/**
 * Policy bundle mechanics (TD §5.2): OPA bundle bytes ARE the policy content.
 * - `content_digest` = sha256 raw-bytes-1 over the exact tar.gz bytes.
 * - `payload_digest` = sha256 `cadp-bundle-payload-1`: for every tar entry except `.manifest`,
 *   ordered by path (bytewise), concat of path || 0x00 || uint64-BE(len) || bytes.
 * - `.manifest.revision` = "cadp-v04:policy:<policy_id>@<revision>#<payload_digest hex>".
 * Also: `cadp.kernel-config.v1` validation (TD §5.4) — closed schema, bounds, no defaults —
 * and `cadp.kernel-config.v2` (AP B3), which adds registry uniqueness, closed entry keys and
 * the allocation-contract/assembly/run-profile registries on top of every v1 rule.
 */

import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

import { jcs, sha256Hex } from "./canonical.ts";
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

// ------------------------------------------------------------------ cadp.kernel-config.v1 / .v2

/** AP B2(2)(i): the schema owner's field roles and value contracts, carried but not authored by the bundle. */
export interface AllocationSchemaDescriptorEntry {
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

/** AP B4(1): declared complete-assembly pairs. */
export interface SubjectCompleteAssemblyEntry {
  readonly evidence_kind: string;
  readonly subject_namespace: string;
  readonly operation_kinds: readonly string[];
}

/** AP B3(4)(a): the exact subject identity of every namespace the kernel itself consumes. */
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
   * v2-only registries (AP B2(2), B3(3)/B3(4), B4(1), B5(3)). Each is REQUIRED under
   * `cadp.kernel-config.v2` and may be `[]`; each is absent under `cadp.kernel-config.v1`,
   * whose closed top-level key set is unchanged.
   */
  readonly allocation_schema_descriptors?: ReadonlyArray<AllocationSchemaDescriptorEntry>;
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

const SCHEMA_V1 = "cadp.kernel-config.v1";
const SCHEMA_V2 = "cadp.kernel-config.v2";

/**
 * AP B3(3) inventory: the complete set of top-level keys v2 adds to `data.cadp`. Nothing else
 * extends `ALLOWED_KEYS`, and none of them is accepted under v1.
 */
const V2_ONLY_KEYS: readonly string[] = [
  "allocation_schema_descriptors", "allocation_schemas", "subject_complete_assembly",
  "kernel_subject_namespaces", "run_profile_enrolled_requester_refs",
];

const ALLOWED_KEYS_V2 = new Set<string>([...ALLOWED_KEYS, ...V2_ONLY_KEYS]);

/**
 * AP B3(3): the closed entry-key sets, nested shapes included — an unknown key INSIDE an entry is
 * refused exactly as an unknown top-level key is, because an inert key is not a declared binding
 * and that does not weaken with nesting depth (B3(2)). Optional keys are listed here too: this set
 * closes the key space; requiredness is the per-registry shape check below.
 */
const ENTRY_KEYS = {
  approved_digest_schemes: ["algorithm", "canonicalization"],
  root_public_keys: ["key_id", "alg", "public_key", "valid_from", "valid_to"],
  attestation_keys: ["key_id", "alg", "public_key", "purpose", "valid_from", "valid_to"],
  identity_registry: ["principal", "producer_ref", "identity_class"],
  identity_class: ["vendor", "product", "account", "process_class"],
  adapter_registry: ["producer_ref", "evidence_kinds", "source_relation", "produced_at_source", "replay_idempotency", "governed_edge"],
  produced_at_source: ["kind", "claim_pointer"],
  allocation_schema_descriptors: ["schema", "fields"],
  descriptor_field: ["field", "role", "value_contract"],
  allocation_schemas: ["schema", "binding_projection", "purpose_relation"],
  binding_projection: ["tuple_field", "authority_ref", "namespace"],
  purpose_relation: ["purpose", "operation_kind"],
  subject_complete_assembly: ["evidence_kind", "subject_namespace", "operation_kinds"],
  kernel_subject_namespaces: ["namespace", "authority_ref"],
} as const satisfies Record<string, readonly string[]>;

/** AP B2(2)(i): closed two-value role vocabulary and closed three-value `value_contract` vocabulary. */
const DESCRIPTOR_ROLES: readonly string[] = ["PROJECTED", "ENTROPY"];
const DESCRIPTOR_VALUE_CONTRACTS: readonly string[] = ["POSITIVE_INTEGER", "NONEMPTY_STRING", "EFFECT_ID"];

/** AP B2(5): the two reserved kernel tuple fields; a descriptor naming either is refused. */
const RESERVED_TUPLE_FIELDS: readonly string[] = ["schema", "purpose"];

/**
 * AP B3(4)(c): the kernel-consumed namespace list is CODE, not bundle content — today exactly the
 * work-run namespace, which the kernel itself consumes (the `effect_request` index,
 * `MAX_EFFECTS_IN_WORK_RUN`, recheck #5's decision scope). A namespace the kernel reads is not a
 * tuple field name: no schema's field set lives in kernel code.
 */
export const KERNEL_WORK_RUN_NAMESPACE = "work-run";

/**
 * AP B2(5): the one allocation schema whose allocatable purpose set is STATICALLY known to be all
 * of `allocation_purposes`, so its `purpose_relation` totality is a property of the bundle. The
 * Kernel names the schema string, never a purpose or an `operation_kind` of it.
 */
const DEFAULT_ALLOCATION_SCHEMA = "cadp.allocation-key.v1";

/**
 * AP B1(5)/B2(2)(ii) extension: the ONE schema id whose WHOLE allocation contract — descriptor
 * entry AND `allocation_schemas` entry — is immutable for the store's lifetime. The Kernel names
 * the schema STRING and nothing else about it: its field set (`origin_key`), its role and its
 * value contract are the Workflow Plane's (WP §3.6), carried by the bundle's descriptor and read
 * by the generic machinery of B2(5) like any other schema's — so `origin_key` appears nowhere in
 * kernel code, exactly as B2(2)(ii)'s honest-scope paragraph requires (the kernel has no canonical
 * text to compare a FIRST authorship against, and inventing one would re-import field names).
 * Claimed for no other schema: `cadp.allocation-key.external.v1`'s entry stays MUTABLE and
 * contract-scoped, which is what makes B2(9)'s drift recovery work for it.
 */
export const RUN_ORIGIN_ALLOCATION_SCHEMA = "cadp.allocation-key.run-origin.v1";

/** The two registry entries one `schema` id is carried by, as a prior activation sealed them. */
export interface SealedAllocationContract {
  readonly descriptor?: unknown;
  readonly allocation_schema?: unknown;
}

/**
 * The two entries a `data.cadp` object carries for one `schema` id, VERBATIM — never the parsed or
 * normalised form, because the immutability comparison below is byte-level (B2(2)(ii)). Defensive
 * about shape: this runs against a bundle that has not necessarily been validated yet.
 */
export function allocationContractEntriesOf(dataCadp: unknown, schema: string): SealedAllocationContract {
  const cfg = typeof dataCadp === "object" && dataCadp !== null ? (dataCadp as Record<string, unknown>) : {};
  const entryOf = (registry: string): unknown => {
    const rows = cfg[registry];
    if (!Array.isArray(rows)) return undefined;
    return rows.find((row) => typeof row === "object" && row !== null && (row as Record<string, unknown>)["schema"] === schema);
  };
  return { descriptor: entryOf("allocation_schema_descriptors"), allocation_schema: entryOf("allocation_schemas") };
}

/** `cadp-jcs-1` digest equality is the comparison; an ABSENT entry is its own (distinct) state. */
function contractEntryDigest(entry: unknown): string | undefined {
  return entry === undefined ? undefined : sha256Hex(jcs(entry));
}

/**
 * AP B2(2)(ii) as extended for `cadp.allocation-key.run-origin.v1`: once ANY prior activation in
 * the sealed store carried that `schema` id, a bundle whose descriptor entry for it OR whose
 * `allocation_schemas` entry for it is not byte-identical to the sealed one — INCLUDING REMOVING
 * either — is refused `SCHEMA_DESCRIPTOR_CHANGED`, no activation. The identity consequence is the
 * point (B1(5)): the schema's `allocation_contract_digest` never takes a second value, so B1(2)'s
 * key derivation yields, for one stamped `requester_ref` and one `origin_key`, exactly ONE
 * `effect_id` for the store's lifetime, under ANY activation sequence — a `C1 → C2 → C1`
 * oscillation cannot fork one logical origin into two run scopes, because there is no `C2` for
 * this schema to reach.
 *
 * PRECEDENCE (B2(2)(ii), B2(8)): this comparison runs BEFORE `validateV2Extensions`, hence before
 * `ALLOCATION_SCHEMA_UNREGISTERED` and `ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE`, so a bundle
 * DELETING either run-origin entry is refused as the prohibited mutation of an activated contract
 * that it is, and never as a schema that was never registered.
 *
 * It is deliberately NOT gated on the proposed bundle's schema string: a prior activation can only
 * have carried this id under `cadp.kernel-config.v2`, so a v1-only store never reaches this rule
 * and v1 behaviour is unchanged — while a v2 store cannot launder the contract away by proposing a
 * bundle that simply drops the registry.
 */
function assertRunOriginContractImmutable(cfg: Record<string, unknown>, prior: SealedAllocationContract | undefined): void {
  if (prior === undefined) return;
  if (prior.descriptor === undefined && prior.allocation_schema === undefined) return;
  const proposed = allocationContractEntriesOf(cfg, RUN_ORIGIN_ALLOCATION_SCHEMA);
  const legs = [
    ["allocation_schema_descriptors", prior.descriptor, proposed.descriptor],
    ["allocation_schemas", prior.allocation_schema, proposed.allocation_schema],
  ] as const;
  for (const [registry, sealed, next] of legs) {
    if (contractEntryDigest(sealed) === contractEntryDigest(next)) continue;
    throw new KernelConfigInvalid(
      next === undefined
        ? `${registry} entry for ${RUN_ORIGIN_ALLOCATION_SCHEMA} is REMOVED; a prior activation sealed it and it is immutable for the store's lifetime`
        : `${registry} entry for ${RUN_ORIGIN_ALLOCATION_SCHEMA} is not byte-identical to the one a prior activation sealed`,
      "SCHEMA_DESCRIPTOR_CHANGED",
    );
  }
}

export class KernelConfigInvalid extends Error {
  /**
   * The AP refusal code for the rules that name one (`REGISTRY_DUPLICATE_KEY`,
   * `REGISTRY_UNKNOWN_ENTRY_KEY`, `ALLOCATION_SCHEMA_UNREGISTERED`,
   * `ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE`, `ALLOCATION_PURPOSE_NOT_REGISTERED`,
   * `KERNEL_NAMESPACE_UNDECLARED`). Undefined for the shape/bounds rules the TD leaves under the
   * publication-level `KERNEL_CONFIG_INVALID` alone. The code is also the message prefix, so it
   * survives into the activation refusal's `detail`.
   */
  readonly reason?: string;
  constructor(message: string, reason?: string) {
    super(reason === undefined ? message : `${reason}: ${message}`);
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
 * Two schema strings are accepted. `cadp.kernel-config.v1` is validated by exactly the rules
 * below and by nothing else. `cadp.kernel-config.v2` (AP B3(5)) is every v1 rule PLUS the
 * v2-only key set and `validateV2Extensions` — registry uniqueness (B3(1)), closed entry keys
 * (B3(2)–(3)), descriptor/projection validation (B2(2), B2(5)) and the cross-field namespace
 * invariant (B3(4)(c)).
 *
 * `priorRunOriginContract` is the run-origin allocation contract as ANY prior activation in the
 * sealed store carried it (AP B2(2)(ii) as extended; `sealedRunOriginContract` in
 * `policyPublication.ts` resolves it). It is optional because the two callers that validate a
 * bundle with no activation to compare against — genesis, which refuses to run once
 * `policy_activation` has rows, and the historical-bundle read of `policyState`/`rootListener`'s
 * signature-key resolution — have no prior to pass and are not activation decisions.
 */
export function validateKernelConfig(dataCadp: unknown, priorRunOriginContract?: SealedAllocationContract): KernelConfig {
  if (typeof dataCadp !== "object" || dataCadp === null) throw new KernelConfigInvalid("data.cadp missing or not an object");
  const cfg = dataCadp as Record<string, unknown>;
  const schema = cfg["schema"];
  const allowed = schema === SCHEMA_V2 ? ALLOWED_KEYS_V2 : ALLOWED_KEYS;
  for (const key of Object.keys(cfg)) {
    if (!allowed.has(key)) throw new KernelConfigInvalid(`unknown key data.cadp.${key} (closed schema)`);
  }
  // v2 is accepted here and refused nowhere else; every other schema string keeps v1's refusal
  // BYTE-IDENTICALLY, message included — widening acceptance is the only v1 change v2 may make.
  if (schema !== SCHEMA_V1 && schema !== SCHEMA_V2) {
    throw new KernelConfigInvalid(`schema must be ${SCHEMA_V1}`);
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

  // B2(2)(ii) as extended, and BEFORE `validateV2Extensions` — that ordering IS the precedence
  // rule: a deleted run-origin entry is `SCHEMA_DESCRIPTOR_CHANGED`, never the
  // `ALLOCATION_SCHEMA_UNREGISTERED` / `ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE` the coverage
  // checks below would otherwise reach for it.
  assertRunOriginContractImmutable(cfg, priorRunOriginContract);

  if (schema === SCHEMA_V2) validateV2Extensions(cfg);

  return cfg as unknown as KernelConfig;
}

// ------------------------------------------------------- cadp.kernel-config.v2 (AP B2/B3/B4/B5)

/** AP B3(2)–(3): an unknown key inside an entry is refused, at every nesting depth. */
function assertEntryKeys(entry: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) {
      throw new KernelConfigInvalid(`unknown key ${where}.${key} (closed entry keys)`, "REGISTRY_UNKNOWN_ENTRY_KEY");
    }
  }
}

/**
 * AP B3(1), B2(2): a first-match lookup over a duplicated key would let bundle authoring order
 * decide what a caller, a producer or a seal is compared against.
 */
function assertUniqueKeys(keys: readonly string[], where: string): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new KernelConfigInvalid(`two ${where} entries share ${key}`, "REGISTRY_DUPLICATE_KEY");
    seen.add(key);
  }
}

