/**
 * Decision Validator V1–V11 (TD §9.2, M0-25 ~ M0-28).
 *
 * A pure deterministic function. It calls no TaskSource, no RepositoryAdapter, no RuntimeAdapter,
 * no WorkflowAdapter and no Store: every authoritative fact arrives as a caller-supplied read
 * model, so the same inputs always produce the same result and the whole gate is testable without
 * a backend.
 *
 * Steps run strictly in order, steps that do not apply are skipped, and the first non-PASS step
 * ends the run — failures are never aggregated.
 *
 * Nothing here mutates anything: `ACCEPTED` is not a transition and `HUMAN_GATE_REQUIRED` is not
 * a pending human decision.
 */

import { evaluateCapabilityRequirements } from "../capability/compatibility.ts";
import { deriveEnforcement, deriveRequestedCapabilities } from "../capability/derive.ts";
import type {
  BackendManifestSet,
  CapabilityRequirementMap,
  CoreExecutionRole,
  RuntimeManifestBody,
} from "../capability/types.ts";
import type {
  CompiledProfileV1Body,
  ExecutionDisposition,
  ExecutionPolicyV1Body,
} from "../profile/types.ts";
import { canonicalize, type CanonicalValue } from "../schemas/canonical-json.ts";
import { CAPABILITY_NAMES, ENFORCEMENT_ASSURANCES } from "../schemas/capability-vocabulary.ts";
import { authorizeDecision, effectiveDisposition, requiresHumanGate } from "./decision-authority.ts";
import { DecisionError, inputInvalid } from "./errors.ts";
import { validateProposal } from "./proposal.ts";
import {
  ACTOR_EXECUTION_OPERATION,
  AUDITOR_EXECUTION_OPERATION,
  AUTOMATIC_MERGE_OPERATION,
  BATCH_VIEW_FIELDS,
  SELECTION_ADMISSION_KINDS,
  WRITABLE_PIPELINE_STEP,
  type DecisionRejectReason,
  type DecisionValidationBatchView,
  type DecisionValidationResult,
  type ProposalV1,
  type RepositoryValidationView,
  type SelectionAdmissionKind,
  type TaskBearingProposalV1,
  type TaskLookupView,
} from "./types.ts";

export interface DecisionValidationInput {
  /** Already-structured Supervisor input; V1 validates it. */
  readonly proposal: unknown;
  readonly compiled_profile: CompiledProfileV1Body;
  /** The hash of the profile above, as computed by the Batch 4 compiler. */
  readonly compiled_profile_hash: string;
  /** Required for task-bearing variants (V2/V3). */
  readonly task?: TaskLookupView;
  /** Required for the repository-sensitive variants (V8). */
  readonly repository?: RepositoryValidationView;
  /** Required where V9/V10 apply. */
  readonly manifests?: BackendManifestSet;
  /** Required for a new admission (V11). */
  readonly batch?: DecisionValidationBatchView;
  /**
   * TD §9.2e (M1-7) — defaults to `INITIAL_ADMISSION`. A `RESELECTION` skips the `max_tasks` rule
   * only: the task already consumed its admission slot, but whether execution may start *now*
   * is still re-judged.
   */
  readonly admission_kind?: SelectionAdmissionKind;
}

const ACCEPTED: DecisionValidationResult = { kind: "ACCEPTED" };
const HUMAN_GATE: DecisionValidationResult = { kind: "HUMAN_GATE_REQUIRED" };

const rejected = (reason_code: DecisionRejectReason): DecisionValidationResult => ({
  kind: "POLICY_REJECTED",
  reason_code,
});

export function validateDecision(input: DecisionValidationInput): DecisionValidationResult {
  return runValidation(input);
}

/**
 * TD §17.3 — the post-resolved-Human-Gate seam. Not a bypass: `authorizedGateProposal` is the
 * Proposal copy frozen inside a RESOLVED `HUMAN_GATE_APPROVAL` record, and it satisfies V7 only
 * for that exact Proposal. Every other step, V1–V6 and V8–V11, still runs against fresh
 * authority input. There is no flag that disables the gate globally.
 */
export function validateDecisionWithSatisfiedGate(
  input: DecisionValidationInput,
  authorizedGateProposal: ProposalV1,
): DecisionValidationResult {
  return runValidation(input, authorizedGateProposal);
}

