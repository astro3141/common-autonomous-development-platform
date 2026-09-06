/**
 * #128 — the activity-host → surface-broker timeout hierarchy (repairing the failure measured by
 * the #127 self-host pilot, `issuecomment-5552903334`).
 *
 * The pilot's three `implementCandidate` attempts died at ~301s with `UND_ERR_HEADERS_TIMEOUT`
 * while their worker containers were still running: the declared budgets (900_000 worker /
 * 960_000 RPC) were both longer than an IMPLICIT ~300s response-headers timeout carried by the
 * transport (Node's global `fetch`/undici), and the Temporal attempt budget was *equal to* the
 * inner worker budget instead of above the RPC. Temporal then retried the healthy operation.
 *
 * Controls:
 *   T1  the declared hierarchy exists, is finite, strictly ordered with a positive margin, and
 *       every bound above the surface run is longer than the old implicit ~300s boundary;
 *   T2  an over-budget or failed RPC fails boundedly and can never become a value — no candidate,
 *       no partial body, no stale/late response;
 *   T3  the ordering lets the inner surface terminate (and clean up) before the broker answers,
 *       and lets the broker answer before the caller's RPC budget expires;
 *   T4  the inner bound really bounds the SURFACE. `docker run` hands the runner a client process,
 *       not the container: the first #128 L4 run measured the over-budget worker container still
 *       running after the caller had been told the attempt failed. The bounded lifecycle owner
 *       (`runBoundedSurface`) must force-remove the exact container and OBSERVE it gone, inside the
 *       outer bounds, with no result ever becoming a candidate — and, because a control plane that
 *       cannot answer is not a control plane that answered "gone", only an AFFIRMATIVE absence may
 *       establish that postcondition (T4-3b/T4-3c). The bound must also survive the launcher going
 *       away first (T4-3d/e/f), and CREATION must be established before any of this means anything —
 *       until the daemon acknowledges the name, "not visible" and "gone" are the same query
 *       result (T4-3g/h/i). Finally, a deadline must end the COMMAND and not merely the wait: an
 *       abandoned docker client can still create, observe or remove afterwards (T4-3h2/h3/h4).
 *
 * Guard bites — removing a control reintroduces a measured failure class:
 *   - drop the explicit RPC bound  → "an unresponsive broker" and "a stalled response body" hang
 *     instead of failing at their declared budget;
 *   - go back to global `fetch`    → "the seam does not run on the implicit-timeout transport"
 *     fails, and with it the ~300s hidden headers timeout is back;
 *   - go back to killing only the launching client (the pre-repair `collect`) → T4-1, T4-3, T4-5
 *     and T4-6 all fail, because T4-0 first proves the scripted surface OUTLIVES its client exactly
 *     as the real container did;
 *   - go back to reading a failed container query as absence → T4-3b and T4-3c fail, and with them
 *     a wedged docker daemon is once again reported as a clean termination;
 *   - go back to treating any launcher settle as an authoritative surface exit → T4-3d and T4-3e
 *     fail, and a surface whose docker client died early outlives its bound with no owner left;
 *   - go back to treating an unacknowledged creation as established → T4-3g, T4-3h and T4-3i fail,
 *     and a container that becomes visible just after the launcher died is leaked;
 *   - let ANY command in the owner escape its deadline (a raw `await port.terminate(...)`) → T4-3h2
 *     never completes at all: the runner hangs exactly where it claims to be giving up, so the broker
 *     never reaches its workspace cleanup and outer 504s pile up unresolved work;
 *   - abandon a command instead of CANCELLING it at its deadline → T4-3h4 fails and the test runner
 *     itself cannot exit, because the commands the owner walked away from are still alive;
 *   - send the signal but not wait for the reap (`cancel()` without awaiting `closed`) → T4-3h4
 *     fails: a command is still alive at the instant the owner hands control back;
 *   - take the launcher back out of the command abstraction (raw kill, no reap) → T4-3h5 fails,
 *     because the owner starts touching the container while its own client is still running;
 *   - let a ChildProcess `error` resolve `closed` → T4-3h8 fails: Node emits `error` when a process
 *     could not be KILLED, so that reading turns a failed kill into "the child is reaped";
 *   - wait for an errored launcher's closure without CANCELLING it → T4-3h6 fails, because nothing
 *     ever ends the client that answered with an error;
 *   - hand back a command's ANSWER without first releasing it → T4-3h9 and T4-3j0 fail: a result can
 *     arrive while the child is still alive, so the run proceeds (or returns) still owning it;
 *   - report the container's state without regard to whether every command was released → T4-3j0
 *     fails, because a confirmed-gone container would read as a clean stop while our own client runs;
 *   - let one command's closure clear the run-wide release fact → T4-3j1 fails: a closed launcher
 *     erases the failure recorded for a live `observe` client and hides it from the operator;
 *   - consume an answer whose command could not be released → T4-3j2 fails, because a create client
 *     that is still running gets believed when it promises no container can ever appear.
 *
 * These controls own the seam deterministically and always run. The same bound against a REAL
 * docker container is an explicit live probe — `node cadp/live/surfaceLifetimeProbe.ts` — which
 * FAILS rather than skips when docker or the pinned image is missing, so it is deliberately not
 * part of this always-run suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brokerPostJson, BrokerRpcTimeoutError } from "../product/brokerTransport.ts";
import { commandOf, creationOf, dockerCreateArgv, dockerObserveArgv, dockerStartArgv, observationOf, runBoundedSurface, runReviewer, runVerifier, runWorker } from "../product/isolation.ts";
import type { CommandOutput, CreationOutcome, IsolationConfig, SurfaceCommand, SurfaceCommandPort, SurfaceObservation } from "../product/isolation.ts";
import { BROKER_OPERATIONS, startBroker, surfaceFailure as brokerSurfaceFailure } from "../product/surfaceBroker.ts";
import type { BrokerOperation } from "../product/surfaceBroker.ts";
import { SURFACE_ACTIVITY_OPTIONS } from "../product/workflows.ts";
import {
  ACTIVITY_HEARTBEAT_TIMEOUT_MS,
  BROKER_SERVER_TIMEOUTS,
  MIN_LAYER_MARGIN_MS,
  OLD_IMPLICIT_TRANSPORT_HEADERS_TIMEOUT_MS,
  SURFACE_BUDGETS,
  SURFACE_TERMINATION_MS,
} from "../product/timeouts.ts";

const OPERATIONS = Object.entries(SURFACE_BUDGETS);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RunningServer { url: string; server: Server; close: () => Promise<void> }

async function listen(server: Server): Promise<RunningServer> {
  if (!server.listening) await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A raw HTTP server whose response timing is scripted — the transport's counterparty. */
async function scriptedTransportServer(respond: (end: (status: number, body: string) => void) => void): Promise<RunningServer> {
  const server = createServer((req, res) => {
    req.on("data", () => { /* drain */ });
    req.on("end", () => {
      respond((status, body) => {
        if (res.writableEnded) return;
        res.writeHead(status, { "content-type": "application/json" }).end(body);
      });
    });
  });
  server.listen(0, "127.0.0.1");
  return listen(server);
}

/** The EXACT production broker server construction, with a scripted operation table. */
async function scriptedBroker(operations: Record<string, BrokerOperation>): Promise<RunningServer> {
  return listen(startBroker(0, operations));
}

// ------------------------------------------------------------------ T1: the declared hierarchy

test("#128 T1-1: every surface operation declares a finite, strictly ordered bound stack", () => {
  assert.ok(OPERATIONS.length >= 3, "the development vertical's /implement, /verify and /review are all declared");
  for (const [operation, budget] of OPERATIONS) {
    const layers = [
      ["surface_ms", budget.surface_ms],
      ["broker_response_ms", budget.broker_response_ms],
      ["rpc_ms", budget.rpc_ms],
      ["activity_attempt_ms", budget.activity_attempt_ms],
    ] as const;
    for (const [name, value] of layers) {
      assert.ok(Number.isFinite(value) && Number.isInteger(value) && value > 0, `${operation}.${name} must be a finite positive ms value (got ${String(value)})`);
    }
    for (let i = 1; i < layers.length; i += 1) {
      const [innerName, inner] = layers[i - 1]!;
      const [outerName, outer] = layers[i]!;
      assert.ok(outer > inner, `${operation}: ${outerName} (${outer}) must be strictly greater than ${innerName} (${inner})`);
      assert.ok(
        outer - inner >= MIN_LAYER_MARGIN_MS,
        `${operation}: the ${innerName}→${outerName} margin (${outer - inner}ms) must leave at least ${MIN_LAYER_MARGIN_MS}ms for termination, cleanup and response serialization`,
      );
    }
  }
});

