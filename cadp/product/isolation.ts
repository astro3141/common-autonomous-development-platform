/**
 * OS-level surface isolation (TD §4.1). Env scrubbing is not a boundary against a same-UID
 * process; untrusted worker/reviewer/verifier code runs inside an enforceable OS + network
 * boundary:
 *
 *  - Filesystem: surfaces run in Docker containers with NO host mount except a fresh /ws
 *    checkout (and, for the worker, a read-only auth.json). The PEP secret dir and manifest
 *    are unreachable.
 *  - Network (egress policy, not DNS pinning): worker and reviewer run on an `--internal`
 *    docker network — no route to the internet at all, so every governed target (GitHub, the
 *    record service, the Kernel API, by name / literal IP / docker gateway) is unreachable.
 *    The ONLY hole is a dual-homed allowlist CONNECT proxy that forwards to the model provider
 *    hosts and refuses everything else. The verifier gets `--network none` (needs nothing).
 *  - Version exactness: the image pins the TD §11 reference surfaces; the built-image digest
 *    and observed tool versions are bound into the reach/WORK_START evidence.
 *
 * The SAME construction is what CREDENTIAL_REACH_ATTESTATION measures.
 */

import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface IsolationConfig {
  /** Pinned surface image (name:tag). */
  readonly worker_image: string;
  /** `--internal` docker network the surfaces run on (no direct internet). */
  readonly egress_network: string;
  /** `host:port` of the allowlist proxy on that network (worker/reviewer HTTPS_PROXY). */
  readonly egress_proxy: string;
}

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const PROXY_SCRIPT = fileURLToPath(new URL("../live/egressProxy.mjs", import.meta.url));

function collect(child: ReturnType<typeof spawn>, timeout_ms: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout_ms);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 127, stdout: "", stderr: String(error) });
    });
  });
}

const PROXY_ENV = (proxy: string): string[] => [
  "-e", `HTTPS_PROXY=http://${proxy}`,
  "-e", `HTTP_PROXY=http://${proxy}`,
  "-e", `https_proxy=http://${proxy}`,
  "-e", `http_proxy=http://${proxy}`,
];

/**
 * Worker container: host fs invisible (only /ws + ro auth.json); on the internal network with
 * provider-only egress via the proxy. Governed targets have no route.
 */
export function runWorker(
  config: IsolationConfig,
  input: { workspace: string; codexAuthDir: string; sessionsDir?: string; argv: readonly string[]; timeout_ms?: number },
): Promise<RunResult> {
  const sessionsMount = input.sessionsDir !== undefined ? ["-v", `${input.sessionsDir}:/root/.codex/sessions`] : [];
  const args = [
    "run", "--rm", "--init",
    "--network", config.egress_network,
    ...PROXY_ENV(config.egress_proxy),
    "-v", `${input.workspace}:/ws`,
    "-v", `${input.codexAuthDir}/auth.json:/root/.codex/auth.json:ro`,
    ...sessionsMount,
    "-w", "/ws",
    config.worker_image,
    ...input.argv,
  ];
  return collect(spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] }), input.timeout_ms ?? 900_000);
}

/**
 * Verifier container: `--network none`, host fs invisible except the checkout mount. The
 * candidate's own (untrusted) test process has no secrets and no reachability whatsoever.
 */
export function runVerifier(
  config: IsolationConfig,
  input: { workspace: string; argv: readonly string[]; timeout_ms?: number },
): Promise<RunResult> {
  const args = [
    "run", "--rm", "--init", "--network", "none",
    "-v", `${input.workspace}:/ws`,
    "-w", "/ws",
    config.worker_image,
    ...input.argv,
  ];
  return collect(spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] }), input.timeout_ms ?? 300_000);
}

/**
 * Reviewer container: host fs invisible (only a ro checkout); on the internal network with
 * provider-only egress via the proxy → GitHub/record/Kernel are unreachable (http-000). The
 * model OAuth token is injected by env (operator-extracted), so no keychain/host credential is
 * reachable.
 */
export function runReviewer(
  config: IsolationConfig,
  input: { workspace: string; providerToken: string; argv: readonly string[]; timeout_ms?: number },
): Promise<RunResult> {
  const args = [
    "run", "--rm", "--init",
    "--network", config.egress_network,
    ...PROXY_ENV(config.egress_proxy),
    "-v", `${input.workspace}:/ws:ro`,
    "-e", "HOME=/root",
    "-e", `CLAUDE_CODE_OAUTH_TOKEN=${input.providerToken}`,
    "-w", "/ws",
    config.worker_image,
    ...input.argv,
  ];
  return collect(spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] }), input.timeout_ms ?? 300_000);
}

/** Extract the Claude Code provider OAuth token (operator action; the surface never sees the keychain). */
export function claudeProviderToken(): string {
  const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 5000 });
  return (JSON.parse(raw) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth.accessToken;
}

export function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["info"], { stdio: "ignore" });
    child.on("close", (status) => resolve(status === 0));
    child.on("error", () => resolve(false));
  });
}

// ------------------------------------------------------------------ egress network lifecycle

export interface EgressBoundary {
  readonly network: string;
  readonly proxy: string; // host:port on the internal network
  teardown(): void;
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
}

/**
 * Create the surface egress boundary (TD §4.1): an `--internal` network (no internet) plus a
 * dual-homed allowlist proxy that forwards only to `allowHosts`. Idempotent per name.
 */
export function createEgressBoundary(name: string, allowHosts: readonly string[]): EgressBoundary {
  const internal = `${name}-int`;
  const external = `${name}-ext`;
  const proxyName = `${name}-proxy`;
  for (const [net, extra] of [[internal, ["--internal"]], [external, []]] as const) {
    try { docker(["network", "create", ...extra, net]); } catch { /* exists */ }
  }
  try { docker(["rm", "-f", proxyName]); } catch { /* absent */ }
  docker([
    "run", "-d", "--name", proxyName, "--network", internal,
    "-v", `${PROXY_SCRIPT}:/egressProxy.mjs:ro`,
    "-e", `ALLOW_HOSTS=${allowHosts.join(",")}`,
    "node:22-bookworm-slim", "node", "/egressProxy.mjs",
  ]);
  docker(["network", "connect", external, proxyName]);
  return {
    network: internal,
    proxy: `${proxyName}:8888`,
    teardown() {
      try { docker(["rm", "-f", proxyName]); } catch { /* gone */ }
      for (const net of [internal, external]) {
        try { docker(["network", "rm", net]); } catch { /* gone */ }
      }
    },
  };
}

/** Built-image identity for the reach/WORK_START evidence (TD §11 version exactness). */
export function imageIdentity(image: string): { image: string; image_digest: string; tool_versions: Record<string, string> } {
  const image_digest = docker(["image", "inspect", image, "--format", "{{.Id}}"]);
  const versions = docker([
    "run", "--rm", "--network", "none", image,
    "sh", "-c", "printf 'codex-cli=%s\\nclaude=%s\\n' \"$(codex --version)\" \"$(claude --version)\"",
  ]);
  const tool_versions: Record<string, string> = {};
  for (const line of versions.split("\n")) {
    const [k, v] = line.split("=");
    if (k && v) tool_versions[k.trim()] = v.trim();
  }
  return { image, image_digest, tool_versions };
}
