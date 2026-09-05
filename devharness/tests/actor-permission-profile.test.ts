import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACTOR_ALLOWED_TOOLS, ACTOR_DISALLOWED_TOOLS, FORBIDDEN_PERMISSION_MODE, actorPermissionArgs,
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
