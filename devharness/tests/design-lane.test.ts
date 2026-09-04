import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeWorld } from './helpers.ts'

// Required test 4: design required -> Design lane -> Review GO -> wait Human merge.
test('4: design-marked issue routes a DESIGN lane through review to HUMAN_MERGE_WAIT', async () => {
  const w = makeWorld()
  w.github.addIssue(20, 'design the widget contract', 'HARNESS_LANE: DESIGN\n\nDecide the widget API.')
  await w.sup.run([])
  const lane = w.store.getLane('design-i20')
  assert.ok(lane)
  assert.equal(lane.laneKind, 'DESIGN')
  assert.equal(lane.ownerRole, 'designer')
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  assert.equal(w.actor.invocations.length, 1)
  assert.equal(w.reviewer.invocations.length, 1)
})

// Required test 5: dependent Execution cannot start before Design merge.
test('5: execution lane stays BLOCKED_ON_DESIGN until human merges the design PR', async () => {
  const w = makeWorld()
  w.github.addIssue(21, 'design first', 'HARNESS_LANE: DESIGN\n\nDesign it.')
  w.github.addIssue(22, 'implement after design', 'HARNESS_DEPENDS_ON_DESIGN: #21\n\nImplement it.')
  await w.sup.run([])

  const design = w.store.getLane('design-i21')
  const exec = w.store.getLane('exec-i22')
  assert.ok(design)
  assert.ok(exec)
  assert.equal(design.status, 'HUMAN_MERGE_WAIT')
  assert.equal(exec.status, 'BLOCKED_ON_DESIGN')
  // Execution has done NOTHING: no worktree, no actor call for it.
  assert.equal(exec.worktree, '')
  assert.ok(w.actor.invocations.every((i) => i.laneId !== 'exec-i22'))

  // Run again while design is still unmerged: still blocked.
  await w.sup.run([])
  assert.equal(exec.status, 'BLOCKED_ON_DESIGN')
  assert.ok(w.actor.invocations.every((i) => i.laneId !== 'exec-i22'))

  // HUMAN merges the design PR (outside the harness).
  assert.ok(design.prNumber)
  w.github.humanMerge(design.prNumber)
  await w.sup.run([])

  assert.equal(design.status, 'MERGED')
  assert.equal(exec.status, 'HUMAN_MERGE_WAIT')
  assert.ok(w.actor.invocations.some((i) => i.laneId === 'exec-i22'))
})
