/**
 * The production binding of `OpenClawGatewaySeam` to an installed Backend v1 (TD §13.1, §30.2).
 *
 * **Validate everything, invent nothing, fail closed** (PR #43 finding 1). The backend package is
 * resolved through its own `package.json`, shape-checked before any call, and its trusted session
 * input is host-owned (I-TD5) — supplied only by a deployment-provided derivation, never minted
 * here.
 *
 * #81 I2 — the measured `AcpRuntime.ensureSession` is `async`. The synchronous RuntimeAdapter seam
 * is preserved unchanged: a synchronous backend is driven directly (the audited-sync path), and a
 * genuinely asynchronous backend is driven behind an adapter-local `BlockingBackendBridge` — one
 * worker thread that owns the backend runtime and answers each operation synchronously via
 * `Atomics.wait`. Either way the backend owns identity, ambiguous/timeout failures stay
 * fail-closed, and no session/turn ref is fabricated.
 *
 * Every refusal is `GatewayUnavailable` with the concrete reason. Nothing retries, installs,
 * patches or repairs.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import {
  BlockingBackendBridge,
  type BackendTurnTerminal,
} from "./backend-bridge.ts";
import { GatewayUnavailable } from "./gateway-seam.ts";
import type {
  GatewayEnsureSessionRequest,
  GatewaySessionRef,
  GatewayTurnStatus,
  OpenClawGatewaySeam,
} from "./gateway-seam.ts";

export interface OpenClawGatewayConfig {
  /** The installed backend core distribution directory (the RA-4 `core_dist_dir`). */
  readonly core_dist_dir: string;
  /** The installed agent-extension (acpx) directory, or null when it does not resolve (C3). */
  readonly agent_extension_dir: string | null;
  /** The controller session's agent id — deployment configuration, never minted here (I-TD5). */
  readonly controller_agent_id: string;
  /** Working directory the controller session is ensured with. */
  readonly controller_cwd: string;
  /**
   * Deployment-owned derivation of the backend's trusted session input for one request — the
   * `sessionKey`-bearing object the audited `ensureSession` actually takes. The host owns that
   * identity (I-TD5); the Platform neither stores nor invents it, so without this derivation the
   * gateway refuses every session operation before any side effect.
   */
  readonly derive_session_input?: (
    request: GatewayEnsureSessionRequest,
  ) => Record<string, unknown>;
  /** #81 I2 — bound for one async backend operation before the bridge fails closed. */
  readonly async_backend_timeout_ms?: number;
}

interface LiveTurn {
  readonly started_at: string;
  status: GatewayTurnStatus | undefined;
}

/** The gateway's internal backend, either the synchronous acpx surface or the async bridge. */
interface Backend {
  ensureSession(input: Record<string, unknown>): { agentId: string; sessionId: string };
  startTurn(session: GatewaySessionRef, request_id: string, instruction: string): void;
  turnStatus(session: GatewaySessionRef, request_id: string): GatewayTurnStatus | undefined;
}

const DEFAULT_ASYNC_TIMEOUT_MS = 120_000;

interface SyncRuntimeSurface {
  ensureSession(input: Record<string, unknown>): unknown;
  startTurn(input: Record<string, unknown>): unknown;
}

/**
 * Lazy production seam. Method calls resolve and validate the backend on first use, and fail
 * closed with the exact missing mechanism or incompatibility when they cannot.
 */
export class OpenClawProductionGateway implements OpenClawGatewaySeam {
  readonly #config: OpenClawGatewayConfig;
  readonly #now: () => string;
  #backend: Backend | undefined;

  constructor(config: OpenClawGatewayConfig, now: () => string = () => new Date().toISOString()) {
    this.#config = config;
    this.#now = now;
  }

  ensure_session(request: GatewayEnsureSessionRequest): GatewaySessionRef {
    const backend = this.#resolveBackend();
    const derive = this.#config.derive_session_input;
    if (derive === undefined) {
      // I-TD5 — the trusted input is host-owned. Refuse before any call, never fabricate it.
      throw new GatewayUnavailable(
        "no trusted session-input derivation is configured; the backend host owns session identity (I-TD5) and the Platform will not invent it",
      );
    }
    const input = derive(request);
    const entry = backend.ensureSession({ ...input, cwd: request.cwd });
    return { agent_id: entry.agentId, session_id: entry.sessionId };
  }

  start_turn(session: GatewaySessionRef, request_id: string, instruction: string): void {
    this.#resolveBackend().startTurn(session, request_id, instruction);
  }

