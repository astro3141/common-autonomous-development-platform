/**
 * Neutral capability fixtures.
 *
 * Fictitious backends and plain provenance references only — no backend product name and nothing
 * that I-TD7 restricts appears here.
 */

import { CAPABILITY_NAMES } from "../../core/schemas/capability-vocabulary.ts";
import type { EnforcementAssurance } from "../../core/schemas/capability-vocabulary.ts";

export const ULID_A = "01JQ8ZK5T7RC9V2W4X6Y8Z0ABC";
export const ULID_B = "01JQ8ZK5T7RC9V2W4X6Y8Z0ABD";

type Directional = { allow: EnforcementAssurance; deny: EnforcementAssurance };

/** A directional map with the same entry for all twelve capabilities. */
export const uniformEnforcement = (
  allow: EnforcementAssurance,
  deny: EnforcementAssurance,
): Record<string, Directional> => {
  const map: Record<string, Directional> = {};
  for (const capability of CAPABILITY_NAMES) map[capability] = { allow, deny };
  return map;
};

/** Everything enforceable in both directions — the "strong backend" fixture. */
export const strongEnforcement = (): Record<string, Directional> =>
  uniformEnforcement("ENFORCED", "ENFORCED");

/** Nothing audited — the "weak backend" fixture. */
export const weakEnforcement = (): Record<string, Directional> =>
  uniformEnforcement("NOT_YET_AUDITED", "NOT_YET_AUDITED");

export const runtimeManifest = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  schema: "platform/backend-capability-manifest",
  schema_version: 1,
  body: {
    backend_kind: "RUNTIME",
    adapter_id: "example-runtime",
    adapter_version: "1.0.0",
    backend_instance_id: "instance-a",
    features: { persistent_session: true },
    receipt_supported: true,
    capability_enforcement: strongEnforcement(),
    ...overrides,
  },
});

export const componentManifest = (
  kind: "WORKFLOW" | "REPOSITORY" | "VERIFICATION",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  schema: "platform/backend-capability-manifest",
  schema_version: 1,
  body: {
    backend_kind: kind,
    adapter_id: `example-${kind.toLowerCase()}`,
    adapter_version: "1.0.0",
    backend_instance_id: `instance-${kind.toLowerCase()}`,
    features: {},
    ...overrides,
  },
});

export const manifestSet = (): {
  runtime: unknown;
  workflow: unknown;
  repository: unknown;
  verification: unknown;
} => ({
  runtime: runtimeManifest(),
  workflow: componentManifest("WORKFLOW"),
  repository: componentManifest("REPOSITORY"),
  verification: componentManifest("VERIFICATION"),
});

/** A complete twelve-capability applied map, all the same value. */
export const uniformApplied = (
  assurance: EnforcementAssurance,
): Record<string, EnforcementAssurance> => {
  const map: Record<string, EnforcementAssurance> = {};
  for (const capability of CAPABILITY_NAMES) map[capability] = assurance;
  return map;
};