function entryObjectOf(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new KernelConfigInvalid(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function entriesOf(cfg: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = cfg[key];
  if (!Array.isArray(value)) throw new KernelConfigInvalid(`${key} required (may be [])`);
  return value.map((entry, index) => entryObjectOf(entry, `${key}[${index}]`));
}

/** The exact-string/no-pattern rule that already governs `identity_registry.principal` (TD §5.4). */
function assertExactString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) throw new KernelConfigInvalid(`${where} must be a nonempty string`);
  if (/[*?[\]]/u.test(value)) throw new KernelConfigInvalid(`${where} must be exact (no patterns)`);
  return value;
}

function exactStringOf(entry: Record<string, unknown>, key: string, where: string): string {
  return assertExactString(entry[key], `${where}.${key}`);
}

function closedVocabularyOf(entry: Record<string, unknown>, key: string, vocabulary: readonly string[], where: string): string {
  const value = entry[key];
  if (typeof value !== "string" || !vocabulary.includes(value)) {
    throw new KernelConfigInvalid(`${where}.${key} must be one of {${vocabulary.join(", ")}}`);
  }
  return value;
}

interface ParsedDescriptor {
  readonly schema: string;
  readonly fields: ReadonlyArray<{ field: string; role: string; value_contract: string }>;
}

