# DESIGN — CADP v0.5 generation (SPEC-DESIGN)

How a workload worked is its orchestrator's business; the moment it changes the external world, it is CADP's business.

Status: SPEC-DESIGN for the v0.5 generation. Grounded in the v0.4 corpus at this checkout: `Common Autonomous Development Platform — Specification v0.4.md` (below: Spec) and `TECHNICAL_DESIGN_cadp_v0_4_generation.md` (below: TD). This document decides architecture; it authorizes no implementation and patches neither v0.4 document (see D6). Probe rule: TD §17.2's measurement-first discipline applies to this document itself — any capability claim below not backed by a corpus measurement carries an explicit `[UNMEASURED — probe required]` marker.

## D0. The lesson of the withdrawn Conductor integration (PRs 199–204)

Six design-review rounds on the withdrawn Conductor-integration section each surfaced a new contract gap — not because the drafts were careless, but because the approach was wrong: constitutionalizing another product's runtime makes CADP's surface grow with every orchestrator feature. Each Conductor concept (its task states, its retry semantics, its history model) demanded a CADP counterpart, and the next orchestrator release would have demanded more. The v0.4 corpus already states the correct boundary — Spec §8 lists the durable workflow engine, retry scheduler, and task graph as things the kernel does not own, and TD §7.1 reads the orchestrator through exactly three contacts — but the withdrawn drafts violated it by describing Conductor's internals normatively. The correction is structural: narrow CADP to the authority/effect boundary and make every orchestrator a pure client of it. That correction is this document.

## D1. Three control planes, connected only by API contracts

v0.5 organizes the platform as three planes. No plane imports another's types; the only couplings are the contracts named here.

### D1.1 Workflow Plane

The Workflow Plane is a replaceable commodity orchestrator owning roles, routing, retry, checkpoint, context, and the DAG. Reference product for v0.5: Microsoft Conductor `[UNMEASURED — probe required: no container or API probe of Conductor exists in this corpus; the measured v0.4 reference orchestrator is Temporal (TD §6.4, §7), and Conductor becomes the reference only after equivalent probes — start-receipt provenance, replay-idempotent step submission, memo-equivalent binding]`. Its history and events are never authority (Spec §2.6; TD §7.1: "Temporal history is never read as authority; kernel rows are") — the same rule verbatim for Conductor or any successor.

Two distinct qualifications, deliberately asymmetric:

- **Effect boundary / Kernel Conformance:** anything that proposes effects qualifies. A Conductor workflow, a cron job, and a human at a terminal are equal citizens at the effect boundary, and each can claim Kernel Conformance if it satisfies K1–K7 exactly — mirroring Spec §8.1, where a human-operated tool or manual effect gateway reaches Kernel Conformance only.
- **Run profile (D2):** NOTHING qualifies automatically. Run-profile participation is a separate enrolled fact declared by the active policy, never a property a requester acquires by being an orchestrator or sheds by not being one.

### D1.2 Execution Plane

The Execution Plane is the surface broker, provider adapters, executor profiles, isolation postures, and session scanning of TD §17 and §19 (reference code: `cadp/product/surfaceBroker.ts`, `cadp/product/isolation.ts`). It is a CADP product service with a declarative contract — not part of the authority boundary, and optional per deployment: a deployment that runs its workers some other way loses nothing constitutional, only the reference execution evidence producers.

The contract is symmetric and output-bound:

- `ExecutionRequest` carries the executor profile, the provider, and the exact input digests.
- `ExecutionResult` carries an exact `output_artifact_digest`, and the execution evidence (the `BACKEND_EXECUTION`-successor envelope) binds that digest as a subject. `[UNMEASURED — probe required: v0.4's measured scan (TD §17.2, §19.3) captures model/effort/run identity from session logs; no probe has yet captured an output artifact digest from a live surface, so the capture mechanics are a v0.5 TD measurement item.]`

Credentials: in the reference deployment, the Execution Plane's provider subscriptions are not mutation credentials for any current governed domain target (the v0.4 measurement behind this: TD §17.3 injects exactly one provider's auth into an isolated container, and TD §18.2 keeps the GitHub read credential host-side). This is a **deployment-policy fact, never a universal exemption**. The rule is Spec §2.3 applied without a carve-out: any credential able to create a governed effect lives inside the enforcing boundary. A deployment whose policy classifies provider invocation itself as a governed effect (spend caps, data-egress control, model-access governance) thereby brings provider credentials under the full Authority Plane custody rules. No credential KIND is permanently exempt; only concrete credentials that provably cannot reach a governed effect under the active policy sit outside, and that status dissolves the moment policy reclassifies.

