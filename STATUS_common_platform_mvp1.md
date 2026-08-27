# Common Autonomous Development Platform — MVP 1 Implementation Status

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
> file is then wrong and must be corrected. It records what was built and what was proven; it
> introduces no contract, no state, no vocabulary and no decision of its own.
>
> `STATUS_common_platform_mvp0.md` remains the MVP 0 record and is untouched. It does not describe
> MVP 1 and must not be read as doing so.
>
> Last updated: 2026-08-10.

---

## 0. Verdict

```text
Common Autonomous Development Platform
MVP 1 — FORMAL COMPLETE

MVP1_CODE_COMPLETE     YES
MVP1_FORMAL_COMPLETE   YES
MVP1_LIVE_PILOT_READY  NO
```

**Formal complete** means one thing precisely: the Spec §65 path and the Technical Design's
required deterministic implementation of it are closed — implemented, composed by the production
Coordinator, and proven by executable tests, with no Platform-local implementation blocker, no
Platform-local contract blocker and no load-bearing test-evidence gap remaining.

It does **not** mean production ready.
It does **not** mean a real Backend end-to-end run has passed — every Runtime, repository,
verification and report interaction proven here is a deterministic test double.
It does **not** mean automatic merge exists; MVP 1 performs no canonical mutation at all.
It does **not** begin MVP 2.

---

## 1. MVP 1 authoritative scope (Spec §65)

```text
Project Profile
+ Execution Policy
→ Compiled Profile
→ TaskSource discover
→ Supervisor Proposal
→ Decision validation
→ Immutable Task Contract
→ Actor CapabilityGrant
→ Actor RuntimeSession
→ candidate commit
→ Platform-owned Verification
→ Auditor readonly CapabilityGrant
→ Independent Audit
→ FIX_REQUIRED <= policy limit
→ AUDIT_PASS
→ Pending Human Merge Decision
```

```text
automatic merge = absent
```

That is the whole of MVP 1. Nothing from MVP 2 (Safe Automatic Merge), MVP 3 (Subflow /
Hold-next / Batch) or MVP 4 (Long-running Unattended / reconciliation) is in scope, was pulled
forward, or is recorded here as delivered.

---

## 2. Final validation evidence

```text
tests      1034 / 1034 PASS
typecheck  PASS
schema     v6 / 17
```

Schema v6 is migrations v1–v6 (`foundation` / `domain` / `mvp1-artifacts` / `selection-scope` /
`selection-binding` / `audit-decision-category`) over 17 tables. No migration was added by B13 or
by CORR1.

**Production-Coordinator end-to-end evidence.** Both drive the lifecycle exclusively through
`ProductionCoordinator.tickOnce()`; nothing below the Coordinator is stubbed except the four
genuinely external adapters.

```text
happy path   tests/b13-e2e.test.ts:115   B13-30
             discovery → Supervisor request → authoritative Proposal ingress →
             Coordinator activation → Actor → candidate → Verification → Auditor →
             AUDIT_PASS → MERGE_APPROVAL → human APPROVE → manual merge observed →
             Attempt MERGED / Task COMPLETED / Batch COMPLETED / Run COMPLETED

outbox       tests/b13-e2e.test.ts:237   B13-42
             one batch-complete summary; a failing transport leaves the row unsent and
             rolls back no lifecycle fact

FIX_REQUIRED tests/b13-e2e.test.ts:282   B13-31
             candidate A audited FIX_REQUIRED → REWORKING → same Attempt, same Actor
             session, same workspace, same Task Contract, same base → actor-turn:2 →
             candidate B → verification → audit AUDIT_PASS → human merge → completed run

activation   tests/b13-coordinator.test.ts:409/439/465/491
             B13-CORR1-1 .. B13-CORR1-4 (see §3)
```

---

## 3. Implementation batches

