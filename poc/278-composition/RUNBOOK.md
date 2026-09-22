# RUNBOOK — #278 commodity composition PoC (Conductor + Preloop + MLflow + deterministic Gate)

| | |
|---|---|
| **Source revision** | PoC workspace `poc-278 @ 2027dcb` (2026-09-21), the baseline recorded before #281 |
| **Fixture revision** | fixture repo `@ e41c407` ("fixture baseline (post-slice passing state)") |
| **Committed for** | #281 Phase 0 — reproducible baseline (config only; AUTHORITY_EFFECT: NONE, #277 freeze kept) |
| **Excluded** | measured raw evidence (`evidence/`), all credentials, #281 additions (acpx, CodexBar, fsmcp) |

### Versions measured on the running system (2026-09-21)

| Component | Version | Pinned where |
|---|---|---|
| Conductor | v0.1.37 (`microsoft/conductor @ 87f7788e60c7cbb8895832b9edfb4e63f3924590`) | `docker/agent.Dockerfile` `CONDUCTOR_COMMIT` |
| Claude Code | 2.1.278 | `docker/agent.Dockerfile` `CLAUDE_CODE_VERSION` |
| Preloop server (OSS) | 0.15.0 (`ghcr.io/preloop/preloop:0.15.0`, `console:0.15.0`) | `PRELOOP_VERSION=0.15.0` given to the installer (§2.1) |
| Preloop CLI | 0.15.0 (commit `c91b326`) | `docker/agent.Dockerfile` `PRELOOP_CLI_VERSION` |
| MLflow | 3.16.1 | `docker/mlflow.Dockerfile` |
| Python (runtime base) | 3.13, Debian bookworm | `python:3.13-slim-bookworm` |
| Docker Desktop (measured host) | 4.91.0, engine 29.8.0, compose v5.5.1 | — |

Differences from the source workspace, all so that a fresh clone works: bind-mount defaults
are relative (were `D:/Work/...`); the Kaspersky root CA is optional (`docker/ca/`);
Conductor, Claude Code and the Preloop CLI are pinned (were `main` / latest); one probe's
Windows-venv default path now points at the container venv. Nothing else changed.

Build check on 2026-09-22 from this directory: the image reports Claude Code `2.1.278`,
Conductor `v0.1.37`, Preloop CLI `0.15.0`, SymPy `1.14.0`. Without the CLI pin the same build
got Preloop CLI `0.16.0`.

---

## 0. Layout

```
poc/278-composition/
  docker/     compose.poc.yaml; agent / mlflow / toolsvc images; ca/ (optional extra roots)
  workflows/  slice.yaml (vertical slice) and probes/ (one per control)
  policy/     allow (baseline), n1-deny, n2-approval, n7-native-deny
  gate/       gate.py, run_tests.py, governance_probe.py, verify_artifact.py, preserve_evidence.py
  fixture/    the code the slice's agent works on (src/slugify.py, tests/)
  evidence/   empty placeholders — measured output lands here and is never committed
```

Inside the agent container this directory is `/work`.

## 1. Rules that exist because something went wrong

