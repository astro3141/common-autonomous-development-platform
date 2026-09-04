#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createGitHubAdapter } from './adapters/github.ts'
import { createClaudeActorAdapter } from './adapters/actor-claude.ts'
import { createCodexReviewerAdapter } from './adapters/reviewer-codex.ts'
import { Store } from './store.ts'
import { Supervisor, realGitPort, realValidationRunner } from './supervisor.ts'
import { decide } from './transitions.ts'
import type { HarnessConfig, LaneKind } from './types.ts'

/**
 * devharness — thin GitHub-backed development supervisor (bootstrap tooling
 * for building CADP; not a CADP Core component).
 *
 * Commands:
 *   run        drive lanes until human boundary / hold
 *   status     print lane registry
 *   resume L   human resume of a held lane
 *   hold L     human hold of a lane
 *   reconcile  restart-style state reconstruction only
 *
 * There is deliberately NO merge command: human merge only.
 */

const USAGE = `usage: devharness <run|status|resume|hold|reconcile> [options]
  --repo owner/name        target repository (required)
  --pointer N              canonical working-pointer issue (default 65)
  --work SPEC              work issue; repeatable. SPEC = N[:design|:execution][:after=M]
  --state-dir PATH         durable state dir (default ~/.cadp-devharness/<owner>__<name>)
  --base-branch NAME       base branch (default main)
  --validation-cmd CMD     deterministic validation command run in the worktree
  --label NAME             work-discovery label ('' disables; default harness:work)
  --dry-run                READ-ONLY / NO-ACTUATION: print routes only
  --max-steps N            supervisor step bound per run (default 200)
  --max-turns N            actor max turns (default 100)
  --actor-arg A            extra arg passed to claude CLI; repeatable
  --reviewer-arg A         extra arg passed to codex CLI; repeatable
  --lane L                 lane id (resume/hold)
  --reason TEXT            reason (hold)`

function parseWorkSpec(spec: string): { issue: number; kind?: LaneKind; dependsOn?: number } {
  const parts = spec.split(':')
  const issue = Number(parts[0])
  if (!Number.isInteger(issue) || issue <= 0) throw new Error(`bad --work spec: ${spec}`)
  const out: { issue: number; kind?: LaneKind; dependsOn?: number } = { issue }
  for (const p of parts.slice(1)) {
    if (p === 'design') out.kind = 'DESIGN'
    else if (p === 'execution') out.kind = 'EXECUTION'
    else if (p.startsWith('after=')) out.dependsOn = Number(p.slice(6))
    else throw new Error(`bad --work spec segment: ${p}`)
  }
  return out
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      pointer: { type: 'string', default: '65' },
      work: { type: 'string', multiple: true, default: [] },
      'state-dir': { type: 'string' },
      'base-branch': { type: 'string', default: 'main' },
      'validation-cmd': { type: 'string' },
      label: { type: 'string', default: 'harness:work' },
      'dry-run': { type: 'boolean', default: false },
      'max-steps': { type: 'string', default: '200' },
      'max-turns': { type: 'string', default: '100' },
      'actor-arg': { type: 'string', multiple: true, default: [] },
      'reviewer-arg': { type: 'string', multiple: true, default: [] },
      lane: { type: 'string' },
      reason: { type: 'string' },
    },
  })
  const cmd = positionals[0]
  if (cmd === undefined || !['run', 'status', 'resume', 'hold', 'reconcile'].includes(cmd)) {
    console.error(USAGE)
    return 2
  }
  if (values.repo === undefined) {
    console.error('--repo is required\n' + USAGE)
    return 2
  }
  const repo = values.repo
  const dryRun = values['dry-run']
  const stateDir = values['state-dir'] ?? join(homedir(), '.cadp-devharness', repo.replace('/', '__'))

  const config: HarnessConfig = {
    repo,
    pointerIssue: Number(values.pointer),
    baseBranch: values['base-branch'],
    stateDir,
    validationCommand: values['validation-cmd'],
    workLabel: values.label,
    actorExtraArgs: values['actor-arg'],
    reviewerExtraArgs: values['reviewer-arg'],
    actorMaxTurns: Number(values['max-turns']),
    retry: { maxProviderRetries: 2, retryAfterCapSeconds: 120, maxRepairRounds: 3 },
    dryRun,
  }

  const store = new Store(stateDir, repo, config.pointerIssue, { ephemeral: dryRun })
  const git = realGitPort(config)
  const sup = new Supervisor({
    config,
    store,
    github: createGitHubAdapter(dryRun),
    actor: createClaudeActorAdapter({ maxTurns: config.actorMaxTurns, extraArgs: config.actorExtraArgs }),
    reviewer: createCodexReviewerAdapter({ extraArgs: config.reviewerExtraArgs }),
    git,
    runValidation: realValidationRunner,
    sleep: (s) => new Promise((r) => setTimeout(r, s * 1000)),
    log: (m) => console.log(m),
  })

  const explicit = values.work.map(parseWorkSpec)

  switch (cmd) {
    case 'run': {
      if (!dryRun) git.ensureBaseClone()
      if (dryRun) console.log('DRY-RUN: read-only, no actuation. GitHub writes are hard-refused by the adapter.')
      const lines = await sup.run(explicit, Number(values['max-steps']))
      console.log('\n=== lanes ===')
      for (const l of lines) console.log(l)
      return 0
    }
    case 'status': {
      for (const l of sup.statusLines()) console.log(l)
      return 0
    }
    case 'reconcile': {
      await sup.reconcile()
      for (const l of sup.statusLines()) console.log(l)
      return 0
    }
    case 'resume':
    case 'hold': {
      const laneId = values.lane ?? positionals[1]
      if (laneId === undefined) { console.error('--lane required'); return 2 }
      const lane = store.getLane(laneId)
      if (lane === undefined) { console.error(`no such lane: ${laneId}`); return 2 }
      const event = cmd === 'resume'
        ? { type: 'HUMAN_RESUME' as const }
        : { type: 'HUMAN_HOLD' as const, reason: values.reason ?? 'operator hold' }
      const decision = decide(lane, event, config.retry)
      lane.status = decision.status
      lane.holdReason = decision.holdReason
      lane.holdProvenance = decision.status === 'HOLD_CAPACITY' || decision.status === 'HOLD_UNKNOWN'
        ? decision.provenance ?? lane.holdProvenance
        : undefined
      if (decision.resetsProviderRetry === true) lane.retryCount = 0
      store.upsertLane(lane)
      store.log({ human: cmd, laneId, note: decision.note })
      console.log(`${laneId}: ${decision.note} -> ${lane.status}`)
      return 0
    }
  }
  return 2
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => { console.error(err); process.exit(1) },
  )
}
