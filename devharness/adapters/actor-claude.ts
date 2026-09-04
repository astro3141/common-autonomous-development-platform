import { classifyFailure, classifyProviderText } from '../outcomes.ts'
import { ACTOR_OUTPUT_SCHEMA, actorPrompt } from '../prompts.ts'
import { faultInjectionFor, runCli } from './spawn.ts'
import type { ActorPort, ActorRequest, ActorResult } from './types.ts'

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
      const args = [
        '-p', prompt,
        '--output-format', 'json',
        '--json-schema', JSON.stringify(ACTOR_OUTPUT_SCHEMA),
        '--max-turns', String(opts.maxTurns),
        ...opts.extraArgs,
      ]
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
