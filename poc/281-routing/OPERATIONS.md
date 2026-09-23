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

**Everything else on both sides must be identical, and that is now checked.** A review of the
published tree found `p281/steps/novel_reviews.py` calling `fanout.run_all(..., ledger=…)` against
a `run_all(jobs)` that had been published without that parameter: the workspace ran (it still had
the ledger version), the published pair stopped with a `TypeError` before a reviewer started, and
the runs reported as "measured on the running stack" were of code no reader could execute. The
per-member ledger was dropped from this scope on purpose, so the workspace was brought back to the
published interface — and `scripts/mirror-check.sh` now compares every file that exists on both
sides, with these two as its only documented exceptions. It is run before publishing, and a
difference fails it.

Its first version compared code and documents only: a changed `p281/fixtures/trading/packet.json`
(what every lane decides from) and a changed `policy/b-fsmcp.yaml` (what the tools may do) both
passed as `MIRROR OK`, which review demonstrated on two temporary trees. Inputs and policy decide
what a run produces, so both are compared now (83 files); each of those two cases fails the check.
Generated configuration (`config/generated/`, written by `cfg.py` per host) and anything holding
credentials stay out of it — they are not published and are per-host by design.

So **the running agent image was built from the unpinned Dockerfile**, and the versions in it are
whatever the installers returned on 2026-09-22 (§3). The pinned Dockerfile in the repository has
never been built here. The compose defaults are the repository's relative ones on both sides;
what differs is this host's `docker/.env`, which is where a host's own paths belong.

### What the platform provides, and what a workflow decides

`CONTRACT.md` draws that line: the platform provides capabilities with guarantees, the workflow
decides behaviour. It carries the audit of where this PoC had crossed it — the fan-out each
workflow had re-implemented (now `p281/steps/tasks.py`), the "required review" judgement that sat
inside it, the trading baseline computed in a platform step, and `record.py` accepting only one
execution per run (now a parent run with a child run per execution, so a lane's own tokens and
duration can be compared).

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

## 8. Update and rollback (measured 2026-09-23)

```bash
scripts/release.sh record [--tag NAME]         # keep what is running now
scripts/release.sh list
scripts/release.sh update --to REV             # record, move the workspace to REV, rebuild, check
scripts/release.sh rollback --to TAG           # put a kept release back (the operator runs this)
```

**A release is not an image tag.** Because Claude, Conductor and the Preloop CLI live in the
`agent-home` volume that masks the image's copy (§3), replacing the image does not change what
runs. A release here is therefore four things, kept together:

| part | how it is kept |
|---|---|
| code revision | the workspace's git revision (an update and a rollback check it out) |
| images | each running image is tagged `…:rel-<tag>`, so a later build of `:local` cannot take it away |
| configuration | `config/`, `policy/` and `docker/.env` |
| the toolchain itself | `/home/agent/.local` from the volume — 256 MB compressed |

**Data is not part of a release.** Logins, the Preloop database, MLflow and the run history stay
where they are and must survive both directions. `scripts/backup.sh` is what covers them.

Only changes to **tracked** files block an update or a rollback; run evidence living in the
workspace is untracked data and is not a reason to refuse. After either command the workspace sits
on that revision (detached); check out a branch again to continue development.

**Exercise.**

| step | result |
|---|---|
| `record --tag base` | 7 images tagged `rel-base`, toolchain 256 MB, configuration 8 KB, six tool versions read from the container |
| `update --to <rev>` (a visible change in the hub) | the release in use was recorded first, images rebuilt, stack recreated, **16/16 checks** |
| after the update | the hub showed the new version; **logins, policy state (`applied`), the run history (8 runs) and the MLflow experiments were unchanged** |
| a change made only inside the volume | a file added under `/home/agent/.local/bin` — the case an image rollback would not undo |
| `rollback --to base` (operator-run) | workspace back at its revision, `…:local` re-tagged from `rel-base`, **the volume's toolchain put back (the added file was gone)**, configuration restored, **16/16 checks** |
| after the rollback | the hub showed the old version again; policy, runs and MLflow unchanged; `auto` workflow **PASS** |

