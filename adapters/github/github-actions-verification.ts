/**
 * GitHubActionsVerificationAdapter — GitHub Actions as a replaceable external Verification
 * backend (#57; Spec §37, TD §15.1a/§15.2, CI backend per TD "CIValidationAdapter").
 *
 * GitHub Actions is the executor and evidence source only. ADP's VerificationPolicy still decides
 * whether observed evidence suffices; a green check never transitions Platform state by itself,
 * and this adapter holds no lifecycle authority.
 *
 *   start   push the exact candidate SHA to a deterministic per-operation verification branch —
 *           the repository's own workflow configuration reacts to the push. Same op + same
 *           candidate re-push converges; same op + different candidate is a deterministic
 *           conflict (Spec §57 at this boundary).
 *   observe read the check runs of the exact candidate SHA. Each declared required check maps to
 *           evidence bound to that SHA and the frozen contract hash; a missing required check is
 *           a run still RUNNING (the Platform's own monitors own staleness); failure, timeout,
 *           cancellation, stale/neutral/skipped conclusions and unreadable answers are never PASS.
 *   settle  the audit gate is a commit status on the candidate SHA under one adapter-owned
 *           context — durable, target-authoritative, exact-SHA-bound. Observe before act,
 *           re-observe after; a settled gate is never overwritten.
 *
 * Assurance is `ARTIFACT_VERIFIED` per the TD's CI-adapter designation: the backend's
 * authoritative run record for the exact SHA, not a Platform re-execution and not worker
 * self-reporting.
 */

import { createHash } from "node:crypto";

import type {
  TaskContractSnapshot,
  VerificationProfile,
  VerificationRunHandle,
} from "../interfaces/handles.ts";
import type { RepositoryCanonicalSnapshot } from "../interfaces/repository-adapter.ts";
import type {
  AuditSettlementOperationContextV1,
  AuditSettlementResult,
  PlatformAuditVerdict,
  VerificationAdapter,
  VerificationEvidence,
  VerificationOperationContextV1,
  VerificationResult,
  VerificationRunObservation,
  VerificationStartResult,
} from "../interfaces/verification-adapter.ts";
import { hashEnvelope, type SchemaEnvelope } from "../../core/schemas/envelope.ts";
import type { GitHubTransportV1 } from "./transport.ts";

export const GITHUB_ACTIONS_ADAPTER_VERSION = "1";
export const GITHUB_ACTIONS_EXECUTOR_IDENTITY =
  `github-actions@github-actions-verification-adapter:${GITHUB_ACTIONS_ADAPTER_VERSION}`;

/** The adapter-owned audit gate context on the candidate commit. */
export const AUDIT_STATUS_CONTEXT = "adp/audit-verdict";

export interface GitHubActionsVerificationConfig {
  readonly owner: string;
  readonly repo: string;
  /** Local canonical clone candidate SHAs are pushed from. */
  readonly canonical_repo_path: string;
  /** Per verification profile: the exact check-run names that must conclude. */
  readonly profiles: Readonly<Record<string, readonly string[]>>;
}

interface ActionsRunRefV1 {
  readonly op_key: string;
  readonly candidate_commit: string;
  readonly task_contract_hash: string;
  readonly verification_profile: string;
  readonly verify_branch: string;
}

export class GitHubActionsVerificationAdapter implements VerificationAdapter {
  readonly #transport: GitHubTransportV1;
  readonly #config: GitHubActionsVerificationConfig;

  constructor(transport: GitHubTransportV1, config: GitHubActionsVerificationConfig) {
    this.#transport = transport;
    this.#config = config;
  }

