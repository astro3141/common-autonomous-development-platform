/**
 * TD-control → conformance-test traceability manifest.
 *
 * DEFINITION (the owner's decision, stated verbatim):
 *
 *   Conformance tests are NOT authority themselves — they are the EXECUTABLE ASSURANCE PROJECTION
 *   of TD authority; they are protected to PREVENT WEAKENING OF THE TD ASSURANCE BOUNDARY (not
 *   because changing them "amends the TD").
 *
 * What follows from that definition, and what does not:
 *
 *   - Editing a file in this directory amends NOTHING constitutional. The TDs remain the sole
 *     authority; a test is a projection of a control the TD already states.
 *   - But a projection can be WEAKENED — deleted, narrowed, excluded from the executed set — and a
 *     weakened projection silently narrows the assurance boundary the TDs are relied on to hold.
 *     That is the hazard `cadp/product/gateFiles.ts` routes to a HUMAN_DECISION for this directory,
 *     and that this manifest plus `conformance-manifest.test.ts` make DETERMINISTIC rather than
 *     reviewer-dependent: a mapped test that is dropped or moved breaks the meta-test.
 *   - `cadp/tests/ops/` is deliberately OUTSIDE that boundary. Its files assert operational
 *     contracts only (broker prompt shapes, provider argv snapshots, timeout budgets, effort argv
 *     rendering). They are executed by every verifier exactly as before — the split changed
 *     PROTECTION, never EXECUTION COVERAGE.
 *
 * The mapping is explicitly MANY-TO-MANY in both directions:
 *
 *   - one control may need several files (AP-A4's o1..o5 legs plus its guard-bites span
 *     `conformance-runorigin`, `conformance-basesha` and `conformance-allocation`);
 *   - one file may serve several controls (`conformance-authority` carries a dozen §13.1 C-legs).
 *
 * Control IDs are `<doc>-<id>`:
 *
 *   TD04-*  TECHNICAL_DESIGN_cadp_v0_4_generation.md §13.1 negative controls (C1..C42) and
 *           §13.2 product controls (P1..P7b)
 *   AP-*    TECHNICAL_DESIGN_cadp_v0_5_authority_plane.md §C falsification controls (A1..A5)
 *   WP-*    TECHNICAL_DESIGN_cadp_v0_5_workflow_plane.md §7 conformance controls (numbered 1..15)
 *   EP-*    TECHNICAL_DESIGN_cadp_v0_5_execution_plane.md §C conformance controls (numbered 1..3)
 *
 * A conformance-directory file that is protection-worthy but not (yet) the projection of a
 * NUMBERED TD control is listed in `AUXILIARY` with its reason, never silently omitted: the
 * meta-test requires every `*.test.ts` here to appear in one list or the other.
 */

/** One TD control and the conformance test files that project it. */
export interface ControlMapping {
  /** `<doc>-<id>`, e.g. `AP-A4`, `TD04-C41`, `WP-7`. */
  readonly control: string;
  /** Basenames, relative to `cadp/tests/conformance/`. Never empty. */
  readonly tests: readonly string[];
}

/** A protected file that is not (yet) tied to a numbered control, with the reason it is protected. */
export interface AuxiliaryEntry {
  /** Basename, relative to `cadp/tests/conformance/`. */
  readonly test: string;
  /** Why this file belongs inside the assurance boundary despite carrying no numbered control ID. */
  readonly reason: string;
}

