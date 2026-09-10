/**
 * CONFORMANCE TRACEABILITY MANIFEST — TD control ID → the test files that project it.
 *
 * DEFINITION, verbatim (the reason this directory is gate-protected, stated here so no reader has
 * to infer it): conformance tests are NOT authority themselves - they are the EXECUTABLE ASSURANCE
 * PROJECTION of TD authority; they are protected to PREVENT WEAKENING OF THE TD ASSURANCE BOUNDARY
 * (not because changing them "amends the TD"). The TD says what must hold; these files are the
 * mechanism by which "it holds" is decided at merge time. A delegated agent that may edit them
 * freely may lower the bar it is judged against without ever touching a constitutional document —
 * so `cadp/tests/conformance/` (this whole directory, this manifest and its meta-test included)
 * routes to a HUMAN_DECISION via `GATE_PATH_RULES`. Amending the TD remains a separate act,
 * governed by the constitutional-document rules of `cadp/product/gateFiles.ts`.
 *
 * `cadp/tests/ops/` is deliberately NOT protected: those files assert operational contracts
 * (prompt shapes, provider argv snapshots, timeout budgets, effort argv rendering, ops
 * conveniences). Weakening one loses a regression, not an assurance boundary. Both directories
 * keep RUNNING in both verifiers — the split changes PROTECTION, never execution coverage.
 *
 * MANY-TO-MANY, in both directions, and that is the point:
 *   - one control may be projected by several files (AP-A4's origin/minting legs live in
 *     `conformance-runorigin.test.ts`, its `startWork` origin-profile legs in
 *     `conformance-basesha.test.ts`);
 *   - one file may project several controls (`conformance-authority.test.ts` carries eleven TD04
 *     negative controls plus the Spec §8.4 independence family).
 * Neither direction may be collapsed: a control is only as protected as the WEAKEST file that
 * projects it, and a file is only as legible as the controls it names.
 *
 * DOC KEYS in `control` (`<doc>-<id>`), all from the merged Spec/TD corpus at this checkout:
 *   SPEC  Common Autonomous Development Platform — Specification (v0.4 authoritative, v0.5 lane)
 *   TD04  TECHNICAL_DESIGN_cadp_v0_4_generation.md (§13.1 negative controls C1–C42; § clauses)
 *   AP    TECHNICAL_DESIGN_cadp_v0_5_authority_plane.md (§C controls A1–A5; B-clauses)
 *   EP    TECHNICAL_DESIGN_cadp_v0_5_execution_plane.md (§C controls 1–3; B-clauses)
 *   WP    TECHNICAL_DESIGN_cadp_v0_5_workflow_plane.md (§7 controls 1–15)
 *   RTA   DESIGN_cadp_reclassification_transition_authority.md (§12 falsification table, FC*)
 * IDs are the corpus's OWN identifiers: the falsification-control number where the document
 * numbers its controls, and the numbered clause where the control is stated as a clause.
 *
 * Entries name only controls that HAVE a projecting test file here. A corpus control with no test
 * is absent from this list rather than silently implied by it — e.g. EP §C control 1 (symmetric
 * contract shape) has no dedicated file at this checkout, and EP §C control 3's optionality half
 * (a deployment with the Execution Plane removed) is projected only through its
 * `backend_model_present` DENY leg.
 */

/** One TD control and every conformance-directory test file that projects it (never empty). */
export interface ControlTraceEntry {
  /** `<doc>-<id>` — a control identifier that exists in the merged Spec/TD corpus. */
  readonly control: string;
  /** Basenames, resolved against `cadp/tests/conformance/`. Many-to-many, both directions. */
  readonly tests: readonly string[];
}

/**
 * A conformance-directory test file that is protection-worthy but is NOT (yet) tied to a numbered
 * control of the merged corpus — an issue-lane control set, a smoke/meta suite, or a file placed
 * here by the AMBIGUOUS → conformance/ fail-protected default of the split. Listing it is what
 * keeps the directory intentional: the meta-test admits no stowaways and no silent drops.
 */
export interface AuxiliaryTraceEntry {
  readonly test: string;
  /** Why it is protected, and where its controls are numbered if they are numbered elsewhere. */
  readonly why: string;
}

