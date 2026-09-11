/**
 * `cadp.execution-request.v1` — the BROKER-to-SURFACE execution contract
 * (TECHNICAL_DESIGN_cadp_v0_5_execution_plane.md B1(1), pinned exactly by B1(1e)).
 *
 * WHEN THIS OBJECT EXISTS. Not the caller-to-broker body. The `brokerImplement` /
 * `brokerReview` / `brokerPlan` arguments are the distinct PREPARATORY REQUEST and are left
 * untouched by this module. `ExecutionRequestV1` is constructed by the broker AFTER preparation
 * completes — the profile resolved, the workspace materialized, the final prompt bytes built — and
 * IMMEDIATELY BEFORE the surface starts, which is the only moment at which every input it names is
 * already in the broker's hands and nothing has executed yet. That ordering is what makes the
 * request digest cover exactly what the surface will see, and it is enforced mechanically here by
 * `startSurfaceUnderRequest`: the surface starter is a thunk this module invokes only after the
 * whole request has been constructed, closed-key validated and digested.
 *
 * WHY THE SURFACE-PROMPT LAYER EXISTS. The caller's inputs are NOT the surface's inputs. The
 * reviewer prompt does not exist until the broker has cloned, run `git merge-base origin/main
 * <candidate_sha>`, built a `git diff --stat --patch` and wrapped it in its own instruction text;
 * the planner prompt is `buildPlanPrompt(...)`. Byte-identical caller arguments therefore yield
 * different surface bytes when `origin/main` moves under the merge-base, when the diff crosses the
 * truncation bound, or when prompt-building code changes — so a caller-inputs-only digest is not
 * the EXACT input digest the contract requires. `input_digests` accordingly carries both layers,
 * and `execution_request_digest` changes whenever the surface-visible bytes change.
 *
 * WHAT IS DELIBERATELY NOT HERE. B1(2)/(2a) — `ExecutionResult`, `output_artifact_subject` and the
 * `execution-output` subject binding — is a separate contract; this module mints no subject, seals
 * nothing, and holds no Kernel token. `execution_request_digest` is computed and returned because
 * B1(1e) requires it; the (2a) `object_id` prefix that will consume its `.value` is future work.
 */

import { isDigestShape, jcsDigest, rawDigest } from "../kernel/canonical.ts";
import type { Digest } from "../kernel/canonical.ts";
import { WORKER_PROVIDERS } from "./workerProviders.ts";
import type { WorkerProvider, WorkerProviderProfile } from "./workerProviders.ts";
import { REVIEW_PROVIDERS } from "./reviewProviders.ts";
import type { ReviewProvider, ReviewProviderProfile } from "./reviewProviders.ts";
import { PLAN_PROVIDERS } from "./planProviders.ts";
import type { PlanProvider, PlanProviderProfile } from "./planProviders.ts";

/** B1(1e): `schema` is this literal string, for every role. */
export const EXECUTION_REQUEST_SCHEMA = "cadp.execution-request.v1";

/** The §19.5 surface-role vocabulary, unchanged. */
export type SurfaceRole = "WORKER" | "REVIEWER" | "PLANNER";

/** B1(1): the CLOSED `input_role` literal set, in the literal order entries must appear in. */
export const INPUT_ROLES = ["work-item", "intent", "surface-prompt", "workspace-revision"] as const;
export type InputRole = (typeof INPUT_ROLES)[number];

/** B1(1e): one `input_digests` entry — exactly two keys, the digest always TYPED. */
export interface ExecutionInputDigestV1 {
  readonly input_role: InputRole;
  readonly digest: Digest;
}

/** B1(1e): the WORKER and PLANNER key set — identical keys, different required `input_role`s. */
export interface BaseRevisionExecutionRequestV1 {
  readonly schema: typeof EXECUTION_REQUEST_SCHEMA;
  readonly surface_role: "WORKER" | "PLANNER";
  readonly provider: string;
  readonly executor_profile_digest: Digest;
  readonly repo_id: string;
  readonly base_revision: string;
  readonly input_digests: readonly ExecutionInputDigestV1[];
}

