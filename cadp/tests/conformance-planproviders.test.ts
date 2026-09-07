import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REFERENCE_IDENTITIES } from "../deployment/referencePolicy.ts";
import { brokerPlan } from "../product/surfaceBroker.ts";
import { sealPlan } from "../live/ops.ts";
import { sha256Hex } from "../kernel/canonical.ts";
import type { EvidenceDraft } from "../kernel/ingress.ts";
import type { EvidenceEnvelopeV1 } from "../kernel/records.ts";
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

test("§19 effort_argv omission preserves every planner argv byte-for-byte", () => {
  for (const profile of Object.values(PLAN_PROVIDERS)) assert.equal(profile.effort_argv, undefined);
  assert.deepEqual(planArgv("claude", "PROMPT"), HISTORICAL_CLAUDE_PLAN_ARGV("PROMPT"));
  assert.deepEqual(planArgv("grok", "PROMPT"), ["grok", "-p", "PROMPT", "--permission-mode", "plan", "--disable-web-search", "--tools", "read_file,list_dir,grep"]);
  assert.deepEqual(planArgv("codex", "PROMPT"), ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "PROMPT"]);
});

test("measured planner session-scan capabilities are pinned byte-exactly; effort stays unprobed", () => {
  const expected = {
    claude: { sessions_subdir: "claude-sessions", sessions_container_dir: "projects", model_scan: { session_regex: '"model"\\s*:\\s*"([^"]+)"', stdout_regex: '"model"\\s*:\\s*"([^"]+)"' } },
    grok: { sessions_subdir: "grok-sessions", sessions_container_dir: undefined, model_scan: { session_regex: '"model_id"\\s*:\\s*"([^"]+)"', stdout_regex: '"model_id"\\s*:\\s*"([^"]+)"' } },
    codex: { sessions_subdir: "codex-sessions", sessions_container_dir: undefined, model_scan: { session_regex: '"model"\\s*:\\s*"([^"]+)"', stdout_regex: '"model"\\s*:\\s*"([^"]+)"' } },
  } as const;
  for (const [provider, profile] of Object.entries(PLAN_PROVIDERS)) {
    assert.deepEqual({ sessions_subdir: profile.sessions_subdir, sessions_container_dir: profile.sessions_container_dir, model_scan: profile.model_scan }, expected[provider as keyof typeof expected]);
    assert.equal(profile.effort_scan, undefined);
    assert.equal(profile.requested_effort, undefined);
    assert.equal(profile.effort_argv, undefined);
  }
});

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

test("sealPlan seals proposal and PLANNER execution siblings under their distinct principals", async () => {
  const expectedPlanner = {
    claude: ["cadp-planner", "planner:claude-code"],
    grok: ["cadp-planner-grok", "planner:grok"],
    codex: ["cadp-planner-codex", "planner:codex"],
  } as const;
  const intent = "split the policy-qualified planner change into bounded work";
  const baseSha = "a".repeat(40);

  for (const provider of ["claude", "grok", "codex"] as const) {
    const submissions: Array<{ principal: string; draft: EvidenceDraft }> = [];
    const result = await sealPlan("unused", intent, provider, {
      manifest: {
        dir: "unused", api_url: "http://kernel.invalid", root_url: "http://root.invalid",
        api_port: 1, root_port: 2, record_port: 3, temporal_port: 4, temporal_ui_port: 5, broker_port: 6,
        repo_full_name: "owner/repo", repo_id: "123", base_sha: baseSha, tokens: {},
        root_key_id: "root", kernel_config_path: "unused", policy_content_digest: "digest",
      },
      resolveBase: () => baseSha,
      broker: async <T>() => ({ proposal: VALID_PROPOSAL, stdout_digest: "stdout" } as T),
      clientForPrincipal: (principal) => ({
        submitEvidence: async (draft) => {
          submissions.push({ principal, draft });
          return { evidence_id: `evidence-${submissions.length}` } as EvidenceEnvelopeV1;
        },
      }),
    });

    assert.equal(submissions.length, 2);
    const [proposal, backend] = submissions;
    assert.equal(proposal!.principal, expectedPlanner[provider][0]);
    assert.equal(proposal!.draft.evidence_kind, "WORK_PROPOSAL");
    assert.equal(proposal!.draft.producer_ref, expectedPlanner[provider][1], "WORK_PROPOSAL producer_ref stays unchanged");
    assert.equal(backend!.principal, provider === "codex" ? "cadp-backend-scan" : `cadp-backend-scan-${provider}`);
    assert.equal(backend!.draft.evidence_kind, "BACKEND_EXECUTION");
    assert.equal(backend!.draft.producer_ref, `backend-scan:${provider}`);
    assert.deepEqual(backend!.draft.subject_bindings.slice(0, 2), proposal!.draft.subject_bindings);
    assert.deepEqual(backend!.draft.subject_bindings, [
      { authority_ref: "cadp-store:k04", namespace: "work-intent", object_id: sha256Hex(intent) },
      { authority_ref: "github.com", namespace: "repo-base", object_id: `123@${baseSha}` },
      { authority_ref: "cadp-store:k04", namespace: "surface-role", object_id: "PLANNER" },
    ]);
    assert.deepEqual((backend!.draft.claim as Record<string, unknown>)["observed"], {
      model: { availability: "UNKNOWN" },
      provider: { availability: "PRESENT", value: provider, locator: "broker-response#backend_provider" },
      run_id: { availability: "UNKNOWN" }, version: { availability: "UNKNOWN" }, effort: { availability: "UNKNOWN" },
    });
    assert.deepEqual(Object.keys(result).sort(), ["items", "proposal_evidence_id"], "planner execution stays out of downstream gate evidence APIs");
  }
});

const VALID_PROPOSAL = {
  schema: "cadp.work-proposal.v1" as const,
  items: [{ work_item: "make the planner evidence change", max_steps: 4, max_effects: 2, rationale: "bounded" }],
};

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
