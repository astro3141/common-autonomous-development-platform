# RUNBOOK — #281 routing layer over the #278 stack

| | |
|---|---|
| **Source revision** | PoC workspace `poc-278 @ f3070f9` (2026-09-22) |
| **Base** | `poc/278-composition/` (#282). Preloop install, onboarding rules, isolation checks and STOP are as described in its RUNBOOK; this file lists only what #281 adds or changes. |
| **Verdict at this revision** | provider-separation PoC succeeded; #281 overall **PARTIAL** (see "Open") |
| **Excluded** | every login and token (`/route`, `.env`, Grok/Codex/Claude credential files), measured evidence, one-off diagnostics' outputs |

## What #281 adds

```
Conductor workflow (p281/workflows/auto.yaml)          — names no vendor
  route    : collect_obs.py → router.py                — quota-based choice, HOLD if nothing eligible
  execute  : run-agent.mjs (acpx)                      — the routing/execution layer
               model path + login: routing layer (/route/*), out via the allowlist proxy
               tools: Preloop MCP (rules) ; any ACP permission request → Preloop approval, fail closed
  check    : the file on disk, not the agent's account
  record   : MLflow (REST); a record failure never changes the outcome
```

| Component | Version / where |
|---|---|
| node | 22.14.0 (`/opt/node`) |
| acpx | 0.18.0 |
| claude-agent-acp / codex-acp | 0.79.0 / 1.12.0 (codex-acp runs its bundled Codex 0.154.0) |
| @openai/codex | 0.155.1 |
| @xai-official/grok | 1.0.40 |
| CodexBar CLI | 0.63.0, static musl build (the glibc build needs GLIBC 2.38; bookworm has 2.36) |
| filesystem MCP | `@modelcontextprotocol/server-filesystem@2026.8.31` behind `supergateway@4.0.0` |
| egress proxy | tinyproxy (Debian bookworm), allowlist in `docker/egress/allow` |

### Containers, networks, volumes (in addition to #278's)

| Name | Role | Networks |
|---|---|---|
| `cadp278-egress` | the routing layer's only way out: CONNECT :443 to allowlisted provider hosts | `cadp278-governed` (alias `egress`), `cadp278-egressnet` |
| `cadp278-fsmcp` | filesystem MCP serving `/ws`, reachable only through Preloop's MCP proxy | `cadp278-toolnet` |
| `cadp278-quota` | Codex quota observer (CodexBar, own login); writes files only | `cadp278-quotanet` |

| Volume | Holds |
|---|---|
| `cadp278-route-creds` → `/route` | the routing layer's own provider logins + the Codex session ledger |
| `cadp278-ws` → `/ws` | the workspace shared by agent and fsmcp |
| `cadp278-quota-home`, `cadp278-quota-obs` → `/obs` (read-only in the agent) | observer login, observations |

## Bring-up (after #278's RUNBOOK §2.1–2.6)

```bash
cd poc/281-routing/docker
docker compose -f compose.poc.yaml up -d --build
# re-attach Preloop as in #278 §2.3
```

Policy — the #281 policy is a superset of `allow.yaml` (toolsvc unchanged, plus fsmcp path rules):

```bash
docker exec cadp278-agent preloop policy apply /work/policy/b-fsmcp.yaml
```

**Then call Preloop's scan once**, or the fsmcp tools stay invisible to agents (measured on 0.15.0):
`POST /api/v1/mcp-servers/{id}/scan` with the operator's Preloop token (`preloop auth token`).

### Routing-layer logins (operator; separate lineage from Preloop's custody — F8)

All go through the allowlist proxy; the agent never gets direct egress.

```bash
P="-e HTTPS_PROXY=http://egress:8888 -e HTTP_PROXY=http://egress:8888 -e NO_PROXY=console,api,mlflow,localhost"
docker exec cadp278-agent sh -c 'mkdir -p /route/claude /route/codex /route/grok/home && chmod 700 /route'
docker exec -it $P -e CLAUDE_CONFIG_DIR=/route/claude cadp278-agent claude auth login --claudeai
docker exec -it $P -e CODEX_HOME=/route/codex        cadp278-agent codex login --device-auth
docker exec -it $P -e GROK_HOME=/route/grok -e HOME=/route/grok/home cadp278-agent grok login --device-auth
```

Codex and Grok device codes can be completed from a phone; Claude's login needs the code pasted
into the terminal. Then configure Grok per `grok/config.example.toml`.

### Quota observer (Codex fallback source)

```bash
docker exec -it cadp278-quota codex login --device-auth         # same account as the agent's
docker cp ../p281/observer_loop.sh cadp278-quota:/tmp/ && docker exec -d cadp278-quota sh /tmp/observer_loop.sh
```

The loop does not survive a container restart; until restarted, the router sees `stale` and
falls through or holds (fail closed).

## Running

```bash
docker exec cadp278-agent sh -c 'cd /work && conductor run p281/workflows/auto.yaml'
# fixed provider instead of the router:
docker exec cadp278-agent sh -c 'cd /work && conductor run p281/workflows/route.yaml -i provider=codex'
# #280 Phase R through the routing layer (option A: model proposes and reviews, never verifies):
docker exec cadp278-agent sh -c 'cd /work && conductor run p281/workflows/research-r.yaml'   # needs /research mounted (#280 workspace)
# router fault injection (no model):
docker exec cadp278-agent sh -c 'python3 /work/p281/collect_obs.py /tmp/obs && python3 /work/p281/router_controls.py /tmp/obs'
```

Routing policy: `p281/routing-policy.json` (override with `ROUTING_POLICY=`). The `*-test.json`
policies are the tight/strict variants used to force a Grok route and a HOLD. MLflow
experiment: `p281-routing`.

## Rules added by #281

| Rule | Why |
|---|---|
| Never share a provider login between the routing layer and Preloop's custody. | F8: rotating tokens with two custodians log each other out. |
| Give each vendor process its own home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME` + `HOME`). | Grok imported Claude Code's user settings from `$HOME` and ran the Preloop hook installed for Claude on every call (stalls, mis-attribution). |
| Keep `mcp-proxy.anthropic.com` off the allowlist. | It serves the claude.ai account's own MCP connectors — a tool path that bypasses Preloop. |
| Do not use Antigravity (agy) through acpx. | Google's terms name "OpenClaw with Antigravity OAuth" as a breach; accounts were suspended. |
| Call the Preloop api directly (`api:8000`), not the console proxy, for approvals. | nginx and Node `fetch` both cut a held-open approval at 300 s, before Preloop answers `timed_out`. |
| Do not put Claude managed settings in the image. | Container-wide; would strip Write/Bash from the #278 workflows. |

## Open (why #281 is PARTIAL)

- Codex `apply_patch` has no off switch; it is held for human approval, where the rules do
  not apply.
- Grok has no Preloop principal of its own; its MCP calls use and are recorded under Claude
  Code's.
- The agent's enrolment token can approve its own requests; orphaned approvals stay
  approvable after a run ends.
- Served model is `unknown` on every path.
- Validated for a fixed file task only: no per-task capability or allowed-model filtering,
  per-model quota windows recorded but unused.
- Provider terms for subscription use through acpx not reviewed.

Details and every measurement: `p281/FINDINGS-281.md`.
