import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeWorld, REPO } from './helpers.ts'
import type { Lane } from '../types.ts'

// Control pre-review gate repairs (PR #110, issuecomment-5535154804).

// B1: dependent Execution must build on the Human-landed post-Design main.
test('B1: after design merge advances main, dependent execution refreshes baseSha to the new main', async () => {
  const w = makeWorld()
  w.github.addIssue(70, 'design first', 'HARNESS_LANE: DESIGN\n\nDesign it.')
  w.github.addIssue(71, 'implement after design', 'HARNESS_DEPENDS_ON_DESIGN: #70\n\nImplement it.')
  await w.sup.run([])
  const design = w.store.getLane('design-i70')
  const exec = w.store.getLane('exec-i71')
  assert.ok(design?.prNumber)
  assert.equal(exec?.status, 'BLOCKED_ON_DESIGN')
  const preMergeBase = exec.baseSha

  // Human merges the design; main advances to a NEW SHA.
  const newMain = 'postdesignmain'.padEnd(40, '0')
  w.github.humanMerge(design.prNumber, { newMainSha: newMain })
  w.git.baseSha = newMain // origin/main now resolves to the post-merge SHA

  await w.sup.run([])
  assert.equal(exec.status, 'HUMAN_MERGE_WAIT')
  // The lane base was refreshed BEFORE worktree creation...
  assert.equal(exec.baseSha, newMain)
  assert.notEqual(exec.baseSha, preMergeBase)
  const wt = w.git.addWorktreeCalls.find((c) => c.branch === 'harness/exec-i71')
  assert.equal(wt?.baseSha, newMain)
  // ...and the design merge commit was proven contained in that base.
  assert.deepEqual(w.git.ancestorCalls.at(-1), { ancestor: newMain, descendant: newMain })
  // The frozen execution candidate is bound to the post-design base.
  assert.equal(exec.candidate?.baseSha, newMain)
})

test('B1b: incoherent post-merge base (design commit not contained) holds instead of building stale', async () => {
  const w = makeWorld()
  w.github.addIssue(72, 'design', 'HARNESS_LANE: DESIGN\n\nd')
  w.github.addIssue(73, 'impl', 'HARNESS_DEPENDS_ON_DESIGN: #72\n\ni')
  await w.sup.run([])
  const design = w.store.getLane('design-i72')
  const exec = w.store.getLane('exec-i73')
  assert.ok(design?.prNumber)
  w.github.humanMerge(design.prNumber, { newMainSha: 'elsewhere'.padEnd(40, '0') })
  w.git.ancestorResult = false // merge commit NOT contained in resolved base
  await w.sup.run([])
  assert.equal(exec?.status, 'HOLD_UNKNOWN')
  assert.match(exec.holdReason ?? '', /base refresh failed/)
  assert.equal(exec.worktree, '') // never built on a stale/incoherent base
})

// B2: remote PR head drift (foreign push; local worktree untouched).
test('B2a: remote-head-only mutation after GO invalidates the review and holds', async () => {
  const w = makeWorld()
  w.github.addIssue(74, 'work', 'body')
  await w.sup.run([])
  const lane = w.store.getLane('exec-i74')
  assert.equal(lane?.status, 'HUMAN_MERGE_WAIT')
  assert.ok(lane.prNumber)

  // Someone force-pushes the PR branch on GitHub; the local worktree is unchanged.
  const pr = w.github.prs.get(lane.prNumber)
  assert.ok(pr)
  pr.headSha = 'foreignpush'.padEnd(40, '0')

  await w.sup.run([])
  assert.equal(lane.status, 'HOLD_UNKNOWN')
  assert.match(lane.holdReason ?? '', /foreign push/)
  assert.equal(lane.reviews[0]?.invalidated, true)
  assert.equal(lane.reviewedHeadSha, undefined)
  // Nothing was re-reviewed or re-built on the drifted identity.
  assert.equal(w.reviewer.invocations.length, 1)
  assert.equal(w.actor.invocations.length, 1)
})

