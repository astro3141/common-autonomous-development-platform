/**
 * Temporal activities (TD §7.4, §8): every governed effect converges through durable kernel
 * state (`get_effect_state`) before any admission request — a replayed/retried activity
 * re-reads rows, never blind-retries a dispatch. Worker/reviewer/verifier surfaces run as
 * sandboxed subprocesses with their own principals; no governed credential exists here.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { KernelClient } from "../clients/kernelClient.ts";
import type { EvidenceEnvelopeV1 } from "../kernel/records.ts";

const ZERO_SHA = "0000000000000000000000000000000000000000";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`activity environment missing ${name}`);
  return value;
}

function workflowClient(): KernelClient {
  return new KernelClient(env("CADP_KERNEL_URL"), env("CADP_WORKFLOW_TOKEN"));
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function nowMs(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- WORK_STEP evidence

async function submitWorkStep(input: {
  work_run_ref: string;
  step_ordinal: number;
  input_digest: string;
  output_digest: string;
  summary: string;
  prior_step_envelope_digest?: string;
}): Promise<EvidenceEnvelopeV1> {
  const client = workflowClient();
  return client.submitEvidence({
    evidence_kind: "WORK_STEP",
    subject_bindings: [
      { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: input.work_run_ref },
      { authority_ref: "cadp-store:k04", namespace: "step-input", object_id: input.input_digest },
      { authority_ref: "cadp-store:k04", namespace: "step-output", object_id: input.output_digest },
    ],
    availability: "PRESENT",
    claim_schema: "cadp.work-step.v1",
    claim: {
      step_ordinal: input.step_ordinal,
      summary: input.summary,
      ...(input.prior_step_envelope_digest !== undefined ? { prior_step_envelope_digest: input.prior_step_envelope_digest } : {}),
    },
    producer_ref: "workflow:cadp-work",
    source_ref: `temporal:${input.work_run_ref}`,
    source_relation: "SELF_REPORT",
  });
}

export async function submitBoundStop(
  work_run_ref: string,
  step_ordinal: number,
  bound: string,
  prior_step_envelope_digest?: string,
): Promise<void> {
  const client = workflowClient();
  await client.submitEvidence({
    evidence_kind: "WORK_BOUND_STOP",
    subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: work_run_ref }],
    availability: "PRESENT",
    claim_schema: "cadp.work-bound-stop.v1",
    claim: { bound, at_step: step_ordinal, ...(prior_step_envelope_digest !== undefined ? { prior_step_envelope_digest } : {}) },
    producer_ref: "workflow:cadp-work",
    source_ref: `temporal:${work_run_ref}`,
    source_relation: "SELF_REPORT",
  });
}

// ---------------------------------------------------------------- governed effect driver

interface GovernedResult {
  effect_id: string;
  outcome: string;
  detail?: string;
  target_operation_ref?: string;
}

/**
 * TD §7.4: allocate (idempotent) → read durable state → branch → seal → evaluate → admit.
 * On UNKNOWN: one reconcile request + re-read; never a blind second dispatch.
 */
