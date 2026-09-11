/**
 * `cadp.execution-request.v1` — the BROKER-to-SURFACE execution contract (EP TD B1(1), B1(1e)).
 *
 * WHEN THIS OBJECT EXISTS. `ExecutionRequestV1` is constructed BY THE BROKER after preparation
 * completes and IMMEDIATELY BEFORE the surface starts — the moment every input it names (the final
 * prompt bytes, the materialized workspace revision, the resolved provider profile) is already in
 * the broker's hands and nothing has executed yet. It is emphatically NOT the caller-to-broker
 * request body: the reviewer's surface prompt does not exist until the broker has cloned, run
 * `git merge-base origin/main <candidate_sha>`, built the diff and wrapped it in its own
 * instruction text, so a caller-to-broker body has no `surface-prompt` bytes to carry. The
 * `brokerImplement` / `brokerReview` / `brokerPlan` argument shapes are the distinct PREPARATORY
 * REQUEST, which this contract neither replaces nor constrains and leaves UNCHANGED.
 *
 * The causality this module enforces, in order:
 *   caller preparatory request
 *     → broker preparation (resolve the profile, clone, check out / merge-base, build the prompt)
 *     → ExecutionRequestV1 CONSTRUCTED and VALIDATED   (`buildExecutionRequestV1`)
 *     → execution_request_digest computed              (`startBoundSurface`, after validation)
 *     → attempt identity minted + surface started      (the `start` callback, `runBoundedSurface`)
 *
 * A MALFORMED request is refused at the first of those steps: no digest is computed, no attempt
 * identity is minted, no surface is started, and nothing is sealed (B1(1e)). That ordering is the
 * whole point of routing the surface start through `startBoundSurface` rather than digesting
 * alongside it.
 *
 * WHAT THIS MODULE DOES NOT DO. B1(2)'s `ExecutionResult` — `output_artifact_subject`, its digest
 * and locator, and the `execution-output` subject binding whose `object_id` prefix is
 * `execution_request_digest.value` — is a separate contract and is not implemented here. The
 * digest this module computes is therefore handed to the surface-start callback and no further;
 * no broker response shape and no transport operation shape changes in this lane.
 */

import { isDigestShape, jcsDigest, rawDigest, type Digest } from "../kernel/canonical.ts";
import { PLAN_PROVIDERS } from "./planProviders.ts";
import type { PlanProvider } from "./planProviders.ts";
import { REVIEW_PROVIDERS } from "./reviewProviders.ts";
import type { ReviewProvider } from "./reviewProviders.ts";
import { WORKER_PROVIDERS } from "./workerProviders.ts";
import type { WorkerProvider } from "./workerProviders.ts";

/** The literal `schema` string of every request this module constructs (B1(1e)). */
export const EXECUTION_REQUEST_SCHEMA = "cadp.execution-request.v1";

/** Stable prefix of every refusal this module raises — the MALFORMED leg of B1(1e). */
export const EXECUTION_REQUEST_MALFORMED = `${EXECUTION_REQUEST_SCHEMA} MALFORMED`;

function malformed(detail: string): never {
  throw new Error(
    `${EXECUTION_REQUEST_MALFORMED}: ${detail} — refused before any digest, attempt identity, surface or seal`,
  );
}

// ------------------------------------------------------------------ vocabulary

/** §19.5's surface-role vocabulary, unchanged. */
export type SurfaceRole = "WORKER" | "REVIEWER" | "PLANNER";

/** The CLOSED `input_role` literal set (B1(1)), in the literal order entries must appear in. */
export type InputRole = "work-item" | "intent" | "surface-prompt" | "workspace-revision";
export const INPUT_ROLES: readonly InputRole[] = ["work-item", "intent", "surface-prompt", "workspace-revision"];

/**
 * The `input_role`s each surface role declares, EXACTLY ONCE EACH and in the mandated order
 * (B1(1e)). REVIEWER declares no `workspace-revision`: `brokerReview` mounts a fresh empty
 * `review-ws` and keeps its candidate checkout broker-host-side for diff construction only.
 */
