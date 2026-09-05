import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTrackedDebris } from '../debris.ts'
import { makeWorld } from './helpers.ts'

// Issue #119 H2/H3 — negative test: known tracked-debris patterns
// (.write-probe-*, temporary tsconfig/repro files, commit-message scratch
// files) must never remain tracked in a frozen candidate.

test('119-H3: isTrackedDebris recognizes the known debris categories and nothing else', () => {
  assert.equal(isTrackedDebris('.write-probe-design-i106'), true)
  assert.equal(isTrackedDebris('tsconfig.i109.json'), true)
  assert.equal(isTrackedDebris('tsconfig.typecheck-scratch.json'), true)
  assert.equal(isTrackedDebris('s2_prerepair_repro.ts'), true)
  assert.equal(isTrackedDebris('COMMIT_MSG_I109.txt'), true)
  assert.equal(isTrackedDebris('nested/dir/COMMIT_MSG_I109.txt'), true)
  // Real product/config files are never mistaken for debris.
  assert.equal(isTrackedDebris('tsconfig.json'), false)
  assert.equal(isTrackedDebris('src/reproduction-model.ts'), false) // "repro" not a standalone token
  assert.equal(isTrackedDebris('devharness/gitops.ts'), false)
  assert.equal(isTrackedDebris('README.md'), false)
})

test('119-H3: a candidate diff containing debris is auto-stripped (bounded git rm) before it is ever frozen or reviewed', async () => {
  const w = makeWorld()
  w.github.addIssue(122, 'work', 'body')
  const debrisPaths = [
    '.write-probe-design-i122',
    'tsconfig.i122.json',
    's2_prerepair_repro.ts',
    'COMMIT_MSG_I122.txt',
  ]
  w.actor.script = [(req) => {
    w.git.heads.set(req.worktree, w.git.newSha('withdebris'))
    w.git.changed.set(req.worktree, ['src/real.ts', ...debrisPaths])
    return { outcome: { kind: 'COMPLETE', detail: 'done' }, actorSignal: 'COMPLETE' }
  }]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i122')
  assert.ok(lane)
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  assert.ok(lane.candidate)

  // Bounded removal touched exactly the debris paths, nothing else.
  assert.equal(w.git.removedPaths.length, 1)
  assert.deepEqual([...w.git.removedPaths[0]!.paths].sort(), [...debrisPaths].sort())

  // The frozen candidate — what was pushed and what the Reviewer saw — never
  // carries the debris.
  assert.deepEqual(lane.candidate.changedFiles, ['src/real.ts'])
  assert.equal(w.reviewer.invocations.length, 1)
  const reviewedHead = w.reviewer.invocations[0]?.headSha
  assert.equal(reviewedHead, lane.candidate.headSha)
  assert.ok(w.git.pushes.every((p) => p.sha === lane.candidate?.headSha))

  // H2: cleanup stayed strictly bounded — it never touched push or any
  // GitHub-mutating call beyond the ordinary single PR-creation/receipt flow.
  assert.equal(w.git.pushes.length, 1)
  assert.equal(w.github.writeCalls.filter((c) => c.startsWith('createPr')).length, 1)
})
