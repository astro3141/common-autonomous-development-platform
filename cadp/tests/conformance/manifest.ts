/**
 * Conformance traceability manifest — TD control ID ⇄ test file, many-to-many.
 *
 * DEFINITION (the reason this directory is gate-protected, stated once, verbatim):
 * conformance tests are NOT authority themselves — they are the EXECUTABLE ASSURANCE PROJECTION
 * of TD authority; they are protected to PREVENT WEAKENING OF THE TD ASSURANCE BOUNDARY (not
 * because changing them "amends the TD").
 *
 * A test file in `cadp/tests/conformance/` implements one or more TD-mandated conformance
 * controls: its assertions are the executable form of a control the merged Spec/TD corpus states.
 * Deleting, moving or emptying such a file narrows what the verifier actually proves while the TD
 * text is untouched — the assurance boundary moves without any amendment being visible. That is
 * what the gate protection (`cadp/product/gateFiles.ts`) and the meta-test
 * (`conformance-manifest.test.ts`) exist to make impossible to do silently.
 *
 * `cadp/tests/ops/` holds tests of OPERATIONAL contracts only (broker prompt shapes, provider argv
 * snapshots, timeout budgets, effort argv rendering). Those are not gate-protected; both
 * directories keep RUNNING in both verifiers — the split changes PROTECTION, never coverage.
 *
 * MANY-TO-MANY, in both directions, by construction:
 *   - one control maps to several files (AP-A4's legs and guard-bites live in `conformance-runorigin`
 *     AND `conformance-basesha`);
 *   - one file serves several controls (`conformance-allocation` carries AP-B1/B2/B3/B6 plus the
 *     WP first-seal controls 7–10).
 *
 * CONTROL ID NAMESPACES (`<doc>-<id>`; the doc is the authority, the id is its own numbering):
 *   AP-*    TECHNICAL_DESIGN_cadp_v0_5_authority_plane.md — §C controls A1–A5, contracts B1–B6
 *   WP-*    TECHNICAL_DESIGN_cadp_v0_5_workflow_plane.md — §7 falsification controls 1–15
 *   EP-*    TECHNICAL_DESIGN_cadp_v0_5_execution_plane.md — §C controls, contracts B1–B2
 *   TD-*    TECHNICAL_DESIGN_cadp_v0_4_generation.md — §13.1 C-controls, §13.2 P-controls,
 *           §13.3 adapter suite, §12 r8 observation revision, §4.1 isolation, §20.6 items
 *   RTA-*   DESIGN_cadp_reclassification_transition_authority.md — the #117 §12 FC table
 *   SPEC-*  Common Autonomous Development Platform — Specification v0.5.md — §8.2, §8.4, §9 (K7)
 *
 * UNMAPPED-AUXILIARY holds conformance-directory files that are protection-worthy but not (yet)
 * tied to a NUMBERED corpus control — including the files classified AMBIGUOUS at the directory
 * split, which take the fail-protected default (conformance/, not ops/). Each carries its reason.
 * A file listed there is protected exactly as strongly as a mapped one; only its traceability is
 * pending.
 */

/** One control and every test file that implements a leg, guard-bite or recheck of it. */
export type ControlEntry = {
  /** `<doc>-<id>` per the namespaces above. */
  readonly control: string;
  /** File names (basenames) inside `cadp/tests/conformance/`. Never empty. */
  readonly tests: readonly string[];
  /** Optional: what the file's own leg numbering is, where it differs from the control id. */
  readonly note?: string;
};

/** A conformance-directory file protected without (yet) a numbered control behind it. */
export type AuxiliaryEntry = {
  /** File name (basename) inside `cadp/tests/conformance/`. */
  readonly test: string;
  /** Why it lives here: the contract it pins, and — if it was AMBIGUOUS — that it took the default. */
  readonly reason: string;
};

