/**
 * OS-level surface isolation (TD §4.1). Env scrubbing is not a boundary against a same-UID
 * process; untrusted worker/reviewer/verifier code runs inside an enforceable OS + network
 * boundary:
 *
 *  - Filesystem: surfaces run in Docker containers with NO host mount except a fresh /ws
 *    checkout (and, for the worker, a read-only auth.json). The PEP secret dir and manifest
 *    are unreachable.
 *  - Network (egress policy, not DNS pinning): worker and reviewer run on an `--internal`
 *    docker network — no route to the internet at all, so every governed target (GitHub, the
 *    record service, the Kernel API, by name / literal IP / docker gateway) is unreachable.
 *    The ONLY hole is a dual-homed allowlist CONNECT proxy that forwards to the model provider
 *    hosts and refuses everything else. The verifier gets `--network none` (needs nothing).
 *  - Version exactness: the image pins the TD §11 reference surfaces; the built-image digest
 *    and observed tool versions are bound into the reach/WORK_START evidence.
 *  - Lifetime (#128): every surface is CREATED under an unambiguous container identity, acknowledged
 *    before it is considered launched, and run through `runBoundedSurface`, which owns the whole
 *    lifecycle from establishment to termination. An expired bound force-removes that exact
 *    container and OBSERVES that it is gone — killing the docker CLIENT only detaches, which is how
 *    #127's over-budget worker kept running after its caller had already failed.
 *
 * The SAME construction is what CREDENTIAL_REACH_ATTESTATION measures.
 */

import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { SURFACE_BUDGETS, SURFACE_TERMINATION_MS } from "./timeouts.ts";

export interface IsolationConfig {
  /** Pinned surface image (name:tag). */
  readonly worker_image: string;
  /** `--internal` docker network the surfaces run on (no direct internet). */
  readonly egress_network: string;
  /** `host:port` of the allowlist proxy on that network (worker/reviewer HTTPS_PROXY). */
  readonly egress_proxy: string;
}

/**
 * Observed post-condition of the surface itself after a bounded run (#128 T2/T3).
 *
 *  - `EXITED`                   the surface finished on its own, inside its declared bound.
 *  - `TERMINATED`               the bound expired and the exact container was force-removed AND
 *                               observed gone inside `SURFACE_TERMINATION_MS`.
 *  - `TERMINATION_UNCONFIRMED`  the bound expired, termination was requested, but absence could not
 *                               be observed inside `SURFACE_TERMINATION_MS`. Reported, never
 *                               claimed as terminated (requested != observed).
 */
export type SurfaceState = "EXITED" | "TERMINATED" | "TERMINATION_UNCONFIRMED" | "NEVER_CREATED";

/**
 * What the creation step ESTABLISHED about the named container (#128 round-4 F5).
 *
 *  - `CREATED`   the daemon acknowledged creation, so the identity now exists. Every later
 *                observation is meaningful: `ABSENT` can only mean "it existed and is gone".
 *  - `REJECTED`  the create command ran to completion and failed, so no container of this identity
 *                was created and none can appear later. There is nothing to bound.
 *  - `UNKNOWN`   the create command did not complete — killed, un-spawnable, or past its deadline.
 *                The daemon may already have accepted the request, so a container may STILL appear.
 *
 * Without this phase `ABSENT` is overloaded as both "the established surface is gone" and "the
 * surface is not visible yet", and a launcher lost during creation could be reported as a clean exit
 * moments before its container came up.
 */
export type SurfaceCreation = "CREATED" | "REJECTED" | "UNKNOWN";

/**
 * What a control-plane query ESTABLISHED about one container identity (#128 round-2 F1).
 *
 *  - `PRESENT`  the query completed and that exact identity exists (running or merely stopped).
 *  - `ABSENT`   the query completed and that exact identity does not exist.
 *  - `UNKNOWN`  the query did NOT complete — the daemon/socket/context was unavailable, the command
 *               could not be spawned, or its deadline expired. This is the absence of an
 *               observation, not an observation of absence.
 *
 * The distinction is load-bearing: collapsing `UNKNOWN` into `ABSENT` is precisely how a wedged
 * docker daemon would be reported as a clean termination while the surface kept running.
 */
export type SurfaceObservation = "PRESENT" | "ABSENT" | "UNKNOWN";

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The container identity this run owned; the bound applies to THIS, not to the launching CLI. */
  readonly container?: string;
  /** True when the run was terminated at its declared bound instead of exiting on its own. */
  readonly timed_out?: boolean;
  /** What was OBSERVED about the surface afterwards. */
  readonly surface_state?: SurfaceState;
  /**
   * What the creation phase established. Callers use this to tell a surface that failed BEFORE it
   * ever ran from one that failed after — the runner distinguishes them, so reports should too.
   */
  readonly creation?: SurfaceCreation;
  /**
   * False when a command this run started could not be confirmed released before it returned, i.e.
   * the owner may still hold a live docker client (#128 round-9 F8). A clean end is never claimed
   * in that state: `surface_state` is downgraded to `TERMINATION_UNCONFIRMED` alongside it.
   */
  readonly commands_released?: boolean;
}