export const CONTROL_TRACE: readonly ControlTraceEntry[] = [
  // ---- TD04 §13.1 constitutional negative controls (Spec §13.1–13.3; #94 minimum list) ----
  { control: "TD04-C1", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C2", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C3", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C4", tests: ["conformance-store.test.ts"] },
  { control: "TD04-C5", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C6", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C7", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C8", tests: ["conformance-store.test.ts"] },
  { control: "TD04-C9", tests: ["conformance-dispatch.test.ts"] }, // C9 + C9b + the #12 guard-bite
  { control: "TD04-C10", tests: ["conformance-record.test.ts"] },
  { control: "TD04-C11", tests: ["conformance-github.test.ts"] },
  { control: "TD04-C12", tests: ["conformance-authority.test.ts", "conformance-delegation.test.ts"] },
  { control: "TD04-C13", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C14", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C15", tests: ["conformance-store.test.ts"] },
  { control: "TD04-C16", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C17", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C18", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C19", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C20", tests: ["conformance-github.test.ts"] },
  { control: "TD04-C21", tests: ["conformance-github.test.ts"] },
  { control: "TD04-C22", tests: ["conformance-policyactivate.test.ts"] }, // C22 + C22b recovery
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

  // ---- TD04 numbered clauses whose falsification is a control in its own right ----
  { control: "TD04-§4.1", tests: ["conformance-osisolation.test.ts"] }, // F6–F10 + guard-bites
  { control: "TD04-§12", tests: ["conformance-isolation.test.ts"] }, // F5: the API is exactly the ten calls
  { control: "TD04-§12r8", tests: ["conformance-observability.test.ts"] }, // O1–O5 read-only observation
  { control: "TD04-§20.6", tests: ["conformance-deployment-actuation.test.ts", "conformance-attest-refresh.test.ts"] },

  // ---- Spec ----
  { control: "SPEC-§8.4", tests: ["conformance-authority.test.ts", "conformance-delegation.test.ts", "conformance-reviewproviders.test.ts"] },
  { control: "SPEC-§9.1", tests: ["kernel-chain.test.ts"] }, // K3→K4→K5→K6→dispatch→K7 kernel invariant

  // ---- AP §C (v0.5 authority plane) ----
  { control: "AP-A1", tests: ["conformance-kernelconfig.test.ts"] },
  { control: "AP-A2", tests: ["conformance-kernelconfig.test.ts"] },
  { control: "AP-A3", tests: ["conformance-assembly.test.ts"] }, // kernel-side legs + recheck #18
  { control: "AP-A4", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts"] },
  { control: "AP-A5", tests: ["conformance-runorigin.test.ts", "conformance-allocation.test.ts", "conformance-basesha.test.ts"] },

  // ---- EP §C / clauses (v0.5 execution plane) ----
  { control: "EP-2", tests: ["conformance-isolation.test.ts"] }, // F2 custody, named by the EP itself
  { control: "EP-3", tests: ["conformance-authority.test.ts"] }, // the backend_model_present DENY half
  { control: "EP-B1(3)", tests: ["conformance-digestscheme.test.ts"] }, // approved_digest_schemes on evidence

  // ---- WP §7 (v0.5 workflow plane) ----
  { control: "WP-1", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-2", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-5", tests: ["conformance-runorigin.test.ts"] },
  { control: "WP-6", tests: ["conformance-gatefiles.test.ts"] }, // gate-file guard: no AGENT_DECISION merge
  { control: "WP-7", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-8", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-9", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-10", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-13", tests: ["conformance-runorigin.test.ts"] },
  { control: "WP-15", tests: ["conformance-basesha.test.ts"] },

  // ---- RTA §12 falsification table (the governed intake v1 → v1.1 transition) ----
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
  { control: "RTA-FC14", tests: ["conformance-transition.test.ts"] }, // guard-bite control
  { control: "RTA-FC15", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC16", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC17", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC18", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC19", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC20", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC21", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC22", tests: ["conformance-composition.test.ts"] }, // production composition root
];

/** UNMAPPED-AUXILIARY: protected, in the directory on purpose, not tied to a numbered control. */
export const AUXILIARY_TRACE: readonly AuxiliaryTraceEntry[] = [
  {
    test: "conformance-manifest.test.ts",
    why: "UNMAPPED-AUXILIARY — the meta-test of this manifest. It is the mechanism that makes a deleted or moved mapped test fail deterministically, so it is protected with what it guards.",
  },
  {
    test: "conformance-intake.test.ts",
    why: "UNMAPPED-AUXILIARY — cadp.improvement-intake.v1 controls 1–20 are numbered in the #104 issue lane, not (yet) in the merged corpus; the legs are real kernel/policy refusals and protection-worthy as such.",
  },
  {
    test: "conformance-externalverify.test.ts",
    why: "UNMAPPED-AUXILIARY — EV1–EV*: the external verifier's evidence projection fails closed to UNKNOWN. Verification machinery by exactly the gateFiles test, numbered only in the #57 lane.",
  },
  {
    test: "conformance-reviewbody.test.ts",
    why: "UNMAPPED-AUXILIARY — R1–R*: the Primary Reviewer's full text is retained, self-verifying and byte-recoverable (#259 P0b). Reviewer-evidence honesty; numbered only in the issue lane.",
  },
  {
    test: "conformance-reviewmount.test.ts",
    why: "UNMAPPED-AUXILIARY — what the reviewer actually SEES: the mounted evidence workspace and its instruction (#259 P0a). A weakening here silently blinds the gate's reviewer.",
  },
  {
    test: "conformance-workbounds.test.ts",
    why: "UNMAPPED-AUXILIARY — WB1–WB5: malformed WORK_START bounds fail closed in policy, PEP and workflow entry, with a rego guard-bite (#127). Fail-closed authority behaviour, numbered in the issue lane.",
  },
  {
    test: "conformance-planner.test.ts",
    why: "UNMAPPED-AUXILIARY — PL1–PL4: proposal parsing fails closed, provenance is registry-bound, and a proposal confers NO authority (Spec §8.2 read-only discovery). PL4 is an authority claim, so this is not planner plumbing.",
  },
  {
    test: "conformance-mcp.test.ts",
    why: "UNMAPPED-AUXILIARY (ambiguous → conformance/ by the fail-protected default) — M3's work-start cap fails closed and cadp/product/mcp.ts is itself gate machinery; M1/M2 are protocol shape.",
  },
  {
    test: "conformance-driver.test.ts",
    why: "UNMAPPED-AUXILIARY (ambiguous → conformance/ by the fail-protected default) — D1–D3 pin the fail-closed run classification of cadp/product/driver.ts, which is itself gate machinery.",
  },
  {
    test: "conformance-provider-measurement-gate.test.ts",
    why: "UNMAPPED-AUXILIARY (ambiguous → conformance/ by the fail-protected default) — asserts that model/effort facts stay MEASURED, which is what the policy's backend_model_present / effort_requirement_met gates consume.",
  },
];
