import type { ActorSignal, Lane, Outcome, ReviewVerdict } from '../types.ts'

/**
 * Thin replaceable adapter boundary. Role composition is fixed by
 * configuration at startup; the supervisor has no code path that substitutes
 * one role's provider for another (safety rule 10: no silent fallback).
 */

export type IssueInfo = {
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
}

export type PrInfo = {
  number: number
  headRefName: string
  headSha: string
  baseRefName: string
  merged: boolean
  state: 'open' | 'closed' | 'merged'
}

/**
 * GitHub port. Deliberately has NO merge capability: human merge is the only
 * merge path (safety rule 1). Write methods must throw in dry-run mode.
 */
export type GitHubPort = {
  getIssue(repo: string, num: number): Promise<IssueInfo>
  listWorkIssues(repo: string, label: string): Promise<IssueInfo[]>
  findPrForBranch(repo: string, branch: string): Promise<PrInfo | undefined>
  getPr(repo: string, num: number): Promise<PrInfo>
  comment(repo: string, issueOrPr: number, body: string): Promise<void>
  createPr(repo: string, args: { head: string; base: string; title: string; body: string }): Promise<number>
  readonly readOnly: boolean
}

export type ActorRequest = {
  lane: Lane
  worktree: string
  taskKind: 'fresh' | 'repair' | 'interrupted-resume'
  issue: IssueInfo
  reviewerFindings?: string[]
  validationCommand?: string
}

export type ActorResult = {
  outcome: Outcome
  actorSignal?: ActorSignal
  summary?: string
}

/** Worker port (Fable). Separate bounded invocation per call; owns file edits. */
export type ActorPort = {
  readonly providerName: string
  invoke(req: ActorRequest): Promise<ActorResult>
}

export type ReviewRequest = {
  lane: Lane
  worktree: string
  issue: IssueInfo
  candidate: { baseSha: string; headSha: string; treeSha: string; changedFiles: string[] }
}

export type ReviewResult = {
  outcome: Outcome
  verdict?: ReviewVerdict
  summary?: string
  findings?: string[]
}

/** Independent reviewer port (Codex). Read-only; never the same invocation as the actor. */
export type ReviewerPort = {
  readonly providerName: string
  review(req: ReviewRequest): Promise<ReviewResult>
}
