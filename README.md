# Common Autonomous Development Platform

A deterministic platform core for supervising autonomous development work: it discovers tasks,
validates a Supervisor's structured proposal, freezes an immutable Task Contract, issues scoped
capability grants, runs an Actor, verifies the result under Platform control, has an independent
Auditor review it, and stops at a mandatory human merge decision.

The design premise is that **model output is never authority**. A Runtime turn can say `DONE` and
nothing happens; a person can say "I merged it" and nothing happens. Every lifecycle transition is
driven by durable state, structured submissions through an authoritative ingress, and facts read
back from the repository.

```text
MVP 0   FORMAL COMPLETE
MVP 1   FORMAL COMPLETE
MVP 2   NOT STARTED        (Safe Automatic Merge)
MVP 3   NOT STARTED        (Subflow / Hold-next / Batch)
MVP 4   NOT STARTED        (Long-running Unattended / reconciliation)
```

## Status — read this before reading anything else

**This is not production ready, and nothing here has ever run against a live backend.**

`MVP 1 FORMAL COMPLETE` means one precise thing: the Spec §65 path is implemented, composed by the
production Coordinator, and proven by executable tests. Every Runtime session, repository mutation,
verification run and report delivery proven in this repository is a deterministic test double.

```text
tests      1034 / 1034 PASS
typecheck  PASS
schema     v6 / 17 tables

production composition root   absent
live backend READY proof      absent
automatic merge               absent
RA-4 live preflight           BLOCKED (C2, C3, C4, C5)
```

The repository also carries its own failures in the open. `STATUS_common_platform_mvp1.md` §3
records that the first B13 seal was **invalid** — the end-to-end test bypassed activation and the
report claimed a wiring that did not exist — along with the correction (CORR1) that fixed it.
`PREFLIGHT_composition_root.md` records a further gap found afterwards: no production code path
issues the run-scoped SUPERVISOR capability grant, so a live run cannot currently open.

That is deliberate. A status document that only records successes is not evidence.

## Documents

Architecture authority order. Where documents disagree, **the higher one wins** and the lower one
is wrong and must be corrected.

| # | Document | Role |
|---|---|---|
| 1 | `Common Autonomous Development Platform — Specification v0.3.md` | What the platform is |
| 2 | `TECHNICAL_DESIGN_autonomous_development_platform.md` | How it is built — schemas, state machines, contracts |
| 3 | `PLATFORM_BACKEND_CAPABILITY.md` | What Backend v1 can and cannot honestly claim |
| 4 | `STATUS_workflow_harness.md` | Backend harness observations |
| 5 | `STATUS_common_platform_mvp1.md` | MVP 1 implementation/evidence record |

Operational and supporting:

- `HANDOFF_common_platform_mvp1_live_pilot.md` — how to run the first live pilot, and what not to do
- `PREFLIGHT_composition_root.md` — read-only survey of what the production composition root needs
- `STATUS_common_platform_mvp0.md` — the MVP 0 record, untouched
- `Authority order.md` — project boundary and document precedence

Status documents record what was built and proven. They introduce no contract, no state, no
vocabulary and no decision of their own.

## Layout

```text
core/          the deterministic Platform Core — no backend vocabulary anywhere in it
  admission/     proposal submission, validation, activation, run bootstrap
  capability/    capability broker, grants, backend manifests, enforcement receipts
  contract/      immutable Task Contract snapshot + contract source capture
  coordinator/   ProductionCoordinator.tickOnce() — dispatch only, never duplicate a rule
  decision/      Decision Validator V1–V11
  discovery/     TaskSource observation → durable projection
  execution/     Actor / Verification / Auditor / rework / human-merge use-cases
  humandecision/ PendingHumanDecision
  profile/       Project Profile + Execution Policy → Compiled Profile
  schemas/       canonical JSON, envelopes, digests, identifiers
  statemachine/  Task / Attempt / Batch transitions and commit guards
  store/         SQLite durable state, migrations, outbox
  tasksource/    generic TaskSource contract + ProjectDocumentTaskSource

adapters/      the backend boundaries
  interfaces/               the five adapter contracts — interfaces only
  local-git/                RepositoryAdapter over git worktrees
  local-verification/       VerificationAdapter over a durable workflow
  local-drift-source/       ProfileSource + ContractSourceReader
  backend-runtime-preflight/ RA-4 — read-only, measures and never repairs
  runtime-result-channel/   structured result collection, adapter-owned

testdoubles/   deterministic fakes, one per interface
tests/         1034 deterministic tests
```

## Backend independence

```text
OpenClaw + durable-jobs = replaceable Backend v1  ≠  Common Platform
```

The long-lived asset is the deterministic Core. Neither backend was modified to satisfy Platform
architecture, and neither may be. `core/` carries no backend vocabulary — the one module that names
backend mechanisms is the RA-4 preflight, whose entire job is naming them.

## Running it

Requires Node.js with `node:sqlite` (Node 22+).

```sh
npm install
npm test        # 1034 deterministic tests
npm run typecheck
```

Those two commands are the repository's entire check surface: `npm test` runs the deterministic
suite under `node --test`, and `npm run typecheck` runs `tsc --noEmit`. Both must pass before a
change is proposed — a change that fails either one is not ready to be reviewed.

There is no `start` script, because there is no production composition root yet. See
`PREFLIGHT_composition_root.md` for what building one requires.

## Safety boundary

No Runtime external effect may start before the RA-4 preflight reports `READY`. The preflight is
currently `BLOCKED(C2,C3,C4,C5)` against the measured install. It must not be bypassed, and
Platform policy must not be weakened to make it pass.

## License

MIT — see `LICENSE`.
