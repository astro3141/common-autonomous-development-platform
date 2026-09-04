import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import * as realGit from './gitops.ts'
import { decide, type Decision, type Event } from './transitions.ts'
import type { Store } from './store.ts'
import type { GitHubPort, ActorPort, ReviewerPort, IssueInfo } from './adapters/types.ts'
import type { HarnessConfig, Lane, LaneKind } from './types.ts'

const pexec = promisify(execFile)

/** Local git port so deterministic tests can fake it. */
export type GitPort = {
  ensureBaseClone(): string
  resolveRemoteSha(branch: string): string
  addWorktree(worktree: string, branch: string, baseSha: string): void
  worktreeExists(worktree: string): boolean
  headSha(worktree: string): string
  treeSha(worktree: string): string
  checkpointCommit(worktree: string, message: string): void
  changedFiles(worktree: string, baseSha: string): string[]
  push(worktree: string, branch: string): void
  /** Ancestor check in the base clone (design-artifact visibility proof). */
  isAncestorInBase(ancestor: string, descendant: string): boolean
}

export function realGitPort(cfg: HarnessConfig): GitPort {
  let base = ''
  return {
    ensureBaseClone: () => (base = realGit.ensureBaseClone(cfg.stateDir, cfg.repo)),
    resolveRemoteSha: (branch) => realGit.resolveRemoteSha(base, branch),
    addWorktree: (w, b, sha) => realGit.addWorktree(base, w, b, sha),
    worktreeExists: realGit.worktreeExists,
    headSha: realGit.headSha,
    treeSha: realGit.treeSha,
    checkpointCommit: realGit.checkpointCommit,
    changedFiles: realGit.changedFiles,
    push: realGit.push,
    isAncestorInBase: (anc, desc) => realGit.isAncestor(base, anc, desc),
  }
}

export type ValidationRunner = (worktree: string, command: string) => Promise<{ pass: boolean; detail: string }>

export const realValidationRunner: ValidationRunner = async (worktree, command) => {
  try {
    await pexec('sh', ['-c', command], { cwd: worktree, maxBuffer: 10 * 1024 * 1024 })
    return { pass: true, detail: `\`${command}\` passed` }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    const tail = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim().slice(-1500)
    return { pass: false, detail: `\`${command}\` failed (exit ${e.code}): ${tail}` }
  }
}

export type SupervisorDeps = {
  config: HarnessConfig
  store: Store
  github: GitHubPort
  actor: ActorPort
  reviewer: ReviewerPort
  git: GitPort
  runValidation: ValidationRunner
  sleep: (seconds: number) => Promise<void>
  log: (msg: string) => void
}

