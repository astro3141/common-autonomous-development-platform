/**
 * EP-B1 / EP-C1 — the BROKER-to-SURFACE `ExecutionRequestV1` construction contract.
 *
 * Execution Plane TD B1(1) and B1(1e) pin `cadp.execution-request.v1` so that two conforming
 * implementations cannot produce different digests from the same execution: exact closed key sets
 * per role, a profile payload that IS the resolved registry entry verbatim, typed digests over the
 * exact UTF-8 bytes the surface will see, and a fail-closed refusal for anything malformed. C1's
 * surface-input-drift and malformed-request legs are the falsification half.
 *
 *   X1  the exact closed top-level key set of each role — REVIEWER carries `candidate_revision`
 *       and NO `base_revision` key at all, WORKER/PLANNER the mirror image
 *   X2  every digest is a TYPED `Digest`, never a bare hex string; `input_digests` appear in the
 *       mandated order and digest the exact UTF-8 bytes handed over
 *   X3  `executor_profile_payload.v1` is the resolved registry entry VERBATIM — every present key
 *       of the live profile, nothing else, absent optionals OMITTED (never null-filled)
 *   X4  every closed level is closed: unknown keys at the top level, in an `input_digests` entry
 *       and anywhere inside the profile payload are refused; `auth_method` is closed PER VARIANT
 *   X5  array order is load-bearing (`argv_template`, `auth_files`, `allowed_values`) while object
 *       KEY order is not — RFC 8785 sorts keys
 *   X6  SURFACE-INPUT DRIFT: byte-identical preparatory arguments whose broker-BUILT prompt bytes
 *       differ (a merge-base that moved, an edited prompt template) yield DIFFERENT
 *       `execution_request_digest.value`s — a caller-inputs-only digest fails this leg
 *   X7  MALFORMED ⇒ REFUSAL: for every malformed shape, the refusal lands BEFORE the request is
 *       digested, before an attempt identity is minted and before any surface is created
 *   X8  and therefore NO ENVELOPE: driven through the production broker server construction and
 *       the production transport, a malformed request seals nothing at all
 *
 * `can_read_workspace` (REVIEWER) landed in the reviewer-mount lane AFTER the TD's B1(1e) listing
 * was written. The TD's own VERBATIM principle governs — the resolved profile enters the request as
 * the code defines it today — so X3 asserts its PRESENCE in the payload and X5's guard-bite asserts
 * that two profiles differing only in it digest differently. Excluding it would make the payload a
 * TD-era snapshot instead of the resolved entry.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { jcsDigest } from "../../kernel/canonical.ts";
import type { Digest } from "../../kernel/canonical.ts";
import { brokerPostJson } from "../../product/brokerTransport.ts";
import {
  assertExecutionRequestV1,
  buildExecutionRequestV1,
  buildExecutorProfilePayload,
  EXECUTION_REQUEST_KEYS,
  EXECUTION_REQUEST_SCHEMA,
  executionInputDigest,
  executionRequestDigest,
  executorProfileKeys,
  executorProfilePayloadOf,
  REQUIRED_INPUT_ROLES,
  startBoundSurface,
} from "../../product/executionContract.ts";
import type { ExecutionRequestInput, SurfaceRole } from "../../product/executionContract.ts";
import { PLAN_PROVIDERS } from "../../product/planProviders.ts";
import { REVIEW_PROVIDERS } from "../../product/reviewProviders.ts";
import { buildReviewPrompt, startBroker } from "../../product/surfaceBroker.ts";
import type { BrokerOperation } from "../../product/surfaceBroker.ts";
import { WORKER_PROVIDERS } from "../../product/workerProviders.ts";

const BASE_SHA = "1".repeat(40);
const CANDIDATE_SHA = "2".repeat(40);
const REPO = "astro3141/cadp";
const WORK_ITEM = "fix the reviewer prompt — é 漢 🙂";
const INTENT = "decompose the execution-contract lane";

const WORKER_INPUT = {
  surface_role: "WORKER",
  provider: "codex",
  repo_id: REPO,
  base_revision: BASE_SHA,
  workspace_revision: BASE_SHA,
  work_item: WORK_ITEM,
  surface_prompt: WORK_ITEM,
} as const satisfies ExecutionRequestInput;

const PLANNER_INPUT = {
  surface_role: "PLANNER",
  provider: "claude",
  repo_id: REPO,
  base_revision: BASE_SHA,
  workspace_revision: BASE_SHA,
  intent: INTENT,
  surface_prompt: `PLAN PROMPT for ${INTENT}`,
} as const satisfies ExecutionRequestInput;

const REVIEWER_INPUT = {
  surface_role: "REVIEWER",
  provider: "grok",
  repo_id: REPO,
  candidate_revision: CANDIDATE_SHA,
  work_item: WORK_ITEM,
  surface_prompt: buildReviewPrompt("grok", CANDIDATE_SHA, WORK_ITEM, "diff --git a/x b/x\n+one\n"),
} as const satisfies ExecutionRequestInput;

const INPUTS: readonly ExecutionRequestInput[] = [WORKER_INPUT, PLANNER_INPUT, REVIEWER_INPUT];

const sha256Hex = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** Read a typed request as a plain bag of keys, so a leg can assert on the key set itself. */
const asObject = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

