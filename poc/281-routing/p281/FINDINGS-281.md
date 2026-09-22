# #281 findings — common agent execution and quota-based routing

Working log. Measured facts only; each entry states what is and is not established.

---

## Phase 0 — environment fixed

- **RUNBOOK rewritten.** The previous version predated the Preloop install and prescribed the
  F6 project-scope onboarding rule that F9 superseded. Followed as written it would have
  re-created the F8 incident path. See `RUNBOOK.md`.
- **Revisions are now recordable.** Neither workspace was under version control. Baseline
  snapshot: `poc-278 @ 2027dcb`, `research-280 @ ecccc6e`, fixture `@ e41c407`. Secret-bearing
  incident files and the MLflow store are git-ignored. `core.autocrlf` is **off**: with it on, a
  fresh checkout rewrites line endings and changes `sha256(gate.py)`, breaking every manifest
  that pins it.
- **Baseline smoke on the existing path passed** (2026-09-21): isolation intact (no default
  route, egress `000`, MCP `401`), Conductor → Preloop gateway returned `GATEWAY_ROUNDTRIP_OK`,
  gateway logged the POSTs.

### Runtime additions (image rebuilt)

Everything under `/opt`, never `$HOME` (#280: `$HOME` is a volume that pins what is under it).

| Component | Version |
|---|---|
| node | 22.14.0 |
| acpx | 0.18.0 |
| @agentclientprotocol/claude-agent-acp | 0.79.0 |
| @agentclientprotocol/codex-acp | 1.12.0 |
| @openai/codex | 0.155.1 |
| CodexBar CLI | 0.63.0, static musl build (glibc build does not run here, see below) |

Two provisioning traps:

1. The node tarball step failed on `tar -xJ`: `python:3.13-slim-bookworm` has no `xz-utils`.
   Switched to the `.tar.gz` distribution.
2. **CodexBar's glibc build needs `GLIBC_2.38`; Debian bookworm ships 2.36.** It fails at load:
   `version 'GLIBC_2.38' not found`. Switched to the static musl build; it runs (`CodexBar 0.63.0`).
   Image after the switch: `72d6e4cb395e`. Isolation re-verified after recreate.

acpx's built-in profiles launch adapters with `npx -y <adapter>`. With no egress that can only
work if the adapter is already installed; it is, and the built-in profile did start.

---

## Phase 2 — acpx + Claude

### A. Built-in profile, nothing injected → fails closed

`acpx claude exec …` with no extra configuration:

```
Internal error: Failed to refresh OAuth token: another Claude Code process is refreshing it
or exited mid-refresh …
```

This is the settings-isolation behaviour the review cited, measured. acpx's built-in Claude
profile loads project and local settings but **not user settings**, and in this container the
gateway environment and the Preloop PreToolUse hook both live in the user tier. So the session
fell back to the ambient OAuth credential, tried to refresh it, and could not reach the provider
because the runtime has no egress.

- **Safe:** it failed closed; nothing bypassed the gateway.
- **Misleading:** the error blames a concurrent refresh; the real cause is no network.
- **Residue:** the failed refresh left `~/.claude/.oauth_refresh.lock`, which would make later
  OAuth-path runs report the same misleading message. Removed.
- **Credential untouched:** `sha256(.credentials.json)` = `ef30dfd483ba7c2a`, identical to the
  value recorded in F12. The existing Conductor path still worked immediately afterwards.

### B. Built-in profile, gateway env injected explicitly → works through the gateway

Chosen over `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1`, which would also pull in the rest of the
user tier (the thing F6 was trying to avoid) and would leave "which settings applied" implicit.
Exactly three variables, read from the container's own settings and passed as process env:

```
ANTHROPIC_BASE_URL=http://console/anthropic
ANTHROPIC_API_KEY=agt_…            (Preloop gateway key)
ANTHROPIC_MODEL=sonnet
```

Result: reply `B_OK`, exit 0. Gateway log for the same window: **6 × `200`**, 1 × `404`.

### The 404, and what model actually served

The adapter did **not** honour `ANTHROPIC_MODEL=sonnet`. It requested its own default,
`claude-sonnet-5`. The gateway attempted to auto-register that Claude-family model, hit a
`UniqueViolation` on `uq_managed_agent_ai_model_binding_slot`, and answered
`Requested model not found` (404); later requests in the same session returned 200.

acpx records `model_usage: [{"model": "claude-sonnet-5", totalTokens: 42438}]`. That is the
model the adapter **requested**. The gateway 404'd on exactly that name once, and does not log a
served-model identity for the 200s, so **the served model is not confirmed** — recorded as such,
per the issue's rule that an alias alone does not establish the served model.

Two Preloop 0.15.0 idempotency defects are visible in the same window (both `UniqueViolation`,
one on `uq_runtime_session_account_source`, one on the model-binding slot). Neither blocked the
run.

---

## Phase 3 — does acpx contain native writes? Yes, at the ACP layer

Fixture: an empty workspace; the task is to create `marker.txt`. Each case uses a **fresh named
session** (`sessions new --name p3-<case>`), because acpx's session key is
`(agentCommand, absoluteCwd, optional name)` and carries no account or policy.

| Case | Mode | Permission request recorded | Independent file check |
|---|---|---|---|
| Write tool | `--approve-all` | yes — `kind=edit`, `Write marker.txt`, content `P3` | **created** (control) |
| Write tool | default (`--approve-reads`) | yes — identical request | **absent** |
| Write tool | `--deny-all` | yes — identical request | **absent** |
| shell alternative | default | yes — `kind=execute`, `echo P3 > marker.txt` | **absent** |

Every "absent" case carries the exact request for that write in its transcript, and the approve
control proves the agent was capable of and attempted the same write. So these are refusals, not
runs where nothing was tried — the standard the issue sets for deny evidence.

This is the result #278 could not get. Under Conductor's `claude-agent-sdk` provider, native
Write/Bash ran unmediated in the measured configuration (F19/F22). acpx refuses them at the ACP
permission layer, including the shell route to the same effect.

**What this is not:** it is acpx's own permission policy, not Preloop's. The issue requires
Preloop to own the policy decision and forbids the adapter from becoming a second approval
engine. This establishes that the ACP layer is a place where native actions **can** be stopped;
routing that decision to Preloop (`onPermissionRequest` → Preloop → the pending request) is the
next, narrow piece of work. Also not yet shown: a real *approval* round trip through Preloop, and
the approval-timeout case.

`exit=5` on refusal: the refused request ends the turn and the process exits non-zero. Inside a
Conductor step that surfaces as a failed step — consistent with failing closed.

---

## CodexBar guard inside the governed runtime (first probe)

`codexbar guard --provider {claude,codex} --min-remaining 20 --window session --json`:

```
{"provider":"claude","exitCode":69,"remainingPercent":null,"unavailableReason":"fetch-failed","decision":"unknown"}
{"provider":"codex", "exitCode":69,"remainingPercent":null,"unavailableReason":"fetch-failed","decision":"unknown"}
```

- **Fails closed by default** with no egress: exit 69, no percentage invented.
- **The guard output names no account.** It can say "claude has N% left", never *whose*. The
  account-match requirement therefore cannot be met from `guard` alone; the router has to bind
  the observation to an account identity obtained separately and compare it with the executing
  account. `guard` removes the threshold glue, not the identity glue.
- Quota observation needs provider egress, which the governed runtime deliberately lacks, so
  CodexBar cannot live in the agent container; it needs an observer placement of its own.

## Change ledger (the #281 success measure)

Every change made to run a given vendor through the common layer, recorded as it happens.

| # | What | Why | Vendor-specific? |
|---|---|---|---|
| 1 | node + acpx + both ACP adapters + codex in the image | egress 0 forbids launch-time `npx` | no (shared) |
| 2 | inject gateway env per run: base URL, key, `ANTHROPIC_MODEL`, and the three `ANTHROPIC_DEFAULT_*_MODEL` alias mappings | acpx excludes user settings; without the mappings the ACP adapter picks its own default model (404) | **Claude-specific**, confined to `PROVIDERS.claude` |
| 3 | fresh named session per run | session key lacks account/policy | no (shared) |
| 4 | `onPermissionRequest` → Preloop `permission-check`, fallback `deny-all` | acpx policy is not Preloop's | shared; only the Preloop `source` label differs per vendor |
| 5 | result normalization (`DENIED`, `CONTROL_UNAVAILABLE`) | acpx reports a refused turn as `completed` | no (shared) |

Codex not yet run — blocked on a container-side Codex login.

---

## Target (restated 2026-09-21, after review)

The goal is not vendor-switch convenience but **removing per-vendor wiring from every other
component**. Responsibilities:

| Component | Owns |
|---|---|
| Conductor | order, branching, retries |
| routing/execution layer (`run-agent.mjs` over acpx) | choice of provider/model/account, run and cancel, one result shape |
| quota collector (CodexBar) | per-account remaining, observation time, source |
| Preloop | policy and approval on requests in the common shape |
| MLflow | results, usage, evaluation |

"The others do not know the provider" means they carry no **vendor execution code**; MLflow may
record the real provider and model, Preloop may receive attributes it needs for policy.

**Success test for this phase:** the same Conductor request, the same Preloop policy and the
same MLflow recording path, with only the routing layer's choice changing, runs Claude and runs
Codex. If every vendor difference then sits inside the routing layer, the separation holds.
Until Codex has run, the change ledger below is **one path's increment**, not a generalization.

---

## Phase 3b — ACP permission requests decided by Preloop

### What Preloop 0.15.0 actually offers for native tools

`POST /api/v1/agents/permission-check` — "Decide whether an onboarded agent's native tool call may
proceed." Request: `tool_name`, `tool_input`, `source`, `session_id`, `cwd`, `agent_reasoning`,
`client_decision`. Response: `decision` (`allow`|`deny`), `reason`, `request_id`, `timed_out`.
This is the endpoint Preloop's own `permission-hook` calls; authenticated with the agent's
enrolment token from `~/.preloop/agents/<id>/permission_hook.json`.

Measured, with the policy `n7-native-deny.yaml` (a `Bash`/`builtin` rule with `action: deny`)
applied:

| request | response |
|---|---|
| `Bash`, `client_decision=allow` | `allow` — **the deny rule did not apply** |
| `Bash`, `client_decision=deny` | `deny`, "Denied by client policy" |
| `Write`, `client_decision=allow` | `allow` |
| `Bash`, no `client_decision` | held open → a pending approval request |

The pending request records its own basis:

> `rule_context.explanation`: "The agent's own permission hook escalated this call for human
> approval. **No Preloop access rule was evaluated for it.**"

So on this build, for native tools, **Preloop is an approval channel, not a policy engine**:
the client's decision is taken as given, and Preloop's contribution is to hold an `ask` open for
a human. This is the same mechanism behind F22's "hook returned local allow and never contacted
Preloop" — the hook computed `allow` locally, and even had it asked, a client `allow` is final.

Consequence for the target table: "Preloop owns the policy decision" holds today only for tools
reaching it over **MCP** (N1, rule-evaluated). For native tools the choice is between
(a) every native action escalates to a human through Preloop, or (b) a rule set somewhere else
decides `allow`/`deny` and Preloop only records the escalations. (b) is the second policy
engine the issue forbids. The adapter below does (a).

### The adapter — `run-agent.mjs`

One entry point, request JSON in, one normalized result JSON out. Vendor-specific material is
confined to a `PROVIDERS` table (agent name, Preloop `source` label, child-only env).

- `onPermissionRequest` → `permission-check` with **no** `client_decision`: the adapter holds
  no policy.
- Any error on that path → `reject_once`. acpx falls back to the configured policy when the
  handler throws or returns `undefined`, so the configured policy is `deny-all`.
- Fresh session key per run.
- Normalized `status`: `COMPLETED` | `DENIED` | `CONTROL_UNAVAILABLE` | `FAILED` | `CANCELLED`.
  `DENIED` and `CONTROL_UNAVAILABLE` are never `retryable_elsewhere`.

### Results — Claude, task "create marker.txt with your file-writing tool"

| case | Preloop | adapter status | exit | file | acpx's own `turn.status` |
|---|---|---|---|---|---|
| approve | request `2164ac02…`, approved by a second party over HTTP | `COMPLETED` | 0 | `P4` | `completed` |
| decline | request `8ac33c24…`, declined | `DENIED` | 3 | absent | `completed` |
| Preloop unreachable | `fetch failed` | `CONTROL_UNAVAILABLE` | 1 | absent | `completed` |

Every row carries the Preloop `request_id` (or the transport error) bound to the exact
`Write marker.txt` request, in `permissions.jsonl` under the run's evidence directory.

**Why the normalization is not optional:** in the decline and the unreachable cases acpx
reports `turn.status: completed, stopReason: end_turn`. The agent simply ends its turn saying
it was not allowed. A caller that reads acpx's status sees success. Without the adapter's
`DENIED`, a router would mark the run done — or, reading the text, treat it as a failure and
retry on another provider, which turns "not approved" into "ask someone else".

In the unreachable case the agent tells the user the write "was blocked by your permission
settings". The real cause was that the approval service was down. The explanation an agent
gives for a refusal is not evidence of why it was refused; the adapter's record is.

### Model identity, revisited

The Phase 2 404 is explained. The container's onboarding state maps `sonnet` to
`ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4-5` (and likewise opus/haiku). Phase 2
passed only `ANTHROPIC_MODEL=sonnet`, so the ACP adapter fell back to its own default
`claude-sonnet-5`, which the gateway could not serve. With the three `DEFAULT_*` mappings also
passed: requests go out as `anthropic/claude-sonnet-4-5` (+ `claude-haiku-4-5` for a small
auxiliary call), and the gateway logged **9 × 200, 0 × 404** for the three runs.

Three levels, kept apart:

| level | value | source |
|---|---|---|
| requested (by the caller) | none — alias `sonnet` from settings | request / env |
| adapter-reported | `anthropic/claude-sonnet-4-5` | acpx `_meta.quota.model_usage` |
| served | **unknown** | nothing on this path reports it |

Adapter-reported is what the client asked the gateway for, not what answered. Model selection
does not count as working until served identity is observable.

### Approval authority — a hole to record

The token that asks for approval (`permission_hook.json`) can also **resolve** approval
requests: both the approve and the decline in this phase were issued with it. It lives in the
agent's `$HOME`, mode 600, owned by the same uid the agent runs as. So an agent that has been
granted one shell command can read it and approve its own subsequent requests. Not exploited
here; the second party in these tests is a script (`approver.py`) standing in for a human.
Requester and approver credentials must be separated before this path counts as an approval
control — in the product (a scope on the enrolment token) or in placement (the approver
credential never inside the governed runtime).

### Stale state

Approval requests from 2026-09-20 still show `status: pending` after their `expires_at`. Expiry
is not written back to the record; a consumer listing "pending" must also check `expires_at`.

### Approval timeout — the proxy expires first

An escalated request nobody answers:

| path | after | client receives |
|---|---|---|
| `http://console/api/…` (nginx proxy) | 300.0 s | `504 Gateway Time-out` HTML page |
| `http://api:8000/api/…` (direct) | 302.5 s | `{"decision":"deny","reason":"Approval request timed out","timed_out":true}` |

Preloop's approval window is 300 s (`timeout_seconds` in the hook config, `expires_at` = request
+ 5 min) and it answers a moment after the window closes. The console proxy's own 300 s read
timeout fires first. Through the proxy, the adapter still refuses (a 504 is an error, and errors
reject) but classifies an **expired approval** as **control unavailable**. The adapter now calls
the api directly; the agent reaches it by the `api` alias on `cadp278-governed`.

