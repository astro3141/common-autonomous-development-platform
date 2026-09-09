import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REFERENCE_IDENTITIES } from "../deployment/referencePolicy.ts";
import type { EvidenceDraft } from "../kernel/ingress.ts";
import type { EvidenceEnvelopeV1 } from "../kernel/records.ts";
import { brokerReview } from "../product/surfaceBroker.ts";
import { scanBackendModel } from "../product/surfaceBroker.ts";
import { submitBackendExecutionEvidence } from "../product/backendExecution.ts";
import { reviewerAuthArgs } from "../product/isolation.ts";
import {
  assertReviewIndependence,
  parseReviewVerdict,
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

test("§19 reviewer argv snapshots pin measured effort configuration", () => {
  for (const provider of ["claude", "grok"] as const) assert.equal(REVIEW_PROVIDERS[provider].effort_argv, undefined);
  assert.deepEqual(reviewArgv("claude", "PROMPT"), HISTORICAL_CLAUDE_ARGV("PROMPT"));
  assert.deepEqual(reviewArgv("grok", "PROMPT"), ["grok", "-p", "PROMPT", "--permission-mode", "plan", "--disable-web-search", "--tools", "read_file,list_dir,grep", "--json-schema", '{"type":"object","properties":{"verdict":{"type":"string","enum":["APPROVE","REQUEST_CHANGES"]},"reason":{"type":"string"}},"required":["verdict","reason"]}']);
  assert.deepEqual(reviewArgv("codex", "PROMPT"), ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "PROMPT", "-c", "model_reasoning_effort=high"]);
});

test("measured reviewer session-scan capabilities are pinned byte-exactly; effort stays unprobed", async () => {
  const expected = {
    claude: { sessions_subdir: "claude-sessions", sessions_container_dir: "projects", model_scan: { session_regex: '"model"\\s*:\\s*"([^"]+)"', stdout_regex: '"model"\\s*:\\s*"([^"]+)"' } },
    grok: { sessions_subdir: "grok-sessions", sessions_container_dir: undefined, model_scan: { session_regex: '"model_id"\\s*:\\s*"([^"]+)"', stdout_regex: '"model_id"\\s*:\\s*"([^"]+)"' } },
    codex: { sessions_subdir: "codex-sessions", sessions_container_dir: undefined, model_scan: { session_regex: '"model"\\s*:\\s*"([^"]+)"', stdout_regex: '"model"\\s*:\\s*"([^"]+)"' } },
  } as const;
  for (const [provider, profile] of Object.entries(REVIEW_PROVIDERS)) {
    assert.deepEqual({ sessions_subdir: profile.sessions_subdir, sessions_container_dir: profile.sessions_container_dir, model_scan: profile.model_scan }, expected[provider as keyof typeof expected]);
    assert.equal(profile.effort_scan, undefined);
    if (provider === "codex") {
      assert.equal(profile.requested_effort, "high");
      assert.deepEqual(profile.effort_argv, { flag: "-c", value_placement: "separate", value_prefix: "model_reasoning_effort=", allowed_values: ["high"] });
    } else {
      assert.equal(profile.requested_effort, undefined);
      assert.equal(profile.effort_argv, undefined);
    }
    const brokerFact = scanBackendModel(profile, "/absent/reviewer-sessions", provider === "grok" ? '{"model_id":"measured-fallback"}' : '{"model":"measured-fallback"}', `${provider}-reviewer-stdout`);
    let draft: EvidenceDraft | undefined;
    await submitBackendExecutionEvidence({
      client: { submitEvidence: async (value) => { draft = value; return { evidence_id: "backend-review" } as EvidenceEnvelopeV1; } },
      provider, surface_role: "REVIEWER", subject_bindings: [], model: brokerFact.model, locator: brokerFact.locator,
    });
    assert.ok(draft !== undefined);
    const observed = (draft.claim as { observed: Record<string, unknown> }).observed;
    assert.deepEqual(observed["model"], { availability: "PRESENT", value: "measured-fallback", locator: `${provider}-reviewer-stdout#pattern=${profile.model_scan!.stdout_regex}` });
    assert.deepEqual(observed["effort"], { availability: "UNKNOWN" });
  }
});

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
    assert.throws(() => resolveReviewProvider("gemini"), /unknown review provider/u, "a dropped provider name never resolves");
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

