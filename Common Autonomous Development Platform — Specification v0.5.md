# Common Autonomous Development Platform — Specification v0.5

How a workload worked is its orchestrator's business; the moment it changes the external world, it is CADP's business.

| Field | Value |
|---|---|
| Status | **SPECIFICATION CANDIDATE while unmerged; SPECIFICATION BASELINE upon Human-approved canonical merge** |
| Authored from | `DESIGN_cadp_v0_5_generation.md` (below: Design) at this checkout |
| Grounding corpus | `Common Autonomous Development Platform — Specification v0.4.md` (below: Spec v0.4) and `TECHNICAL_DESIGN_cadp_v0_4_generation.md` (below: TD) |
| Succession | Upon Human-approved canonical merge, v0.5 becomes the Specification authority of the v0.5 generation. Spec v0.4 remains the valid record of the v0.4 generation and is not edited (§10; Design D6). |
| Scope | Constitutional authority boundary (K1–K7), three-plane architecture, run composition profile, execution-plane product contract, reference-composition boundary |
| Non-scope | Technical Design, implementation language, storage, policy engine or workflow product selection, production implementation |

Probe rule: the measurement-first discipline of TD §17.2 applies to this Specification itself. Any capability claim below that is not backed by a corpus measurement carries an explicit `[UNMEASURED — probe required]` marker (Design, Status preamble).

---

## 1. Purpose and generation thesis

v0.5 organizes the platform as **three control planes connected only by API contracts** (Design D1). No plane imports another's types.

```text
Workflow Plane   — replaceable commodity orchestrator (roles, routing, retry,
                   checkpoint, context, DAG). Never authority. (§4)
Execution Plane  — optional CADP product service (surface broker, provider
                   adapters, executor profiles, isolation). Never authority. (§6)
Authority Plane  — the only constitutional territory: K1–K7, exact binding,
                   evidence semantics, credential custody, admission,
                   PEP-only actuation, effect identity, reconciliation. (§2–§3)
```

Everything mandatory in v0.5 lives in the Authority Plane; everything else is a product or a commodity (Design D1.3). This narrowing is the structural lesson of the withdrawn Conductor integration (Design D0): constitutionalizing another product's runtime makes CADP's surface grow with every orchestrator feature. The correction is to narrow CADP to the authority/effect boundary and make every orchestrator a pure client of it.

The kernel is unchanged: Kernel Conformance (K1–K7; Spec v0.4 §8.1, §13.1–13.3) is the complete v0.5 core. No kernel primitive is added, removed, or altered (Design D2). Where this document restates v0.4 kernel semantics, it restates them faithfully; where it generalizes, the generalization is core-level principle, never new vocabulary.

---

## 2. Authority Plane — constitutional invariants

These invariants carry forward from Spec v0.4 §2 unchanged, with the v0.5 core-level generalizations of Design D1.2, D4 and D5 integrated where marked.

### 2.1 Proposal and authority

The output of a model, agent, workflow, reviewer, Human, or any other producer is never, by itself, external-effect authority.

```text
Untrusted or bounded producer requests.
Policy evaluates.
Enforcement Point admits.
Narrow capability performs.
Authoritative source reconciles.
```

A Human decision is attributable evidence that policy may require; Human identity alone is never reused for unrelated effects and never bypasses the enforcement point. Genesis trust anchors and explicit break-glass authority follow the bootstrap rules of §2.9.

### 2.2 Policy and enforcement

Policy language and evaluator may own decision computation, but `policy ALLOW ≠ external effect authority`. An actual external effect is permitted only when the Policy Enforcement Point (PEP) freshly verifies the exact decision/effect binding and releases or directly uses a bounded capability (Spec v0.4 §2.2).

### 2.3 Credential reach — and no permanent exemption

No standing credential, token, session, or alternate mutation path capable of creating a governed effect may exist in a worker, model, reviewer, verifier, or workflow payload. If a deployment cannot prove this exclusive reach, it cannot claim enforced admission for that effect, and any policy requiring enforcement fails closed. Prompt instructions, role labels, sandbox names, and worker self-report are not credential-isolation evidence (Spec v0.4 §2.3).

