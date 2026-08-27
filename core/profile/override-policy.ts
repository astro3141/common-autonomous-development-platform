/**
 * Approved Override whitelist, per-path typing and privilege direction (TD §7.1c, §7.2 rule 4–6).
 *
 * Each whitelisted path gets a small deterministic function pair — read the current value, and
 * compare old/new. No generic ordering framework, no JSON path engine: the v1 whitelist is a
 * closed list of thirteen entries.
 */

import { canonicalize } from "../schemas/canonical-json.ts";
import { ProfileCompileError, schemaError } from "./errors.ts";
import { asBoolean, asInteger, asMember } from "./shape.ts";
import { sortCanonicalStrings } from "./semantic-set.ts";
import {
  DECISION_TYPES,
  REMOTE_PUSH_MODES,
  type DecisionType,
  type ExecutionPolicyV1Body,
  type RemotePushMode,
} from "./types.ts";

/** More permissive than / less permissive than / same / not comparable. */
export type PrivilegeDirection = "RESTRICTIVE" | "PERMISSIVE" | "SAME" | "INCOMPARABLE";

export const OVERRIDE_WHITELIST = [
  "auto_merge",
  "allow_auto_subflow",
  "batch_policy.max_tasks",
  "batch_policy.max_rework",
  "batch_policy.concurrency",
  "repository_policy.remote_push",
  "repository_policy.direct_canonical_write",
  "repository_policy.allow_force_push",
  "repository_policy.allow_tag_change",
  "repository_policy.allow_git_clean",
  "repository_policy.allow_reset_hard",
  "human_gate_policy.required_decisions",
] as const;

export type OverridePath = (typeof OVERRIDE_WHITELIST)[number];

const BOOLEAN_PATHS: readonly OverridePath[] = [
  "auto_merge",
  "allow_auto_subflow",
  "repository_policy.direct_canonical_write",
  "repository_policy.allow_force_push",
  "repository_policy.allow_tag_change",
  "repository_policy.allow_git_clean",
  "repository_policy.allow_reset_hard",
];

const INTEGER_MINIMUM: Readonly<Partial<Record<OverridePath, number>>> = {
  "batch_policy.max_tasks": 1,
  "batch_policy.max_rework": 0,
  "batch_policy.concurrency": 1,
};

export function isOverridePath(value: string): value is OverridePath {
  return (OVERRIDE_WHITELIST as readonly string[]).includes(value);
}

/** Current effective value at a whitelisted path. */
export function readPolicyValue(policy: ExecutionPolicyV1Body, path: OverridePath): unknown {
  switch (path) {
    case "auto_merge":
      return policy.auto_merge;
    case "allow_auto_subflow":
      return policy.allow_auto_subflow;
    case "batch_policy.max_tasks":
      return policy.batch_policy.max_tasks;
    case "batch_policy.max_rework":
      return policy.batch_policy.max_rework;
    case "batch_policy.concurrency":
      return policy.batch_policy.concurrency;
    case "repository_policy.remote_push":
      return policy.repository_policy.remote_push;
    case "repository_policy.direct_canonical_write":
      return policy.repository_policy.direct_canonical_write;
    case "repository_policy.allow_force_push":
      return policy.repository_policy.allow_force_push;
    case "repository_policy.allow_tag_change":
      return policy.repository_policy.allow_tag_change;
    case "repository_policy.allow_git_clean":
      return policy.repository_policy.allow_git_clean;
    case "repository_policy.allow_reset_hard":
      return policy.repository_policy.allow_reset_hard;
    case "human_gate_policy.required_decisions":
      return policy.human_gate_policy.required_decisions;
  }
}

/**
 * Validates the override's value against the domain of its path. Types are never coerced —
 * `"3"` stays a string and is rejected.
 */
export function typeOverrideValue(path: OverridePath, value: unknown): unknown {
  const where = `override:${path}`;
  if (BOOLEAN_PATHS.includes(path)) return asBoolean(value, where);

  const minimum = INTEGER_MINIMUM[path];
  if (minimum !== undefined) return asInteger(value, where, minimum);

  if (path === "repository_policy.remote_push") {
    return asMember(value, where, REMOTE_PUSH_MODES);
  }

  // human_gate_policy.required_decisions
  if (!Array.isArray(value)) throw schemaError(where, "expected an array");
  const decisions = value.map((entry, index) =>
    asMember(entry, `${where}/${index}`, DECISION_TYPES),
  );
  const seen = new Set<DecisionType>();
  for (const decision of decisions) {
    if (seen.has(decision)) {
      throw new ProfileCompileError("DUPLICATE", where, `duplicate decision type: ${decision}`);
    }
    seen.add(decision);
  }
  // The override value is normalized like the policy field itself (§7.2 rule 6, M0-13), so a
  // reordered set is the same value for no-op, direction and application purposes.
  return sortCanonicalStrings(decisions);
}

