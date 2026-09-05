import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { addedFiles } from '../gitops.ts'

/**
 * Issue #119 review round-2 finding 2/3 — `addedFiles` must scope the
 * debris scan to paths this lane itself introduced, exercised against a
 * real throwaway repository (no test touches the project repository).
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function writeAndCommit(dir: string, files: Record<string, string | null>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path)
    if (content === null) {
      rmSync(full)
    } else {
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', message])
  return git(dir, ['rev-parse', 'HEAD'])
}

function seedRepo(files: Record<string, string>): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'devharness-gitops-added-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'devharness-test@example.com'])
  git(dir, ['config', 'user.name', 'devharness-test'])
  const baseSha = writeAndCommit(dir, files, 'seed')
  return { dir, baseSha }
}

test('119-finding2/3: addedFiles lists a newly introduced debris file', () => {
  const { dir, baseSha } = seedRepo({ 'src/real.ts': 'export const x = 1\n' })
  writeAndCommit(dir, { '.write-probe-x': 'probe\n' }, 'add debris')
  assert.deepEqual(addedFiles(dir, baseSha), ['.write-probe-x'])
})

test('119-finding3: addedFiles excludes a pre-existing file that was only modified, even if its name matches a debris pattern', () => {
  const { dir, baseSha } = seedRepo({
    'src/real.ts': 'export const x = 1\n',
    'tsconfig.i109.json': '{"extends": "./tsconfig.json"}\n', // legitimate, already at base
  })
  writeAndCommit(dir, { 'tsconfig.i109.json': '{"extends": "./tsconfig.json", "extra": true}\n' }, 'modify pre-existing config')
  assert.deepEqual(addedFiles(dir, baseSha), [])
})

test('119-finding2: addedFiles excludes a debris file the lane itself already deleted (nothing left to git rm)', () => {
  const { dir, baseSha } = seedRepo({ 'src/real.ts': 'export const x = 1\n' })
  writeAndCommit(dir, { 's2_prerepair_repro.ts': 'scratch\n' }, 'add debris (round 1)')
  writeAndCommit(dir, { 's2_prerepair_repro.ts': null }, 'repair round deletes its own debris')
  assert.deepEqual(addedFiles(dir, baseSha), [])
})