export const REQUIRED_INPUT_ROLES: Readonly<Record<SurfaceRole, readonly InputRole[]>> = {
  WORKER: ["work-item", "surface-prompt", "workspace-revision"],
  PLANNER: ["intent", "surface-prompt", "workspace-revision"],
  REVIEWER: ["work-item", "surface-prompt"],
};

/**
 * The EXACT CLOSED top-level key set per role (B1(1e)). WORKER and PLANNER share a key set and
 * differ only in their required `input_role`s; REVIEWER carries `candidate_revision` and NO
 * `base_revision` key at all — not a null or empty one — mirroring the implemented signature
 * asymmetry (`brokerReview` is handed a candidate sha and no base sha).
 */
export const EXECUTION_REQUEST_KEYS: Readonly<Record<SurfaceRole, readonly string[]>> = {
  WORKER: ["schema", "surface_role", "provider", "executor_profile_digest", "repo_id", "base_revision", "input_digests"],
  PLANNER: ["schema", "surface_role", "provider", "executor_profile_digest", "repo_id", "base_revision", "input_digests"],
  REVIEWER: ["schema", "surface_role", "provider", "executor_profile_digest", "repo_id", "candidate_revision", "input_digests"],
};

export interface InputDigestEntry {
  readonly input_role: InputRole;
  /** The TYPED `Digest` over the input's UTF-8 bytes — never a bare hex string (B1(1e)). */
  readonly digest: Digest;
}

interface ExecutionRequestHeader {
  readonly schema: typeof EXECUTION_REQUEST_SCHEMA;
  readonly provider: string;
  readonly executor_profile_digest: Digest;
  readonly repo_id: string;
  readonly input_digests: readonly InputDigestEntry[];
}

export interface WorkerExecutionRequestV1 extends ExecutionRequestHeader {
  readonly surface_role: "WORKER";
  readonly base_revision: string;
}

export interface PlannerExecutionRequestV1 extends ExecutionRequestHeader {
  readonly surface_role: "PLANNER";
  readonly base_revision: string;
}

export interface ReviewerExecutionRequestV1 extends ExecutionRequestHeader {
  readonly surface_role: "REVIEWER";
  readonly candidate_revision: string;
}

export type ExecutionRequestV1 = WorkerExecutionRequestV1 | PlannerExecutionRequestV1 | ReviewerExecutionRequestV1;

// ------------------------------------------------------------ executor profile

/**
 * `executor_profile_payload.v1` IS THE RESOLVED REGISTRY ENTRY VERBATIM, under a CLOSED key set:
 * the profile object the resolver returned from `WORKER_PROVIDERS` / `REVIEW_PROVIDERS` /
 * `PLAN_PROVIDERS`, copied unaltered, with nothing added, renamed, defaulted or re-typed. An
 * absent optional key is OMITTED, never null-filled; no key outside the role's set may appear.
 *
 * The declarative specs below ARE the closed key sets. Every nested object is closed too, except
 * the one deliberate exception: `auth_env.static_env`, an OPEN `string → string` map whose keys are
 * provider data rather than schema, copied verbatim with no key added or dropped (RFC 8785 sorts
 * those keys like any other). `argv_template`, `auth_files` (top level and inside `auth_method`)
 * and `effort_argv.allowed_values` keep their ARRAY ORDER, which is load-bearing; RFC 8785 sorts
 * object keys, so declaration order is irrelevant everywhere else.
 *
 * The payload digests DESCRIPTORS ONLY — `auth_files` / `auth_subdir` / `auth_env.env_var` /
 * `auth_method` name WHERE auth comes from — so no credential is ever in the preimage (§17.3).
 * This is not `workerProfileDigest` (`workerProfile.ts`), which digests the constructed auth
 * sandbox; the two are distinct objects and must not be conflated.
 */
type FieldType =
  | "string"
  | "boolean"
  | "string_array"
  | "open_string_map"
  | { readonly object: ProfileFieldSpec }
  | { readonly union_on_kind: Readonly<Record<string, ProfileFieldSpec>> };