### D1.3 Authority Plane

The Authority Plane is the only constitutional territory: K1–K7 (Spec §4), exact binding (Spec §2.4), evidence semantics (Spec §7; TD §9), governed-target credential custody (Spec §2.3; TD §4), admission (Spec §5; TD §3.4), PEP-only actuation (TD §4), effect identity, and reconciliation (Spec §6; TD §6). Everything in v0.5 that is mandatory lives here; everything else is a product or a commodity.

## D2. Core/profile split and enforceable enrollment

**Core:** Kernel Conformance (K1–K7, Spec §8.1, §13.1–13.3) is the unchanged v0.5 core. No kernel primitive is added, removed, or altered.

**Profile:** v0.4's Autonomous-Work Product Conformance (Spec §8.2) is demoted from a peer conformance layer to an optional **composition profile** — the *run profile*. A profile-less deployment is governed per-effect only, and explicitly loses run bounds and every step-evidence-dependent gate (no `MAX_EFFECTS_IN_WORK_RUN`, no `WORK_STEP` chain requirements, no bound-stop semantics). That loss is stated, not hidden: per-effect governance is complete Kernel Conformance, not degraded run governance.

**Enforceable enrollment.** Whether a requester is subject to the run profile is a POLICY-BOUND DEPLOYMENT FACT: the active policy declares which exact requester principals (Spec/TD `requester_ref`, stamped from the authenticated caller — TD §9.1 S3) are run-profiled. Never workflow self-declaration: a requester cannot opt out by omitting a binding and cannot opt in by inventing one. For an enrolled principal, every `EffectRequestV1` MUST carry the work-run binding, and an unbound effect is **REFUSED**, not merely uncounted. This strengthening is load-bearing: in v0.4, `MAX_EFFECTS_IN_WORK_RUN` counts `effect_request` rows whose `work_bindings` include `work_run_ref` (TD §5.4 constraint table, §7.3), so a request that simply omitted the binding escaped the count; under v0.5 enrollment it cannot be admitted at all.

**Run scope validity and run membership are two distinct requirements** (the round-4 blocker), both stated:

1. **Scope validity.** A run scope's validity grades by the **K7 outcome** of the `WORK_START` effect, not by K6 alone. K6 records that the PEP created authority to dispatch; the truth of the effect is K7 (Spec §5.1 step 8, §6.3). v0.4's own `WORK_START` adapter reaches `COMMITTED` only when a target-authoritative `DescribeWorkflowExecution` returns a memo matching `cadp_effect_id` and `cadp_args_digest` — the `StartWorkflow` response alone never yields `COMMITTED` (TD §6.4 reference-adapter table; conformance C34). Therefore: a `COMMITTED` `WORK_START` effect_id is a valid run scope; an `UNKNOWN` one is unusable until reconciliation resolves it (Spec §6.1 — no blind retry, no optimistic use); a `NO_EFFECT_CONFIRMED` one is refused.
2. **Run membership.** An enrolled requester MUST present an AUTHENTICATED run scope proving that THIS request belongs to that exact `work_run_ref`. Possession or knowledge of another valid run identifier is never sufficient: a stable principal serving many concurrent runs could otherwise attach a drained run's work to a fresh run's budget, and `max_effects` would stop being a constitutional guarantee. The spec-design locks ONLY this invariant — *a requester cannot self-select or borrow another valid run scope* — and leaves the mechanism to the TD, which must choose one and prove it under §13-style falsification: a run capability minted at `COMMITTED` `WORK_START` dispatch, a per-run principal, or another authenticated channel. `[UNMEASURED — probe required: no such mechanism exists or has been probed in the v0.4 corpus; today the binding is caller-asserted content of `work_bindings`.]`

`work_run_ref` remains authority-issued: it IS the admitted `WORK_START` effect_id, exactly as TD §7.4 defines it (`work_run_ref = effect_id(WORK_START)`).

## D3. Bisection of TD §7 (the v0.4 autonomous-work composition)

TD §7 currently interleaves two ownerships. v0.5 bisects it:

- **Workflow durability (orchestrator business, leaves the constitutional documents):** step ordinal, DAG, retry, checkpoint, `WORK_STEP` chaining (`prior_step_envelope_digest`, replay-idempotent ingress of TD §7.4), and `max_steps` — v0.4 already concedes the kernel does not count steps (TD §7.3).
- **Authority (kernel/policy business inside the run profile):** the authority-issued `work_run_ref` binding, enrolled-principal run-scoped admission with membership proof (D2), and `max_effects` counting — the PEP-enforced half of TD §7.3's "enforced twice, by different owners, on different quantities."

`WORK_STEP` evidence itself does not vanish — a deployment's policy may still require it — but its chaining mechanics stop being constitutional text and become Workflow Plane product contract, consumed by the Authority Plane only as ordinary K2 envelopes.

## D4. The effect boundary — the only mandatory contract with any workflow plane

Mutation intents arrive as `EffectRequestV1` through an effect client (the TD §12 caller surface). This is the whole mandatory integration; the withdrawn Conductor section is replaced by exactly this (D6).

**General evidence principle (CORE):** evidence that policy requires for an effect must bind to exact immutable subjects, and the policy must EXPLICITLY verify the required relation between each evidence subject and the effect material. The core states only this. Subject-equality rules for particular domains are composition semantics. Consequently the development rule — `REVIEW`/`VERIFICATION` bound to `candidate_sha` compared against the material's candidate (TD §8.3, C41 leg 1; TD §18.3's exact-sha verification binding) — DESCENDS from constitutional text to the development reference composition, exactly as a trading composition would verify `RISK_EVIDENCE(portfolio snapshot X)` against `ORDER(material derived from X)`. Same principle, different domain vocabulary, neither in the core.

**Execution provenance (v0.5 strengthening):** where policy requires execution provenance for an effect, it compares the sealed material's artifact against the execution evidence's bound `output_artifact_digest` — never inferred from K4 inclusion alone. Decision-input inclusion proves the decision *saw* the envelope, not that the execution *produced* the artifact. v0.4's reference policy checks only presence and surface-role on `BACKEND_EXECUTION` (`backend_model_present`, `require_backend_effort`, `surface-role = WORKER` qualification — TD §19.2, §19.5); the output binding is new in v0.5 and depends on the D1.2 capture probe.

**Credentials and actuation:** workflow and execution planes hold zero governed-target credentials (Spec §2.3; TD §4.1, §12 — workers cannot `admit_and_dispatch`). The PEP remains the only actuator.

**Effect classification:** semantically non-effecting operations are outside effect admission — but nothing establishes purity by name. A tool name, an HTTP method, or a claimed read-only mode never proves non-effecting. The corpus's own measurement: grok's plan mode blocked the `write` tool yet executed `run_terminal_command` (2026-09-06 container probe, TD §17.2) — the enforced read-only boundary was a tool allow-list, not the named mode. Classification is therefore a policy-bound declaration per operation against the target adapter's contract, and v0.5 APPLIES Spec §2.5's fail-closed principle to it: an operation's effect classification is a required fact, and an unclassified operation defaults to effecting. (This is an application of §2.5's rule that a missing/unverifiable required fact never satisfies a requirement — §2.5 itself does not state a classification rule.)

## D5. Two analogy caveats, stated as constitutional distinctions

Readers coming from Kubernetes-style control-plane design will reach for two analogies. Both are wrong, constitutionally:

1. **Reconciliation is epistemic, not convergent.** CADP reconciliation resolves `UNKNOWN` outcomes by target-authoritative reads (Spec §6; TD §6.3, §6.5 — "The Reconciler never dispatches"). Blind retry is forbidden (Spec §6.1); the discipline is exactly-once-with-proof. It is never a level-triggered convergence engine that drives the world toward a desired state.
2. **The constitutional store is sealed history, not desired state.** K1–K7 rows are append-only sealed facts consumed by gates (TD §2.4, §3.3). There is no mutable desired-state store whose latest value is authority; "latest" lookups at dispatch are expressly forbidden (TD §6.6).

## D6. Disposition of the v0.4 corpus

