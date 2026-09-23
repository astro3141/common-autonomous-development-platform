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
| `docker/compose.poc.yaml` | same defaults as the repository; this host's paths come from `docker/.env` (git-ignored: `POC_HOST_DIR=D:/Work/poc-278`, `RESEARCH_HOST_DIR=D:/Work/research-280`) | relative defaults (`..`, `../evidence/research`) — a fresh clone resolves inside `poc/281-routing/` |
| `docker/agent.Dockerfile` | unpinned installs; copies one host CA file | Claude 2.1.278, Conductor `87f7788e`, Preloop CLI 0.15.0 pinned; `ca/` directory, certificates unversioned |

So **the running agent image was built from the unpinned Dockerfile**, and the versions in it are
whatever the installers returned on 2026-09-22 (§3). The pinned Dockerfile in the repository has
never been built here. The compose defaults are the repository's relative ones on both sides;
what differs is this host's `docker/.env`, which is where a host's own paths belong.

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

## 7. Backup and restore (measured 2026-09-23)

```bash
scripts/backup.sh [--out DIR] [--key FILE]     # stops the writers, copies, encrypts
scripts/restore.sh --archive FILE --workspace DIR --clone-from REPO --rev REV --stack NAME
scripts/restore.sh --archive FILE --workspace X --verify-only    # decrypt + manifest only
```

**What a backup holds** — everything marked *restore required* in §4: the three volumes
(`route-creds`, `agent-home`, `quota-home`), a transactional dump of Preloop's database, and the
host paths `evidence/mlflow`, `evidence/p281`, `evidence/ui-runs`, `evidence/runs`,
`evidence/conductor-events`, `config/` (including `generated/state.json`, taken with the database
so the two agree), `policy/`, the research data and the Preloop install directory with its `.env`.
`quota-obs` and `ws` are left out: they are regenerated. A `release.json` records the revision,
image ids and the tool versions read from the running containers (§3).

**Consistency.** Every writer is stopped for the copy (15 containers, ~2 minutes); Postgres stays
up for its dump alone. `--no-stop` exists for a dry run and is crash-consistent only.

**Encryption.** The archive holds provider logins, the Preloop enrolment token and Preloop's key
file, so it is always AES-256 encrypted with a key file kept outside the archive
(`~/.cadp-backup.key`, created on first use). **Lose the key and the backup is unreadable — keep a
copy of the key, and of the archive, on separate media.** Nothing is written inside the workspace
or the repository.

**Restoring never touches the instance in use.** The restored copy gets its own instance name
(`STACK`, default `cadp278r`), its own volumes, its own Preloop project and its own ports (hub
8790, ops 8791, MLflow 5010, Preloop 8010/8011/3010). Both copies hold the *same* credentials, so
they must not run at once: the script refuses to start while the live instance is up, and prints
how to stop it.

**Result of the first real exercise** (backup `20260922-234312`, 1.1 GB, 14 members):

| criterion | result |
|---|---|
| archive readable and unchanged | 14/14 members match their SHA-256 |
| restored into a fresh clone (`poc/281-ops`), new volumes, new ports | instance `cadp278r` came up; live volumes and workspace untouched |
| authentication | all three provider logins usable without logging in again; observer login too |
| policy | `cfg.py status` → `applied`; Preloop MCP still requires authentication; fsmcp tools exposed |
| records | the run history and the MLflow experiments from the backup were there |
| a small task | `auto` workflow → **PASS** (`file present with expected content`) |
| all checks | 16/16 |

**Three faults the exercise found — all fixed:**

1. **A Windows clone broke the observer.** Git checked the shell scripts out with CRLF; `/bin/sh`
   inside the container then failed (`Syntax error: end of file unexpected`). Fixed by
   `.gitattributes` (`* text=auto eol=lf`).
2. **A clone without instance names silently started the live instance** against the restored
   workspace. The restore script now refuses a revision that has no `STACK` support, and checks
   after start-up that the containers carry its own name.
3. **The Preloop policy addressed the tool servers by instance-specific host names**
   (`cadp278-toolsvc`, `cadp278-fsmcp`), so in the restored copy the model could not reach them and
   the task ended `BLOCK`. The services now carry the instance-independent aliases `toolsvc` and
   `fsmcp`, and every policy file uses those. Re-applied and verified on both instances (live task:
   PASS).
   MLflow's allowed-host list also had the port fixed at 5000; it now follows the instance's port.

**Not covered.** Expired or revoked credentials are not made to work again by a restore: what is
restored is the state as it was. A restore proves the state comes back, not that a token is still
valid.

### Review of the first exercise — what was wrong, and what it does now (2026-09-23)

A review of the scripts at `f295884` found six failure paths. All are fixed and each was exercised
against the running stack.

