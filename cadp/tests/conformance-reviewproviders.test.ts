import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REFERENCE_IDENTITIES } from "../deployment/referencePolicy.ts";
import { brokerReview } from "../product/surfaceBroker.ts";
import {
  DEFAULT_REVIEW_PROVIDER,
  DIFF_PROMPT_SENTINEL,
  REVIEW_PROVIDERS,
  resolveReviewProvider,
  reviewArgv,
} from "../product/reviewProviders.ts";

/** The claude argv brokerReview used before the provider registry (byte-identical default). */
const HISTORICAL_CLAUDE_ARGV = (prompt: string): string[] => [
  "claude",
  "-p",
  "--model",
  "claude-sonnet-5",
  "--permission-mode",
  "plan",
  "--disallowedTools=Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit",
  prompt,
];

test("claude reviewer retains the byte-identical argv, auth method, and identity class", () => {
  assert.equal(DEFAULT_REVIEW_PROVIDER, "claude");
  assert.deepEqual(REVIEW_PROVIDERS.claude.argv_template, [
    "-p",
    "--model",
    "claude-sonnet-5",
    "--permission-mode",
    "plan",
    "--disallowedTools=Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit",
    DIFF_PROMPT_SENTINEL,
  ]);
  assert.deepEqual(REVIEW_PROVIDERS.claude.auth_method, { kind: "oauth_env", env_var: "CLAUDE_CODE_OAUTH_TOKEN" });
  assert.equal(REVIEW_PROVIDERS.claude.identity_class_product, "claude-code");
  const prompt = "You are reviewing the exact committed change below";
  assert.deepEqual(reviewArgv(DEFAULT_REVIEW_PROVIDER, prompt), HISTORICAL_CLAUDE_ARGV(prompt));
  assert.deepEqual(reviewArgv(resolveReviewProvider("claude"), prompt), HISTORICAL_CLAUDE_ARGV(prompt));
  // Read-only permission profile is part of the argv identity, not a separate switch.
  assert.ok(REVIEW_PROVIDERS.claude.argv_template.includes("--permission-mode"));
  assert.ok(REVIEW_PROVIDERS.claude.argv_template.includes("plan"));
  const tools = REVIEW_PROVIDERS.claude.argv_template.find((a) => a.startsWith("--disallowedTools="));
  assert.match(tools ?? "", /Bash/u);
  assert.match(tools ?? "", /Read/u);
  assert.match(tools ?? "", /Write/u);
  assert.match(tools ?? "", /Edit/u);
});

test("review argv template expands the DIFF_PROMPT sentinel and no other token", () => {
  const prompt = "APPROVE-or-REQUEST_CHANGES\n\ndiff-body";
  const argv = reviewArgv("claude", prompt);
  assert.equal(argv.filter((a) => a === DIFF_PROMPT_SENTINEL).length, 0);
  assert.equal(argv.at(-1), prompt);
  assert.deepEqual(argv.slice(0, -1), HISTORICAL_CLAUDE_ARGV("unused").slice(0, -1));
  assert.equal(REVIEW_PROVIDERS.claude.argv_template.filter((a) => a === DIFF_PROMPT_SENTINEL).length, 1);
});

test("§8.4 identity_class.product matches the registered reviewer and is independent of workers", () => {
  const registered = REFERENCE_IDENTITIES.find((i) => i.producer_ref === "reviewer:claude-code");
  assert.equal(registered?.identity_class.product, REVIEW_PROVIDERS.claude.identity_class_product);
  const workerProducts = new Set(
    REFERENCE_IDENTITIES.filter((i) => i.identity_class.process_class === "worker" && i.producer_ref.startsWith("worker:"))
      .map((i) => i.identity_class.product),
  );
  assert.ok(workerProducts.size > 0);
  assert.ok(!workerProducts.has(REVIEW_PROVIDERS.claude.identity_class_product), "reviewer product must differ from implementer products");
});

test("unknown review providers fail synchronously without filesystem effects", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-review-provider-invalid-"));
  try {
    const before = readdirSync(root);
    assert.throws(() => resolveReviewProvider("made-up"), /unknown review provider/u);
    assert.throws(() => resolveReviewProvider("codex"), /unknown review provider/u, "a worker name is not a reviewer");
    assert.throws(() => resolveReviewProvider(""), /unknown review provider/u);
    assert.throws(() => resolveReviewProvider(undefined as unknown as string), /unknown review provider/u);
    assert.deepEqual(readdirSync(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/review rejects an unknown provider before creating its workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-review-provider-required-"));
  const oldTmp = process.env["TMPDIR"];
  try {
    process.env["TMPDIR"] = root;
    const before = readdirSync(root);
    await assert.rejects(
      brokerReview({ repo_full_name: "unused/unused", candidate_sha: "unused", work_item: "unused", review_product: "made-up" }),
      /unknown review provider/u,
    );
    assert.deepEqual(readdirSync(root), before);
  } finally {
    if (oldTmp === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = oldTmp;
    rmSync(root, { recursive: true, force: true });
  }
});