- **Spec v0.4 and the TD remain the valid record of the current generation.** No patching-as-continuity: they are not edited to retroactively describe v0.5 (the same succession discipline as Spec §12.1).
- **TD §17–§19 re-home** as Execution Plane product-service contracts (D1.2). NON-BLOCKING regeneration note: the future TD should physically separate execution mechanics (container argv, mounts, scan regexes) from the evidence/binding contracts that cross into the Authority Plane (locator rules, `produced_at` sourcing, subject bindings), which currently interleave within those sections.
- **TD §20's `DEPLOY` passes THROUGH the Authority Plane.** Admission, HUMAN-only decision (never delegated — TD §20.3(c)), attestation freshness (TD §20.3(b), recheck #8), and PEP actuation are core guarantees. But its semantics — sha ancestry (§20.3(a)), the closed component list, `expected_prior` CAS shape, restart mechanics — are a target/reference-composition contract like any future domain adapter's. The Authority Plane never owns any domain effect vocabulary, deployment included; `cadp.deploy.v1` is a composition schema, not kernel vocabulary, exactly as TD §20 already insists ("This is not a kernel primitive").
- **The withdrawn Conductor section is replaced** by a thin effect-boundary integration a fraction of its size: effect client, evidence submission, run-profile enrollment if the deployment declares it. Nothing else.
- **The development vertical becomes the reference composition:** run profile + Execution Plane services + Authority Plane + the development evidence-relation rules (the D4 descent: candidate-sha subject equality, verification exact-sha binding, independence predicates of TD §8.4).

## D7. What v0.5 must not do

1. **No new kernel primitives.** K1–K7 is the complete constitutional vocabulary; v0.5 adds no K8.
2. **No absorption of any orchestrator lifecycle.** No task states, no retry semantics, no checkpoint model in constitutional text — for Conductor, Temporal, or anything else (the D0 lesson).
3. **No evidence kinds whose only consumer is a workflow engine's internals.** If no gate consumes it, it is orchestrator telemetry, not evidence.
4. **No domain effect semantics in the core.** Development, trading, deployment: all composition vocabulary (D4, D6).
5. **No permanent credential-kind exemptions.** Only policy-scoped, revocable-by-reclassification deployment facts (D1.2).

## D8. Generation transition

- **Author Specification v0.5 from this design.** The Spec gains the three-plane structure (D1), the core/profile split with enforceable enrollment (D2), the general evidence principle with domain descent (D4), and the classification fail-closed application (D4). It loses the §8.2 product layer as constitutional text (demoted to the run profile) and any orchestrator-lifecycle residue.
- **Regenerate the TD by plane:** an Authority Plane TD (successor to TD §§2–6, 9, 12, 13), an Execution Plane contract document (successor to TD §§17–19, per the D6 separation note), and a thin Workflow Plane integration contract (successor to the bisected §7/§8 workflow half plus the effect-client surface of §12).
- **Migration is re-homing and re-labeling, not a rewrite.** The K1–K7 records, the admission protocol, the adapters, and the conformance controls carry forward unchanged; what moves is which document owns which section.
- **Existing live environments stay v0.4-generation until a v0.5 genesis.** Consistent with the corpus's own generation discipline (TD §10; the live2–live8 pattern of TD §20.1): a new constitution is a new environment minted by genesis, never an in-place mutation of a running one.

## Appendix — corpus anchors used

| Claim in this design | Anchor at this checkout |
|---|---|
| Manual gateway reaches Kernel Conformance only | Spec §8.1 |
| Product conformance layer being demoted | Spec §8.2 |
| Fail-closed required-fact rule | Spec §2.5 |
| `MAX_EFFECTS_IN_WORK_RUN` counts only bound requests | TD §5.4 table, §7.3 |
| `WORK_START` `COMMITTED` only on `DescribeWorkflowExecution` memo | TD §6.4 (adapter table; C34) — note: the proof rule lives in §6.4, not §6.6; §6.6 is the CAS-completeness rule |
| `work_run_ref = effect_id(WORK_START)` | TD §7.4 |
| Review subject-equality rule (C41 leg 1) | TD §8.3 |
| Verification exact-sha, fail-closed projection | TD §18.3 |
| grok plan-mode probe (write blocked, terminal not) | TD §17.2 |
| Backend policy checks presence + surface-role only | TD §19.2, §19.5 |
| `DEPLOY` HUMAN-only, ancestry, `expected_prior`, restart | TD §20.3 |
| Reconciler never dispatches; no "latest" at dispatch | TD §6.5, §6.6 |
| Requester/producer stamping from authenticated principal | TD §9.1 |
