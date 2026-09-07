import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { loadManifest, spawnComponent, spawnComponentSandboxed } from "./env.ts";
import { imageIdentity } from "../product/isolation.ts";
import type { DeploymentComponentRunner, ComponentIdentity } from "../kernel/adapters/deploymentActuation.ts";

export type LiveComponent = "broker" | "worker";

/** The single implementation used by both ctl and governed deployment actuation. */
export function killLiveComponent(dir: string, name: string): void {
  const pidFile = join(dir, `${name}.pid`);
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  try { process.kill(pid, "SIGKILL"); } catch { /* ctl's existing best-effort kill semantics */ }
}

export function startLiveComponent(dir: string, name: LiveComponent): void {
  const m = loadManifest(dir);
  const repoRoot = join(import.meta.dirname, "..", "..");
  if (name === "broker") {
    const egress = JSON.parse(readFileSync(join(dir, "egress.json"), "utf8")) as { network: string; proxy: string };
    spawnComponentSandboxed(dir, "broker", "node", [join(repoRoot, "cadp/product/surfaceBroker.ts")], {
      CADP_BROKER_PORT: String(m.broker_port),
      CADP_WORKER_IMAGE: readFileSync(join(dir, "worker-image"), "utf8").trim(),
      CADP_EGRESS_NETWORK: egress.network,
      CADP_EGRESS_PROXY: egress.proxy,
      CADP_FAILED_SESSIONS_DIR: join(dir, "failed-sessions"),
    }, [join(dir, "secret")]);
    return;
  }

  mkdirSync(join(dir, "worker-tmp"), { recursive: true });
  spawnComponentSandboxed(dir, "worker", "node", [join(repoRoot, "cadp/product/worker.ts")], {
    CADP_KERNEL_URL: m.api_url,
    CADP_WORKFLOW_TOKEN: m.tokens["cadp-workflow"]!,
    CADP_VERIFIER_TOKEN: m.tokens["cadp-verifier"]!,
    CADP_REVIEWER_TOKEN: m.tokens["cadp-reviewer-claude"]!,
    ...(m.tokens["cadp-reviewer-grok"] !== undefined ? { CADP_REVIEWER_TOKEN_GROK: m.tokens["cadp-reviewer-grok"]! } : {}),
    ...(m.tokens["cadp-reviewer-codex"] !== undefined ? { CADP_REVIEWER_TOKEN_CODEX: m.tokens["cadp-reviewer-codex"]! } : {}),
    ...(m.tokens["cadp-backend-scan-claude"] !== undefined ? { CADP_BACKEND_SCAN_TOKEN_CLAUDE: m.tokens["cadp-backend-scan-claude"]! } : {}),
    ...(m.tokens["cadp-verifier-actions"] !== undefined ? { CADP_VERIFIER_ACTIONS_TOKEN: m.tokens["cadp-verifier-actions"]! } : {}),
    CADP_BACKEND_SCAN_TOKEN: m.tokens["cadp-backend-scan"]!,
    CADP_BACKEND_SCAN_TOKEN_GROK: m.tokens["cadp-backend-scan-grok"]!,
    CADP_TEMPORAL_ADDRESS: `127.0.0.1:${m.temporal_port}`,
    CADP_TEMPORAL_NAMESPACE: "cadp-v04",
    CADP_TASK_QUEUE: "cadp-worker",
    CADP_BROKER_URL: `http://127.0.0.1:${m.broker_port}`,
  }, [join(dir, "secret")], [m.api_port, m.temporal_port, m.broker_port]);
}

export function liveDeploymentComponentRunner(dir: string): DeploymentComponentRunner {
  const repoRoot = join(import.meta.dirname, "..", "..");
  return {
    async observe(component): Promise<ComponentIdentity> {
      const pid = Number(readFileSync(join(dir, `${component}.pid`), "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid ${component} pid file`);
      const code_sha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const workerImage = readFileSync(join(dir, "worker-image"), "utf8").trim();
      return { code_sha, image_digest: imageIdentity(workerImage).image_digest, pid };
    },
    async kill(component) { killLiveComponent(dir, component); },
    async start(component) { startLiveComponent(dir, component); },
  };
}