/** B1(1e): the REVIEWER key set — carrying NO `base_revision` key at all, not a null or empty one. */
export interface CandidateRevisionExecutionRequestV1 {
  readonly schema: typeof EXECUTION_REQUEST_SCHEMA;
  readonly surface_role: "REVIEWER";
  readonly provider: string;
  readonly executor_profile_digest: Digest;
  readonly repo_id: string;
  readonly candidate_revision: string;
  readonly input_digests: readonly ExecutionInputDigestV1[];
}

export type ExecutionRequestV1 = BaseRevisionExecutionRequestV1 | CandidateRevisionExecutionRequestV1;

/**
 * B1(1e) MALFORMED ⇒ BROKER REFUSAL, NOTHING EXECUTED. Carries a stable `reason` so a control can
 * assert WHICH closure was violated rather than matching prose.
 */
export class ExecutionRequestMalformed extends Error {
  readonly reason: string;

  constructor(reason: string, detail: string) {
    super(`malformed ${EXECUTION_REQUEST_SCHEMA}: ${reason} — ${detail}`);
    this.name = "ExecutionRequestMalformed";
    this.reason = reason;
  }
}

// ------------------------------------------------------------------ closed key sets

/** B1(1e): the EXACT closed top-level key set of each role's request object. */
export const REQUEST_KEYS: Readonly<Record<SurfaceRole, readonly string[]>> = {
  WORKER: ["schema", "surface_role", "provider", "executor_profile_digest", "repo_id", "base_revision", "input_digests"],
  PLANNER: ["schema", "surface_role", "provider", "executor_profile_digest", "repo_id", "base_revision", "input_digests"],
  REVIEWER: ["schema", "surface_role", "provider", "executor_profile_digest", "repo_id", "candidate_revision", "input_digests"],
};

/** The revision key each role declares; the other role's revision key is a WRONG_ROLE_SHAPE. */
const REVISION_KEY: Readonly<Record<SurfaceRole, "base_revision" | "candidate_revision">> = {
  WORKER: "base_revision",
  PLANNER: "base_revision",
  REVIEWER: "candidate_revision",
};

/** B1(1e): the required `input_role`s per role, each present EXACTLY ONCE, in this order. */
export const REQUIRED_INPUT_ROLES: Readonly<Record<SurfaceRole, readonly InputRole[]>> = {
  WORKER: ["work-item", "surface-prompt", "workspace-revision"],
  PLANNER: ["intent", "surface-prompt", "workspace-revision"],
  // The reviewer mounts a fresh EMPTY `review-ws` and keeps its candidate checkout broker-host-side
  // purely for diff construction, so it declares no `workspace-revision` entry.
  REVIEWER: ["work-item", "surface-prompt"],
};

/**
 * B1(1): `executor_profile_payload.v1` IS THE RESOLVED REGISTRY ENTRY VERBATIM, under a closed key
 * set which is "exactly the role's implemented profile interface".
 *
 * DRIFT NOTE, stated rather than absorbed. The TD enumerates that interface as of 2026-09-08. The
 * REVIEWER interface has since gained one key — `can_read_workspace` (#259 P0a, 2026-09-10), the
 * measured per-profile capability that scopes the reviewer's mount instruction. The TD's own
 * warrant for its enumeration is the implemented interface it cites (`ReviewProviderProfile`,
 * `reviewProviders.ts`), and the alternative reading — hold the 2026-09-08 list literally — would
 * make EVERY live reviewer profile malformed and refuse every review, which is precisely the
 * "nothing added, renamed, defaulted or re-typed" rule inverted into dropping a key that IS part of
 * the entry. The key set below therefore tracks the interface, and the ops-side payload snapshot
 * (`cadp/tests/ops/conformance-executorprofile.test.ts`) fails loudly on the next such drift
 * instead of letting a new profile key silently widen or silently break the closure.
 *
 * PLANNER remains "the REVIEWER set less `verdict_format`" — and less `can_read_workspace`, which
 * `PlanProviderProfile` does not declare either.
 */
export const EXECUTOR_PROFILE_KEYS: Readonly<
  Record<SurfaceRole, { readonly required: readonly string[]; readonly optional: readonly string[] }>
