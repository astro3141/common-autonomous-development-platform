# OpenClaw as a Runtime Backend — Capability Contract

> Purpose: reference for the future **Common Autonomous Development Platform**, which **may use OpenClaw
> as one replaceable Runtime Backend**. The Platform is exposed to the Supervisor through **MCP**; OpenClaw
> remains a **RuntimeAdapter** implementation beneath it. This document records what the current OpenClaw
> stack can and cannot provide as that backend, grounded in a read-only source audit (2026-08-08). It is a
> capability/contract map, not an implementation plan.
>
> **Boundary (do not conflate):**
> `OpenClaw ≠ Platform` · `ACP ≠ Platform` · `MCP ≠ Platform Core` · `durable-jobs ≠ Platform`.
> `OpenClaw + durable-jobs = Backend v1 implementation` — one RuntimeAdapter/WorkflowAdapter pair that a
> later Platform may keep, swap for OpenClaw-native, or replace with a different runtime/workflow backend.

**Audited versions**: core `openclaw@2026.7.2-beta.7` (worktree `dabe1915`) · durable-jobs `master`.
**Repository baselines** (read-only, this close-out): source-audit baseline `427c0a8`; close-out **code
commit `8e44078`** (delivery-route best-effort) → **docs commit `2cbb89d`** (P3-H finalization) — the
latter is durable-jobs final HEAD, **not** `427c0a8`. This capability doc is committed in `~/Lab`
(`97aaa71` + this accuracy pass).
**Feasibility verdict**: `OPENCLAW_CONDITIONAL_GO` — MVP 1–2 realistic on existing primitives + small glue;
MVP 3+ needs a clearly-bounded upper orchestration layer. The workflow engine does NOT need rebuilding.

**Close-out state**: **Backend v1 ready** — *not* "original P3-H 10/10 complete". The audit-continuation
smoke (original H3/H4 + duplicate-continuation H8) is **non-blocking deferred validation**.

**Test-status legend** (recorded per capability below):
- `[D]` deterministic-tested — covered by the durable-jobs `node --test` suite (389/389, 2026-08-08) and/or core unit tests.
- `[L]` live-tested — exercised on the real external-ACP path in the 2026-08-08 run (patched `2026.7.2-beta.7` cell).
- `[P]` primitive present — the mechanism exists in source but was **not** exercised as this capability (no autonomous-loop run yet).

> A `[D]`-only capability means the guarantee holds in tests but the **live** end-to-end use is not yet proven.

---

## 1. OpenClaw Runtime Backend (ACP / session layer)

Capabilities:
- **persistent model session** `[L]` — acpx persistent Claude ACP sessions; survived gateway restart (record + parent identity + `acp_sessions` rows persist).
- **spawn/resume separate Actor/Auditor sessions** `[P]` — RuntimeAdapter mapping is now settled (RA-1 CLOSED; see §3). The managed ACP session path exists: `AcpRuntime.ensureSession({ sessionKey, agent, mode, cwd, resumeSessionId? })` in `extensions/acpx/src/runtime.ts`, acquired through `src/acp/control-plane/manager.runtime-handle-ensure.ts`. **Evidence corrected (2026-08 read-only re-audit):** the earlier basis — a `spawn_agent` tool plus a subagent registry — does not hold. `spawn_agent` occurs only as a **Codex provider tool-name alias** (`agent → spawn_agent`) in `src/agents/harness/native-hook-relay-codec.ts`, and `state-migrations.subagent-registry*` describes itself as a **retired** legacy run-registry store. The primitive itself is unchanged in strength; only its identification was wrong. **The Actor/Auditor autonomous spawn+result-collection loop was still NOT run.**
- **session-bound trusted tool context** `[L]` — plugin-tools MCP bridge injects `OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY` + `OPENCLAW_TOOLS_MCP_WORKSPACE_DIR`; `resolveOwnerContext` requires `(agentId + workspaceDir)`. Trust boundary (freeze / cross-session / cross-agent / malformed) live-verified. Enables per-role tool boundaries (e.g. read-only Auditor).
- **worktree-aware execution** `[D]` — `src/agents/worktrees/service.ts` (create/remove, lease `core:managed-worktrees:create`); unit-tested, not exercised in the P3-H run. **No merge primitive.**
- **Slack/control-plane integration** `[L]` — `src/acp/control-plane/*`, Slack slash `/openclaw`, `delivery-outbox` frozen-route delivery (observed live).
- **autonomous wake** `[P]` — `src/infra/heartbeat-runner*` + cron (managed "dreaming" cron observed at boot); present, not driven as a supervisor loop.