v0.5 states the general form without carve-out (Design D1.2): **any credential able to create a governed effect lives inside the enforcing boundary. No credential KIND is permanently exempt.** Only concrete credentials that provably cannot reach a governed effect under the active policy sit outside the boundary, and that status is a deployment-policy fact that dissolves the moment policy reclassifies the operations the credential can reach.

### 2.4 Exact binding and the general evidence relation

The following are bound by immutable identity and digest, never by inference or display label: effective policy identity/revision/content; observed work/input identity and mutable revision or content digest; requested effect target, operation kind, and material parameters; required evidence identity, subject, producer, provenance, integrity, and freshness; required Human or machine decision provenance and scope; backend-reported actual execution/observation identity and availability. A mutable subject without its required revision/digest cannot be claimed exact or fresh (Spec v0.4 §2.4).

**General evidence-relation principle (CORE — Design D4):** evidence that policy requires for an effect MUST bind to exact immutable subjects, and the policy MUST explicitly verify the required relation between each evidence subject and the effect material. The core states only this. Subject-equality rules for particular domains — e.g. the development rule that `REVIEW`/`VERIFICATION` evidence bound to a `candidate_sha` is compared against the material's candidate (TD §8.3; TD §18.3) — are composition semantics and live in reference compositions (§7), never in the core.

### 2.5 Fail closed — and effect classification

If a required fact is missing, stale, contradictory, unverifiable, or `UNKNOWN`, the evaluator and PEP do not treat the requirement as satisfied. Policy may state which provenance or `UNKNOWN` it tolerates for low-risk effects, but the Platform never promotes an unavailable fact to an observed value and never fabricates assurance to pass policy (Spec v0.4 §2.5).

**Effect classification (Design D4):** semantically non-effecting operations are outside effect admission — but **nothing establishes purity by name**. A tool name, an HTTP method, or a claimed read-only mode never proves an operation non-effecting (measured: a plan mode that blocked the `write` tool still executed terminal commands — TD §17.2 container probe). Classification is a policy-bound declaration per operation against the target adapter's contract, and v0.5 applies this section's fail-closed principle to it: **an operation's effect classification is a required fact, and an unclassified operation defaults to effecting.**

### 2.6 Sealed history, not desired state

Conversations, prompt history, process memory, and workflow-local transient state are not constitutional authority. Policy decisions, effect admissions, evidence references, and effect outcomes are durable records verifiable with the same meaning after restart (Spec v0.4 §2.6).

The constitutional store is **sealed history** (Design D5): K1–K7 rows are append-only sealed facts consumed by gates. There is no mutable desired-state store whose latest value is authority, and "latest" lookups at dispatch are forbidden (TD §6.6).

### 2.7 No silent substitution

If the policy, work revision, effect material, target, evidence, reviewer, Human decision, or backend observation changes, an existing decision/admission is never silently reused. New material input requires new evaluation (Spec v0.4 §2.7).

### 2.8 Epistemic reconciliation, not convergence

CADP reconciliation is **epistemic**: it resolves `UNKNOWN` outcomes only by target-authoritative reads. Blind retry is forbidden (§3, K7 rules; §5.1). The reconciler never dispatches (TD §6.5). Reconciliation is never a level-triggered convergence engine driving the world toward a desired state; the discipline is exactly-once-with-proof (Design D5).

### 2.9 Constitution lifecycle and bootstrap

Carried forward from Spec v0.4 §9 unchanged:

- **Genesis.** The first `PolicyRefV1`, trusted issuer, and PEP credential placement are installed out-of-band by deployment root authority, recorded attributably and immutably, and never generated by agent/model inference.
- **Policy change.** Policy content is never mutated in place; a new revision and digest are issued. Post-genesis activation happens only via (1) a governed effect admitting the exact new `PolicyRefV1` under current policy, (2) a scoped Human/root decision defined by current policy, or (3) emergency break-glass with durable evidence of identity, reason, scope, and prior/new policy refs. Break-glass never rewrites past outcomes/evidence and is not an ordinary worker capability.
- **In-flight decisions.** A policy revision change is never silently applied: before admission, a divergence between active policy and decision policy requires new evaluation; after admission, recovery of the exact admitted effect follows the frozen admission while new effects follow current policy; explicit revocation/stop rules are applied by the PEP before dispatch.

---

## 3. Constitutional vocabulary — K1–K7

