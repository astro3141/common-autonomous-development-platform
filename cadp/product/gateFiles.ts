/**
 * Gate-machinery file classification (merge-authority safety).
 *
 * A delegated merge decision (AGENT_DECISION) may auto-merge ORDINARY product/doc changes, but it
 * must NOT be able to auto-merge a change to the machinery that FORMS the gate itself — the kernel,
 * the policy, the verifier/reviewer/isolation surfaces, the model selection, or the conformance
 * suite that decides pass/fail. Otherwise the agent (or a contaminated conductor triggering it)
 * could weaken the very checks that are supposed to constrain it — the self-approval hazard, one
 * level up. Any candidate touching these paths routes to a HUMAN_DECISION instead (Spec §3:
 * one identity may not both perform and validate an incompatible duty).
 *
 * This is deliberately broad and errs toward requiring a human: a false "human required" costs a
 * click; a false "safe to auto-merge" could silently disarm the gate.
 */

/** Path prefixes/globs whose change makes a candidate gate-touching. */
export const GATE_PATH_RULES: readonly string[] = [
  "cadp/kernel/", // K1–K7 records, PEP, ingress, evaluator, api caller-matrix, store, genesis, root listener
  "cadp/deployment/", // the reference policy (rego + delegated_merge_producers + kernel config)
  "cadp/live/image/", // the surface image — what model/tooling actually runs
  "cadp/product/surfaceBroker.ts", // clone/worker/verify/review/plan drivers + diff the reviewer sees
  "cadp/product/isolation.ts", // container/network isolation + bounded surface lifetime
  "cadp/product/workerProfile.ts", // worker argv/auth profile + profile digest
  "cadp/product/workerProviders.ts", // which worker models are selectable
  "cadp/product/reviewProviders.ts", // which reviewer models are selectable
  "cadp/product/planProviders.ts", // which planner models are selectable
  "cadp/product/brokerTransport.ts", // the activity-host -> broker transport bounds
  "cadp/product/timeouts.ts", // the declared timeout hierarchy
  "cadp/product/mcp.ts", // the tool surface a supervising session drives
  "cadp/product/driver.ts", // the run classification / fail-closed loop logic
  "cadp/product/gateFiles.ts", // this rule itself
  "cadp/tests/", // the conformance suite that decides verification pass/fail
];

/** Returns the subset of changed paths that touch gate machinery (empty ⇒ ordinary change). */
export function touchesGateMachinery(changedPaths: readonly string[]): string[] {
  return changedPaths.filter((p) => GATE_PATH_RULES.some((rule) => (rule.endsWith("/") ? p.startsWith(rule) : p === rule)));
}
