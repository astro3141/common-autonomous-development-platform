/**
 * Temporal worker entry (TD §11): runs `cadpWork` workflows + activities on the
 * `cadp-worker` task queue. Holds the workflow-identity kernel token; NEVER a governed
 * target credential. Run: node cadp/product/worker.ts (env-configured).
 */

import { Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";

import * as activities from "./activities.ts";

async function main(): Promise<void> {
  const worker = await Worker.create({
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities,
    taskQueue: process.env["CADP_TASK_QUEUE"] ?? "cadp-worker",
    namespace: process.env["CADP_TEMPORAL_NAMESPACE"] ?? "cadp-v04",
    maxConcurrentActivityTaskExecutions: 2,
  });
  console.log(JSON.stringify({ worker: "started", pid: process.pid }));
  await worker.run();
}

main().catch((error) => {
  console.error("worker failed:", error);
  process.exit(1);
});
