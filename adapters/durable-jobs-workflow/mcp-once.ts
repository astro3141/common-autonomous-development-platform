/**
 * One-shot MCP tool call helper (IG-3 production transport).
 *
 * Runs as its own process: reads one JSON request from stdin —
 * `{ command, args, env, tool, payload }` — spawns the MCP server it names, performs the
 * initialize handshake, calls the tool once, prints the result JSON to stdout and exits. Any
 * failure exits non-zero with the reason on stderr; the parent treats that as an unavailable
 * backend, fail-closed.
 *
 * The transport uses a subprocess because the Platform's adapter surface is synchronous by
 * contract; this process is where the asynchronous stdio conversation is allowed to live.
 */

import { spawn } from "node:child_process";

interface OnceRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly tool: string;
  readonly payload: unknown;
  readonly timeout_ms?: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function fail(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(1);
}

const request = JSON.parse(await readStdin()) as OnceRequest;
const timeout = setTimeout(() => fail("mcp call timed out"), request.timeout_ms ?? 120_000);

const child = spawn(request.command, request.args, {
  env: { ...process.env, ...request.env },
  stdio: ["pipe", "pipe", "inherit"],
});
child.on("error", (error) => fail(`server did not start: ${error.message}`));

let buffer = "";
let nextId = 0;
const pending = new Map<number, (value: unknown) => void>();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      continue; // Not a JSON-RPC line; the server may log. Ignore, never guess.
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) fail(`rpc error: ${message.error.message ?? "unknown"}`);
      resolve?.(message.result);
    }
  }
});

function rpc(method: string, params: unknown): Promise<unknown> {
  const id = ++nextId;
  const promise = new Promise<unknown>((resolve) => pending.set(id, resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return promise;
}

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "adp-workflow-transport", version: "1" },
});
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const result = (await rpc("tools/call", {
  name: request.tool,
  arguments: request.payload,
})) as { isError?: boolean; content?: readonly { type?: string; text?: string }[] };

clearTimeout(timeout);
if (result.isError === true) fail(`tool call failed: ${JSON.stringify(result.content ?? [])}`);
const text = result.content?.find((item) => item.type === "text")?.text;
process.stdout.write(text ?? JSON.stringify(result));
child.kill();
process.exit(0);