const PROXY_SCRIPT = fileURLToPath(new URL("../live/egressProxy.mjs", import.meta.url));

// ------------------------------------------------------------------ bounded surface lifecycle

/**
 * The command/container-control port the bounded surface runner owns (#128).
 *
 * `docker run` returns a CLIENT process, not the container: killing it detaches, which is exactly
 * why the pre-repair `surface_ms` did not bound the surface. Every operation here therefore names
 * the container EXPLICITLY, so termination targets the surface itself. Production binds this to the
 * docker CLI; the deterministic controls bind it to a scripted surface, so what they exercise is
 * this runner rather than a copy of it.
 *
 * No method may reject — a rejection would be one more way to lose the distinction between "the
 * surface is gone" and "we could not tell". `observe` carries that distinction explicitly instead.
 */
export interface SurfaceCommandPort {
  /**
   * Create the container by name WITHOUT starting it, and report what that established (#128 F5).
   * `spawn` returning only proves a local CLI process exists; it says nothing about whether the
   * daemon has created the named object whose lifetime this owner claims to bound. Splitting
   * creation out is what gives the owner an acknowledgement to reason from.
   */
  create(container: string, args: readonly string[]): SurfaceCommand<CreationOutcome>;
  /**
   * Start the already-created container, attached. What this owns is the CLIENT, not the surface —
   * and it is a command like any other, so the owner can end it and know that it ended (#128 A5).
   */
  launch(container: string): SurfaceCommand<CommandOutput>;
  /**
   * Request force-removal of that exact container. Resolves `true` when the removal command itself
   * completed successfully. A `false` here is NOT evidence either way (removing an already-absent
   * container fails too) — only `observe` establishes the postcondition.
   */
  terminate(container: string): SurfaceCommand<boolean>;
  /** Observe whether that exact identity exists. `UNKNOWN` when the observation could not be made. */
  observe(container: string): SurfaceCommand<SurfaceObservation>;
}

/**
 * One control-plane command in flight (#128 round-6 F7/A5).
 *
 * A bare Promise cannot be bounded: racing it with a timer stops the CALLER waiting, but the docker
 * CLI child it stands for keeps running, so the owner can return while a `create` is still able to
 * publish the container, or while `rm`/`ps` clients accumulate across Temporal retries. Owning the
 * command means owning its lifetime, so every command carries the means to actually stop it.
 *
 * Sending a signal is not the same as the process being gone, so cancellation has its own COMPLETION
 * (#128 round-7 F7): `closed` resolves only once the command's child has actually been reaped. The
 * owner awaits it, which is what makes "when `settle` resolves, no command it started is still
 * alive" a fact about the implementation rather than an intention in a comment.
 *
 * `cancel` must be idempotent. Nothing here may reject — losing the difference between "the surface
 * is gone" and "we could not tell" is the failure this whole module exists to prevent.
 */
export interface SurfaceCommand<T> {
  readonly result: Promise<T>;
  /** Resolves when this command owns no live process — immediately for one that owns none. */
  readonly closed: Promise<void>;
  cancel(): void;
}

/**
 * What a creation command answered: the established phase, plus whatever the command itself said.
 * The detail is the underlying docker message (an unreachable daemon, an unknown image), kept
 * separate from the phase so a report can state the phase once and quote the cause.
 */
export interface CreationOutcome {
  readonly creation: SurfaceCreation;
  readonly detail: string;
}

export interface SurfaceRunOptions {
  /** Override the container-control port (deterministic controls only). */
  readonly port?: SurfaceCommandPort;
  /** Override the stop-and-confirm bound (deterministic controls only). */
  readonly termination_ms?: number;
}

/** Container identities are unique per run, so termination can never target someone else's surface. */
const CONTAINER_PREFIX = "cadp-surface-";

/** How often absence is re-observed while the termination bound is still open. */
const SURVIVAL_POLL_MS = 100;

/**
 * Budget reserved inside a reconciliation window for its final best-effort removal, so that sweep is
 * a real command with time to run rather than one launched at an already-expired deadline (#128 F7).
 */
const FINAL_SWEEP_MS = 1_000;

/**
 * Slice reserved inside any command's window so cancellation can be COMPLETED — signal sent AND the
 * child reaped — before the window ends rather than after it (#128 round-7 F7).
 */
const CANCEL_MS = 250;

const DEADLINE = Symbol("deadline");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Append a lifecycle note to whatever the surface itself managed to say, on its own line. */
const note = (stderr: string, line: string): string =>
  `${stderr}${stderr.length === 0 || stderr.endsWith("\n") ? "" : "\n"}${line}`;

