# TECHNICAL DESIGN — CADP v0.5 Workflow Plane integration contract

How a workload worked is its orchestrator's business; the moment it changes the external world, it is CADP's business.

| Field | Value |
|---|---|
| Status | **TECHNICAL DESIGN CANDIDATE while unmerged; plane-TD of the v0.5 generation upon Human-approved canonical merge** |
| Mandated by | `DESIGN_cadp_v0_5_generation.md` (below: Design) D8; `Common Autonomous Development Platform — Specification v0.5.md` (below: Spec v0.5) §10 |
| Succeeds | The workflow half of the bisected TD §7/§8 plus the effect-client caller surface of TD §12 (`TECHNICAL_DESIGN_cadp_v0_4_generation.md`, below: TD v0.4) — re-homed, not rewritten (Design D8) |
| Scope | The Workflow Plane **boundary** only: effect client for external candidates, evidence submission, run-profile non-enrollment |
| Non-scope | Everything inside any orchestrator (§2); the Authority Plane TD; the Execution Plane contract document |

Probe rule: TD v0.4 §17.2's measurement-first discipline applies. Any capability claim not backed by a corpus or P0 measurement carries `[UNMEASURED — probe required]`. P0 below = the owner-run Conductor probe, run `24919dde`, 2026-09-07.

## 1. Position and thinness rule

The withdrawn Conductor integration (PRs 199–204) failed by constitutionalizing an orchestrator's runtime; every Conductor concept demanded a CADP counterpart (Design D0). This document is its replacement at a fraction of that size, and the size bound is structural, not stylistic: per Spec v0.5 §4.1, mutation intents arriving as `EffectRequestV1` through an effect client is the **whole** mandatory integration between any workflow plane and CADP. Everything below specifies that boundary and nothing behind it. A Conductor workflow, a cron job, and a human at a terminal are equal citizens at this boundary (Spec v0.5 §4.2); nothing here is Conductor-specific except measured facts grounding refusals (§5, §6).

## 2. Scope fence (non-goals)

Per Design D7-2 and D7-3, this document contains, normatively:

- **no orchestrator task states** — how a Conductor (or Temporal, or cron) run represents progress is its business;
- **no retry semantics** — the orchestrator may retry its own steps freely; the *effect* retry discipline is the Authority Plane's (Spec v0.5 §4.4: no blind retry), stated there, not here;
- **no checkpoint model** — orchestrator durability is never authority (Spec v0.5 §4.1);
- **no DAG vocabulary** and **no Conductor YAML schema** — workflow shape never crosses the boundary.

Orchestrator internals appear below **only** as measured facts grounding refusals (Design preamble; §5, §6). If a future revision of this document states any of the above normatively, that is a regression to the withdrawn approach and grounds for REQUEST_CHANGES on its own.

## 3. The external-candidate effect client

### 3.1 Measured gap (P0)

