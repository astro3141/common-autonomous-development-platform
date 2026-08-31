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
tests       1099 / 1099 PASS      (baseline 1045; +54, no test deleted to pass)
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
`foreign_key_check`). START_SUBFLOW admission links the child to the batch's unique in-flight
parent and suspends an ACTIVE parent in the same transaction; an ambiguous parent is a durable,
observable refusal (no guessed parent — see §3 below). Automatic parent resume when every child
COMPLETED; explicit RESUME_PARENT and DEFER_TASK are applied decisions. Coordinator: multi-task
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

- **CONTRACT_AMBIGUITY — subflow parent binding.** `TaskSelectionProposalV1` has no parent field
  and the TD defers START_SUBFLOW lifecycle application without fixing the parent linkage. The
  implementation uses the only deterministic reading available (Spec §47 + V11): the parent is the
  batch's **unique** in-flight admitted task; when that is not unique, nothing is admitted and the
  refusal is a durable observation (`subflow_parent_unresolved`). Governance may later fix an
  explicit parent reference (likely a ProposalV2 field); the current behavior invents no authority
  and fails closed on ambiguity.
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

## 5. The candidate

```text
branch: integration/adp-fixed-point
base:   9ccbe61a388842d663b0c41bd7801186e6471225 (canonical main)
```

The human decides the merge. Live-pilot readiness still requires RA-4 C1–C5 remediation on a
patched Backend v1 cell; nothing in this branch weakens that gate.