/** Resolve `work`, or DEADLINE at `at`. A probe that rejected is not a confirmation, so it is DEADLINE too. */
function within<T>(work: Promise<T>, at: number): Promise<T | typeof DEADLINE> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(DEADLINE), Math.max(0, at - Date.now()));
    const settle = (value: T | typeof DEADLINE): void => { clearTimeout(timer); resolve(value); };
    work.then(settle, () => settle(DEADLINE));
  });
}

/**
 * Run one control-plane command under a deadline that ENDS it (#128 round-6 F7).
 *
 * `within` alone only stops the caller waiting; the command would keep running, and an abandoned
 * `docker create` can still publish its container after the owner has returned. So a command that
 * misses its deadline is cancelled AND reaped: when this resolves, the owner holds no live command.
 * Sending SIGKILL and returning would not establish that — the signal is asynchronous — so the
 * cancellation slice is RESERVED ahead of `at` rather than taken from beyond it, and the answer
 * deadline is pulled in to pay for it. A command is never STARTED past its deadline either:
 * dispatching one only to cancel it immediately would be theatre.
 */
async function settle<T>(
  port: SurfaceCommandPort,
  start: (port: SurfaceCommandPort) => SurfaceCommand<T>,
  at: number,
  ledger: CommandLedger,
): Promise<T | typeof DEADLINE> {
  if (Date.now() >= at) return DEADLINE;
  const command = start(port);
  const outcome = await within(command.result, at - reserveFor(at));
  // An ANSWER is not a released process. `error` settles `result` while the child is still alive, so
  // the answer is not handed back until the command has been ended and its closure OBSERVED — under
  // the same deadline, and whether or not it answered (#128 round-9 F8). For a command that closed
  // normally this costs nothing: `cancel` is a no-op and `closed` has already resolved.
  //
  // And an answer whose command could NOT be released is not authoritative either (#128 round-10):
  // the client that produced it is still running, so treating its `ABSENT` as proof of absence would
  // let a live command license exactly the clean ending this owner exists to withhold.
  if (!record(ledger, command, await stop(command, at))) return DEADLINE;
  return outcome;
}

/**
 * Which commands a run started have NOT been confirmed released (#128 round-9 F8, round-10 F8).
 *
 * A single shared boolean could not carry this: confirming one command's closure would clear a
 * failure recorded for a DIFFERENT one, so a closed launcher could erase a live `observe` client and
 * the run would report itself clean. The ledger therefore holds the outstanding commands themselves,
 * so a later confirmation can only ever clear the command it actually observed.
 *
 * An owner that still holds a live docker client cannot claim a clean end: that client may yet
 * publish a container, mutate the daemon, or simply accumulate across Temporal retries.
 */
interface CommandLedger { readonly outstanding: Set<SurfaceCommand<unknown>> }

/** True only when every command this run started was confirmed closed. */
const releasedAll = (ledger: CommandLedger): boolean => ledger.outstanding.size === 0;

/** Record ONE command's release outcome. Only that command's own closure may clear it. */
function record(ledger: CommandLedger, command: SurfaceCommand<unknown>, released: boolean): boolean {
  if (released) ledger.outstanding.delete(command);
  else ledger.outstanding.add(command);
  return released;
}

/**
 * The state this run may CLAIM. An owner that still holds a live command has not established a clean
 * end — that client can yet publish a container or mutate the daemon — so anything it would have
 * called settled becomes `TERMINATION_UNCONFIRMED`. `NEVER_CREATED` is the one exception worth
 * keeping only when nothing leaked, since an unreleased create client is exactly what might still
 * create something (#128 round-9 F8).
 */
function reported(state: SurfaceState, ledger: CommandLedger): SurfaceState {
  return releasedAll(ledger) ? state : "TERMINATION_UNCONFIRMED";
}

/** The slice of a window held back so cancellation can COMPLETE inside it, never beyond it. */
function reserveFor(at: number): number {
  return Math.min(CANCEL_MS, Math.max(1, Math.floor((at - Date.now()) / 2)));
}

/**
 * Cancel a command and wait for it to be REAPED, bounded by `at`. Reaping is observed through
 * `closed`, which is bound to authoritative process closure alone — never to an `error`, since Node
 * emits that when a process could not be KILLED, i.e. exactly when it is still alive (#128 F8).
 *
 * A child that cannot be reaped even after SIGKILL is beyond anything this process can do, so the
 * bound still wins — that is the only way past here, it never becomes an unbounded wait, and the
 * caller is told the outcome is unconfirmed rather than clean.
 */
async function stop(command: SurfaceCommand<unknown>, at: number): Promise<boolean> {
  command.cancel();
  return (await within(command.closed, at)) !== DEADLINE;
}

