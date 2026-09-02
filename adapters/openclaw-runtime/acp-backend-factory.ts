/**
 * The production backend factory the bridge worker imports (#81 I2).
 *
 * It resolves and loads the installed acpx package exactly as the gateway did before — through the
 * package's own `package.json` (`exports`/`main`), never by requiring the directory — and returns
 * the audited `{ ensureSession, startTurn }` surface. Because this runs inside the worker (an async
 * context), an `async ensureSession` is no longer a blocker: the worker awaits it. Nothing here is
 * OpenClaw source; it only loads and calls the already-installed package.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export interface AcpBackendFactoryData {
  readonly agent_extension_dir: string;
}

export interface AcpBackend {
  ensureSession(input: Record<string, unknown>): Promise<unknown> | unknown;
  startTurn(input: Record<string, unknown>): unknown;
}

export function createBackend(input: unknown): AcpBackend {
  const data = input as AcpBackendFactoryData;
  const dir = data.agent_extension_dir;
  const entry = resolveEntry(dir);
  const require = createRequire(join(dir, "package.json"));
  let moduleExports: unknown;
  try {
    moduleExports = require(entry) as unknown;
  } catch (error) {
    throw new Error(
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
    throw new Error(
      "the loaded module does not expose the audited AcpRuntime surface (ensureSession/startTurn); refusing an unrecognized API",
    );
  }
  return {
    ensureSession: ensureSession.bind(surface) as AcpBackend["ensureSession"],
    startTurn: startTurn.bind(surface) as AcpBackend["startTurn"],
  };
}

/** The package entry per its own manifest: `exports["."]` (any of its forms) or `main`. */
function resolveEntry(dir: string): string {
  let manifest: { exports?: unknown; main?: unknown };
  try {
    manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as typeof manifest;
  } catch (error) {
    throw new Error(`the agent extension at ${dir} has no readable package.json: ${(error as Error).message}`);
  }
  const fromExports = entryFromExports(manifest.exports);
  const relative = fromExports ?? (typeof manifest.main === "string" ? manifest.main : undefined);
  if (relative === undefined) {
    throw new Error(
      `the agent extension at ${dir} declares neither exports["."] nor main; refusing to guess an entry`,
    );
  }
  return join(dir, relative);
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
