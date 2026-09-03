/**
 * OS + network isolation boundary controls (TD §4.1). The surfaces run in Docker containers on
 * an --internal network with a provider-only allowlist proxy; the Temporal activity host runs
 * under a Seatbelt boundary denying the PEP secret path. Every control has a guard-bite.
 *
 *  F6  reviewer container: no host fs; governed targets (name + literal IP + docker gateway)
 *      http-000; provider reachable via proxy. Guard-bite (host node) reads secret + reaches.
 *  F7  verifier container (--network none): no host fs, no egress at all.
 *  F8  worker container: no host fs; governed targets unreachable by every route.
 *  F9  activity host: under the worker Seatbelt profile a payload cannot read the PEP secret
 *      files; guard-bite (no sandbox) reads them.
 *
 * Container legs skip (not fail) when Docker is unavailable; Seatbelt legs skip off macOS.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { createEgressBoundary, dockerAvailable, runReviewer, runVerifier, runWorker } from "../product/isolation.ts";
import type { EgressBoundary, IsolationConfig } from "../product/isolation.ts";
import { denyReadProfile } from "../live/env.ts";

const PAYLOAD = fileURLToPath(new URL("../live/probePayload.mjs", import.meta.url));
const WORKER_IMAGE = "cadp-surface:0.151.0-2.1.221";

function spawnAsync(cmd: string, args: string[], env: Record<string, string>, timeout_ms = 60_000): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout_ms);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }); });
  });
}

let dockerOk = false;
let imageOk = false;
let boundary: EgressBoundary | undefined;
test("prereqs", async () => {
  dockerOk = await dockerAvailable();
  if (dockerOk) imageOk = spawnSync("docker", ["image", "inspect", WORKER_IMAGE], { stdio: "ignore" }).status === 0;
  if (dockerOk && imageOk) boundary = createEgressBoundary("cadp-osiso-test", ["api.openai.com", "api.anthropic.com"]);
  console.log(`  docker=${dockerOk} image=${imageOk} platform=${platform()}`);
});

after(() => { boundary?.teardown(); });

function config(): IsolationConfig {
  return { worker_image: WORKER_IMAGE, egress_network: boundary!.network, egress_proxy: boundary!.proxy };
}

/** Governed targets by name, literal IP, and docker gateway — none may be reachable. */
function governedTargets(kernelPort: number): Record<string, string> {
  return {
    github_name: "https://api.github.com/",
    github_ip: "https://140.82.112.3/",
    docker_gateway: "http://192.168.65.1/",
    kernel_hostbridge: `http://host.docker.internal:${kernelPort}/allocate_effect_id`,
  };
}

function parse(stdout: string): { fs_reads: Array<{ path: string }>; egress: Array<{ target: string; status: unknown }>; credential_use: Array<Record<string, unknown>> } {
  const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  return JSON.parse(line!) as { fs_reads: Array<{ path: string }>; egress: Array<{ target: string; status: unknown }>; credential_use: Array<Record<string, unknown>> };
}