| Batch | Scope | Final status | Spec §65 contribution |
|---|---|---|---|
| B1 | Canonical JSON / envelope / digest / identifiers; store foundation (blob, decision log, idempotency, transaction) | FORMAL PASS — SEALED | substrate for every hash-bound artifact |
| B2 | TaskSource contract + `materializeDiscoveryPass` | FORMAL PASS — SEALED | TaskSource discover |
| B3 | RepositoryAdapter interface + LocalGit implementation | FORMAL PASS — SEALED | candidate commit, repository authority |
| B4 | Decision Validator V1–V11 + Proposal ingress/admission | FORMAL PASS — SEALED | Supervisor Proposal, Decision validation |
| B5 | Activation: selection-binding gate, repository-scope resolution, Task Contract, both CapabilityGrants | FORMAL PASS — SEALED | Immutable Task Contract, Actor + Auditor CapabilityGrant |
| B6 | Actor workspace / spawn / first turn (§19.3e) | FORMAL PASS — SEALED | Actor RuntimeSession |
| B7 | `IMPLEMENTING → VERIFYING`: candidate authority, verification start | FORMAL PASS — SEALED | candidate commit → Platform-owned Verification |
| B8 | Verification evidence model + workflow tool seam (adapter side) | FORMAL PASS — SEALED | Platform-owned Verification |
| B9 | Verification completion + evidence gate + recovery classification | FORMAL PASS — SEALED | Platform-owned Verification |
| B10 | Auditor launch + §11 stage-boundary drift gate | FORMAL PASS — SEALED | Independent Audit |
| B11 | Auditor verdict collection + audit decision + settlement | FORMAL PASS — SEALED | FIX_REQUIRED / AUDIT_PASS / HUMAN_REQUIRED |
| B12 | Human Merge: approval request, application, repository merge observation | FORMAL PASS — SEALED | Pending Human Merge Decision; no automatic merge |
| B13 | Production Coordinator, bounded rework loop, Supervisor session, report delivery, batch + run completion | FORMAL PASS — SEALED (re-sealed after CORR1) | composes the whole spine |

### B13 — seal history, recorded as it happened

```text
initial B13 seal invalidated:
activation was not Coordinator-wired and E2E directly bypassed it.

CORR1:
SELECTED + no Attempt now dispatches activateSelectedTask through tickOnce.
direct E2E activation bypass removed.

B13 then re-sealed.
```

Detail, so this is auditable rather than tidy: `#advanceTask` originally returned as soon as it
found no current Attempt, so a `SELECTED` task was never advanced; the E2Es called
`activateSelectedTask` directly through a fixture wrapper and reached a completed run anyway. The
original B13 report's claim that activation was Coordinator-wired was therefore false, and the
seal it carried was invalid. CORR1 added the dispatch branch ahead of the Attempt requirement
(`core/coordinator/production-coordinator.ts:178`, `#activate` at `:222`), deleted the fixture
wrapper and all three direct calls, and added four focused tests: activation through one tick, no
duplicate activation on a second tick, stale selection → `HELD(SELECTION_STALE)` with no Attempt
and no Contract/Grants, and a source guard that the Coordinator calls the use-case without
duplicating any of its internals. The Coordinator supplies only caller-allocated identities and
the declared Contract Source bytes; the selection-binding gate, scope resolution, §12.7
compatibility recheck, both Grants and the transition all remain inside the sealed use-case.

---

## 4. Contract close-outs

```text
M1-11 CLOSED — FINAL
M1-12 CLOSED
M1-13 CLOSED — FINAL
M1-14 CLOSED — FINAL
M1-15 CLOSED — FINAL
```

| | Purpose (one line; the TD is the definition) |
|---|---|
| M1-11 | §11 stage-boundary drift: observation assembled from authoritative reads, never an injectable outcome. |
| M1-12 | Drift *cause* lives in the transition/attempt provenance; the task's current *blocker* is always `BLOCKED_BY_DECISION:<id>`. |
| M1-13 | Auditor verdict collection and the audit decision: candidate-qualified operation identity, one retry per candidate, settlement through the VerificationAdapter. |
| M1-14 | Human Merge contract: approval is permission, `MERGED` is a repository fact, and §17.3's gate revalidation is not reused for it. |
| M1-15 | Supervisor spawn/turn operation identities and the run-completion classification B13 depends on. |

