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
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { buildWorkerSandbox } from "./workerProfile.ts";
import { resolveWorkerProvider, WORKER_PROVIDERS, workerArgv } from "./workerProviders.ts";
import type { WorkerProvider } from "./workerProviders.ts";
import { DEFAULT_REVIEW_PROVIDER, REVIEW_PROVIDERS, resolveReviewProvider, reviewArgv } from "./reviewProviders.ts";
import type { ReviewProviderProfile } from "./reviewProviders.ts";
import { DEFAULT_PLAN_PROVIDER, PLAN_PROVIDERS, resolvePlanProvider, planArgv } from "./planProviders.ts";
import type { PlanProviderProfile } from "./planProviders.ts";
import { buildPlanPrompt, parseWorkProposal } from "./planner.ts";
import { claudeProviderToken, dockerAvailable, runReviewer, runVerifier, runWorker } from "./isolation.ts";
import { BROKER_SERVER_TIMEOUTS, SURFACE_BUDGETS } from "./timeouts.ts";
import type { IsolationConfig, ReviewerAuth, RunResult } from "./isolation.ts";

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

/**
 * A non-zero surface run is always a failure, never a result (#128 T2). When the run ended at its
 * declared bound the message says so — and reports what was OBSERVED about the container, so a
 * bounded failure whose termination could not be confirmed is never described as a clean one.
 */
