import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../store.ts'
import { Supervisor, type GitPort, type SupervisorDeps } from '../supervisor.ts'
import type {
  ActorPort, ActorRequest, ActorResult, GitHubPort, IssueInfo, PrInfo,
  ReviewerPort, ReviewRequest, ReviewResult,
} from '../adapters/types.ts'
import type { HarnessConfig } from '../types.ts'

export const REPO = 'fake/target'

export class FakeGit implements GitPort {
  heads = new Map<string, string>()
  worktrees = new Set<string>()
  pushes: { worktree: string; branch: string; sha: string }[] = []
  changed = new Map<string, string[]>()
  private seq = 0
  baseSha = 'base'.padEnd(40, '0')

  newSha(prefix = 'sha'): string {
    this.seq += 1
    return `${prefix}${this.seq}`.padEnd(40, '0')
  }
  ensureBaseClone(): string { return '/fake/base' }
  resolveRemoteSha(): string { return this.baseSha }
  addWorktree(worktree: string, _branch: string, baseSha: string): void {
    this.worktrees.add(worktree)
    this.heads.set(worktree, baseSha)
  }
  worktreeExists(worktree: string): boolean { return this.worktrees.has(worktree) }
  headSha(worktree: string): string { return this.heads.get(worktree) ?? '' }
  treeSha(worktree: string): string { return `tree-${this.headSha(worktree)}`.slice(0, 40).padEnd(40, '0') }
  checkpointCommit(): void {}
  changedFiles(worktree: string): string[] { return this.changed.get(worktree) ?? ['src/x.ts'] }
  push(worktree: string, branch: string): void {
    this.pushes.push({ worktree, branch, sha: this.headSha(worktree) })
  }
}

export class FakeGitHub implements GitHubPort {
  readOnly = false
  issues = new Map<number, IssueInfo>()
  prs = new Map<number, PrInfo>()
  branchPr = new Map<string, number>()
  comments: { num: number; body: string }[] = []
  writeCalls: string[] = []
  private nextPr = 100

  addIssue(num: number, title: string, body: string, labels: string[] = ['harness:work']): void {
    this.issues.set(num, { number: num, title, body, state: 'open', labels })
  }
  async getIssue(_repo: string, num: number): Promise<IssueInfo> {
    const i = this.issues.get(num)
    if (i === undefined) throw new Error(`no issue #${num}`)
    return i
  }
  async listWorkIssues(_repo: string, label: string): Promise<IssueInfo[]> {
    return [...this.issues.values()].filter((i) => i.state === 'open' && i.labels.includes(label))
  }
  async findPrForBranch(_repo: string, branch: string): Promise<PrInfo | undefined> {
    const n = this.branchPr.get(branch)
    return n === undefined ? undefined : this.prs.get(n)
  }
  async getPr(_repo: string, num: number): Promise<PrInfo> {
    const p = this.prs.get(num)
    if (p === undefined) throw new Error(`no pr #${num}`)
    return p
  }
  async comment(_repo: string, num: number, body: string): Promise<void> {
    if (this.readOnly) throw new Error('dry-run: GitHub write refused (comment)')
    this.writeCalls.push(`comment#${num}`)
    this.comments.push({ num, body })
  }
  async createPr(_repo: string, args: { head: string; base: string; title: string; body: string }): Promise<number> {
    if (this.readOnly) throw new Error('dry-run: GitHub write refused (createPr)')
    this.writeCalls.push(`createPr:${args.head}`)
    this.nextPr += 1
    const pr: PrInfo = {
      number: this.nextPr, headRefName: args.head, headSha: '', baseRefName: args.base,
      merged: false, state: 'open',
    }
    this.prs.set(pr.number, pr)
    this.branchPr.set(args.head, pr.number)
    return pr.number
  }
  /** Test-only: the HUMAN merges. The harness has no path to this. */
  humanMerge(num: number): void {
    const p = this.prs.get(num)
    if (p === undefined) throw new Error(`no pr #${num}`)
    p.merged = true
    p.state = 'merged'
  }
}

export type ScriptedActor = (req: ActorRequest) => ActorResult
export class FakeActor implements ActorPort {
  providerName = 'fake-actor'
  invocations: { taskKind: string; laneId: string; findings?: string[] }[] = []
  script: ScriptedActor[] = []
  git: FakeGit
  constructor(git: FakeGit) { this.git = git }

  /** Default behavior: commit a new SHA and report COMPLETE. */
  defaultBehavior: ScriptedActor = (req) => {
    this.git.heads.set(req.worktree, this.git.newSha('act'))
    return { outcome: { kind: 'COMPLETE', detail: 'done' }, actorSignal: 'COMPLETE' }
  }
  async invoke(req: ActorRequest): Promise<ActorResult> {
    this.invocations.push({ taskKind: req.taskKind, laneId: req.lane.laneId, findings: req.reviewerFindings })
    const fn = this.script.shift() ?? this.defaultBehavior
    return fn(req)
  }
}

export type ScriptedReviewer = (req: ReviewRequest) => ReviewResult
export class FakeReviewer implements ReviewerPort {
  providerName = 'fake-reviewer'
  invocations: { laneId: string; headSha: string }[] = []
  script: ScriptedReviewer[] = []
  defaultBehavior: ScriptedReviewer = () => ({
    outcome: { kind: 'COMPLETE', detail: 'looks good' }, verdict: 'GO', summary: 'ok', findings: [],
  })
  async review(req: ReviewRequest): Promise<ReviewResult> {
    this.invocations.push({ laneId: req.lane.laneId, headSha: req.candidate.headSha })
    const fn = this.script.shift() ?? this.defaultBehavior
    return fn(req)
  }
}

export type World = {
  sup: Supervisor
  store: Store
  git: FakeGit
  github: FakeGitHub
  actor: FakeActor
  reviewer: FakeReviewer
  sleeps: number[]
  cfg: HarnessConfig
  stateDir: string
}

export function makeWorld(overrides: Partial<HarnessConfig> = {}, stateDir?: string): World {
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), 'devharness-test-'))
  const cfg: HarnessConfig = {
    repo: REPO,
    pointerIssue: 1,
    baseBranch: 'main',
    stateDir: dir,
    validationCommand: undefined,
    workLabel: 'harness:work',
    actorExtraArgs: [],
    reviewerExtraArgs: [],
    actorMaxTurns: 10,
    retry: { maxProviderRetries: 2, retryAfterCapSeconds: 120, maxRepairRounds: 3 },
    dryRun: false,
    ...overrides,
  }
  const store = new Store(dir, REPO, 1, { ephemeral: false })
  const git = new FakeGit()
  const github = new FakeGitHub()
  const actor = new FakeActor(git)
  const reviewer = new FakeReviewer()
  const sleeps: number[] = []
  const deps: SupervisorDeps = {
    config: cfg, store, github, actor, reviewer, git,
    runValidation: async () => ({ pass: true, detail: 'fake validation pass' }),
    sleep: async (s) => { sleeps.push(s) },
    log: () => {},
  }
  return { sup: new Supervisor(deps), store, git, github, actor, reviewer, sleeps, cfg, stateDir: dir }
}