test("#128 T1-2: every bound above the surface run outlives the old implicit ~300s transport boundary", () => {
  for (const [operation, budget] of OPERATIONS) {
    for (const [name, value] of [
      ["broker_response_ms", budget.broker_response_ms],
      ["rpc_ms", budget.rpc_ms],
      ["activity_attempt_ms", budget.activity_attempt_ms],
    ] as const) {
      assert.ok(
        value - OLD_IMPLICIT_TRANSPORT_HEADERS_TIMEOUT_MS >= MIN_LAYER_MARGIN_MS,
        `${operation}.${name} (${value}) must exceed the measured #127 implicit headers timeout (${OLD_IMPLICIT_TRANSPORT_HEADERS_TIMEOUT_MS}) by a real margin`,
      );
    }
  }
  // The operation #127 actually measured crossing ~301s while healthy: even its INNER surface run
  // is allowed to outlive the old boundary threefold.
  assert.ok(SURFACE_BUDGETS.implement.surface_ms > OLD_IMPLICIT_TRANSPORT_HEADERS_TIMEOUT_MS);
});

test("#128 T1-3: the workflow proxies each surface activity with its own attempt budget, above that operation's RPC budget", () => {
  const wiring = [
    ["implementCandidate", SURFACE_ACTIVITY_OPTIONS.implementCandidate, SURFACE_BUDGETS.implement],
    ["verifyCandidate", SURFACE_ACTIVITY_OPTIONS.verifyCandidate, SURFACE_BUDGETS.verify],
    ["reviewCandidate", SURFACE_ACTIVITY_OPTIONS.reviewCandidate, SURFACE_BUDGETS.review],
  ] as const;
  for (const [activity, options, budget] of wiring) {
    assert.equal(options.startToCloseTimeout, budget.activity_attempt_ms, `${activity} must run under its own operation's attempt budget`);
    assert.ok(
      (options.startToCloseTimeout as number) > budget.rpc_ms,
      `${activity}: a bounded RPC failure — not a Temporal start-to-close timeout — must be what the workflow observes`,
    );
    assert.equal(options.heartbeatTimeout, ACTIVITY_HEARTBEAT_TIMEOUT_MS);
    assert.ok(
      ACTIVITY_HEARTBEAT_TIMEOUT_MS < budget.rpc_ms,
      "a killed activity host is still detected by heartbeat long before the RPC budget",
    );
    assert.equal(options.retry?.maximumAttempts, 3, "retry discipline is unchanged by this repair");
  }
});

test("#128 T1-4: the production broker operation table declares each response budget between the surface and RPC bounds", () => {
  const wiring = [
    ["/implement", SURFACE_BUDGETS.implement],
    ["/verify", SURFACE_BUDGETS.verify],
    ["/review", SURFACE_BUDGETS.review],
    ["/plan", SURFACE_BUDGETS.plan],
  ] as const;
  assert.deepEqual(Object.keys(BROKER_OPERATIONS).sort(), wiring.map(([p]) => p).sort(), "the broker exposes exactly the declared operations");
  for (const [path, budget] of wiring) {
    const operation = BROKER_OPERATIONS[path]!;
    assert.equal(operation.response_budget_ms, budget.broker_response_ms);
    assert.ok(operation.response_budget_ms > budget.surface_ms, `${path}: the inner surface run is killed and cleaned up before the broker answers`);
    assert.ok(operation.response_budget_ms < budget.rpc_ms, `${path}: the broker answers before the caller's RPC budget expires`);
  }
});

test("#128 T1-5: stopping the surface and confirming it is gone is reserved inside the surface→broker margin", () => {
  assert.ok(
    Number.isFinite(SURFACE_TERMINATION_MS) && SURFACE_TERMINATION_MS > 0,
    "terminating the container is itself a bounded step — a wedged daemon may not turn the inner bound into an unbounded wait",
  );
  assert.ok(SURFACE_TERMINATION_MS < MIN_LAYER_MARGIN_MS, "termination must fit inside the declared inter-layer margin");
  for (const [operation, budget] of OPERATIONS) {
    assert.ok(
      budget.surface_ms + SURFACE_TERMINATION_MS < budget.broker_response_ms,
      `${operation}: the container must be force-removed and OBSERVED gone before the broker answers (${budget.surface_ms}+${SURFACE_TERMINATION_MS} vs ${budget.broker_response_ms})`,
    );
  }
});

// ------------------------------------------------------------------ T2/T3: the explicit transport

test("#128 T2-1: a response inside the declared RPC budget succeeds", async () => {
  const server = await scriptedTransportServer((end) => { setTimeout(() => end(200, JSON.stringify({ candidate_sha: "abc123" })), 150); });
  try {
    const started = Date.now();
    const result = await brokerPostJson<{ candidate_sha: string }>(server.url, "/implement", { work_item: "x" }, { rpc_ms: 5_000 });
    assert.equal(result.candidate_sha, "abc123");
    assert.ok(Date.now() - started >= 100, "the caller really waited for the surface run");
  } finally { await server.close(); }
});

test("#128 T2-2: an unresponsive broker fails at the declared budget — bounded, with no value", async () => {
  // GUARD BITE: this is the control that the explicit transport bound carries. Delete the bound
  // and this request waits forever instead of failing at 300ms.
  const server = await scriptedTransportServer(() => { /* headers are never sent */ });
  try {
    const started = Date.now();
    const failure = await brokerPostJson(server.url, "/implement", {}, { rpc_ms: 300 }).then(
      (value) => ({ resolved: value }),
      (error: unknown) => ({ error }),
    );
    const elapsed = Date.now() - started;
    assert.ok(!("resolved" in failure), "a response that never arrived must never become a value");
    const error = (failure as { error: unknown }).error;
    assert.ok(error instanceof BrokerRpcTimeoutError, `expected a bounded RPC timeout, got ${String(error)}`);
    assert.equal(error.phase, "RESPONSE_HEADERS", "this is exactly the #127 failure class, now under an explicit bound");
    assert.equal(error.budget_ms, 300);
    assert.ok(elapsed >= 250 && elapsed < 5_000, `the failure must land at the declared bound (elapsed ${elapsed}ms)`);
  } finally { await server.close(); }
});

test("#128 T2-3: a response that stalls after its headers is bounded too, and no partial body is returned", async () => {
  const server = createServer((req, res) => {
    req.on("data", () => { /* drain */ });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"candidate_sha":"partia'); // headers + half a body, then silence
    });
  });
  server.listen(0, "127.0.0.1");
  const running = await listen(server);
  try {
    const error = await brokerPostJson(running.url, "/implement", {}, { rpc_ms: 300 }).then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof BrokerRpcTimeoutError, `expected a bounded RPC timeout, got ${String(error)}`);
    assert.equal(error.phase, "RESPONSE_BODY");
  } finally { await running.close(); }
});

test("#128 T2-4: a broker error status or unparseable body is a failure, never a fabricated result", async () => {
  const failing = await scriptedTransportServer((end) => end(500, JSON.stringify({ error: "worker container exited 137" })));
  try {
    await assert.rejects(
      brokerPostJson(failing.url, "/implement", {}, { rpc_ms: 2_000 }),
      /broker \/implement 500: .*worker container exited 137/u,
    );
  } finally { await failing.close(); }

  const garbled = await scriptedTransportServer((end) => end(200, "candidate_sha=abc"));
  try {
    await assert.rejects(brokerPostJson(garbled.url, "/implement", {}, { rpc_ms: 2_000 }), /unparseable JSON/u);
  } finally { await garbled.close(); }
});

test("#128 T2-5: an unbounded RPC budget is refused — the repair is a finite bound, not an infinite one", async () => {
  const server = await scriptedTransportServer((end) => end(200, "{}"));
  try {
    for (const rpc_ms of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
      await assert.rejects(
        brokerPostJson(server.url, "/implement", {}, { rpc_ms }),
        /RPC budget must be finite and positive/u,
        `rpc_ms=${String(rpc_ms)} must be refused`,
      );
    }
  } finally { await server.close(); }
});