v0.4 exposes no surface for an externally-produced candidate to enter governance. The live surfaces — `cadp/live/mcpServer.ts` (`cadp_work_start`) and `cadp/live/ctl.ts` — only start the internal Temporal pipeline: `cadpWork` (`cadp/product/workflows.ts`) runs its own `implementCandidate` / `verifyCandidate` / `reviewCandidate` activities. A candidate produced anywhere else (a Conductor workflow's working tree, a cron job, a human clone) has no path to the governed effects `GIT_PUSH`, `PR_CREATE`, `PR_MERGE` except by not being governed at all. This section closes that gap with the minimal caller surface.

### 3.2 Caller surface — no new API

The client is the existing Kernel API of TD v0.4 §12, unchanged: `put_blob`, `allocate_effect_id`, `seal_effect_request`, `submit_evidence`, `assemble_admission_input`, `evaluate`, `admit_and_dispatch`, `get_effect_state`, `request_reconcile`, plus the reads. An external effect proposer authenticates as its own registered principal (mTLS/SPIFFE or, for a human terminal, the IdP path) with the **workflow/orchestrator caller class reach** of the TD v0.4 §12 matrix. No new endpoint, no new caller class, no new record kind. This is safe for untrusted callers for exactly the reason TD v0.4 §12 states: no method grants authority — a sealed request still needs evidence, an evaluator decision under the active policy, and the PEP's fresh recheck (Spec v0.5 §4.3 steps 5–7). `requester_ref` is always stamped from the authenticated principal, never accepted from the body (TD v0.4 §9.1 S3).

### 3.3 Effect identity — Platform-sealed, orchestrator-retry-convergent

`effect_id` is allocated by Platform effect ingress before any non-trivial external call; a caller-proposed correlation string is never identity authority (Spec v0.5 K3). Concretely for external proposers:

- The proposer calls `allocate_effect_id` with a versioned canonical tuple (TD v0.4 §7.4 discipline: canonical JSON, closed `purpose` vocabulary, no raw concatenation), schema `cadp.allocation-key.external.v1`: `{ schema, repo_id, candidate_sha, purpose }`. The Ingress scopes the derived key by the **stamped** requester principal — two principals proposing the same candidate get distinct effect identities; a retry by the same principal converges on the same `effect_id`, so an orchestrator that re-runs a step never creates a second logical effect. (This replaces the internal tuple's `work_run_ref + step_ordinal` scoping, which presumes run-profile enrollment — §5 refuses that here.)
- A Conductor run identifier is doubly disqualified as an identity component: constitutionally, because K3 forbids caller identity authority; and factually, because P0 measured that `CONDUCTOR_RUN_ID` is not exported to script-step environments despite the documentation saying it is. It may travel as opaque diagnostic content inside `source_ref`/claim payloads; it never keys anything.

### 3.4 The three governed effects and their material bindings

All three re-use the v0.4 GitHub adapter contract of TD v0.4 §6.4 **byte-for-byte** — same materials, same idempotency/precondition rules, same COMMITTED / NO_EFFECT_CONFIRMED proofs. What is new is only who seals the request:

| Effect | Material (TD v0.4 §6.4) | External-candidate binding rule |
|---|---|---|
| `GIT_PUSH` | `{repo_id, ref = refs/heads/cadp/candidate/<candidate_sha>, new_sha = candidate_sha, expected_old_sha = 0000…, bundle_cas_key}` | The proposer `put_blob`s a `git bundle` of the candidate; the PEP verifies the bundle reproduces **exactly** `candidate_sha` before pushing (TD v0.4 §6.6, §8.1). An external bundle is exactly as untrusted as a worker bundle was; the same verification makes it safe. |
| `PR_CREATE` | `{repo_id, base_ref, head_ref = refs/heads/cadp/candidate/<head_sha>, head_sha, title_cas_key, body_cas_key}` | `head_sha = candidate_sha`; write-once candidate ref shape enforced at admission (TD v0.4 §4.4 #14). |
| `PR_MERGE` | `{repo_id, pr_number, expected_head_sha, merge_method}` | `expected_head_sha = candidate_sha`; target-native CAS rejects head drift. |

`base_sha` and repository identity enter `work_bindings` of every `EffectRequestV1` as exact input identity + revision (Spec v0.5 K3), so policy, reviewers, and the merge decision all evaluate against a pinned base. Any ancestry rule (candidate descends from `base_sha`) is development-composition semantics per Spec v0.5 §7, evaluated by the evaluator over K4-bound facts — never new kernel vocabulary.

### 3.5 Re-homed unchanged

- **Broker push/PR actuation:** the credential-less bounded broker and PEP-held GitHub credential (TD v0.4 §4, §18.2) actuate; the proposer never touches a governed-target credential (§6).
- **Gate-file routing:** `touchesGateMachinery` (`cadp/product/gateFiles.ts`) applies to external candidates identically — a candidate touching kernel/policy/surface/conformance/constitutional-document paths routes to a `HUMAN_DECISION`, never a delegated agent merge.
- **Agent vs HUMAN merge decision:** the TD v0.4 §12 r9 `agent-surface` contract carries over — `AGENT_DECISION` satisfies only the merge gate, only for producers named in `delegated_merge_producers`, formed by a fresh isolated reviewer, honestly attributed. For an external candidate, the r9 independence predicate is evaluated against the **proposing `requester_ref`** (the closest stamped identity to the implementer, §4.2): a delegate that is, or shares an identity class with, the proposer is refused.

## 4. Evidence submission

### 4.1 Ingress and provenance honesty

External evidence enters as `EvidenceEnvelopeV1` through `submit_evidence`, under the full TD v0.4 §9.1 ingress discipline: `producer_ref` stamped from the authenticated principal; `provenance.integrity` set by the Ingress; `source_relation` checked against the policy-bound adapter registry. The consequence for orchestrator-relayed evidence is mechanical: **when an orchestrator submits a review it ran (the P0 case: a codex review executed inside the Conductor loop), the envelope's producer is the orchestrator's principal and its relation is at most `SELF_REPORT` of the orchestrator** — unless the platform can independently verify the actual producer (a signature the Ingress verifies against `data.cadp.attestation_keys` → `SIGNED_ATTESTATION` under the true producer, or the producer submitting directly as its own registered principal). Self-report is never promoted (Spec v0.5 §4.5); an honest `SELF_REPORT` review is recorded, and simply does not satisfy a gate requiring independence.

### 4.2 What the reference policy accepts for external candidates

The candidate-sha subject-equality rules of TD v0.4 §8.3 (C41 leg 1) apply unchanged — they are composition semantics now (Spec v0.5 §2.4, §7): a required `REVIEW`/`VERIFICATION` envelope satisfies the requirement only if its bound `repo_id + candidate_sha` equals the exact candidate the sealed material names; inequality is requirement-unsatisfied, no K6. On top of that equality, the reference policy for external candidates requires:

- **Verification:** a `PRESENT` `VERIFICATION` from `verifier:github-actions` bound to the exact `candidate_sha` with `claim.conclusion == "success"`, `TARGET_AUTHORITY_OBSERVATION`, source-authoritative `produced_at` (TD v0.4 §18.3 fail-closed projection, unchanged). This producer works for external candidates without modification because it observes the pushed candidate ref at the target — it is independent of whoever made the candidate by construction.
- **Review:** a `REVIEW` envelope whose producer is a registered principal distinct from the proposing `requester_ref` and satisfying the TD v0.4 §8.4 identity-class predicates against it. A platform reviewer surface reviewing the pushed ref qualifies; a GitHub-native review read via API qualifies (subject = `commit_id`, compared by the evaluator); an orchestrator-relayed review qualifies only under the §4.1 verification paths — as bare relay it is `SELF_REPORT` of the proposer's side and does not satisfy the requirement.
- **Merge:** `HUMAN_DECISION` (TD v0.4 §9.3 path A), or delegated `AGENT_DECISION` under §3.5's carried-over constraints.

With the implementer outside the platform, no `BACKEND_EXECUTION`/`WORK_STEP` evidence exists to prove implementer identity; the reference policy therefore treats the proposing `requester_ref` as the implementer-side identity for every separation predicate. That is deliberately conservative (Spec v0.5 §2.5): an unknown implementer never weakens an independence requirement.

### 4.3 Fail-closed default

Absent, stale, subject-mismatched, or `UNKNOWN` required evidence admits nothing (Spec v0.5 §2.5, §4.5). There is no "external candidates get a lighter gate" mode: an external candidate passes the same evaluator, the same fresh recheck, and the same gate-file routing as an internal one, or it does not pass.

## 5. Explicit non-enrollment in the run profile

### 5.1 Measured facts (P0, run `24919dde`, 2026-09-07)

Conductor's run receipts are local-file grade: an `events.jsonl` under `TMPDIR`, keyed by an 8-hex `run_id`; the run record is **deleted on normal completion**; a checkpoint is written only on failure by default.

### 5.2 The refusal

Run-scope validity grades by the K7 outcome of a `WORK_START` effect (Spec v0.5 §5.2): `COMMITTED` requires a target-authoritative receipt binding the exact effect (the measured v0.4 rule: a describe-read returning a memo matching `cadp_effect_id` and `cadp_args_digest` — TD v0.4 §6.4, C34). A TMPDIR file deleted on success, keyed by a local 8-hex identifier, cannot be that receipt: there is no target-authoritative `WORK_START` outcome to grade a Conductor run scope by K7, and after a normal completion there is no receipt at all. **Therefore the reference deployment enrolls no Conductor principal in the run profile. Conductor runs claim per-effect Kernel Conformance only — never the run profile.** This is a measured refusal, not a policy preference, and it is complete governance, not degraded governance: per-effect Kernel Conformance is the whole constitutional guarantee (Spec v0.5 §5).

Non-enrollment is symmetric and policy-bound (Spec v0.5 §5.1): the active policy simply does not name any Conductor principal among the enrolled `requester_ref`s, and a non-enrolled principal **cannot opt in by inventing a `work_run_ref` binding** — a fabricated binding names no admitted `WORK_START` effect_id and fails scope validity outright. What non-enrollment costs is stated, not hidden: no `MAX_EFFECTS_IN_WORK_RUN`, no `WORK_STEP` chain requirements, no bound-stop semantics for these runs.

### 5.3 Revisit conditions

Enrollment could be revisited only on new measurement: `[UNMEASURED — probe required: a target-authoritative run receipt from the orchestrator — durable across normal completion, correlatable to a Platform-sealed WORK_START effect_id by a target-returned binding (memo-equivalent), and readable by the Reconciler after restart. Absent all three properties, K7 grading of a Conductor run scope remains impossible and non-enrollment stands.]`

## 6. Credential custody at the client (measured)

P0 measured that a Conductor `working_dir` is **not a sandbox**, and that `claude-agent-sdk` loads the working directory's settings as a trust boundary. The consequence is the Spec v0.5 §2.3 rule with no softening: **no governed-target credential may exist anywhere an orchestrator's working directory or settings can reach.** Credential custody stays entirely PEP/broker-side (TD v0.4 §4.1, §18.2: the GitHub credential is PEP-held; the broker is credential-less toward the kernel; workers cannot `admit_and_dispatch` — matrix reach notwithstanding, the worker class cannot even seal requests). The only credential an effect-proposer environment holds is its own Kernel API principal identity, which grants no effect authority by §3.2. A deployment that places a governed-target token in a Conductor working directory has left Kernel Conformance for every effect that token can reach, whatever this document says.

## 7. Conformance controls (falsification additions)

In the Spec v0.5 §9 spirit — proven by attempting the violation:

1. **Replay convergence:** the same external principal re-calling `allocate_effect_id` with the same `cadp.allocation-key.external.v1` tuple receives the same `effect_id`; the target shows one push, one PR (counted at the target, TD v0.4 §13 method).
2. **Identity-squatting refusal:** a different principal submitting the same tuple receives a different `effect_id` and cannot conflict the first principal's request.
3. **Relayed-review honesty:** an orchestrator-relayed review seals as `SELF_REPORT` of the orchestrator principal and a gate requiring independent review DENYs; the same review submitted by the reviewer's own registered principal (or attested per §4.1) admits.
4. **Subject inequality:** review/verification bound to candidate A does not admit an effect naming candidate B (C41 leg 1 rerun against the external client).
5. **Opt-in refusal:** a non-enrolled principal's request carrying a fabricated `work_run_ref` is refused (Spec v0.5 §9.2 negative control, external edition).
6. **Gate-file guard:** an external candidate touching a `GATE_PATH_RULES` path cannot be merged by `AGENT_DECISION`.

## Appendix — anchors used

| Rule here | Anchor |
|---|---|
| Effect client is the whole mandatory integration | Spec v0.5 §4.1; Design D4, D6 |
| Equal citizens at the effect boundary | Spec v0.5 §4.2; Design D1.1 |
| Platform-sealed effect identity | Spec v0.5 K3; TD v0.4 §2.2, §7.4 (tuple discipline) |
| GitHub adapter materials/proofs unchanged | TD v0.4 §6.4, §6.6 |
| Bundle-reproduces-candidate verification | TD v0.4 §8.1, §6.6 |
| Gate-file routing; delegated merge | `cadp/product/gateFiles.ts`; TD v0.4 §12 r9 |
| Producer stamping; registry-bound provenance | TD v0.4 §9.1 |
| Candidate-sha subject equality as composition semantics | TD v0.4 §8.3 (C41 leg 1), §18.3; Spec v0.5 §2.4, §7 |
| Run scope grades by K7; enrollment policy-bound | Spec v0.5 §5.1–5.3; TD v0.4 §6.4 (C34) |
| Credential custody without carve-out | Spec v0.5 §2.3, §6; TD v0.4 §4.1, §18.2 |
| P0 measured facts (Conductor receipts, working_dir, CONDUCTOR_RUN_ID) | owner-run Conductor probe, run `24919dde`, 2026-09-07 |