export const CONTROL_MAPPINGS: readonly ControlMapping[] = [
  // ---------------------------------------------------------------- Authority Plane v0.5 §C
  { control: "AP-A1", tests: ["conformance-kernelconfig.test.ts"] },
  { control: "AP-A2", tests: ["conformance-kernelconfig.test.ts"] },
  { control: "AP-A3", tests: ["conformance-assembly.test.ts"] },
  // A4's run-capability legs, its witnessed minting and the K7 grading span three files; the
  // origin-profile half is pinned in basesha, the allocation half in allocation.
  { control: "AP-A4", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts", "conformance-allocation.test.ts"] },
  { control: "AP-A5", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts", "conformance-allocation.test.ts"] },

  // ---------------------------------------------------------------- Workflow Plane v0.5 §7
  { control: "WP-1", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-2", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-6", tests: ["conformance-gatefiles.test.ts", "conformance-delegation.test.ts"] },
  { control: "WP-7", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-8", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-9", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-10", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-13", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts"] },
  { control: "WP-14", tests: ["conformance-basesha.test.ts"] },
  { control: "WP-15", tests: ["conformance-basesha.test.ts"] },

  // ---------------------------------------------------------------- Execution Plane v0.5 §C
  { control: "EP-1", tests: ["conformance-digestscheme.test.ts"] },

  // ---------------------------------------------------------------- TD v0.4 §13.1 (C1..C42)
  { control: "TD04-C1", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C2", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C3", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C4", tests: ["conformance-store.test.ts", "conformance-observability.test.ts"] },
  { control: "TD04-C5", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C6", tests: ["conformance-authority.test.ts", "conformance-isolation.test.ts", "conformance-osisolation.test.ts"] },
  { control: "TD04-C7", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C8", tests: ["conformance-store.test.ts"] },
  { control: "TD04-C9", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C9b", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C10", tests: ["conformance-record.test.ts", "conformance-isolation.test.ts"] },
  { control: "TD04-C11", tests: ["conformance-github.test.ts"] },
  { control: "TD04-C12", tests: ["conformance-authority.test.ts", "conformance-delegation.test.ts", "conformance-reviewproviders.test.ts"] },
  { control: "TD04-C13", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C14", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C15", tests: ["conformance-store.test.ts"] },
  { control: "TD04-C16", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C17", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C18", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C19", tests: ["conformance-authority.test.ts", "conformance-root.test.ts"] },
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
  { control: "TD04-C29", tests: ["conformance-authority.test.ts", "conformance-observability.test.ts", "conformance-isolation.test.ts"] },
  { control: "TD04-C30", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD04-C31", tests: ["conformance-policyactivate.test.ts", "conformance-kernelconfig.test.ts"] },
  { control: "TD04-C32", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C33", tests: ["conformance-store.test.ts"] },
  { control: "TD04-C34", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C35", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD04-C36", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C37", tests: ["conformance-store.test.ts"] },
  { control: "TD04-C38", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C39", tests: ["conformance-root.test.ts"] },
  { control: "TD04-C40", tests: ["conformance-root.test.ts"] },
  { control: "TD04-C41", tests: ["conformance-github.test.ts", "conformance-reviewbody.test.ts"] },
  { control: "TD04-C42", tests: ["conformance-root.test.ts"] },

  // ---------------------------------------------------------------- TD v0.4 §13.2 product controls
  { control: "TD04-P7a", tests: ["conformance-workbounds.test.ts"] },
  { control: "TD04-P7b", tests: ["conformance-workbounds.test.ts"] },
];

/**
 * Protected but not (yet) mapped to a numbered TD control. UNMAPPED-AUXILIARY. Everything here is
 * inside the assurance boundary; the missing piece is only the control NUMBER to trace it to.
 *
 * Two populations live here:
 *   (a) files projecting controls the corpus states under an ISSUE-lane numbering (#104 §11, #117
 *       §12, #57, #61, #128, #259) or a TD section that numbers items rather than controls
 *       (§4.1's F-legs, §20.6's items) — real conformance, no `<doc>-<id>` to cite yet;
 *   (b) files landed here by the AMBIGUOUS → conformance/ fail-protected default: a false
 *       "protected" costs a human click, a false "unprotected" silently disarms a control.
 */
export const AUXILIARY: readonly AuxiliaryEntry[] = [
  { test: "conformance-manifest.test.ts", reason: "the meta-test itself — it is what makes a dropped or moved mapped test fail deterministically" },
  { test: "conformance-attest-refresh.test.ts", reason: "TD §20.6 item 7 (scheduled attestation refresh) and recheck #8's stale-boundary refusal; §20.6 numbers items, not controls" },
  { test: "conformance-deployment-actuation.test.ts", reason: "TD §20.6 items 1–6, governed DEPLOY including first-class rollback; §20.6 numbers items, not controls" },
  { test: "conformance-composition.test.ts", reason: "#117 §5.1 composition-root conformance — asserts the DEPLOYED adapter list the kernel registers, not the harness's" },
  { test: "conformance-intake.test.ts", reason: "cadp.improvement-intake.v1, #104 §11 controls 1–20 (issue-lane numbering)" },
  { test: "conformance-transition.test.ts", reason: "#107 S1/S3/S4/S5 against the #117 §12 falsification table, guard-bites included (issue-lane numbering)" },
  { test: "conformance-externalverify.test.ts", reason: "#57 EV1–EV5: the external check-run projection is fail-closed and `verifier:github-actions` evidence never transitions anything by itself (the workflow's INVOCATION is pinned by GF8 in conformance-gatefiles.test.ts)" },
  { test: "conformance-reviewmount.test.ts", reason: "#259 P0a — the reviewer's two planes; a candidate must not be able to instruct its own reviewer" },
  { test: "conformance-planner.test.ts", reason: "#61 PL1–PL4: proposal parsing fails closed, provenance is registry-bound, and a proposal confers NO authority (Spec §8.2)" },
  { test: "conformance-mcp.test.ts", reason: "#61 M1–M3: the supervising session's tool surface and its fail-closed work-start cap (mcp.ts is gate machinery)" },
  { test: "conformance-driver.test.ts", reason: "#61 D1–D3 fail-closed run classification (driver.ts is gate machinery); AMBIGUOUS → conformance by the fail-protected default" },
  { test: "conformance-sessions.test.ts", reason: "the local verifier's pinned argv plus the reviewer/verifier mount posture; AMBIGUOUS → conformance by the fail-protected default" },
  { test: "conformance-planproviders.test.ts", reason: "mixed file: planner argv snapshots (ops-shaped) alongside the §8.4 planner-vs-implementer independence leg; AMBIGUOUS → conformance by the fail-protected default" },
  { test: "kernel-chain.test.ts", reason: "kernel invariant smoke: the full K3 → K4 → K5(OPA) → K6 → dispatch → K7 chain against the reference composition" },
];