| # | was | is now | checked |
|---|---|---|---|
| 1 | the teardown command printed after a restore carried no instance name, so in a new shell it resolved to the live project | the restore writes `config/instance.env` (instance name, Preloop project, paths, ports) and `docker/.env`; `up.sh` and the new `down.sh` in that workspace read it | in the restored workspace, `up.sh --check` used ports 8791/8790 and `down.sh --volumes` removed only `cadp278r-*` and `preloop-restore_*`; the six live volumes were untouched |
| 2 | an existing workspace could be overwritten, and a stray `PRELOOP_PROJECT` could point the `DROP DATABASE` at the live database | every target — workspace, Preloop project and install directory, volumes, container names — is checked **before the first write**; the live instance's own mounts are compared against the target both ways | refused: the live workspace (with and without `--into-existing`), the live Preloop project, the live Preloop directory, the live stack name, an existing clone target, a missing workspace. Nothing was unpacked in any of them |
| 3 | `pg_restore … \|\| true` discarded errors and the restore continued on a table count | `--exit-on-error`, the output kept, and the row counts of `account`, `user`, `api_key`, `mcp_server` and `approval_request` must match the numbers recorded in the backup | a truncated dump: `pg_restore: error: could not read from input file: end of file` → stopped, **no containers started**. A good archive: "80 tables, key counts match" |
| 4 | the backup copied from wherever the script happened to live, and a missing source was just "skipped" | sources come from the running containers' mounts (`/work`, `/research`, `/mlflow`, normalised from Docker's internal form), and a missing **required** member fails the run (`--allow-missing` to override) | with `evidence/mlflow` moved aside: `backup failed: required members missing: mlflow`, and the staging directory removed |
| 5 | a failure after the database dump left plaintext behind | staging is created `umask 077`/`chmod 700` and removed on every exit path, and the containers are started again from the same handler | after the induced failure: no staging directory left |
| 6 | `release.json` was assembled by string concatenation and did not parse | it is written and re-read by a JSON library, and the release must be complete: tool versions and database counts are required members | parsed; `{"claude": "2.1.278 …", "codex": "codex-cli 0.155.1", …}` and `{"account": 1, "user": 1, "api_key": 6, "mcp_server": 2, "approval_request": 44}`. The tool versions are read from the container, which is started for the reading if it was stopped |

**One more trap, found while re-testing.** A clone whose `up.sh` predates `instance.env` started the
**live-named** containers against the restored workspace (it happened, and was reverted with no data
loss: the live containers were recreated from the live workspace and all checks passed). The restore
now refuses a revision whose `compose.poc.yaml`, `up.sh` or `down.sh` lacks instance support, before
anything is started, and still verifies the names afterwards.

**Second exercise, end to end** (archive `20260923-004642`): restored into a fresh clone →
`cadp278r` on its own ports → 16/16 checks → Preloop counts match → run history and MLflow
experiments present → `auto` workflow **PASS** → `down.sh --volumes` removed only the restored
instance → the live instance came back with 16/16 checks.

### Second review — four failure paths closed (2026-09-23)

| # | was | is now | checked |
|---|---|---|---|
| 1 | the restore compared its Preloop directory with the live one for equality only, and split the live mount list on spaces, so a parent directory of the live install (later `rm -rf`'d) and a path with spaces slipped through | every directory the restore writes to or deletes — its workspace and its Preloop install — is compared **both ways** against every directory the live instance uses, on normalised paths, read line by line. Docker's internal mount form (`/run/desktop/mnt/host/d/…`) is normalised first; unnormalised it matched nothing and the check passed silently | refused: workspace equal to, inside, or containing the live workspace; workspace equal to the live research directory; Preloop directory equal to, above, or inside a live directory; the restore's own two directories overlapping each other; and the same with spaces in the path. A separate target still passes |
| 2 | `down.sh --volumes` selected by name prefix, so with `STACK=cadp278r` a volume named `cadp278r-second-…` was selected too | the five volumes of the instance and its Preloop data volume are named exactly | with `cadp278r-second-route-creds` and `cadp278r-second-agent-home` present, only `cadp278r-route-creds` was removed; the lookalikes survived |
| 3 | `up.sh` defaulted `POC_HOST_DIR`/`RESEARCH_HOST_DIR` to its own directory and exported them, and a shell variable wins over `docker/.env` — so the live agent had ended up mounting the wrong research directory | no path is defaulted in `up.sh`/`down.sh`; one is exported only when the environment or a restored workspace's `instance.env` set it. Compose then reads `docker/.env`, and falls back to the relative defaults | after the fix the live agent mounts `D:/Work/research-280` again (it had been mounting `…/poc-278/evidence/research`), and the restored copy mounts its own |
| 4 | the row counts were read before the writers were stopped and the dump taken after, so an approval arriving in between made a good dump look wrong | the counts are read after the stop and immediately before `pg_dump`, from the same quiesced state | a fresh backup and restore: "80 tables, key counts match" |

Third exercise, end to end (archive `20260923-011845`): fresh clone → `cadp278r` on its own ports →
16/16 checks → counts match → `auto` workflow **PASS** → the research data restored (48 MB of the
49 MB directory, the difference being files the backup excludes) → `down.sh --volumes` removed only
this instance's six volumes → the live instance came back with 16/16 checks and its correct mounts.
