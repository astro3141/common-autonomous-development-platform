# Common Autonomous Development Platform — MVP 0 Implementation Status

> **This file is an implementation status / evidence record only.** It does not define
> architecture and cannot redefine it.
>
> **Architecture authority (unchanged):**
> 1. `Common Autonomous Development Platform — Specification v0.3`
> 2. `TECHNICAL_DESIGN_autonomous_development_platform.md`
> 3. `PLATFORM_BACKEND_CAPABILITY.md`
> 4. `STATUS_workflow_harness.md`
>
> Where this file disagrees with the Specification or the Technical Design, **those win** — this
> file is then wrong and must be corrected.
>
> Last updated: 2026-08-09.

---

## 0. Verdict

**Common Autonomous Development Platform — MVP 0 — FORMAL COMPLETE.**

This means exactly what Spec §64 says it means: the Architecture Core is implemented and the five
MVP 0 acceptance criteria are proven by executable tests. It does **not** mean MVP 1 ready, does
**not** mean production ready, does **not** mean "autonomous development platform complete", and
does **not** mean Backend integration is complete. Nothing in this repository has yet executed a
real runtime session, workflow, repository mutation, verification run or report delivery.

---

## 1. What MVP 0 is (Spec §64)

MVP 0 is the **Architecture Core**: schemas, compilers, validators, durable state, adapter
*interfaces* and minimal deterministic test doubles. Its acceptance is exactly five criteria — no
others were added here:

```text
A1  OpenClaw 없이 Core policy/state tests 가능
A2  infra-scanner 없이 Core tests 가능
A3  ACP identifier 없이 Core state 표현 가능
A4  READY_ITEM 없이 generic Task lifecycle test 가능
A5  Backend capability mismatch를 실행 전에 차단 가능
```

---

## 2. Acceptance result

| Acceptance | Verdict | Primary executable evidence | Supporting area | Meaning |
|---|---|---|---|---|
| **A1** Core tests without OpenClaw | **PASS** | `tests/mvp0-acceptance.test.ts` → *A1 / A2 / A4: a full generic lifecycle runs on Core alone with neutral vocabulary* | `package.json` (`dependencies: {}`); production imports are only `node:crypto` / `node:fs` / `node:sqlite`; `tests/backend-independence.test.ts` → *B1-AC6: Core primitives run with no dependency declared* | The whole task lifecycle runs with no adapter constructed and no backend package installed |
| **A2** Core tests without infra-scanner | **PASS** | `tests/mvp0-acceptance.test.ts` → same test (classifications `IMPLEMENTABLE` / `LARGE_SCOPE` / `SPLIT_NEEDED`, pipelines `standard` / `review_only`) | `tests/backend-independence.test.ts` → *B1-AC6: no Backend or Project vocabulary appears in Core code or fixtures*; per-batch boundary tests for B6–B9 | Project semantics live in the Project Profile, never in Core |
| **A3** Core state without ACP identifier | **PASS** | `tests/mvp0-acceptance.test.ts` → *A3: the durable schema carries no backend or session identity* (reads the real `sqlite_master` SQL) | `tests/store-database.test.ts` → *B2-AC1: foundation data survives close and reopen*; `tests/coordinator-recovery.test.ts` → *B9-AC26: a new Coordinator over the same store returns the same classification* | Run / Task / Attempt state is created, persisted and reloaded with no backend or session identity anywhere in the schema |
| **A4** generic lifecycle without READY_ITEM | **PASS** | `tests/mvp0-acceptance.test.ts` → *A1 / A2 / A4* (`READY → IMPLEMENTING → VERIFYING → AUDITING → READY_TO_MERGE → APPROVED_FOR_MANUAL_MERGE → MERGED`, task `COMPLETED`, batch `COMPLETED`) | `tests/statemachine-transitions.test.ts` (15), `tests/statemachine-batch.test.ts` (8), `tests/store-domain-schema.test.ts` (exact state vocabularies) | Transitions are driven by generic state + typed facts + policy/read-model; no project classification name is a lifecycle condition |
| **A5** capability mismatch blocked before execution | **PASS** | `tests/decision-acceptance-a5.test.ts` (4) — adequate backend accepted; weakened **allow** blocked; weakened **deny** blocked; verdict reproducible with no execution seam | `tests/mvp0-acceptance.test.ts` → *A5: a weakened backend is blocked before execution, on the human-gated path too*; `tests/decision-validator-backend.test.ts` (directional accepted-set, `NOT_YET_AUDITED`, `features` / `receipt_supported` independence); `tests/capability-compatibility.test.ts` (no assurance ranking) | V10 rejects with exactly `BACKEND_INCOMPATIBLE` before any side effect, and a human approval cannot bypass it (TD §17.3) |

---

## 3. Implementation batches

