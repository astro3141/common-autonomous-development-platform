import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyFailure } from '../outcomes.ts'
import { REVIEWER_OUTPUT_SCHEMA, reviewerPrompt } from '../prompts.ts'
import { faultInjectionFor, runCli } from './spawn.ts'
import type { ReviewerPort, ReviewRequest, ReviewResult } from './types.ts'

/**
 * Codex independent-reviewer adapter over the real `codex exec` surface,
 * read-only sandbox. Never invoked on anything but a frozen exact candidate.
 */
export function createCodexReviewerAdapter(opts: {
  extraArgs: string[]
  timeoutMs?: number
}): ReviewerPort {
  return {
    providerName: 'codex-cli',

    async review(req: ReviewRequest): Promise<ReviewResult> {
      const injected = faultInjectionFor('reviewer')
      const dir = mkdtempSync(join(tmpdir(), 'devharness-review-'))
      const schemaFile = join(dir, 'schema.json')
      const lastMsgFile = join(dir, 'last.json')
      writeFileSync(schemaFile, JSON.stringify(REVIEWER_OUTPUT_SCHEMA))

      const args = [
        'exec',
        '-s', 'read-only',
        '--skip-git-repo-check',
        '--color', 'never',
        '--output-schema', schemaFile,
        '-o', lastMsgFile,
        ...opts.extraArgs,
        reviewerPrompt(req),
      ]
      const raw = await runCli('codex', args, {
        cwd: req.worktree,
        timeoutMs: opts.timeoutMs ?? 30 * 60_000,
        killAfterMs: injected !== undefined ? 5_000 : undefined,
      })

      if (injected !== undefined) {
        return {
          outcome: {
            kind: injected,
            detail: `FAULT_INJECTION: simulated reviewer ${injected} immediately after real invocation start (not a real provider event)`,
            faultInjected: true,
          },
        }
      }
      if (raw.harnessKilled) {
        return { outcome: { kind: 'PROCESS_CRASHED', detail: 'reviewer invocation exceeded harness timeout and was killed' } }
      }

      if (raw.exitCode === 0 && existsSync(lastMsgFile)) {
        try {
          const j = JSON.parse(readFileSync(lastMsgFile, 'utf8')) as {
            verdict?: string; summary?: string; findings?: string[]; debrisPaths?: string[]
          }
          if (j.verdict === 'GO' || j.verdict === 'REQUEST_CHANGES') {
            return {
              outcome: { kind: 'COMPLETE', detail: j.summary ?? '' },
              verdict: j.verdict,
              summary: j.summary,
              findings: j.findings ?? [],
              debrisPaths: j.debrisPaths ?? [],
            }
          }
          return { outcome: { kind: 'UNKNOWN', detail: `clean exit but no typed verdict: ${JSON.stringify(j).slice(0, 400)}` } }
        } catch {
          return { outcome: { kind: 'UNKNOWN', detail: 'exit 0 but unparseable reviewer output' } }
        }
      }
      return { outcome: classifyFailure(raw) }
    },
  }
}