interface ProfileField {
  readonly type: FieldType;
  readonly optional?: boolean;
}

type ProfileFieldSpec = Readonly<Record<string, ProfileField>>;

const SCAN_SPEC: ProfileFieldSpec = {
  session_regex: { type: "string" },
  stdout_regex: { type: "string" },
};

const EFFORT_ARGV_SPEC: ProfileFieldSpec = {
  flag: { type: "string" },
  value_placement: { type: "string" },
  // OMITTED when absent, never null-filled.
  value_prefix: { type: "string", optional: true },
  allowed_values: { type: "string_array" },
};

const AUTH_ENV_SPEC: ProfileFieldSpec = {
  env_var: { type: "string" },
  // THE one deliberate open map in the whole payload.
  static_env: { type: "open_string_map" },
};

/**
 * `auth_method` is a discriminated union CLOSED PER VARIANT: `kind` is always present and no key of
 * the other variant is carried, not even as undefined (`ReviewAuthMethod` / `PlanAuthMethod`).
 */
const AUTH_METHOD_TYPE: FieldType = {
  union_on_kind: {
    oauth_env: { kind: { type: "string" }, env_var: { type: "string" } },
    auth_files: { kind: { type: "string" }, auth_subdir: { type: "string" }, auth_files: { type: "string_array" } },
  },
};

/** `WorkerProviderProfile` (`workerProviders.ts`) — the complete current key set. */
const WORKER_PROFILE_SPEC: ProfileFieldSpec = {
  argv_template: { type: "string_array" },
  auth_files: { type: "string_array" },
  auth_subdir: { type: "string" },
  auth_env: { type: { object: AUTH_ENV_SPEC }, optional: true },
  sessions_subdir: { type: "string" },
  sessions_container_dir: { type: "string", optional: true },
  identity_class_product: { type: "string" },
  model_scan: { type: { object: SCAN_SPEC }, optional: true },
  requested_effort: { type: "string", optional: true },
  effort_argv: { type: { object: EFFORT_ARGV_SPEC }, optional: true },
  effort_scan: { type: { object: SCAN_SPEC }, optional: true },
};

/**
 * `ReviewProviderProfile` (`reviewProviders.ts`) — the complete current key set.
 *
 * `can_read_workspace` is one of the profile fields that landed AFTER the TD (the reviewer-mount
 * lane, #259 P0a); the TD's B1(1e) listing predates it. The TD's own VERBATIM principle governs:
 * the resolved provider profile enters `ExecutionRequestV1` AS THE CODE DEFINES IT TODAY, so the
 * field is part of the closed key set and part of the digested payload. Silently excluding it
 * would make the payload a TD-era snapshot rather than the resolved entry, and would let two
 * profiles that differ in a real, argv-derived capability digest equal. A future TD doc batch
 * refreshes the listing; the serialization is not waiting on it.
 */
const REVIEWER_PROFILE_SPEC: ProfileFieldSpec = {
  argv_template: { type: "string_array" },
  auth_method: { type: AUTH_METHOD_TYPE },
  can_read_workspace: { type: "boolean" }, // profile field landed after the TD; verbatim principle governs
  sessions_subdir: { type: "string", optional: true },
  sessions_container_dir: { type: "string", optional: true },
  model_scan: { type: { object: SCAN_SPEC }, optional: true },
  requested_effort: { type: "string", optional: true },
  effort_argv: { type: { object: EFFORT_ARGV_SPEC }, optional: true },
  effort_scan: { type: { object: SCAN_SPEC }, optional: true },
  identity_class_product: { type: "string" },
  verdict_format: { type: "string" },
};

/**
 * `PlanProviderProfile` (`planProviders.ts`) — the complete current key set: the reviewer's set
 * less `verdict_format` AND less `can_read_workspace`, because the planner profile type declares
 * neither. Audited against the interface in this checkout rather than derived from the reviewer
 * spec, so a field added to one role's profile can never leak into another role's payload.
 */
