/**
 * OS + network isolation boundary controls (TD §4.1). The surfaces run in Docker containers on
 * an --internal network with a provider-only allowlist proxy; the Temporal activity host runs
 * under a Seatbelt boundary denying the PEP secret path. Every control has a guard-bite.
 *
 *  F6  reviewer container: no host fs; governed targets (name + literal IP + docker gateway)
 *      http-000; provider reachable via proxy. Guard-bite (host node) reads secret + reaches.
 *  F7  verifier container (--network none): no host fs, no egress at all.
 *  F8  worker container: no host fs; governed targets unreachable by every route.
 *  F9  surface broker: under the broker Seatbelt profile (deny-read secret) a payload cannot read
 *      the PEP secret files; guard-bite (no sandbox) reads them.
 *  F10 activity host: under the EXACT production activity-host profile (deny-read secret + egress
 *      pinned to only its allowed localhost ports) a payload cannot read the secret, cannot reach a
 *      governed target (denied port / GitHub by name+IP are http-000 while the allowed port works),
 *      and cannot use the docker daemon to bind-mount+read the secret. Guard-bites breach each.
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
import { activityHostProfile, denyReadProfile } from "../live/env.ts";

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

test("F9: surface broker under Seatbelt (deny-read secret) cannot read the PEP secret path; guard-bite reads it", async () => {
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

test("F10: activity host under its exact profile — secret unread, governed egress http-000, daemon-mount denied; guard-bites breach", async () => {
  if (platform() !== "darwin" || spawnSync("which", ["sandbox-exec"], { stdio: "ignore" }).status !== 0) {
    console.log("  skipped: sandbox-exec unavailable");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "cadp-f10-"));
  const allowed = await kernelStub(); // the legitimate seam (Kernel/Temporal/broker port stand-in)
  const denied = await kernelStub();  // a governed port the activity host must NOT reach
  try {
    const secret = join(dir, "secret");
    mkdirSync(join(secret, "root"), { recursive: true });
    for (const f of ["github-token", "api-tokens.json", "record-api-key", "root-token", "workflow-token-map.json"]) writeFileSync(join(secret, f), "SECRET-" + f);
    writeFileSync(join(secret, "root", "root-key.pem"), "ROOT-KEY");
    const files = ["github-token", "api-tokens.json", "record-api-key", "root-token", "workflow-token-map.json", "root/root-key.pem"].map((f) => join(secret, f));

    // The EXACT production activity-host profile: deny the secret path, allow ONLY the seam port.
    const profilePath = join(dir, "activity-host.sb");
    writeFileSync(profilePath, activityHostProfile([secret], [allowed.port]));

    const targets = {
      allowed_seam: `http://127.0.0.1:${allowed.port}/`,
      denied_port: `http://127.0.0.1:${denied.port}/`,
      github_name: "https://api.github.com/",
      github_ip: "https://140.82.112.3/",
    };
    const env = { ...process.env as Record<string, string>, PROBE_SEARCH_ROOTS: secret, PROBE_TARGETS: JSON.stringify(targets), PROBE_EXPLICIT_FILES: files.join(":") };
    const confined = await spawnAsync("sandbox-exec", ["-f", profilePath, "node", PAYLOAD], env);
    const cf = parse(confined.stdout);
    assert.equal(cf.fs_reads.length, 0, `confined activity host reads NO secret file: ${JSON.stringify(cf.fs_reads)}`);
    for (const e of cf.egress) {
      if (e.target === "allowed_seam") assert.notEqual(e.status, "000", "the allowed seam port must be reachable");
      else assert.equal(e.status, "000", `governed target ${e.target} must be http-000: ${JSON.stringify(e)}`);
    }
    assert.equal(denied.hits, 0, "the denied governed port was never actually reached");

    // Guard-bite (no profile): the denied port is reachable and every secret file is read.
    const bite = await spawnAsync("node", [PAYLOAD], env);
    const bf = parse(bite.stdout);
    assert.ok(bf.fs_reads.length >= files.length, `bite: unconfined host reads every secret file (${bf.fs_reads.length})`);
    assert.ok(bf.egress.some((e) => e.target === "denied_port" && e.status !== "000"), "bite: reached the governed port");

    // Confused-deputy control: under the profile the docker daemon socket is denied, so the host
    // cannot bind-mount the secret path into a container and read it. Guard-bite (no profile) can.
    if (await dockerAvailable() && spawnSync("docker", ["image", "inspect", WORKER_IMAGE], { stdio: "ignore" }).status === 0) {
      const mountArgs = ["run", "--rm", "--network", "none", "-v", `${secret}:/stolen:ro`, WORKER_IMAGE, "cat", "/stolen/github-token"];
      const denyMount = await spawnAsync("sandbox-exec", ["-f", profilePath, "docker", ...mountArgs], process.env as Record<string, string>);
      assert.notEqual(denyMount.status, 0, `daemon-mount of the secret must fail under the profile: ${denyMount.stdout}${denyMount.stderr}`);
      assert.ok(!denyMount.stdout.includes("SECRET-github-token"), "the secret bytes must NOT come back through a container mount");
      const biteMount = await spawnAsync("docker", mountArgs, process.env as Record<string, string>);
      assert.ok(biteMount.stdout.includes("SECRET-github-token"), "bite: unconfined docker mount reads the secret bytes");
    } else {
      console.log("  daemon-mount leg skipped (docker/image absent)");
    }
  } finally { allowed.close(); denied.close(); rmSync(dir, { recursive: true, force: true }); }
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
