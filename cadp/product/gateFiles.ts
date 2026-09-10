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
  // The CONFORMANCE half of the test corpus — the executable assurance projection of TD authority.
  // These tests are not authority themselves; they are protected because weakening them weakens the
  // TD ASSURANCE BOUNDARY (a candidate that deletes, guts or exclusion-evades one has narrowed the
  // gate without touching the constitution). The whole directory is listed — manifest.ts and its
  // meta-test included, since a manifest whose checker is delegable protects nothing. Its shared
  // fixtures live in cadp/tests/conformance/support/ and are covered by the same prefix: a harness
  // that can be neutered is a suite that can be neutered. cadp/tests/ops/ is deliberately NOT here
  // — operational contracts (prompt shapes, argv snapshots, timeout budgets) are ordinary product.
  "cadp/tests/conformance/",
  // The EXTERNAL verifier's invocation. It pins, by explicit path, which tests actually run; it is
  // verification machinery for exactly the reason surfaceBroker.ts's local argv is (also listed
  // above, once). The broader ".github/" rule below covers this file too — the explicit entry
  // states the verification-machinery reason rather than leaving it to a directory prefix.
  ".github/workflows/cadp-verify.yml",
  // Reviewer-INSTRUCTION files (#259 P0a). A provider CLI discovers these automatically from its
  // working directory and its ancestors and loads them as its own instructions, so a
  // candidate-authored change to one opens a path to address the reviewer that judges it — gate
  // machinery by exactly the test above (it can influence merge eligibility), even though no such
  // file exists in the repo today. A leading `**/` marks a BASENAME rule: the discovery walk is
  // per-directory, so the root copy is not the only one that would be loaded.
  "**/AGENTS.md",
  "**/AGENTS.override.md",
  // Constitutional documents (design lane): the Spec, TDs and the authority order DEFINE the very
  // authority boundaries this gate enforces — a delegated agent auto-merging an edit to them is
  // the self-approval hazard in its purest form. Every constitutional/design document routes to a
  // HUMAN_DECISION. A trailing `*` marks a filename prefix, covering past and future revisions
  // (v0.3, v0.4, next generations) without re-editing this list per revision.
  ".github/", // the external verification workflow — what the Actions verifier actually RUNS
  "Authority order.md",
  "Common Autonomous Development Platform — Specification*", // every Spec revision
  "TECHNICAL_DESIGN_*", // every TD document
  "DESIGN_*", // standalone design/authority notes
];

/** Returns the subset of changed paths that touch gate machinery (empty ⇒ ordinary change). */
export function touchesGateMachinery(changedPaths: readonly string[]): string[] {
  return changedPaths.filter((p) =>
    GATE_PATH_RULES.some((rule) =>
      rule.startsWith("**/") ? p === rule.slice(3) || p.endsWith(`/${rule.slice(3)}`) // basename, any depth
      : rule.endsWith("/") ? p.startsWith(rule) // directory prefix
      : rule.endsWith("*") ? p.startsWith(rule.slice(0, -1)) // filename prefix (constitutional docs)
      : p === rule, // exact file
    ),
  );
}
