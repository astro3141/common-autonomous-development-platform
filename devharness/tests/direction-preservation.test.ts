import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decide } from '../transitions.ts'
import { makeWorld, type World } from './helpers.ts'
import type { Lane } from '../types.ts'

// Issue #111 falsification suite: the exact worker-reported reason for
// STOP_DESIGN_REQUIRED must survive into durable state, the canonical
// receipt, restart, and status — and be superseded by later completion.

const UNIQUE = 'DIRECTION-REASON-7f3a: landed contract lacks a decision on widget retention TTL vs archive semantics'

function humanResume(w: World, lane: Lane): void {
  const d = decide(lane, { type: 'HUMAN_RESUME' }, w.cfg.retry)
  lane.status = d.status
  lane.holdReason = d.holdReason
  lane.holdProvenance = undefined
  if (d.resetsProviderRetry === true) lane.retryCount = 0
  w.store.upsertLane(lane)
}

// #111 test 1: exact text reaches durable state AND the GitHub receipt.
test('111-1: STOP_DESIGN_REQUIRED preserves the exact worker summary in state and receipt', async () => {
  const w = makeWorld()
  w.github.addIssue(90, 'work needing direction', 'body')
  w.actor.script = [() => ({
    outcome: { kind: 'COMPLETE', detail: UNIQUE },
    actorSignal: 'STOP_DESIGN_REQUIRED',
    summary: UNIQUE,
  })]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i90')
  assert.equal(lane?.status, 'HUMAN_DIRECTION_WAIT')
  // Durable state carries the exact record.
  assert.equal(lane.pendingDirection?.actorSignal, 'STOP_DESIGN_REQUIRED')
  assert.equal(lane.pendingDirection?.directionSummary, UNIQUE)
  assert.equal(lane.pendingDirection?.sourceRole, 'actor')
  // Canonical receipt carries the exact text, marked as worker report only.
  const receipt = w.github.comments.find((c) => c.body.includes('HUMAN_DIRECTION_WAIT'))
  assert.ok(receipt)
  assert.ok(receipt.body.includes(UNIQUE))
  assert.match(receipt.body, /"actor_signal": "STOP_DESIGN_REQUIRED"/)
  assert.match(receipt.body, /"source_role": "actor"/)
  assert.match(receipt.body, /WORKER_REPORTED_INFORMATION_ONLY/)
  assert.match(receipt.body, /not Human or Design authority/)
  // No reviewer, no candidate: the reason transport changed no routing.
  assert.equal(w.reviewer.invocations.length, 0)
  assert.equal(lane.candidate, undefined)
})

// Design-lane variant: source_role must say designer.
test('111-1b: designer STOP_DESIGN_REQUIRED records source_role=designer', async () => {
  const w = makeWorld()
  w.github.addIssue(91, 'design stop', 'HARNESS_LANE: DESIGN\n\nbody')
  w.actor.script = [() => ({
    outcome: { kind: 'COMPLETE', detail: '' },
    actorSignal: 'STOP_DESIGN_REQUIRED',
    summary: UNIQUE,
  })]
  await w.sup.run([])
  const lane = w.store.getLane('design-i91')
  assert.equal(lane?.status, 'HUMAN_DIRECTION_WAIT')
  assert.equal(lane.pendingDirection?.sourceRole, 'designer')
})

// #111 test 2: restart/reconcile preserves the pending direction text.
test('111-2: restart preserves the exact pending direction text and shows it in status', async () => {
  const w = makeWorld()
  w.github.addIssue(92, 'work', 'body')
  w.actor.script = [() => ({
    outcome: { kind: 'COMPLETE', detail: '' },
    actorSignal: 'STOP_DESIGN_REQUIRED',
    summary: UNIQUE,
  })]
  await w.sup.run([])

  // New process, same state dir; no human relays anything.
  const w2 = makeWorld({}, w.stateDir)
  w2.github.issues = w.github.issues
  await w2.sup.reconcile()
  const lane2 = w2.store.getLane('exec-i92')
  assert.equal(lane2?.status, 'HUMAN_DIRECTION_WAIT')
  assert.equal(lane2.pendingDirection?.directionSummary, UNIQUE)
  // Status projection exposes it (boundary is actionable without replaying provider state).
  const line = w2.sup.statusLines().find((l) => l.includes('exec-i92'))
  assert.ok(line?.includes(UNIQUE.slice(0, 60)))
  // Running again keeps the boundary and does not duplicate/mutate the record.
  await w2.sup.run([])
  assert.equal(lane2.status, 'HUMAN_DIRECTION_WAIT')
  assert.equal(lane2.pendingDirection?.directionSummary, UNIQUE)
})

