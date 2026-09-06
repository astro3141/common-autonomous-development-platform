/**
 * The explicit bounded timeout hierarchy of the activity-host → surface-broker seam (#128,
 * repairing the failure measured by the #127 self-host pilot).
 *
 * The pilot proved that only PART of this hierarchy was declared. The inner worker budget
 * (900_000) and the activity-host RPC budget (960_000) were explicit, but the transport that
 * carried the RPC was Node's global `fetch` (undici), whose IMPLICIT ~300s headers timeout is
 * shorter than both: three healthy `/implement` attempts died at ~301s with
 * `UND_ERR_HEADERS_TIMEOUT` while their worker containers were still running, and Temporal then
 * retried and exhausted the activity. The Temporal attempt budget (15 minutes) was also *equal
 * to*, not greater than, the inner worker budget — so even without the transport defect an
 * in-bound long run had no margin left for the response.
 *
 * Every load-bearing bound of one broker operation is therefore declared here, finite, and
 * strictly ordered:
 *
 *   surface_ms  <  broker_response_ms  <  rpc_ms  <  activity_attempt_ms
 *
 * with a positive margin at every step:
 *
 *   - `surface_ms`            the inner surface run (worker/verifier/reviewer container). It is
 *                             terminated first, so its existing cleanup runs inside the outer
 *                             bounds. "Terminated" means the CONTAINER is gone, not merely that the
 *                             launching docker CLI was killed — see `SURFACE_TERMINATION_MS`.
 *   - `broker_response_ms`    the broker answers — normally, or with a bounded 504 — before the
 *                             caller's RPC budget expires. Margin = surface kill + cleanup +
 *                             response serialization.
 *   - `rpc_ms`                the activity host's explicit transport budget (response headers AND
 *                             body). No library default may preempt it.
 *   - `activity_attempt_ms`   the Temporal start-to-close budget for one attempt, so a bounded RPC
 *                             failure — not a Temporal timeout — is what the workflow observes.
 *
 * The values are implementation configuration, not architecture authority; the ORDERING is the
 * contract (asserted in cadp/tests/conformance-timeout.test.ts). None of them may be infinite.
 */

/** One long-running broker operation's complete, explicit bound stack. All values are ms. */
export interface SurfaceOperationBudget {
  /** Inner surface run inside the isolated container (bounded-termination deadline). */
  readonly surface_ms: number;
  /** Broker-side bound on answering the request at all (surface run + cleanup + serialization). */
  readonly broker_response_ms: number;
  /** Activity-host transport budget for the whole RPC (headers + body). */
  readonly rpc_ms: number;
  /** Temporal start-to-close budget for one activity attempt. */
  readonly activity_attempt_ms: number;
}

/**
 * The measured #127 boundary: Node's global-fetch/undici implicit response-headers timeout. It is
 * recorded so the conformance controls can assert that every declared bound of a long-running
 * operation is strictly longer than the timeout that used to preempt them.
 */
export const OLD_IMPLICIT_TRANSPORT_HEADERS_TIMEOUT_MS = 300_000;

/** The minimum declared margin between two adjacent layers (cleanup + response serialization). */
export const MIN_LAYER_MARGIN_MS = 30_000;

/**
 * The bound on the TERMINATION step itself, spent inside the `surface_ms → broker_response_ms`
 * margin (`surface_ms + SURFACE_TERMINATION_MS < broker_response_ms`, asserted by the controls).
 *
 * The #127 pilot and the first #128 L4 run both measured why this step needs its own owner and its
 * own bound: `docker run` hands the caller a CLIENT process, not the container. Killing that client
 * detaches from the surface — the over-budget worker container observed in LIVE-3 kept running,
 * with compute and provider egress, after the caller had already been told the attempt failed. So
 * `surface_ms` is only a real bound if, on expiry, the runner force-removes the EXACT container it
 * launched and then OBSERVES that it is gone; this value bounds that stop-and-confirm sequence, so
 * a wedged docker daemon cannot turn the inner bound into an unbounded wait.
 */
export const SURFACE_TERMINATION_MS = 10_000;

