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

import { compose } from "./compose.ts";
import { loadConfig } from "./config.ts";
import { startIngress } from "./ingress.ts";
import { openRun } from "./open-run.ts";

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
  const { run_id, batch_id } = openRun(composition);
  const log = (line: string): void => {
    process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  };
  log(`run ${run_id} batch ${batch_id} store ${config.store_path}`);

  // The RA-4 verdict is reported at startup for the operator; the Platform's own fail-closed
  // gating does not depend on this log line — every execution path asks the preflight itself.
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
  });
  log(`ingress listening on ${config.ingress.host}:${ingress.port()}`);

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
    composition.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