Caveat: durable-jobs stage activities are **argv-only** and do NOT call ACP sessions (0 acp/subagent references in durable-jobs). The session layer and the workflow layer are **separate**; the upper platform must join them.

---

## 2. Durable Workflow Backend (durable-jobs)

Capabilities:
- **persistent workflow/store** `[D][L]` — `workflow-store.js` journaled records, schema-versioned, per-`(ownerKey,requestId)`; live records created + survived restart.
- **stage execution and linear advancement** `[D]` + partial `[L]` — `workflow-reconciler.js`: claims + submits the next runnable PENDING stage, at most one per pass; never advances past a non-PASSED stage, never fabricates PASSED. Live run only reached noop→`ARTIFACT_MISSING`; **multi-stage advance not live-exercised**.
- **local argv activities** `[D]` — `workflow-activity.js` `{argv, timeoutSeconds}`; `worker.js` spawns child with pre-spawn toolchain/checkpoint fingerprint re-verify (TOCTOU close).
- **audit_decide gate** `[D]` **only (NOT live)** — `workflow-audit.js` mode `none|supervisor`; verdicts `PASS|FAIL|BLOCKED|INCONCLUSIVE`; **verification levels enforced** (`WORKER_REPORTED`/`INFERRED` cannot carry a stage to PASSED — self-report rejected). Auditor is an *external* caller of `audit_decide`. **The live audit round-trip (H4) was NOT run (`workflowAuditEnabled=false`)** — the platform's Auditor gate is deterministically proven but live-unproven; this is the top deferred item.
- **retry/resume attempts** `[D]` — `workflow-control.js` `controlResume` creates attempt N+1 with `checkpointPolicy` (`require_match` = exact worktree fingerprint, or `manual_rerun`); reconciler `FALLBACK_ELIGIBLE_PROFILES`.
- **idempotent start** `[D][L]` — `startWorkflow` dedups on `(ownerKey, requestId)`; same payload → reused, different → `WORKFLOW_REQUEST_CONFLICT`; live-verified (start path only — not duplicate-continuation).
- **restart reconciliation** `[D][L]` — `reconcileWorkflow` recovery scan each pass; live record + parent identity survived gateway restart (continuation/audit recovery NOT live-run).
- **deterministic evidence / verification levels** `[D]` — evaluator derives verdict from AGY structured envelope (`agy-json`) for model runners, or process/provider state for local; audit requires `REEXECUTED|LOG_VERIFIED|ARTIFACT_VERIFIED`.

Model-runner caveat: the **only** model runner is AGY (`evaluator.js`: `command[0]` basename `agy` → `resultProtocol: "agy-json"`). Profiles: `model_agy` (model) + `local_test|local_build|local_docker|generic_local` (local). A Claude Actor runs as a `generic_local`/subagent, not as a first-class structured model runner.

---

## 3. RuntimeAdapter interface (Runtime Backend → Platform) — current mapping

