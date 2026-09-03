/**
 * PR #102 review repairs — negative controls:
 *  F1  verifier credential isolation: a MALICIOUS candidate test running under the real
 *      verifier env finds no kernel URL/tokens and cannot reach the Kernel API; the
 *      guard-bite (inherited worker env) DOES reach it — the control is load-bearing.
 *  F2  worker profile: sandbox imports ONLY codex auth material (no config.toml/MCP);
 *      env carries no ambient credentials; profile digest is deterministic.
 *  F3  reviewer isolation: minimal env carries no credential surfaces; gh/git mutation
 *      attempts under it fail.
 *  F4  prior-state truthfulness: recheck #7 accepts the prior's latest outcome presented
 *      byte-exact in SEALED material (or the genuine receipt envelope); a stale/wrong
 *      digest refuses; no kernel API can mint target-authority evidence for an UNKNOWN.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeHarness, runChain, sealScriptedRequest, stopSharedOpa } from "./support/harness.ts";

/** Async spawn: the kernel API server lives in THIS process, so probe children must run
 * while our event loop keeps serving (spawnSync would deadlock the probe's fetch). */
function spawnAsync(cmd: string, args: string[], options: { cwd?: string; env?: Record<string, string>; timeout?: number }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeout ?? 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}
import { startKernelApi } from "../kernel/api.ts";
import { buildWorkerSandbox, reviewerEnv, verifierEnv, workerEnv, workerProfileDigest, WORKER_AUTH_FILES } from "../product/workerProfile.ts";

after(() => stopSharedOpa());

// A malicious payload a candidate could hide in its test suite: probe the inherited env for
// kernel effect authority and try to use it. Run as a plain script under the SAME env boundary
// the live verifier gives candidate tests; it exits after writing its measurement.
const MALICIOUS_TEST = `
import { writeFileSync } from "node:fs";

const leaks = Object.keys(process.env).filter(
  (k) => k.startsWith("CADP_") || /(^|_)(TOKEN|SECRET)(_|$)/i.test(k) || k === "GH_TOKEN" || k === "GITHUB_TOKEN",
);
let kernel = "no-url-available";
const url = process.env.CADP_KERNEL_URL;
const token = process.env.CADP_WORKFLOW_TOKEN;
if (url !== undefined && token !== undefined) {
  try {
    const res = await fetch(url + "/allocate_effect_id", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-00000000ef11", step_ordinal: 666, purpose: "record-write" }),
    });
    kernel = "reached:" + res.status + ":" + JSON.stringify(await res.json()).slice(0, 120);
  } catch (e) {
    kernel = "unreachable:" + String(e).slice(0, 80);
  }
}
writeFileSync(process.env.MALICIOUS_REPORT ?? "/tmp/malicious-report.json", JSON.stringify({ leaks, kernel }));
process.exit(0);
`;

test("F1: candidate tests under the verifier env have NO kernel effect authority; guard-bite proves the env is the guard", async () => {
  const h = await makeHarness();
  const dir = mkdtempSync(join(tmpdir(), "cadp-f1-"));
  let api: { port: number; close(): void } | undefined;
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    // A live kernel API with a workflow token — exactly what the Temporal worker process holds.
    const tokens = new Map([["tok-wf", "cadp-workflow"]]);
    api = await startKernelApi(
      { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens },
      0,
    );
    // Simulate the worker-process env that verifyCandidate runs inside. (Node test-runner
    // IPC variables are stripped — they are harness plumbing, not part of the finding, and
    // they wedge a nested `node --test`.)
    const workerProcessEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key.startsWith("NODE_TEST") || key === "NODE_OPTIONS" || key === "FORCE_COLOR") continue;
      workerProcessEnv[key] = value;
    }
    workerProcessEnv["CADP_KERNEL_URL"] = `http://127.0.0.1:${api.port}`;
    workerProcessEnv["CADP_WORKFLOW_TOKEN"] = "tok-wf";
    workerProcessEnv["CADP_VERIFIER_TOKEN"] = "tok-x";
    const workspace = join(dir, "candidate");
    writeFileSync(join(dir, "report.json"), "{}");
    const testDir = join(workspace, "test");
    spawnSync("mkdir", ["-p", testDir]);
    writeFileSync(join(testDir, "malicious-probe.mjs"), MALICIOUS_TEST);

    // Production path: verifierEnv() — the scrubbed env used by verifyCandidate.
    const scrubbed = { ...verifierEnv(join(dir, "verifier-home")), MALICIOUS_REPORT: join(dir, "report.json") };
    // Executed via plain `node` (node:test runs in-process): same env boundary as the live
    // `node --test`, without a nested runner layer that wedges the outer test harness.
    const run = await spawnAsync("node", ["test/malicious-probe.mjs"], { cwd: workspace, env: scrubbed, timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as { leaks: string[]; kernel: string };
    assert.deepEqual(report.leaks, [], "no kernel/token variables visible to candidate code");
    assert.equal(report.kernel, "no-url-available", "no kernel endpoint reachable from inherited state");
    const allocationsBefore = (h.store.db.prepare("SELECT COUNT(*) AS n FROM effect_allocation").get() as { n: number }).n;

    // Guard-bite: WITHOUT the scrubbed env (worker process env inherited), the same malicious
    // test REACHES the kernel with workflow effect authority — the env scrub is load-bearing.
    writeFileSync(join(dir, "report.json"), "{}");
    const bitten = await spawnAsync("node", ["test/malicious-probe.mjs"], {
      cwd: workspace,
      env: { ...workerProcessEnv, MALICIOUS_REPORT: join(dir, "report.json") },
      timeout: 60_000,
    });
    assert.equal(bitten.status, 0, bitten.stderr);
    const bittenReport = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as { leaks: string[]; kernel: string };
    assert.ok(bittenReport.leaks.includes("CADP_WORKFLOW_TOKEN"), "bite: token visible");
    assert.ok(bittenReport.kernel.startsWith("reached:200"), `bite: kernel effect path reached (${bittenReport.kernel})`);
    const allocationsAfter = (h.store.db.prepare("SELECT COUNT(*) AS n FROM effect_allocation").get() as { n: number }).n;
    assert.equal(allocationsAfter, allocationsBefore + 1, "bite: the malicious test allocated an effect id — prohibited authority exercised");
  } finally {
    api?.close();
    rmSync(dir, { recursive: true, force: true });
    h.close();
  }
});

