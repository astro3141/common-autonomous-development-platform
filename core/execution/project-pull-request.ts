/**
 * Pull-request projection of one READY_TO_MERGE candidate (#52; Spec §17/§37 boundary style).
 *
 * The projection is delivery, not lifecycle: this use-case moves no Task/Attempt state, and its
 * whole durable footprint is the idempotency record that fences the external effect (I-TD2) plus
 * an adapter-metadata receipt for operators. Eligibility is judged from durable rows at call
 * time — never from the caller's claim:
 *
 *   the attempt is the task's current attempt and is exactly READY_TO_MERGE
 *   a candidate commit is bound
 *   verification evidence rows exist for that exact candidate
 *   an audit record with verdict AUDIT_PASS exists for that exact candidate
 *
 * Anything else refuses before any external effect. A PR can therefore never exist ahead of
 * READY_TO_MERGE through this path, and never for a commit other than the bound candidate.
 */

import type {
  PullRequestProjectionAdapterV1,
  PullRequestReceiptV1,
} from "../../adapters/interfaces/pull-request-projection.ts";
import { PullRequestProjectionFailedError } from "../../adapters/interfaces/pull-request-projection.ts";
import type { CanonicalValue } from "../schemas/canonical-json.ts";
import type { PlatformStore } from "../store/platform-store.ts";

export const PR_PROJECTION_ADAPTER = "pull-request-projection";
export const PR_PROJECTION_METADATA_KEY = "candidate_pull_request";

export const prProjectionOp = (attemptKey: string): string => `op:${attemptKey}:pr-projection`;

export interface ProjectPullRequestCommand {
  readonly attempt_key: string;
  readonly base_branch: string;
}

export type ProjectPullRequestOutcome =
  | { readonly kind: "PROJECTED"; readonly receipt: PullRequestReceiptV1 }
  | { readonly kind: "NOT_ELIGIBLE"; readonly reason: string }
  | { readonly kind: "FAILED"; readonly reason: string };

export interface ProjectPullRequestDeps {
  readonly store: PlatformStore;
  readonly projection: PullRequestProjectionAdapterV1;
}

export function projectPullRequest(
  deps: ProjectPullRequestDeps,
  command: ProjectPullRequestCommand,
): ProjectPullRequestOutcome {
  const { store } = deps;
  const attempt = store.attempts.get(command.attempt_key);
  if (attempt === undefined) return notEligible(`unknown attempt ${command.attempt_key}`);
  const current = store.attempts.current(attempt.task_key);
  if (current === undefined || current.attempt_key !== attempt.attempt_key) {
    return notEligible(`${attempt.attempt_key} is not the task's current attempt`);
  }
  if (attempt.state !== "READY_TO_MERGE") {
    return notEligible(`projection requires READY_TO_MERGE, not ${attempt.state}`);
  }
  const candidate = attempt.candidate_commit;
  if (candidate === null) return notEligible(`${attempt.attempt_key} has no bound candidate commit`);

  const task = store.tasks.require(attempt.task_key);
  const contract_hash = store.contracts.hashOf(attempt.contract_snapshot_id);

  // §15.2/§16.2 — the projection may only deliver what the exact candidate already earned.
  const evidence = store.verificationEvidence
    .forAttempt(attempt.attempt_key)
    .filter((row) => row.target_commit === candidate);
  if (evidence.length === 0) {
    return notEligible(`no verification evidence is bound to candidate ${candidate}`);
  }
  const audits = store.auditRecords
    .forAttempt(attempt.attempt_key)
    .filter((row) => row.candidate_commit === candidate && row.verdict === "AUDIT_PASS");
  const audit = audits.at(-1);
  if (audit === undefined) {
    return notEligible(`no AUDIT_PASS record is bound to candidate ${candidate}`);
  }

  const op_key = prProjectionOp(attempt.attempt_key);
  const record = store.idempotency.get(op_key);
  if (record?.state === "DONE") {
    return { kind: "PROJECTED", receipt: record.result as unknown as PullRequestReceiptV1 };
  }

  const head_branch = `adp/candidate/${sanitizeRefComponent(attempt.attempt_key)}`;
  const request = {
    op_key,
    head_branch,
    candidate_commit: candidate,
    base_branch: command.base_branch,
    title: `[ADP] ${taskTitle(store, task.task_key)}`,
    body: renderPrBody({
      source_task_ref: task.external_task_ref,
      task_key: task.task_key,
      attempt_key: attempt.attempt_key,
      candidate,
      contract_snapshot_id: attempt.contract_snapshot_id,
      contract_hash,
      evidence_ids: evidence.map((row) => row.evidence_id),
      audit_id: audit.audit_id,
    }),
  };

  if (record?.state === "INTENT") {
    // Crash window: reconcile against the target before anything else may happen.
    const reconciled = reconcile(deps, head_branch, candidate);
    if (reconciled.kind === "PROJECTED") {
      store.withTransaction(() => {
        store.idempotency.markDone(op_key, reconciled.receipt as unknown as CanonicalValue);
      });
      recordReceipt(store, attempt.attempt_key, reconciled.receipt);
      return reconciled;
    }
    if (reconciled.kind === "FAILED") return reconciled;
    // NO_EFFECT proven — fall through and publish under the same INTENT.
  } else {
    store.withTransaction(() => {
      store.idempotency.beginIntent(op_key);
    });
  }

  let receipt: PullRequestReceiptV1;
  try {
    receipt = deps.projection.publish_candidate_pull_request(request).receipt;
  } catch (error) {
    if (error instanceof PullRequestProjectionFailedError) {
      store.withTransaction(() => {
        store.idempotency.markFailed(op_key);
      });
      return { kind: "FAILED", reason: error.message };
    }
    // Ambiguous: the INTENT stays; a later call reconciles. Never a blind second publish.
    return { kind: "FAILED", reason: error instanceof Error ? error.message : String(error) };
  }
  store.withTransaction(() => {
    store.idempotency.markDone(op_key, receipt as unknown as CanonicalValue);
  });
  recordReceipt(store, attempt.attempt_key, receipt);
  return { kind: "PROJECTED", receipt };
}

