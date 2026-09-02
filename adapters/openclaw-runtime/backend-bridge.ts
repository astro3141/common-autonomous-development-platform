/**
 * BlockingBackendBridge — the adapter-local blocking facade over a measured **asynchronous**
 * backend runtime (TD §13.1/§30.2, #81 I2).
 *
 * The sealed `RuntimeAdapter`/`OpenClawGatewaySeam` surface is synchronous, and the audited
 * `AcpRuntime.ensureSession` is `async`. Rather than reopen the Core contract, this bridge hosts
 * the backend runtime in one long-lived worker thread and turns each backend operation into a
 * synchronous call: the main thread posts a request and blocks on `Atomics.wait` until the worker
 * posts the *authoritative backend return*, correlated by request id and read with
 * `receiveMessageOnPort` (no main-thread event loop, so no reentrancy).
 *
 * Fail-closed by construction: a rejection surfaces as `GatewayUnavailable` with no fabricated
 * ref; a never-settling operation hits the bounded timeout and fails (never a fabricated success),
 * with its stale reply discarded on the next call; a malformed backend value is caught by the
 * gateway's own shape checks. Nothing here invents session/turn identity, retries a spent
 * operation, or lets a raw trusted credential escape the worker — the whole bridge lives below the
 * gateway's I-TD5/I-TD7 boundary.
 */

import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
  type MessagePort,
} from "node:worker_threads";

import { GatewayUnavailable } from "./gateway-seam.ts";

/** The terminal turn projection the worker computes, mirroring `GatewayTurnStatus`. */
export interface BackendTurnTerminal {
  readonly backend_status: "COMPLETED" | "CANCELLED" | "TIMEOUT" | "RUNTIME_ERROR" | "SESSION_LOST";
  readonly termination_reason: string;
  readonly started_at: string;
  readonly completed_at: string;
}

export interface BlockingBackendBridgeOptions {
  /** URL string the worker `import()`s; its `createBackend(factory_data)` returns the backend. */
  readonly factory_module: string;
  readonly factory_data: unknown;
  /** Bounded wait for any one backend operation; a slower operation fails closed. */
  readonly timeout_ms: number;
}

interface WorkerReply {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

export class BlockingBackendBridge {
  readonly #worker: Worker;
  readonly #port: MessagePort;
  readonly #signal: Int32Array;
  readonly #timeout: number;
  #seq = 0;
  #fatal: string | undefined;
  #disposed = false;

  constructor(options: BlockingBackendBridgeOptions) {
    const channel = new MessageChannel();
    const shared = new SharedArrayBuffer(4);
    this.#signal = new Int32Array(shared);
    this.#port = channel.port1;
    this.#timeout = options.timeout_ms;
    this.#worker = new Worker(new URL("./backend-bridge-worker.ts", import.meta.url), {
      workerData: {
        reply_port: channel.port2,
        signal: shared,
        factory_module: options.factory_module,
        factory_data: options.factory_data,
      },
      transferList: [channel.port2],
    });
    // The bridge must not keep the process alive on its own; the composition disposes it.
    this.#worker.unref();
    this.#worker.on("error", (error: Error) => {
      // A worker-level crash is a fatal, fail-closed condition for every subsequent call — never
      // a success. In-flight callers observe it as their bounded timeout.
      this.#fatal = error.message;
    });
  }

  /** One backend operation, synchronously. Throws `GatewayUnavailable` on any non-success. */
  call(op: string, payload: unknown): unknown {
    if (this.#disposed) throw new GatewayUnavailable("the backend bridge is disposed");
    if (this.#fatal !== undefined) {
      throw new GatewayUnavailable(`the backend worker failed fatally: ${this.#fatal}`);
    }
    const id = ++this.#seq;
    this.#worker.postMessage({ id, op, payload });

    const deadline = Date.now() + this.#timeout;
    for (;;) {
      const matched = this.#drain(id);
      if (matched !== undefined) {
        if (matched.ok) return matched.value;
        throw new GatewayUnavailable(matched.error ?? `backend ${op} failed`);
      }
      if (this.#fatal !== undefined) {
        throw new GatewayUnavailable(`the backend worker failed fatally: ${this.#fatal}`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Bounded fail-closed: no fabricated result. A late reply is discarded by id next call.
        throw new GatewayUnavailable(
          `backend ${op} did not return within ${this.#timeout}ms; failing closed`,
        );
      }
      const observed = Atomics.load(this.#signal, 0);
      Atomics.wait(this.#signal, 0, observed, remaining);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    void this.#worker.terminate();
  }

  /** Reads every currently-available reply, returning the one for `id` (stale ones are dropped). */
  #drain(id: number): WorkerReply | undefined {
    let found: WorkerReply | undefined;
    for (;;) {
      const message = receiveMessageOnPort(this.#port);
      if (message === undefined) break;
      const reply = message.message as WorkerReply;
      if (reply.id === id) found = reply;
      // Any reply with a different id is from a timed-out earlier call and is dropped.
    }
    return found;
  }
}
