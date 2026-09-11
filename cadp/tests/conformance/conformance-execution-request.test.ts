/**
 * EP-B1(1)/(1e) — the BROKER-to-SURFACE `cadp.execution-request.v1` construction contract, and the
 * EP-C1 SURFACE-INPUT-DRIFT and MALFORMED-REQUEST legs.
 *
 * The contract is contract-new (EP B1's opening), so these legs falsify the CONSTRUCTION path the
 * TD pins, not a measured capture. What each leg asserts:
 *
 *   X1  the EXACT closed top-level key set of each role — WORKER/PLANNER carry `base_revision`,
 *       REVIEWER carries `candidate_revision` and NO `base_revision` key at all
 *   X2  every digest is TYPED: `executor_profile_digest` under `cadp-jcs-1`, every `input_digests`
 *       entry under `raw-bytes-1` over the exact UTF-8 bytes handed over, never a bare hex string
 *   X3  the required `input_role`s, each present exactly once, in the mandated literal order
 *   X4  `executor_profile_payload.v1` is the resolved registry entry VERBATIM under B1(1)'s EXACT
 *       pinned key set: absent optionals OMITTED (never null-filled), `auth_env.static_env` the one
 *       open map, nothing added — and no key outside the pinned set digested even when the
 *       implemented interface has gained one (`can_read_workspace`, #259 P0a)
 *   X5  nested closure — `auth_env`, `model_scan`, `effort_scan`, `effort_argv`, and `auth_method`
 *       closed PER VARIANT with no key of the other variant carried, not even as undefined
 *   X6  ARRAY ORDER is load-bearing: reordering `argv_template` / `auth_files` /
 *       `effort_argv.allowed_values` changes the digest, while object-key order never does
 *   X7  SURFACE-INPUT DRIFT (EP-C1): two reviewer requests whose PREPARATORY arguments are
 *       byte-identical but whose built prompt differs — a moved merge-base, a changed template —
 *       yield different `execution_request_digest.value`s. A caller-inputs-only digest fails.
 *   X8  MALFORMED ⇒ REFUSAL WITH NOTHING EXECUTED (EP-C1): for every malformed shape the refusal
 *       lands before the request digest is computed, before an attempt identity is minted, before
 *       a surface is created, and therefore before anything could be captured or sealed
 *   X9  the broker's three surface starts all run through that gate (source-order pin)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  EXECUTION_REQUEST_SCHEMA,
  EXECUTOR_PROFILE_KEYS,
  ExecutionRequestMalformed,
  REQUEST_KEYS,
  REQUIRED_INPUT_ROLES,
  assertExecutionRequestWellFormed,
  buildExecutionRequest,
  executionRequestDigest,
  executorProfileDigest,
  executorProfilePayload,
  startSurfaceUnderRequest,
} from "../../product/executionContract.ts";
import type { ExecutionRequestV1, SurfaceRole } from "../../product/executionContract.ts";
import { WORKER_PROVIDERS } from "../../product/workerProviders.ts";
import { REVIEW_PROVIDERS } from "../../product/reviewProviders.ts";
import { PLAN_PROVIDERS } from "../../product/planProviders.ts";
import { buildReviewPrompt } from "../../product/surfaceBroker.ts";

const REPO = "astro3141/cadp";
const BASE = "1".repeat(40);
const CANDIDATE = "2".repeat(40);
// Non-ASCII on purpose: the entries digest UTF-8 BYTES, not code units.
const WORK_ITEM = 'implement the “symmetric” contract — Ω/日本語';
const INTENT = "decompose the v0.5 execution plane — ✅";

const rawHex = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

const workerRequest = (over: { work_item?: string; surface_prompt?: string; base_revision?: string } = {}): ExecutionRequestV1 =>
  buildExecutionRequest({
    surface_role: "WORKER",
    provider: "codex",
    profile: WORKER_PROVIDERS.codex,
    repo_id: REPO,
    base_revision: over.base_revision ?? BASE,
    work_item: over.work_item ?? WORK_ITEM,
    surface_prompt: over.surface_prompt ?? WORK_ITEM,
  });

const plannerRequest = (): ExecutionRequestV1 =>
  buildExecutionRequest({
    surface_role: "PLANNER",
    provider: "claude",
    profile: PLAN_PROVIDERS.claude,
    repo_id: REPO,
    base_revision: BASE,
    intent: INTENT,
    surface_prompt: `PLAN PROMPT for ${INTENT}`,
  });

const reviewerRequest = (surface_prompt: string): ExecutionRequestV1 =>
  buildExecutionRequest({
    surface_role: "REVIEWER",
    provider: "codex",
    profile: REVIEW_PROVIDERS.codex,
    repo_id: REPO,
    candidate_revision: CANDIDATE,
    work_item: WORK_ITEM,
    surface_prompt,
  });

const clone = <T>(value: T): T => structuredClone(value);

const malformedReason = (error: unknown): string | undefined =>
  error instanceof ExecutionRequestMalformed ? error.reason : undefined;

// ------------------------------------------------------------------ X1/X2/X3

test("X1: each role's request carries EXACTLY its closed top-level key set", () => {
  const shapes: ReadonlyArray<readonly [SurfaceRole, ExecutionRequestV1]> = [
    ["WORKER", workerRequest()],
    ["PLANNER", plannerRequest()],
    ["REVIEWER", reviewerRequest("a built reviewer prompt")],
  ];
  for (const [role, request] of shapes) {
    assert.deepEqual(
      Object.keys(request).sort(),
      [...REQUEST_KEYS[role]].sort(),
      `${role} must carry exactly ${REQUEST_KEYS[role].join(", ")}`,
    );
    assert.equal(request.schema, EXECUTION_REQUEST_SCHEMA);
    assert.equal(request.surface_role, role);
    assert.equal(request.repo_id, REPO);
  }

  // The asymmetry is in the implemented signatures and the contract mirrors it rather than papering
  // over it: `brokerReview` is handed a candidate and NO base at all.
  const reviewer = shapes[2]![1];
  assert.ok(!Object.prototype.hasOwnProperty.call(reviewer, "base_revision"), "REVIEWER carries no base_revision key — not a null or empty one");
  assert.equal((reviewer as { candidate_revision: string }).candidate_revision, CANDIDATE);
  // WORKER and PLANNER share the key set exactly; they differ in required input_roles, not keys.
  assert.deepEqual(Object.keys(shapes[0]![1]).sort(), Object.keys(shapes[1]![1]).sort());
});

test("X2: every digest is TYPED — profile under cadp-jcs-1, inputs under raw-bytes-1 over exact UTF-8 bytes", () => {
  const request = workerRequest({ surface_prompt: WORK_ITEM });
  assert.deepEqual(Object.keys(request.executor_profile_digest).sort(), ["algorithm", "canonicalization", "value"]);
  assert.equal(request.executor_profile_digest.algorithm, "sha256");
  assert.equal(request.executor_profile_digest.canonicalization, "cadp-jcs-1");
  assert.equal(request.executor_profile_digest.value, executorProfileDigest("WORKER", WORKER_PROVIDERS.codex).value);

  const byRole = new Map(request.input_digests.map((e) => [e.input_role, e.digest]));
  assert.equal(byRole.get("work-item")?.value, rawHex(WORK_ITEM), "the work-item entry is over the exact caller string's UTF-8 bytes");
  assert.equal(byRole.get("surface-prompt")?.value, rawHex(WORK_ITEM));
  assert.equal(byRole.get("workspace-revision")?.value, rawHex(BASE), "the revision entry is over its 40-character sha STRING");
  for (const entry of request.input_digests) {
    assert.deepEqual(Object.keys(entry).sort(), ["digest", "input_role"], "an entry is exactly {input_role, digest} — two keys, no more");
    assert.equal(entry.digest.canonicalization, "raw-bytes-1");
    assert.equal(typeof entry.digest.value, "string");
  }

  // `execution_request_digest` is typed too, and covers the COMPLETE object.
  const digest = executionRequestDigest(request);
  assert.equal(digest.algorithm, "sha256");
  assert.equal(digest.canonicalization, "cadp-jcs-1");
  assert.match(digest.value, /^[0-9a-f]{64}$/u);
  assert.equal(executionRequestDigest(workerRequest({ surface_prompt: WORK_ITEM })).value, digest.value, "the same request digests equal");
});

test("X3: the required input_roles appear exactly once each, in the mandated literal order", () => {
  assert.deepEqual(workerRequest().input_digests.map((e) => e.input_role), [...REQUIRED_INPUT_ROLES.WORKER]);
  assert.deepEqual(plannerRequest().input_digests.map((e) => e.input_role), [...REQUIRED_INPUT_ROLES.PLANNER]);
  assert.deepEqual(reviewerRequest("p").input_digests.map((e) => e.input_role), [...REQUIRED_INPUT_ROLES.REVIEWER]);
  // The reviewer mounts a fresh EMPTY review-ws, so it declares NO workspace-revision entry.
  assert.ok(!REQUIRED_INPUT_ROLES.REVIEWER.includes("workspace-revision"));
  // WORKER digests the work item, PLANNER the intent — the caller layer is role-specific.
  assert.ok(REQUIRED_INPUT_ROLES.WORKER.includes("work-item") && !REQUIRED_INPUT_ROLES.WORKER.includes("intent"));
  assert.ok(REQUIRED_INPUT_ROLES.PLANNER.includes("intent") && !REQUIRED_INPUT_ROLES.PLANNER.includes("work-item"));
});

// ------------------------------------------------------------------ X4/X5/X6 — the profile preimage

test("X4: executor_profile_payload.v1 is the resolved registry entry VERBATIM, absent optionals OMITTED", () => {
  // Every LIVE registry entry round-trips key-for-key and value-for-value over the role's PINNED key
  // set: nothing added, renamed, defaulted or re-typed. (The ops-side snapshot pins the per-provider
  // payloads themselves.)
  const live: ReadonlyArray<readonly [SurfaceRole, Record<string, unknown>]> = [
    ...Object.values(WORKER_PROVIDERS).map((p) => ["WORKER", p] as const),
    ...Object.values(REVIEW_PROVIDERS).map((p) => ["REVIEWER", p] as const),
    ...Object.values(PLAN_PROVIDERS).map((p) => ["PLANNER", p] as const),
  ];
  for (const [role, profile] of live) {
    const payload = executorProfilePayload(role, profile);
    const pinned = new Set([...EXECUTOR_PROFILE_KEYS[role].required, ...EXECUTOR_PROFILE_KEYS[role].optional]);
    const expected = Object.keys(profile).filter((key) => pinned.has(key));
    assert.deepEqual(Object.keys(payload).sort(), expected.sort(), `${role} payload keys must be the entry's own PINNED keys`);
    assert.deepEqual(
      payload,
      JSON.parse(JSON.stringify(Object.fromEntries(expected.map((key) => [key, profile[key]])))),
      `${role} payload must equal the entry verbatim over the pinned set`,
    );
  }

  // B1(1)'s key set is EXACT, so the payload carries no key outside it even when the implemented
  // interface has one. `ReviewProviderProfile.can_read_workspace` (#259 P0a, added after the TD
  // pinned its enumeration) is admitted on the live entry and kept OUT of the preimage: digesting it
  // would be a key outside the role's set, and refusing the entry would refuse every review. No
  // identity is lost — the flag is a function of `argv_template`, which IS in the preimage
  // (`conformance-reviewproviders.test.ts` §4.1 asserts the flag matches the measured argv).
  assert.ok(!Object.prototype.hasOwnProperty.call(REQUEST_KEYS, "can_read_workspace"));
  for (const role of ["WORKER", "REVIEWER", "PLANNER"] as const) {
    assert.ok(
      ![...EXECUTOR_PROFILE_KEYS[role].required, ...EXECUTOR_PROFILE_KEYS[role].optional].includes("can_read_workspace"),
      `${role}'s pinned key set must not carry can_read_workspace`,
    );
  }
  assert.deepEqual([...EXECUTOR_PROFILE_KEYS.REVIEWER.required].sort(), ["argv_template", "auth_method", "identity_class_product", "verdict_format"]);
  // PLANNER is exactly "the REVIEWER set less verdict_format".
  assert.deepEqual(
    [...EXECUTOR_PROFILE_KEYS.PLANNER.required, ...EXECUTOR_PROFILE_KEYS.PLANNER.optional].sort(),
    [...EXECUTOR_PROFILE_KEYS.REVIEWER.required, ...EXECUTOR_PROFILE_KEYS.REVIEWER.optional].filter((k) => k !== "verdict_format").sort(),
  );
  for (const [provider, profile] of Object.entries(REVIEW_PROVIDERS)) {
    const payload = executorProfilePayload("REVIEWER", profile);
    assert.ok(Object.prototype.hasOwnProperty.call(profile, "can_read_workspace"), `${provider} entry declares the flag`);
    assert.ok(!Object.prototype.hasOwnProperty.call(payload, "can_read_workspace"), `${provider} payload must not carry the flag`);
    // Flipping an EXCLUDED key cannot move the digest; flipping the argv it tracks must.
    const flipped = { ...profile, can_read_workspace: !profile.can_read_workspace };
    assert.equal(executorProfileDigest("REVIEWER", flipped).value, executorProfileDigest("REVIEWER", profile).value);
  }
  // The exclusion is NOT a general escape hatch: any other unpinned interface-looking key still fails.
  const strayReviewer = { ...REVIEW_PROVIDERS.codex, can_write_workspace: true };
  assert.throws(() => executorProfilePayload("REVIEWER", strayReviewer), (e) => malformedReason(e) === "UNKNOWN_PROFILE_KEY");
  // And the exclusion is per-role: the worker and planner interfaces never declared the flag, so it
  // is an unknown key there rather than an admitted one.
  for (const [role, profile] of [["WORKER", WORKER_PROVIDERS.codex], ["PLANNER", PLAN_PROVIDERS.codex]] as const) {
    assert.throws(
      () => executorProfilePayload(role, { ...profile, can_read_workspace: true }),
      (e) => malformedReason(e) === "UNKNOWN_PROFILE_KEY",
      `${role} must not admit can_read_workspace`,
    );
  }

  // OMITTED, never null-filled: the codex worker declares no auth_env / sessions_container_dir /
  // requested_effort, and the payload carries no such key at all.
  const codexWorker = executorProfilePayload("WORKER", WORKER_PROVIDERS.codex);
  for (const absent of ["auth_env", "sessions_container_dir", "requested_effort", "effort_argv"]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(codexWorker, absent), `${absent} must be omitted, not null-filled`);
  }
  // A present optional IS carried: the codex reviewer's measured effort pairing, value_prefix and all.
  const codexReviewer = executorProfilePayload("REVIEWER", REVIEW_PROVIDERS.codex);
  assert.equal(codexReviewer["requested_effort"], "high");
  assert.deepEqual(codexReviewer["effort_argv"], REVIEW_PROVIDERS.codex.effort_argv);

  // `auth_env.static_env` is THE ONE OPEN string → string map: its keys are provider data, copied
  // verbatim with none added or dropped.
  const claudeWorker = executorProfilePayload("WORKER", WORKER_PROVIDERS.claude);
  assert.deepEqual(claudeWorker["auth_env"], { env_var: "CLAUDE_CODE_OAUTH_TOKEN", static_env: { IS_SANDBOX: "1" } });
  const widened = clone(WORKER_PROVIDERS.claude) as { auth_env: { static_env: Record<string, string> } };
  widened.auth_env.static_env["CADP_EXTRA"] = "1";
  assert.notEqual(
    executorProfileDigest("WORKER", widened).value,
    executorProfileDigest("WORKER", WORKER_PROVIDERS.claude).value,
    "an added static_env key is provider DATA and must change the digest",
  );

  // A key outside the role's set makes the request malformed — including a key that is legitimate
  // for ANOTHER role (`verdict_format` is the reviewer's, never the planner's).
  const strayPlanner = { ...PLAN_PROVIDERS.codex, verdict_format: "first-line" };
  assert.throws(() => executorProfilePayload("PLANNER", strayPlanner), (e) => malformedReason(e) === "UNKNOWN_PROFILE_KEY");
  const strayWorker = { ...WORKER_PROVIDERS.codex, cadp_note: "hello" };
  assert.throws(() => executorProfilePayload("WORKER", strayWorker), (e) => malformedReason(e) === "UNKNOWN_PROFILE_KEY");
  const { identity_class_product: _dropped, ...missing } = WORKER_PROVIDERS.codex;
  assert.throws(() => executorProfilePayload("WORKER", missing), (e) => malformedReason(e) === "MISSING_PROFILE_KEY");
});

test("X5: every NESTED level is closed too, and auth_method is closed PER VARIANT", () => {
  const worker = (auth_env: unknown): unknown => ({ ...WORKER_PROVIDERS.claude, auth_env });
  const reviewer = (over: Record<string, unknown>): unknown => ({ ...REVIEW_PROVIDERS.codex, ...over });

  const cases: ReadonlyArray<readonly [string, SurfaceRole, unknown, string]> = [
    ["auth_env with an extra key", "WORKER", worker({ env_var: "T", static_env: {}, token: "leaked" }), "UNKNOWN_PROFILE_KEY"],
    ["auth_env missing static_env", "WORKER", worker({ env_var: "T" }), "MISSING_PROFILE_KEY"],
    ["auth_env.static_env with a non-string value", "WORKER", worker({ env_var: "T", static_env: { A: 1 } }), "MALFORMED_PROFILE_VALUE"],
    ["model_scan with an extra key", "WORKER", { ...WORKER_PROVIDERS.codex, model_scan: { session_regex: "a", stdout_regex: "b", file_regex: "c" } }, "UNKNOWN_PROFILE_KEY"],
    ["effort_scan missing stdout_regex", "WORKER", { ...WORKER_PROVIDERS.codex, effort_scan: { session_regex: "a" } }, "MISSING_PROFILE_KEY"],
    ["effort_argv with an extra key", "REVIEWER", reviewer({ effort_argv: { flag: "-c", value_placement: "separate", allowed_values: ["high"], note: "x" } }), "UNKNOWN_PROFILE_KEY"],
    ["effort_argv with an unmeasured placement", "REVIEWER", reviewer({ effort_argv: { flag: "-c", value_placement: "inline", allowed_values: ["high"] } }), "MALFORMED_PROFILE_VALUE"],
    ["auth_method oauth_env carrying the OTHER variant's key", "REVIEWER", reviewer({ auth_method: { kind: "oauth_env", env_var: "T", auth_subdir: ".codex" } }), "UNKNOWN_PROFILE_KEY"],
    ["auth_method auth_files carrying the OTHER variant's key", "REVIEWER", reviewer({ auth_method: { kind: "auth_files", auth_subdir: ".codex", auth_files: ["auth.json"], env_var: "T" } }), "UNKNOWN_PROFILE_KEY"],
    ["auth_method with no kind", "REVIEWER", reviewer({ auth_method: { env_var: "T" } }), "MALFORMED_PROFILE_VALUE"],
    ["auth_method with an unknown kind", "REVIEWER", reviewer({ auth_method: { kind: "keychain", env_var: "T" } }), "MALFORMED_PROFILE_VALUE"],
  ];
  for (const [label, role, profile, reason] of cases) {
    assert.throws(() => executorProfileDigest(role, profile), (e) => malformedReason(e) === reason, label);
  }

  // "not even as undefined": a key carried with an undefined value is still a key. `jcs` skips
  // undefined, so letting it through would admit an unclosed object at an identical digest.
  const undefinedKey = { ...REVIEW_PROVIDERS.claude, auth_method: { kind: "oauth_env", env_var: "T", auth_files: undefined } };
  assert.throws(() => executorProfileDigest("REVIEWER", undefinedKey), (e) => malformedReason(e) === "UNKNOWN_PROFILE_KEY");

  // `effort_argv.value_prefix` is optional and OMITTED when absent — a profile without it is valid
  // and digests differently from one carrying an empty-ish prefix.
  const noPrefix = reviewer({ effort_argv: { flag: "--effort", value_placement: "separate", allowed_values: ["high"] } });
  const payload = executorProfilePayload("REVIEWER", noPrefix);
  assert.ok(!Object.prototype.hasOwnProperty.call(payload["effort_argv"], "value_prefix"));
});

test("X6: ARRAY ORDER is load-bearing; object-key declaration order is not", () => {
  const baseline = executorProfileDigest("WORKER", WORKER_PROVIDERS.codex).value;

  const reorderedArgv = { ...WORKER_PROVIDERS.codex, argv_template: [...WORKER_PROVIDERS.codex.argv_template].reverse() };
  assert.notEqual(executorProfileDigest("WORKER", reorderedArgv).value, baseline, "argv_template order is the argv identity of §17.1");

  const reorderedAuthFiles = { ...REVIEW_PROVIDERS.codex, auth_method: { kind: "auth_files", auth_subdir: ".codex", auth_files: ["b.json", "a.json"] } };
  const straightAuthFiles = { ...REVIEW_PROVIDERS.codex, auth_method: { kind: "auth_files", auth_subdir: ".codex", auth_files: ["a.json", "b.json"] } };
  assert.notEqual(executorProfileDigest("REVIEWER", reorderedAuthFiles).value, executorProfileDigest("REVIEWER", straightAuthFiles).value);

  const allowedA = { ...REVIEW_PROVIDERS.codex, effort_argv: { flag: "-c", value_placement: "separate", allowed_values: ["high", "low"] } };
  const allowedB = { ...REVIEW_PROVIDERS.codex, effort_argv: { flag: "-c", value_placement: "separate", allowed_values: ["low", "high"] } };
  assert.notEqual(executorProfileDigest("REVIEWER", allowedA).value, executorProfileDigest("REVIEWER", allowedB).value);

  // RFC 8785 sorts OBJECT keys, so a profile declared in a different key order is the same object.
  const entries = Object.entries(WORKER_PROVIDERS.codex).reverse();
  assert.equal(executorProfileDigest("WORKER", Object.fromEntries(entries)).value, baseline, "declaration order must not move the digest");

  // And the profile preimage is load-bearing for the REQUEST digest, not just for its own field.
  const viaGrok = buildExecutionRequest({
    surface_role: "WORKER",
    provider: "codex",
    profile: reorderedArgv as typeof WORKER_PROVIDERS.codex,
    repo_id: REPO,
    base_revision: BASE,
    work_item: WORK_ITEM,
    surface_prompt: WORK_ITEM,
  });
  assert.notEqual(executionRequestDigest(viaGrok).value, executionRequestDigest(workerRequest()).value);
});

// ------------------------------------------------------------------ X7 — EP-C1 surface-input drift

test("X7 (EP-C1 surface-input-drift): byte-identical PREPARATORY arguments, drifted surface bytes, different request digest", () => {
  // One set of caller-to-broker arguments, unchanged across both runs: the same repo, the same
  // candidate_sha, the same work_item, the same provider. Only the broker-BUILT prompt differs.
  const diffAtForkBaseA = "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n";
  // ORIGIN/MAIN MOVED UNDER THE MERGE-BASE: the same candidate now diffs against a later fork
  // point, so the cumulative patch — and therefore the reviewer's prompt — is different bytes.
  const diffAtForkBaseB = `${diffAtForkBaseA}diff --git a/y.ts b/y.ts\n@@ -1 +1 @@\n-const b = 1;\n+const b = 2;\n`;

  const promptA = buildReviewPrompt("codex", CANDIDATE, WORK_ITEM, diffAtForkBaseA);
  const promptB = buildReviewPrompt("codex", CANDIDATE, WORK_ITEM, diffAtForkBaseB);
  assert.notEqual(promptA, promptB, "pre-condition: the built prompts differ");

  const requestA = reviewerRequest(promptA);
  const requestB = reviewerRequest(promptB);

  // The CALLER layer is byte-identical between the two — which is exactly why a caller-inputs-only
  // digest could not tell them apart.
  const callerEntry = (request: ExecutionRequestV1): string => request.input_digests.find((e) => e.input_role === "work-item")!.digest.value;
  assert.equal(callerEntry(requestA), callerEntry(requestB));
  assert.equal(requestA.executor_profile_digest.value, requestB.executor_profile_digest.value);
  assert.equal((requestA as { candidate_revision: string }).candidate_revision, (requestB as { candidate_revision: string }).candidate_revision);

  // The SURFACE layer is not, so the requests are two distinct requests.
  const surfaceEntry = (request: ExecutionRequestV1): string => request.input_digests.find((e) => e.input_role === "surface-prompt")!.digest.value;
  assert.notEqual(surfaceEntry(requestA), surfaceEntry(requestB));
  assert.notEqual(
    executionRequestDigest(requestA).value,
    executionRequestDigest(requestB).value,
    "two executions the caller cannot tell apart are two distinct requests when the surfaces saw different bytes",
  );

  // A PROMPT-TEMPLATE edit under a byte-identical diff drifts the digest the same way.
  const templateEdited = reviewerRequest(`${promptA}\nReply in English.`);
  assert.notEqual(executionRequestDigest(templateEdited).value, executionRequestDigest(requestA).value);

  // The same drift on the worker/planner side: the work item is unchanged, the prompt is not.
  assert.notEqual(
    executionRequestDigest(workerRequest({ surface_prompt: `${WORK_ITEM} (re-wrapped)` })).value,
    executionRequestDigest(workerRequest({ surface_prompt: WORK_ITEM })).value,
  );
  // And a moved workspace revision drifts it too, since the surface reads a different tree.
  assert.notEqual(executionRequestDigest(workerRequest({ base_revision: "3".repeat(40) })).value, executionRequestDigest(workerRequest()).value);
});

// ------------------------------------------------------------------ X8 — EP-C1 malformed request

/** The malformed shapes B1(1e) enumerates, each with the closure it violates. */
const MALFORMED: ReadonlyArray<readonly [string, unknown, string]> = (() => {
  const worker = workerRequest();
  const reviewer = reviewerRequest("a built reviewer prompt");
  const planner = plannerRequest();
  const mutate = (request: ExecutionRequestV1, apply: (copy: Record<string, unknown>) => void): unknown => {
    const copy = clone(request) as unknown as Record<string, unknown>;
    apply(copy);
    return copy;
  };
  const entries = (request: ExecutionRequestV1): Record<string, unknown>[] =>
    clone(request.input_digests) as unknown as Record<string, unknown>[];

  return [
    // --- unknown key at every closed level
    ["an unknown TOP-LEVEL key", mutate(worker, (c) => { c["run_id"] = "r-1"; }), "UNKNOWN_TOP_LEVEL_KEY"],
    ["an unknown key inside an input_digests ENTRY", mutate(worker, (c) => {
      const list = entries(worker);
      list[0] = { ...list[0]!, locator: "broker-response#work_item" };
      c["input_digests"] = list;
    }), "UNKNOWN_INPUT_ENTRY_KEY"],
    ["an input_digests entry missing its digest", mutate(worker, (c) => {
      const list = entries(worker);
      list[1] = { input_role: "surface-prompt" };
      c["input_digests"] = list;
    }), "MISSING_INPUT_ENTRY_KEY"],

    // --- unknown / duplicate / missing input_role
    ["an UNKNOWN input_role outside the closed set", mutate(worker, (c) => {
      const list = entries(worker);
      list[2] = { ...list[2]!, input_role: "workspace-tree" };
      c["input_digests"] = list;
    }), "UNKNOWN_INPUT_ROLE"],
    ["an input_role the ROLE does not declare (a reviewer workspace-revision)", mutate(reviewer, (c) => {
      c["input_digests"] = [...entries(reviewer), { input_role: "workspace-revision", digest: worker.input_digests[2]!.digest }];
    }), "UNKNOWN_INPUT_ROLE"],
    ["a DUPLICATE input_role", mutate(worker, (c) => {
      const list = entries(worker);
      c["input_digests"] = [list[0]!, list[1]!, { ...list[1]! }, list[2]!];
    }), "DUPLICATE_INPUT_ROLE"],
    ["a MISSING required input_role", mutate(planner, (c) => {
      c["input_digests"] = entries(planner).filter((e) => e["input_role"] !== "intent");
    }), "MISSING_INPUT_ROLE"],
    ["the required input_roles out of their mandated order", mutate(worker, (c) => {
      c["input_digests"] = [...entries(worker)].reverse();
    }), "INPUT_ROLE_ORDER"],
    ["input_digests that is not a list at all", mutate(worker, (c) => { c["input_digests"] = { "work-item": "x" }; }), "INPUT_DIGESTS_NOT_A_LIST"],

    // --- wrong role / wrong revision shape
    ["a REVIEWER carrying base_revision", mutate(reviewer, (c) => { c["base_revision"] = BASE; }), "WRONG_ROLE_SHAPE"],
    ["a WORKER carrying candidate_revision", mutate(worker, (c) => { c["candidate_revision"] = CANDIDATE; }), "WRONG_ROLE_SHAPE"],
    ["a WORKER with no revision key at all", mutate(worker, (c) => { delete c["base_revision"]; }), "MISSING_TOP_LEVEL_KEY"],
    ["a revision that is not a 40-character sha", mutate(worker, (c) => { c["base_revision"] = "HEAD"; }), "MALFORMED_REVISION"],
    ["a workspace-revision entry disagreeing with the declared revision", mutate(worker, (c) => {
      const list = entries(worker);
      list[2] = { ...list[2]!, digest: reviewer.input_digests[1]!.digest };
      c["input_digests"] = list;
    }), "WORKSPACE_REVISION_MISMATCH"],
    ["an unknown surface_role", mutate(worker, (c) => { c["surface_role"] = "VERIFIER"; }), "UNKNOWN_SURFACE_ROLE"],
    ["a provider no resolver admits", mutate(worker, (c) => { c["provider"] = "gpt-cli"; }), "UNKNOWN_PROVIDER"],
    ["a provider from ANOTHER role's registry is still checked against this role's", mutate(worker, (c) => { c["provider"] = "unknown-worker"; }), "UNKNOWN_PROVIDER"],
    ["the wrong schema string", mutate(worker, (c) => { c["schema"] = "cadp.execution-request.v2"; }), "WRONG_SCHEMA"],
    ["an empty repo_id", mutate(worker, (c) => { c["repo_id"] = ""; }), "MALFORMED_REPO_ID"],

    // --- malformed TYPED digests
    ["executor_profile_digest as a BARE HEX STRING", mutate(worker, (c) => { c["executor_profile_digest"] = worker.executor_profile_digest.value; }), "MALFORMED_DIGEST"],
    ["executor_profile_digest under the wrong canonicalization", mutate(worker, (c) => {
      c["executor_profile_digest"] = { ...worker.executor_profile_digest, canonicalization: "raw-bytes-1" };
    }), "MALFORMED_DIGEST"],
    ["an input digest as a bare hex string", mutate(worker, (c) => {
      const list = entries(worker);
      list[0] = { ...list[0]!, digest: worker.input_digests[0]!.digest.value };
      c["input_digests"] = list;
    }), "MALFORMED_DIGEST"],
    ["an input digest under the wrong canonicalization", mutate(worker, (c) => {
      const list = entries(worker);
      list[0] = { ...list[0]!, digest: { ...worker.input_digests[0]!.digest, canonicalization: "cadp-jcs-1" } };
      c["input_digests"] = list;
    }), "MALFORMED_DIGEST"],
    ["an input digest whose value is not sha256 hex", mutate(worker, (c) => {
      const list = entries(worker);
      list[0] = { ...list[0]!, digest: { algorithm: "sha256", canonicalization: "raw-bytes-1", value: "not-hex" } };
      c["input_digests"] = list;
    }), "MALFORMED_DIGEST"],
    ["a digest carrying an extra key", mutate(worker, (c) => {
      c["executor_profile_digest"] = { ...worker.executor_profile_digest, note: "x" };
    }), "MALFORMED_DIGEST"],

    // --- not an object at all
    ["a request that is not an object", null, "REQUEST_NOT_AN_OBJECT"],
    ["a request that is an array", [], "REQUEST_NOT_AN_OBJECT"],
  ] as const;
})();

