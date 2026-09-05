/**
 * Policy bundle mechanics (TD §5.2): OPA bundle bytes ARE the policy content.
 * - `content_digest` = sha256 raw-bytes-1 over the exact tar.gz bytes.
 * - `payload_digest` = sha256 `cadp-bundle-payload-1`: for every tar entry except `.manifest`,
 *   ordered by path (bytewise), concat of path || 0x00 || uint64-BE(len) || bytes.
 * - `.manifest.revision` = "cadp-v04:policy:<policy_id>@<revision>#<payload_digest hex>".
 * Also: `cadp.kernel-config.v1` validation (TD §5.4) — closed schema, bounds, no defaults.
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

export interface KernelConfig {
  readonly schema: "cadp.kernel-config.v1";
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

export class KernelConfigInvalid extends Error {}

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
 */
export function validateKernelConfig(dataCadp: unknown): KernelConfig {
  if (typeof dataCadp !== "object" || dataCadp === null) throw new KernelConfigInvalid("data.cadp missing or not an object");
  const cfg = dataCadp as Record<string, unknown>;
  for (const key of Object.keys(cfg)) {
    if (!ALLOWED_KEYS.has(key)) throw new KernelConfigInvalid(`unknown key data.cadp.${key} (closed schema)`);
  }
  if (cfg["schema"] !== "cadp.kernel-config.v1") throw new KernelConfigInvalid("schema must be cadp.kernel-config.v1");

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

  return cfg as unknown as KernelConfig;
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