async function governedEffect(input: {
  work_run_ref: string;
  step_ordinal: number;
  purpose: string;
  target_ref: { authority_ref: string; target_type: string; target_id: string };
  operation_kind: string;
  material_schema: string;
  buildMaterial: (effect_id: string) => Promise<Record<string, unknown>>;
  evidence_refs: string[];
  prior_effect_refs?: string[];
  extra_bindings?: Array<{ authority_ref: string; namespace: string; object_id: string; revision_or_version?: string }>;
}): Promise<GovernedResult> {
  const client = workflowClient();
  const { effect_id } = await client.allocateEffectId({
    schema: "cadp.allocation-key.v1",
    work_run_ref: input.work_run_ref,
    step_ordinal: input.step_ordinal,
    purpose: input.purpose,
  });

  // Durable-state branch (Spec §6.3): committed → done; unresolved → reconcile, never redo.
  let state: Awaited<ReturnType<KernelClient["getEffectState"]>> | undefined;
  try {
    state = await client.getEffectState(effect_id);
  } catch {
    state = undefined; // not sealed yet
  }
  if (state !== undefined) {
    const committed = state.outcomes.find((o) => o.result === "COMMITTED");
    if (committed !== undefined) {
      return { effect_id, outcome: "COMMITTED", target_operation_ref: committed.target_operation_ref };
    }
    if (state.admissions.length > 0) {
      await client.requestReconcile(effect_id);
      const after = await client.getEffectState(effect_id);
      const resolved = after.outcomes.find((o) => o.result === "COMMITTED" || o.result === "NO_EFFECT_CONFIRMED");
      if (resolved?.result === "COMMITTED") {
        return { effect_id, outcome: "COMMITTED", target_operation_ref: resolved.target_operation_ref };
      }
      if (resolved === undefined) {
        return { effect_id, outcome: "UNKNOWN", detail: "prior admission unresolved; reconciliation pending" };
      }
      // NO_EFFECT_CONFIRMED → fall through to a fresh admission of the SAME effect.
    }
  }

  const material = await input.buildMaterial(effect_id);
  const materialBytes = Buffer.from(JSON.stringify(material), "utf8");
  const { cas_key } = await client.putBlob(materialBytes);
  await client.sealEffectRequest({
    effect_id,
    requester_ref: "workflow:cadp-work",
    work_bindings: [
      { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: input.work_run_ref },
      ...(input.extra_bindings ?? []),
    ],
    target_ref: input.target_ref,
    operation_kind: input.operation_kind,
    material_schema: input.material_schema,
    material_ref: cas_key,
    prior_effect_refs: input.prior_effect_refs ?? [],
  });

  const assembled = await client.assembleAdmissionInput(effect_id, input.evidence_refs);
  const evaluated = await client.evaluate(assembled.input_digest.value);
  if (evaluated.kind !== "DECISION") {
    return { effect_id, outcome: "EVALUATION_UNAVAILABLE", detail: JSON.stringify(evaluated) };
  }
  if (evaluated.decision.outcome !== "ALLOW") {
    return { effect_id, outcome: evaluated.decision.outcome, detail: evaluated.decision.reason_codes.join(",") };
  }
  const admitted = await client.admitAndDispatch(effect_id, evaluated.decision.decision_id);
  if (admitted.kind === "REFUSAL") {
    return { effect_id, outcome: `REFUSED_${admitted.reason}`, detail: admitted.detail };
  }
  if (admitted.outcome.result === "UNKNOWN") {
    await client.requestReconcile(effect_id);
    const after = await client.getEffectState(effect_id);
    const committed = after.outcomes.find((o) => o.result === "COMMITTED");
    if (committed !== undefined) {
      return { effect_id, outcome: "COMMITTED", target_operation_ref: committed.target_operation_ref };
    }
    return { effect_id, outcome: "UNKNOWN", detail: admitted.outcome.unknown_reason };
  }
  return {
    effect_id,
    outcome: admitted.outcome.result,
    target_operation_ref: admitted.outcome.target_operation_ref,
  };
}

// ---------------------------------------------------------------- record vertical

export async function recordWriteStep(input: {
  work_run_ref: string;
  step_ordinal: number;
  tenant: string;
  resource_id: string;
  payload: string;
  prior_effect_id?: string;
  prior_step_envelope_digest?: string;
}): Promise<GovernedResult & { work_step_envelope_digest: string }> {
  const client = workflowClient();
  const evidence: string[] = [];
  const priors: string[] = [];
  let payload = input.payload;
  if (input.prior_effect_id !== undefined) {
    // Causal binding: B's body embeds A's target-authoritative receipt ref (P2).
    const priorState = await client.getEffectState(input.prior_effect_id);
    const committed = priorState.outcomes.find((o) => o.result === "COMMITTED");
    if (committed === undefined) throw new Error(`prior effect ${input.prior_effect_id} is not COMMITTED`);
    payload = JSON.stringify({ body: input.payload, depends_on: { effect_id: input.prior_effect_id, record: committed.target_operation_ref } });
    const priorEvidence = await client.sealPriorState(input.prior_effect_id);
    evidence.push(priorEvidence.evidence_id);
    priors.push(input.prior_effect_id);
  }
  const payloadBytes = Buffer.from(payload, "utf8");
  const { cas_key: body_cas_key } = await client.putBlob(payloadBytes);
  const body_digest = sha256(payloadBytes);

  const result = await governedEffect({
    work_run_ref: input.work_run_ref,
    step_ordinal: input.step_ordinal,
    purpose: "record-write",
    target_ref: { authority_ref: "record-service:disposable", target_type: "RECORD_SERVICE", target_id: "cadp-disposable" },
    operation_kind: "RECORD_WRITE",
    material_schema: "cadp.record-write.v1",
    buildMaterial: async (effect_id) => ({
      tenant: input.tenant,
      resource_id: input.resource_id,
      body_digest,
      body_cas_key,
      idempotency_key: `cadp-v04:${effect_id}`,
    }),
    evidence_refs: evidence,
    prior_effect_refs: priors,
  });

  const workStep = await submitWorkStep({
    work_run_ref: input.work_run_ref,
    step_ordinal: input.step_ordinal,
    input_digest: sha256(input.payload),
    output_digest: body_digest,
    summary: `RECORD_WRITE ${input.resource_id} -> ${result.outcome}`,
    prior_step_envelope_digest: input.prior_step_envelope_digest,
  });
  return { ...result, work_step_envelope_digest: workStep.envelope_digest.value };
}