test("#128 T3-1: the seam does not run on the implicit-timeout global fetch transport", async (t) => {
  // GUARD BITE: undici's implicit ~300s response-headers timeout is a property of global fetch. A
  // seam that goes back to it fails here — and would fail again at ~301s in production.
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (() => {
    throw new Error("the broker seam must not use global fetch: undici applies an implicit ~300s response-headers timeout (#127)");
  }) as typeof globalThis.fetch;

  const server = await scriptedTransportServer((end) => { setTimeout(() => end(200, JSON.stringify({ ok: true })), 50); });
  try {
    assert.deepEqual(await brokerPostJson(server.url, "/verify", {}, { rpc_ms: 5_000 }), { ok: true });
  } finally { await server.close(); }

  // …and the activity host itself carries no other fetch-based path to the broker.
  const source = readFileSync(new URL("../product/activities.ts", import.meta.url), "utf8");
  assert.ok(!/\bfetch\s*\(/u.test(source), "the activity host must not call global fetch at all");
  assert.match(source, /brokerPostJson/u, "the activity host's broker seam is the explicit-timeout transport");
});

// ------------------------------------------------------------------ T2/T3: the broker server

test("#128 T3-2: the broker server declares its bounds, and its request-receipt bounds never kill a long response", async () => {
  const responseMs = 250;
  const running = await scriptedBroker({
    "/slow": { response_budget_ms: 5_000, run: async () => { await sleep(responseMs); return { ok: true }; } },
  });
  try {
    assert.equal(running.server.headersTimeout, BROKER_SERVER_TIMEOUTS.headers_ms);
    assert.equal(running.server.requestTimeout, BROKER_SERVER_TIMEOUTS.request_ms);
    assert.equal(running.server.keepAliveTimeout, BROKER_SERVER_TIMEOUTS.keep_alive_ms);
    assert.equal(running.server.timeout, BROKER_SERVER_TIMEOUTS.socket_inactivity_ms);
    assert.equal(running.server.timeout, 0, "a socket-inactivity timer here would kill exactly the healthy long responses #127 lost");

    // A response produced well after the receipt bounds still completes: those bounds govern how
    // long the CLIENT may take to send a request, not how long the operation may take.
    running.server.requestTimeout = 60;
    running.server.headersTimeout = 60;
    assert.deepEqual(await brokerPostJson(running.url, "/slow", {}, { rpc_ms: 5_000 }), { ok: true });
  } finally { await running.close(); }
});

test("#128 T3-3: an over-budget surface run is answered as a bounded failure and its late result is discarded", async () => {
  let cleanedUp = false;
  let lateResult: unknown;
  const running = await scriptedBroker({
    "/implement": {
      response_budget_ms: 200,
      run: async () => {
        try {
          await sleep(1_200); // still running when the broker's response budget expires
          lateResult = { candidate_sha: "fabricated-by-an-overdue-run" };
          return lateResult;
        } finally {
          cleanedUp = true; // the surface run's own cleanup still executes
        }
      },
    },
  });
  try {
    const started = Date.now();
    // The caller's RPC budget is deliberately ABOVE the broker's response budget, as in production:
    // the broker answers first, so the workflow sees a broker failure, not a transport timeout.
    const error = await brokerPostJson(running.url, "/implement", {}, { rpc_ms: 1_000 }).then(() => undefined, (e: unknown) => e);
    const elapsed = Date.now() - started;
    assert.ok(error instanceof Error, "an over-budget operation must fail the RPC");
    assert.ok(!(error instanceof BrokerRpcTimeoutError), "the broker answered inside the caller's budget — the ordering held");
    assert.match(error.message, /broker \/implement 504: .*exceeded its declared response budget of 200ms/u);
    assert.doesNotMatch(error.message, /fabricated/u, "a timed-out run must not deliver a candidate");
    assert.ok(elapsed < 900, `the bounded 504 must precede the RPC budget (elapsed ${elapsed}ms)`);

    await sleep(1_400); // let the overdue run finish
    assert.equal(cleanedUp, true, "the surface run's cleanup still ran after the bounded answer");
    assert.notEqual(lateResult, undefined, "the run did complete late — and its result was discarded, not delivered");

    // The server is still healthy and no stale response leaked into the next request.
    const second = await brokerPostJson(running.url, "/implement", {}, { rpc_ms: 1_000 }).then(() => undefined, (e: unknown) => e);
    assert.ok(second instanceof Error && /504/u.test(second.message), "each request is answered on its own bound");
  } finally { await running.close(); }
});

test("#128 T3-4: the declared ordering lets the inner surface fail first — the broker returns that bounded failure normally", async () => {
  // Scaled production ordering: surface 200 < broker response 400 < rpc 800. The surface run ends
  // at its own bound (as `runVerifier` does at 300_000 — see T4 for the bound actually biting on a
  // real surface) and the broker reports the failure normally, inside every outer bound.
  const running = await scriptedBroker({
    "/verify": {
      response_budget_ms: 400,
      run: async () => {
        await sleep(200);
        return { status: "PRESENT", conclusion: "failure", clone_head: "abc", started_at: "t0", completed_at: "t1", output_digest: "d" };
      },
    },
  });
  try {
    const started = Date.now();
    const result = await brokerPostJson<{ conclusion: string }>(running.url, "/verify", {}, { rpc_ms: 800 });
    const elapsed = Date.now() - started;
    assert.equal(result.conclusion, "failure", "an over-budget verifier is a bounded FAILURE — never a success");
    assert.ok(elapsed < 400, `the surface bound bit first (elapsed ${elapsed}ms)`);
  } finally { await running.close(); }
});

// ------------------------------------------------------------------ T4: the bounded surface lifecycle

/** A command that has already answered — the ordinary case for a scripted control plane. */
const done = <T>(value: T): SurfaceCommand<T> => ({ result: Promise.resolve(value), closed: Promise.resolve(), cancel: () => {} });

/**
 * A command that never answers on its own but OWNS something real: a live OS process, and optionally
 * a pending side effect. `cancel` must stop both. Round-6 F7 is precisely that a command which is
 * merely un-awaited keeps running — so the controls model a resource that can actually leak.
 */
function pendingCommand<T>(script = "setInterval(() => {}, 1000)"): SurfaceCommand<T> & { child: ChildProcess } {
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let reaped = (): void => {};
  const closed = new Promise<void>((resolve) => { reaped = resolve; });
  child.on("close", () => { reaped(); });
  child.on("error", () => { reaped(); });
  return {
    child,
    result: new Promise<T>(() => {}),
    closed,
    cancel() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); },
  };
}

/** Wrap a scripted launcher client as a command, exactly as the docker adapter wraps its CLI child. */
function clientCommand(child: ChildProcess): SurfaceCommand<CommandOutput> {
  let reaped = (): void => {};
  const closed = new Promise<void>((resolve) => { reaped = resolve; });
  const result = new Promise<CommandOutput>((resolve) => {
    const out: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.on("close", (status, signal) => {
      resolve({ status: signal === null ? status : null, stdout: Buffer.concat(out).toString("utf8"), stderr: "", completed: signal === null && status !== null });
      reaped();
    });
    child.on("error", () => { resolve({ status: null, stdout: "", stderr: "", completed: false }); reaped(); });
  });
  return { result, closed, cancel() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } };
}

/** Ownership of one scripted surface: the client the runner holds, and the surface it launched. */
interface ScriptedSurfaces {
  readonly port: SurfaceCommandPort;
  readonly launched: Array<{ container: string; args: readonly string[] }>;
  /** How many launched surfaces are still running. */
  alive(): number;
  /** Kill only the LAUNCHER clients, leaving their surfaces running (#128 round-3 F4). */
  killClients(): Promise<void>;
  /** How many launcher clients are still alive — a client the owner failed to reap shows up here. */
  clientsAlive(): number;
  killAll(): void;
}

/**
 * A scaled stand-in for the docker seam that reproduces the exact ownership mismatch #127 measured
 * and the first #128 L4 run confirmed: what `launch` returns is a CLIENT process, while the surface
 * it started is a SEPARATE process that outlives the client's death. A runner that only kills the
 * client cannot bound this; only one that terminates the surface by its own identity — and then
 * observes it gone — can. Both processes are real OS processes, so nothing here is mocked away.
 */
