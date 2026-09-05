// devharness — bootstrap project-operation tooling for building CADP.
// NOT a CADP Platform Core component. No K1-K7 / PEP / constitutional machinery.

export type LaneKind = 'DESIGN' | 'EXECUTION'

export type LaneStatus =
  | 'PENDING'             // admitted as work, no worktree yet
  | 'BLOCKED_ON_DESIGN'   // dependent design candidate not merged yet
  | 'WORKTREE_SETUP'      // isolated worktree/branch being created
  | 'ACTOR_RUNNING'       // worker invocation in flight (persisted before spawn)
  | 'ACTOR_INTERRUPTED'   // restart found ACTOR_RUNNING; worktree preserved
  | 'VALIDATING'          // deterministic validation of actor output
  | 'FREEZING'            // exact candidate identity being recorded/published
  | 'REVIEW_RUNNING'      // reviewer invocation in flight (persisted before spawn)
  | 'REVIEW_INTERRUPTED'  // restart found REVIEW_RUNNING; candidate still frozen
  | 'REPAIR_PENDING'      // REQUEST_CHANGES received; same-lane bounded repair next
  | 'HUMAN_MERGE_WAIT'    // GO on exact frozen head; human merge boundary
  | 'HUMAN_DIRECTION_WAIT'// genuinely new product direction required
  | 'HOLD_CAPACITY'       // durable hold: resource/rate/auth/provider exhaustion
  | 'HOLD_UNKNOWN'        // durable hold: unclassifiable result; never assume success
  | 'MERGED'              // observed merged on GitHub; lane closed

/** Normalized invocation results. COMPLETE requires parseable typed output. */
export type OutcomeKind =
  | 'COMPLETE'
  | 'FAILED_WORK'
  | 'RESOURCE_EXHAUSTED'
  | 'RATE_LIMITED'
  | 'AUTH_REQUIRED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROCESS_CRASHED'
  | 'UNKNOWN'

export type Outcome = {
  kind: OutcomeKind
  detail: string
  /** Only set when the provider gave an exact retry condition. */
  retryAfterSeconds?: number
  /** True when produced by the labeled FAULT_INJECTION adapter mode. */
  faultInjected?: boolean
}

/** Closed vocabulary parsed from worker structured output. Anything else => UNKNOWN. */
export type ActorSignal = 'COMPLETE' | 'STOP_DESIGN_REQUIRED'
export type ReviewVerdict = 'GO' | 'REQUEST_CHANGES'

/** Exact candidate identity the Reviewer is bound to. */
export type Candidate = {
  repo: string
  baseSha: string
  headSha: string
  treeSha: string
  changedFiles: string[]
  frozenAt: string
}

export type ReviewRecord = {
  baseSha: string
  headSha: string
  verdict: ReviewVerdict
  summary: string
  findings: string[]
  invalidated: boolean
  invalidatedReason?: string
  at: string
}

export type OwnerRole = 'actor' | 'designer'

/**
 * Durable record of a worker's STOP_DESIGN_REQUIRED report. This is
 * worker-REPORTED information only — never Human/Design authority.
 */
export type PendingDirection = {
  actorSignal: 'STOP_DESIGN_REQUIRED'
  directionSummary: string
  sourceRole: OwnerRole
  at: string
}

export type Lane = {
  laneId: string
  laneKind: LaneKind
  repo: string
  workIssue: number
  dependsOnDesignIssue?: number
  baseBranch: string
  baseSha: string
  branch: string
  worktree: string // '' until WORKTREE_SETUP completes
  currentHeadSha: string
  ownerRole: OwnerRole
  status: LaneStatus
  /** Which role's failure produced the current hold; drives resume routing. */
  holdProvenance?: 'actor' | 'reviewer'
  /** Exact worker-reported reason while at HUMAN_DIRECTION_WAIT (worker report, not authority). */
  pendingDirection?: PendingDirection
  candidate?: Candidate
  /**
   * Exact identity of the most recent Reviewer-rejected candidate (REQUEST_CHANGES).
   * Persisted across repair rounds and holds/resumes so a repair that produces
   * a byte-identical head/tree can be detected and never silently re-reviewed
   * (issue #119 H1).
   */
  rejectedCandidate?: Candidate
  reviews: ReviewRecord[]
  reviewedHeadSha?: string
  prNumber?: number
  holdReason?: string
  reviewerFindings?: string[] // pending findings for the next repair round
  /**
   * The findings that drove the repair round which just completed, retained
   * past the point `reviewerFindings` is cleared on Actor COMPLETE so that
   * VALIDATING's reviewer-flagged debris check (H3) can still see which
   * exact files the Reviewer named for removal in that round.
   */
  lastRepairFindings?: string[]
  attempt: number    // repair rounds consumed
  retryCount: number // provider retries consumed within the current step
  createdAt: string
  updatedAt: string
}

export type RetryPolicy = {
  maxProviderRetries: number
  retryAfterCapSeconds: number
  maxRepairRounds: number
}

export type HarnessConfig = {
  repo: string // owner/name
  pointerIssue: number
  baseBranch: string
  stateDir: string
  validationCommand?: string
  workLabel: string
  actorExtraArgs: string[]
  reviewerExtraArgs: string[]
  actorMaxTurns: number
  retry: RetryPolicy
  dryRun: boolean
}
