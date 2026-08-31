/**
 * §17.4 — PendingDecision resolution application (v1.5 PR #43 amendment, D22).
 *
 * **Decision resolution is not itself a lifecycle effect.** A durable `RESOLVED` record is the
 * person's answer; whether and how that answer moves the Task/Attempt lifecycle is decided here,
 * by the exact category × origin × chosen-option mapping the TD tabulates — nothing else. The
 * protocol is fixed:
 *
 *     resolved choice → record/hash/options/category/created_from exact validation
 *     → fresh owner reads + state revalidation → exact mapping lookup → allowed source guard
 *     → existing deterministic transition command
 *     → success: transition + applied_transition_ref, one transaction
 *     → refusal: RESOLVED(applied_transition_ref = null) stays, safe-held state kept
 *
 * There is deliberately no generic "resolve any decision" dispatcher: an unmapped
 * category/origin/option combination is a refusal, never an improvisation, and resolution text is
 * never reinterpreted as a different option.
 *
 * **One judgement per resolution.** Terminal-record immutability forbids background retry of a
 * refused application, so each RESOLVED record gets exactly one judged application attempt,
 * recorded under `op:decision:<id>:apply`. An authority that cannot be read (owner unavailable)
 * is *not* a judgement — nothing is spent, and a later pass may observe again; that is the same
 * unavailability-vs-absence distinction §22.5 draws.
 */

import type { RepositoryAdapter } from "../../adapters/interfaces/repository-adapter.ts";
import {
  auditDecisionCause,
  driftCause,
  hashPendingDecision,
  MERGE_MISMATCH_PREFIX,
  MERGE_REJECT_PREFIX,
  mergeDecisionCause,
  type PendingDecisionV1,
} from "../humandecision/index.ts";
import type { CanonicalValue } from "../schemas/canonical-json.ts";
import {
  commitAttemptFact,
  commitTaskAbandonment,
  commitTaskReattemptReentry,
} from "../statemachine/transition-commit.ts";
import { blockedByDecision, type ResolvedDecisionApplication } from "../statemachine/types.ts";
import type { TaskContractV1Body } from "../contract/types.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import type { TaskAttemptRow, TaskRow } from "../store/domain-types.ts";

export interface ResolvedDecisionAuthorities {
  readonly store: PlatformStore;
  /** Needed only for the `RECOVERY_DECISION` origin's fresh canonical re-observation. */
  readonly repository: RepositoryAdapter;
}

export type ApplyResolvedDecisionOutcome =
  | { readonly kind: "APPLIED"; readonly decision_id: string; readonly transition_seq: number }
  /** Judged and refused: the record stays `RESOLVED(null)` and the judgement is spent. */
  | { readonly kind: "REFUSED"; readonly decision_id: string; readonly reason: string }
  /** An owner could not be read; nothing was judged and nothing was spent. */
  | { readonly kind: "OWNER_UNAVAILABLE"; readonly decision_id: string }
  | { readonly kind: "NOTHING_TO_APPLY" };

/** The §17.4 application op — one judged attempt per resolution, ever. */
export const applyOpKey = (decision_id: string): string => `op:decision:${decision_id}:apply`;

const CATEGORIES: readonly string[] = [
  "AUDIT_DECISION",
  "REATTEMPT_DECISION",
  "CONTRACT_DECISION",
  "RECOVERY_DECISION",
];

/**
 * Applies at most one resolved, unapplied, not-yet-judged non-merge decision for this task.
 * `MERGE_APPROVAL` stays with §19.4's own narrow entry point and is never touched here.
 */
export function applyResolvedDecisionForTask(
  authorities: ResolvedDecisionAuthorities,
  command: { readonly task_key: string },
): ApplyResolvedDecisionOutcome {
  const { store } = authorities;
  for (const record of store.pendingDecisions.forSubject(command.task_key)) {
    const decision = record.body;
    if (!CATEGORIES.includes(decision.category)) continue;
    if (decision.status !== "RESOLVED") continue;
    if (decision.resolution?.applied_transition_ref !== null) continue;
    if (store.idempotency.get(applyOpKey(decision.decision_id))?.state === "DONE") continue;

    return applyOne(authorities, record.body, record.record_hash);
  }
  return { kind: "NOTHING_TO_APPLY" };
}

