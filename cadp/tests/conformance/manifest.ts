/**
 * TD-control → conformance-test traceability manifest.
 *
 * DEFINITION (the owner's decision, stated verbatim): conformance tests are NOT authority
 * themselves — they are the EXECUTABLE ASSURANCE PROJECTION of TD authority; they are protected to
 * PREVENT WEAKENING OF THE TD ASSURANCE BOUNDARY (not because changing them "amends the TD").
 *
 * What that buys, mechanically: `cadp/tests/conformance/` is gate-protected (`GATE_PATH_RULES`,
 * cadp/product/gateFiles.ts), so a candidate that deletes, guts or exclusion-evades one of these
 * files routes to a HUMAN_DECISION instead of an AGENT_DECISION. This manifest is what makes the
 * "deletes or guts" half deterministic rather than eyeball-detectable: every mapped file is named
 * here, and conformance-manifest.test.ts fails if a named file stops existing, if a file in the
 * directory is named by nothing (a stowaway), or if an entry maps a control to no test at all.
 * The invocation half is closed separately, by the pinned three-leaf argv both verifiers run
 * (VERIFIER_TEST_ARGV, cadp/product/surfaceBroker.ts).
 *
 * The mapping is deliberately MANY-TO-MANY. One control has several legs that landed in different
 * files (AP-A4's o1..o5 and w1/w2 legs sit in conformance-runorigin while its `startWork` origin
 * profiles sit in conformance-basesha), and one file serves several controls (conformance-authority
 * carries twelve of the TD v0.4 §13.1 controls). Neither direction is a 1:1 function and the
 * structure below does not pretend otherwise.
 *
 * DOC PREFIXES — every control id is `<doc>-<id>`, and `<doc>` names a document in this repository:
 *   TD04  TECHNICAL_DESIGN_cadp_v0_4_generation.md   (§13.1 C-controls, §13.2 P-controls, §20.6 items)
 *   AP    TECHNICAL_DESIGN_cadp_v0_5_authority_plane.md   (§C controls A1–A5)
 *   EP    TECHNICAL_DESIGN_cadp_v0_5_execution_plane.md   (§C controls 1–3)
 *   WP    TECHNICAL_DESIGN_cadp_v0_5_workflow_plane.md    (§7 controls 1–15)
 *   RTA   DESIGN_cadp_reclassification_transition_authority.md   (§12 falsification table, FC1–FC22)
 *
 * COVERAGE HONESTY. This manifest maps the controls whose implementing tests are IDENTIFIABLE at
 * this checkout — it is not a claim that the merged corpus is fully covered. Controls deliberately
 * absent: EP-3 (optionality — a whole-deployment posture, no deterministic test), WP-3, WP-11 and
 * WP-12 (no test at this checkout implements them). A control's absence here asserts nothing about
 * the control; it only means no file is mapped to it, and no meta-test leg depends on it.
 *
 * AUXILIARY. `UNMAPPED_AUXILIARY` carries the conformance-directory files that are
 * protection-worthy but not (yet) tied to a numbered control of the merged corpus — most of them
 * implement controls numbered in an ISSUE rather than in a TD (e.g. conformance-intake's #104 §11
 * controls 1–20). They are protected on the same footing as the mapped files; being auxiliary is a
 * statement about this manifest's citation, never about the file's standing.
 *
 * OPS CLASSIFICATION (the sibling directory, cadp/tests/ops/, which is NOT gate-protected). Four
 * files were classified as asserting operational contracts only: conformance-brokerprompt (broker
 * prompt shapes), conformance-sessions (docker argv snapshots + failed-session retention),
 * conformance-timeout (the #128 timeout-budget hierarchy) and conformance-reasoning-effort (effort
 * argv rendering). Every other file defaulted to conformance/ — including the borderline
 * provider-registry files (conformance-workproviders, conformance-reviewproviders,
 * conformance-planproviders, conformance-provider-measurement-gate), which carry §8.4
 * identity/independence legs and observed-fact legs and so are not "operational only". Note in
 * particular that the EP-2 custody control and its reviewer-posture sibling named by the Execution
 * Plane TD live in conformance-isolation.test.ts, which is protected — conformance-sessions carries
 * the argv-snapshot restatement of that posture, not the control.
 *
 * Both directories keep RUNNING in both verifiers. The split changes PROTECTION, never execution
 * coverage.
 */