test("F6: reviewer container — no host fs; governed egress http-000 by every route; guard-bite breaches", async () => {
  if (!dockerOk || !imageOk) { console.log("  skipped"); return; }
  const dir = mkdtempSync(join(tmpdir(), "cadp-f6-"));
  const stub = await kernelStub();
  try {
    mkdirSync(join(dir, "secret"), { recursive: true });
    writeFileSync(join(dir, "secret", "github-token"), "ghp_SECRET");
    const ws = join(dir, "ws"); mkdirSync(ws, { recursive: true });
    spawnSync("cp", [PAYLOAD, join(ws, "probe.mjs")]);
    const targets = governedTargets(stub.port);
    const run = await runReviewer(config(), {
      workspace: ws, providerToken: "probe",
      argv: ["sh", "-c", `PROBE_SEARCH_ROOTS='/:/ws:/root' PROBE_TARGETS='${JSON.stringify(targets)}' node /ws/probe.mjs`],
      timeout_ms: 60_000,
    });
    const f = parse(run.stdout);
    assert.ok(!f.fs_reads.some((x) => x.path.includes(dir)), "host secret invisible");
    assert.ok(f.egress.every((e) => e.status === "000"), `all governed routes http-000: ${JSON.stringify(f.egress)}`);
    assert.equal(stub.hits, 0, "kernel stub untouched");

    const bite = await spawnAsync("node", [PAYLOAD], { ...process.env as Record<string, string>, PROBE_SEARCH_ROOTS: `${dir}:${join(dir, "secret")}`, PROBE_TARGETS: JSON.stringify({ kernel: `http://127.0.0.1:${stub.port}/x` }) });
    const bf = parse(bite.stdout);
    assert.ok(bf.fs_reads.length > 0, "bite: host secret readable");
    assert.ok(bf.egress.some((e) => e.status !== "000"), "bite: host reached the port");
  } finally { stub.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("F7: verifier container --network none — no host fs, no egress; guard-bite breaches", async () => {
  if (!dockerOk || !imageOk) { console.log("  skipped"); return; }
  const dir = mkdtempSync(join(tmpdir(), "cadp-f7-"));
  const stub = await kernelStub();
  try {
    mkdirSync(join(dir, "secret"), { recursive: true });
    writeFileSync(join(dir, "secret", "record-api-key"), "SECRET");
    const ws = join(dir, "ws"); mkdirSync(ws, { recursive: true });
    spawnSync("cp", [PAYLOAD, join(ws, "probe.mjs")]);
    const run = await runVerifier(config(), {
      workspace: ws,
      argv: ["sh", "-c", `PROBE_SEARCH_ROOTS='/:/ws' PROBE_TARGETS='${JSON.stringify(governedTargets(stub.port))}' node /ws/probe.mjs`],
      timeout_ms: 60_000,
    });
    const f = parse(run.stdout);
    assert.ok(!f.fs_reads.some((x) => x.path.includes(dir)), "host secret invisible");
    assert.ok(f.egress.every((e) => e.status === "000"), "no egress at all under --network none");
    assert.equal(stub.hits, 0, "kernel stub untouched");

    const bite = await spawnAsync("node", [PAYLOAD], { ...process.env as Record<string, string>, PROBE_SEARCH_ROOTS: `${dir}:${join(dir, "secret")}`, PROBE_TARGETS: JSON.stringify({ kernel: `http://127.0.0.1:${stub.port}/x` }) });
    const bf = parse(bite.stdout);
    assert.ok(bf.fs_reads.length > 0, "bite: host files readable");
    assert.ok(bf.egress.some((e) => e.status !== "000"), "bite: host reached the port");
  } finally { stub.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("F8: worker container — no host fs; governed targets unreachable by name/IP/gateway; provider proxied", async () => {
  if (!dockerOk || !imageOk) { console.log("  skipped"); return; }
  const dir = mkdtempSync(join(tmpdir(), "cadp-f8-"));
  try {
    mkdirSync(join(dir, "secret"), { recursive: true });
    writeFileSync(join(dir, "secret", "github-token"), "ghp_SECRET");
    const ws = join(dir, "ws"); const auth = join(dir, "auth");
    mkdirSync(ws, { recursive: true }); mkdirSync(auth, { recursive: true });
    writeFileSync(join(auth, "auth.json"), "{}");
    spawnSync("cp", [PAYLOAD, join(ws, "probe.mjs")]);
    const targets = { ...governedTargets(42999), provider_openai: "https://api.openai.com/v1/models" };
    const run = await runWorker(config(), {
      workspace: ws, codexAuthDir: auth,
      argv: ["sh", "-c", `PROBE_SEARCH_ROOTS='/:/ws' PROBE_TARGETS='${JSON.stringify(targets)}' node /ws/probe.mjs`],
      timeout_ms: 60_000,
    });
    const f = parse(run.stdout);
    assert.ok(!f.fs_reads.some((x) => x.path.includes(dir)), "host secret invisible");
    for (const e of f.egress) {
      if (e.target === "provider_openai") assert.notEqual(e.status, "000", "provider reachable via proxy");
      else assert.equal(e.status, "000", `governed route ${e.target} must be http-000: ${JSON.stringify(e)}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("F9: activity host under Seatbelt cannot read the PEP secret path; guard-bite reads it", async () => {
  if (platform() !== "darwin" || spawnSync("which", ["sandbox-exec"], { stdio: "ignore" }).status !== 0) {
    console.log("  skipped: sandbox-exec unavailable");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "cadp-f9-"));
  try {
    const secret = join(dir, "secret");
    mkdirSync(join(secret, "root"), { recursive: true });
    for (const f of ["github-token", "api-tokens.json", "record-api-key", "root-token", "workflow-token-map.json"]) writeFileSync(join(secret, f), "SECRET-" + f);
    writeFileSync(join(secret, "root", "root-key.pem"), "ROOT-KEY");
    const files = ["github-token", "api-tokens.json", "record-api-key", "root-token", "workflow-token-map.json", "root/root-key.pem"].map((f) => join(secret, f));
    const env = { ...process.env as Record<string, string>, PROBE_SEARCH_ROOTS: secret, PROBE_TARGETS: "{}", PROBE_EXPLICIT_FILES: files.join(":") };

    const profilePath = join(dir, "worker.sb");
    writeFileSync(profilePath, denyReadProfile([secret]));
    const confined = await spawnAsync("sandbox-exec", ["-f", profilePath, "node", PAYLOAD], env);
    const cf = parse(confined.stdout);
    assert.equal(cf.fs_reads.length, 0, `the confined activity host must read NO secret file: ${JSON.stringify(cf.fs_reads)}`);

    const bite = await spawnAsync("node", [PAYLOAD], env);
    const bf = parse(bite.stdout);
    assert.ok(bf.fs_reads.length >= files.length, `bite: unconfined host reads every secret file (${bf.fs_reads.length})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function kernelStub(): Promise<{ port: number; hits: number; close(): void }> {
  let hits = 0;
  const server = createServer((_req, res) => { hits += 1; res.writeHead(200); res.end("{}"); });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr !== null ? addr.port : 0, get hits() { return hits; }, close: () => server.close() } as { port: number; hits: number; close(): void });
    });
  });
}