interface ParsedAllocationSchema {
  readonly schema: string;
  readonly binding_projection: ReadonlyArray<{ tuple_field: string; authority_ref: string; namespace: string }>;
  readonly purpose_relation: ReadonlyArray<{ purpose: string; operation_kind: string }>;
}

/** AP B2(2)(i): the schema descriptor registry — closed entry keys, closed vocabularies, unique. */
function parseDescriptors(cfg: Record<string, unknown>): ParsedDescriptor[] {
  const where = "allocation_schema_descriptors entry";
  const parsed = entriesOf(cfg, "allocation_schema_descriptors").map((entry) => {
    assertEntryKeys(entry, ENTRY_KEYS.allocation_schema_descriptors, where);
    const schema = exactStringOf(entry, "schema", where);
    const rawFields = entry["fields"];
    if (!Array.isArray(rawFields)) throw new KernelConfigInvalid(`${where} fields required (may be [])`);
    const fields = rawFields.map((raw, index) => {
      const fieldEntry = entryObjectOf(raw, `${where} fields[${index}]`);
      assertEntryKeys(fieldEntry, ENTRY_KEYS.descriptor_field, `${where} fields entry`);
      const field = exactStringOf(fieldEntry, "field", `${where} fields entry`);
      if (RESERVED_TUPLE_FIELDS.includes(field)) {
        throw new KernelConfigInvalid(`${where} fields entry field ${field} is reserved kernel vocabulary`);
      }
      return {
        field,
        role: closedVocabularyOf(fieldEntry, "role", DESCRIPTOR_ROLES, `${where} fields entry`),
        value_contract: closedVocabularyOf(fieldEntry, "value_contract", DESCRIPTOR_VALUE_CONTRACTS, `${where} fields entry`),
      };
    });
    assertUniqueKeys(fields.map((f) => f.field), `${where} fields`);
    return { schema, fields };
  });
  assertUniqueKeys(parsed.map((d) => d.schema), "allocation_schema_descriptors");
  return parsed;
}