The seven semantic records below are the complete and exact primitives of the v0.5 kernel, unchanged from Spec v0.4 §4. They do not require seven services or seven tables; they may share storage, but field meaning and authority are never merged. All digests carry `{ algorithm, canonicalization, value }` under a policy-approved versioned scheme; digests under different schemes are never treated as the same content identity. Field lists below are summarized; the rules are normative and complete.

### K1. `PolicyRefV1` — immutable policy identity

Fields: `policy_id`, `revision`, `content_digest`, `issuer_ref`.

- A policy revision is immutable. A mutable alias alone never admits an effect.
- Evaluator implementation/version is recorded separately in decision provenance and never substitutes for policy identity.
- Activation follows §2.9.

### K2. `EvidenceEnvelopeV1` — exact, honest evidence

Fields: `evidence_id`, `evidence_kind`, `subject_bindings[]` (authority_ref, namespace, object_id, optional revision/content_digest), `availability: PRESENT | UNKNOWN`, `claim_schema`, `claim?`/`claim_digest?` (PRESENT only), `unknown_reason?` (required when UNKNOWN), `producer_ref`, `source_ref`, `produced_at`, `provenance { source_relation: SELF_REPORT | INDEPENDENT_OBSERVATION | TARGET_AUTHORITY_OBSERVATION; integrity: UNATTESTED | AUTHENTICATED_SOURCE | SIGNED_ATTESTATION; attestation_ref? }`, `envelope_digest`.

- `evidence_kind` can express backend observation, verification, review, Human decision, machine decision, or reconciliation claims. Claim payloads keep their domain/backend-native schema; the envelope never flattens meanings or invents equivalence between different backends' claims.
- A requested value is never copied into a claim unless the source actually emitted/attested it.
- `UNKNOWN` is an honest observation of absence of value: `claim`/`claim_digest` are forbidden, `unknown_reason` and source provenance are required. An ordinary lookup miss or unavailable read is never a universal absence proof; a genuinely authoritative absence proof is itself recorded as a `PRESENT` claim.
- Assurance is not a total order or universal trust score. Policy checks required `source_relation`, `integrity`, producer independence, and subject binding each on their own.
- Review evidence (candidate identity, reviewer identity, verdict/body integrity, freshness) uses this same contract; there is no separate Auditor authority primitive. Human decisions are envelopes with `evidence_kind = HUMAN_DECISION` and require exact subject/effect scope, attributable producer, issued time, decision body, and integrity.

### K3. `EffectRequestV1` — sealed effect intent

Fields: `effect_id`, `requester_ref`, `work_bindings[]`, `target_ref { authority_ref, target_type, target_id }`, `operation_kind`, `material_schema`, `material_digest`, `material_ref?`, `prior_effect_refs[]`, `requested_at`, `request_digest`.

- `effect_id` is a stable logical-effect identity allocated **before** any non-trivial external call, by Platform-controlled effect ingress or the PEP. A model/worker-proposed correlation string is not identity authority; the Platform must seal it into a unique identity for it to be used in an accepted request.
- One `effect_id` has exactly one `request_digest`. Reuse with different bytes/material/target is a conflict and performs no effect.
- A target-native idempotency key, when present, is deterministically bound to `effect_id` and never replaces the Platform record.
- Material may be content-addressed; the PEP verifies that the actual dispatched bytes match `material_digest`.
- `prior_effect_refs` explicitly surfaces compensation, replacement, or unresolved-prior relations; they are never hidden from policy input.

### K4. `AdmissionInputV1` — complete decision input

Fields: `policy_ref`, `effect_request_ref`, `effect_request_digest`, `evidence_refs[] { evidence_id, envelope_digest }`, `assembled_at`, `input_digest`.

- The complete canonical binding of material input handed to the evaluator. Display text or mutable URLs are never sufficient references.
- Every policy-required Human decision, review, verification, backend actual identity, and target observation appears in `evidence_refs`.
- The PEP never back-fills facts the evaluator did not see. A material change requires a new `AdmissionInputV1` and a new evaluation.

### K5. `PolicyDecisionV1` — bound decision

Fields: `decision_id`, `policy_ref`, `admission_input_digest`, `outcome: ALLOW | DENY | REQUIRE_EVIDENCE`, `reason_codes[]`, `constraints[]`, `evaluator { evaluator_ref, evaluator_version, integrity_ref }`, `decided_at`, `not_after?`, `decision_digest`.

