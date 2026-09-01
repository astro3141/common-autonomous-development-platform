/**
 * #55 — the observation server's main-thread handle: spawn, await readiness, stop.
 *
 * The worker owns its own event loop and its own read-only store connection, which is the whole
 * point: `spawnSync`-blocking model turns on the lifecycle thread cannot starve it. See
 * `observer-worker.ts` for the authority boundary.
 */

import { Worker } from "node:worker_threads";

export interface ObserverOptions {
  readonly store_path: string;
  readonly port: number;
  readonly host: string;
}

export interface ObserverHandle {
  /** The actually bound port (useful when options.port is 0). */
  readonly port: number;
  stop(): Promise<void>;
}

export function startObserver(options: ObserverOptions): Promise<ObserverHandle> {
  const worker = new Worker(new URL("./observer-worker.ts", import.meta.url), {
    workerData: {
      store_path: options.store_path,
      port: options.port,
      host: options.host,
    },
  });
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => rejectPromise(error);
    worker.once("error", onError);
    worker.once("message", (message: { kind?: string; port?: number }) => {
      if (message?.kind !== "listening") {
        rejectPromise(new Error("observer worker sent an unexpected first message"));
        return;
      }
      worker.off("error", onError);
      resolvePromise({
        port: message.port ?? options.port,
        stop: () =>
          new Promise((resolveStop) => {
            worker.once("exit", () => resolveStop());
            worker.postMessage({ kind: "stop" });
          }),
      });
    });
  });
}
