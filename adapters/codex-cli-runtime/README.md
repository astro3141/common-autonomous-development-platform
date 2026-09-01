# Codex CLI RuntimeAdapter (supervised pilot)

This is a separate ADP RuntimeAdapter. It does not replace the IO adapter, OpenClaw Runtime, or
durable-jobs Workflow backend. ADP continues to own project/task lifecycle, Supervisor/Actor/
Auditor semantics, selection, verification/audit, recovery, evidence, and merge policy.

## Inspected execution seam

The pilot is fail-closed to the locally inspected `codex-cli 0.151.0`. The installed binary's
`codex exec --help` and `codex exec resume --help` were checked before implementation. Source was
checked at tag `rust-v0.151.0`, commit
`78c290807ce710180111df227df3b7a4fe845452` in `openai/codex`:

- `codex-rs/exec/src/cli.rs`: non-interactive and explicit resume arguments
- `codex-rs/exec/src/exec_events.rs`: `thread.started`, item, terminal, and usage JSONL shapes
- `codex-rs/exec/src/event_processor_with_jsonl_output.rs`: emitted terminal semantics
- `codex-rs/exec/src/lib.rs`: thread start/resume and turn submission flow
- `codex-rs/exec/tests/suite/resume.rs`: persisted-thread reuse behavior
- `codex-rs/config/src/permissions_toml.rs` and `codex-rs/core/src/config/permissions.rs`:
  named permission-profile syntax and exact `:workspace_roots` lowering
- `codex-rs/core/README.md`: built-in workspace-write keeps `.git` and a resolved gitdir read-only

The adapter invokes argv directly, with no shell:

```text
codex exec --strict-config --ignore-user-config --ignore-rules --json \
  --model <configured> <bounded-sandbox-args> \
  --output-schema <host-owned-schema> -C <workspace> [resume <thread-id>] -
```

Read-only profiles use `--sandbox read-only`. The inspected CLI's built-in `workspace-write`
profile intentionally makes `.git` read-only, so it cannot satisfy the Actor candidate-commit
contract. Workspace-write Actor bindings therefore use an inline named permission profile that
allows writes only below the assigned workspace and its `.git/`, while carving `.git/config`,
`.git/config.worktree`, `.git/hooks/`, and `.git/objects/info/` back to read-only and keeping
network disabled. This profile is paired with LocalGit's isolated clone workspace: no canonical
gitdir is included in the writable roots. The adapter never passes `--approve-for-me`, an
approval override, or a full-access flag.

The first `spawn_session` must execute a bounded acknowledgement turn because this CLI surface has
no create-only session command. The returned handle contains the backend-emitted thread id. ADP
turns then use explicit `resume <thread-id>`. Effective provider and resolved model are not in the
JSONL surface, so result observations retain the request but report both actual identities as
`UNKNOWN`. Token usage is recorded for ADP turns when `turn.completed` reports it. Initialization
turn usage is not placed in the session handle because RuntimeAdapter's spawn result has no
measurement channel and ADP metadata policy forbids smuggling measurement fields into that handle.
The five JSONL usage keys are projected as `input`, `cached_input`, `cache_write_input`, `output`,
and `reasoning_output`, each with unit `token`, so the durable observation also satisfies I-TD7's
key-name denylist.

## Exact pilot matrix and gaps

Only exact profiles configured with provider `openai`, a non-empty requested model, and sandbox
`read-only` or `workspace-write` are advertised. There is no CLI model catalogue, so model
acceptance is deferred to `codex exec` and any refusal is a terminal fail-closed result. Grok,
Gemini, and arbitrary custom providers are not advertised by this adapter.

The manifest records these unsupported capabilities rather than inferring them:

- no create-only session operation
- no backend thread status query or close-thread operation
- no active-turn cancellation in the synchronous pilot adapter
- no spawn-op, turn-op, or in-flight-turn reacquisition after an adapter restart
- no WorkflowControllerHandle

Git commit support is narrower than general Git administration: an Actor may update the isolated
workspace index, objects, and branch ref, but may not change Git config/hooks, use a repository
remote, or write canonical. A linked-worktree `.git` pointer is rejected by LocalGit as
`BACKEND_CAPABILITY_GAP`; it is not repaired by granting access to the canonical gitdir.

Explicit thread resume across separate CLI processes is supported. That is narrower than ADP
operation reacquisition and must not be treated as recovery authority. CapabilityGrant translation
has not been audited, so the manifest supplies no enforcement receipt, claims no `ENFORCED`
boundary, and is incompatible with automatic merge.

## Live pilot

The opt-in test creates a disposable Git repository and runs the same bounded lifecycle as the IO
pilot: real Supervisor, Actor, local re-verification, real Auditor, then a human merge decision.
It keeps `AUTO_MERGE=OFF`, `PUBLIC_INGRESS=OFF`, and batch concurrency/max tasks at one.

```sh
ADP_CODEX_CLI_LIVE_PILOT=1 \
ADP_CODEX_CLI_BIN=/opt/homebrew/bin/codex \
ADP_CODEX_CLI_VERSION='codex-cli 0.151.0' \
node --test tests/codex-cli-runtime-live-pilot.test.ts
```

Optional exact role model requests are `ADP_CODEX_CLI_SUPERVISOR_MODEL`,
`ADP_CODEX_CLI_ACTOR_MODEL`, and `ADP_CODEX_CLI_AUDITOR_MODEL`.

On 2026-09-01, the fresh disposable vertical completed on the inspected CLI with requested
`openai` / `gpt-5.6-sol`: Supervisor and Actor completed, local verification re-executed `PASS`,
the Auditor returned `AUDIT_PASS`, and ADP stopped at `READY_TO_MERGE` with an open
`MERGE_APPROVAL`. Candidate commit `43d4a5ad9e1cdcf9e39c3c1b63908f4a6257769d` existed only in
the disposable repository; the canonical branch remained unchanged and the repository was then
removed. The exact bounded result and reported usage are preserved in
`live-pilot-evidence.json`.
