import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeWorld } from './helpers.ts'

// Required test 6: Actor RESOURCE_EXHAUSTED mid-work -> HOLD; Reviewer not invoked.
test('6: actor resource exhaustion holds the lane, preserves worktree, never calls reviewer', async () => {
  const w = makeWorld()
  w.github.addIssue(30, 'work', 'body')
  w.actor.script = [
    (req) => {
      // Partial output exists in the worktree (mid-work), then quota dies.
      w.git.heads.set(req.worktree, w.git.newSha('partial'))
      return { outcome: { kind: 'RESOURCE_EXHAUSTED', detail: 'usage limit reached' } }
    },
  ]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i30')
  assert.ok(lane)
  assert.equal(lane.status, 'HOLD_CAPACITY')
  assert.match(lane.holdReason ?? '', /actor RESOURCE_EXHAUSTED/)
  // Reviewer never saw the partial candidate.
  assert.equal(w.reviewer.invocations.length, 0)
  assert.equal(lane.candidate, undefined)
  // Branch/worktree/files preserved.
  assert.ok(w.git.worktreeExists(lane.worktree))
  assert.ok(w.git.headSha(lane.worktree).startsWith('partial'))
  // Durable HOLD receipt.
  assert.ok(w.github.comments.some((c) => c.body.includes('HOLD_CAPACITY')))
  // Restart does not silently resume: still held.
  await w.sup.run([])
  assert.equal(lane.status, 'HOLD_CAPACITY')
  assert.equal(w.actor.invocations.length, 1)
})

// Required test 7: Reviewer RESOURCE_EXHAUSTED -> frozen candidate retained; Actor not reinvoked.
test('7: reviewer resource exhaustion keeps candidate frozen; actor not reinvoked; no self-review', async () => {
  const w = makeWorld()
  w.github.addIssue(31, 'work', 'body')
  w.reviewer.script = [
    () => ({ outcome: { kind: 'RESOURCE_EXHAUSTED', detail: 'codex usage limit reached' } }),
  ]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i31')
  assert.ok(lane)
  assert.equal(lane.status, 'HOLD_CAPACITY')
  assert.match(lane.holdReason ?? '', /reviewer RESOURCE_EXHAUSTED/)
  // Candidate remains frozen and untouched.
  assert.ok(lane.candidate)
  assert.equal(w.git.headSha(lane.worktree), lane.candidate.headSha)
  // Actor was invoked exactly once (initial work); NOT sent the candidate back.
  assert.equal(w.actor.invocations.length, 1)
  // No verdict was recorded from anything but the reviewer port (no self-review).
  assert.equal(lane.reviews.length, 0)
  assert.equal(lane.reviewedHeadSha, undefined)
})

// Required test 8: RATE_LIMITED with exact retry-after -> bounded retry.
test('8: rate limit with authoritative retry_after retries within bound and then proceeds', async () => {
  const w = makeWorld()
  w.github.addIssue(32, 'work', 'body')
  w.actor.script = [
    () => ({ outcome: { kind: 'RATE_LIMITED', detail: '429', retryAfterSeconds: 30 } }),
    w.actor.defaultBehavior,
  ]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i32')
  assert.ok(lane)
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  assert.deepEqual(w.sleeps, [30]) // exact provider retry condition honored
  assert.equal(w.actor.invocations.length, 2)
})

// Required test 9: RATE_LIMITED without authoritative retry condition -> HOLD.
test('9: rate limit without retry condition holds immediately, no retry, no sleep', async () => {
  const w = makeWorld()
  w.github.addIssue(33, 'work', 'body')
  w.actor.script = [
    () => ({ outcome: { kind: 'RATE_LIMITED', detail: 'rate limited, no retry-after' } }),
  ]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i33')
  assert.ok(lane)
  assert.equal(lane.status, 'HOLD_CAPACITY')
  assert.match(lane.holdReason ?? '', /no authoritative retry condition/)
  assert.deepEqual(w.sleeps, [])
  assert.equal(w.actor.invocations.length, 1)
})

// Required test 12: provider unavailable beyond retry bound -> HOLD.
test('12: provider unavailable retries up to the bound then holds', async () => {
  const w = makeWorld()
  w.github.addIssue(34, 'work', 'body')
  const unavailable = () => ({ outcome: { kind: 'PROVIDER_UNAVAILABLE' as const, detail: 'overloaded' } })
  w.actor.script = [unavailable, unavailable, unavailable, unavailable]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i34')
  assert.ok(lane)
  assert.equal(lane.status, 'HOLD_CAPACITY')
  assert.match(lane.holdReason ?? '', /PROVIDER_UNAVAILABLE beyond retry bound/)
  // 1 initial + maxProviderRetries(2) retries = 3 invocations, then hold.
  assert.equal(w.actor.invocations.length, 3)
})

// Required test 13: no silent provider fallback in either direction.
test('13: exhaustion never swaps providers: actor stays actor, reviewer stays reviewer', async () => {
  // Actor exhausted: reviewer must not be used as a substitute worker.
  const w1 = makeWorld()
  w1.github.addIssue(35, 'work', 'body')
  w1.actor.script = [() => ({ outcome: { kind: 'RESOURCE_EXHAUSTED', detail: 'quota' } })]
  await w1.sup.run([])
  assert.equal(w1.store.getLane('exec-i35')?.status, 'HOLD_CAPACITY')
  assert.equal(w1.reviewer.invocations.length, 0)
  assert.equal(w1.actor.invocations.length, 1)

  // Reviewer exhausted: actor must not review its own candidate; nothing else reviews.
  const w2 = makeWorld()
  w2.github.addIssue(36, 'work', 'body')
  w2.reviewer.script = [() => ({ outcome: { kind: 'RESOURCE_EXHAUSTED', detail: 'quota' } })]
  await w2.sup.run([])
  const lane2 = w2.store.getLane('exec-i36')
  assert.equal(lane2?.status, 'HOLD_CAPACITY')
  assert.equal(w2.actor.invocations.length, 1)
  assert.equal(lane2?.reviews.length, 0)
  // Held is held: further runs invoke nobody.
  await w2.sup.run([])
  assert.equal(w2.actor.invocations.length, 1)
  assert.equal(w2.reviewer.invocations.length, 1)
})
