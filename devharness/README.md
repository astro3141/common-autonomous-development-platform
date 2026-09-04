# devharness — thin GitHub-backed development supervisor (bootstrap tooling)

Project-operation tooling used to build CADP. It is **not** a CADP Platform
Core component, not a second policy/effect/evidence architecture, and imports
none of K1–K7 / PEP / constitutional machinery. It may later be replaced by
CADP self-hosting.

Purpose: remove the Human from the repetitive development orchestration loop
(implementation → review → repair → re-review → merge-ready relay) while CADP
is being built. The Human keeps final merge and genuinely new
product-direction decisions.

## Composition (v1, fixed — no silent fallback)

| Role | Provider | Invocation surface |
|---|---|---|
| Supervisor/Control | deterministic harness logic | `devharness/cli.ts` |
| Design worker | Fable | `claude -p … --output-format json --json-schema …` (separate invocation) |
| Execution Actor | Fable | same surface, separate invocation/role prompt |
| Independent Reviewer | Codex | `codex exec -s read-only --output-schema … -o …` |
| Human | you | merges PRs; answers `HUMAN_DIRECTION_WAIT` |

The Supervisor routes but never implements or designs; it has no action that
writes implementation files and no code path that merges a PR.

## Lane model

`DESIGN` and `EXECUTION` lanes step through a deterministic transition engine
(`transitions.ts` — pure function, no LLM output as transition authority):

```
PENDING → (BLOCKED_ON_DESIGN) → WORKTREE_SETUP → ACTOR_RUNNING → VALIDATING
→ FREEZING → REVIEW_RUNNING → { HUMAN_MERGE_WAIT | REPAIR_PENDING → ACTOR_RUNNING … }
plus: ACTOR_INTERRUPTED / REVIEW_INTERRUPTED (restart), HUMAN_DIRECTION_WAIT,
HOLD_CAPACITY, HOLD_UNKNOWN, MERGED
```

Invariants enforced:

- Exact-candidate rule: reviews bind `{repo, base SHA, head SHA, tree SHA,
  changed files}`; any head mutation (including rebase) invalidates prior
  review; GO never carries to a new SHA.
- Worktree ownership: one lane per worktree, registry-enforced.
- Design must land (human merge) before dependent execution admits.
- Resource exhaustion / UNKNOWN → durable HOLD receipts; partial output never
  becomes a review candidate; reviewer exhaustion never re-invokes the actor.
- RATE_LIMITED retries only with an exact provider retry condition, bounded.
- Human merge only; no production deployment; no automatic Spec mutation.

Worker results are normalized to
`COMPLETE | FAILED_WORK | RESOURCE_EXHAUSTED | RATE_LIMITED | AUTH_REQUIRED |
PROVIDER_UNAVAILABLE | PROCESS_CRASHED | UNKNOWN` (`outcomes.ts`); success is
never assumed — a clean exit without a typed signal/verdict is UNKNOWN → HOLD.

## State

Durable local registry (`state.json` + `journal.jsonl`, atomic writes) under
`--state-dir` (default `~/.cadp-devharness/<owner>__<repo>`); GitHub stays the
canonical handoff medium via machine-readable issue/PR receipts. After restart
the supervisor reconciles local lanes against GitHub (merged-while-down,
interrupted invocations, stale worktrees) without any human state relay.

## Usage

```
npm run devharness -- run --repo owner/name --pointer 65 \
  [--work N[:design|:execution][:after=M]] [--validation-cmd 'npm test'] \
  [--label harness:work] [--dry-run]
npm run devharness -- status --repo owner/name
npm run devharness -- resume --repo owner/name --lane exec-i7
npm run devharness -- hold   --repo owner/name --lane exec-i7 --reason '…'
npm run devharness -- reconcile --repo owner/name
```

Work is discovered from open issues carrying the work label (default
`harness:work`) and/or passed explicitly with `--work`. Issue-body markers:
`HARNESS_LANE: DESIGN` routes a design lane; `HARNESS_DEPENDS_ON_DESIGN: #N`
blocks execution until that design lane's PR is human-merged.

`--dry-run` is READ-ONLY / NO-ACTUATION: the GitHub adapter hard-refuses
writes, the store is ephemeral, no worktree is created, no worker is invoked;
planned routes are printed.

`DEVHARNESS_FAULT_INJECT=actor:RESOURCE_EXHAUSTED` (or `reviewer:…`) enables
the labeled FAULT_INJECTION mode: the real invocation is started, terminated
immediately after the boundary, and replaced with the injected outcome —
receipts carry `FAULT_INJECTION`; this is never a real provider event.

## Tests

`node --test 'devharness/tests/*.test.ts'` — deterministic coverage of the 18
required scenarios (happy path, repair/re-review, invalidation, design gate,
capacity/rate/unknown holds, no-fallback, worktree ownership, restart,
supervisor-cannot-implement, human-merge-only, dry-run refusal) using fake
adapters only. Live proof is run separately against a disposable repository.
