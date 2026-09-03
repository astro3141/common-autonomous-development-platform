/**
 * OS-level surface isolation (TD §4.1, PR #102 re-review new blocker): env scrubbing is not
 * a boundary against a same-UID process that can read the PEP secret path or the manifest
 * token material. Untrusted worker/reviewer/verifier code runs inside an enforceable sandbox:
 *
 *  - worker (codex): a Docker container. Host filesystem is not mounted (only a fresh /ws
 *    workspace and a copied auth.json), so the PEP secret dir and manifest are unreachable;
 *    governed target hosts are pinned to 127.0.0.1 (dead) via --add-host, while the commodity
 *    provider egress the surface legitimately needs stays open.
 *  - verifier (candidate `node --test`): a Docker container with `--network none` — the
 *    untrusted candidate has NO filesystem visibility of the host and NO network at all, so it
 *    can neither read secrets nor reach the Kernel/targets.
 *  - reviewer (claude -p): needs host Claude auth, so it runs under a macOS Seatbelt profile
 *    that denies reading the PEP secret path, denies the Kernel API port and governed target
 *    ports, and denies the keychain/security binary and credential helpers — while keeping the
 *    provider egress the reviewer needs.
 *
 * The SAME construction is what CREDENTIAL_REACH_ATTESTATION measures (the attestation probes
 * run through `runWorker`/`runVerifier`/`runReviewer` with a probe command).
 */

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export interface IsolationConfig {
  /** Docker image with node + git + codex (built by cadp/live/image). */
  readonly worker_image: string;
  /** Governed target hosts pinned unreachable inside the worker container. */
  readonly governed_hosts: readonly string[];
  /** Local TCP ports the reviewer must not reach (Kernel API + governed local targets). */
  readonly denied_ports: readonly number[];
  /** Absolute paths the reviewer must not read (PEP secret dir, manifest). */
  readonly denied_read_paths: readonly string[];
}

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

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

/**
 * Worker container: host fs invisible; only /ws (rw) and a copied codex auth (ro) are mounted;
 * governed hosts pinned dead; provider egress open. `argv` runs inside the container's /ws.
 */
export function runWorker(
  config: IsolationConfig,
  input: { workspace: string; codexAuthDir: string; sessionsDir?: string; argv: readonly string[]; timeout_ms?: number },
): Promise<RunResult> {
  // Pin governed hosts AND the docker host bridge to a dead address: the worker container can
  // reach the commodity provider (public DNS) but not GitHub or the host-side record service.
  const addHost = [...config.governed_hosts, "host.docker.internal"].flatMap((h) => ["--add-host", `${h}:127.0.0.1`]);
  // auth.json is mounted read-only; a separate writable sessions dir lets the container's codex
  // write its session log where the host-side backend-scan adapter can read it (#91), without
  // exposing the read-only auth mount to writes.
  const sessionsMount = input.sessionsDir !== undefined ? ["-v", `${input.sessionsDir}:/root/.codex/sessions`] : [];
  const args = [
    "run", "--rm", "--init",
    "-v", `${input.workspace}:/ws`,
    "-v", `${input.codexAuthDir}/auth.json:/root/.codex/auth.json:ro`,
    ...sessionsMount,
    "-w", "/ws",
    ...addHost,
    config.worker_image,
    ...input.argv,
  ];
  return collect(spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] }), input.timeout_ms ?? 900_000);
}

/**
 * Verifier container: `--network none`, host fs invisible except a read-only checkout mount.
 * The candidate's own (untrusted) test process therefore has no secrets and no reachability.
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
 * Reviewer container: like the worker, host fs invisible (only a read-only checkout), governed
 * hosts + host bridge pinned dead → GitHub/record/Kernel egress is http-000. The provider
 * (Anthropic) is a public host and stays reachable; the model OAuth token is passed by env so
 * no keychain/host-credential access is needed. Only /ws (ro) is mounted.
 */
export function runReviewer(
  config: IsolationConfig,
  input: { workspace: string; providerToken: string; argv: readonly string[]; timeout_ms?: number },
): Promise<RunResult> {
  const addHost = [...config.governed_hosts, "host.docker.internal"].flatMap((h) => ["--add-host", `${h}:127.0.0.1`]);
  const args = [
    "run", "--rm", "--init",
    "-v", `${input.workspace}:/ws:ro`,
    "-e", "HOME=/root",
    "-e", `CLAUDE_CODE_OAUTH_TOKEN=${input.providerToken}`,
    "-w", "/ws",
    ...addHost,
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

/** Is the worker/verifier container runtime actually available? (fail closed if not). */
export function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["info"], { stdio: "ignore" });
    child.on("close", (status) => resolve(status === 0));
    child.on("error", () => resolve(false));
  });
}