| Platform-required | Backend today | Gap |
|---|---|---|
| `spawn_session(role, profile, cwd) -> handle` | `AcpRuntime.ensureSession(...)` (`extensions/acpx/src/runtime.ts`); the Platform-facing handle is the adapter-derived pair `(agentId, entry.sessionId)` | **RA-1a CLOSED — adapter-only, no OpenClaw patch.** The raw `sessionKey` is a trusted credential (it is what `OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY` carries), so it stays in adapter memory. The durable reference is `entry.sessionId` (`randomUUID()`, assigned by `src/gateway/sessions-patch.ts` — "assigning an id makes them real") scoped by the store's owner partition `agentId`; `resolveSessionKeyFromResolveParams({sessionId, agentId})` resolves it back, and its existing ambiguity branch fails closed. Worktree creation is **not** part of this primitive — it is the RepositoryAdapter's (TD §14.3). |
| `send_turn(handle, instruction) -> result` | **`AcpRuntime.startTurn(input) -> AcpRuntimeTurn`** (`packages/acp-core/src/runtime/types.ts`; acpx impl `extensions/acpx/src/runtime.ts`) | **RA-1b CLOSED.** The contract calls it the "preferred turn API": input `{handle, text, attachments?, mode, requestId, signal?}`, result `{requestId, events, result: Promise<AcpRuntimeTurnResult>, cancel, closeStream}`. `requestId` is caller-supplied, so the Platform's own `op:<attempt>:actor-turn:<n>` can be it. **Measured limits (2026-08 read-only audit):** start mapping = **available**; same-`requestId` duplicate dedup = **not available** (acpx `startTurn` passes through and consults no store); durable `requestId → turn` reacquisition = **not available** (control-plane uses `requestId` only as a background-task `runId` and a signal-log field; `activeTurnBySession` is a process-local `Map`; no turn identity is persisted on the session). **MVP 1 handling:** a crash after the turn was accepted but before the Platform persisted its handle is indeterminate, so the Platform **never retries** and fails closed to `RECOVERY_CONFLICT` (TD §19.3e T2) — duplicate Actor turns are structurally impossible. Full automatic turn recovery belongs to the later Runtime-recovery scope (Spec §69, MVP 4), **not** an MVP 1 backend gap. **Turn completion observation and structured result collection remain RA-2.** |
| `get_session_status(handle)` | `acp_sessions` store + control-plane active-turns | queryable; expose as stable API |
| `cancel_session(handle)` | acpx wrapper kill-tree + session lifecycle | present at process level; expose as API |
| `CapabilityEnforcementReceipt` (TD §12.6) | **absent** | **Measured (2026-08): `receipt_supported = false`.** No enforcement-receipt / applied-means concept exists anywhere in the backend source. Tool allowlist, `permissionMode` and workspace `cwd` are *configuration intent and mechanism*, not a per-spawn report of what was actually applied. TD §12.6 accepts `false` as a valid manifest state, so this is **not** an adapter blocker on its own — a policy that requires receipts simply fails V10 before spawn. |

## 4. WorkflowAdapter interface (Workflow Backend → Platform) — current mapping

| Platform-required | Backend today |
|---|---|
| `start(workflow_spec) -> handle` | `workflow` tool `action=start` (pipeline of stages) — AVAILABLE |
| `status(handle)` | `action=status/list` — AVAILABLE |
| `resume(handle)` | `action=resume` (attempt N+1 + checkpointPolicy) — AVAILABLE |
| `cancel(handle)` | `action=cancel` — AVAILABLE |
| `audit_decide(handle, verdict, evidence)` | `action=audit_decide` (verdict + per-check verification levels) — AVAILABLE (interface); **live round-trip DEFERRED** |

The WorkflowAdapter interface the Platform needs is **essentially already exposed** by the `workflow` MCP tool.

---

## 5. Runtime Capability Enforcement / CapabilityGrant Mapping

The Platform's trust model is per-Role `CapabilityGrant`. This section records, **from the read-only audit
only**, how strongly each capability boundary can be *enforced by the OpenClaw runtime/tool layer* today —
**not** what a prompt can request. Distinguish:

- **prompt-instruction** ("tell the Auditor not to write") — advisory, NOT a boundary.
- **runtime/tool boundary** (the write/shell tool is absent from the session, or an ownership gate rejects
  the call) — a real boundary.

Enforcement markers: `ENFORCED` · `AVAILABLE_WITH_REDUCED_ASSURANCE` · `UNENFORCEABLE_CAPABILITY_BOUNDARY`
· `NOT YET AUDITED`. This close-out audited the workflow/session/packaging layers; it did **not** deep-audit
the tool-permission enforcement code paths, so filesystem/git capabilities are marked conservatively.

