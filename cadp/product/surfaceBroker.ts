/**
 * Bounded surface-launcher seam (TD §4.1; PR #102 re-review 5101871379 activity-host blockers).
 *
 * The Temporal activity host holds the Kernel workflow tokens and drives the governed-effect
 * protocol, so its network is pinned to ONLY the Kernel/Temporal/broker localhost ports and it
 * has no Docker access at all (its Seatbelt profile denies every other remote, incl. the docker
 * daemon socket). It therefore cannot (a) reach a governed target directly, nor (b) use the
 * docker daemon as a confused deputy to mount+read the PEP secret path.
 *
 * The work that genuinely needs GitHub (public read-only clones) and the docker daemon (launch
 * the isolated model surfaces) lives HERE instead, in a separate trusted process that:
 *   - holds NO Kernel token and NO PEP secret (its own Seatbelt profile denies the secret path);
 *   - accepts NO host path from its caller — every request carries only {repo, sha, work_item},
 *     and the broker mounts ONLY the ephemeral workspace/auth dirs IT created, with fixed args,
 *     so a malicious surface can never steer a bind-mount at the secret path;
 *   - returns raw observed data; the activity host submits all evidence with its Kernel tokens.
 *
 * Requests are localhost HTTP (the activity host is allowed the broker port only).
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { buildWorkerSandbox, WORKER_ARGV_PREFIX } from "./workerProfile.ts";
import { claudeProviderToken, dockerAvailable, runReviewer, runVerifier, runWorker } from "./isolation.ts";
import type { IsolationConfig } from "./isolation.ts";

const ZERO_SHA = "0000000000000000000000000000000000000000";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function nowMs(): string {
  return new Date().toISOString();
}

async function git(args: string[], cwd?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("close", (status) => resolve({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
    child.on("error", (e) => resolve({ status: 127, stdout: "", stderr: String(e) }));
  });
}

function config(): IsolationConfig {
  const get = (name: string): string => {
    const v = process.env[name];
    if (v === undefined || v.length === 0) throw new Error(`broker environment missing ${name}`);
    return v;
  };
  return { worker_image: get("CADP_WORKER_IMAGE"), egress_network: get("CADP_EGRESS_NETWORK"), egress_proxy: get("CADP_EGRESS_PROXY") };
}

// ------------------------------------------------------------------ /implement

/**
 * Clone at base_sha in a fresh ephemeral tree, run codex inside the worker container (fixed
 * mounts: only this workspace + a copied auth.json), commit + bundle the candidate. Returns the
 * candidate sha, the bundle bytes (b64), and the observed backend model scanned from the codex
 * session log. NO governed credential and NO caller-supplied path is involved.
 */
