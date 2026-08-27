/**
 * Supervisor operation identity (TD §6.1, §13.4; M1-15).
 *
 * Identity only — this module constructs op keys and projection keys and does nothing with them.
 *
 *     op:<batch_id>:supervisor-spawn:<n>   the run-level session required before request turn n
 *     op:<batch_id>:supervisor-turn:<n>    request turn n to the authoritative Supervisor session
 *
 * The two are always distinct: a session spawn and a turn are separate external effects with
 * separate crash windows, exactly as M1-8/M1-10 fixed for the Actor and the Auditor. No single
 * operation covers both.
 *
 * The keys being batch-scoped does **not** make the session batch-owned. Its lifetime is
 * run-scoped and its handle is projected at `adapter_metadata(entity_key = run_id)`; MVP 1 has one
 * active batch, so the batch is simply the axis the request ordinal runs along. A later batch that
 * finds a usable run session performs no spawn at all.
 */

/** TD §18.1c — the run's Supervisor session projection. One semantic key, no aliases. */
export const SUPERVISOR_SESSION_METADATA_KEY = "supervisor_session";

export const supervisorSpawnOp = (batchId: string, n: number): string =>
  `op:${batchId}:supervisor-spawn:${n}`;

export const supervisorTurnOp = (batchId: string, n: number): string =>
  `op:${batchId}:supervisor-turn:${n}`;

/** TD §18.1c — the turn handle, projected on the run beside its session. */
export const supervisorTurnMetadataKey = (batchId: string, n: number): string =>
  `supervisor_turn:${batchId}:${n}`;