// --- one resolution ------------------------------------------------------------------------------

function applyOne(
  authorities: ResolvedDecisionAuthorities,
  decision: PendingDecisionV1,
  record_hash: string | null,
): ApplyResolvedDecisionOutcome {
  const { store } = authorities;
  const id = decision.decision_id;

  // I-TD2 — the judgement is announced before it runs. A crash mid-judgement leaves INTENT, and
  // the next pass re-judges from fresh reads; only a committed DONE is a spent attempt.
  store.withTransaction(() => {
    store.idempotency.beginIntent(applyOpKey(id));
  });

  // --- record validation, before anything about the world -------------------------------------
  if (record_hash === null || record_hash !== hashPendingDecision(decision)) {
    return refuse(store, id, "the terminal record hash does not verify");
  }
  const chosen = decision.resolution?.chosen_option;
  if (chosen === null || chosen === undefined || !decision.options.includes(chosen)) {
    return refuse(store, id, "the resolution does not name an offered option");
  }
  if (decision.subject.kind !== "TASK") {
    return refuse(store, id, "only TASK-subject decisions have a §17.4 mapping");
  }
  const task_key = decision.subject.task_key;

  // --- the exact mapping row -------------------------------------------------------------------
  const row = mappingRow(decision, chosen);
  if (row === undefined) {
    return refuse(store, id, `no §17.4 mapping for ${decision.category}/${decision.created_from}/${chosen}`);
  }

  // --- fresh owner reads + revalidation --------------------------------------------------------
  const task = store.tasks.get(task_key);
  if (task === undefined) return refuse(store, id, "the subject task row is gone");
  if (task.platform_state !== "HELD") {
    return refuse(store, id, `the task is ${task.platform_state}, not the safe-held source state`);
  }
  if (task.state_reason?.code !== blockedByDecision(id)) {
    return refuse(store, id, "the task is no longer held by this exact decision");
  }

  const source = store.attempts.get(row.attempt_key);
  if (source === undefined) return refuse(store, id, "the source Attempt named by created_from is gone");
  const current = store.attempts.current(task_key);
  if (current !== undefined && current.attempt_key !== source.attempt_key) {
    return refuse(store, id, "a newer Attempt exists; the question is about a superseded one");
  }

  try {
    return row.apply(authorities, { decision, task, source, chosen });
  } catch (error) {
    if (error instanceof OwnerUnavailable) return { kind: "OWNER_UNAVAILABLE", decision_id: id };
    // The transition command itself refused (its transaction rolled back). Judged: spent.
    return refuse(store, id, error instanceof Error ? error.message : String(error));
  }
}

class OwnerUnavailable extends Error {}

interface ApplicationContext {
  readonly decision: PendingDecisionV1;
  readonly task: TaskRow;
  readonly source: TaskAttemptRow;
  readonly chosen: string;
}

interface MappingRow {
  readonly attempt_key: string;
  readonly apply: (
    authorities: ResolvedDecisionAuthorities,
    context: ApplicationContext,
  ) => ApplyResolvedDecisionOutcome;
}

/**
 * The exhaustive current-v1 mapping (§17.4 table). Each row closes over the origin's parsed
 * provenance; a `created_from` outside the Core-owned grammar has no row at all.
 */