// ---------------------------------------------------------------- grok reviewer (#149, measured)

test("grok reviewer carries the MEASURED read-only argv (allow-list is the boundary, not plan mode)", () => {
  // Probes (2026-09-06, grok 1.0.13): plan mode blocks `write` but NOT `run_terminal_command`;
  // the `--tools read_file,list_dir,grep` allow-list held against a direct terminal attempt.
  assert.deepEqual(reviewArgv("grok", "PROMPT"), [
    "grok",
    "-p",
    "PROMPT",
    "--permission-mode",
    "plan",
    "--disable-web-search",
    "--tools",
    "read_file,list_dir,grep",
    "--json-schema",
    '{"type":"object","properties":{"verdict":{"type":"string","enum":["APPROVE","REQUEST_CHANGES"]},"reason":{"type":"string"}},"required":["verdict","reason"]}',
  ]);
  const argv = REVIEW_PROVIDERS.grok.argv_template;
  assert.ok(!argv.includes("bypassPermissions"), "the reviewer must NEVER carry the worker's edit-approval bypass");
  assert.ok(argv.includes("--tools"), "the enforced read-only boundary is the tool allow-list");
});

test("grok reviewer authenticates via its own auth files, never the claude token", () => {
  assert.deepEqual(REVIEW_PROVIDERS.grok.auth_method, { kind: "auth_files", auth_subdir: ".grok", auth_files: ["auth.json"] });
});

test("grok reviewer identity product matches the policy registry and the grok WORKER product", () => {
  const entry = REFERENCE_IDENTITIES.find((i) => i.producer_ref === "reviewer:grok");
  assert.ok(entry !== undefined, "reviewer:grok is registered in the policy identity registry");
  assert.equal(entry.identity_class.product, REVIEW_PROVIDERS.grok.identity_class_product);
});

test("§8.4 independence guard refuses a same-product reviewer at entry", () => {
  assert.throws(() => assertReviewIndependence("grok", "grok"), /reviewer independence/u, "grok cannot review a grok-implemented run");
  assert.doesNotThrow(() => assertReviewIndependence("codex-cli", "grok"), "grok may review a codex-implemented run");
  assert.doesNotThrow(() => assertReviewIndependence("grok", "claude"), "claude may review a grok-implemented run");
  assert.throws(() => assertReviewIndependence("claude-code", "claude"), /reviewer independence/u);
});

test("reviewer auth arg-builder: oauth_env injects exactly one env var; auth_files mount READ-ONLY", () => {
  assert.deepEqual(reviewerAuthArgs({ kind: "oauth_env", env_var: "CLAUDE_CODE_OAUTH_TOKEN", token: "tok" }), ["-e", "CLAUDE_CODE_OAUTH_TOKEN=tok"]);
  assert.deepEqual(
    reviewerAuthArgs({ kind: "auth_files", auth_subdir: ".grok", authDir: "/base/surface-auth", auth_files: ["auth.json"] }),
    ["-v", "/base/surface-auth/auth.json:/root/.grok/auth.json:ro"],
  );
});

// -------------------------------------------------- verdict contracts (9th pilot measurement)

test("claude verdict contract: first line, reason next — byte-identical to the pre-registry parse", () => {
  assert.deepEqual(parseReviewVerdict("claude", "APPROVE\nlooks correct\n"), { verdict: "APPROVE", reason: "looks correct" });
  assert.deepEqual(parseReviewVerdict("claude", "REQUEST_CHANGES\nmissing test\n"), { verdict: "REQUEST_CHANGES", reason: "missing test" });
  // Unparseable output fails closed.
  assert.equal(parseReviewVerdict("claude", "narration without any verdict").verdict, "REQUEST_CHANGES");
});

