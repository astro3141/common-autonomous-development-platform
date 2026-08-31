# Common Autonomous Development Platform — Integration Status (`integration/adp-fixed-point`)

> **This file is an implementation status / evidence record only.** It does not define
> architecture and cannot redefine it.
>
> **Architecture authority (unchanged):**
> 1. `Common Autonomous Development Platform — Specification v0.3`
> 2. `TECHNICAL_DESIGN_autonomous_development_platform.md` (v1.5)
> 3. `PLATFORM_BACKEND_CAPABILITY.md`
> 4. `STATUS_workflow_harness.md`
>
> Where this file disagrees with those, they win. This branch was **not merged to canonical
> `main`**; the human decides that. Baseline: main `9ccbe61a388842d663b0c41bd7801186e6471225`.
>
> Last updated: 2026-08-31.

---

## 0. Verdict

```text
tests       1127 / 1127 PASS      (baseline 1045; +82, no test deleted to pass)
typecheck   PASS
schema      v7 / 17 tables        (v7 = subflow-parent: SUSPENDED + task.parent_task_key)

production composition root       PRESENT   (deployment/, runnable entrypoint)
production vertical E2E           RUNNABLE  (3 E2Es over the production composition)
MVP 2  Safe Automatic Merge       IMPLEMENTED
MVP 3  Subflow / Hold-next / Batch IMPLEMENTED
MVP 4  Recovery / Circuit breaker / Monitoring  IMPLEMENTED
v1.5 operability (§5.11–§5.14, §13.2a, §24.1, §7.1d)  IMPLEMENTED

live OpenClaw/durable-jobs execution   NOT RUN  (BACKEND_BLOCKER — no backend install here;
                                        RA-4 preflight measured BLOCKED(C1..C5), fail-closed
                                        proven live: zero external INTENT under BLOCKED)
```

`IMPLEMENTED` means: implemented against the current Spec/TD, composed by the production
Coordinator or composition root, and proven by deterministic executable tests, including the
§15.4 falsification controls listed below. It does not mean live-backend-proven.

## 1. What was added over the MVP 1 baseline

### Production composition + Backend v1 adapters (IG-2..IG-6, PREFLIGHT stages 1–2)

- `deployment/` — config load/validation, `compose()` (all eleven dependency slots, production
  implementations), `openRun()` (compile → bootstrapRun → issueSupervisorGrant →
  materializeDiscoveryPass, restart-resuming via a store-verified pointer), HTTP ingress
  (`/v1/proposals`, decisions resolution/apply-gate, discovery, recover/resume/monitor,
  diagnostics/measurements/findings/routing), `main.ts` entrypoint (compose → open → ingress →
  caller-driven tick → shutdown), §12.3 Backend v1 manifest values (`receipt_supported=false`,
  UNENFORCEABLE canonical-write/merge denial — honest).
- `adapters/openclaw-runtime/` — RuntimeAdapter over the measured RA-1 gateway seam: op-key
  identity + same-op reacquire, RA-2b result-channel arming before the backend turn, receipt-free
  spawn, `TurnNotObservable` fail-closed observation, I-TD12-honest slot retirement, plus a lazy
  production gateway binding that is unreachable while RA-4 is BLOCKED.
- `adapters/durable-jobs-workflow/` — WorkflowAdapter over the `workflow` tool transport (M0-8
  controller placement, fail-closed answers), one-shot MCP subprocess transport.
- `adapters/file-report/` — durable, op_key-idempotent ReportAdapter (§21.1).
- `adapters/backend-v1/` — neutral re-export barrel so tests stay under the I-TD1 guard.

### MVP 2 (TD §14.4/§14.5)

`core/execution/automatic-merge.ts` — Repository Gate strategy A: G1–G5 preconditions from
authoritative facts, §11 merge-boundary drift, §14.5 capability precondition (evaluated fresh at
the gate), write-ahead merge INTENT, observe-or-execute recovery, canonical divergence →
PAUSED_SAFELY. The honest Backend v1 manifests make the Gate refuse (proven), and `commit_merge`
has exactly one production caller (source guard).

### MVP 3 (Spec §47/§48/§68)

Migration v7 (`SUSPENDED`, `task.parent_task_key`; FK-off rewrite with in-transaction
`foreign_key_check`). START_SUBFLOW is validated but not
applied (the parent binding is an unresolved CONTRACT_AMBIGUITY — see §3 below); the sealed
explicit-parent admission linkage suspends an ACTIVE parent in the same transaction and is proven
directly at the state machine. Automatic parent resume when every child COMPLETED; explicit
RESUME_PARENT and DEFER_TASK are applied decisions. Coordinator: multi-task
Supervisor pacing from durable facts, §20.1 WAITING/RESUME through the sealed batch guard.

### MVP 4 (TD §22.2/§22.5, Spec §52/§69)

