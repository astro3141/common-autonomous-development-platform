# DESIGN — CADP v0.5 generation: three planes, one authority boundary

How a workload worked is its orchestrator's business; the moment it changes the external world, it is CADP's business. That sentence is the whole correction of this generation. v0.4 proved the kernel (K1–K7, exact binding, fail-closed admission) and then let the platform's surface grow along every axis of the products around it. v0.5 stops that growth by naming what is constitutional — the authority/effect boundary — and demoting everything else to replaceable planes connected only by API contracts.

This document is the SPEC-DESIGN for the v0.5 generation. It is grounded in the current corpus as it exists in this checkout: `Common Autonomous Development Platform — Specification v0.4.md` (cited as Spec) and `TECHNICAL_DESIGN_cadp_v0_4_generation.md` (cited as TD). Capability claims that have not been measured carry an explicit probe marker: **UNMEASURED — requires a live probe before any registry entry or conformance claim**.

## 0. The lesson of the withdrawn Conductor-integration attempt (PRs 199–204)

The previous drafts of this generation tried to constitutionalize an orchestrator integration. Six design-review rounds each surfaced a new contract gap — task lifecycle mapping, event-log trust, retry semantics, workflow-definition versioning, worker registration, human-task mirroring — and every gap was real, because constitutionalizing another product's runtime makes CADP's surface grow with every feature that product ships. There is no fixed point on that path: the reviewed surface was the orchestrator's, not CADP's. PRs 199–204 were withdrawn.

The correction is not a better orchestrator mapping. It is narrowing CADP to the authority/effect boundary: the only contract any workflow plane owes CADP is the one v0.4 already defined for its own reference orchestrator — propose effects as exact `EffectRequestV1`s, submit evidence honestly, read kernel rows as the only authority (TD §7.1: "Temporal history is never read as authority; kernel rows are"). Everything the six rounds fought over lives on the other side of that line and stops being CADP's problem.

## 1. Decision: three control planes, connected only by API contracts

### 1.1 Workflow Plane (commodity, replaceable)

Owns roles, routing, retry, checkpoint, context, DAG, timers, signals — everything Spec §8 items 2–5 already disclaim. Reference for v0.5: **Microsoft Conductor**, replacing Temporal's reference role in TD §7 — chosen precisely because it must be replaceable; the reference deployment may keep Temporal without any conformance consequence. Conductor's own runtime semantics are **UNMEASURED — requires a live probe before any reference-deployment claim**; nothing in this design depends on them, which is the point. The workflow plane's history, event log, and task states are never authority; kernel rows are (TD §7.1, unchanged).

**Who qualifies (round-3 wording).** Anything that proposes effects qualifies at the effect boundary and for Kernel Conformance — a Conductor workflow, a cron job, or a human at a terminal included. But NOTHING qualifies for the optional run profile automatically: run-profile participation is a separate enrolled fact (§2.2 below). This mirrors v0.4's existing split, where a human-operated tool or manual effect gateway reaches Constitutional Kernel Conformance only, never Product Conformance (Spec §8.1).

### 1.2 Execution Plane (CADP product service, optional per deployment)

The surface broker, provider adapters, executor profiles, isolation postures, and session scanning of TD §17 and TD §19 become a named product service — the Execution Plane — with a declarative contract. It is not part of the authority boundary and a deployment may omit it entirely.

The contract is symmetric and output-bound:

- `ExecutionRequest` carries the executor profile, the provider, and exact input digests.
- `ExecutionResult` carries an exact `output_artifact_digest`, which the execution evidence binds as a subject.

This is a v0.5 strengthening over TD §19, where `BACKEND_EXECUTION` (`cadp.backend.v1`) binds `work_run` + `step` + `surface-role` and observed model/effort, but no output artifact. Capture mechanics inherit TD §19.3's measured pattern (writable session mount, profile-declared `model_scan`/`effort_scan`, `UNKNOWN` when absent); artifact-digest capture per provider is **UNMEASURED — requires a container probe per provider argv before the profile field is added**, exactly as TD §19.3 already requires for reviewer/planner session layouts.

**Credentials (round-3 fix).** In the reference deployment, the Execution Plane's provider subscriptions (TD §17.3: `oauth_env` tokens, `auth_files` such as `~/.grok/auth.json`) are not mutation credentials for any CURRENT governed domain target — the worker cannot push; the PEP pushes a verified bundle (TD §8.1). But this is a deployment-policy fact, never a universal exemption. The constitutional rule is: **any credential able to create a governed effect lives inside the enforcing boundary** (Spec §2.3). A deployment whose active policy classifies provider invocation itself as a governed effect — for cost, data-transfer, or any other reason — thereby brings those provider credentials under the full Authority Plane custody rules. No credential KIND is permanently exempt.

