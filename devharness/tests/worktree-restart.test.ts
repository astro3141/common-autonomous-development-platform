import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeWorld, REPO } from './helpers.ts'
import { Store } from '../store.ts'
import type { Lane } from '../types.ts'

function mkLane(id: string, issue: number, worktree: string, status: Lane['status']): Lane {
  return {
    laneId: id, laneKind: 'EXECUTION', repo: REPO, workIssue: issue,
    baseBranch: 'main', baseSha: 'base'.padEnd(40, '0'), branch: `harness/${id}`,
    worktree, currentHeadSha: '', ownerRole: 'actor', status,
    reviews: [], attempt: 0, retryCount: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
}

// Required test 14: two lanes cannot own the same worktree.
test('14: second lane claiming an owned worktree is refused and held', async () => {
  const w = makeWorld()
  const shared = '/fake/worktrees/shared'
  const a = mkLane('exec-i50', 50, shared, 'WORKTREE_SETUP')
  const b = mkLane('exec-i51', 51, shared, 'WORKTREE_SETUP')
  w.store.upsertLane(a)
  w.store.upsertLane(b)

  await w.sup.step(a)
  assert.equal(a.status, 'ACTOR_RUNNING')
  assert.equal(w.store.state.worktreeOwners[shared], 'exec-i50')

  await w.sup.step(b)
  assert.equal(b.status, 'HOLD_UNKNOWN')
  assert.match(b.holdReason ?? '', /worktree ownership conflict/)
  assert.equal(w.store.state.worktreeOwners[shared], 'exec-i50')

  // Registry-level guard also holds directly.
  assert.throws(() => w.store.claimWorktree(shared, 'exec-i51'), /owned by lane exec-i50/)
})

// Required test 16: restart reconstructs lane state and resumes/waits correctly.
test('16: restart during actor invocation resumes the same bounded lane without human relay', async () => {
  const w = makeWorld()
  w.github.addIssue(52, 'work', 'body')
  // Simulate a crash mid-actor-invocation: persist ACTOR_RUNNING then "die".
  w.actor.script = [(req) => {
    w.git.heads.set(req.worktree, w.git.newSha('partial'))
    throw new Error('simulated process death') // never reaches a result
  }]
  await w.sup.run([]).catch(() => {}) // the "crash"
  const persisted = w.store.getLane('exec-i52')
  assert.equal(persisted?.status, 'ACTOR_RUNNING')

  // New process: same state dir, fresh supervisor. No human pastes anything.
  const w2 = makeWorld({}, w.stateDir)
  const lane2 = w2.store.getLane('exec-i52')
  assert.ok(lane2)
  // Disk state (worktree) survived the crash.
  w2.git.worktrees.add(lane2.worktree)
  w2.git.heads.set(lane2.worktree, 'partialX'.padEnd(40, '0'))
  w2.github.addIssue(52, 'work', 'body')

  await w2.sup.run([])
  assert.equal(w2.actor.invocations[0]?.taskKind, 'interrupted-resume')
  assert.equal(lane2.status, 'HUMAN_MERGE_WAIT')
  assert.equal(w2.reviewer.invocations.length, 1)
})

test('16b: restart during review re-invokes reviewer on the same frozen candidate; actor untouched', async () => {
  const w = makeWorld()
  w.github.addIssue(53, 'work', 'body')
  w.reviewer.script = [() => { throw new Error('simulated death mid-review') }]
  await w.sup.run([]).catch(() => {})
  const persisted = w.store.getLane('exec-i53')
  assert.equal(persisted?.status, 'REVIEW_RUNNING')
  assert.ok(persisted?.candidate)

  const w2 = makeWorld({}, w.stateDir)
  const lane2 = w2.store.getLane('exec-i53')
  assert.ok(lane2?.candidate)
  w2.git.worktrees.add(lane2.worktree)
  w2.git.heads.set(lane2.worktree, lane2.candidate.headSha) // frozen candidate intact on disk
  w2.github.addIssue(53, 'work', 'body')
  w2.github.branchPr.set(lane2.branch, lane2.prNumber ?? 0)
  if (lane2.prNumber !== undefined) {
    w2.github.prs.set(lane2.prNumber, {
      number: lane2.prNumber, headRefName: lane2.branch, headSha: lane2.candidate.headSha,
      baseRefName: 'main', merged: false, state: 'open',
    })
  }

  await w2.sup.run([])
  assert.equal(w2.actor.invocations.length, 0) // actor NOT reinvoked
  assert.equal(w2.reviewer.invocations.length, 1)
  assert.equal(w2.reviewer.invocations[0]?.headSha, lane2.candidate.headSha)
  assert.equal(lane2.status, 'HUMAN_MERGE_WAIT')
})

test('16c: restart at human boundaries maintains them; merged-while-down is observed', async () => {
  const w = makeWorld()
  w.github.addIssue(54, 'work', 'body')
  await w.sup.run([])
  const lane = w.store.getLane('exec-i54')
  assert.equal(lane?.status, 'HUMAN_MERGE_WAIT')
  assert.ok(lane?.prNumber)

  // Human merged while the supervisor was down.
  w.github.humanMerge(lane.prNumber)
  const w2 = makeWorld({}, w.stateDir)
  w2.github.prs = w.github.prs
  w2.github.issues = w.github.issues
  w2.github.branchPr = w.github.branchPr
  await w2.sup.reconcile()
  assert.equal(w2.store.getLane('exec-i54')?.status, 'MERGED')
})

test('16d: stale lane (worktree deleted) is reconciled to a durable hold, not resumed blind', async () => {
  const w = makeWorld()
  const lane = mkLane('exec-i55', 55, '/fake/worktrees/gone', 'VALIDATING')
  w.store.upsertLane(lane)
  // FakeGit has no such worktree -> stale.
  await w.sup.reconcile()
  assert.equal(w.store.getLane('exec-i55')?.status, 'HOLD_CAPACITY')
  assert.match(w.store.getLane('exec-i55')?.holdReason ?? '', /stale lane/)
})
