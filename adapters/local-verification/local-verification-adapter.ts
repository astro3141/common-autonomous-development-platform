/**
 * LocalVerificationAdapter — the Backend v1 VerificationAdapter (TD §15.1, §15.1a).
 *
 * This is the only place that knows the initial verification backend runs checks as durable
 * workflow activities. Everything above it sees `STARTED | BLOCKED` and
 * `RUNNING | COMPLETED | FAILED`; everything below it — the readiness preflight, the trusted
 * controller, the workflow spec, the backend's request identity, the backend's own state
 * vocabulary — is this file's business. Swapping it for a `CIValidationAdapter` changes nothing
 * in Core, which is the whole point of the boundary (Spec §37).
 *
 * It owns no durable state. The dependencies are injected adapters, not a framework: there is no
 * registry, no codec, no scheduler and no job abstraction shared with Runtime turns.
 */

import type {
  RepositoryAdapter,
  RepositoryCanonicalSnapshot,
} from "../interfaces/repository-adapter.ts";
import type { RuntimeAdapter, RuntimePreflight } from "../interfaces/runtime-adapter.ts";
import type { WorkflowAdapter } from "../interfaces/workflow-adapter.ts";
import type {
  TaskContractSnapshot,
  VerificationProfile,
  VerificationRunHandle,
  WorkflowHandle,
  WorkflowSpec,
} from "../interfaces/handles.ts";

import type {
  AuditSettlementOperationContextV1,
  AuditSettlementResult,
  PlatformAuditVerdict,
  VerificationAdapter,
  VerificationEvidence,
  VerificationOperationContextV1,
  VerificationRunObservation,
  VerificationStartResult,
} from "../interfaces/verification-adapter.ts";
import { hashEnvelope, type SchemaEnvelope } from "../../core/schemas/envelope.ts";
import type {
  BackendAuditGateStatus,
  BackendStageStatus,
  BackendVerificationStatus,
  VerificationBackendSeam,
  VerificationRunRefV1,
} from "./backend-seam.ts";
import { buildEvidence, classifyStage } from "./evidence.ts";

/**
 * Everything the Backend v1 composition needs, supplied by whoever wires the adapters together.
 *
 * `preflight` is here rather than on the VerificationAdapter contract on purpose (TD §15.1a): a CI
 * backend has no idea what this backend's packaging checks are, and `BLOCKED` already carries
 * everything Core is allowed to know about readiness.
 */
export interface LocalVerificationDependencies {
  readonly preflight: RuntimePreflight;
  readonly runtime: RuntimeAdapter;
  readonly workflow: WorkflowAdapter;
  readonly repository: RepositoryAdapter;
  /** MVP1-B8 §23 — the Backend v1 read/advance seam. Never Core, never generic. */
  readonly backend: VerificationBackendSeam;
  /**
   * The checks each verification profile declares, in order. This is the `config` half of the
   * Project Profile's `verification_profiles` entry (TD §7.1a): the Profile declares the commands
   * and Core never interprets them, so the declaration reaches the adapter that runs them.
   */
  readonly profiles: Readonly<Record<string, VerificationProfileChecks>>;
}

/** One declared check. `check_id` is what the policy's `required_verification` names. */
export interface DeclaredCheck {
  readonly check_id: string;
  readonly argv: readonly string[];
  readonly timeout_seconds?: number;
}

export type VerificationProfileChecks = readonly DeclaredCheck[];

/**
 * TD §14.1 — the durable workflow request. Built here, never in Core: `request_id` is the backend's
 * idempotency key and its field name is a backend detail, which is exactly why Core does not know
 * it. Every value is either frozen Platform authority or an adapter-derived location.
 */
interface VerificationWorkflowSpecV1 {
  readonly request_id: string;
  readonly candidate_commit: string;
  readonly task_contract_hash: string;
  readonly canonical_ref: string;
  readonly canonical_head: string;
  readonly verification_profile: string;
  readonly worktree: string;
  /**
   * One stage per declared check, in declared order. `stage_name` carries the `check_id`, which is
   * how a later observation binds a backend execution back to the check it was for — never by
   * reading argv or output (§7).
   */
  readonly pipeline: readonly {
    readonly stage_name: string;
    readonly argv: readonly string[];
    readonly timeout_seconds?: number;
  }[];
}

export class LocalVerificationAdapter implements VerificationAdapter {
  readonly #deps: LocalVerificationDependencies;

  constructor(dependencies: LocalVerificationDependencies) {
    this.#deps = dependencies;
  }

