import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTrackedDebris, isExplicitlyRequiredByIssue } from '../debris.ts'
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

test('119-H3: isExplicitlyRequiredByIssue matches only on the literal basename in the issue body', () => {
  assert.equal(isExplicitlyRequiredByIssue('tsconfig.i123.json', 'Add tsconfig.i123.json to the repo.'), true)
  assert.equal(isExplicitlyRequiredByIssue('nested/tsconfig.i123.json', 'Add tsconfig.i123.json to the repo.'), true)
  assert.equal(isExplicitlyRequiredByIssue('tsconfig.i123.json', 'No mention of any scratch config here.'), false)
})

// Review round-2 finding 3 — a file that already existed at base and was
// merely modified must never be treated as debris, even if its name matches
// a debris pattern.
test('119-finding3: a pre-existing (modified, not added) file matching a debris pattern is preserved', async () => {
  const w = makeWorld()
  w.github.addIssue(123, 'work', 'body')
  w.actor.script = [(req) => {
    w.git.heads.set(req.worktree, w.git.newSha('withmodified'))
    // tsconfig.i123.json matches the debris pattern but was already present
    // at base and only modified here — `added` (diff-filter=A) excludes it.
    w.git.changed.set(req.worktree, ['src/real.ts', 'tsconfig.i123.json'])
    w.git.added.set(req.worktree, ['src/real.ts'])
    return { outcome: { kind: 'COMPLETE', detail: 'done' }, actorSignal: 'COMPLETE' }
  }]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i123')
  assert.ok(lane)
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  assert.equal(w.git.removedPaths.length, 0)
  assert.ok(lane.candidate)
  assert.deepEqual([...lane.candidate.changedFiles].sort(), ['src/real.ts', 'tsconfig.i123.json'])
})

// Review round-2 finding 3 — the governing issue may explicitly require a
// newly added file whose name happens to match a debris pattern; that named
// exception must be preserved, never inferred from Actor prose.
test('119-finding3: a newly added file the issue body explicitly names is exempt from debris removal', async () => {
  const w = makeWorld()
  w.github.addIssue(124, 'work', 'The fix must add a new file named tsconfig.i124.json as permanent project config.')
  w.actor.script = [(req) => {
    w.git.heads.set(req.worktree, w.git.newSha('withrequired'))
    w.git.changed.set(req.worktree, ['src/real.ts', 'tsconfig.i124.json'])
    return { outcome: { kind: 'COMPLETE', detail: 'done' }, actorSignal: 'COMPLETE' }
  }]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i124')
  assert.ok(lane)
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  assert.equal(w.git.removedPaths.length, 0)
  assert.ok(lane.candidate)
  assert.deepEqual([...lane.candidate.changedFiles].sort(), ['src/real.ts', 'tsconfig.i124.json'])
})

// Review round-2 finding 2 — a repair Actor that deletes a previously
// tracked debris file itself must never trigger a redundant (and failing)
// `git rm` on a path already absent from HEAD/index.
test('119-finding2: a repair round where the Actor itself deletes a previously tracked debris file proceeds normally', async () => {
  const w = makeWorld()
  w.github.addIssue(125, 'work', 'body')
  w.reviewer.script = [
    () => ({ outcome: { kind: 'COMPLETE', detail: 'reviewed' }, verdict: 'REQUEST_CHANGES', summary: 'remove the debris file', findings: ['drop the scratch file'] }),
  ]
  w.actor.script = [
    (req) => {
      // Fresh round: real work plus a tracked debris file.
      w.git.heads.set(req.worktree, w.git.newSha('fresh'))
      w.git.changed.set(req.worktree, ['src/real.ts', 's2_prerepair_repro.ts'])
      return { outcome: { kind: 'COMPLETE', detail: 'done' }, actorSignal: 'COMPLETE' }
    },
    (req) => {
      // Repair round: the Actor deletes its own debris file. Net diff versus
      // the original base no longer contains it at all (added then removed
      // within the same base..HEAD span) — nothing left to `git rm`.
      w.git.heads.set(req.worktree, w.git.newSha('repaired'))
      w.git.changed.set(req.worktree, ['src/real.ts'])
      return { outcome: { kind: 'COMPLETE', detail: 'removed the scratch file myself' }, actorSignal: 'COMPLETE' }
    },
  ]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i125')
  assert.ok(lane)
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  // No bounded-removal call was ever needed for the repair round.
  assert.equal(w.git.removedPaths.length, 1) // only the fresh-round cleanup
  assert.ok(lane.candidate)
  assert.deepEqual(lane.candidate.changedFiles, ['src/real.ts'])
  assert.equal(w.reviewer.invocations.length, 2)
})

// Review round-2 finding 4 — deterministic validation must run against the
// exact post-cleanup head/tree, not a divergent head created afterward.
test('119-finding4: debris cleanup happens before validation runs, so validation and the frozen candidate are bound to the same head', async () => {
  const seenAtValidation: string[][] = []
  const w = makeWorld({ validationCommand: 'true' }, undefined, {
    runValidation: async (worktree) => {
      seenAtValidation.push([...w.git.changedFiles(worktree)])
      return { pass: true, detail: 'ok' }
    },
  })
  w.github.addIssue(126, 'work', 'body')
  w.actor.script = [(req) => {
    w.git.heads.set(req.worktree, w.git.newSha('withdebris'))
    w.git.changed.set(req.worktree, ['src/real.ts', '.write-probe-i126'])
    return { outcome: { kind: 'COMPLETE', detail: 'done' }, actorSignal: 'COMPLETE' }
  }]
  await w.sup.run([])
  const lane = w.store.getLane('exec-i126')
  assert.ok(lane)
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  assert.ok(lane.candidate)
  // Validation observed the already-cleaned file list — debris was gone
  // before validation ran, not stripped afterward.
  assert.deepEqual(seenAtValidation[0], ['src/real.ts'])
  assert.deepEqual(lane.candidate.changedFiles, ['src/real.ts'])
})