function mappingRow(decision: PendingDecisionV1, chosen: string): MappingRow | undefined {
  if (decision.category === "AUDIT_DECISION") {
    const cause = auditDecisionCause(decision);
    if (cause === undefined) return undefined;
    if (chosen === "REQUEST_REWORK") {
      return { attempt_key: cause.attempt_key, apply: auditRework(cause.candidate_commit) };
    }
    if (chosen === "ABANDON") {
      return { attempt_key: cause.attempt_key, apply: abandonLive("AUDITING", cause.candidate_commit) };
    }
    return undefined;
  }

  if (decision.category === "REATTEMPT_DECISION") {
    const drift = driftCause(decision);
    if (drift !== undefined) {
      // Source already INVALIDATED by the drift path — task-only applications.
      if (chosen === "REATTEMPT_WITH_NEW_SNAPSHOT") {
        return { attempt_key: drift.attempt_key, apply: reattemptOverTerminal("INVALIDATED") };
      }
      if (chosen === "ABANDON") {
        return { attempt_key: drift.attempt_key, apply: abandonOverTerminal("INVALIDATED") };
      }
      return undefined;
    }
    if (decision.created_from.startsWith(MERGE_REJECT_PREFIX)) {
      const cause = mergeDecisionCause(decision);
      if (cause === undefined) return undefined;
      if (chosen === "REATTEMPT_WITH_NEW_SNAPSHOT") {
        return {
          attempt_key: cause.attempt_key,
          apply: reattemptLive("READY_TO_MERGE", "REATTEMPT_REQUESTED", cause.candidate_commit),
        };
      }
      if (chosen === "ABANDON") {
        return { attempt_key: cause.attempt_key, apply: abandonLive("READY_TO_MERGE", cause.candidate_commit) };
      }
    }
    return undefined;
  }

  if (decision.category === "CONTRACT_DECISION") {
    const drift = driftCause(decision);
    if (drift === undefined) return undefined;
    if (chosen === "ALLOW_FROZEN_SNAPSHOT_TO_COMPLETE") {
      return { attempt_key: drift.attempt_key, apply: allowFrozen() };
    }
    if (chosen === "INVALIDATE_ATTEMPT") {
      return { attempt_key: drift.attempt_key, apply: invalidateContractDrift() };
    }
    return undefined;
  }

  // RECOVERY_DECISION — only the merge-mismatch origin has a v1 mapping.
  if (!decision.created_from.startsWith(MERGE_MISMATCH_PREFIX)) return undefined;
  const cause = mergeDecisionCause(decision);
  if (cause === undefined) return undefined;
  if (chosen === "REATTEMPT_WITH_NEW_SNAPSHOT") {
    return {
      attempt_key: cause.attempt_key,
      apply: recoveryReattempt(cause.candidate_commit),
    };
  }
  if (chosen === "ABANDON") {
    return {
      attempt_key: cause.attempt_key,
      apply: abandonLive("APPROVED_FOR_MANUAL_MERGE", cause.candidate_commit),
    };
  }
  return undefined;
}

// --- the applications ----------------------------------------------------------------------------

/** Shared: the frozen contract still loads and re-hashes, and both frozen grants still load. */
function frozenBasisIntact(store: PlatformStore, source: TaskAttemptRow): boolean {
  let contract;
  try {
    contract = store.contracts.get(source.contract_snapshot_id);
  } catch {
    return false;
  }
  if (contract === undefined) return false;
  const grants = (contract.body as unknown as TaskContractV1Body).capability_grants;
  for (const role of ["actor", "auditor"] as const) {
    const grant_id = grants?.[role]?.grant_id;
    if (typeof grant_id !== "string" || store.grants.get(grant_id) === undefined) return false;
  }
  return true;
}

function commitApplication(
  store: PlatformStore,
  decision_id: string,
  attempt_key: string,
  application: ResolvedDecisionApplication,
): ApplyResolvedDecisionOutcome {
  const committed = commitAttemptFact(store, {
    attempt_key,
    fact: { kind: "RESOLVED_DECISION_APPLIED", application },
    within: (transition) => {
      store.pendingDecisions.recordAppliedTransition(decision_id, transition.seq);
      store.idempotency.markDone(applyOpKey(decision_id), {
        applied_transition_seq: transition.seq,
      } as unknown as CanonicalValue);
    },
  });
  return { kind: "APPLIED", decision_id, transition_seq: committed.transition.seq };
}