| Rule | Why (#278 finding) |
|---|---|
| **Never run `preloop agents onboard` or `preloop agents discover` on the host.** | F8 — onboarding took custody of the host's rotating Claude subscription token and logged the host's daily Claude out repeatedly. |
| Never run `preloop agents discover` without `--json` (or `--no-onboard-prompt`). | F8 — in a non-TTY shell its prompts default to Y and it onboards. |
| Never mount the host's `~/.claude` into any container. | F9/F12 — the container holds its own credential lineage. |
| Onboard **only inside the agent container**, after pinning a model in its `~/.claude/settings.json`. | F11 — without a model pin, credential resolution silently fails. |
| After onboarding, remove `CLAUDE_CODE_SIMPLE` from the container's settings env. | F22 — onboarding writes `CLAUDE_CODE_SIMPLE=1`, which skips the hook it installs. |
| Do not treat a hook invocation as governance. | F22 — the hook returned local `allow` and never contacted Preloop. |
| Nothing baked into the image may live under `$HOME`. | `$HOME` is a named volume; image changes under it silently do not apply once the volume exists. |
| Do not use Preloop usage/spend figures as a budget. | F25 — no budget API in 0.15.0; subscription spend is $0; agent calls produce no usage row. |
| Approve Preloop requests over HTTP, not `preloop approvals approve`. | F20 — the CLI posts an empty body and is rejected 422. |
| **Never commit** a gateway key (`agt_…`), a Bearer, an OAuth token or a Preloop `.env`. | #281 Phase 0 acceptance — secret scan must pass. |

## 2. Fresh bring-up (from a clone)

Prerequisites: Docker Desktop (or Engine + compose v2), `git`, `curl`, a browser, and a Claude
account **dedicated to the governed runtime** — not the one used interactively on the host (F8).

### 2.1 Preloop OSS (upstream installer, its own compose project)

```bash
curl -fsSL https://preloop.ai/install/oss -o /tmp/preloop-oss.sh
less /tmp/preloop-oss.sh            # read it first
PRELOOP_VERSION=0.15.0 bash /tmp/preloop-oss.sh   # ~/.preloop-oss, compose project `preloop-oss`
```

Without `PRELOOP_VERSION` the installer takes the latest release (0.16.0 was already out on
2026-09-22). Confirm the pin landed:

```bash
grep '^PRELOOP_VERSION=' ~/.preloop-oss/.env          # expect PRELOOP_VERSION=0.15.0
```

The installer generates `~/.preloop-oss/.env`, which holds secrets. Its keys are listed in
`preloop-oss.env.example` here; **never** copy the real file into this repository.

**Operator-only:** open the setup link the installer prints (`http://localhost:3000/register#bootstrap=…`)
and create the first user.

Expected: `api` :8000, `gateway` :8001, `console` :3000, plus `postgres`, `nats`, `worker`,
`scheduler`, `flow-worker` (the last two ship in the stock compose and are unused; Preloop Flow
is a #278 non-goal).

### 2.2 PoC stack

```bash
cd poc/278-composition/docker
# optional, only if something on the host terminates TLS: put its root CA at ca/<name>.crt
docker compose -f compose.poc.yaml up -d --build
```

Creates networks `cadp278-governed` (internal), `cadp278-provision`, `cadp278-observe`,
`cadp278-toolnet` (internal); volume `cadp278-agent-home`; containers `cadp278-agent`,
`cadp278-mlflow`, `cadp278-toolsvc`.

### 2.3 Attach Preloop to the PoC networks (also after every restart)

```bash
docker network connect --alias api     cadp278-governed preloop-oss-api-1
docker network connect --alias console cadp278-governed preloop-oss-console-1
docker network connect --alias gateway cadp278-governed preloop-oss-gateway-1
docker network connect --alias api     cadp278-toolnet  preloop-oss-api-1
```

Without the aliases the agent cannot resolve `api`, `console` or `gateway`. An
"already exists" error on re-run is harmless. The attachment does not survive a restart of the
Preloop containers.

### 2.4 Credentials, minted inside the container (the operator performs the logins)

```bash
docker network connect cadp278-provision cadp278-agent            # temporary egress
docker exec -it cadp278-agent claude auth login --claudeai
docker exec -it cadp278-agent preloop login --headless --url http://console
#   it prints a console URL; open it on the host with `http://console` replaced by
#   `http://localhost:3000`, sign in, then pass the code back:
docker exec -it cadp278-agent preloop login --code <code> --url http://console
docker network disconnect cadp278-provision cadp278-agent         # egress removed again
```

Verify isolation (§3) before continuing.

### 2.5 Onboard Claude Code to Preloop — inside the container only

```bash
# F11: pin a model first
docker exec cadp278-agent python3 -c 'import json,os
p=os.path.expanduser("~/.claude/settings.json"); s=json.load(open(p)) if os.path.exists(p) else {}
s["model"]="sonnet"; json.dump(s,open(p,"w"),indent=1)'
docker exec cadp278-agent preloop agents onboard claude-code --dry-run --skip-live-validate   # read the plan
docker exec cadp278-agent preloop agents onboard claude-code --approvals --yes --skip-live-validate
# F22: remove CLAUDE_CODE_SIMPLE written by onboarding
docker exec cadp278-agent python3 -c 'import json,os
p=os.path.expanduser("~/.claude/settings.json"); s=json.load(open(p))
s.get("env",{}).pop("CLAUDE_CODE_SIMPLE",None); json.dump(s,open(p,"w"),indent=1)'
```

Onboarding writes, inside the container only: the gateway route into
`~/.claude/settings.json` env, the Preloop MCP server into `~/.claude.json`, and the
permission hook. §6 lists the resulting settings.

### 2.6 Baseline policy

```bash
docker exec cadp278-agent preloop policy apply /work/policy/allow.yaml
```

## 3. Verify isolation before trusting any result

```bash
docker exec cadp278-agent sh -c 'ip route'          # must show NO default route
docker exec cadp278-agent sh -c 'curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://pypi.org; echo " exit=$?"'
#   expected: 000 exit=6    (no egress)
docker exec cadp278-agent sh -c 'curl -s -o /dev/null -w "%{http_code}\n" http://console/mcp/v1'
#   expected: 401           (Preloop reachable, auth required)
```

| Container | Networks |
|---|---|
| cadp278-agent | `cadp278-governed` **only** |
| cadp278-mlflow | `cadp278-governed`, `cadp278-observe` (inbound path for the host browser) |
| cadp278-toolsvc | `cadp278-toolnet` only — the agent cannot reach it directly |
| preloop api | `cadp278-governed`, `cadp278-toolnet`, `preloop-oss_default` |
| preloop gateway, console | `cadp278-governed`, `preloop-oss_default` |

## 4. Running, and re-checking the CONFIG_ONLY_PATHS

Every run takes the MCP bearer from the container's own config, never from a file in this repo:

```bash
docker exec cadp278-agent sh -c '
export PRELOOP_MCP_TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser(\"~/.claude.json\")))[\"mcpServers\"][\"preloop\"][\"headers\"][\"Authorization\"].split()[-1])")
cd /work && conductor run workflows/slice.yaml'
```

Probes run the same way with their own path. MLflow UI from the host: <http://127.0.0.1:5000>
(experiment `1`).

| #278 receipt path | Finding | Re-check |
|---|---|---|
| Conductor model traffic through the Preloop gateway | F13 | `workflows/probes/p41-gateway-live.yaml` → reply `GATEWAY_ROUNDTRIP_OK`; `docker logs preloop-oss-gateway-1` shows `POST /anthropic/v1/messages … 200` |
| LLM-driven MCP tool call through the Preloop MCP layer | F14 | `workflows/probes/p42-mcp-governed.yaml` under `allow.yaml` → marker appears in `evidence/n1-markers/` |
| Policy deny on that path (N1) | F14 | apply `policy/n1-deny.yaml`, run `workflows/probes/n1-deny.yaml` → no marker; revert to `allow.yaml` |
| Require-approval on that path (N2) | F20 | apply `policy/n2-approval.yaml`, run `workflows/slice.yaml`; approve the pending request over HTTP (`POST /api/v1/approval-requests/{id}/approve`, body `{"approved": true}`) → the same run completes `PASS`; revert |
| Conductor OTel traces to MLflow, no collector | F1 | `workflows/probes/p43-trace-only.yaml` → a trace in experiment `1` carrying `conductor.run_id` |
| Deterministic Gate as a script step | F4, F17 | `workflows/slice.yaml` → `{"decision":"PASS",…}`; `probes/n3-missing-evidence.yaml` and `probes/n4-failed-test.yaml` → not PASS |
| Governance evidence from Conductor's own event log | F16 | slice output carries `governance_status` and `governed_calls` from `gate/governance_probe.py` |

Controls that change policy must be reverted to `policy/allow.yaml` afterwards.

**Resetting the fixture.** `probes/g1-stale-digest.yaml` deliberately tampers with
`fixture/src/slugify.py`, and the slice's agent edits the fixture. Restore it on the host:

```bash
git checkout -- poc/278-composition/fixture
```

## 5. STOP

**Emergency — cut the model and control paths, keep all state:**

```bash
docker network disconnect cadp278-governed preloop-oss-gateway-1   # no model path
docker network disconnect cadp278-governed preloop-oss-console-1   # no MCP / control path
docker network disconnect cadp278-governed preloop-oss-api-1
docker stop cadp278-agent
```

The agent has no other route out (§3), so this stops every governed action. Undo with §2.3.

**Orderly shutdown:**

```bash
docker compose -f poc/278-composition/docker/compose.poc.yaml down      # volumes kept
cd ~/.preloop-oss && docker compose stop
```

**Full teardown** (loses the container's logins and Preloop's database):

```bash
docker compose -f poc/278-composition/docker/compose.poc.yaml down -v
cd ~/.preloop-oss && docker compose down -v
```

If Claude Code was ever onboarded somewhere it should not have been, offboard it **there**:
`preloop agents offboard "Claude Code" -y --remove-model yes --remove-mcp-servers yes`
(restores the backed-up config and writes the live token back — the F8 recovery).

## 6. Wiring (values are placeholders)

Written **inside the container** by §2.5, or set by the compose file. None of these values
belong in this repository.

| Setting | Where it lives | Value shape |
|---|---|---|
| `ANTHROPIC_BASE_URL` | container `~/.claude/settings.json` → `env` | `http://console/anthropic` |
| `ANTHROPIC_API_KEY` | same | `agt_<preloop-gateway-key>` — **secret** |
| `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` | same | `sonnet` → `anthropic/claude-sonnet-4-5`, … |
| `runtime.provider.setting_sources` | Conductor workflow YAML | `[user]` — inside the container the user tier *is* the governed config |
| `runtime.mcp_servers.preloop` | Conductor workflow YAML | `url: http://console/mcp/v1`, header `Authorization: Bearer ${PRELOOP_MCP_TOKEN}` |
| `PRELOOP_MCP_TOKEN` | exported per run from container `~/.claude.json` (§4) | **secret**, never written to a file |
| `PRELOOP_URL` | compose env | `http://console` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_PROTOCOL` | compose env | `http://mlflow:5000` / `http/protobuf` |
| `OTEL_EXPORTER_OTLP_HEADERS` | compose env | `x-mlflow-experiment-id=1` |
| `OTEL_SERVICE_NAME` | compose env | `cadp-commodity-composition-poc` |

Host-side compose variables: `.env.example` (`POC_HOST_DIR`, `RESEARCH_HOST_DIR`, both optional).

## 7. Known open items (from #278, unchanged)

- Attempt identity is implicit: binding is by artifact digest, so an identical retry is
  indistinguishable from the previous attempt.
- `review.verdict` carries no artifact binding.
- Preloop tool-policy decisions are enforced but exist only in the api container's log.
- Successful agent model calls produce no Preloop usage row.
- Conductor's `claude-agent-sdk` provider offers only two tool configurations; "tools present,
  not bypass" is not expressible, and native Write/Bash were not governed in the measured
  configuration (F19, corrected by F22).