After the server answered `timed_out`, the request record still read `status: pending`,
`resolved_at: null` — the stale-state issue above, confirmed on a request whose expiry was
observed.

### Approval expiry through the adapter — three clocks, all had to be fixed

The first three end-to-end expiry runs were all misclassified as `CONTROL_UNAVAILABLE` (still
refused, never allowed), each by a different clock that fired before Preloop's ~302 s answer:

| run | what cut it | fix |
|---|---|---|
| `p4-expire` | acpx run deadline 240 s | classify as `TIMED_OUT` (below); keep run deadline > approval window |
| `p4-expire2` | nginx console proxy, 504 at 300 s | call `api:8000` directly — but the container's `PRELOOP_URL=http://console` (set for the Preloop CLI) overrode the new default; the adapter now reads its own `PRELOOP_API_URL` |
| `p4-expire3` | Node `fetch` (undici) default `headersTimeout` 300 s | `node:http` for this call; the run deadline is the only bound |
| `p4-expire4` | — | **`DENIED`, `denial: approval_expired`, request `ab85cc10…`**, 314 s, no file |

Deadline shorter than the approval window, `p4-deadline` (60 s): **`TIMED_OUT`,
`run_ended_awaiting_approval`**, no file, not retryable elsewhere.

Default timeouts of 300 s sit on both sides of a 300 s approval window. Any layer added
between the adapter and Preloop (a proxy, a service mesh, an HTTP client upgrade) can move an
expiry back into "unavailable". Worth a regression check whenever the path changes.

**Orphaned approval.** After `p4-deadline` ended, its Preloop request `1d8e1412…` was still
`pending` and approvable for four more minutes. Approving it would record an approval that
authorised nothing. Preloop 0.15.0 exposes approve/decline/decide but no withdraw; the adapter
does not decline on its own, since declining is a decision. Open item: a withdraw/cancel on
run end, or a record the approver sees saying the requester is gone.

Regression after the client change: `p4-approve2` → `COMPLETED`, file `P4`, request `f42db1e3…`.

### Phase 3 status for Claude

| requirement | status |
|---|---|
| native Write routed to Preloop through the common layer | **done** — every case carries the Preloop `request_id` |
| approve → action happens | done |
| decline → action does not happen, result `DENIED` | done |
| approval expires → `DENIED` (`approval_expired`) | done, after three clock fixes |
| Preloop unreachable → refused, `CONTROL_UNAVAILABLE` | done |
| run deadline during approval → refused, `TIMED_OUT` | done |
| Preloop **policy** (rules) decides native actions | **not available** in 0.15.0 — approval channel only |
| requester cannot approve itself | **not met** — same token does both |
| shell route (`Bash`) through the adapter | covered by acpx in Phase 3; not yet re-run through Preloop |

---

## Phase 2–3 for Codex — same adapter, same Preloop, provider switched in the request

Codex logged in inside the container (`codex login --device-auth`, ChatGPT account, own
credential lineage; temporary egress detached afterwards, isolation re-verified).