export const CONTROL_MAP: readonly ControlEntry[] = [
  // ---- Authority Plane (AP): §C controls A1–A5 and the B1–B6 contracts they falsify.
  { control: "AP-A1", tests: ["conformance-kernelconfig.test.ts"], note: "duplicate-registry-row rejection, B3(1)" },
  { control: "AP-A2", tests: ["conformance-kernelconfig.test.ts"], note: "unknown-entry-key rejection, B3(2)/B3(3)" },
  { control: "AP-A3", tests: ["conformance-assembly.test.ts"], note: "assembly-completeness refusal; the kernel-side legs of A3" },
  { control: "AP-A4", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts"], note: "run-capability borrowing/witnessed minting/delivery + K7 gating (B5)" },
  { control: "AP-A5", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts"], note: "run-origin identity + contract immutability (B1(5), B2(2)(ii), B2(8))" },
  { control: "AP-B1", tests: ["conformance-allocation.test.ts", "conformance-runorigin.test.ts", "conformance-basesha.test.ts"] },
  { control: "AP-B2", tests: ["conformance-allocation.test.ts", "conformance-runorigin.test.ts"] },
  { control: "AP-B3", tests: ["conformance-kernelconfig.test.ts", "conformance-allocation.test.ts"] },
  { control: "AP-B4", tests: ["conformance-assembly.test.ts"] },
  { control: "AP-B5", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts"] },
  { control: "AP-B6", tests: ["conformance-runorigin.test.ts", "conformance-allocation.test.ts"], note: "wire framing, exercised on the transport of the A4/B2 legs" },

  // ---- Workflow Plane (WP) §7 falsification controls.
  { control: "WP-1", tests: ["conformance-allocation.test.ts"], note: "replay convergence" },
  { control: "WP-2", tests: ["conformance-allocation.test.ts"], note: "identity-squatting refusal (cross-principal distinctness)" },
  { control: "WP-4", tests: ["conformance-github.test.ts"], note: "subject inequality — the C41 leg rerun against the external client" },
  { control: "WP-6", tests: ["conformance-gatefiles.test.ts", "conformance-delegation.test.ts"], note: "gate-file guard: a GATE_PATH_RULES path is never merged by AGENT_DECISION" },
  { control: "WP-7", tests: ["conformance-allocation.test.ts"], note: "first-seal candidate binding" },
  { control: "WP-8", tests: ["conformance-allocation.test.ts"], note: "first-seal base binding" },
  { control: "WP-9", tests: ["conformance-allocation.test.ts"], note: "first-seal purpose binding" },
  { control: "WP-10", tests: ["conformance-allocation.test.ts"], note: "first-seal principal binding" },
  { control: "WP-13", tests: ["conformance-runorigin.test.ts", "conformance-basesha.test.ts"], note: "run-origin replay convergence and origin distinctness (§3.6)" },
  { control: "WP-14", tests: ["conformance-basesha.test.ts"], note: "origin material replay stability (§3.6)" },
  { control: "WP-15", tests: ["conformance-basesha.test.ts"], note: "record-vertical generality (§3.6)" },

  // ---- Execution Plane (EP).
  { control: "EP-B1", tests: ["conformance-digestscheme.test.ts"], note: "B1(3)'s named digest-scheme gap in the inherited AP §2.1 contract" },
  {
    control: "EP-B1-6b",
    tests: ["conformance-reviewmount.test.ts"],
    note: "B1(6b) the evidence plane is a SANITIZED SNAPSHOT: /candidate is the tracked tree of candidate_sha byte-for-byte with NO .git (the inverted assertion), a symlink/gitlink candidate is refused at materialization with no container created, and the mode rule itself at its seam",
  },
  { control: "EP-C2", tests: ["conformance-isolation.test.ts"], note: "custody; the EP §C text names this file and its F2 control by path" },

  // ---- v0.4 TD §13.1 constitutional negative controls (C1–C42), with their guard-bites.
  { control: "TD-C1", tests: ["conformance-binding.test.ts"] },
  { control: "TD-C2", tests: ["conformance-binding.test.ts"] },
  { control: "TD-C3", tests: ["conformance-binding.test.ts"] },
  { control: "TD-C4", tests: ["conformance-store.test.ts"] },
  { control: "TD-C5", tests: ["conformance-binding.test.ts"] },
  { control: "TD-C6", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C7", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C8", tests: ["conformance-store.test.ts"] },
  { control: "TD-C9", tests: ["conformance-dispatch.test.ts"], note: "C9/C9b, with the #12 guard-bite" },
  { control: "TD-C10", tests: ["conformance-record.test.ts"] },
  { control: "TD-C11", tests: ["conformance-github.test.ts"] },
  { control: "TD-C12", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C13", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C14", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C15", tests: ["conformance-store.test.ts"] },
  { control: "TD-C16", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD-C17", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C18", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C19", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C20", tests: ["conformance-github.test.ts"] },
  { control: "TD-C21", tests: ["conformance-github.test.ts"] },
  { control: "TD-C22", tests: ["conformance-policyactivate.test.ts"], note: "C22/C22b activation reorder + recovery" },
  { control: "TD-C23", tests: ["conformance-store.test.ts"] },
  { control: "TD-C24", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C25", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD-C26", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD-C27", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C28", tests: ["conformance-authority.test.ts"] },
  { control: "TD-C29", tests: ["conformance-authority.test.ts", "conformance-deployment-actuation.test.ts"] },
  { control: "TD-C30", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD-C31", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD-C32", tests: ["conformance-binding.test.ts"] },
  { control: "TD-C33", tests: ["conformance-store.test.ts"] },
  { control: "TD-C34", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD-C35", tests: ["conformance-policyactivate.test.ts"] },
  { control: "TD-C36", tests: ["conformance-dispatch.test.ts"] },
  { control: "TD-C37", tests: ["conformance-store.test.ts"] },
  { control: "TD-C38", tests: ["conformance-binding.test.ts"] },
  { control: "TD-C39", tests: ["conformance-root.test.ts"] },
  { control: "TD-C40", tests: ["conformance-root.test.ts"] },
  { control: "TD-C41", tests: ["conformance-github.test.ts"], note: "review-to-effect provenance continuity, falsifications 1–5 + guard-bite" },
  { control: "TD-C42", tests: ["conformance-root.test.ts"] },

  // ---- v0.4 TD §13.2 product controls, §13.3 adapter suite, §12 r8, §4.1, §20.6.
  { control: "TD-P7", tests: ["conformance-workbounds.test.ts"], note: "P7a/P7b step and effect bounds; the malformed-bound fail-closed legs (#127)" },
  {
    control: "TD-13.3",
    tests: [
      "conformance-record.test.ts",
      "conformance-github.test.ts",
      "conformance-deployment-actuation.test.ts",
      "conformance-intake.test.ts",
    ],
    note: "per-adapter conformance suite; the intake adapter's own legs are numbered #104 §11 controls 1–20",
  },
  { control: "TD-12-r8", tests: ["conformance-observability.test.ts"], note: "read-only constitutional observation, O1–O5" },
  {
    control: "TD-4.1",
    tests: ["conformance-osisolation.test.ts", "conformance-isolation.test.ts", "conformance-reviewmount.test.ts"],
    note: "surface OS/network isolation boundary (F6–F10) and the reviewer's evidence/instruction planes (#259 P0a)",
  },
  { control: "TD-20.6-item1", tests: ["conformance-composition.test.ts", "conformance-deployment-actuation.test.ts"] },
  { control: "TD-20.6-item2", tests: ["conformance-deployment-actuation.test.ts"] },
  { control: "TD-20.6-item3", tests: ["conformance-deployment-actuation.test.ts"] },
  { control: "TD-20.6-item4", tests: ["conformance-deployment-actuation.test.ts"] },
  { control: "TD-20.6-item5", tests: ["conformance-deployment-actuation.test.ts"] },
  { control: "TD-20.6-item6", tests: ["conformance-deployment-actuation.test.ts"], note: "rollback as a second Human-gated DEPLOY" },
  { control: "TD-20.6-item7", tests: ["conformance-attest-refresh.test.ts"], note: "deployment-control scheduled attestation refresh" },

  // ---- Reclassification/transition authority (RTA): the #117 §12 falsification table.
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
  { control: "RTA-FC14", tests: ["conformance-transition.test.ts"], note: "guard-bite controls: the policy source or a registry ingress rule is disabled and the exploit must reproduce" },
  { control: "RTA-FC15", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC16", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC17", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC18", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC19", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC20", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC21", tests: ["conformance-transition.test.ts"] },
  { control: "RTA-FC22", tests: ["conformance-composition.test.ts"], note: "the governed FINDING_SEAL row in the PRODUCTION composition root, with its guard-bite" },

  // ---- Spec v0.5 sections that mandate a control directly.
  { control: "SPEC-8.2", tests: ["conformance-planner.test.ts"], note: "read-only discovery: a proposal is provenance-bound and confers no authority" },
  {
    control: "SPEC-8.4",
    tests: ["conformance-reviewproviders.test.ts", "conformance-planproviders.test.ts", "conformance-delegation.test.ts"],
    note: "reviewer/decider independence, extended to the machine decision (Spec §3 incompatible duties)",
  },
  { control: "SPEC-K7", tests: ["conformance-runorigin.test.ts"], note: "K7 run grading of the capability the AP-A4 legs mint" },
];

export const UNMAPPED_AUXILIARY: readonly AuxiliaryEntry[] = [
  {
    test: "conformance-manifest.test.ts",
    reason: "the meta-test itself: it is what makes a deletion or a silent drop from this directory fail deterministically",
  },
  {
    test: "kernel-chain.test.ts",
    reason: "end-to-end kernel admit/commit chain and its fail-closed refusals (no reach attestation, no identity); an invariant suite, not a numbered control",
  },
  {
    test: "conformance-externalverify.test.ts",
    reason: "#57 EV1–EV5: the external verifier as an EVIDENCE SOURCE and the require_external_verification sufficiency param; issue-anchored control table",
  },
  {
    test: "conformance-reviewbody.test.ts",
    reason: "#259 P0b R1–R6: the Primary Reviewer's full text is retained durably, self-verifying and byte-identically recoverable; issue-anchored control table",
  },
  {
    test: "conformance-driver.test.ts",
    reason: "#61 D1–D3: the fail-closed run-classification loop behind ctl work-plan. AMBIGUOUS at the split (loop plumbing vs the fail-closed rule it enforces) — took the fail-protected default",
  },
  {
    test: "conformance-mcp.test.ts",
    reason: "#61 M1–M3: the MCP tool-surface subset and the session work-start cap. AMBIGUOUS (tool-surface plumbing vs the cap failing closed) — took the fail-protected default",
  },
  {
    test: "conformance-sessions.test.ts",
    reason: "verifier/reviewer docker-arg pins plus failed-session retention. AMBIGUOUS (an isolation-surface pin alongside an operational convenience) — took the fail-protected default",
  },
  {
    test: "conformance-provider-measurement-gate.test.ts",
    reason: "provider model/effort scan slots must be MEASURED, never assumed. AMBIGUOUS (provider-profile snapshot vs the evidence-honesty rule it protects) — took the fail-protected default",
  },
];