- A decision applies only to its exact `AdmissionInputV1`. `ALLOW` is not a permit or credential.
- The PEP verifies the selected evaluator and its `integrity_ref` over an authenticated local channel or verifiable attestation. A worker-submitted decision-shaped document is not an evaluator decision.
- Evaluator error, unknown policy revision, or malformed output is never `ALLOW`.
- `REQUIRE_EVIDENCE` defines no UI or pending lifecycle; commodity workflow gathers the evidence and requests a fresh evaluation.
- Constraints are used in admission only when the PEP understands and can enforce them; an unsupported constraint fails closed.

### K6. `EffectAdmissionV1` — durable pre-effect authority

Fields: `admission_id`, `effect_id`, `dispatch_ordinal`, `prior_admission_ref?`, `effect_request_digest`, `policy_decision_ref`/`digest`, `admission_input_digest`, `pep_ref`, `bounded_capability { target_ref, operation_kind, material_digest, single_dispatch: true, expires_at? }`, `admitted_at`, `admission_digest`.

- Created only against a valid `PolicyDecisionV1` whose `outcome` is `ALLOW` for the exact `admission_input_digest` the admission binds. A `DENY` or `REQUIRE_EVIDENCE` outcome, an absent or unverifiable decision, or a decision bound to a different input never admits: the PEP refuses the effect and releases no capability (Spec v0.4 §2 rule 2, §5.1 steps 4–6). `ALLOW` is necessary for admission, never sufficient (K5).
- Created only after the PEP re-verifies, at commit time against current durable facts: binding, policy validity, evidence freshness, credential reach, and prior effect state (§5.2 recheck list).
- The PEP must prove that the held credential/session's **actual** target account/tenant/repository/endpoint matches `target_ref`; caller-requested target text is not actual-target proof.
- `EffectAdmissionV1` is durably recorded **before** any external call or mutating-credential release. The admission record and the pre-effect intent are the same semantic record; no separate workflow `INTENT` state machine is required.
- The bounded capability is valid for one transport dispatch of one exact logical effect/target/material. General-purpose standing credentials are never handed to workers.
- `(effect_id, dispatch_ordinal)` reservation and the admission write are atomic; exactly one concurrent writer per ordinal succeeds.
- All admissions of one `effect_id` share one `effect_request_digest`. The next ordinal is created only after a fresh recheck and only when the prior dispatch is `NO_EFFECT_CONFIRMED` or target-native idempotency provably guarantees the same logical effect. With an inconclusive prior admission and no such idempotency proof, no new admission may be created.
- Replay may look up and reconcile existing admissions/outcomes but never re-consumes a bounded capability and never creates a new logical effect.

### K7. `EffectOutcomeV1` — target-authoritative truth

Fields: `outcome_id`, `effect_id`, `admission_digest`, `result: COMMITTED | NO_EFFECT_CONFIRMED | UNKNOWN`, `target_ref`, `target_operation_ref?`, `evidence_ref`, `observed_at`, `observer_ref`, `outcome_digest`.

- Outcomes are append-only observations. A past `UNKNOWN` is never deleted or rewritten as no-effect.
- `COMMITTED` requires a target-authoritative receipt (or a policy-approved equivalent authoritative observation) that the target accepted/applied the exact effect.
- `NO_EFFECT_CONFIRMED` requires target-authoritative proof that no external effect of this `effect_id` occurred.
- Transient 404s, eventual-consistency misses, timeouts, unavailable reads, parse failures, and correlation failure are `UNKNOWN`, never `NO_EFFECT_CONFIRMED`. If the target cannot provide authoritative reconciliation, an ambiguous call stays `UNKNOWN`.

---

## 4. The effect boundary and the Workflow Plane

### 4.1 The only mandatory workflow contract

Mutation intents arrive as `EffectRequestV1` through an effect client. This is the **whole** mandatory integration between any workflow plane and CADP (Design D4). The Workflow Plane — any replaceable commodity orchestrator owning roles, routing, retry, checkpoint, context, and the DAG — is never authority: its history and events are never read as authority; kernel rows are (Spec v0.4 §2.6; TD §7.1). The reference workflow product for v0.5 is Microsoft Conductor `[UNMEASURED — probe required: no container or API probe of Conductor exists in this corpus; the measured v0.4 reference orchestrator is Temporal (TD §6.4, §7), and Conductor becomes the reference only after equivalent probes — start-receipt provenance, replay-idempotent step submission, memo-equivalent binding]` (Design D1.1).