| Capability | Runtime enforcement today | Basis / caveat |
|---|---|---|
| workflow ownership / `audit_decide` authorization | **ENFORCED** | `resolveOwnerContext` fail-closed on `(agentId+workspaceDir)`; non-owner/cross-session/cross-agent rejected — live-verified (STATUS §5.2). This is a *workflow-control* boundary, not a filesystem one. |
| repository read | `NOT YET AUDITED` | read tools exist; whether a session can be constrained read-only at the tool boundary was not audited. |
| feature write (in worktree) | `AVAILABLE_WITH_REDUCED_ASSURANCE` | Actor writes via file/shell tools in a managed worktree (`agents/worktrees/service.ts`); worktree is isolation **by convention**, not a hard sandbox. |
| canonical write (outside worktree) | `UNENFORCEABLE_CAPABILITY_BOUNDARY` (today) | nothing sandboxes a shell/file tool to the worktree; confinement requires removing shell/file write tools — not a dedicated runtime boundary. |
| merge (ff-only) | `UNENFORCEABLE_CAPABILITY_BOUNDARY` (today) | **no ff-only merge primitive in core**; a merge is just a shell/git command, ungated beyond whatever gates shell. |
| shell | `NOT YET AUDITED` | gated only by tool allowlist + `permissionMode`; under `permissionMode=approve-all` (used in the P3-H run) there is no per-call gate. Strictness/bypass not audited. |
| spawn child session | `NOT YET AUDITED` | managed ACP session creation (`AcpRuntime.ensureSession`) plus whatever tool policy gates it; enforcement strictness not audited. (Assurance unchanged — the 2026-08 re-audit corrected the mechanism name only.) |
| remote push | `NOT YET AUDITED` / effectively `UNENFORCEABLE` without removing shell | a git/shell command; no dedicated boundary observed. |
| destructive git (`reset --hard`, `clean`, tag move) | `NOT YET AUDITED` / effectively `UNENFORCEABLE` without removing shell | same as shell. |

**Role application (configured, not inherently enforced):** Supervisor / Actor / Auditor are *configurations*
of the above — e.g. an **Auditor read-only** grant would be built by removing write/shell tools from that
session's allowlist and using a non-`approve-all` `permissionMode`. That is a tool-boundary mechanism, but
it was **not audited for bypass resistance** → treat as `AVAILABLE_WITH_REDUCED_ASSURANCE` until a dedicated
capability-enforcement audit is done.

**Direct answers for the Platform's go/no-go:**
- *Can Auditor read-only be actually guaranteed on this runtime?* Configurable via tool allowlist +
  `permissionMode`, but **not yet proven at the boundary** → `AVAILABLE_WITH_REDUCED_ASSURANCE`; audit before relying.
- *Can automatic merge be allowed on this runtime?* **No, not yet** — merge/canonical-write/push are
  `UNENFORCEABLE_CAPABILITY_BOUNDARY` today (no ff-only primitive, no worktree sandbox). Automatic merge must
  wait for a dedicated merge activity + atomic parent==HEAD check + a capability-enforcement audit.

---

## 6. What this backend DOES NOT own (upper platform owns)

- project profile semantics
- task selection
- READY_ITEM / THIN_FOUNDATION / MAJOR_FOUNDATION / CONTRACT_CHANGE classification
- batch scheduling (cross-workflow hold/continue, batch ≤ N, foundation suspend→resume of an original task)
- human policy (auto-merge permissions, approval points)
- ff-only merge policy (no core `--ff-only` primitive; must be a local activity + atomic expected-HEAD/parent check)
- PROJECT_STATUS interpretation
- the Supervisor loop's own durable state + crash recovery (durable-jobs recovers per-workflow, not the loop above it)

## 7. Known backend caveats

