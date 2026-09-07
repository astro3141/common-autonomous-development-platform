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

- The proposer calls `allocate_effect_id` with a versioned canonical tuple (TD v0.4 §7.4 discipline: canonical JSON, closed `purpose` vocabulary, no raw concatenation), schema `cadp.allocation-key.external.v1`: `{ schema, repo_id, candidate_base_sha, candidate_sha, purpose }`. `candidate_base_sha` (§3.4 vocabulary: the exact base revision the candidate was built and reviewed against) is an exact immutable identity component alongside repository identity and `candidate_sha` — without it, two submissions whose candidates sit on materially different base revisions could share an `effect_id`, contradicting K3's binding of one `effect_id` to one `request_digest` over exact material. The Ingress scopes the derived key by the **stamped** requester principal — two principals proposing the same candidate get distinct effect identities; a retry by the same principal converges on the same `effect_id`, so an orchestrator that re-runs a step never creates a second logical effect. (This replaces the internal tuple's `work_run_ref + step_ordinal` scoping, which presumes run-profile enrollment — §5 refuses that here.)
- **Allocation-to-first-seal binding (closes the pre-K3 window).** K3's one-`effect_id`-one-`request_digest` conflict rule presupposes an *existing* sealed `request_digest`; on the first `seal_effect_request` for an allocated `effect_id` there is nothing yet to conflict with, so K3 alone would not stop a first seal naming different material than the allocation — or a first seal by a different principal than the allocator. The Ingress therefore retains an internal `AllocationBinding { effect_id, requester_ref (stamped), allocation_schema, repo_id, candidate_base_sha, candidate_sha, purpose }` in its existing allocation storage — explicitly **not** a new constitutional record; no K8 is created. `seal_effect_request` MUST verify, before any K3 record is created: (a) the caller's stamped `requester_ref` equals the allocation's `requester_ref`; (b) the sealed `repo_id`, `candidate_base_sha`, and `candidate_sha` equal the allocated values; (c) the closed purpose-to-operation_kind correspondence holds — `GIT_PUSH`↔`GIT_PUSH`, `PR_CREATE`↔`PR_CREATE`, `PR_MERGE`↔`PR_MERGE`. Any mismatch is REFUSED: no `EffectRequestV1` is sealed, no effect is performed. After a `request_digest` exists, the existing K3 conflict rule continues to govern re-seal attempts — same material converges, different material conflicts and performs no effect (Spec v0.5 K3). The binding closes the pre-K3 window; K3 governs everything after it.
- A Conductor run identifier is doubly disqualified as an identity component: constitutionally, because K3 forbids caller identity authority; and factually, because P0 measured that `CONDUCTOR_RUN_ID` is not exported to script-step environments despite the documentation saying it is. It may travel as opaque diagnostic content inside `source_ref`/claim payloads; it never keys anything.

### 3.4 The three governed effects and their material bindings

All three re-use the v0.4 GitHub adapter contract of TD v0.4 §6.4 **byte-for-byte** — same materials, same idempotency/precondition rules, same COMMITTED / NO_EFFECT_CONFIRMED proofs. What is new is only who seals the request.

**Vocabulary split — two different "bases".** `candidate_base_sha` is the immutable provenance/input binding: it records which base revision the candidate was built and reviewed against, and it is what the §3.3 allocation tuple and the sealed `work_bindings` carry. `base_ref` is the mutable PR/merge target branch at the target. No existing adapter proves that `base_ref`'s current revision equals `candidate_base_sha` at effect time: `PR_CREATE`'s `base_ref` is a mutable branch that can move between seal and call, and the GitHub merge API's `sha` precondition is a CAS on the PR HEAD, never on the base branch.

