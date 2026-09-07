/** The single live-component implementation shared by ctl and governed DEPLOY. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { imageIdentity } from "../product/isolation.ts";
import { loadManifest, spawnComponent, spawnComponentSandboxed } from "./env.ts";

export type DeployableComponent = "broker" | "worker";
export interface ComponentIdentity { code_sha: string; image_digest: string; pid: number }
export interface ComponentRunner { observe(name: DeployableComponent): ComponentIdentity; kill(name: DeployableComponent): void; start(name: DeployableComponent): void }

const root = join(import.meta.dirname, "..", "..");
const identityFile = (dir: string, name: string) => join(dir, `${name}.identity.json`);

export function observeComponentIdentity(dir: string, name: DeployableComponent): ComponentIdentity {
  const pid = Number(readFileSync(join(dir, `${name}.pid`), "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid ${name} pid`);
  if (!existsSync(identityFile(dir, name))) throw new Error(`${name} identity observation unavailable`);
  const identity = JSON.parse(readFileSync(identityFile(dir, name), "utf8")) as ComponentIdentity;
  if (identity.pid !== pid) throw new Error(`${name} identity pid does not match pid file`);
  return identity;
}

export function killComponent(dir: string, name: string): void {
  const path = join(dir, `${name}.pid`);
  if (!existsSync(path)) return console.log(JSON.stringify({ [name]: "no pid file" }));
  const pid = Number(readFileSync(path, "utf8").trim());
  try { process.kill(pid, "SIGKILL"); console.log(JSON.stringify({ killed: name, pid })); }
  catch (error) { console.log(JSON.stringify({ [name]: `kill failed: ${(error as Error).message}` })); }
}

export function startComponent(dir: string, name: string): number {
  const m = loadManifest(dir);
  let pid: number;
  switch (name) {
    case "record": pid = spawnComponent(dir, name, "node", [join(root, "cadp/product/recordService.ts"), String(m.record_port), join(dir, "record-service.sqlite")], { RECORD_SERVICE_API_KEY: readFileSync(join(dir, "secret", "record-api-key"), "utf8").trim() }); break;
    case "temporal": pid = spawnComponent(dir, name, "temporal", ["server", "start-dev", "--headless", "--port", String(m.temporal_port), "--ui-port", String(m.temporal_ui_port), "--db-filename", join(dir, "temporal.sqlite"), "--namespace", "cadp-v04"]); break;
    case "kernel": pid = spawnComponent(dir, name, "node", [join(root, "cadp/kernel/kernelService.ts"), m.kernel_config_path]); break;
    case "broker": {
      const egress = JSON.parse(readFileSync(join(dir, "egress.json"), "utf8")) as { network: string; proxy: string };
      pid = spawnComponentSandboxed(dir, name, "node", [join(root, "cadp/product/surfaceBroker.ts")], { CADP_BROKER_PORT: String(m.broker_port), CADP_WORKER_IMAGE: readFileSync(join(dir, "worker-image"), "utf8").trim(), CADP_EGRESS_NETWORK: egress.network, CADP_EGRESS_PROXY: egress.proxy, CADP_FAILED_SESSIONS_DIR: join(dir, "failed-sessions") }, [join(dir, "secret")]); break;
    }
    case "worker": {
      mkdirSync(join(dir, "worker-tmp"), { recursive: true });
      const env = { CADP_KERNEL_URL: m.api_url, CADP_WORKFLOW_TOKEN: m.tokens["cadp-workflow"]!, CADP_VERIFIER_TOKEN: m.tokens["cadp-verifier"]!, CADP_REVIEWER_TOKEN: m.tokens["cadp-reviewer-claude"]!, ...(m.tokens["cadp-reviewer-grok"] ? { CADP_REVIEWER_TOKEN_GROK: m.tokens["cadp-reviewer-grok"]! } : {}), ...(m.tokens["cadp-reviewer-codex"] ? { CADP_REVIEWER_TOKEN_CODEX: m.tokens["cadp-reviewer-codex"]! } : {}), ...(m.tokens["cadp-backend-scan-claude"] ? { CADP_BACKEND_SCAN_TOKEN_CLAUDE: m.tokens["cadp-backend-scan-claude"]! } : {}), ...(m.tokens["cadp-verifier-actions"] ? { CADP_VERIFIER_ACTIONS_TOKEN: m.tokens["cadp-verifier-actions"]! } : {}), CADP_BACKEND_SCAN_TOKEN: m.tokens["cadp-backend-scan"]!, CADP_BACKEND_SCAN_TOKEN_GROK: m.tokens["cadp-backend-scan-grok"]!, CADP_TEMPORAL_ADDRESS: `127.0.0.1:${m.temporal_port}`, CADP_TEMPORAL_NAMESPACE: "cadp-v04", CADP_TASK_QUEUE: "cadp-worker", CADP_BROKER_URL: `http://127.0.0.1:${m.broker_port}` };
      pid = spawnComponentSandboxed(dir, name, "node", [join(root, "cadp/product/worker.ts")], env, [join(dir, "secret")], [m.api_port, m.temporal_port, m.broker_port]); break;
    }
    default: throw new Error(`unknown component ${name}`);
  }
  if (name === "broker" || name === "worker") writeFileSync(identityFile(dir, name), JSON.stringify({ code_sha: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), image_digest: imageIdentity(readFileSync(join(dir, "worker-image"), "utf8").trim()).image_digest, pid }));
  console.log(JSON.stringify({ started: name }));
  return pid;
}

export const liveComponentRunner = (dir: string): ComponentRunner => ({ observe: (name) => observeComponentIdentity(dir, name), kill: (name) => killComponent(dir, name), start: (name) => { startComponent(dir, name); } });
