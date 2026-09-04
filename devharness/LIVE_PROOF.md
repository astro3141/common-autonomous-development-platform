# devharness live E2E proof record

Disposable target: `astro3141/devharness-live-proof` (public, throwaway; kept
as evidence). Real composition throughout: Supervisor = deterministic harness;
Actor/Designer = Fable via `claude -p` (separate bounded invocations);
Reviewer = Codex via `codex exec -s read-only`. No human relayed any SHA /
state / review content between steps; the only human actions were the explicit
proof-boundary merges noted below. Date: 2026-09-04.

## Scenario A — execution + repair loop  ✅

Issue #7 (`slugify`, staged delivery: first candidate §1-only by explicit
issue instruction, reviewer judges full contract — the "intentionally likely
to require reviewer correction" lever):

```
issue #7 → lane exec-i7 → isolated worktree → real Fable Actor
→ candidate frozen 2be489520b14972231d068596e101a9660bc58fd (PR #8)
→ real Codex review → REQUEST_CHANGES (4 findings, receipted)
→ supervisor routes same bounded lane → Fable repair (findings passed in)
→ new exact candidate af08b6b77c674b6a60d8f85179286145a3feb5e1
→ prior verdict not carried (new freeze, re-review)
→ Codex re-review → GO on exact frozen head → HUMAN_MERGE_READY (receipt)
```