| Effect | Material (TD v0.4 §6.4) | External-candidate binding rule |
|---|---|---|
| `GIT_PUSH` | `{repo_id, ref = refs/heads/cadp/candidate/<candidate_sha>, new_sha = candidate_sha, expected_old_sha = 0000…, bundle_cas_key}` | The proposer `put_blob`s a `git bundle` of the candidate; the PEP verifies the bundle reproduces **exactly** `candidate_sha` before pushing (TD v0.4 §6.6, §8.1). An external bundle is exactly as untrusted as a worker bundle was; the same verification makes it safe. The sealed request also binds `candidate_base_sha` as exact immutable input (rule below); the PEP's ancestry check runs against exactly that admitted `candidate_base_sha` (TD v0.4 §6.4) — bundle ancestry against the admitted base is target-state-independent and enforceable, so this effect's base discipline is complete as stated. |
| `PR_CREATE` | `{repo_id, base_ref, head_ref = refs/heads/cadp/candidate/<head_sha>, head_sha, title_cas_key, body_cas_key}` | `head_sha = candidate_sha`; write-once candidate ref shape enforced at admission (TD v0.4 §4.4 #14). The sealed request also binds `candidate_base_sha` as provenance (rule below). `base_ref` is the mutable target branch; this effect does not prove what revision it names at call time. |
| `PR_MERGE` | `{repo_id, pr_number, expected_head_sha, merge_method}` | `expected_head_sha = candidate_sha`; the target-native CAS rejects **head** drift only — GitHub's `sha` precondition is on the PR HEAD, never on the base branch. The sealed request also binds `candidate_base_sha` as provenance (rule below). |

For each of the three effects, `candidate_base_sha` and repository identity enter the sealed `EffectRequestV1` alongside `candidate_sha` as exact immutable bindings: `work_bindings` carries them as exact input identity + revision, covered by `request_digest` (Spec v0.5 K3), and equal by the §3.3 allocation-to-first-seal binding to the allocated values. This is the same exact-input discipline TD v0.4 §8.3 applies to the candidate subject in the development composition — equality over K4-bound sealed facts, decided by the evaluator; inequality = requirement unsatisfied, no K6 — extended to the base revision that composition already pins (worker workspace materialized at exactly `candidate_base_sha`, bundle ancestry checked against the admitted base; TD v0.4 §8.1, §6.4). What this binding proves is **provenance, not target state**: policy and reviewers evaluate against the pinned base the candidate was built and reviewed on; the binding does not — and no measured adapter can — pin the target branch's current revision at effect time. A policy that cares about the target's *current* base takes a fresh target observation (`base_ref` → current sha) into K4 as evidence and applies its drift rule there, evaluator-side (Spec v0.5 §2.4). Atomic exact-base-at-merge enforcement is a target adapter contract gap: `[UNMEASURED — probe required: no GitHub-native atomic base-branch CAS exists in the measured v0.4 adapter contract]`. Any ancestry rule (candidate descends from `candidate_base_sha`) is development-composition semantics per Spec v0.5 §7, evaluated by the evaluator over K4-bound facts — never new kernel vocabulary.

### 3.5 Re-homed unchanged

- **Broker push/PR actuation:** the credential-less bounded broker and PEP-held GitHub credential (TD v0.4 §4, §18.2) actuate; the proposer never touches a governed-target credential (§6).
- **Gate-file routing:** `touchesGateMachinery` (`cadp/product/gateFiles.ts`) applies to external candidates identically — a candidate touching kernel/policy/surface/conformance/constitutional-document paths routes to a `HUMAN_DECISION`, never a delegated agent merge.
- **Agent vs HUMAN merge decision:** the TD v0.4 §12 r9 `agent-surface` contract carries over — `AGENT_DECISION` satisfies only the merge gate, only for producers named in `delegated_merge_producers`, formed by a fresh isolated reviewer, honestly attributed. For an external candidate the carried-over r9 predicate is, and claims only, **proposer/reviewer separation**: a delegate that is, or shares an identity class with, the proposing `requester_ref` is refused. Proposer/reviewer separation is not implementer independence. Where the active policy additionally requires **implementer/reviewer independence**, that predicate evaluates against the full producer set established by `CANDIDATE_PROVENANCE` evidence (§4.2) — the reviewer must be distinct from *every* established producer, not merely one; when that evidence is absent, the independence requirement is unsatisfied and no K6 is created (Spec v0.5 §2.5).

## 4. Evidence submission

### 4.1 Ingress and provenance honesty

External evidence enters as `EvidenceEnvelopeV1` through `submit_evidence`, under the full TD v0.4 §9.1 ingress discipline: `producer_ref` stamped from the authenticated principal; `provenance.integrity` set by the Ingress; `source_relation` checked against the policy-bound adapter registry. The consequence for orchestrator-relayed evidence is mechanical: **when an orchestrator submits a review it ran (the P0 case: a codex review executed inside the Conductor loop), the envelope's producer is the orchestrator's principal and its relation is at most `SELF_REPORT` of the orchestrator** — unless the platform can independently verify the actual producer (a signature the Ingress verifies against `data.cadp.attestation_keys` → `SIGNED_ATTESTATION` under the true producer, or the producer submitting directly as its own registered principal). Self-report is never promoted (Spec v0.5 §4.5); an honest `SELF_REPORT` review is recorded, and simply does not satisfy a gate requiring independence.

### 4.2 What the reference policy accepts for external candidates

The candidate-sha subject-equality rules of TD v0.4 §8.3 (C41 leg 1) apply unchanged — they are composition semantics now (Spec v0.5 §2.4, §7): a required `REVIEW`/`VERIFICATION` envelope satisfies the requirement only if its bound `repo_id + candidate_sha` equals the exact candidate the sealed material names; inequality is requirement-unsatisfied, no K6.

**Candidate-producer provenance (`CANDIDATE_PROVENANCE`).** Proving reviewer ≠ proposer does not prove reviewer ≠ actual implementer: in the Conductor case the proposer is principal C while the actual coder is some agent X, and a reviewer R with R ≠ C proves nothing about R vs X. Spec v0.5's independence generalization requires separation from the producer(s) of the exact subject/material being approved, not from the requester. External candidates therefore carry actual candidate-producer provenance as an **ordinary evidence kind** — no new kernel primitive; a gate consumes it, so it is not orchestrator telemetry: a `CANDIDATE_PROVENANCE` `EvidenceEnvelopeV1` whose subject binds `{ repo_id, candidate_sha }` exactly and whose `producer_ref` is an actual candidate producer. A candidate may have **several** producers (co-authored material — e.g. one agent writes the change and another amends it before submission); each envelope establishes one producer, and the candidate's **producer set** is the union of every validly-established `CANDIDATE_PROVENANCE` producer over the exact `{ repo_id, candidate_sha }` subject — envelopes accumulate, they never replace or narrow the set. Each envelope's provenance must be authenticated/signed/independently-verifiable under the TD v0.4 §9.1 ingress discipline; an orchestrator-relayed claim of who produced the candidate is `SELF_REPORT` **of the orchestrator** and does not establish a producer — the same rule §4.1 applies to reviews. Every implementer/reviewer separation predicate in §3.5 and this section evaluates against **that producer set**: it is satisfied only if the reviewer is distinct from *every* producer in the set — a reviewer who is any established producer is reviewing their own material, and a co-producer's separate envelope naming someone else never launders that. The predicate is exactly as strong as the established set: an authenticated envelope that omits a co-producer is a false attestation accountable to its signer under §9.1, not a weakening of the predicate. When the evidence is absent and the policy requires implementer/reviewer independence, the requirement is unsatisfied and no K6 is created (Spec v0.5 §2.5).

**Per-effect evidence prerequisite matrix (normative).** Evidence can gate an effect only if it can exist before that effect: a GitHub Actions verification exists only after the candidate ref is pushed, so it cannot gate `GIT_PUSH`; a GitHub-native PR review exists only after the PR exists, so it cannot gate `PR_CREATE`. The reference policy gates per effect:

| Effect | Evidence the reference policy requires |
|---|---|
| `GIT_PUSH` | Only evidence obtainable pre-push: `CANDIDATE_PROVENANCE` (above), and any policy-required pre-push `REVIEW` by a registered principal over the submitted bundle/candidate content. |
| `PR_CREATE` | May additionally require: the `GIT_PUSH` outcome `COMMITTED`, and a `PRESENT` `VERIFICATION` from `verifier:github-actions` bound to the exact pushed `candidate_sha` with `claim.conclusion == "success"`, `TARGET_AUTHORITY_OBSERVATION`, source-authoritative `produced_at` (TD v0.4 §18.3 fail-closed projection, unchanged; this producer observes the pushed ref at the target, so it is independent of whoever made the candidate by construction). |
| `PR_MERGE` | May additionally require: PR-created facts; a GitHub-native review read via API (subject = `commit_id`, compared by the evaluator) or a platform review of the pushed ref, satisfying the implementer/reviewer independence predicate above (an orchestrator-relayed review only under the §4.1 verification paths — as bare relay it is `SELF_REPORT` and does not satisfy); and `HUMAN_DECISION` (TD v0.4 §9.3 path A) or delegated `AGENT_DECISION` per §3.5. |

General rule: a policy that requires, for effect E, evidence whose producing precondition is E itself (or a later effect) is unsatisfiable and MUST be rejected at policy-authoring time.

### 4.3 Fail-closed default

Absent, stale, subject-mismatched, or `UNKNOWN` required evidence admits nothing (Spec v0.5 §2.5, §4.5). There is no "external candidates get a lighter gate" mode: an external candidate passes the same evaluator, the same fresh recheck, and the same gate-file routing as an internal one, or it does not pass.

## 5. Explicit non-enrollment in the run profile

### 5.1 Measured facts (P0, run `24919dde`, 2026-09-07)

Conductor's run receipts are local-file grade: an `events.jsonl` under `TMPDIR`, keyed by an 8-hex `run_id`; the run record is **deleted on normal completion**; a checkpoint is written only on failure by default.

### 5.2 The refusal

Run-scope validity grades by the K7 outcome of a `WORK_START` effect (Spec v0.5 §5.2): `COMMITTED` requires a target-authoritative receipt binding the exact effect (the measured v0.4 rule: a describe-read returning a memo matching `cadp_effect_id` and `cadp_args_digest` — TD v0.4 §6.4, C34). A TMPDIR file deleted on success, keyed by a local 8-hex identifier, cannot be that receipt: there is no target-authoritative `WORK_START` outcome to grade a Conductor run scope by K7, and after a normal completion there is no receipt at all. **Therefore the reference deployment enrolls no Conductor principal in the run profile. Conductor runs claim per-effect Kernel Conformance only — never the run profile.** This is a measured refusal, not a policy preference, and it is complete governance, not degraded governance: per-effect Kernel Conformance is the whole constitutional guarantee (Spec v0.5 §5).

Non-enrollment is symmetric and policy-bound (Spec v0.5 §5.1): the active policy simply does not name any Conductor principal among the enrolled `requester_ref`s, and the reference policy reserves run-scope binding for enrolled principals — a non-enrolled principal **cannot acquire run-profile semantics by presenting a `work_run_ref`**. What non-enrollment costs is stated, not hidden: no `MAX_EFFECTS_IN_WORK_RUN`, no `WORK_STEP` chain requirements, no bound-stop semantics for these runs.

### 5.3 Revisit conditions

Enrollment could be revisited only on new measurement: `[UNMEASURED — probe required: a target-authoritative run receipt from the orchestrator — durable across normal completion, correlatable to a Platform-sealed WORK_START effect_id by a target-returned binding (memo-equivalent), and readable by the Reconciler after restart. Absent all three properties, K7 grading of a Conductor run scope remains impossible and non-enrollment stands.]`

## 6. Credential custody at the client (measured)

P0 measured that a Conductor `working_dir` is **not a sandbox**, and that `claude-agent-sdk` loads the working directory's settings as a trust boundary. The consequence is the Spec v0.5 §2.3 rule with no softening: **no governed-target credential may exist anywhere an orchestrator's working directory or settings can reach.** Credential custody stays entirely PEP/broker-side (TD v0.4 §4.1, §18.2: the GitHub credential is PEP-held; the broker is credential-less toward the kernel; workers cannot `admit_and_dispatch` — matrix reach notwithstanding, the worker class cannot even seal requests). The only CADP/governed-effect credential an effect-proposer environment holds is its own Kernel API principal identity, which grants no effect authority by §3.2. A deployment that places a governed-target token in a Conductor working directory has left Kernel Conformance for every effect that token can reach, whatever this document says.

## 7. Conformance controls (falsification additions)

In the Spec v0.5 §9 spirit — proven by attempting the violation:

1. **Replay convergence:** the same external principal re-calling `allocate_effect_id` with the same `cadp.allocation-key.external.v1` tuple receives the same `effect_id`; the target shows one push, one PR (counted at the target, TD v0.4 §13 method).
2. **Identity-squatting refusal:** a different principal submitting the same tuple receives a different `effect_id` and cannot conflict the first principal's request.
3. **Relayed-review honesty:** an orchestrator-relayed review seals as `SELF_REPORT` of the orchestrator principal and a gate requiring independent review DENYs; the same review submitted by the reviewer's own registered principal (or attested per §4.1) admits.
4. **Subject inequality:** review/verification bound to candidate A does not admit an effect naming candidate B (C41 leg 1 rerun against the external client).
5. **Opt-in refusal:** a non-enrolled principal's request carrying a fabricated `work_run_ref` is refused (Spec v0.5 §9.2 negative control, external edition).
6. **Gate-file guard:** an external candidate touching a `GATE_PATH_RULES` path cannot be merged by `AGENT_DECISION`.
7. **First-seal candidate binding:** an `effect_id` allocated for candidate A whose first `seal_effect_request` names candidate B is REFUSED — no `EffectRequestV1` sealed, no effect (§3.3 allocation-to-first-seal binding).
8. **First-seal base binding:** an `effect_id` allocated with `candidate_base_sha` X whose first seal names base Y is REFUSED.
9. **First-seal purpose binding:** an `effect_id` allocated with purpose `PR_CREATE` whose seal names operation `PR_MERGE` is REFUSED.
10. **First-seal principal binding:** principal B first-sealing an `effect_id` allocated to principal A is REFUSED.
11. **Co-producer review refusal:** a candidate whose established `CANDIDATE_PROVENANCE` producer set is `{X, Y}` receives a review produced by Y (distinct from the proposer and from X); a gate requiring implementer/reviewer independence DENYs — the predicate evaluates against every established producer, not just one (§4.2).
12. **Unsatisfiable-cycle refusal:** a policy that requires, for `GIT_PUSH`, the `verifier:github-actions` `VERIFICATION` of the pushed candidate — evidence whose producing precondition is the `GIT_PUSH` itself (§4.2 general rule) — is rejected at policy-authoring time; the deployment refuses to activate it.

## Appendix — anchors used

| Rule here | Anchor |
|---|---|
| Effect client is the whole mandatory integration | Spec v0.5 §4.1; Design D4, D6 |
| Equal citizens at the effect boundary | Spec v0.5 §4.2; Design D1.1 |
| Platform-sealed effect identity | Spec v0.5 K3; TD v0.4 §2.2, §7.4 (tuple discipline) |
| `candidate_base_sha` exact binding in identity tuple and sealed material | Spec v0.5 K3 (one `effect_id` = one `request_digest`); TD v0.4 §8.3 (exact-binding discipline), §8.1, §6.4 (base pinning in the development composition) |
| Allocation-to-first-seal binding (pre-K3 window); internal `AllocationBinding`, no K8 | Spec v0.5 K3 (conflict rule presupposes an existing sealed `request_digest`); §3.3 |
| Target-base drift as fresh K4 observation; no atomic base-branch CAS | Spec v0.5 §2.4; `[UNMEASURED]` marker in §3.4 |
| `CANDIDATE_PROVENANCE` as ordinary evidence; independence vs the full established producer set | Spec v0.5 §2.5, §4.5; TD v0.4 §9.1 (ingress discipline, no promoted self-report) |
| Per-effect evidence prerequisite matrix; unsatisfiable-cycle refusal | Spec v0.5 §2.4, §2.5; §4.2 general rule |
| GitHub adapter materials/proofs unchanged | TD v0.4 §6.4, §6.6 |
| Bundle-reproduces-candidate verification | TD v0.4 §8.1, §6.6 |
| Gate-file routing; delegated merge | `cadp/product/gateFiles.ts`; TD v0.4 §12 r9 |
| Producer stamping; registry-bound provenance | TD v0.4 §9.1 |
| Candidate-sha subject equality as composition semantics | TD v0.4 §8.3 (C41 leg 1), §18.3; Spec v0.5 §2.4, §7 |
| Run scope grades by K7; enrollment policy-bound | Spec v0.5 §5.1–5.3; TD v0.4 §6.4 (C34) |
| Credential custody without carve-out | Spec v0.5 §2.3, §6; TD v0.4 §4.1, §18.2 |
| P0 measured facts (Conductor receipts, working_dir, CONDUCTOR_RUN_ID) | owner-run Conductor probe, run `24919dde`, 2026-09-07 |