test("F2: the worker sandbox imports ONLY codex auth material and its env carries no ambient credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "cadp-f2-"));
  try {
    const sandbox = buildWorkerSandbox(dir);
    const codexDir = join(sandbox.home, ".codex");
    const contents = existsSync(codexDir) ? readdirSync(codexDir) : [];
    for (const entry of contents) {
      assert.ok((WORKER_AUTH_FILES as readonly string[]).includes(entry), `unexpected import into worker profile: ${entry}`);
    }
    assert.ok(!contents.includes("config.toml"), "host config.toml (MCP/config mutation surface) is NOT imported");
    const env = workerEnv(sandbox.home);
    assert.equal(env["HOME"], sandbox.home, "fresh HOME");
    for (const key of Object.keys(env)) {
      assert.ok(!key.startsWith("CADP_") && key !== "GH_TOKEN" && key !== "GITHUB_TOKEN" && key !== "SSH_AUTH_SOCK", key);
    }
    assert.equal(env["GIT_CONFIG_GLOBAL"], "/dev/null");
    // Profile digest is deterministic and binds argv + auth-file set (attestation binding).
    assert.equal(workerProfileDigest(sandbox), workerProfileDigest(sandbox));
    assert.equal(workerProfileDigest(sandbox), workerProfileDigest(), "probe construction == production construction");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F3: the reviewer env carries no credential surfaces; gh/git mutation attempts under it fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "cadp-f3-"));
  try {
    const env = reviewerEnv(join(dir, "reviewer-home"));
    for (const key of Object.keys(env)) {
      assert.ok(!key.startsWith("CADP_"), key);
      assert.ok(!["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "ANTHROPIC_API_KEY"].includes(key), key);
    }
    assert.equal(env["GIT_CONFIG_GLOBAL"], "/dev/null", "user gitconfig (credential helpers) disabled");
    assert.equal(env["GIT_TERMINAL_PROMPT"], "0");
    const gh = spawnSync("gh", ["api", "/user"], { env, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(gh.status, 0, "gh has no authentication under the reviewer env");
    // A git push over https cannot obtain credentials (no helper, prompts disabled).
    const ws = join(dir, "repo");
    spawnSync("git", ["init", "--quiet", ws], { encoding: "utf8" });
    writeFileSync(join(ws, "f"), "x");
    spawnSync("git", ["-C", ws, "add", "-A"], { encoding: "utf8" });
    spawnSync("git", ["-C", ws, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "t"], { encoding: "utf8" });
    const push = spawnSync("git", ["-C", ws, "push", "https://github.com/astro3141/cadp-v04-live-f32db2.git", "HEAD:refs/heads/cadp/probe-f3"], {
      env, encoding: "utf8", timeout: 30_000,
    });
    assert.notEqual(push.status, 0, "governed push fails without credentials");
    assert.match(push.stderr, /could not read Username|Authentication failed|terminal prompts disabled/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F4: recheck #7 — the prior's LATEST outcome must be presented truthfully; no manufactured target-authority evidence", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();

    // Prior effect ends UNKNOWN (ambiguous dispatch, never resolved).
    const prior = sealScriptedRequest(h, { body: "prior-unknown" });
    h.target.onDispatch = () => ({ kind: "AMBIGUOUS", raw_observation: "timeout (injected)" });
    const first = await runChain(h, prior.request.effect_id);
    assert.equal(first.admitted?.kind === "ADMITTED" ? first.admitted.outcome.result : "", "UNKNOWN");
    h.target.onDispatch = undefined;
    const latest = h.store.outcomesByEffect(prior.request.effect_id).at(-1)!;
    assert.equal(latest.evidence_ref, undefined, "an UNKNOWN has no target receipt envelope — nothing to re-wrap");

    // (a) successor presenting the outcome record BYTE-EXACT inside sealed material → admitted.
    const okBody = Buffer.from("successor-ok", "utf8");
    const { createHash } = await import("node:crypto");
    const okMaterial = {
      tenant: "scripted-1", resource_id: "r-f4",
      body_digest: createHash("sha256").update(okBody).digest("hex"),
      body_cas_key: h.ingress.putBlob(okBody),
      prior_outcomes: [{ effect_id: prior.request.effect_id, outcome_digest: latest.outcome_digest.value }],
    };
    const okRef = h.ingress.putBlob(Buffer.from(JSON.stringify(okMaterial), "utf8"));
    const { PRINCIPALS } = await import("./support/harness.ts");
    const okRequest = h.ingress.sealEffectRequest(
      {
        effect_id: h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-00000000f004", step_ordinal: 1, purpose: "record-write" }),
        requester_ref: "workflow:cadp-work",
        work_bindings: [],
        target_ref: h.target.targetRef(),
        operation_kind: "SCRIPTED_WRITE",
        material_schema: "test.scripted-write.v1",
        material_ref: okRef,
        prior_effect_refs: [prior.request.effect_id],
      },
      PRINCIPALS.workflow,
    );
    const ok = await runChain(h, okRequest.effect_id);
    assert.equal(ok.admitted?.kind, "ADMITTED", JSON.stringify(ok.admitted));

    // (b) successor presenting a WRONG/stale outcome digest → refused (state hidden/misstated).
    const badMaterial = { ...okMaterial, resource_id: "r-f4-bad", prior_outcomes: [{ effect_id: prior.request.effect_id, outcome_digest: "0".repeat(64) }] };
    const badRef = h.ingress.putBlob(Buffer.from(JSON.stringify(badMaterial), "utf8"));
    const badRequest = h.ingress.sealEffectRequest(
      {
        effect_id: h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-00000000f004", step_ordinal: 2, purpose: "record-write" }),
        requester_ref: "workflow:cadp-work",
        work_bindings: [],
        target_ref: h.target.targetRef(),
        operation_kind: "SCRIPTED_WRITE",
        material_schema: "test.scripted-write.v1",
        material_ref: badRef,
        prior_effect_refs: [prior.request.effect_id],
      },
      PRINCIPALS.workflow,
    );
    const bad = await runChain(h, badRequest.effect_id);
    assert.ok(bad.admitted?.kind === "REFUSAL" && bad.admitted.reason === "PRIOR_EFFECT_STATE_NOT_PRESENTED", JSON.stringify(bad.admitted));

    // (c) omitting the presentation entirely → refused.
    const noneMaterial = { tenant: "scripted-1", resource_id: "r-f4-none", body_digest: okMaterial.body_digest, body_cas_key: okMaterial.body_cas_key };
    const noneRef = h.ingress.putBlob(Buffer.from(JSON.stringify(noneMaterial), "utf8"));
    const noneRequest = h.ingress.sealEffectRequest(
      {
        effect_id: h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-00000000f004", step_ordinal: 3, purpose: "record-write" }),
        requester_ref: "workflow:cadp-work",
        work_bindings: [],
        target_ref: h.target.targetRef(),
        operation_kind: "SCRIPTED_WRITE",
        material_schema: "test.scripted-write.v1",
        material_ref: noneRef,
        prior_effect_refs: [prior.request.effect_id],
      },
      PRINCIPALS.workflow,
    );
    const none = await runChain(h, noneRequest.effect_id);
    assert.ok(none.admitted?.kind === "REFUSAL" && none.admitted.reason === "PRIOR_EFFECT_STATE_NOT_PRESENTED", JSON.stringify(none.admitted));
  } finally {
    h.close();
  }
});

test("F4/F5 API exactness: the Kernel API is exactly the TD's ten calls; seal_prior_state does not exist", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const tokens = new Map([["tok-wf", "cadp-workflow"]]);
    const api = await startKernelApi(
      { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens },
      0,
    );
    try {
      const res = await fetch(`http://127.0.0.1:${api.port}/seal_prior_state`, {
        method: "POST",
        headers: { authorization: "Bearer tok-wf", "content-type": "application/json" },
        body: JSON.stringify({ effect_id: "x" }),
      });
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error: string }).error, "NO_SUCH_METHOD");
    } finally {
      api.close();
    }
  } finally {
    h.close();
  }
});