test("X8 (EP-C1 malformed-request): every malformed shape is refused, and NOTHING is executed", async () => {
  for (const [label, request, reason] of MALFORMED) {
    // The refusal happens at validation, which is what the digest function runs FIRST — so no
    // request digest is ever computed for a malformed request.
    assert.throws(() => assertExecutionRequestWellFormed(request), (e) => malformedReason(e) === reason, label);
    assert.throws(() => executionRequestDigest(request), (e) => malformedReason(e) === reason, `${label} (no digest computed)`);

    // NO SURFACE, NO ATTEMPT, NO ENVELOPE. The starter mints the attempt identity exactly as
    // `runBoundedSurface` does (`cadp-surface-<kind>-<randomUUID()>`, minted BEFORE the container is
    // created) and the sealer downstream builds an envelope from whatever it captures. A refused
    // request must leave all three counters at zero.
    const attempts: string[] = [];
    const surfaces: string[] = [];
    const envelopes: unknown[] = [];
    await assert.rejects(
      startSurfaceUnderRequest(
        () => request,
        async () => {
          const container = `cadp-surface-worker-${randomUUID()}`;
          attempts.push(container);
          surfaces.push(container);
          const captured = { container, stdout: "APPROVE" };
          envelopes.push(captured);
          return captured;
        },
      ),
      (e: unknown) => malformedReason(e) === reason,
      label,
    );
    assert.deepEqual(attempts, [], `${label}: no attempt identity was minted`);
    assert.deepEqual(surfaces, [], `${label}: no surface was created`);
    assert.deepEqual(envelopes, [], `${label}: nothing was captured, so nothing could be sealed`);
  }
});

