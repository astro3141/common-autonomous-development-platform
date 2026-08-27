# Production Composition Root — read-only preflight survey

> **This file is a survey record only.** It does not define architecture and cannot redefine it.
>
> **Architecture authority (unchanged):**
> 1. `Common Autonomous Development Platform — Specification v0.3`
> 2. `TECHNICAL_DESIGN_autonomous_development_platform.md`
> 3. `PLATFORM_BACKEND_CAPABILITY.md`
> 4. `STATUS_workflow_harness.md`
> 5. `STATUS_common_platform_mvp1.md`
>
> Where this file disagrees with those, **they win** — this file is then wrong and must be
> corrected. It introduces no contract, no state, no vocabulary and no decision of its own.
>
> Operational handoff: `HANDOFF_common_platform_mvp1_live_pilot.md`
>
> Survey date: 2026-08-27. No code was modified; read-only inspection only.

---

## 0. Question

`STATUS_common_platform_mvp1.md` §8 O1 records that the production composition root is absent, and
calls building it *"dependency wiring over existing sealed exports"*. This survey tests that claim
against the actual tree, and answers one question:

```text
Is building the production composition root ordinary dependency wiring,
or does it require a decision that Spec/TD has not made?
```

Verdict is in §5. Short version: **ordinary dependency wiring**, plus six implementation gaps —
one of which is not where the status document implies it is.

---

## 1. State surveyed

```text
tests      1034 / 1034 PASS
typecheck  PASS
schema     v6 / 17 tables

package.json dependencies   {}          (zero runtime dependencies)
tsconfig include            core, adapters, testdoubles, tests
server / transport code     none
executable entrypoint       none
```

---

## 2. Wiring reference — `tests/support/coordinator-fixtures.ts`

The handoff names this fixture as the single reference implementation of the whole dependency
graph. It builds exactly the eleven slots of `ProductionCoordinatorDependencies`
(`core/coordinator/production-coordinator.ts:63`), and it contains no business logic.

**It is thinner than production in two places.** The fixture does not use the production
run-opening path at all:

```text
domain-fixtures.world()     → store.runs.create / store.batches.create directly   (bypasses bootstrapRun)
domain-fixtures.discover()  → commitTaskDiscovery directly                        (bypasses materializeDiscoveryPass)
```

Both production exports exist, so this is not a gap — but a composition root that copies the
fixture would silently skip them. It must call `bootstrapRun` and `materializeDiscoveryPass`.

| Fixture dependency | role | fixture impl | production impl | source | status |
|---|---|---|---|---|---|
| `store` | `PlatformStore` | `tempStore().open()` | same class, durable path | `core/store/platform-store.ts:92` | READY |
| `profiles` | `ProfileSource` | injected reader | `DocumentProfileSource`, default fs reader | `adapters/local-drift-source/profile-source.ts:40` | READY |
| `contractSources` | `ContractSourceReader` | injected reader | `FileContractSourceReader`, default fs reader | `adapters/local-drift-source/contract-source-reader.ts:30` | READY |
| `taskSource` | `TaskSourceV1` | `StubTaskSource` | `ProjectDocumentTaskSource` | `core/tasksource/project-document-task-source.ts:72` | READY |
| `repository` | `RepositoryAdapter` | `RecordingRepository` | `LocalGitRepositoryAdapter` | `adapters/local-git/local-git-repository-adapter.ts:106` | READY |
| `verification` | `VerificationAdapter` | `FakeVerificationAdapter` | `LocalVerificationAdapter` | `adapters/local-verification/index.ts:37` | READY (deps unmet) |
| `preflight` | `RuntimePreflight` | `readyPreflight` | RA-4 probe | `adapters/backend-runtime-preflight/preflight.ts` | READY |
| `runtime` | `RuntimeAdapter` | `RecordingRuntime` | `OpenClawRuntimeAdapter` | — | **MISSING** |
| `report` | `ReportAdapter` | `FakeReportAdapter` | production transport | — | **MISSING** |
| `manifests` | `ManifestSetInput` | `receiptFreeManifests()` | TD §12.3 values | validator only | **MISSING** |
| `identities` | `CoordinatorIdentities` | counters | real ULID/clock | — | **MISSING** (root may own) |
| — | run-scoped SUPERVISOR grant | issued inline by the fixture | **a Core use-case** | — | **MISSING** (IG-1) |
| ingress | Proposal transport | direct function call | MCP tool server | `submitProposal` (Core side only) | **MISSING** |

`LocalVerificationAdapter` requires `runtime`, `workflow` and a backend seam
(`adapters/local-verification/local-verification-adapter.ts:56`), so the missing Runtime and
Workflow adapters block Verification too. The dependencies are chained.

---

## 3. Export inventory

Three states, deliberately distinguished: *an interface exists* ≠ *a production implementation
exists* ≠ *a publicly importable production export exists*.

### READY — interface, implementation and export all present

