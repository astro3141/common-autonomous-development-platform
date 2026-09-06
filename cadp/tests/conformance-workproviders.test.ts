import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jcsDigest } from "../kernel/canonical.ts";
import { buildWorkerSandbox, workerProfileDigest, WORKER_ARGV_PREFIX, WORKER_AUTH_FILES } from "../product/workerProfile.ts";
import { resolveWorkerProvider, WORKER_PROVIDERS } from "../product/workerProviders.ts";
import { brokerImplement, scanBackendModel } from "../product/surfaceBroker.ts";

test("codex provider retains the byte-identical worker profile", () => {
  assert.deepEqual(WORKER_PROVIDERS.codex.argv_prefix, ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check"]);
  assert.deepEqual(WORKER_PROVIDERS.codex.auth_files, ["auth.json"]);
  assert.strictEqual(WORKER_ARGV_PREFIX, WORKER_PROVIDERS.codex.argv_prefix);
  assert.strictEqual(WORKER_AUTH_FILES, WORKER_PROVIDERS.codex.auth_files);
  const previous = jcsDigest({
    schema: "cadp.worker-profile.v1", product: "codex-cli",
    argv_prefix: [...WORKER_ARGV_PREFIX], auth_files: [...WORKER_AUTH_FILES],
    home: "fresh-per-invocation",
  }).value;
  assert.equal(workerProfileDigest(), previous);
});

for (const provider of ["grok", "gemini"] as const) {
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
  const digests = (["codex", "grok", "gemini"] as const).map((provider) => {
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

for (const provider of ["codex", "grok", "gemini"] as const) {
  test(`${provider} backend scan reports observed model with a provider-owned locator`, () => {
    const root = mkdtempSync(join(tmpdir(), `cadp-scan-${provider}-`));
    try {
      const sessions = join(root, WORKER_PROVIDERS[provider].sessions_subdir);
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, "session.jsonl"), `${JSON.stringify({ requested_model: `${provider}-requested` })}\n${JSON.stringify({ model: `${provider}-observed` })}\n`);
      const fact = scanBackendModel(provider, sessions, "");
      assert.equal(fact.model, `${provider}-observed`);
      assert.match(fact.locator ?? "", new RegExp(`${WORKER_PROVIDERS[provider].sessions_subdir}.*session\\.jsonl#offset=`));
      assert.notEqual(fact.model, `${provider}-requested`, "requested and observed model facts must not be collapsed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${provider} backend scan leaves absent facts UNKNOWN`, () => {
    const root = mkdtempSync(join(tmpdir(), `cadp-scan-empty-${provider}-`));
    try {
      const fact = scanBackendModel(provider, root, "no backend facts");
      assert.equal(fact.model, undefined);
      assert.equal(fact.locator, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
