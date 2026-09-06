import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brokerReview } from "../product/surfaceBroker.ts";
import {
  DEFAULT_REVIEW_PROVIDER,
  DIFF_PROMPT_SENTINEL,
  REVIEW_PROVIDERS,
  resolveReviewProvider,
  reviewArgv,
} from "../product/reviewProviders.ts";

/** Pre-registry claude argv (binary + flags + prompt). The default path must stay byte-identical. */
const CLAUDE_REVIEW_ARGV = (prompt: string): string[] => [
  "claude",
  "-p",
  "--model",
  "claude-sonnet-5",
  "--permission-mode",
  "plan",
  "--disallowedTools=Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit",
  prompt,
];

test("claude review path is unchanged by default", () => {
  assert.equal(DEFAULT_REVIEW_PROVIDER, "claude");
  assert.equal(resolveReviewProvider(DEFAULT_REVIEW_PROVIDER), "claude");
  const prompt = "You are reviewing the exact committed change below (commit abc) implementing: \"do the thing\".\n\ndiff";
  assert.deepEqual(reviewArgv(resolveReviewProvider(DEFAULT_REVIEW_PROVIDER), prompt), CLAUDE_REVIEW_ARGV(prompt));
  assert.deepEqual(REVIEW_PROVIDERS.claude.auth_method, { kind: "env", env_var: "CLAUDE_CODE_OAUTH_TOKEN" });
  assert.equal(REVIEW_PROVIDERS.claude.identity_class_product, "claude-code");
  // §8.4: reviewer product class must differ from every implementer product.
  assert.notEqual(REVIEW_PROVIDERS.claude.identity_class_product, "codex-cli");
  assert.notEqual(REVIEW_PROVIDERS.claude.identity_class_product, "grok");
  // Read-only permission profile is part of the pinned argv, not a separate switch.
  const argv = reviewArgv("claude", prompt);
  assert.ok(argv.includes("--permission-mode") && argv[argv.indexOf("--permission-mode") + 1] === "plan");
  assert.ok(argv.includes("--disallowedTools=Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit"));
});

test("review argv template expands the DIFF_PROMPT sentinel and leaves other tokens unchanged", () => {
  const prompt = "PROMPT-{{not-a-sentinel}}";
  assert.ok(REVIEW_PROVIDERS.claude.argv_template.includes(DIFF_PROMPT_SENTINEL));
  assert.equal(DIFF_PROMPT_SENTINEL, "{{DIFF_PROMPT}}");
  const expanded = reviewArgv("claude", prompt);
  assert.deepEqual(expanded, CLAUDE_REVIEW_ARGV(prompt));
  assert.ok(!expanded.includes(DIFF_PROMPT_SENTINEL));
  assert.deepEqual(
    expanded.filter((a) => a !== prompt),
    ["claude", ...REVIEW_PROVIDERS.claude.argv_template.filter((a) => a !== DIFF_PROMPT_SENTINEL)],
  );
  // Expansion is positional: the prompt lands where the sentinel was (last token for claude).
  assert.equal(expanded[expanded.length - 1], prompt);
  assert.equal(
    REVIEW_PROVIDERS.claude.argv_template[REVIEW_PROVIDERS.claude.argv_template.length - 1],
    DIFF_PROMPT_SENTINEL,
  );
});

test("resolveReviewProvider rejects an unknown provider and never defaults silently", () => {
  assert.throws(() => resolveReviewProvider("made-up"), /unknown review provider/u);
  assert.throws(() => resolveReviewProvider("codex"), /unknown review provider/u, "a worker is not a reviewer");
  assert.throws(() => resolveReviewProvider("grok"), /unknown review provider/u, "a worker is not a reviewer");
  assert.throws(() => resolveReviewProvider(""), /unknown review provider/u);
  assert.throws(() => resolveReviewProvider("Claude"), /unknown review provider/u, "names are exact, not case-folded");
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