| Component | Export | Source |
|---|---|---|
| Platform Store | `PlatformStore.open` | `core/store/platform-store.ts:92` |
| Profile compiler | `compileProfile` | `core/profile/compiler.ts:52` |
| Run bootstrap | `bootstrapRun` | `core/admission/bootstrap.ts:34` |
| Discovery | `materializeDiscoveryPass` | `core/discovery/materialize.ts:89` |
| Proposal ingress (Core side) | `submitProposal`, `resolveHumanGateAndAdmit` | `core/admission/submit-proposal.ts:68` |
| Coordinator | `ProductionCoordinator` | `core/coordinator/production-coordinator.ts:110` |
| TaskSource | `ProjectDocumentTaskSource` | `core/tasksource/project-document-task-source.ts:72` |
| RepositoryAdapter | `LocalGitRepositoryAdapter` | `adapters/local-git/local-git-repository-adapter.ts:106` |
| VerificationAdapter | `createLocalVerification` | `adapters/local-verification/index.ts:37` |
| ProfileSource | `DocumentProfileSource` | `adapters/local-drift-source/profile-source.ts:40` |
| ContractSourceReader | `FileContractSourceReader` | `adapters/local-drift-source/contract-source-reader.ts:30` |
| RA-4 preflight | `backendRuntimePreflight`, `inspectBackendRuntime` | `adapters/backend-runtime-preflight/index.ts` |
| RuntimeResultChannel | `RuntimeResultChannel`, `withCollectedResult` | `adapters/runtime-result-channel/index.ts` |
| Manifest validator | `validateManifestSet` | `core/capability/manifest-set.ts:27` |

Direct module imports compose all of these without a barrel, so the absence of a barrel is not an
architecture gap. Two configuration facts worth recording: `DocumentProfileSource` parses **JSON**
(TD §5.2 prose says YAML; the implementation at this state reads JSON), and
`FileContractSourceReader`'s `root` is the repository checkout.

### MISSING — interface only

| Component | Production impl | Behavior fully determined by TD? | Classification |
|---|---|---|---|
| RuntimeAdapter | none | **yes** — §13.1 mapping; §30.2 RA-1a/1b/2a/2b/3 all `CLOSED`, *"adapter-only glue"* | IMPLEMENTATION GAP |
| WorkflowAdapter | none | **yes** — §14.1 mapping, M0-8 concrete signatures | IMPLEMENTATION GAP |
| WorkflowToolTransport | none | **yes** — one method, grammar owned by the seam | IMPLEMENTATION GAP |
| ReportAdapter | none | **yes** — §21.1 closes the Core-facing contract; transport is explicitly implementation detail | IMPLEMENTATION GAP |
| Platform MCP/API ingress | none | **yes** — §5.1 fixes responsibility, input and prohibitions | IMPLEMENTATION GAP |
| BackendManifestSet values | none | **yes** — §12.3 transcribes them; `receipt_supported=false` measured | IMPLEMENTATION GAP |
| ULID / clock provider | none | n/a — the root may own these | root-owned |

### TEST_ONLY — production must never reference these

`tests/support/*` (`RecordingRuntime`, `RecordingRepository`, `RecordingWorkflow`,
`CurrentSources`, `readyPreflight`, `receiptFreeManifests`, `StubTaskSource`, `ulidAllocator`,
`fixedNow`, `tempStore`) and the four fakes in `testdoubles/`.

---

## 4. IG-1 — no production path issues the run-scoped SUPERVISOR grant

This is the one finding that is not a simple omission.

```text
required:  requestSupervisorProposal → requireSupervisorGrant(store, run_id)
           → store.grants.forRun(run_id).find(role === "SUPERVISOR")
           → absent ⇒ throw ExecutionStartError("run <id> has no run-scoped SUPERVISOR grant")
           core/execution/supervisor-session.ts:262-276

issuers:   bootstrapRun            → writes run / batch / compiled profile. No grant.
           activateSelectedTask    → buildTaskContract issues ACTOR + AUDITOR at ATTEMPT scope
           transition-commit.ts:382-383 → grants.put(..., {kind:"ATTEMPT"}) — the only two calls
           production grants.put({kind:"RUN"}) callers = 0

only issuer in the tree: tests/support/coordinator-fixtures.ts:93-102
```

The comment at `core/execution/supervisor-session.ts:262` reads *"The run-scoped SUPERVISOR grant
activation already issued"*. **That is false.** Activation issues no SUPERVISOR grant, and
activation happens *after* the Supervisor turn — the ordering it implies cannot occur.

Without this step the first tick throws inside `#requestProposalIfNeeded` and the run never opens.

**The composition root cannot supply it.** CapabilityGrant derivation is not the root's to own, and
TD §13.4 places issuance in Core: *"Core가 run-scoped grant를 발급한다."*

The behavior is nevertheless fully determined:

```text
§12.4  SUPERVISOR requested map = all 12 capabilities false  (core/capability/derive.ts:39 implements this)
§13.4  issued after run init, before the first Supervisor spawn
§13.4  persisted in the existing capability_grant row (run_id non-null, attempt_key null, partial unique per run)
§13.4  "새 grant schema는 없다" — no new grant schema
§12.7  task_contract_capability_view is a required input that v1 derivation does not read
       (core/capability/broker.ts:26-40)
```