/** A mutable deep copy, so a leg can construct exactly the malformation it names. */
const mutate = (request: unknown, edit: (copy: Record<string, unknown>) => void): Record<string, unknown> => {
  const copy = structuredClone(request) as Record<string, unknown>;
  edit(copy);
  return copy;
};

const entriesOf = (request: unknown): Array<Record<string, unknown>> =>
  (request as { input_digests: Array<Record<string, unknown>> }).input_digests;

// ============================================================ X1 — the exact closed role shapes

test("X1: each role's ExecutionRequestV1 carries EXACTLY its closed top-level key set", () => {
  const expected: Record<SurfaceRole, readonly string[]> = {
    WORKER: ["schema", "surface_role", "provider", "executor_profile_digest", "repo_id", "base_revision", "input_digests"],
    PLANNER: ["schema", "surface_role", "provider", "executor_profile_digest", "repo_id", "base_revision", "input_digests"],
    REVIEWER: ["schema", "surface_role", "provider", "executor_profile_digest", "repo_id", "candidate_revision", "input_digests"],
  };
  for (const input of INPUTS) {
    const request = asObject(buildExecutionRequestV1(input));
    // The pinned set, and the module's own declaration of it, agree with the TD text verbatim.
    assert.deepEqual([...EXECUTION_REQUEST_KEYS[input.surface_role]], [...expected[input.surface_role]]);
    assert.deepEqual(Object.keys(request).sort(), [...expected[input.surface_role]].sort());
    assert.equal(request["schema"], EXECUTION_REQUEST_SCHEMA);
    assert.equal(request["surface_role"], input.surface_role);
    assert.equal(request["provider"], input.provider);
    assert.equal(request["repo_id"], REPO);
  }
});

test("X1: REVIEWER carries no base_revision key AT ALL — not a null, not an empty one", () => {
  const reviewer = asObject(buildExecutionRequestV1(REVIEWER_INPUT));
  assert.ok(!("base_revision" in reviewer), "the broker is never handed a base sha for a review");
  assert.equal(reviewer["candidate_revision"], CANDIDATE_SHA);
  // ...and the mirror image: the roles that DO materialize a workspace carry no candidate_revision.
  for (const input of [WORKER_INPUT, PLANNER_INPUT]) {
    const request = asObject(buildExecutionRequestV1(input));
    assert.ok(!("candidate_revision" in request));
    assert.equal(request["base_revision"], BASE_SHA);
  }
});

// ================================================ X2 — typed digests, mandated order, UTF-8 bytes

test("X2: input_digests appear in the mandated order, exactly once each, per role", () => {
  assert.deepEqual([...REQUIRED_INPUT_ROLES.WORKER], ["work-item", "surface-prompt", "workspace-revision"]);
  assert.deepEqual([...REQUIRED_INPUT_ROLES.PLANNER], ["intent", "surface-prompt", "workspace-revision"]);
  // REVIEWER mounts a fresh EMPTY review-ws, so it declares no workspace-revision entry at all.
  assert.deepEqual([...REQUIRED_INPUT_ROLES.REVIEWER], ["work-item", "surface-prompt"]);
  for (const input of INPUTS) {
    const request = buildExecutionRequestV1(input);
    assert.deepEqual(
      request.input_digests.map((e) => e.input_role),
      [...REQUIRED_INPUT_ROLES[input.surface_role]],
    );
  }
});

