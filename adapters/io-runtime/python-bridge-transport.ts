/** Synchronous JSON-RPC transport to the long-lived Python bridge holding IO PTY sessions. */

import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalize } from "../../core/schemas/canonical-json.ts";
import { BackendCapabilityGap } from "./io-runtime-adapter.ts";
import type {
  IOBridgeCapabilities,
  IORuntimeAdapterConfig,
  IORuntimeTransport,
  IOSessionObservation,
  IOSpawnObservation,
  IOSpawnRequest,
  IOTerminalTurnObservation,
  IOTurnObservation,
  IOTurnRequest,
} from "./types.ts";

interface RPCEnvelope<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error_code?: string;
  readonly message?: string;
}

export class PythonIOBridgeTransport implements IORuntimeTransport {
  readonly #config: IORuntimeAdapterConfig;
  readonly #bridgePath: string;
  readonly #socketPath: string;
  readonly #configPath: string;

  constructor(config: IORuntimeAdapterConfig, bridgePath = fileURLToPath(new URL("./bridge.py", import.meta.url))) {
    this.#config = config;
    this.#bridgePath = bridgePath;
    this.#socketPath = join(config.state_root, "bridge.sock");
    this.#configPath = join(config.state_root, "bridge-config.json");
    this.#writeConfig();
  }

  capabilities(): IOBridgeCapabilities {
    return this.#call<IOBridgeCapabilities>({ operation: "capabilities" });
  }

  spawn(request: IOSpawnRequest): IOSpawnObservation {
    return this.#call<IOSpawnObservation>({ operation: "spawn", ...request });
  }

  sendTurn(request: IOTurnRequest): IOTurnObservation {
    return this.#call<IOTurnObservation>({ operation: "send_turn", ...request });
  }

  turnResult(turn_ref: string): IOTerminalTurnObservation {
    return this.#call<IOTerminalTurnObservation>({ operation: "turn_result", turn_ref });
  }

  sessionStatus(session_ref: string): IOSessionObservation {
    return this.#call<IOSessionObservation>({ operation: "session_status", session_ref });
  }

  cancel(session_ref: string): void {
    this.#call({ operation: "cancel", session_ref });
  }

  close(session_ref: string): void {
    this.#call({ operation: "close", session_ref });
  }

  /** Test/operator cleanup only. Never called by RuntimeAdapter.close_session. */
  shutdownBridge(): void {
    this.#call({ operation: "shutdown" });
  }

  #call<T = Record<string, never>>(request: Record<string, unknown>): T {
    this.#ensureServer();
    let stdout: string;
    try {
      stdout = execFileSync(
        this.#config.python_executable,
        [this.#bridgePath, "call", "--socket", this.#socketPath],
        {
          encoding: "utf8",
          input: canonicalize(request as never),
          maxBuffer: 16 * 1024 * 1024,
          timeout: (this.#config.turn_timeout_seconds + 30) * 1000,
        },
      );
    } catch (error) {
      throw new BackendCapabilityGap(`IO bridge RPC failed: ${(error as Error).message}`);
    }
    let envelope: RPCEnvelope<T>;
    try {
      envelope = JSON.parse(stdout) as RPCEnvelope<T>;
    } catch {
      throw new BackendCapabilityGap("IO bridge returned a non-JSON response");
    }
    if (!envelope.ok || envelope.result === undefined) {
      throw new BackendCapabilityGap(
        `${envelope.error_code ?? "BRIDGE_ERROR"}: ${envelope.message ?? "IO bridge refused the request"}`,
      );
    }
    return envelope.result;
  }

  #ensureServer(): void {
    try {
      execFileSync(
        this.#config.python_executable,
        [
          this.#bridgePath,
          "ensure-server",
          "--socket",
          this.#socketPath,
          "--config",
          this.#configPath,
        ],
        { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 15_000 },
      );
    } catch (error) {
      throw new BackendCapabilityGap(`cannot start or reacquire IO bridge: ${(error as Error).message}`);
    }
  }

  #writeConfig(): void {
    mkdirSync(dirname(this.#configPath), { recursive: true, mode: 0o700 });
    const staging = `${this.#configPath}.writing`;
    writeFileSync(
      staging,
      `${canonicalize({
        adapter_instance_id: this.#config.adapter_instance_id,
        io_checkout: this.#config.io_checkout,
        expected_io_commit: this.#config.expected_io_commit,
        state_root: this.#config.state_root,
        workspace_trust: this.#config.workspace_trust ?? null,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(staging, this.#configPath);
  }
}
