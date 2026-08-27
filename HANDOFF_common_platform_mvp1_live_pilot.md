# Common Autonomous Development Platform — MVP 1 Live Pilot Handoff

```text
Common Autonomous Development Platform
MVP1 Live Pilot Handoff

Platform MVP1:
FORMAL COMPLETE

Live pilot:
NOT READY

Current blocker:
RA-4 live BLOCKED(C2,C3,C4,C5)
```

Authority order:

```text
1 Spec v0.3
2 Technical Design
3 Backend Capability Contract
4 Workflow Harness Status
5 STATUS_common_platform_mvp1.md
```

This handoff is operational. It cannot redefine any of the documents above; where it disagrees
with them, they win and this file is wrong.

---

## 1. What already exists

```text
deterministic Common Platform Core
Profile / Policy compiler
TaskSource materialization
Supervisor Proposal validation
immutable Task Contract
CapabilityGrants
Runtime abstraction
Actor lifecycle
Verification
Auditor lifecycle
bounded FIX_REQUIRED rework
Human Merge Decision
manual-merge observation
Report Outbox
production Coordinator tickOnce
Batch/Run completion
```

```text
1034/1034 deterministic tests PASS
schema v6 / 17
```

You do **not** need to read the B1–B13 design history before starting pilot preparation.
`STATUS_common_platform_mvp1.md` plus this file is enough. Reach for the Technical Design when a
specific contract question comes up, not as background reading.

---

## 2. What does NOT exist yet

```text
production executable/composition root
live Backend READY proof
automatic merge
MVP3 scheduler/subflow
MVP4 reconciliation
```

```text
no production-ready claim
```

Nothing in this repository has yet executed a real Runtime session, verification run, repository
mutation or report delivery.

---

## 3. Pilot objective

The first live pilot proves exactly ONE task:

```text
bootstrap
→ discover
→ Supervisor Proposal
→ validation
→ activation
→ Actor
→ candidate
→ Verification
→ Auditor
→ optional FIX_REQUIRED rework
→ AUDIT_PASS
→ MERGE_APPROVAL
→ Human APPROVE
→ human performs repository merge
→ Platform observes merge
→ Task/Batch/Run complete
```

Automatic merge MUST NOT be used.

---

## 4. Pilot task selection rules

Choose the smallest real task available. Required properties:

```text
single repository
single task
no subflow
no new primitive/evidence model
small bounded diff
deterministic verification
clear acceptance criteria
no production credentials/secrets
no automatic merge requirement
```

Prefer a task that can safely be abandoned if the pilot fails. Do not choose a broad refactor for
the first run.

---

## 5. Production composition root prerequisite

Before touching a Runtime, build and wire the deployment composition only.

The composition root instantiates and configures existing production pieces:

```text
Platform Store
Profile source / compiler
TaskSource
RepositoryAdapter
RuntimeAdapter
VerificationAdapter
ReportAdapter
ContractSourceReader
ProductionCoordinator
Platform API/MCP ingress
identity/time injectors
```

Then it invokes the existing run-opening sequence:

```text
create run + single batch
compile/freeze profile
discover/materialize TaskSource
then repeatedly invoke tickOnce()
```

This is dependency wiring.

```text
Do NOT move business logic out of the sealed Core use-cases.
Do NOT build a new orchestration framework.
Do NOT add scheduler state.
```

Every piece the root needs is already exported. The single reference implementation of the whole
dependency graph is the test fixture `tests/support/coordinator-fixtures.ts` — read it as a wiring
map, then build the production equivalent with real adapters. Do not import test fixtures into
production.

---

## 6. Deployment invocation

`tickOnce()` remains caller-driven. A tick is one bounded step: it performs the work durable state
already authorises and returns.

The pilot may put a very small explicit loop or process wrapper around caller invocation if
operation requires it, but that wrapper must NOT become new Platform durable authority.

If an executable runner/service wrapper is necessary, keep it outside Core and make its lifecycle
replaceable.

```text
No durable tick cursor.
No self-authored workflow state.
```

---

## 7. RA-4 gate — mandatory before Runtime effects

Run the existing RA-4 preflight before:

```text
Supervisor spawn
Actor workspace/session
Auditor session
Verification backend external start
```

Current known result:

```text
BLOCKED:
C2
C3
C4
C5
```

Do not bypass. Do not change Platform policy to make it pass.