// ---------------------------------------------------------------- development vertical

function run(cmd: string, args: string[], options: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: options.env ?? (process.env as Record<string, string>),
    encoding: "utf8",
    timeout: options.timeout ?? 600_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Sandboxed subprocess env (TD §4.1): fresh HOME, no ambient tokens, no gh config. */
function sandboxEnv(home: string): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    GH_CONFIG_DIR: join(home, ".config", "gh-empty"),
    TMPDIR: join(home, "tmp"),
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

export async function implementCandidate(input: {
  work_run_ref: string;
  step_ordinal: number;
  repo_full_name: string;
  base_sha: string;
  work_item: string;
  prior_step_envelope_digest?: string;
}): Promise<{
  candidate_sha: string;
  bundle_cas_key: string;
  work_step_envelope_id: string;
  work_step_envelope_digest: string;
  backend_evidence_id: string;
}> {
  const client = workflowClient();
  const base = mkdtempSync(join(tmpdir(), "cadp-impl-"));
  try {
    // Fresh workspace at exactly base_sha (TD §8.1 — never a reused dirty tree).
    const workspace = join(base, "ws");
    let r = run("git", ["clone", "--quiet", `https://github.com/${input.repo_full_name}.git`, workspace]);
    if (r.status !== 0) throw new Error(`clone failed: ${r.stderr.slice(0, 300)}`);
    r = run("git", ["checkout", "--quiet", input.base_sha], { cwd: workspace });
    if (r.status !== 0) throw new Error(`checkout ${input.base_sha} failed: ${r.stderr.slice(0, 300)}`);

    // Worker sandbox home: codex auth copied in; NO gh config, NO ambient tokens.
    const home = join(base, "home");
    mkdirSync(join(home, "tmp"), { recursive: true });
    const realCodex = join(process.env["HOME"] ?? "", ".codex");
    if (existsSync(realCodex)) cpSync(realCodex, join(home, ".codex"), { recursive: true });

    // Pinned worker argv (TD §8.1; #89 profile trap): part of worker_profile_digest.
    const argv = ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", workspace, input.work_item];
    const workerRun = run("codex", argv, { cwd: workspace, env: sandboxEnv(home), timeout: 900_000 });
    if (workerRun.status !== 0) {
      throw new Error(`codex exited ${workerRun.status}: ${workerRun.stderr.slice(0, 400)}`);
    }

    // The harness commits the worker-local candidate (worker cannot push — no credential).
    run("git", ["add", "-A"], { cwd: workspace });
    r = run("git", ["-c", "user.name=cadp-worker", "-c", "user.email=worker@cadp-v04.invalid", "commit", "-m", `cadp candidate: ${input.work_item.slice(0, 60)}`], { cwd: workspace });
    if (r.status !== 0) throw new Error(`nothing to commit: ${r.stderr.slice(0, 200)} ${r.stdout.slice(0, 200)}`);
    const candidate_sha = run("git", ["rev-parse", "HEAD"], { cwd: workspace }).stdout.trim();

    // Complete bundle whose single head IS the candidate (TD §6.6).
    run("git", ["branch", "-f", "cadp-candidate", candidate_sha], { cwd: workspace });
    const bundlePath = join(base, "candidate.bundle");
    r = run("git", ["bundle", "create", bundlePath, "cadp-candidate"], { cwd: workspace });
    if (r.status !== 0) throw new Error(`bundle create failed: ${r.stderr.slice(0, 300)}`);
    const { cas_key: bundle_cas_key } = await client.putBlob(readFileSync(bundlePath));

    // Backend identity: scan, don't address (#91) — locator-bearing observed facts only.
    const backendEvidence = await submitBackendExecution(input.work_run_ref, input.step_ordinal, home, workerRun.stdout);

    const workStep = await submitWorkStep({
      work_run_ref: input.work_run_ref,
      step_ordinal: input.step_ordinal,
      input_digest: sha256(JSON.stringify({ base_sha: input.base_sha, work_item: input.work_item })),
      output_digest: candidate_sha,
      summary: `implement candidate ${candidate_sha.slice(0, 12)}`,
      prior_step_envelope_digest: input.prior_step_envelope_digest,
    });
    return {
      candidate_sha,
      bundle_cas_key,
      work_step_envelope_id: workStep.evidence_id,
      work_step_envelope_digest: workStep.envelope_digest.value,
      backend_evidence_id: backendEvidence,
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** #91 method: scan the worker's own session log; PRESENT facts carry locators; absent = UNKNOWN. */
async function submitBackendExecution(work_run_ref: string, step_ordinal: number, home: string, stdout: string): Promise<string> {
  const scanClient = new KernelClient(env("CADP_KERNEL_URL"), env("CADP_BACKEND_SCAN_TOKEN"));
  const sessionsDir = join(home, ".codex", "sessions");
  let modelValue: string | undefined;
  let locator: string | undefined;
  const scan = (file: string): void => {
    const content = readFileSync(file, "utf8");
    const idx = content.search(/"model"\s*:\s*"/u);
    if (idx >= 0) {
      const m = /"model"\s*:\s*"([^"]+)"/u.exec(content.slice(idx, idx + 200));
      if (m !== null) {
        modelValue = m[1];
        locator = `${file}#offset=${idx}`;
      }
    }
  };
  try {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (modelValue === undefined && (entry.endsWith(".jsonl") || entry.endsWith(".json"))) scan(p);
      }
    };
    if (existsSync(sessionsDir)) walk(sessionsDir);
  } catch { /* absent facts stay UNKNOWN */ }
  const stdoutModel = /model:\s*(\S+)/u.exec(stdout);
  if (modelValue === undefined && stdoutModel !== null) {
    modelValue = stdoutModel[1];
    locator = "worker-stdout#pattern=model:";
  }
  const observed: Record<string, unknown> = {
    model:
      modelValue !== undefined
        ? { availability: "PRESENT", value: modelValue, locator }
        : { availability: "UNKNOWN" },
    provider: { availability: "UNKNOWN" },
    run_id: { availability: "UNKNOWN" },
    version: { availability: "UNKNOWN" },
    effort: { availability: "UNKNOWN" },
  };
  const envelope = await scanClient.submitEvidence({
    evidence_kind: "BACKEND_EXECUTION",
    subject_bindings: [
      { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: work_run_ref },
      { authority_ref: "cadp-store:k04", namespace: "step", object_id: `${work_run_ref}#${step_ordinal}` },
    ],
    availability: "PRESENT",
    claim_schema: "cadp.backend.v1",
    claim: { requested: { model: "codex default" }, observed },
    producer_ref: "backend-scan:codex",
    source_ref: "codex session log scan",
    source_relation: "SELF_REPORT",
  });
  return envelope.evidence_id;
}

export async function governedGitPush(input: {
  work_run_ref: string;
  step_ordinal: number;
  repo_id: string;
  candidate_sha: string;
  bundle_cas_key: string;
  prior_step_envelope_digest?: string;
}): Promise<GovernedResult & { work_step_envelope_digest: string }> {
  const result = await governedEffect({
    work_run_ref: input.work_run_ref,
    step_ordinal: input.step_ordinal,
    purpose: "git-push",
    target_ref: { authority_ref: "github.com", target_type: "GIT_REPOSITORY", target_id: input.repo_id },
    operation_kind: "GIT_PUSH",
    material_schema: "cadp.git-push.v1",
    buildMaterial: async () => ({
      repo_id: input.repo_id,
      ref: `refs/heads/cadp/candidate/${input.candidate_sha}`,
      new_sha: input.candidate_sha,
      expected_old_sha: ZERO_SHA,
      bundle_cas_key: input.bundle_cas_key,
    }),
    evidence_refs: [],
  });
  const workStep = await submitWorkStep({
    work_run_ref: input.work_run_ref,
    step_ordinal: input.step_ordinal,
    input_digest: input.candidate_sha,
    output_digest: input.candidate_sha,
    summary: `GIT_PUSH candidate -> ${result.outcome}`,
    prior_step_envelope_digest: input.prior_step_envelope_digest,
  });
  return { ...result, work_step_envelope_digest: workStep.envelope_digest.value };
}

export async function verifyCandidate(input: {
  work_run_ref: string;
  step_ordinal: number;
  repo_full_name: string;
  repo_id: string;
  candidate_sha: string;
  prior_step_envelope_digest?: string;
}): Promise<{ verification_evidence_id: string; conclusion: string; work_step_envelope_digest: string }> {
  const verifier = new KernelClient(env("CADP_KERNEL_URL"), env("CADP_VERIFIER_TOKEN"));
  const base = mkdtempSync(join(tmpdir(), "cadp-verify-"));
  const started_at = nowMs();
  try {
    // Fresh clone at exactly the candidate sha (TD §8.2 harness alternative).
    const workspace = join(base, "ws");
    let r = run("git", ["clone", "--quiet", `https://github.com/${input.repo_full_name}.git`, workspace]);
    if (r.status !== 0) throw new Error(`clone failed: ${r.stderr.slice(0, 300)}`);
    r = run("git", ["fetch", "--quiet", "origin", `refs/heads/cadp/candidate/${input.candidate_sha}`], { cwd: workspace });
    r = run("git", ["checkout", "--quiet", input.candidate_sha], { cwd: workspace });
    if (r.status !== 0) throw new Error(`checkout candidate failed: ${r.stderr.slice(0, 300)}`);
    const cloneHead = run("git", ["rev-parse", "HEAD"], { cwd: workspace }).stdout.trim();
    const porcelain = run("git", ["status", "--porcelain"], { cwd: workspace }).stdout.trim();

    if (porcelain.length > 0 || cloneHead !== input.candidate_sha) {
      // Dirty tree ⇒ UNKNOWN, never PASS (C11 / #89 false-PASS).
      const envelope = await verifier.submitEvidence({
        evidence_kind: "VERIFICATION",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: input.candidate_sha, revision_or_version: input.candidate_sha }],
        availability: "UNKNOWN",
        claim_schema: "cadp.verification.harness.v1",
        unknown_reason: porcelain.length > 0 ? "DIRTY_WORKSPACE" : "HEAD_MISMATCH",
        producer_ref: "verifier:harness",
        source_ref: `fresh-clone:${cloneHead}`,
        source_relation: "INDEPENDENT_OBSERVATION",
      });
      const workStep = await submitWorkStep({
        work_run_ref: input.work_run_ref, step_ordinal: input.step_ordinal,
        input_digest: input.candidate_sha, output_digest: envelope.envelope_digest.value,
        summary: "verification UNKNOWN", prior_step_envelope_digest: input.prior_step_envelope_digest,
      });
      return { verification_evidence_id: envelope.evidence_id, conclusion: "UNKNOWN", work_step_envelope_digest: workStep.envelope_digest.value };
    }

    const test = run("node", ["--test"], { cwd: workspace, timeout: 300_000 });
    const completed_at = nowMs();
    const conclusion = test.status === 0 ? "success" : "failure";
    const envelope = await verifier.submitEvidence({
      evidence_kind: "VERIFICATION",
      subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: input.candidate_sha, revision_or_version: input.candidate_sha }],
      availability: "PRESENT",
      claim_schema: "cadp.verification.harness.v1",
      claim: {
        head_sha: input.candidate_sha,
        clone_head: cloneHead,
        porcelain_empty: true,
        conclusion,
        runner: "node --test",
        started_at,
        completed_at,
        output_digest: sha256(test.stdout + test.stderr),
      },
      produced_at: completed_at, // SOURCE contract /completed_at (TD §9.1)
      producer_ref: "verifier:harness",
      source_ref: `fresh-clone:${cloneHead}`,
      source_relation: "INDEPENDENT_OBSERVATION",
    });
    const workStep = await submitWorkStep({
      work_run_ref: input.work_run_ref, step_ordinal: input.step_ordinal,
      input_digest: input.candidate_sha, output_digest: envelope.envelope_digest.value,
      summary: `verification ${conclusion}`, prior_step_envelope_digest: input.prior_step_envelope_digest,
    });
    return { verification_evidence_id: envelope.evidence_id, conclusion, work_step_envelope_digest: workStep.envelope_digest.value };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export async function reviewCandidate(input: {
  work_run_ref: string;
  step_ordinal: number;
  repo_full_name: string;
  repo_id: string;
  candidate_sha: string;
  work_item: string;
  prior_step_envelope_digest?: string;
}): Promise<{ review_evidence_id: string; verdict: string; work_step_envelope_digest: string }> {
  const reviewer = new KernelClient(env("CADP_KERNEL_URL"), env("CADP_REVIEWER_TOKEN"));
  const base = mkdtempSync(join(tmpdir(), "cadp-review-"));
  try {
    const workspace = join(base, "ws");
    let r = run("git", ["clone", "--quiet", `https://github.com/${input.repo_full_name}.git`, workspace]);
    if (r.status !== 0) throw new Error(`clone failed: ${r.stderr.slice(0, 300)}`);
    run("git", ["fetch", "--quiet", "origin", `refs/heads/cadp/candidate/${input.candidate_sha}`], { cwd: workspace });
    r = run("git", ["checkout", "--quiet", input.candidate_sha], { cwd: workspace });
    if (r.status !== 0) throw new Error(`checkout failed: ${r.stderr.slice(0, 300)}`);
    const diff = run("git", ["show", "--stat", "--patch", input.candidate_sha], { cwd: workspace }).stdout.slice(0, 40_000);

    // Second-surface reviewer (measured #90: Claude Code, read-only): exact committed diff.
    const home = join(base, "home");
    mkdirSync(join(home, "tmp"), { recursive: true });
    const prompt = `You are reviewing the exact committed change below (commit ${input.candidate_sha}) implementing: "${input.work_item}". Reply with exactly APPROVE or REQUEST_CHANGES on the first line, then one short reason line.\n\n${diff}`;
    const review = run("claude", ["-p", "--model", "claude-sonnet-5", "--permission-mode", "plan", prompt], {
      cwd: workspace,
      env: { ...sandboxEnv(home), HOME: process.env["HOME"] ?? home },
      timeout: 300_000,
    });
    const firstLine = review.stdout.trim().split("\n")[0]?.trim() ?? "";
    const verdict = firstLine.includes("APPROVE") && !firstLine.includes("REQUEST_CHANGES") ? "APPROVE" : "REQUEST_CHANGES";

    const envelope = await reviewer.submitEvidence({
      evidence_kind: "REVIEW",
      subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: input.candidate_sha, revision_or_version: input.candidate_sha }],
      availability: "PRESENT",
      claim_schema: "cadp.review.v1",
      claim: { verdict, body_digest: sha256(review.stdout), reviewer_run_id: `claude-p:${Date.now()}` },
      producer_ref: "reviewer:claude-code",
      source_ref: `claude-code:plan-mode`,
      source_relation: "INDEPENDENT_OBSERVATION",
    });
    const workStep = await submitWorkStep({
      work_run_ref: input.work_run_ref, step_ordinal: input.step_ordinal,
      input_digest: input.candidate_sha, output_digest: envelope.envelope_digest.value,
      summary: `review ${verdict}`, prior_step_envelope_digest: input.prior_step_envelope_digest,
    });
    return { review_evidence_id: envelope.evidence_id, verdict, work_step_envelope_digest: workStep.envelope_digest.value };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