### 4.2 Two qualifications, deliberately asymmetric

- **Effect boundary / Kernel Conformance:** anything that proposes effects qualifies. A workflow, a cron job, and a human at a terminal are equal citizens at the effect boundary, and each can claim Kernel Conformance if — and only if — it satisfies K1–K7 exactly (Spec v0.4 §8.1: a Human-operated tool or manual effect gateway reaches Kernel Conformance only, never the autonomous-work claim).
- **Run profile (§5):** NOTHING qualifies automatically. Run-profile participation is a separate enrolled fact declared by the active policy — never a property a requester acquires by being an orchestrator or sheds by not being one (Design D1.1).

### 4.3 Admission protocol

The positive path, unchanged from Spec v0.4 §5.1:

```text
1. Workflow/worker proposes material; Platform effect ingress allocates
   effect_id and seals EffectRequestV1.
2. Evidence sources emit exact EvidenceEnvelopeV1 records.
3. Platform assembles AdmissionInputV1 under one PolicyRefV1.
4. Policy evaluator emits PolicyDecisionV1.
5. PEP fresh-rechecks exact binding and exclusive credential reach.
6. PEP durably records EffectAdmissionV1 before capability release/call.
7. PEP or its bounded target adapter performs the exact effect.
8. Target-authoritative observation emits EffectOutcomeV1.
```

Steps 5–7 are the constitutional effect gate; workflow success, agent completion, test PASS, review APPROVE, or policy `ALLOW` never skips it.

**Commit-time fresh recheck (Spec v0.4 §5.2).** Immediately before admission the PEP re-verifies at minimum: the active `PolicyRefV1` is the exact revision/content bound to the decision; the bound decision's `outcome` is `ALLOW` (K6); decision/input/request digests mutually match; no mutable work/input/target revision drifted since evidence and decision; required evidence is bound to the exact subject and fresh; Human/machine decisions are bound to the exact effect scope and not already consumed; the decision is unexpired and unrevoked; the same effect identity is not used with a different request; no prior `UNKNOWN` or conflicting committed effect is hidden; no alternate governed-effect credential path exists in the worker or any component; the PEP-held credential's actual target identity matches `target_ref`; and the PEP can actually enforce the policy constraints. Any unproven item means no `EffectAdmissionV1` and no capability release.

**Human and delegated machine decisions (Spec v0.4 §5.3, §5.3a).** A policy-required Human judgment enters as an `EvidenceEnvelopeV1` with attributable identity, exact work/effect subject binding, explicit decision body and scope, issued time and policy-required freshness, authenticated or attested provenance, and no cross-effect reuse. Idempotent recovery of the same `effect_id` may reference the same scoped decision; a different `effect_id`, changed material, changed target, or changed work revision requires a new decision and evaluation. A Human may explicitly delegate a policy-named gate to a machine agent: the decision is honestly attributed as a machine decision (never disguised as Human), delegation is per-deployment opt-in to exact policy-allowed producers, the producer must be independent of that work run's implementer/orchestrator (no self-approval), constitutional/root operations are never delegable, and machine decisions satisfy the same scope/freshness/no-reuse rules.

**Review and verification (Spec v0.4 §5.4).** Verification and review are envelope producers. A PASS/APPROVE label alone is insufficient: the immutable identity of the exact candidate/input/artifact/material executed or reviewed is required; a dirty workspace, mutable head, changed artifact, or stale review fails exact subject binding. Policy-required reviewer independence is proven by producer-identity separation; self-assertion stays honestly `SELF_REPORT` and is never promoted; reviewers, verifiers, and CI never hold credentials that bypass the governed effect path.

**Execution provenance (v0.5 strengthening — Design D4).** Where policy requires execution provenance for an effect, it compares the sealed material's artifact against the execution evidence's bound `output_artifact_digest` — never inferring production from K4 inclusion alone. Decision-input inclusion proves the decision *saw* the envelope, not that the execution *produced* the artifact. (The v0.4 reference policy checks only presence and surface-role on backend-execution evidence — TD §19.2, §19.5; the output binding is new in v0.5 and depends on the §6 capture probe.)