`production-recovery.ts` (integrity → circuit breaker on corruption; capability re-reconciliation
under the frozen policy with HOLD/PAUSE per `recovery_policy`; category-specific decision STALE),
`commitBatchResumeFromPause` (explicit human exit, reconcile-first), `monitor.ts` (`monitor_once`:
DURABLE_PROGRESS_STALE / INTENT_UNRESOLVED / EXTERNAL_COMPLETION_UNPROJECTED / NEXT_OWNER_MISSING
as `AnomalyObservationV1` with provenance+coverage honesty; observation only, zero actuation).

### v1.5 operability (TD §5.11–§5.14, §7.1d/§7.7a, §13.2a, §24.1)

`core/operability/` — diagnosticPacket (per-field provenance, partial results, I-TD8 next-owner),
measurementPacket (attempt-level aggregate, honest UNKNOWN, deterministic-only §24.1 attribution),
ImprovementFindingV1 (evidence-resolved fail-closed, blob + `finding_recorded` journal, idempotent
replay, supersede chain, presentation collapse, outbox projection), routing recommendations
(read-only, never a policy input), `evaluationInputContext` (honest UNKNOWN until delivery
provenance exists). ProjectProfileV2/CompiledProfileV2 with the Supervisor binding resolved from
the frozen v2 chain (§13.5); the deployment pilot profile is v2. RuntimeTurnResult carries the
optional §13.2a observation; the completed turn's redacted envelope is preserved durably at the
VERIFYING commit.

## 2. Defects found and fixed (with regressions)

- **BUG (sealed source): `IMPLEMENTING→VERIFYING` read `actor_turn:1` unconditionally.** After a
  rework the live turn is `actor-turn:<rework_count+1>` (M1-15); the stale terminal turn-1 result
  could advance the lifecycle while the rework turn was still running (candidate/rework corruption
  risk; test fixtures masked it). Fixed to observe the current turn; regression `OP-7`.
- Guard tests that had encoded "MVP 2/3 not implemented" as invariants were updated to the
  stronger, still-true invariants (exactly one Gate; MVP 3 vocabulary owned by its modules), never
  deleted.

## 3. Contract gaps / interpretations (not silently decided)