test("grok verdict contract: the LAST schema object in the measured {text} wrapper is final", () => {
  // Measured fixture shape (json-schema probe): narration turns are coerced into the schema too;
  // only the final object is the verdict.
  const wrapper = JSON.stringify({
    text:
      '{ "verdict": "REQUEST_CHANGES", "reason": "still locating the diff" }' +
      '{ "verdict": "REQUEST_CHANGES", "reason": "reading the file" }' +
      '{"verdict":"APPROVE","reason":"the JSDoc matches the stated constraints"}',
  });
  assert.deepEqual(parseReviewVerdict("grok", wrapper), { verdict: "APPROVE", reason: "the JSDoc matches the stated constraints" });
});

test("grok verdict contract fails closed on shapes outside the measured contract", () => {
  assert.equal(parseReviewVerdict("grok", "not json at all APPROVE").verdict, "REQUEST_CHANGES");
  assert.equal(parseReviewVerdict("grok", JSON.stringify({ text: "prose with no schema object" })).verdict, "REQUEST_CHANGES");
  // The 9th-pilot failure shape (plain-output glue) must NOT parse as an approval.
  assert.equal(parseReviewVerdict("grok", "I'll inspect the committed JSDoc against the stated constraints and the surrounding file.APPROVE").verdict, "REQUEST_CHANGES");
});

test("grok reviewer argv now carries the verdict json-schema constraint", () => {
  const argv = REVIEW_PROVIDERS.grok.argv_template;
  const i = argv.indexOf("--json-schema");
  assert.ok(i >= 0 && typeof argv[i + 1] === "string");
  const schema = JSON.parse(argv[i + 1]!) as { properties: { verdict: { enum: string[] } }; required: string[] };
  assert.deepEqual(schema.properties.verdict.enum, ["APPROVE", "REQUEST_CHANGES"]);
  assert.deepEqual(schema.required, ["verdict", "reason"]);
});

// ------------------------------------------------ codex reviewer + claude worker (2026-09-07 probes)

test("codex reviewer carries the MEASURED read-only sandbox argv and first-line contract", () => {
  assert.deepEqual(reviewArgv("codex", "PROMPT"), ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "PROMPT", "-c", "model_reasoning_effort=high"]);
  assert.ok(!REVIEW_PROVIDERS.codex.argv_template.includes("danger-full-access"), "the reviewer must NEVER carry the worker's full-access sandbox");
  assert.equal(REVIEW_PROVIDERS.codex.verdict_format, "first-line");
  assert.deepEqual(REVIEW_PROVIDERS.codex.auth_method, { kind: "auth_files", auth_subdir: ".codex", auth_files: ["auth.json"] });
  const entry = REFERENCE_IDENTITIES.find((i) => i.producer_ref === "reviewer:codex");
  assert.ok(entry !== undefined && entry.identity_class.product === REVIEW_PROVIDERS.codex.identity_class_product);
});

test("independence matrix over the full worker×reviewer product space", () => {
  // Same product refuses; every cross-product pair passes.
  assert.throws(() => assertReviewIndependence("codex-cli", "codex"), /reviewer independence/u);
  assert.throws(() => assertReviewIndependence("claude-code", "claude"), /reviewer independence/u, "a claude-implemented run cannot be claude-reviewed");
  for (const [worker, review] of [["codex-cli", "claude"], ["codex-cli", "grok"], ["grok", "claude"], ["grok", "codex"], ["claude-code", "grok"], ["claude-code", "codex"]] as const) {
    assert.doesNotThrow(() => assertReviewIndependence(worker, review), `${worker} × ${review} must be a valid pairing`);
  }
});