### 4.4 Ambiguity, retry, and restart

Carried forward from Spec v0.4 §6 unchanged:

- **No blind retry.** An external call without an authoritatively correlatable receipt is `UNKNOWN`. `UNKNOWN` is never treated as an ordinary retryable failure. Re-dispatch of the same effect is permitted only when (1) the PEP can enforce that target-native idempotency yields one logical effect for the same `effect_id`, or (2) target-authoritative observation returned `NO_EFFECT_CONFIRMED`. Otherwise automatic retry stops and the effect waits for reconciliation or a policy-governed exception.
- **New effect after `UNKNOWN`.** Re-attempting or compensating the same semantic goal uses a new `effect_id`, includes the prior effect and outcome in `prior_effect_refs` and evidence, never hides duplicate/compensation risk from policy input, obtains a fresh scoped Human decision where policy requires one, and never converts the old `UNKNOWN` into `NO_EFFECT_CONFIRMED`.
- **Restart.** After restart, authority is reconstructed from durable records and target observation, never process memory: no `EffectAdmissionV1` → no inference that a capability was released, fresh evaluation required; admission + `COMMITTED` → no re-dispatch, use the committed result; admission + `NO_EFFECT_CONFIRMED` → next dispatch admission possible after fresh recheck; admission without conclusive outcome → reconcile, else `UNKNOWN`, and no next dispatch without proven same-effect idempotency. A workflow product's own retry/history never substitutes for this authority.
- **Conflict and corruption** are fail-closed safety events: multiple request digests for one `effect_id`; an observed committed governed effect without admission; material mismatch between admission and target receipt; evidence digest or subject-binding corruption; alternate credential use outside the PEP; unexplainable contradiction between target outcomes. The Platform never normalizes these into success/failure; it records durable incident evidence and halts new side effects in the affected scope.

### 4.5 Evidence trust and backend neutrality

Carried forward from Spec v0.4 §7 unchanged. The envelope is neutral transport, not neutralized meaning: it never translates backend-native claims into universal capabilities, copies requested configuration into observed actual identity, promotes self-report to independent observation or attestation, invents cross-vendor equivalence, or substitutes defaults for `UNKNOWN`. Requested runtime/model/version values are request/policy input only; actual values are `PRESENT` claims only when the backend actually emitted them, else `availability = UNKNOWN`. Policy may independently require, per evidence item: accepted producer/source identity, exact run/work/effect binding, maximum age or revision freshness, source relation, integrity mechanism, producer independence, and target-authoritative observation — and fails closed when no backend can provide the required assurance. There is no trust-equivalence table and no universal numeric trust score. Missing evidence and `UNKNOWN` envelopes are both honest, and neither satisfies a required `PRESENT` fact.

---

## 5. The run profile — an optional composition profile

v0.4's Autonomous-Work Product Conformance (Spec v0.4 §8.2) is demoted from a peer conformance layer to an optional **composition profile**: the run profile (Design D2). It is composition, not product identity — no product qualifies for it automatically, and no deployment needs it to be kernel-conformant.

A profile-less deployment is governed per-effect only, and explicitly loses run bounds and every step-evidence-dependent gate: no `MAX_EFFECTS_IN_WORK_RUN`, no `WORK_STEP` chain requirements, no bound-stop semantics. That loss is stated, not hidden: per-effect governance is complete Kernel Conformance, not degraded run governance.

### 5.1 Enforceable enrollment

Whether a requester is subject to the run profile is a **policy-bound deployment fact**: the active policy declares which exact requester principals (`requester_ref`, stamped from the authenticated caller — TD §9.1) are run-profiled. Self-declaration is excluded in both directions: a requester cannot opt out by omitting a binding and cannot opt in by inventing one.

For an enrolled principal, every `EffectRequestV1` MUST carry the work-run binding, and an unbound effect is **REFUSED**, not merely uncounted. This strengthening is load-bearing: in v0.4, `MAX_EFFECTS_IN_WORK_RUN` counted only requests whose `work_bindings` included `work_run_ref` (TD §5.4, §7.3), so an unbound request escaped the count; under v0.5 enrollment it cannot be admitted at all.

### 5.2 Run scope validity