  start_verification(
    operation_context: VerificationOperationContextV1,
    verification_profile: VerificationProfile,
    repository_snapshot: RepositoryCanonicalSnapshot,
    task_contract_snapshot: TaskContractSnapshot,
    candidate_commit: string,
  ): VerificationStartResult {
    void repository_snapshot;
    const profile_id = verification_profile as unknown as string;
    const required = this.#config.profiles[profile_id];
    if (required === undefined || required.length === 0) {
      throw new Error(`verification profile ${profile_id} declares no required GitHub checks`);
    }

    const verify_branch = `adp/verify/${shortHash(operation_context.op_key)}`;
    try {
      // No force: a branch already at a different commit means this op key was started with
      // different material — a deterministic conflict, never silently repointed.
      this.#transport.push_commit(
        this.#config.canonical_repo_path,
        candidate_commit,
        `refs/heads/${verify_branch}`,
      );
    } catch {
      // Nothing observable was started for this op if the push did not land; the same operation
      // may simply be tried again later.
      return { kind: "BLOCKED" };
    }

    const run: ActionsRunRefV1 = {
      op_key: operation_context.op_key,
      candidate_commit,
      task_contract_hash: hashEnvelope(task_contract_snapshot as unknown as SchemaEnvelope),
      verification_profile: profile_id,
      verify_branch,
    };
    return { kind: "STARTED", run_handle: run as unknown as VerificationRunHandle };
  }

  get_verification_result(run_handle: VerificationRunHandle): VerificationRunObservation {
    const run = run_handle as unknown as ActionsRunRefV1;
    const required = this.#config.profiles[run.verification_profile];
    if (required === undefined || required.length === 0) return { state: "FAILED" };

    let checks: readonly CheckRun[];
    try {
      checks = this.#checkRunsFor(run.candidate_commit);
    } catch {
      // A denied, unavailable or malformed answer proves nothing about the checks.
      return { state: "FAILED" };
    }

    const evidence: VerificationEvidence[] = [];
    for (const name of required) {
      const matches = checks.filter((check) => check.name === name);
      if (matches.length === 0) return { state: "RUNNING" }; // not yet reported for this SHA
      if (matches.length > 1) return { state: "FAILED" }; // ambiguous mapping is never guessed
      const check = matches[0]!;
      // The query is by candidate SHA, and the run's own head must agree — a result for any
      // other commit is not evidence for this one (#57 negative control).
      if (check.head_sha !== run.candidate_commit) return { state: "FAILED" };
      if (check.status !== "completed") return { state: "RUNNING" };
      const result = concludeOf(check.conclusion);
      if (result === null) return { state: "FAILED" };
      if (check.completed_at === null) return { state: "FAILED" };
      evidence.push({
        evidence_id: deriveEvidenceId(run, check),
        check_id: name,
        result,
        assurance_level: "ARTIFACT_VERIFIED",
        target_commit: run.candidate_commit,
        task_contract_hash: run.task_contract_hash,
        executor_identity: GITHUB_ACTIONS_EXECUTOR_IDENTITY,
        run_reference: `check-run:${check.id}`,
        timestamp: check.completed_at,
      });
    }
    return { state: "COMPLETED", evidence };
  }

  settle_audit(
    operation_context: AuditSettlementOperationContextV1,
    run_handle: VerificationRunHandle,
    auditor_verdict: PlatformAuditVerdict,
    evidence: readonly VerificationEvidence[],
  ): AuditSettlementResult {
    void operation_context;
    void evidence;
    const run = run_handle as unknown as ActionsRunRefV1;

    const before = this.#observeGate(run.candidate_commit);
    if (before === undefined) return { kind: "UNAVAILABLE" };
    if (before !== null) {
      return before === auditor_verdict ? { kind: "SETTLED" } : { kind: "CONFLICT" };
    }

    try {
      this.#transport.api({
        method: "POST",
        path: `repos/${this.#config.owner}/${this.#config.repo}/statuses/${run.candidate_commit}`,
        body: {
          state: auditor_verdict === "AUDIT_PASS" ? "success" : "failure",
          context: AUDIT_STATUS_CONTEXT,
          description: auditor_verdict,
        },
      });
    } catch {
      // The call failed but may have applied — the re-observation below is the only authority.
    }
    const after = this.#observeGate(run.candidate_commit);
    if (after === undefined || after === null) return { kind: "UNAVAILABLE" };
    return after === auditor_verdict ? { kind: "SETTLED" } : { kind: "CONFLICT" };
  }

  /** `undefined` = unreadable; `null` = readable and not settled; else the settled verdict. */
  #observeGate(candidate: string): PlatformAuditVerdict | null | undefined {
    let raw: unknown;
    try {
      raw = this.#transport.api({
        method: "GET",
        path: `repos/${this.#config.owner}/${this.#config.repo}/commits/${candidate}/statuses?per_page=100`,
      });
    } catch {
      return undefined;
    }
    if (!Array.isArray(raw)) return undefined;
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) return undefined;
      const record = entry as Record<string, unknown>;
      if (record["context"] !== AUDIT_STATUS_CONTEXT) continue;
      const description = record["description"];
      if (
        description === "AUDIT_PASS" ||
        description === "FIX_REQUIRED" ||
        description === "HUMAN_REQUIRED"
      ) {
        return description;
      }
      return undefined; // a gate row that cannot be read coherently is unreadable, not unset
    }
    return null;
  }

  #checkRunsFor(candidate: string): readonly CheckRun[] {
    const raw = this.#transport.api({
      method: "GET",
      path: `repos/${this.#config.owner}/${this.#config.repo}/commits/${candidate}/check-runs?per_page=100`,
    });
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("check-runs response has an unexpected shape");
    }
    const runs = (raw as Record<string, unknown>)["check_runs"];
    if (!Array.isArray(runs)) throw new Error("check-runs response carries no check_runs array");
    return runs.map((entry) => {
      if (typeof entry !== "object" || entry === null) throw new Error("check run is not an object");
      const record = entry as Record<string, unknown>;
      if (typeof record["name"] !== "string" || typeof record["status"] !== "string") {
        throw new Error("check run misses name/status");
      }
      return {
        id: typeof record["id"] === "number" ? record["id"] : -1,
        name: record["name"],
        status: record["status"],
        conclusion: typeof record["conclusion"] === "string" ? record["conclusion"] : null,
        head_sha: typeof record["head_sha"] === "string" ? record["head_sha"] : "",
        completed_at: typeof record["completed_at"] === "string" ? record["completed_at"] : null,
      };
    });
  }
}

interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly head_sha: string;
  readonly completed_at: string | null;
}

/**
 * Backend conclusions → Platform results. Only `success` is PASS; `failure` is a verification
 * answer; everything that means "did not conclude its work" (timeout, cancellation, staleness,
 * neutral/skipped, action_required) is ERROR — and an unknown conclusion is unusable, fail-closed.
 */
function concludeOf(conclusion: string | null): VerificationResult | null {
  if (conclusion === "success") return "PASS";
  if (conclusion === "failure") return "FAIL";
  if (
    conclusion === "timed_out" ||
    conclusion === "cancelled" ||
    conclusion === "stale" ||
    conclusion === "neutral" ||
    conclusion === "skipped" ||
    conclusion === "action_required"
  ) {
    return "ERROR";
  }
  return null;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Deterministic ULID-shaped evidence identity, derived from the terminal backend record only. */
function deriveEvidenceId(run: ActionsRunRefV1, check: CheckRun): string {
  const milliseconds = Date.parse(check.completed_at ?? "");
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error(`check run ${check.name} has no terminal timestamp`);
  }
  const material = JSON.stringify([
    "platform/github-actions-evidence-id/v1",
    run.op_key,
    check.id,
    check.name,
    run.candidate_commit,
    run.task_contract_hash,
  ]);
  const digest = createHash("sha256").update(material).digest();
  let entropy = 0n;
  for (const byte of digest.subarray(0, 10)) entropy = (entropy << 8n) | BigInt(byte);
  return encodeCrockford(BigInt(milliseconds), 10) + encodeCrockford(entropy, 16);
}

function encodeCrockford(value: bigint, length: number): string {
  let remaining = value;
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = CROCKFORD[Number(remaining & 31n)] + encoded;
    remaining >>= 5n;
  }
  return encoded;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
