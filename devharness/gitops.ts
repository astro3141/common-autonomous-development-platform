import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Local git plumbing for worktree isolation and exact-candidate identity. */

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function ensureBaseClone(stateDir: string, repo: string): string {
  const base = join(stateDir, 'base')
  if (!existsSync(join(base, '.git'))) {
    mkdirSync(stateDir, { recursive: true })
    execFileSync('git', ['clone', `https://github.com/${repo}.git`, base], { stdio: ['ignore', 'pipe', 'pipe'] })
  } else {
    git(base, ['fetch', 'origin', '--prune'])
  }
  return base
}

export function resolveRemoteSha(base: string, branch: string): string {
  git(base, ['fetch', 'origin', branch])
  return git(base, ['rev-parse', `origin/${branch}`])
}

/** Create an isolated worktree on a new branch from an exact base SHA. */
export function addWorktree(base: string, worktree: string, branch: string, baseSha: string): void {
  git(base, ['worktree', 'add', '-b', branch, worktree, baseSha])
}

export function worktreeExists(worktree: string): boolean {
  return existsSync(join(worktree, '.git'))
}

export function headSha(worktree: string): string {
  return git(worktree, ['rev-parse', 'HEAD'])
}

export function treeSha(worktree: string): string {
  return git(worktree, ['rev-parse', 'HEAD^{tree}'])
}

export function isDirty(worktree: string): boolean {
  return git(worktree, ['status', '--porcelain']) !== ''
}

/**
 * Package uncommitted worker output into a checkpoint commit. Content is
 * entirely worker-authored; this is mechanical packaging only.
 */
export function checkpointCommit(worktree: string, message: string): void {
  if (isDirty(worktree)) {
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-m', message])
  }
}

/**
 * Bounded tracked-file removal (issue #119 H2). Operates only inside
 * `worktree` (via `git -C`) and only on the exact paths given — no glob
 * expansion, no traversal outside the worktree, no push, no GitHub call.
 * Callers must pass paths already confirmed to be in the lane's own diff.
 */
export function removeTrackedPaths(worktree: string, paths: string[]): void {
  if (paths.length === 0) return
  git(worktree, ['rm', '-f', '--', ...paths])
}

export function changedFiles(worktree: string, baseSha: string): string[] {
  const out = git(worktree, ['diff', '--name-only', `${baseSha}...HEAD`])
  return out === '' ? [] : out.split('\n')
}

export function push(worktree: string, branch: string): void {
  // force-with-lease: a rebase repair rewrites lane-branch history. The lane
  // exclusively owns its branch (foreign pushes hold the lane), and the lease
  // still refuses to clobber an unexpected remote head.
  git(worktree, ['push', '--force-with-lease', '-u', 'origin', `HEAD:refs/heads/${branch}`])
}

/** True if `ancestor` is an ancestor of (or equal to) `descendant` in `repoDir`. */
export function isAncestor(repoDir: string, ancestor: string, descendant: string): boolean {
  try {
    git(repoDir, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}
