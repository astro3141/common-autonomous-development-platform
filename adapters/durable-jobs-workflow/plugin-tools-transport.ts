/**
 * PluginToolsMcpTransport — the production `WorkflowToolTransport` (IG-3).
 *
 * Backend v1 exposes the `workflow` tool through the per-session plugin-tools MCP server, and the
 * trusted context rides in that server's environment — the host-injected session identity, never a
 * value this transport mints (I-TD5). One invocation is one short-lived subprocess conversation:
 * spawn the configured server entry with the controller session's environment, handshake, call the
 * tool once, read the answer.
 *
 * The environment values come from deployment configuration and are handed over untouched; they
 * are never logged, never persisted and never returned (I-TD7). An installation where the entry is
 * missing simply fails the call — the RA-4 preflight already reported that environment BLOCKED
 * before anything could reach here.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { WorkflowToolTransport } from "../local-verification/workflow-tool-seam.ts";

export class WorkflowTransportError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "WorkflowTransportError";
  }
}

export interface PluginToolsMcpTransportConfig {
  /** The resolved plugin-tools server entry (RA-4 C5's serve implementation). */
  readonly serve_entry: string;
  /** Trusted-context environment for the controller session. Deployment-owned, opaque here. */
  readonly env: Readonly<Record<string, string>>;
  /** The MCP tool name that carries workflow actions. */
  readonly tool?: string;
  readonly timeout_ms?: number;
}

const HELPER = fileURLToPath(new URL("./mcp-once.ts", import.meta.url));

export class PluginToolsMcpTransport implements WorkflowToolTransport {
  readonly #config: PluginToolsMcpTransportConfig;

  constructor(config: PluginToolsMcpTransportConfig) {
    this.#config = config;
  }

  invoke(request: Readonly<Record<string, unknown>>): unknown {
    const once = {
      command: process.execPath,
      args: [this.#config.serve_entry],
      env: this.#config.env,
      tool: this.#config.tool ?? "workflow",
      payload: request,
      timeout_ms: this.#config.timeout_ms ?? 120_000,
    };
    const run = spawnSync(process.execPath, [HELPER], {
      input: JSON.stringify(once),
      encoding: "utf8",
      timeout: (this.#config.timeout_ms ?? 120_000) + 10_000,
    });
    if (run.status !== 0) {
      throw new WorkflowTransportError(
        `workflow tool call failed: ${run.stderr?.trim() || run.error?.message || "unknown"}`,
      );
    }
    try {
      return JSON.parse(run.stdout) as unknown;
    } catch {
      throw new WorkflowTransportError("workflow tool answered with something that is not JSON");
    }
  }
}