/** AP B2(2)(iii): the projection registry — closed entry keys, unique per schema/field/target/purpose. */
function parseAllocationSchemas(cfg: Record<string, unknown>): ParsedAllocationSchema[] {
  const where = "allocation_schemas entry";
  const parsed = entriesOf(cfg, "allocation_schemas").map((entry) => {
    assertEntryKeys(entry, ENTRY_KEYS.allocation_schemas, where);
    const schema = exactStringOf(entry, "schema", where);
    const rawProjection = entry["binding_projection"];
    if (!Array.isArray(rawProjection)) throw new KernelConfigInvalid(`${where} binding_projection required (may be [])`);
    const binding_projection = rawProjection.map((raw, index) => {
      const projection = entryObjectOf(raw, `${where} binding_projection[${index}]`);
      assertEntryKeys(projection, ENTRY_KEYS.binding_projection, `${where} binding_projection entry`);
      return {
        tuple_field: exactStringOf(projection, "tuple_field", `${where} binding_projection entry`),
        authority_ref: exactStringOf(projection, "authority_ref", `${where} binding_projection entry`),
        namespace: exactStringOf(projection, "namespace", `${where} binding_projection entry`),
      };
    });
    const rawRelation = entry["purpose_relation"];
    if (!Array.isArray(rawRelation)) throw new KernelConfigInvalid(`${where} purpose_relation required (may be [])`);
    const purpose_relation = rawRelation.map((raw, index) => {
      const relation = entryObjectOf(raw, `${where} purpose_relation[${index}]`);
      assertEntryKeys(relation, ENTRY_KEYS.purpose_relation, `${where} purpose_relation entry`);
      return {
        purpose: exactStringOf(relation, "purpose", `${where} purpose_relation entry`),
        operation_kind: exactStringOf(relation, "operation_kind", `${where} purpose_relation entry`),
      };
    });
    assertUniqueKeys(binding_projection.map((p) => p.tuple_field), `${where} binding_projection`);
    // The authoring-side half of B2(3.4)'s exactly-one rule: two fields projected onto one target
    // pair demand two bindings on it, which every conforming seal would then refuse.
    assertUniqueKeys(binding_projection.map((p) => JSON.stringify([p.authority_ref, p.namespace])), `${where} binding_projection target`);
    assertUniqueKeys(purpose_relation.map((r) => r.purpose), `${where} purpose_relation`);
    return { schema, binding_projection, purpose_relation };
  });
  assertUniqueKeys(parsed.map((s) => s.schema), "allocation_schemas");
  return parsed;
}

