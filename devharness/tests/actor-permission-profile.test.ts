import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACTOR_ALLOWED_TOOLS, ACTOR_DISALLOWED_TOOLS, FORBIDDEN_PERMISSION_MODE,
  actorPermissionArgs, buildActorArgs, createClaudeActorAdapter,
} from '../adapters/actor-claude.ts'

// Issue #119 review round-2 finding 1 — the standard writable Actor
// permission profile must grant a bounded `git rm` capability while denying
// push, GitHub mutation, and permission bypass, regardless of what extra
// args an operator later supplies on top of it.

test('119-H2 finding1: the profile grants exactly a bounded git-rm capability, nothing broader', () => {
  assert.deepEqual(ACTOR_ALLOWED_TOOLS, ['Bash(git rm -f -- *)'])
})

test('119-H2 finding1: the profile denies push, GitHub mutation, and unscoped rm', () => {
  assert.ok(ACTOR_DISALLOWED_TOOLS.some((t) => t.includes('git push')))
  assert.ok(ACTOR_DISALLOWED_TOOLS.some((t) => t.includes('gh')))
  assert.ok(ACTOR_DISALLOWED_TOOLS.some((t) => t === 'Bash(rm*)'))
})

test('119-H2 finding1: the assembled CLI args never carry a permission-bypass flag', () => {
  const args = actorPermissionArgs()
  assert.ok(!args.some((a) => a.includes(FORBIDDEN_PERMISSION_MODE)))
  assert.ok(args.includes('--allowedTools'))
  assert.ok(args.includes('--disallowedTools'))
})

// Round-2 review finding 1 — the prior test above only examined
// actorPermissionArgs() in isolation and never assembled or validated the
// real invocation, so `--actor-arg=--permission-mode --actor-arg=bypassPermissions`
// appended after it would still reach `claude` unrejected. These tests build
// the complete argument array `buildActorArgs` actually hands to `runCli`.

test('119-H2 finding1: a full clean invocation never carries a bypass flag and keeps the fixed profile', () => {
  const args = buildActorArgs('do the work', { maxTurns: 10, extraArgs: ['--verbose'] })
  assert.ok(!args.some((a) => a.includes(FORBIDDEN_PERMISSION_MODE)))
  assert.ok(args.includes('-p'))
  const allowedIdx = args.indexOf('--allowedTools')
  const disallowedIdx = args.indexOf('--disallowedTools')
  assert.ok(allowedIdx >= 0 && disallowedIdx === allowedIdx + 2)
  assert.equal(args[allowedIdx + 1], ACTOR_ALLOWED_TOOLS.join(','))
  assert.equal(args[disallowedIdx + 1], ACTOR_DISALLOWED_TOOLS.join(','))
  assert.ok(args.includes('--verbose'))
  // extraArgs are appended strictly after the fixed permission profile.
  assert.ok(args.indexOf('--verbose') > disallowedIdx)
})

test('119-H2 finding1: extraArgs smuggling --permission-mode + bypassPermissions is rejected before invocation', () => {
  assert.throws(
    () => buildActorArgs('do the work', { maxTurns: 10, extraArgs: ['--permission-mode', 'bypassPermissions'] }),
    /permission profile is fixed/,
  )
})

test('119-H2 finding1: extraArgs referencing bypassPermissions in any form is rejected', () => {
  assert.throws(
    () => buildActorArgs('do the work', { maxTurns: 10, extraArgs: ['--permission-mode=bypassPermissions'] }),
    /permission profile is fixed/,
  )
  assert.throws(
    () => buildActorArgs('do the work', { maxTurns: 10, extraArgs: ['bypassPermissions'] }),
    /forbidden permission mode/,
  )
})

test('119-H2 finding1: extraArgs re-declaring allowedTools/disallowedTools is rejected', () => {
  assert.throws(
    () => buildActorArgs('do the work', { maxTurns: 10, extraArgs: ['--allowedTools', 'Bash(*)'] }),
    /permission profile is fixed/,
  )
  assert.throws(
    () => buildActorArgs('do the work', { maxTurns: 10, extraArgs: ['--disallowedTools', ''] }),
    /permission profile is fixed/,
  )
})

test('119-H2 finding1: createClaudeActorAdapter rejects a malicious extraArgs invocation before spawning', async () => {
  const adapter = createClaudeActorAdapter({
    maxTurns: 10,
    extraArgs: ['--actor-arg=--permission-mode', '--actor-arg=bypassPermissions'].flatMap((a) => a.split('=').slice(1)),
  })
  await assert.rejects(
    adapter.invoke({
      lane: {} as never,
      worktree: '/tmp/nonexistent-does-not-matter',
      taskKind: 'fresh',
      issue: { number: 1, title: 't', body: 'b', state: 'open', labels: [] },
    }),
    /permission profile is fixed/,
  )
})