test("X2: every digest is a TYPED Digest over the exact UTF-8 bytes — never a bare hex string", () => {
  const worker = buildExecutionRequestV1(WORKER_INPUT);
  assert.equal(worker.executor_profile_digest.algorithm, "sha256");
  assert.equal(worker.executor_profile_digest.canonicalization, "cadp-jcs-1");
  assert.equal(worker.executor_profile_digest.value, jcsDigest(buildExecutorProfilePayload("WORKER", "codex")).value);

  const expected: Record<string, string> = {
    "work-item": WORK_ITEM,
    "surface-prompt": WORK_ITEM,
    "workspace-revision": BASE_SHA,
  };
  for (const entry of worker.input_digests) {
    assert.deepEqual(Object.keys(entry).sort(), ["digest", "input_role"], "the entry shape is exactly { input_role, digest }");
    assert.equal(entry.digest.algorithm, "sha256");
    assert.equal(entry.digest.canonicalization, "raw-bytes-1");
    // The bytes, independently computed here: a multi-byte work item proves the encoding is UTF-8
    // and not UTF-16 or latin1, and the revision entry digests its 40-character sha STRING.
    assert.equal(entry.digest.value, sha256Hex(expected[entry.input_role]!));
  }
  assert.equal(executionInputDigest(BASE_SHA).value, sha256Hex(BASE_SHA));

  // The PLANNER's intent and its broker-BUILT prompt are distinct entries with distinct digests.
  const planner = buildExecutionRequestV1(PLANNER_INPUT);
  const intentEntry = planner.input_digests.find((e) => e.input_role === "intent")!;
  const promptEntry = planner.input_digests.find((e) => e.input_role === "surface-prompt")!;
  assert.equal(intentEntry.digest.value, sha256Hex(INTENT));
  assert.equal(promptEntry.digest.value, sha256Hex(PLANNER_INPUT.surface_prompt));
  assert.notEqual(intentEntry.digest.value, promptEntry.digest.value);
});

test("X2: execution_request_digest is a typed jcsDigest over the COMPLETE request object", () => {
  for (const input of INPUTS) {
    const request = buildExecutionRequestV1(input);
    const digest: Digest = executionRequestDigest(request);
    assert.equal(digest.algorithm, "sha256");
    assert.equal(digest.canonicalization, "cadp-jcs-1");
    assert.match(digest.value, /^[0-9a-f]{64}$/u);
    assert.equal(digest.value, jcsDigest(request).value);
    // Deterministic: the same execution digests equal, twice.
    assert.equal(executionRequestDigest(buildExecutionRequestV1(input)).value, digest.value);
  }
  // Two roles are two requests: no digest is shared across the role boundary.
  const values = INPUTS.map((i) => executionRequestDigest(buildExecutionRequestV1(i)).value);
  assert.equal(new Set(values).size, values.length);
});

// ============================== X3 — the profile payload IS the resolved registry entry, verbatim

const REGISTRIES: ReadonlyArray<{ role: SurfaceRole; registry: Readonly<Record<string, Record<string, unknown>>> }> = [
  { role: "WORKER", registry: WORKER_PROVIDERS as unknown as Readonly<Record<string, Record<string, unknown>>> },
  { role: "REVIEWER", registry: REVIEW_PROVIDERS as unknown as Readonly<Record<string, Record<string, unknown>>> },
  { role: "PLANNER", registry: PLAN_PROVIDERS as unknown as Readonly<Record<string, Record<string, unknown>>> },
];

test("X3: the payload is the LIVE resolved profile verbatim — every present key, nothing added, nothing dropped", () => {
  for (const { role, registry } of REGISTRIES) {
    for (const [provider, profile] of Object.entries(registry)) {
      const payload = buildExecutorProfilePayload(role, provider);
      const present = Object.entries(profile).filter(([, value]) => value !== undefined);
      assert.deepEqual(
        Object.keys(payload).sort(),
        present.map(([key]) => key).sort(),
        `${role}/${provider}: the payload key set must be the profile's own present key set — a key the code defines today and the payload omits is a TD-era snapshot, not the resolved entry`,
      );
      for (const [key, value] of present) {
        assert.deepEqual(payload[key], value, `${role}/${provider}.${key} must be copied verbatim`);
      }
      // Absent optionals are OMITTED, never null-filled and never defaulted.
      for (const key of executorProfileKeys(role)) {
        if (profile[key] === undefined) assert.ok(!(key in payload), `${role}/${provider}.${key} is absent and must stay absent`);
      }
    }
  }
});

