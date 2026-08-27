/**
 * Capability requirement compatibility primitive (TD §12.2).
 *
 * This is the calculation V10 will later use — not V10 itself. Operation selection, unknown
 * operation semantics, proposal→operation mapping and V9/V10 sequencing all belong to the
 * Decision Validator batch; the caller passes the requirement map it already selected.
 */

import { CAPABILITY_NAMES } from "../schemas/capability-vocabulary.ts";
import { deriveEnforcement } from "./derive.ts";
import type {
  CapabilityEnforcementMap,
  CapabilityName,
  CapabilityRequirementMap,
  EnforcementAssurance,
  RequestedCapabilities,
  RuntimeManifestBody,
} from "./types.ts";

export interface CapabilityCheck {
  readonly capability: CapabilityName;
  readonly requested: boolean;
  /** The directional assurance that actually applies (TD §12.2a). */
  readonly actual: EnforcementAssurance;
  readonly accepted: readonly EnforcementAssurance[];
  readonly passed: boolean;
}

export interface CompatibilityResult {
  readonly compatible: boolean;
  readonly checks: readonly CapabilityCheck[];
  readonly failures: readonly CapabilityCheck[];
}

/**
 * Every requirement must hold. Membership in `accepted` is the whole test — there is no assurance
 * ordering, so `NOT_YET_AUDITED` and `UNENFORCEABLE_CAPABILITY_BOUNDARY` pass only when the policy
 * lists them explicitly. `receipt_supported` plays no part here (M0-19).
 */
export function evaluateCapabilityRequirements(
  requested: RequestedCapabilities,
  runtimeManifest: RuntimeManifestBody,
  requirements: CapabilityRequirementMap,
): CompatibilityResult {
  return compareAgainstRequirements(
    requested,
    deriveEnforcement(requested, runtimeManifest),
    requirements,
  );
}

/**
 * TD §11.4 (M1-11) — the same rule, applied to an **already frozen** enforcement map.
 *
 * Stage-boundary drift asks whether the *current* policy requirement would still have permitted
 * the authorization this Attempt was granted. The answer must not move when the live Backend
 * moves, and it must be reconstructible after a restart — so `actual` is read out of the frozen
 * CapabilityGrant instead of being derived now.
 *
 * `evaluateCapabilityRequirements` cannot serve that question directly: it takes a Runtime
 * Manifest body, and no Manifest body is durably stored — inventing one to satisfy the signature
 * is exactly what M1-11 forbids. This is not a second authority: same accepted-set membership,
 * same vocabulary, same fixed iteration order, one shared implementation. Only the source of
 * `actual` differs.
 */
export function evaluateFrozenEnforcementRequirements(
  requested: RequestedCapabilities,
  enforcement: CapabilityEnforcementMap,
  requirements: CapabilityRequirementMap,
): CompatibilityResult {
  return compareAgainstRequirements(requested, enforcement, requirements);
}

function compareAgainstRequirements(
  requested: RequestedCapabilities,
  enforcement: CapabilityEnforcementMap,
  requirements: CapabilityRequirementMap,
): CompatibilityResult {
  // Iterating the fixed vocabulary keeps the result order independent of the caller's key order.
  const checks: CapabilityCheck[] = [];
  for (const capability of CAPABILITY_NAMES) {
    const requirement = requirements[capability];
    if (requirement === undefined) continue;
    const actual = enforcement[capability];
    checks.push({
      capability,
      requested: requested[capability],
      actual,
      accepted: requirement.accepted,
      passed: requirement.accepted.includes(actual),
    });
  }

  const failures = checks.filter((check) => !check.passed);
  return { compatible: failures.length === 0, checks, failures };
}