---

## 8. RA-4 remediation work

Investigate and remediate only the measured deployment conditions (TD §30.2):

```text
C2 core dist contains required workspace-dir propagation mechanism
C3 @openclaw/acpx installed/resolvable
C4 acpx contains resolveOpenClawCoreDistEntry behavior
C5 resolved core entry points to patched plugin-tools serve implementation
```

Preserve the C1 and C6 checks and the C7 provenance record. Prefer a clean, reproducible
installation/package over a hand-edited environment.

```text
Do not mutate OpenClaw/durable-jobs architecture to satisfy Common Platform design.
```

If remediation requires a source patch, classify it explicitly as:

```text
BACKEND DEPLOYMENT GAP
```

and bring it back to the architecture-review session before any broad modification.

---

## 9. Preflight success criterion

Do not proceed until:

```text
C1 PASS
C2 PASS
C3 PASS
C4 PASS
C5 PASS
C6 PASS

RA-4 = READY
```

Record C7 provenance. The output must show concrete observed mechanisms, symbols and resolved
paths — a version string alone is not PASS authority.

---

## 10. Runtime boundary

The Platform stores only opaque, non-secret runtime references. Never put into the Platform DB or
logs:

```text
sessionKey
token
Authorization header
secret environment values
```

The Backend owns trusted identity. The adapter keeps the credential; the Platform keeps the
handle.

---

## 11. Supervisor authority

During the pilot:

```text
Supervisor Runtime text is NOT authority.
```

The only authoritative selection path is:

```text
Supervisor
→ Platform MCP/API
→ structured Proposal
→ deterministic validation
```

Never manually force a Task into `SELECTED` as a shortcut.

CORR1 exists specifically because the deterministic E2E previously bypassed activation and the
resulting report claimed a wiring that did not exist. Do not reproduce that class of bypass in the
live runner: if the runner has to reach past the Coordinator to make progress, that is the
finding, not the workaround.

---

## 12. Human Merge

After AUDIT_PASS:

```text
MERGE_APPROVAL
→ human APPROVE
→ APPROVED_FOR_MANUAL_MERGE
```

That is NOT `MERGED`.

The human then performs the repository merge externally. The Platform only observes canonical
repository state afterward, and a person saying "I merged it" is never an input to any branch.

Never invoke an automatic merge primitive in MVP 1.

---

## 13. Expected normal states

```text
DISCOVERED
→ SELECTED
→ ACTIVE / Attempt READY
→ IMPLEMENTING
→ VERIFYING
→ AUDITING

FIX_REQUIRED:
→ REWORKING
→ IMPLEMENTING
→ ...

AUDIT_PASS:
→ READY_TO_MERGE
→ Task HELD(BLOCKED_BY_DECISION)

Human APPROVE:
→ APPROVED_FOR_MANUAL_MERGE
→ Task ACTIVE

human merges:
→ Platform observes
→ Attempt MERGED
→ Task COMPLETED
→ Batch COMPLETED
→ Run COMPLETED
```

---

## 14. Safe stop states

These are legitimate fail-closed / safe-held outcomes, not faults to route around:

```text
SELECTION_STALE
POLICY_BACKEND_INCOMPATIBLE
RECOVERY_CONFLICT
VERIFICATION_INFRA
AUDIT_UNUSABLE
AUDIT_GATE_UNAVAILABLE
DRIFT_CHECK_UNAVAILABLE
BLOCKED_BY_DECISION:<id>
HUMAN_MERGE_MISMATCH
PAUSED_SAFELY
```

```text
Do not manually edit SQLite to escape them.
Do not retry a possibly accepted Runtime turn.
```

---

## 15. PendingDecision boundaries

If the pilot reaches one of:

```text
AUDIT_DECISION
REATTEMPT_DECISION
CONTRACT_DECISION
RECOVERY_DECISION
```

STOP the autonomous flow. These are accepted MVP 1 safe-held endpoints — the Platform deliberately
has no contract for resuming from them.

Do not invent a resolution procedure in the live session. Bring the case to the
architecture-review session.

---

## 16. Evidence to collect

For every live pilot run preserve at least:

```text
run_id
batch_id
task_key
attempt_key
compiled_profile_hash
task_contract snapshot/hash
base_head
candidate_commit
CapabilityGrant ids/hashes
Supervisor operation keys
Actor operation keys
Verification operation/run ref
Verification Evidence ids
Auditor operation keys
audit_id/verdict
PendingDecision id/category/status
repository HEAD observations
Batch/Run terminal states
Report Outbox state
all reason codes
```