| Batch | Scope | Final status |
|---|---|---|
| B1 | Deterministic Contract Foundation (canonical JSON, envelope hashing, identifiers) | **FORMAL PASS** |
| B2 | Platform Durable Store Foundation (SQLite/WAL, blob, decision_log, idempotency) | **FORMAL PASS** |
| B3 | Adapter Contracts + minimal Test Doubles | **FORMAL PASS** |
| B4 | Project Profile / Execution Policy / Compiled Profile + Compiler | **FORMAL PASS** |
| B5 | Capability Model (Manifest, Broker, Grant, Receipt, compatibility) | **FORMAL PASS** |
| B6 | TaskSource + Immutable Task Contract | **FORMAL PASS** |
| B7 | Supervisor Proposal + Decision Validator V1–V11 | **FORMAL PASS** |
| B8 | Domain Durable State + Task/Attempt/Batch State Machine + PendingHumanDecision | **FORMAL PASS** |
| B9 | Coordinator MVP 0 Shell + local Recovery seam | **FORMAL PASS** |

Per-batch history is not restated here; the closed contract decisions live in TD §30.1.

---

## 4. Final validation baseline

Re-measured in this repository at close-out:

| Check | Result |
|---|---|
| `npm test` (`node --test`) | **524 / 524 pass, 0 fail** |
| `npm run typecheck` (`tsc --noEmit`) | **0 errors** |
| Node | v26.6.0 |
| Runtime dependencies | none (`dependencies: {}`) |

No test was added, modified, skipped or weakened for this close-out.

---

## 5. Store / migration state

```text
schema version = 2
migration v1 = foundation   (blob, decision_log, idempotency, schema_migrations)
migration v2 = domain       (10 tables, TD §18.1a)
tables = 14
journal mode = WAL, single writer, BEGIN IMMEDIATE
```

Deliberately **absent** — current MVP boundary, not a defect:

```text
coordinator_state      Coordinator is stateless by contract (TD §5.6)
recovery_state         MVP 0 recovery is classification-only (TD §22.4)
adapter_metadata       needs a real backend handle to store (MVP 1)
verification_evidence  needs Platform-owned verification execution (MVP 1)
audit_record           needs Auditor execution (MVP 1)
```

---

## 6. Coordinator MVP 0 result (TD §25, M0-33)

Logical surface is exactly three operations:

```text
tickOnce()                 caller-driven single step
observe(workflow_handle)   one WorkflowAdapter.status poll, returned verbatim
recover(run_id)            Platform-owned durable integrity classification
```

Properties held and tested: stateless; caller-driven tick; **no** timer or background loop; **no**
production side effect; **no** production fact assembly; **no** TaskSource materialization; **no**
outbox drain; **no** migration v3.

A `WorkflowObservation` is **not** a transition fact — its `state` / `stage` / `refs` carry
backend-normalized vocabulary and are never interpreted into Core lifecycle meaning (TD §14.2).

The absence of a production Coordinator loop is **MVP 1 integration**, not remaining MVP 0 work.

---

## 7. Recovery MVP 0 result (TD §22.4, M0-34)

```text
RecoveryClassification = CONSISTENT | EXPLAINABLE | UNEXPLAINED
```

`EXPLAINABLE` is reserved for later integration, when authoritative external observations can
explain a projection lag; no MVP 0 path produces it.

MVP 0 `recover(run_id)` scope is **Platform-owned durable integrity only**, reusing the existing
store load / re-hash / invariant paths. Coverage:

```text
compiled profile snapshot (run and each batch)
task contract snapshot
run-bound SUPERVISOR grant
attempt-bound ACTOR grant
attempt-bound AUDITOR grant
terminal TASK    PendingHumanDecision
terminal BATCH   PendingHumanDecision
terminal PROJECT PendingHumanDecision
```

Isolation is tested: a corrupt PROJECT-subject decision belonging to **another** project does not
change this run's classification. There is no external Adapter query, no durable mutation, and no
recovery framework — `UNEXPLAINED` does not itself pause anything.

External Runtime / Workflow / Repository / Verification / TaskSource reconciliation is **later-MVP
scope** (Spec §69), not unfinished MVP 0 work.

---

## 8. Core architecture properties proven at MVP 0

Proven by the deterministic suite:

```text
Core is backend-independent.
Core is project-vocabulary-independent.
Core durable state is ACP-identifier-independent.
Supervisor decisions are Proposals, not execution authority.
Capability mismatch fails before execution.
TaskSource is not Platform lifecycle authority.
State transitions are deterministic and transactionally durable.
Model text is not authoritative execution truth.
same-Supervisor auto-continuation is not a Core dependency.
```

**Not** proven, and not claimed: that a production Runtime actually enforces a CapabilityGrant.
The Platform contract for enforcement (Manifest, Grant, EnforcementReceipt, the V10 gate) exists
and is tested against test doubles; real backend enforcement remains audit-pending — see
`PLATFORM_BACKEND_CAPABILITY.md` and `STATUS_workflow_harness.md`.

---

## 9. Completed contract/state foundation

Reference only; the definitions live in the Technical Design.

