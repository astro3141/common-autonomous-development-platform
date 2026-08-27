/**
 * Actor-cycle operation identity (TD §6.1, §19.3, §21; M1-8, M1-15).
 *
 * Identity only — this module constructs op keys and projection keys and does nothing with them.
 *
 * The workspace and the session belong to the Attempt: a rework re-uses both, because what changed
 * is what the Actor is asked to do, not where or as whom. The **turn** is per attempt-turn, and its
 * ordinal comes from durable state alone:
 *
 *     first turn                       rework_count = 0   → actor-turn:1
 *     after REWORK_STARTED commits     rework_count = c+1 → actor-turn:<rework_count + 1>
 *     equivalently, before that commit                    → actor-turn:<old rework_count + 2>
 *
 * So the first rework turn is `actor-turn:2`, never `actor-turn:1`. There is no process-local
 * counter: `attempt.rework_count` is the only source, which is what makes the ordinal identical
 * after a restart.
 */

/** TD §19.3e — the feature workspace, one per Attempt. */
export const actorWorkspaceOp = (attemptKey: string): string => `op:${attemptKey}:workspace`;

/** TD §19.3e — the Actor session, one per Attempt and reused by every rework. */
export const actorSpawnOp = (attemptKey: string): string => `op:${attemptKey}:actor-spawn`;

/** TD §21 — one Actor turn. `n` is derived from `attempt.rework_count`, never from memory. */
export const actorTurnOp = (attemptKey: string, n: number): string =>
  `op:${attemptKey}:actor-turn:${n}`;

/** TD §18.1c — the durable turn projection, per turn for the same reason. */
export const actorTurnMetadataKey = (n: number): string => `actor_turn:${n}`;

/**
 * The turn ordinal for an attempt whose `REWORK_STARTED` has **already committed**. Called with
 * the pre-transition count it would be off by one, which is exactly the mistake this function
 * exists to make impossible.
 */
export const actorTurnOrdinal = (rework_count: number): number => rework_count + 1;