test("X3: the REVIEWER payload carries can_read_workspace — the profile field that landed after the TD", () => {
  assert.ok(executorProfileKeys("REVIEWER").includes("can_read_workspace"));
  for (const [provider, profile] of Object.entries(REVIEW_PROVIDERS)) {
    const payload = buildExecutorProfilePayload("REVIEWER", provider);
    assert.equal(typeof profile.can_read_workspace, "boolean", "the live profile declares it");
    assert.equal(payload["can_read_workspace"], profile.can_read_workspace, `${provider}: silently excluding it would break the verbatim contract`);
  }
  // The PLANNER profile type declares neither can_read_workspace nor verdict_format, so neither is
  // in its closed set: a field added to one role's profile never leaks into another role's payload.
  assert.ok(!executorProfileKeys("PLANNER").includes("can_read_workspace"));
  assert.ok(!executorProfileKeys("PLANNER").includes("verdict_format"));
  assert.ok(executorProfileKeys("REVIEWER").includes("verdict_format"));
  for (const provider of Object.keys(PLAN_PROVIDERS)) {
    const payload = buildExecutorProfilePayload("PLANNER", provider);
    assert.ok(!("can_read_workspace" in payload));
    assert.ok(!("verdict_format" in payload));
  }
});

test("X3: auth_env.static_env is the ONE open map — copied verbatim, and no credential is in the preimage", () => {
  const payload = buildExecutorProfilePayload("WORKER", "claude");
  assert.deepEqual(payload["auth_env"], { env_var: "CLAUDE_CODE_OAUTH_TOKEN", static_env: { IS_SANDBOX: "1" } });
  // An arbitrary provider-data key is carried; the map's keys are data, not schema.
  const widened = executorProfilePayloadOf("WORKER", {
    ...WORKER_PROVIDERS.claude,
    auth_env: { env_var: "CLAUDE_CODE_OAUTH_TOKEN", static_env: { IS_SANDBOX: "1", MEASURED_EXTRA: "yes" } },
  });
  assert.deepEqual((widened["auth_env"] as { static_env: unknown }).static_env, { IS_SANDBOX: "1", MEASURED_EXTRA: "yes" });
  // DESCRIPTORS ONLY: the preimage names WHERE auth comes from — `auth_files` / `auth_subdir` /
  // `auth_env.env_var` / `auth_method` — so no credential can be in it. `auth_env.env_var` is the
  // NAME of an env var, never its value, and the resolved token (`claudeProviderToken`) is injected
  // by the broker at container construction and appears in no profile and therefore in no payload.
  const keysDeep = (value: unknown): string[] =>
    typeof value !== "object" || value === null
      ? []
      : Array.isArray(value)
        ? value.flatMap(keysDeep)
        : Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => [key, ...keysDeep(nested)]);
  for (const { role, registry } of REGISTRIES) {
    for (const provider of Object.keys(registry)) {
      for (const key of keysDeep(buildExecutorProfilePayload(role, provider))) {
        assert.ok(
          !/^(token|secret|credential|password)$/iu.test(key),
          `${role}/${provider} payload declares a credential-VALUE key "${key}" — the preimage carries descriptors only`,
        );
      }
    }
  }
});

// ================================================================= X4 — every closed level closes

test("X4: an unknown key ANYWHERE inside the profile payload is refused", () => {
  const cases: ReadonlyArray<{ role: SurfaceRole; profile: unknown; what: string }> = [
    { role: "WORKER", profile: { ...WORKER_PROVIDERS.codex, extra_key: "x" }, what: "top level of the payload" },
    { role: "WORKER", profile: { ...WORKER_PROVIDERS.codex, model_scan: { session_regex: "a", stdout_regex: "b", extra: "c" } }, what: "model_scan" },
    { role: "WORKER", profile: { ...WORKER_PROVIDERS.codex, effort_scan: { session_regex: "a", stdout_regex: "b", note: "c" } }, what: "effort_scan" },
    { role: "WORKER", profile: { ...WORKER_PROVIDERS.claude, auth_env: { env_var: "E", static_env: {}, extra: 1 } }, what: "auth_env" },
    { role: "REVIEWER", profile: { ...REVIEW_PROVIDERS.codex, effort_argv: { ...REVIEW_PROVIDERS.codex.effort_argv, extra: 1 } }, what: "effort_argv" },
    { role: "PLANNER", profile: { ...PLAN_PROVIDERS.claude, verdict_format: "first-line" }, what: "a key that belongs to another role" },
  ];
  for (const { role, profile, what } of cases) {
    assert.throws(() => executorProfilePayloadOf(role, profile), /MALFORMED: unknown key/u, `unknown key at ${what} must be refused`);
  }
  // A MISSING required key is equally malformed — the payload is never null-filled to cover it.
  const { identity_class_product: _dropped, ...withoutRequired } = WORKER_PROVIDERS.codex;
  assert.throws(() => executorProfilePayloadOf("WORKER", withoutRequired), /MALFORMED: missing required key "identity_class_product"/u);
});

