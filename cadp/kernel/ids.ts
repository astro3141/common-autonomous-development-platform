/** Identity allocation (TD §2.2): `cadp-v04:<kind>:<uuidv7>`. Uniqueness is enforced by the store. */

import { randomBytes } from "node:crypto";

export function uuidv7(clock: () => number = Date.now): string {
  const ms = BigInt(clock());
  const bytes = randomBytes(16);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type IdKind = "effect" | "evidence" | "decision" | "admission" | "outcome";

export function newId(kind: IdKind, clock: () => number = Date.now): string {
  return `cadp-v04:${kind}:${uuidv7(clock)}`;
}

export function isKindId(kind: IdKind, value: unknown): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^cadp-v04:${kind}:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "u").test(value)
  );
}
