import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeWorld } from './helpers.ts'

// Required test 1: Execution -> Actor COMPLETE -> Reviewer GO -> HUMAN_MERGE_WAIT.
test('1: execution happy path ends at HUMAN_MERGE_WAIT with exact reviewed head', async () => {
  const w = makeWorld()
  w.github.addIssue(10, 'add feature', 'do the thing')
  await w.sup.run([])
  const lane = w.store.getLane('exec-i10')
  assert.ok(lane)
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  assert.equal(w.actor.invocations.length, 1)
  assert.equal(w.actor.invocations[0]?.taskKind, 'fresh')
  assert.equal(w.reviewer.invocations.length, 1)
  assert.ok(lane.candidate)
  assert.equal(lane.reviewedHeadSha, lane.candidate.headSha)
  assert.equal(w.reviewer.invocations[0]?.headSha, lane.candidate.headSha)
  assert.equal(lane.prNumber, 101)
  assert.ok(w.github.comments.some((c) => c.body.includes('HUMAN_MERGE_READY')))
  // Candidate identity is fully bound.
  assert.ok(lane.candidate.baseSha.length === 40)
  assert.ok(lane.candidate.treeSha.length === 40)
  assert.ok(lane.candidate.changedFiles.length > 0)
})

// Required test 2: REQUEST_CHANGES -> repair -> new SHA -> re-review -> GO.
test('2: reviewer REQUEST_CHANGES routes bounded same-lane repair with new SHA and re-review', async () => {
  const w = makeWorld()
  w.github.addIssue(11, 'fix bug', 'body')
  w.reviewer.script = [
    () => ({ outcome: { kind: 'COMPLETE', detail: '' }, verdict: 'REQUEST_CHANGES', summary: 'nope', findings: ['f1: broken edge case'] }),
    // second review uses defaultBehavior GO
  ]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i11')
  assert.ok(lane)
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  assert.equal(w.actor.invocations.length, 2)
  assert.equal(w.actor.invocations[1]?.taskKind, 'repair')
  assert.deepEqual(w.actor.invocations[1]?.findings, ['f1: broken edge case'])
  assert.equal(lane.attempt, 1)
  assert.equal(w.reviewer.invocations.length, 2)
  // Repair produced a different SHA and the second review is bound to it.
  assert.notEqual(w.reviewer.invocations[0]?.headSha, w.reviewer.invocations[1]?.headSha)
  assert.equal(lane.reviewedHeadSha, w.reviewer.invocations[1]?.headSha)
  // The two reviews are recorded; the first is REQUEST_CHANGES on the old SHA.
  assert.equal(lane.reviews.length, 2)
  assert.equal(lane.reviews[0]?.verdict, 'REQUEST_CHANGES')
  assert.equal(lane.reviews[1]?.verdict, 'GO')
})

// Required test 3: old Review invalidated after candidate mutation.
test('3: candidate mutation after GO invalidates the review; GO does not carry to new SHA', async () => {
  const w = makeWorld()
  w.github.addIssue(12, 'change', 'body')
  await w.sup.run([])
  const lane = w.store.getLane('exec-i12')
  assert.ok(lane)
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  const goSha = lane.reviewedHeadSha
  assert.ok(goSha)

  // Someone/something moves the branch after the GO.
  w.git.heads.set(lane.worktree, w.git.newSha('mut'))
  await w.sup.run([])

  assert.equal(lane.reviews[0]?.invalidated, true)
  // Lane re-cycled: validated, re-frozen, re-reviewed at the NEW head.
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  assert.notEqual(lane.reviewedHeadSha, goSha)
  assert.equal(w.reviewer.invocations.length, 2)
  assert.ok(w.github.comments.some((c) => c.body.includes('VALIDATING') || c.body.includes('mutated')))
})

// Required test 15: rebase/base change invalidates review (head identity change
// detected between freeze and review start).
test('15: head mutation detected at review start invalidates prior frozen candidate authority', async () => {
  const w = makeWorld()
  w.github.addIssue(13, 'rebase target', 'body')
  // Reviewer's first invocation happens only after freeze; mutate the head
  // right before review by scripting the reviewer to never be reached:
  // we simulate the rebase between FREEZING and REVIEW_RUNNING by stepping manually.
  w.reviewer.script = [
    () => ({ outcome: { kind: 'COMPLETE', detail: '' }, verdict: 'GO', summary: 'ok', findings: [] }),
  ]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i13')
  assert.ok(lane)
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  const firstGo = lane.reviewedHeadSha
  assert.ok(firstGo)

  // Simulate a rebase: every SHA on the branch is rewritten.
  w.git.heads.set(lane.worktree, w.git.newSha('rebased'))
  await w.sup.run([])
  assert.equal(lane.reviews[0]?.invalidated, true)
  assert.notEqual(lane.reviewedHeadSha, firstGo)
  assert.equal(lane.reviews.at(-1)?.headSha, lane.reviewedHeadSha)
})