> = {
  WORKER: {
    required: ["argv_template", "auth_files", "auth_subdir", "sessions_subdir", "identity_class_product"],
    optional: ["auth_env", "sessions_container_dir", "model_scan", "requested_effort", "effort_argv", "effort_scan"],
  },
  REVIEWER: {
    required: ["argv_template", "auth_method", "can_read_workspace", "identity_class_product", "verdict_format"],
    optional: ["sessions_subdir", "sessions_container_dir", "model_scan", "requested_effort", "effort_argv", "effort_scan"],
  },
  PLANNER: {
    required: ["argv_template", "auth_method", "identity_class_product"],
    optional: ["sessions_subdir", "sessions_container_dir", "model_scan", "requested_effort", "effort_argv", "effort_scan"],
  },
};

/** The closed provider name set each role's resolver admits. An unknown name never reaches here. */
const PROVIDER_NAMES: Readonly<Record<SurfaceRole, readonly string[]>> = {
  WORKER: Object.keys(WORKER_PROVIDERS),
  REVIEWER: Object.keys(REVIEW_PROVIDERS),
  PLANNER: Object.keys(PLAN_PROVIDERS),
};

// ------------------------------------------------------------------ small shape helpers

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Closed-key enforcement at one level. A key PRESENT WITH AN UNDEFINED VALUE counts as present:
 * B1(1) forbids carrying the other variant's key "not even as undefined", and `jcs` skipping
 * `undefined` would otherwise let such a key pass unseen into an equal digest.
 */
function assertClosedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  where: string,
  unknownReason: string,
  missingReason: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ExecutionRequestMalformed(unknownReason, `${where} carries unknown key "${key}"`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
      throw new ExecutionRequestMalformed(missingReason, `${where} is missing required key "${key}"`);
    }
  }
}

