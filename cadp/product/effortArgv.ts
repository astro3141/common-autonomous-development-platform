export interface EffortArgvSpec {
  readonly flag: string;
  readonly value_placement: "separate" | "equals";
  readonly value_prefix?: string;
  readonly allowed_values: readonly string[];
}

export interface EffortArgvProfile {
  readonly requested_effort?: string;
  readonly effort_argv?: EffortArgvSpec;
}

/** Validate and append an explicitly paired, measured reasoning-effort request. */
export function appendRequestedEffort(argv: readonly string[], profile: EffortArgvProfile, label: string): string[] {
  const requested = profile.requested_effort;
  const spec = profile.effort_argv;
  if ((requested === undefined) !== (spec === undefined)) {
    throw new Error(`${label} has an unpaired requested_effort/effort_argv configuration`);
  }
  if (requested === undefined || spec === undefined) return [...argv];
  if (!spec.allowed_values.includes(requested)) {
    throw new Error(`${label} requested_effort ${requested} is not in the measured allowed values`);
  }
  const value = `${spec.value_prefix ?? ""}${requested}`;
  return spec.value_placement === "separate"
    ? [...argv, spec.flag, value]
    : [...argv, `${spec.flag}=${value}`];
}