So this is an **IMPLEMENTATION GAP, not a CONTRACT GAP** — no decision is missing, only code. Its
location matters more than its size: it belongs in Core, not in the root.

---

## 5. Verdict

```text
VERDICT = ORDINARY DEPENDENCY WIRING

Core semantic change required:                  NO
new architecture decision required:             NO
safe to proceed to composition implementation:  YES
Runtime effects permitted now:                  NO — RA-4 READY required
```

No CONTRACT GAP trigger fired. No new lifecycle transition, authority owner, durable state or
identity, trust semantics, proposal submission authority, capability semantics, verification or
audit authority, PendingDecision resolution, retry/recovery semantics, or Core↔Backend contract is
required. Every blocked point is behavior TD already determined, missing only code.

One qualification, stated rather than buried: **IG-1 requires adding code to sealed Core.** It
changes no semantics — no new schema, table, vocabulary or state, and `derive.ts:39` already
implements the rule — but it is not something the composition root may do on its behalf.

```text
IG-1  run-scoped SUPERVISOR grant issuance use-case       Core,    §12.4 / §13.4
IG-2  OpenClawRuntimeAdapter                              adapter, §13.1 / §30.2
IG-3  DurableJobsWorkflowAdapter + WorkflowToolTransport   adapter, §14.1
IG-4  production ReportAdapter                             adapter, §21.1
IG-5  Platform MCP/API Proposal ingress transport          adapter, §5.1
IG-6  BackendManifestSet production values                 config,  §12.3
```

Live pilot remains blocked by these six plus the already-recorded
`RA-4 live BLOCKED(C2,C3,C4,C5)`.

---

## 6. Proposed minimal composition

Structure only — nothing here has been built.

```text
deployment/
  config.ts      configuration load + validation
  compose.ts     dependency construction → { coordinator, store, run_id, dispose }
  open-run.ts    bootstrapRun + materializeDiscoveryPass
  main.ts        process entrypoint: compose → open → ingress → tick → shutdown
```

`tsconfig.json`'s `include` would need `deployment/**/*.ts`.

**Construction order.** config → store → repository → task source → profile source → contract
source reader → preflight → runtime (IG-2) → workflow (IG-3) → verification → report (IG-4) →
manifests (IG-6) → identities → `ProductionCoordinator`. Everything but the gaps is constructor
plumbing.

**Bootstrap sequence.**

```text
compileProfile(...)
  → bootstrapRun(store, { run_id, batch_id, project_id, compiled_profile })
  → [IG-1, in Core] issue run-scoped SUPERVISOR grant
  → materializeDiscoveryPass(store, taskSource, { run_id, batch_id, context })
```

**Ingress.** `main.ts` starts the transport; its handler calls `submitProposal` and nothing else,
sharing the same store and repository instances as the Coordinator. Stateless, per §5.1.

**Tick.** `main.ts` only. `coordinator.tickOnce(run_id)` in a thin process wrapper; cadence belongs
to the wrapper. No durable tick cursor, no scheduler table, no background authority inside Core.
`TickStep` is logged, never branched on as authority.

**Shutdown.** `main.ts` owns it: stop ingress → let the in-flight tick finish → `store.close()`.
Runtime sessions are **not** closed — session lifetime belongs to durable state and the adapter, and
process exit must never manufacture a Platform lifecycle fact.

**What the root must not own.** Task/Attempt transitions, proposal validation, activation,
CapabilityGrant derivation, verification eligibility, audit/rework/merge semantics, PendingDecision
interpretation, new durable state. None of the above reaches past `ProductionCoordinator` into a
sealed use-case — preserving the CORR1 lesson:

```text
If the runner must reach past ProductionCoordinator to make progress,
that is a finding, not a workaround.
```

---

## 7. Suggested next batch

**Stage 1 — wiring only, verifiable without a Runtime.**

```text
new:     deployment/{config,compose,open-run,main}.ts
         deployment/manifests/*.json                      (§12.3 transcription)
         core/admission/issue-supervisor-grant.ts          ← IG-1
         tests/deployment-composition.test.ts
edit:    tsconfig.json                                     (include deployment)
         core/admission/index.ts                           (barrel, one line)
         core/execution/supervisor-session.ts:262          (correct the false comment)
```

Acceptance:

```text
zero imports from tests/support/* or testdoubles/* in production code (source guard)
compose() fills all eleven dependency slots and typechecks
IG-1 satisfies §12.4 (all 12 false) and run-scoped persistence
  — exactly one role=SUPERVISOR row per run, attempt_key null
  — re-issue on the same run fails closed on the partial unique
no transition / validation / derivation / eligibility logic anywhere in deployment/ (source guard)
no durable tick cursor, scheduler table, work queue, or new durable state
1034 tests + typecheck still PASS; schema stays v6/17 (no migration)
```

**Stage 2 — the missing adapters (IG-2 … IG-5)**, as a separate batch, under
`adapters/openclaw-runtime/` and `adapters/durable-jobs-workflow/`. OpenClaw and durable-jobs
sources are not modified; §30.2 closed both as requiring no patch. Deterministic tests only — no
live execution.

**Stage 3 — RA-4 remediation → C1–C6 PASS → READY.** No Runtime external effect until then.
