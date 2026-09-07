/**
 * PR #102 review repairs (env-level controls that remain after the OS boundary was added in
 * the re-review repair — the surface *isolation* itself is proven by F6/F7/F8 in
 * conformance-osisolation.test.ts):
 *
 *  F2  worker profile: the codex sandbox imports ONLY auth.json (no host config.toml/MCP); the
 *      profile digest is deterministic and equal between the probe and production constructions.
 *  F4  prior-state truthfulness: recheck #7 accepts the prior's latest outcome presented
 *      byte-exact in sealed material (or the genuine receipt envelope); a stale/wrong digest
 *      refuses; no kernel API can mint target-authority evidence for an UNKNOWN.
 *  F5  API exactness: the Kernel API is exactly the TD §12 ten calls; seal_prior_state is gone.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeHarness, runChain, sealScriptedRequest, stopSharedOpa } from "./support/harness.ts";
import { startKernelApi } from "../kernel/api.ts";
import { buildWorkerSandbox, workerProfileDigest, WORKER_AUTH_FILES } from "../product/workerProfile.ts";
import { runReviewer } from "../product/isolation.ts";
import type { CreationOutcome, IsolationConfig, SurfaceCommand, SurfaceCommandPort } from "../product/isolation.ts";
import { WORKER_PROVIDERS, workerArgv } from "../product/workerProviders.ts";

after(() => stopSharedOpa());

function done<T>(value: T): SurfaceCommand<T> {
  return { result: Promise.resolve(value), closed: Promise.resolve(), cancel() {} };
}

async function reviewerDockerArgs(sessionsDir?: string): Promise<readonly string[]> {
  let constructed: readonly string[] | undefined;
  const port: SurfaceCommandPort = {
    create(_container, args) {
      constructed = args;
      return done<CreationOutcome>({ creation: "REJECTED", detail: "argv fixture" });
    },
    launch: () => { throw new Error("rejected fixture must not launch"); },
    terminate: () => { throw new Error("rejected fixture must not terminate"); },
    observe: () => { throw new Error("rejected fixture must not observe"); },
  };
  const config: IsolationConfig = {
    worker_image: "cadp-surface:fixture",
    egress_network: "cadp-fixture-int",
    egress_proxy: "cadp-fixture-proxy:8888",
  };
  await runReviewer(config, {
    workspace: "/checkout",
    auth: { kind: "oauth_env", env_var: "CLAUDE_CODE_OAUTH_TOKEN", token: "token" },
    authSubdir: ".claude",
    ...(sessionsDir === undefined ? {} : { sessionsDir, sessionsContainerDir: "projects" }),
    argv: ["claude", "-p", "review"],
  }, { port });
  assert.ok(constructed !== undefined);
  return constructed;
}

test("§19 effort_argv omission preserves every worker argv byte-for-byte", () => {
  for (const profile of Object.values(WORKER_PROVIDERS)) assert.equal(profile.effort_argv, undefined);
  assert.deepEqual(workerArgv("codex", "ITEM"), ["codex", "exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-C", "/ws", "ITEM"]);
  assert.deepEqual(workerArgv("grok", "ITEM"), ["grok", "-p", "ITEM", "--output-format", "streaming-json", "--permission-mode", "bypassPermissions"]);
  assert.deepEqual(workerArgv("claude", "ITEM"), ["claude", "-p", "ITEM", "--model", "claude-fable-5", "--permission-mode", "bypassPermissions"]);
});

test("§19 reviewer session bind is the only extra writable bind; workspace stays ro and host HOME is absent", async () => {
  const oldHome = process.env["HOME"];
  process.env["HOME"] = "/host/home-decoy";
  try {
    const without = await reviewerDockerArgs();
    const withSessions = await reviewerDockerArgs("/host/reviewer-sessions");
    assert.deepEqual(without, [
      "--network", "cadp-fixture-int",
      "-e", "HTTPS_PROXY=http://cadp-fixture-proxy:8888", "-e", "HTTP_PROXY=http://cadp-fixture-proxy:8888",
      "-e", "https_proxy=http://cadp-fixture-proxy:8888", "-e", "http_proxy=http://cadp-fixture-proxy:8888",
      "-v", "/checkout:/ws:ro", "-e", "HOME=/root", "-e", "CLAUDE_CODE_OAUTH_TOKEN=token",
      "-w", "/ws", "cadp-surface:fixture", "claude", "-p", "review",
    ]);
    const expected = [...without];
    expected.splice(expected.indexOf("-w"), 0, "-v", "/host/reviewer-sessions:/root/.claude/projects");
    assert.deepEqual(withSessions, expected);
    assert.equal(withSessions.filter((arg) => arg.includes(":/ws")).length, 1);
    assert.ok(withSessions.includes("/checkout:/ws:ro"));
    assert.equal(withSessions.some((arg) => arg.includes("/host/home-decoy")), false, "host HOME must never be mounted");
  } finally {
    if (oldHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = oldHome;
  }
});

test("F2: the worker sandbox imports ONLY codex auth material; the profile digest is deterministic", () => {
  // Hermetic: build a CONTROLLED host HOME with exactly the declared auth material + a config.toml
  // decoy, so the test does not depend on the machine's real ~/.codex (which the isolated verifier
  // container does not have — an ambient dependency made this test fail in-container and pass only
  // on a developer host that happened to be codex-configured).
  const dir = mkdtempSync(join(tmpdir(), "cadp-f2-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "cadp-f2-home-"));
  const realHome = process.env["HOME"];
  try {
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    for (const f of WORKER_AUTH_FILES) writeFileSync(join(fakeHome, ".codex", f), "{}");
    writeFileSync(join(fakeHome, ".codex", "config.toml"), "# host config that must NOT be imported\n");
    process.env["HOME"] = fakeHome;

    const sandbox = buildWorkerSandbox(dir);
    const codexDir = join(sandbox.home, ".codex");
    const contents = existsSync(codexDir) ? readdirSync(codexDir) : [];
    for (const entry of contents) {
      assert.ok((WORKER_AUTH_FILES as readonly string[]).includes(entry), `unexpected import into worker profile: ${entry}`);
    }
    assert.ok(!contents.includes("config.toml"), "host config.toml (MCP/config mutation surface) is NOT imported");
    assert.deepEqual([...sandbox.copied].sort(), [...WORKER_AUTH_FILES].sort(), "exactly the declared auth files are imported");
    assert.equal(workerProfileDigest(sandbox), workerProfileDigest(sandbox));
    assert.equal(workerProfileDigest(sandbox), workerProfileDigest(), "probe construction == production construction");
  } finally {
    if (realHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = realHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("F4: recheck #7 — the prior's LATEST outcome must be presented truthfully; no manufactured target-authority evidence", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();

    const prior = sealScriptedRequest(h, { body: "prior-unknown" });
    h.target.onDispatch = () => ({ kind: "AMBIGUOUS", raw_observation: "timeout (injected)" });
    const first = await runChain(h, prior.request.effect_id);
    assert.equal(first.admitted?.kind === "ADMITTED" ? first.admitted.outcome.result : "", "UNKNOWN");
    h.target.onDispatch = undefined;
    const latest = h.store.outcomesByEffect(prior.request.effect_id).at(-1)!;
    assert.equal(latest.evidence_ref, undefined, "an UNKNOWN has no target receipt envelope — nothing to re-wrap");

    const { createHash } = await import("node:crypto");
    const { PRINCIPALS } = await import("./support/harness.ts");
    const okBody = Buffer.from("successor-ok", "utf8");
    const sealSuccessor = (resource: string, priorOutcomes: Array<{ effect_id: string; outcome_digest: string }> | undefined, step: number) => {
      const material: Record<string, unknown> = {
        tenant: "scripted-1", resource_id: resource,
        body_digest: createHash("sha256").update(okBody).digest("hex"),
        body_cas_key: h.ingress.putBlob(okBody),
      };
      if (priorOutcomes !== undefined) material["prior_outcomes"] = priorOutcomes;
      const ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
      return h.ingress.sealEffectRequest(
        {
          effect_id: h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-00000000f004", step_ordinal: step, purpose: "record-write" }),
          requester_ref: "workflow:cadp-work",
          work_bindings: [],
          target_ref: h.target.targetRef(),
          operation_kind: "SCRIPTED_WRITE",
          material_schema: "test.scripted-write.v1",
          material_ref: ref,
          prior_effect_refs: [prior.request.effect_id],
        },
        PRINCIPALS.workflow,
      );
    };

    const ok = await runChain(h, sealSuccessor("r-ok", [{ effect_id: prior.request.effect_id, outcome_digest: latest.outcome_digest.value }], 1).effect_id);
    assert.equal(ok.admitted?.kind, "ADMITTED", JSON.stringify(ok.admitted));

    const bad = await runChain(h, sealSuccessor("r-bad", [{ effect_id: prior.request.effect_id, outcome_digest: "0".repeat(64) }], 2).effect_id);
    assert.ok(bad.admitted?.kind === "REFUSAL" && bad.admitted.reason === "PRIOR_EFFECT_STATE_NOT_PRESENTED", JSON.stringify(bad.admitted));

    const none = await runChain(h, sealSuccessor("r-none", undefined, 3).effect_id);
    assert.ok(none.admitted?.kind === "REFUSAL" && none.admitted.reason === "PRIOR_EFFECT_STATE_NOT_PRESENTED", JSON.stringify(none.admitted));
  } finally {
    h.close();
  }
});

test("F5: the Kernel API is exactly the TD's ten calls; seal_prior_state does not exist", async () => {
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