---

## 5. Final architecture acceptance

Verdicts from the post-CORR1 read-only close-out.

```text
Profile / Policy boundary                PASS
Compiled Profile                         PASS
TaskSource                               PASS
Proposal authority                       PASS
Supervisor Runtime                       PASS
Decision validation/admission            PASS
Activation                               PASS
Immutable Task Contract                  PASS
Capability                               PASS
Actor Runtime                            PASS
Repository candidate authority           PASS
Platform-owned Verification              PASS
Independent Auditor                      PASS
FIX_REQUIRED bounded rework              PASS
Audit settlement                         PASS
Mandatory Human Merge Decision           PASS
Human approval != merge                  PASS
Repository-authoritative merge observed  PASS
Batch completion                         PASS
Run completion                           PASS
Report Outbox                            PASS
safe-held exceptional decisions          PASS
stateless/bounded Coordinator            PASS
write-ahead INTENT invariant             PASS
identity/secret boundary                 PASS
architecture independence                PASS
```

```text
B13 candidate-cycle correction C1 VALID
B13 candidate-cycle correction C2 VALID
B13 candidate-cycle correction C3 VALID
```

C1 — an unfinished verification run for another candidate still blocks a second open run; a
historical `DONE` run for a superseded candidate does not.
C2 — completion requires `op:<attempt>:verify:<current candidate>` specifically, neither accepting
an old candidate's `DONE` nor requiring exactly one verify per Attempt.
C3 — the re-computed gate and the `AuditorReviewContext` both see the current candidate's evidence
only; earlier rows stay immutable and cannot contaminate a later cycle, and duplicate `check_id`
within the current candidate still reads as `AMBIGUOUS`.

---

## 6. Successful deterministic endpoint

```text
Attempt MERGED
Task    COMPLETED
Batch   COMPLETED
Run     COMPLETED
```

Proven with deterministic adapters (`tests/b13-e2e.test.ts` B13-30 and B13-31).

**It has not been proven on the live Backend.** No real Runtime session, verification run,
repository mutation or report delivery has been executed by this Platform.

---

## 7. Intentionally safe-held MVP 1 endpoints

```text
AUDIT_DECISION
REATTEMPT_DECISION
CONTRACT_DECISION
RECOVERY_DECISION
```

The Platform opens these decisions correctly and blocks the task on them. Applying a resolved one
is **not implemented** in MVP 1: the Coordinator applies only `MERGE_APPROVAL`, and every other
category is left exactly where it is — no guessed resolution, no new Attempt, no Actor launch, no
merge, no state bypass.

This is accepted safe-held behaviour, not missing MVP 1 work. Spec §65's spine terminates at the
Pending Human Merge Decision; resuming from the other categories is a lifecycle rule the TD does
not yet define, and inventing one would be inventing architecture.

`HUMAN_GATE_APPROVAL` application remains optional for the AUTO_EXECUTE pilot path — the mechanism
exists at the Proposal ingress (§17.3 revalidation) and is tested, but Spec §65 requires no
pre-execution human gate, so it is not needed for formal-complete acceptance. The mandatory human
boundary MVP 1 does require is the Merge Decision, and that is implemented.

---

## 8. Non-blocking implementation observations

Recorded separately from blockers, because they are not blockers.

### O1 — production composition root absent

```text
Core contracts/use-cases implemented.
Production dependency composition / executable bootstrap root not yet built.
Tests assemble the dependency graph through test fixtures.
```

```text
PILOT / DEPLOYMENT PREREQUISITE
NOT Platform architecture blocker
NOT reason to revoke MVP1 FORMAL COMPLETE
```

The pilot must supply:

```text
run bootstrap
profile load/compile
TaskSource construction
discovery/materialization invocation
production Coordinator dependency graph
caller-driven tick invocation
MCP/API ingress
```

