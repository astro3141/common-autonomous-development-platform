/**
 * Auditor verdict collection and the audit decision (TD §16.1–§16.3, §19.3, §21; MVP1-B11).
 *
 * The Auditor has been running since B10. This module reads what it produced, decides whether that
 * is a verdict at all, and — only then — settles the audit gate and moves the attempt. Four
 * separations carry the whole design:
 *
 *   **A failed Runtime is not an Auditor's opinion.** A turn that was cancelled, timed out, errored
 *   or lost its session says nothing about the candidate, so it takes the existing `RUNTIME_FAILED`
 *   path. It never becomes `AUDIT_INVALID` and never spends the one retry.
 *
 *   **A verdict is the structured envelope or it is nothing.** Model prose and
 *   `model_declared_outcome` are read by nobody here (I-TD3). An envelope must arrive on the
 *   Auditor protocol, validate, and bind to *this* cycle's candidate, contract hash and evidence
 *   sequence — otherwise it is an unusable observation, worth exactly one retry.
 *
 *   **The boundary decides before the outside world is touched.** `AUDIT_PASS` crosses
 *   `AUDITING → READY_TO_MERGE`, so §11 is evaluated first; a boundary that refuses produces no
 *   settlement effect and no record at all.
 *
 *   **`SETTLED` is the adapter's statement about its backend, not about a call returning.** Until
 *   it says so, there is no audit record and no transition.
 *
 * Core reaches the audit gate only through the opaque `VerificationRunHandle` it already holds. No
 * workflow handle, no controller, no backend identity ever appears here.
 */

