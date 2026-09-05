import { classifyFailure, classifyProviderText } from '../outcomes.ts'
import { ACTOR_OUTPUT_SCHEMA, actorPrompt } from '../prompts.ts'
import { faultInjectionFor, runCli } from './spawn.ts'
import type { ActorPort, ActorRequest, ActorResult } from './types.ts'

/**
 * Standard writable Actor permission profile (issue #119 H2). Grants exactly
 * enough to remove Reviewer-identified tracked debris in the Actor's own
 * isolated worktree (`git rm` is a plain worktree-scoped git subcommand — it
 * cannot address anything outside that repository's tree, so this needs no
 * separate path confinement). Explicitly denies the reach this profile must
 * never gain: pushing, mutating GitHub, or escaping to full filesystem
 * deletion via a broader shell/`rm` grant.
 */
export const ACTOR_ALLOWED_TOOLS = ['Bash(git rm -f -- *)']
export const ACTOR_DISALLOWED_TOOLS = ['Bash(git push*)', 'Bash(gh*)', 'Bash(rm*)']

/** The one hard rule this profile may never carry, however it is composed. */
export const FORBIDDEN_PERMISSION_MODE = 'bypassPermissions'

export function actorPermissionArgs(): string[] {
  return [
    '--allowedTools', ACTOR_ALLOWED_TOOLS.join(','),
    '--disallowedTools', ACTOR_DISALLOWED_TOOLS.join(','),
  ]
}

/**
 * CLI flags that would let operator-supplied `actorExtraArgs` re-declare or
 * loosen the fixed permission profile above (e.g. re-adding `--permission-mode`
 * so it can be paired with a later `bypassPermissions` token, or re-declaring
 * `--allowedTools`/`--disallowedTools` with a broader list). These flags are
 * never legitimate in `actorExtraArgs`: the profile is fixed and non-negotiable.
 */
const FORBIDDEN_ACTOR_EXTRA_ARG_FLAGS = new Set([
  '--permission-mode',
  '--allowedTools',
  '--disallowedTools',
  '--dangerously-skip-permissions',
])

/**
 * Reject `actorExtraArgs` that could re-open the permission surface the fixed
 * profile above closes, before the invocation is ever assembled. A flag check
 * alone is not enough — the forbidden mode name itself is also rejected
 * wherever it appears, so it cannot be smuggled in as a bare value token
 * (e.g. `--actor-arg=--permission-mode --actor-arg=bypassPermissions`).
 */
export function assertSafeActorExtraArgs(extraArgs: string[]): void {
  for (const arg of extraArgs) {
    const flag = arg.split('=', 1)[0] ?? arg
    if (FORBIDDEN_ACTOR_EXTRA_ARG_FLAGS.has(flag)) {
      throw new Error(
        `actorExtraArgs may not set ${flag}: the Actor permission profile is fixed and cannot be overridden`,
      )
    }
    if (arg.includes(FORBIDDEN_PERMISSION_MODE)) {
      throw new Error(`actorExtraArgs may not reference the forbidden permission mode "${FORBIDDEN_PERMISSION_MODE}"`)
    }
  }
}

/**
 * Assembles the complete `claude` CLI invocation for one Actor call: prompt,
 * output contract, the fixed permission profile, and any operator-supplied
 * extra args — in that order, matching what is actually spawned. Exported so
 * tests can validate the real assembled invocation (not just the permission
 * profile in isolation). Throws if `extraArgs` attempts to reopen the
 * permission surface the fixed profile closes.
 */
export function buildActorArgs(prompt: string, opts: { maxTurns: number; extraArgs: string[] }): string[] {
  assertSafeActorExtraArgs(opts.extraArgs)
  return [
    '-p', prompt,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(ACTOR_OUTPUT_SCHEMA),
    '--max-turns', String(opts.maxTurns),
    ...actorPermissionArgs(),
    ...opts.extraArgs,
  ]
}

/**
 * Fable worker adapter over the real `claude -p` (headless print mode) surface.
 * Each call is a separate bounded invocation in the lane's isolated worktree.
 */
export function createClaudeActorAdapter(opts: {
  maxTurns: number
  extraArgs: string[]
  timeoutMs?: number
}): ActorPort {
  return {
    providerName: 'claude-cli',

    async invoke(req: ActorRequest): Promise<ActorResult> {
      const injected = faultInjectionFor('actor')
      const prompt = actorPrompt(req)
      const args = buildActorArgs(prompt, opts)
      const raw = await runCli('claude', args, {
        cwd: req.worktree,
        timeoutMs: opts.timeoutMs ?? 45 * 60_000,
        // For injected faults: cross the real invocation boundary, then stop it.
        killAfterMs: injected !== undefined ? 5_000 : undefined,
      })

      if (injected !== undefined) {
        return {
          outcome: {
            kind: injected,
            detail: `FAULT_INJECTION: simulated actor ${injected} immediately after real invocation start (not a real provider event)`,
            faultInjected: true,
          },
        }
      }
      if (raw.harnessKilled) {
        return { outcome: { kind: 'PROCESS_CRASHED', detail: 'actor invocation exceeded harness timeout and was killed' } }
      }

      // Success path requires positively parsed structured output.
      if (raw.exitCode === 0) {
        try {
          const j = JSON.parse(raw.stdout) as {
            is_error: boolean
            result?: string
            structured_output?: { signal?: string; summary?: string }
            subtype?: string
            api_error_status?: number | null
          }
          if (!j.is_error) {
            const sig = j.structured_output?.signal
            if (sig === 'COMPLETE' || sig === 'STOP_DESIGN_REQUIRED') {
              return {
                outcome: { kind: 'COMPLETE', detail: j.structured_output?.summary ?? '' },
                actorSignal: sig,
                summary: j.structured_output?.summary,
              }
            }
            return { outcome: { kind: 'UNKNOWN', detail: `clean exit but no typed signal (subtype=${j.subtype})` } }
          }
          const text = `${j.result ?? ''} api_error_status=${j.api_error_status ?? ''} subtype=${j.subtype ?? ''}`
          const classified = classifyProviderText(text)
          if (classified) return { outcome: classified }
          if (j.subtype !== undefined && j.subtype.startsWith('error_')) {
            return { outcome: { kind: 'FAILED_WORK', detail: text.slice(0, 800) } }
          }
          return { outcome: { kind: 'UNKNOWN', detail: text.slice(0, 800) } }
        } catch {
          return { outcome: { kind: 'UNKNOWN', detail: `exit 0 but unparseable output: ${raw.stdout.slice(0, 400)}` } }
        }
      }
      return { outcome: classifyFailure(raw) }
    },
  }
}
