import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jcsDigest } from "../kernel/canonical.ts";
import { buildWorkerSandbox, workerProfileDigest, WORKER_ARGV_PREFIX, WORKER_AUTH_FILES } from "../product/workerProfile.ts";
import { resolveWorkerProvider, WORKER_PROVIDERS, workerArgv, WORK_ITEM_SENTINEL } from "../product/workerProviders.ts";
import { brokerImplement, scanBackendModel } from "../product/surfaceBroker.ts";

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

// codex has a MEASURED model_scan; grok deliberately does not (format unmeasured → UNKNOWN, never guessed).
test("codex backend scan reports observed model with a locator; requested is not collapsed", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-scan-codex-"));
  try {
    const sessions = join(root, WORKER_PROVIDERS.codex.sessions_subdir);
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "session.jsonl"), `${JSON.stringify({ requested_model: "codex-requested" })}\n${JSON.stringify({ model: "codex-observed" })}\n`);
    const fact = scanBackendModel("codex", sessions, "");
    assert.equal(fact.model, "codex-observed");
    assert.match(fact.locator ?? "", /codex-sessions.*session\.jsonl#offset=/u);
    assert.notEqual(fact.model, "codex-requested", "requested and observed model facts must not be collapsed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("grok backend scan stays UNKNOWN (format not yet measured — no guessed model)", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-scan-grok-"));
  try {
    const sessions = join(root, WORKER_PROVIDERS.grok.sessions_subdir);
    mkdirSync(sessions, { recursive: true });
    // Even if a session file happens to contain a model field, grok has no measured scan spec,
    // so the observed model is honestly UNKNOWN rather than a value scraped by a guessed pattern.
    writeFileSync(join(sessions, "session.jsonl"), `${JSON.stringify({ model: "grok-guessable" })}\n`);
    const fact = scanBackendModel("grok", sessions, "model: grok-guessable");
    assert.equal(fact.model, undefined);
    assert.equal(fact.locator, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("codex backend scan leaves absent facts UNKNOWN", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-scan-empty-"));
  try {
    const fact = scanBackendModel("codex", root, "no backend facts");
    assert.equal(fact.model, undefined);
    assert.equal(fact.locator, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
