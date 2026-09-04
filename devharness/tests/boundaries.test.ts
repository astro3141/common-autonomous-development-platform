import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createGitHubAdapter } from '../adapters/github.ts'
import { makeWorld, REPO } from './helpers.ts'
import type { Lane } from '../types.ts'

function snapshotDir(dir: string): string {
  const parts: string[] = []
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) {
      const p = join(f.parentPath, f.name)
      parts.push(`${p}:${readFileSync(p, 'utf8')}`)
    }
  }
  return parts.sort().join('|')
}

// Required test 17: Supervisor cannot mutate implementation files through its routing path.
test('17: a full supervisor cycle leaves worktree file contents untouched (only workers author files)', async () => {
  const w = makeWorld()
  // Real directory standing in for the worktree; fake actor writes nothing.
  const wt = mkdtempSync(join(tmpdir(), 'devharness-wt-'))
  mkdirSync(join(wt, 'src'))
  writeFileSync(join(wt, 'src', 'impl.ts'), 'export const x = 1\n')
  writeFileSync(join(wt, 'README.md'), 'readme\n')

  w.github.addIssue(60, 'work', 'body')
  w.git.worktrees.add(wt)
  w.git.heads.set(wt, 'head0'.padEnd(40, '0'))
  const lane: Lane = {
    laneId: 'exec-i60', laneKind: 'EXECUTION', repo: REPO, workIssue: 60,
    baseBranch: 'main', baseSha: 'base'.padEnd(40, '0'), branch: 'harness/exec-i60',
    worktree: wt, currentHeadSha: '', ownerRole: 'actor', status: 'VALIDATING',
    reviews: [], attempt: 0, retryCount: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  w.store.upsertLane(lane)

  const before = snapshotDir(wt)
  // VALIDATING -> FREEZING -> REVIEW_RUNNING -> HUMAN_MERGE_WAIT: pure routing.
  await w.sup.step(lane)
  await w.sup.step(lane)
  await w.sup.step(lane)
  assert.equal(lane.status, 'HUMAN_MERGE_WAIT')
  assert.equal(snapshotDir(wt), before)
})

// Required test 18: Human merge boundary cannot be bypassed.
test('18: harness exposes no merge path and HUMAN_MERGE_WAIT only exits via observed human merge', async () => {
  // (a) The GitHub port surface has no merge-like capability at all.
  const real = createGitHubAdapter(true)
  const surface = Object.keys(real)
  assert.ok(surface.every((k) => !/merge/i.test(k)), `adapter surface leaks merge: ${surface.join(',')}`)

  // (b) A GO lane stays at HUMAN_MERGE_WAIT across arbitrarily many runs.
  const w = makeWorld()
  w.github.addIssue(61, 'work', 'body')
  await w.sup.run([])
  const lane = w.store.getLane('exec-i61')
  assert.equal(lane?.status, 'HUMAN_MERGE_WAIT')
  for (let i = 0; i < 3; i += 1) await w.sup.run([])
  assert.equal(lane?.status, 'HUMAN_MERGE_WAIT')
  assert.equal(w.github.prs.get(lane.prNumber ?? -1)?.merged, false)

  // (c) Only the human merge (external) releases the boundary.
  w.github.humanMerge(lane.prNumber ?? -1)
  await w.sup.run([])
  assert.equal(lane?.status, 'MERGED')
})

test('dry-run: GitHub writes are hard-refused and no worker is invoked', async () => {
  // Adapter-level refusal (the backstop for the CADP read-only dry-run).
  const ro = createGitHubAdapter(true)
  await assert.rejects(ro.comment('x/y', 1, 'hi'), /dry-run: GitHub write refused/)
  await assert.rejects(ro.createPr('x/y', { head: 'h', base: 'main', title: 't', body: 'b' }), /dry-run: GitHub write refused/)

  // Supervisor-level: dry-run plans routes without actuation.
  const w = makeWorld({ dryRun: true })
  w.github.readOnly = true
  w.github.addIssue(62, 'work', 'body')
  w.github.addIssue(63, 'design work', 'HARNESS_LANE: DESIGN\n\ndesign it')
  await w.sup.run([])
  assert.equal(w.github.writeCalls.length, 0)
  assert.equal(w.actor.invocations.length, 0)
  assert.equal(w.reviewer.invocations.length, 0)
  assert.equal(w.git.pushes.length, 0)
  assert.equal(w.git.worktrees.size, 0)
  // Routing was still computed deterministically.
  assert.equal(w.store.getLane('exec-i62')?.status, 'WORKTREE_SETUP')
  assert.equal(w.store.getLane('design-i63')?.laneKind, 'DESIGN')
})