const PLANNER_PROFILE_SPEC: ProfileFieldSpec = {
  argv_template: { type: "string_array" },
  auth_method: { type: AUTH_METHOD_TYPE },
  sessions_subdir: { type: "string", optional: true },
  sessions_container_dir: { type: "string", optional: true },
  model_scan: { type: { object: SCAN_SPEC }, optional: true },
  requested_effort: { type: "string", optional: true },
  effort_argv: { type: { object: EFFORT_ARGV_SPEC }, optional: true },
  effort_scan: { type: { object: SCAN_SPEC }, optional: true },
  identity_class_product: { type: "string" },
};

const EXECUTOR_PROFILE_SPECS: Readonly<Record<SurfaceRole, ProfileFieldSpec>> = {
  WORKER: WORKER_PROFILE_SPEC,
  REVIEWER: REVIEWER_PROFILE_SPEC,
  PLANNER: PLANNER_PROFILE_SPEC,
};

/** The role's closed `executor_profile_payload.v1` key set (declaration order; RFC 8785 sorts). */
export function executorProfileKeys(role: SurfaceRole): readonly string[] {
  return Object.keys(EXECUTOR_PROFILE_SPECS[role]);
}

function copyClosed(value: unknown, spec: ProfileFieldSpec, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    malformed(`${path} is not an object`);
  }
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) {
      malformed(`unknown key "${key}" at ${path} — the key set is closed`);
    }
  }
  const copy: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(spec)) {
    const raw = source[key];
    if (raw === undefined) {
      // An absent optional is OMITTED, never null-filled and never defaulted.
      if (field.optional !== true) malformed(`missing required key "${key}" at ${path}`);
      continue;
    }
    copy[key] = copyField(raw, field.type, `${path}.${key}`);
  }
  return copy;
}

function copyField(value: unknown, type: FieldType, path: string): unknown {
  if (type === "string") {
    if (typeof value !== "string") malformed(`${path} is not a string`);
    return value;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") malformed(`${path} is not a boolean`);
    return value;
  }
  if (type === "string_array") {
    if (!Array.isArray(value)) malformed(`${path} is not an array`);
    // Array ORDER is load-bearing and is retained exactly.
    return value.map((element, index) => {
      if (typeof element !== "string") malformed(`${path}[${index}] is not a string`);
      return element;
    });
  }
  if (type === "open_string_map") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) malformed(`${path} is not an object`);
    const source = value as Record<string, unknown>;
    const copy: Record<string, string> = {};
    // OPEN: the keys are provider data, so none is added and none is dropped.
    for (const key of Object.keys(source)) {
      const entry = source[key];
      if (typeof entry !== "string") malformed(`${path}.${key} is not a string`);
      copy[key] = entry;
    }
    return copy;
  }
  if ("object" in type) return copyClosed(value, type.object, path);
  if (typeof value !== "object" || value === null || Array.isArray(value)) malformed(`${path} is not an object`);
  const kind = (value as Record<string, unknown>)["kind"];
  if (typeof kind !== "string") malformed(`${path}.kind is missing — the union is discriminated on it`);
  const variant = Object.prototype.hasOwnProperty.call(type.union_on_kind, kind) ? type.union_on_kind[kind] : undefined;
  if (variant === undefined) malformed(`unknown ${path}.kind "${kind}" — the union is closed`);
  return copyClosed(value, variant, `${path}(${kind})`);
}

function registryEntry(role: SurfaceRole, provider: string): unknown {
  const registry: Readonly<Record<string, unknown>> =
    role === "WORKER" ? WORKER_PROVIDERS : role === "REVIEWER" ? REVIEW_PROVIDERS : PLAN_PROVIDERS;
  // Resolvers never default: an unknown provider name fails closed (§17.1).
  if (!Object.prototype.hasOwnProperty.call(registry, provider)) {
    malformed(`unknown ${role} provider "${provider}" — the registry is a closed union and never defaults`);
  }
  return registry[provider];
}