### 1.3 Authority Plane (the only constitutional territory)

K1–K7, exact binding (Spec §2.4), evidence semantics (Spec §7), governed-target credential custody (Spec §2.3, TD §4), admission (Spec §5, TD §3.4), PEP-only actuation, effect identity (TD §2.2), and reconciliation (Spec §6, TD §6.5). Unchanged from v0.4 in substance; v0.5 changes what surrounds it, not what it is.

## 2. Decision: core/profile split

### 2.1 Kernel Conformance is the unchanged core

Constitutional Kernel Conformance (Spec §8.1: K1–K7 plus §13.1–13.3) is the v0.5 core, byte-for-byte in meaning. The v0.4 CADP Autonomous-Work Product Conformance (Spec §8.2) is demoted to an optional composition profile — the **run profile**. A profile-less deployment is governed per-effect only, and explicitly loses run bounds (`MAX_EFFECTS_IN_WORK_RUN`, `WORK_BOUND_STOP`) and every step-evidence-dependent gate (anything quantifying over `WORK_STEP` chains, TD §7.4). That loss is stated, not hidden: per-effect governance is still full K1–K7 governance.

### 2.2 Enforceable enrollment (round-3 fix)

Whether a requester is subject to the run profile is a **policy-bound deployment fact**: the active policy declares which exact requester principals are run-profiled. Never workflow self-declaration — a requester cannot opt out by omitting a binding, and cannot opt in by inventing one.

For an enrolled principal, every `EffectRequest` MUST carry the work-run binding, and an unbound effect is **REFUSED**, not merely uncounted. This strengthening is load-bearing: today TD §7.3 has the PEP enforce `MAX_EFFECTS_IN_WORK_RUN` by "counting `effect_request` rows whose `work_bindings` include `work_run_ref`" — so a v0.4 request that simply omits the binding escapes the count. Under v0.5 enrollment, omission is refusal.

The presented `work_run_ref` must verify as the effect identity of a REAL admitted `WORK_START` — a sealed K3 with its K6 admission in the store — never an arbitrary string. `work_run_ref` remains authority-issued: it IS the admitted `WORK_START` `effect_id`, exactly as TD §7.4 already defines it.

## 3. Decision: bisection of TD §7 (the autonomous-work composition)

TD §7 currently mixes two owners. v0.5 splits it:

- **Workflow durability (orchestrator business, leaves the constitution):** step ordinal, DAG, retry, checkpoint, `WORK_STEP` causal chaining (TD §7.4's replay-idempotent ingress and `allocation_key` mechanics), and `max_steps` (TD §7.3 already assigns `max_steps`/`deadline` emission to the commodity workflow).
- **Authority (kernel/policy business, inside the run profile):** the authority-issued `work_run_ref` binding, enrolled-principal run-scoped admission (§2.2), and `max_effects` counting — TD §7.3's PEP half, strengthened by refusal-on-unbound.

`WORK_STEP` evidence remains available as an evidence kind a policy MAY require inside the run profile; the kernel never requires it in the core, and its chaining semantics are the profile's, not the kernel's.

## 4. Decision: the effect boundary is the only mandatory contract

Mutation intents arrive as `EffectRequest`s through an effect client (the TD §12 API, unchanged: twelve calls, reach matrix, no task/attempt/batch endpoint). Workflow and execution planes hold zero governed-target credentials; the PEP remains the only actuator (TD §4).

**Evidence relation (round-3 fix — the core states only the general principle).** Evidence that policy requires for an effect must bind to exact immutable subjects, and the policy must EXPLICITLY verify the required relation between each evidence subject and the effect material. Subject-equality rules for particular domains are composition semantics, not core. Therefore the development rule — `REVIEW`/`VERIFICATION` bound to `candidate_sha`, compared against the sealed material's candidate, inequality is `DENY` with the evaluator deciding (TD §8.3 review-to-effect subject equality, C41 leg 1; TD §18.3's `VERIFICATION` bound to the exact candidate sha) — DESCENDS to the development reference composition. A trading composition would verify `RISK_EVIDENCE`(portfolio snapshot X) against `ORDER`(material derived from X) by exactly the same principle with its own subjects.

