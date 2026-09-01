/**
 * §19.5.3 (D22, MVP 3) — deterministic RESUME_PARENT eligibility and its application.
 *
 * The owner of a *normal* parent resume is this predicate over authoritative durable rows —
 * never a Supervisor Proposal, never Model discretion, never a human gate. A `RESUME_PARENT`
 * Proposal remains only an exceptional re-observation request: it may cause this predicate to be
 * evaluated again, and nothing else.
 *
 * Everything below reconstructs from §18.1f + the child Contract v2 alone, which is exactly what
 * makes restart catch-up trivial: a crash between the child's terminal commit and the parent's
 * resume leaves durable state from which any later pass derives the same eligibility once.
 */

import type { TaskContractV1Body } from "../contract/types.ts";
import { commitParentResume } from "../statemachine/transition-commit.ts";
import { subflowChildOf } from "../statemachine/types.ts";
import { isTerminalTask } from "../store/domain-types.ts";
import type { PlatformStore } from "../store/platform-store.ts";

export type ResumeEligibility =
  | { readonly kind: "ELIGIBLE"; readonly child_task_key: string }
  | { readonly kind: "NOT_ELIGIBLE"; readonly reason: string };

/** The full §19.5.3 predicate, derived from durable rows only. Read-only. */
export function resumeEligibility(store: PlatformStore, parent_task_key: string): ResumeEligibility {
  const not = (reason: string): ResumeEligibility => ({ kind: "NOT_ELIGIBLE", reason });

  const parent = store.tasks.get(parent_task_key);
  if (parent === undefined) return not("the parent row is gone");
  if (parent.platform_state !== "SUSPENDED") {
    return not(`the parent is ${parent.platform_state}, not SUSPENDED`);
  }
  const reason = parent.state_reason;
  const child_key = subflowChildOf(reason?.code);
  if (child_key === undefined || reason == null) {
    return not("the parent's suspension carries no SUBFLOW_CHILD cause");
  }

  const child = store.tasks.get(child_key);
  if (child === undefined) return not("the bound child row is gone");
  if (child.parent_task_key !== parent_task_key) {
    return not("the child's durable relation does not name this parent");
  }
  if (child.platform_state !== "COMPLETED") {
    return not(`the child is ${child.platform_state}, not COMPLETED`);
  }
  const childAttempts = store.attempts.forTask(child_key);
  const terminal = childAttempts[childAttempts.length - 1];
  if (terminal === undefined || terminal.state !== "SUCCEEDED") {
    return not("the child's terminal Attempt is not SUCCEEDED — completion ≠ merge, and neither substitutes");
  }

  // The child Contract v2's frozen relation must equal the current durable relation exactly.
  let binding: TaskContractV1Body["subflow_binding"];
  try {
    binding = (store.contracts.get(terminal.contract_snapshot_id)?.body as unknown as TaskContractV1Body)
      ?.subflow_binding;
  } catch {
    return not("the child Contract cannot be read");
  }
  if (binding === undefined) return not("the child Contract carries no subflow v2 binding");
  if (binding.parent_task_key !== parent_task_key) return not("the frozen binding names a different parent");
  if (binding.suspension_transition_ref !== `transition:${reason.log_seq}`) {
    return not("the frozen suspension ref is not the parent's current suspension transition");
  }

  // The parent's continuation point must be untouched: same Attempt, same state, same Contract.
  const attempt = store.attempts.current(parent_task_key);
  if (attempt === undefined) return not("the parent has no current continuation Attempt");
  if (attempt.attempt_key !== binding.parent_attempt_key) {
    return not("the parent's current Attempt is not the frozen continuation Attempt");
  }
  if (attempt.state !== binding.parent_attempt_state_at_suspend) {
    return not(`the parent Attempt moved to ${attempt.state} during suspension`);
  }
  let parentContractHash: unknown;
  try {
    parentContractHash = store.contracts.hashOf(attempt.contract_snapshot_id);
  } catch {
    return not("the parent's frozen Contract cannot be read");
  }
  if (parentContractHash !== binding.parent_task_contract_hash) {
    return not("the parent's frozen Contract is not the one the binding froze");
  }

  // No blocker, no recovery conflict, and no other non-terminal child holding the relation open.
  if (isTerminalTask(parent.platform_state as never)) return not("the parent is terminal");
  if (store.pendingDecisions.openFor(parent_task_key).length > 0) {
    return not("an OPEN decision blocks the parent");
  }
  if (attempt.state_reason?.code === "RECOVERY_CONFLICT") {
    return not("the parent Attempt carries a recovery conflict");
  }
  for (const sibling of store.tasks.childrenOf(parent_task_key)) {
    if (sibling.task_key !== child_key && !isTerminalTask(sibling.platform_state)) {
      return not(`another child (${sibling.task_key}) is still non-terminal`);
    }
  }

  return { kind: "ELIGIBLE", child_task_key: child_key };
}

export type ResumeParentOutcome =
  | { readonly kind: "RESUMED"; readonly transition_seq: number }
  | { readonly kind: "NOT_ELIGIBLE"; readonly reason: string };

/**
 * Applies the predicate exactly once when it holds: `SUSPENDED→ACTIVE`, parent Attempt/Contract
 * untouched. Idempotent across restart — a resumed parent simply stops being eligible.
 */
export function resumeParentIfEligible(
  store: PlatformStore,
  parent_task_key: string,
): ResumeParentOutcome {
  const eligibility = resumeEligibility(store, parent_task_key);
  if (eligibility.kind !== "ELIGIBLE") return eligibility;
  const resumed = commitParentResume(store, parent_task_key);
  return { kind: "RESUMED", transition_seq: resumed.transition.seq };
}