/**
 * A profile object copied verbatim under the role's closed key set. Exported separately from the
 * registry lookup so the closure itself is falsifiable: a profile carrying an unknown key at ANY
 * level, a cross-variant `auth_method` key, or a reordered array can be fed straight in.
 */
export function executorProfilePayloadOf(role: SurfaceRole, profile: unknown): Record<string, unknown> {
  return copyClosed(profile, EXECUTOR_PROFILE_SPECS[role], `executor_profile_payload.v1(${role})`);
}

/** The resolved registry entry copied verbatim under the role's closed key set. */
export function buildExecutorProfilePayload(role: SurfaceRole, provider: string): Record<string, unknown> {
  return executorProfilePayloadOf(role, registryEntry(role, provider));
}

/** `executor_profile_digest` = `jcsDigest(executor_profile_payload.v1)`, a TYPED `Digest`. */
export function executorProfileDigest(role: SurfaceRole, provider: string): Digest {
  return jcsDigest(buildExecutorProfilePayload(role, provider));
}

// ------------------------------------------------------------------ input digests

const UTF8 = new TextEncoder();

/**
 * Every `input_digests` entry digests the UTF-8 RAW BYTES of the exact string handed over (the
 * revision entries over their 40-character sha string), under `{sha256, raw-bytes-1}`.
 */
export function executionInputDigest(text: string): Digest {
  return rawDigest(UTF8.encode(text));
}

const SHA_RE = /^[0-9a-f]{40}$/u;

function assertTypedDigest(
  value: unknown,
  canonicalization: Digest["canonicalization"],
  where: string,
): asserts value is Digest {
  if (!isDigestShape(value)) {
    malformed(`${where} is not a typed Digest {algorithm, canonicalization, value} — a bare hex string is never accepted`);
  }
  if (value.canonicalization !== canonicalization) {
    malformed(`${where} carries canonicalization "${value.canonicalization}" — the pinned scheme is {sha256, ${canonicalization}}`);
  }
}

// ------------------------------------------------------------------ construction

/**
 * What the BROKER holds when preparation is complete. Every field maps to something the broker
 * already has in hand at that moment; nothing here is re-derived from a caller argument.
 */
export type ExecutionRequestInput =
  | {
      readonly surface_role: "WORKER";
      readonly provider: WorkerProvider;
      /** Exactly the `repo_full_name` argument. */
      readonly repo_id: string;
      /** Exactly the `base_sha` argument the workspace was materialized at. */
      readonly base_revision: string;
      /** The revision the broker ACTUALLY materialized; must equal `base_revision`. */
      readonly workspace_revision: string;
      /** The `work_item` string exactly as handed to `brokerImplement`. */
      readonly work_item: string;
      /** The exact final prompt string the broker hands the surface. */
      readonly surface_prompt: string;
    }
  | {
      readonly surface_role: "PLANNER";
      readonly provider: PlanProvider;
      readonly repo_id: string;
      readonly base_revision: string;
      readonly workspace_revision: string;
      /** The `intent` string exactly as handed to `brokerPlan`. */
      readonly intent: string;
      readonly surface_prompt: string;
    }
  | {
      readonly surface_role: "REVIEWER";
      readonly provider: ReviewProvider;
      readonly repo_id: string;
      /** Exactly the `candidate_sha` argument `brokerReview` receives and checks out. */
      readonly candidate_revision: string;
      readonly work_item: string;
      readonly surface_prompt: string;
    };

/**
 * Construct the role's `ExecutionRequestV1` from what the broker holds, then VALIDATE it. Throws
 * the MALFORMED refusal on anything B1(1e) forbids, before any request digest exists.
 *
 * The `surface-prompt` entry digests the FINAL BROKER-BUILT PROMPT BYTES, never the caller inputs
 * alone: the reviewer's prompt is built from a merge-base and a cumulative diff, the planner's from
 * `buildPlanPrompt`, and the worker's is the work item as substituted at `WORK_ITEM_SENTINEL`. Two
 * executions whose caller arguments are byte-identical are two DISTINCT requests when the surfaces
 * saw different bytes (B1(1)'s drift consequence).
 */