- **CONTRACT_AMBIGUITY — subflow parent binding (PR #43 finding 9; not decided).**
  `TaskSelectionProposalV1` has no parent field and the TD defers START_SUBFLOW lifecycle
  application without fixing the parent linkage. An earlier revision applied a "unique in-flight
  admitted task" reading; the independent review correctly classified that as implementation-decided
  contract semantics, and it has been reverted. Current behavior: a START_SUBFLOW Proposal is
  **validated but not applied** — nothing is admitted, no parent is chosen, and the refusal is a
  durable journal observation (`contract_ambiguity_observed`, naming Spec §47 and the proposal
  schema). The sealed mechanisms the resolution will need — explicit-parent admission linkage
  (`subflow_parent_task_key`: child link + ACTIVE parent suspension in one transaction) and
  `commitParentResume` (explicit RESUME_PARENT, child-completion resume) — remain implemented and
  are proven directly at the state machine (B15-3/B15-6). Governance must fix an explicit parent
  reference (likely a ProposalV2 field) before START_SUBFLOW can apply.
- **EXPLICITLY_DEFERRED — non-MERGE_GATE pipelines.** `RESUME_PARENT`/review-only pipeline steps
  remain declared-but-not-executable (M0-30 unchanged): a subflow child completes through an
  ordinary MERGE_GATE pipeline.
- **EXPLICITLY_DEFERRED — applying resolved `AUDIT_DECISION` / `REATTEMPT_DECISION` /
  `CONTRACT_DECISION` / `RECOVERY_DECISION`.** Still safe-held endpoints (MVP 1 STATUS §7): the TD
  defines the questions and their STALE bases but not the re-entry lifecycle rule beyond "a new
  Proposal through the ordinary path", which is available today via reselection/ingress.
- **BACKEND_BLOCKER — live Backend v1 execution.** No OpenClaw/durable-jobs install exists in this
  environment (RA-4 BLOCKED(C1..C5) measured by the production entrypoint, which then performed
  **zero** external operations — the fail-closed boundary held live). The production gateway
  binding and MCP transport are deterministic-tested glue whose live round-trip remains deferred
  backend validation, exactly as PREFLIGHT stage 3 records.
- **§5.14 evaluation harness.** Corpus-as-TaskSource benchmark topology is not built (needs live
  model runs to mean anything); the input-completeness contract is implemented honestly (UNKNOWN).

## 4. Falsification / fault evidence (§15.4 highlights)

```text
honest Backend v1 manifests → automatic merge REFUSED (B14-2)      moved canonical → refused (B14-3)
out-of-scope / forbidden diff → refused (B14-4/5)                  merge crash windows (B14-6/7/8)
weakened backend at restart → HOLD, no silent resume (B16-3/4)     corrupt root → circuit breaker (B16-2)
PAUSED_SAFELY resists resume until reconciled (B16-6)              monitor moves nothing durable (B16-7/8)
result-channel arm-before-turn + unknown slot fail-closed (RTA-3/6) turn-not-terminal → no fabricated result (RTA-4)
current-turn regression (OP-7)                                     restart resumes the same run (ALIVE-3, DEPLOY-3)
finding evidence must resolve; conflicts refuse (OP-5)             ingress+real git full lifecycle (ALIVE-1/2)
```

## 5. PR #43 independent review — disposition of the 18 findings

Every finding from review comment 5479029297 was reproduced at head `b32289d` before any fix, and
every fix carries a regression + falsification control in `tests/pr43-findings.test.ts` (F-numbered)
or the reworked suite tests.

| # | Verdict | Disposition |
|---|---------|-------------|
| 1 | BUG | Production gateway resolves the backend entry via package exports, validates shape before any call, refuses async `ensureSession`/thenable results, requires deployment-supplied `derive_session_input` (I-TD5) — commit `f46cf51` (F1) |
| 2 | BUG | Workflow adapter takes a lazy `controller_binding` provider resolved at call time — `f46cf51` (F2) |
| 3 | BUG | `bootRun` runs §22.2 reconciliation before ingress/ticks; startup logs the classification — `beb7c75` (F3) |
| 4 | IMPLEMENTATION_GAP | Full-width recovery: attempt reconciliation per state (READY INTENT probe, IMPLEMENTING turn catch-up via sealed `startVerification({recovered_turn_loss})`, VERIFYING/MERGING/approved repo+verification probes), external CLOSED sweep, outbox drain, `recovery_pass` journal — `beb7c75` (F4) |
| 5 | BUG | Malformed manifest set → pause + `CAPABILITY_UNAVAILABLE` every pass; never launders to CONSISTENT — `f46cf51` (F5) |
| 6 | BUG | Run discovery is store-authoritative (`activeForProject`); pointer file is written, never read; >1 active refuses — `f46cf51` (F6) |
| 7 | BUG | Report file naming injective (underscore escaped) — `f46cf51` (F7) |
| 8 | BUG | §21.1 exactly-one line across the crash window (`#appendLineOnce` scans by op_key) — `f46cf51` (F8) |
| 9 | **CONTRACT_AMBIGUITY — separated, not decided** | The "unique in-flight parent" reading reverted; START_SUBFLOW is validated-but-not-applied with a durable `contract_ambiguity_observed` entry; sealed linkage/resume proven directly (B15-3/6) — see §3 |
| 10 | BUG | `safe_independent_runnable_exists` judges policy slots, writable slot and fresh HARD deps (TaskSource throw = unsafe) — `172b3f5` (F10) |
| 11 | BUG | Supervisor pacing counts batch-scoped `decision_validation` entries only — `f46cf51` (F11) |
| 12 | BUG | Monitor observes the current rework turn, not the terminal turn-1 — `f46cf51` (F12) |
| 13 | IMPLEMENTATION_GAP | Full §22.5 vocabulary (8 kinds incl. TERMINAL_DIVERGENCE over both merge-pending states), keyed thresholds with `threshold_ref` provenance, `authority_coverage` partial results — `172b3f5` (F13) |
| 14 | BUG | v2 Compiled Profile requires `supervisor_profile`; compose fails closed — `f46cf51` (F14) |
| 15 | IMPLEMENTATION_GAP | Observation schema v2: Core-stamped frozen role chain (§13.2a/§13.5), inline failure attribution; adapter claims never override — `172b3f5` (F15) |
| 16 | IMPLEMENTATION_GAP | §5.14 evaluation units (role×class×binding×assurance×completeness) with per-category measurement refs — `172b3f5` (F16) |
| 17 | BUG | Result-channel separation asserted before any mkdir, via realpath of nearest existing ancestor, both directions — `f46cf51` (F17) |
| 18 | BUG | Finding transition refs resolve only an exact `state_transition` at that seq — `f46cf51` (F18) |

Evidence strengthening beyond the findings: B16-2 now corrupts a real durable artifact (raw SQLite
tamper of `envelope_json` → circuit breaker), and ALIVE-4 proves total backend loss across a
restart: honest waiting while no authority answers, §22.3 R-1 catch-up through the sealed judge,
and the armed result-channel slot forcing `HELD(RECOVERY_CONFLICT)` with **zero** duplicate turns.

## 5a. The candidate

```text
branch: integration/adp-fixed-point
base:   9ccbe61a388842d663b0c41bd7801186e6471225 (canonical main)
```

The human decides the merge. Live-pilot readiness still requires RA-4 C1–C5 remediation on a
patched Backend v1 cell; nothing in this branch weakens that gate.