test("X4: auth_method is a discriminated union closed PER VARIANT — no key of the other variant", () => {
  // Each live variant round-trips verbatim, carrying exactly its own keys.
  assert.deepEqual(buildExecutorProfilePayload("REVIEWER", "claude")["auth_method"], { kind: "oauth_env", env_var: "CLAUDE_CODE_OAUTH_TOKEN" });
  assert.deepEqual(buildExecutorProfilePayload("REVIEWER", "grok")["auth_method"], { kind: "auth_files", auth_subdir: ".grok", auth_files: ["auth.json"] });

  const withAuthMethod = (auth_method: unknown): unknown => ({ ...REVIEW_PROVIDERS.claude, auth_method });
  assert.throws(
    () => executorProfilePayloadOf("REVIEWER", withAuthMethod({ kind: "oauth_env", env_var: "E", auth_subdir: ".claude" })),
    /MALFORMED: unknown key "auth_subdir"/u,
    "an oauth_env variant may not carry an auth_files key, not even as a hint",
  );
  assert.throws(
    () => executorProfilePayloadOf("REVIEWER", withAuthMethod({ kind: "auth_files", auth_subdir: ".grok", auth_files: [], env_var: "E" })),
    /MALFORMED: unknown key "env_var"/u,
  );
  assert.throws(() => executorProfilePayloadOf("REVIEWER", withAuthMethod({ env_var: "E" })), /MALFORMED: .*kind is missing/u);
  assert.throws(() => executorProfilePayloadOf("REVIEWER", withAuthMethod({ kind: "keychain", env_var: "E" })), /MALFORMED: unknown .*kind "keychain"/u);
});

// ======================================= X5 — array order is load-bearing, object key order is not

test("X5: reordering a load-bearing ARRAY changes the profile digest", () => {
  const digestOf = (role: SurfaceRole, profile: unknown): string => jcsDigest(executorProfilePayloadOf(role, profile)).value;
  const codex = WORKER_PROVIDERS.codex;
  const baseline = digestOf("WORKER", codex);
  assert.equal(baseline, jcsDigest(buildExecutorProfilePayload("WORKER", "codex")).value);

  // argv_template IS the argv identity of §17.1: the same tokens in a different order are a
  // different invocation, and must be a different executor profile.
  assert.notEqual(digestOf("WORKER", { ...codex, argv_template: [...codex.argv_template].reverse() }), baseline);
  assert.notEqual(digestOf("WORKER", { ...codex, auth_files: ["b.json", "a.json"] }), digestOf("WORKER", { ...codex, auth_files: ["a.json", "b.json"] }));
  const reviewCodex = REVIEW_PROVIDERS.codex;
  assert.notEqual(
    digestOf("REVIEWER", { ...reviewCodex, effort_argv: { ...reviewCodex.effort_argv!, allowed_values: ["high", "low"] } }),
    digestOf("REVIEWER", { ...reviewCodex, effort_argv: { ...reviewCodex.effort_argv!, allowed_values: ["low", "high"] } }),
  );
});

test("X5: object KEY declaration order does not change the digest — RFC 8785 sorts keys", () => {
  const codex = WORKER_PROVIDERS.codex;
  const reordered: Record<string, unknown> = {};
  for (const key of Object.keys(codex).reverse()) reordered[key] = asObject(codex)[key];
  assert.notDeepEqual(Object.keys(reordered), Object.keys(codex));
  assert.equal(jcsDigest(executorProfilePayloadOf("WORKER", reordered)).value, jcsDigest(buildExecutorProfilePayload("WORKER", "codex")).value);
});

test("X5 guard-bite: two REVIEWER profiles differing ONLY in can_read_workspace digest differently", () => {
  const claude = REVIEW_PROVIDERS.claude;
  const flipped = { ...claude, can_read_workspace: !claude.can_read_workspace };
  assert.notEqual(
    jcsDigest(executorProfilePayloadOf("REVIEWER", flipped)).value,
    jcsDigest(executorProfilePayloadOf("REVIEWER", claude)).value,
    "a payload that excluded can_read_workspace would collapse two profiles whose prompts genuinely differ",
  );
});

// ================================================================== X6 — SURFACE-INPUT DRIFT (C1)