export function buildExecutionRequestV1<I extends ExecutionRequestInput>(
  input: I,
): Extract<ExecutionRequestV1, { surface_role: I["surface_role"] }> {
  const header = {
    schema: EXECUTION_REQUEST_SCHEMA,
    surface_role: input.surface_role,
    provider: input.provider,
    executor_profile_digest: executorProfileDigest(input.surface_role, input.provider),
    repo_id: input.repo_id,
  } as const;
  const entry = (input_role: InputRole, text: string): InputDigestEntry => ({ input_role, digest: executionInputDigest(text) });

  let request: ExecutionRequestV1;
  if (input.surface_role === "REVIEWER") {
    request = {
      ...header,
      surface_role: "REVIEWER",
      candidate_revision: input.candidate_revision,
      // The literal order of the closed set, filtered to this role's declared entries.
      input_digests: [entry("work-item", input.work_item), entry("surface-prompt", input.surface_prompt)],
    };
  } else if (input.surface_role === "PLANNER") {
    request = {
      ...header,
      surface_role: "PLANNER",
      base_revision: input.base_revision,
      input_digests: [
        entry("intent", input.intent),
        entry("surface-prompt", input.surface_prompt),
        entry("workspace-revision", input.workspace_revision),
      ],
    };
  } else {
    request = {
      ...header,
      surface_role: "WORKER",
      base_revision: input.base_revision,
      input_digests: [
        entry("work-item", input.work_item),
        entry("surface-prompt", input.surface_prompt),
        entry("workspace-revision", input.workspace_revision),
      ],
    };
  }
  assertExecutionRequestV1(request);
  // The role the caller asked for is the role that was built — the branch above decides it and
  // `assertExecutionRequestV1` has just re-checked it. Restated for the type system so call sites
  // see their own role's exact shape (a WORKER request has no `candidate_revision` to reach for).
  return request as unknown as Extract<ExecutionRequestV1, { surface_role: I["surface_role"] }>;
}

/**
 * The complete B1(1e) validation, over an arbitrary candidate object. Refuses an unknown key at
 * EVERY closed level (top level, `input_digests` entry, `executor_profile_payload.v1`), an unknown,
 * duplicate or missing `input_role`, a wrong role or revision shape, and a malformed typed digest.
 */