  /**
   * Establishes the run, or reports that nothing was started.
   *
   * The readiness check comes first and, when it fails, the method returns before acquiring a
   * controller or touching the workflow backend — so `BLOCKED` really is the guarantee Core relies
   * on: zero external verification effect.
   */
  start_verification(
    operation_context: VerificationOperationContextV1,
    verification_profile: VerificationProfile,
    repository_snapshot: RepositoryCanonicalSnapshot,
    task_contract_snapshot: TaskContractSnapshot,
    candidate_commit: string,
  ): VerificationStartResult {
    if (this.#deps.preflight().status === "BLOCKED") {
      return { kind: "BLOCKED" };
    }

    // Where the checks actually run. Verification gets its own worktree at the candidate rather
    // than borrowing the Actor's: the operation key makes it deterministic and idempotent (a retry
    // re-acquires the same one), and it cannot be disturbed by a session still holding the feature
    // workspace. No new authority field was needed — the candidate and the op key are both already
    // arguments of this contract.
    const workspace = this.#deps.repository.create_feature_workspace({
      base_head: candidate_commit,
      op_key: operation_context.op_key,
    });

    const profile_id = verification_profile as unknown as string;
    const checks = this.#deps.profiles[profile_id];
    if (checks === undefined || checks.length === 0) {
      throw new Error(`verification profile ${profile_id} declares no checks`);
    }
    assertUniqueCheckIds(checks);

    const controller = this.#deps.runtime.acquire_workflow_controller();
    const spec: VerificationWorkflowSpecV1 = {
      request_id: operation_context.op_key,
      candidate_commit,
      // Frozen here so a later observation can rebuild the binding after a restart without asking
      // Core again. It is the adapter's own copy of the immutable snapshot it was handed (§9).
      task_contract_hash: hashEnvelope(task_contract_snapshot as unknown as SchemaEnvelope),
      canonical_ref: repository_snapshot.ref,
      canonical_head: repository_snapshot.head,
      verification_profile: profile_id,
      worktree: workspace.path,
      pipeline: checks.map((check) => ({
        stage_name: check.check_id,
        argv: check.argv,
        ...(check.timeout_seconds === undefined ? {} : { timeout_seconds: check.timeout_seconds }),
      })),
    };

    const handle = this.#deps.workflow.start(controller, spec as unknown as WorkflowSpec);
    // The run reference is the backend's workflow id plus this adapter's own frozen request
    // material. The backend's status projection does not return the start request, so carrying it
    // in the (adapter-owned, Core-opaque, I-TD7-admissible) handle lets a restarted adapter
    // rebuild the candidate and contract binding without asking Core again.
    const run: VerificationRunRefV1 = {
      workflow_id: workflowIdOf(handle),
      request_id: operation_context.op_key,
      candidate_commit,
      task_contract_hash: spec.task_contract_hash,
    };
    return { kind: "STARTED", run_handle: run as unknown as VerificationRunHandle };
  }

  /**
   * Walks the backend's checks in order, turning each terminal one into evidence and releasing the
   * next only once *this* adapter has established PASS from the child process. Nothing about the
   * backend's own state vocabulary crosses the return (TD §15.1a).
   *
   * The walk is bounded by the number of stages: each iteration either returns or consumes one
   * stage, so this polls the backend a fixed number of times and never spins.
   */
  get_verification_result(run_handle: VerificationRunHandle): VerificationRunObservation {
    const run = run_handle as unknown as VerificationRunRefV1;
    let status: BackendVerificationStatus;
    try {
      status = this.#deps.backend.inspect_verification_workflow(run);
    } catch {
      // A denied, unavailable or malformed answer proves nothing about the checks.
      return { state: "FAILED" };
    }
    if (!this.#executedHere(run, status)) return { state: "FAILED" };

    const evidence: VerificationEvidence[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < status.stages.length; index += 1) {
      const stage = status.stages[index];
      // The stage set must not change shape underneath the walk, and a check id must identify
      // exactly one execution — an ambiguous mapping is fail-closed, never a guess (§7).
      if (stage === undefined || stage.stage_name.length === 0) return { state: "FAILED" };
      if (seen.has(stage.stage_name)) return { state: "FAILED" };
      seen.add(stage.stage_name);

      const outcome = classifyStage(stage);
      if (outcome.kind === "PENDING") return { state: "RUNNING" };
      if (outcome.kind === "UNUSABLE") return { state: "FAILED" };
      if (stage.finished_at === null) return { state: "FAILED" };

      evidence.push(
        buildEvidence({
          check_id: stage.stage_name,
          result: outcome.result,
          target_commit: run.candidate_commit,
          task_contract_hash: run.task_contract_hash,
          run_reference: run.workflow_id,
          finished_at: stage.finished_at,
          attempt: stage.current_attempt ?? index,
        }),
      );

      if (outcome.result !== "PASS") {
        // §19 — a failing check is a *verification* answer, not an infrastructure failure. The
        // stage is not approved, later checks are not run, and nothing is synthesized for them.
        return { state: "COMPLETED", evidence };
      }

      // §17 — approval comes strictly after this adapter established PASS itself. A stage the
      // backend already records as verified is left alone, which is what makes a crash between the
      // approval and its observation harmless (§18).
      if (!isVerifiedStage(stage)) {
        try {
          this.#deps.backend.approve_verified_stage(run, {
            stage_id: stage.stage_id,
            attempt: stage.current_attempt ?? 1,
          });
          // Re-read the backend rather than assuming what the approval did: the next check's facts
          // must be backend-authoritative, and a crash here must be recoverable from them alone.
          status = this.#deps.backend.inspect_verification_workflow(run);
        } catch {
          return { state: "FAILED" };
        }
      }
    }

    return { state: "COMPLETED", evidence };
  }

  /**
   * TD §16.3 (M1-13) — settles this run's audit gate, observe-before-act and re-observe-after.
   *
   * Backend v1 proves request dedup for starting a workflow and proves its *absence* for turns; it
   * proves nothing either way for the audit decision. So a blind call could settle the same gate
   * twice, and a returned call could still be a gate that never settled. Both are handled the same
   * way: the backend's own record of the gate is the only thing that counts.
   *
   *   already settled, same decision → `SETTLED`, and no second backend effect
   *   already settled, different      → `CONFLICT`; a settled gate is never overwritten
   *   not settled                     → decide, then read it back before saying anything
   *   cannot be read                  → `UNAVAILABLE` — never inferred from this adapter's own
   *                                     missing process memory, only from a failed observation
   *
   * `operation_context` is the Platform's identity for the operation. Backend v1 has no request-id
   * dedup on its audit primitive, which is exactly why it is not passed down as one and why the
   * observation above carries the whole burden.
   */
  settle_audit(
    operation_context: AuditSettlementOperationContextV1,
    run_handle: VerificationRunHandle,
    auditor_verdict: PlatformAuditVerdict,
    evidence: readonly VerificationEvidence[],
  ): AuditSettlementResult {
    void operation_context;
    const run = run_handle as unknown as VerificationRunRefV1;
    const requested = BACKEND_VERDICT[auditor_verdict];

    const before = this.#observeGate(run);
    if (before === undefined) return { kind: "UNAVAILABLE" };
    if (before.settled) {
      return before.verdict === requested ? { kind: "SETTLED" } : { kind: "CONFLICT" };
    }

    // The trusted controller and the workflow identity are this adapter's, obtained the same way
    // the run was started. Neither ever crosses back up to Core (I-TD5/I-TD7).
    const controller = this.#deps.runtime.acquire_workflow_controller();
    const handle = { workflow_id: run.workflow_id } as unknown as WorkflowHandle;
    try {
      this.#deps.workflow.audit_decide(controller, handle, requested, evidence);
    } catch {
      // The call failed, but it may still have applied. Fall through to the re-observation rather
      // than guessing: this is precisely the AD3 window.
    }

    const after = this.#observeGate(run);
    if (after === undefined || !after.settled) return { kind: "UNAVAILABLE" };
    return after.verdict === requested ? { kind: "SETTLED" } : { kind: "CONFLICT" };
  }

  /** One authoritative read of the gate. `undefined` means it could not be performed. */
  #observeGate(run: VerificationRunRefV1): BackendAuditGateStatus | undefined {
    try {
      return this.#deps.backend.inspect_audit_gate(run);
    } catch {
      return undefined;
    }
  }

  /**
   * §8 — the candidate binding is only trustworthy if the checks ran where this run put them. The
   * workspace is re-acquired through the same idempotent operation that created it, and its path
   * must be the directory the backend actually used.
   */
  #executedHere(run: VerificationRunRefV1, status: BackendVerificationStatus): boolean {
    if (status.worktree === null || status.stages.length === 0) return false;
    try {
      const workspace = this.#deps.repository.create_feature_workspace({
        base_head: run.candidate_commit,
        op_key: run.request_id,
      });
      return workspace.path === status.worktree;
    } catch {
      return false;
    }
  }
}

