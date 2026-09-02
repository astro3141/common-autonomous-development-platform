# Issue-Orchestrator RuntimeAdapter (supervised pilot)

This adapter uses Issue-Orchestrator (IO) only as a provider/session execution backend. ADP keeps
project/task lifecycle, role semantics, selection, verification and audit policy, recovery,
evidence, and merge authority. The adapter imports no IO issue scheduling, labels, planning lanes,
review lifecycle, continuation policy, Control authority, or state machine.

The implementation was inspected and exercised against IO commit
`ba3cde2a06896ce8e3d38da076be1fbea3311fe3` from `astro3141/issue-orchestrator`:

- provider registry: `execution/agent_runner_providers/__init__.py`
- provider command mapping: `execution/agent_runner_providers/claude.py` and `codex.py`
- persistent session/turn/result seam: `execution/persistent_round_runner.py`
- provider readiness: each registered provider's `check_readiness`

The bridge validates that exact checkout commit before importing IO. It then offers only session
spawn, turn submission, terminal result/status observation, close/cancel, and same-live-bridge
reacquisition. A bridge restart cannot reacquire the PTY process and is advertised as unsupported.

## Capability matrix

| IO provider id | IO registry | Model capability | Pilot behavior |
| --- | --- | --- | --- |
| `claude-code` | registered | request pass-through; source aliases `haiku`, `sonnet`, `opus`; no observed resolved-model id | selectable when readiness is `ready` |
| `codex` | registered | arbitrary request pass-through; no model catalogue or observed resolved-model id | selectable when readiness is `ready`; interactive launches require explicit repository-trust authority |
| `grok` | not registered | none | `BACKEND_CAPABILITY_GAP` |
| `gemini-cli` | not registered | none | `BACKEND_CAPABILITY_GAP` |

`capabilityAdvertisement()` returns the exact configured profile requests intersected with IO's
live provider registry and returns `model_catalog: null`. A requested model is retained as
`requested_model`; `execution_observation.actual.model` and the actual binding remain `UNKNOWN`
because IO does not observe the provider-resolved model. An unregistered provider fails before a
session starts. Provider/model command refusals also fail closed.

`acquire_workflow_controller()` always raises `BACKEND_CAPABILITY_GAP`: IO exposes no ADP
`WorkflowControllerHandle`. Existing workflow and verification implementations remain separate
composition slots.

The pilot Runtime manifest claims no translated grant enforcement receipt. Every allow boundary is
`NOT_YET_AUDITED`, every deny boundary is `UNENFORCEABLE_CAPABILITY_BOUNDARY`, and automatic merge
is incompatible. The supervised profile must explicitly accept that reduced assurance.

## Live pilot

The opt-in vertical test defaults to `AUTO_MERGE=OFF`, `PUBLIC_INGRESS=OFF`, batch size one, and a
human merge decision. Ordinary `npm test` skips it so authenticated provider sessions are never
started accidentally.

```sh
ADP_IO_LIVE_PILOT=1 \
ADP_IO_CHECKOUT=/absolute/path/to/exact/io/checkout \
ADP_IO_PYTHON=/absolute/path/to/io/.venv/bin/python \
ADP_IO_SHA=ba3cde2a06896ce8e3d38da076be1fbea3311fe3 \
node --test tests/io-runtime-live-pilot.test.ts
```

Set `ADP_IO_PROVIDER=codex` to exercise the other registered provider. Optional model overrides are
`ADP_IO_SUPERVISOR_MODEL`, `ADP_IO_ACTOR_MODEL`, and `ADP_IO_AUDITOR_MODEL`.

On 2026-09-01, a short turn in an already trusted repository completed through the exact seam with
`claude-code`/requested `haiku`. The required fresh-repository run failed closed before model work:
IO accepted Claude's trust dialog and opened the TUI, but the first prompt did not reach the
composer; IO returned `prompt_not_accepted` after 120 seconds. A Codex fresh-run attempt passed the
explicit workspace-trust equality check and returned the same IO failure. The full vertical is
therefore currently blocked at fresh session → first turn. This adapter does not add retry,
continuation, or control behavior to hide that IO capability gap.
