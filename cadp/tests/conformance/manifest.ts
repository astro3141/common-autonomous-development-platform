/**
 * TD ⇄ conformance-test traceability manifest.
 *
 * DEFINITION (the reason this directory is protected at all): conformance tests are NOT authority
 * themselves — they are the EXECUTABLE ASSURANCE PROJECTION of TD authority; they are protected to
 * PREVENT WEAKENING OF THE TD ASSURANCE BOUNDARY (not because changing them "amends the TD").
 *
 * Nothing in this file confers authority, and editing it amends no document. Its only job is to
 * make the projection AUDITABLE: which TD-mandated control is executable, and by which files. The
 * meta-test (`conformance-manifest.test.ts`) turns that record into a deterministic failure when a
 * mapped test is deleted, moved or silently dropped from the directory.
 *
 * The mapping is deliberately MANY-TO-MANY in both directions:
 *   - one control may be executed by several files (AP-A4's legs live across `conformance-runorigin`,
 *     `conformance-allocation` and `conformance-basesha`, plus their guard-bites);
 *   - one file may serve several controls (`conformance-authority.test.ts` carries C6, C7, C12, C13,
 *     C14, C17, C18, C19, C24, C27, C28 and C29).
 *
 * Control-ID prefixes name the document the ID is defined in:
 *   TDv0.4-*      TECHNICAL_DESIGN_cadp_v0_4_generation.md §13.1 (C-series), §13.2 (P-series),
 *                 §13.3 (adapter suite), §20.6 (guarded continuous-deployment items)
 *   AP-*          TECHNICAL_DESIGN_cadp_v0_5_authority_plane.md §C (A1–A5)
 *   EP-*          TECHNICAL_DESIGN_cadp_v0_5_execution_plane.md §C (controls 1–3, contract B1(3))
 *   WP-*          TECHNICAL_DESIGN_cadp_v0_5_workflow_plane.md §7 (controls 1–15)
 *   RTA-*         DESIGN_cadp_reclassification_transition_authority.md §12 (FC-series)
 *   SPECv0.5-*    Common Autonomous Development Platform — Specification v0.5.md §9
 *   INTAKE104-*   the `cadp.improvement-intake.v1` control set (#104 §11 controls 1–20), landed as
 *                 the product contract in TD v0.4 §15
 *
 * A control the corpus states but no file executes is simply ABSENT here — the manifest never
 * claims coverage it does not have, and the meta-test never demands that every control be listed.
 * What it does demand is the converse: no file in this directory is unaccounted for.
 */

/** One TD-mandated control and every conformance file that executes some leg of it. */
export interface ControlMapping {
  /** `<doc>-<id>` per the prefix table above. */
  readonly control: string;
  /** Basenames, relative to `cadp/tests/conformance/`. Never empty. */
  readonly tests: readonly string[];
}

/**
 * A conformance-directory file that is protection-worthy but not (yet) tied to a NUMBERED control
 * in the corpus — the UNMAPPED-AUXILIARY set. Two populations land here:
 *   (a) files whose controls carry lane-local ids (F6–F10, M1–M3, O1–O5, EV1–EV5, PL1–PL4, R1–R6,
 *       GF1–GF8, FC22, D1–D3) that no merged TD numbers yet;
 *   (b) files classified AMBIGUOUS under the split rule and resolved to `conformance/` by the
 *       fail-protected default — over-protection costs a human click, under-protection silently
 *       widens what a delegated merge may weaken.
 * Auxiliary membership is a protection claim, not a coverage claim.
 */
export interface AuxiliaryEntry {
  readonly test: string;
  /** Why the file is protection-worthy, and (for (b)) why the ambiguity resolved to conformance/. */
  readonly reason: string;
}

