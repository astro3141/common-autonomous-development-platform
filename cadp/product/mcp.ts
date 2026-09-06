/**
 * Minimal MCP (Model Context Protocol) dispatcher — the thin conformance edge (Spec §8.1) that
 * lets a commodity single-model agent session act as the supervision loop by CALLING CADP's
 * existing governed operations as tools. Direction adopted from the #61 planner direction pilot
 * (recommendation B): CADP owns no supervisor component; the commodity session owns the loop and
 * receives ALLOW/DENY/evidence back — never a credential, never admission authority.
 *
 * Protocol subset: JSON-RPC 2.0 over newline-delimited stdio — `initialize`, `ping`,
 * `notifications/initialized`, `tools/list`, `tools/call`. Nothing else; unknown methods error.
 *
 * Session guardrail (direction-pilot risk 2): the kernel bounds each work run, not the
 * whole-intent loop, so the tool surface itself caps governed work starts per session.
 */

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<unknown>;
}

export interface McpSession {
  work_starts: number;
  readonly max_work_starts: number;
}

export function makeMcpSession(max_work_starts = 20): McpSession {
  return { work_starts: 0, max_work_starts };
}

export class WorkStartCapExceeded extends Error {
  constructor(cap: number) {
    super(`this session already started ${cap} governed work runs — its cap is reached. Start a new session (a fresh cap) only with deliberate human intent.`);
    this.name = "WorkStartCapExceeded";
  }
}

/** Wrap a work-start tool call with the session cap. The cap is a tool-surface bound, not authority. */
export async function guardedWorkStart<T>(session: McpSession, start: () => Promise<T>): Promise<T> {
  if (session.work_starts >= session.max_work_starts) throw new WorkStartCapExceeded(session.max_work_starts);
  session.work_starts += 1; // count the attempt, not the success: a refused admission still consumed loop budget
  return start();
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: number | string | null; result: unknown } | { jsonrpc: "2.0"; id: number | string | null; error: { code: number; message: string } };

const respond = (id: number | string | null, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: number | string | null, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

export const MCP_PROTOCOL_VERSION = "2024-11-05";

/**
 * Handle one JSON-RPC message. Returns the response to write, or undefined for notifications.
 * Tool results and tool FAILURES both travel as tool-call results (`isError` per MCP), so the
 * calling model always sees the exact refusal text — a DENY is information, not a crash.
 */
export async function handleMcpMessage(message: JsonRpcRequest, tools: readonly McpTool[]): Promise<JsonRpcResponse | undefined> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined;
  switch (message.method) {
    case "initialize":
      return respond(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "cadp", version: "0.4.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return respond(id, {});
    case "tools/list":
      return respond(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const params = message.params ?? {};
      const name = params["name"];
      const tool = tools.find((t) => t.name === name);
      if (tool === undefined) return fail(id, -32602, `unknown tool ${String(name)}`);
      const args = (params["arguments"] ?? {}) as Record<string, unknown>;
      try {
        const result = await tool.call(args);
        return respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return respond(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return isNotification ? undefined : fail(id, -32601, `no such method ${String(message.method)}`);
  }
}