/**
 * The exact `docker` argv that CREATES one bounded surface, without starting it. `--name` is what
 * makes the container addressable by the SAME identity the termination step uses; without it the
 * runner would hold only a client handle again. `create` is separate from `start` so that the
 * daemon's acknowledgement is observable: once this exits 0 the identity exists, and once it exits
 * non-zero no container of this identity was made (#128 round-4 F5).
 */
export function dockerCreateArgv(container: string, args: readonly string[]): string[] {
  return ["create", "--rm", "--init", "--name", container, ...args];
}

/** Start the created container attached, so the client streams its output and returns its status. */
export function dockerStartArgv(container: string): string[] {
  return ["start", "--attach", container];
}

/**
 * The exact `docker` argv that OBSERVES one container identity. `docker ps --all` succeeds (exit 0)
 * whether or not anything matches, so its exit status reports whether the DAEMON answered while its
 * output reports what exists — which is what makes absence distinguishable from "could not ask".
 * `docker container inspect` cannot do this: it exits non-zero both for "no such container" and for
 * an unreachable daemon, so reading its failure as absence is unsound.
 */
export function dockerObserveArgv(container: string): string[] {
  return ["ps", "--all", "--no-trunc", "--filter", `name=^${container}$`, "--format", "{{.Names}}"];
}

/**
 * Map one completed `dockerObserveArgv` run to an observation (#128 round-2 F1).
 *
 * ONLY a successful query is evidence. A non-zero exit (daemon/socket/context unavailable) or a
 * failure to spawn at all means the observation never happened — `UNKNOWN`, never `ABSENT`. When
 * the query did succeed, any matching name is `PRESENT`; only genuinely empty output is `ABSENT`.
 * Every ambiguous case resolves AWAY from absence, because absence is what licenses `TERMINATED`.
 */
export function observationOf(status: number | null, stdout: string): SurfaceObservation {
  if (status !== 0) return "UNKNOWN";
  return stdout.split("\n").some((line) => line.trim().length > 0) ? "PRESENT" : "ABSENT";
}

/**
 * Run one docker CLI command as a CANCELLABLE command (#128 round-6 F7). A command that was
 * signalled or could not be spawned has status `null` — it did not complete, so it established
 * nothing, which is exactly what `creationOf`/`observationOf` map to UNKNOWN.
 *
 * `cancel` SIGKILLs the CLI child, so abandoning a command really ends it rather than leaving a
 * client alive to mutate the daemon (or accumulate) after the owner has returned.
 */
export function dockerCommand(args: readonly string[]): SurfaceCommand<CommandOutput> {
  return commandOf(spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] }));
}

/** What one CLI command said: its own exit, its output, and whether it got there of its own accord. */
export interface CommandOutput {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the child reached a normal exit rather than being signalled or failing to spawn. */
  readonly completed: boolean;
}

/**
 * Wrap a spawned child as a cancellable command. `closed` resolves only once the child has actually
 * been reaped, so cancellation has an observable COMPLETION and not merely a signal (#128 round-7).
 */
export function commandOf(child: ChildProcess): SurfaceCommand<CommandOutput> {
  // `closed` is bound to `close` ALONE (#128 round-8 F8). Node's `error` is not a termination event:
  // it is also emitted when a process could NOT be killed, and `exit` may or may not follow. Letting
  // it resolve `closed` would mean a failed SIGKILL reads as "the child is reaped" — the one reading
  // that must never be possible, since it is precisely when the child IS still alive. `close`, by
  // contrast, is emitted only after the process has ended and its stdio has closed, and it does
  // follow a spawn failure (measured on Node v26.6.0: a failed spawn emits `error` then `close`), so
  // the no-process case still converges here.
  let reaped = (): void => {};
  const closed = new Promise<void>((resolve) => { reaped = resolve; });
  child.on("close", () => { reaped(); });
  const result = new Promise<CommandOutput>((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    child.on("close", (status, signal) => resolve({
      status: signal === null ? status : null,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
      completed: signal === null && status !== null,
    }));
    // An error says the command produced no ANSWER. It says nothing about whether the process is
    // gone, so it settles `result` only and never `closed`.
    child.on("error", () => resolve({ status: null, stdout: "", stderr: "", completed: false }));
  });
  return {
    result,
    closed,
    cancel() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); },
  };
}

/** Adapt a command's completion into a port answer, keeping its cancel/closed channels intact. */
function mapCommand<T>(command: SurfaceCommand<CommandOutput>, map: (r: CommandOutput) => T): SurfaceCommand<T> {
  return { result: command.result.then(map), closed: command.closed, cancel: () => { command.cancel(); } };
}

/**
 * A completed create is an acknowledgement either way; only a create that never finished leaves the
 * question open. `status === null` means the command was signalled or could not be spawned.
 */
export function creationOf(status: number | null): SurfaceCreation {
  if (status === null) return "UNKNOWN";
  return status === 0 ? "CREATED" : "REJECTED";
}

