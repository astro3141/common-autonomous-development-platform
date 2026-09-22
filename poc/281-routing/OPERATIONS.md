# Operations — what is actually running, and what must survive

Scope: keeping the environment in use, and being able to undo a change. Full unattended
installation from nothing is deliberately out of scope for now (§6).

Measured 2026-09-23 on the running stack. Everything below was read from the live host and
containers, not from the compose files.

## 1. Revisions actually in use

| what | value |
|---|---|
| PoC workspace (`D:\Work\poc-278`, mounted as `/work`) | `a4cb26e`, clean tree |
| repository (`D:\Work\cadp`, `main`) | `9a54921` (#284 merged) |
| research workspace (`D:\Work\research-280`, mounted as `/research`) | not a git tree; 49 MB of data |

**The workspace and the repository are not the same tree.** The workspace is the ancestor: it
carries #278 material and local notes that were never mirrored. Two differences change behaviour:

| file | workspace (running) | repository |
|---|---|---|
| `docker/compose.poc.yaml` | bind sources default to `D:/Work/poc-278`, `/research` to `D:/Work/research-280` | relative (`..`, `../evidence/research`) — a fresh clone resolves inside `poc/281-routing/` |
| `docker/agent.Dockerfile` | unpinned installs; copies one host CA file | Claude 2.1.278, Conductor `87f7788e`, Preloop CLI 0.15.0 pinned; `ca/` directory, certificates unversioned |

So **the running agent image was built from the unpinned Dockerfile**, and the versions in it are
whatever the installers returned on 2026-09-22 (§3). The pinned Dockerfile in the repository has
never been built here.

## 2. Containers and images

| container | image | image id | restart |
|---|---|---|---|
| cadp278-agent | cadp278/governed-runtime:local | `3e8bd6e7acaf` | unless-stopped |
| cadp278-quota | cadp278/governed-runtime:local | `3e8bd6e7acaf` | unless-stopped |
| cadp278-mlflow | cadp278/mlflow:3.16.1 | `57a342f2b725` | unless-stopped |
| cadp278-toolsvc | cadp278/toolsvc:local | `38b87dca3845` | unless-stopped |
| cadp278-fsmcp | cadp278/fsmcp:local | `f57433a16a90` | unless-stopped |
| cadp278-egress | cadp278/egress:local | `c458342cf3e7` | unless-stopped |
| cadp278-ops | cadp278/ops:local | `9e0c9a20f6f6` | unless-stopped |
| cadp278-hub | cadp278/hub:local | `5242dbd198af` | unless-stopped |
| preloop-oss api / worker / flow-worker / scheduler / gateway | ghcr.io/preloop/preloop:0.15.0 | `82728945c4b6` | unless-stopped |
| preloop-oss console | ghcr.io/preloop/console:0.15.0 | `d53da2640ace` | unless-stopped |
| preloop-oss postgres | pgvector/pgvector:pg16 | `ccc6e83d6e35` | unless-stopped |
| preloop-oss nats | nats:alpine | `ac8f88a6494b` | unless-stopped |

The `:local` tags are mutable: a rebuild replaces them and the previous image keeps no tag. There
is no release history to go back to.

## 3. Tool versions — and where they live

Read inside `cadp278-agent`:

| tool | path | version in use | same path inside the image |
|---|---|---|---|
| claude | `/home/agent/.local/bin/claude` | 2.1.278 | 2.1.278 |
| conductor | `/home/agent/.local/bin/conductor` | v0.1.37 | v0.1.37 |
| preloop CLI | `/home/agent/.local/bin/preloop` | 0.15.0 (`c91b326`) | 0.15.0 |
| codex | `/opt/npm-global/bin/codex` | codex-cli 0.155.1 | 0.155.1 |
| grok | `/opt/npm-global/bin/grok` | 1.0.40 | 1.0.40 |
| node / python | image | v22.14.0 / 3.13.15 | — |
| acpx, claude-agent-acp, codex-acp | `/opt/npm-global` | 0.18.0, 0.79.0, 1.12.0 | same |

**`/home/agent` is a volume (`cadp278-agent-home`), and it masks the image's copy of that
directory.** Claude, Conductor and the Preloop CLI are installed there. Today the two copies agree,
but nothing keeps them in step: after a rebuild the container still runs the volume's binaries, and
after `claude update` inside the container the image's copy is stale. Consequences:

- **Replacing the image does not roll back those three tools.**
- A release must therefore be recorded as *code revision + image ids + configuration + the tool
  versions read from the running container* (this table), not as an image tag alone.

## 4. Where state lives, and what it costs to lose

| data | location | size | class | why |
|---|---|---|---|---|
| provider logins (Claude, Codex, Grok) + Codex session ledger | volume `cadp278-route-creds` → `/route` | 66 MB | **restore required** | only the operator can recreate them, interactively, per provider |
| Preloop agent enrolment, CLI config, the agent's own `~/.codex`, `~/.claude` | volume `cadp278-agent-home` → `/home/agent` | 771 MB | **restore required** | enrolment token and client id; re-enrolling is a manual Preloop operation |
| observer's Codex login (+ caches) | volume `cadp278-quota-home` → `/home/agent` (quota) | 1.3 GB | **restore required** (login part) | operator login; the caches inside are disposable |
| Preloop account, policies, MCP servers, approval history, custodied credentials | volume `preloop-oss_postgres-data` | 22 MB | **restore required** | registration closes after the first user; re-creating it is a manual bootstrap |
| Preloop secrets/config | `~/.preloop-oss/.env` (21 lines) | 1 KB | **restore required** | the database is bound to these keys; without it a restored DB is not usable |
| research data | bind `D:\Work\research-280` → `/research` | 49 MB | **restore required** | the actual subject of the #280 work |
| MLflow database and artifacts | bind `evidence/mlflow` → `/mlflow` | 12 MB | **restore required** | the record of every run; SQLite file and artifacts must be kept together |
| run evidence: `evidence/ui-runs`, `evidence/p281`, `evidence/runs`, `evidence/conductor-events` | workspace | 3 MB | **restore required** | a run's UI record, its Conductor event log and its artifacts are one unit — they are kept or dropped together |
| settings sources: `config/environment.yaml`, `config/profiles/*`, `policy/*` | workspace (versioned) | small | **restore required** if edited locally | the repository holds them, but operator edits live here first |
| apply state `config/generated/state.json` | workspace (git-ignored) | small | **special** | derived in form, but it records which policy this tool made active on the account. It pairs with the Preloop database: restore both from the same snapshot, or reset it and apply again. Never restore it against a different Preloop database |
| generated settings `config/generated/*.json` | workspace | small | regenerate | `cfg.py generate` |
| quota observations | volume `cadp278-quota-obs` → `/obs` | 12 KB | regenerate | the observer rewrites them within minutes |
| per-run workspaces | volume `cadp278-ws` → `/ws` | 700 KB | regenerate / discard | scratch for a run; keep only while the run is open |
| images | Docker | — | rebuild | but see §3: a rebuild does not restore tool versions held in the volume |
| host CA file `docker/ca/*.crt` | workspace | 1 KB | site-specific | needed on this host (TLS interception); deliberately unversioned |

Docker keeps all volumes in one WSL2 disk: `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`
(36 GB). A copy of the whole disk is a crude but complete backup of every volume at once; a copy
taken on 2026-09-23 sits in `D:\docker-vhdx-backup-20260923`.

## 5. Host facts and failure modes

- Windows 11 + Docker Desktop 29.8.0 (WSL2 backend). Everything here depends on that combination.
- **Docker Desktop can fail to start with a stale socket file**, e.g.
  `initializing Ingest server … sailor-ingest.sock … The file cannot be accessed by the system`.
  The files under `%LOCALAPPDATA%\Docker\run` and `%LOCALAPPDATA%\docker-secrets-engine` are AF_UNIX
  sockets that Windows then refuses to open, rename or delete; each failed start leaves more of
  them. Docker has open reports of this
  ([#676](https://github.com/docker/desktop-feedback/issues/676),
  [#554](https://github.com/docker/desktop-feedback/issues/554),
  [#460](https://github.com/docker/desktop-feedback/issues/460)).
  - **Do not press "Reset to factory defaults" in that dialog. Press Quit.** The reset deletes
    images, containers and volumes — that is every login, the Preloop database and all run history
    in §4.
  - Recovery that worked (2026-09-23): quit Docker Desktop, move both directories aside, and if it
    still fails, **restart Windows** — that cleared them and the engine came up in ~10 s. Measured:
    no data was lost, all 16 checks passed, the three provider logins survived.
- After a host restart both compose projects come back on their own (`restart: unless-stopped`);
  `scripts/up.sh --check` confirms.

## 6. Scope now

1. **Backup and restore** — a consistent backup, restored onto new volumes and a fresh clone,
   verified by authentication, policy, records and a small task, with the live instance untouched.
2. **Update and rollback** — keep the previous release (code + images + configuration + the tool
   versions of §3) and perform an update and an operator-run rollback.
3. **Maintenance** — cleanup that previews by default and never splits a run from its records;
   checks that show when they last ran and why they failed.
4. **Full fresh installation** — deferred. What is manual today stays written down instead
   (`RUNBOOK.md`, #278 §2.1–2.6 plus the #281 bring-up and the operator logins).