Additional fully-organic repair loops observed live: issue #10 (REQUEST_CHANGES
`5e9e0d46` → repair → GO `fd3ecd02`) and issue #15 (two repair rounds,
GO `48c92c8b` at attempt 2/3). First-pass GO pipelines: issues #1, #3, #5
(PRs #2/#4/#6, frozen `e809ea95`/`77c7c160`/`e48c73fc`) — three earlier
attempts at drawing natural REQUEST_CHANGES that the real composition cleared.

## Scenario B — Actor capacity failure  ✅ (FAULT_INJECTION)

The real Fable environment exposes no safe way to produce a quota event on
demand, so the labeled adapter-level fault-injection mode was used
(`DEVHARNESS_FAULT_INJECT=actor:RESOURCE_EXHAUSTED`): the real `claude -p`
invocation was started and terminated immediately after the invocation
boundary; the outcome is labeled `FAULT_INJECTION`, not a real provider event.

Issue #9, lane exec-i9:
```
real actor invocation starts → injected RESOURCE_EXHAUSTED
→ HOLD_CAPACITY (durable receipt on issue #9, hold_reason labeled FAULT_INJECTION)
→ worktree/branch/files preserved on disk
→ no candidate frozen; Reviewer NEVER invoked; no fallback
→ subsequent runs leave the lane held (no silent resume)
```

## Scenario C — Reviewer capacity failure  ✅ (FAULT_INJECTION, same standard)

Issue #10, lane exec-i10 (`DEVHARNESS_FAULT_INJECT=reviewer:RESOURCE_EXHAUSTED`):
```
real Fable actor completes → candidate frozen 5e9e0d469be5 (tree 9ecfccf01ece,
files lib/median.js tests/median.test.js, PR #11)
→ real codex invocation starts → injected RESOURCE_EXHAUSTED
→ HOLD_CAPACITY; candidate remains frozen byte-identical
→ Actor NOT re-invoked (1 total actor call); no self-review; no fallback
```
Recovery: `devharness resume exec-i10` (human action) → re-validate → re-freeze
same head → real Codex review → organic REQUEST_CHANGES → repair → GO
`fd3ecd02226d` → HUMAN_MERGE_READY.

## Scenario D — restart  ✅

Issue #12, lane exec-i12. The supervisor process was SIGKILLed at a real
intermediate point (repair-actor invocation in flight after an organic
REQUEST_CHANGES; the in-flight worker process was also killed to simulate a
machine stop). Persisted status at crash: `ACTOR_RUNNING`.

Restart (no human state relay — only re-running `devharness run`):
```
ACTOR_RUNNING --RESTART_OBSERVED--> ACTOR_INTERRUPTED
→ Fable re-invoked (interrupted-resume) in the same preserved worktree
→ validation → freeze e5a6d83abae8 → real Codex review → GO
→ HUMAN_MERGE_WAIT (PR #13)
```
All other lanes were reconstructed to their correct boundaries
(HUMAN_MERGE_WAIT / HOLD) from the local registry + GitHub.

## Scenario E — Design lane  ✅

Design issue #14 (`HARNESS_LANE: DESIGN`) + dependent execution issue #15
(`HARNESS_DEPENDS_ON_DESIGN: #14`):
```
design-i14: separate Fable Design invocation (designer role prompt)
→ docs/design-temperature.md candidate frozen 20c77c8d2811 (PR #16)
→ real Codex independent design review → GO → HUMAN_MERGE_WAIT
exec-i15:  PENDING → BLOCKED_ON_DESIGN (no worktree, actor never invoked;
           re-verified every supervisor round while design unmerged)
```
Human proof-boundary merge of PR #16 (operator action outside the harness) →
next run:
```
design-i14 → MERGED (observed)
exec-i15 → unblocked → worktree from post-merge main (landed design visible)
→ implement per landed design → 2 organic REQUEST_CHANGES repair rounds
→ GO 48c92c8bac7b → HUMAN_MERGE_READY (PR #17)
```

## CADP #65 read-only dry-run  ✅

`devharness run --repo astro3141/common-autonomous-development-platform
--pointer 65 --dry-run --label '' --work 106:design --work 107:execution
--work 109:execution --work 96:execution:after=106`

Output (no actuation; GitHub write methods hard-refuse in dry-run; ephemeral
store; no worktrees):
```
design-i106  DESIGN     WORKTREE_SETUP     (would create worktree + invoke Design worker)
exec-i107    EXECUTION  WORKTREE_SETUP     (would create worktree + invoke Actor)
exec-i109    EXECUTION  WORKTREE_SETUP     (would create worktree + invoke Actor)
exec-i96     EXECUTION  BLOCKED_ON_DESIGN  (blocked: design #106 not merged)
```

Comparison with canonical #65 state:

| Issue | Harness route | Canonical (#65) | Match |
|---|---|---|---|
| #106 | DESIGN lane, Design worker next | `STATE_106 DESIGN REPAIR`, `NEXT_OWNER_106 Design` | ✅ |
| #107 | EXECUTION lane, Actor next | `STATE_107 EXECUTION REPAIR`, `NEXT_OWNER_107 Execution` | ✅ |
| #109 | EXECUTION lane, Actor next | `NEXT_OWNER_109 Execution` | ✅ |
| #96 | blocked until design lands | `#96 IMPLEMENTATION HOLD` behind repair gate | ✅ |

Post-dry-run verification: no comments added, no branches created, no state
persisted. (Lane classification for unlabeled CADP issues was supplied by the
human via `--work N:kind` annotations, which is the supported v1 mechanism;
`#96`'s single-design dependency is a simplification of the canonical
triple-gate — see known limitations.)

## Control repair round — focused live proofs (issuecomment-5535154804)

Run 2026-09-04, after landing B1/B2/B3 repairs. Same real composition.

### B1 live — Design→Execution base freshness  ✅

Design issue #18 (checksum design; one organic Codex design-review repair
round) → GO `2ec171f21d96` (PR #20) → human proof-boundary merge advanced main
`aca9b9656a44 → 613d16118af9`. Next run, dependent execution #19:

```
[exec-i19] base refreshed aca9b9656a44 -> 613d16118af9 (post-design-merge)
worktree created FROM 613d16118af9; docs/design-checksum.md visible
design merge commit verified as ancestor of the execution HEAD
frozen candidate baseSha == 613d16118af9; changed files lib/checksum.js, tests/checksum.test.js
→ real Codex review → GO b305f84e3ce4 → HUMAN_MERGE_READY (PR #21)
```

### B2 live — remote head drift (foreign push)  ✅

An external clone pushed a commit (`9ed9d5c21136`) to `harness/exec-i12`
while the local worktree stayed at the GO'd candidate `e5a6d83abae8`:

```
[exec-i12] HUMAN_MERGE_WAIT --REMOTE_HEAD_DRIFT--> HOLD_UNKNOWN
both reviews (REQUEST_CHANGES, GO) invalidated; reviewedHeadSha cleared
no re-review, no rebuild on the drifted identity; durable receipt posted
```

### B2 live — base/main advancement  ✅ (organic, at scale)

Main had genuinely advanced (`→ aca9b9656a44` via the scenario-E design
merge) after six lanes' GOs were frozen against older bases. On the first run
with the repaired code, ALL six stale GOs were voided and repaired:

```
exec-i1/i3/i5/i7/i10/i15: HUMAN_MERGE_WAIT --BASE_DRIFT--> REPAIR_PENDING
→ real Fable rebase-repair (explicit rebase instruction in findings)
→ new exact heads, re-frozen with baseSha == aca9b9656a44
→ real Codex re-reviews → GO on every lane (attempts 1–3, all within bound)
```

### B3 live — real provider limit (not injected)  ✅

During exec-i19's first actor invocation the real Fable CLI returned a
provider limit error (is_error, no authoritative retry condition):

```
ACTOR_RESULT RATE_LIMITED (no authoritative retry condition)
→ HOLD_CAPACITY immediately; no shortened-interval retry; no fallback
```

This is genuine (non-FAULT_INJECTION) provider-limit evidence for the
exhaustion semantics.

### Empty-candidate guard (defect found and fixed during this round)

The provider-limit death above left exec-i19's branch with zero commits; the
human resume path then attempted to freeze an empty candidate (head == base),
failing only at PR creation (safety net → HOLD_UNKNOWN). Repair: FREEZING now
detects head == base / empty diff and routes CANDIDATE_EMPTY → bounded repair
(never freezing, pushing, or reviewing empty work). Proven live on the next
resume (log above) and pinned by a deterministic test.

## Deviations / operator notes

- Proof-boundary merges performed: PR #16 (scenario E design). PRs
  #2/#4/#6/#8/#11/#13/#17 were intentionally left open at HUMAN_MERGE_WAIT as
  standing evidence of the human-merge boundary.
- During the first scenario-D kill attempt, an overly broad `pgrep -f
  dangerously-skip-permissions` selected and killed an unrelated old process
  (pid 1590) on the operator machine instead of the actor child; the scenario
  was redone with exact-PID kills. Harness code was not involved — operator
  procedure error only.
