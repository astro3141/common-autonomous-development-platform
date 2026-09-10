/**
 * MCP tool-surface dispatcher conformance (#61 direction pilot, recommendation B).
 *
 *   M1  protocol subset: initialize / ping / tools list+call / notifications / unknown method
 *   M2  a tool failure travels as an isError tool result (a DENY is information, not a crash)
 *   M3  session work-start cap (direction-pilot risk 2): attempts count, the cap fails closed,
 *       and no start callback runs past it
 */

import assert from "node:assert/strict";
import test from "node:test";

import { handleMcpMessage, makeMcpSession, guardedWorkStart, WorkStartCapExceeded, MCP_PROTOCOL_VERSION } from "../../product/mcp.ts";
import type { McpTool } from "../../product/mcp.ts";

const echoTool: McpTool = {
  name: "echo",
  description: "echoes",
  inputSchema: { type: "object", properties: { v: { type: "string" } } },
  call: async (args) => ({ echoed: args["v"] }),
};
const failingTool: McpTool = {
  name: "denied",
  description: "always refuses",
  inputSchema: { type: "object" },
  call: async () => {
    throw new Error("policy DENY: malformed_work_bounds");
  },
};

test("M1: the protocol subset behaves exactly", async () => {
  const init = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, [echoTool]);
  assert.deepEqual(init, {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "cadp", version: "0.4.0" } },
  });
  assert.equal(await handleMcpMessage({ method: "notifications/initialized" }, [echoTool]), undefined);
  assert.deepEqual(await handleMcpMessage({ id: 2, method: "ping" }, [echoTool]), { jsonrpc: "2.0", id: 2, result: {} });

  const list = await handleMcpMessage({ id: 3, method: "tools/list" }, [echoTool, failingTool]);
  assert.deepEqual((list as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name), ["echo", "denied"]);

  const call = await handleMcpMessage({ id: 4, method: "tools/call", params: { name: "echo", arguments: { v: "hi" } } }, [echoTool]);
  assert.deepEqual(call, { jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: JSON.stringify({ echoed: "hi" }, null, 2) }] } });

  const missing = await handleMcpMessage({ id: 5, method: "tools/call", params: { name: "nope" } }, [echoTool]);
  assert.equal((missing as { error: { code: number } }).error.code, -32602);
  const unknown = await handleMcpMessage({ id: 6, method: "resources/list" }, [echoTool]);
  assert.equal((unknown as { error: { code: number } }).error.code, -32601);
  assert.equal(await handleMcpMessage({ method: "resources/updated" }, [echoTool]), undefined, "unknown notifications are ignored, not errored");
});

test("M2: a tool failure is an isError result carrying the exact refusal text", async () => {
  const failed = await handleMcpMessage({ id: 7, method: "tools/call", params: { name: "denied" } }, [failingTool]);
  assert.deepEqual(failed, {
    jsonrpc: "2.0",
    id: 7,
    result: { content: [{ type: "text", text: "policy DENY: malformed_work_bounds" }], isError: true },
  });
});

test("M3: the session work-start cap fails closed and counts attempts, not successes", async () => {
  const session = makeMcpSession(2);
  let ran = 0;
  const start = () => guardedWorkStart(session, async () => { ran += 1; return ran; });

  assert.equal(await start(), 1);
  await assert.rejects(() => guardedWorkStart(session, async () => { throw new Error("ADMISSION REFUSED"); }), /ADMISSION REFUSED/u);
  // Two attempts consumed (one refused) — the cap is on loop budget, not on successes.
  await assert.rejects(start, WorkStartCapExceeded);
  assert.equal(ran, 1, "no start callback runs past the cap");
});