/** Parse harness routing markers from an issue body. Deterministic; no LLM. */
export function classifyIssue(issue: IssueInfo): { kind: LaneKind; dependsOnDesignIssue?: number } {
  const body = issue.body
  const kind: LaneKind =
    /^\s*HARNESS_LANE:\s*DESIGN\s*$/m.test(body) || issue.labels.includes('harness:design')
      ? 'DESIGN'
      : 'EXECUTION'
  const dep = body.match(/^\s*HARNESS_DEPENDS_ON_DESIGN:\s*#?(\d+)\s*$/m)
  return { kind, dependsOnDesignIssue: dep?.[1] !== undefined ? Number(dep[1]) : undefined }
}

export function laneIdFor(kind: LaneKind, issueNumber: number): string {
  return `${kind === 'DESIGN' ? 'design' : 'exec'}-i${issueNumber}`
}

const TERMINALLY_YIELDED: Lane['status'][] = [
  'HUMAN_MERGE_WAIT', 'HUMAN_DIRECTION_WAIT', 'HOLD_CAPACITY', 'HOLD_UNKNOWN', 'MERGED', 'BLOCKED_ON_DESIGN',
]

export class Supervisor {
  readonly d: SupervisorDeps
  constructor(deps: SupervisorDeps) {
    this.d = deps
  }

  private receipt(kind: string, lane: Lane, extra: Record<string, unknown> = {}): string {
    const payload = {
      receipt: kind,
      lane_id: lane.laneId,
      lane_kind: lane.laneKind,
      repo: lane.repo,
      work_issue: lane.workIssue,
      branch: lane.branch,
      base_sha: lane.baseSha,
      current_head_sha: lane.currentHeadSha,
      status: lane.status,
      attempt: lane.attempt,
      ...extra,
    }
    return `devharness receipt: **${kind}**\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
  }

  private async postReceipt(kind: string, lane: Lane, extra: Record<string, unknown> = {}): Promise<void> {
    const body = this.receipt(kind, lane, extra)
    if (this.d.config.dryRun) {
      this.d.log(`[dry-run] would post receipt ${kind} on #${lane.workIssue}`)
      return
    }
    try {
      await this.d.github.comment(lane.repo, lane.workIssue, body)
    } catch (err) {
      // Receipts must not take down the lane; local journal still records it.
      this.d.log(`WARN: receipt post failed: ${String(err)}`)
    }
    this.d.store.log({ receipt: kind, laneId: lane.laneId, ...extra })
  }

  /** Apply an engine decision to a lane: bookkeeping actions + persist. */
  private async apply(lane: Lane, event: Event, decision: Decision): Promise<void> {
    this.d.store.log({
      transition: true, laneId: lane.laneId,
      from: lane.status, event: event.type, to: decision.status, note: decision.note,
    })
    this.d.log(`[${lane.laneId}] ${lane.status} --${event.type}--> ${decision.status} (${decision.note})`)

    if (decision.actions.includes('INVALIDATE_REVIEWS')) {
      for (const r of lane.reviews) {
        if (!r.invalidated) {
          r.invalidated = true
          r.invalidatedReason = decision.note
        }
      }
      lane.reviewedHeadSha = undefined
    }
    if (decision.pendingDirection !== undefined) {
      lane.pendingDirection = { ...decision.pendingDirection, at: new Date().toISOString() }
    } else if (decision.clearsPendingDirection === true) {
      lane.pendingDirection = undefined
    }
    if (decision.countsProviderRetry === true) lane.retryCount += 1
    if (decision.resetsProviderRetry === true) lane.retryCount = 0
    if (decision.countsRepairRound === true) lane.attempt += 1
    lane.holdReason = decision.holdReason
    lane.holdProvenance = decision.status === 'HOLD_CAPACITY' || decision.status === 'HOLD_UNKNOWN'
      ? decision.provenance ?? lane.holdProvenance
      : undefined
    lane.status = decision.status
    this.d.store.upsertLane(lane)

    if (decision.actions.includes('POST_HOLD_RECEIPT')) {
      await this.postReceipt(decision.status, lane, { hold_reason: decision.holdReason })
    } else if (decision.actions.includes('POST_RECEIPT')) {
      const directionExtra = decision.status === 'HUMAN_DIRECTION_WAIT' && lane.pendingDirection !== undefined
        ? {
            actor_signal: lane.pendingDirection.actorSignal,
            direction_summary: lane.pendingDirection.directionSummary,
            source_role: lane.pendingDirection.sourceRole,
            authority: 'WORKER_REPORTED_INFORMATION_ONLY — an Actor/Design-worker report, not Human or Design authority',
          }
        : {}
      await this.postReceipt(decision.status, lane, { note: decision.note, ...directionExtra })
    }
    if (decision.actions.includes('RETRY_AFTER_DELAY') && decision.retryDelaySeconds !== undefined) {
      this.d.log(`[${lane.laneId}] bounded retry in ${decision.retryDelaySeconds}s`)
      await this.d.sleep(decision.retryDelaySeconds)
    }
  }

  private step2(lane: Lane, event: Event): Promise<void> {
    return this.apply(lane, event, decide(lane, event, this.d.config.retry))
  }

  /** Re-read status after step2 mutation (defeats stale switch narrowing). */
  private statusOf(lane: Lane): Lane['status'] {
    return lane.status
  }

  /** Design dependency merge state. merged=null means no dependency. */
  private async designDependency(lane: Lane): Promise<{ merged: boolean | null; mergeCommitSha?: string }> {
    if (lane.dependsOnDesignIssue === undefined) return { merged: null }
    const designLaneId = laneIdFor('DESIGN', lane.dependsOnDesignIssue)
    const local = this.d.store.getLane(designLaneId)
    const branch = local?.branch ?? `harness/${designLaneId}`
    const pr = local?.prNumber !== undefined
      ? await this.d.github.getPr(lane.repo, local.prNumber)
      : await this.d.github.findPrForBranch(lane.repo, branch)
    if (pr?.merged === true) return { merged: true, mergeCommitSha: pr.mergeCommitSha }
    if (local?.status === 'MERGED') return { merged: true }
    return { merged: false }
  }

  /**
   * B1: refresh the lane base to the exact post-design-merge base branch SHA
   * and prove the landed design is contained in it, BEFORE any worktree is
   * created. Returns false (and holds the lane) when the refresh is unsafe.
   */
  private async refreshBaseAfterDesignMerge(lane: Lane, designMergeCommitSha?: string): Promise<boolean> {
    if (this.d.config.dryRun) {
      this.d.log(`[dry-run] [${lane.laneId}] would refresh base to post-design-merge ${lane.baseBranch} and verify the design merge commit is contained`)
      return true
    }
    if (lane.worktree !== '') return true // worktree already exists; base is fixed
    const freshBase = this.d.git.resolveRemoteSha(lane.baseBranch)
    if (designMergeCommitSha !== undefined && !this.d.git.isAncestorInBase(designMergeCommitSha, freshBase)) {
      await this.step2(lane, {
        type: 'BASE_REFRESH_FAILED',
        reason: `design merge commit ${designMergeCommitSha.slice(0, 12)} is not contained in ${lane.baseBranch}@${freshBase.slice(0, 12)}`,
      })
      return false
    }
    if (lane.baseSha !== freshBase) {
      this.d.log(`[${lane.laneId}] base refreshed ${lane.baseSha.slice(0, 12)} -> ${freshBase.slice(0, 12)} (post-design-merge)`)
      lane.baseSha = freshBase
      this.d.store.upsertLane(lane)
    }
    return true
  }

  /**
   * B2: exact review identity must also hold on GitHub, not just in the local
   * worktree. Raises a drift event and returns true when drift was handled.
   */
  private async remoteIdentityDrifted(lane: Lane, expectedHead: string): Promise<boolean> {
    if (lane.prNumber !== undefined) {
      const pr = await this.d.github.getPr(lane.repo, lane.prNumber)
      if (pr.state === 'open' && pr.headSha !== '' && pr.headSha !== expectedHead) {
        await this.step2(lane, { type: 'REMOTE_HEAD_DRIFT', observedRemoteHead: pr.headSha })
        return true
      }
    }
    const baseNow = await this.d.github.getBranchHead(lane.repo, lane.baseBranch)
    if (lane.candidate !== undefined && baseNow !== lane.candidate.baseSha) {
      lane.reviewerFindings = [
        `Base branch ${lane.baseBranch} advanced to ${baseNow} after this candidate was based on ${lane.candidate.baseSha}. ` +
        `Rebase the branch onto the new base (git fetch origin && git rebase ${baseNow}), resolve any conflicts, keep the work intact, rerun validation, and commit.`,
      ]
      lane.baseSha = baseNow
      await this.step2(lane, { type: 'BASE_DRIFT', observedBaseSha: baseNow })
      return true
    }
    return false
  }

  /**
   * Advance one lane by one step. Returns true if the lane yielded (reached a
   * human boundary / hold / blocked state) for this run.
   */
  async step(lane: Lane): Promise<boolean> {
    const cfg = this.d.config
    switch (lane.status) {
      case 'PENDING': {
        const dep = await this.designDependency(lane)
        if (dep.merged === true) {
          // Design already landed at admission time: still take the refresh path.
          const ok = await this.refreshBaseAfterDesignMerge(lane, dep.mergeCommitSha)
          if (!ok) return true
        }
        await this.step2(lane, { type: 'ADMIT', designDependencyMerged: dep.merged })
        return this.statusOf(lane) === 'BLOCKED_ON_DESIGN'
      }

      case 'BLOCKED_ON_DESIGN': {
        const dep = await this.designDependency(lane)
        if (dep.merged !== true) {
          await this.step2(lane, { type: 'DESIGN_DEP_STILL_UNMERGED' })
          return true
        }
        // B1: the dependent execution must build on the Human-landed design.
        const ok = await this.refreshBaseAfterDesignMerge(lane, dep.mergeCommitSha)
        if (!ok) return true
        await this.step2(lane, { type: 'DESIGN_DEP_MERGED' })
        return this.statusOf(lane) === 'BLOCKED_ON_DESIGN'
      }

      case 'WORKTREE_SETUP': {
        if (cfg.dryRun) {
          this.d.log(`[dry-run] [${lane.laneId}] would create worktree ${lane.worktree || '(new)'} branch ${lane.branch} from ${lane.baseSha.slice(0, 12)}`)
          return true
        }
        const worktree = lane.worktree !== '' ? lane.worktree : join(cfg.stateDir, 'worktrees', lane.laneId)
        try {
          this.d.store.claimWorktree(worktree, lane.laneId) // throws if another lane owns it
        } catch (err) {
          await this.step2(lane, { type: 'WORKTREE_CONFLICT', reason: String(err) })
          return true
        }
        if (!this.d.git.worktreeExists(worktree)) {
          this.d.git.addWorktree(worktree, lane.branch, lane.baseSha)
        }
        lane.worktree = worktree
        lane.currentHeadSha = this.d.git.headSha(worktree)
        await this.step2(lane, { type: 'WORKTREE_READY' })
        return false
      }

      case 'REPAIR_PENDING': {
        if (cfg.dryRun) {
          this.d.log(`[dry-run] [${lane.laneId}] would start repair round ${lane.attempt + 1}`)
          return true
        }
        await this.step2(lane, { type: 'WORKTREE_READY' })
        return false
      }

      case 'ACTOR_RUNNING':
      case 'ACTOR_INTERRUPTED': {
        if (cfg.dryRun) {
          this.d.log(`[dry-run] [${lane.laneId}] would invoke ${lane.ownerRole} (${this.d.actor.providerName}) in ${lane.worktree}`)
          return true
        }
        const issue = await this.d.github.getIssue(lane.repo, lane.workIssue)
        const taskKind = lane.status === 'ACTOR_INTERRUPTED'
          ? 'interrupted-resume'
          : (lane.reviewerFindings !== undefined && lane.reviewerFindings.length > 0 ? 'repair' : 'fresh')
        this.d.log(`[${lane.laneId}] invoking ${this.d.actor.providerName} (${taskKind})`)
        const res = await this.d.actor.invoke({
          lane, worktree: lane.worktree, taskKind, issue,
          reviewerFindings: lane.reviewerFindings,
          validationCommand: cfg.validationCommand,
        })
        lane.currentHeadSha = this.d.git.worktreeExists(lane.worktree) ? this.d.git.headSha(lane.worktree) : lane.currentHeadSha
        if (res.outcome.kind === 'COMPLETE') lane.reviewerFindings = undefined
        await this.step2(lane, {
          type: 'ACTOR_RESULT', outcome: res.outcome,
          actorSignal: res.actorSignal, actorSummary: res.summary,
        })
        return TERMINALLY_YIELDED.includes(this.statusOf(lane))
      }

      case 'VALIDATING': {
        if (cfg.dryRun) {
          this.d.log(`[dry-run] [${lane.laneId}] would run validation`)
          return true
        }
        const result = cfg.validationCommand !== undefined
          ? await this.d.runValidation(lane.worktree, cfg.validationCommand)
          : { pass: true, detail: 'no validation command configured' }
        if (!result.pass) lane.reviewerFindings = [`Deterministic validation failed. ${result.detail}`]
        await this.step2(lane, { type: 'VALIDATION_RESULT', pass: result.pass, detail: result.detail })
        return TERMINALLY_YIELDED.includes(this.statusOf(lane))
      }

      case 'FREEZING': {
        if (cfg.dryRun) {
          this.d.log(`[dry-run] [${lane.laneId}] would freeze candidate + push + ensure PR`)
          return true
        }
        this.d.git.checkpointCommit(lane.worktree, `harness: checkpoint worker output for #${lane.workIssue}`)
        const headSha = this.d.git.headSha(lane.worktree)
        if (headSha === lane.baseSha || this.d.git.changedFiles(lane.worktree, lane.baseSha).length === 0) {
          lane.reviewerFindings = [
            'The branch contains no committed work beyond the base SHA. Complete the issue and commit the result on this branch.',
          ]
          await this.step2(lane, { type: 'CANDIDATE_EMPTY' })
          return TERMINALLY_YIELDED.includes(this.statusOf(lane))
        }
        // R2: the candidate identity is only real if the recorded base is
        // actually in the branch history. A worker that skipped a requested
        // rebase is caught here, before any freeze/push/review.
        if (!this.d.git.isAncestorInBase(lane.baseSha, headSha)) {
          lane.reviewerFindings = [
            `Recorded base ${lane.baseSha} is NOT an ancestor of branch HEAD ${headSha} — the requested rebase was not performed or not completed. ` +
            `Run: git fetch origin && git rebase ${lane.baseSha}, resolve conflicts keeping the work intact, rerun validation, and commit.`,
          ]
          await this.step2(lane, { type: 'CANDIDATE_BASE_UNPROVEN' })
          return TERMINALLY_YIELDED.includes(this.statusOf(lane))
        }
        lane.candidate = {
          repo: lane.repo,
          baseSha: lane.baseSha,
          headSha,
          treeSha: this.d.git.treeSha(lane.worktree),
          changedFiles: this.d.git.changedFiles(lane.worktree, lane.baseSha),
          frozenAt: new Date().toISOString(),
        }
        lane.currentHeadSha = headSha
        this.d.git.push(lane.worktree, lane.branch)
        if (lane.prNumber === undefined) {
          const existing = await this.d.github.findPrForBranch(lane.repo, lane.branch)
          lane.prNumber = existing !== undefined
            ? existing.number
            : await this.d.github.createPr(lane.repo, {
                head: lane.branch,
                base: lane.baseBranch,
                title: `[harness ${lane.laneKind.toLowerCase()}] #${lane.workIssue}`,
                body: `Candidate for #${lane.workIssue}. Managed by devharness lane \`${lane.laneId}\`. Human merge only.`,
              })
        }
        this.d.store.upsertLane(lane)
        await this.step2(lane, { type: 'CANDIDATE_FROZEN' })
        await this.postReceipt('CANDIDATE_FROZEN', lane, {
          candidate: lane.candidate, pr: lane.prNumber,
        })
        return false
      }

      case 'REVIEW_RUNNING':
      case 'REVIEW_INTERRUPTED': {
        if (cfg.dryRun) {
          this.d.log(`[dry-run] [${lane.laneId}] would invoke reviewer (${this.d.reviewer.providerName}) on frozen candidate`)
          return true
        }
        const cand = lane.candidate
        if (cand === undefined) {
          await this.step2(lane, { type: 'REVIEW_RESULT', outcome: { kind: 'UNKNOWN', detail: 'no frozen candidate' }, headShaAtReviewEnd: '' })
          return true
        }
        const headBefore = this.d.git.headSha(lane.worktree)
        if (headBefore !== cand.headSha) {
          lane.currentHeadSha = headBefore
          await this.step2(lane, { type: 'CANDIDATE_MUTATED', observedHeadSha: headBefore })
          return false
        }
        // B2: exact identity must also hold remotely before review starts.
        if (await this.remoteIdentityDrifted(lane, cand.headSha)) {
          return TERMINALLY_YIELDED.includes(this.statusOf(lane))
        }
        const issue = await this.d.github.getIssue(lane.repo, lane.workIssue)
        this.d.log(`[${lane.laneId}] invoking ${this.d.reviewer.providerName} on ${cand.headSha.slice(0, 12)}`)
        const res = await this.d.reviewer.review({ lane, worktree: lane.worktree, issue, candidate: cand })
        const headAfter = this.d.git.headSha(lane.worktree)
        lane.currentHeadSha = headAfter
        // B2: re-verify remote identity after review; a verdict for a drifted
        // identity is discarded, never recorded.
        if (res.outcome.kind === 'COMPLETE' && await this.remoteIdentityDrifted(lane, cand.headSha)) {
          return TERMINALLY_YIELDED.includes(this.statusOf(lane))
        }
        if (res.outcome.kind === 'COMPLETE' && res.verdict !== undefined && headAfter === cand.headSha) {
          lane.reviews.push({
            baseSha: cand.baseSha, headSha: cand.headSha,
            verdict: res.verdict, summary: res.summary ?? '',
            findings: res.findings ?? [], invalidated: false,
            at: new Date().toISOString(),
          })
          if (res.verdict === 'GO') lane.reviewedHeadSha = cand.headSha
          if (res.verdict === 'REQUEST_CHANGES') lane.reviewerFindings = res.findings ?? []
          this.d.store.upsertLane(lane)
        }
        await this.step2(lane, {
          type: 'REVIEW_RESULT', outcome: res.outcome, verdict: res.verdict, headShaAtReviewEnd: headAfter,
        })
        if (this.statusOf(lane) === 'HUMAN_MERGE_WAIT') {
          await this.postReceipt('HUMAN_MERGE_READY', lane, {
            reviewed_head_sha: lane.reviewedHeadSha, pr: lane.prNumber, verdict: 'GO',
          })
        } else if (this.statusOf(lane) === 'REPAIR_PENDING') {
          await this.postReceipt('REVIEW_REQUEST_CHANGES', lane, {
            reviewed_head_sha: cand.headSha, findings: res.findings, pr: lane.prNumber,
          })
        }
        return TERMINALLY_YIELDED.includes(this.statusOf(lane))
      }

      case 'HUMAN_MERGE_WAIT': {
        // Detect post-GO mutation first: GO never carries to a new SHA.
        if (!cfg.dryRun && lane.worktree !== '' && this.d.git.worktreeExists(lane.worktree)) {
          const head = this.d.git.headSha(lane.worktree)
          if (lane.reviewedHeadSha !== undefined && head !== lane.reviewedHeadSha) {
            lane.currentHeadSha = head
            await this.step2(lane, { type: 'CANDIDATE_MUTATED', observedHeadSha: head })
            return false
          }
        }
        if (lane.prNumber === undefined) return true
        const pr = await this.d.github.getPr(lane.repo, lane.prNumber)
        if (pr.merged) {
          await this.step2(lane, { type: 'OBSERVED_MERGED' })
          return this.statusOf(lane) !== 'MERGED'
        }
        // B2: a stale GO must not survive remote head or base drift while
        // waiting on the human merge boundary.
        if (!cfg.dryRun && lane.reviewedHeadSha !== undefined) {
          if (await this.remoteIdentityDrifted(lane, lane.reviewedHeadSha)) {
            return TERMINALLY_YIELDED.includes(this.statusOf(lane))
          }
        }
        await this.step2(lane, { type: 'OBSERVED_PR_STILL_OPEN' })
        return this.statusOf(lane) !== 'MERGED'
      }

      case 'HUMAN_DIRECTION_WAIT':
      case 'HOLD_CAPACITY':
      case 'HOLD_UNKNOWN':
      case 'MERGED':
        return true
    }
  }

  /**
   * Restart / startup reconciliation: rebuild a safe picture from the local
   * registry + GitHub without any human state relay.
   */
  async reconcile(): Promise<void> {
    for (const lane of this.d.store.lanes()) {
      if (lane.status === 'ACTOR_RUNNING' || lane.status === 'REVIEW_RUNNING') {
        await this.step2(lane, { type: 'RESTART_OBSERVED' })
        continue
      }
      // Stale lane: mid-flight status but the worktree is gone.
      const needsWorktree: Lane['status'][] = ['ACTOR_INTERRUPTED', 'VALIDATING', 'FREEZING', 'REVIEW_INTERRUPTED', 'REPAIR_PENDING']
      if (needsWorktree.includes(lane.status) && lane.worktree !== '' && !this.d.git.worktreeExists(lane.worktree)) {
        await this.step2(lane, { type: 'HUMAN_HOLD', reason: `stale lane: worktree ${lane.worktree} missing` })
        continue
      }
      // Human may have merged while we were down.
      if (lane.status === 'HUMAN_MERGE_WAIT' && lane.prNumber !== undefined && !this.d.config.dryRun) {
        const pr = await this.d.github.getPr(lane.repo, lane.prNumber)
        if (pr.merged) await this.step2(lane, { type: 'OBSERVED_MERGED' })
      }
    }
  }

  /** Admit new work from GitHub (label-discovered + explicitly requested). */
  async admitWork(explicit: { issue: number; kind?: LaneKind; dependsOn?: number }[]): Promise<Lane[]> {
    const cfg = this.d.config
    const admitted: Lane[] = []
    const discovered = cfg.workLabel !== ''
      ? await this.d.github.listWorkIssues(cfg.repo, cfg.workLabel)
      : []
    const wanted = new Map<number, { kind?: LaneKind; dependsOn?: number }>()
    for (const iss of discovered) wanted.set(iss.number, {})
    for (const e of explicit) wanted.set(e.issue, { kind: e.kind, dependsOn: e.dependsOn })

    for (const [num, hint] of [...wanted.entries()].sort((a, b) => a[0] - b[0])) {
      const issue = await this.d.github.getIssue(cfg.repo, num)
      if (issue.state !== 'open') continue
      const cls = classifyIssue(issue)
      const kind = hint.kind ?? cls.kind
      const dependsOn = hint.dependsOn ?? cls.dependsOnDesignIssue
      const laneId = laneIdFor(kind, num)
      if (this.d.store.getLane(laneId) !== undefined) continue
      const lane: Lane = {
        laneId,
        laneKind: kind,
        repo: cfg.repo,
        workIssue: num,
        dependsOnDesignIssue: dependsOn,
        baseBranch: cfg.baseBranch,
        baseSha: cfg.dryRun ? '(dry-run: unresolved)' : this.d.git.resolveRemoteSha(cfg.baseBranch),
        branch: `harness/${laneId}`,
        worktree: '',
        currentHeadSha: '',
        ownerRole: kind === 'DESIGN' ? 'designer' : 'actor',
        status: 'PENDING',
        reviews: [],
        attempt: 0,
        retryCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      if (!cfg.dryRun) {
        this.d.store.upsertLane(lane)
        await this.postReceipt('LANE_CREATED', lane, {
          depends_on_design: dependsOn ?? null,
          // Disclosure: worker isolation is registry/prompt-level, not a
          // filesystem sandbox, so the exact invocation args stay on record.
          actor_invocation_args: cfg.actorExtraArgs,
        })
      } else {
        this.d.store.state.lanes[laneId] = lane // ephemeral store in dry-run
      }
      admitted.push(lane)
      this.d.log(`[${lane.laneId}] admitted (${kind}${dependsOn !== undefined ? `, after design #${dependsOn}` : ''})`)
    }
    return admitted
  }

  /**
   * Drive all lanes until every lane is at a human boundary / hold, or the
   * cycle bound is hit. Returns a summary line per lane.
   */
  async run(explicitWork: { issue: number; kind?: LaneKind; dependsOn?: number }[], maxSteps = 200): Promise<string[]> {
    await this.reconcile()
    await this.admitWork(explicitWork)
    let steps = 0
    let progress = true
    while (progress && steps < maxSteps) {
      progress = false
      for (const lane of this.d.store.lanes()) {
        if (TERMINALLY_YIELDED.includes(lane.status) && lane.status !== 'BLOCKED_ON_DESIGN' && lane.status !== 'HUMAN_MERGE_WAIT') continue
        // One pass per lane per round; yielded lanes are revisited next round
        // only if some other lane progressed (e.g. design merged unblocks).
        const before = lane.status
        let yielded: boolean
        try {
          yielded = await this.step(lane)
        } catch (err) {
          // Outermost safety net: an unexpected step failure never crashes the
          // run or guesses success — the lane holds durably for a human.
          lane.status = 'HOLD_UNKNOWN'
          lane.holdReason = `supervisor step error: ${String(err).slice(0, 300)}`
          this.d.store.upsertLane(lane)
          this.d.store.log({ stepError: true, laneId: lane.laneId, error: String(err) })
          this.d.log(`[${lane.laneId}] step error -> HOLD_UNKNOWN: ${String(err)}`)
          await this.postReceipt('HOLD_UNKNOWN', lane, { hold_reason: lane.holdReason })
          yielded = true
        }
        steps += 1
        if (!yielded || lane.status !== before) progress = true
        if (steps >= maxSteps) break
      }
      // Second condition: if every lane is yielded at a boundary, stop.
      const allYielded = this.d.store.lanes().every((l) => TERMINALLY_YIELDED.includes(l.status))
      if (allYielded) break
    }
    return this.statusLines()
  }

  statusLines(): string[] {
    return this.d.store.lanes().map((l) =>
      `${l.laneId}  ${l.laneKind}  ${l.status}` +
      `  issue=#${l.workIssue}  branch=${l.branch}` +
      (l.prNumber !== undefined ? `  pr=#${l.prNumber}` : '') +
      (l.candidate !== undefined ? `  frozen=${l.candidate.headSha.slice(0, 12)}` : '') +
      (l.reviewedHeadSha !== undefined ? `  reviewedGO=${l.reviewedHeadSha.slice(0, 12)}` : '') +
      (l.holdReason !== undefined ? `  hold="${l.holdReason.slice(0, 100)}"` : '') +
      (l.pendingDirection !== undefined ? `  direction[${l.pendingDirection.sourceRole}]="${l.pendingDirection.directionSummary.slice(0, 120)}"` : ''),
    )
  }
}