export function surfaceFailure(kind: string, run: RunResult): string {
  // A run that could not release a command it started may still hold a live docker client, so the
  // report says that first — it is the part an operator has to act on (#128 round-9 F8).
  const held = run.commands_released === false ? " (a control-plane command could not be confirmed released)" : "";
  if (run.timed_out === true) {
    return `${kind} surface exceeded its declared bound; termination ${run.surface_state}${held} (container ${run.container}): ${run.stderr.slice(-400)}`;
  }
  // A surface can fail before it ever runs as well as after (#128 round-4/round-5): a creation the
  // daemon refused never had a launcher at all, and an unacknowledged one never got that far either.
  // Keep those distinct from "it outlived its launcher" instead of flattening every non-EXITED state
  // into one sentence — the runner went to some trouble to tell them apart.
  if (run.creation === "REJECTED") {
    return `${kind} surface was never created (container ${run.container}): ${run.stderr.slice(-400)}`;
  }
  if (run.surface_state !== undefined && run.surface_state !== "EXITED") {
    const phase = run.creation === "UNKNOWN" ? "surface creation was never acknowledged" : "surface outlived its launcher";
    return `${kind} ${phase}; termination ${run.surface_state}${held} (container ${run.container}): ${run.stderr.slice(-400)}`;
  }
  return `${kind} container exited ${run.status}: ${run.stderr.slice(0, 400)}`;
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
 * Clone at base_sha in a fresh ephemeral tree, run the selected worker inside the worker container
 * (fixed mounts: only this workspace + the provider's allowlisted auth files), commit + bundle the
 * candidate. Returns the candidate sha, bundle bytes (b64), and observed backend identity scanned
 * from that provider's session log. NO governed credential and NO caller-supplied path is involved.
 */
export async function brokerImplement(body: { repo_full_name: string; base_sha: string; work_item: string; worker_product: string }): Promise<{
  candidate_sha: string;
  bundle_b64: string;
  backend_model?: string;
  backend_locator?: string;
  backend_provider: WorkerProvider;
}> {
  // Deliberately precedes even the docker availability probe: invalid/missing selection has no
  // filesystem, process, docker, or network side effect and can never fall back to codex.
  const provider = resolveWorkerProvider(body.worker_product);
  const profile = WORKER_PROVIDERS[provider];
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

    const sandbox = buildWorkerSandbox(base, provider);
    const sessionsDir = join(sandbox.home, profile.sessions_subdir);
    mkdirSync(sessionsDir, { recursive: true });
    const workerRun = await runWorker(config(), {
      workspace,
      workerAuthDir: join(sandbox.home, profile.auth_subdir),
      authSubdir: profile.auth_subdir,
      authFiles: profile.auth_files,
      sessionsDir,
      argv: workerArgv(provider, body.work_item),
      timeout_ms: SURFACE_BUDGETS.implement.surface_ms,
    });
    // Opt-in worker session preservation for debugging (default OFF so runs don't accumulate).
    // Captured BEFORE the status check so a FAILED run's session (the interesting one) is kept too.
    preserveWorkerSession(sessionsDir, workerRun, body.work_item);
    if (workerRun.status !== 0) {
      // TERMINATED-at-bound and nonzero exits: keep the session for the postmortem before the
      // ephemeral workspace (the only copy) is deleted by the finally below.
      preserveFailedSession(sessionsDir, workerRun, body.work_item, `worker-status-${String(workerRun.status)}`);
      throw new Error(surfaceFailure("worker", workerRun));
    }

    await git(["add", "-A"], workspace);
    r = await git(["-c", "user.name=cadp-worker", "-c", "user.email=worker@cadp-v04.invalid", "commit", "-m", `cadp candidate: ${body.work_item.slice(0, 60)}`], workspace);
    if (r.status !== 0 && !/nothing to commit|커밋할 사항 없음/u.test(r.stdout + r.stderr)) {
      throw new Error(`commit failed: ${r.stderr.slice(0, 200)} ${r.stdout.slice(0, 200)}`);
    }
    const candidate_sha = (await git(["rev-parse", "HEAD"], workspace)).stdout.trim();
    // A no-op candidate (worker exited 0 but changed nothing) is an implement-quality failure the
    // reviewer will reject downstream (observed live, 3rd pilot) — keep its session for diagnosis.
    if (candidate_sha === body.base_sha) preserveFailedSession(sessionsDir, workerRun, body.work_item, "no-op-candidate");

    await git(["branch", "-f", "cadp-candidate", candidate_sha], workspace);
    const bundlePath = join(base, "candidate.bundle");
    r = await git(["bundle", "create", bundlePath, "cadp-candidate"], workspace);
    if (r.status !== 0) throw new Error(`bundle create failed: ${r.stderr.slice(0, 300)}`);
    const bundle_b64 = readFileSync(bundlePath).toString("base64");

    const backend = scanBackendModel(provider, sessionsDir, workerRun.stdout);
    return { candidate_sha, bundle_b64, backend_provider: provider, backend_model: backend.model, backend_locator: backend.locator };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** One preserved run snapshot: the session tree + bounded stdout/stderr/status (+ failure reason). */
function copySessionSnapshot(destRoot: string, sessionsDir: string, run: { status: number | null; stdout: string; stderr: string }, work_item: string, reason?: string): void {
  const stamp = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${sha256(work_item).slice(0, 8)}`;
  const dest = join(destRoot, stamp);
  mkdirSync(dest, { recursive: true });
  if (existsSync(sessionsDir)) cpSync(sessionsDir, join(dest, "sessions"), { recursive: true });
  writeFileSync(join(dest, "run.json"), JSON.stringify({ status: run.status, ...(reason !== undefined ? { reason } : {}), work_item, stdout: run.stdout.slice(-20_000), stderr: run.stderr.slice(-20_000) }, null, 2));
}

/**
 * Debug-only worker session preservation. When CADP_DEBUG_SESSIONS_DIR is set, copy EVERY run's
 * session log + stdout/stderr/status to a persistent per-run folder. Default OFF (no bloat) —
 * failure retention below covers the postmortem case without this.
 */
function preserveWorkerSession(sessionsDir: string, run: { status: number | null; stdout: string; stderr: string }, work_item: string): void {
  const debugDir = process.env["CADP_DEBUG_SESSIONS_DIR"];
  if (debugDir === undefined || debugDir.length === 0) return;
  try {
    copySessionSnapshot(debugDir, sessionsDir, run, work_item);
  } catch { /* debugging aid must never break a run */ }
}

/** Bounded failure retention: newest snapshots kept, oldest pruned (stamps sort lexicographically). */
export const FAILED_SESSION_RETENTION = 20;

/**
 * Failure-only session retention. The pilot series (#149 dogfooding) showed that exactly when a
 * worker run fails — TERMINATED at its bound, nonzero exit, or a no-op candidate — its session log
 * is the ONLY record of what the model actually did, and the ephemeral workspace deletion was
 * destroying it. Successful runs stay ephemeral (the size concern that made retention opt-in);
 * failures are rare, small, and precisely the runs that need a postmortem. Enabled by the
 * deployment via CADP_FAILED_SESSIONS_DIR (ctl wires it to <env>/failed-sessions); absent ⇒ off.
 * Retention is bounded to the newest FAILED_SESSION_RETENTION snapshots so it can never grow
 * without limit. Never breaks a run.
 */
export function preserveFailedSession(sessionsDir: string, run: { status: number | null; stdout: string; stderr: string }, work_item: string, reason: string): void {
  const failedDir = process.env["CADP_FAILED_SESSIONS_DIR"];
  if (failedDir === undefined || failedDir.length === 0) return;
  try {
    copySessionSnapshot(failedDir, sessionsDir, run, work_item, reason);
    const entries = readdirSync(failedDir).sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - FAILED_SESSION_RETENTION))) {
      rmSync(join(failedDir, stale), { recursive: true, force: true });
    }
  } catch { /* retention aid must never break a run */ }
}

/**
 * #91 method: scan the worker's OWN provider session log for the observed model; PRESENT facts
 * carry a locator. A provider WITHOUT a measured `model_scan` returns UNKNOWN (no guessed value) —
 * requested != observed honesty. The capture group lives in the provider's MEASURED spec (codex
 * `"model":"…"`, grok `"model_id":"…"`), so the scan itself is provider-independent.
 */
export function scanBackendModel(provider: WorkerProvider, sessionsDir: string, stdout: string): { model?: string; locator?: string } {
  const spec = WORKER_PROVIDERS[provider].model_scan;
  if (spec === undefined) return {}; // format not measured for this provider → UNKNOWN
  let model: string | undefined;
  let locator: string | undefined;
  const sessionRe = new RegExp(spec.session_regex, "u");
  const scan = (file: string): void => {
    const content = readFileSync(file, "utf8");
    const m = sessionRe.exec(content);
    if (m !== null && m[1] !== undefined) { model = m[1]; locator = `${file}#offset=${m.index}`; }
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
    const m = new RegExp(spec.stdout_regex, "u").exec(stdout);
    if (m !== null) { model = m[1]; locator = `${provider}-worker-stdout#pattern=${spec.stdout_regex}`; }
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
    // Dependency provisioning (self-host friction): the verifier container runs `node --test`
    // under `--network none`, so it cannot fetch dependencies — a target whose own suite imports
    // packages (CADP itself imports @temporalio/*) would fail every such test with
    // ERR_MODULE_NOT_FOUND, which is NOT a verdict about the candidate. The trusted broker (which
    // has network but holds no kernel token or secret) therefore populates node_modules HERE,
    // before the network-isolated test run, with `--ignore-scripts` so a candidate's install
    // scripts never execute on the broker host. A provisioning failure is UNKNOWN, never failure.
    const hasLock = existsSync(join(workspace, "package-lock.json"));
    if (hasLock || existsSync(join(workspace, "package.json"))) {
      const install = spawn("npm", [hasLock ? "ci" : "install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
      const installResult = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const err: Buffer[] = [];
        install.stderr?.on("data", (c: Buffer) => err.push(c));
        const timer = setTimeout(() => install.kill("SIGKILL"), 180_000);
        install.on("close", (status) => { clearTimeout(timer); resolve({ status, stderr: Buffer.concat(err).toString("utf8") }); });
        install.on("error", (e) => { clearTimeout(timer); resolve({ status: 127, stderr: String(e) }); });
      });
      if (installResult.status !== 0) {
        return { status: "UNKNOWN", clone_head, unknown_reason: `DEP_PROVISION_FAILED: ${installResult.stderr.slice(-200)}` };
      }
    }
    const test = await runVerifier(config(), { workspace, argv: ["node", "--test"], timeout_ms: SURFACE_BUDGETS.verify.surface_ms });
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

/**
 * Resolve a reviewer/planner profile's auth descriptor into the container injection (#155 §8.4).
 * `oauth_env` extracts the operator token; `auth_files` copies the declared files from the host
 * HOME into a fresh dir under `base` (deleted with the run) and mounts them READ-ONLY. Fail closed
 * on anything else — never reuse another provider's token, never fall back to worker auth.
 */
function surfaceProviderAuth(
  auth_method: ReviewProviderProfile["auth_method"] | PlanProviderProfile["auth_method"],
  base: string,
): ReviewerAuth {
  if (auth_method.kind === "oauth_env" && auth_method.env_var === "CLAUDE_CODE_OAUTH_TOKEN") {
    return { kind: "oauth_env", env_var: auth_method.env_var, token: claudeProviderToken() };
  }
  if (auth_method.kind === "auth_files") {
    const host = process.env["HOME"];
    if (host === undefined || host.length === 0) throw new Error("host HOME unavailable for provider auth files — failing closed");
    const authDir = join(base, "surface-auth");
    mkdirSync(authDir, { recursive: true });
    for (const file of auth_method.auth_files) {
      const src = join(host, auth_method.auth_subdir, file);
      if (!existsSync(src)) throw new Error(`provider auth file missing on host: ~/${auth_method.auth_subdir}/${file} — failing closed`);
      cpSync(src, join(authDir, file));
    }
    return { kind: "auth_files", auth_subdir: auth_method.auth_subdir, authDir, auth_files: auth_method.auth_files };
  }
  throw new Error(`unsupported surface auth method: ${auth_method.kind}`);
}

export async function brokerReview(body: { repo_full_name: string; candidate_sha: string; work_item: string; review_product?: string }): Promise<{
  verdict: string;
  reason: string;
  stdout: string;
}> {
  // Unknown review_product fails closed with no filesystem, process, docker, or network side
  // effect. An omitted selection keeps the measured claude path (byte-identical argv).
  const provider = resolveReviewProvider(body.review_product ?? DEFAULT_REVIEW_PROVIDER);
  const profile = REVIEW_PROVIDERS[provider];
  if (!(await dockerAvailable())) throw new Error("reviewer isolation runtime (docker) unavailable — failing closed");
  const base = mkdtempSync(join(tmpdir(), "cadp-review-"));
  try {
    const workspace = join(base, "ws");
    let r = await git(["clone", "--quiet", `https://github.com/${body.repo_full_name}.git`, workspace]);
    if (r.status !== 0) throw new Error(`clone failed: ${r.stderr.slice(0, 300)}`);
    await git(["fetch", "--quiet", "origin", `refs/heads/cadp/candidate/${body.candidate_sha}`], workspace);
    r = await git(["checkout", "--quiet", body.candidate_sha], workspace);
    if (r.status !== 0) throw new Error(`checkout failed: ${r.stderr.slice(0, 300)}`);
    // The reviewer must see the CANDIDATE'S CUMULATIVE change, not just its tip commit. `git show`
    // shows only the last commit — so a multi-round run whose real fix landed in an earlier round
    // and whose tip is a cosmetic follow-up would be reviewed as "no change", a false REJECT
    // (measured live: a correct api.ts fix rejected because the tip commit only renamed a test).
    // Diff from the candidate's fork point off main to the candidate.
    const mb = await git(["merge-base", "origin/main", body.candidate_sha], workspace);
    const forkBase = mb.status === 0 && mb.stdout.trim().length > 0 ? mb.stdout.trim() : "origin/main";
    const diff = (await git(["diff", "--stat", "--patch", forkBase, body.candidate_sha], workspace)).stdout.slice(0, 60_000);

    const prompt = `You are reviewing the exact committed change below (commit ${body.candidate_sha}) implementing: "${body.work_item}". Reply with exactly APPROVE or REQUEST_CHANGES on the first line, then one short reason line.\n\n${diff}`;
    const reviewWs = join(base, "review-ws");
    mkdirSync(reviewWs, { recursive: true });
    const review = await runReviewer(config(), {
      workspace: reviewWs,
      auth: surfaceProviderAuth(profile.auth_method, base),
      argv: reviewArgv(provider, prompt),
      timeout_ms: SURFACE_BUDGETS.review.surface_ms,
    });
    if (review.status !== 0 || review.stdout.trim().length === 0) {
      throw new Error(`reviewer surface failed — ${surfaceFailure("reviewer", review)}`);
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

// ------------------------------------------------------------------ /plan

/**
 * Proposal-only planner surface (#61 roadmap): a read-only reviewer-class container reads the
 * checkout at base_sha and decomposes the whole intent into bounded work items. Output is parsed
 * against the closed cadp.work-proposal.v1 schema and FAILS CLOSED on any deviation — a proposal
 * is never repaired, and it confers no authority (WORK_START remains the only admission).
 */
export async function brokerPlan(body: { repo_full_name: string; base_sha: string; intent: string; plan_product?: string }): Promise<{
  proposal: ReturnType<typeof parseWorkProposal>;
  stdout_digest: string;
}> {
  // Unknown plan_product fails closed with no filesystem, process, docker, or network side
  // effect. An omitted selection keeps the measured claude path (byte-identical argv).
  const provider = resolvePlanProvider(body.plan_product ?? DEFAULT_PLAN_PROVIDER);
  const profile = PLAN_PROVIDERS[provider];
  if (!(await dockerAvailable())) throw new Error("planner isolation runtime (docker) unavailable — failing closed");
  const base = mkdtempSync(join(tmpdir(), "cadp-plan-"));
  try {
    const workspace = join(base, "ws");
    let r = await git(["clone", "--quiet", `https://github.com/${body.repo_full_name}.git`, workspace]);
    if (r.status !== 0) throw new Error(`clone failed: ${r.stderr.slice(0, 300)}`);
    r = await git(["checkout", "--quiet", body.base_sha], workspace);
    if (r.status !== 0) throw new Error(`checkout ${body.base_sha} failed: ${r.stderr.slice(0, 300)}`);

    const prompt = buildPlanPrompt(body.intent, body.repo_full_name, body.base_sha);
    const run = await runReviewer(config(), {
      workspace,
      auth: surfaceProviderAuth(profile.auth_method, base),
      // Read-only planning surface: reading the checkout is allowed; every mutating/external tool is not.
      argv: planArgv(provider, prompt),
      timeout_ms: SURFACE_BUDGETS.plan.surface_ms,
    });
    if (run.status !== 0 || run.stdout.trim().length === 0) {
      throw new Error(`planner surface failed — ${surfaceFailure("planner", run)}`);
    }
    return { proposal: parseWorkProposal(run.stdout), stdout_digest: sha256(run.stdout) };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ server

/**
 * One broker operation: the surface run plus the explicit bound (#128) on answering the request
 * at all. `response_budget_ms` sits above the inner surface kill and below the caller's RPC
 * budget, so the normal ordering lets the surface terminate and run its cleanup first.
 */
export interface BrokerOperation {
  readonly response_budget_ms: number;
  readonly run: (body: Record<string, unknown>) => Promise<unknown>;
}

export const BROKER_OPERATIONS: Record<string, BrokerOperation> = {
  "/implement": {
    response_budget_ms: SURFACE_BUDGETS.implement.broker_response_ms,
    run: (b) => brokerImplement(b as { repo_full_name: string; base_sha: string; work_item: string; worker_product: string }),
  },
  "/verify": {
    response_budget_ms: SURFACE_BUDGETS.verify.broker_response_ms,
    run: (b) => brokerVerify(b as { repo_full_name: string; candidate_sha: string }),
  },
  "/review": {
    response_budget_ms: SURFACE_BUDGETS.review.broker_response_ms,
    run: (b) => brokerReview(b as { repo_full_name: string; candidate_sha: string; work_item: string; review_product?: string }),
  },
  "/plan": {
    response_budget_ms: SURFACE_BUDGETS.plan.broker_response_ms,
    run: (b) => brokerPlan(b as { repo_full_name: string; base_sha: string; intent: string; plan_product?: string }),
  },
};

/**
 * The broker HTTP server. `operations` defaults to the production table; the conformance controls
 * pass a scripted operation so they exercise THIS server construction, not a copy of it.
 */
export function startBroker(port: number, operations: Record<string, BrokerOperation> = BROKER_OPERATIONS): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    const operation = req.url !== undefined ? operations[req.url] : undefined;
    if (req.method !== "POST" || operation === undefined) {
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
      return;
    }
    const path = req.url!;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown>;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
      catch { res.writeHead(400).end(JSON.stringify({ error: "bad json" })); return; }

      // Exactly one response per request. A surface run that outlives its declared response
      // budget gets a bounded 504 here; its late result — however it eventually resolves — is
      // DISCARDED, so an over-budget run can never be answered as a success or reused as a
      // stale response (#128 T2). The run's own `finally` cleanup still executes.
      let answered = false;
      const started = Date.now();
      const answer = (status: number, payload: unknown): void => {
        if (answered) return;
        answered = true;
        clearTimeout(guard);
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
      };
      const guard = setTimeout(() => {
        answer(504, {
          error: `broker ${path} exceeded its declared response budget of ${operation.response_budget_ms}ms after ${Date.now() - started}ms`,
        });
      }, operation.response_budget_ms);
      // A client that walked away (its own RPC budget expired) leaves no dangling guard timer.
      res.on("close", () => { answered = true; clearTimeout(guard); });

      operation.run(body)
        .then((result) => { answer(200, result); })
        .catch((e: unknown) => { answer(500, { error: e instanceof Error ? e.message : String(e) }); });
    });
  });
  // Request-RECEIPT bounds only: measured on Node v26, neither bounds an already-received request
  // whose long response is still being produced. The socket-inactivity timer stays disabled — it
  // would kill exactly the healthy long-running responses #127 lost; the finite server-side bound
  // is the per-request response guard above.
  server.headersTimeout = BROKER_SERVER_TIMEOUTS.headers_ms;
  server.requestTimeout = BROKER_SERVER_TIMEOUTS.request_ms;
  server.keepAliveTimeout = BROKER_SERVER_TIMEOUTS.keep_alive_ms;
  server.timeout = BROKER_SERVER_TIMEOUTS.socket_inactivity_ms;
  server.listen(port, "127.0.0.1", () => {
    const bound = server.address();
    console.log(JSON.stringify({ broker: "started", pid: process.pid, port: typeof bound === "object" && bound !== null ? bound.port : port }));
  });
  return server;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("surfaceBroker.ts")) {
  startBroker(Number(process.env["CADP_BROKER_PORT"] ?? "0"));
}