test("X6: a merge-base that moved changes the request digest under BYTE-IDENTICAL caller arguments", () => {
  // Same repo, same candidate sha, same work item, same provider — the whole preparatory request.
  // Only the broker-BUILT prompt differs, because `git merge-base origin/main <candidate>` resolved
  // to a different fork point after origin/main moved, so `git diff <forkBase> <candidate>` covers
  // a different range.
  const beforeDrift = buildReviewPrompt("grok", CANDIDATE_SHA, WORK_ITEM, "diff --git a/x b/x\n+one\n");
  const afterDrift = buildReviewPrompt("grok", CANDIDATE_SHA, WORK_ITEM, "diff --git a/x b/x\n+one\n+two\n");
  const request = (surface_prompt: string) =>
    buildExecutionRequestV1({ surface_role: "REVIEWER", provider: "grok", repo_id: REPO, candidate_revision: CANDIDATE_SHA, work_item: WORK_ITEM, surface_prompt });

  const a = request(beforeDrift);
  const b = request(afterDrift);
  // The caller layer is identical in both — which is exactly why a caller-inputs-only digest fails.
  const callerDigest = (r: typeof a): string => r.input_digests.find((e) => e.input_role === "work-item")!.digest.value;
  assert.equal(callerDigest(a), callerDigest(b));
  assert.equal(a.candidate_revision, b.candidate_revision);
  assert.equal(a.executor_profile_digest.value, b.executor_profile_digest.value);
  assert.notEqual(executionRequestDigest(a).value, executionRequestDigest(b).value);
});

test("X6: an edited prompt TEMPLATE drifts the digest too, and the profile capability scopes it", () => {
  const diff = "diff --git a/x b/x\n+one\n";
  const asBuilt = buildReviewPrompt("grok", CANDIDATE_SHA, WORK_ITEM, diff);
  const asEdited = `${asBuilt}\n\nAn extra instruction a template edit would add.`;
  const digestFor = (surface_prompt: string): string =>
    executionRequestDigest(
      buildExecutionRequestV1({ surface_role: "REVIEWER", provider: "grok", repo_id: REPO, candidate_revision: CANDIDATE_SHA, work_item: WORK_ITEM, surface_prompt }),
    ).value;
  assert.notEqual(digestFor(asEdited), digestFor(asBuilt));

  // The same drift is real across profiles: grok can read the mount and is told so, claude cannot.
  const grokPrompt = buildReviewPrompt("grok", CANDIDATE_SHA, WORK_ITEM, diff);
  const claudePrompt = buildReviewPrompt("claude", CANDIDATE_SHA, WORK_ITEM, diff);
  assert.notEqual(grokPrompt, claudePrompt);
  assert.notEqual(executionInputDigest(grokPrompt).value, executionInputDigest(claudePrompt).value);
});

test("X6: the WORKER and PLANNER surface-prompt entries digest the FINAL bytes, not the caller string", () => {
  // PLANNER: the caller hands an intent; the surface reads `buildPlanPrompt`'s output.
  const planner = buildExecutionRequestV1(PLANNER_INPUT);
  const drifted = buildExecutionRequestV1({ ...PLANNER_INPUT, surface_prompt: `${PLANNER_INPUT.surface_prompt} (template edited)` });
  assert.equal(
    planner.input_digests.find((e) => e.input_role === "intent")!.digest.value,
    drifted.input_digests.find((e) => e.input_role === "intent")!.digest.value,
  );
  assert.notEqual(executionRequestDigest(planner).value, executionRequestDigest(drifted).value);

  // WORKER: the prompt is the work item as substituted at WORK_ITEM_SENTINEL. It equals the caller
  // string at this checkout, so its entry is a SEPARATE declared fact rather than a duplicate one —
  // a substitution that ever stopped being the identity would show up here as a digest change.
  const worker = buildExecutionRequestV1(WORKER_INPUT);
  const substituted = buildExecutionRequestV1({ ...WORKER_INPUT, surface_prompt: `${WORK_ITEM} [wrapped]` });
  assert.notEqual(executionRequestDigest(worker).value, executionRequestDigest(substituted).value);
});

// ========================= X7 — MALFORMED ⇒ refusal BEFORE digest, attempt identity and surface

const VALID_WORKER = buildExecutionRequestV1(WORKER_INPUT);
const VALID_REVIEWER = buildExecutionRequestV1(REVIEWER_INPUT);
const HEX = "a".repeat(64);