`work_run_ref` remains authority-issued: it IS the admitted `WORK_START` effect_id (TD §7.4). A run scope's validity grades by the **K7 outcome** of the `WORK_START` effect, not by K6 alone — K6 records that the PEP created authority to dispatch; the truth of the effect is K7:

- a `COMMITTED` `WORK_START` effect_id is a valid run scope;
- an `UNKNOWN` one is **unusable until reconciliation resolves it** — no blind retry, no optimistic use (§4.4);
- a `NO_EFFECT_CONFIRMED` one is **refused**.

(The measured v0.4 grounding: the reference `WORK_START` adapter reaches `COMMITTED` only when a target-authoritative describe returns a memo matching `cadp_effect_id` and `cadp_args_digest`; the start response alone never yields `COMMITTED` — TD §6.4; conformance C34.)

### 5.3 Run membership

Distinct from scope validity: an enrolled requester MUST present an **authenticated run scope proving that THIS request belongs to that exact `work_run_ref`**. Possession or knowledge of another valid run identifier is never sufficient — a stable principal serving many concurrent runs could otherwise attach a drained run's work to a fresh run's budget, and `max_effects` would stop being a constitutional guarantee.

This Specification locks ONLY the invariant — *a requester cannot self-select or borrow another valid run scope* — and delegates the mechanism to the Technical Design, which must choose one (a run capability minted at `COMMITTED` `WORK_START` dispatch, a per-run principal, or another authenticated channel) and prove it under falsification obligations in the spirit of §9. `[UNMEASURED — probe required: no such mechanism exists or has been probed in the v0.4 corpus; today the binding is caller-asserted content of work_bindings.]`

### 5.4 Bisection of run mechanics (Design D3)

- **Workflow durability — orchestrator business, outside constitutional text:** step ordinal, DAG, retry, checkpoint, `WORK_STEP` chaining and replay-idempotent step ingress, and `max_steps` (v0.4 already concedes the kernel does not count steps — TD §7.3).
- **Authority — kernel/policy business inside the run profile:** the authority-issued `work_run_ref` binding, enrolled-principal run-scoped admission with membership proof, and `max_effects` counting.

`WORK_STEP` evidence does not vanish — a deployment's policy may still require it — but its chaining mechanics are Workflow Plane product contract, consumed by the Authority Plane only as ordinary K2 envelopes.

---

## 6. The Execution Plane — optional product service

The Execution Plane (surface broker, provider adapters, executor profiles, isolation postures, session scanning — TD §17, §19) is a CADP product service with a declarative contract. It is **not part of the authority boundary and optional per deployment**: a deployment that runs its workers some other way loses nothing constitutional, only the reference execution-evidence producers (Design D1.2).

The contract is **symmetric and output-bound**:

- `ExecutionRequest` carries the executor profile, the provider, and the exact input digests.
- `ExecutionResult` carries an exact `output_artifact_digest`, and the execution evidence (the `BACKEND_EXECUTION`-successor envelope) binds that digest as a subject. `[UNMEASURED — probe required: v0.4's measured scan (TD §17.2, §19.3) captures model/effort/run identity from session logs; no probe has yet captured an output artifact digest from a live surface, so the capture mechanics are a v0.5 TD measurement item.]`

**Provider-credential custody** is the Execution Plane's internal discipline, subject to §2.3 without carve-out. In the reference deployment, provider subscriptions are not mutation credentials for any current governed domain target (measured: TD §17.3 injects exactly one provider's auth into an isolated container; TD §18.2 keeps the read credential host-side) — but this is a deployment-policy fact, never a universal exemption. A deployment whose policy classifies provider invocation itself as a governed effect (spend caps, data-egress control, model-access governance) thereby brings provider credentials under the full Authority Plane custody rules. No credential kind is permanently exempt (§2.3).

---

## 7. Reference compositions

