/**
 * A scripted async backend factory for the #81 I2 blocking-bridge probe. The worker imports this
 * module and calls `createBackend(data)`; each behaviour is genuinely asynchronous (returns a
 * Promise) so the probe proves the real bridge consumes the measured async shape and fails closed.
 *
 * `data.mode`:
 *   resolve   ensureSession resolves { agentId: data.agent, sessionId: data.session }
 *   reject    ensureSession rejects
 *   hang      ensureSession never settles (drives the bounded-timeout control)
 *   malformed ensureSession resolves a value without the audited shape
 */

interface ScriptData {
  readonly mode: "resolve" | "reject" | "hang" | "malformed";
  readonly agent?: string;
  readonly session?: string;
}

export function createBackend(input: unknown): {
  ensureSession(payload: Record<string, unknown>): Promise<unknown>;
  startTurn(payload: Record<string, unknown>): unknown;
} {
  const data = input as ScriptData;
  return {
    async ensureSession(payload: Record<string, unknown>): Promise<unknown> {
      switch (data.mode) {
        case "resolve":
          return { agentId: data.agent ?? String(payload["agent"]), sessionId: data.session ?? "s-1" };
        case "reject":
          throw new Error("scripted backend refused the session");
        case "malformed":
          return { not: "a session" };
        case "hang":
          return await new Promise<never>(() => undefined);
      }
    },
    startTurn(): unknown {
      return { result: Promise.resolve({ status: "completed" }) };
    },
  };
}
