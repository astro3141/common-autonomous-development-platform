# CADP architecture evolution and bootstrap rationale

This is a historical record of what this checkout actually contains. It is not architecture
authority (`Authority order.md`: Spec v0.4 > TD v2.0 > `cadp/` implementation). It does not
invent GitHub close-states; issue numbers below are those the documents themselves name.

---

## 1. What v0.3 was and what it proved

v0.3 (`Common Autonomous Development Platform — Specification v0.3.md`, TD v1.5
`TECHNICAL_DESIGN_autonomous_development_platform.md`) was a **development-supervision control
plane**, not a coding-agent product. Spec §1–§5: reuse Runtime / workflow / Git / CI; own only
project meaning, automation authority, execution contracts, verification evidence, and human
judgment. The spine was:

```
Project Profile + Execution Policy → Compiled Profile → Supervisor Model
  → structured Proposal → Platform validation → CapabilityGrant
  → Actor RuntimeSession → Platform Verification → Independent Auditor
  → Repository Gate / Human Decision
```

Fixed Core roles were Supervisor / Actor / Auditor. Backend v1 mapping (TD §1, `PLATFORM_BACKEND_CAPABILITY.md`)
was OpenClaw as `RuntimeAdapter`, durable-jobs as `WorkflowAdapter`, local Git, local verifier,
Slack report, `ProjectDocumentTaskSource`. The model runner behind durable-jobs was **AGY-only**
(`agy-json`); a Claude Actor ran as `generic_local`, not a first-class structured runner.

**What the STATUS / PREFLIGHT snapshots actually sealed:**

