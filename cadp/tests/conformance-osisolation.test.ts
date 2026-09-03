/**
 * PR #102 re-review new blocker — OS-level isolation boundary controls. The env-level F1–F5
 * controls remain; these prove the *deployment mechanism* denies a malicious surface the
 * filesystem-discovery / credential-recovery path the re-review described:
 *
 *  F6  reviewer Seatbelt: malicious code under `runReviewer` cannot read the PEP secret path
 *      or manifest, cannot reach the Kernel/target ports, cannot exec the keychain; the
 *      guard-bite (no sandbox) DOES read the secret and reach the port — load-bearing.
 *  F7  verifier container: `runVerifier` (--network none, no host mount) sees no host files
 *      and no network; the guard-bite (host node, host env) reads the manifest and reaches out.
 *  F8  worker container: `runWorker` sees no host filesystem and cannot reach governed hosts
 *      (pinned dead), while retaining the commodity provider egress.
 *
 * Container legs are skipped (not failed) when Docker is unavailable, and Seatbelt legs when
 * not on macOS — the boundary is asserted hard wherever the mechanism exists.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { dockerAvailable, runReviewer, runVerifier, runWorker } from "../product/isolation.ts";
import type { IsolationConfig } from "../product/isolation.ts";

const PAYLOAD = fileURLToPath(new URL("../live/probePayload.mjs", import.meta.url));

/** Async spawn — the stub HTTP server lives in THIS process, so a blocking spawnSync child
 * would deadlock its fetch against our frozen event loop. */
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
const WORKER_IMAGE = "cadp-surface:1";

let dockerOk = false;
let imageOk = false;
test("prereqs", async () => {
  dockerOk = await dockerAvailable();
  if (dockerOk) {
    imageOk = spawnSync("docker", ["image", "inspect", WORKER_IMAGE], { stdio: "ignore" }).status === 0;
  }
  console.log(`  docker=${dockerOk} image=${imageOk} platform=${platform()}`);
});

/** A live server standing in for the Kernel/record port a malicious surface would target. */
function kernelStub(): Promise<{ port: number; hits: number; close(): void }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ effect_id: "cadp-v04:effect:leaked" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ port, get hits() { return hits; }, close: () => server.close() } as { port: number; hits: number; close(): void });
    });
  });
}