// B2: base/main advancement after GO.
test('B2b: base-main-only advancement after GO invalidates and routes bounded rebase repair', async () => {
  const w = makeWorld()
  w.github.addIssue(75, 'work', 'body')
  await w.sup.run([])
  const lane = w.store.getLane('exec-i75')
  assert.equal(lane?.status, 'HUMAN_MERGE_WAIT')
  const staleGoSha = lane.reviewedHeadSha
  assert.ok(staleGoSha)

  // A different PR is human-merged; main advances. Lane branch/worktree unchanged.
  const advanced = 'advancedmain'.padEnd(40, '0')
  w.github.mainHead = advanced

  await w.sup.run([])
  // Stale GO did not survive.
  assert.equal(lane.reviews[0]?.invalidated, true)
  // A bounded same-lane repair was routed with an explicit rebase instruction.
  assert.equal(w.actor.invocations[1]?.taskKind, 'repair')
  assert.match(w.actor.invocations[1]?.findings?.[0] ?? '', /Rebase the branch onto the new base/)
  // The lane re-froze against the NEW base and was re-reviewed to GO.
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  assert.equal(lane.candidate?.baseSha, advanced)
  assert.notEqual(lane.reviewedHeadSha, staleGoSha)
  assert.equal(w.reviewer.invocations.length, 2)
})

test('B2c: base advancement detected before review start; reviewer never sees the stale identity', async () => {
  const w = makeWorld()
  w.github.addIssue(76, 'work', 'body')
  // Freeze completes, then main advances before the reviewer is invoked.
  const lane: Lane = {
    laneId: 'exec-i76', laneKind: 'EXECUTION', repo: REPO, workIssue: 76,
    baseBranch: 'main', baseSha: 'base'.padEnd(40, '0'), branch: 'harness/exec-i76',
    worktree: '/fake/worktrees/exec-i76', currentHeadSha: '', ownerRole: 'actor', status: 'VALIDATING',
    reviews: [], attempt: 0, retryCount: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  w.git.worktrees.add(lane.worktree)
  w.git.heads.set(lane.worktree, 'frozenhead'.padEnd(40, '0'))
  w.store.upsertLane(lane)
  await w.sup.step(lane) // VALIDATING -> FREEZING
  await w.sup.step(lane) // FREEZING -> REVIEW_RUNNING (frozen, PR created)
  assert.equal(lane.status, 'REVIEW_RUNNING')
  // Main advances between freeze and review.
  w.github.mainHead = 'movedmain'.padEnd(40, '0')
  await w.sup.step(lane)
  assert.equal(w.reviewer.invocations.length, 0) // stale identity never reviewed
  assert.equal(lane.status, 'REPAIR_PENDING')
  assert.match(lane.reviewerFindings?.[0] ?? '', /Rebase/)
})

// Empty-candidate guard (surfaced by live proof): a lane whose worker died
// before committing anything must never freeze or review an empty candidate.
test('empty candidate (head == base) routes bounded repair, never review', async () => {
  const w = makeWorld()
  w.github.addIssue(78, 'work', 'body')
  // First actor invocation "completes" without committing anything (e.g. it
  // was resumed after a provider limit killed the real work).
  w.actor.script = [
    () => ({ outcome: { kind: 'COMPLETE', detail: 'claims done' }, actorSignal: 'COMPLETE' }),
    // Second (repair) invocation actually commits.
  ]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i78')
  assert.equal(lane?.status, 'HUMAN_MERGE_WAIT')
  assert.equal(w.actor.invocations.length, 2)
  assert.equal(w.actor.invocations[1]?.taskKind, 'repair')
  assert.match(w.actor.invocations[1]?.findings?.[0] ?? '', /no committed work/)
  // The empty state was never frozen, pushed, or reviewed.
  assert.equal(w.reviewer.invocations.length, 1)
  assert.notEqual(w.reviewer.invocations[0]?.headSha, lane.baseSha)
  assert.ok(w.git.pushes.every((p) => p.sha !== lane.baseSha))
})

// B3: provider retry_after is never shortened by the local cap.
test('B3: retry_after exceeding the configured maximum wait holds instead of retrying early', async () => {
  const w = makeWorld() // cap = 120s
  w.github.addIssue(77, 'work', 'body')
  w.actor.script = [
    () => ({ outcome: { kind: 'RATE_LIMITED', detail: '429 retry-after: 600', retryAfterSeconds: 600 } }),
  ]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i77')
  assert.equal(lane?.status, 'HOLD_CAPACITY')
  assert.match(lane.holdReason ?? '', /retry_after=600s exceeds configured maximum wait 120s/)
  assert.deepEqual(w.sleeps, []) // never slept a shortened interval
  assert.equal(w.actor.invocations.length, 1) // never retried early
})