export async function governedPrCreate(input: {
  work_run_ref: string;
  step_ordinal: number;
  repo_id: string;
  base_ref: string;
  candidate_sha: string;
  work_item: string;
  evidence_refs: string[];
  prior_step_envelope_digest?: string;
}): Promise<GovernedResult & { pr_number?: number; work_step_envelope_digest: string }> {
  const client = workflowClient();
  const title = Buffer.from(`CADP candidate: ${input.work_item.slice(0, 80)}`, "utf8");
  const body = Buffer.from(
    `Autonomous candidate \`${input.candidate_sha}\` for work run.\n\nGoverned by CADP v0.4 kernel: verification + independent review evidence sealed before admission.`,
    "utf8",
  );
  const { cas_key: title_cas_key } = await client.putBlob(title);
  const { cas_key: body_cas_key } = await client.putBlob(body);

  const result = await governedEffect({
    work_run_ref: input.work_run_ref,
    step_ordinal: input.step_ordinal,
    purpose: "pr-create",
    target_ref: { authority_ref: "github.com", target_type: "GIT_REPOSITORY", target_id: input.repo_id },
    operation_kind: "PR_CREATE",
    material_schema: "cadp.pr-create.v1",
    buildMaterial: async () => ({
      repo_id: input.repo_id,
      base_ref: input.base_ref,
      head_ref: `refs/heads/cadp/candidate/${input.candidate_sha}`,
      head_sha: input.candidate_sha,
      title_cas_key,
      body_cas_key,
    }),
    evidence_refs: input.evidence_refs,
  });
  const workStep = await submitWorkStep({
    work_run_ref: input.work_run_ref,
    step_ordinal: input.step_ordinal,
    input_digest: input.candidate_sha,
    output_digest: result.target_operation_ref ?? result.outcome,
    summary: `PR_CREATE -> ${result.outcome}`,
    prior_step_envelope_digest: input.prior_step_envelope_digest,
  });
  const prNumber = result.target_operation_ref !== undefined ? Number(/pull:(\d+)/u.exec(result.target_operation_ref)?.[1]) : undefined;
  return { ...result, pr_number: Number.isInteger(prNumber) ? prNumber : undefined, work_step_envelope_digest: workStep.envelope_digest.value };
}