function runValidation(
  input: DecisionValidationInput,
  authorizedGateProposal?: ProposalV1,
): DecisionValidationResult {
  // --- V1 structural/domain validation ---------------------------------------------
  let proposal: ProposalV1;
  try {
    proposal = validateProposal(input.proposal);
  } catch (error) {
    if (error instanceof DecisionError && error.reason === "PROPOSAL_SCHEMA_INVALID") {
      return rejected("PROPOSAL_SCHEMA_INVALID");
    }
    throw error;
  }

  const project = input.compiled_profile.effective.project;
  const policy = input.compiled_profile.effective.policy;
  const taskBearing = proposal.variant !== "BATCH_CONTROL";

  // --- V2 task existence (A/B/C) ----------------------------------------------------
  let lookup: TaskLookupView | undefined;
  if (taskBearing) {
    lookup = requireTask(input);
    if (lookup.status === "NOT_FOUND") return rejected("TASK_NOT_FOUND");
  }

  // --- V3 expected freshness --------------------------------------------------------
  if (taskBearing && lookup?.status === "FOUND") {
    const expected = (proposal as TaskBearingProposalV1).expected;
    // Version first: it is deliberately outside the definition hash (§8.1a), so an unchanged body
    // with a bumped version is drift that only this comparison can see.
    if (expected.task_version !== lookup.task.version) return rejected("TASK_DRIFT");
    if (expected.task_definition_hash !== lookup.task.definition_hash) return rejected("TASK_DRIFT");
  }
  if (proposal.expected.compiled_profile_hash !== input.compiled_profile_hash) {
    return rejected("PROFILE_DRIFT");
  }

  const selection = proposal.variant === "TASK_SELECTION" ? proposal : undefined;

  // --- V4 classification membership (selection only) --------------------------------
  if (selection !== undefined && !Object.hasOwn(project.classifications, selection.classification)) {
    return rejected("CLASSIFICATION_UNKNOWN");
  }

  const disposition: ExecutionDisposition | undefined =
    selection === undefined ? undefined : effectiveDisposition(policy, selection.classification);

  // --- V5 decision authority ---------------------------------------------------------
  const unauthorized = authorizeDecision(proposal, policy, disposition);
  if (unauthorized !== undefined) return rejected(unauthorized);

  // --- V6 profile references (selection only) ---------------------------------------
  if (selection !== undefined) {
    const known =
      Object.hasOwn(project.pipelines, selection.pipeline_id) &&
      Object.hasOwn(project.roles, selection.actor_profile) &&
      Object.hasOwn(project.verification_profiles, selection.verification_profile) &&
      // TD §9.2 (M1-6) — the fourth declared reference. Same reason code; no new V-step.
      Object.hasOwn(project.repository_scopes, selection.repository_scope_id);
    if (!known) return rejected("PROFILE_REFERENCE_UNKNOWN");
  }

  // --- V7 Human Gate ----------------------------------------------------------------
  // Short-circuits: V8–V11 are not executed and no side effect of any kind is produced.
  if (requiresHumanGate(proposal, policy, disposition)) {
    // A resolved gate authorizes exactly the occurrence it was opened for (§17.3 step 13).
    if (authorizedGateProposal === undefined || !sameStructure(proposal, authorizedGateProposal)) {
      return HUMAN_GATE;
    }
  }

  // --- V8 repository expected state (A/B) -------------------------------------------
  if (proposal.variant === "TASK_SELECTION" || proposal.variant === "REPOSITORY_SENSITIVE_TASK_CONTROL") {
    const repository = requireRepository(input);
    if (proposal.expected.base_head !== repository.canonical_head) {
      return rejected("REPOSITORY_STATE_MISMATCH");
    }
  }

  // --- V9 capability derivation feasibility -----------------------------------------
  const derivationRoles = rolesRequiringDerivation(proposal, policy);
  if (derivationRoles.length > 0) {
    const runtime = requireManifests(input).runtime.body;
    for (const role of derivationRoles) {
      // Feasibility only: no Grant, no grant_id, no Task Contract is produced here.
      if (!derivationFeasible(policy, runtime, role)) {
        return rejected("CAPABILITY_DERIVATION_FAILED");
      }
    }
  }

  // --- V10 Backend Compatibility Gate ------------------------------------------------
  const operations = operationsFor(proposal, policy);
  if (operations.length > 0) {
    const runtime = requireManifests(input).runtime.body;
    for (const [operation_id, role] of operations) {
      const requirements = policy.capability_requirements[operation_id] as
        | CapabilityRequirementMap
        | undefined;
      // An operation the Execution Policy never declared carries no requirement, and an empty
      // requirement set is compatible — absence is not incompatibility.
      if (requirements === undefined) continue;

      const result = evaluateCapabilityRequirements(
        deriveRequestedCapabilities(policy, role),
        runtime,
        requirements,
      );
      const failure = result.failures[0];
      if (failure !== undefined) {
        return { kind: "BACKEND_INCOMPATIBLE", detail: { operation_id, role, failure } };
      }
    }
  }

  // --- V11 batch admission / concurrency --------------------------------------------
  if (selection !== undefined) {
    const batch = requireBatch(input);
    const limits = policy.batch_policy;
    const kind = admissionKind(input);
    // §9.2e — rule 1 is a *new admission* rule; a reselection re-uses the slot it already holds.
    if (kind === "INITIAL_ADMISSION" && batch.admitted_task_count >= limits.max_tasks) {
      return rejected("BATCH_MAX_TASKS_REACHED");
    }
    if (batch.active_task_count >= limits.concurrency) return rejected("CONCURRENCY_LIMIT_REACHED");

    // A pipeline without an ACTOR step never produces a writable candidate, so it does not
    // compete for the writable slot. No new pipeline classification is introduced for this.
    const pipeline = project.pipelines[selection.pipeline_id];
    const writable = pipeline !== undefined && pipeline.steps.includes(WRITABLE_PIPELINE_STEP);
    if (writable && batch.active_writable_candidate_count >= 1) {
      return rejected("WRITABLE_CONCURRENCY_CONFLICT");
    }
  }

  return ACCEPTED;
}

