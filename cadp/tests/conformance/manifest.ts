/**
 * Conformance traceability manifest — TD control ID → executable projection (many-to-many).
 *
 * DEFINITION (the reason this directory is protected at all):
 *
 *   conformance tests are NOT authority themselves - they are the EXECUTABLE ASSURANCE PROJECTION
 *   of TD authority; they are protected to PREVENT WEAKENING OF THE TD ASSURANCE BOUNDARY (not
 *   because changing them "amends the TD").
 *
 * The TD is the authority. A test in this directory is the only mechanism by which that authority
 * is CHECKED on every candidate, so deleting, narrowing or de-selecting one silently shrinks the
 * assurance boundary while every document still reads the same. That is why `cadp/tests/conformance/`
 * is gate machinery (`cadp/product/gateFiles.ts`) and a candidate touching it routes to a
 * HUMAN_DECISION — not because the test text carries constitutional force.
 *
 * WHAT THIS FILE IS FOR. Protection alone does not tell a reader WHICH authority a given file
 * projects, and nothing previously stopped a mapped control from losing its last executable leg
 * (moved file, renamed file, dropped file) without a single check failing. This manifest states the
 * mapping explicitly and `conformance-manifest.test.ts` makes it self-falsifying: every mapped file
 * must exist here, every file here must be mapped, and no *.test.ts may live anywhere else in the
 * repository.
 *
 * MANY-TO-MANY, deliberately. One control has several legs and they need not share a file (AP-A4's
 * o1..o5 legs plus its guard-bites run across `conformance-runorigin` and `conformance-basesha`),
 * and one file serves several controls (`conformance-authority` carries nine of TD04's §13.1 rows).
 * Neither direction is a function, so neither is modelled as one.
 *
 * DOC KEYS (the `<doc>` half of every `<doc>-<id>` control):
 *
 *   TD04        TECHNICAL_DESIGN_cadp_v0_4_generation.md — §13.1 C1–C42 (constitutional negative
 *               controls), §13.2 P1–P7 (product controls), §13.3 (adapter conformance suite),
 *               §12 r8 (read-only observation), §4.1 (OS/network isolation), §20.6 (governed deploy)
 *   AP          TECHNICAL_DESIGN_cadp_v0_5_authority_plane.md §C — A1–A5
 *   EP          TECHNICAL_DESIGN_cadp_v0_5_execution_plane.md §C — C1–C3 (its numbered items 1–3),
 *               plus B1(3), the named implementation gap in the inherited §2.1 digest contract
 *   WP          TECHNICAL_DESIGN_cadp_v0_5_workflow_plane.md §7 — C1–C15 (its numbered items 1–15)
 *   SPEC        Common Autonomous Development Platform — Specification v0.4/v0.5, by section
 *   INTAKE      #104 §11 improvement-intake controls C1–C20 (its OWN numbering — INTAKE-C11 is not
 *               TD04-C11; the two lists are unrelated and are never merged here)
 *   TRANSITION  #117 §12 governed-transition falsification table FC1–FC22
 *   ISSUE<n>    an issue-derived control family the merged corpus references by number (#102 F-series,
 *               #127 work-bounds, #259 P0a/P0b reviewer-plane repairs, #61 direction pilot)
 *
 * WHAT IS DELIBERATELY NOT LISTED. Controls whose only proof is a live pilot (TD04 §13.2 P1–P6,
 * WP-C11/C12, EP-C1/EP-C3 — the latter two are contract-new at this checkout and have no executable
 * leg yet) have no entry: an entry with an empty `tests` array is REFUSED by the meta-test, because
 * a control mapped to nothing is a coverage claim that cannot fail.
 *
 * THE OPS SPLIT (`cadp/tests/ops/`, not gate-protected). A file lands there only when every one of
 * its assertions is an OPERATIONAL contract — a byte-snapshot of a shape that may change without
 * weakening any TD-mandated control: `conformance-brokerprompt` (prompt escaping),
 * `conformance-workproviders` / `conformance-planproviders` / `conformance-reasoning-effort`
 * (provider argv and session-scan parser snapshots), `conformance-timeout` (#128 budget ordering and
 * bounded-failure plumbing), `conformance-sessions` (failed-session retention convenience). Their
 * evidence-honesty-adjacent legs are PRODUCT-SIDE parsers; the CONTROLS those parsers feed —
 * TD04-C13 (observed-without-locator), TD04-C14 (required fact UNKNOWN) and the TD04 §13.3 adapter
 * suite — are projected here, in `conformance-authority` and `conformance-record`, and stay
 * protected. `conformance-reviewproviders` and `conformance-provider-measurement-gate` are the two
 * provider-registry files that did NOT go to ops: the first parses the reviewer VERDICT that decides
 * merge eligibility and holds the entry independence guard, the second refuses unmeasured capability
 * claims. Both are listed as UNMAPPED-AUXILIARY below under the fail-protected default.
 */

