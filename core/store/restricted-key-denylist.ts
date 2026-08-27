/**
 * I-TD7 metadata key deny list — the one module in Core that is *allowed* to name the forbidden
 * identifier categories, because naming them is its entire job.
 *
 * TD §6.1 / §18.1c enumerate exactly these categories. This is a **key-name** rule and nothing
 * more: no entropy detector, no credential regex over values, no classification engine, no
 * environment or filesystem inspection. Matching is case- and separator-insensitive, so
 * `session_key`, `sessionKey` and `SESSION-KEY` all match, and callers apply it to the metadata
 * key and to every nested object key of the value — the most conservative deterministic reading
 * of "raw secret-bearing identifier must not be stored".
 *
 * The static backend-independence guard exempts this file by name; every other Core file stays
 * under the full check.
 */

const FORBIDDEN_METADATA_KEYS: readonly string[] = [
  "sessionkey",
  "token",
  "authorization",
  "secret",
  "credential",
];

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, "");

/** True when the key name is, or contains, one of the I-TD7 categories. */
export function isSecretBearingKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return FORBIDDEN_METADATA_KEYS.some((forbidden) => normalized.includes(forbidden));
}

/** The categories themselves, for tests that need to enumerate them. */
export const SECRET_BEARING_KEY_CATEGORIES: readonly string[] = FORBIDDEN_METADATA_KEYS;
