import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeWorld } from './helpers.ts'

// Required test 10: UNKNOWN actor result -> HOLD.
test('10: unknown actor result holds; success is never assumed', async () => {
  const w = makeWorld()
  w.github.addIssue(40, 'work', 'body')
  w.actor.script = [() => ({ outcome: { kind: 'UNKNOWN', detail: 'garbled output' } })]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i40')
  assert.equal(lane?.status, 'HOLD_UNKNOWN')
  assert.equal(w.reviewer.invocations.length, 0)
  assert.ok(w.github.comments.some((c) => c.body.includes('HOLD_UNKNOWN')))
})

// Clean exit without a typed signal is also not success.
test('10b: actor COMPLETE outcome without typed signal holds', async () => {
  const w = makeWorld()
  w.github.addIssue(41, 'work', 'body')
  w.actor.script = [() => ({ outcome: { kind: 'COMPLETE', detail: 'exit 0' } })] // no actorSignal
  await w.sup.run([])
  assert.equal(w.store.getLane('exec-i41')?.status, 'HOLD_UNKNOWN')
})

// Required test 11: UNKNOWN reviewer result -> HOLD (candidate stays frozen).
test('11: unknown reviewer result holds with candidate frozen', async () => {
  const w = makeWorld()
  w.github.addIssue(42, 'work', 'body')
  w.reviewer.script = [() => ({ outcome: { kind: 'UNKNOWN', detail: 'no verdict' } })]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i42')
  assert.equal(lane?.status, 'HOLD_UNKNOWN')
  assert.ok(lane?.candidate)
  assert.equal(lane?.reviews.length, 0)
  assert.equal(w.actor.invocations.length, 1) // actor not reinvoked
})

// An unexpected exception inside a supervisor step is a durable hold, never a
// crash of the run and never assumed success.
test('step exception routes the lane to HOLD_UNKNOWN and the run survives', async () => {
  const w = makeWorld()
  w.github.addIssue(44, 'work', 'body')
  w.github.addIssue(45, 'other work', 'body')
  const orig = w.actor.defaultBehavior
  w.actor.defaultBehavior = (req) => {
    if (req.lane.laneId === 'exec-i44') throw new Error('adapter blew up')
    return orig(req)
  }
  await w.sup.run([])
  const broken = w.store.getLane('exec-i44')
  assert.equal(broken?.status, 'HOLD_UNKNOWN')
  assert.match(broken.holdReason ?? '', /supervisor step error: .*adapter blew up/)
  // The other lane still completed normally.
  assert.equal(w.store.getLane('exec-i45')?.status, 'HUMAN_MERGE_WAIT')
})

// STOP_DESIGN_REQUIRED routes to the human boundary, not invention.
test('actor STOP_DESIGN_REQUIRED routes HUMAN_DIRECTION_WAIT', async () => {
  const w = makeWorld()
  w.github.addIssue(43, 'work', 'body')
  w.actor.script = [() => ({
    outcome: { kind: 'COMPLETE', detail: 'missing contract' },
    actorSignal: 'STOP_DESIGN_REQUIRED',
  })]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i43')
  assert.equal(lane?.status, 'HUMAN_DIRECTION_WAIT')
  assert.equal(w.reviewer.invocations.length, 0)
})