export const DOCKER_SURFACE_PORT: SurfaceCommandPort = {
  create: (container, args) =>
    mapCommand(dockerCommand(dockerCreateArgv(container, args)), (r) => ({ creation: creationOf(r.status), detail: r.stderr.trim() })),
  launch: (container) => commandOf(spawn("docker", dockerStartArgv(container), { stdio: ["ignore", "pipe", "pipe"] })),
  terminate: (container) => mapCommand(dockerCommand(["rm", "--force", "--volumes", container]), (r) => r.status === 0),
  observe: (container) => mapCommand(dockerCommand(dockerObserveArgv(container)), (r) => observationOf(r.status, r.stdout)),
};

/**
 * Stop the exact container and keep observing until its absence is ESTABLISHED or the termination
 * bound expires.
 *
 * `TERMINATED` is returned only for an affirmative `ABSENT` observation (#128 round-2 F1). A
 * `PRESENT`, an `UNKNOWN`, or an observation that could not finish inside the bound all keep
 * polling and, at the deadline, resolve as `TERMINATION_UNCONFIRMED` — so "the daemon stopped
 * answering" can never be reported as "the surface is gone".
 */
async function terminateSurface(port: SurfaceCommandPort, container: string, at: number, ledger: CommandLedger): Promise<SurfaceState> {
  for (;;) {
    await settle(port, (p) => p.terminate(container), at, ledger);
    const observed = await settle(port, (p) => p.observe(container), at, ledger);
    if (observed === "ABSENT") return "TERMINATED";
    if (Date.now() >= at) return "TERMINATION_UNCONFIRMED";
    await sleep(Math.min(SURVIVAL_POLL_MS, at - Date.now()));
  }
}

/**
 * The launcher settled inside the declared bound WITHOUT unambiguously reporting the surface's own
 * exit (#128 round-3 F4). `launch` returns the docker CLIENT, and T4-0 shows client and surface have
 * different lifetimes: a client that is killed, that loses its daemon connection, or that never
 * started says nothing about the container — and once it is gone, nothing is left to enforce
 * `surface_ms`. So the container's fate is established here rather than assumed:
 *
 *   - already `ABSENT`  the surface really did end on its own            → `EXITED`
 *   - `PRESENT`         it OUTLIVED its launcher; stop it and confirm    → `TERMINATED` / unconfirmed
 *   - `UNKNOWN`         we cannot say it ended, so we do not claim it did → stop-and-confirm
 *
 * Bounded by the same `termination_ms` the timeout path uses, so the outer hierarchy is unaffected.
 */
async function settleOrphanedSurface(port: SurfaceCommandPort, container: string, at: number, ledger: CommandLedger): Promise<SurfaceState> {
  const observed = await settle(port, (p) => p.observe(container), at, ledger);
  if (observed === "ABSENT") return "EXITED";
  return terminateSurface(port, container, at, ledger);
}

/**
 * Creation was never acknowledged, so the daemon may or may not have accepted it (#128 round-4 F5).
 * An empty query here is NOT evidence: it can equally mean "nothing was created" or "the create is
 * still in flight and the container is about to appear". Reporting that as a clean exit is how a
 * launcher lost during creation would leak a container that came up moments later.
 *
 * So keep force-removing the exact identity and re-observing for the whole bounded window, which
 * catches a container that appears late, and then answer honestly:
 *
 *   - a surface DID appear and was then confirmed gone  → `TERMINATED`
 *   - only ever absent                                   → `TERMINATION_UNCONFIRMED`, because we
 *                                                          cannot establish that no late surface can
 *                                                          still appear
 */
async function reconcileUnacknowledgedCreation(port: SurfaceCommandPort, container: string, at: number, ledger: CommandLedger): Promise<SurfaceState> {
  // Hold a real slice of the window back for the final sweep. Launching that removal AT an expired
  // deadline would be theatre: `settle` would refuse to start it, or start it only to cancel it
  // immediately (#128 round-6 F7). A sweep only means something if it has budget to run in.
  const sweep = Math.min(FINAL_SWEEP_MS, Math.max(1, Math.floor((at - Date.now()) / 2)));
  const watchUntil = at - sweep;
  let appeared = false;
  for (;;) {
    // OBSERVE before removing. Removal is synchronous against a real daemon, so a terminate-first
    // loop would delete a late container without ever having seen it and could then only report
    // "unconfirmed" — safe, but weaker than what actually happened.
    const observed = await settle(port, (p) => p.observe(container), watchUntil, ledger);
    if (observed === "PRESENT") {
      appeared = true;
      await settle(port, (p) => p.terminate(container), watchUntil, ledger);
    } else if (observed === "ABSENT" && appeared) {
      return "TERMINATED"; // it did appear, and is now confirmed gone
    }
    if (Date.now() >= watchUntil) break;
    await sleep(Math.min(SURVIVAL_POLL_MS, watchUntil - Date.now()));
  }
  // One last removal on the way out: we are about to stop looking, so leave nothing behind that
  // appeared at the very end of the window. It runs inside the slice reserved above, and like every
  // other command here it is CANCELLED rather than abandoned if it overruns — a wedged control plane
  // may neither turn this bound into an unbounded wait (#128 round-5 F6) nor leave a live client
  // behind after the owner has returned (#128 round-6 F7).
  await settle(port, (p) => p.terminate(container), at, ledger);
  return "TERMINATION_UNCONFIRMED";
}

