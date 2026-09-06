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
/**
 * The development vertical structurally spends one governed effect each for GIT_PUSH, PR_CREATE
 * and PR_MERGE — a smaller max_effects dooms the run to a refused merge AFTER the model work is
 * done (measured in the first hands-off supervision pilot: planner proposed 2, PEP refused the
 * merge with "3 > 2"). Fail closed at entry instead.
 */
export const DEV_MIN_EFFECTS = 3;

/** Returns a refusal message when a development run's effect bound cannot cover its own delivery. */
export function devEffectFloorViolation(max_effects: number): string | undefined {
  if (Number.isSafeInteger(max_effects) && max_effects >= DEV_MIN_EFFECTS) return undefined;
  return `a development work run needs max_effects >= ${DEV_MIN_EFFECTS} (governed push + PR + merge; +1 per revision round) — got ${String(max_effects)}`;
}

export function malformedWorkBounds(bounds: WorkBounds): string | undefined {
  for (const [name, value] of [["max_steps", bounds.max_steps], ["max_effects", bounds.max_effects]] as const) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return `${name}=${String(value)}`;
  }
  if (bounds.deadline !== undefined && Number.isNaN(Date.parse(bounds.deadline))) return `deadline=${String(bounds.deadline)}`;
  return undefined;
}
