import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeWorld } from './helpers.ts'

// Issue #119 H1 — a repair round that produces no candidate delta versus the
// candidate the Reviewer already rejected must never be re-reviewed.

const REQUEST_CHANGES_ONCE = () => ({
  outcome: { kind: 'COMPLETE' as const, detail: 'not yet' },
  verdict: 'REQUEST_CHANGES' as const,
  summary: 'fix the thing',
  findings: ['fix X'],
})

// Acceptance 1: rejected candidate -> repair Actor COMPLETE with identical
// head/tree -> Reviewer invocation count stays zero (for the repair round)
// and the lane holds with the exact no-op reason.
test('119-H1-1: repair COMPLETE with head/tree identical to the rejected candidate holds without re-review', async () => {
  const w = makeWorld()
  w.github.addIssue(119, 'work', 'body')
  w.reviewer.script = [REQUEST_CHANGES_ONCE]
  // The repair invocation claims COMPLETE but commits nothing at all — the
  // worktree stays exactly where the rejected candidate left it.
  w.actor.script = [
    w.actor.defaultBehavior, // fresh: commits a real candidate
    () => ({ outcome: { kind: 'COMPLETE', detail: 'nothing to change' }, actorSignal: 'COMPLETE' }),
  ]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i119')
  assert.ok(lane)
  assert.equal(lane.status, 'HOLD_UNKNOWN')
  assert.equal(lane.holdProvenance, 'actor')
  assert.match(lane.holdReason ?? '', /no candidate delta/)
  assert.ok(lane.rejectedCandidate)
  assert.match(lane.holdReason ?? '', new RegExp(lane.rejectedCandidate.headSha.slice(0, 12)))
  // Exactly one review ever happened (the original); the no-op repair round
  // was never handed back to the Reviewer.
  assert.equal(w.reviewer.invocations.length, 1)
  assert.equal(w.actor.invocations.length, 2)
  // The no-op repair was never pushed as a "new" frozen candidate either.
  assert.equal(w.git.pushes.length, 1)
})

// Acceptance 2: a repair that actually changes head/tree keeps the normal
// validate/freeze/re-review path fully intact.
test('119-H1-2: repair that changes head/tree proceeds through validate/freeze/re-review normally', async () => {
  const w = makeWorld()
  w.github.addIssue(120, 'work', 'body')
  w.reviewer.script = [REQUEST_CHANGES_ONCE]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i120')
  assert.ok(lane)
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  assert.equal(w.actor.invocations.length, 2)
  assert.equal(w.actor.invocations[1]?.taskKind, 'repair')
  // The second (repaired) candidate really did get reviewed and GO'd.
  assert.equal(w.reviewer.invocations.length, 2)
  assert.ok(lane.reviewedHeadSha)
  assert.notEqual(lane.reviewedHeadSha, lane.rejectedCandidate?.headSha)
})

// Acceptance 4: restart preserves the rejected-candidate identity needed for H1.
test('119-H1-4: restart preserves the rejected-candidate identity across a fresh Store load', async () => {
  const w = makeWorld()
  w.github.addIssue(121, 'work', 'body')
  await w.sup.admitWork([])
  const lane = w.store.getLane('exec-i121')
  assert.ok(lane)
  await w.sup.step(lane) // PENDING -> WORKTREE_SETUP
  await w.sup.step(lane) // -> ACTOR_RUNNING
  await w.sup.step(lane) // actor completes -> VALIDATING
  await w.sup.step(lane) // -> FREEZING
  await w.sup.step(lane) // frozen + pushed + PR -> REVIEW_RUNNING
  assert.ok(lane.candidate)
  const rejected = lane.candidate
  w.reviewer.script = [REQUEST_CHANGES_ONCE]
  await w.sup.step(lane) // REQUEST_CHANGES -> REPAIR_PENDING
  assert.equal(lane.status, 'REPAIR_PENDING')
  assert.ok(lane.rejectedCandidate)
  assert.equal(lane.rejectedCandidate.headSha, rejected.headSha)
  assert.equal(lane.rejectedCandidate.treeSha, rejected.treeSha)

  // "Restart": a brand-new Store/Supervisor loaded from the same state dir.
  const w2 = makeWorld({}, w.stateDir)
  const lane2 = w2.store.getLane('exec-i121')
  assert.ok(lane2?.rejectedCandidate)
  assert.equal(lane2.rejectedCandidate.headSha, rejected.headSha)
  assert.equal(lane2.rejectedCandidate.treeSha, rejected.treeSha)
  assert.equal(lane2.status, 'REPAIR_PENDING')
})