/**
 * Run ONE surface container under its declared bound, owning its whole lifecycle (#128 T2/T3).
 *
 * The postcondition of an expired bound is not "we killed a process handle" but "this exact
 * container has been force-removed and observed gone" — otherwise `surface_ms` bounds only the
 * caller's view while the model keeps burning compute and provider egress (measured in #127, and
 * again in the first #128 LIVE-3). Termination is itself bounded by `termination_ms`, which the
 * hierarchy reserves inside the surface → broker-response margin, so the broker still answers, the
 * workspace cleanup still runs, and the outer RPC/attempt bounds are still met.
 *
 * The run has two phases. Creation is ESTABLISHED first (#128 round-4 F5): until the daemon has
 * acknowledged the named container, an empty observation cannot be distinguished from "not visible
 * yet", so a launcher lost during creation could otherwise be reported as a clean exit moments
 * before its container came up. An unacknowledged creation is reconciled boundedly and never
 * reported as an exit.
 *
 * Once established, the bound is enforced on BOTH ways out. When the timer expires the container is
 * force-removed and confirmed gone; when the LAUNCHER settles first that is only an established
 * surface exit if the attached client completed normally with 0 — otherwise the client has gone away
 * without saying anything about the container, leaving nothing to enforce `surface_ms`, so the same
 * stop-and-confirm path runs (#128 round-3 F4).
 *
 * A run whose surface had to be stopped is always a FAILURE: `status` is never 0, so no caller can
 * read a bounded timeout — or an orphaned surface — as a surface success.
 */