### Model route

- Bare (`c0`): no gateway configured → `failed to lookup address information`; nothing left
  the container. Fails closed, like Claude case A.
- Preloop's `discover` did not list Codex until `~/.codex/config.toml` existed (an empty file
  suffices). Then: `Codex CLI · full · ChatGPT OAuth tokens present in auth.json`.
- `preloop agents onboard codex` (inside the container, **without** `--approvals` — approvals go
  through the adapter; a second hook would double-ask) wrote `model_provider = 'preloop'`,
  `base_url = 'http://console/openai/v1'`, `wire_api = 'responses'`, model
  `openai/gpt-6-astra`, and took custody of the ChatGPT OAuth credential. Undo:
  `preloop agents offboard "Codex CLI"` (backup saved).
- Preloop forwards `/openai/v1/responses` to `chatgpt.com/backend-api/codex/responses` with the
  custodied credential and `chatgpt-account-id` (gateway source,
  `_create_openai_codex_response`).
- `c1`: `C1_OK`, gateway `POST /openai/v1/responses 200`. **No adapter change**: codex-acp reads
  `~/.codex/config.toml`, whereas acpx's Claude profile skips Claude's user settings. The two
  vendors differ in *where* the route has to be put, not in the adapter's interface.
- codex-acp runs its **bundled** Codex (`client_version=0.154.0` on the wire), not the
  separately installed `@openai/codex@0.155.1`. The version that runs is the adapter's
  dependency; pin it there (`CODEX_PATH` can override).

### Approvals — Codex does not ask the client by default

First attempt (`c2`/`c3`, default mode): **no ACP permission request at all.** codex-acp's
default mode `agent` sets `approvalsReviewer: auto_review`, i.e. Codex's own **Guardian**
reviewer model decides escalations. Its model was not registered in Preloop → gateway 404 →
Guardian denied. The adapter saw a `completed` turn with no permission events and reported
`COMPLETED` while the file was absent — neither approval nor denial ever reached Preloop.

codex-acp modes (from its source):

| mode | approval policy | reviewer | sandbox |
|---|---|---|---|
| `read-only` | on-request | **user** (the ACP client) | workspace-write |
| `agent` (default) | on-request | **auto_review** (Guardian model) | workspace-write |
| `agent-full-access` | never | user | none |

`PROVIDERS.codex.env = { INITIAL_AGENT_MODE: "read-only" }` → escalations become ACP
permission requests → Preloop:

| run | Preloop | status | file |
|---|---|---|---|
| `c4-approve` | Edit `dbdb6ab4…` approved, Run `c044f956…` approved | `COMPLETED` | `P4` |
| `c5-decline` | Edit `a6e89631…` declined | `DENIED` (exit 3) | absent |
| `c6-approve` | Edit `d4c3bb13…`, Run `2569a26b…` approved | `COMPLETED` | `P4` |

**The same adapter, the same Preloop endpoint and the same normalized result**, with the
provider named only in the request.

Lesson for the result contract: a vendor's *internal* reviewer can refuse an action without
any permission event reaching the client. "No denial observed" is not "nothing was denied";
the router must know which approval mode each vendor is in, and that knowledge belongs in
the provider profile.

### Codex's sandbox does not work in this container

`bwrap: No permissions to create a new namespace` — Docker's default profile blocks
unprivileged user namespaces. Every sandboxed Codex shell command fails first, and Codex then
asks to run it **outside** the sandbox, which becomes a Preloop approval (`Run command`). So
here every Codex shell command is human-approved, and approving it means unsandboxed
execution inside the (network-isolated) container. Not changed: enabling userns in the
container is a security-profile change.

### What the approver sees — fixed in the shared part

Codex sends an edit's permission request with `rawInput: null`; the target is in the ACP
`locations` and diff `content`. The first Codex approvals therefore reached Preloop as
"Edit files" with **no file named** — an approver cannot meaningfully approve that. The
adapter now forwards `_acp_locations` and `_acp_diffs` for every vendor. After the fix:

- Claude: path + full new content (`is_new: true`, `"P4"`).
- Codex: path only (`/…/marker.txt`); its request carries no diff content. The content of a
  Codex edit is **not** visible to the approver at approval time.

### Change ledger — updated with Codex

| # | change | where | vendor-specific? |
|---|---|---|---|
| 1 | node, acpx, both ACP adapters in the image | image | shared |
| 2 | Claude gateway env (base URL, key, alias + 3 mappings) | `PROVIDERS.claude` | Claude |
| 3 | fresh session key per run | adapter | shared |
| 4 | `onPermissionRequest` → Preloop, fail closed | adapter | shared (`source` label per vendor) |
| 5 | result normalization | adapter | shared |
| 6 | forward ACP `locations` / diffs to the approver | adapter | shared (found via Codex) |
| 7 | Codex gateway route: `config.toml` via Preloop onboarding (+ empty file so discover sees Codex) | container Codex config | Codex, **outside** the routing layer |
| 8 | `INITIAL_AGENT_MODE=read-only` | `PROVIDERS.codex` | Codex |

Against the success test: Conductor was not in these runs yet (the adapter was invoked
directly), and MLflow recording is not wired. Within the routing layer, every vendor
difference is confined to `PROVIDERS` **except #7**, which lives in the container's Codex
config written by Preloop onboarding. Moving it into the profile (codex-acp `CODEX_CONFIG` /
`MODEL_PROVIDER`) would make the separation complete; not yet tried.

---

## Option B — file work over MCP, decided by Preloop rules

Why: for native tools Preloop 0.15.0 only relays approvals (Phase 3b). For MCP tools it
evaluates rules (N1). So file work is moved onto an MCP server behind Preloop, and the
vendors' native write/shell tools are removed where the vendor allows it.

### Setup

- `cadp278-fsmcp`: official `@modelcontextprotocol/server-filesystem@2026.8.31` (stdio)
  wrapped by `supergateway@4.0.0` as Streamable HTTP, because Preloop only proxies
  URL-addressed MCP servers. On `cadp278-toolnet` only; from the agent, `cadp278-fsmcp:8000`
  is unreachable (`000`) — the only route is Preloop's MCP proxy.
- Shared volume `cadp278-ws` at `/ws` in both containers (same absolute paths on both sides).
- Policy `policy/b-fsmcp.yaml` (CEL): `write_file` / `edit_file` / `create_directory` /
  `move_file` denied when the path is under `/.claude` or ends in `forbidden.txt`.
- After `policy apply`, the new server's tools were **not** exposed until
  `POST /api/v1/mcp-servers/{id}/scan` ("Discovered 14 tools"). `GET …/tools` for the same
  server returns 500 (a Pydantic `UUID`-vs-`str` validation error) — a Preloop defect.