function reconcile(
  deps: ProjectPullRequestDeps,
  head_branch: string,
  candidate: string,
):
  | { readonly kind: "PROJECTED"; readonly receipt: PullRequestReceiptV1 }
  | { readonly kind: "NO_EFFECT" }
  | { readonly kind: "FAILED"; readonly reason: string } {
  let result;
  try {
    result = deps.projection.reconcile_pull_request(head_branch, candidate);
  } catch (error) {
    if (error instanceof PullRequestProjectionFailedError) {
      return { kind: "FAILED", reason: error.message };
    }
    return { kind: "FAILED", reason: "pull request state is unprovable; retry later" };
  }
  if (result.status === "COMMITTED") return { kind: "PROJECTED", receipt: result.receipt };
  if (result.status === "NO_EFFECT_CONFIRMED") return { kind: "NO_EFFECT" };
  return { kind: "FAILED", reason: "pull request state is unprovable; retry later" };
}

function recordReceipt(store: PlatformStore, attempt_key: string, receipt: PullRequestReceiptV1): void {
  store.withTransaction(() => {
    store.adapterMetadata.put({
      entity_key: attempt_key,
      adapter_id: PR_PROJECTION_ADAPTER,
      key: PR_PROJECTION_METADATA_KEY,
      value: receipt as unknown as CanonicalValue,
    });
  });
}

function taskTitle(store: PlatformStore, task_key: string): string {
  const task = store.tasks.require(task_key);
  return `${task.external_task_ref}`;
}

function renderPrBody(input: {
  readonly source_task_ref: string;
  readonly task_key: string;
  readonly attempt_key: string;
  readonly candidate: string;
  readonly contract_snapshot_id: string;
  readonly contract_hash: string | undefined;
  readonly evidence_ids: readonly string[];
  readonly audit_id: string;
}): string {
  return [
    `Source task: ${input.source_task_ref}`,
    `Task: \`${input.task_key}\``,
    `Attempt: \`${input.attempt_key}\``,
    `Candidate: \`${input.candidate}\``,
    `Task Contract: \`${input.contract_snapshot_id}\`${input.contract_hash === undefined ? "" : ` (\`${input.contract_hash}\`)`}`,
    `Verification evidence: ${input.evidence_ids.map((id) => `\`${id}\``).join(", ")}`,
    `Audit: \`${input.audit_id}\` (AUDIT_PASS)`,
    "",
    "Projected by ADP after verification and audit; merging remains governed by current policy.",
  ].join("\n");
}

function notEligible(reason: string): ProjectPullRequestOutcome {
  return { kind: "NOT_ELIGIBLE", reason };
}

function sanitizeRefComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
}
