import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jcsDigest } from "../kernel/canonical.ts";
import { buildWorkerSandbox, workerProfileDigest, WORKER_ARGV_PREFIX, WORKER_AUTH_FILES } from "../product/workerProfile.ts";
import { resolveWorkerProvider, WORKER_PROVIDERS } from "../product/workerProviders.ts";
import { brokerImplement, scanBackendModel, workerArgv } from "../product/surfaceBroker.ts";
import { workerDockerArgs } from "../product/isolation.ts";

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
  assert.deepEqual(workerArgv("codex", "do work"), ["codex", "exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-C", "/ws", "do work"]);
});

test("worker argv and mounts are selected only from each provider profile", () => {
  for (const provider of ["codex", "grok", "gemini"] as const) {
    assert.deepEqual(workerArgv(provider, "item"), [provider, ...WORKER_PROVIDERS[provider].argv_prefix, ...(provider === "codex" ? ["-C", "/ws"] : []), "item"]);
    const args = workerDockerArgs(
      { worker_image: "worker", egress_network: "egress", egress_proxy: "proxy:1" },
      { workspace: "/workspace", workerAuthDir: "/auth", workerProvider: provider, sessionsDir: "/sessions", argv: workerArgv(provider, "item") },
    );
    for (const file of WORKER_PROVIDERS[provider].auth_files) {
      assert.ok(args.includes(`/auth/${file}:/root/${WORKER_PROVIDERS[provider].auth_subdir}/${file}:ro`));
    }
    assert.ok(args.includes(`/sessions:/root/${WORKER_PROVIDERS[provider].auth_subdir}/sessions`));
  }
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

test("/implement resolves worker_product before Docker or temporary workspace effects", async () => {
  const before = readdirSync(tmpdir()).filter((entry) => entry.startsWith("cadp-impl-")).sort();
  await assert.rejects(
    brokerImplement({ repo_full_name: "unused/unused", base_sha: "0", work_item: "unused", worker_product: "made-up" }),
    /unknown worker provider: made-up/u,
  );
  const after = readdirSync(tmpdir()).filter((entry) => entry.startsWith("cadp-impl-")).sort();
  assert.deepEqual(after, before);
});

for (const provider of ["codex", "grok", "gemini"] as const) {
  test(`${provider} backend scan reports provider-specific evidence locators`, () => {
    const root = mkdtempSync(join(tmpdir(), `cadp-scan-${provider}-`));
    try {
      const session = join(root, "session.jsonl");
      writeFileSync(session, `${JSON.stringify({ model: `${provider}-observed-model` })}\n`);
      assert.deepEqual(scanBackendModel(provider, root, "model: requested-model"), {
        model: `${provider}-observed-model`,
        locator: `${provider}-session:${session}#offset=1`,
      });
      assert.deepEqual(scanBackendModel(provider, join(root, "absent"), ""), { model: undefined, locator: undefined });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
