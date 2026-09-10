import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jcsDigest } from "../../kernel/canonical.ts";
import { buildWorkerSandbox, workerProfileDigest, WORKER_ARGV_PREFIX, WORKER_AUTH_FILES } from "../../product/workerProfile.ts";
import { resolveWorkerProvider, WORKER_PROVIDERS, workerArgv, WORK_ITEM_SENTINEL } from "../../product/workerProviders.ts";
import { REVIEW_PROVIDERS } from "../../product/reviewProviders.ts";
import { PLAN_PROVIDERS } from "../../product/planProviders.ts";
import { brokerImplement, scanBackendModel } from "../../product/surfaceBroker.ts";

test("codex provider retains the byte-identical worker profile", () => {
  assert.deepEqual(WORKER_PROVIDERS.codex.argv_template, ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-C", "/ws", WORK_ITEM_SENTINEL]);
  assert.deepEqual(WORKER_PROVIDERS.codex.auth_files, ["auth.json"]);
  assert.strictEqual(WORKER_ARGV_PREFIX, WORKER_PROVIDERS.codex.argv_template);
  assert.strictEqual(WORKER_AUTH_FILES, WORKER_PROVIDERS.codex.auth_files);
  // codex argv is unchanged in effect: binary + template with the work item substituted last.
  assert.deepEqual(workerArgv("codex", "do the thing"), ["codex", "exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-C", "/ws", "do the thing"]);
});

test("grok argv places the prompt BEFORE its flags (template, not last-token prefix)", () => {
  assert.deepEqual(workerArgv("grok", "fix the bug"), ["grok", "-p", "fix the bug", "--output-format", "streaming-json", "--permission-mode", "bypassPermissions"]);
});

test("grok runs with edit approvals bypassed (headless autonomous-edit posture, codex parity)", () => {
  // Without this, grok's default permission mode blocks edit tools in a no-TTY headless session and
  // it emits a prose plan instead of a diff (observed live). This is grok's analogue of codex's
  // `--sandbox danger-full-access`; container isolation, not the CLI prompt, is the real boundary.
  assert.ok(workerArgv("grok", "x").includes("bypassPermissions"), "grok must bypass its own edit-approval prompts");
  assert.ok(WORKER_PROVIDERS.grok.argv_template.includes("--permission-mode"), "grok argv must set an explicit permission mode");
});

for (const provider of ["grok"] as const) {
  test(`${provider} sandbox copies only its declared auth files`, () => {
    const root = mkdtempSync(join(tmpdir(), `cadp-${provider}-`));
    const oldHome = process.env["HOME"];
    try {
      const hostHome = join(root, "host");
      const profile = WORKER_PROVIDERS[provider];
      mkdirSync(join(hostHome, profile.auth_subdir), { recursive: true });
      for (const rel of profile.auth_files) writeFileSync(join(hostHome, profile.auth_subdir, rel), `${provider}:${rel}`);
      writeFileSync(join(hostHome, profile.auth_subdir, "must-not-copy"), "secret");
      process.env["HOME"] = hostHome;
      const sandbox = buildWorkerSandbox(join(root, "sandbox"), provider);
      assert.deepEqual(sandbox.copied, profile.auth_files);
      assert.deepEqual(readdirSync(join(sandbox.home, profile.auth_subdir)).sort(), [...profile.auth_files].sort());
      for (const rel of profile.auth_files) assert.equal(readFileSync(join(sandbox.home, profile.auth_subdir, rel), "utf8"), `${provider}:${rel}`);
    } finally {
      if (oldHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = oldHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("worker profile digests are provider-specific and deterministic", () => {
  const digests = (["codex", "grok"] as const).map((provider) => {
    assert.equal(workerProfileDigest(undefined, provider), workerProfileDigest(undefined, provider));
    return workerProfileDigest(undefined, provider);
  });
  assert.equal(new Set(digests).size, digests.length);
});

test("unknown providers fail synchronously without filesystem effects", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-provider-invalid-"));
  try {
    const before = readdirSync(root);
    assert.throws(() => resolveWorkerProvider("made-up"), /unknown worker provider/u);
    assert.throws(() => resolveWorkerProvider("gemini"), /unknown worker provider/u, "gemini was dropped");
    assert.deepEqual(readdirSync(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/implement rejects a missing provider before creating its workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-provider-required-"));
  const oldTmp = process.env["TMPDIR"];
  try {
    process.env["TMPDIR"] = root;
    const before = readdirSync(root);
    await assert.rejects(
      brokerImplement({ repo_full_name: "unused/unused", base_sha: "unused", work_item: "unused", worker_product: undefined as unknown as string }),
      /unknown worker provider/u,
    );
    assert.deepEqual(readdirSync(root), before);
  } finally {
    if (oldTmp === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = oldTmp;
    rmSync(root, { recursive: true, force: true });
  }
});

// Both providers now carry a MEASURED model_scan; a provider without one stays UNKNOWN, never guessed.
test("codex backend scan reports observed model with a locator; requested is not collapsed", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-scan-codex-"));
  try {
    const sessions = join(root, WORKER_PROVIDERS.codex.sessions_subdir);
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "session.jsonl"), `${JSON.stringify({ requested_model: "codex-requested" })}\n${JSON.stringify({ model: "codex-observed" })}\n`);
    const fact = scanBackendModel(WORKER_PROVIDERS.codex, sessions, "");
    assert.equal(fact.model, "codex-observed");
    assert.match(fact.locator ?? "", /codex-sessions.*session\.jsonl#offset=/u);
    assert.notEqual(fact.model, "codex-requested", "requested and observed model facts must not be collapsed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grok backend scan reads model_id from the measured chat_history.jsonl layout", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-scan-grok-"));
  try {
    // Measured layout (2026-09-06 probe): sessions/<urlencoded-cwd>/<session-id>/chat_history.jsonl
    const sessions = join(root, WORKER_PROVIDERS.grok.sessions_subdir, "%2Fws", "01a0768e-af89-7063-92d8-9c7a43be0408");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "chat_history.jsonl"), `${JSON.stringify({ model_id: "grok-4.6-build", model_fingerprint: "fp_08d0bc26c22b024e" })}\n`);
    const fact = scanBackendModel(WORKER_PROVIDERS.grok, join(root, WORKER_PROVIDERS.grok.sessions_subdir), "");
    assert.equal(fact.model, "grok-4.6-build");
    assert.match(fact.locator ?? "", /chat_history\.jsonl#offset=/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grok backend scan falls back to the measured stdout end-event modelUsage key", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-scan-grok-stdout-"));
  try {
    // Measured: the headless NDJSON stream ends with {"type":"end",...,"modelUsage":{"<model>":{...}}}.
    const stdout = '{"type":"end","stopReason":"end_turn","modelUsage":{"grok-4.6-build":{"modelCalls":1}}}';
    const fact = scanBackendModel(WORKER_PROVIDERS.grok, join(root, "absent-sessions"), stdout, "grok-worker-stdout");
    assert.equal(fact.model, "grok-4.6-build");
    assert.match(fact.locator ?? "", /grok-worker-stdout#pattern=/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grok backend scan leaves absent facts UNKNOWN (no session match, no stdout match)", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-scan-grok-empty-"));
  try {
    const fact = scanBackendModel(WORKER_PROVIDERS.grok, root, "no backend facts here");
    assert.equal(fact.model, undefined);
    assert.equal(fact.locator, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex backend scan leaves absent facts UNKNOWN", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-scan-empty-"));
  try {
    const fact = scanBackendModel(WORKER_PROVIDERS.codex, root, "no backend facts");
    assert.equal(fact.model, undefined);
    assert.equal(fact.locator, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------ claude worker (2026-09-07 container probes)

test("claude worker carries the MEASURED headless-edit argv, env auth, and session layout", () => {
  assert.deepEqual(workerArgv("claude", "do it"), ["claude", "-p", "do it", "--model", "claude-opus-5", "--permission-mode", "bypassPermissions"]);
  const p = WORKER_PROVIDERS.claude;
  // Measured: as root claude refuses bypassPermissions unless IS_SANDBOX=1 acknowledges the container.
  assert.deepEqual(p.auth_env, { env_var: "CLAUDE_CODE_OAUTH_TOKEN", static_env: { IS_SANDBOX: "1" } });
  assert.deepEqual(p.auth_files, [], "no auth file is copied — the token is env-injected");
  assert.equal(p.sessions_container_dir, "projects", "measured: claude writes ~/.claude/projects, not .../sessions");
  assert.equal(p.identity_class_product, "claude-code");
});

test("claude backend scan reads the measured projects-jsonl model field", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-scan-claude-"));
  try {
    const sessions = join(root, WORKER_PROVIDERS.claude.sessions_subdir, "-ws", "");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "128b41c7.jsonl"), `${JSON.stringify({ model: "claude-sonnet-5" })}\n`);
    const fact = scanBackendModel(WORKER_PROVIDERS.claude, join(root, WORKER_PROVIDERS.claude.sessions_subdir), "");
    assert.equal(fact.model, "claude-sonnet-5");
    assert.match(fact.locator ?? "", /128b41c7\.jsonl#offset=/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviewer and planner profiles without measured model scans stay UNKNOWN", () => {
  assert.deepEqual(scanBackendModel({}, "/unused", '{"model":"guessed"}'), {});
});