export async function runBoundedSurface(
  input: { kind: string; args: readonly string[]; timeout_ms: number },
  options: SurfaceRunOptions = {},
): Promise<RunResult> {
  const port = options.port ?? DOCKER_SURFACE_PORT;
  const termination_ms = options.termination_ms ?? SURFACE_TERMINATION_MS;
  for (const [name, value] of [["surface", input.timeout_ms], ["termination", termination_ms]] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} bound must be finite and positive (got ${String(value)})`);
  }

  const container = `${CONTAINER_PREFIX}${input.kind}-${randomUUID()}`;
  const ledger: CommandLedger = { outstanding: new Set<SurfaceCommand<unknown>>() };

  // Phase 1 — establish the surface before claiming to bound it (#128 round-4 F5). Until the daemon
  // has acknowledged creation, an empty observation cannot be told apart from "not visible yet", so
  // the owner has nothing sound to reason from.
  // A create that did not answer inside its own deadline established nothing, which is UNKNOWN — the
  // same answer the adapter gives for a create that could not run at all.
  const acknowledged = await settle(port, (p) => p.create(container, input.args), Date.now() + termination_ms, ledger);
  const creation: SurfaceCreation = acknowledged === DEADLINE ? "UNKNOWN" : acknowledged.creation;
  // `stderr` carries the underlying command's own detail; the PHASE is carried structurally in
  // `creation`/`surface_state`, so a report states it once instead of echoing a synthesized sentence.
  const detail = acknowledged === DEADLINE ? "" : acknowledged.detail;
  if (creation !== "CREATED") {
    if (creation === "REJECTED") {
      // The create ran to completion and failed: no container of this identity exists and none can
      // appear. There is no surface to bound, and saying so is honest.
      return { status: null, stdout: "", stderr: detail, container, timed_out: false, surface_state: reported("NEVER_CREATED", ledger), creation, commands_released: releasedAll(ledger) };
    }
    const surface_state = await reconcileUnacknowledgedCreation(port, container, Date.now() + termination_ms, ledger);
    return { status: null, stdout: "", stderr: detail, container, timed_out: false, surface_state: reported(surface_state, ledger), creation, commands_released: releasedAll(ledger) };
  }

  // Phase 2 — the identity now exists, so every later observation is meaningful and the declared
  // bound is a bound on something real.
  const launcher = port.launch(container);

  const finished = await within(launcher.result, Date.now() + input.timeout_ms);
  if (finished !== DEADLINE) {
    // An attached `docker run` that reached a normal exit of 0 DID report the container's own exit,
    // and `--rm` took it away with it: that is an established surface exit, and it stays the cheap
    // hot path. Every other settle — a nonzero docker/container status, a killed client, a client
    // that never started — is the launcher going away WITHOUT establishing the surface's fate, and
    // is exactly the ownership mismatch this owner exists to close (#128 round-3 F4).
    if (finished.completed && finished.status === 0) {
      // `completed` is only ever set from a real `close`, so the launcher is already reaped here.
      return { status: 0, stdout: finished.stdout, stderr: finished.stderr, container, timed_out: false, surface_state: "EXITED", creation };
    }
    const at = Date.now() + termination_ms;
    // The launcher produced an ANSWER, which is not the same as its process being gone — an `error`
    // settles the answer while the child may still be alive (#128 round-8 F8). END it FIRST, with its
    // own reserved slice, so container reconciliation cannot consume the whole window and leave the
    // teardown nothing to run in (#128 round-9 F8). On the ordinary path `cancel` is a no-op and
    // `closed` has already resolved, so this costs nothing.
    const launcherReleased = record(ledger, launcher, await stop(launcher, Date.now() + reserveFor(at)));
    const settled = await settleOrphanedSurface(port, container, at, ledger);
    // Give the launcher whatever budget is left, but attribute the result to the LAUNCHER ALONE —
    // observing that it closed says nothing about any other command (#128 round-10 F8).
    if (!launcherReleased) record(ledger, launcher, (await within(launcher.closed, at)) !== DEADLINE);
    const state = reported(settled, ledger);
    const orphaned = state !== "EXITED";
    return {
      // A surface that outlived its launcher is never a success, whatever the client reported.
      status: orphaned && finished.status === 0 ? null : finished.status,
      stdout: finished.stdout,
      stderr: orphaned ? note(finished.stderr, `surface ${container} outlived its launcher; termination ${state}`) : finished.stderr,
      container,
      timed_out: false,
      surface_state: state,
      creation,
      commands_released: releasedAll(ledger),
    };
  }

  // Over budget. End the launcher FIRST — it is a command this owner holds, not the surface, and
  // `A5` is that it must be ended and REAPED like any other rather than merely signalled. Then
  // terminate the surface by its own identity and confirm, all inside one shared deadline.
  const at = Date.now() + termination_ms;
  const launcherReleased = record(ledger, launcher, await stop(launcher, Date.now() + reserveFor(at)));
  const [surface_state, partial] = await Promise.all([
    terminateSurface(port, container, at, ledger),
    within(launcher.result, at), // whatever the surface managed to say before the bound
  ]);
  // The launcher answering is not the launcher being GONE, and a fast container removal must not let
  // this return while the client we started is still alive (#128 round-8 F8). Spend whatever budget
  // is left waiting for its real closure — and if it never comes, say so rather than reporting a
  // tidy TERMINATED over a launcher that is still running (#128 round-9 F8).
  if (!launcherReleased) record(ledger, launcher, (await within(launcher.closed, at)) !== DEADLINE);
  const state = reported(surface_state, ledger);
  const observed = partial === DEADLINE ? { status: null, stdout: "", stderr: "" } : partial;
  return {
    status: observed.status === 0 ? null : observed.status,
    stdout: observed.stdout,
    stderr: note(observed.stderr, `surface ${container} exceeded its declared bound of ${input.timeout_ms}ms; termination ${state}`),
    container,
    timed_out: true,
    surface_state: state,
    creation,
    commands_released: releasedAll(ledger),
  };
}

const PROXY_ENV = (proxy: string): string[] => [
  "-e", `HTTPS_PROXY=http://${proxy}`,
  "-e", `HTTP_PROXY=http://${proxy}`,
  "-e", `https_proxy=http://${proxy}`,
  "-e", `http_proxy=http://${proxy}`,
];

/**
 * Worker container: host fs invisible (only /ws + ro auth.json); on the internal network with
 * provider-only egress via the proxy. Governed targets have no route.
 */
export function runWorker(
  config: IsolationConfig,
  input: {
    workspace: string;
    /** @deprecated Compatibility spelling for the codex profile. */
    codexAuthDir?: string;
    workerAuthDir?: string;
    authSubdir?: string;
    authFiles?: readonly string[];
    sessionsDir?: string;
    argv: readonly string[];
    timeout_ms?: number;
  },
  options: SurfaceRunOptions = {},
): Promise<RunResult> {
  const authDir = input.workerAuthDir ?? input.codexAuthDir;
  if (authDir === undefined) throw new Error("worker auth directory missing");
  const authSubdir = input.authSubdir ?? ".codex";
  const authFiles = input.authFiles ?? ["auth.json"];
  const authMounts = authFiles.flatMap((file) => ["-v", `${authDir}/${file}:/root/${authSubdir}/${file}:ro`]);
  const sessionsMount = input.sessionsDir !== undefined ? ["-v", `${input.sessionsDir}:/root/${authSubdir}/sessions`] : [];
  return runBoundedSurface({
    kind: "worker",
    args: [
      "--network", config.egress_network,
      ...PROXY_ENV(config.egress_proxy),
      "-v", `${input.workspace}:/ws`,
      ...authMounts,
      ...sessionsMount,
      "-w", "/ws",
      config.worker_image,
      ...input.argv,
    ],
    timeout_ms: input.timeout_ms ?? SURFACE_BUDGETS.implement.surface_ms,
  }, options);
}