| Area | TD reference |
|---|---|
| constrained canonical JSON, JCS subset, SHA-256 envelope hashing | §6 |
| raw Contract Source hashing | §10.2 |
| D+ identifier injectivity | §6.1 |
| Project Profile / Execution Policy separation, Compiled Profile immutable snapshot | §7.1a–§7.7 |
| Approved Override authority binding | §7.2 rule 7, §7.6 |
| Backend Capability Manifest, CapabilityGrant, EnforcementReceipt | §12 |
| TaskSource contract, TaskDefinition, Immutable Task Contract | §8, §10 |
| Decision Validator V1–V11 | §9.2 |
| PendingHumanDecision + post-gate revalidation | §17 |
| Platform durable store, atomic transition and logging | §18 |
| Task / Attempt / Batch lifecycle | §19, §20 |
| Coordinator MVP 0 seam, local recovery classification | §5.6, §5.6a, §22.4 |

---

## 10. Intentionally deferred — not missing

Everything below is out of MVP 0 by Spec/TD scope, not by omission.

| Deferred work | Target |
|---|---|
| TaskSource discovery → durable Task materialization orchestration | MVP 1 |
| production Coordinator scheduling loop (TD §14.2's 30s poll) | MVP 1 |
| production authoritative-fact assembly for the Decision Validator | MVP 1 |
| Supervisor Runtime turn orchestration | MVP 1 |
| Actor session spawn / turn | MVP 1 |
| `RuntimeResultChannel` concrete implementation | MVP 1 |
| Workflow start / resume / `audit_decide` production wiring | MVP 1 |
| real Repository workspace orchestration | MVP 1 |
| Platform-owned verification execution | MVP 1 |
| Auditor session lifecycle | MVP 1 |
| ReportAdapter delivery and `sent_at` handling | MVP 1 |
| Repository Gate execution / merge | MVP 2 |
| automatic merge authority | MVP 2 |
| full Platform ↔ Backend reconciliation | MVP 4 |

---

## 11. MVP boundary

| MVP | Scope (Spec §64–§69) | Status |
|---|---|---|
| MVP 0 | Architecture Core | **COMPLETE** |
| MVP 1 | Single Task / Human Merge | **NOT STARTED** |
| MVP 2 | Safe Automatic Merge | **NOT STARTED** |
| MVP 3 | Subflow / Hold-next / Batch | **NOT STARTED** |
| MVP 4 | Long-running Unattended / reconciliation | **NOT STARTED** |

---

## 12. Backend v1 boundary

```text
OpenClaw + durable-jobs  =  replaceable Backend v1 dependency

They are NOT:
  the Common Platform
  the Common Platform Core
  the MVP 0 implementation
```

MVP 0 was implemented and validated **without** them. Their current state is recorded in
`PLATFORM_BACKEND_CAPABILITY.md` and `STATUS_workflow_harness.md` and is **referenced, not
upgraded, by this document** — in particular the deferred `audit_decide` live round-trip and the
partially-audited runtime capability enforcement remain exactly as those files describe.

---

## 13. MVP 1 backend blockers (TD §30.2)

```text
RA-1  OPEN — MVP1 backend blocker (managed session spawn config / handle mapping / receipt range)
RA-2  OPEN — MVP1 backend blocker (turn completion observation, RuntimeResultChannel path)
RA-3  OPEN — MVP1 backend blocker (WorkflowControllerHandle ↔ trusted controller identity)
RA-4  OPEN — MVP1 backend blocker (backend preflight self-check / packaging)
```

**They do not block MVP 0 close-out**, because MVP 0 is backend-free and validated entirely with
deterministic test doubles (Spec §63). None of them were investigated or resolved here.

MVP 2 blockers are tracked separately (TD §30.3) and are **not** the same as RA-1–RA-4:
capability-enforcement audit, Actor canonical-write denial boundary, merge bypass resistance, and
the optional protected-remote strategy.

---

## 14. Contract close-out state

```text
M0-1 ~ M0-34   CLOSED
M0-35          absent
```

Each record — the gap, the decision, and the TD section that now closes it — is in TD §30.1.

---

## 15. Batch 10

**No Batch 10 implementation was required.**

Spec §64 A1–A5 were already covered directly by executable acceptance tests, and the final
read-only preflight found no production-code gap and no acceptance-test gap. The accurate record
is therefore:

```text
B1–B9                = implementation batches
final MVP 0 close-out = documentation only
```

There is no `Batch 10 PASS`; inventing one would be false history.

---

## 16. Status block

```text
MVP0_STATUS              FORMAL_COMPLETE
SPEC_ACCEPTANCE          A1-A5_PASS
IMPLEMENTATION_BATCHES   B1-B9_FORMAL_PASS
TESTS                    524/524_PASS
TYPECHECK                PASS
SCHEMA_VERSION           2
M0_BLOCKERS              NONE
MVP1                     NOT_STARTED
MVP1_BACKEND_BLOCKERS    RA-1, RA-2, RA-3, RA-4
```
