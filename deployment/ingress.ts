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
 *   GET  /v1/dashboard/:run_id            — operator dashboard: HTML over the read-only projections
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { DecisionAuthorities } from "../core/admission/fact-assembly.ts";
import { resolveHumanGateAndAdmit, submitProposal } from "../core/admission/submit-proposal.ts";
import { monitorOnce } from "../core/coordinator/monitor.ts";
import { recoverRun } from "../core/coordinator/production-recovery.ts";
import {
  buildRoutingRecommendations,
  diagnosticPacket,
  listFindings,
  measurementPacket,
  recordFinding,
  type ImprovementFindingV1Body,
} from "../core/operability/index.ts";
import { commitBatchResumeFromPause } from "../core/statemachine/transition-commit.ts";
import { materializeDiscoveryPass } from "../core/discovery/materialize.ts";
import type { PlatformStore } from "../core/store/platform-store.ts";
import type { ProductionCoordinatorDependencies } from "../core/coordinator/production-coordinator.ts";
import { renderDashboard, type DashboardSnapshot } from "./dashboard.ts";
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
    // §22.5 — read-only anomaly observation. No transition, no retry, no actuation.
    const monitorMatch = /^\/v1\/runs\/([^/]+)\/monitor$/.exec(path);
    if (monitorMatch !== null) {
      const monitored = monitorOnce(
        { store: deps.store, runtime: deps.runtime, repository: deps.repository, verification: deps.verification },
        {
        run_id: decodeURIComponent(monitorMatch[1] ?? ""),
        now: isoNow(),
        trigger_config: {
          stale_after_ms: readNumber(url.searchParams.get("stale_after_ms"), 30 * 60_000),
          intent_unresolved_after_ms: readNumber(
            url.searchParams.get("intent_unresolved_after_ms"),
            10 * 60_000,
          ),
            config_ref: "ingress-defaults-v1",
          },
        },
      );
      return json(response, 200, monitored);
    }
    // §5.11 — the diagnostic packet: per-field provenance, partial-tolerant, zero authority.
    const diagnosticMatch = /^\/v1\/diagnostics\/(.+)$/.exec(path);
    if (diagnosticMatch !== null) {
      return json(
        response,
        200,
        diagnosticPacket(
          { store, repository: deps.repository },
          decodeURIComponent(diagnosticMatch[1] ?? ""),
        ),
      );
    }
    // §5.12 — the attempt-level measurement aggregate. UNKNOWN is an answer, never estimated.
    const measurementMatch = /^\/v1\/measurements\/(.+)$/.exec(path);
    if (measurementMatch !== null) {
      return json(
        response,
        200,
        measurementPacket(store, decodeURIComponent(measurementMatch[1] ?? "")),
      );
    }
    // §5.13 — recorded findings, re-read and hash-verified from the blob chain.
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
    // §5.14 — read-only routing recommendations. Evidence for a person, never a policy input.
    const routingMatch = /^\/v1\/runs\/([^/]+)\/routing-recommendations$/.exec(path);
    if (routingMatch !== null) {
      return json(response, 200, {
        recommendations: buildRoutingRecommendations(store, {
          run_id: decodeURIComponent(routingMatch[1] ?? ""),
          generated_at: isoNow(),
        }),
      });
    }
    // §5.11 — the operator dashboard. It renders the projections above and nothing else: no store
    // query of its own, no adapter call of its own, and — being inside the GET-only block with a
    // pure renderer — no path by which a page could reach a transition.
    const dashboardMatch = /^\/v1\/dashboard\/(.+)$/.exec(path);
    if (dashboardMatch !== null) {
      return html(
        response,
        200,
        renderDashboard(dashboardSnapshot(deps, decodeURIComponent(dashboardMatch[1] ?? ""))),
      );
    }
    return fail(response, 404, "unknown path");
  }

  if (request.method !== "POST") return fail(response, 405, "method not allowed");
  const body = await readJson(request);

  // §5.13 — record a Finding. Evidence must resolve or the record is refused; recording changes
  // no lifecycle state, and re-execution goes through the ordinary admission path only.
  if (path === "/v1/findings") {
    const input = body as Partial<ImprovementFindingV1Body> & { classifier_ref?: string };
    const recorded = recordFinding(store, {
      finding_id: input.finding_id ?? ulid(),
      subject_ref: input.subject_ref ?? "",
      classification: input.classification as ImprovementFindingV1Body["classification"],
      summary: input.summary ?? "",
      evidence_refs: input.evidence_refs ?? [],
      observation_refs: input.observation_refs ?? [],
      discovered_at: input.discovered_at ?? isoNow(),
      classifier: (input.classifier ?? "HUMAN") as ImprovementFindingV1Body["classifier"],
      classifier_ref: input.classifier_ref ?? "ingress",
      escaped_from: input.escaped_from ?? null,
      supersedes_finding_ref: input.supersedes_finding_ref ?? null,
    });
    return json(response, 200, recorded);
  }
  
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

  // §22.2 — one full reconciliation pass over a run, applied through the sealed guards.
  const recoverMatch = /^\/v1\/runs\/([^/]+)\/recover$/.exec(path);
  if (recoverMatch !== null) {
    const report = recoverRun(deps, { run_id: decodeURIComponent(recoverMatch[1] ?? "") });
    return json(response, 200, report);
  }

  // Spec §52 — the explicit human exit from PAUSED_SAFELY: reconcile first, resume only on
  // CONSISTENT, and never touch the fail-closed task/attempt states.
  const resumeMatch = /^\/v1\/runs\/([^/]+)\/resume$/.exec(path);
  if (resumeMatch !== null) {
    const run_id = decodeURIComponent(resumeMatch[1] ?? "");
    const report = recoverRun(deps, { run_id });
    // Spec §52 — resumption requires the world to reconcile *completely*. A pass that had to
    // apply anything (a hold, a pause, an unavailable capability boundary) is not a clean bill:
    // resuming over it would re-enter exactly the state recovery just refused (finding 5).
    if (report.classification !== "CONSISTENT") {
      return json(response, 409, { error: "the run does not reconcile", report });
    }
    const resumed: string[] = [];
    for (const batch of store.batches.forRun(run_id)) {
      if (batch.status !== "PAUSED_SAFELY") continue;
      commitBatchResumeFromPause(store, { batch_id: batch.batch_id });
      resumed.push(batch.batch_id);
    }
    return json(response, 200, { resumed, report });
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

/**
 * Gathers exactly the projections the JSON surfaces above already expose, and nothing more. Every
 * read here is one of `runProjection`, `monitorOnce`, `diagnosticPacket`, `measurementPacket` or
 * `listFindings`; the dashboard introduces no query of its own against the store's tables.
 *
 * A projection that throws is dropped rather than defaulted — §5.11's partial-result rule — so one
 * unavailable derivation never costs the whole page, and nothing missing is filled in.
 */
function dashboardSnapshot(
  deps: ProductionCoordinatorDependencies,
  run_id: string,
): DashboardSnapshot {
  const store = deps.store;

  const attempt = (subject: unknown): string | null => {
    const key = (subject as { attempt_key?: string } | null | undefined)?.attempt_key;
    return typeof key === "string" ? key : null;
  };
  const tolerate = <T>(read: () => T): T | null => {
    try {
      return read();
    } catch {
      return null;
    }
  };

  const run = tolerate(() => runProjection(store, run_id));
  const attemptKeys = ((run as { batches?: readonly { tasks?: readonly unknown[] }[] } | null)
    ?.batches ?? [])
    .flatMap((batch) => batch.tasks ?? [])
    .map((task) => attempt((task as { attempt?: unknown }).attempt))
    .filter((key): key is string => key !== null);

  const monitor = tolerate(() =>
          monitorOnce(deps, {
            run_id,
            now: isoNow(),
            trigger_config: {
              stale_after_ms: 30 * 60_000,
              intent_unresolved_after_ms: 10 * 60_000,
              config_ref: "dashboard-defaults-v1",
            },
          }),
  );

  const subjects = [run_id, ...attemptKeys];
  const diagnostics = subjects
    .map((subject) =>
      tolerate(() => diagnosticPacket({ store, repository: deps.repository }, subject)),
    )
    .filter((packet): packet is NonNullable<typeof packet> => packet !== null);

  const measurements = attemptKeys
    .map((attempt_key) => {
      const packet = tolerate(() => measurementPacket(store, attempt_key));
      return packet === null ? null : { attempt_key, packet };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const findings = (tolerate(() => listFindings(store)) ?? []).map((finding) => ({
    finding_id: finding.body.finding_id,
    classification: finding.body.classification,
    subject_ref: finding.body.subject_ref,
    summary: finding.body.summary,
  }));

  return {
    generated_at: isoNow(),
    run_id,
    run,
    monitor: monitor as DashboardSnapshot["monitor"],
    diagnostics,
    measurements,
    findings,
  };
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}

function fail(response: ServerResponse, status: number, message: string): void {
  json(response, status, { error: message });
}

function readNumber(value: string | null, fallback: number): number {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