**Execution provenance is compared, never inferred.** The composition compares the sealed material's artifact against the execution evidence's bound `output_artifact_digest`. K4 inclusion alone proves only that the decision saw the envelope, not that the execution produced the artifact. v0.4's reference policy checks only presence and surface-role here (TD §19.5: `backend_model_present`/`backend_effort_present` over `surface-role = WORKER`); the output binding is a v0.5 strengthening.

**Non-effecting operations.** Semantically non-effecting operations are outside effect admission — but nothing establishes purity by name. A tool name, an HTTP method, or a claimed read-only mode never proves non-effecting. The corpus's own measurement: grok's `--permission-mode plan` blocked the `write` tool yet executed `run_terminal_command` (a `touch` landed a file; TD §17.2, 2026-09-06 container probe). Classification is a policy-bound declaration per operation against the target adapter's contract, and the fail-closed default for the unclassified is: **it is an effect** (Spec §2.5).

## 5. Decision: two analogy caveats as constitutional distinctions

Because three-plane architectures invite two familiar readings, v0.5 forecloses both in the constitution:

1. **CADP reconciliation is epistemic, not convergent.** It resolves `UNKNOWN` by target-authoritative reads; blind retry is forbidden (Spec §6.1); the discipline is exactly-once-with-proof (TD §6.3–6.5). It is never a level-triggered convergence engine that drives the world toward a desired state — a reconciler that "makes it so" is a second actuator outside the PEP.
2. **The constitutional store is sealed history consumed by gates, never a mutable desired-state store.** Append-only rows (TD §2.4), verify-on-read (TD §12 r8); nothing edits a row to change what the platform "wants."

## 6. Decision: disposition of the v0.4 corpus

- **Spec v0.4 and its TD remain the valid record of the current generation.** No patching-as-continuity — the same succession discipline Spec §12.1 applied to v0.3.
- **TD §17, §18, §19 re-home** as Execution Plane product-service contracts (provider registries, measurement-first capabilities, auth injection, external verification backend, session scanning), verbatim in substance.
- **TD §20's DEPLOY passes THROUGH the Authority Plane, but its vocabulary does not enter it.** The core guarantees are admission, HUMAN-only decision (TD §20.3c), attestation freshness (TD §20.3b), PEP actuation. Its semantics — sha ancestry (TD §20.3a), the component list `{broker, worker}`, `expected_prior` compare-and-refuse (TD §20.4), restart mechanics — are a target/reference-composition contract like any future domain adapter's. The Authority Plane never owns any domain effect vocabulary, deployment included.
- **The withdrawn Conductor section is replaced** by a thin effect-boundary integration a fraction of its size: effect client + evidence submission + kernel-row reads, per §1.1 and §4.
- **The development vertical becomes the reference composition:** run profile + Execution Plane services + Authority Plane + the development evidence-relation rules of §4.

## 7. What v0.5 must not do

1. No new kernel primitives. K1–K7 is the complete constitutional vocabulary.
2. No absorption of any orchestrator lifecycle — no task, attempt, batch, or workflow-definition concept in the core (reaffirming TD §12 and Spec §8.2 item 6).
3. No evidence kinds whose only consumer is a workflow engine's internals.
4. No domain effect semantics in the core — not merge, not deploy, not order.
5. No permanent credential-kind exemptions (§1.2): every exemption is a deployment-policy fact, revisited when policy changes.

## 8. Generation transition

- Author Specification v0.5 from this design.
- Regenerate the TD **by plane**: an Authority Plane TD (successor to TD §§2–6, 9, 12, 13), an Execution Plane TD (re-homed TD §§17–19), and a thin workflow-plane integration contract (successor to the bisected TD §7, per §3).
- Migration is re-homing and re-labeling, not a rewrite: the kernel implementation, the store, the PEP, and the reference policy carry forward.
- Existing live environments stay v0.4-generation until a v0.5 genesis — the fresh-environment discipline TD §10 and TD §20.3 (the live2–live8 pattern) already establish. No in-place mutation of a running constitution.

## Review contract (for the reviewer of this document)

REQUEST_CHANGES only for: (a) a missing decision from the set above, (b) a claim about the v0.4 corpus contradicting the actual documents at `base_sha`, or (c) an unmeasured capability without a probe marker. Formatting, ordering, and style beyond the first-sentence rule are NON-BLOCKING notes. Verify v0.4 claims by opening the documents and list what you checked.