/** One control's tests. `control` is `<doc>-<id>`; `tests` are basenames in this directory. */
export interface ControlMapping {
  readonly control: string;
  readonly tests: readonly string[];
}

/** A protected conformance-directory file not (yet) cited by a numbered control. */
export interface AuxiliaryMapping {
  readonly test: string;
  /** Why the file is protection-worthy, and where its controls ARE numbered. */
  readonly why: string;
}

/** Many-to-many: one control → many files, one file → many controls. */
export const CONTROL_MAP: readonly ControlMapping[] = [
  // ---------------------------------------------------------------- TD v0.4 §13.1 (C1–C42)
  { control: "TD04-C1", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C2", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C3", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C4", tests: ["conformance-binding.test.ts", "conformance-store.test.ts"] },
  { control: "TD04-C5", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C6", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C7", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C8", tests: ["conformance-store.test.ts"] },
  { control: "TD04-C9", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C9b", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C10", tests: ["conformance-record.test.ts"] },
  { control: "TD04-C11", tests: ["conformance-github.test.ts"] },
  // C12's independence predicate is falsified in three places: at the kernel/policy layer, in the
  // reviewer registry's product matrix, and at the delegated-merge gate.
  { control: "TD04-C12", tests: ["conformance-authority.test.ts", "conformance-reviewproviders.test.ts", "conformance-delegation.test.ts"] },
  { control: "TD04-C13", tests: ["conformance-authority.test.ts", "conformance-workproviders.test.ts"] },
  { control: "TD04-C14", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C15", tests: ["conformance-store.test.ts", "conformance-allocation.test.ts"] },
  { control: "TD04-C16", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C17", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C18", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C19", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C20", tests: ["conformance-github.test.ts"] },
  { control: "TD04-C21", tests: ["conformance-github.test.ts"] },
  { control: "TD04-C22", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD04-C22b", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD04-C23", tests: ["conformance-store.test.ts"] },
  { control: "TD04-C24", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C25", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C26", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD04-C27", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C28", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C29", tests: ["conformance-authority.test.ts", "conformance-deployment-actuation.test.ts"] },
  { control: "TD04-C30", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD04-C31", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD04-C32", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C33", tests: ["conformance-store.test.ts"] },
  { control: "TD04-C34", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C35", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD04-C36", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C37", tests: ["conformance-store.test.ts"] },
  { control: "TD04-C38", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C39", tests: ["conformance-root.test.ts"] },
  { control: "TD04-C40", tests: ["conformance-root.test.ts"] },
  { control: "TD04-C41", tests: ["conformance-github.test.ts"] },
  { control: "TD04-C42", tests: ["conformance-root.test.ts"] },

  // ---------------------------------------------------------------- TD v0.4 §13.2 (P-controls)
  // P1–P6 are live-pilot product controls (they need a real target and a real Human path) and have
  // no deterministic implementation here. P7b's kernel-enforced effect bound does.
  { control: "TD04-P7b", tests: ["conformance-workbounds.test.ts"] },

  // ---------------------------------------------------------------- TD v0.4 §12/§18/§20.6 items
  { control: "TD04-12r8", tests: ["conformance-observability.test.ts"] },
  { control: "TD04-20.6-items-1-6", tests: ["conformance-deployment-actuation.test.ts"] },
  { control: "TD04-20.6-item-7", tests: ["conformance-attest-refresh.test.ts"] },

  // ---------------------------------------------------------------- Authority Plane §C (A1–A5)
  { control: "AP-A1", tests: ["conformance-kernelconfig.test.ts"] },
  { control: "AP-A2", tests: ["conformance-kernelconfig.test.ts"] },
  { control: "AP-A3", tests: ["conformance-assembly.test.ts"] },
  // A4's legs o1..o5 / w1,w2 and the guard-bites are Authority-side (runorigin); the two `startWork`
  // ORIGIN PROFILES the same control names are product-side (basesha). One control, two files.
  { control: "AP-A4", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts"] },
  { control: "AP-A5", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts"] },
  // AP §C's B2 first-seal legs (binding, typed tuple, purpose, contract swap, duplicate projection,
  // cross-principal re-seal, kernel-namespace ambiguity) are the WP-7..WP-10 rows below.

  // ---------------------------------------------------------------- Execution Plane §C (1–3)
  // EP-1's scheme leg — B1(3)'s NAMED gap in the inherited §2.1 approved-scheme contract.
  { control: "EP-1", tests: ["conformance-digestscheme.test.ts"] },
  // EP-2 names conformance-isolation.test.ts's F2 by file and quotes its reviewer-posture sibling;
  // the container-boundary halves of the same custody claim are the F6/F7/F8 legs.
  { control: "EP-2", tests: ["conformance-isolation.test.ts", "conformance-osisolation.test.ts"] },

  // ---------------------------------------------------------------- Workflow Plane §7 (1–15)
  { control: "WP-1", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-2", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-4", tests: ["conformance-github.test.ts"] },
  { control: "WP-5", tests: ["conformance-runorigin.test.ts"] },
  { control: "WP-6", tests: ["conformance-gatefiles.test.ts", "conformance-delegation.test.ts"] },
  { control: "WP-7", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-8", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-9", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-10", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-13", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts"] },
  { control: "WP-14", tests: ["conformance-basesha.test.ts", "conformance-runorigin.test.ts"] },
  { control: "WP-15", tests: ["conformance-basesha.test.ts", "conformance-runorigin.test.ts"] },

  // ---------------------------------------------------------------- RTA §12 (FC1–FC22)
  { control: "RTA-FC1", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC2", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC3", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC5", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC6", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC7", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC8", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC9", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC10", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC11", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC12", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC14", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC15", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC16", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC17", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC18", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC19", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC20", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC21", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC22", tests: ["conformance-composition.test.ts"] },
];

/** Protected, but not cited by a numbered control of the merged corpus. */
export const UNMAPPED_AUXILIARY: readonly AuxiliaryMapping[] = [
  { test: "conformance-manifest.test.ts", why: "the meta-test that makes this manifest load-bearing; protecting the manifest without protecting its checker would be a hole" },
  { test: "conformance-intake.test.ts", why: "cadp.improvement-intake.v1 controls are numbered in issue #104 §11 (controls 1–20) plus the #109 E-legs, not in the merged TD corpus" },
  { test: "conformance-externalverify.test.ts", why: "EV1–EV5 falsify the TD v0.4 §18 external-verification projection and its policy gate; §18 states no numbered control" },
  { test: "conformance-planner.test.ts", why: "PL1–PL4 (proposal parses exactly, fails closed, is registry-bound provenance, and confers NO admission authority); numbered in issue #61" },
  { test: "conformance-planproviders.test.ts", why: "planner registry: §8.4 identity_class agreement with the policy registry, sealPlan provenance siblings, and unknown-provider fail-closed" },
  { test: "conformance-mcp.test.ts", why: "M1–M3 for the supervising tool surface, including the fail-closed session work-start cap; numbered in issue #61" },
  { test: "conformance-driver.test.ts", why: "D1–D3 fail-closed run classification behind ctl work-plan (cadp/product/driver.ts is itself gate machinery); numbered in issue #61" },
  { test: "conformance-provider-measurement-gate.test.ts", why: "pins that reviewer/planner/worker measurement slots stay MEASURED and unmeasured slots stay absent — the precondition every observed-fact control reads" },
  { test: "conformance-reviewmount.test.ts", why: "#259 P0a — the reviewer's two planes: the candidate checkout is mounted read-only and never as the reviewer's cwd, so a candidate cannot instruct its own reviewer" },
  { test: "conformance-reviewbody.test.ts", why: "#259 P0b — the Primary Reviewer's full text is retained durably, is self-verifying, and is byte-identically recoverable" },
  { test: "kernel-chain.test.ts", why: "the K3→K4→K5(OPA)→K6→dispatch→K7 smoke chain against the reference composition — the end-to-end path every kernel control assumes exists" },
];
