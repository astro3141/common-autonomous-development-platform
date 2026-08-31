/**
 * Platform API ingress — the authoritative Proposal submission transport (TD §5.1, IG-5).
 *
 * Stateless transport over the sealed Core entry points, per §5.1: no policy judgement, no state
 * transition, no side effect of its own. The handler calls `submitProposal` (or the narrow
 * post-gate/human surfaces below) and returns what Core said. MCP is one possible transport of the
 * same API; this one is plain HTTP JSON so a Supervisor, a person or a script can all reach it
 * with nothing installed.
 *
 * Surfaces, all thin:
 *   POST /v1/proposals                    — { run_id, batch_id, proposal } → submitProposal
 *   POST /v1/decisions/:id/resolution     — record a human answer (§17.1d; recording ≠ applying)
 *   POST /v1/decisions/:id/apply-gate     — resolved HUMAN_GATE_APPROVAL → §17.3 revalidation
 *   POST /v1/discovery                    — one fresh discovery/materialization pass (§8.4)
 *   GET  /v1/runs/:run_id                 — read model projection (no authority, no adapters)
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { DecisionAuthorities } from "../core/admission/fact-assembly.ts";
import { resolveHumanGateAndAdmit, submitProposal } from "../core/admission/submit-proposal.ts";
import { materializeDiscoveryPass } from "../core/discovery/materialize.ts";
import type { PlatformStore } from "../core/store/platform-store.ts";
import type { ProductionCoordinatorDependencies } from "../core/coordinator/production-coordinator.ts";
import { isoNow, ulid } from "./identities.ts";

export interface IngressOptions {
  readonly host: string;
  readonly port: number;
  readonly report_channel: string;
}

export interface Ingress {
  readonly server: Server;
  /** The bound port (useful when configured as 0). */
  port(): number;
  close(): Promise<void>;
}

/** Starts the ingress over the shared composition. The returned server is already listening. */
export function startIngress(
  deps: ProductionCoordinatorDependencies,
  options: IngressOptions,
): Promise<Ingress> {
  const authorities: DecisionAuthorities = {
    store: deps.store,
    taskSource: deps.taskSource,
    repository: deps.repository,
    manifests: deps.manifests,
  };

  const server = createServer((request, response) => {
    void handle(request, response, deps.store, authorities, deps, options).catch((error) => {
      fail(response, 500, error instanceof Error ? error.message : String(error));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      resolve({
        server,
        port: () => {
          const address = server.address();
          return typeof address === "object" && address !== null ? address.port : options.port;
        },
        close: () =>
          new Promise((done, failClose) =>
            server.close((error) => (error ? failClose(error) : done())),
          ),
      });
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  store: PlatformStore,
  authorities: DecisionAuthorities,
  deps: ProductionCoordinatorDependencies,
  options: IngressOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://ingress");
  const path = url.pathname;

  if (request.method === "GET") {
    const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(path);
    if (runMatch !== null) {
      return json(response, 200, runProjection(store, decodeURIComponent(runMatch[1] ?? "")));
    }
    return fail(response, 404, "unknown path");
  }

  if (request.method !== "POST") return fail(response, 405, "method not allowed");
  const body = await readJson(request);

  if (path === "/v1/proposals") {
    const { run_id, batch_id, proposal } = body as {
      run_id?: unknown;
      batch_id?: unknown;
      proposal?: unknown;
    };
    if (typeof run_id !== "string" || typeof batch_id !== "string") {
      return fail(response, 400, "run_id and batch_id are required");
    }
    const submitted = submitProposal(authorities, {
      run_id,
      batch_id,
      proposal,
      observed_at: isoNow(),
      decision_id: ulid(),
      report_channel: options.report_channel,
    });
    return json(response, 200, {
      result: submitted.result,
      task_key: submitted.task_key,
      admitted: submitted.admitted,
      pending_decision_id: submitted.pending_decision_id,
    });
  }

  const resolutionMatch = /^\/v1\/decisions\/([^/]+)\/resolution$/.exec(path);
  if (resolutionMatch !== null) {
    const decision_id = decodeURIComponent(resolutionMatch[1] ?? "");
    const { chosen_option, free_form, resolved_by } = body as {
      chosen_option?: unknown;
      free_form?: unknown;
      resolved_by?: unknown;
    };
    if (typeof resolved_by !== "string" || resolved_by.length === 0) {
      return fail(response, 400, "resolved_by is required");
    }
    const record = store.withTransaction(() =>
      store.pendingDecisions.resolve(decision_id, {
        kind: typeof chosen_option === "string" ? "OPTION" : "FREE_FORM",
        chosen_option: typeof chosen_option === "string" ? chosen_option : null,
        free_form: typeof free_form === "string" ? free_form : null,
        resolved_by,
        resolved_at: isoNow(),
        approval_binding: null,
        applied_transition_ref: null,
      }),
    );
    return json(response, 200, { decision_id, status: record.body.status });
  }

  const gateMatch = /^\/v1\/decisions\/([^/]+)\/apply-gate$/.exec(path);
  if (gateMatch !== null) {
    const { run_id, batch_id } = body as { run_id?: unknown; batch_id?: unknown };
    if (typeof run_id !== "string" || typeof batch_id !== "string") {
      return fail(response, 400, "run_id and batch_id are required");
    }
    const applied = resolveHumanGateAndAdmit(authorities, {
      run_id,
      batch_id,
      decision_id: decodeURIComponent(gateMatch[1] ?? ""),
      observed_at: isoNow(),
    });
    return json(response, 200, { result: applied.result, admitted: applied.admitted });
  }

  if (path === "/v1/discovery") {
    const { run_id, batch_id } = body as { run_id?: unknown; batch_id?: unknown };
    if (typeof run_id !== "string" || typeof batch_id !== "string") {
      return fail(response, 400, "run_id and batch_id are required");
    }
    const pass = materializeDiscoveryPass(store, deps.taskSource, {
      run_id,
      batch_id,
      context: { observed_at: isoNow() },
    });
    return json(response, 200, { observed: pass.observations.length });
  }

  return fail(response, 404, "unknown path");
}

/** A read model, not authority: plain durable projections for a person or a Supervisor to read. */
function runProjection(store: PlatformStore, run_id: string): unknown {
  const run = store.runs.get(run_id);
  if (run === undefined) return { run: null };
  const batches = store.batches.forRun(run_id).map((batch) => ({
    batch_id: batch.batch_id,
    status: batch.status,
    admission_closed: batch.admission_closed,
    tasks: store.tasks.inBatch(batch.batch_id).map((task) => ({
      task_key: task.task_key,
      external_task_ref: task.external_task_ref,
      platform_state: task.platform_state,
      state_reason: task.state_reason,
      attempt: projectAttempt(store, task.task_key),
      open_decisions: store.pendingDecisions.openFor(task.task_key).map((record) => ({
        decision_id: record.body.decision_id,
        category: record.body.category,
        question: record.body.question,
        options: record.body.options,
      })),
    })),
  }));
  return { run: { run_id: run.run_id, status: run.status, project_id: run.project_id }, batches };
}

function projectAttempt(store: PlatformStore, task_key: string): unknown {
  const attempt = store.attempts.current(task_key);
  return attempt === undefined
    ? null
    : {
        attempt_key: attempt.attempt_key,
        state: attempt.state,
        candidate_commit: attempt.candidate_commit,
        rework_count: attempt.rework_count,
      };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? {} : (JSON.parse(text) as unknown);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}

function fail(response: ServerResponse, status: number, message: string): void {
  json(response, status, { error: message });
}
