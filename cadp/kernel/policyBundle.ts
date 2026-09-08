/**
 * Policy bundle mechanics (TD §5.2): OPA bundle bytes ARE the policy content.
 * - `content_digest` = sha256 raw-bytes-1 over the exact tar.gz bytes.
 * - `payload_digest` = sha256 `cadp-bundle-payload-1`: for every tar entry except `.manifest`,
 *   ordered by path (bytewise), concat of path || 0x00 || uint64-BE(len) || bytes.
 * - `.manifest.revision` = "cadp-v04:policy:<policy_id>@<revision>#<payload_digest hex>".
 * Also: `cadp.kernel-config.v1` validation (TD §5.4) — closed schema, bounds, no defaults —
 * and `cadp.kernel-config.v2` (AP B3), which adds registry uniqueness, closed entry keys and
 * the five v0.5 registries on top of exactly that v1 rule set.
 */

import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

import { sha256Hex } from "./canonical.ts";
import type { Digest } from "./canonical.ts";

// ------------------------------------------------------------------ tar (ustar, minimal)

function tarHeader(name: string, size: number): Uint8Array {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii"); // mode
  header.write("0000000\0", 108, 8, "ascii"); // uid
  header.write("0000000\0", 116, 8, "ascii"); // gid
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii"); // mtime = 0 (deterministic)
  header.write("        ", 148, 8, "ascii"); // checksum placeholder
  header.write("0", 156, 1, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

export function buildTar(entries: ReadonlyArray<{ path: string; bytes: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry.path, entry.bytes.length));
    parts.push(entry.bytes);
    const pad = (512 - (entry.bytes.length % 512)) % 512;
    if (pad > 0) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function parseTar(bytes: Uint8Array): Array<{ path: string; bytes: Uint8Array }> {
  const buf = Buffer.from(bytes);
  const entries: Array<{ path: string; bytes: Uint8Array }> = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim(), 8);
    const typeflag = String.fromCharCode(header[156]!);
    offset += 512;
    if (typeflag === "0" || typeflag === "\0") {
      entries.push({ path: name, bytes: Buffer.from(buf.subarray(offset, offset + size)) });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

// ------------------------------------------------------------------ bundle identity

function normalizePath(path: string): string {
  return path.replace(/^\/+/u, "");
}

/** cadp-bundle-payload-1 (TD §2.1/§5.2): every entry except `.manifest`. */
export function payloadDigestOf(bundleTarGz: Uint8Array): Digest {
  const entries = parseTar(gunzipSync(bundleTarGz))
    .map((e) => ({ path: normalizePath(e.path), bytes: e.bytes }))
    .filter((e) => e.path !== ".manifest")
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(Buffer.from(entry.path, "utf8"));
    hash.update(Buffer.from([0]));
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(entry.bytes.length));
    hash.update(len);
    hash.update(entry.bytes);
  }
  return { algorithm: "sha256", canonicalization: "cadp-bundle-payload-1", value: hash.digest("hex") };
}

export function contentDigestOf(bundleTarGz: Uint8Array): Digest {
  return { algorithm: "sha256", canonicalization: "raw-bytes-1", value: sha256Hex(bundleTarGz) };
}

export function manifestRevisionString(policy_id: string, revision: number, payloadHex: string): string {
  return `${policy_id}@${revision}#${payloadHex}`;
}

export function parseManifestRevision(rev: string): { policy_id: string; revision: number; payloadHex: string } | undefined {
  const m = /^(cadp-v04:policy:[a-z0-9-]+)@(\d+)#([0-9a-f]{64})$/u.exec(rev);
  if (m === null) return undefined;
  return { policy_id: m[1]!, revision: Number(m[2]), payloadHex: m[3]! };
}

export function manifestOf(bundleTarGz: Uint8Array): { revision?: string; roots?: string[] } | undefined {
  const entry = parseTar(gunzipSync(bundleTarGz)).find((e) => normalizePath(e.path) === ".manifest");
  if (entry === undefined) return undefined;
  try {
    return JSON.parse(Buffer.from(entry.bytes).toString("utf8")) as { revision?: string };
  } catch {
    return undefined;
  }
}

export function dataJsonOf(bundleTarGz: Uint8Array): unknown {
  const entry = parseTar(gunzipSync(bundleTarGz)).find((e) => normalizePath(e.path) === "data.json");
  if (entry === undefined) return undefined;
  try {
    return JSON.parse(Buffer.from(entry.bytes).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Build a bundle whose `.manifest.revision` carries the non-self-referential payload identity.
 * Build-time only; publication re-verifies from the exact bytes (TD §5.2).
 */
export function buildPolicyBundle(input: {
  policy_id: string;
  revision: number;
  rego: string;
  data: unknown;
}): Uint8Array {
  const entries: Array<{ path: string; bytes: Uint8Array }> = [
    { path: "policy.rego", bytes: Buffer.from(input.rego, "utf8") },
    { path: "data.json", bytes: Buffer.from(JSON.stringify(input.data), "utf8") },
  ];
  const payloadHash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    payloadHash.update(Buffer.from(entry.path, "utf8"));
    payloadHash.update(Buffer.from([0]));
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(entry.bytes.length));
    payloadHash.update(len);
    payloadHash.update(entry.bytes);
  }
  const manifest = {
    revision: manifestRevisionString(input.policy_id, input.revision, payloadHash.digest("hex")),
    roots: [""],
  };
  const tar = buildTar([{ path: ".manifest", bytes: Buffer.from(JSON.stringify(manifest), "utf8") }, ...entries]);
  return gzipSync(tar, { level: 9 });
}

// ------------------------------------------------------------------ cadp.kernel-config.v1

/** AP B2(2)(i): the schema owner's immutable field-role/value-contract declaration. */
export interface AllocationSchemaDescriptor {
  readonly schema: string;
  readonly fields: ReadonlyArray<{
    field: string;
    role: "PROJECTED" | "ENTROPY";
    value_contract: "POSITIVE_INTEGER" | "NONEMPTY_STRING" | "EFFECT_ID";
  }>;
}

/** AP B2(2)(iii): policy/composition projection targets and purpose relations. */
export interface AllocationSchemaEntry {
  readonly schema: string;
  readonly binding_projection: ReadonlyArray<{ tuple_field: string; authority_ref: string; namespace: string }>;
  readonly purpose_relation: ReadonlyArray<{ purpose: string; operation_kind: string }>;
}

/** AP B4(1): the declared subject-complete assembly set. */
export interface SubjectCompleteAssemblyEntry {
  readonly evidence_kind: string;
  readonly subject_namespace: string;
  readonly operation_kinds: readonly string[];
}

/** AP B3(4)(a): the exact subject identity of every namespace the KERNEL itself consumes. */
export interface KernelSubjectNamespaceEntry {
  readonly namespace: string;
  readonly authority_ref: string;
}

export interface KernelConfig {
  readonly schema: "cadp.kernel-config.v1" | "cadp.kernel-config.v2";
  readonly approved_digest_schemes: ReadonlyArray<{ algorithm: string; canonicalization: string }>;
  readonly root_public_keys: ReadonlyArray<{ key_id: string; alg: "Ed25519"; public_key: string; valid_from: string; valid_to?: string }>;
  readonly attestation_keys: ReadonlyArray<{ key_id: string; alg: string; public_key: string; purpose: string; valid_from: string; valid_to?: string }>;
  readonly identity_registry: ReadonlyArray<{
    principal: string;
    producer_ref: string;
    identity_class: { vendor: string; product: string; account: string; process_class: string };
  }>;
  readonly adapter_registry: ReadonlyArray<{
    producer_ref: string;
    evidence_kinds: readonly string[];
    source_relation: string;
    produced_at_source: { kind: "SOURCE"; claim_pointer: string } | { kind: "NONE" };
    /**
     * v1.1 governed-writer opt-ins (#117 §5.2/§5.3). Absent for every pre-existing producer, so
     * their ingress behaviour is unchanged. `SOURCE_REF_UNIQUE` makes the declared NATIVE_KEY
     * replay idempotency true at the target; `SUPERSEDES_SINGLETON` is the separate governed-edge
     * uniqueness constraint (invariant U) — never an idempotency key.
     */
    replay_idempotency?: "SOURCE_REF_UNIQUE";
    governed_edge?: "SUPERSEDES_SINGLETON";
  }>;
  readonly allocation_purposes: readonly string[];
  readonly decision_ttl_s: number;
  readonly dispatch_window_s: number;
  readonly identity_probe_max_age_s: number;
  readonly reach_attestation_max_age_s: number;
  readonly target_immutability_attestation_max_age_s: number;
  readonly reconcile_max_attempts: number;
  readonly reconcile_backoff_s: number;
  readonly pr_settle_window_s: number;
  readonly temporal_idempotency_horizon_s: number;
  readonly cas_upload_max_bytes: number;
  readonly break_glass_max_lifetime_s: number;
  /**
   * The five keys `cadp.kernel-config.v2` adds (AP B3(3)'s inventory audit). Each is REQUIRED
   * under v2 and MAY be `[]`; each is absent under v1, whose closed top-level key set is
   * unchanged — a v1 bundle carrying any of them is refused `unknown key` exactly as before.
   */
  readonly allocation_schema_descriptors?: ReadonlyArray<AllocationSchemaDescriptor>;
  readonly allocation_schemas?: ReadonlyArray<AllocationSchemaEntry>;
  readonly subject_complete_assembly?: ReadonlyArray<SubjectCompleteAssemblyEntry>;
  readonly kernel_subject_namespaces?: ReadonlyArray<KernelSubjectNamespaceEntry>;
  readonly run_profile_enrolled_requester_refs?: readonly string[];
}

const INT_BOUNDS: ReadonlyArray<[keyof KernelConfig & string, number, number]> = [
  ["decision_ttl_s", 60, 86400],
  ["dispatch_window_s", 10, 3600],
  ["identity_probe_max_age_s", 60, 86400],
  ["reach_attestation_max_age_s", 60, 86400],
  ["target_immutability_attestation_max_age_s", 60, 86400],
  ["reconcile_max_attempts", 1, 1000],
  ["reconcile_backoff_s", 1, 3600],
  ["pr_settle_window_s", 0, 3600],
  ["temporal_idempotency_horizon_s", 60, 31536000],
  ["cas_upload_max_bytes", 1024, 1073741824],
  ["break_glass_max_lifetime_s", 60, 86400],
];

const ALLOWED_KEYS = new Set<string>([
  "schema", "approved_digest_schemes", "root_public_keys", "attestation_keys", "identity_registry",
  "adapter_registry", "allocation_purposes",
  ...INT_BOUNDS.map(([k]) => k),
]);

export const KERNEL_CONFIG_V1 = "cadp.kernel-config.v1";
export const KERNEL_CONFIG_V2 = "cadp.kernel-config.v2";

/**
 * AP B3(3), inventory audit: exactly five keys extend the closed top-level set, and only for v2.
 * Nothing else in the Authority Plane TD extends `ALLOWED_KEYS`.
 */
const V2_ONLY_KEYS: readonly string[] = [
  "allocation_schema_descriptors", "allocation_schemas", "subject_complete_assembly",
  "kernel_subject_namespaces", "run_profile_enrolled_requester_refs",
];

const ALLOWED_KEYS_V2 = new Set<string>([...ALLOWED_KEYS, ...V2_ONLY_KEYS]);

export class KernelConfigInvalid extends Error {
  /** The TD reason code this refusal carries, for the refusals AP B2/B3 name one for. */
  readonly reason: string;
  constructor(detail: string, reason = "KERNEL_CONFIG_INVALID") {
    super(reason === "KERNEL_CONFIG_INVALID" ? detail : `${reason}: ${detail}`);
    this.reason = reason;
  }
}

/**
 * Invariant P (#117 §5.2): the reserved governed-writer producer identity. It is a permanent
 * constant of product contract v1.1 — the value every uniqueness key, store index and clearing
 * predicate uses — so the registry conformance rule below must know it literally. What rotates
 * on compromise or retirement is the workload CREDENTIAL bound to it in the identity registry,
 * never the identity, which keeps invariant U true across every writer generation.
 */
const GOVERNED_PRODUCER_CONSTANT = "governed:reclassification";

/**
 * Closed-schema validation (TD §5.4, C31): unknown keys rejected, bounds inclusive,
 * exact-match registries only (no wildcard/glob/regex principals).
 *
 * Two schemas are accepted. `cadp.kernel-config.v1` is validated by exactly the rules below and
 * by nothing else — its behaviour is unchanged. `cadp.kernel-config.v2` (AP B3(5)) is validated
 * by the same rules PLUS the strictly narrower `validateKernelConfigV2` block: registry
 * uniqueness (B3(1)), closed entry keys (B3(2)–(3)), the five new registries (B2(2), B3(4),
 * B4(1), B5(3)) and the work-run declaration invariant (B3(4)(c)).
 */
export function validateKernelConfig(dataCadp: unknown): KernelConfig {
  if (typeof dataCadp !== "object" || dataCadp === null) throw new KernelConfigInvalid("data.cadp missing or not an object");
  const cfg = dataCadp as Record<string, unknown>;
  const isV2 = cfg["schema"] === KERNEL_CONFIG_V2;
  const allowed = isV2 ? ALLOWED_KEYS_V2 : ALLOWED_KEYS;
  for (const key of Object.keys(cfg)) {
    if (!allowed.has(key)) throw new KernelConfigInvalid(`unknown key data.cadp.${key} (closed schema)`);
  }
  if (!isV2 && cfg["schema"] !== KERNEL_CONFIG_V1) {
    throw new KernelConfigInvalid(`schema must be ${KERNEL_CONFIG_V1} or ${KERNEL_CONFIG_V2}`);
  }

  const schemes = cfg["approved_digest_schemes"];
  if (!Array.isArray(schemes) || schemes.length === 0) throw new KernelConfigInvalid("approved_digest_schemes required");
  for (const s of schemes as Array<Record<string, unknown>>) {
    if (typeof s["algorithm"] !== "string" || typeof s["canonicalization"] !== "string") {
      throw new KernelConfigInvalid("approved_digest_schemes entry shape");
    }
  }

  const rootKeys = cfg["root_public_keys"];
  if (!Array.isArray(rootKeys) || rootKeys.length < 1) throw new KernelConfigInvalid("root_public_keys required ≥1");
  for (const k of rootKeys as Array<Record<string, unknown>>) {
    if (typeof k["key_id"] !== "string" || k["alg"] !== "Ed25519" || typeof k["public_key"] !== "string" || typeof k["valid_from"] !== "string") {
      throw new KernelConfigInvalid("root_public_keys entry shape");
    }
  }

  if (!Array.isArray(cfg["attestation_keys"])) throw new KernelConfigInvalid("attestation_keys required (may be [])");

  const identity = cfg["identity_registry"];
  if (!Array.isArray(identity)) throw new KernelConfigInvalid("identity_registry required");
  for (const entry of identity as Array<Record<string, unknown>>) {
    const principal = entry["principal"];
    if (typeof principal !== "string" || /[*?[\]]/u.test(principal)) {
      throw new KernelConfigInvalid("identity_registry principal must be exact (no patterns)");
    }
    if (typeof entry["producer_ref"] !== "string") throw new KernelConfigInvalid("identity_registry producer_ref");
    const cls = entry["identity_class"] as Record<string, unknown> | undefined;
    if (
      cls === undefined ||
      typeof cls["vendor"] !== "string" || typeof cls["product"] !== "string" ||
      typeof cls["account"] !== "string" || typeof cls["process_class"] !== "string"
    ) {
      throw new KernelConfigInvalid("identity_registry identity_class shape");
    }
  }

  const adapters = cfg["adapter_registry"];
  if (!Array.isArray(adapters)) throw new KernelConfigInvalid("adapter_registry required");
  for (const entry of adapters as Array<Record<string, unknown>>) {
    const producer = entry["producer_ref"];
    if (typeof producer !== "string" || /[*?[\]]/u.test(producer)) {
      throw new KernelConfigInvalid("adapter_registry producer_ref must be exact");
    }
    if (!Array.isArray(entry["evidence_kinds"])) throw new KernelConfigInvalid("adapter_registry evidence_kinds");
    if (typeof entry["source_relation"] !== "string") throw new KernelConfigInvalid("adapter_registry source_relation");
    const pas = entry["produced_at_source"] as Record<string, unknown> | undefined;
    if (pas === undefined || (pas["kind"] !== "SOURCE" && pas["kind"] !== "NONE")) {
      throw new KernelConfigInvalid("adapter_registry produced_at_source kind");
    }
    if (pas["kind"] === "SOURCE" && (typeof pas["claim_pointer"] !== "string" || !(pas["claim_pointer"] as string).startsWith("/"))) {
      throw new KernelConfigInvalid("produced_at_source SOURCE requires an RFC6901 claim_pointer");
    }
    // v1.1 governed-writer opt-ins: closed vocabularies, plus invariant P's reserved-constant
    // conformance rule (#117 §5.2 rule 2) — a bundle that grants governed-edge power to any
    // producer_ref other than the permanent contract constant is refused at POLICY_ACTIVATE.
    const replay = entry["replay_idempotency"];
    if (replay !== undefined && replay !== "SOURCE_REF_UNIQUE") {
      throw new KernelConfigInvalid("adapter_registry replay_idempotency must be SOURCE_REF_UNIQUE when present");
    }
    const governed = entry["governed_edge"];
    if (governed !== undefined) {
      if (governed !== "SUPERSEDES_SINGLETON") {
        throw new KernelConfigInvalid("adapter_registry governed_edge must be SUPERSEDES_SINGLETON when present");
      }
      if (producer !== GOVERNED_PRODUCER_CONSTANT) {
        throw new KernelConfigInvalid(
          `governed_edge is reserved for ${GOVERNED_PRODUCER_CONSTANT} (invariant P); ${String(producer)} may not declare it`,
        );
      }
    }
  }

  const purposes = cfg["allocation_purposes"];
  if (!Array.isArray(purposes) || purposes.length < 1 || !purposes.every((p) => typeof p === "string")) {
    throw new KernelConfigInvalid("allocation_purposes required ≥1");
  }

  for (const [key, lo, hi] of INT_BOUNDS) {
    const v = cfg[key];
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) {
      throw new KernelConfigInvalid(`${key} must be an integer in [${lo}, ${hi}]`);
    }
  }

  // Bootstrap-scheme retention (TD §2.1/§4.4 #17): may extend but never remove bootstrap schemes.
  for (const boot of [
    { algorithm: "sha256", canonicalization: "raw-bytes-1" },
    { algorithm: "sha256", canonicalization: "cadp-jcs-1" },
    { algorithm: "sha256", canonicalization: "cadp-bundle-payload-1" },
  ]) {
    if (!(schemes as Array<Record<string, unknown>>).some((s) => s["algorithm"] === boot.algorithm && s["canonicalization"] === boot.canonicalization)) {
      throw new KernelConfigInvalid(`approved_digest_schemes must retain bootstrap scheme ${boot.canonicalization}`);
    }
  }

  if (isV2) validateKernelConfigV2(cfg);

  return cfg as unknown as KernelConfig;
}

// ------------------------------------------------------------------ cadp.kernel-config.v2 (AP B2/B3)

/**
 * AP B3(3): the closed entry-key sets, exactly as that clause lists them. Nested sets are closed
 * identically and for the identical reason — "an inert key is not a declared binding" (B3(2))
 * does not weaken with nesting depth. A trailing-optional member (`valid_to`, `claim_pointer`,
 * the two governed-writer opt-ins) is a member of the set; its REQUIRED-ness is the concern of
 * the shape rules above, not of key closure.
 */
const V2_ENTRY_KEYS: Readonly<Record<string, readonly string[]>> = {
  approved_digest_schemes: ["algorithm", "canonicalization"],
  root_public_keys: ["key_id", "alg", "public_key", "valid_from", "valid_to"],
  attestation_keys: ["key_id", "alg", "public_key", "purpose", "valid_from", "valid_to"],
  identity_registry: ["principal", "producer_ref", "identity_class"],
  "identity_registry.identity_class": ["vendor", "product", "account", "process_class"],
  adapter_registry: ["producer_ref", "evidence_kinds", "source_relation", "produced_at_source", "replay_idempotency", "governed_edge"],
  "adapter_registry.produced_at_source": ["kind", "claim_pointer"],
  allocation_schema_descriptors: ["schema", "fields"],
  "allocation_schema_descriptors.fields": ["field", "role", "value_contract"],
  allocation_schemas: ["schema", "binding_projection", "purpose_relation"],
  "allocation_schemas.binding_projection": ["tuple_field", "authority_ref", "namespace"],
  "allocation_schemas.purpose_relation": ["purpose", "operation_kind"],
  subject_complete_assembly: ["evidence_kind", "subject_namespace", "operation_kinds"],
  kernel_subject_namespaces: ["namespace", "authority_ref"],
};

/** AP B2(2)(i): the two closed vocabularies of a descriptor field entry. */
const DESCRIPTOR_ROLES: readonly string[] = ["PROJECTED", "ENTROPY"];
const DESCRIPTOR_VALUE_CONTRACTS: readonly string[] = ["POSITIVE_INTEGER", "NONEMPTY_STRING", "EFFECT_ID"];

/** AP B2(5): the two reserved kernel tuple fields; a descriptor naming either is refused. */
const RESERVED_TUPLE_FIELDS: readonly string[] = ["schema", "purpose"];

/**
 * AP B3(4)(c): the kernel-consumed namespace list is CODE, not bundle content — today exactly the
 * work-run namespace, which the kernel itself consumes (the `effect_request` index in
 * `ingress.ts`; recheck #5's decision scope, `REQUIRE_NO_PRIOR_UNKNOWN_IN_SCOPE` and
 * `MAX_EFFECTS_IN_WORK_RUN` in `pep.ts`). A namespace the kernel reads is not a tuple field name.
 */
const KERNEL_CONSUMED_NAMESPACE_WORK_RUN = "work-run";

/** Resolve `container[key]` as an array of objects, refusing anything else. */
function v2ObjectEntries(container: Record<string, unknown>, key: string, where: string): Array<Record<string, unknown>> {
  const value = container[key];
  if (!Array.isArray(value)) throw new KernelConfigInvalid(`${where} required (may be [])`);
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new KernelConfigInvalid(`${where}[${index}] must be an object`);
    }
    return entry as Record<string, unknown>;
  });
}

