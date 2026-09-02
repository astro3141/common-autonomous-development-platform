/**
 * Process entrypoint (PREFLIGHT §6): compose → open → ingress → tick → shutdown.
 *
 *     node deployment/main.ts --config <path>
 *
 * `main` owns exactly what the survey said it may: configuration, construction, the ingress
 * lifetime, tick cadence and shutdown. `TickStep` is logged and never branched on as authority. A
 * tick that throws is a failed tick — logged, nothing durable harmed (transitions are
 * transactional), and the next tick simply looks at durable state again.
 *
 * Shutdown: stop ingress → let the in-flight tick finish → close the store. Runtime sessions are
 * deliberately not closed — session lifetime belongs to durable state and the adapter, and process
 * exit must never manufacture a Platform lifecycle fact.
 */

import { parseArgs } from "node:util";

import { bootRun } from "./boot.ts";
import { compose } from "./compose.ts";
import { loadConfig } from "./config.ts";
import { startIngress } from "./ingress.ts";
import { startObserver, type ObserverHandle } from "./observer.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      "once": { type: "boolean", default: false },
    },
  });
  if (values.config === undefined) {
    process.stderr.write("usage: node deployment/main.ts --config <path> [--once]\n");
    process.exit(2);
  }

  const config = loadConfig(values.config);
  const composition = compose(config);
  const log = (line: string): void => {
    process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  };

  // §22.2 (finding 3) — reconciliation runs before the ingress exists and before any tick: a
  // restarted mid-flight run is either CONSISTENT, explained fail-closed, or stopped. Nothing
  // external can start ahead of this line.
  const { opened, report } = bootRun(composition);
  const { run_id, batch_id } = opened;
  log(`run ${run_id} batch ${batch_id} store ${config.store_path}`);
  log(
    `startup reconciliation: ${report.classification}` +
      (report.actions.length === 0
        ? ""
        : ` (${report.actions.map((action) => `${action.kind}:${action.subject}`).join(", ")})`),
  );

  // The RA-4 verdict is reported at startup for the operator; the Platform's own fail-closed
  // gating does not depend on this log line — every execution path asks the preflight itself.
  // (An UNEXPLAINED reconciliation already paused the run above; ticks below deliver reports
  // only and start nothing external — Spec §52 requires the explicit human resume.)
  const readiness = composition.deps.preflight();
  log(
    readiness.status === "READY"
      ? "backend preflight READY"
      : `backend preflight BLOCKED: ${readiness.reasons.join(", ")}`,
  );

  const ingress = await startIngress(composition.deps, {
    host: config.ingress.host,
    port: config.ingress.port,
    report_channel: config.report.channel,
    ...(composition.projection === undefined
      ? {}
      : {
          projection: composition.projection,
          projection_base_branch: composition.projection_base_branch,
        }),
  });
  log(`ingress listening on ${config.ingress.host}:${ingress.port()}`);

  // #55 — the read-only observation server lives on its own worker thread with its own read-only
  // store connection, so it keeps answering while a tick blocks this thread inside a model turn.
  let observer: ObserverHandle | null = null;
  if (config.observation !== null) {
    observer = await startObserver({
      store_path: config.store_path,
      port: config.observation.port,
      host: config.observation.host,
    });
    log(`observation surface listening on ${config.observation.host}:${observer.port} (read-only)`);
  }

  let ticking = false;
  let stopped = false;
  const tick = (): void => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      const step = composition.coordinator.tickOnce(run_id);
      if (step !== "NOTHING_TO_DO") log(`tick: ${step}`);
    } catch (error) {
      log(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ticking = false;
    }
  };

  if (values.once === true) {
    tick();
    await ingress.close();
    await observer?.stop();
    composition.dispose();
    return;
  }

  tick();
  const interval = setInterval(tick, config.tick_interval_ms);

  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    log("shutting down");
    await ingress.close();
    await observer?.stop();
    composition.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
