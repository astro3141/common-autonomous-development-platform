import type {
  ActorSignal, Lane, LaneStatus, Outcome, RetryPolicy, ReviewVerdict,
} from './types.ts'

/**
 * Deterministic supervisor transition engine.
 *
 * decide() is a pure function (Lane, Event, RetryPolicy) -> Decision.
 * LLM output never reaches this engine raw: adapters parse worker output into
 * the closed ActorSignal / ReviewVerdict vocabulary; anything unparseable
 * arrives as Outcome UNKNOWN. No LLM output is transition authority.
 */

export type Event =
  | { type: 'ADMIT'; designDependencyMerged: boolean | null } // null = no dependency
  | { type: 'DESIGN_DEP_MERGED' }
  | { type: 'DESIGN_DEP_STILL_UNMERGED' }
  | { type: 'WORKTREE_READY' }
  | { type: 'WORKTREE_CONFLICT'; reason: string }
  | { type: 'ACTOR_RESULT'; outcome: Outcome; actorSignal?: ActorSignal }
  | { type: 'VALIDATION_RESULT'; pass: boolean; detail: string }
  | { type: 'CANDIDATE_FROZEN' }
  | { type: 'REVIEW_RESULT'; outcome: Outcome; verdict?: ReviewVerdict; headShaAtReviewEnd: string }
  | { type: 'CANDIDATE_MUTATED'; observedHeadSha: string }
  | { type: 'OBSERVED_MERGED' }
  | { type: 'OBSERVED_PR_STILL_OPEN' }
  | { type: 'RESTART_OBSERVED' } // lane found in a *_RUNNING status at startup
  | { type: 'HUMAN_RESUME' }
  | { type: 'HUMAN_HOLD'; reason: string }

/**
 * Side effects the supervisor is allowed to route. This vocabulary is closed:
 * there is deliberately NO action that writes implementation files and NO
 * action that merges a PR. (Safety rules 1, 3.)
 */
export type ActionKind =
  | 'CREATE_WORKTREE'
  | 'INVOKE_ACTOR'          // fresh or repair round, same bounded lane
  | 'RUN_VALIDATION'
  | 'FREEZE_CANDIDATE'      // record exact identity, push branch, ensure PR
  | 'INVOKE_REVIEWER'
  | 'INVALIDATE_REVIEWS'
  | 'POST_RECEIPT'
  | 'POST_HOLD_RECEIPT'
  | 'RETRY_AFTER_DELAY'     // bounded, only with an exact provider retry condition
  | 'STOP_LANE_PROCESSING'  // human boundary / hold / blocked: yield this lane

export type Decision = {
  status: LaneStatus
  actions: ActionKind[]
  holdReason?: string
  retryDelaySeconds?: number
  /** increment lane.retryCount (provider retry) */
  countsProviderRetry?: boolean
  /** reset lane.retryCount (step completed) */
  resetsProviderRetry?: boolean
  /** increment lane.attempt (repair round) */
  countsRepairRound?: boolean
  note: string
}

const hold = (status: 'HOLD_CAPACITY' | 'HOLD_UNKNOWN', reason: string): Decision => ({
  status,
  actions: ['POST_HOLD_RECEIPT', 'STOP_LANE_PROCESSING'],
  holdReason: reason,
  note: `durable hold: ${reason}`,
})

/**
 * Shared routing for non-COMPLETE provider outcomes. Identical rules for actor
 * and reviewer; the caller supplies role only for receipts. No provider
 * fallback exists anywhere in this table. (Safety rule 10.)
 */