Rule check without a model (`mcp_call.py`, each principal's own MCP bearer):

| principal | `/ws/rt/ok-*.txt` | `/ws/rt/forbidden.txt` | `/ws/rt/.claude/settings.json` |
|---|---|---|---|
| Claude Code | written | "Access denied: …" | "Access denied: …" |
| Codex CLI | written | "Access denied: …" | "Access denied: …" |

**A rule denial comes back with `isError: false`** — as an ordinary tool result whose text
starts `Access denied:`. The adapter can only detect it by matching that text (`mcp_denials`);
this is fragile and would fail silently if Preloop rewords it.

### Wiring, per vendor (adapter `native_tools: false`)

Shared: the adapter attaches Preloop's MCP endpoint to the ACP session (`mcpServers`, with the
principal's own bearer, so Preloop attributes calls to the right agent).

| | Claude | Codex |
|---|---|---|
| remove native write/shell | project settings in the run's workspace, `permissions.deny` Write/Edit/MultiEdit/NotebookEdit/Bash | `features.shell_tool=false`, `features.unified_exec=false` via `CODEX_CONFIG` |
| what remains native | nothing that writes (measured: `WRITE_UNAVAILABLE`) | `apply_patch` — no off switch in Codex 0.154; escalates to Preloop **human approval** |
| stop the vendor asking the client for each MCP call | adapter recognises `_meta.claudeCode.mcpServer = {name: preloop, source: dynamic}` and passes it (decision is at the MCP proxy) | `mcp_servers.preloop.default_tools_approval_mode = "approve"` |

Not tried first and rejected: Claude **managed settings** (`/etc/claude-code/managed-settings.json`)
do remove Write/Bash under acpx (measured), but they apply to the whole container and would
strip Write/Bash from the #278 and #280 workflows too. Removed after the test; nothing else
ran in that window.

Two things that did not work, recorded because both look like they should:

- Claude: `permissions.allow: ["mcp__preloop__*"]` and `["mcp__preloop"]` in project settings did
  **not** stop Claude asking the client about the ACP-attached server (`source: "dynamic"`).
  Deny rules from the same file do apply. Cause not established.
- Codex, without `default_tools_approval_mode`: the MCP call became an ACP permission request
  carrying **only** `_meta.is_mcp_tool_approval: true` — no server, no tool, no arguments.
  An approver shown that cannot know what they are approving.

### Results — same request, provider switched

| provider | `ok.txt` | `forbidden.txt` | `.claude/settings.json` |
|---|---|---|---|
| Claude | `COMPLETED`, `B1` | `DENIED` (rule), absent | `DENIED` (rule), file unchanged |
| Codex | `COMPLETED`, `B1` | `DENIED` (rule), absent | `DENIED` (rule), absent |

No human approval was involved in any of the six; the decisions are Preloop rule evaluations.

Native bypass attempts under B (Codex, explicitly told not to use MCP):

| tool | outcome |
|---|---|
| shell | `NATIVE_UNAVAILABLE` — tool absent |
| apply_patch → `forbidden.txt` | ACP permission request → Preloop approval; unanswered → `TIMED_OUT`, absent |

**Residual:** the Codex `apply_patch` route is governed by human approval, not by the rules.
A human who approves it can write `forbidden.txt`; the approver sees the path
(`_acp_locations`) but not the content. Closing it needs either an off switch in Codex or
Preloop evaluating rules on the native permission check.

### Change ledger — option B additions

| # | change | where | vendor-specific? |
|---|---|---|---|
| 9 | fsmcp container, `/ws` volume, `b-fsmcp.yaml`, one `scan` call | infrastructure / Preloop | shared |
| 10 | attach Preloop MCP to the ACP session with the principal's bearer | adapter (+ `mcpAuth` per vendor) | shared mechanism, per-vendor token location |
| 11 | remove native write/shell | `PROVIDERS.*.disableNative` | per vendor |
| 12 | don't double-ask for Preloop MCP calls | `PROVIDERS.claude.governedDownstream` / Codex config | per vendor |
| 13 | detect MCP rule denials by text | adapter | shared, fragile |

---

## Phase 4 — one Conductor workflow, Gate and MLflow record; provider chosen by input

`p281/workflows/route.yaml`: `execute` (script → `run-agent.mjs`) → `check` (deterministic:
the file on disk, not the agent's account) → `record` (MLflow REST) → terminate. The only
thing that differs between runs is `-i provider=…`.

| run | Conductor run | adapter status | Gate | file | tokens | MLflow run |
|---|---|---|---|---|---|---|
| claude, `routed.txt` | `4f0b4e59` | `COMPLETED` | `PASS` | `R1` | 69,424 | `38ee8cff…` |
| codex, `routed.txt` | `03096e3f` | `COMPLETED` | `PASS` | `R1` | 11,420 | `af01a6c6…` |
| claude, `forbidden.txt` | `a3b87a82` | `DENIED` (Preloop rule) | `DENIED` | absent | 69,379 | `f65d9830…` |
| codex, `forbidden.txt` | `4978e1ea` | `DENIED` (Preloop rule) | `DENIED` | absent | 11,397 | `5918c572…` |

No human approval in any run (`approvals_requested = 0`); every decision is a Preloop rule
evaluation at the MCP proxy.

MLflow (experiment `p281-routing`): each run carries provider, status, Gate decision and
reason, the three model levels, token and wall-time metrics, the evidence path, and the
adapter's full `result.json` as an artifact. Each is tagged `conductor.run_id`; **all four**
IDs are found in Conductor's own OTel traces in experiment `1`, so the routed execution and
the workflow trace join on it without a collector.

**The success test, measured.** Workflow YAML and the three step scripts contain **no vendor
name** (`grep` for claude/codex/anthropic/openai/gpt/sonnet: only the usage example in a
comment). All vendor material is in `run-agent.mjs` (`PROVIDERS` and its comments, 25 lines
mentioning a vendor), plus one item outside it: Codex's gateway route in the container's
`~/.codex/config.toml`, written by Preloop onboarding (ledger #7).

What the record also makes visible: the same task cost ~69k tokens on Claude and ~11k on
Codex. Most of Claude's is cached input (the Claude Code system prompt and tool definitions);
this is a per-run fixed cost of the agent, not of the task, and is the kind of number the
router's choice should see.

Model identity is still `served: unknown` for both: nothing on these paths reports what
actually answered. The MLflow record keeps the requested/adapter-reported/served split.

---

## Operations note — Docker Desktop failed to start after an idle period (2026-09-22)

Docker Desktop stopped (the host had been idle) and then would not start:

```
starting services: initializing Ingest server: listening on unix://…/Docker/run/sailor-ingest.sock:
rename …sailor-ingest.sock …sailor-ingest.sock.stale: The file cannot be accessed by the system.
```

Stale AF_UNIX socket files left by the previous run could be neither renamed nor moved
(`Error 1920`), even after `wsl --shutdown`; the second start failed the same way on
`docker-secrets-engine/engine.sock`, and a third on the socket the failed second start had
itself left behind. Fix: stop Docker Desktop and WSL, rename the **directories**
`%LOCALAPPDATA%\Docker\run` and `%LOCALAPPDATA%\docker-secrets-engine` aside (a directory
rename succeeds where the socket file cannot be touched), start once cleanly. Nothing was
deleted; the renamed directories are kept. The error dialog's "Reset to factory defaults"
would have erased the volumes holding the container logins and Preloop's database.

After the restart the PoC containers were `Exited (255)` (no restart policy); `docker start`
plus the network re-attach restored everything, isolation re-verified.

Idle sleep is now blocked while `tools/keep-awake.ps1` runs (`SetThreadExecutionState`,
`ES_CONTINUOUS | ES_SYSTEM_REQUIRED`; no power setting changed; ends with the process).

---

## Phase 5 — quota-based routing

### Observation sources

| provider | source | account binding | freshness |
|---|---|---|---|
| codex | CodexBar 0.63.0 in the **observer container** `cadp278-quota` (egress, own `codex login --device-auth` — done by the operator from a phone; passkey login worked) | observer's `identity.accountEmail` vs the id_token email of the agent's `~/.codex/auth.json`, compared as sha256 fingerprints — **basis "email"**; matched | provider `updatedAt`, re-collected every 300 s |
| claude | Preloop gateway's stored upstream headers (`anthropic-ratelimit-unified-5h/7d-utilization`, via `GET /api/v1/account/gateway-usage/rate-limits`) — **no new login needed** | the Preloop-custodied OAuth credential is both the observed and the executing account — **basis "structural"**, no email on either side | only when Preloop writes a usage row |

- Observer placement: the observer has egress and credentials, so it joins no network the
  agent is on and runs no service. It writes `/obs/codex.raw.json`; the agent mounts that
  volume **read-only** (`touch` → "Read-only file system"). Agent isolation re-verified.
- The two containers were confirmed to be the same ChatGPT account before use (email and
  account-id fingerprints equal) without either email leaving the stack.
- **Codex reports no session (5 h) window** for this account (`primary: null`); only weekly.
  The policy requires `weekly`; an unreported optional window is recorded as "not reported",
  never assumed empty.
- **Codex quota is invisible on the execution path**: Preloop keeps only headers containing
  `ratelimit` (Codex's are not), and Codex's own rollout records `rate_limits` with every
  field `null` behind the gateway. Hence the observer.
- **Claude's Preloop-sourced observation goes stale**: snapshots ride on usage rows, and
  successful agent calls write none (#278 F25). The newest Anthropic snapshot was ~16.7 h old
  despite many successful Claude runs today. With a 30-minute freshness bound Claude is
  never eligible from this source — the router says so rather than using the old number.

### Router (`router.py`, no vendor code) and policy (`routing-policy.json`)

Per candidate, in preference order (`claude`, `codex`): no observation → unknown;
observed ≠ executing account → `account_mismatch`; older than 1800 s → `stale`; future
timestamp → unknown; required window missing → unknown; any reported window ≥ its limit
(session 80 %, weekly 90 %) → `exhausted`. First eligible wins; none → **HOLD, nothing runs**.

### Fault injection (`router_controls.py`, deterministic): 12 / 12

| case | expected | got |
|---|---|---|
| live observations | ROUTE codex | ROUTE codex (claude stale 60 271 s) |
| claude made fresh | ROUTE claude | ROUTE claude |
| claude fresh, session 85 % | ROUTE codex | ROUTE codex |
| **codex account mismatch** | HOLD | HOLD |
| codex mismatch, claude fresh | ROUTE claude | ROUTE claude — never the mismatched one |
| codex executing account unknown | HOLD | HOLD |
| **codex stale (2 h), numbers fine** | HOLD | HOLD |
| codex timestamp 1 h in the future | HOLD | HOLD |
| codex required weekly window missing | HOLD | HOLD |
| codex weekly 95 % | HOLD | HOLD |
| observer down (no file) | HOLD | HOLD |
| both fresh, both exhausted | HOLD | HOLD |

### End to end — `p281/workflows/auto.yaml`

`route` (collect + decide) → `execute` → `check` → `record`, or `route` → `record_hold` →
`held`.

| run | route | outcome | MLflow |
|---|---|---|---|
| live policy | `ROUTE codex: within limits` (claude stale) | `COMPLETED`, Gate `PASS` | recorded with the router's evaluation |
| strict test policy (weekly ≤ 10 %) | `HOLD: claude=stale; codex=exhausted: weekly 19% >= 10%` | not started — **0 gateway requests** in the window | recorded as `HOLD / NOT_RUN` |

The first HOLD run left no MLflow record (the record step was on the execute path only);
a `record_hold` step was added, because not starting is a result that has to be auditable.

Workflow and router contain no vendor name; vendor translation lives in the collector
(`collect_obs.py`) and the execution profile (`run-agent.mjs`).

### Not established

- Claude quota from a first-hand source (a CodexBar Claude login in the observer needs the
  operator at the PC; the Preloop source is stale by construction on this build).
- The Claude identity binding is structural (single custodied credential), not a compared
  identity.
- Observer liveness: the loop runs via `docker exec -d` and does not survive a container
  restart; a restart shows up as `stale` (fail closed), not as wrong numbers.

---

## Option B, model path — the routing layer owns the provider connection (Codex)

Why: Conductor decides *when* to call a model and the router decides *which*; but the pipe
and the credential were still Preloop's gateway, so the usable providers were still bounded
by what Preloop's gateway supports. That placement came from #278's setup (a §4.1 test item,
the "gateway is the only egress" isolation, and onboarding taking custody — F8), not from
Preloop owning the decision.

### Setup

- `cadp278-egress`: tinyproxy, CONNECT :443 only, allowlist `chatgpt.com`, `auth.openai.com`,
  `api.openai.com`, `api.anthropic.com`, `platform.claude.com`, `console.anthropic.com`,
  `claude.ai`. On `cadp278-governed` (alias `egress`) and `cadp278-egressnet`. Measured: the
  agent still has no default route and no direct egress; through the proxy the provider hosts
  answer (403/404 from the servers) and `pypi.org`, `github.com`, `example.com` are refused
  ("Proxying refused on filtered domain").
- `cadp278-route-creds` at `/route` (mode 700): the routing layer's **own** Codex login
  (`CODEX_HOME=/route/codex codex login --device-auth`, via the proxy; operator on a phone).
  A separate lineage from the credential Preloop custodies (F8: never share a rotating token
  between two custodians). Same ChatGPT account (email fingerprint equal).
- Adapter: request `model_route: "direct"` → `PROVIDERS.codex.directEnv()` = `CODEX_HOME` +
  proxy env; the Preloop MCP server (tools stay governed by Preloop) is now defined entirely in
  `CODEX_CONFIG` (env, not written anywhere) instead of the onboarding-written config file.

### Results

| run | route | Preloop gateway model requests | egress | outcome |
|---|---|---|---|---|
| `d1` (first try) | direct | **0** | `chatgpt.com` ×13 | `TIMED_OUT` — see below |
| `d2` `ok.txt` | direct | **0** | `chatgpt.com` ×16 | `COMPLETED`, file `D1` |
| `d3` `forbidden.txt` | direct | **0** | `chatgpt.com` | `DENIED` by the **Preloop MCP rule**, file absent |

So: model traffic no longer touches Preloop; file work is still decided by Preloop's rules.

`d1` failed because the MCP auto-approve setting (`default_tools_approval_mode`) had been
attaching to the server entry that Preloop onboarding wrote into `~/.codex/config.toml`. With
`CODEX_HOME` moved, that file is not read, the setting attached to nothing, and the MCP call
fell back to a nameless client approval. Defining the server fully in `CODEX_CONFIG` fixed it
— and removed ledger item #7: **Codex's configuration no longer depends on anything outside
the routing layer.**

`*.oaiusercontent.com` (several regional hosts) is contacted by Codex at start and refused by
the allowlist; runs complete without it. Purpose not established; left refused.

### Quota on the execution path

Behind the Preloop gateway, Codex's rollout carried `rate_limits` with every field `null`.
On the direct route the same record carries:

```
"primary": {"used_percent": 19.0, "window_minutes": 10080, "resets_at": 1790419759}, "plan_type": "prolite"
```

— the same numbers CodexBar reports from the observer. The routing layer now sees the quota
of the account it executes as, from its own execution, without Preloop and without a second
login. The observer remains useful before the first run and when idle.

### Still open

- Claude on the direct route: needs a routing-layer Claude login (`CLAUDE_CONFIG_DIR=/route/claude`
  + proxy), which has to be pasted into a terminal — operator at the PC.
- `collect_obs.py` should read Codex quota from the routing layer's own rollouts as the primary
  source (fresh after every run), with the observer as fallback.

### Quota collection now prefers the execution layer's own record

`collect_obs.py` takes the policy's `model_route` per provider (`codex: direct`,
`claude: preloop_gateway` until Claude has a routing-layer login) and, for Codex, considers:

1. **the routing layer's own session rollouts** (`/route/codex/sessions`): the `rate_limits` the
   provider returned to the login that executes — identity basis `same-credential`;
2. the observer's CodexBar reading — basis `email`, compared against the executing login.

The newest wins (timestamps compared as times, not strings); the other is kept under
`other_sources`. Windows are classified by length (≤ 1 day = session, else weekly), because
the rollout labels the weekly window `primary` and CodexBar labels it `secondary`.

Measured: before a run the observer reading (04:58:50) was newest and was used; immediately
after an auto-routed run the rollout (05:00:08, `same-credential`) was newest and was used.
Both reported weekly 19 %. Router controls re-run on the new observations: 12/12.

End to end, `auto.yaml`: `ROUTE codex` → executed on the **direct route** (Preloop gateway
model requests 0, egress `CONNECT chatgpt.com` ×18) → Gate `PASS` → MLflow, now tagged with
`model_route`.

The observer is now a fallback: it matters before the first run and after idle periods, when
the rollout is older than the freshness bound.

---

## Decision (2026-09-22): keep the acpx layer as the routing solution

Considered: moving routing and quota logic onto a model-API gateway (LiteLLM Proxy, the de facto
open-source choice) and patching it for subscriptions. Rejected for now:

- **Subscriptions are a hard requirement.** Gateways of this kind assume pay-per-token API keys.
  Their budgets are dollar spend (zero on a subscription) and their usage-based routing
  counts their own tokens/requests. Neither is the provider's 5 h / weekly utilization,
  which is what subscription quota is.
- **They route model calls, not agents.** Switching Claude ↔ Codex means switching the whole
  agent CLI; a model-level router would instead feed one agent's requests to another vendor's
  backend (the Codex subscription backend expects Codex-shaped requests).
- What such a gateway would add (fallback/cooldown, rule-based routing, logging) is useful
  mainly *within* one vendor (several accounts or models). If that becomes a need, it can sit
  under the acpx layer later. Using subscription tokens through a proxy or pooling accounts
  must be checked against provider terms first.

Consequence: the routing layer stays self-maintained — acpx (agent execution) + `run-agent.mjs`
(profiles, Preloop wiring, result contract) + `router.py` / `collect_obs.py` (quota routing)
+ the observer and the allowlist egress.

---

## A third provider: Grok Build (xAI), and routing between real choices

Why: routing can only be tested with two providers eligible at once. Claude's quota source is
stale (Preloop gateway snapshots) and a routing-layer Claude login needs the operator at the
PC; Grok could be logged in from a phone.

Antigravity (agy) was **not** added. Google's Antigravity terms state that using third-party
software to access the service with Antigravity OAuth — the example given is "OpenClaw with
Antigravity OAuth", and acpx is an OpenClaw project — is a breach that may suspend Antigravity
*and* Gemini CLI accounts; paying subscribers were reported suspended in September 2026. The
official agy has no ACP mode (feature request open); it has a headless stream-json mode, which
might be a sanctioned path but was not assessed. Not tried on the operator's account.

### Setup

- `@xai-official/grok@1.0.40` in the image; acpx's built-in `grok-build` profile, overridden to
  `grok agent --no-leader stdio` (the default shared "leader" process would let runs share one
  backend).
- Routing-layer login `GROK_HOME=/route/grok` via `grok login --device-auth` through the
  allowlist proxy (operator on a phone). SuperGrok account.
- Allowlist + `auth.x.ai`, `accounts.x.ai`, `api.x.ai`, `cli-chat-proxy.grok.com`. Refused and
  not needed for runs: `grok.com`, `api.mixpanel.com` (telemetry), `preloop.ai`,
  `registry.npmjs.org`.
- Preloop MCP registered in Grok's own config (`grok mcp add preloop http://console/mcp/v1`).

### Three problems found on the way

1. **Grok ignores an MCP server handed over ACP.** `session/new` carried the server; Grok's log
   shows no connection attempt, and its tool search waited for a server "still connecting".
   Registered in its own config the same server is healthy (`grok mcp doctor`: handshake OK,
   20 tools). Profile uses the config (`mcpViaConfig`), like Codex.
2. **Grok imports Claude Code's user settings from `$HOME`.** Its MCP doctor lists
   `~/.claude.json` as a config source, and captured ACP traffic shows `hook_run_started
   pre_tool_use` running `global/settings:pre_tool_use[0]` — the Preloop permission hook that
   onboarding installed **for Claude**. Every Grok tool call became a Preloop human-approval
   request labelled `claude_code` and stalled for the hook's 300 s timeout (7 stray requests,
   declined afterwards). A cross-vendor configuration leak, and a mis-attribution in Preloop's
   record. Fix: `HOME=/route/grok/home` for the Grok process; the doctor then reports
   `~/.claude.json not found`.
3. **Grok asks the client about its own MCP calls.** A `permissions.allow = ["mcp__preloop__*"]`
   entry in Grok's config did not stop it. The profile recognises the call
   (`_meta["x.ai/tool"].name == "use_tool"`, `rawInput.tool_name` prefixed `preloop__`) and
   passes it, because the decision is Preloop's rule at the MCP proxy — as for Claude.

Also seen: acpx prints `Got response to unknown request skills-reload` (Grok's `_x.ai/*`
extension traffic); harmless once the hook stall was removed.

### Results

| run | outcome | file | Preloop gateway |
|---|---|---|---|
| `ok.txt` | `COMPLETED`, 14 s | `G1` | 0 |
| `forbidden.txt` | `DENIED` by the Preloop rule | absent | 0 |
| native write, told not to use MCP | ACP permission → Preloop approval, unanswered → `TIMED_OUT` | absent | 0 |

Native write/shell for Grok are not removed yet (it has `--deny` rules; not wired). As with
Codex's `apply_patch`, they are held for human approval, where the rules do not apply.

### Quota

CodexBar reads Grok quota with the routing layer's own login, through the proxy, **inside the
agent container** — no observer needed: SuperGrok, weekly 1 %, resets 2026-09-28,
`updatedAt` present. Basis `same-credential`. No session window reported.

The Claude source had started failing with 401: the collector read the Preloop CLI token from
`config.yaml`, which had expired; it now asks `preloop auth token`, which refreshes.

### Routing between real choices

Live observations: codex weekly 19 %, grok weekly 1 %, claude stale.

| policy | route | executed on | Preloop gateway | egress | Gate |
|---|---|---|---|---|---|
| default (weekly ≤ 90 %) | `ROUTE codex` | Codex, direct | 0 | `chatgpt.com` | PASS (earlier run) |
| codex's real 19 % over a 15 % test limit | **`ROUTE grok`** | Grok, direct | 0 | `api.x.ai`, `cli-chat-proxy.grok.com` | **PASS** |

The choice changed because of the providers' own reported quota, and the workflow, Gate and
MLflow record were the same for both.

Router controls, now over three providers: **14 / 14** — every codex fault (account mismatch,
unknown executing account, stale, future timestamp, missing window, exhausted, observer down)
falls through to grok; grok mismatch + codex exhausted → HOLD; both stale → HOLD; all three
exhausted → HOLD; codex and grok exhausted with claude fresh → claude.

### Preloop attribution for Grok

Grok is not a Preloop-onboarded agent, so its MCP calls use the Claude Code principal's MCP
bearer and are recorded under that principal. Open: a Grok principal of its own.

### Grok native tools removed (2026-09-22)

The earlier "allow rule had no effect" was a mistake in the section name: Grok's config uses
`[permission]`, not `[permissions]`. With the documented form in the routing layer's
`/route/grok/config.toml` (outside `/ws`, so the filesystem MCP cannot edit it):

```toml
[permission]
deny  = ["Bash", "Edit", "Write", "WebFetch", "WebSearch"]
allow = ["MCPTool(preloop__*)"]
[ui]
remember_tool_approvals = false
```

| run | outcome | ACP permission requests | file |
|---|---|---|---|
| MCP `ok.txt` | `COMPLETED`, 17 s | **none** (the allow rule now applies) | `G1` |
| MCP `forbidden.txt` | `DENIED` by the Preloop rule | none | absent |
| told to use built-in write, then shell | both blocked by Grok's deny rules → `NATIVE_UNAVAILABLE` | none | absent |

For Grok the residual that remains for Codex's `apply_patch` is closed: there is no native
write path left that a human approval could open. Deny rules win over every other rule and
mode in Grok's documented evaluation order.

---

## Claude on the direct route — separation complete for all three providers (2026-09-22)

- Routing-layer login: `CLAUDE_CONFIG_DIR=/route/claude claude auth login --claudeai` through the
  allowlist proxy (operator at the PC). `claude auth status`: logged in, `claude.ai`, Max,
  `configDirectory: /route/claude`. A lineage separate from the credential Preloop custodies.
- Profile: `directEnv = {CLAUDE_CONFIG_DIR, proxy}`, and on this route the gateway variables
  (`ANTHROPIC_BASE_URL`, gateway key, model aliases) are **not** passed. `CLAUDE_CONFIG_DIR` also
  moves Claude's user tier away from `~/.claude`, where onboarding installed the Preloop hook
  and MCP entry — the same class of leak Grok showed.

| run | outcome | file | Preloop gateway | egress |
|---|---|---|---|---|
| MCP `ok.txt` | `COMPLETED`, 9 s | `C1` | 0 | `api.anthropic.com` |
| MCP `forbidden.txt` | `DENIED` by the Preloop rule | absent | 0 | `api.anthropic.com` |

Adapter-reported models: `claude-opus-5[1m]` (the Max default) and `claude-haiku-4-5`. Served
model still not observable.

**Account connectors blocked by the allowlist.** Claude tried `mcp-proxy.anthropic.com` — the
claude.ai account's own MCP connectors — and was refused ("authorize it in your claude.ai
connector settings" in its reply). Had it been allowed, those connectors would have been a
tool path that does not pass through Preloop. Kept refused on purpose. Also refused:
`http-intake.logs.us5.datadoghq.com` (telemetry).

**Quota, fresh.** CodexBar honours `CLAUDE_CONFIG_DIR`: with the routing login, through the
proxy, inside the agent container — session (5 h) 9 %, weekly 55 %, plus a "Fable only" weekly
window 36 % (kept as `extra_windows`), `updatedAt` current. Basis `same-credential`; identity is
the login's organisation UUID. The stale Preloop-snapshot source is no longer used when Claude
routes directly.

**Routing with three fresh providers.** Policy `model_route` = direct for all three. Live:
claude 9 % / 55 %, codex 19 %, grok 2 % → `ROUTE claude` (first in preference and within limits).
`auto.yaml` end to end: `ROUTE claude` → Claude direct (Preloop gateway model requests 0,
`api.anthropic.com` ×14) → Gate `PASS` → MLflow.

Router controls rewritten to set Claude's state explicitly rather than rely on it being
stale: **15 / 15** (claude stale / session-exhausted / account-mismatch each fall to codex;
every codex fault with claude out falls to grok; all stale → HOLD; all exhausted → HOLD;
codex and grok exhausted → claude).

### Status against the goal — final for this PoC

| | Claude | Codex | Grok |
|---|---|---|---|
| model path + login owned by the routing layer | ✅ | ✅ | ✅ |
| quota observed outside Preloop, same credential | ✅ | ✅ (+ observer) | ✅ |
| tools governed by Preloop rules (MCP) | ✅ | ✅ | ✅ |
| native write/shell | off (project deny) | shell off; `apply_patch` → human approval | off (own deny rules) |
| Preloop gateway on the model path | no | no | no |

Conductor, Preloop and MLflow no longer own any provider. The Preloop gateway and its
custodied credentials are now used only by the #278 Conductor-provider path.

---

## Fixes after review (2026-09-22)

Review verdict: provider-separation PoC succeeded; #281 overall **PARTIAL**. Four boundary
defects fixed before reuse.

### 1. Codex rollout quota could be attributed to the wrong login

Rollouts record no account (`session_meta` has id, cwd, originator, provider — no identity),
yet the collector labelled any rollout with the *current* login. After an A→B re-login in the
same `CODEX_HOME`, A's still-fresh quota would have been used as B's. (Not observed here; a
defect before account changes are supported.)

Fix: the adapter now writes a **session ledger** (`/route/codex-session-ledger.jsonl`, outside
`/ws`): per run, Codex's session id (`backendSessionId`, which is the rollout file's id) and the
login fingerprint read at start *and* end — a login that changed during the run binds the
session to no account. The collector accepts a rollout only if the ledger binds its session
to the current executing account.

| ledger | rollout used? | source chosen |
|---|---|---|
| session bound to the current login | yes | rollout, `same-credential` |
| same session bound to another account (A→B) | **no** | observer, email-compared |
| no ledger (pre-fix runs) | **no** | observer |

### 2. Malformed quota numbers

`-1` and `NaN` passed as eligible; a string crashed the whole selection. Now a usable
utilisation must be a real, finite number in [0, 100] (bool excluded); anything else makes that
candidate `unknown` and the others are still evaluated; any exception inside one candidate's
evaluation is contained the same way. Controls added: `-1`, `NaN`, `Infinity`, `150`, `"55"`,
`true`, windows as a list, `observed_at` as a number, every candidate malformed → HOLD.
Controls now **24 / 24**.

### 3. Missing token usage recorded as 0

`execute.py` wrote `total_tokens: 0` when the adapter reported none. Now missing measurements
are omitted: they live in an optional-field object `measurements` (Conductor allows optional
fields only inside objects), and `record.py` logs a metric only when it is a real number.

### 4. An MLflow failure changed the run's outcome

Before, a failing record step stopped the workflow short of its terminal step, so the #278 N5
property ("observation failure does not change the decision") did not hold here. Now
`record.py` never fails: it reports `record_error` and exits 0; routing is on the Gate
decision as before. Measured with MLflow unreachable (`MLFLOW_URL=http://mlflow-down:5000`):
Conductor exit 0, terminated at `done_pass`, decision `PASS`, `record_error = "URLError …
name resolution"`, `mlflow_run_id` empty. `record_error` is now a workflow output.

### Scope, restated

Validated: choosing a provider for a **fixed file task** from provider-reported quota.
Not validated: per-task capability or allowed-model filtering, per-model quota windows
(e.g. Claude's "Fable only" window is recorded but not used), served-model identity. This
result does not extend to arbitrary research/development tasks or to model-level routing.

---

## #280 Phase R through the routing layer (option A: the model proposes and reviews, never verifies)

`p281/workflows/research-r.yaml`: `route` → `stage_in` → **propose** (routed) → `normalize` →
`manifest` → `verify_primary` (SymPy) → `verify_independent` (no CAS) → `stage_review` →
**review** (routed, same provider) → `stage_back` → `input_verify` → `gate` → `preserve` →
`record`. The deterministic spine is #280's `stack/steps.py` and `stack/gate.py`, unchanged.

- Agents can write only through the Preloop MCP server, which serves `/ws`; #280's steps use
  `/research/artifacts/runs/<run>`. `steps/r_stage.py` copies between them without editing;
  `input-verify` re-hashes everything anyway.
- `steps/agent_task.py` is the generic routed model step (prompt file, expected output file).
- Option B (a code-execution MCP for the agent) was not built: here it would make the proposer
  its own verifier. It belongs to exploratory tasks and needs its own sandbox design.

### Results

| run | route | provider / path | Gate | candidate sha256 | review | tokens (propose + review) | model-step time | Preloop gateway |
|---|---|---|---|---|---|---|---|---|
| default policy | `ROUTE claude` | Claude, direct | **ADMIT** | `829946630c89…` | PASS, no blocking | 70,916 + 76,936 = **147,852** | 26 s + 32 s | 0 |
| weekly limit 50 % (claude's real 55 % excluded) | `ROUTE codex` | Codex, direct | **ADMIT** | `829946630c89…` | PASS, no blocking | 16,830 + 19,177 = **36,007** | 30 s + 33 s | 0 |

- Both runs produced the **same canonical candidate as #280's direct baseline and its stacked
  run** (`829946630c89df12af172809df9dd29df6015cb7feaa52e0aec81e872cdd633c`); both checkers
  returned `EXACT_IDENTITY_VERIFIED`; the review is bound to that hash.
- No human approvals, no rule denials, no Preloop gateway model requests in either run.
- For reference, #280's stacked run (Conductor's own Claude provider, via the Preloop gateway):
  168,966 tokens, 89 s. The same step via Codex here: ~4× fewer tokens.

### Scope

This is one known-answer research step whose verification is fully deterministic. It shows
the routing path carries a research task end to end with the #280 Gate intact and with the
provider chosen from quota. It says nothing about the model's contribution on open problems
(#280's own conclusion), nor about tasks where the agent must compute (option B).

### Closing the review fixes (second pass, 2026-09-22)

Three remaining boundaries, found on review of `f3070f9`:

1. **A corrupt observation file stopped the whole choice.** Reading and parsing were outside the
   per-candidate guard. Now inside it: a corrupt file makes that candidate `unknown`. Controls
   added — first candidate corrupt → routes to the next; every file corrupt → HOLD. **26 / 26.**
2. **A ledger write failure overwrote a finished result.** The throw happened before
   `result.json` was written, so a completed task came out `FAILED`. Now the write is guarded:
   the result is unchanged, `ledger_error` is reported beside it (and surfaced by the workflow
   steps and MLflow tags), and the session is simply absent from the ledger, so its rollout is
   not used for quota. Measured with the ledger path unwritable: `COMPLETED`, `result.json`
   present, `ledger_error: ENOENT …`, no ledger line.
3. **Record errors did not reach the final output on every branch.** `auto.yaml` read only
   `record`, not `record_hold`; `research-r.yaml` had no `record_error` output. Both now take it
   from whichever record step ran.

End-to-end with MLflow unreachable (`MLFLOW_URL=http://mlflow-down:5000`), final workflow output:

| workflow | outcome | terminated at | decision | `record_error` in final output |
|---|---|---|---|---|
| `auto.yaml` | completed | success | `PASS` | yes (`URLError … name resolution`) |
| `auto.yaml` | denied by Preloop rule | `done_denied` | `DENIED` | yes |
| `auto.yaml` | HOLD (strict test policy) | `held` | — | yes |
| `research-r.yaml` | HOLD (strict test policy) | `held` | — | yes |
| `research-r.yaml` | completed (Codex) | success | `ADMIT`, candidate `829946630c89…` | yes |

In every case the decision and the terminal step are the ones the run would have without the
failure; the observation failure is visible, not silent.

Test policies updated to route all three providers directly (the strict one still referenced
Claude's old gateway route; it made no difference to the HOLD, since all candidates were over the
limit or stale).

---

## UX track, step 1 — minimal run base (2026-09-22)

Completion criterion (agreed): after **recreating** the containers, networks, the observer and
the logins come back with no manual step, and a small task succeeds.

What changed:

- `docker/preloop.cadp.yaml`: an extra compose file on top of the upstream Preloop install that
  attaches `api` / `console` / `gateway` to `cadp278-governed` (and `api` to `cadp278-toolnet`)
  with the aliases the agent resolves. Replaces the out-of-band `docker network connect`, which
  was lost on every Preloop restart. (`default` is listed explicitly — naming any network
  replaces a service's implicit one.)
- `restart: unless-stopped` on all six PoC containers (there was none).
- The quota observer's loop is now the `quota` container's command (script bind-mounted
  read-only), so it restarts with the container.
- The image pre-creates `/ws`, `/obs`, `/route` agent-owned, so fresh volumes need no `chown`.
- `scripts/up.sh`: brings up the PoC stack, then Preloop with the override, then runs 13 checks
  (isolation ×3, services ×5, routing-layer and observer logins ×4, observation freshness).
  `--check` only checks; `--recreate` forces recreation of every container in both projects.
  (Windows note: docker needs native paths; the script converts with `cygpath -m`.)

Measured:

| state | checks | small task (`auto.yaml`) |
|---|---|---|
| before (running stack) | 13 / 13 | — |
| after `up.sh --recreate` (image rebuilt; every PoC **and** Preloop container recreated) | **13 / 13**, no manual step | `ROUTE claude` → direct → Gate `PASS` → MLflow, `record_error` empty |

Preloop's recreated `api` / `console` / `gateway` carry the PoC networks and aliases from the
override; the observer wrote a fresh observation seconds after its recreate.

Not covered: a Docker Desktop restart (the stale-socket failure seen earlier is a Docker
Desktop issue outside the stack; its workaround is in the RUNBOOK).

## UX track, step 2 — settings model (2026-09-22)

Goal: settings are not repeated per solution × per workflow. Three layers, one source of truth,
generated settings kept apart, and a visible difference between *saved*, *applied* and *apply
failed*.

| layer | file (source, edited by hand or UI) | holds |
|---|---|---|
| environment | `config/environment.yaml` | Preloop api / MCP addresses, MLflow address, egress proxy + no_proxy, workspace / evidence / observation / login roots |
| profile | `config/profiles/<name>.yaml` | providers in preference order, each with route and login; quota limits; tool policy (native tools, Preloop policy file); execution timeout; MLflow experiment |
| workflow | `p281/workflows/*.yaml` | steps, and one input: `-i profile=<name>` (default `research-default`) |

`p281/cfg.py` (PyYAML 6.0.2 added to the image's venv):

- `validate` — known providers, route supported by that provider (Grok: direct only), numbers
  in range, login present (warning if not), policy file exists; and **all profiles must name the
  same Preloop policy**, because Preloop 0.15.0 applies one policy per account (two different
  ones would overwrite each other on apply).
- `generate` — `config/generated/runtime.json` and `config/generated/profiles/<name>.json`,
  each stamped with the sha256 of the source it came from and "edit config/*.yaml instead".
  `config/generated/` is git-ignored (derived).
- `apply` — what lives in another solution: `preloop policy apply` + the MCP scan Preloop needs
  before new tools are visible. Records `applied_sha256` / `applied_at` / `apply_error`.
- `status` — per target: `saved`, `applied`, `changed_since_apply`, `apply_failed` (+ error).

Consumers now read the generated settings, with the old literals only as fallback:
`run-agent.mjs` (Preloop addresses, egress, login root + the profile's login name),
`collect_obs.py`, `steps/route.py` (the profile's routing policy; `ROUTING_POLICY` still
overrides for tests), `steps/execute.py` / `steps/agent_task.py` (timeout, native-tools flag,
workspace and evidence roots, login), `steps/record.py` (MLflow address, the profile's
experiment; `MLFLOW_URL` still overrides for failure tests).

Profiles shipped: `research-default` (claude → codex → grok, as before) and `cost-first`
(codex → grok → claude).

Measured:

| check | result |
|---|---|
| validate → generate → apply | 4 targets `applied` (runtime, two profiles, the Preloop policy — applied and scanned) |
| edit a profile, no regenerate | that profile `changed_since_apply`; others unchanged |
| regenerate | back to `applied` |
| temporary profile naming a malformed Preloop policy, apply | that policy `apply_failed` with Preloop's validation error; the real policy stays `applied` |
| two profiles naming different Preloop policies | `validate` fails with the conflict named |
| `auto.yaml -i profile=cost-first` | `ROUTE codex` → PASS → MLflow (tagged `profile=cost-first`) |
| `auto.yaml -i profile=no-such-profile` | HOLD "unknown profile" — no guessing — recorded in MLflow |
| `research-r.yaml -i profile=cost-first` | `ROUTE codex` → **ADMIT**, candidate `829946630c89…`; the request carried the profile's login, timeout and native-tools setting |

Limitation: `applied` for the Preloop policy is what *this tool* last applied. A policy applied
to Preloop by other means is not detected (no drift check against Preloop's current policy).

## UX track — approval separation, checked against Preloop 0.15.0 (2026-09-22)

Completion condition (agreed): the operator *can* approve and the agent's credential *cannot*,
measured. Result: **not achievable on Preloop OSS 0.15.0; kept open.**

- The agent's enrolment token (`agt_…`) is an API key. `get_current_user` resolves an API key to
  its owner **user**; `approve_request` is guarded by `require_permission("decide_approvals")`
  on that user; `has_permission` is role-based. The key was issued by the account owner, so it
  carries the owner role's `decide_approvals`. (`ApiKey.scopes` exists in the model but is not
  checked on authentication.)
- Roles without `decide_approvals` exist (`analyst`, `viewer`, `tracker_manager`), so a
  dedicated agent user with such a role would separate the two. But the OSS API has **no user
  creation, invitation or role-assignment endpoint** (only `GET /api/v1/roles` and
  `/auth/users/me`); registration is closed after the first user. Only an unsupported database
  edit could create one — not done.
- Consequence for the design: approval actions will be issued only with an operator credential
  held **outside** the agent container (the ops side), so the gap closes as soon as Preloop can
  issue the agent a credential without approval rights.

## UX track, step 3 — login and run API with a Docker-operation boundary (2026-09-22)

- `cadp278-ops` (`docker/ops.Dockerfile`: `docker:27.5.1-cli` + Python stdlib; `ops/server.py`):
  the **only** component with the Docker socket. A fixed route table; every route is one
  predetermined `docker exec` into the agent with an argv list (no shell) and validated
  arguments (provider allowlist, `[a-z0-9-]` names, workflow allowlist, input charset). Published
  on `127.0.0.1:8781` — which limits who reaches it, not what it can do. Request bodies (which
  carry authorization codes) are never logged. The UI will call only this API.
- `p281/login_helper.py` (agent side): runs the provider's official login CLI under a
  pseudo-terminal, through the allowlist proxy, into `<logins_root>/<login>`; parses the official
  URL and device code; hands a pasted code to the CLI through a FIFO (never on disk, never
  logged); reports `starting` / `waiting_for_browser` / `waiting_for_code` / `connected` /
  `failed` plus the account state. umask 077.
- `p281/run_workflow.py` (agent side): starts an allowlisted workflow with a profile and inputs as
  an argv list; the run view is read from Conductor's own event log (steps, current step, the
  router's decision, termination step and reason, final output) — no second copy of progress.

Measured through the API:

| call | result |
|---|---|
| `GET /api/profiles`, `/api/config/status`, `POST /api/config/apply` | profiles listed; four targets `applied`; apply → "already applied" |
| `GET /api/accounts?profile=research-default` | per provider: `connected`, account match true, age, weekly/session use, identity basis; router decision `ROUTE claude` |
| login start / status / cancel (test login name) | Codex: official device URL + code, `waiting_for_browser`; earlier direct test of the helper: Grok URL + code, Claude URL + `waiting_for_code` |
| invalid login name (`../etc`), invalid workflow (`rm -rf`) | rejected (400) |
| `POST /api/runs {auto, cost-first}` then poll `GET /api/runs/<id>` | steps `route → execute → check → record → done_pass`; route `codex`/direct/`cost-first`; `PASS`; `record_error` empty |
| ops log | method + path only; no code-like strings |

Not yet exercised: a real account connection completed through the API (needs the operator);
planned through the UI in step 4.

## UX track, step 4 — one screen from account to result (2026-09-22)

`cadp278-hub` (`docker/hub.Dockerfile`, `hub/server.py`, `hub/index.html`): serves one page and
forwards `/api/*` to the ops API. **No mounts, no Docker access, no credentials** (checked by
`up.sh`). Published on `127.0.0.1:8780`. The page reads state from the owning systems via ops and
hands actions to them; it keeps none of its own.

Screens (Korean):

- **계정·상태** — for the selected profile: each provider's connection state, route and plan;
  whether the executing account equals the observed account (and on what basis); weekly / 5 h
  use ("보고 안 됨" when the provider does not report a window); observation age; usable now or
  why not; the router's current choice. "계정 연결 / 재연결" starts the provider's official
  login: the device URL and code for Codex / Grok, a code field for Claude; polled until
  `connected`. Settings targets with 적용됨 / 저장됨 (미적용) / 변경됨 — 적용 필요 / 적용 실패 and an
  apply button. Pending Preloop approvals (read-only; expired ones hidden), with the Preloop
  console link — approving stays in Preloop.
- **워크플로 실행** — template (`auto`, `research-r`), inputs, profile; **실행 전 검사** (settings
  valid, all applied, predicted provider or HOLD) gates the run button.
- **실행 기록 / 상세** — steps as they happen, current step, chosen provider and why, the reason it
  stopped (router HOLD with each provider's reason; "Preloop 승인 대기" with the pending tool and
  target when a run's workspace has a pending approval), decision, output, record error, links to
  the MLflow run and the Preloop console, Conductor run id.

Measured in the browser (built-in browser pane):

| action | shown |
|---|---|
| open the page | 3 providers connected, accounts match, quota + age, usable; config 4 × 적용됨 |
| profile `cost-first`, template `research-r`, 실행 전 검사 | 설정 유효 · 모두 적용됨 · 예상 제공자 codex |
| 실행 | live steps `route → stage_in → propose → … → review → … → admitted`; then **ADMIT**, reason, `codex direct`, candidate `829946630c89…`, MLflow link |
| a run under a temporary profile with every limit at 1 % (via API, viewed in the UI) | **HOLD**, "라우터가 실행을 보류했습니다: codex … 26.0% ≥ 1%; grok … 2% ≥ 1%; claude … 60% ≥ 1%", `route → record_hold → held`, MLflow link |

Fixed on the way: an explicitly failed terminate (HOLD/BLOCK/DENIED) carries the workflow output
in Conductor's `workflow_failed` event; the view now shows it as output, not as an error.

Not yet done against the first UX completion criterion: **an account connection completed by the
operator through this screen** (every login so far was made before the screen existed).

### First UX completion criterion — met (2026-09-23)

The operator reconnected **all three** providers through the screen (no container access):
Claude with the pasted code, Codex and Grok with device codes. Afterwards: every login `exit 0`,
no FIFO left, all `connected`, executing = observed account for each, Codex still the same
account (email fingerprint unchanged), `up.sh --check` all passed.

Operator feedback, applied: a **copy button** next to the device code (Codex, Grok). The login
box now redraws only when the URL or code changes, so the "복사됨" confirmation or a manual
selection is not wiped by the 2 s poll. Verified in the browser with a throwaway login name
(button present → click → "복사됨" → still present after polls), then cancelled and cleaned up.

## UX track — review fixes before merging #284 (2026-09-23)

Review of #284 @ 615c470: "basic UX demo succeeded, fix before merge". Six issues, all fixed and
checked against the running stack. No screen features were added.

| # | issue | fix | checked |
|---|---|---|---|
| 1 | quota was read for the default login, not the profile's selected login (all three providers) | `route.py` passes the profile's logins (`P281_LOGINS`); `collect_obs.py` reads each provider's quota, identity and ledger from that login's directory | profile naming `codex-b`, `grok-b`, `claude-b`: each read from its own directory; a login with no credentials is excluded and the router falls through; `research-default` unchanged |
| 2 | policy A→B→A showed A "applied" while B stayed on the account | `generate` drops policy targets no profile references; `apply` only applies referenced policies and records `preloop_active` (policy + hash); status says `applied` / `replaced` / `changed_since_apply` / `saved` / `apply_failed` with the policy actually active on the account | real Preloop: A→B→A ends on A; re-applying A reports "already applied" |
| 3 | a UI run was bound to its Conductor run by start time | each UI run has its own directory and `TMPDIR`; Conductor writes its event log under it, so the directory holds exactly that run's log; the view reads the Conductor run id from it | two runs started 1 s apart: PASS (`7f7e0fa0`) and DENIED (`552e1957`), each with its own result and MLflow run; a failed terminate now also fills where/why |
| 4 | a pending approval was not visible while a model step waited | the view gives `workspace_prefix` = `<workspace_root>/<conductor run id>` from the start; the screen matches pending approvals against it | `research-r` run `20260922-163951-6d6bb6`: during `propose`, run detail showed "Preloop 승인 대기 중 (Write /ws/e13fe17b-codex/synthetic.txt)"; the request was declined |
| 5 | runs cut by a restart stayed "running" forever | meta records launcher pid + container instance (PID 1 start time); a running run whose launcher is gone and whose log has no end becomes `interrupted` — not resumed | same run: `docker restart cadp278-agent` during `propose` → `interrupted`, screen "중단됨"; `up.sh --check` all pass after |
| 6 | `r_stage` ignored `workspace_root` (fixed `/ws`) | `r_stage` reads the setting; `validate` rejects any root outside `/ws` (the only directory the filesystem MCP serves) | `workspace_root: /ws/alt` → `research-r` ADMIT, every file incl. the model's MCP writes under `/ws/alt/189cd1a8`, candidate `829946630c89…`; `/data` rejected by validate; restored to `/ws` |

The approval for check 4 was synthetic: one permission-check request with the adapter's own
endpoint and token, marked `source: p281_test`, because a model under the current policy does not
reach a human-approval tool on its own. It was declined immediately; the test script was removed.