test("X8b: a WELL-FORMED request starts the surface, and the digest is available before it does", async () => {
  const order: string[] = [];
  const prepared = await startSurfaceUnderRequest(
    () => {
      order.push("build");
      return workerRequest();
    },
    async () => {
      order.push("start");
      return { container: `cadp-surface-worker-${randomUUID()}` };
    },
  );
  assert.deepEqual(order, ["build", "start"], "the request is built and digested strictly before the surface starts");
  assert.equal(prepared.execution_request_digest.canonicalization, "cadp-jcs-1");
  assert.equal(prepared.execution_request_digest.value, executionRequestDigest(workerRequest()).value);
  assert.equal(prepared.request.surface_role, "WORKER");
  assert.match(prepared.run.container, /^cadp-surface-worker-/u);
});

// ------------------------------------------------------------------ X9 — the broker integration

test("X9: every broker surface start runs through the execution-request gate", () => {
  const source = readFileSync(fileURLToPath(new URL("../../product/surfaceBroker.ts", import.meta.url)), "utf8");
  const gates = [...source.matchAll(/startSurfaceUnderRequest\(/gu)];
  assert.equal(gates.length, 3, "brokerImplement, brokerReview and brokerPlan each construct one request");
  assert.equal([...source.matchAll(/buildExecutionRequest\(\{/gu)].length, 3);

  // Source order: no `runWorker(config()` / `runReviewer(config()` call appears before the gate that
  // must precede it. A start hoisted out of the gate — and therefore out of the refusal — fails here.
  const starts = [...source.matchAll(/run(?:Worker|Reviewer)\(config\(\)/gu)].map((m) => m.index);
  assert.equal(starts.length, 3, "the broker starts exactly three model surfaces");
  const gateIndexes = gates.map((m) => m.index);
  for (const [i, start] of starts.entries()) {
    assert.ok(gateIndexes[i]! < start!, `surface start #${i + 1} is not preceded by its execution-request gate`);
  }
  // `runVerifier` is deliberately NOT gated: the local verifier is not a model surface and B1(1)
  // names no request for it.
  assert.ok(source.includes("runVerifier(config()"));
});