/**
 * `/implement`: a worker run over a real work item. #127 measured codex crossing ~301s while
 * healthy, so every layer above the surface already outlived the old implicit boundary.
 *
 * `surface_ms` is a CEILING, not a target: a worker that finishes on its own (codex exits ~301s)
 * is unaffected by a higher ceiling — the bound only caps a run that would otherwise never stop.
 * grok is a slower agentic worker: the 3rd/4th pilots showed it engaging edit tools (once
 * #152 unblocked headless edits) but burning the full 900_000ms ceiling without converging on the
 * multi-file #149 task, so it was TERMINATED before committing a candidate. The ceiling is raised
 * to 1_800_000ms (30m) to cover the slowest SUPPORTED worker (grok), not just codex's measured
 * pace. codex's normal ~301s exit is unchanged. grok's actual convergence time remains UNMEASURED —
 * we only know it exceeds 15m; if 30m still TERMINATES, that is an honest signal grok is not
 * converging on this class of task rather than merely being slow. The four layers keep their
 * MIN_LAYER_MARGIN_MS spacing (30k/30k/60k) so the #128 termination→cleanup→response hierarchy holds.
 */
export const IMPLEMENT_BUDGET: SurfaceOperationBudget = {
  surface_ms: 1_800_000,
  broker_response_ms: 1_830_000,
  rpc_ms: 1_860_000,
  activity_attempt_ms: 1_920_000,
};

/** `/verify`: `node --test` inside the `--network none` verifier container. */
export const VERIFY_BUDGET: SurfaceOperationBudget = {
  surface_ms: 300_000,
  broker_response_ms: 330_000,
  rpc_ms: 360_000,
  activity_attempt_ms: 420_000,
};

/** `/review`: the second-surface reviewer run over the exact committed diff. */
export const REVIEW_BUDGET: SurfaceOperationBudget = {
  surface_ms: 300_000,
  broker_response_ms: 330_000,
  rpc_ms: 360_000,
  activity_attempt_ms: 420_000,
};

/** `/plan`: the proposal-only planner surface reading the checkout (read-only, no authority). */
export const PLAN_BUDGET: SurfaceOperationBudget = {
  surface_ms: 300_000,
  broker_response_ms: 330_000,
  rpc_ms: 360_000,
  activity_attempt_ms: 420_000,
};

/** Every long-running broker operation of the development vertical, by operation name. */
export const SURFACE_BUDGETS = {
  implement: IMPLEMENT_BUDGET,
  verify: VERIFY_BUDGET,
  review: REVIEW_BUDGET,
  plan: PLAN_BUDGET,
} as const;

export type SurfaceOperation = keyof typeof SURFACE_BUDGETS;

/**
 * External verification (#57): the broker read of the GitHub check-runs API is a single quick
 * HTTP call (no container surface), and the POLLING loop lives in the activity — one bounded
 * read per interval until the run completes or the attempt budget ends. Actions queue+run for
 * this repo measures in single-digit minutes; the attempt budget covers that with margin while
 * the heartbeat keeps a dead activity host detectable in ~30s.
 */
export const EXTERNAL_VERIFY = {
  broker_response_ms: 30_000,
  rpc_ms: 60_000,
  poll_interval_ms: 15_000,
  activity_attempt_ms: 660_000,
} as const;

/**
 * Temporal attempt budget for the activities that do NOT cross the broker seam (kernel-only:
 * allocate → seal → evaluate → admit, evidence submission). Unchanged from the pre-repair
 * composition — those activities never wait on a model surface.
 */
export const KERNEL_ACTIVITY_ATTEMPT_MS = 900_000;

/** Heartbeat bound: a killed activity host is detected in ~30s, not at start-to-close (P4). */
export const ACTIVITY_HEARTBEAT_TIMEOUT_MS = 30_000;

/** Interval at which a long broker RPC heartbeats, well inside `ACTIVITY_HEARTBEAT_TIMEOUT_MS`. */
export const BROKER_CALL_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Broker HTTP server bounds. `headers_ms`/`request_ms` bound how long a CLIENT may take to send
 * its request — measured on Node v26: neither one bounds an already-received request whose
 * response is still being produced, so they are safe to keep short and must never be mistaken for
 * the operation bound. `socket_inactivity_ms` is deliberately 0 (disabled): a socket-inactivity
 * timer on this server would kill exactly the healthy long-running responses #127 lost. The finite
 * bound on the server side is `SurfaceOperationBudget.broker_response_ms`, enforced per request.
 */
export const BROKER_SERVER_TIMEOUTS = {
  headers_ms: 60_000,
  request_ms: 120_000,
  keep_alive_ms: 5_000,
  socket_inactivity_ms: 0,
} as const;