// #111 test 3: the COMPLETE path never creates a direction request.
test('111-3: actor COMPLETE creates no pending direction', async () => {
  const w = makeWorld()
  w.github.addIssue(93, 'work', 'body')
  await w.sup.run([])
  const lane = w.store.getLane('exec-i93')
  assert.equal(lane?.status, 'HUMAN_MERGE_WAIT')
  assert.equal(lane.pendingDirection, undefined)
  assert.ok(w.github.comments.every((c) => !c.body.includes('direction_summary')))
})

// #111 test 4: after resume, a later successful completion supersedes the
// stale direction text so it cannot be mistaken for current state.
test('111-4: resume then successful completion clears the stale pending direction', async () => {
  const w = makeWorld()
  w.github.addIssue(94, 'work', 'body')
  w.actor.script = [() => ({
    outcome: { kind: 'COMPLETE', detail: '' },
    actorSignal: 'STOP_DESIGN_REQUIRED',
    summary: UNIQUE,
  })]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i94')
  assert.equal(lane?.status, 'HUMAN_DIRECTION_WAIT')
  assert.equal(lane.pendingDirection?.directionSummary, UNIQUE)

  // Human resumes (after answering direction out-of-band, e.g. issue edit).
  humanResume(w, lane)
  assert.equal(lane.status, 'ACTOR_INTERRUPTED') // fail-closed worker resume (R1)
  await w.sup.run([]) // default actor behavior completes with a commit

  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  assert.equal(lane.pendingDirection, undefined) // stale request superseded
  const line = w.sup.statusLines().find((l) => l.includes('exec-i94'))
  assert.ok(line !== undefined && !line.includes('DIRECTION-REASON-7f3a'))
})

// Engine-level: the supervisor transports the reason but never answers it —
// no transition consumes pendingDirection as input authority.
test('111-5: pending direction is never auto-answered; only human resume exits the boundary', async () => {
  const w = makeWorld()
  w.github.addIssue(95, 'work', 'body')
  w.actor.script = [() => ({
    outcome: { kind: 'COMPLETE', detail: '' },
    actorSignal: 'STOP_DESIGN_REQUIRED',
    summary: UNIQUE,
  })]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i95')
  assert.equal(lane?.status, 'HUMAN_DIRECTION_WAIT')
  const before = w.actor.invocations.length
  for (let i = 0; i < 3; i += 1) await w.sup.run([])
  assert.equal(lane.status, 'HUMAN_DIRECTION_WAIT') // boundary holds
  assert.equal(w.actor.invocations.length, before)  // nobody re-invoked to "answer"
  assert.equal(lane.pendingDirection?.directionSummary, UNIQUE)
})

// A worker signaling STOP with no structured summary still yields an explicit,
// honest placeholder rather than silently empty text.
test('111-6: STOP without a summary records an explicit placeholder', async () => {
  const w = makeWorld()
  w.github.addIssue(96, 'work', 'body')
  w.actor.script = [() => ({
    outcome: { kind: 'COMPLETE', detail: '' },
    actorSignal: 'STOP_DESIGN_REQUIRED',
    // no summary field
  })]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i96')
  assert.equal(lane?.status, 'HUMAN_DIRECTION_WAIT')
  assert.equal(lane.pendingDirection?.directionSummary, '(worker provided no structured summary)')
})