export async function prepareMergeEffect(input: {
  work_run_ref: string;
  step_ordinal: number;
  repo_id: string;
  pr_number: number;
  expected_head_sha: string;
  evidence_refs: string[];
  prior_step_envelope_digest?: string;
}): Promise<{ effect_id: string; requires_human: boolean; work_step_envelope_digest: string }> {
  const client = workflowClient();
  const { effect_id } = await client.allocateEffectId({
    schema: "cadp.allocation-key.v1",
    work_run_ref: input.work_run_ref,
    step_ordinal: input.step_ordinal,
    purpose: "pr-merge",
  });
  const material = {
    repo_id: input.repo_id,
    pr_number: input.pr_number,
    expected_head_sha: input.expected_head_sha,
    merge_method: "merge",
  };
  const { cas_key } = await client.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  await client.sealEffectRequest({
    effect_id,
    requester_ref: "workflow:cadp-work",
    work_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: input.work_run_ref }],
    target_ref: { authority_ref: "github.com", target_type: "GIT_REPOSITORY", target_id: input.repo_id },
    operation_kind: "PR_MERGE",
    material_schema: "cadp.pr-merge.v1",
    material_ref: cas_key,
    prior_effect_refs: [],
  });
  // §9.3 path A: initial K4 WITHOUT Human evidence → REQUIRE_EVIDENCE(HUMAN_DECISION).
  const assembled = await client.assembleAdmissionInput(effect_id, input.evidence_refs);
  const evaluated = await client.evaluate(assembled.input_digest.value);
  const requiresHuman =
    evaluated.kind === "DECISION" &&
    evaluated.decision.outcome === "REQUIRE_EVIDENCE" &&
    evaluated.decision.reason_codes.includes("HUMAN_DECISION");
  const workStep = await submitWorkStep({
    work_run_ref: input.work_run_ref,
    step_ordinal: input.step_ordinal,
    input_digest: input.expected_head_sha,
    output_digest: effect_id,
    summary: `PR_MERGE sealed; human required: ${requiresHuman}`,
    prior_step_envelope_digest: input.prior_step_envelope_digest,
  });
  return { effect_id, requires_human: requiresHuman, work_step_envelope_digest: workStep.envelope_digest.value };
}

export async function completeMergeWithHumanDecision(input: {
  effect_id: string;
  human_evidence_id: string;
  evidence_refs: string[];
}): Promise<{ outcome: string; detail?: string }> {
  const client = workflowClient();
  // §9.3: NEW AdmissionInputV1 including the Human envelope → fresh evaluation → K6.
  const assembled = await client.assembleAdmissionInput(input.effect_id, [...input.evidence_refs, input.human_evidence_id]);
  const evaluated = await client.evaluate(assembled.input_digest.value);
  if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
    return { outcome: "NOT_ALLOWED", detail: JSON.stringify(evaluated).slice(0, 300) };
  }
  const admitted = await client.admitAndDispatch(input.effect_id, evaluated.decision.decision_id);
  if (admitted.kind === "REFUSAL") return { outcome: `REFUSED_${admitted.reason}`, detail: admitted.detail };
  return { outcome: admitted.outcome.result, detail: admitted.outcome.target_operation_ref };
}