- Current design **needs durable-jobs** because stock OpenClaw core lacks the workflow engine / audit gate parts of this contract.
- **The current live install is not the patched cell (measured 2026-08).** `/opt/homebrew/lib/node_modules/openclaw` is `openclaw 2026.7.1-2 (0790d9f)`: `OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY` is present, but `OPENCLAW_TOOLS_MCP_WORKSPACE_DIR` is **absent**, `@openclaw/acpx` is **not installed at all**, and `resolveOpenClawCoreDistEntry` is absent. The patched lab source carries both host fixes as **uncommitted working-tree changes**. So `source capability evidence ≠ clean distributable backend package`, and any Platform run must gate on the TD §30.2 RA-4 preflight (C1–C7) before touching a Runtime.
- **ACPX/core packaging patches are not yet cleanly upstream / reproducibly distributed**: the P3-H fixes build reproducibly from source (`OPENCLAW_BUILD_ALL_NO_PNPM=1`; ACPX byte-identical; core `plugin-tools-serve.js` byte-identical), but `pnpm pack` (workspace: → concrete) requires a full workspace install the local worktree cannot do (symlinked node_modules). Fresh cells still `npm install` the unpatched registry `@openclaw/acpx@2026.7.2-beta.7`. See memory `p3h-packaging-reproducible`.
- **Model runner is AGY-only**; a Claude Actor with structured results needs a new runner profile or Claude speaking `agy-json`.
- **No ff-only merge primitive** anywhere in core — highest-risk gap for autonomous merge (lineage/race).
- The backend may later become plain (upstreamed) OpenClaw, or be replaced entirely; the upper platform should depend on the **interfaces (§3–4)**, not on durable-jobs internals.

## 8. Top failure modes to design around
1. ff-only merge race / lineage corruption (no primitive; needs atomic parent==HEAD).
2. Supervisor-loop crash leaving a batch inconsistent (loop state not durable-jobs-managed).
3. Actor scope creep / two workflows on one canonical (contention).
4. Auditor filling verification levels dishonestly (enforce evidence-level tooling, not narrative).
5. AGY-only runner → Claude result mapped via exit-code/auditor only.

## 9. Recommended first step (pilot)
Single READY_ITEM (e.g. an infra-scanner `~/Lab/30_Projects/infra-scanner` check item with a deterministic evaluator/test): Supervisor creates a workflow → Actor (managed ACP session or local runner) implements+commits in a worktree → local runner verifies → audit gate → separate Auditor session `audit_decide` → FIX_REQUIRED ≤2 via resume → **human approves merge** (MVP 1). Verify the item is truly READY (no new primitive/evidence) before piloting.

---

## 10. Handoff summary (read this first)

For the next Common Platform project — decide backend use **without** reading the P3-H history (that
history is the *evidence trail* for these claims: STATUS §5 + P3_H §9).

- **Runtime Backend capabilities** → §1 (persistent session `[L]`, session-bound trusted context `[L]`,
  spawn child `[P]`, worktree `[D]`, Slack/control-plane `[L]`, autonomous wake `[P]`).
- **Workflow Backend capabilities** → §2 (store/advance/resume/idempotent-start/restart `[D]`, several `[L]`;
  **audit_decide gate `[D]`-only, live round-trip deferred**).
- **RuntimeAdapter interface + current mapping** → §3. **WorkflowAdapter interface + current mapping** → §4.
- **CapabilityGrant enforcement level** → §5 (ownership `ENFORCED`; merge/canonical-write/push
  `UNENFORCEABLE` today; Auditor read-only `AVAILABLE_WITH_REDUCED_ASSURANCE`; shell/spawn/git `NOT YET AUDITED`).
- **Test legend** → `[D]` deterministic-tested · `[L]` live-tested · `[P]` primitive-only. **`Backend v1 ready`
  ≠ every capability live-verified.**
- **Not owned by the backend** → §6. **Known caveats** → §7. **Failure modes** → §8.
- **Replaceability:** OpenClaw+durable-jobs is **one** Backend v1 implementation; the Platform may keep it,
  swap for OpenClaw-native, or use a different runtime/workflow backend — depend on §3–4 interfaces, not
  durable-jobs internals.

**Close-out:** `Backend v1 ready`. Original P3-H = **PARTIALLY EXECUTED / NOT 10/10**. Non-blocking deferred:
continuation auto-fire (H3), live `audit_decide` (H4), original H5/H6 `audit_decide` negatives,
duplicate-continuation idempotency (H8), full audit-continuation restart agreement. Known packaging caveat:
ACPX/core fixes not cleanly distributed/upstream.

---
*Source: read-only audit, no code/state modified. Cross-refs: memories `p3h-final-pass`, `p3h-packaging-reproducible`, `openclaw-autonomous-dev-feasibility`. Evidence trail: durable-jobs `docs/STATUS_workflow_harness.md` §5, `docs/P3_H_session_bound_audit_smoke.md` §9.*
