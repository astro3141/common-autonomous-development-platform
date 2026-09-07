# DESIGN — CADP v0.5 generation: three planes, one authority boundary

How a workload worked is its orchestrator's business; the moment it changes the external world, it is CADP's business.

This is the SPEC-DESIGN for the v0.5 generation. It decides shape, not code. Its ground is the v0.4 corpus in this checkout: `Common Autonomous Development Platform — Specification v0.4.md` (below: Spec) and `TECHNICAL_DESIGN_cadp_v0_4_generation.md` (below: TD). Claims about unmeasured capabilities carry an explicit **[PROBE REQUIRED]** marker, per the TD §17.2 rule that guessing is the defect measurement-first exists to prevent.

## 0. The lesson of the withdrawn Conductor attempt

The prior draft (PRs 199–204, withdrawn; none of it is merged — this checkout's history ends at PR #198) tried to integrate a workflow product by constitutionalizing its runtime: its task lifecycle, its worker polling contract, its event log. Six design-review rounds each surfaced a *new* contract gap, and each gap was real, because the approach guaranteed an unbounded supply of them: when CADP's specification owns another product's runtime semantics, CADP's surface grows with every orchestrator feature — every new task type, retry mode, or event kind becomes a fresh constitutional question. Spec §8 already warned against exactly this ("제품의 workflow/identity/trust semantics가 이 Specification을 대체하지 않는다"), and TD §7.1 already practiced it for Temporal ("Temporal history is never read as authority; kernel rows are").

The correction is not a better orchestrator integration. It is narrowing CADP to the authority/effect boundary — the first sentence of this document — and letting everything on the far side of that boundary be somebody else's product.

## 1. Three control planes, connected only by API contracts

v0.5 organizes the platform as three planes. Nothing crosses between them except explicit API contracts.

**Workflow Plane — replaceable commodity.** Owns roles, routing, retry, checkpoint, context management, and the task DAG. Reference product for v0.5: Microsoft Conductor, replacing Temporal in the reference composition only — either satisfies the contract, and so does a cron job or a human at a terminal (Spec §8.1 already grants the kernel-conformance claim to a manual gateway). Its history and events are **never authority**: exactly the TD §7.1 / §6.4 rule (kernel rows decide; even Temporal's `DescribeWorkflowExecution` was only within-horizon transport dedupe, TD §6.4). **[PROBE REQUIRED]** every Conductor-specific capability — start dedupe, payload delivery by digest, worker task-queue isolation — is unmeasured; no registry entry, timeout, or argv for it may be written from documentation.

**Execution Plane — a CADP product service, not constitutional territory.** The surface broker, provider adapters, executor profiles, isolation postures and session scanning of TD §17 and §19 (`cadp/product/surfaceBroker.ts`, `workerProviders.ts`, `reviewProviders.ts`, `planProviders.ts`, `isolation.ts`) become a named service with a declarative contract. It holds model-subscription custody (`oauth_env` / `auth_files`, TD §17.3) as **internal discipline** — good hygiene of a product, not a kernel invariant, because model subscriptions are not governed-target credentials in the Spec §2.3 sense. It is **optional per deployment**: a deployment that brings its own execution substrate still conforms. It is **not part of the authority boundary**.

Its contract is symmetric and output-bound (this is owner fix 2):

- `ExecutionRequest` carries the executor profile, the provider selection, and exact **input digests**.
- `ExecutionResult` carries an exact **`output_artifact_digest`**.
- The execution evidence — `BACKEND_EXECUTION` (TD §9.2) or its v0.5 successor — **binds that output artifact digest as a subject**, alongside its existing bindings.
- A gate that needs execution provenance for an effect compares the sealed effect material's artifact — for development, the candidate/bundle digest the material already names (`candidate_sha` / `bundle_cas_key`, TD §8.1) — **against the execution evidence's bound output**. It never infers the link from K4 inclusion alone: decision-input inclusion proves the decision *saw* the envelope, not that the execution *produced* the artifact.

Honesty about v0.4: today's `BACKEND_EXECUTION` binds `work_run_ref + step` only (TD §9.2 table; TD §19.1: "subject_bindings = work_run + step"), and the reference policy consumes it via presence and surface-role predicates — `implementer_refs`, `backend_model_present`, `require_backend_effort` on `observed.*.availability == "PRESENT"`, role-qualified to `surface-role = WORKER` (TD §19.1, §19.2, §19.5). Nothing in v0.4 compares an execution's output to the effect's candidate. The output-artifact binding is a **v0.5 strengthening**, not a description of the current gate.

**Authority Plane — the only constitutional territory.** K1–K7 (Spec §4), exact binding (Spec §2.4), evidence semantics (Spec §7), governed-target credential custody (Spec §2.3, TD §4.1), admission and commit-time fresh recheck (Spec §5.2, TD §3.4/§4.4), PEP-only actuation, effect identity, and reconciliation (Spec §6, TD §6). This plane is what "CADP-conformant" means. Everything else in this document is composition around it.

## 2. Core/profile split: kernel core, run profile

**Kernel Conformance (K1–K7) is the unchanged core.** Spec §8.1's claim survives verbatim into v0.5: satisfying K1–K7 and the §13.1–§13.3 controls, with no promise of continuation, restart recovery, or multi-step work.

**The v0.4 Autonomous-Work Product Conformance (Spec §8.2) is demoted to an optional composition profile — the run profile.** Its six product outcomes remain exactly as written; what changes is their status: a deployment may conform to the kernel core without them. A profile-less deployment is governed **per-effect only**, and this design says plainly what that loses: no run bounds (no `MAX_EFFECTS_IN_WORK_RUN`), and no gates that depend on step evidence (`WORK_STEP` chains, `WORK_BOUND_STOP`, run-scoped evidence queries per TD §12 `list_evidence(work_run_ref)`).

**What the run profile keeps at the authority boundary** (owner fix 1):

1. `work_run_ref` **is** the admitted `WORK_START` effect identity — authority-issued via `allocate_effect_id` and admission (TD §7.4: `work_run_ref = effect_id(WORK_START)`), never workflow-invented. A workflow plane cannot mint a run.
2. Every run-scoped `EffectRequestV1` **MUST carry that binding** in `work_bindings`.
3. The PEP's `max_effects` counts **exactly the effects bound to the admitted `WORK_START`** — no more, and critically, no fewer.

The vulnerability this closes: in v0.4, `MAX_EFFECTS_IN_WORK_RUN` "counts `effect_request` rows whose `work_bindings` include `work_run_ref`" (TD §7.3, §5.4 constraint table). Counting only *when a binding is present* means a workflow that **omits** the binding on a request escapes the run bound entirely — the effect is uncounted rather than refused. Under the v0.5 run profile, an effect request from a run-profiled deployment's workflow principal that carries **no** run binding is **refused, not uncounted**. Unbound effects remain legal only for principals and deployments outside the run profile (per-effect governance, decision 2 above), where no run bound was ever promised.

## 3. Bisecting TD §7 at the corrected cut

TD §7 mixes two owners. v0.5 cuts it as follows:

- **Workflow durability (orchestrator business, leaves the constitution):** step ordinal, the DAG, retry policy, checkpointing, `WORK_STEP` causal chaining and its replay-idempotent ingress contract (TD §7.4), and `max_steps` enforcement (TD §7.3 already assigns `max_steps` to the workflow). These describe *how the workload worked*.
- **Authority (kernel/policy business inside the run profile):** the authority-issued `work_run_ref` binding, run-scoped effect admission, and `max_effects` counting (TD §7.3's PEP half). These govern *what the workload may do to the external world*.

The v0.4 double-enforcement insight survives — the two bounds are enforced "by different owners, on different quantities" (TD §7.3) — but v0.5 stops writing the workflow's half into constitutional text.

## 4. The effect boundary: the only mandatory contract with any workflow plane

Whatever the workflow plane is, its entire mandatory relationship with CADP is:

1. **Mutation intents arrive as `EffectRequestV1`s through an effect client.** The client is a thin library over the twelve kernel API calls (TD §12); the Conductor integration is a task worker that calls it — **[PROBE REQUIRED]** for any claim about how Conductor tasks invoke it. The withdrawn draft's orchestrator section is replaced by this client contract, a fraction of its size (§6 below).
2. **REVIEW and VERIFICATION evidence are candidate-bound with evaluator-checked subject equality.** TD §8.3 C41: a `REVIEW` satisfies a requirement only if its bound candidate equals the exact candidate the sealed material names; inequality is requirement-unsatisfied, decided by the evaluator, no K6. TD §18.3: `VERIFICATION` is bound to the exact candidate sha with fail-closed projection. These rules move into v0.5 core text unchanged.
3. **Execution provenance uses the output-artifact binding of decision 1** — sealed material artifact compared to the execution evidence's bound output, never inferred from K4 inclusion.
4. **The workflow and execution planes hold zero governed-target credentials** (Spec §2.3; TD §4.1's custody rule: only the kernel process reads them). **The PEP remains the only actuator.**

**Effect scope wording (owner fix):** semantically non-effecting operations are outside effect admission — but *nothing establishes purity by name*. A tool name, an HTTP method, or a claimed read-only mode never proves an operation is non-effecting; the corpus itself supplies the cautionary measurement — grok's `--permission-mode plan` blocked the `write` tool but still executed `run_terminal_command` (TD §17.2). Anything that changes the external world is an effect regardless of what it is called; classification is a policy-bound declaration per operation against the target adapter's contract, and the fail-closed default for the unclassified is: it is an effect.

## 5. Two analogy caveats, promoted to constitutional distinctions

People will describe v0.5 as "a control plane like Kubernetes." Two places where that analogy would quietly rewrite the constitution:

- **CADP reconciliation is epistemic, not convergent.** Its job is to resolve `UNKNOWN` by target-authoritative reads (Spec §6, K7; TD §6.3's outcome truth rules) — exactly-once-with-proof, blind retry forbidden (Spec §6.1). It is never a level-triggered convergence engine that keeps actuating until observed state matches desired state; a reconciler that "makes it so" is an ungoverned actuator.
- **The constitutional store is sealed history, not a desired-state store.** Gates consume append-only K1–K7 rows (TD §2.4); nothing edits a record to change what the platform will do next. Intent changes only by admitting new effects under the active policy.

## 6. Disposition of the v0.4 corpus

- **Spec v0.4 and the TD remain the valid record of the current generation.** No patching-as-continuity: they are not rewritten to look like v0.5.
- **TD §§17–19 re-home as Execution Plane product-service contracts** (provider registries, isolation postures, session scanning, observability) — content unchanged, ownership label changed.
- **TD §20's DEPLOY splits along the plane boundary** (owner fix 3). The operation **passes through the Authority Plane**: admission, the HUMAN-only decision with no agent delegation (TD §20.3(c)), attestation freshness (TD §20.3(b), recheck #8), and PEP actuation are core guarantees. But its **semantics** — sha ancestry against `main` (TD §20.3(a)), the closed component list of `cadp.deploy.v1`, `expected_prior` compare-and-swap (TD §20.4), restart mechanics — are a target/reference-composition contract, exactly like a future trading or messaging adapter's domain semantics. The Authority Plane never owns any domain effect vocabulary, deployment included. Spec v0.4 already declares development-specific primitives non-core (Spec §8.2 item 6, §10, the §11 COMMODITIZE row); v0.5 applies the same rule to CADP's own self-deployment.
- **The withdrawn Conductor section is replaced** by the thin effect-boundary integration of decision 4 — an effect client plus evidence submission, a fraction of the withdrawn text's size.
- **The development vertical becomes the reference composition**: run profile + Execution Plane services + Authority Plane. It stays what Spec §10 already made it — the required reference domain, not the constitutional center.

## 7. What v0.5 must not do

- **No new kernel primitives.** K1–K7 stay the whole constitutional vocabulary (Spec §4).
- **No absorption of any orchestrator lifecycle** — the §0 lesson, and Spec §14's non-goals restated.
- **No evidence kinds whose only consumer is a workflow engine's internals.** If only the orchestrator would ever read it, it is orchestrator state, not evidence.
- **No domain effect semantics in the core** — not merge, not deploy, not trade.

## 8. Generation transition

1. Author Specification v0.5 from this design: core = Authority Plane (K1–K7, admission, evidence, reconciliation, plus the C41-class binding rules of decision 4); profiles = run profile; plane contracts as annexes.
2. Regenerate the TD **by plane**: Authority Plane TD (successor to TD §§1–6, 9–13), Execution Plane contract (re-homed TD §§17–19), reference Workflow Plane integration (the effect client; every Conductor-specific fact **[PROBE REQUIRED]** before it is written down).
3. Migration is **re-homing and re-labeling, not a rewrite**: the section moves and ownership map above, with the two substantive strengthenings (output-artifact binding, refuse-unbound-run-effects) called out as behavior changes.
4. Existing live environments stay v0.4-generation until a v0.5 **genesis** — the established fresh-environment pattern (TD §10, §20.3 recommendation (i), the live2–live8 precedent). No in-place constitutional mutation of a running deployment.