/**
 * AP B2(2)(iii): each mapping is validated against that schema's descriptor at activation, never
 * discovered at runtime allocation. A mapping with no descriptor has nothing to be validated
 * against, so it is refused `ALLOCATION_SCHEMA_UNREGISTERED` here.
 *
 * The converse is NOT a validation rule: B2(5)'s "both entries" is a condition on ALLOCATABILITY
 * — a schema missing either is refused `ALLOCATION_SCHEMA_UNREGISTERED` at `allocate_effect_id`
 * (a later lane) — and B2(8) does not list a descriptor without a mapping among the bundle-level
 * refusals. A carried-but-unmapped descriptor is therefore an inert, unallocatable schema, not an
 * invalid bundle; the one bundle-level "entry required" rule the TD does state is v1's static
 * `purpose_relation` totality below.
 */
function assertProjectionCoverage(descriptors: readonly ParsedDescriptor[], schemas: readonly ParsedAllocationSchema[]): void {
  for (const entry of schemas) {
    const descriptor = descriptors.find((d) => d.schema === entry.schema);
    if (descriptor === undefined) {
      throw new KernelConfigInvalid(
        `allocation_schemas entry ${entry.schema} has no allocation_schema_descriptors entry`,
        "ALLOCATION_SCHEMA_UNREGISTERED",
      );
    }
    for (const projection of entry.binding_projection) {
      if (!descriptor.fields.some((f) => f.field === projection.tuple_field)) {
        throw new KernelConfigInvalid(
          `allocation_schemas entry ${entry.schema} projects ${projection.tuple_field}, which is not a descriptor field`,
          "ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE",
        );
      }
    }
    for (const field of descriptor.fields) {
      const mapped = entry.binding_projection.filter((p) => p.tuple_field === field.field).length;
      if (field.role === "PROJECTED" && mapped !== 1) {
        throw new KernelConfigInvalid(
          `allocation_schemas entry ${entry.schema} maps PROJECTED field ${field.field} ${mapped} times (exactly one required)`,
          "ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE",
        );
      }
      if (field.role === "ENTROPY" && mapped !== 0) {
        throw new KernelConfigInvalid(
          `allocation_schemas entry ${entry.schema} maps ENTROPY field ${field.field}, which is projected nowhere`,
          "ALLOCATION_SCHEMA_PROJECTION_INCOMPLETE",
        );
      }
    }
  }
}