function routeProviderFailure(
  role: 'actor' | 'reviewer',
  lane: Lane,
  outcome: Outcome,
  policy: RetryPolicy,
): Decision {
  const inj = outcome.faultInjected ? ' [FAULT_INJECTION]' : ''
  switch (outcome.kind) {
    case 'RESOURCE_EXHAUSTED':
      return hold('HOLD_CAPACITY', `${role} RESOURCE_EXHAUSTED${inj}: ${outcome.detail}`)
    case 'AUTH_REQUIRED':
      return hold('HOLD_CAPACITY', `${role} AUTH_REQUIRED${inj}: ${outcome.detail}`)
    case 'RATE_LIMITED': {
      if (
        outcome.retryAfterSeconds !== undefined &&
        lane.retryCount < policy.maxProviderRetries
      ) {
        return {
          status: lane.status, // stay; supervisor re-runs the same step
          actions: ['RETRY_AFTER_DELAY'],
          retryDelaySeconds: Math.min(outcome.retryAfterSeconds, policy.retryAfterCapSeconds),
          countsProviderRetry: true,
          note: `${role} RATE_LIMITED with exact retry_after; bounded retry ${lane.retryCount + 1}/${policy.maxProviderRetries}`,
        }
      }
      const why = outcome.retryAfterSeconds === undefined
        ? 'no authoritative retry condition'
        : 'retry bound exhausted'
      return hold('HOLD_CAPACITY', `${role} RATE_LIMITED (${why})${inj}: ${outcome.detail}`)
    }
    case 'PROVIDER_UNAVAILABLE': {
      if (lane.retryCount < policy.maxProviderRetries) {
        return {
          status: lane.status,
          actions: ['RETRY_AFTER_DELAY'],
          retryDelaySeconds: 10,
          countsProviderRetry: true,
          note: `${role} PROVIDER_UNAVAILABLE; bounded retry ${lane.retryCount + 1}/${policy.maxProviderRetries}`,
        }
      }
      return hold('HOLD_CAPACITY', `${role} PROVIDER_UNAVAILABLE beyond retry bound${inj}: ${outcome.detail}`)
    }
    case 'PROCESS_CRASHED': {
      if (lane.retryCount < policy.maxProviderRetries) {
        return {
          status: lane.status,
          actions: ['RETRY_AFTER_DELAY'],
          retryDelaySeconds: 5,
          countsProviderRetry: true,
          note: `${role} PROCESS_CRASHED; bounded retry ${lane.retryCount + 1}/${policy.maxProviderRetries}`,
        }
      }
      return hold('HOLD_UNKNOWN', `${role} PROCESS_CRASHED beyond retry bound${inj}: ${outcome.detail}`)
    }
    case 'FAILED_WORK':
      if (role === 'actor' && lane.attempt < policy.maxRepairRounds) {
        return {
          status: 'REPAIR_PENDING',
          actions: ['POST_RECEIPT'],
          countsRepairRound: false, // counted when the repair round actually starts
          note: `${role} FAILED_WORK; bounded same-lane repair`,
        }
      }
      return hold('HOLD_UNKNOWN', `${role} FAILED_WORK${role === 'actor' ? ' beyond repair bound' : ''}${inj}: ${outcome.detail}`)
    case 'UNKNOWN':
      return hold('HOLD_UNKNOWN', `${role} UNKNOWN result${inj}: ${outcome.detail}`)
    case 'COMPLETE':
      throw new Error('routeProviderFailure called with COMPLETE')
  }
}

