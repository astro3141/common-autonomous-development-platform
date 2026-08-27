/**
 * Audit-cycle operation identity (TD §6.1, §16.1, §16.3; M1-10, M1-13).
 *
 * Identity only — this module constructs op keys and projection keys and does nothing with them.
 * It performs no side effect, reads no store and names no backend primitive.
 *
 * The split is the whole point. An Auditor *session* belongs to the Attempt: a rework does not
 * invalidate who is reviewing, only what they are reviewing, so one `audit-spawn` serves the whole
 * Attempt. Everything that judges a candidate belongs to that candidate:
 *
 *     op:<attempt_key>:audit-spawn                      one Auditor session per Attempt
 *     op:<attempt_key>:auditor-turn-1:<candidate_sha>   this candidate's review turn
 *     op:<attempt_key>:auditor-turn-2:<candidate_sha>   its one permitted structured-result retry
 *     op:<attempt_key>:audit-decision:<candidate_sha>   this candidate's audit decision
 *
 * Without the qualifier, an Attempt that goes `FIX_REQUIRED → REWORKING → … → AUDITING` again
 * would find the previous cycle's operations already `DONE` and silently skip its own. The
 * candidate SHA is a §6.1 qualifier — a single segment with no `:` — which is exactly what the
 * grammar reserves them for. No audit-cycle counter and no audit-cycle table exists.
 */

/** One Auditor session for the Attempt, reused by every later cycle of that Attempt. */
export const auditSpawnOp = (attemptKey: string): string => `op:${attemptKey}:audit-spawn`;

/** TD §16.1 — this candidate's initial Auditor review turn. */
export const auditorTurn1Op = (attemptKey: string, candidate: string): string =>
  `op:${attemptKey}:auditor-turn-1:${candidate}`;

/**
 * TD §16.2 — the one and only structured-verdict retry for *this* candidate. There is no third
 * turn for a candidate; a later candidate is a different cycle with its own pair.
 */
export const auditorTurn2Op = (attemptKey: string, candidate: string): string =>
  `op:${attemptKey}:auditor-turn-2:${candidate}`;

/** TD §16.3 — the audit decision for this candidate. */
export const auditDecisionOp = (attemptKey: string, candidate: string): string =>
  `op:${attemptKey}:audit-decision:${candidate}`;

/** TD §18.1c — the durable turn projection, per candidate and per turn for the same reason. */
export const auditorTurnMetadataKey = (candidate: string, turn: 1 | 2 = 1): string =>
  `auditor_turn-${turn}:${candidate}`;