function scriptedSurfaces(runtime: number | "forever", exitCode = 0): ScriptedSurfaces {
  // An attached `docker run` exits AFTER its container does, forwarding the container's output and
  // status. The scripted client therefore outlives its surface by a short lag; modelling them as
  // simultaneous twins would let the client settle while its own surface was still being reaped,
  // which is a property real docker does not have.
  const CLIENT_LAG_MS = 250;
  const forever = "setInterval(() => {}, 1000)";
  const run = (ms: number, emit: boolean): string =>
    `setTimeout(() => { ${emit ? 'process.stdout.write("surface-done"); ' : ""}process.exit(${exitCode}); }, ${ms})`;
  const surfaceScript = runtime === "forever" ? forever : run(runtime, false);
  const clientScript = runtime === "forever" ? forever : run(runtime + CLIENT_LAG_MS, true);
  const spawnScript = (script: string): ChildProcess => spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const surfaces = new Map<string, ChildProcess>();
  const running = (c: ChildProcess | undefined): boolean => c !== undefined && c.exitCode === null && c.signalCode === null;
  const clients: ChildProcess[] = [];
  const launched: Array<{ container: string; args: readonly string[] }> = [];
  return {
    launched,
    port: {
      // Creation is its own acknowledged step, exactly as `docker create` is: the surface process is
      // published HERE, so once this resolves CREATED the identity really exists and later
      // observations mean something.
      create(container, args) {
        launched.push({ container, args });
        surfaces.set(container, spawnScript(surfaceScript));
        return done({ creation: "CREATED", detail: "" });
      },
      launch(container) {
        const client = spawnScript(clientScript); // killing THIS must not stop the surface — that is the whole defect
        clients.push(client);
        void container;
        return clientCommand(client);
      },
      terminate: (container) => { surfaces.get(container)?.kill("SIGKILL"); return done(true); },
      observe: (container) => done(running(surfaces.get(container)) ? "PRESENT" : "ABSENT"),
    },
    alive: () => [...surfaces.values()].filter(running).length,
    clientsAlive: () => clients.filter(running).length,
    async killClients() {
      // Wait for the launch to have happened, then kill ONLY the client and wait for its close, so
      // the runner really does observe a launcher that went away while its surface kept running.
      for (let i = 0; i < 200 && clients.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
      await Promise.all(clients.filter(running).map(async (c) => { c.kill("SIGKILL"); await once(c, "close"); }));
    },
    killAll() { for (const c of [...surfaces.values(), ...clients]) c.kill("SIGKILL"); },
  };
}

const ISOLATION: IsolationConfig = {
  worker_image: "cadp-surface:conformance",
  egress_network: "cadp-conformance-int",
  egress_proxy: "cadp-conformance-proxy:8888",
};

test("#128 T4-0: killing the launching client detaches from the surface — the defect the bound must survive", async (t) => {
  // GUARD BITE for the whole T4 block. If this ever stops holding, the scripted seam no longer
  // models the docker CLI and the controls below would pass vacuously.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  assert.deepEqual(await scripted.port.create("cadp-detached-probe", ["image", "sleep", "600"]).result, { creation: "CREATED", detail: "" });
  const client = scripted.port.launch("cadp-detached-probe");
  client.cancel();
  await client.closed;
  assert.equal(
    await scripted.port.observe("cadp-detached-probe").result,
    "PRESENT",
    "the surface outlives its client — exactly the #127/#128 ownership mismatch, so killing the client is NOT a bound",
  );
  assert.equal(scripted.alive(), 1);
});

test("#128 T4-1: an over-budget run terminates the actual surface, inside its declared termination bound", async (t) => {
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  const started = Date.now();
  const run = await runBoundedSurface(
    { kind: "worker", args: [ISOLATION.worker_image, "codex", "exec"], timeout_ms: 300 },
    { port: scripted.port, termination_ms: 2_000 },
  );
  const elapsed = Date.now() - started;

  assert.equal(run.timed_out, true, "the run ended at its declared bound, not on its own");
  assert.equal(run.surface_state, "TERMINATED", "termination of the exact container was OBSERVED, not merely requested");
  assert.equal(scripted.alive(), 0, "the surface itself is gone — not merely the client handle");
  assert.notEqual(run.status, 0, "a terminated surface can never be read as a success");
  assert.match(run.stderr, /exceeded its declared bound of 300ms; termination TERMINATED/u);
  assert.ok(elapsed >= 300 && elapsed < 2_300, `the bound bit first and termination completed inside its own budget (elapsed ${elapsed}ms)`);

  // The identity the bound targets is unique per run and is what `docker run --name` publishes.
  const [only] = scripted.launched;
  assert.equal(scripted.launched.length, 1);
  assert.equal(run.container, only!.container);
  assert.match(only!.container, /^cadp-surface-worker-[0-9a-f-]{36}$/u);
  assert.deepEqual(dockerCreateArgv(only!.container, only!.args).slice(0, 5), ["create", "--rm", "--init", "--name", only!.container]);
  assert.deepEqual(dockerStartArgv(only!.container), ["start", "--attach", only!.container], "the client attaches to the ALREADY-CREATED identity");
});

test("#128 T4-2: a run that finishes inside its bound is untouched and keeps its output", async (t) => {
  const scripted = scriptedSurfaces(100);
  t.after(() => { scripted.killAll(); });
  const run = await runBoundedSurface(
    { kind: "verifier", args: [ISOLATION.worker_image, "node", "--test"], timeout_ms: 5_000 },
    { port: scripted.port, termination_ms: 2_000 },
  );
  assert.equal(run.timed_out, false);
  assert.equal(run.surface_state, "EXITED");
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "surface-done", "the normal path still returns the surface's own output");
});

test("#128 T4-3: unconfirmed termination is REPORTED, never claimed — and is still bounded", async (t) => {
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  // A daemon that accepts the stop but never stops reporting the container: absence is never observed.
  const wedged: SurfaceCommandPort = { ...scripted.port, terminate: () => done(true), observe: () => done("PRESENT" as const) };
  const started = Date.now();
  const run = await runBoundedSurface(
    { kind: "worker", args: [ISOLATION.worker_image, "codex"], timeout_ms: 200 },
    { port: wedged, termination_ms: 500 },
  );
  const elapsed = Date.now() - started;
  assert.equal(run.timed_out, true);
  assert.equal(run.surface_state, "TERMINATION_UNCONFIRMED", "requested != observed: an unconfirmed stop is not a clean one");
  assert.notEqual(run.status, 0);
  assert.ok(elapsed < 2_000, `even an unconfirmable termination is bounded (elapsed ${elapsed}ms)`);
});

test("#128 T4-3b: an observation that could not be MADE is never read as absence", async (t) => {
  // Round-2 F1. The dangerous case is not a daemon that says "still there" — it is a daemon that
  // says nothing at all. A docker control plane that is down fails `rm` AND fails the query; if the
  // runner treats that failure as "no such container" it reports a clean TERMINATED while the model
  // surface keeps burning compute and provider egress. UNKNOWN must never license TERMINATED.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  for (const [label, down] of [
    ["control plane unreachable", { terminate: () => done(false), observe: () => done("UNKNOWN" as const) }],
    ["observation never settles", { terminate: () => done(false), observe: () => pendingCommand<SurfaceObservation>() }],
  ] as const) {
    const started = Date.now();
    const run = await runBoundedSurface(
      { kind: "worker", args: [ISOLATION.worker_image, "codex"], timeout_ms: 200 },
      { port: { ...scripted.port, ...down }, termination_ms: 500 },
    );
    const elapsed = Date.now() - started;
    assert.equal(run.surface_state, "TERMINATION_UNCONFIRMED", `${label}: an unmade observation is not an observation of absence`);
    assert.notEqual(run.surface_state, "TERMINATED", `${label}: a wedged control plane may never be reported as a clean termination`);
    assert.equal(run.timed_out, true);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /termination TERMINATION_UNCONFIRMED/u, `${label}: the caller is TOLD the surface may still be running`);
    assert.ok(elapsed < 2_000, `${label}: still bounded (elapsed ${elapsed}ms)`);
    // And the honest report is the whole point: the surface really is still alive here.
    assert.ok(scripted.alive() >= 1, `${label}: the surface did survive — which is exactly what UNCONFIRMED reports`);
  }
});

test("#128 T4-3c: the docker adapter maps a failed query to UNKNOWN, and only an empty successful query to ABSENT", () => {
  // Round-2 F1 at the adapter itself, with no docker required — so this control runs everywhere.
  // `docker container inspect` was unsound here: it exits non-zero BOTH for "no such container" and
  // for an unreachable daemon. The observation query must succeed to be evidence at all.
  assert.equal(observationOf(0, ""), "ABSENT", "a successful query with no match is the only thing that proves absence");
  assert.equal(observationOf(0, "\n  \n"), "ABSENT", "whitespace-only output is still no match");
  assert.equal(observationOf(0, "cadp-surface-worker-abc\n"), "PRESENT");
  for (const [status, why] of [[1, "daemon/socket/context unavailable"], [125, "docker CLI usage error"], [null, "the command could not be spawned at all"]] as const) {
    assert.equal(observationOf(status, ""), "UNKNOWN", `exit ${String(status)} (${why}) is the absence of an observation, not an observation of absence`);
    assert.notEqual(observationOf(status, ""), "ABSENT", `exit ${String(status)} must never license TERMINATED`);
  }
  // Ambiguity resolves AWAY from absence: output we did not expect still means "something is there".
  assert.equal(observationOf(0, "some-other-name"), "PRESENT");

  // The query itself must be one that reports daemon reachability separately from matching, and must
  // be anchored to the exact identity so it can never observe a different run's container.
  const argv = dockerObserveArgv("cadp-surface-worker-xyz");
  assert.deepEqual(argv.slice(0, 2), ["ps", "--all"], "`docker ps` exits 0 whether or not anything matches; `inspect` does not");
  assert.ok(argv.includes("name=^cadp-surface-worker-xyz$"), "anchored to the exact container identity");
  assert.deepEqual(argv.slice(-2), ["--format", "{{.Names}}"], "output carries the matched identities and nothing else");
});