function assertNonEmptyString(value: unknown, where: string, reason: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ExecutionRequestMalformed(reason, `${where} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

function assertStringArray(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ExecutionRequestMalformed("MALFORMED_PROFILE_VALUE", `${where} must be an array of strings`);
  }
  return value as readonly string[];
}

const REVISION_RE = /^[0-9a-f]{40}$/u;

/** Every digested entry is over the UTF-8 raw bytes of the exact string handed over. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function assertTypedDigest(value: unknown, canonicalization: Digest["canonicalization"], where: string): Digest {
  if (!isDigestShape(value)) {
    throw new ExecutionRequestMalformed("MALFORMED_DIGEST", `${where} must be a typed Digest {algorithm, canonicalization, value}`);
  }
  if (Object.keys(value as object).length !== 3) {
    throw new ExecutionRequestMalformed("MALFORMED_DIGEST", `${where} carries a key outside {algorithm, canonicalization, value}`);
  }
  if (value.canonicalization !== canonicalization) {
    throw new ExecutionRequestMalformed(
      "MALFORMED_DIGEST",
      `${where} must be canonicalized ${canonicalization} (got ${value.canonicalization})`,
    );
  }
  return value;
}

// ------------------------------------------------------------------ executor_profile_payload.v1

/**
 * The resolved registry entry copied VERBATIM under its role's closed key set: nothing added,
 * renamed, defaulted or re-typed, absent optionals OMITTED (never null-filled), and array order —
 * `argv_template`, `auth_files`, `effort_argv.allowed_values` — retained, because it is load-bearing
 * argv identity. RFC 8785 sorts object keys, so declaration order is irrelevant everywhere else.
 *
 * DESCRIPTORS ONLY: `auth_files` / `auth_subdir` / `auth_env.env_var` / `auth_method` name WHERE
 * auth comes from, so no credential is ever in the preimage.
 */
export function executorProfilePayload(role: SurfaceRole, profile: unknown): Record<string, unknown> {
  if (!isPlainObject(profile)) {
    throw new ExecutionRequestMalformed("MALFORMED_PROFILE_VALUE", `executor_profile_payload.v1 (${role}) must be an object`);
  }
  const keys = EXECUTOR_PROFILE_KEYS[role];
  assertClosedKeys(profile, keys.required, keys.optional, `executor_profile_payload.v1 (${role})`, "UNKNOWN_PROFILE_KEY", "MISSING_PROFILE_KEY");

  const payload: Record<string, unknown> = {};
  const carry = (key: string, validate: (value: unknown, where: string) => unknown): void => {
    if (!Object.prototype.hasOwnProperty.call(profile, key)) return;
    payload[key] = validate(profile[key], `executor_profile_payload.v1 (${role}).${key}`);
  };

  carry("argv_template", (v, w) => [...assertStringArray(v, w)]);
  carry("auth_files", (v, w) => [...assertStringArray(v, w)]);
  carry("auth_subdir", (v, w) => assertNonEmptyString(v, w, "MALFORMED_PROFILE_VALUE"));
  carry("auth_env", (v, w) => closedAuthEnv(v, w));
  carry("auth_method", (v, w) => closedAuthMethod(v, w));
  carry("can_read_workspace", (v, w) => {
    if (typeof v !== "boolean") throw new ExecutionRequestMalformed("MALFORMED_PROFILE_VALUE", `${w} must be a boolean`);
    return v;
  });
  carry("sessions_subdir", (v, w) => assertNonEmptyString(v, w, "MALFORMED_PROFILE_VALUE"));
  carry("sessions_container_dir", (v, w) => assertNonEmptyString(v, w, "MALFORMED_PROFILE_VALUE"));
  carry("identity_class_product", (v, w) => assertNonEmptyString(v, w, "MALFORMED_PROFILE_VALUE"));
  carry("model_scan", (v, w) => closedScan(v, w));
  carry("requested_effort", (v, w) => assertNonEmptyString(v, w, "MALFORMED_PROFILE_VALUE"));
  carry("effort_argv", (v, w) => closedEffortArgv(v, w));
  carry("effort_scan", (v, w) => closedScan(v, w));
  carry("verdict_format", (v, w) => assertNonEmptyString(v, w, "MALFORMED_PROFILE_VALUE"));
  return payload;
}

/** `auth_env` = exactly `{ env_var, static_env }`. */
function closedAuthEnv(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ExecutionRequestMalformed("MALFORMED_PROFILE_VALUE", `${where} must be an object`);
  assertClosedKeys(value, ["env_var", "static_env"], [], where, "UNKNOWN_PROFILE_KEY", "MISSING_PROFILE_KEY");
  const static_env = value["static_env"];
  if (!isPlainObject(static_env) || Object.values(static_env).some((entry) => typeof entry !== "string")) {
    throw new ExecutionRequestMalformed("MALFORMED_PROFILE_VALUE", `${where}.static_env must be a string → string map`);
  }
  return {
    env_var: assertNonEmptyString(value["env_var"], `${where}.env_var`, "MALFORMED_PROFILE_VALUE"),
    // THE ONE DELIBERATE EXCEPTION: an OPEN `string → string` map whose keys are provider data
    // rather than schema. Copied verbatim with no key added or dropped; RFC 8785 sorts those keys
    // like any other.
    static_env: { ...static_env },
  };
}

/** `model_scan` / `effort_scan` = exactly `{ session_regex, stdout_regex }`. */
function closedScan(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ExecutionRequestMalformed("MALFORMED_PROFILE_VALUE", `${where} must be an object`);
  assertClosedKeys(value, ["session_regex", "stdout_regex"], [], where, "UNKNOWN_PROFILE_KEY", "MISSING_PROFILE_KEY");
  return {
    session_regex: assertNonEmptyString(value["session_regex"], `${where}.session_regex`, "MALFORMED_PROFILE_VALUE"),
    stdout_regex: assertNonEmptyString(value["stdout_regex"], `${where}.stdout_regex`, "MALFORMED_PROFILE_VALUE"),
  };
}

/** `effort_argv` = exactly `{ flag, value_placement, value_prefix?, allowed_values }`. */
function closedEffortArgv(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ExecutionRequestMalformed("MALFORMED_PROFILE_VALUE", `${where} must be an object`);
  assertClosedKeys(value, ["flag", "value_placement", "allowed_values"], ["value_prefix"], where, "UNKNOWN_PROFILE_KEY", "MISSING_PROFILE_KEY");
  const placement = value["value_placement"];
  if (placement !== "separate" && placement !== "equals") {
    throw new ExecutionRequestMalformed("MALFORMED_PROFILE_VALUE", `${where}.value_placement must be "separate" or "equals"`);
  }
  return {
    flag: assertNonEmptyString(value["flag"], `${where}.flag`, "MALFORMED_PROFILE_VALUE"),
    value_placement: placement,
    // OMITTED when absent, never null-filled.
    ...(Object.prototype.hasOwnProperty.call(value, "value_prefix")
      ? { value_prefix: assertNonEmptyString(value["value_prefix"], `${where}.value_prefix`, "MALFORMED_PROFILE_VALUE") }
      : {}),
    allowed_values: [...assertStringArray(value["allowed_values"], `${where}.allowed_values`)],
  };
}

/**
 * `auth_method` is a discriminated union CLOSED PER VARIANT — either exactly
 * `{ kind: "oauth_env", env_var }` or exactly `{ kind: "auth_files", auth_subdir, auth_files }`,
 * `kind` always present and no key of the other variant carried, not even as undefined.
 */
function closedAuthMethod(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ExecutionRequestMalformed("MALFORMED_PROFILE_VALUE", `${where} must be an object`);
  const kind = value["kind"];
  if (kind === "oauth_env") {
    assertClosedKeys(value, ["kind", "env_var"], [], `${where} (oauth_env)`, "UNKNOWN_PROFILE_KEY", "MISSING_PROFILE_KEY");
    return { kind, env_var: assertNonEmptyString(value["env_var"], `${where}.env_var`, "MALFORMED_PROFILE_VALUE") };
  }
  if (kind === "auth_files") {
    assertClosedKeys(value, ["kind", "auth_subdir", "auth_files"], [], `${where} (auth_files)`, "UNKNOWN_PROFILE_KEY", "MISSING_PROFILE_KEY");
    return {
      kind,
      auth_subdir: assertNonEmptyString(value["auth_subdir"], `${where}.auth_subdir`, "MALFORMED_PROFILE_VALUE"),
      auth_files: [...assertStringArray(value["auth_files"], `${where}.auth_files`)],
    };
  }
  throw new ExecutionRequestMalformed("MALFORMED_PROFILE_VALUE", `${where}.kind must be "oauth_env" or "auth_files" (got ${JSON.stringify(kind)})`);
}

/** `executor_profile_digest` = `jcsDigest(executor_profile_payload.v1)`, a TYPED `Digest`. */
export function executorProfileDigest(role: SurfaceRole, profile: unknown): Digest {
  return jcsDigest(executorProfilePayload(role, profile));
}

// ------------------------------------------------------------------ construction

/** The broker-held inputs of one request: everything it already has when preparation completes. */
export type ExecutionRequestInput =
  | {
      readonly surface_role: "WORKER";
      readonly provider: WorkerProvider;
      readonly profile: WorkerProviderProfile;
      readonly repo_id: string;
      /** The revision the workspace was ACTUALLY materialized at. */
      readonly base_revision: string;
      readonly work_item: string;
      /** The exact final prompt string handed to the surface. */
      readonly surface_prompt: string;
    }
  | {
      readonly surface_role: "PLANNER";
      readonly provider: PlanProvider;
      readonly profile: PlanProviderProfile;
      readonly repo_id: string;
      readonly base_revision: string;
      readonly intent: string;
      readonly surface_prompt: string;
    }
  | {
      readonly surface_role: "REVIEWER";
      readonly provider: ReviewProvider;
      readonly profile: ReviewProviderProfile;
      readonly repo_id: string;
      readonly candidate_revision: string;
      readonly work_item: string;
      readonly surface_prompt: string;
    };

/**
 * Build one role's `ExecutionRequestV1` from the broker's own inputs, then validate it under
 * B1(1e)'s closed key sets. The caller layer re-derives nothing: the revision field is the revision
 * handed over (and, for the roles that materialize a workspace, the one actually materialized), and
 * the work-item / intent entry is over the exact string this run was handed. The surface layer
 * digests the FINAL prompt bytes, which is where a derived value (the reviewer's merge-base diff)
 * legitimately belongs.
 */
export function buildExecutionRequest(input: ExecutionRequestInput): ExecutionRequestV1 {
  const role = input.surface_role;
  const executor_profile_digest = executorProfileDigest(role, input.profile);
  const entry = (input_role: InputRole, text: string): ExecutionInputDigestV1 => ({ input_role, digest: rawDigest(utf8(text)) });

  const request: ExecutionRequestV1 =
    role === "REVIEWER"
      ? {
          schema: EXECUTION_REQUEST_SCHEMA,
          surface_role: "REVIEWER",
          provider: input.provider,
          executor_profile_digest,
          repo_id: input.repo_id,
          candidate_revision: input.candidate_revision,
          input_digests: [entry("work-item", input.work_item), entry("surface-prompt", input.surface_prompt)],
        }
      : {
          schema: EXECUTION_REQUEST_SCHEMA,
          surface_role: role,
          provider: input.provider,
          executor_profile_digest,
          repo_id: input.repo_id,
          base_revision: input.base_revision,
          input_digests: [
            role === "WORKER" ? entry("work-item", input.work_item) : entry("intent", input.intent),
            entry("surface-prompt", input.surface_prompt),
            // The surface layer's record of what the surface actually read — never a second source
            // for the declared revision, which is why it must equal it.
            entry("workspace-revision", input.base_revision),
          ],
        };

  assertExecutionRequestWellFormed(request);
  return request;
}

// ------------------------------------------------------------------ validation

/**
 * B1(1e) in full, over an ARBITRARY candidate object — so a control can construct the violation and
 * watch it be refused, which a typed builder alone could never demonstrate. Throws
 * `ExecutionRequestMalformed`; returns nothing on success.
 */
export function assertExecutionRequestWellFormed(value: unknown): asserts value is ExecutionRequestV1 {
  if (!isPlainObject(value)) {
    throw new ExecutionRequestMalformed("REQUEST_NOT_AN_OBJECT", `a request must be a JSON object (got ${JSON.stringify(value)})`);
  }
  const role = value["surface_role"];
  if (role !== "WORKER" && role !== "REVIEWER" && role !== "PLANNER") {
    throw new ExecutionRequestMalformed("UNKNOWN_SURFACE_ROLE", `surface_role must be WORKER | REVIEWER | PLANNER (got ${JSON.stringify(role)})`);
  }

  // Top-level closure. The OTHER role's revision key is called out as a role-shape violation rather
  // than a generic unknown key: a REVIEWER carrying `base_revision` is exactly the asymmetry the
  // implemented signatures forbid papering over.
  const otherRevisionKey = REVISION_KEY[role] === "base_revision" ? "candidate_revision" : "base_revision";
  if (Object.prototype.hasOwnProperty.call(value, otherRevisionKey)) {
    throw new ExecutionRequestMalformed("WRONG_ROLE_SHAPE", `${role} carries "${otherRevisionKey}", which only the other role declares`);
  }
  assertClosedKeys(value, REQUEST_KEYS[role], [], `${role} request`, "UNKNOWN_TOP_LEVEL_KEY", "MISSING_TOP_LEVEL_KEY");

  if (value["schema"] !== EXECUTION_REQUEST_SCHEMA) {
    throw new ExecutionRequestMalformed("WRONG_SCHEMA", `schema must be "${EXECUTION_REQUEST_SCHEMA}" (got ${JSON.stringify(value["schema"])})`);
  }
  const provider = value["provider"];
  if (typeof provider !== "string" || !PROVIDER_NAMES[role].includes(provider)) {
    throw new ExecutionRequestMalformed("UNKNOWN_PROVIDER", `provider ${JSON.stringify(provider)} is not a name the ${role} resolver admits`);
  }
  assertTypedDigest(value["executor_profile_digest"], "cadp-jcs-1", `${role} request.executor_profile_digest`);
  assertNonEmptyString(value["repo_id"], `${role} request.repo_id`, "MALFORMED_REPO_ID");

  const revisionKey = REVISION_KEY[role];
  const revision = value[revisionKey];
  if (typeof revision !== "string" || !REVISION_RE.test(revision)) {
    throw new ExecutionRequestMalformed(
      "MALFORMED_REVISION",
      `${role} request.${revisionKey} must be a 40-character lowercase-hex sha (got ${JSON.stringify(revision)})`,
    );
  }

  assertInputDigests(value["input_digests"], role, revision);
}

function assertInputDigests(value: unknown, role: SurfaceRole, revision: string): void {
  if (!Array.isArray(value)) {
    throw new ExecutionRequestMalformed("INPUT_DIGESTS_NOT_A_LIST", `${role} request.input_digests must be a list`);
  }
  const required = REQUIRED_INPUT_ROLES[role];
  const seen: InputRole[] = [];
  for (const [index, raw] of value.entries()) {
    const where = `${role} request.input_digests[${index}]`;
    if (!isPlainObject(raw)) throw new ExecutionRequestMalformed("UNKNOWN_INPUT_ENTRY_KEY", `${where} must be an object`);
    assertClosedKeys(raw, ["input_role", "digest"], [], where, "UNKNOWN_INPUT_ENTRY_KEY", "MISSING_INPUT_ENTRY_KEY");
    const input_role = raw["input_role"];
    if (typeof input_role !== "string" || !(INPUT_ROLES as readonly string[]).includes(input_role)) {
      throw new ExecutionRequestMalformed("UNKNOWN_INPUT_ROLE", `${where}.input_role ${JSON.stringify(input_role)} is outside the closed set`);
    }
    if (!required.includes(input_role as InputRole)) {
      throw new ExecutionRequestMalformed("UNKNOWN_INPUT_ROLE", `${where}.input_role "${input_role}" is not declared for ${role}`);
    }
    if (seen.includes(input_role as InputRole)) {
      throw new ExecutionRequestMalformed("DUPLICATE_INPUT_ROLE", `${where}.input_role "${input_role}" appears more than once`);
    }
    const digest = assertTypedDigest(raw["digest"], "raw-bytes-1", `${where}.digest`);
    // A broker that materialized a tree other than its declared revision is malformed. The entry is
    // the surface layer's record of what the surface READ — it may not disagree with the field.
    if (input_role === "workspace-revision" && digest.value !== rawDigest(utf8(revision)).value) {
      throw new ExecutionRequestMalformed(
        "WORKSPACE_REVISION_MISMATCH",
        `${where}.digest is not the digest of the declared ${REVISION_KEY[role]}`,
      );
    }
    seen.push(input_role as InputRole);
  }
  for (const input_role of required) {
    if (!seen.includes(input_role)) {
      throw new ExecutionRequestMalformed("MISSING_INPUT_ROLE", `${role} request.input_digests omits required input_role "${input_role}"`);
    }
  }
  if (seen.join(",") !== required.join(",")) {
    throw new ExecutionRequestMalformed(
      "INPUT_ROLE_ORDER",
      `${role} request.input_digests must appear in the literal order [${required.join(", ")}] (got [${seen.join(", ")}])`,
    );
  }
}

/**
 * `execution_request_digest` = `jcsDigest(the complete ExecutionRequestV1 object)` — every key,
 * under `cadp-jcs-1`, yielding a TYPED `Digest`. Validation runs FIRST: a malformed request is
 * never digested.
 */
export function executionRequestDigest(request: unknown): Digest {
  assertExecutionRequestWellFormed(request);
  return jcsDigest(request);
}

// ------------------------------------------------------------------ the surface-start gate

/** What the broker holds once the request exists and before the surface has produced anything. */
export interface PreparedExecution<T> {
  readonly request: ExecutionRequestV1;
  readonly execution_request_digest: Digest;
  readonly run: T;
}

/**
 * THE ORDERING, MADE MECHANICAL. `buildRequest` runs, its result is closed-key validated, and the
 * request digest is computed — and only then is `start` invoked. So for every malformed request the
 * refusal lands before `jcsDigest` of the request, before any attempt identity is minted
 * (`runBoundedSurface` mints `cadp-surface-<kind>-<uuid>` as it creates the surface), before any
 * surface is started, and therefore before anything could be captured or sealed.
 *
 * `start` is a thunk rather than an already-issued promise precisely so a refusal is OBSERVABLE as
 * a surface that was never created, not merely as an exception racing one that was.
 */
export async function startSurfaceUnderRequest<T>(buildRequest: () => unknown, start: () => Promise<T>): Promise<PreparedExecution<T>> {
  const request = buildRequest();
  const execution_request_digest = executionRequestDigest(request);
  return { request: request as ExecutionRequestV1, execution_request_digest, run: await start() };
}