| Record | Verdict | Bound |
|---|---|---|
| `STATUS_workflow_harness.md` | Backend v1 ready; original P3-H 10/10 **not** complete (audit-continuation deferred) | durable-jobs `0.6.0-dev.6`, 389/389 tests |
| `STATUS_common_platform_mvp0.md` | MVP 0 **FORMAL COMPLETE** (Spec §64 A1–A5) | 524/524 tests, `dependencies: {}`, schema v2 / 14 tables. **No** real runtime, workflow, repo mutation, or verification had run. |
| `STATUS_common_platform_mvp1.md` | MVP 1 **FORMAL COMPLETE**, `MVP1_LIVE_PILOT_READY = NO` | 1034/1034 tests, schema v6 / 17 tables, ProductionCoordinator E2E on **test doubles**. RA-4 contract CLOSED, live preflight `BLOCKED(C2–C5)`. |
| `PREFLIGHT_composition_root.md` | composition root = ordinary dependency wiring; six IGs, IG-1 later implemented (PR #33) | RuntimeAdapter / WorkflowAdapter / Report / MCP ingress still **MISSING** at survey time |
| `HANDOFF_common_platform_mvp1_live_pilot.md` | live pilot **NOT READY**; RA-4 `BLOCKED(C2,C3,C4,C5)` | do not bypass; do not weaken Platform policy to pass |
| `STATUS_integration_adp_fixed_point.md` | MVP 2–4 + v1.5 operability **IMPLEMENTED** on `integration/adp-fixed-point` | 1140/1140 tests; live OpenClaw/durable-jobs **NOT RUN**; RA-4 still `BLOCKED(C1..C5)` and fail-closed (zero external INTENT) |

Bootstrap of CADP *itself* was a separate GitHub-issue loop, not Core:

- `.issue-orchestrator/` (commit `58b9fa1`): `backend` / `reviewer` / `designer` role prompts and
  `default.yaml` scoped to milestone `MVP1 Live Pilot — Production Integration`. Agent worktrees
  seed from a git ref, so prompts had to be tracked.
- `devharness/` (README, `LIVE_PROOF.md`): a **standalone** GitHub-backed supervisor
  (deterministic `transitions.ts`, Fable actor, Codex reviewer, human merge only). It imports
  none of K1–K7. Live proof 2026-09-04 on a disposable repo; CADP #65 dry-run was read-only.

v0.3 therefore proved a **backend-independent Core** (no OpenClaw, no infra-scanner, no ACP id,
no `READY_ITEM` in the lifecycle) and a formally complete Supervisor→Human-merge spine against
doubles. It did **not** prove exclusive credential custody, target-authoritative effect
reconciliation, or a live Backend v1 path.

---

## 2. Why the restart

Spec v0.4 is explicit: it does **not** shrink-copy the autonomous-development Core. TD v2.0 is
**not** a revision of TD v1.5 (`TECHNICAL_DESIGN_cadp_v0_4_generation.md` header; §14:
HISTORICAL_OLD_GENERATION). The measured remainder after #89 (`CADP_SURVIVING_KERNEL`) was four
irreducible boundaries, not Task/Attempt/Profile/Supervisor:

1. one policy decision bound to **one** exact effect identity, with an enforcement point that
   refuses any other effect;
2. an effect-identity ledger written **before** the external call, reconciled against a
   **target-authoritative** read;
3. evidence bound to the artifact it was executed against, not merely labelled with its id;
4. custody of every governed mutating credential **outside** every worker / reviewer / verifier /
   workflow context.

The Supervisor / RuntimeAdapter architecture could not deliver those:

- **Platform owned a workflow framework.** Spec v0.3 Core assets (Profile Compiler, Task/Batch
  state machine, Capability Broker, PendingHumanDecision, Repository Gate) made Issue / branch /
  PR / Supervisor / Actor / Auditor into Core primitives. Spec v0.4 §1: they are not. §11
  **DROP**s Supervisor/Actor/Auditor as Core roles and **COMMODITIZE**s Runtime/Workflow/
  Verification/Repository adapters and task/batch state.
- **ALLOW was mixed with lifecycle.** v0.3 Decision Validator + CapabilityGrant authorized a
  *role session*. Spec v0.4 §2.2: `policy ALLOW ≠ external effect authority`. Only the PEP
  admits, and only for one sealed `EffectRequestV1`.
- **Credential reach was not exclusive.** RuntimeAdapter spawned Actor/Auditor sessions on
  OpenClaw; Capability Manifest `receipt_supported=false` was honest but meant enforcement was
  configuration intent, not a per-spawn receipt (`PLATFORM_BACKEND_CAPABILITY.md` §3). Spec v0.4
  §2.3: prompt / role label / sandbox name / worker self-report is not isolation evidence. Live
  RA-4 never went READY, so the exclusive-reach claim was never measured on Backend v1.
- **Requested was treated as actual.** Backend Capability Manifest and SupervisorProposal
  freshness could be omitted by the model (TD v1.5 #60 amendment). Spec v0.4 §2.1/§7.2 and TD
  §9.2: requested values are never copied into observed facts (#91 T5 / C13).
- **Evidence was adapter-labelled, not subject-bound.** v0.3 VerificationAdapter produced
  lifecycle facts. v0.4 K2 envelopes bind `subject_bindings` + producer + provenance; a review
  of commit A cannot admit an effect naming B.
- **The live backend was a packaging wall, not a missing batch.** HANDOFF / STATUS_mvp1: RA-4
  `BLOCKED` on OpenClaw dist / `@openclaw/acpx` / patched plugin-tools. STATUS_integration: the
  fail-closed boundary held (zero INTENT) — which is honesty, not a product path.

Cutover is a new namespace, not a migration (Spec §12, TD §10): schema `k04`, Temporal
`cadp-v04`, no promotion of v0.3 Grant / TaskContract / INTENT into a v0.4 admission. Semantic
invariants that *were* proven (model output is proposal; capability is an enforceable boundary;
worker self-report is not verification; no silent substitution) are kept as negative controls,
not as schemas (Spec §12.3).

---

## 3. The v0.4 shape today

Layout (`README.md`, `cadp/`): a thin constitutional kernel plus commodity composition.

| Layer | What it is | Files |
|---|---|---|
| K1–K7 records | PolicyRef, EvidenceEnvelope, EffectRequest, AdmissionInput, PolicyDecision, EffectAdmission, EffectOutcome | `cadp/kernel/records.ts`, `store.ts`, `cas.ts`, `ingress.ts` |
| PEP admission | sole credential holder; durable admission **before** dispatch; rechecks #1–#17; target-authoritative K7 | `cadp/kernel/pep.ts`, `reconciler.ts` |
| OPA evaluation | sidecar; ALLOW is computation, not a permit; evaluator failure seals **no** K5 | `cadp/kernel/evaluator.ts`, `cadp/deployment/referencePolicy.ts` |
| Temporal orchestration | `cadpWork` owns continuation/bounds; never credentials or effect authority | `cadp/product/workflows.ts`, `activities.ts`, `cadp/kernel/adapters/temporal.ts` |
| Surface isolation | Docker `--internal` + allowlist proxy; Seatbelt on activity-host; bounded lifetime (#127/#128) | `cadp/product/isolation.ts`, `timeouts.ts` |
| Provider-adapter matrix | closed unions; unknown names fail closed | worker `codex\|grok\|claude`; reviewer/planner `claude\|grok\|codex` (`workerProviders.ts`, `reviewProviders.ts`, `planProviders.ts`) |
| External verification | GitHub Actions `cadp-verify` is an **evidence source**, not lifecycle authority (#57) | `.github/workflows/cadp-verify.yml`, `cadp/product/externalVerification.ts` |
| Execution observability | `observer` caller class; verify-on-read; projections are not records (#96/#106, TD r8) | `cadp/live/observe.ts`, `cadp/product/observationProjection.ts` |
| Guarded CD | `DEPLOY` restarts `{broker, worker}` from a pinned sha; Human on every admission; kernel self-restart is out of band (#58, TD §20) | `cadp/kernel/adapters/deploymentActuation.ts` |

**Governing invariants (load-bearing, not slogans):**

- **Fail-closed honesty.** Missing / stale / contradictory / `UNKNOWN` required facts do not
  satisfy policy (Spec §2.5). Ambiguous accepted calls stay `UNKNOWN` and are never blindly
  retried; `NO_EFFECT_CONFIRMED` needs a target-authoritative proof (C9/C10).
- **Requested vs observed.** `cadp.backend.v1` keeps `requested` and `observed` as separate
  sub-objects. A `PRESENT` observed field needs a locator that replays; Ingress rejects a copy of
  the requested model into observed (C13 / #91 T5). Unmeasured scans stay `UNKNOWN`.
- **Measurement-first capabilities.** Provider argv, auth, `model_scan`, and `effort_scan` exist
  only after a live container probe of **that** surface (`conformance-provider-measurement-gate.test.ts`).
  Devin, signed backend identity, OPA signed-bundle remote path, Temporal multi-worker: unmeasured,
  never assumed (TD §11, U1/U7).
- **Gate-file merge tiering.** `cadp/product/gateFiles.ts`: a delegated `AGENT_DECISION` may
  auto-merge ordinary paths; kernel, policy, isolation, provider registries, conformance,
  `.github/`, Spec/TD/DESIGN documents route to `HUMAN_DECISION` (self-approval of the gate).
  `DEPLOY` is gate-touching **by definition** and never accepts `AGENT_DECISION` (TD §20.2).
- **Reviewer independence.** Policy: `producer_ref` and `identity_class.product` of REVIEW ≠
  implementer. A run whose implementing product matches the delegated merge agent is never
  auto-merged (`README.md`; C12; AD5 in `conformance-delegation.test.ts`).

Production deployment remains **NOT AUTHORIZED**. The live composition is a disposable reference
proof (`README.md`).

---

## 4. What was retired, and why

**v0.3 execution generation (`core/`, `adapters/`, `deployment/`, `testdoubles/`, `tests/`).**
Removed in `93d00e5` (~79k lines). TD v2.0 §10/§14 froze it as HISTORICAL_OLD_GENERATION; nothing
under `cadp/` imported it; the v0.3 composition root had no live deployment. Spec v0.3, TD v1.5,
`STATUS_*`, `HANDOFF_*`, `PREFLIGHT_composition_root.md`, and `PLATFORM_BACKEND_CAPABILITY.md`
remain as evidence only (`Authority order.md`).

**v0.3 issue tracks.** Spec v0.4 §12.1: v0.3 / TD v1.5 / `#85` / `#87` / `#88` / OpenClaw /
durable-jobs are **not** v0.4 architecture authority. TD v2.0 explicitly does not replay `#52` or
touch PR `#83`/`#88`. The MVP 0–4 batches (STATUS_mvp0 B1–B9, STATUS_mvp1 B1–B13, integration
MVP 2–4), Route-A ADP preconditions (`#81`), GitHub vertical (`#70`/`#52`/`#57`/`#78`), and RA-1–RA-4
backend blockers were that generation's work. Control `#65` continues as the v0.4 design-control
issue (TD header), not as a v0.3 Attempt track.

**`.issue-orchestrator/`.** The v0.3-era issue-driven onboarding loop (Claude backend/designer,
Codex reviewer, milestone-filtered graph). It is still tracked so worktrees can seed prompts, but
it is not a CADP component and owns no K1–K7 authority. v0.4 supervision is a commodity session
talking to `cadp/live/mcpServer.ts` — CADP owns no supervisor (`README.md`).

**`devharness/`.** Bootstrap project-operation tooling used to *build* CADP (issue → worktree →
actor → exact-candidate review → human merge). Retired as architecture: Spec §11 DROPs Supervisor
as a Core role; the harness never imported the kernel (`devharness/README.md`). It remains in-tree
(`npm run devharness`) as that bootstrap, not as the product.

**gemini / AGY path.** v0.3's only structured model runner was AGY (`PLATFORM_BACKEND_CAPABILITY.md`).
v0.4 briefly had `gemini` in the closed provider union, then dropped it (`9898aab`, `#61`, inbox
`#147`): off-the-shelf isolation required a pay-per-token API key, and file-token injection was
rejected upstream (`antigravity-cli #479`) — not viable on the subscription. Unknown name
`gemini` now fail-closes (`conformance-workproviders.test.ts` / review / plan suites). The measured
closed set is codex / grok / claude.

**OpenClaw / durable-jobs as Backend v1.** Spec v0.4 non-goals: no v0.3 compatibility facade, no
OpenClaw/durable-jobs special case. They may inform a future commodity adapter only after the
same conformance and credential-reach attestation (TD §10).
