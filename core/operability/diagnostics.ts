/**
 * Diagnostic Projection — `diagnostic_packet` (TD §5.11, I-TD8).
 *
 * A read-only derivation of Store facts and optional adapter observations into one packet a
 * person can act on. Three rules from §5.11 are load-bearing:
 *
 *   - **per-field provenance**: every field says where it came from, whether it is a fresh
 *     observation or a durable projection, and when it was observed;
 *   - **partial results**: one unavailable authority never kills the packet — the field is
 *     `UNAVAILABLE` with an error ref and everything else stands, and nothing cached is ever
 *     presented as `fresh`;
 *   - **no authority**: the packet owns no transition, causes no side effect, and is never a
 *     second source of truth.
 *
 * The `next_owner` field is the I-TD8 derivation: every non-terminal durable state names the
 * party whose move it is — HUMAN(decision), COORDINATOR, or NONE for terminal states.
 */

import type { RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import { isTerminalTask } from "../store/domain-types.ts";

export type DiagnosticField<T> =
  | {
      readonly availability: "AVAILABLE";
      readonly value: T;
      readonly source: string;
      readonly freshness: "fresh" | "durable_projection";
      readonly observed_at?: string;
    }
  | {
      readonly availability: "UNAVAILABLE";
      readonly source: string;
      readonly error_ref?: string;
    };

export interface NextOwner {
  readonly owner: "HUMAN" | "COORDINATOR" | "NONE";
  readonly detail: string;
}

export interface DiagnosticPacketV1 {
  readonly subject_ref: string;
  readonly state: DiagnosticField<Record<string, unknown>>;
  readonly next_owner: DiagnosticField<NextOwner>;
  readonly recent_transitions: DiagnosticField<readonly Record<string, unknown>[]>;
  readonly operations: DiagnosticField<readonly Record<string, unknown>[]>;
  readonly evidence: DiagnosticField<readonly Record<string, unknown>[]>;
  readonly open_decisions: DiagnosticField<readonly Record<string, unknown>[]>;
  readonly repository: DiagnosticField<Record<string, unknown>>;
}

export interface DiagnosticAuthorities {
  readonly store: PlatformStore;
  /** Optional: when present the canonical head is read fresh; when it fails, UNAVAILABLE. */
  readonly repository?: RepositoryAdapter;
}

const durable = <T>(value: T, source: string): DiagnosticField<T> => ({
  availability: "AVAILABLE",
  value,
  source,
  freshness: "durable_projection",
});

const unavailable = <T>(source: string, error: unknown): DiagnosticField<T> => ({
  availability: "UNAVAILABLE",
  source,
  error_ref: error instanceof Error ? error.message : String(error),
});

/** Builds one packet for a run, task or attempt key. Read-only, always partial-tolerant. */
export function diagnosticPacket(
  authorities: DiagnosticAuthorities,
  subject_ref: string,
): DiagnosticPacketV1 {
  const { store } = authorities;

  const field = <T>(source: string, read: () => T): DiagnosticField<T> => {
    try {
      return durable(read(), source);
    } catch (error) {
      return unavailable(source, error);
    }
  };

  const packet: DiagnosticPacketV1 = {
    subject_ref,
    state: field("store", () => stateOf(store, subject_ref)),
    next_owner: field("store (I-TD8 derivation)", () => nextOwner(store, subject_ref)),
    recent_transitions: field("store:decision_log", () =>
      store.decisions
        .read()
        .filter(
          (entry) =>
            entry.kind === "state_transition" &&
            JSON.stringify(entry.payload).includes(subject_ref),
        )
        .slice(-10)
        .map((entry) => ({ seq: entry.seq, ts: entry.ts, ...(entry.payload as object) })),
    ),
    operations: field("store:idempotency", () =>
      store.idempotency
        .keysWithPrefix(`op:${subject_ref}`)
        .map((key) => {
          const record = store.idempotency.get(key);
          return { op_key: key, state: record?.state ?? "UNKNOWN", ts: record?.ts };
        }),
    ),
    evidence: field("store:verification_evidence + audit_record", () => {
      if (!subject_ref.startsWith("attempt:")) return [];
      return [
        ...store.verificationEvidence.forAttempt(subject_ref).map((row) => ({
          kind: "evidence",
          evidence_id: row.evidence_id,
          check_id: row.check_id,
          result: row.result,
          binding_valid: row.binding_valid,
          target_commit: row.target_commit,
        })),
        ...store.auditRecords.forAttempt(subject_ref).map((row) => ({
          kind: "audit",
          audit_id: row.audit_id,
          verdict: row.verdict,
          candidate_commit: row.candidate_commit,
        })),
      ];
    }),
    open_decisions: field("store:pending_human_decision", () =>
      store.pendingDecisions.openFor(taskSubject(subject_ref)).map((record) => ({
        decision_id: record.body.decision_id,
        category: record.body.category,
        question: record.body.question,
        options: [...record.body.options],
      })),
    ),
    repository:
      authorities.repository === undefined
        ? unavailable("repository", "no repository authority was supplied")
        : freshRepository(authorities.repository),
  };
  return packet;
}

function freshRepository(repository: RepositoryAdapter): DiagnosticField<Record<string, unknown>> {
  try {
    const snapshot = repository.snapshot_canonical();
    return {
      availability: "AVAILABLE",
      value: { ref: snapshot.ref, head: snapshot.head },
      source: "repository (authoritative)",
      freshness: "fresh",
      observed_at: new Date().toISOString(),
    };
  } catch (error) {
    return unavailable("repository", error);
  }
}

function taskSubject(subject_ref: string): string {
  return subject_ref.startsWith("attempt:")
    ? subject_ref.replace(/^attempt:/, "").replace(/:\d+$/, "")
    : subject_ref;
}

function stateOf(store: PlatformStore, subject: string): Record<string, unknown> {
  if (subject.startsWith("run:")) {
    const run = store.runs.require(subject);
    return { kind: "run", status: run.status, project_id: run.project_id };
  }
  if (subject.startsWith("attempt:")) {
    const attempt = store.attempts.require(subject);
    return {
      kind: "attempt",
      state: attempt.state,
      candidate_commit: attempt.candidate_commit,
      rework_count: attempt.rework_count,
      reason: attempt.state_reason?.code ?? null,
    };
  }
  if (subject.startsWith("batch:")) {
    const batch = store.batches.require(subject);
    return { kind: "batch", status: batch.status, admission_closed: batch.admission_closed };
  }
  const task = store.tasks.require(subject);
  return {
    kind: "task",
    platform_state: task.platform_state,
    reason: task.state_reason?.code ?? null,
    parent_task_key: task.parent_task_key,
  };
}

/** I-TD8 — every non-terminal state has a machine-readable next owner. */
function nextOwner(store: PlatformStore, subject: string): NextOwner {
  if (subject.startsWith("run:")) {
    const run = store.runs.require(subject);
    if (run.status === "PAUSED_SAFELY") return { owner: "HUMAN", detail: "run is paused; explicit resume required (Spec §52)" };
    if (run.status === "COMPLETED") return { owner: "NONE", detail: "terminal" };
    return { owner: "COORDINATOR", detail: "ordinary tick" };
  }
  if (subject.startsWith("attempt:")) {
    const attempt = store.attempts.require(subject);
    return nextOwner(store, attempt.task_key);
  }
  if (subject.startsWith("batch:")) {
    const batch = store.batches.require(subject);
    if (batch.status === "PAUSED_SAFELY") return { owner: "HUMAN", detail: "circuit breaker; explicit resume required" };
    if (batch.status === "WAITING") return { owner: "HUMAN", detail: "every runnable path blocks on an open decision (§20.1)" };
    if (batch.status === "COMPLETED" || batch.status === "FAILED") return { owner: "NONE", detail: "terminal" };
    return { owner: "COORDINATOR", detail: "ordinary tick" };
  }

  const task = store.tasks.require(subject);
  if (isTerminalTask(task.platform_state)) return { owner: "NONE", detail: "terminal" };
  const reason = task.state_reason?.code ?? "";
  const blocked = /^BLOCKED_BY_DECISION:(.+)$/.exec(reason);
  if (blocked !== null) return { owner: "HUMAN", detail: `decision ${blocked[1]}` };
  if (task.platform_state === "HELD") {
    // A held reason without a decision is a Coordinator/recovery concern (retryable hold).
    return { owner: "COORDINATOR", detail: `held: ${reason || "unreasoned"}` };
  }
  if (task.platform_state === "SUSPENDED") {
    return { owner: "COORDINATOR", detail: "resumes when subflow children complete (Spec §47)" };
  }
  return { owner: "COORDINATOR", detail: "ordinary tick" };
}
