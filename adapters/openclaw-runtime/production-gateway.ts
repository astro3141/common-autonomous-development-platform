/**
 * The production binding of `OpenClawGatewaySeam` to an installed Backend v1 (TD §13.1, §30.2).
 *
 * This file is glue to primitives the read-only audits measured — `AcpRuntime.ensureSession`,
 * `startTurn`, the owner-partitioned session store — and nothing else. It resolves them **lazily**
 * from the configured install: construction never touches the backend, so a composition root can
 * be built in an environment where the RA-4 preflight is BLOCKED, and the fail-closed guarantee
 * stays where it belongs — no Runtime external effect starts before READY, so in a blocked
 * environment nothing ever calls this seam.
 *
 * Every failure is `GatewayUnavailable` with the concrete reason. Nothing here retries, installs,
 * patches or repairs — a broken install is reported, never fixed (same rule as the preflight).
 *
 * Live execution of this binding requires the patched Backend v1 cell (RA-4 C1–C6 READY). Where
 * that cell is absent this module is deliberately unreachable production surface: its correctness
 * against a live backend is a deferred backend validation, not a deterministic test subject.
 */

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
}

interface LiveTurn {
  readonly started_at: string;
  status: GatewayTurnStatus | undefined;
}

/**
 * Lazy production seam. Method calls resolve the backend on first use and fail closed with the
 * exact missing mechanism when they cannot.
 */
export class OpenClawProductionGateway implements OpenClawGatewaySeam {
  readonly #config: OpenClawGatewayConfig;
  readonly #now: () => string;
  /** RA-2a — live turn tracking is process-local; a restart forgets it, honestly. */
  readonly #turns = new Map<string, LiveTurn>();
  #runtime: unknown;

  constructor(config: OpenClawGatewayConfig, now: () => string = () => new Date().toISOString()) {
    this.#config = config;
    this.#now = now;
  }

  ensure_session(request: GatewayEnsureSessionRequest): GatewaySessionRef {
    const runtime = this.#acpRuntime() as {
      ensureSession?: (input: Record<string, unknown>) => unknown;
    };
    if (typeof runtime.ensureSession !== "function") {
      throw new GatewayUnavailable("backend runtime exposes no ensureSession");
    }
    const entry = runtime.ensureSession({
      agent: request.runtime_profile,
      mode: "managed",
      cwd: request.cwd,
    }) as { sessionId?: unknown; agentId?: unknown } | null;
    const session_id = typeof entry?.sessionId === "string" ? entry.sessionId : undefined;
    const agent_id = typeof entry?.agentId === "string" ? entry.agentId : request.runtime_profile;
    if (session_id === undefined) {
      throw new GatewayUnavailable("ensureSession returned no session id");
    }
    return { agent_id, session_id };
  }

  start_turn(session: GatewaySessionRef, request_id: string, instruction: string): void {
    const runtime = this.#acpRuntime() as {
      startTurn?: (input: Record<string, unknown>) => {
        result?: Promise<{ status?: string; stopReason?: string; error?: { message?: string } }>;
      };
    };
    if (typeof runtime.startTurn !== "function") {
      throw new GatewayUnavailable("backend runtime exposes no startTurn");
    }
    const key = `${session.agent_id}:${session.session_id}:${request_id}`;
    const live: LiveTurn = { started_at: this.#now(), status: undefined };
    this.#turns.set(key, live);
    const turn = runtime.startTurn({
      handle: { agentId: session.agent_id, sessionId: session.session_id },
      text: instruction,
      mode: "managed",
      requestId: request_id,
    });
    // RA-2a — the terminal projection is the settled promise; the settlement is recorded when it
    // arrives and read back synchronously by `turn_status`.
    turn.result
      ?.then((result) => {
        live.status = {
          backend_status:
            result.status === "completed"
              ? "COMPLETED"
              : result.status === "cancelled"
                ? "CANCELLED"
                : "RUNTIME_ERROR",
          termination_reason: result.stopReason ?? result.error?.message ?? String(result.status),
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

  /** Resolves the acpx runtime from the configured install, once, fail-closed. */
  #acpRuntime(): unknown {
    if (this.#runtime !== undefined) return this.#runtime;
    const dir = this.#config.agent_extension_dir;
    if (dir === null) {
      throw new GatewayUnavailable("the agent extension (acpx) is not installed (RA-4 C3)");
    }
    const require = createRequire(join(dir, "package.json"));
    let moduleExports: unknown;
    try {
      moduleExports = require(dir) as unknown;
    } catch (error) {
      throw new GatewayUnavailable(
        `the agent extension could not be loaded from ${dir}: ${(error as Error).message}`,
      );
    }
    const runtime = (moduleExports as { AcpRuntime?: unknown }).AcpRuntime ?? moduleExports;
    this.#runtime = runtime;
    return runtime;
  }
}
