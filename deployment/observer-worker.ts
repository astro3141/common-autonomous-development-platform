/**
 * #55 — the observation worker. Runs inside a `node:worker_threads` Worker with its own event
 * loop and its own SQLite-enforced read-only store connection, so the read-only surface answers
 * while the lifecycle thread is blocked inside a model turn.
 *
 * Authority map unchanged (§22.1): this thread owns nothing. Writes fail at the database; there
 * is no POST surface, no adapter, no transition path. Adapter-backed observations are honestly
 * absent: the monitor runs with an unqueryable runtime and no repository/verification authority,
 * so `authority_coverage` reports what this surface actually could and could not observe (#47's
 * merged semantics) instead of pretending.
 */

import { createServer, type ServerResponse } from "node:http";
import { parentPort, workerData } from "node:worker_threads";

import type { RuntimeAdapter } from "../adapters/interfaces/runtime-adapter.ts";
import { monitorOnce } from "../core/coordinator/monitor.ts";
import { diagnosticPacket } from "../core/operability/diagnostics.ts";
import { listFindings } from "../core/operability/finding.ts";
import { measurementPacket } from "../core/operability/measurement.ts";
import { buildRoutingRecommendations } from "../core/operability/routing.ts";
import { PlatformStore } from "../core/store/platform-store.ts";
import { runProjection } from "./projections.ts";

interface ObserverWorkerData {
  readonly store_path: string;
  readonly port: number;
  readonly host: string;
}

const data = workerData as ObserverWorkerData;
const store = PlatformStore.open(data.store_path, { read_only: true });

/** This surface holds no runtime authority; a query through it is an honest failed observation. */
const unqueryableRuntime = {
  get_turn_result(): never {
    throw new Error("the observation surface holds no runtime authority");
  },
} as unknown as RuntimeAdapter;

const server = createServer((request, response) => {
  try {
    if (request.method !== "GET") return fail(response, 405, "observation surface is read-only");
    const url = new URL(request.url ?? "/", "http://observer");
    const path = url.pathname;

    const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(path);
    if (runMatch !== null) {
      return json(response, 200, runProjection(store, decodeURIComponent(runMatch[1] ?? "")));
    }
    const monitorMatch = /^\/v1\/runs\/([^/]+)\/monitor$/.exec(path);
    if (monitorMatch !== null) {
      return json(
        response,
        200,
        monitorOnce(
          { store, runtime: unqueryableRuntime },
          {
            run_id: decodeURIComponent(monitorMatch[1] ?? ""),
            now: new Date().toISOString(),
            trigger_config: {
              stale_after_ms: readNumber(url.searchParams.get("stale_after_ms"), 30 * 60_000),
              intent_unresolved_after_ms: readNumber(
                url.searchParams.get("intent_unresolved_after_ms"),
                10 * 60_000,
              ),
              config_ref: "observer-defaults-v1",
            },
          },
        ),
      );
    }
    const diagnosticMatch = /^\/v1\/diagnostics\/(.+)$/.exec(path);
    if (diagnosticMatch !== null) {
      return json(response, 200, diagnosticPacket({ store }, decodeURIComponent(diagnosticMatch[1] ?? "")));
    }
    const measurementMatch = /^\/v1\/measurements\/(.+)$/.exec(path);
    if (measurementMatch !== null) {
      return json(response, 200, measurementPacket(store, decodeURIComponent(measurementMatch[1] ?? "")));
    }
    if (path === "/v1/findings") {
      return json(response, 200, {
        findings: listFindings(store).map((finding) => ({
          finding_id: finding.body.finding_id,
          finding_hash: finding.finding_hash,
          subject_ref: finding.body.subject_ref,
          classification: finding.body.classification,
          summary: finding.body.summary,
          supersedes_finding_ref: finding.body.supersedes_finding_ref,
        })),
      });
    }
    const routingMatch = /^\/v1\/runs\/([^/]+)\/routing-recommendations$/.exec(path);
    if (routingMatch !== null) {
      return json(response, 200, {
        recommendations: buildRoutingRecommendations(store, {
          run_id: decodeURIComponent(routingMatch[1] ?? ""),
          generated_at: new Date().toISOString(),
        }),
      });
    }
    return fail(response, 404, "unknown path");
  } catch (error) {
    // §5.11 — an unreadable projection is an error answer, never a hang and never a guess.
    return fail(response, 500, error instanceof Error ? error.message : String(error));
  }
});

server.listen(data.port, data.host, () => {
  const address = server.address();
  parentPort?.postMessage({
    kind: "listening",
    port: typeof address === "object" && address !== null ? address.port : data.port,
  });
});

parentPort?.on("message", (message: unknown) => {
  if ((message as { kind?: string } | null)?.kind === "stop") {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  }
});

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function fail(response: ServerResponse, status: number, message: string): void {
  json(response, status, { error: message });
}

function readNumber(value: string | null, fallback: number): number {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