Automatic rollback on a failed update is deliberately not included: the update prints the command
and the operator decides. A database migration that changes Preloop's schema is not covered by
image rollback either — that would need a restore from a backup taken before the update.

### Review of the release path — five points closed (2026-09-23)

| # | was | is now | checked |
|---|---|---|---|
| 1 | the release carried `config/generated/state.json`, so a rollback claimed a policy the account did not have (A kept → B applied → back to A left the account on B, reported `applied`) | generated settings are not part of a release; after an update or a rollback the restored policy is **applied again** and the resulting state is printed | kept `polA` (policy `b-fsmcp`) → switched the profiles to a variant and applied it (account: variant) → rolled back: the account is on `b-fsmcp` again, `state: applied`, `active_on_account: policy/b-fsmcp.yaml` |
| 2 | the rollback deleted `/home/agent/.local` and then unpacked; a damaged archive left the agent with no toolchain | images, both archives and the unpacked toolchain are verified **before** anything changes, and the running one is swapped only for a staged copy that looks usable | a truncated toolchain archive: "the release's archives do not verify — nothing was changed", and Claude and Conductor still ran |
| 3 | the revision and configuration were read from wherever the script sat, the images from the running containers — they could describe different checkouts | every command first checks that this workspace is the one the agent mounts as `/work` (Docker's internal mount form normalised) | running `record` from the repository checkout: "this script is in … but cadp278-agent runs D:/Work/poc-278" |
| 4 | an update rebuilt images but left the volume's toolchain in place, so a Dockerfile version bump changed nothing | the update compares the running tool versions with the new image's and **refuses** when they differ, unless `--replace-toolchain` is given, which stages the image's `/home/agent/.local` and swaps it in | with a deliberately different version in the volume the update refused and named the difference; with `--replace-toolchain` it replaced the toolchain and the intended version ran |
| 5 | `record` accepted uncommitted changes to tracked files while keeping only the revision | `record` refuses them too (untracked run evidence is still fine) | refused with an edited tracked file |

After these, a release is: revision + images + configuration **sources** + the toolchain, with the
Preloop policy applied again on both paths. Data (logins, database, MLflow, run history) still
belongs to `backup.sh`, not to a release.

### Second review of the release path — four boundaries closed (2026-09-23)

| # | was | is now | checked |
|---|---|---|---|
| 1 | a policy that could not be applied was ignored (`|| true`), so an update ended "done" with the account still on the previous policy | an unapplied policy fails the update, with the rollback command | with `preloop policy apply` made to fail and a policy that really had to be applied: `"apply failed"`, "the update left the Preloop policy unapplied", exit 1 |
| 2 | the toolchain comparison happened after the workspace and images had already moved, so a refusal left a mixed state | the target revision is built in a throw-away worktree under its own tag and compared there; the workspace, the `:local` tags and the containers are touched only after that passes | refused with the workspace at its revision, the agent image id unchanged, and no release recorded |
| 3 | a valid tar with no real tools passed (only the link's presence was checked) and the swap then removed the running toolchain | the staged copy is followed *inside itself* — every required tool must exist and be non-empty — and the previous copy is kept until the new one answers | an archive whose `bin/claude` pointed at a missing target and whose `share/claude` was empty: "the release's toolchain has no usable tools in it — the running one is untouched"; Claude, Conductor and the Preloop CLI still answered |
| 4 | restoring a release recorded by the older script brought its `config/generated/state.json` back, so the re-apply was skipped as "already applied" | generated settings are excluded on extraction as well, and a new record carries `format=2` | rolling back to the old-format `base`: configuration restored without generated settings, policy **applied** (not "already"), `active_on_account` correct |

The candidate build also showed why this matters: the workspace's `agent.Dockerfile` was unpinned,
so a rebuild fetched Claude 2.1.280, Conductor 0.1.39 and Preloop CLI 0.16.0 against a stack running
2.1.278 / 0.1.37 / 0.15.0. The versions in use are now pinned there as well (they already were in
the repository copy).

Two smaller faults came out of the same run and are fixed: a tool that cannot answer no longer
aborts the script, and the candidate build takes a native path for its context.

### Third review of the release path — three boundaries closed (2026-09-23)

| # | was | is now | checked |
|---|---|---|---|
| 1 | the toolchain was judged only after the checks and the policy had passed, so a replacement that installed but could not run was left in place | the swapped-in toolchain is judged immediately after the stack comes back, whatever the checks said; a copy that does not answer is put back and the command fails | a release whose Claude was present and non-empty but not executable: "the new toolchain does not answer (claude) — putting the previous one back", exit 1, and the working tools answered again |
| 2 | a refused toolchain left the agent stopped, because it was stopped before verification | staging and verification happen while the agent runs; only the swap stops it | the hollow-archive refusal now ends with the agent still `running` and Claude answering |
| 3 | the candidate build looked for `docker/agent.Dockerfile` at the worktree root, which is wrong wherever this stack sits below the repository root (the restored copies from §7 do) | the candidate uses the same prefix this workspace has inside its own repository (`git rev-parse --show-prefix`) and says so if the file is not there | the prefix is empty in the PoC workspace and `poc/281-routing/` in a repository checkout; a worktree of this repository resolves `poc/281-routing/docker/agent.Dockerfile` |

**One more, found while testing.** An update or a rollback checks out another revision of the very
workspace this script lives in — including the script. A shell reads a script as it runs, so the
file changed underneath it. `release.sh` now copies itself to a temporary file and re-executes that
copy, so the running code cannot change halfway.

## 9. Cleanup and check reporting (measured 2026-09-23)

```bash
scripts/cleanup.sh [--days N] [--keep N] [--apply] [--include-orphans] [--json]
scripts/up.sh --check        # also writes evidence/checks/last.json
```

**Cleanup removes runs, not directories.** A run leaves three traces — the screen's record
(`evidence/ui-runs/<id>/`, with Conductor's event log), the workspace it worked in
(`<workspace_root>/<run>…`) and the adapter's evidence (`evidence/p281/<run>-…`). They are grouped
by the Conductor run id and removed together or not at all, so the screen never lists a run whose
artifacts are gone.

**Preview is the default.** Nothing is deleted without `--apply`.

**A run is kept, whatever its age, when** it is still running; Preloop has a pending approval under
its workspace; the operator marked it (a `keep` file in its directory); or it is inside the
retention window (`--days`, default 14) or among the newest (`--keep`, default 20). Traces that
belong to no run on the screen are reported as orphans and are only removed with
`--include-orphans`.

Run times come from the run id, not from file timestamps — a restored or copied file carries the
wrong date.

**Checks now leave a record.** `scripts/up.sh --check` writes `evidence/checks/last.json` with the
time, the instance, whether it passed and each failing check with what was expected and what was
found. `ops` serves it at `/api/checks`, and the hub shows one line in the header:

- `점검 통과 · 3분 전` — passed, and how long ago;
- `점검 통과 · 2일 전 (오래됨)` — passed, but the last check is over a day old;
- `점검 실패 · 3일 전 · grok /route login: yes 기대, no; MLflow: 200 기대, 000` — what failed.

That is the only screen addition in this step.

**What the exercise found**

| case | result |
|---|---|
| preview by default | with no `--apply`, nothing was deleted and the grouped list was printed |
| a run marked `keep` | kept under `--days 0 --keep 0` ("marked keep") |
| a run still going | kept ("still running") |
| a pending approval under a run's workspace | kept ("an approval is pending under its workspace") |
| **the approvals reader failing** | **the first version deleted anyway** — the reader's non-zero exit produced an empty list. It now stops with "nothing was removed", for a failed reader and for unreadable output alike |
| check reporting | passing, stale and failing states all shown on the screen, with the failing checks named |

The bad case above was found by running it: 15 old runs were removed while the approvals reader was
broken. Everything tracked in git came back with `git checkout`, and the 11 untracked evidence
directories were restored from the backup taken earlier (§7) — which is the first time a backup was
used for its actual purpose here.

### Review of the cleanup — four boundaries closed (2026-09-23)

| # | was | is now | checked |
|---|---|---|---|
| 1 | the approvals reader asked for the first 50 requests of the whole history, so fifty decided ones hid a waiting one and its run was removed | it asks for `status=pending` and keeps asking until a page comes back short; `--all` reports whether the answer is **complete**, and the cleanup stops unless it is | a reader reporting `complete: false` stops the run with "nothing was removed"; a pending request that only a full scan reaches protects its run and its orphan traces |
| 2 | orphans were collected separately and deleted straight away, with none of the protections | orphans are held to the same rules: a pending approval under them, a recent change, or **any** run whose state could not be read keeps them | each case exercised; an unreadable `meta.json` alone is enough to keep every orphan |
| 3 | `ignore_errors=True` meant a group could half-disappear and still be reported as removed | every path of a group is moved aside first; if one move fails the others are put back and the run is reported as **failed**, not removed (exit code 1) | with a move made to fail, nothing of that run was gone and it was listed under "could NOT be removed" |
| 4 | a run was judged by the state on the screen, so one whose launcher was still writing its final state could be removed | the launcher process is checked directly, whatever the log and the state say | a run with an end in its event log but a live launcher is kept ("its launcher is still alive") |

These are covered by `p281/cleanup_controls.py` (13 checks), which runs against temporary
directories with a stubbed approvals reader — no run of the instance is read or removed.

**Cost of testing this badly — what was and was not recovered.**

Two of these cases were first exercised against the live workspace with `--apply`, which removed
real run evidence. The recovery was **partial**:

| trace | result |
|---|---|
| the screen's records (`evidence/ui-runs/`), tracked in git | fully recovered with `git checkout` |
| adapter evidence (`evidence/p281/`), not tracked | 36 directories restored from the backup, in two goes. Four runs are still without it, because they ran after that backup was taken: `20260923-014530-00808d` (5775abd7), `20260923-014953-0b2b01` (405095d1), `20260923-022134-3ccc7a` (7933931d), `20260923-030330-8b15a3` (da721b3f) |
| the scratch workspaces under `/ws` | **not recovered, for any of the twelve runs**: 7f7e0fa0, 552e1957, d9f651cc, c5ece803, e13fe17b, 7ed5fc4f, 189cd1a8, 38a59361, 5775abd7, 405095d1, 7933931d, da721b3f. They are classified regenerate/discard in §4 and are deliberately not in the backup |

The 16/16 checks reported after the incident say the services are healthy. They are not evidence
that past artifacts came back; the table above is. The controls exist so that these paths are
never exercised on live data again.

### Two more boundaries in the cleanup (2026-09-23)

| was | is now | checked |
|---|---|---|
| an orphan was protected path by path, so a pending approval on `/ws/<run>-execute` still let `evidence/p281/<run>-execute-codex` be deleted | orphan traces are grouped by run id as well: protections and removal apply to the whole run | an approval on one trace keeps both; an unprotected orphan run goes with all of its traces |
| `shutil.move` falls back to copy-then-delete, so a failure in the middle could leave the original partly gone while a copy sat in the holding place | the holding place is on the same mount by construction, so `os.rename` is used and nothing is copied; a rename that cannot be done is a failure to report | with a rename made to fail, every path of the run stayed where it was and the holding place was left empty |

`p281/cleanup_controls.py` now covers 17 cases.

## 10. Tool policy per caller — corrected and measured (2026-09-23)

An earlier version of this section concluded that a per-role permission "cannot be expressed in
this version". **That was wrong**, and the review that caught it was right: the conclusion came
from reading the condition evaluator alone and stopping there.

**What is true about conditions.** A rule's CEL expression is evaluated against `{"args": args}`
only; the caller is not visible *inside the expression*.

**What that misses.** Choosing *whose* rules apply happens before the expression is evaluated.
Read in the running image (`ghcr.io/preloop/preloop:0.15.0`):

| mechanism | where |
|---|---|
| `subject_scope_chain()` — the caller's `api_key_id`, then its `managed_agent_id` | `services/subject_governance.py` |
| `get_scoped_tool_rules()` — the rules for that subject, most specific first | same |
| `is_tool_enabled_for_subject()` — a per-subject on/off for a tool, checked **before** any rule | same |
| both are called by the policy evaluator, which is handed `subject_context` | `services/policy_evaluator.py` |
| the MCP proxy fills that context on every call and also filters the tool **list** per subject | `services/dynamic_fastmcp.py` |
| per-key governance is readable and writable over the API | `GET/PUT /api/v1/auth/api-keys/{id}/governance` |

**Two of the three providers are different subjects; the third is not.** Codex and Claude were each
enrolled as their own managed agent, and the account holds a credential for each, with different
`api_key_id` *and* `managed_agent_id` (read from the API). **Grok presents Claude's credential**:
comparing the bearer token each provider sends to the Preloop MCP endpoint (hashes only, never the
values) gives

| provider | MCP credential |
|---|---|
| Claude | `57dfc1f6…` — the same token the adapter uses for permission checks |
| Grok | `57dfc1f6…` — **the same one** |
| Codex | `5f90701f…` — its own |

So a per-credential rule aimed at Claude would hit Grok as well. That is a fact about this
installation, not about Preloop: Grok's Preloop registration was never separate here (see
`run-agent.mjs`, the Grok profile — it has no Preloop principal of its own, a known open item of
#281), and nothing has given it one.

**Measured end to end on the live stack**, with one policy and one account:

| step | result |
|---|---|
| `write_file` disabled on the Codex credential only (`tool_enabled_overrides`) | the governance API accepted it |
| Codex asked to write a file | **DENIED**, no file written |
| Claude asked to write the same file, unchanged | **COMPLETED**, file written |
| the override cleared, Codex asked again | **COMPLETED**, file written |

So per-caller tool permission works today, **at the granularity of a credential** — which is what
was measured, and no further. It is not per role: in the novel trial one credential carries two
roles on each side (Codex is architect *and* story reviewer, Claude is author *and* history
reviewer), so "the author may write, the history reviewer may not" was **not** shown and does not
follow from this test. Telling two roles of the same vendor apart would need a credential per
role. What is *not* built is the
connection: nothing in this stack sets or tracks per-credential governance — `cfg.py` manages the
account policy only, and a role's credential is chosen for its login, not for its permissions.

**Correcting two more claims that were in this document**

- "A second Preloop stack per domain is required" — not established. Different rules for different
  callers do not need another account; they need per-credential governance, which is one API call.
  A second stack is one option, not the only one.
- "Registration closes after the first user" — that is a setting, not a law: `registration_enabled`
  still decides once an instance has a user, and a bootstrap token path exists
  (`api/auth/bootstrap.py`). The earlier wording stated a configuration as a property of the
  product.
- **Per-run directories are separation of storage, not of access.** The file server serves all of
  `/ws`, and the account policy carries no per-run restriction, so nothing stops one run's agent
  from reading or writing another run's directory. This document said "each run works in its own
  directory", which is true and was easy to misread as isolation; it is not.

**Where this leaves it**, in the reviewer's words: *differentiated rights per credential inside one
account are reported working; choosing a Preloop credential per role, and managing those settings,
is unimplemented.* The pieces measured above are the ones a design would use — a role names a
credential, and that credential carries the tool rights, which for two roles of the same vendor
means a credential per role — and `cfg.py` would have to own that mapping the way it owns the
account policy today. Per-lane recovery (§ trial records) and this mapping both stay on the same
footing: built when something actually needs them.

### Grok now has a Preloop principal of its own (2026-09-23)

The open item was real: Grok presented **Claude's** credential to the Preloop MCP endpoint, so any
per-credential rule aimed at one hit the other. It is closed, and the closing needed no new
Preloop feature.

**How.** `preloop agents discover` does not know Grok, but the API does not depend on discovery:

```
POST /api/v1/agents                      {"display_name": "...", "agent_kind": "grok"}
POST /api/v1/agents/{id}/credentials     {"name": "...", "scopes": ["mcp:read","mcp:write"]}
```

The credential is returned once; it went into the `Authorization` header of the `preloop` MCP
server entry in `/route/grok/config.toml` (the previous file is kept as `config.toml.bak`).
Nothing else changed — a masked diff of the two files differs only in the token.

**Measured after the change**

| check | result |
|---|---|
| credential Grok presents | `00794a90…`, no longer Claude's `57dfc1f6…` |
| MCP authentication with it | HTTP 200, and `tools/list` offers 19 tools (the adapter's credential is offered 20) |
| a task through the routing layer | file written through `preloop__write_file` |
| `write_file` disabled **on the Grok credential only** | Grok: no file. Claude at the same moment: file written |
| override cleared | Grok writes again |

So the three providers are now three subjects, and a tool right can be given or withheld per
provider. The earlier limitation stands where it was narrowed to: this is **per credential**, and
two roles sharing one provider still share its rights.

**One behaviour worth recording.** Grok reached for its own `write`/`search_replace` first, which
its configuration denies, and then gave up — "PROBE_BLOCKED: write and search_replace refused".
Naming the MCP tool in the prompt (`preloop__write_file`) made it work. The credential was never
the problem; tool choice was. A workflow that depends on Grok writing files should name the tool.

### Per-role credentials: measured, and the adapter can now present one (2026-09-23)

The limitation recorded above — *"this is per credential, and two roles sharing one provider still
share its rights"* — was about this stack's wiring, not about Preloop. Both halves were measured.

**Preloop side.** Two principals of the *same* vendor were created (`agent_kind: claude_code`,
"Claude Code (role: author)" and "… (role: history)"), each with its own MCP credential, and
`write_file` was disabled on the history principal alone. Governance is available per credential
(`/api/v1/auth/api-keys/{key_id}/governance`) and per principal
(`/api/v1/agents/{agent_id}/governance`); the principal level was used here, so the rule survives
credential rotation.

| credential presented to `/mcp/v1` | tools offered | `write_file` |
|---|---|---|
| role principal `author` | 19 | wrote the file |
| role principal `history` (override `write_file:false`) | 18 — `write_file` is not in the list | "Access denied: Tool 'write_file' is not available" |
| the adapter's own Claude credential, unchanged | 20 | wrote the file |

**Adapter side.** A request may now name a principal: `mcp_principal: "<name>"` in `request.json`.
The adapter then presents that principal's credential to the Preloop MCP endpoint instead of its
own — for the server it attaches over ACP (Claude) and for the one it writes into a vendor config
in memory (Codex). The token is never stored by the adapter and never written into the evidence:
the caller supplies it in `PRELOOP_MCP_<NAME>`, and the result records only the principal's name.

Measured through the routing layer, same provider, same login, same prompt, only the credential
differing:

| run | result |
|---|---|
| `mcp_principal: author` | `COMPLETED`, file written — the session called `mcp__preloop__write_file` |
| `mcp_principal: history` | `COMPLETED`, no file — the session searched for the tool, did not find it in its list, and never called it |
| `mcp_principal` named, `PRELOOP_MCP_<NAME>` not set | `FAILED` — fails closed, never falls back to the adapter's wider credential |
| `mcp_principal` with `native_tools: true` | `FAILED` — the run would not go through the MCP server at all |
| no `mcp_principal` (regression) | `COMPLETED`, file written with the adapter's own credential |
| `mcp_principal` on Grok | `FAILED` — refused: Grok reads its credential from `/route/grok/config.toml`, so the adapter cannot substitute it for one call. Per-role for Grok would need a login directory (and config file) per role. |

**What is still not built.** Nothing maps a workflow role to a principal: `steps/roles.py` binds a
role to a vendor and a login, and no step passes `mcp_principal`, so no workflow uses this yet.
Where the credentials come from is also left open on purpose — the adapter reads an environment
variable, so an operator can inject them from wherever they are kept, and `cfg.py` would own the
role → principal mapping the day a workflow needs it.

**Two lifecycle facts worth keeping.** Deleting a managed agent (`DELETE /api/v1/agents/{id}`)
revokes its credential immediately — the same token went from HTTP 200 to 401 — but the API key
rows stay listed until deleted separately (`DELETE /api/v1/auth/api-keys/{key_id}`). The probe
principals, their eight credentials and every probe file were removed after the measurement; the
account is back to the four principals it had (Grok, Codex, two Claude).