/** The backend records its own progression marker; presence of a verified state is all we read. */
const isVerifiedStage = (stage: BackendStageStatus): boolean => stage.stage_state === "PASSED";

function assertUniqueCheckIds(checks: VerificationProfileChecks): void {
  const seen = new Set<string>();
  for (const check of checks) {
    if (check.check_id.length === 0 || seen.has(check.check_id)) {
      throw new Error(`verification profile declares an ambiguous check id "${check.check_id}"`);
    }
    seen.add(check.check_id);
  }
}

/**
 * TD §16.3 (M1-13) — Platform verdict → the backend's own audit vocabulary.
 *
 * The mapping lives here and nowhere else. Core never learns these values, and a backend-native
 * verdict the Platform does not have (`INCONCLUSIVE`) never travels the other way: it would be a
 * fourth Auditor verdict the contract does not define, so it can only ever be a `CONFLICT`.
 */
const BACKEND_VERDICT: Readonly<Record<PlatformAuditVerdict, string>> = {
  AUDIT_PASS: "PASS",
  FIX_REQUIRED: "FAIL",
  HUMAN_REQUIRED: "BLOCKED",
};

/** Backend v1 returns an opaque workflow handle whose plain id is the run's backend identity. */
function workflowIdOf(handle: WorkflowHandle): string {
  const value = (handle as unknown as { workflow_id?: unknown; workflowId?: unknown });
  const id = typeof value.workflow_id === "string" ? value.workflow_id : value.workflowId;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("the workflow backend returned no usable workflow id");
  }
  return id;
}
