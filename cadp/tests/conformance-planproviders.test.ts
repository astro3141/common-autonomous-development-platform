import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REFERENCE_IDENTITIES } from "../deployment/referencePolicy.ts";
import { brokerPlan } from "../product/surfaceBroker.ts";
import {
  DEFAULT_PLAN_PROVIDER,
  PLAN_PROMPT_SENTINEL,
  PLAN_PROVIDERS,
  resolvePlanProvider,
  planArgv,
} from "../product/planProviders.ts";

/** The claude argv brokerPlan used before the provider registry (byte-identical default). */
const HISTORICAL_CLAUDE_PLAN_ARGV = (prompt: string): string[] => [
  "claude",
  "-p",
  "--model",
  "claude-sonnet-5",
  "--permission-mode",
  "plan",
  "--disallowedTools=Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task",
  prompt,
];

test("claude planner retains the byte-identical argv, auth method, and identity class", () => {
  assert.equal(DEFAULT_PLAN_PROVIDER, "claude");
  assert.deepEqual(PLAN_PROVIDERS.claude.argv_template, [
    "-p",
    "--model",
    "claude-sonnet-5",
    "--permission-mode",
    "plan",
    "--disallowedTools=Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task",
    PLAN_PROMPT_SENTINEL,
  ]);
  assert.deepEqual(PLAN_PROVIDERS.claude.auth_method, { kind: "oauth_env", env_var: "CLAUDE_CODE_OAUTH_TOKEN" });
  assert.equal(PLAN_PROVIDERS.claude.identity_class_product, "claude-code");
  const prompt = "You are planning bounded autonomous work over the repository";
  assert.deepEqual(planArgv(DEFAULT_PLAN_PROVIDER, prompt), HISTORICAL_CLAUDE_PLAN_ARGV(prompt));
  assert.deepEqual(planArgv(resolvePlanProvider("claude"), prompt), HISTORICAL_CLAUDE_PLAN_ARGV(prompt));
  // Read-only permission profile is part of the argv identity, not a separate switch.
  assert.ok(PLAN_PROVIDERS.claude.argv_template.includes("--permission-mode"));
  assert.ok(PLAN_PROVIDERS.claude.argv_template.includes("plan"));
  const tools = PLAN_PROVIDERS.claude.argv_template.find((a) => a.startsWith("--disallowedTools="));
  assert.match(tools ?? "", /Bash/u);
  assert.match(tools ?? "", /Write/u);
  assert.match(tools ?? "", /Edit/u);
  assert.match(tools ?? "", /NotebookEdit/u);
  assert.match(tools ?? "", /WebFetch/u);
  assert.match(tools ?? "", /WebSearch/u);
  assert.match(tools ?? "", /Task/u);
  // Reading the checkout remains allowed — the planner is proposal-only, not a second reviewer.
  assert.doesNotMatch(tools ?? "", /(?:^|,)Read(?:,|$)/u);
});

test("plan argv template expands the PLAN_PROMPT sentinel and no other token", () => {
  const prompt = "Decompose this intent into bounded work items\n\nINTENT: ship it";
  const argv = planArgv("claude", prompt);
  assert.equal(argv.filter((a) => a === PLAN_PROMPT_SENTINEL).length, 0);
  assert.equal(argv.at(-1), prompt);
  assert.deepEqual(argv.slice(0, -1), HISTORICAL_CLAUDE_PLAN_ARGV("unused").slice(0, -1));
  assert.equal(PLAN_PROVIDERS.claude.argv_template.filter((a) => a === PLAN_PROMPT_SENTINEL).length, 1);
});

test("§8.4 identity_class.product matches the registered planner and is independent of workers", () => {
  const registered = REFERENCE_IDENTITIES.find((i) => i.producer_ref === "planner:claude-code");
  assert.equal(registered?.identity_class.product, PLAN_PROVIDERS.claude.identity_class_product);
  const workerProducts = new Set(
    REFERENCE_IDENTITIES.filter((i) => i.identity_class.process_class === "worker" && i.producer_ref.startsWith("worker:"))
      .map((i) => i.identity_class.product),
  );
  assert.ok(workerProducts.size > 0);
  assert.ok(!workerProducts.has(PLAN_PROVIDERS.claude.identity_class_product), "planner product must differ from implementer products");
});

test("unknown plan providers fail synchronously without filesystem effects", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-plan-provider-invalid-"));
  try {
    const before = readdirSync(root);
    assert.throws(() => resolvePlanProvider("made-up"), /unknown plan provider/u);
    assert.throws(() => resolvePlanProvider("gemini"), /unknown plan provider/u, "a dropped provider name never resolves");
    assert.throws(() => resolvePlanProvider(""), /unknown plan provider/u);
    assert.throws(() => resolvePlanProvider(undefined as unknown as string), /unknown plan provider/u);
    assert.deepEqual(readdirSync(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/plan rejects an unknown provider before creating its workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-plan-provider-required-"));
  const oldTmp = process.env["TMPDIR"];
  try {
    process.env["TMPDIR"] = root;
    const before = readdirSync(root);
    await assert.rejects(
      brokerPlan({ repo_full_name: "unused/unused", base_sha: "unused", intent: "unused", plan_product: "made-up" }),
      /unknown plan provider/u,
    );
    assert.deepEqual(readdirSync(root), before);
  } finally {
    if (oldTmp === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = oldTmp;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- grok planner (#149, measured)

test("grok planner carries the MEASURED read-only argv and its own auth files", () => {
  assert.deepEqual(planArgv("grok", "PROMPT"), [
    "grok",
    "-p",
    "PROMPT",
    "--permission-mode",
    "plan",
    "--disable-web-search",
    "--tools",
    "read_file,list_dir,grep",
  ]);
  assert.ok(!PLAN_PROVIDERS.grok.argv_template.includes("bypassPermissions"), "the planner must NEVER carry the worker's edit-approval bypass");
  assert.deepEqual(PLAN_PROVIDERS.grok.auth_method, { kind: "auth_files", auth_subdir: ".grok", auth_files: ["auth.json"] });
});

test("grok planner identity product matches the policy registry", () => {
  const entry = REFERENCE_IDENTITIES.find((i) => i.producer_ref === "planner:grok");
  assert.ok(entry !== undefined, "planner:grok is registered in the policy identity registry");
  assert.equal(entry.identity_class.product, PLAN_PROVIDERS.grok.identity_class_product);
});
