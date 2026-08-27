/**
 * Canonical ordering for schema-declared semantic sets (TD §6 M0-13, §7.1b, §7.1c).
 *
 * Only the four collections the schema declares as sets are normalized. Generic arrays stay
 * order-sensitive — there is no "sort every array" behaviour here, and the Batch 1 serializer is
 * untouched. The ordering relation is the very one §6 uses for object keys, reused rather than
 * re-derived, so no locale-dependent comparison can creep in.
 */

import { compareCodePoints } from "../schemas/canonical-json.ts";

/** Unicode code-point ascending — the same relation as §6 object-key ordering. */
export function sortCanonicalStrings<T extends string>(values: readonly T[]): T[] {
  return [...values].sort(compareCodePoints);
}

/** Approved override items are a set keyed by `field_path`, which is unique in v1. */
export function sortByFieldPath<T extends { readonly field_path: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort((left, right) => compareCodePoints(left.field_path, right.field_path));
}