Domain effect semantics live in reference compositions that **use** the Authority Plane, and never in the core (Design D4, D6). The development candidate-equality rules (review/verification bound to exact `candidate_sha` and compared against the material's candidate — TD §8.3, §18.3), deployment actuation semantics (`DEPLOY` sha ancestry, closed component list, `expected_prior` CAS shape, restart mechanics — TD §20.3), and any future trading or messaging domain vocabulary are all composition semantics, exactly as a trading composition would verify `RISK_EVIDENCE(portfolio snapshot X)` against `ORDER(material derived from X)`. Every domain effect still passes THROUGH the Authority Plane — for `DEPLOY`, admission, HUMAN-only decision (never delegated), attestation freshness, and PEP actuation remain core guarantees — but the domain vocabulary itself is a composition schema, never kernel vocabulary.

**The development vertical is the reference composition of this generation** (Design D6): run profile + Execution Plane services + Authority Plane + the development evidence-relation rules (candidate-sha subject equality, verification exact-sha binding, and the independence predicates of TD §8.4).

---

## 8. What v0.5 must not do

Normative constraints (Design D7):

1. **No new kernel primitives.** K1–K7 is the complete constitutional vocabulary; v0.5 adds no K8.
2. **No absorption of any orchestrator lifecycle.** No task states, no retry semantics, no checkpoint model in constitutional text — for any orchestrator (the D0 lesson).
3. **No evidence kinds whose only consumer is a workflow engine's internals.** If no gate consumes it, it is orchestrator telemetry, not evidence.
4. **No domain effect semantics in the core.** Development, trading, deployment: all composition vocabulary (§7).
5. **No permanent credential-kind exemptions.** Only policy-scoped deployment facts, revocable by reclassification (§2.3, §6).

---

## 9. Conformance

In the falsification spirit of the v0.4 conformance culture (Spec v0.4 §13): every claim below is proven by controls that attempt and fail to violate it, not by assertion.

### 9.1 Kernel Conformance (mandatory for the claim "CADP v0.5 kernel-conformant")

A v0.5 kernel-conformant implementation proves K1–K7 and, at minimum, the binding, provenance, and credential/effect controls of Spec v0.4 §13.1–§13.3, restated normatively:

- exact policy/work/effect/evidence binding admits; wrong target, wrong work revision, changed material, stale or tampered evidence, drifted mutable candidate, and cross-effect decision reuse do not;
- implementer self-assertion never satisfies required independent review; requested values copied as actuals never pass; a required-but-unavailable actual fact is `UNKNOWN` and does not admit; self-report never satisfies a signed/attested requirement;
- a worker-held credential or alternate path to a governed effect defeats the enforced-admission claim; no capability release without an admission record; same identity + same request replay creates no duplicate logical effect; same identity + different request is refused as conflict; no blind retry of an ambiguous call; no `NO_EFFECT_CONFIRMED` without target-authoritative proof;
- additionally in v0.5: an operation without a policy-bound effect classification is treated as effecting (§2.5), and no credential kind is exempted from §2.3 by kind.

### 9.2 Run-profile deployment (additional proof)

A deployment claiming the run profile additionally proves:

- enrollment is policy-bound: an enrolled principal's unbound effect is REFUSED, and a non-enrolled principal cannot opt in by inventing a binding (§5.1);
- run scope validity grades by K7: an `UNKNOWN` `WORK_START` scope admits nothing until reconciled, and a `NO_EFFECT_CONFIRMED` scope is refused (§5.2);
- run membership is authenticated: a request presenting another valid run's identifier is refused, under the TD-chosen mechanism's falsification controls (§5.3);
- `max_effects` bounds hold under the above — including the negative control that formerly-escaping unbound requests now fail admission.

### 9.3 Reference compositions (additional proof)

A reference composition proves its domain evidence-relation rules as composition semantics over the kernel: for the development vertical, that review/verification evidence bound to a different `candidate_sha` than the material's candidate does not admit, that verification binding is exact-sha and fail-closed, and that policy-required implementer/reviewer independence holds by exact provenance — without introducing any domain vocabulary into the kernel (§7).

---

## 10. Generation boundary

- **Spec v0.4 and the v0.4 TD remain the valid record of the v0.4 generation.** No patching-as-continuity: they are not edited to retroactively describe v0.5 (the succession discipline of Spec v0.4 §12.1; Design D6).
- **v0.5 deployments require a v0.5 genesis.** A new constitution is a new environment minted by genesis (§2.9), never an in-place mutation of a running one.
- **Existing live environments stay v0.4-generation** until a v0.5 genesis, consistent with the corpus's own generation discipline (TD §10, §20.1).
- The K1–K7 records, the admission protocol, the adapters, and the conformance controls carry forward unchanged; the migration is re-homing and re-labeling by plane, not a rewrite (Design D8).
