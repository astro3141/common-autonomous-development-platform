/**
 * Requested capability derivation and directional enforcement selection (TD §12.4, §12.2a).
 *
 * Both are pure functions of already-authoritative inputs. The requested map's only authority is
 * `effective.policy` + `CoreExecutionRole` — role profile config, runtime_profile and any model or
 * Supervisor input are deliberately not parameters, so they cannot influence the result.
 */

import type { ExecutionPolicyV1Body } from "../profile/types.ts";
import { CAPABILITY_NAMES } from "../schemas/capability-vocabulary.ts";
import type {
  CapabilityEnforcementMap,
  CapabilityName,
  CoreExecutionRole,
  RequestedCapabilities,
  RuntimeManifestBody,
} from "./types.ts";

/** All twelve capabilities false — the SUPERVISOR baseline and the starting point for the others. */
function noCapabilities(): Record<CapabilityName, boolean> {
  const map = {} as Record<CapabilityName, boolean>;
  for (const capability of CAPABILITY_NAMES) map[capability] = false;
  return map;
}

/**
 * TD §12.4 normative baseline. Always returns a complete twelve-key map.
 *
 * The single policy-derived entry is the Actor's `remote.feature_push`: only
 * `FEATURE_BRANCH_ONLY` grants it — `PLATFORM_MANAGED_ONLY` is not an Actor push authority.
 * `remote.create_pr` stays false because v1 policy has no field that could enable it.
 */
export function deriveRequestedCapabilities(
  effectivePolicy: ExecutionPolicyV1Body,
  role: CoreExecutionRole,
): RequestedCapabilities {
  const requested = noCapabilities();

  if (role === "SUPERVISOR") return requested;

  requested["repository.read"] = true;
  if (role === "AUDITOR") return requested;

  // ACTOR
  requested["repository.feature_write"] = true;
  requested["shell.execute"] = true;
  requested["remote.feature_push"] =
    effectivePolicy.repository_policy.remote_push === "FEATURE_BRANCH_ONLY";
  return requested;
}

/**
 * TD §12.2a directional rule: the requested direction selects which declared assurance applies.
 * The value is copied verbatim — no ranking, minimum, promotion or downgrade.
 */
export function deriveEnforcement(
  requested: RequestedCapabilities,
  runtimeManifest: RuntimeManifestBody,
): CapabilityEnforcementMap {
  const enforcement = {} as Record<CapabilityName, CapabilityEnforcementMap[CapabilityName]>;
  for (const capability of CAPABILITY_NAMES) {
    const directional = runtimeManifest.capability_enforcement[capability];
    enforcement[capability] = requested[capability] ? directional.allow : directional.deny;
  }
  return enforcement;
}
