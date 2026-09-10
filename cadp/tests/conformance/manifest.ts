/**
 * Conformance traceability manifest — TD control ID → test file(s).
 *
 * DEFINITION (the reason this directory is gate-protected, stated exactly):
 *
 *   conformance tests are NOT authority themselves - they are the EXECUTABLE ASSURANCE PROJECTION
 *   of TD authority; they are protected to PREVENT WEAKENING OF THE TD ASSURANCE BOUNDARY (not
 *   because changing them "amends the TD").
 *
 * The distinction is load-bearing. A candidate that edits a test does not amend the Spec or a TD —
 * it cannot; authority lives in the constitutional documents and the policy. What it CAN do is
 * shrink the executable projection of that authority until a prohibited change stops being
 * observable. That is the hazard `cadp/product/gateFiles.ts` routes to a HUMAN_DECISION, and it is
 * the only claim made by protecting this directory.
 *
 * The mapping is deliberately MANY-TO-MANY in both directions:
 *   - one control may be projected by several files (AP-A4's o1..o5 origin legs, its temporal
 *     minting legs and its guard-bites are split across the run-origin and base-sha suites);
 *   - one file may project several controls (conformance-authority.test.ts carries C6, C7, C12,
 *     C13, C14, C17, C18, C19, C24, C27, C28 and C29).
 *
 * Control IDs are `<doc>-<id>`:
 *   TD-*   TECHNICAL_DESIGN_cadp_v0_4_generation.md (§13.1 C-controls, §13.2 P-controls, and the
 *          numbered sections that mandate a control without numbering it: §4.1, §11, §12, §13.3, §20.6)
 *   AP-*   TECHNICAL_DESIGN_cadp_v0_5_authority_plane.md §C (A1–A5 and the contract-clause bullets)
 *   EP-*   TECHNICAL_DESIGN_cadp_v0_5_execution_plane.md §C (controls 1–3, and B1(3))
 *   WP-*   TECHNICAL_DESIGN_cadp_v0_5_workflow_plane.md §7 (controls 1–15)
 *   RTA-*  DESIGN_cadp_reclassification_transition_authority.md §12 falsification table (FC1–FC21)
 *
 * A conformance-directory file that is protection-worthy but carries no numbered control in the
 * merged corpus is listed in UNMAPPED_AUXILIARY with the reason — it is NOT silently dropped, and
 * conformance-manifest.test.ts refuses any file that appears in neither list.
 */

/** One control's executable projection: the test files that falsify it. */
export interface ControlProjection {
  /** `<doc>-<id>` — the control as the merged Spec/TD corpus names it. */
  readonly control: string;
  /** Basenames of files in `cadp/tests/conformance/`. Never empty. */
  readonly tests: readonly string[];
}

/** A protected conformance file with no numbered control (yet). */
export interface AuxiliaryProjection {
  /** Basename of a file in `cadp/tests/conformance/`. */
  readonly test: string;
  /** Why it is protection-worthy, and what it would take to give it a control ID. */
  readonly note: string;
}