function auditRework(candidate: string) {
  return (
    { store }: ResolvedDecisionAuthorities,
    { decision, task, source }: ApplicationContext,
  ): ApplyResolvedDecisionOutcome => {
    const id = decision.decision_id;
    if (source.state !== "AUDITING") return refuse(store, id, `the source Attempt is ${source.state}, not AUDITING`);
    if (source.candidate_commit !== candidate) {
      return refuse(store, id, "the Attempt's candidate is no longer the audited one");
    }
    if (!auditEvidenceBinds(store, decision, source, candidate)) {
      return refuse(store, id, "the audit evidence no longer binds to this exact cycle");
    }
    const limits = store.batchView.compiledProfileFor(task.batch_id).effective.policy.batch_policy;
    if (source.rework_count >= limits.max_rework) {
      return refuse(store, id, "no rework remains; the mapping row requires remaining rework");
    }
    if (!frozenBasisIntact(store, source)) return refuse(store, id, "the frozen contract/grant basis no longer loads");
    return commitApplication(store, id, source.attempt_key, { kind: "AUDIT_REWORK" });
  };
}

function abandonLive(expected: TaskAttemptRow["state"], candidate: string) {
  return (
    { store }: ResolvedDecisionAuthorities,
    { decision, source }: ApplicationContext,
  ): ApplyResolvedDecisionOutcome => {
    const id = decision.decision_id;
    if (source.state !== expected) return refuse(store, id, `the source Attempt is ${source.state}, not ${expected}`);
    if (source.candidate_commit !== candidate) {
      return refuse(store, id, "the Attempt's candidate is no longer the one the question was about");
    }
    return commitApplication(store, id, source.attempt_key, { kind: "ABANDON", decision_id: id });
  };
}

function reattemptLive(
  expected: TaskAttemptRow["state"],
  attempt_reason: "REATTEMPT_REQUESTED" | "RECOVERY_CONFLICT",
  candidate: string,
) {
  return (
    { store }: ResolvedDecisionAuthorities,
    { decision, source }: ApplicationContext,
  ): ApplyResolvedDecisionOutcome => {
    const id = decision.decision_id;
    if (source.state !== expected) return refuse(store, id, `the source Attempt is ${source.state}, not ${expected}`);
    if (source.candidate_commit !== candidate) {
      return refuse(store, id, "the Attempt's candidate is no longer the one the question was about");
    }
    return commitApplication(store, id, source.attempt_key, {
      kind: "REATTEMPT",
      decision_id: id,
      attempt_reason,
    });
  };
}

/** §17.4 RECOVERY row — the candidate must *still* be missing from canonical, read fresh now. */
function recoveryReattempt(candidate: string) {
  return (
    authorities: ResolvedDecisionAuthorities,
    context: ApplicationContext,
  ): ApplyResolvedDecisionOutcome => {
    const { store } = authorities;
    const id = context.decision.decision_id;
    if (context.source.state !== "APPROVED_FOR_MANUAL_MERGE") {
      return refuse(store, id, `the source Attempt is ${context.source.state}, not APPROVED_FOR_MANUAL_MERGE`);
    }
    let merged: boolean;
    try {
      const head = authorities.repository.snapshot_canonical().head;
      merged = head === candidate || authorities.repository.verify_lineage(candidate, head);
    } catch {
      throw new OwnerUnavailable("the repository could not be read");
    }
    if (merged) {
      // The mismatch resolved itself in the person's favour; reattempting would fork history.
      return refuse(store, id, "the candidate has since reached canonical; nothing to reattempt");
    }
    return commitApplication(store, id, context.source.attempt_key, {
      kind: "REATTEMPT",
      decision_id: id,
      attempt_reason: "RECOVERY_CONFLICT",
    });
  };
}

function allowFrozen() {
  return (
    { store }: ResolvedDecisionAuthorities,
    { decision, source }: ApplicationContext,
  ): ApplyResolvedDecisionOutcome => {
    const id = decision.decision_id;
    if (isTerminal(source.state)) return refuse(store, id, `the source Attempt is already ${source.state}`);
    if (!frozenBasisIntact(store, source)) return refuse(store, id, "the frozen contract/grant basis no longer loads");
    return commitApplication(store, id, source.attempt_key, { kind: "ALLOW_FROZEN" });
  };
}