export async function brokerImplement(body: { repo_full_name: string; base_sha: string; work_item: string }): Promise<{
  candidate_sha: string;
  bundle_b64: string;
  backend_model?: string;
  backend_locator?: string;
}> {
  if (!(await dockerAvailable())) throw new Error("surface isolation runtime (docker) unavailable — failing closed");
  const base = mkdtempSync(join(tmpdir(), "cadp-impl-"));
  try {
    const workspace = join(base, "ws");
    let r = await git(["clone", "--quiet", `https://github.com/${body.repo_full_name}.git`, workspace]);
    if (r.status !== 0) throw new Error(`clone failed: ${r.stderr.slice(0, 300)}`);
    r = await git(["checkout", "--quiet", body.base_sha], workspace);
    if (r.status !== 0) {
      await git(["fetch", "--quiet", "origin", `refs/heads/cadp/candidate/${body.base_sha}`], workspace);
      r = await git(["checkout", "--quiet", body.base_sha], workspace);
      if (r.status !== 0) throw new Error(`checkout ${body.base_sha} failed: ${r.stderr.slice(0, 300)}`);
    }

    const sandbox = buildWorkerSandbox(base);
    const sessionsDir = join(sandbox.home, "codex-sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const workerRun = await runWorker(config(), {
      workspace,
      codexAuthDir: join(sandbox.home, ".codex"),
      sessionsDir,
      argv: ["codex", ...WORKER_ARGV_PREFIX, "-C", "/ws", body.work_item],
      timeout_ms: 900_000,
    });
    if (workerRun.status !== 0) throw new Error(`worker container exited ${workerRun.status}: ${workerRun.stderr.slice(0, 400)}`);

    await git(["add", "-A"], workspace);
    r = await git(["-c", "user.name=cadp-worker", "-c", "user.email=worker@cadp-v04.invalid", "commit", "-m", `cadp candidate: ${body.work_item.slice(0, 60)}`], workspace);
    if (r.status !== 0 && !/nothing to commit|커밋할 사항 없음/u.test(r.stdout + r.stderr)) {
      throw new Error(`commit failed: ${r.stderr.slice(0, 200)} ${r.stdout.slice(0, 200)}`);
    }
    const candidate_sha = (await git(["rev-parse", "HEAD"], workspace)).stdout.trim();

    await git(["branch", "-f", "cadp-candidate", candidate_sha], workspace);
    const bundlePath = join(base, "candidate.bundle");
    r = await git(["bundle", "create", bundlePath, "cadp-candidate"], workspace);
    if (r.status !== 0) throw new Error(`bundle create failed: ${r.stderr.slice(0, 300)}`);
    const bundle_b64 = readFileSync(bundlePath).toString("base64");

    const backend = scanBackendModel(sessionsDir, workerRun.stdout);
    return { candidate_sha, bundle_b64, backend_model: backend.model, backend_locator: backend.locator };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** #91 method: scan the worker's OWN codex session log; PRESENT facts carry a locator. */
function scanBackendModel(sessionsDir: string, stdout: string): { model?: string; locator?: string } {
  let model: string | undefined;
  let locator: string | undefined;
  const scan = (file: string): void => {
    const content = readFileSync(file, "utf8");
    const idx = content.search(/"model"\s*:\s*"/u);
    if (idx >= 0) {
      const m = /"model"\s*:\s*"([^"]+)"/u.exec(content.slice(idx, idx + 200));
      if (m !== null) { model = m[1]; locator = `${file}#offset=${idx}`; }
    }
  };
  try {
    const walk = (d: string): void => {
      for (const entry of readdirSync(d)) {
        const p = join(d, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (model === undefined && (entry.endsWith(".jsonl") || entry.endsWith(".json"))) scan(p);
      }
    };
    if (existsSync(sessionsDir)) walk(sessionsDir);
  } catch { /* absent facts stay UNKNOWN */ }
  if (model === undefined) {
    const m = /model:\s*(\S+)/u.exec(stdout);
    if (m !== null) { model = m[1]; locator = "worker-stdout#pattern=model:"; }
  }
  return { model, locator };
}

// ------------------------------------------------------------------ /verify

export async function brokerVerify(body: { repo_full_name: string; candidate_sha: string }): Promise<
  | { status: "UNKNOWN"; clone_head: string; unknown_reason: string }
  | { status: "PRESENT"; clone_head: string; conclusion: string; started_at: string; completed_at: string; output_digest: string }
> {
  if (!(await dockerAvailable())) throw new Error("verifier isolation runtime (docker) unavailable — failing closed");
  const base = mkdtempSync(join(tmpdir(), "cadp-verify-"));
  const started_at = nowMs();
  try {
    const workspace = join(base, "ws");
    let r = await git(["clone", "--quiet", `https://github.com/${body.repo_full_name}.git`, workspace]);
    if (r.status !== 0) throw new Error(`clone failed: ${r.stderr.slice(0, 300)}`);
    await git(["fetch", "--quiet", "origin", `refs/heads/cadp/candidate/${body.candidate_sha}`], workspace);
    r = await git(["checkout", "--quiet", body.candidate_sha], workspace);
    if (r.status !== 0) throw new Error(`checkout candidate failed: ${r.stderr.slice(0, 300)}`);
    const clone_head = (await git(["rev-parse", "HEAD"], workspace)).stdout.trim();
    const porcelain = (await git(["status", "--porcelain"], workspace)).stdout.trim();
    if (porcelain.length > 0 || clone_head !== body.candidate_sha) {
      return { status: "UNKNOWN", clone_head, unknown_reason: porcelain.length > 0 ? "DIRTY_WORKSPACE" : "HEAD_MISMATCH" };
    }
    const test = await runVerifier(config(), { workspace, argv: ["node", "--test"], timeout_ms: 300_000 });
    const completed_at = nowMs();
    return {
      status: "PRESENT",
      clone_head,
      conclusion: test.status === 0 ? "success" : "failure",
      started_at,
      completed_at,
      output_digest: sha256(test.stdout + test.stderr),
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ /review

export async function brokerReview(body: { repo_full_name: string; candidate_sha: string; work_item: string }): Promise<{
  verdict: string;
  reason: string;
  stdout: string;
}> {
  if (!(await dockerAvailable())) throw new Error("reviewer isolation runtime (docker) unavailable — failing closed");
  const base = mkdtempSync(join(tmpdir(), "cadp-review-"));
  try {
    const workspace = join(base, "ws");
    let r = await git(["clone", "--quiet", `https://github.com/${body.repo_full_name}.git`, workspace]);
    if (r.status !== 0) throw new Error(`clone failed: ${r.stderr.slice(0, 300)}`);
    await git(["fetch", "--quiet", "origin", `refs/heads/cadp/candidate/${body.candidate_sha}`], workspace);
    r = await git(["checkout", "--quiet", body.candidate_sha], workspace);
    if (r.status !== 0) throw new Error(`checkout failed: ${r.stderr.slice(0, 300)}`);
    const diff = (await git(["show", "--stat", "--patch", body.candidate_sha], workspace)).stdout.slice(0, 40_000);

    const prompt = `You are reviewing the exact committed change below (commit ${body.candidate_sha}) implementing: "${body.work_item}". Reply with exactly APPROVE or REQUEST_CHANGES on the first line, then one short reason line.\n\n${diff}`;
    const reviewWs = join(base, "review-ws");
    mkdirSync(reviewWs, { recursive: true });
    const review = await runReviewer(config(), {
      workspace: reviewWs,
      providerToken: claudeProviderToken(),
      argv: ["claude", "-p", "--model", "claude-sonnet-5", "--permission-mode", "plan", "--disallowedTools=Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit", prompt],
      timeout_ms: 300_000,
    });
    if (review.status !== 0 || review.stdout.trim().length === 0) {
      throw new Error(`reviewer surface failed (exit ${review.status}): ${(review.stderr || review.stdout).slice(0, 200)}`);
    }
    const lines = review.stdout.trim().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const verdictLine = lines.find((l) => l === "APPROVE" || l === "REQUEST_CHANGES" || l.startsWith("APPROVE") || l.startsWith("REQUEST_CHANGES")) ?? "";
    const verdict = verdictLine.startsWith("APPROVE") ? "APPROVE" : "REQUEST_CHANGES";
    const reason = lines[lines.indexOf(verdictLine) + 1] ?? review.stdout.trim().slice(0, 200);
    return { verdict, reason, stdout: review.stdout };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ server

const HANDLERS: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  "/implement": (b) => brokerImplement(b as { repo_full_name: string; base_sha: string; work_item: string }),
  "/verify": (b) => brokerVerify(b as { repo_full_name: string; candidate_sha: string }),
  "/review": (b) => brokerReview(b as { repo_full_name: string; candidate_sha: string; work_item: string }),
};

export function startBroker(port: number): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    const handler = req.url !== undefined ? HANDLERS[req.url] : undefined;
    if (req.method !== "POST" || handler === undefined) {
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown>;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
      catch { res.writeHead(400).end(JSON.stringify({ error: "bad json" })); return; }
      handler(body)
        .then((result) => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result)); })
        .catch((e: unknown) => { res.writeHead(500).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })); });
    });
  });
  server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ broker: "started", pid: process.pid, port })));
  return server;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("surfaceBroker.ts")) {
  startBroker(Number(process.env["CADP_BROKER_PORT"] ?? "0"));
}