export const CONTROL_MAPPINGS: readonly ControlMapping[] = [
  // ---------------------------------------------------------- TD v0.4 §13.1 constitutional negatives
  { control: "TDv0.4-C1", tests: ["conformance-binding.test.ts"] },
  { control: "TDv0.4-C2", tests: ["conformance-binding.test.ts"] },
  { control: "TDv0.4-C3", tests: ["conformance-binding.test.ts"] },
  { control: "TDv0.4-C4", tests: ["conformance-store.test.ts"] },
  { control: "TDv0.4-C5", tests: ["conformance-binding.test.ts"] },
  { control: "TDv0.4-C6", tests: ["conformance-authority.test.ts"] },
  { control: "TDv0.4-C7", tests: ["conformance-authority.test.ts"] },
  { control: "TDv0.4-C8", tests: ["conformance-store.test.ts"] },
  { control: "TDv0.4-C9", tests: ["conformance-dispatch.test.ts"] },
  { control: "TDv0.4-C9b", tests: ["conformance-dispatch.test.ts"] },
  { control: "TDv0.4-C10", tests: ["conformance-record.test.ts"] },
  { control: "TDv0.4-C11", tests: ["conformance-github.test.ts"] },
  // C12/C28 are the independence + derived-identity-class pair. The kernel/policy leg is in
  // conformance-authority; the product-side entry guard that refuses a same-product reviewer before
  // a run starts (`assertReviewIndependence`, and the full worker×reviewer matrix) is in
  // conformance-reviewproviders — which is why that file is conformance/, not ops/.
  { control: "TDv0.4-C12", tests: ["conformance-authority.test.ts", "conformance-reviewproviders.test.ts"] },
  { control: "TDv0.4-C13", tests: ["conformance-authority.test.ts"] },
  { control: "TDv0.4-C14", tests: ["conformance-authority.test.ts"] },
  { control: "TDv0.4-C15", tests: ["conformance-store.test.ts"] },
  { control: "TDv0.4-C16", tests: ["conformance-dispatch.test.ts"] },
  { control: "TDv0.4-C17", tests: ["conformance-authority.test.ts"] },
  { control: "TDv0.4-C18", tests: ["conformance-authority.test.ts"] },
  { control: "TDv0.4-C19", tests: ["conformance-authority.test.ts"] },
  { control: "TDv0.4-C20", tests: ["conformance-github.test.ts"] },
  { control: "TDv0.4-C21", tests: ["conformance-github.test.ts"] },
  { control: "TDv0.4-C22", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TDv0.4-C22b", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TDv0.4-C23", tests: ["conformance-store.test.ts"] },
  { control: "TDv0.4-C24", tests: ["conformance-authority.test.ts"] },
  { control: "TDv0.4-C25", tests: ["conformance-dispatch.test.ts"] },
  { control: "TDv0.4-C26", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TDv0.4-C27", tests: ["conformance-authority.test.ts"] },
  { control: "TDv0.4-C28", tests: ["conformance-authority.test.ts", "conformance-reviewproviders.test.ts"] },
  { control: "TDv0.4-C29", tests: ["conformance-authority.test.ts", "conformance-deployment-actuation.test.ts"] },
  { control: "TDv0.4-C30", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TDv0.4-C31", tests: ["conformance-policyactivate.test.ts", "conformance-kernelconfig.test.ts"] },
  { control: "TDv0.4-C32", tests: ["conformance-binding.test.ts"] },
  { control: "TDv0.4-C33", tests: ["conformance-store.test.ts"] },
  { control: "TDv0.4-C34", tests: ["conformance-dispatch.test.ts"] },
  { control: "TDv0.4-C35", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TDv0.4-C36", tests: ["conformance-dispatch.test.ts"] },
  { control: "TDv0.4-C37", tests: ["conformance-store.test.ts"] },
  { control: "TDv0.4-C38", tests: ["conformance-binding.test.ts"] },
  { control: "TDv0.4-C39", tests: ["conformance-root.test.ts"] },
  { control: "TDv0.4-C40", tests: ["conformance-root.test.ts"] },
  { control: "TDv0.4-C41", tests: ["conformance-github.test.ts"] },
  { control: "TDv0.4-C42", tests: ["conformance-root.test.ts"] },

  // ---------------------------------------------------------- TD v0.4 §13.2 product controls
  // P1–P6 are live-harness controls (real target, real record service) and have no deterministic
  // file here; P7's two bounds do — the workflow-enforced step bound and the kernel-enforced
  // effect bound, both proven fail-closed against malformed numerics (#127).
  { control: "TDv0.4-P7a", tests: ["conformance-workbounds.test.ts"] },
  { control: "TDv0.4-P7b", tests: ["conformance-workbounds.test.ts"] },

  // ---------------------------------------------------------- TD v0.4 §13.3 adapter suite
  { control: "TDv0.4-13.3", tests: ["conformance-record.test.ts", "conformance-intake.test.ts"] },

  // ---------------------------------------------------------- TD v0.4 §20 guarded deployment
  { control: "TDv0.4-20.6.1-6", tests: ["conformance-deployment-actuation.test.ts"] },
  { control: "TDv0.4-20.6.7", tests: ["conformance-attest-refresh.test.ts"] },

  // ---------------------------------------------------------- Authority Plane TD §C
  { control: "AP-A1", tests: ["conformance-kernelconfig.test.ts"] },
  { control: "AP-A2", tests: ["conformance-kernelconfig.test.ts"] },
  { control: "AP-A3", tests: ["conformance-assembly.test.ts"] },
  { control: "AP-A4", tests: ["conformance-runorigin.test.ts", "conformance-allocation.test.ts", "conformance-basesha.test.ts"] },
  { control: "AP-A5", tests: ["conformance-runorigin.test.ts", "conformance-allocation.test.ts", "conformance-basesha.test.ts"] },

  // ---------------------------------------------------------- Execution Plane TD §C
  { control: "EP-2", tests: ["conformance-isolation.test.ts"] },
  { control: "EP-B1(3)", tests: ["conformance-digestscheme.test.ts"] },

  // ---------------------------------------------------------- Workflow Plane TD §7
  { control: "WP-1", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-2", tests: ["conformance-allocation.test.ts"] },
  // The gate-file guard: an external candidate touching a GATE_PATH_RULES path cannot be merged by
  // AGENT_DECISION. The rule itself is falsified in conformance-gatefiles; the merge-gate refusal it
  // feeds is falsified in conformance-delegation.
  { control: "WP-6", tests: ["conformance-gatefiles.test.ts", "conformance-delegation.test.ts"] },
  { control: "WP-7", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-8", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-9", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-10", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-13", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts"] },
  { control: "WP-14", tests: ["conformance-basesha.test.ts"] },
  { control: "WP-15", tests: ["conformance-basesha.test.ts"] },

  // ---------------------------------------------------------- Reclassification/transition authority §12
  ...["FC1", "FC2", "FC3", "FC5", "FC6", "FC7", "FC8", "FC9", "FC10", "FC11", "FC12",
    "FC14", "FC15", "FC16", "FC17", "FC18", "FC19", "FC20", "FC21"].map((id) => ({
    control: `RTA-${id}`,
    tests: ["conformance-transition.test.ts"] as readonly string[],
  })),

  // ---------------------------------------------------------- improvement-intake control set
  ...["C3", "C4", "C5", "C6", "C7", "C8", "C11", "C12", "C13", "C14", "C15",
    "C16", "C17", "C18", "C19", "C20", "S2"].map((id) => ({
    control: `INTAKE104-${id}`,
    tests: ["conformance-intake.test.ts"] as readonly string[],
  })),

  // ---------------------------------------------------------- Spec v0.5 §9.1 kernel conformance
  { control: "SPECv0.5-9.1", tests: ["kernel-chain.test.ts"] },
];

export const AUXILIARY_TESTS: readonly AuxiliaryEntry[] = [
  {
    test: "conformance-manifest.test.ts",
    reason: "the meta-test itself — it is what makes every mapping above deterministically falsifiable",
  },
  {
    test: "conformance-osisolation.test.ts",
    reason: "TD §4.1 OS/network boundary (F6–F10 with guard-bites); the surface containment the whole execution plane rests on, but F6–F10 are lane-local ids no merged TD numbers",
  },
  {
    test: "conformance-observability.test.ts",
    reason: "TD §12 r8 read-only constitutional observation (O1–O5): the observer's B2 write-forbidden guard and verify-on-read honesty; lane-local ids",
  },
  {
    test: "conformance-externalverify.test.ts",
    reason: "the external-verifier evidence path (EV1–EV5): fail-closed projection of check runs and the require_external_verification gate — verification machinery, lane-local ids",
  },
  {
    test: "conformance-composition.test.ts",
    reason: "FC22, production composition root: the governed transition is only real if the DEPLOYED kernel registers its adapter; lane-local id",
  },
  {
    test: "conformance-reviewbody.test.ts",
    reason: "#259 P0b (R1–R6): fail-closed submission and retrieval of the Primary Reviewer's durable body — a REVIEW claim whose bytes cannot be re-verified must never be readable as verified",
  },
  {
    test: "conformance-reviewmount.test.ts",
    reason: "#259 P0a: the reviewer's two planes — the candidate cannot become its own reviewer's instruction source; falsifies the boundary rather than asserting a string",
  },
  {
    test: "conformance-planner.test.ts",
    reason: "PL1–PL4: proposals are registry-bound and confer NO authority (WORK_START admission is unchanged by a sealed proposal). AMBIGUOUS vs the owner's 'planner plumbing' ops category; resolved to conformance/ because PL3/PL4 are authority claims, not plumbing",
  },
  {
    test: "conformance-planproviders.test.ts",
    reason: "AMBIGUOUS: mostly plan-argv snapshots (an ops shape), but it also asserts the Spec §8.4 identity_class registry consistency — planner product ≠ every implementer product — and the distinct principals sealPlan seals under. Fail-protected default",
  },
  {
    test: "conformance-provider-measurement-gate.test.ts",
    reason: "the measurement-honesty gate: reviewer/planner model scans are MEASURED and unmeasured effort slots stay absent, so requested is never collapsible into observed (the C13/C14 posture, product-side)",
  },
  {
    test: "conformance-mcp.test.ts",
    reason: "M1–M3: the supervising session's tool surface, including the fail-closed work-start cap; mcp.ts is gate machinery under GATE_PATH_RULES",
  },
  {
    test: "conformance-driver.test.ts",
    reason: "D1–D3: the fail-closed run classification behind ctl work-plan — only a clean delivery advances the loop; driver.ts is gate machinery under GATE_PATH_RULES",
  },
  {
    test: "conformance-sessions.test.ts",
    reason: "AMBIGUOUS: retention is an ops convenience, but the same file pins the constructed isolation argv — the verifier's --network none and the reviewer's :ro workspace. Fail-protected default",
  },
];