function invalidateContractDrift() {
  return (
    { store }: ResolvedDecisionAuthorities,
    { decision, source }: ApplicationContext,
  ): ApplyResolvedDecisionOutcome => {
    const id = decision.decision_id;
    if (isTerminal(source.state)) return refuse(store, id, `the source Attempt is already ${source.state}`);
    return commitApplication(store, id, source.attempt_key, {
      kind: "INVALIDATE_CONTRACT_DRIFT",
      decision_id: id,
    });
  };
}

/** Drift-origin rows over an already-terminal source: task-only transitions. */
function reattemptOverTerminal(expected: TaskAttemptRow["state"]) {
  return (
    { store }: ResolvedDecisionAuthorities,
    { decision, task, source }: ApplicationContext,
  ): ApplyResolvedDecisionOutcome => {
    const id = decision.decision_id;
    if (source.state !== expected) return refuse(store, id, `the source Attempt is ${source.state}, not ${expected}`);
    const committed = commitTaskReattemptReentry(store, {
      task_key: task.task_key,
      decision_id: id,
      within: (transition) => {
        store.pendingDecisions.recordAppliedTransition(id, transition.seq);
        store.idempotency.markDone(applyOpKey(id), {
          applied_transition_seq: transition.seq,
        } as unknown as CanonicalValue);
      },
    });
    return { kind: "APPLIED", decision_id: id, transition_seq: committed.transition.seq };
  };
}

function abandonOverTerminal(expected: TaskAttemptRow["state"]) {
  return (
    { store }: ResolvedDecisionAuthorities,
    { decision, task, source }: ApplicationContext,
  ): ApplyResolvedDecisionOutcome => {
    const id = decision.decision_id;
    if (source.state !== expected) return refuse(store, id, `the source Attempt is ${source.state}, not ${expected}`);
    const committed = commitTaskAbandonment(store, {
      task_key: task.task_key,
      decision_id: id,
      within: (transition) => {
        store.pendingDecisions.recordAppliedTransition(id, transition.seq);
        store.idempotency.markDone(applyOpKey(id), {
          applied_transition_seq: transition.seq,
        } as unknown as CanonicalValue);
      },
    });
    return { kind: "APPLIED", decision_id: id, transition_seq: committed.transition.seq };
  };
}

// --- shared predicates ---------------------------------------------------------------------------

/** The settled audit record named by `evidence_refs` still binds to this exact attempt/candidate. */
function auditEvidenceBinds(
  store: PlatformStore,
  decision: PendingDecisionV1,
  source: TaskAttemptRow,
  candidate: string,
): boolean {
  const audit_id = decision.evidence_refs[0];
  if (audit_id === undefined) return false;
  let record;
  try {
    record = store.auditRecords.get(audit_id);
  } catch {
    return false;
  }
  return (
    record !== undefined &&
    record.attempt_key === source.attempt_key &&
    record.candidate_commit === candidate
  );
}

function isTerminal(state: TaskAttemptRow["state"]): boolean {
  return state === "MERGED" || state === "SUCCEEDED" || state === "INVALIDATED" || state === "FAILED";
}

/**
 * A judged refusal: the answer stays `RESOLVED(applied_transition_ref = null)`, the safe-held
 * state is untouched, and the one application attempt is durably spent — never retried in the
 * background. Continuing in the current world takes the mapping's fresh Proposal or a new
 * decision through the ordinary paths.
 */
function refuse(store: PlatformStore, decision_id: string, reason: string): ApplyResolvedDecisionOutcome {
  store.withTransaction(() => {
    store.idempotency.markDone(applyOpKey(decision_id), { refused: reason } as unknown as CanonicalValue);
  });
  return { kind: "REFUSED", decision_id, reason };
}