/** Exact structural equality of two normalized Proposals (§17.3 step 5/13). */
export function sameStructure(left: ProposalV1, right: ProposalV1): boolean {
  return (
    canonicalize(left as unknown as CanonicalValue) ===
    canonicalize(right as unknown as CanonicalValue)
  );
}

// --- V9/V10 selection ---------------------------------------------------------------

/** §9.2c — a selection needs both grants at contract time, so both must be derivable. */
function rolesRequiringDerivation(
  proposal: ProposalV1,
  policy: ExecutionPolicyV1Body,
): readonly CoreExecutionRole[] {
  if (proposal.variant === "TASK_SELECTION") return ["ACTOR", "AUDITOR"];
  if (proposal.decision === "PROPOSE_MERGE" && policy.auto_merge) return ["ACTOR"];
  return [];
}

/**
 * §9.2d — the fixed decision→operation mapping. `operation_id` remains a Policy-owned opaque
 * string: custom ids may exist, but the validator never infers one and no Proposal supplies one.
 */
function operationsFor(
  proposal: ProposalV1,
  policy: ExecutionPolicyV1Body,
): ReadonlyArray<readonly [string, CoreExecutionRole]> {
  if (proposal.variant === "TASK_SELECTION") {
    return [
      [ACTOR_EXECUTION_OPERATION, "ACTOR"],
      [AUDITOR_EXECUTION_OPERATION, "AUDITOR"],
    ];
  }
  // With `auto_merge` off there is no automatic canonical write, so the human merge path is not
  // blocked by a capability requirement written for the automatic one.
  if (proposal.decision === "PROPOSE_MERGE" && policy.auto_merge) {
    return [[AUTOMATIC_MERGE_OPERATION, "ACTOR"]];
  }
  return [];
}

/** The requested map and the directional enforcement map must both come out complete. */
function derivationFeasible(
  policy: ExecutionPolicyV1Body,
  runtime: RuntimeManifestBody,
  role: CoreExecutionRole,
): boolean {
  let requested;
  let enforcement;
  try {
    requested = deriveRequestedCapabilities(policy, role);
    enforcement = deriveEnforcement(requested, runtime);
  } catch {
    return false;
  }
  return CAPABILITY_NAMES.every(
    (capability) =>
      typeof requested[capability] === "boolean" &&
      ENFORCEMENT_ASSURANCES.includes(enforcement[capability]),
  );
}

// --- caller-contract guards -----------------------------------------------------------
// A missing read model is a programming error, never a Proposal rejection, so it is never
// mapped to a DecisionRejectReason.

function requireTask(input: DecisionValidationInput): TaskLookupView {
  const view = input.task;
  if (view === undefined) throw inputInvalid("/task", "a task lookup view is required");
  return view;
}

function requireRepository(input: DecisionValidationInput): RepositoryValidationView {
  const view = input.repository;
  if (view === undefined) {
    throw inputInvalid("/repository", "a repository validation view is required");
  }
  if (typeof view.canonical_head !== "string" || view.canonical_head.length === 0) {
    throw inputInvalid("/repository/canonical_head", "expected a non-empty string");
  }
  return view;
}

function requireManifests(input: DecisionValidationInput): BackendManifestSet {
  const manifests = input.manifests;
  if (manifests === undefined) {
    throw inputInvalid("/manifests", "a validated backend manifest set is required");
  }
  return manifests;
}

function admissionKind(input: DecisionValidationInput): SelectionAdmissionKind {
  const kind = input.admission_kind ?? "INITIAL_ADMISSION";
  if (!SELECTION_ADMISSION_KINDS.includes(kind)) {
    throw inputInvalid("/admission_kind", `unknown selection admission kind ${String(kind)}`);
  }
  return kind;
}

function requireBatch(input: DecisionValidationInput): DecisionValidationBatchView {
  const view = input.batch;
  if (view === undefined) throw inputInvalid("/batch", "a batch admission view is required");
  for (const field of BATCH_VIEW_FIELDS) {
    const count = view[field];
    if (!Number.isInteger(count) || count < 0) {
      throw inputInvalid(`/batch/${field}`, "expected a non-negative integer");
    }
  }
  for (const key of Object.keys(view)) {
    if (!(BATCH_VIEW_FIELDS as readonly string[]).includes(key)) {
      throw inputInvalid(`/batch/${key}`, "unknown field");
    }
  }
  return view;
}