/** AP B3(2)/(3): an unknown key INSIDE an entry is refused, at any nesting depth. */
function assertClosedEntryKeys(where: string, entry: Record<string, unknown>): void {
  const allowed = V2_ENTRY_KEYS[where]!;
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) {
      throw new KernelConfigInvalid(`unknown key ${key} in ${where} entry (closed entry keys)`, "REGISTRY_UNKNOWN_ENTRY_KEY");
    }
  }
}

/** AP B3(1), B2(2): a first-match lookup must never be decided by bundle authoring order. */
function assertUniqueKeys(where: string, keyName: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new KernelConfigInvalid(`two ${where} entries share ${keyName} ${value}`, "REGISTRY_DUPLICATE_KEY");
    }
    seen.add(value);
  }
}

function v2String(where: string, entry: Record<string, unknown>, key: string): string {
  const value = entry[key];
  if (typeof value !== "string") throw new KernelConfigInvalid(`${where} ${key} must be a string`);
  return value;
}

/**
 * The v2-only rule set (AP B3(5)): registry uniqueness (B3(1)), closed entry keys (B3(2)–(3)),
 * the five new registries with their shapes and vocabularies (B2(2), B3(4), B4(1), B5(3)),
 * descriptor-vs-projection coverage (B2(2)(iii), B2(5)) and the work-run declaration invariant
 * (B3(4)(c)). Runs only for `cadp.kernel-config.v2`; v1 reaches none of it.
 *
 * NOT enforced here, and deliberately: B2(2)(ii)'s cross-activation descriptor immutability
 * (`SCHEMA_DESCRIPTOR_CHANGED`) compares against the SEALED STORE and so is not a function of one
 * bundle, and B2(5)'s allocation-time refusals (`ALLOCATION_TUPLE_INVALID`,
 * `ALLOCATION_PURPOSE_NOT_REGISTERED`) are ingress rules — including its v1 corollary that a
 * bundle carry a `cadp.allocation-key.v1` entry whose `purpose_relation` is total over
 * `allocation_purposes`, which lands with the ingress migration off this registry.
 */