import type { RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import type { RuntimeTurnHandle, VerificationRunHandle } from "../../adapters/interfaces/handles.ts";
import type {
  RuntimeAdapter,
  RuntimeTurnResult,
} from "../../adapters/interfaces/runtime-adapter.ts";
import type {
  PlatformAuditVerdict,
  VerificationAdapter,
  VerificationEvidence,
} from "../../adapters/interfaces/verification-adapter.ts";
import type { ContractSourceReader, TaskContractV1Body } from "../contract/types.ts";
import { buildAuditDecision } from "../humandecision/audit-decision.ts";
import type { ProfileSource } from "../profile/types.ts";
import type { CanonicalObject, CanonicalValue } from "../schemas/canonical-json.ts";
import {
  commitAttemptFact,
  type PendingDecisionCreation,
} from "../statemachine/transition-commit.ts";
import type { TaskAttemptRow, TaskRow } from "../store/domain-types.ts";
import {
  validateAuditorVerdict,
  type AuditorVerdictV1,
  type VerificationEvidenceV1,
} from "../store/mvp1-artifact-stores.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type { TaskSourceV1 } from "../tasksource/types.ts";
import { assembleDriftObservation } from "./assemble-drift-observation.ts";
import {
  auditDecisionOp,
  auditorTurn1Op,
  auditorTurn2Op,
  auditorTurnMetadataKey,
} from "./audit-operations.ts";
import {
  auditInstruction,
  auditorReviewContext,
  type AuditorReviewContextV1,
} from "./auditor-review.ts";
import { applyDriftStop, type DriftStopOutcome } from "./drift-lifecycle.ts";
import { evaluateStageBoundaryDrift } from "./stage-boundary-drift.ts";
import { loadFrozenAuditorCapability } from "./start-auditing.ts";
import {
  ExecutionStartError,
  REPOSITORY_ADAPTER,
  RUNTIME_ADAPTER,
  WORKSPACE_METADATA_KEY,
} from "./start-implementation.ts";

/** TD §16.2 — the one protocol an Auditor verdict may arrive on. */
const AUDITOR_VERDICT_PROTOCOL = "platform-auditor-verdict-v1";

/** TD §18.1c — generic provenance for the audit commit. Never a backend state or identity. */
const COMMITTED_VIA = "platform-audit-settlement:1";

/** TD §18.2 — the journal kind for an unusable Auditor observation. Not a table (§16.2). */
export const AUDIT_OBSERVATION_KIND = "audit_observation";

/** TD §18.1c — where B7/B8 left the run's opaque reference. */
const VERIFICATION_ADAPTER = "verification";
const VERIFICATION_RUN_METADATA_KEY = "run";

export interface AuditCompletionAuthorities {
  readonly store: PlatformStore;
  readonly runtime: RuntimeAdapter;
  readonly verification: VerificationAdapter;
  /** TD §11.4 — the three read seams the stage-boundary assembler needs. */
  readonly repository: RepositoryAdapter;
  readonly profiles: ProfileSource;
  readonly taskSource: TaskSourceV1;
  readonly contractSources: ContractSourceReader;
}

export interface CompleteAuditingCommand {
  readonly attempt_key: string;
  /** Caller-allocated ULID for the `audit_record` this cycle may produce (TD §17.1/§18.1c). */
  readonly audit_id?: string;
  /** Caller-allocated ULID for a decision this cycle may open (drift hold, or HUMAN_REQUIRED). */
  readonly decision_id?: string;
  readonly report_channel?: string;
  /** Caller-supplied observation time — Core reads no clock. */
  readonly recorded_at?: string;
}

/** Why a structured result could not be read as this cycle's verdict (TD §16.2). */
export type AuditInvalidReason =
  | "NO_STRUCTURED_RESULT"
  | "WRONG_PROTOCOL"
  | "MALFORMED_VERDICT"
  | "CANDIDATE_MISMATCH"
  | "CONTRACT_HASH_MISMATCH"
  | "EVIDENCE_MISMATCH";

export type CompleteAuditingOutcome =
  /** The turn could not be observed at all. Nothing was read as a fact and nothing was written. */
  | { readonly kind: "TURN_UNOBSERVABLE"; readonly attempt_key: string }
  /** §16.2 — the first unusable observation; the one permitted retry has been sent. */
  | {
      readonly kind: "AUDIT_RETRY_STARTED";
      readonly attempt_key: string;
      readonly reason: AuditInvalidReason;
      readonly op_key: string;
    }
  /** §16.2 — the retry produced an unusable result too. No third turn exists. */
  | {
      readonly kind: "AUDIT_UNUSABLE";
      readonly attempt_key: string;
      readonly reason: AuditInvalidReason;
      readonly transition_seq: number;
    }
  /** §11.4 — the boundary refused before any settlement effect (M1-11/M1-12). */
  | DriftStopOutcome
  /** §16.3 — a valid verdict whose settlement could not be established or contradicts the gate. */
  | {
      readonly kind: "HELD";
      readonly attempt_key: string;
      readonly reason_code: "RUNTIME_FAILED" | "AUDIT_GATE_UNAVAILABLE" | "RECOVERY_CONFLICT";
      readonly transition_seq: number;
    }
  /** §16.3 — the audit decision is settled and durable; the branch has been applied. */
  | {
      readonly kind: "AUDIT_DECIDED";
      readonly attempt_key: string;
      readonly verdict: PlatformAuditVerdict;
      readonly audit_id: string;
      readonly decision_id?: string;
      readonly transition_seq: number;
    };

/** Runs one audit-completion pass for an `AUDITING` attempt. Safe to call again at any point. */
export function completeAuditing(
  authorities: AuditCompletionAuthorities,
  command: CompleteAuditingCommand,
): CompleteAuditingOutcome {
  const { store } = authorities;
  const attempt_key = command.attempt_key;
  const attempt = store.attempts.require(attempt_key);
  const task = store.tasks.require(attempt.task_key);
  requireAuditable(attempt, task);

  const contract = requireContract(store, attempt);
  const candidate = attempt.candidate_commit as string;
  const review = auditorReviewContext(store, attempt, contract);
  const decision_op = auditDecisionOp(attempt_key, candidate);

  // §21 AD5 — a completed cycle is complete. The backend is not asked again and no second record
  // is written; the operation's own stored result is the authority for which record it produced.
  const settled = store.idempotency.get(decision_op);
  if (settled?.state === "DONE") {
    return {
      kind: "AUDIT_DECIDED",
      attempt_key,
      verdict: recordedVerdict(store, settled.result),
      audit_id: recordedAuditId(settled.result),
      transition_seq: 0,
    };
  }
  if (settled?.state === "FAILED") {
    throw new ExecutionStartError(`${decision_op} is FAILED; a new attempt is a human decision`);
  }

  // --- which turn this pass is about ------------------------------------------------------------
  const turn = resolveTurn(store, attempt_key, candidate);
  if (turn.kind === "INDETERMINATE") {
    // §21 AT3/AT4 — the retry may have been accepted and its handle never landed. Backend v1 can
    // prove neither, so the one thing that must not happen is a third Auditor turn.
    return held(store, attempt_key, "RECOVERY_CONFLICT");
  }

  let result: RuntimeTurnResult;
  try {
    result = authorities.runtime.get_turn_result(turn.handle);
  } catch {
    // Not an answer about the candidate and not a failure of the Auditor: nothing is recorded.
    return { kind: "TURN_UNOBSERVABLE", attempt_key };
  }

  if (result.backend_status !== "COMPLETED") {
    // §5 — the Runtime failed. That is not the Auditor producing an invalid verdict, so it spends
    // no retry, settles nothing and writes no record.
    return held(store, attempt_key, "RUNTIME_FAILED");
  }

  const usable = readVerdict(result, review);
  if (usable.kind === "INVALID") {
    return handleInvalid(authorities, {
      attempt_key,
      contract,
      review,
      reason: usable.reason,
      retried: turn.retried,
    });
  }

  return decide(authorities, command, {
    attempt,
    task,
    contract,
    candidate,
    review,
    decision_op,
    verdict: usable.envelope,
  });
}

// --- observing the turn ---------------------------------------------------------------------------

type TurnResolution =
  | { readonly kind: "TURN"; readonly handle: RuntimeTurnHandle; readonly retried: boolean }
  | { readonly kind: "INDETERMINATE" };

/**
 * §16.1 — the cycle is on its retry exactly when the retry operation exists. An intent with no
 * durable handle is the AT3/AT4 window: the turn may or may not have been accepted, so it is never
 * resent and never observed as if it had not happened.
 */
function resolveTurn(
  store: PlatformStore,
  attempt_key: string,
  candidate: string,
): TurnResolution {
  const retry = store.idempotency.get(auditorTurn2Op(attempt_key, candidate));
  if (retry !== undefined) {
    const handle = turnHandle(store, attempt_key, candidate, 2);
    return handle === undefined ? { kind: "INDETERMINATE" } : { kind: "TURN", handle, retried: true };
  }
  const first = store.idempotency.get(auditorTurn1Op(attempt_key, candidate));
  if (first?.state !== "DONE") {
    throw new ExecutionStartError(`${attempt_key} has no completed Auditor turn for ${candidate}`);
  }
  const handle = turnHandle(store, attempt_key, candidate, 1);
  if (handle === undefined) {
    throw new ExecutionStartError(`${attempt_key}'s Auditor turn has no durable handle`);
  }
  return { kind: "TURN", handle, retried: false };
}

function turnHandle(
  store: PlatformStore,
  attempt_key: string,
  candidate: string,
  turn: 1 | 2,
): RuntimeTurnHandle | undefined {
  const row = store.adapterMetadata.get(
    attempt_key,
    RUNTIME_ADAPTER,
    auditorTurnMetadataKey(candidate, turn),
  );
  // Opaque on the way in and on the way out: Core never looks inside it.
  return row === undefined ? undefined : (row.value as unknown as RuntimeTurnHandle);
}

// --- reading the verdict ---------------------------------------------------------------------------

type VerdictReading =
  | { readonly kind: "VALID"; readonly envelope: AuditorVerdictV1 }
  | { readonly kind: "INVALID"; readonly reason: AuditInvalidReason };

/**
 * TD §16.2 — the envelope must arrive on the Auditor protocol, validate, and bind to *this* cycle.
 *
 * `model_declared_outcome` and the turn's text are deliberately never consulted: a verdict the
 * Platform acts on comes from the structured channel or it does not exist (I-TD3, §13.2).
 */
function readVerdict(result: RuntimeTurnResult, review: AuditorReviewContextV1): VerdictReading {
  const structured = result.structured_output;
  if (structured === undefined) return { kind: "INVALID", reason: "NO_STRUCTURED_RESULT" };
  if (structured.protocol !== AUDITOR_VERDICT_PROTOCOL) {
    return { kind: "INVALID", reason: "WRONG_PROTOCOL" };
  }

  let envelope: AuditorVerdictV1;
  try {
    envelope = validateAuditorVerdict(structured.body);
  } catch {
    return { kind: "INVALID", reason: "MALFORMED_VERDICT" };
  }

  const reviewed = envelope.reviewed;
  if (reviewed.candidate_commit !== review.candidate_commit) {
    return { kind: "INVALID", reason: "CANDIDATE_MISMATCH" };
  }
  if (reviewed.task_contract_hash !== review.task_contract_hash) {
    return { kind: "INVALID", reason: "CONTRACT_HASH_MISMATCH" };
  }
  // §16.2 — positional exact equality against the authoritative sequence. Not a set, not sorted,
  // not deduplicated: a reordered or shortened echo is a different claim about what was reviewed.
  const expected = review.evidence_ids;
  const same =
    reviewed.evidence_ids.length === expected.length &&
    reviewed.evidence_ids.every((id, index) => id === expected[index]);
  return same ? { kind: "VALID", envelope } : { kind: "INVALID", reason: "EVIDENCE_MISMATCH" };
}

// --- the unusable path ------------------------------------------------------------------------------

/**
 * TD §16.2 — one retry per candidate, then the cycle is over.
 *
 * The retry is a new turn on the **same** Auditor session: the verdict was unusable, not the
 * session's identity, so no second spawn, workspace or grant is created. The candidate, the
 * contract and the evidence are re-stated verbatim — the retry cannot move the basis it is judged
 * against.
 */
function handleInvalid(
  authorities: AuditCompletionAuthorities,
  input: {
    readonly attempt_key: string;
    readonly contract: TaskContractV1Body;
    readonly review: AuditorReviewContextV1;
    readonly reason: AuditInvalidReason;
    readonly retried: boolean;
  },
): CompleteAuditingOutcome {
  const { store } = authorities;
  const attempt_key = input.attempt_key;
  const candidate = input.review.candidate_commit;
  recordInvalid(store, attempt_key, candidate, input.reason, input.retried);

  if (input.retried) {
    // §16.2 — the retry is spent. No third turn, no settlement, no record, no decision.
    return {
      kind: "AUDIT_UNUSABLE",
      attempt_key,
      reason: input.reason,
      transition_seq: holdTransition(store, attempt_key, "AUDIT_UNUSABLE"),
    };
  }

  const op_key = auditorTurn2Op(attempt_key, candidate);
  store.withTransaction(() => {
    store.idempotency.beginIntent(op_key);
  });

  const session = requireAuditorSession(store, attempt_key);
  const workspace = requireReviewPath(store, attempt_key);
  let handle: RuntimeTurnHandle;
  try {
    // Outside every transaction, exactly like the first turn (M1-8/M1-10).
    handle = authorities.runtime.send_turn(
      { op_key },
      session,
      auditInstruction(input.contract, workspace, input.review, describe(input.reason)),
    );
  } catch {
    // A throw does not prove the turn was refused. Fail closed rather than resend.
    return held(store, attempt_key, "RECOVERY_CONFLICT");
  }

  store.withTransaction(() => {
    store.adapterMetadata.put({
      entity_key: attempt_key,
      adapter_id: RUNTIME_ADAPTER,
      key: auditorTurnMetadataKey(candidate, 2),
      value: handle as unknown as CanonicalValue,
    });
    store.idempotency.markDone(op_key, handle as unknown as CanonicalValue);
  });
  return { kind: "AUDIT_RETRY_STARTED", attempt_key, reason: input.reason, op_key };
}

/** §16.2/§18.2 — an unusable observation is journal evidence, never an artifact row. */
function recordInvalid(
  store: PlatformStore,
  attempt_key: string,
  candidate: string,
  reason: AuditInvalidReason,
  retried: boolean,
): void {
  store.withTransaction(() => {
    store.decisions.append({
      kind: AUDIT_OBSERVATION_KIND,
      refKey: attempt_key,
      payload: {
        observation: "AUDIT_INVALID",
        attempt_key,
        candidate_commit: candidate,
        reason,
        turn: retried ? 2 : 1,
      } as unknown as CanonicalObject,
    });
  });
}

/** Descriptive only — it explains the fault and confers no authority (§16.2). */
const describe = (reason: AuditInvalidReason): string => {
  switch (reason) {
    case "NO_STRUCTURED_RESULT":
      return "no structured result was returned";
    case "WRONG_PROTOCOL":
      return "it was not a platform-auditor-verdict-v1 envelope";
    case "MALFORMED_VERDICT":
      return "the envelope did not match the platform-auditor-verdict-v1 schema";
    case "CANDIDATE_MISMATCH":
      return "reviewed.candidate_commit was not the candidate under review";
    case "CONTRACT_HASH_MISMATCH":
      return "reviewed.task_contract_hash was not this attempt's contract hash";
    case "EVIDENCE_MISMATCH":
      return "reviewed.evidence_ids was not the exact evidence sequence, in order";
  }
};

// --- the decision -------------------------------------------------------------------------------------

/**
 * TD §16.3 / §19.3 — the boundary first, then the settlement, then one atomic commit.
 *
 * Only `AUDIT_PASS` crosses `AUDITING → READY_TO_MERGE`, so only it is asked about drift; adding a
 * "safety" evaluation to the other two would invent a second policy path for boundaries §11 does
 * not own.
 */
function decide(
  authorities: AuditCompletionAuthorities,
  command: CompleteAuditingCommand,
  input: {
    readonly attempt: TaskAttemptRow;
    readonly task: TaskRow;
    readonly contract: TaskContractV1Body;
    readonly candidate: string;
    readonly review: AuditorReviewContextV1;
    readonly decision_op: string;
    readonly verdict: AuditorVerdictV1;
  },
): CompleteAuditingOutcome {
  const { store } = authorities;
  const attempt_key = input.attempt.attempt_key;
  const verdict = input.verdict.verdict;

  if (verdict === "AUDIT_PASS") {
    const drift = evaluateStageBoundaryDrift(
      assembleDriftObservation(authorities, {
        boundary: "AUDITING_TO_READY_TO_MERGE",
        attempt: input.attempt,
        contract: input.contract,
        compiled: store.batchView.compiledProfileFor(input.task.batch_id),
        auditor_grant: loadFrozenAuditorCapability(store, attempt_key, input.contract),
      }),
    );
    if (drift.kind !== "CONTINUE") {
      // The boundary refused, so the external settlement never happens and no record exists to
      // claim this cycle succeeded.
      return applyDriftStop(store, {
        attempt_key,
        task_key: input.task.task_key,
        outcome: drift,
        ...(command.decision_id === undefined ? {} : { decision_id: command.decision_id }),
        ...(command.report_channel === undefined ? {} : { report_channel: command.report_channel }),
      });
    }
  }

  const evidence = authoritativeEvidence(store, input.review);

  // §21 — write-ahead intent, then the external effect, and nothing durable in between.
  store.withTransaction(() => {
    store.idempotency.beginIntent(input.decision_op);
  });
  const settlement = authorities.verification.settle_audit(
    { op_key: input.decision_op },
    requireRunHandle(store, attempt_key),
    verdict,
    evidence,
  );
  if (settlement.kind === "UNAVAILABLE") {
    return held(store, attempt_key, "AUDIT_GATE_UNAVAILABLE");
  }
  if (settlement.kind === "CONFLICT") {
    // The gate is settled with a different decision. Overwriting a backend-authoritative answer is
    // exactly what fail-closed exists to prevent.
    return held(store, attempt_key, "RECOVERY_CONFLICT");
  }

  return commitDecision(authorities, command, {
    ...input,
    attempt_key,
    verdict_value: verdict,
    envelope: input.verdict,
  });
}

/** The one transaction that makes an audit decision durable — never before `SETTLED`. */
function commitDecision(
  authorities: AuditCompletionAuthorities,
  command: CompleteAuditingCommand,
  input: {
    readonly attempt_key: string;
    readonly task: TaskRow;
    readonly candidate: string;
    readonly review: AuditorReviewContextV1;
    readonly decision_op: string;
    readonly verdict_value: PlatformAuditVerdict;
    readonly envelope: AuditorVerdictV1;
  },
): CompleteAuditingOutcome {
  const { store } = authorities;
  const audit_id = command.audit_id;
  const recorded_at = command.recorded_at;
  if (audit_id === undefined || recorded_at === undefined) {
    throw new ExecutionStartError(
      `${input.attempt_key} settled an audit, which needs an allocated audit id and an observation time`,
    );
  }

  const decision =
    input.verdict_value === "HUMAN_REQUIRED"
      ? requireAuditDecision(command, {
          task_key: input.task.task_key,
          attempt_key: input.attempt_key,
          candidate_commit: input.candidate,
          audit_id,
        })
      : undefined;
  if (decision !== undefined) {
    // §17.1c — the same cycle on a second pass finds the open record instead of opening a second.
    const existing = store.pendingDecisions.byDedupKey(decision.decision.dedup_key);
    if (existing !== undefined) {
      throw new ExecutionStartError(
        `${input.attempt_key} already has an open AUDIT_DECISION for ${input.candidate}`,
      );
    }
  }

  const committed = commitAttemptFact(store, {
    attempt_key: input.attempt_key,
    // §19.2 — the sealed guard owns every branch. `drift_clear` is true because `AUDIT_PASS`
    // reached here only through a `CONTINUE` boundary, and the other two do not cross one.
    fact: { kind: "AUDIT_DECIDED", verdict: input.verdict_value, drift_clear: true },
    ...(decision === undefined ? {} : { decision }),
    within: () => {
      store.auditRecords.put({
        audit_id,
        attempt_key: input.attempt_key,
        candidate_commit: input.review.candidate_commit,
        task_contract_hash: input.review.task_contract_hash,
        envelope: input.envelope,
        committed_via: COMMITTED_VIA,
        recorded_at,
      });
      store.idempotency.markDone(input.decision_op, {
        audit_id,
        verdict: input.verdict_value,
      } as unknown as CanonicalValue);
    },
  });

  return {
    kind: "AUDIT_DECIDED",
    attempt_key: input.attempt_key,
    verdict: input.verdict_value,
    audit_id,
    ...(decision === undefined ? {} : { decision_id: decision.decision.decision_id }),
    transition_seq: committed.transition.seq,
  };
}

function requireAuditDecision(
  command: CompleteAuditingCommand,
  input: {
    readonly task_key: string;
    readonly attempt_key: string;
    readonly candidate_commit: string;
    readonly audit_id: string;
  },
): PendingDecisionCreation {
  if (command.decision_id === undefined || command.report_channel === undefined) {
    throw new ExecutionStartError(
      `${input.attempt_key} needs an allocated decision id and a report channel for HUMAN_REQUIRED`,
    );
  }
  return {
    decision: buildAuditDecision({ decision_id: command.decision_id, ...input }),
    channel: command.report_channel,
  };
}

// --- authoritative reads ------------------------------------------------------------------------------

/**
 * §16.3 — the evidence the gate is settled against is the Platform's own stored set, in the same
 * order the Auditor was given. The verdict's copy of the identities is never the source.
 */
function authoritativeEvidence(
  store: PlatformStore,
  review: AuditorReviewContextV1,
): readonly VerificationEvidence[] {
  return review.evidence_ids.map((evidence_id) => {
    const envelope: VerificationEvidenceV1 | undefined =
      store.verificationEvidence.envelope(evidence_id);
    if (envelope === undefined) {
      throw new ExecutionStartError(`evidence ${evidence_id} is no longer readable`);
    }
    return envelope as unknown as VerificationEvidence;
  });
}

function requireRunHandle(store: PlatformStore, attempt_key: string): VerificationRunHandle {
  const row = store.adapterMetadata.get(
    attempt_key,
    VERIFICATION_ADAPTER,
    VERIFICATION_RUN_METADATA_KEY,
  );
  if (row === undefined) {
    throw new ExecutionStartError(`${attempt_key} has no durable verification run reference`);
  }
  // Handed back exactly as it was stored. Core has never looked inside it and does not now.
  return row.value as unknown as VerificationRunHandle;
}

function requireAuditorSession(store: PlatformStore, attempt_key: string) {
  const row = store.adapterMetadata.get(attempt_key, RUNTIME_ADAPTER, "auditor_session");
  if (row === undefined) {
    throw new ExecutionStartError(`${attempt_key} has no durable Auditor session`);
  }
  return row.value as never;
}

/** The review path B6 created and B10 already showed the Auditor. No repository call is made. */
function requireReviewPath(store: PlatformStore, attempt_key: string) {
  const row = store.adapterMetadata.get(attempt_key, REPOSITORY_ADAPTER, WORKSPACE_METADATA_KEY);
  if (row === undefined) {
    throw new ExecutionStartError(`${attempt_key} has no durable workspace reference`);
  }
  const stored = row.value as unknown as { path: string; base_head: string; branch: string };
  return { path: stored.path, base_head: stored.base_head, branch: stored.branch };
}

// --- preconditions --------------------------------------------------------------------------------------

function requireAuditable(attempt: TaskAttemptRow, task: TaskRow): void {
  if (attempt.state !== "AUDITING") {
    throw new ExecutionStartError(`an audit decision requires AUDITING, not ${attempt.state}`);
  }
  if (task.platform_state !== "ACTIVE") {
    throw new ExecutionStartError(`${task.task_key} is ${task.platform_state}, not ACTIVE`);
  }
  if (attempt.candidate_commit === null) {
    throw new ExecutionStartError(`${attempt.attempt_key} is AUDITING without a candidate`);
  }
}

function requireContract(store: PlatformStore, attempt: TaskAttemptRow): TaskContractV1Body {
  const envelope = store.contracts.get(attempt.contract_snapshot_id);
  if (envelope === undefined) {
    throw new ExecutionStartError(`contract ${attempt.contract_snapshot_id} is missing`);
  }
  return envelope.body as unknown as TaskContractV1Body;
}

type AuditHoldReason = "RUNTIME_FAILED" | "AUDIT_GATE_UNAVAILABLE" | "RECOVERY_CONFLICT";

/** Parks the task under a §24 reason. The attempt stays where it is — still `AUDITING`. */
function held(
  store: PlatformStore,
  attempt_key: string,
  reason_code: AuditHoldReason,
): Extract<CompleteAuditingOutcome, { kind: "HELD" }> {
  return {
    kind: "HELD",
    attempt_key,
    reason_code,
    transition_seq: holdTransition(store, attempt_key, reason_code),
  };
}

const holdTransition = (
  store: PlatformStore,
  attempt_key: string,
  reason_code: AuditHoldReason | "AUDIT_UNUSABLE",
): number =>
  commitAttemptFact(store, { attempt_key, fact: { kind: "EXECUTION_HELD", reason_code } })
    .transition.seq;

const recordedAuditId = (result: CanonicalValue | undefined): string => {
  const value = (result as { audit_id?: unknown } | undefined)?.audit_id;
  if (typeof value !== "string") throw new ExecutionStartError("the settled audit has no audit id");
  return value;
};

const recordedVerdict = (store: PlatformStore, result: CanonicalValue | undefined): PlatformAuditVerdict => {
  const record = store.auditRecords.get(recordedAuditId(result));
  if (record === undefined) throw new ExecutionStartError("the settled audit has no record");
  return record.verdict as PlatformAuditVerdict;
};