/**
 * Verifier container: `--network none`, host fs invisible except the checkout mount. The
 * candidate's own (untrusted) test process has no secrets and no reachability whatsoever.
 */
export function runVerifier(
  config: IsolationConfig,
  input: { workspace: string; argv: readonly string[]; timeout_ms?: number },
  options: SurfaceRunOptions = {},
): Promise<RunResult> {
  return runBoundedSurface({
    kind: "verifier",
    args: [
      "--network", "none",
      "-v", `${input.workspace}:/ws`,
      "-w", "/ws",
      config.worker_image,
      ...input.argv,
    ],
    timeout_ms: input.timeout_ms ?? SURFACE_BUDGETS.verify.surface_ms,
  }, options);
}

/**
 * Reviewer container: host fs invisible (only a ro checkout); on the internal network with
 * provider-only egress via the proxy → GitHub/record/Kernel are unreachable (http-000). The
 * model OAuth token is injected by env (operator-extracted), so no keychain/host credential is
 * reachable.
 */
export function runReviewer(
  config: IsolationConfig,
  input: { workspace: string; providerToken: string; argv: readonly string[]; timeout_ms?: number },
  options: SurfaceRunOptions = {},
): Promise<RunResult> {
  return runBoundedSurface({
    kind: "reviewer",
    args: [
      "--network", config.egress_network,
      ...PROXY_ENV(config.egress_proxy),
      "-v", `${input.workspace}:/ws:ro`,
      "-e", "HOME=/root",
      "-e", `CLAUDE_CODE_OAUTH_TOKEN=${input.providerToken}`,
      "-w", "/ws",
      config.worker_image,
      ...input.argv,
    ],
    timeout_ms: input.timeout_ms ?? SURFACE_BUDGETS.review.surface_ms,
  }, options);
}

/** Extract the Claude Code provider OAuth token (operator action; the surface never sees the keychain). */
export function claudeProviderToken(): string {
  const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 5000 });
  return (JSON.parse(raw) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken;
}

export function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["info"], { stdio: "ignore" });
    child.on("close", (status) => resolve(status === 0));
    child.on("error", () => resolve(false));
  });
}

// ------------------------------------------------------------------ egress network lifecycle

export interface EgressBoundary {
  readonly network: string;
  readonly proxy: string; // host:port on the internal network
  teardown(): void;
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
}

/**
 * Create the surface egress boundary (TD §4.1): an `--internal` network (no internet) plus a
 * dual-homed allowlist proxy that forwards only to `allowHosts`. Idempotent per name.
 */
export function createEgressBoundary(name: string, allowHosts: readonly string[]): EgressBoundary {
  const internal = `${name}-int`;
  const external = `${name}-ext`;
  const proxyName = `${name}-proxy`;
  for (const [net, extra] of [[internal, ["--internal"]], [external, []]] as const) {
    try { docker(["network", "create", ...extra, net]); } catch { /* exists */ }
  }
  try { docker(["rm", "-f", proxyName]); } catch { /* absent */ }
  docker([
    "run", "-d", "--name", proxyName, "--network", internal,
    "-v", `${PROXY_SCRIPT}:/egressProxy.mjs:ro`,
    "-e", `ALLOW_HOSTS=${allowHosts.join(",")}`,
    "node:22-bookworm-slim", "node", "/egressProxy.mjs",
  ]);
  docker(["network", "connect", external, proxyName]);
  return {
    network: internal,
    proxy: `${proxyName}:8888`,
    teardown() {
      try { docker(["rm", "-f", proxyName]); } catch { /* gone */ }
      for (const net of [internal, external]) {
        try { docker(["network", "rm", net]); } catch { /* gone */ }
      }
    },
  };
}

/** Built-image identity for the reach/WORK_START evidence (TD §11 version exactness). */
export function imageIdentity(image: string): { image: string; image_digest: string; tool_versions: Record<string, string> } {
  const image_digest = docker(["image", "inspect", image, "--format", "{{.Id}}"]);
  const versions = docker([
    "run", "--rm", "--network", "none", image,
    "sh", "-c", "printf 'codex-cli=%s\\nclaude=%s\\ngrok=%s\\n' \"$(codex --version)\" \"$(claude --version)\" \"$(grok --version 2>/dev/null || echo absent)\"",
  ]);
  const tool_versions: Record<string, string> = {};
  for (const line of versions.split("\n")) {
    const [k, v] = line.split("=");
    if (k && v) tool_versions[k.trim()] = v.trim();
  }
  return { image, image_digest, tool_versions };
}
