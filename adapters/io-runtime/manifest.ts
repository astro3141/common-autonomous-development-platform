/** Honest Runtime manifest for the bounded IO-backed pilot. */

import type { ManifestSetInput } from "../../core/capability/manifest-set.ts";
import { CAPABILITY_NAMES } from "../../core/schemas/capability-vocabulary.ts";
import { backendV1Manifests, type BackendManifestConfig } from "../../deployment/manifests.ts";
import type { IORuntimeAdapterConfig } from "./types.ts";

export const IO_RUNTIME_ADAPTER_VERSION = "0.1.0-pilot";

/**
 * Keeps the existing Backend v1 workflow/repository/verification manifests and replaces only the
 * Runtime slot. This does not modify or reimplement the existing Backend v1 components.
 *
 * The adapter currently translates no ADP CapabilityGrant into IO's SandboxScope. Therefore no
 * per-capability enforcement is claimed: allow is unaudited and deny is explicitly unenforceable.
 * AUTO_MERGE remains incompatible by design.
 */
export function ioPilotManifests(
  backend: BackendManifestConfig,
  runtime: IORuntimeAdapterConfig,
): ManifestSetInput {
  const existing = backendV1Manifests(backend);
  const capability_enforcement: Record<string, { allow: string; deny: string }> = {};
  for (const capability of CAPABILITY_NAMES) {
    capability_enforcement[capability] = {
      allow: "NOT_YET_AUDITED",
      deny: "UNENFORCEABLE_CAPABILITY_BOUNDARY",
    };
  }
  const bindings = Object.entries(runtime.profiles)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([runtime_profile, binding]) => ({
      runtime_profile,
      provider: binding.provider,
      requested_model: binding.model,
    }));
  return {
    ...existing,
    runtime: {
      schema: "platform/backend-capability-manifest",
      schema_version: 1,
      body: {
        backend_kind: "RUNTIME",
        adapter_id: "issue-orchestrator-runtime",
        adapter_version: IO_RUNTIME_ADAPTER_VERSION,
        backend_instance_id: runtime.adapter_instance_id,
        features: {
          persistent_session: true,
          structured_turn_result: "STRUCTURED_PROTOCOL",
          authoritative_session_identity: true,
          cancellation: true,
          same_bridge_reacquisition: true,
          bridge_restart_reacquisition: false,
          expected_io_commit: runtime.expected_io_commit,
          configured_bindings: bindings,
          model_catalog: "UNAVAILABLE",
          workflow_controller: "BACKEND_CAPABILITY_GAP",
        },
        receipt_supported: false,
        capability_enforcement,
      },
    },
  };
}