test("#128 T4-3d: a launcher that dies before the deadline does not end the run — the surface is stopped and observed", async (t) => {
  // Round-3 F4. The timer is not the only way out of a bounded run: the LAUNCHER can go away first.
  // `launch` returns the docker client, and T4-0 proves client and surface have different lifetimes,
  // so a client that is killed (or loses its daemon connection) has said NOTHING about the container
  // — and once it is gone nothing is left to enforce surface_ms. Reporting that as a plain EXITED is
  // the same ownership mismatch as the pre-repair timer path, on the early-failure branch.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  const started = Date.now();
  const running = runBoundedSurface(
    { kind: "worker", args: [ISOLATION.worker_image, "codex"], timeout_ms: 60_000 },
    { port: scripted.port, termination_ms: 2_000 },
  );
  await scripted.killClients(); // the surface keeps running; only its launcher is gone
  const run = await running;
  const elapsed = Date.now() - started;

  assert.notEqual(run.surface_state, "EXITED", "a dead launcher is not an observed surface exit");
  assert.equal(run.surface_state, "TERMINATED", "the exact container was stopped and OBSERVED gone");
  assert.equal(scripted.alive(), 0, "the orphaned surface is really gone — not left burning compute and provider egress");
  assert.notEqual(run.status, 0, "a surface that outlived its launcher can never be read as a success");
  assert.match(run.stderr, /outlived its launcher; termination TERMINATED/u, "the caller is told which failure this was");
  assert.ok(elapsed < 10_000, `resolved far inside the declared surface bound of 60_000ms (elapsed ${elapsed}ms)`);
});

test("#128 T4-3e: a dead launcher whose surface cannot be observed is UNCONFIRMED, never EXITED", async (t) => {
  // The same branch as T4-3d, but with the round-2 lesson applied: if the control plane cannot
  // answer, the run may not claim the surface ended either — it must say so and stay bounded.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  const blind: SurfaceCommandPort = { ...scripted.port, terminate: () => done(false), observe: () => done("UNKNOWN" as const) };
  const started = Date.now();
  const running = runBoundedSurface(
    { kind: "reviewer", args: [ISOLATION.worker_image, "claude"], timeout_ms: 60_000 },
    { port: blind, termination_ms: 500 },
  );
  await scripted.killClients();
  const run = await running;
  const elapsed = Date.now() - started;

  assert.equal(run.surface_state, "TERMINATION_UNCONFIRMED", "an unobservable surface is not an exited one");
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /outlived its launcher; termination TERMINATION_UNCONFIRMED/u);
  assert.ok(elapsed < 10_000, `still bounded (elapsed ${elapsed}ms)`);
  assert.ok(scripted.alive() >= 1, "the surface really did survive — which is exactly what UNCONFIRMED reports");
});

test("#128 T4-3f: a launcher that exits normally still reports its own result — the repair does not relabel ordinary runs", async (t) => {
  // Guard against over-correcting F4. An attached `docker run` that exits normally reported the
  // CONTAINER's status and `--rm` took it away, so that is an established exit: success keeps status
  // 0 and its output, and an ordinary surface FAILURE keeps its real exit code for the broker.
  for (const [label, exitCode] of [["success", 0], ["ordinary surface failure", 3]] as const) {
    const scripted = scriptedSurfaces(100, exitCode);
    t.after(() => { scripted.killAll(); });
    const run = await runBoundedSurface(
      { kind: "verifier", args: [ISOLATION.worker_image, "node", "--test"], timeout_ms: 5_000 },
      { port: scripted.port, termination_ms: 2_000 },
    );
    assert.equal(run.surface_state, "EXITED", `${label}: an established exit stays EXITED`);
    assert.equal(run.timed_out, false, `${label}: no bound was exceeded`);
    assert.equal(run.status, exitCode, `${label}: the surface's own exit code reaches the caller unchanged`);
    assert.equal(run.stdout, "surface-done", `${label}: its output is preserved`);
    assert.doesNotMatch(run.stderr, /outlived its launcher/u, `${label}: no spurious lifecycle note`);
  }
});

test("#128 T4-3g: a container that appears AFTER an unacknowledged creation is caught, never called EXITED", async (t) => {
  // Round-4 F5. `spawn` returning proves a local CLI exists, not that the daemon created anything.
  // Before creation is acknowledged, an empty query cannot be told apart from "not visible yet" — so
  // a create that never completed must not license EXITED just because nothing is visible YET. Here
  // the surface is published LATE, after the owner has already asked once.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  let publish: (() => void) | undefined;
  const late: SurfaceCommandPort = {
    ...scripted.port,
    create(container, args) {
      // The daemon accepted the request, but the client died before acknowledging it.
      publish = () => { void scripted.port.create(container, args); };
      setTimeout(() => publish?.(), 150);
      return done({ creation: "UNKNOWN" as const, detail: "" });
    },
  };
  const started = Date.now();
  const run = await runBoundedSurface(
    { kind: "worker", args: [ISOLATION.worker_image, "codex"], timeout_ms: 60_000 },
    { port: late, termination_ms: 3_000 },
  );
  const elapsed = Date.now() - started;

  assert.notEqual(run.surface_state, "EXITED", "an unacknowledged creation may never be reported as a surface exit");
  assert.equal(run.surface_state, "TERMINATED", "the late container was caught and confirmed gone");
  assert.equal(run.creation, "UNKNOWN", "the phase is carried structurally, not as a synthesized message");
  assert.equal(scripted.alive(), 0, "nothing was leaked — the whole point of reconciling instead of trusting an empty query");
  assert.notEqual(run.status, 0);
  assert.match(brokerSurfaceFailure("worker", run), /creation was never acknowledged; termination TERMINATED/u);
  assert.ok(elapsed < 10_000, `bounded (elapsed ${elapsed}ms)`);
});

test("#128 T4-3h: an unacknowledged creation that never becomes visible is UNCONFIRMED, not EXITED", async (t) => {
  // The same window, but nothing ever appears. We still cannot establish that no late surface CAN
  // appear, so the honest answer is unconfirmed — not a clean exit — and it is still bounded.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  let observed = 0;
  const started = Date.now();
  const run = await runBoundedSurface(
    { kind: "verifier", args: [ISOLATION.worker_image, "node"], timeout_ms: 60_000 },
    {
      port: {
        ...scripted.port,
        create: () => done({ creation: "UNKNOWN" as const, detail: "" }),
        observe: (c) => { observed += 1; return scripted.port.observe(c); },
      },
      termination_ms: 400,
    },
  );
  const elapsed = Date.now() - started;

  assert.equal(run.surface_state, "TERMINATION_UNCONFIRMED", "an empty query during the creation window is not proof of absence");
  assert.notEqual(run.status, 0);
  assert.ok(observed > 1, `reconciliation really did keep watching for a late container (${observed} observations)`);
  assert.ok(elapsed <= 400 + 750, `and never spent more than its declared window (elapsed ${elapsed}ms)`);
});

test("#128 T4-3h2: a control-plane command that NEVER SETTLES cannot extend reconciliation past its deadline", async (t) => {
  // Round-5 F6. The reconciliation loop bounded its own commands, but its final best-effort removal
  // was a raw await — and `terminate` is allowed never to settle when the daemon is wedged, which is
  // exactly what T4-3b models. That one bypass could hang runBoundedSurface forever at the moment it
  // claims to be giving up, so the broker would never reach its workspace cleanup and outer 504s
  // would pile up unresolved work. Every command in the owner must be subordinate to its deadline.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  let dispatched = 0;
  const wedged: SurfaceCommandPort = {
    ...scripted.port,
    create: () => done({ creation: "UNKNOWN" as const, detail: "" }),
    terminate: () => { dispatched += 1; return pendingCommand<boolean>(); }, // accepted, never answered
    observe: () => done("ABSENT" as const),
  };
  const started = Date.now();
  const run = await runBoundedSurface(
    { kind: "worker", args: [ISOLATION.worker_image, "codex"], timeout_ms: 60_000 },
    { port: wedged, termination_ms: 500 },
  );
  const elapsed = Date.now() - started;

  assert.equal(run.surface_state, "TERMINATION_UNCONFIRMED", "the runner still gives an honest answer");
  assert.notEqual(run.status, 0);
  assert.ok(elapsed >= 250, `the window was really used watching for a late container (elapsed ${elapsed}ms)`);
  assert.ok(elapsed <= 500 + 750, `and the wedged command did NOT extend it (elapsed ${elapsed}ms)`);
  assert.ok(dispatched >= 1, "the final best-effort removal is still DISPATCHED — bounded means not awaited, not skipped");
});