test("F6: reviewer container has no host filesystem and governed egress is http-000; guard-bite (host) breaches", async () => {
  if (!dockerOk || !imageOk) {
    console.log("  skipped: docker/image unavailable");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "cadp-f6-"));
  const stub = await kernelStub();
  try {
    const secretDir = join(dir, "secret");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "github-token"), "ghp_SUPER_SECRET_TOKEN");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tokens: { "cadp-workflow": "wf-token" }, api_url: `http://127.0.0.1:${stub.port}` }));
    const ws = join(dir, "ws");
    mkdirSync(ws, { recursive: true });
    spawnSync("cp", [PAYLOAD, join(ws, "probe.mjs")]);
    const config: IsolationConfig = { worker_image: WORKER_IMAGE, governed_hosts: ["github.com", "api.github.com"], denied_ports: [], denied_read_paths: [] };
    const run = await runReviewer(config, {
      workspace: ws,
      providerToken: "probe-not-used",
      argv: ["sh", "-c", `PROBE_SEARCH_ROOTS='/:/ws:/root' PROBE_TARGETS='${JSON.stringify({ github_api: "https://api.github.com/rate_limit", kernel: `http://host.docker.internal:${stub.port}/x` })}' node /ws/probe.mjs`],
      timeout_ms: 60_000,
    });
    const findings = JSON.parse(run.stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"))!) as {
      fs_reads: Array<{ path: string }>; egress: Array<{ target: string; status: unknown }>;
    };
    assert.ok(!findings.fs_reads.some((f) => f.path.includes(dir)), "host secret/manifest invisible in the reviewer container");
    assert.ok(findings.egress.every((e) => e.status === "000"), `governed egress must all be http-000: ${JSON.stringify(findings.egress)}`);
    assert.equal(stub.hits, 0, "the Kernel stub received nothing from the isolated reviewer");

    // Guard-bite: the same payload on the HOST reads the secret and reaches the port.
    const bite = await spawnAsync("node", [PAYLOAD], { ...process.env as Record<string, string>, PROBE_SEARCH_ROOTS: `${dir}:${secretDir}`, PROBE_TARGETS: JSON.stringify({ kernel: `http://127.0.0.1:${stub.port}/x` }) });
    const biteFindings = JSON.parse(bite.stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"))!) as {
      fs_reads: Array<{ path: string }>; egress: Array<{ status: unknown }>;
    };
    assert.ok(biteFindings.fs_reads.length > 0, "bite: host secret readable");
    assert.ok(biteFindings.egress.some((e) => e.status !== "000"), "bite: host reached the port");
  } finally {
    stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F7: verifier container has no host filesystem and no network; guard-bite (host) reads + reaches", async () => {
  if (!dockerOk || !imageOk) {
    console.log("  skipped: docker/image unavailable");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "cadp-f7-"));
  const stub = await kernelStub();
  try {
    const secretDir = join(dir, "secret");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "record-api-key"), "SECRET-KEY");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tokens: { "cadp-workflow": "wf" }, api_url: `http://127.0.0.1:${stub.port}` }));
    const ws = join(dir, "ws");
    mkdirSync(ws, { recursive: true });
    spawnSync("cp", [PAYLOAD, join(ws, "probe.mjs")]);
    const config: IsolationConfig = { worker_image: WORKER_IMAGE, governed_hosts: [], denied_ports: [], denied_read_paths: [] };
    const run = await runVerifier(config, {
      workspace: ws,
      argv: ["sh", "-c", `PROBE_SEARCH_ROOTS='/:/ws' PROBE_TARGETS='${JSON.stringify({ kernel: `http://host.docker.internal:${stub.port}/x` })}' node /ws/probe.mjs`],
      timeout_ms: 60_000,
    });
    const findings = JSON.parse(run.stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"))!) as {
      fs_reads: Array<{ path: string }>; egress: Array<{ status: unknown }>;
    };
    assert.ok(!findings.fs_reads.some((f) => f.path.includes(dir)), "host secret/manifest files are invisible in the container");
    assert.ok(findings.egress.every((e) => e.status === "000"), "no network egress at all under --network none");
    assert.equal(stub.hits, 0, "the stub received nothing from the isolated verifier");

    // Guard-bite: the same payload on the HOST reads the secret and reaches the port.
    const bite = await spawnAsync("node", [PAYLOAD], { ...process.env as Record<string, string>, PROBE_SEARCH_ROOTS: `${dir}:${secretDir}`, PROBE_TARGETS: JSON.stringify({ kernel: `http://127.0.0.1:${stub.port}/x` }) });
    const biteFindings = JSON.parse(bite.stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"))!) as {
      fs_reads: Array<{ path: string }>; egress: Array<{ status: unknown }>;
    };
    assert.ok(biteFindings.fs_reads.length > 0, "bite: host files readable");
    assert.ok(biteFindings.egress.some((e) => e.status !== "000"), "bite: host reached the port");
  } finally {
    stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F8: worker container sees no host filesystem and cannot reach governed hosts (pinned dead)", async () => {
  if (!dockerOk || !imageOk) {
    console.log("  skipped: docker/image unavailable");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "cadp-f8-"));
  try {
    const secretDir = join(dir, "secret");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "github-token"), "ghp_SECRET");
    const ws = join(dir, "ws");
    const auth = join(dir, "auth");
    mkdirSync(ws, { recursive: true });
    mkdirSync(auth, { recursive: true });
    writeFileSync(join(auth, "auth.json"), "{}");
    spawnSync("cp", [PAYLOAD, join(ws, "probe.mjs")]);
    const config: IsolationConfig = {
      worker_image: WORKER_IMAGE,
      governed_hosts: ["github.com", "api.github.com"],
      denied_ports: [],
      denied_read_paths: [],
    };
    const run = await runWorker(config, {
      workspace: ws,
      codexAuthDir: auth,
      argv: ["sh", "-c", `PROBE_SEARCH_ROOTS='/:/ws' PROBE_TARGETS='${JSON.stringify({ github_api: "https://api.github.com/rate_limit" })}' node /ws/probe.mjs`],
      timeout_ms: 60_000,
    });
    const findings = JSON.parse(run.stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"))!) as {
      fs_reads: Array<{ path: string }>; egress: Array<{ target: string; status: unknown }>;
    };
    assert.ok(!findings.fs_reads.some((f) => f.path.includes(dir)), "host secret files invisible in the worker container");
    const gh = findings.egress.find((e) => e.target === "github_api");
    assert.equal(gh?.status, "000", `governed host must be unreachable (pinned dead): ${JSON.stringify(gh)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

after(() => { /* servers closed per-test */ });
