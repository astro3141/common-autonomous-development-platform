# DESIGN — CADP v0.5 Generation: Three Planes, One Authority Boundary

How a workload worked is its orchestrator's business; the moment it changes the external world, it is CADP's business.

Everything in this design is an application of that sentence. It is the SPEC-DESIGN document for the v0.5 generation, authored against the v0.4 corpus in this checkout: `Common Autonomous Development Platform — Specification v0.4.md` (below: Spec v0.4) and `TECHNICAL_DESIGN_cadp_v0_4_generation.md` (below: TD), in particular TD §7, §9, §12 and §17–20.

## 0. The lesson that forces this generation

The withdrawn Conductor-integration section went through six consecutive design-review rounds (PRs #199–#204). Each round surfaced a new contract gap — not because the reviews were bad, but because the section was constitutionalizing another product's runtime. Every Conductor step type, retry rule, and plugin reference that the section described became a CADP contract liability: CADP's surface grew with every orchestrator feature, and no round could be the last, because the orchestrator has an unbounded feature set and the section had signed up to mirror it.

Spec v0.4 already states the rule that was being violated: §8 places the "durable workflow/orchestration engine" and its "retry scheduler, timer, queue, signal, callback" outside kernel ownership, and §8.3 says the presence of a commodity continuation product never makes its lifecycle kernel property. The correction is not a seventh review round; it is to narrow CADP's constitutional territory to the authority/effect boundary and to say so structurally. That is v0.5.

## 1. Three control planes, connected only by API contracts

v0.5 organizes everything the v0.4 corpus built into three planes. No plane reads another's internal state; the only couplings are the declared contracts named below.

**Workflow Plane** (reference: Microsoft Conductor; replaceable commodity). Owns roles, routing, retry, checkpointing, run context, and the DAG — everything Spec v0.4 §8 items 2–5 already disclaim. It is a *reference*, not a constitutional citizen: any engine that can call the effect boundary (§4) qualifies, exactly as TD §7.1 treated Temporal in v0.4. Its history and events are never authority (TD §7.1: "Temporal history is never read as authority; kernel rows are" — the rule survives verbatim with the product name swapped out).

**Execution Plane** (a CADP *product service*, not constitutional territory). This is the surface machinery the v0.4 TD already built and measured: the surface broker (`cadp/product/surfaceBroker.ts`), the closed provider registries and executor profiles of TD §17 (`cadp/product/workerProviders.ts`, `reviewProviders.ts`, `planProviders.ts`), the isolation postures of `cadp/product/isolation.ts`, the auth-injection discipline of TD §17.3, and the session scanning / observed-model evidence of TD §17.2 and §19. In v0.5 it gets its own declarative contract: an **ExecutionRequest** of profile, provider, and input digests, returning artifacts and honest surface evidence. Model-subscription custody (the `oauth_env` / `auth_files` machinery of TD §17.3) is this plane's *internal* discipline. The Execution Plane is NOT part of the authority boundary and is optional per deployment — a deployment that runs surfaces some other way loses nothing constitutional, only this product service.

**Authority Plane** (the constitutional kernel — the ONLY constitutional territory). K1–K7 (Spec v0.4 §4: `PolicyRefV1`, `EvidenceEnvelopeV1`, `EffectRequestV1`, `AdmissionInputV1`, `PolicyDecisionV1`, `EffectAdmissionV1`, `EffectOutcomeV1`), exact binding (§2.4), evidence semantics (§7), governed-target credential custody (§2.3), the admission protocol with commit-time fresh recheck (§5.2), PEP-only actuation, effect identity, and the reconciliation rules of §6. Implementation-wise this is TD §§2–6, §9, the twelve-call Kernel API of TD §12, and the deployment-actuation contract of TD §20.

## 2. Core/profile split

**Core: Kernel Conformance, unchanged.** Spec v0.4 §8.1's Constitutional Kernel Conformance (K1–K7 plus the §13.1–13.3 controls) carries into v0.5 byte-for-byte in meaning. No new kernel primitive is added by this design (§7 below).

**Profile: the run profile.** Spec v0.4 §8.2's CADP Autonomous-Work Product Conformance is *demoted* from a conformance layer of the specification to an optional **composition profile** — the run profile. A deployment that adopts it gets what §8.2 promises today: `WORK_START` admission (TD §7.2), work-run-bound effect counting (`max_effects` enforced by the PEP as `MAX_EFFECTS_IN_WORK_RUN`, TD §7.3), and step evidence (`WORK_STEP` / `WORK_BOUND_STOP`, TD §7.4). These are chosen per deployment, not imposed by the constitution.

The honest consequence, stated as such: a profile-less deployment is governed **per-effect only**. It keeps every K1–K7 guarantee for each individual effect, and it explicitly **loses** run bounds (there is no `work_run_ref` to count against) and every gate whose input is step evidence. That is a real reduction in what policy can express, accepted deliberately — it is the same trade §8.1 already grants a "Human-operated tool or manual effect gateway."

## 3. Bisection of TD §7

TD §7 (D7, autonomous-work product composition) currently interleaves two different kinds of machinery. v0.5 cuts it along the boundary principle:

**Workflow durability — orchestrator business, profile machinery at most:** continuation identity (`work_run_ref`, deterministic `step_ordinal`, TD §7.4), replay idempotency (the `WORK_STEP` semantic-payload convergence rule and the `allocation_key` tuple of TD §7.4), `max_steps`, deadline enforcement by the workflow, and step chaining (`prior_step_envelope_digest`). None of this is kernel contract in v0.5. Where the run profile is adopted, it lives there; where it is not, an orchestrator may do all of it privately and CADP does not care.

**Authority — kernel/policy business inside the run profile:** work-run-bound effect counting (`max_effects` / `MAX_EFFECTS_IN_WORK_RUN`, counted by the PEP over `effect_request` rows bound to `work_run_ref` — TD §7.3's "enforced twice, by different owners, on different quantities" already made the PEP's count independent of the workflow's step count) and work-bound admission (`WORK_START` as a governed effect, TD §7.2 / Spec §8.2). These remain governed exactly because they cross the boundary sentence: releasing autonomous work and bounding its external effects change the world.

## 4. The effect boundary — the only mandatory contract with any workflow plane

Mutation intents arrive as `EffectRequestV1`s through an **effect client**; that is the entire mandatory integration between any workflow engine and CADP. The withdrawn Conductor section is replaced by this, at a fraction of its size.

**Evidence requirements are artifact-bound, not lifecycle-bound.** The proof that the thin boundary loses no authority-critical evidence is already in the v0.4 corpus: the development gates consume `REVIEW`, `VERIFICATION`, and `BACKEND_EXECUTION` bound to the exact `candidate_sha`, not to any step lifecycle. TD §8.3's review-to-effect subject equality (C41) makes the *evaluator* compare the `REVIEW` envelope's bound candidate against the sealed material's `head_sha`; TD §18.3 binds `VERIFICATION` from `verifier:github-actions` to the exact candidate sha with `produced_at = claim.completed_at`; TD §8.1/§17.2 bind `BACKEND_EXECUTION` to the run via session scanning of the surface's own logs. No gate in the reference policy consumes an orchestrator lifecycle event as evidence — so removing the orchestrator from the constitutional surface removes nothing a gate depends on.

**Credentials.** Workflow and Execution Planes hold zero governed-target credentials (Spec §2.3 unchanged). The PEP remains the only actuator. Read/pure tools are unconstrained by CADP — the boundary sentence again: they do not change the external world. Mutating tools are credential-less shims that seal `EffectRequests` and wait on kernel rows; TD §8.1's worker-cannot-push / `GIT_PUSH`-via-bundle discipline is the existing model.

## 5. Two analogy caveats, stated as constitutional distinctions

The Kubernetes analogy motivates the three-plane shape (commodity scheduling below, product services beside, a small authoritative core) — and it misleads in exactly two places, both of which are constitutional distinctions, not stylistic ones:

1. **CADP reconciliation is epistemic, not level-triggered.** A Kubernetes controller converges actual state toward desired state by acting again. CADP's reconciler (Spec §6, TD §6.5) resolves `UNKNOWN` outcomes by **target-authoritative reads**; blind retry is forbidden (Spec §6.1); the goal is exactly-once-with-proof, and a new effect after `UNKNOWN` requires the §6.2 protocol, never a loop that re-actuates until the world matches a spec. A v0.5 reader who imports "reconcile = keep applying" has imported a constitutional violation.
2. **The constitutional store is sealed history, not desired state.** etcd is a mutable desired-state store that controllers write to steer the world. The CADP record store (TD §2.4, §3) is append-only sealed history — K1–K7 rows consumed by gates and reconstruction. Nothing steers the world by editing it, and nothing in it is ever "the spec to converge to."

## 6. Disposition of the v0.4 corpus

- **Spec v0.4 and its TD remain the valid record of the current generation.** No patching-as-continuity: v0.5 is authored as a successor, the same rule Spec v0.4 §12.1 applied to v0.3 ("v0.3 … is not v0.4's architecture authority; historical evidence or commodity adapter input only").
- **TD §17 (provider adapters), §18 (external verification backend), §19 (surface execution observability)** re-home as Execution Plane product-service contracts. Their content — measured argv, closed registries, fail-closed projections, observed-model evidence — is unchanged; only its constitutional address changes.
- **TD §20 (guarded continuous-deployment contract)** stays in the Authority Plane: deployment actuation changes the external world, so it is squarely inside the boundary sentence.
- **The withdrawn Conductor section** is replaced by the thin effect-boundary integration of §4 above.
- **The development vertical** (TD §11's reference composition, TD §§7–8's work loop) is re-described as the *reference composition*: run profile + Execution Plane services + Authority Plane. It stays the required reference domain (Spec §10.1) without being the constitutional center.

## 7. What v0.5 must NOT do

1. **No new kernel primitives.** K1–K7 is the complete constitutional vocabulary; the ExecutionRequest and the run profile are product contracts, not K8.
2. **No absorption of any orchestrator lifecycle.** Not Conductor's, not Temporal's, not a future engine's. Step types, retry rules, signals, and plugins never appear in CADP contract text again.
3. **No evidence kinds whose only consumer is a workflow engine's internals.** An evidence kind exists to feed a gate over external-world change; if only the orchestrator would read it, it is orchestrator state, not evidence.

## 8. Generation transition

1. Author **Specification v0.5** from this design: the Authority Plane as the constitutional core, the run profile as its optional composition profile, the effect boundary as the sole mandatory workflow-plane contract.
2. Regenerate the **TD by plane**: an Authority Plane TD (successor to TD §§2–6, §9, §12, §20), an Execution Plane service contract (successor to TD §§17–19), and a reference-composition document (successor to TD §7/§8/§11, bisected per §3 above).
3. **Migration is re-homing and re-labeling of existing code, not a rewrite.** The kernel, PEP, broker, registries, and adapters in `cadp/` keep their behavior; what changes is which contract document owns each file.
4. **Existing live environments stay v0.4-generation until a v0.5 genesis** — the same clean execution-domain boundary Spec v0.4 §12.2 imposed on v0.3: new namespace, new genesis `PolicyRefV1`, no in-place record migration, no silent promotion of v0.4 admissions.

## Appendix: review focus

For the reviewer of this document: (a) verify literally that the first body sentence after the H1 is the boundary principle, with nothing preceding it; (b) verify every v0.4 claim above against Spec v0.4 and the TD at `base_sha`; (c) verify the presence of the three planes (§1), the core/profile split (§2), the TD-§7 bisection (§3), and both analogy caveats (§5). Contracts checked while authoring: Spec v0.4 §2, §4 (K1–K7), §5.2, §6.1–6.4, §8, §8.1–8.3, §9, §10.1, §12.1–12.3; TD §7.1–7.5, §8.1–8.4, §9.1, §12 (Kernel API and caller matrix), §17.1–17.5, §18.1–18.4, §19, §20.