/** Privilege direction of `next` relative to `current` (TD §7.2 rule 6). */
export function privilegeDirection(
  path: OverridePath,
  current: unknown,
  next: unknown,
): PrivilegeDirection {
  if (BOOLEAN_PATHS.includes(path)) {
    const from = current as boolean;
    const to = next as boolean;
    if (from === to) return "SAME";
    return to ? "PERMISSIVE" : "RESTRICTIVE"; // false < true
  }

  if (INTEGER_MINIMUM[path] !== undefined) {
    const from = current as number;
    const to = next as number;
    if (from === to) return "SAME";
    return to > from ? "PERMISSIVE" : "RESTRICTIVE"; // smaller = more restrictive
  }

  if (path === "repository_policy.remote_push") {
    const order = REMOTE_PUSH_MODES; // DENY < PLATFORM_MANAGED_ONLY < FEATURE_BRANCH_ONLY
    const from = order.indexOf(current as RemotePushMode);
    const to = order.indexOf(next as RemotePushMode);
    if (from === to) return "SAME";
    return to > from ? "PERMISSIVE" : "RESTRICTIVE";
  }

  // human_gate_policy.required_decisions — set semantics.
  const from = new Set(current as readonly DecisionType[]);
  const to = new Set(next as readonly DecisionType[]);
  const added = [...to].some((decision) => !from.has(decision));
  const removed = [...from].some((decision) => !to.has(decision));
  if (!added && !removed) return "SAME";
  if (added && !removed) return "RESTRICTIVE"; // strict superset: more decisions gated
  if (removed && !added) return "PERMISSIVE"; // strict subset: fewer decisions gated
  return "INCOMPARABLE";
}

/** Applies a typed override to a policy body, returning a new body. */
export function applyOverride(
  policy: ExecutionPolicyV1Body,
  path: OverridePath,
  value: unknown,
): ExecutionPolicyV1Body {
  switch (path) {
    case "auto_merge":
      return { ...policy, auto_merge: value as boolean };
    case "allow_auto_subflow":
      return { ...policy, allow_auto_subflow: value as boolean };
    case "batch_policy.max_tasks":
      return { ...policy, batch_policy: { ...policy.batch_policy, max_tasks: value as number } };
    case "batch_policy.max_rework":
      return { ...policy, batch_policy: { ...policy.batch_policy, max_rework: value as number } };
    case "batch_policy.concurrency":
      return { ...policy, batch_policy: { ...policy.batch_policy, concurrency: value as number } };
    case "repository_policy.remote_push":
      return {
        ...policy,
        repository_policy: { ...policy.repository_policy, remote_push: value as RemotePushMode },
      };
    case "repository_policy.direct_canonical_write":
      return {
        ...policy,
        repository_policy: { ...policy.repository_policy, direct_canonical_write: value as boolean },
      };
    case "repository_policy.allow_force_push":
      return {
        ...policy,
        repository_policy: { ...policy.repository_policy, allow_force_push: value as boolean },
      };
    case "repository_policy.allow_tag_change":
      return {
        ...policy,
        repository_policy: { ...policy.repository_policy, allow_tag_change: value as boolean },
      };
    case "repository_policy.allow_git_clean":
      return {
        ...policy,
        repository_policy: { ...policy.repository_policy, allow_git_clean: value as boolean },
      };
    case "repository_policy.allow_reset_hard":
      return {
        ...policy,
        repository_policy: { ...policy.repository_policy, allow_reset_hard: value as boolean },
      };
    case "human_gate_policy.required_decisions":
      return {
        ...policy,
        human_gate_policy: { required_decisions: value as readonly DecisionType[] },
      };
  }
}

/** Exact structural equality in the restricted JSON model (used for approval value matching). */
export function canonicalEquals(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}