/** TD control ID → the conformance files that project it. Many-to-many, both directions. */
export const CONTROL_PROJECTIONS: readonly ControlProjection[] = [
  // ---------------------------------------------------------------- TD v0.4 §13.1 (C1–C42)
  { control: "TD-C1", tests: ["conformance-binding.test.ts"] },
  { control: "TD-C2", tests: ["conformance-binding.test.ts"] },
  { control: "TD-C3", tests: ["conformance-binding.test.ts"] },
  { control: "TD-C4", tests: ["conformance-store.test.ts"] },
  { control: "TD-C5", tests: ["conformance-binding.test.ts"] },
  // C6's reach attestation is proven in the authority suite; its FRESHNESS boundary (recheck #8,
  // which the refresh scheduler exists to keep inside) is proven in the attest-refresh suite.
  { control: "TD-C6", tests: ["conformance-authority.test.ts", "conformance-attest-refresh.test.ts"] },
  { control: "TD-C7", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C8", tests: ["conformance-store.test.ts"] },
  { control: "TD-C9", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD-C9b", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD-C10", tests: ["conformance-record.test.ts"] },
  { control: "TD-C11", tests: ["conformance-github.test.ts"] },
  // C12 (independence where required) is projected at three altitudes: the policy refusal
  // (authority), the product-entry guard and its full worker×reviewer matrix (reviewproviders),
  // and the delegated-merge edition AD5 (delegation).
  { control: "TD-C12", tests: ["conformance-authority.test.ts", "conformance-reviewproviders.test.ts", "conformance-delegation.test.ts"] },
  { control: "TD-C13", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C14", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C15", tests: ["conformance-store.test.ts"] },
  { control: "TD-C16", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD-C17", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C18", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C19", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C20", tests: ["conformance-github.test.ts"] },
  { control: "TD-C21", tests: ["conformance-github.test.ts"] },
  { control: "TD-C22", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD-C22b", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD-C23", tests: ["conformance-store.test.ts"] },
  { control: "TD-C24", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C25", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD-C26", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD-C27", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C28", tests: ["conformance-authority.test.ts"] },
  // C29 API reach: the caller-matrix refusals (authority) and the observer class's read-only
  // reach + B2 write-forbidden guard (observability) are the same control's two halves.
  { control: "TD-C29", tests: ["conformance-authority.test.ts", "conformance-observability.test.ts"] },
  { control: "TD-C30", tests: ["conformance-policyactivate.test.ts"] },
  // C31 kernel-config fail-closed: the activation refusal (policyactivate) and the validation-layer
  // rules recheck #17 calls (kernelconfig) project one control.
  { control: "TD-C31", tests: ["conformance-policyactivate.test.ts", "conformance-kernelconfig.test.ts"] },
  { control: "TD-C32", tests: ["conformance-binding.test.ts"] },
  { control: "TD-C33", tests: ["conformance-store.test.ts"] },
  { control: "TD-C34", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD-C35", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD-C36", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD-C37", tests: ["conformance-store.test.ts"] },
  { control: "TD-C38", tests: ["conformance-binding.test.ts"] },
  { control: "TD-C39", tests: ["conformance-root.test.ts"] },
  { control: "TD-C40", tests: ["conformance-root.test.ts"] },
  { control: "TD-C41", tests: ["conformance-github.test.ts"] },
  { control: "TD-C42", tests: ["conformance-root.test.ts"] },

  // ---------------------------------------------------------------- TD v0.4 §13.2 (P-controls)
  { control: "TD-P7b", tests: ["conformance-workbounds.test.ts"] },

  // ---------------------------------------------------------------- TD v0.4 numbered sections
  // §4.1 credential custody + OS/network isolation boundary (F2/F4/F5 env legs; F6–F10 real-container legs).
  { control: "TD-4.1", tests: ["conformance-isolation.test.ts", "conformance-osisolation.test.ts"] },
  // §11 reference composition: the DEPLOYED registry the governed transition must be reachable through.
  { control: "TD-11", tests: ["conformance-composition.test.ts"] },
  // §12 r8 read-only constitutional observation (O1–O5).
  { control: "TD-12r8", tests: ["conformance-observability.test.ts"] },
  // §12 r9 gate-file routing / delegated merge.
  { control: "TD-12r9", tests: ["conformance-gatefiles.test.ts", "conformance-delegation.test.ts"] },
  // §13.3 per-adapter conformance suite (describe-vs-behaviour, material completeness, receipt binding).
  { control: "TD-13.3", tests: ["conformance-record.test.ts", "conformance-dispatch.test.ts", "conformance-github.test.ts", "conformance-deployment-actuation.test.ts"] },
  // §20.6 guarded continuous-deployment contract: items 1–6 governed DEPLOY, item 7 attestation refresh.
  { control: "TD-20.6", tests: ["conformance-deployment-actuation.test.ts", "conformance-attest-refresh.test.ts"] },

  // ---------------------------------------------------------------- Authority Plane §C
  { control: "AP-A1", tests: ["conformance-kernelconfig.test.ts"] },
  { control: "AP-A2", tests: ["conformance-kernelconfig.test.ts"] },
  { control: "AP-A3", tests: ["conformance-assembly.test.ts"] },
  // AP-A4 is the manifest's canonical many-to-many case: the B5 refusal-code legs, the o1..o5 origin
  // legs, the w1/w2 witnessed-minting legs and their guard-bites are in the run-origin suite; the
  // ORIGIN-PROFILE half that the live `startWork` path actually seals is in the base-sha suite.
  { control: "AP-A4", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts"] },
  { control: "AP-A5", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts", "conformance-allocation.test.ts"] },
  // Contract-clause bullets of §C (unnumbered there, named by the clause they falsify).
  { control: "AP-B1(5)", tests: ["conformance-allocation.test.ts", "conformance-basesha.test.ts"] },
  { control: "AP-B2", tests: ["conformance-allocation.test.ts"] },
  { control: "AP-B3(4)", tests: ["conformance-allocation.test.ts", "conformance-kernelconfig.test.ts"] },
  { control: "AP-B4", tests: ["conformance-assembly.test.ts"] },
  { control: "AP-B5", tests: ["conformance-runorigin.test.ts"] },

  // ---------------------------------------------------------------- Execution Plane §C
  { control: "EP-2", tests: ["conformance-isolation.test.ts"] },
  { control: "EP-B1(3)", tests: ["conformance-digestscheme.test.ts"] },

  // ---------------------------------------------------------------- Workflow Plane §7
  { control: "WP-1", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-2", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-6", tests: ["conformance-gatefiles.test.ts", "conformance-delegation.test.ts"] },
  { control: "WP-7", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-8", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-9", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-10", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-13", tests: ["conformance-basesha.test.ts", "conformance-runorigin.test.ts"] },
  { control: "WP-14", tests: ["conformance-basesha.test.ts"] },
  { control: "WP-15", tests: ["conformance-basesha.test.ts"] },

  // ---------------------------------------------------------------- Reclassification-transition design §12
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
];

/**
 * UNMAPPED-AUXILIARY: protected, but not (yet) tied to a numbered control.
 *
 * Two populations live here, and the note says which:
 *   (a) suites whose controls are numbered by an ISSUE rather than by the merged corpus — the
 *       control exists and is real, the corpus simply has no `<doc>-<id>` to cite yet;
 *   (b) files classified AMBIGUOUS at the split and resolved to conformance/ by the fail-protected
 *       default — protection is cheap and reversible, a silent drop is not.
 */
export const UNMAPPED_AUXILIARY: readonly AuxiliaryProjection[] = [
  {
    test: "conformance-manifest.test.ts",
    note: "(b) the meta-test itself. It is the mechanism that makes a deleted or moved mapped test fail deterministically, so it is exactly as protection-worthy as what it guards.",
  },
  {
    test: "kernel-chain.test.ts",
    note: "(b) the K3→K4→K5(OPA)→K6→dispatch→K7 positive-control smoke against the reference composition. No numbered control, but every negative control is read against this chain still admitting and committing; if it silently stopped running, the C-suite's refusals would prove nothing.",
  },
  {
    test: "conformance-intake.test.ts",
    note: "(a) cadp.improvement-intake.v1 controls 1–20 are numbered in issue #104 §11, not in the merged corpus. Real store + real OPA + real kernel path with the intake adapter and reference Rego.",
  },
  {
    test: "conformance-externalverify.test.ts",
    note: "(a) EV1–EV5 are numbered in issue #57. External verification is an EVIDENCE SOURCE gating pr_create under require_external_verification — a live gate input, and the workflow whose invocation this lane pins.",
  },
  {
    test: "conformance-reviewbody.test.ts",
    note: "(a) R1–R6 are numbered in issue #259 P0b. The REVIEW claim's {body_cas_key, body_digest} pair must be self-verifying and the bytes recoverable byte-identically; a weakened leg would let an unverifiable review claim seal.",
  },
  {
    test: "conformance-reviewmount.test.ts",
    note: "(a) numbered in issue #259 P0a. The reviewer's two planes: a candidate must never be able to address the reviewer that judges it (the same hazard GATE_PATH_RULES' **/AGENTS.md rule covers), and the mount is read-only and non-overmounting.",
  },
  {
    test: "conformance-planner.test.ts",
    note: "(b) AMBIGUOUS at the split. PL1/PL2 are ops-shaped (proposal parsing, fail-closed sweep), but PL3 (only the registered planner producer may seal WORK_PROPOSAL) and PL4 (a sealed proposal changes nothing about WORK_START admission — proposal is not authority) are authority claims. Fail-protected default applied.",
  },
  {
    test: "conformance-driver.test.ts",
    note: "(b) AMBIGUOUS at the split. Numbered in issue #61 (D1–D3), but cadp/product/driver.ts is itself GATE_PATH_RULES machinery ('the run classification / fail-closed loop logic'); protecting the machinery while leaving its only falsification unprotected would be a hole. Fail-protected default applied.",
  },
  {
    test: "conformance-mcp.test.ts",
    note: "(b) AMBIGUOUS at the split. M1/M2 are protocol plumbing, but M3 (the session work-start cap fails closed and counts ATTEMPTS, not successes) is a fail-closed bound, and cadp/product/mcp.ts is GATE_PATH_RULES machinery. Fail-protected default applied.",
  },
  {
    test: "conformance-provider-measurement-gate.test.ts",
    note: "(b) AMBIGUOUS at the split. Shaped like a provider-registry snapshot, but what it pins is that every role's observed facts remain MEASURABLE — the precondition for backend_model_present, which pr_create_ok consumes (EP §C control 3). Fail-protected default applied.",
  },
  {
    test: "conformance-sessions.test.ts",
    note: "(b) AMBIGUOUS at the split. Failed-session retention is an ops convenience, but the same file pins runVerifier's and runReviewer's constructed docker argv — the --network none verifier, the read-only workspace and the single writable sessions bind. Those are the isolation boundary in argv form. Fail-protected default applied.",
  },
];
