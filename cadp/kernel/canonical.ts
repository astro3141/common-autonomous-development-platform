/**
 * cadp-jcs-1 canonicalization and digest objects (TD v2.0 §2.1).
 *
 * cadp-jcs-1 = RFC 8785 JCS plus: (a) the record's own digest field is omitted before
 * canonicalization; (b) every timestamp is RFC 3339 UTC with millisecond precision and `Z`.
 * raw-bytes-1 = the bytes as stored. cadp-bundle-payload-1 is defined in policyBundle.ts.
 */

import { createHash } from "node:crypto";

export interface Digest {
  readonly algorithm: "sha256";
  readonly canonicalization: "cadp-jcs-1" | "raw-bytes-1" | "cadp-bundle-payload-1";
  readonly value: string;
}

/** RFC 8785 serialization. Values here are JSON-safe (strings, ints, bools, arrays, objects). */
export function jcs(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number is not canonicalizable");
    // RFC 8785 uses ECMAScript Number-to-string, which JSON.stringify implements.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => jcs(v === undefined ? null : v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort(compareUtf16);
    const parts: string[] = [];
    for (const key of keys) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${jcs(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error(`not canonicalizable: ${typeof value}`);
}

/** RFC 8785 sorts property names by UTF-16 code units. */
function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function jcsDigest(value: unknown): Digest {
  return { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256Hex(jcs(value)) };
}

export function rawDigest(bytes: Uint8Array): Digest {
  return { algorithm: "sha256", canonicalization: "raw-bytes-1", value: sha256Hex(bytes) };
}

/** Compute a record's own digest with its digest field omitted (cadp-jcs-1 rule a). */
export function recordDigest(record: Record<string, unknown>, ownDigestField: string): Digest {
  const copy: Record<string, unknown> = { ...record };
  delete copy[ownDigestField];
  return jcsDigest(copy);
}

export function digestsEqual(a: Digest, b: Digest): boolean {
  return a.algorithm === b.algorithm && a.canonicalization === b.canonicalization && a.value === b.value;
}

/** RFC 3339 UTC, millisecond precision, Z suffix (cadp-jcs-1 rule b). */
export function nowIso(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && TS_RE.test(value) && !Number.isNaN(Date.parse(value));
}

export function isDigestShape(value: unknown): value is Digest {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    d["algorithm"] === "sha256" &&
    (d["canonicalization"] === "cadp-jcs-1" ||
      d["canonicalization"] === "raw-bytes-1" ||
      d["canonicalization"] === "cadp-bundle-payload-1") &&
    typeof d["value"] === "string" &&
    /^[0-9a-f]{64}$/u.test(d["value"] as string)
  );
}

/** The fixed pre-genesis trust set `cadp-bootstrap-1` (TD §2.1). */
export const BOOTSTRAP_SCHEMES: ReadonlyArray<{ algorithm: string; canonicalization: string }> = [
  { algorithm: "sha256", canonicalization: "raw-bytes-1" },
  { algorithm: "sha256", canonicalization: "cadp-jcs-1" },
  { algorithm: "sha256", canonicalization: "cadp-bundle-payload-1" },
];

export function schemeApproved(
  digest: Digest,
  approved: ReadonlyArray<{ algorithm: string; canonicalization: string }>,
): boolean {
  return approved.some((s) => s.algorithm === digest.algorithm && s.canonicalization === digest.canonicalization);
}
