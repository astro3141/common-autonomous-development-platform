/**
 * Root-owned identity and clock providers (PREFLIGHT §3: "the root may own these").
 *
 * Core allocates no identity and reads no clock, so the composition root supplies both. The ULID
 * here is a real, spec-shaped ULID (48-bit timestamp + 80 random bits, Crockford base32) with the
 * usual same-millisecond monotonic increment, so caller-allocated ids stay unique and sortable
 * across restarts without any durable counter.
 */

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = 0;
let lastRandom: number[] = [];

/** One spec-shaped ULID. Monotonic within a millisecond; random across them. */
export function ulid(now: number = Date.now()): string {
  let time = now;
  let random: number[];
  if (time <= lastTime) {
    // Same or regressed millisecond: increment the previous randomness (standard monotonic rule).
    time = lastTime;
    random = [...lastRandom];
    for (let i = random.length - 1; i >= 0; i -= 1) {
      random[i] = ((random[i] ?? 0) + 1) & 0xff;
      if (random[i] !== 0) break;
    }
  } else {
    random = [...randomBytes(10)];
  }
  lastTime = time;
  lastRandom = random;

  let timePart = "";
  let remaining = time;
  for (let i = 0; i < 10; i += 1) {
    timePart = (ALPHABET[remaining % 32] ?? "0") + timePart;
    remaining = Math.floor(remaining / 32);
  }

  // 80 random bits → 16 base32 characters.
  let value = 0n;
  for (const byte of random) value = (value << 8n) | BigInt(byte);
  let randomPart = "";
  for (let i = 0; i < 16; i += 1) {
    randomPart = (ALPHABET[Number(value & 31n)] ?? "0") + randomPart;
    value >>= 5n;
  }
  return timePart + randomPart;
}

/** ISO-8601 UTC now. The only clock the deployment hands to the Platform. */
export const isoNow = (): string => new Date().toISOString();
