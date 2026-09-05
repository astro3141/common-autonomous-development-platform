import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { removeTrackedPaths } from '../gitops.ts'

/**
 * Issue #119 H2 — bounded `git rm` capability, exercised against a real
 * throwaway repository (no test touches the project repository or any
 * remote). Every test builds its own temp repo under the OS temp dir.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function seedRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'devharness-gitops-debris-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'devharness-test@example.com'])
  git(dir, ['config', 'user.name', 'devharness-test'])
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'seed'])
  return dir
}

test('119-H2: removeTrackedPaths deletes exactly the named tracked paths, nothing else', () => {
  const dir = seedRepo({
    'src/real.ts': 'export const x = 1\n',
    '.write-probe-x': 'probe\n',
    'COMMIT_MSG_I1.txt': 'scratch\n',
  })
  const before = git(dir, ['ls-files']).split('\n').sort()
  assert.deepEqual(before, ['.write-probe-x', 'COMMIT_MSG_I1.txt', 'src/real.ts'])

  removeTrackedPaths(dir, ['.write-probe-x', 'COMMIT_MSG_I1.txt'])

  const afterIndex = git(dir, ['ls-files']).split('\n').sort()
  assert.deepEqual(afterIndex, ['src/real.ts'])
  assert.equal(existsSync(join(dir, 'src/real.ts')), true)
  assert.equal(existsSync(join(dir, '.write-probe-x')), false)
  assert.equal(existsSync(join(dir, 'COMMIT_MSG_I1.txt')), false)
})

test('119-H2: removeTrackedPaths never touches a path that was not named, even if it matches a debris pattern', () => {
  const dir = seedRepo({
    'src/real.ts': 'export const x = 1\n',
    '.write-probe-a': 'probe a\n',
    '.write-probe-b': 'probe b\n',
  })
  removeTrackedPaths(dir, ['.write-probe-a']) // .write-probe-b is deliberately not named
  const remaining = git(dir, ['ls-files']).split('\n').sort()
  assert.deepEqual(remaining, ['.write-probe-b', 'src/real.ts'])
})

test('119-H2: no-op on an empty path list — never runs `git rm` with no bound', () => {
  const dir = seedRepo({ 'src/real.ts': 'export const x = 1\n' })
  removeTrackedPaths(dir, [])
  assert.deepEqual(git(dir, ['ls-files']).split('\n'), ['src/real.ts'])
  assert.equal(git(dir, ['status', '--porcelain']), '')
})

test('119-H2: the bounded-removal surface never interacts with a remote (no push / GitHub mutation reach)', () => {
  const dir = seedRepo({
    'src/real.ts': 'export const x = 1\n',
    '.write-probe-x': 'probe\n',
  })
  assert.equal(git(dir, ['remote']), '') // no remote configured
  removeTrackedPaths(dir, ['.write-probe-x'])
  // Still no remote after the call: removeTrackedPaths has no code path that
  // adds a remote, fetches, or pushes — it is exactly `git rm -f -- <paths>`
  // scoped to the given worktree.
  assert.equal(git(dir, ['remote']), '')
  assert.equal(existsSync(join(dir, '.write-probe-x')), false)
})