/**
 * The v2-only rules (AP B3(5)): registry uniqueness (B3(1)), closed entry keys (B3(2)–(3)), the
 * two new allocation registries with their descriptor-vs-projection validation (B2(2), B2(5)),
 * the assembly and run-profile keys (B4(1), B5(3)) and the cross-field invariant of B3(4)(c).
 * None of it runs for `cadp.kernel-config.v1`.
 */
function validateV2Extensions(cfg: Record<string, unknown>): void {
  // (2) Closed entry keys over the registries v1 already shape-checks (B3(3)).
  for (const entry of entriesOf(cfg, "approved_digest_schemes")) {
    assertEntryKeys(entry, ENTRY_KEYS.approved_digest_schemes, "approved_digest_schemes entry");
  }
  for (const entry of entriesOf(cfg, "root_public_keys")) {
    assertEntryKeys(entry, ENTRY_KEYS.root_public_keys, "root_public_keys entry");
  }
  for (const entry of entriesOf(cfg, "attestation_keys")) {
    assertEntryKeys(entry, ENTRY_KEYS.attestation_keys, "attestation_keys entry");
  }

  const identity = entriesOf(cfg, "identity_registry");
  for (const entry of identity) {
    assertEntryKeys(entry, ENTRY_KEYS.identity_registry, "identity_registry entry");
    assertEntryKeys(entryObjectOf(entry["identity_class"], "identity_registry entry identity_class"), ENTRY_KEYS.identity_class, "identity_registry entry identity_class");
  }
  // (1) Uniqueness (B3(1)): both keys `identityEntry`'s find() resolves by.
  assertUniqueKeys(identity.map((entry) => entry["principal"] as string), "identity_registry principal");
  assertUniqueKeys(identity.map((entry) => entry["producer_ref"] as string), "identity_registry producer_ref");

  const adapters = entriesOf(cfg, "adapter_registry");
  for (const entry of adapters) {
    assertEntryKeys(entry, ENTRY_KEYS.adapter_registry, "adapter_registry entry");
    assertEntryKeys(entryObjectOf(entry["produced_at_source"], "adapter_registry entry produced_at_source"), ENTRY_KEYS.produced_at_source, "adapter_registry entry produced_at_source");
  }
  assertUniqueKeys(adapters.map((entry) => entry["producer_ref"] as string), "adapter_registry producer_ref");

  // (4)/(5) The two new allocation registries and their cross-validation.
  const descriptors = parseDescriptors(cfg);
  const schemas = parseAllocationSchemas(cfg);
  assertProjectionCoverage(descriptors, schemas);

  // B2(5): v1's allocatable purpose set is statically all of `allocation_purposes`, so its
  // `purpose_relation` totality is checked here rather than deferred to a first allocation.
  const defaultSchema = schemas.find((entry) => entry.schema === DEFAULT_ALLOCATION_SCHEMA);
  if (defaultSchema !== undefined) {
    const registered = new Set(defaultSchema.purpose_relation.map((r) => r.purpose));
    for (const purpose of cfg["allocation_purposes"] as readonly string[]) {
      if (!registered.has(purpose)) {
        throw new KernelConfigInvalid(
          `allocation_schemas entry ${DEFAULT_ALLOCATION_SCHEMA} registers no purpose_relation for ${purpose}`,
          "ALLOCATION_PURPOSE_NOT_REGISTERED",
        );
      }
    }
  }

  // B4(1): declared complete-assembly pairs — identity strings only, no material field parsed.
  for (const entry of entriesOf(cfg, "subject_complete_assembly")) {
    const where = "subject_complete_assembly entry";
    assertEntryKeys(entry, ENTRY_KEYS.subject_complete_assembly, where);
    exactStringOf(entry, "evidence_kind", where);
    exactStringOf(entry, "subject_namespace", where);
    const kinds = entry["operation_kinds"];
    if (!Array.isArray(kinds)) throw new KernelConfigInvalid(`${where} operation_kinds required (may be [])`);
    kinds.forEach((kind, index) => assertExactString(kind, `${where} operation_kinds[${index}]`));
  }

  // B3(4)(a): the exact subject identity of every kernel-consumed namespace, unique per namespace.
  const namespaces = entriesOf(cfg, "kernel_subject_namespaces");
  for (const entry of namespaces) {
    const where = "kernel_subject_namespaces entry";
    assertEntryKeys(entry, ENTRY_KEYS.kernel_subject_namespaces, where);
    exactStringOf(entry, "namespace", where);
    exactStringOf(entry, "authority_ref", where);
  }
  assertUniqueKeys(namespaces.map((entry) => entry["namespace"] as string), "kernel_subject_namespaces namespace");

  // B5(3): enrollment is in the stamped `requester_ref` domain — exact strings, no entry object,
  // so the exact-string/no-pattern rule governs its members directly (B3(3)).
  const enrolled = cfg["run_profile_enrolled_requester_refs"];
  if (!Array.isArray(enrolled)) throw new KernelConfigInvalid("run_profile_enrolled_requester_refs required (may be [])");
  enrolled.forEach((ref, index) => assertExactString(ref, `run_profile_enrolled_requester_refs[${index}]`));

  // (6) B3(4)(c): the declaration cannot be authored away by omission — a bundle that enables the
  // run profile while declaring no work-run namespace would activate with the ambiguity lock and
  // the exact-pair lookups silently absent.
  if (enrolled.length > 0 && namespaces.filter((entry) => entry["namespace"] === KERNEL_WORK_RUN_NAMESPACE).length !== 1) {
    throw new KernelConfigInvalid(
      `run_profile_enrolled_requester_refs is non-empty but no kernel_subject_namespaces entry declares ${KERNEL_WORK_RUN_NAMESPACE}`,
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