This is dependency wiring over existing sealed exports (`bootstrapRun`,
`materializeDiscoveryPass`, `compileProfile`, `ProductionCoordinator`, `submitProposal` and the
adapter implementations). It is not MVP 2 and must not be treated as such.

### O2 — Verification run adapter metadata rework crash case

```text
adapter_metadata verification run reference is not candidate-qualified.

Crash window:
candidate B verify INTENT exists before B backend start,
while historical candidate A run handle remains available.

Recovery could conservatively associate A's run observation with B.
Evidence target binding then fails closed; false PASS is not possible.
```

```text
KNOWN NON-BLOCKING FAIL-CLOSED LIVENESS RISK
```

Concretely: `completeVerification` computes `binding_valid` from
`evidence.target_commit === confirmed_candidate`, so every item of a mismatched run is stored
unbound and the gate fails to `VERIFICATION_FAILED` — costing a rework cycle, never producing a
false pass. Not fixed here. Escalate only if the live pilot demonstrates practical impact.

---

## 9. Backend separation

```text
OpenClaw + durable-jobs
= replaceable Backend v1
≠ Common Platform
```

The long-lived asset is the deterministic Common Platform Core. Neither backend was modified to
satisfy Platform architecture, and neither may be. Core carries no backend vocabulary: a scan of
`core/` for `sessionKey`, `AcpRuntime`, `durable-jobs`, `OpenClaw`, `plugin-tools`,
`PROJECT_STATUS`, `READY_ITEM`, `infra-scanner` and ACP identifiers returns nothing outside the
one module whose job is naming the forbidden key categories.

The original P3-H deferred continuation validation (H3/H4/H8 and the same-Supervisor
auto-continuation smoke) is **Backend quality validation only**. Per Spec §66 it is explicitly not
an MVP 1 Architecture Gate, and it does not block MVP 1 formal completion.

---

## 10. RA-4 live state

```text
RA-4 contract = CLOSED

live preflight =
BLOCKED(C2,C3,C4,C5)
```

The preflight's conditions are defined in TD §30.2 (C1–C7) and are not restated in full here. In
short: C1/C2 are core-dist mechanisms, C3/C4 are `@openclaw/acpx` installation and behaviour, C5
is the resolved core entry actually pointing at the patched implementation, C6 is an explicit
permission mode, and C7 is provenance recording. `READY ⟺ C1–C6 pass`.

```text
CLOSED != READY
```

`CLOSED` means the preflight **contract** is settled. The currently measured live install fails
C2, C3, C4 and C5, so the environment is `BLOCKED`.

```text
No Runtime external effect may start before preflight READY.
```

The preflight runs before Supervisor spawn, before the Actor workspace/session, before the Auditor
session and before any verification backend start. It must not be bypassed, and Platform policy
must not be weakened to make it pass.

---

## 11. MVP boundaries

```text
MVP0  FORMAL COMPLETE
MVP1  FORMAL COMPLETE
MVP2  NOT STARTED
MVP3  NOT STARTED
MVP4  NOT STARTED
```

MVP 2 remains Safe Automatic Merge (Repository Gate, required capability and verification
assurance, authoritative lineage, automatic merge).
MVP 3 remains Subflow / Hold-next / Batch.
MVP 4 remains Long-running Unattended / reconciliation.

No MVP 2/3/4 functionality is present in the reachable MVP 1 path: no `prepare_merge` or
`commit_merge` caller exists in Core, no scheduler or subflow engine exists, and no reconciliation
framework or background daemon exists.

---

## 12. Next work

```text
MVP1 LIVE PILOT / DEPLOYMENT PREPARATION

1. production composition root
2. RA-4 C2/C3/C4/C5 remediation
3. preflight READY proof
4. smallest possible Single Task / Human Merge live pilot
5. collect operational findings
```

MVP 2 is **not** recommended and must not be started before real pilot observations exist. The
operational handoff for this work is `HANDOFF_common_platform_mvp1_live_pilot.md`.
