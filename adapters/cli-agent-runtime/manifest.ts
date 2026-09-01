/** Honest Runtime manifest for the bounded multi-provider CLI agent pilot (#73/#49/#50). */

import type { ManifestSetInput } from "../../core/capability/manifest-set.ts";
import { CAPABILITY_NAMES } from "../../core/schemas/capability-vocabulary.ts";
import { backendV1Manifests, type BackendManifestConfig } from "../../deployment/manifests.ts";
import { PROVIDER_SEAMS } from "./providers.ts";
import type { CliAgentRuntimeAdapterConfig } from "./types.ts";

export const CLI_AGENT_RUNTIME_ADAPTER_VERSION = "0.1.0-pilot";

/** Keeps existing Backend v1 components and replaces only the Runtime composition slot. */
export function cliAgentPilotManifests(
  backend: BackendManifestConfig,
  runtime: CliAgentRuntimeAdapterConfig,
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
    .map(([runtime_profile, binding]) => ({ runtime_profile, ...binding }));
  const providers = [...new Set(Object.values(runtime.profiles).map((b) => b.provider))].sort();
  return {
    ...existing,
    runtime: {
      schema: "platform/backend-capability-manifest",
      schema_version: 1,
      body: {
        backend_kind: "RUNTIME",
        adapter_id: "cli-agent-runtime",
        adapter_version: CLI_AGENT_RUNTIME_ADAPTER_VERSION,
        backend_instance_id: runtime.adapter_instance_id,
        features: {
          providers,
          pinned_cli_versions: Object.fromEntries(
            providers.map((provider) => [provider, runtime.expected_cli_versions[provider] ?? ""]),
          ),
          persistent_session: true,
          explicit_session_resume: true,
          structured_turn_result: "STRUCTURED_PROTOCOL",
          session_creation_requires_initialization_turn: true,
          // Availability-honest per measured envelope: claude/grok report the executed model,
          // agy does not; requested identity is never substituted (#51).
          resolved_model_identity: Object.fromEntries(
            providers.map((provider) => [
              provider,
              PROVIDER_SEAMS[provider].reports_actual_model ? "REPORTED" : "UNAVAILABLE",
            ]),
          ),
          cost_observation: Object.fromEntries(
            providers.map((provider) => [
              provider,
              PROVIDER_SEAMS[provider].reports_cost ? "REPORTED" : "UNAVAILABLE",
            ]),
          ),
          sandbox_enforcement: "UNENFORCED_BY_ADAPTER",
          create_only_session: false,
          backend_session_status_query: false,
          backend_session_close: false,
          active_turn_cancellation: false,
          spawn_op_reacquisition_after_adapter_restart: false,
          turn_op_reacquisition_after_adapter_restart: false,
          in_flight_turn_reacquisition: false,
          configured_bindings: bindings,
          workflow_controller: "BACKEND_CAPABILITY_GAP",
        },
        receipt_supported: false,
        capability_enforcement,
      },
    },
  };
}
