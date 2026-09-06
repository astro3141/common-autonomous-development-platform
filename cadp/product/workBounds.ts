/** #127 shared bound validation — no Temporal dependency, usable by workflow, planner and CLI. */

export interface WorkBounds {
  max_steps: number;
  max_effects: number;
  deadline?: string;
}

/**
 * #127: a malformed bound must stop the run before any step or effect, never fail open. NaN and
 * Infinity flatten to null across JSON transport; fractional, zero and negative values survive it.
 * Either way `ordinal + 1 > bound` would be silently false (or trivially true) instead of a bound.
 * Returns the offending field, or undefined when every bound is well-formed.
 */
export function malformedWorkBounds(bounds: WorkBounds): string | undefined {
  for (const [name, value] of [["max_steps", bounds.max_steps], ["max_effects", bounds.max_effects]] as const) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return `${name}=${String(value)}`;
  }
  if (bounds.deadline !== undefined && Number.isNaN(Date.parse(bounds.deadline))) return `deadline=${String(bounds.deadline)}`;
  return undefined;
}