Do not collect raw secrets.

---

## 17. Minimum issue packet when something fails

Before bringing a problem back to the architecture-review session, collect:

```text
 1 current Task state + reason
 2 current Attempt state
 3 last successful state_transition
 4 relevant operation op_key + INTENT/DONE state
 5 base_head
 6 candidate_commit
 7 current canonical HEAD
 8 Task Contract hash
 9 Verification Evidence ids/results
10 audit_id/verdict if any
11 PendingDecision id/category/status if any
12 exact adapter/backend error
13 RA-4 preflight result
14 whether the external side effect may already have been accepted
15 whether Coordinator/process was restarted
```

Do not dump secrets.

---

## 18. Finding classification

Every pilot issue must first be classified as exactly one of:

```text
IMPLEMENTATION BUG
  TD already defines correct behavior; code differs.

CONTRACT GAP
  implementation needs a choice not resolved by Spec/TD.

BACKEND DEPLOYMENT GAP
  Platform contract is sufficient but current Backend installation cannot satisfy it.

LIVE ASSURANCE GAP
  source/deterministic tests exist but real boundary has not been demonstrated.

OPERATIONAL / UX ISSUE
  system is correct but awkward to operate.
```

Do not turn every live problem into a new architecture decision.

---

## 19. Known non-blocking observation

Carry this into pilot notes:

```text
Verification adapter run metadata is not candidate-qualified.

A narrow crash/rework window can conservatively associate the prior
candidate's run observation with a later candidate.

Evidence target binding prevents false PASS.

Potential impact:
liveness / unnecessary rework, not unsafe success.
```

If reproduced live, capture the full issue packet (§17) and bring it back. Do not preemptively
redesign it.

---

## 20. Success criteria for first pilot

Pilot PASS requires:

```text
RA-4 READY before Runtime effects

one real task discovered through TaskSource

Supervisor Proposal submitted through authoritative ingress

activation performed by production Coordinator

one Actor candidate produced

Platform-controlled Verification succeeds

independent Auditor reaches AUDIT_PASS
or one bounded FIX_REQUIRED then AUDIT_PASS

one MERGE_APPROVAL created

human APPROVE does not mark MERGED

human manually merges

Platform RepositoryAdapter observes merge

Attempt MERGED

Task COMPLETED

Batch COMPLETED

Run COMPLETED

no duplicate external side effects

no secret-bearing identity persisted
```

Report transport failure alone does not invalidate a completed lifecycle, provided the outbox row
remains correctly unsent and retains its identity for an idempotent retry.

---

## 21. Pilot failure rule

A first pilot failure is acceptable.

Do not patch around a fail-closed state just to get a green demonstration. If the Platform safely
refuses to continue, preserve the evidence and classify the cause.

The purpose of the pilot is to discover real integration problems.

---

## 22. Things the live-pilot session MUST NOT do

```text
do not begin MVP2
do not implement automatic merge
do not build a task scheduler
do not implement full reconciliation
do not add generic workflow machinery
do not silently rebase
do not manually mutate Platform DB
do not treat model text as authority
do not retry indeterminate Runtime turns
do not weaken RA-4
do not modify OpenClaw/durable-jobs merely to fit Platform architecture
```

---

## 23. Exact first action in the new session

```text
1. read STATUS_common_platform_mvp1.md
2. read this handoff
3. locate the Common Platform repository / current HEAD
4. inspect existing production exports needed for the composition root
5. design the smallest deployment composition/root wiring only
6. do not change Core semantics
7. before any Runtime effect, run RA-4 preflight
```

If composition-root wiring itself reveals a missing production contract rather than ordinary
dependency wiring:

```text
STOP
classify CONTRACT GAP
bring the exact gap back to the architecture-review session
```

---

## 24. Handoff state

```text
MVP1 FORMAL IMPLEMENTATION:
COMPLETE

LIVE PILOT:
NOT READY

BLOCKER:
RA-4 live BLOCKED(C2,C3,C4,C5)

NEXT:
production composition
→ RA-4 remediation
→ preflight READY
→ one tiny Single Task / Human Merge pilot

MVP2:
NOT STARTED
```