const MALFORMED_REQUESTS: ReadonlyArray<{ what: string; request: unknown; expect: RegExp }> = [
  { what: "an unknown top-level key", request: mutate(VALID_WORKER, (r) => { r["run_id"] = "extra"; }), expect: /unknown top-level key "run_id"/u },
  { what: "a REVIEWER carrying base_revision", request: mutate(VALID_REVIEWER, (r) => { r["base_revision"] = BASE_SHA; }), expect: /unknown top-level key "base_revision" for surface_role REVIEWER/u },
  {
    what: "a WORKER carrying candidate_revision instead of base_revision",
    request: mutate(VALID_WORKER, (r) => { delete r["base_revision"]; r["candidate_revision"] = CANDIDATE_SHA; }),
    expect: /unknown top-level key "candidate_revision" for surface_role WORKER/u,
  },
  { what: "a missing required top-level key", request: mutate(VALID_WORKER, (r) => { delete r["repo_id"]; }), expect: /missing required key "repo_id"/u },
  { what: "a wrong schema literal", request: mutate(VALID_WORKER, (r) => { r["schema"] = "cadp.execution-request.v2"; }), expect: /schema must be the literal/u },
  { what: "a surface_role outside the closed vocabulary", request: mutate(VALID_WORKER, (r) => { r["surface_role"] = "VERIFIER"; }), expect: /outside the closed WORKER \| REVIEWER \| PLANNER/u },
  { what: "an unknown provider", request: mutate(VALID_WORKER, (r) => { r["provider"] = "gemini"; }), expect: /unknown WORKER provider "gemini"/u },
  { what: "an unknown key in an input_digests entry", request: mutate(VALID_WORKER, (r) => { entriesOf(r)[0]!["locator"] = "x"; }), expect: /unknown key "locator" in input_digests\[0\]/u },
  { what: "an unknown input_role", request: mutate(VALID_WORKER, (r) => { entriesOf(r)[0]!["input_role"] = "session-log"; }), expect: /unknown input_role "session-log"/u },
  { what: "a duplicate input_role", request: mutate(VALID_WORKER, (r) => { entriesOf(r).push(structuredClone(entriesOf(r)[0]!)); }), expect: /duplicate input_role "work-item"/u },
  { what: "a missing required input_role", request: mutate(VALID_WORKER, (r) => { entriesOf(r).splice(1, 1); }), expect: /missing required input_role "surface-prompt"/u },
  {
    what: "an input_role not declared for the role (REVIEWER + workspace-revision)",
    request: mutate(VALID_REVIEWER, (r) => { entriesOf(r).push({ input_role: "workspace-revision", digest: { ...executionInputDigest(CANDIDATE_SHA) } }); }),
    expect: /input_role "workspace-revision" is not declared for surface_role REVIEWER/u,
  },
  {
    what: "input_digests out of the mandated order",
    request: mutate(VALID_WORKER, (r) => { const e = entriesOf(r); [e[0], e[1]] = [e[1]!, e[0]!]; }),
    expect: /must appear in the mandated order/u,
  },
  { what: "a bare hex string where a typed input Digest belongs", request: mutate(VALID_WORKER, (r) => { entriesOf(r)[1]!["digest"] = HEX; }), expect: /input_digests\[1\]\.digest is not a typed Digest/u },
  {
    what: "an input digest under the wrong canonicalization",
    request: mutate(VALID_WORKER, (r) => { (entriesOf(r)[1]!["digest"] as Record<string, unknown>)["canonicalization"] = "cadp-jcs-1"; }),
    expect: /input_digests\[1\]\.digest carries canonicalization "cadp-jcs-1"/u,
  },
  {
    what: "an input digest whose value is not 64 hex characters",
    request: mutate(VALID_WORKER, (r) => { (entriesOf(r)[1]!["digest"] as Record<string, unknown>)["value"] = "not-a-digest"; }),
    expect: /input_digests\[1\]\.digest is not a typed Digest/u,
  },
  { what: "a bare hex string where the typed executor_profile_digest belongs", request: mutate(VALID_WORKER, (r) => { r["executor_profile_digest"] = HEX; }), expect: /executor_profile_digest is not a typed Digest/u },
  {
    what: "a profile digest from ANOTHER role's registry entry",
    request: mutate(VALID_REVIEWER, (r) => { r["executor_profile_digest"] = { ...jcsDigest(buildExecutorProfilePayload("PLANNER", "grok")) }; }),
    expect: /executor_profile_digest is not jcsDigest of the resolved registry entry/u,
  },
  { what: "a revision that is not a 40-character sha", request: mutate(VALID_WORKER, (r) => { r["base_revision"] = "HEAD"; }), expect: /base_revision must be a 40-character lowercase hex sha/u },
  { what: "a reviewer candidate_revision that is not a sha", request: mutate(VALID_REVIEWER, (r) => { r["candidate_revision"] = "origin/main"; }), expect: /candidate_revision must be a 40-character lowercase hex sha/u },
  {
    what: "a workspace-revision that is not the declared base_revision (the broker materialized another tree)",
    request: mutate(VALID_WORKER, (r) => { entriesOf(r)[2]!["digest"] = { ...executionInputDigest(CANDIDATE_SHA) }; }),
    expect: /workspace-revision entry must digest the role's base_revision/u,
  },
  { what: "input_digests that is not an array", request: mutate(VALID_WORKER, (r) => { r["input_digests"] = {}; }), expect: /input_digests must be an array/u },
  { what: "a request that is not an object at all", request: "cadp.execution-request.v1", expect: /the request is not an object/u },
];