test("#128 T4-3h3: a wedged control plane cannot extend the ordinary termination path either", async (t) => {
  // The same property on the timeout path, so the guarantee is not specific to reconciliation:
  // an established surface whose removal command never answers still resolves at its own bound.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  const wedged: SurfaceCommandPort = {
    ...scripted.port,
    terminate: () => pendingCommand<boolean>(),
    observe: () => pendingCommand<SurfaceObservation>(),
  };
  const started = Date.now();
  const run = await runBoundedSurface(
    { kind: "verifier", args: [ISOLATION.worker_image, "node"], timeout_ms: 200 },
    { port: wedged, termination_ms: 500 },
  );
  const elapsed = Date.now() - started;

  assert.equal(run.timed_out, true);
  assert.equal(run.surface_state, "TERMINATION_UNCONFIRMED");
  assert.ok(elapsed < 5_000, `bounded despite a control plane that never answers (elapsed ${elapsed}ms)`);
});

test("#128 T4-3h4: when the owner returns, every command it started is already dead — and its side effect never lands", async (t) => {
  // Round-7 F7. Sending SIGKILL is not the same as the process being gone, so this checks liveness
  // AT THE MOMENT the owner returns, with no grace period. The delayed side effect is performed by
  // the command's OWN process (it writes a file after 1.5s), so it is causally tied to whether that
  // process actually died rather than to a timer the harness cleared by hand.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  const dir = mkdtempSync(join(tmpdir(), "cadp-t4-3h4-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const marker = join(dir, "published");
  // The publish must be scheduled for AFTER the owner can possibly return (create window + the
  // reconciliation window), otherwise a marker would prove nothing about survival.
  const publishScript = `setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "published"); }, 1500); setInterval(() => {}, 1000)`;

  const owned: ChildProcess[] = [];
  const slow = <T>(script?: string): SurfaceCommand<T> => {
    const command = pendingCommand<T>(script);
    owned.push(command.child);
    return command;
  };
  const wedged: SurfaceCommandPort = {
    ...scripted.port,
    // The daemon accepted the create; the command that would publish the container is still running.
    create: () => slow<CreationOutcome>(publishScript),
    terminate: () => slow<boolean>(),
    observe: () => slow<SurfaceObservation>(),
  };

  const started = Date.now();
  const run = await runBoundedSurface(
    { kind: "worker", args: [ISOLATION.worker_image, "codex"], timeout_ms: 60_000 },
    { port: wedged, termination_ms: 400 },
  );
  const elapsed = Date.now() - started;

  // No grace: the postcondition is about the instant the owner hands control back.
  const aliveAtReturn = owned.filter((c) => c.exitCode === null && c.signalCode === null);
  assert.ok(owned.length > 0, "the control plane really was exercised");
  assert.deepEqual(
    aliveAtReturn.map((c) => c.pid),
    [],
    "a command was STILL ALIVE when runBoundedSurface returned — cancelling must be completed, not merely requested",
  );

  assert.equal(run.creation, "UNKNOWN", "a create that never answered established nothing");
  assert.equal(run.surface_state, "TERMINATION_UNCONFIRMED", "and is never reported as an exit");
  assert.ok(elapsed < 1_400, `the owner returned well before the command's own side effect was due (elapsed ${elapsed}ms)`);

  // The side effect that command would have had must never land, because the process is gone.
  await sleep(1_800);
  assert.equal(existsSync(marker), false, "a cancelled create published its container after the owner returned");
  assert.equal(scripted.alive(), 0);
});

test("#128 T4-3h5: the LAUNCHER is a command too — it is reaped BEFORE the owner touches the container", async (t) => {
  // Round-7 A5. `launch` used to hand back a raw ChildProcess that the timeout path SIGKILLed
  // directly, so a docker client that had not yet gone away could outlive the owner exactly like any
  // other abandoned command. The observable contract is an ORDER: end the launcher and confirm it is
  // gone, THEN deal with the container. Real teardown is not instantaneous, so this launcher takes a
  // moment to die and only an owner that WAITS for its closure can satisfy that order.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  const timeline: string[] = [];
  const laggy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { laggy.kill("SIGKILL"); });
  let reaped = (): void => {};
  const closed = new Promise<void>((resolve) => { reaped = resolve; });
  laggy.on("close", () => { timeline.push("launcher-reaped"); reaped(); });
  const launcher: SurfaceCommand<CommandOutput> = {
    result: new Promise<CommandOutput>((resolve) => {
      laggy.on("close", () => resolve({ status: null, stdout: "", stderr: "", completed: false }));
    }),
    closed,
    cancel() { setTimeout(() => laggy.kill("SIGKILL"), 100); }, // teardown takes a moment, as it does in reality
  };
  const watched: SurfaceCommandPort = {
    ...scripted.port,
    launch: () => launcher,
    terminate: (c) => { timeline.push("container-command"); return scripted.port.terminate(c); },
    observe: (c) => { timeline.push("container-command"); return scripted.port.observe(c); },
  };

  const run = await runBoundedSurface(
    { kind: "worker", args: [ISOLATION.worker_image, "codex"], timeout_ms: 200 },
    { port: watched, termination_ms: 2_000 },
  );

  assert.equal(run.timed_out, true);
  assert.equal(run.surface_state, "TERMINATED", "the surface itself is still stopped and confirmed");
  assert.equal(
    laggy.exitCode === null && laggy.signalCode === null,
    false,
    "the launcher client was still alive when the owner returned — a launcher is a command and must be reaped like one",
  );
  assert.equal(
    timeline[0],
    "launcher-reaped",
    `the launcher must be reaped before any container command is issued, got ${JSON.stringify(timeline.slice(0, 3))}`,
  );
  assert.equal(scripted.alive(), 0, "and the surface is gone");
});

test("#128 T4-3h6: a kill that ERRORS is not a reap — the owner waits for real closure", async (t) => {
  // Round-8 F8. Node emits `error` when a process could NOT be killed, and `exit`/`close` may follow
  // later or not at all. Binding `closed` to that event would make a FAILED SIGKILL read as "the
  // child is reaped" — the one reading that must never be possible, because it is exactly when the
  // child is still alive. Here cancellation reports an error first and the process only really ends
  // 400ms later; the owner must not treat the error as closure.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  const timeline: string[] = [];
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  let reaped = (): void => {};
  const closed = new Promise<void>((resolve) => { reaped = resolve; });
  child.on("close", () => { timeline.push("launcher-closed"); reaped(); });
  const launcher: SurfaceCommand<CommandOutput> = {
    // The command ANSWERS immediately with an error — no output, nothing established.
    result: Promise.resolve({ status: null, stdout: "", stderr: "", completed: false }),
    closed,
    cancel() { setTimeout(() => child.kill("SIGKILL"), 400); }, // the kill only lands later
  };
  const watched: SurfaceCommandPort = {
    ...scripted.port,
    launch: () => launcher,
    terminate: (c) => { timeline.push("container-command"); return scripted.port.terminate(c); },
    observe: (c) => { timeline.push("container-command"); return scripted.port.observe(c); },
  };

  const run = await runBoundedSurface(
    { kind: "worker", args: [ISOLATION.worker_image, "codex"], timeout_ms: 200 },
    { port: watched, termination_ms: 3_000 },
  );

  assert.equal(
    child.exitCode === null && child.signalCode === null,
    false,
    "the owner returned while its launcher was still alive — an errored kill is not a reap",
  );
  assert.ok(timeline.includes("launcher-closed"), "real closure was actually observed, not inferred");
  // The launcher ANSWERED (with an error), so this is the settled path, not the timeout path — and
  // it is exactly the path where an errored answer used to leave the client running unattended.
  assert.equal(run.timed_out, false);
  assert.equal(run.surface_state, "TERMINATED", "the surface it left behind is still stopped and confirmed");
  assert.notEqual(run.status, 0, "and a surface that outlived its launcher is never a success");
  assert.equal(scripted.alive(), 0);
});