  turn_status(session: GatewaySessionRef, request_id: string): GatewayTurnStatus | undefined {
    return this.#backend?.turnStatus(session, request_id);
  }

  session_status(session: GatewaySessionRef): Record<string, unknown> {
    return { agent_id: session.agent_id, session_id: session.session_id };
  }

  cancel_session(_session: GatewaySessionRef): void {
    throw new GatewayUnavailable("session cancel is not yet bound to a measured backend primitive");
  }

  close_session(_session: GatewaySessionRef): void {
    throw new GatewayUnavailable("session close is not yet bound to a measured backend primitive");
  }

  controller_session(): GatewaySessionRef {
    return this.ensure_session({
      op_key: "controller",
      role: "PLATFORM_CONTROLLER",
      runtime_profile: this.#config.controller_agent_id,
      cwd: this.#config.controller_cwd,
    });
  }

  /** Resolves and shape-validates the backend once, choosing the sync or async driver. */
  #resolveBackend(): Backend {
    if (this.#backend !== undefined) return this.#backend;
    const dir = this.#config.agent_extension_dir;
    if (dir === null) {
      throw new GatewayUnavailable("the agent extension (acpx) is not installed (RA-4 C3)");
    }

    // The entry comes from the package's own manifest — requiring the directory ignores
    // `exports` and was the reviewed "Cannot find module" failure against the audited package.
    const entry = this.#resolveEntry(dir);
    const require = createRequire(join(dir, "package.json"));
    let moduleExports: unknown;
    try {
      moduleExports = require(entry) as unknown;
    } catch (error) {
      throw new GatewayUnavailable(
        `the agent extension entry ${entry} could not be loaded synchronously: ${(error as Error).message}`,
      );
    }

    const surface =
      (moduleExports as { AcpRuntime?: unknown }).AcpRuntime ??
      (moduleExports as { default?: { AcpRuntime?: unknown } }).default?.AcpRuntime ??
      moduleExports;
    const ensureSession = (surface as { ensureSession?: unknown }).ensureSession;
    const startTurn = (surface as { startTurn?: unknown }).startTurn;
    if (typeof ensureSession !== "function" || typeof startTurn !== "function") {
      throw new GatewayUnavailable(
        "the loaded module does not expose the audited AcpRuntime surface (ensureSession/startTurn); refusing an unrecognized API",
      );
    }

    // #81 I2 — a declared-async ensureSession is the measured reality. It is no longer a blocker:
    // the async backend is driven behind the adapter-local blocking bridge; a synchronous backend
    // keeps the direct, in-process path (existing audited behaviour, unchanged).
    this.#backend =
      ensureSession.constructor.name === "AsyncFunction"
        ? new BridgeBackend(dir, this.#config.async_backend_timeout_ms ?? DEFAULT_ASYNC_TIMEOUT_MS)
        : new SyncBackend(
            {
              ensureSession: ensureSession.bind(surface) as (
                input: Record<string, unknown>,
              ) => unknown,
              startTurn: startTurn.bind(surface) as (input: Record<string, unknown>) => unknown,
            },
            this.#now,
          );
    return this.#backend;
  }

  /** The package entry per its own manifest: `exports["."]` (any of its forms) or `main`. */
  #resolveEntry(dir: string): string {
    let manifest: { exports?: unknown; main?: unknown };
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as typeof manifest;
    } catch (error) {
      throw new GatewayUnavailable(
        `the agent extension at ${dir} has no readable package.json: ${(error as Error).message}`,
      );
    }
    const fromExports = entryFromExports(manifest.exports);
    const relative =
      fromExports ?? (typeof manifest.main === "string" ? manifest.main : undefined);
    if (relative === undefined) {
      throw new GatewayUnavailable(
        `the agent extension at ${dir} declares neither exports["."] nor main; refusing to guess an entry`,
      );
    }
    return join(dir, relative);
  }
}

/** The audited synchronous acpx surface, driven directly in-process (unchanged behaviour). */
class SyncBackend implements Backend {
  readonly #runtime: SyncRuntimeSurface;
  readonly #now: () => string;
  /** RA-2a — live turn tracking is process-local; a restart forgets it, honestly. */
  readonly #turns = new Map<string, LiveTurn>();

  constructor(runtime: SyncRuntimeSurface, now: () => string) {
    this.#runtime = runtime;
    this.#now = now;
  }

