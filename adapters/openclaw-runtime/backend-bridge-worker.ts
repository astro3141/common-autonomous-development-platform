/**
 * The worker that hosts one measured async backend runtime for `BlockingBackendBridge` (#81 I2).
 *
 * It `import()`s the injected factory module, builds the backend once (lazily, on first request),
 * and answers three operations, each of which may be genuinely asynchronous internally while the
 * main thread observes only a synchronous result:
 *
 *   ensureSession(input)   awaits the async backend call and returns its exact {agentId, sessionId}
 *   startTurn({input,key}) starts a turn and tracks its `result` promise to a terminal projection
 *   turnStatus({key})      returns the tracked terminal, or null while running / unknown
 *
 * Every reply is posted to the bridge's private port and then the shared wake counter is bumped so
 * the blocked main thread re-checks. A handler failure is reported as `{ok:false}`; nothing is
 * invented. This module is imported dynamically as a worker entry (mirroring the observer worker),
 * so type stripping applies exactly as in the main thread.
 */

import { parentPort, workerData, type MessagePort } from "node:worker_threads";

interface WorkerData {
  readonly reply_port: MessagePort;
  readonly signal: SharedArrayBuffer;
  readonly factory_module: string;
  readonly factory_data: unknown;
}

interface Backend {
  ensureSession(input: Record<string, unknown>): Promise<unknown> | unknown;
  startTurn(input: Record<string, unknown>): unknown;
}

interface TurnTerminal {
  readonly backend_status: "COMPLETED" | "CANCELLED" | "TIMEOUT" | "RUNTIME_ERROR" | "SESSION_LOST";
  readonly termination_reason: string;
  readonly started_at: string;
  readonly completed_at: string;
}

const data = workerData as WorkerData;
const wake = new Int32Array(data.signal);
const now = (): string => new Date().toISOString();

let backendPromise: Promise<Backend> | undefined;
function backend(): Promise<Backend> {
  backendPromise ??= (async () => {
    const module = (await import(data.factory_module)) as {
      createBackend?: (input: unknown) => Promise<Backend> | Backend;
    };
    if (typeof module.createBackend !== "function") {
      throw new Error(`backend factory ${data.factory_module} has no createBackend export`);
    }
    return await module.createBackend(data.factory_data);
  })();
  return backendPromise;
}

/** null = running/unknown; otherwise the terminal projection. */
const turns = new Map<string, TurnTerminal | null>();

function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function mapTerminal(settled: unknown, started_at: string): TurnTerminal {
  const record = settled as { status?: string; stopReason?: string; error?: { message?: string } } | null;
  const status = record?.status;
  return {
    backend_status:
      status === "completed"
        ? "COMPLETED"
        : status === "cancelled"
          ? "CANCELLED"
          : "RUNTIME_ERROR",
    termination_reason: record?.stopReason ?? record?.error?.message ?? String(status),
    started_at,
    completed_at: now(),
  };
}

async function handle(op: string, payload: Record<string, unknown>): Promise<unknown> {
  const runtime = await backend();
  if (op === "ensureSession") {
    return await runtime.ensureSession(payload);
  }
  if (op === "startTurn") {
    const key = payload["key"] as string;
    const input = payload["input"] as Record<string, unknown>;
    const started_at = now();
    turns.set(key, null);
    const turn = runtime.startTurn(input);
    const result = (turn as { result?: unknown } | null)?.result;
    if (!isThenable(result)) {
      turns.delete(key);
      throw new Error("startTurn answered without the audited { result: Promise } shape");
    }
    void (result as Promise<unknown>).then(
      (settled) => turns.set(key, mapTerminal(settled, started_at)),
      (error: unknown) =>
        turns.set(key, {
          backend_status: "RUNTIME_ERROR",
          termination_reason: error instanceof Error ? error.message : String(error),
          started_at,
          completed_at: now(),
        }),
    );
    return null;
  }
  if (op === "turnStatus") {
    return turns.get(payload["key"] as string) ?? null;
  }
  throw new Error(`unknown backend bridge op ${JSON.stringify(op)}`);
}

parentPort?.on("message", (message: { id: number; op: string; payload: Record<string, unknown> }) => {
  void (async () => {
    let reply: { id: number; ok: boolean; value?: unknown; error?: string };
    try {
      reply = { id: message.id, ok: true, value: await handle(message.op, message.payload) };
    } catch (error) {
      reply = { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    data.reply_port.postMessage(reply);
    Atomics.add(wake, 0, 1);
    Atomics.notify(wake, 0);
  })();
});