test("#128 T4-3h7: a command that ERRORS and never closes cannot be claimed as reaped, and is still bounded", async (t) => {
  // The same distinction where closure never comes at all: the owner may not wait forever, but it
  // also may not pretend the child is gone. It spends its window and reports UNCONFIRMED.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  const errored: SurfaceCommand<SurfaceObservation> = {
    result: Promise.resolve("UNKNOWN"),
    closed: new Promise<void>(() => {}), // the child never closes — closure is never established
    cancel() {},
  };
  const started = Date.now();
  const run = await runBoundedSurface(
    { kind: "verifier", args: [ISOLATION.worker_image, "node"], timeout_ms: 200 },
    { port: { ...scripted.port, observe: () => errored }, termination_ms: 600 },
  );
  const elapsed = Date.now() - started;

  assert.equal(run.surface_state, "TERMINATION_UNCONFIRMED", "an errored, never-closed command is not a clean stop");
  assert.notEqual(run.status, 0);
  assert.ok(elapsed < 5_000, `and the owner is still bounded (elapsed ${elapsed}ms)`);
});

test("#128 T4-3h8: the ADAPTER never resolves `closed` from an error — only authoritative closure does", async (t) => {
  // Round-8 F8 at the adapter itself, with no docker required, so this control runs everywhere.
  // Node emits `error` when a process could not be KILLED, and `exit`/`close` may or may not follow.
  // `commandOf` must therefore settle `result` from an error but NEVER `closed`, because the whole
  // point of `closed` is to mean "this command owns no live process".
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  const command = commandOf(child);

  const pending = "still-pending" as const;
  const peek = <T>(p: Promise<T>): Promise<T | typeof pending> =>
    Promise.race([p, sleep(150).then(() => pending)]);

  // A kill that FAILED: the answer is settled, but the process is demonstrably still running.
  child.emit("error", new Error("kill ESRCH"));
  assert.notEqual(await peek(command.result), pending, "an error settles the command's ANSWER");
  assert.equal(child.exitCode === null && child.signalCode === null, true, "the child really is still alive");
  assert.equal(
    await peek(command.closed),
    pending,
    "`closed` must NOT resolve from an error — a failed kill is exactly when the child is still running",
  );

  // Only real closure establishes it.
  child.kill("SIGKILL");
  await command.closed;
  assert.equal(child.exitCode === null && child.signalCode === null, false, "closure means the child is genuinely gone");
});

test("#128 T4-3h9: a command whose ANSWER errors before closure is still owned — through settle(), on the create path", async (t) => {
  // Round-9 F8. `commandOf` separates "answered" from "released", but the OWNER has to consume that
  // distinction: a result that arrives before closure must not let the run start later commands or
  // return while that client is still alive. The create path carries the most weight, because a live
  // create client is exactly what can publish the container afterwards — so the publish here is done
  // by the command's OWN process and is therefore coupled to its real lifetime.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  const dir = mkdtempSync(join(tmpdir(), "cadp-t4-3h9-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const marker = join(dir, "published");
  const publishScript = `setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "published"); }, 1200); setInterval(() => {}, 1000)`;

  // A REAL live child that ANSWERS immediately with an error and only closes when it is killed.
  const child = spawn(process.execPath, ["-e", publishScript], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  let reaped = (): void => {};
  const closed = new Promise<void>((resolve) => { reaped = resolve; });
  child.on("close", () => { reaped(); });
  let observedAfterCreate = 0;
  const creating: SurfaceCommand<CreationOutcome> = {
    result: Promise.resolve({ creation: "UNKNOWN" as const, detail: "kill ESRCH" }),
    closed,
    cancel() { child.kill("SIGKILL"); },
  };

  const started = Date.now();
  const run = await runBoundedSurface(
    { kind: "worker", args: [ISOLATION.worker_image, "codex"], timeout_ms: 60_000 },
    {
      port: {
        ...scripted.port,
        create: () => creating,
        observe: (c) => { observedAfterCreate += 1; return scripted.port.observe(c); },
      },
      termination_ms: 600,
    },
  );
  const elapsed = Date.now() - started;

  // The answer was consumed only after the command was released: nothing it owns is alive at return.
  assert.equal(
    child.exitCode === null && child.signalCode === null,
    false,
    "the create client was still alive when the owner returned — an answer is not a release",
  );
  assert.ok(observedAfterCreate > 0, "the run really did proceed into reconciliation after the create");
  assert.equal(run.creation, "UNKNOWN");
  assert.equal(run.surface_state, "TERMINATION_UNCONFIRMED");
  assert.ok(elapsed < 5_000, `and it is still bounded (elapsed ${elapsed}ms)`);

  // Its delayed publish is tied to that process, so a released command can never land it.
  await sleep(1_500);
  assert.equal(existsSync(marker), false, "a released create client published its container anyway");
});

test("#128 T4-3j0: a confirmed-gone container is still NOT a clean stop while a launcher we started is alive", async (t) => {
  // Round-9 F8, the exact shape the review named: container removal is AFFIRMATIVELY observed, so
  // the surface really is gone, but the launcher never closes. Reporting a tidy TERMINATED there
  // would describe a clean end while this owner still holds a live docker client. The run is still
  // bounded — it just has to say so.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  const launcher: SurfaceCommand<CommandOutput> = {
    result: new Promise<CommandOutput>(() => {}),
    closed: new Promise<void>(() => {}), // never closes, however hard we try
    cancel() {},
  };
  const started = Date.now();
  const run = await runBoundedSurface(
    { kind: "verifier", args: [ISOLATION.worker_image, "node"], timeout_ms: 200 },
    { port: { ...scripted.port, launch: () => launcher }, termination_ms: 900 },
  );
  const elapsed = Date.now() - started;

  assert.equal(scripted.alive(), 0, "the container itself really was removed and observed gone");
  assert.equal(run.commands_released, false, "the run must say it could not release a command it started");
  assert.equal(
    run.surface_state,
    "TERMINATION_UNCONFIRMED",
    "a confirmed-gone container does not license a clean TERMINATED while our own client is still alive",
  );
  assert.notEqual(run.status, 0);
  assert.ok(elapsed < 5_000, `still bounded (elapsed ${elapsed}ms)`);
});

test("#128 T4-3j1: a CLOSED launcher may not clear another command's release failure", async (t) => {
  // Round-10 F8. The run-wide release fact used to be one shared boolean, so confirming the
  // launcher's closure could erase a failure recorded for a DIFFERENT command. The sequence: the
  // launcher answers abnormally and IS closed, then a real live `observe` answers before any closure
  // and stays alive — and the launcher's closure then reported the whole run as clean, hiding a live
  // docker client from the operator. Attribution has to be per command.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });

  // A launcher that answered abnormally and really is closed.
  const closedLauncher: SurfaceCommand<CommandOutput> = {
    result: Promise.resolve({ status: null, stdout: "", stderr: "", completed: false }),
    closed: Promise.resolve(),
    cancel() {},
  };
  // A REAL observation client that answers ABSENT and can never be released: `cancel` does nothing
  // and it never closes, so it is genuinely still running when the owner returns.
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { live.kill("SIGKILL"); });
  let observations = 0;
  const leaky: SurfaceCommand<SurfaceObservation> = {
    result: Promise.resolve("ABSENT"),
    closed: new Promise<void>(() => {}),
    cancel() {}, // the client survives cancellation — that is the whole point
  };

  const run = await runBoundedSurface(
    { kind: "worker", args: [ISOLATION.worker_image, "codex"], timeout_ms: 60_000 },
    {
      port: {
        ...scripted.port,
        launch: () => closedLauncher,
        observe: (c) => { observations += 1; return observations === 1 ? leaky : scripted.port.observe(c); },
      },
      termination_ms: 600,
    },
  );

  assert.ok(observations >= 1, "the leaky observation really was the one the owner consumed first");
  assert.equal(
    live.exitCode === null && live.signalCode === null,
    true,
    "this control only means something while its observation client is genuinely still running",
  );
  assert.equal(
    run.commands_released,
    false,
    "a closed launcher must not clear the release failure recorded for the observation command",
  );
  assert.notEqual(
    run.surface_state,
    "EXITED",
    "and an ABSENT answered by a still-live client may not license a clean ending",
  );
  assert.equal(run.surface_state, "TERMINATION_UNCONFIRMED");
  assert.match(
    brokerSurfaceFailure("worker", run),
    /could not be confirmed released/u,
    "the operator is warned that a live control-plane command may remain",
  );
});

