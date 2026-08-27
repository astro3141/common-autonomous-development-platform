/**
 * `evaluateStageBoundaryDrift` — the §11 decision, as a pure function (TD §11.4, M1-11).
 *
 * It performs no I/O, holds no state and touches no lifecycle: typed observations in, one outcome
 * out. Three properties do the real work.
 *
 *   **The frozen policy decides.** Which consequence a difference has comes from the Attempt-bound
 *   `contract_drift_policy`, never from the current one — otherwise editing the policy would
 *   silently change how running Attempts react to that very edit.
 *
 *   **A failed read is not a clean bill of health.** `UNAVAILABLE` is its own outcome. The one
 *   thing an unanswerable boundary must never produce is permission to continue.
 *
 *   **Precedence is explicit.** `INVALIDATE > UNAVAILABLE > HOLD > CONTINUE`, resolved by scanning
 *   the fixed `DRIFT_TARGETS` order — no severity numbers, and no dependence on the key order of
 *   whatever object the caller happened to build.
 */

import { canonicalize, type CanonicalValue } from "../schemas/canonical-json.ts";
import { DRIFT_TARGETS, type DriftTarget } from "../profile/types.ts";
import type {
  AuditorStageFacts,
  DriftObservationV1,
  DriftOutcome,
  Observation,
  StageBoundary,
} from "./drift-observation.ts";

/** What one target's observation resolved to, before precedence is applied. */
type Consequence = DriftOutcome["kind"];

/**
 * TD §11.2 — `boundary: MERGE_ONLY` is observed everywhere and acted on only where the merge is
 * authorized. There are two such transitions and they are alternatives, not a sequence: MVP 1's
 * human path stops at the approval, MVP 2's automatic path continues into `MERGING` (M1-14).
 */
const MERGE_BOUNDARIES: readonly StageBoundary[] = [
  "READY_TO_MERGE_TO_APPROVED_FOR_MANUAL_MERGE",
  "READY_TO_MERGE_TO_MERGING",
];

export function evaluateStageBoundaryDrift(observation: DriftObservationV1): DriftOutcome {
  const consequences = new Map<DriftTarget, Consequence>();
  for (const target of DRIFT_TARGETS) {
    consequences.set(target, consequenceFor(observation, target));
  }

  // Strict precedence over the fixed target order: the first target at the highest applicable
  // level names the outcome, so the same facts always produce the same answer and attribution.
  for (const kind of ["INVALIDATE", "UNAVAILABLE", "HOLD"] as const) {
    for (const target of DRIFT_TARGETS) {
      if (consequences.get(target) === kind) return { kind, target };
    }
  }
  return { kind: "CONTINUE" };
}

function consequenceFor(observation: DriftObservationV1, target: DriftTarget): Consequence {
  const state = statusOf(observation, target);
  if (state === "UNAVAILABLE") return "UNAVAILABLE";
  if (state === "UNCHANGED") return "CONTINUE";

  // A difference was observed. What it *means* is the frozen policy's answer, not this module's.
  const rule = observation.policy[target];
  if (rule.boundary === "MERGE_ONLY" && !MERGE_BOUNDARIES.includes(observation.boundary)) {
    // TD §11.2 — observed and recorded, but this boundary is not where it acts. No rebase, no
    // change of base, no hold from canonical movement alone.
    return "CONTINUE";
  }

  switch (rule.action) {
    case "CONTINUE_SNAPSHOT":
      return "CONTINUE";
    case "HOLD_AT_BOUNDARY":
      return "HOLD";
    case "INVALIDATE_AT_BOUNDARY":
      return "INVALIDATE";
    case "REEVALUATE_AT_BOUNDARY":
      return reevaluate(observation);
  }
}

/**
 * TD §11.4 — a changed Profile/Policy is not a hold by itself. The question is only whether the
 * *remaining* stage is still permitted, so the answer is the stage observation. Expansion is
 * ignored: nothing here can hand this Attempt a capability, profile or permission it did not
 * already have.
 *
 * v1 evaluates exactly one remaining stage, the Auditor's, which is the one boundary M1-11
 * integrates. The other three boundaries are later integration work (§11.4 boundary scope).
 */
function reevaluate(observation: DriftObservationV1): Consequence {
  const stage = observation.current.auditor_stage;
  if (stage.status === "UNAVAILABLE") return "UNAVAILABLE";
  // The pipeline this contract names is gone: a successful observation, and the stage plainly
  // cannot run under it.
  if (stage.status === "ABSENT") return "HOLD";
  return permitted(stage.value) ? "CONTINUE" : "HOLD";
}

const permitted = (facts: AuditorStageFacts): boolean =>
  facts.has_auditor && facts.auditor_profile_declared && facts.requirement_met;

// --- per-target comparison ------------------------------------------------------------------

type TargetState = "UNCHANGED" | "CHANGED" | "UNAVAILABLE";

/**
 * Each target has its own canonical comparison (TD §11.4): component refs by `{id, version, hash}`
 * so a difference can be attributed, `task_definition` by its normalized version and hash,
 * `contract_source` by the §10.2 raw content hash, `canonical_head` by commit identity, and the
 * two sub-bodies by canonical JSON equality.
 */
function statusOf(observation: DriftObservationV1, target: DriftTarget): TargetState {
  const { frozen, current } = observation;
  switch (target) {
    case "project_profile":
      return compare(current.project_profile, (value) =>
        sameRef(value, frozen.project_profile),
      );
    case "execution_policy":
      return compare(current.execution_policy, (value) =>
        sameRef(value, frozen.execution_policy),
      );
    case "task_definition":
      return compare(
        current.task_definition,
        (value) =>
          value.version === frozen.task.version &&
          value.definition_hash === frozen.task.definition_hash,
      );
    case "contract_source":
      return compare(current.contract_sources, (value) => sameSources(value, frozen.contract_sources));
    case "canonical_head":
      return compare(current.canonical_head, (value) => value === frozen.base_head);
    case "verification_profile":
      return compare(current.verification_profile, (value) =>
        sameCanonical(value, frozen.verification_profile),
      );
    case "capability_requirements":
      return compare(current.capability_requirements, (value) =>
        sameCanonical(value, frozen.capability_requirements),
      );
  }
}

/** `ABSENT` is a successful observation whose answer is "it is gone" — which is a difference. */
function compare<Value>(
  observation: Observation<Value>,
  equals: (value: Value) => boolean,
): TargetState {
  if (observation.status === "UNAVAILABLE") return "UNAVAILABLE";
  if (observation.status === "ABSENT") return "CHANGED";
  return equals(observation.value) ? "UNCHANGED" : "CHANGED";
}

const sameRef = (
  left: { id: string; version: number; hash: string },
  right: { id: string; version: number; hash: string },
): boolean => left.id === right.id && left.version === right.version && left.hash === right.hash;

const sameSources = (
  left: readonly { path: string; content_hash: string }[],
  right: readonly { path: string; content_hash: string }[],
): boolean =>
  left.length === right.length &&
  left.every(
    (source, index) =>
      source.path === right[index]?.path && source.content_hash === right[index]?.content_hash,
  );

const sameCanonical = (left: unknown, right: unknown): boolean =>
  canonicalize(left as CanonicalValue) === canonicalize(right as CanonicalValue);