function validateKernelConfigV2(cfg: Record<string, unknown>): void {
  // --- B3(2)/(3): closed entry keys over the registries the v1 rules already shape-checked.
  for (const registry of ["approved_digest_schemes", "root_public_keys", "attestation_keys"]) {
    for (const entry of v2ObjectEntries(cfg, registry, registry)) assertClosedEntryKeys(registry, entry);
  }
  const identity = v2ObjectEntries(cfg, "identity_registry", "identity_registry");
  for (const entry of identity) {
    assertClosedEntryKeys("identity_registry", entry);
    assertClosedEntryKeys("identity_registry.identity_class", entry["identity_class"] as Record<string, unknown>);
  }
  const adapters = v2ObjectEntries(cfg, "adapter_registry", "adapter_registry");
  for (const entry of adapters) {
    assertClosedEntryKeys("adapter_registry", entry);
    assertClosedEntryKeys("adapter_registry.produced_at_source", entry["produced_at_source"] as Record<string, unknown>);
  }

  // --- B3(1): the three uniqueness legs of conformance control A1.
  assertUniqueKeys("identity_registry", "principal", identity.map((e) => e["principal"] as string));
  assertUniqueKeys("identity_registry", "producer_ref", identity.map((e) => e["producer_ref"] as string));
  assertUniqueKeys("adapter_registry", "producer_ref", adapters.map((e) => e["producer_ref"] as string));

  // --- B2(2)(i): the schema-owner descriptor registry.
  const descriptors = v2ObjectEntries(cfg, "allocation_schema_descriptors", "allocation_schema_descriptors");
  for (const entry of descriptors) {
    assertClosedEntryKeys("allocation_schema_descriptors", entry);
    const schema = v2String("allocation_schema_descriptors", entry, "schema");
    const fields = v2ObjectEntries(entry, "fields", "allocation_schema_descriptors.fields");
    for (const fieldEntry of fields) {
      assertClosedEntryKeys("allocation_schema_descriptors.fields", fieldEntry);
      // Exactly three members, all required (B2(2)(i)).
      const field = v2String("allocation_schema_descriptors.fields", fieldEntry, "field");
      const role = v2String("allocation_schema_descriptors.fields", fieldEntry, "role");
      const valueContract = v2String("allocation_schema_descriptors.fields", fieldEntry, "value_contract");
      if (RESERVED_TUPLE_FIELDS.includes(field)) {
        throw new KernelConfigInvalid(
          `allocation_schema_descriptors ${schema} names reserved kernel field ${field} (schema and purpose are reserved)`,
        );
      }
      if (!DESCRIPTOR_ROLES.includes(role)) {
        throw new KernelConfigInvalid(`allocation_schema_descriptors ${schema} field ${field} role must be one of ${DESCRIPTOR_ROLES.join(", ")}`);
      }
      if (!DESCRIPTOR_VALUE_CONTRACTS.includes(valueContract)) {
        throw new KernelConfigInvalid(
          `allocation_schema_descriptors ${schema} field ${field} value_contract must be one of ${DESCRIPTOR_VALUE_CONTRACTS.join(", ")}`,
        );
      }
    }
    assertUniqueKeys(`allocation_schema_descriptors ${schema} fields`, "field", fields.map((f) => f["field"] as string));
  }
  assertUniqueKeys("allocation_schema_descriptors", "schema", descriptors.map((e) => e["schema"] as string));

  // --- B2(2)(iii): the policy/composition projection registry.
  const schemas = v2ObjectEntries(cfg, "allocation_schemas", "allocation_schemas");
  for (const entry of schemas) {
    assertClosedEntryKeys("allocation_schemas", entry);
    const schema = v2String("allocation_schemas", entry, "schema");
    const projections = v2ObjectEntries(entry, "binding_projection", "allocation_schemas.binding_projection");
    for (const projection of projections) {
      assertClosedEntryKeys("allocation_schemas.binding_projection", projection);
      v2String("allocation_schemas.binding_projection", projection, "tuple_field");
      v2String("allocation_schemas.binding_projection", projection, "authority_ref");
      v2String("allocation_schemas.binding_projection", projection, "namespace");
    }
    assertUniqueKeys(`allocation_schemas ${schema} binding_projection`, "tuple_field", projections.map((p) => p["tuple_field"] as string));
    // The authoring-side half of B2(3.4)'s exactly-one rule: two tuple_fields projected onto one
    // target pair is an unsatisfiable contract, refused here rather than at every conforming seal.
    assertUniqueKeys(
      `allocation_schemas ${schema} binding_projection`,
      "(authority_ref, namespace) target",
      projections.map((p) => JSON.stringify([p["authority_ref"], p["namespace"]])),
    );
    const relations = v2ObjectEntries(entry, "purpose_relation", "allocation_schemas.purpose_relation");
    for (const relation of relations) {
      assertClosedEntryKeys("allocation_schemas.purpose_relation", relation);
      v2String("allocation_schemas.purpose_relation", relation, "purpose");
      v2String("allocation_schemas.purpose_relation", relation, "operation_kind");
    }
    assertUniqueKeys(`allocation_schemas ${schema} purpose_relation`, "purpose", relations.map((r) => r["purpose"] as string));
  }
  assertUniqueKeys("allocation_schemas", "schema", schemas.map((e) => e["schema"] as string));

  // --- B2(5): every allocation schema has BOTH entries. B2(8) raises ALLOCATION_SCHEMA_UNREGISTERED
  // for a missing descriptor or a missing allocation_schemas entry "again at genesis/activation
  // validation against the bundle itself".
  const descriptorBySchema = new Map(descriptors.map((d) => [d["schema"] as string, d]));
  const projectedSchemas = new Set(schemas.map((e) => e["schema"] as string));
  for (const schema of projectedSchemas) {
    if (!descriptorBySchema.has(schema)) {
      throw new KernelConfigInvalid(`allocation_schemas ${schema} has no allocation_schema_descriptors entry`, "ALLOCATION_SCHEMA_UNREGISTERED");
    }
  }
  for (const schema of descriptorBySchema.keys()) {
    if (!projectedSchemas.has(schema)) {
      throw new KernelConfigInvalid(`allocation_schema_descriptors ${schema} has no allocation_schemas entry`, "ALLOCATION_SCHEMA_UNREGISTERED");
    }
  }

  // --- B2(2)(iii): every PROJECTED field has exactly one mapping, no ENTROPY field has any, and
  // no mapping names a field outside the descriptor (which disposes of the reserved names too).
  for (const entry of schemas) {
    const schema = entry["schema"] as string;
    const fields = (descriptorBySchema.get(schema)!["fields"] as Array<Record<string, unknown>>);
    const projections = entry["binding_projection"] as Array<Record<string, unknown>>;
    for (const projection of projections) {
      const tupleField = projection["tuple_field"] as string;
      if (!fields.some((f) => f["field"] === tupleField)) {
        throw new KernelConfigInvalid(
          `allocation_schemas ${schema} binding_projection names ${tupleField}, which is not a descriptor field`,
          "ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE",
        );
      }
    }
    for (const fieldEntry of fields) {
      const field = fieldEntry["field"] as string;
      const mapped = projections.filter((p) => p["tuple_field"] === field).length;
      const expected = fieldEntry["role"] === "PROJECTED" ? 1 : 0;
      if (mapped !== expected) {
        throw new KernelConfigInvalid(
          `allocation_schemas ${schema} field ${field} is ${String(fieldEntry["role"])} and has ${mapped} binding_projection entries (expected ${expected})`,
          "ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE",
        );
      }
    }
  }

  // --- B4(1): the subject-complete assembly declaration.
  for (const entry of v2ObjectEntries(cfg, "subject_complete_assembly", "subject_complete_assembly")) {
    assertClosedEntryKeys("subject_complete_assembly", entry);
    v2String("subject_complete_assembly", entry, "evidence_kind");
    v2String("subject_complete_assembly", entry, "subject_namespace");
    const kinds = entry["operation_kinds"];
    // An array of exact strings, never an entry object (B3(3)).
    if (!Array.isArray(kinds) || !kinds.every((k) => typeof k === "string")) {
      throw new KernelConfigInvalid("subject_complete_assembly operation_kinds must be an array of strings");
    }
  }

  // --- B3(4)(a): the declared exact subject identity of every kernel-consumed namespace.
  const namespaces = v2ObjectEntries(cfg, "kernel_subject_namespaces", "kernel_subject_namespaces");
  for (const entry of namespaces) {
    assertClosedEntryKeys("kernel_subject_namespaces", entry);
    v2String("kernel_subject_namespaces", entry, "namespace");
    v2String("kernel_subject_namespaces", entry, "authority_ref");
  }
  assertUniqueKeys("kernel_subject_namespaces", "namespace", namespaces.map((e) => e["namespace"] as string));

  // --- B5(3): enrollment in the requester_ref domain. No entry object, so no entry-key set to
  // close; the exact-string/no-pattern rule that governs identity_registry.principal governs its
  // members instead (B3(3)).
  const enrolled = cfg["run_profile_enrolled_requester_refs"];
  if (!Array.isArray(enrolled)) throw new KernelConfigInvalid("run_profile_enrolled_requester_refs required (may be [])");
  for (const ref of enrolled) {
    if (typeof ref !== "string" || /[*?[\]]/u.test(ref)) {
      throw new KernelConfigInvalid("run_profile_enrolled_requester_refs members must be exact requester_refs (no patterns)");
    }
  }

  // --- B3(4)(c): the safeguard reachable by mere OMISSION. A bundle enabling the run profile while
  // declaring no work-run namespace would activate with the ambiguity lock and the exact-pair
  // lookups silently absent. Exactly-one is (1)'s per-namespace uniqueness plus this existence rule.
  if (enrolled.length > 0 && !namespaces.some((e) => e["namespace"] === KERNEL_CONSUMED_NAMESPACE_WORK_RUN)) {
    throw new KernelConfigInvalid(
      `run_profile_enrolled_requester_refs is non-empty but no kernel_subject_namespaces entry declares ${KERNEL_CONSUMED_NAMESPACE_WORK_RUN}`,
      "KERNEL_NAMESPACE_UNDECLARED",
    );
  }
}

/** RFC 6901 pointer resolution for produced_at_source claim pointers. */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  let cur: unknown = doc;
  for (const raw of pointer.split("/").slice(1)) {
    const token = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(cur)) cur = cur[Number(token)];
    else if (typeof cur === "object" && cur !== null) cur = (cur as Record<string, unknown>)[token];
    else return undefined;
  }
  return cur;
}