test("#128 T4-3j2: a still-live create client may not be believed when it says nothing was created", async (t) => {
  // Round-10 F8, the half that is about the ANSWER rather than the ledger. `REJECTED` is the
  // strongest claim in this module — "no container of this identity exists and none can appear" — and
  // accepting it from a client we could not release means trusting a process that is still running,
  // and could still create exactly that container, to promise it never will. An answer whose command
  // was not released is therefore not authoritative at all.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { live.kill("SIGKILL"); });
  const unreleasableCreate: SurfaceCommand<CreationOutcome> = {
    result: Promise.resolve({ creation: "REJECTED" as const, detail: "no such image" }),
    closed: new Promise<void>(() => {}),
    cancel() {}, // the client survives cancellation
  };

  const run = await runBoundedSurface(
    { kind: "worker", args: [ISOLATION.worker_image, "codex"], timeout_ms: 60_000 },
    { port: { ...scripted.port, create: () => unreleasableCreate }, termination_ms: 400 },
  );

  assert.equal(
    live.exitCode === null && live.signalCode === null,
    true,
    "this control only means something while the create client is genuinely still running",
  );
  assert.equal(
    run.creation,
    "UNKNOWN",
    "a REJECTED answered by a client we could not release must not be taken as established",
  );
  assert.notEqual(run.surface_state, "NEVER_CREATED", "so the run may not claim nothing can appear");
  assert.equal(run.commands_released, false);
  assert.doesNotMatch(
    brokerSurfaceFailure("worker", run),
    /was never created/u,
    "and the operator is not told a container can never appear on the word of a live client",
  );
});

test("#128 T4-3i: a creation the daemon REFUSED is reported as never created, with nothing to bound", async (t) => {
  // The counterpart that keeps T4-3h from being over-pessimistic: a create that ran to completion
  // and failed establishes that no container of this identity exists and none can appear, so there
  // is nothing to reconcile and no client is ever started.
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  let launched = 0;
  const started = Date.now();
  const run = await runBoundedSurface(
    { kind: "worker", args: [ISOLATION.worker_image, "codex"], timeout_ms: 60_000 },
    {
      port: { ...scripted.port, create: () => done({ creation: "REJECTED" as const, detail: "no such image: cadp-surface:conformance" }), launch: (c) => { launched += 1; return scripted.port.launch(c); } },
      termination_ms: 3_000,
    },
  );
  assert.equal(run.surface_state, "NEVER_CREATED");
  assert.equal(run.creation, "REJECTED", "the failure phase is carried explicitly, not inferred from a message");
  assert.notEqual(run.status, 0, "a surface that never existed is not a success");
  assert.equal(launched, 0, "nothing is started when creation was refused");
  assert.equal(scripted.alive(), 0);
  assert.ok(Date.now() - started < 1_000, "no reconciliation window is spent on a container that cannot exist");
});

test("#128 T4-3j: the broker names the phase a surface failed in, instead of blaming a launcher that never existed", async () => {
  // Round-5 N1. The runner distinguishes "never created", "creation never acknowledged" and
  // "outlived its launcher"; a report that flattens them says things like
  // "outlived its launcher; termination NEVER_CREATED", which is self-contradictory.
  const base = { stdout: "", stderr: "detail", container: "cadp-surface-worker-x" };
  const cases = [
    [{ ...base, status: null, creation: "REJECTED" as const, surface_state: "NEVER_CREATED" as const }, /was never created/u, /outlived its launcher/u],
    [{ ...base, status: null, creation: "UNKNOWN" as const, surface_state: "TERMINATION_UNCONFIRMED" as const }, /creation was never acknowledged; termination TERMINATION_UNCONFIRMED/u, /outlived its launcher/u],
    [{ ...base, status: null, creation: "CREATED" as const, surface_state: "TERMINATED" as const }, /outlived its launcher; termination TERMINATED/u, /never created/u],
    [{ ...base, status: 3, creation: "CREATED" as const, surface_state: "EXITED" as const }, /container exited 3/u, /outlived its launcher/u],
    [{ ...base, status: null, creation: "CREATED" as const, surface_state: "TERMINATED" as const, timed_out: true }, /exceeded its declared bound; termination TERMINATED/u, /outlived its launcher/u],
    // A run that may still hold a live client says so, because that is what an operator must act on.
    [{ ...base, status: null, creation: "CREATED" as const, surface_state: "TERMINATION_UNCONFIRMED" as const, timed_out: true, commands_released: false }, /could not be confirmed released/u, /outlived its launcher/u],
  ] as const;
  for (const [run, expected, forbidden] of cases) {
    const message = brokerSurfaceFailure("worker", run);
    assert.match(message, expected);
    assert.doesNotMatch(message, forbidden, `"${message}" must not describe a different failure phase`);
  }
});

test("#128 T4-4: an unbounded surface or termination budget is refused", async (t) => {
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  for (const timeout_ms of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
    await assert.rejects(
      runBoundedSurface({ kind: "worker", args: [], timeout_ms }, { port: scripted.port }),
      /surface bound must be finite and positive/u,
    );
  }
  await assert.rejects(
    runBoundedSurface({ kind: "worker", args: [], timeout_ms: 100 }, { port: scripted.port, termination_ms: Number.POSITIVE_INFINITY }),
    /termination bound must be finite and positive/u,
  );
});

test("#128 T4-5: worker, verifier and reviewer all delegate to the bounded owner, keeping their isolation profiles", async (t) => {
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  const options = { port: scripted.port, termination_ms: 2_000 };
  const runs = await Promise.all([
    runWorker(ISOLATION, { workspace: "/ws-w", codexAuthDir: "/auth", argv: ["codex"], timeout_ms: 250 }, options),
    runVerifier(ISOLATION, { workspace: "/ws-v", argv: ["node", "--test"], timeout_ms: 250 }, options),
    runReviewer(ISOLATION, { workspace: "/ws-r", providerToken: "t", argv: ["claude"], timeout_ms: 250 }, options),
  ]);
  for (const run of runs) {
    assert.equal(run.timed_out, true, "every surface runner is bounded by the same owner");
    assert.equal(run.surface_state, "TERMINATED");
    assert.notEqual(run.status, 0);
  }
  assert.equal(scripted.alive(), 0, "no surface of any kind survives its bound");

  const byKind = new Map(scripted.launched.map((l) => [l.container.split("-")[2], l]));
  assert.deepEqual([...byKind.keys()].sort(), ["reviewer", "verifier", "worker"]);
  assert.equal(new Set(scripted.launched.map((l) => l.container)).size, 3, "container identities are unique per run");
  // The isolation profiles TD §4.1 requires are still exactly what gets launched.
  assert.deepEqual(byKind.get("verifier")!.args.slice(0, 2), ["--network", "none"]);
  for (const kind of ["worker", "reviewer"]) {
    const args = byKind.get(kind)!.args;
    assert.deepEqual(args.slice(0, 2), ["--network", ISOLATION.egress_network]);
    assert.ok(args.includes(`HTTPS_PROXY=http://${ISOLATION.egress_proxy}`), `${kind} keeps provider-only egress`);
  }
  assert.ok(byKind.get("reviewer")!.args.includes("/ws-r:/ws:ro"), "the reviewer checkout stays read-only");
});

test("#128 T4-6: end to end — the surface bound bites first, cleanup is observed, and the broker answers a bounded failure with no candidate", async (t) => {
  const scripted = scriptedSurfaces("forever");
  t.after(() => { scripted.killAll(); });
  // Scaled production ordering: surface 300 + termination 900 < broker response 3_000 < rpc 6_000.
  let aliveWhenBrokerAnswered = -1;
  const running = await scriptedBroker({
    "/implement": {
      response_budget_ms: 3_000,
      run: async () => {
        const run = await runBoundedSurface(
          { kind: "worker", args: [ISOLATION.worker_image, "codex"], timeout_ms: 300 },
          { port: scripted.port, termination_ms: 900 },
        );
        aliveWhenBrokerAnswered = scripted.alive();
        // Exactly what `brokerImplement` does with a non-zero surface run.
        if (run.status !== 0) throw new Error(`worker surface exceeded its declared bound; termination ${String(run.surface_state)} (container ${String(run.container)})`);
        return { candidate_sha: "must-never-be-produced" };
      },
    },
  });
  try {
    const started = Date.now();
    const error = await brokerPostJson(running.url, "/implement", {}, { rpc_ms: 6_000 }).then(() => undefined, (e: unknown) => e);
    const elapsed = Date.now() - started;

    assert.ok(error instanceof Error, "an over-budget surface must fail the RPC");
    assert.ok(!(error instanceof BrokerRpcTimeoutError), "the caller's transport bound was never reached — the ordering held");
    assert.match(error.message, /broker \/implement 500: .*exceeded its declared bound; termination TERMINATED/u);
    assert.doesNotMatch(error.message, /must-never-be-produced/u, "a terminated surface may not deliver a candidate");
    assert.equal(aliveWhenBrokerAnswered, 0, "the surface was gone BEFORE the broker answered — cleanup precedes every outer bound");
    assert.equal(scripted.alive(), 0);
    assert.ok(elapsed < 3_000, `the bounded failure landed inside the broker response budget (elapsed ${elapsed}ms)`);
  } finally { await running.close(); }
});