export function assertExecutionRequestV1(candidate: unknown): asserts candidate is ExecutionRequestV1 {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    malformed("the request is not an object");
  }
  const request = candidate as Record<string, unknown>;

  if (request["schema"] !== EXECUTION_REQUEST_SCHEMA) {
    malformed(`schema must be the literal "${EXECUTION_REQUEST_SCHEMA}"`);
  }
  const role = request["surface_role"];
  if (role !== "WORKER" && role !== "REVIEWER" && role !== "PLANNER") {
    malformed(`surface_role "${String(role)}" is outside the closed WORKER | REVIEWER | PLANNER vocabulary`);
  }

  // Closed top-level key set: nothing unknown, nothing missing. A REVIEWER carrying `base_revision`
  // and a WORKER carrying `candidate_revision` are both caught here, as unknown keys for the role.
  const keys = EXECUTION_REQUEST_KEYS[role];
  for (const key of Object.keys(request)) {
    if (!keys.includes(key)) malformed(`unknown top-level key "${key}" for surface_role ${role} — the key set is closed`);
  }
  for (const key of keys) {
    if (request[key] === undefined) malformed(`${role} request is missing required key "${key}"`);
  }

  const provider = request["provider"];
  if (typeof provider !== "string") malformed("provider must be the closed-union name the resolvers admit");
  // Resolving the profile is also the provider's closed-union check: unknown ⇒ MALFORMED.
  const payload = buildExecutorProfilePayload(role, provider);

  const profileDigest = request["executor_profile_digest"];
  assertTypedDigest(profileDigest, "cadp-jcs-1", "executor_profile_digest");
  if (profileDigest.value !== jcsDigest(payload).value) {
    malformed("executor_profile_digest is not jcsDigest of the resolved registry entry for this role and provider");
  }

  const repo_id = request["repo_id"];
  if (typeof repo_id !== "string" || repo_id.length === 0) malformed("repo_id must be a non-empty string");

  const revisionKey = role === "REVIEWER" ? "candidate_revision" : "base_revision";
  const revision = request[revisionKey];
  if (typeof revision !== "string" || !SHA_RE.test(revision)) {
    malformed(`${revisionKey} must be a 40-character lowercase hex sha`);
  }

  const entries = request["input_digests"];
  if (!Array.isArray(entries)) malformed("input_digests must be an array");
  const required = REQUIRED_INPUT_ROLES[role];
  const present: InputRole[] = [];
  for (const [index, raw] of entries.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) malformed(`input_digests[${index}] is not an object`);
    const item = raw as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (key !== "input_role" && key !== "digest") {
        malformed(`unknown key "${key}" in input_digests[${index}] — the entry shape is exactly { input_role, digest }`);
      }
    }
    const input_role = item["input_role"];
    if (typeof input_role !== "string" || !INPUT_ROLES.includes(input_role as InputRole)) {
      malformed(`unknown input_role "${String(input_role)}" at input_digests[${index}] — the literal set is closed`);
    }
    if (present.includes(input_role as InputRole)) {
      malformed(`duplicate input_role "${input_role}" — each declared role appears EXACTLY ONCE`);
    }
    if (!required.includes(input_role as InputRole)) {
      malformed(`input_role "${input_role}" is not declared for surface_role ${role}`);
    }
    assertTypedDigest(item["digest"], "raw-bytes-1", `input_digests[${index}].digest`);
    present.push(input_role as InputRole);
  }
  for (const input_role of required) {
    if (!present.includes(input_role)) malformed(`${role} request is missing required input_role "${input_role}"`);
  }
  if (present.some((input_role, index) => input_role !== required[index])) {
    malformed(`${role} input_digests must appear in the mandated order [${required.join(", ")}], got [${present.join(", ")}]`);
  }

  // The surface layer's record of what the surface actually read: a broker that materialized a tree
  // other than its declared revision is MALFORMED.
  if (role !== "REVIEWER") {
    const workspace = (entries as InputDigestEntry[]).find((item) => item.input_role === "workspace-revision");
    if (workspace === undefined || workspace.digest.value !== executionInputDigest(revision).value) {
      malformed("the workspace-revision entry must digest the role's base_revision — the materialized tree and the declared revision disagree");
    }
  }
}

/** `execution_request_digest` = `jcsDigest(the complete valid ExecutionRequestV1)`, TYPED. */
export function executionRequestDigest(candidate: unknown): Digest {
  assertExecutionRequestV1(candidate);
  return jcsDigest(candidate);
}

// ------------------------------------------------------------------ the surface gate

/** What the broker holds the instant before the surface starts. */
export interface BoundExecutionRequest {
  readonly request: ExecutionRequestV1;
  readonly execution_request_digest: Digest;
}

/**
 * THE ORDERING GATE. Validate the request, digest it, and only then run `start` — which is where
 * the attempt identity is minted and the surface is created (`runBoundedSurface`, `isolation.ts`).
 *
 * A malformed request throws out of the validation step, so `digest` is never called and `start` is
 * never entered: no digest, no attempt identity, no surface, nothing sealed (B1(1e)).
 *
 * `digest` is injectable for exactly the reason `startBroker`'s operation table is: the conformance
 * control counts its invocations to assert the refusal happens BEFORE it, exercising THIS ordering
 * rather than a copy of it. Production always takes the default.
 */
export async function startBoundSurface<T>(
  request: unknown,
  start: (bound: BoundExecutionRequest) => Promise<T>,
  digest: (value: unknown) => Digest = jcsDigest,
): Promise<T> {
  assertExecutionRequestV1(request);
  const execution_request_digest = digest(request);
  return start({ request, execution_request_digest });
}
