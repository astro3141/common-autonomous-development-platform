/**
 * The activity-host → surface-broker transport (#128).
 *
 * The seam is localhost HTTP (TD §4.1: the activity host's egress is pinned to the broker port),
 * but the request is long-running: `/implement` holds the connection for as long as the isolated
 * worker container runs. Node's global `fetch` cannot express that — undici applies an implicit
 * ~300s response-headers timeout that #127 measured killing three healthy in-bound attempts at
 * ~301s (`UND_ERR_HEADERS_TIMEOUT`) while their containers were still working.
 *
 * This module therefore drives `node:http` directly, where every bound is one WE set:
 *
 *   - the socket-inactivity bound (`timeout`) is the declared RPC budget, not a library default,
 *     so nothing shorter can preempt an in-bound response;
 *   - a total deadline covers headers AND body, so a stalled body is bounded too;
 *   - the budget must be finite and positive — an unbounded/infinite RPC is refused up front;
 *   - a request that hits either bound is destroyed and REJECTS. A partial body, an aborted
 *     response and a non-2xx status are failures; none of them can become a value the caller
 *     mistakes for a completed surface run.
 */

import { request as httpRequest } from "node:http";

/** The declared transport budget of one RPC. */
export interface BrokerRpcBudget {
  /** Total budget for the whole response (headers + body), in ms. Finite and positive. */
  readonly rpc_ms: number;
}

/** A bounded transport failure: the declared budget expired before the response completed. */
export class BrokerRpcTimeoutError extends Error {
  readonly path: string;
  readonly phase: "RESPONSE_HEADERS" | "RESPONSE_BODY";
  readonly budget_ms: number;
  readonly elapsed_ms: number;

  constructor(path: string, phase: "RESPONSE_HEADERS" | "RESPONSE_BODY", budget_ms: number, elapsed_ms: number) {
    super(`broker ${path} exceeded its declared ${budget_ms}ms RPC budget after ${elapsed_ms}ms (${phase})`);
    this.name = "BrokerRpcTimeoutError";
    this.path = path;
    this.phase = phase;
    this.budget_ms = budget_ms;
    this.elapsed_ms = elapsed_ms;
  }
}

/**
 * POST a JSON body to the broker and return its parsed JSON response, under the declared budget.
 * Rejects — never resolves — on timeout, transport error, non-2xx status or unparseable body.
 */
export function brokerPostJson<T>(base_url: string, path: string, body: unknown, budget: BrokerRpcBudget): Promise<T> {
  const rpc_ms = budget.rpc_ms;
  if (!Number.isFinite(rpc_ms) || rpc_ms <= 0) {
    return Promise.reject(new Error(`broker ${path} RPC budget must be finite and positive (got ${String(rpc_ms)})`));
  }
  let url: URL;
  try {
    url = new URL(path, base_url);
  } catch {
    return Promise.reject(new Error(`broker base url is not a url: ${base_url}`));
  }
  if (url.protocol !== "http:") {
    return Promise.reject(new Error(`broker seam is localhost HTTP; refusing ${url.protocol} (${url.href})`));
  }
  const payload = Buffer.from(JSON.stringify(body ?? {}), "utf8");
  const started = Date.now();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let headersSeen = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      reject(error);
    };
    const succeed = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    const expired = (): BrokerRpcTimeoutError =>
      new BrokerRpcTimeoutError(path, headersSeen ? "RESPONSE_BODY" : "RESPONSE_HEADERS", rpc_ms, Date.now() - started);

    const req = httpRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === "" ? undefined : url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
          connection: "close",
        },
        // Explicit socket-inactivity bound: the ONLY response-headers timeout on this seam.
        timeout: rpc_ms,
        // A dedicated agent per call: no pooled/keep-alive socket state between surface runs.
        agent: false,
      },
      (res) => {
        headersSeen = true;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("aborted", () => fail(new Error(`broker ${path} response aborted after ${Date.now() - started}ms`)));
        res.on("error", (error: Error) => fail(new Error(`broker ${path} response error after ${Date.now() - started}ms: ${error.message}`)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            fail(new Error(`broker ${path} ${status}: ${text.slice(0, 300)}`));
            return;
          }
          let parsed: T;
          try {
            parsed = JSON.parse(text) as T;
          } catch {
            fail(new Error(`broker ${path} returned unparseable JSON (${text.length} bytes): ${text.slice(0, 200)}`));
            return;
          }
          succeed(parsed);
        });
      },
    );

    // Total deadline: headers AND body. Cleared on every settle path.
    const deadline = setTimeout(() => fail(expired()), rpc_ms);

    req.on("timeout", () => fail(expired()));
    req.on("error", (error: Error) => fail(new Error(`broker ${path} transport error after ${Date.now() - started}ms: ${error.message}`)));
    req.end(payload);
  });
}