  ensureSession(input: Record<string, unknown>): { agentId: string; sessionId: string } {
    const entry = this.#runtime.ensureSession(input);
    if (isThenable(entry)) {
      throw new GatewayUnavailable(
        "ensureSession answered asynchronously; the synchronous path cannot consume it",
      );
    }
    return requireSessionShape(entry);
  }

  startTurn(session: GatewaySessionRef, request_id: string, instruction: string): void {
    const key = `${session.agent_id}:${session.session_id}:${request_id}`;
    const live: LiveTurn = { started_at: this.#now(), status: undefined };
    const turn = this.#runtime.startTurn({
      handle: { agentId: session.agent_id, sessionId: session.session_id },
      text: instruction,
      requestId: request_id,
    });
    const result = (turn as { result?: unknown } | null)?.result;
    if (!isThenable(result)) {
      throw new GatewayUnavailable(
        "startTurn answered without the audited { result: Promise } shape; the turn cannot be observed and is not tracked",
      );
    }
    this.#turns.set(key, live);
    (result as Promise<{ status?: string; stopReason?: string; error?: { message?: string } }>)
      .then((settled) => {
        live.status = {
          backend_status:
            settled.status === "completed"
              ? "COMPLETED"
              : settled.status === "cancelled"
                ? "CANCELLED"
                : "RUNTIME_ERROR",
          termination_reason: settled.stopReason ?? settled.error?.message ?? String(settled.status),
          started_at: live.started_at,
          completed_at: this.#now(),
        };
      })
      .catch((error: unknown) => {
        live.status = {
          backend_status: "RUNTIME_ERROR",
          termination_reason: error instanceof Error ? error.message : String(error),
          started_at: live.started_at,
          completed_at: this.#now(),
        };
      });
  }

  turnStatus(session: GatewaySessionRef, request_id: string): GatewayTurnStatus | undefined {
    return this.#turns.get(`${session.agent_id}:${session.session_id}:${request_id}`)?.status;
  }
}

/** The measured async acpx surface, driven synchronously behind the blocking bridge (#81 I2). */
class BridgeBackend implements Backend {
  readonly #bridge: BlockingBackendBridge;

  constructor(agent_extension_dir: string, timeout_ms: number) {
    this.#bridge = new BlockingBackendBridge({
      factory_module: new URL("./acp-backend-factory.ts", import.meta.url).href,
      factory_data: { agent_extension_dir },
      timeout_ms,
    });
  }

  ensureSession(input: Record<string, unknown>): { agentId: string; sessionId: string } {
    return requireSessionShape(this.#bridge.call("ensureSession", input));
  }

  startTurn(session: GatewaySessionRef, request_id: string, instruction: string): void {
    this.#bridge.call("startTurn", {
      key: `${session.agent_id}:${session.session_id}:${request_id}`,
      input: {
        handle: { agentId: session.agent_id, sessionId: session.session_id },
        text: instruction,
        requestId: request_id,
      },
    });
  }

  turnStatus(session: GatewaySessionRef, request_id: string): GatewayTurnStatus | undefined {
    const terminal = this.#bridge.call("turnStatus", {
      key: `${session.agent_id}:${session.session_id}:${request_id}`,
    }) as BackendTurnTerminal | null;
    return terminal ?? undefined;
  }
}

function requireSessionShape(entry: unknown): { agentId: string; sessionId: string } {
  const record = entry as { sessionId?: unknown; agentId?: unknown } | null;
  if (typeof record?.sessionId !== "string" || typeof record?.agentId !== "string") {
    throw new GatewayUnavailable(
      "ensureSession answered without the audited {agentId, sessionId} shape; refusing to guess a session reference",
    );
  }
  return { agentId: record.agentId, sessionId: record.sessionId };
}

function entryFromExports(exports: unknown): string | undefined {
  if (typeof exports === "string") return exports;
  if (typeof exports !== "object" || exports === null) return undefined;
  const dot = (exports as Record<string, unknown>)["."] ?? exports;
  if (typeof dot === "string") return dot;
  if (typeof dot !== "object" || dot === null) return undefined;
  const conditions = dot as Record<string, unknown>;
  for (const key of ["require", "node", "default", "import"]) {
    const candidate = conditions[key];
    if (typeof candidate === "string") return candidate;
    if (typeof candidate === "object" && candidate !== null) {
      const nested = (candidate as Record<string, unknown>)["default"];
      if (typeof nested === "string") return nested;
    }
  }
  return undefined;
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