export function decide(lane: Lane, event: Event, policy: RetryPolicy): Decision {
  // Human overrides are valid from any status.
  if (event.type === 'HUMAN_HOLD') {
    return hold('HOLD_CAPACITY', `human hold: ${event.reason}`)
  }
  if (event.type === 'HUMAN_RESUME') {
    if (lane.status === 'HOLD_CAPACITY' || lane.status === 'HOLD_UNKNOWN' || lane.status === 'HUMAN_DIRECTION_WAIT') {
      // Resume at the safest equivalent point: re-validate whatever is in the
      // worktree; validation + freeze + review re-establish every guarantee.
      const status: LaneStatus = lane.worktree === '' ? 'PENDING' : 'VALIDATING'
      return { status, actions: [], resetsProviderRetry: true, note: 'human resume; re-entering via validation' }
    }
    return { status: lane.status, actions: [], note: 'resume ignored; lane not held' }
  }

  switch (lane.status) {
    case 'PENDING':
      if (event.type === 'ADMIT') {
        if (event.designDependencyMerged === false) {
          return {
            status: 'BLOCKED_ON_DESIGN',
            actions: ['POST_RECEIPT', 'STOP_LANE_PROCESSING'],
            note: `execution blocked: design #${lane.dependsOnDesignIssue} not merged`,
          }
        }
        return { status: 'WORKTREE_SETUP', actions: ['CREATE_WORKTREE'], note: 'admitted' }
      }
      break

    case 'BLOCKED_ON_DESIGN':
      if (event.type === 'DESIGN_DEP_MERGED') {
        return { status: 'WORKTREE_SETUP', actions: ['CREATE_WORKTREE'], note: 'design dependency merged; admitting execution' }
      }
      if (event.type === 'DESIGN_DEP_STILL_UNMERGED') {
        return { status: 'BLOCKED_ON_DESIGN', actions: ['STOP_LANE_PROCESSING'], note: 'still blocked on design merge' }
      }
      break

    case 'WORKTREE_SETUP':
      if (event.type === 'WORKTREE_READY') {
        return { status: 'ACTOR_RUNNING', actions: ['INVOKE_ACTOR'], note: 'worktree isolated; invoking worker' }
      }
      if (event.type === 'WORKTREE_CONFLICT') {
        return hold('HOLD_UNKNOWN', `worktree ownership conflict: ${event.reason}`)
      }
      break

    case 'ACTOR_RUNNING':
    case 'ACTOR_INTERRUPTED':
      if (event.type === 'RESTART_OBSERVED') {
        return {
          status: 'ACTOR_INTERRUPTED',
          actions: ['INVOKE_ACTOR'],
          note: 'restart found actor invocation in flight; worktree preserved; re-invoking in same lane',
        }
      }
      if (event.type === 'ACTOR_RESULT') {
        if (event.outcome.kind !== 'COMPLETE') {
          return routeProviderFailure('actor', lane, event.outcome, policy)
        }
        if (event.actorSignal === 'COMPLETE') {
          return { status: 'VALIDATING', actions: ['RUN_VALIDATION'], resetsProviderRetry: true, note: 'actor complete; validating' }
        }
        if (event.actorSignal === 'STOP_DESIGN_REQUIRED') {
          return {
            status: 'HUMAN_DIRECTION_WAIT',
            actions: ['POST_RECEIPT', 'STOP_LANE_PROCESSING'],
            resetsProviderRetry: true,
            note: 'actor reports landed contract insufficient; routing to human direction (missing contract must not be invented)',
          }
        }
        return hold('HOLD_UNKNOWN', 'actor exited cleanly but produced no typed signal; success is not assumed')
      }
      break

    case 'VALIDATING':
      if (event.type === 'VALIDATION_RESULT') {
        if (event.pass) {
          return { status: 'FREEZING', actions: ['FREEZE_CANDIDATE'], note: 'validation passed; freezing exact candidate' }
        }
        if (lane.attempt < policy.maxRepairRounds) {
          return {
            status: 'REPAIR_PENDING',
            actions: ['POST_RECEIPT'],
            note: `validation failed (implementation problem, not design): ${event.detail}`,
          }
        }
        return hold('HOLD_UNKNOWN', `validation failed beyond repair bound: ${event.detail}`)
      }
      break

    case 'FREEZING':
      if (event.type === 'CANDIDATE_FROZEN') {
        return { status: 'REVIEW_RUNNING', actions: ['POST_RECEIPT', 'INVOKE_REVIEWER'], note: 'candidate frozen; invoking independent reviewer' }
      }
      break

    case 'REVIEW_RUNNING':
    case 'REVIEW_INTERRUPTED':
      if (event.type === 'RESTART_OBSERVED') {
        return {
          status: 'REVIEW_INTERRUPTED',
          actions: ['INVOKE_REVIEWER'],
          note: 'restart found review in flight; candidate still frozen; re-invoking reviewer (read-only)',
        }
      }
      if (event.type === 'CANDIDATE_MUTATED') {
        return {
          status: 'VALIDATING',
          actions: ['INVALIDATE_REVIEWS', 'POST_RECEIPT', 'RUN_VALIDATION'],
          note: `candidate mutated (head ${event.observedHeadSha.slice(0, 12)}); prior review authority void; re-validating`,
        }
      }
      if (event.type === 'REVIEW_RESULT') {
        if (event.outcome.kind !== 'COMPLETE') {
          // Candidate remains frozen; actor is NOT re-invoked; no self-review.
          return routeProviderFailure('reviewer', lane, event.outcome, policy)
        }
        if (lane.candidate === undefined || event.headShaAtReviewEnd !== lane.candidate.headSha) {
          return {
            status: 'VALIDATING',
            actions: ['INVALIDATE_REVIEWS', 'POST_RECEIPT', 'RUN_VALIDATION'],
            note: 'head moved during review; verdict does not carry to a new SHA; re-validating',
          }
        }
        if (event.verdict === 'GO') {
          return {
            status: 'HUMAN_MERGE_WAIT',
            actions: ['POST_RECEIPT', 'STOP_LANE_PROCESSING'],
            resetsProviderRetry: true,
            note: 'reviewer GO on exact frozen head; HUMAN_MERGE_READY',
          }
        }
        if (event.verdict === 'REQUEST_CHANGES') {
          if (lane.attempt < policy.maxRepairRounds) {
            return {
              status: 'REPAIR_PENDING',
              actions: ['POST_RECEIPT'],
              resetsProviderRetry: true,
              note: 'REQUEST_CHANGES; routing bounded same-lane repair',
            }
          }
          return hold('HOLD_UNKNOWN', 'REQUEST_CHANGES beyond repair bound; human attention required')
        }
        return hold('HOLD_UNKNOWN', 'reviewer exited cleanly but produced no typed verdict; success is not assumed')
      }
      break

    case 'REPAIR_PENDING':
      // Supervisor tick: start the bounded repair round in the same lane.
      if (event.type === 'WORKTREE_READY') {
        return {
          status: 'ACTOR_RUNNING',
          actions: ['INVOKE_ACTOR'],
          countsRepairRound: true,
          resetsProviderRetry: true,
          note: `repair round ${lane.attempt + 1}/${policy.maxRepairRounds} in same bounded lane`,
        }
      }
      break

    case 'HUMAN_MERGE_WAIT':
      if (event.type === 'OBSERVED_MERGED') {
        return { status: 'MERGED', actions: ['POST_RECEIPT'], note: 'human merged; lane closed; reobserve roadmap' }
      }
      if (event.type === 'OBSERVED_PR_STILL_OPEN') {
        return { status: 'HUMAN_MERGE_WAIT', actions: ['STOP_LANE_PROCESSING'], note: 'waiting on human merge boundary' }
      }
      if (event.type === 'CANDIDATE_MUTATED') {
        return {
          status: 'VALIDATING',
          actions: ['INVALIDATE_REVIEWS', 'POST_RECEIPT', 'RUN_VALIDATION'],
          note: 'candidate mutated after GO; GO does not carry to new SHA; re-validating',
        }
      }
      break

    case 'HUMAN_DIRECTION_WAIT':
    case 'HOLD_CAPACITY':
    case 'HOLD_UNKNOWN':
      // Durable boundaries: only HUMAN_RESUME / HUMAN_HOLD (handled above) exit.
      return { status: lane.status, actions: ['STOP_LANE_PROCESSING'], note: 'at durable boundary' }

    case 'MERGED':
      return { status: 'MERGED', actions: ['STOP_LANE_PROCESSING'], note: 'lane already closed' }
  }

  // Unmodeled (status, event) pair: refuse to guess.
  return hold('HOLD_UNKNOWN', `unmodeled transition: ${lane.status} + ${event.type}`)
}