test("X7: every malformed request is REFUSED — and nothing is digested, minted or started", async () => {
  assert.ok(MALFORMED_REQUESTS.length >= 20, "the malformed table must cover every B1(1e) leg");
  for (const { what, request, expect } of MALFORMED_REQUESTS) {
    // The validator refuses it...
    assert.throws(() => { assertExecutionRequestV1(request); }, expect, `${what} must be refused`);
    assert.throws(() => executionRequestDigest(request), /MALFORMED/u, `${what}: no request digest may be computed`);

    // ...and at the gate the surface would start at, the refusal lands BEFORE the digest and BEFORE
    // the attempt identity is minted. `digest` is counted, and `start` is the only place a container
    // identity is ever created — exactly as `runBoundedSurface` mints it at surface start.
    let digested = 0;
    const attempts: string[] = [];
    await assert.rejects(
      startBoundSurface(
        request,
        async () => { attempts.push(`cadp-surface-worker-${randomUUID()}`); return "SURFACE RAN"; },
        (value) => { digested += 1; return jcsDigest(value); },
      ),
      expect,
      `${what} must be refused at the surface gate`,
    );
    assert.equal(digested, 0, `${what}: the request must not be digested before the refusal`);
    assert.deepEqual(attempts, [], `${what}: no attempt identity may be minted and no surface created`);
  }
});

test("X7: a VALID request digests exactly once and only then starts the surface", async () => {
  const order: string[] = [];
  let digested = 0;
  const result = await startBoundSurface(
    VALID_WORKER,
    async (bound) => {
      order.push("start");
      assert.equal(bound.request, VALID_WORKER);
      assert.equal(bound.execution_request_digest.value, executionRequestDigest(VALID_WORKER).value);
      return `cadp-surface-worker-${randomUUID()}`;
    },
    (value) => { order.push("digest"); digested += 1; return jcsDigest(value); },
  );
  assert.equal(digested, 1);
  // The pinned causality: request → digest → attempt identity + surface start.
  assert.deepEqual(order, ["digest", "start"]);
  assert.match(result, /^cadp-surface-worker-/u);
});

// ============================================ X8 — the no-envelope outcome, through the real seams

interface RunningServer { url: string; close: () => Promise<void> }

async function listen(server: Server): Promise<RunningServer> {
  if (!server.listening) await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test("X8: a malformed request through the production broker server seals NOTHING — no surface, no attempt, no envelope", async () => {
  const attempts: string[] = [];
  const envelopes: unknown[] = [];
  const operations: Record<string, BrokerOperation> = {
    // The production broker construction (`startBroker`) with one scripted operation: it performs
    // exactly what `brokerImplement` now performs — build the request, then start the surface
    // through the gate. The surface stand-in mints an attempt identity, as the real one does.
    "/implement": {
      response_budget_ms: 5_000,
      run: (body) =>
        startBoundSurface(body["request"], async () => {
          const container = `cadp-surface-worker-${randomUUID()}`;
          attempts.push(container);
          return { candidate_sha: CANDIDATE_SHA, container };
        }),
    },
  };
  const broker = await listen(startBroker(0, operations));
  try {
    // The activity host's half: it submits an envelope ONLY from a result the broker returned.
    const implement = async (request: unknown): Promise<void> => {
      const result = await brokerPostJson<{ candidate_sha: string }>(broker.url, "/implement", { request }, { rpc_ms: 5_000 });
      envelopes.push({ evidence_kind: "BACKEND_EXECUTION", candidate_sha: result.candidate_sha });
    };

    for (const { what, request } of MALFORMED_REQUESTS) {
      await assert.rejects(implement(request), /MALFORMED/u, `${what} must fail the whole call`);
    }
    assert.deepEqual(attempts, [], "no surface was created and no attempt identity was minted");
    assert.deepEqual(envelopes, [], "the absence of any BACKEND_EXECUTION envelope is the assertion");

    // The same seam with a WELL-FORMED request does produce exactly one attempt and one envelope,
    // so the zero above is a refusal and not a broken harness.
    await implement(VALID_WORKER);
    assert.equal(attempts.length, 1);
    assert.equal(envelopes.length, 1);
  } finally {
    await broker.close();
  }
});
