/**
 * The production binding of `OpenClawGatewaySeam` to an installed Backend v1 (TD §13.1, §30.2).
 *
 * **Validate everything, invent nothing, fail closed** (PR #43 finding 1). The previous revision
 * treated the audited backend as synchronous, fabricated a session `mode`, guessed the handle
 * shape and loaded the package directory as a CommonJS object — four ways of half-working against
 * a backend whose API it had never actually met. This revision does the opposite:
 *
 *   - the package entry is resolved through its own `package.json` (`exports`/`main`), never by
 *     requiring the directory;
 *   - the resolved surface is shape-checked **before any call**: `ensureSession`/`startTurn` must
 *     exist, and a declared-async `ensureSession` is refused outright — the sealed RuntimeAdapter
 *     seam is synchronous, and pretending an awaitable API is a value is exactly the reviewed
 *     defect. Driving the measured async API needs an async seam revision (BACKEND_BLOCKER);
 *   - trusted session input (the `sessionKey` the audited `ensureSession` requires) is never
 *     minted here (I-TD5). It comes only from a deployment-supplied derivation; without one,
 *     every session path refuses before any side effect;
 *   - a call that still answers with a thenable is refused and no session ref is fabricated.
 *
 * Every refusal is `GatewayUnavailable` with the concrete reason. Nothing retries, installs,
 * patches or repairs — a broken or incompatible install is reported, never worked around, and in
 * an RA-4 BLOCKED environment nothing ever reaches this seam at all.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

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
}

interface LiveTurn {
  readonly started_at: string;
  status: GatewayTurnStatus | undefined;
}

interface ValidatedRuntime {
  readonly ensureSession: (input: Record<string, unknown>) => unknown;
  readonly startTurn: (input: Record<string, unknown>) => unknown;
}

/**
 * Lazy production seam. Method calls resolve and validate the backend on first use, and fail
 * closed with the exact missing mechanism or incompatibility when they cannot.
 */
export class OpenClawProductionGateway implements OpenClawGatewaySeam {
  readonly #config: OpenClawGatewayConfig;
  readonly #now: () => string;
  /** RA-2a — live turn tracking is process-local; a restart forgets it, honestly. */
  readonly #turns = new Map<string, LiveTurn>();
  #runtime: ValidatedRuntime | undefined;

  constructor(config: OpenClawGatewayConfig, now: () => string = () => new Date().toISOString()) {
    this.#config = config;
    this.#now = now;
  }

  ensure_session(request: GatewayEnsureSessionRequest): GatewaySessionRef {
    const runtime = this.#acpRuntime();
    const derive = this.#config.derive_session_input;
    if (derive === undefined) {
      // I-TD5 — the trusted input is host-owned. Refuse before any call, never fabricate it.
      throw new GatewayUnavailable(
        "no trusted session-input derivation is configured; the backend host owns session identity (I-TD5) and the Platform will not invent it",
      );
    }
    const input = derive(request);
    const entry = runtime.ensureSession({ ...input, cwd: request.cwd });
    if (isThenable(entry)) {
      // The call already happened; what must not happen is treating an unresolved promise as a
      // session. No ref is fabricated and the operation is reported unavailable (finding 1).
      throw new GatewayUnavailable(
        "ensureSession answered asynchronously; the synchronous RuntimeAdapter seam cannot consume it (BACKEND_BLOCKER — async seam revision required)",
      );
    }
    const record = entry as { sessionId?: unknown; agentId?: unknown } | null;
    const session_id = typeof record?.sessionId === "string" ? record.sessionId : undefined;
    const agent_id = typeof record?.agentId === "string" ? record.agentId : undefined;
    if (session_id === undefined || agent_id === undefined) {
      throw new GatewayUnavailable(
        "ensureSession answered without the audited {agentId, sessionId} shape; refusing to guess a session reference",
      );
    }
    return { agent_id, session_id };
  }

  start_turn(session: GatewaySessionRef, request_id: string, instruction: string): void {
    const runtime = this.#acpRuntime();
    const key = `${session.agent_id}:${session.session_id}:${request_id}`;
    const live: LiveTurn = { started_at: this.#now(), status: undefined };
    const turn = runtime.startTurn({
      handle: { agentId: session.agent_id, sessionId: session.session_id },
      text: instruction,
      requestId: request_id,
    });
    // RA-1b — the measured `startTurn` returns synchronously with `result: Promise<...>`. A turn
    // object without that member is an incompatible API, not a turn.
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
          termination_reason:
            settled.stopReason ?? settled.error?.message ?? String(settled.status),
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

  turn_status(session: GatewaySessionRef, request_id: string): GatewayTurnStatus | undefined {
    return this.#turns.get(`${session.agent_id}:${session.session_id}:${request_id}`)?.status;
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

  /** Resolves and shape-validates the acpx runtime from the configured install, once. */
  #acpRuntime(): ValidatedRuntime {
    if (this.#runtime !== undefined) return this.#runtime;
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
        `the agent extension entry ${entry} could not be loaded synchronously: ${
          (error as Error).message
        }`,
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
    // A declared-async ensureSession is the audited reality this synchronous seam cannot drive.
    // Refusing here — before any call — is the whole point (finding 1).
    if (ensureSession.constructor.name === "AsyncFunction") {
      throw new GatewayUnavailable(
        "the backend ensureSession is asynchronous; the synchronous RuntimeAdapter seam cannot drive it (BACKEND_BLOCKER — async seam revision required)",
      );
    }

    this.#runtime = {
      ensureSession: ensureSession.bind(surface) as ValidatedRuntime["ensureSession"],
      startTurn: startTurn.bind(surface) as ValidatedRuntime["startTurn"],
    };
    return this.#runtime;
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
