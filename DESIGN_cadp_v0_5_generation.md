# CADP v0.5 Generation — Spec-Design (constitutional direction for Specification v0.5)

| Field | Value |
|---|---|
| Status | SPEC-DESIGN CANDIDATE — the direction paper Specification v0.5 will be authored from, the same pattern that produced v0.4 (Spec Design #92 preceded landed Spec #93; see the TD header table) |
| Grounding corpus | `Common Autonomous Development Platform — Specification v0.4.md`; `TECHNICAL_DESIGN_cadp_v0_4_generation.md` (TD v2.0, v0.4 generation), esp. §7, §9, §12, §17–§20; the six closed Conductor-integration candidates (PRs #199–#204, each a withdrawn "§21 Product workflow runtime and the step execution edge (Conductor integration)") |
| Authorizes | Authoring of Specification v0.5 only. No implementation, no production change, no edit to any v0.4 document. |

## 0. The lesson that drives this generation

Six consecutive design-review rounds on the Conductor integration (PRs #199–#204, each adding and each
withdrawing a ~127-line-and-growing TD §21) surfaced a **new contract gap every round** — step-type
allowlists, executor profiles per step kind, execution receipts, the `WORKFLOW_EXECUTOR` surface role,
`events.jsonl` recovery semantics, run-capability inheritance, a four-stage rollout. The failure was not
any single gap. It was structural: **constitutionalizing another product's runtime makes CADP's contract
surface grow with every orchestrator feature.** Every step type, retry rule, and plugin reference of the
workflow engine became a CADP liability that a review round could — correctly — flag as ungoverned. A
constitution that must enumerate its orchestrator's internals can never close.

The correction is to narrow CADP to the authority/effect boundary. That narrowing is this generation.

## 1. The boundary principle (first sentence of the generation)

**How a workload worked is its orchestrator's business; the moment it changes the external world, it is
CADP's business. CADP governs effects, not execution.**

This is already latent in v0.4 — Spec §8 puts the durable workflow engine, retry scheduler, and agent
runtime outside the kernel; TD §7.1 says "Temporal history is never read as authority; kernel rows are."
v0.5 promotes it from a commodity-list consequence to the constitution's opening sentence, and applies it
to CADP's *own* product services just as strictly as to third-party orchestrators.

## 2. Three control planes, connected only by API contracts

1. **Workflow Plane** — reference: Microsoft Conductor (v0.4's reference was Temporal, TD §11; both are
   replaceable commodity, per Spec §8 item 2). Owns roles, routing, retry, checkpoint, context,
   DAG/step graphs. Its history, events, and queues are **never authority** (TD §7.1 rule, generalized).
   CADP names no Conductor concept: no step type, no executor kind, no plugin, no event log format.
2. **Execution Plane** — the existing surface broker (`cadp/product/surfaceBroker.ts`), provider
   adapters (TD §17: `workerProviders.ts`, `reviewProviders.ts`, `planProviders.ts`), executor/worker
   profiles and isolation postures (TD §17.1–§17.2, `cadp/product/isolation.ts`), and session scanning
   (TD §19.3, `model_scan`). This is a **CADP product service** with its own declarative contract: an
   `ExecutionRequest` of `{profile_digest, provider, input_digests}` returning artifacts and evidence.
   It holds model-subscription custody (TD §17.3 `oauth_env` / `auth_files` injection) as its **internal
   discipline** — that custody is real engineering, but it is **not part of the authority boundary**,
   because model subscriptions are not governed-target credentials. The Execution Plane is **optional
   per deployment**: a deployment may bring its own surfaces and still be fully governed.
3. **Authority Plane** — the constitutional kernel and the **only constitutional territory**: K1–K7
   (Spec §4), exact binding (Spec §2.4), evidence semantics (Spec §7, §5.4), credential custody for
   governed targets (Spec §2.3; TD §4), admission and commit-time fresh recheck (Spec §5; TD §3.4,
   §4.4), PEP-only actuation, effect identity, and reconciliation (Spec §6; TD §6). Today this is
   `cadp/kernel/`.

The planes talk only through API contracts (the Authority Plane's twelve-call surface, TD §12, plus the
Execution Plane's `ExecutionRequest`). No plane reads another plane's internal state as truth.

## 3. Core / profile split

**Kernel Conformance is the core and is unchanged from v0.4.** Spec v0.4 §8.1 (Constitutional Kernel
Conformance: K1–K7 plus §13.1–§13.3 controls) carries into v0.5 with the same semantics. Decision 8
below forbids touching it.

**The v0.4 "CADP Autonomous-Work Product Conformance" (Spec §8.2) is demoted to an optional
composition profile — the "run profile."** Its contents: `WORK_START` admission (Spec §8.2's
policy-authorized work start; TD §7.2), work-run-bound effect counting (`max_effects` enforced by the
PEP via `MAX_EFFECTS_IN_WORK_RUN`, TD §7.3), and step evidence (`WORK_STEP` / `WORK_BOUND_STOP`,
TD §7.4). A deployment chooses the profile or not.

**What a profile-less deployment loses — stated explicitly:** it is governed **per-effect only**. Every
mutation still passes the full K1–K7 gate, but (a) there are **no run bounds** — no `max_effects`
ceiling, no work-run deadline tied to a `WORK_START` material, because there is no work run the kernel
knows about; and (b) there are **no step-evidence-dependent gates** — policies like the v0.4 merge
gate's implementer-set derivation, which reads the run's `BACKEND_EXECUTION` and `WORK_STEP` envelopes
to prove reviewer independence (TD §17 preamble, §17.4), cannot be expressed, because the evidence they
consume is profile machinery. Independence predicates then have only per-effect envelopes to work with.
That trade is the deployment's to make; the constitution no longer makes it for them.

## 4. The §7 bisection (what makes the split precise)

TD §7 (D7 — autonomous-work product composition) contains two different kinds of machinery, and v0.5
bisects it along the boundary principle:

- **Workflow durability — belongs to the orchestrator (profile machinery at most):** continuation
  identity and restart convergence (TD §7.4's `work_run_ref` + `step_ordinal` scheme), replay-idempotent
  `WORK_STEP` ingress and the `allocation_key` replay contract (TD §7.4), `max_steps` and the deadline
  the workflow itself enforces (TD §7.3: "the kernel does not count steps"), and step chaining
  (`prior_step_envelope_digest`). v0.4 already assigned enforcement of `max_steps` to the commodity;
  v0.5 finishes the thought: the *specification* of these mechanisms leaves the constitution too.
- **Authority — stays kernel/policy business inside the run profile:** work-bound admission
  (`WORK_START` as a governed effect, TD §7.2) and work-run-bound effect counting (`max_effects`
  counted by the PEP over `effect_request` rows carrying `work_run_ref`, TD §7.3). These bound what a
  run may do to the world, not how it survives a restart — so they are authority.

TD §7.3's own sentence is the seam: "`max_steps` and `max_effects` are distinct bounds… the kernel does
not count steps." v0.5 turns that sentence into the profile's border.

## 5. Effect-boundary integration — the only mandatory contract with any workflow plane

The **entire** mandatory integration between any workflow plane and CADP:

- **Mutation intents arrive as `EffectRequest`s through an effect client.** A workflow step that wants
  to change the world calls the effect client (today: the TD §12 calls `allocate_effect_id` →
  `seal_effect_request` → `assemble_admission_input` → `evaluate` → `admit_and_dispatch`). Nothing else
  about the step is CADP's concern.
- **Evidence requirements are artifact-bound, not step-lifecycle-bound.** The proof that the thin
  boundary loses no authority-critical evidence already exists in v0.4: the development gates consume
  `REVIEW`, `VERIFICATION`, and `BACKEND_EXECUTION` envelopes whose `subject_bindings` name the exact
  `candidate_sha` (Spec §5.4; TD §8.2–§8.3 review-to-effect subject equality; TD §18.3 verification
  bound to the exact candidate sha) — **not** any step lifecycle state. The gates never needed to know
  what step produced the artifact; they needed to know evidence was bound to it. That is why removing
  step lifecycle from the constitution removes no gate input.
- **Credential custody:** workflow and execution planes hold **zero governed-target credentials**. The
  PEP remains the only actuator (Spec §2.3; TD §4.1). This is the v0.4 invariant restated per-plane.
- **Tool lanes:** read/pure tools are unconstrained by CADP — reading is not an effect. Mutating tools
  are **credential-less shims that seal `EffectRequest`s**: the tool call produces a sealed request and
  waits on kernel rows; it never carries a credential and never touches the target. (The withdrawn §21.5
  tried to solve this with "bounded effect slots" inside the runtime; the lane rule replaces it with no
  runtime coupling at all.)

## 6. Two analogy caveats, stated as constitutional distinctions

The Kubernetes analogy motivates the three-plane shape (commodity data plane, replaceable schedulers, a
small API-server-like authority core) — and misleads in exactly two places, which v0.5 states as
constitutional distinctions, not footnotes:

1. **CADP reconciliation is epistemic, not level-triggered.** A Kubernetes controller converges: it
   keeps making desired state so, and re-issuing an action is normal. CADP's reconciler exists to
   **resolve `UNKNOWN` by target-authoritative reads** (Spec §6.1: blind retry forbidden; K7 truth from
   the target, TD §6.3, §6.5). It is exactly-once-with-proof: it may read forever, but it never re-fires
   an effect to "make it so." A CADP that converged would be a CADP that blind-retried.
2. **The constitutional store is sealed history, not desired state.** Kubernetes' store holds mutable
   specs that controllers drive reality toward. The CADP store is append-only sealed records —
   requests, decisions, admissions, outcomes, evidence (TD §2.4, §3.2) — **consumed by gates**, never a
   desired-state document that any controller converges on. Nothing watches the store to act; the PEP
   writes to it before acting (TD §3.4).

## 7. Disposition of the v0.4 corpus

- **Spec v0.4 and TD v2.0 remain the valid record of the current generation.** No patching-as-
  continuity — the same rule Spec v0.4 §12.1–§12.2 and the TD header ("Not a revision of TD v1.5")
  applied to the v0.3 → v0.4 transition. v0.5 is a new document with its own authority, not an edit.
- **TD §17–§19 are re-homed as the Execution Plane's product-service contracts:** provider registries
  and measurement-first capabilities (§17), the external verification backend and broker read (§18),
  and surface execution observability / session scanning (§19). Their content survives; their address
  changes from "sections of the constitutional TD" to "the Execution Plane service's own contract."
- **TD §20 (guarded deployment actuation, `DEPLOY` / `cadp.deploy.v1`) stays Authority Plane:**
  restarting gate processes is an effect on the world's most sensitive target — the gate itself — and
  its Human-only admission (§20.2) is authority, not execution.
- **The withdrawn Conductor-integration §21 is replaced, under this generation, by the effect-boundary
  integration of decision 5** — a contract a fraction of its size (an effect client, the lane rule, and
  the zero-credential rule), because everything §21 enumerated about step types, executors, receipts,
  and event logs was Workflow or Execution Plane business.
- **The development vertical is re-described as the reference composition:** run profile + Execution
  Plane services + Authority Plane. It stays the required reference domain (Spec §10.1) and stays
  non-central (Spec §10).

## 8. What v0.5 must NOT do

- **No new kernel primitives.** K1–K7 is the complete constitutional vocabulary; v0.5 adds no K8.
- **No absorption of any orchestrator lifecycle** — not Conductor's, not Temporal's, not a future
  engine's. No step type, checkpoint format, retry rule, or event schema enters the constitution.
- **No evidence kinds whose only consumer is a workflow engine's internals.** An evidence kind exists
  only if a policy gate consumes it. (The §21 execution receipts failed exactly this test.)

## 9. Generation transition plan

1. **Author Specification v0.5 from this design** — the same pattern as v0.4 (spec-design → spec), with
   the boundary principle as its opening sentence and the three planes as its structure.
2. **Regenerate the TD structure by plane:** an Authority Plane TD (successor to today's §1–§16 + §20),
   an Execution Plane service contract (successor to §17–§19), and a thin effect-boundary integration
   note per workflow plane. Each plane's document cites only its own plane's internals.
3. **Migration is re-homing and re-labeling of existing code, not a rewrite.** `cadp/kernel/` is
   already the Authority Plane. `cadp/product/` splits by ownership: broker/providers/isolation/
   scanning become the Execution Plane service (`product-execution`); workflow-facing pieces
   (`workflows.ts`, `activities.ts`, the effect-client path) become integrations. The store, records,
   PEP, and reconciler do not change.
4. **Existing live environments remain v0.4-generation until a v0.5 genesis.** Same discipline as TD
   §10 (new namespace, new genesis, no promotion, no import of old rows) and as the live2–live8
   practice (TD §20.1): a new constitution is a new environment, guarded by the existing genesis
   refusal (`cadp/kernel/genesis.ts`), never a mutation of a running one.

## 10. Review focus (for the reviewer of this document)

Verify every claim above against the v0.4 corpus at `base_sha`: Spec v0.4 §2–§8, §10–§12; TD §7, §9,
§12, §17–§20; the six closed §21 candidates (PRs #199–#204). Confirm the document contains: the boundary
principle (§1), the three planes (§2), the core/profile split with the profile-less loss statement (§3),
the §7 bisection (§4), and **both** analogy caveats (§6). List the contracts you checked.