/** One control and every test file that projects any leg of it. Neither side is unique. */
export type ConformanceControl = {
  /** `<doc>-<id>` per the DOC KEYS legend above. */
  readonly control: string;
  /** File names (not paths) that must exist in `cadp/tests/conformance/`. Never empty. */
  readonly tests: readonly string[];
};

/** A protected file that projects no single numbered control — stated, never silently tolerated. */
export type AuxiliaryConformanceTest = {
  readonly test: string;
  /** UNMAPPED-AUXILIARY = protection-worthy, not (yet) tied to a numbered control. */
  readonly classification: "UNMAPPED-AUXILIARY" | "MANIFEST-MACHINERY";
  readonly why: string;
};

export const CONFORMANCE_CONTROLS: readonly ConformanceControl[] = [
  // ---------------------------------------------------------------- TD04 §13.1 (C1–C42)
  { control: "TD04-C1", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C2", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C3", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C4", tests: ["conformance-store.test.ts"] },
  { control: "TD04-C5", tests: ["conformance-binding.test.ts"] },
  { control: "TD04-C6", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C7", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C8", tests: ["conformance-store.test.ts"] },
  { control: "TD04-C9", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C9b", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD04-C10", tests: ["conformance-record.test.ts"] },
  { control: "TD04-C11", tests: ["conformance-github.test.ts"] },
  { control: "TD04-C12", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C13", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C14", tests: ["conformance-authority.test.ts"] },
  { control: "TD04-C15", tests: ["conformance-store.test.ts"] },
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
  // C29 (API reach) is projected twice: the kernel matrix, and the deployment-control principals.
  { control: "TD04-C29", tests: ["conformance-authority.test.ts", "conformance-deployment-actuation.test.ts"] },
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
  { control: "TD04-C41", tests: ["conformance-github.test.ts"] },
  { control: "TD04-C42", tests: ["conformance-root.test.ts"] },

  // ---------------------------------------------------------------- TD04 §13.2 / §13.3 / §12 / §4.1 / §20.6
  // P7b, the kernel-enforced effect bound (the workflow-enforced P7a is a live-pilot control).
  { control: "TD04-P7b", tests: ["conformance-workbounds.test.ts"] },
  // The adapter conformance suite: double dispatch, reconciliation honesty, idempotency horizon.
  { control: "TD04-§13.3", tests: ["conformance-record.test.ts", "conformance-intake.test.ts", "conformance-transition.test.ts"] },
  // §12 r8 read-only constitutional observation (#96/#106), O1–O5.
  { control: "TD04-§12r8-O1", tests: ["conformance-observability.test.ts"] },
  { control: "TD04-§12r8-O2", tests: ["conformance-observability.test.ts"] },
  { control: "TD04-§12r8-O3", tests: ["conformance-observability.test.ts"] },
  { control: "TD04-§12r8-O4", tests: ["conformance-observability.test.ts"] },
  { control: "TD04-§12r8-O5", tests: ["conformance-observability.test.ts"] },
  // §4.1 OS + network isolation, F6–F10, every leg with a guard-bite.
  { control: "TD04-§4.1-F6", tests: ["conformance-osisolation.test.ts"] },
  { control: "TD04-§4.1-F7", tests: ["conformance-osisolation.test.ts"] },
  { control: "TD04-§4.1-F8", tests: ["conformance-osisolation.test.ts"] },
  { control: "TD04-§4.1-F9", tests: ["conformance-osisolation.test.ts"] },
  { control: "TD04-§4.1-F10", tests: ["conformance-osisolation.test.ts"] },
  // §20.6 governed deployment actuation: items 1–6 (with the composition-root registration) and 7.
  { control: "TD04-§20.6-1..6", tests: ["conformance-deployment-actuation.test.ts", "conformance-composition.test.ts"] },
  { control: "TD04-§20.6-7", tests: ["conformance-attest-refresh.test.ts"] },
  // §18.1/§18.2/§18.4 external verification as an evidence source, EV1–EV5.
  { control: "TD04-§18-EV1", tests: ["conformance-externalverify.test.ts"] },
  { control: "TD04-§18-EV2", tests: ["conformance-externalverify.test.ts"] },
  { control: "TD04-§18-EV3", tests: ["conformance-externalverify.test.ts"] },
  { control: "TD04-§18-EV4", tests: ["conformance-externalverify.test.ts"] },
  { control: "TD04-§18-EV5", tests: ["conformance-externalverify.test.ts"] },

  // ---------------------------------------------------------------- AP §C (A1–A5)
  { control: "AP-A1", tests: ["conformance-kernelconfig.test.ts"] },
  { control: "AP-A2", tests: ["conformance-kernelconfig.test.ts"] },
  { control: "AP-A3", tests: ["conformance-assembly.test.ts"] },
  // A4's o1..o5 legs, its w1 witness leg and its guard-bites span the mechanism file and the
  // live-composition origin file — the canonical many-to-many row.
  { control: "AP-A4", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts"] },
  { control: "AP-A5", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts"] },

  // ---------------------------------------------------------------- EP §C
  { control: "EP-C2", tests: ["conformance-isolation.test.ts"] },
  { control: "EP-B1(3)", tests: ["conformance-digestscheme.test.ts"] },

  // ---------------------------------------------------------------- WP §7 (C1–C15)
  { control: "WP-C1", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-C2", tests: ["conformance-allocation.test.ts"] },
  // The gate-file guard: an external candidate touching GATE_PATH_RULES cannot be AGENT_DECISION-merged.
  { control: "WP-C6", tests: ["conformance-gatefiles.test.ts", "conformance-delegation.test.ts"] },
  { control: "WP-C7", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-C8", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-C9", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-C10", tests: ["conformance-allocation.test.ts"] },
  { control: "WP-C13", tests: ["conformance-basesha.test.ts", "conformance-runorigin.test.ts"] },
  { control: "WP-C14", tests: ["conformance-basesha.test.ts", "conformance-runorigin.test.ts"] },
  { control: "WP-C15", tests: ["conformance-basesha.test.ts"] },

  // ---------------------------------------------------------------- SPEC
  // §8.2 read-only discovery: a proposal parses exactly, fails closed, and confers no authority.
  { control: "SPEC-§8.2", tests: ["conformance-planner.test.ts"] },
  // §8.4 independence extended to the machine decision; §3 incompatible duties (AD1–AD5).
  { control: "SPEC-§8.4", tests: ["conformance-delegation.test.ts"] },
  // TD04 §0/§11: the DEPLOYED composition root reaches every governed edge it claims — asserted
  // over `composeTargetAdapters`, not over the harness registry, which can and did diverge from it.
  { control: "TD04-§0/§11", tests: ["conformance-composition.test.ts"] },

  // ---------------------------------------------------------------- INTAKE (#104 §11, its own C1–C20)
  { control: "INTAKE-C3", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C4", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C5", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C6", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C7", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C8", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C11", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C12", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C13", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C14", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C15", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C16", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C17", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C18", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C19", tests: ["conformance-intake.test.ts"] },
  { control: "INTAKE-C20", tests: ["conformance-intake.test.ts"] },
  // #109 ancestry-completeness legs (S2-1..S2-5 / E1..E6) ride the same file.
  { control: "ISSUE109-E1..E6", tests: ["conformance-intake.test.ts"] },

  // ---------------------------------------------------------------- TRANSITION (#117 §12, FC1–FC22)
  { control: "TRANSITION-FC1", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC2", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC3", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC5", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC6", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC7", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC8", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC9", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC10", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC11", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC12", tests: ["conformance-transition.test.ts"] },
  // FC14 is the guard-bite row: every load-bearing predicate is re-run with its check removed.
  { control: "TRANSITION-FC14", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC15", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC16", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC17", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC18", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC19", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC20", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC21", tests: ["conformance-transition.test.ts"] },
  { control: "TRANSITION-FC22", tests: ["conformance-composition.test.ts"] },

  // ---------------------------------------------------------------- issue-derived families
  // #102 review repairs: F2 custody (also EP-C2), F4 prior-state truthfulness, F5 API exactness.
  { control: "ISSUE102-F2", tests: ["conformance-isolation.test.ts"] },
  { control: "ISSUE102-F4", tests: ["conformance-isolation.test.ts"] },
  { control: "ISSUE102-F5", tests: ["conformance-isolation.test.ts"] },
  // #127 malformed WORK_START bounds fail closed, WB1–WB5 (WB3 is the guard-bite).
  { control: "ISSUE127-WB1", tests: ["conformance-workbounds.test.ts"] },
  { control: "ISSUE127-WB2", tests: ["conformance-workbounds.test.ts"] },
  { control: "ISSUE127-WB3", tests: ["conformance-workbounds.test.ts"] },
  { control: "ISSUE127-WB4", tests: ["conformance-workbounds.test.ts"] },
  { control: "ISSUE127-WB5", tests: ["conformance-workbounds.test.ts"] },
  // #259 P0a: the reviewer's two planes — the candidate may not instruct its own reviewer. The
  // gate-file basename rule (GF6) is the merge-authority half of the same repair.
  { control: "ISSUE259-P0a", tests: ["conformance-reviewmount.test.ts", "conformance-gatefiles.test.ts"] },
  // #259 P0b: the reviewer's full text is retained, self-verifying and byte-recoverable.
  { control: "ISSUE259-P0b", tests: ["conformance-reviewbody.test.ts"] },
];

/**
 * Files in this directory that project no single numbered control. They are here — protected — by
 * the fail-protected default of the split: AMBIGUOUS lands in `conformance/`. Listing them is what
 * keeps the directory INTENTIONAL: the meta-test refuses any file that is neither mapped above nor
 * declared here, so a new file cannot arrive (or a mapped one be quietly demoted) unnoticed.
 */
export const CONFORMANCE_AUXILIARY: readonly AuxiliaryConformanceTest[] = [
  {
    test: "kernel-chain.test.ts",
    classification: "UNMAPPED-AUXILIARY",
    why: "K3 → K4 → K5(OPA) → K6 → dispatch → K7 smoke against the reference composition: the positive control every §13.1 negative control is read against (and its fail-closed refusals). Not a numbered row of any control table.",
  },
  {
    test: "conformance-driver.test.ts",
    classification: "UNMAPPED-AUXILIARY",
    why: "#61 D1–D3: the fail-closed classification loop behind `ctl work-plan`. `cadp/product/driver.ts` is itself gate machinery — a loop that advanced on an unclean delivery would drive candidates past the gate — so its projection stays protected though no TD control table numbers it.",
  },
  {
    test: "conformance-mcp.test.ts",
    classification: "UNMAPPED-AUXILIARY",
    why: "#61 M1–M3: the tool surface a supervising session drives, including the fail-closed session work-start cap. `cadp/product/mcp.ts` is gate machinery; the cap is a refusal, not a convenience.",
  },
  {
    test: "conformance-reviewproviders.test.ts",
    classification: "UNMAPPED-AUXILIARY",
    why: "The reviewer VERDICT contract (which text becomes APPROVE / REQUEST_CHANGES — the REVIEW claim the merge gate consumes) and the §8.4 entry independence guard. Argv snapshots travel in the same file; splitting the file is out of this lane's scope, and the fail-protected default keeps the whole file protected.",
  },
  {
    test: "conformance-provider-measurement-gate.test.ts",
    classification: "UNMAPPED-AUXILIARY",
    why: "Measurement-first honesty across all three provider registries: a capability field may exist only where a live probe measured it, and unmeasured slots stay absent rather than becoming fabricated PRESENT facts.",
  },
  {
    test: "conformance-manifest.test.ts",
    classification: "MANIFEST-MACHINERY",
    why: "The meta-test over this manifest: mapped files exist, every file here is accounted for, no control maps to nothing, and no *.test.ts hides outside the three enumerated test directories.",
  },
];
