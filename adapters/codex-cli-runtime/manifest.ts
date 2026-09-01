/** Honest Runtime manifest for the bounded direct Codex CLI pilot. */

import type { ManifestSetInput } from "../../core/capability/manifest-set.ts";
import { CAPABILITY_NAMES } from "../../core/schemas/capability-vocabulary.ts";
import { backendV1Manifests, type BackendManifestConfig } from "../../deployment/manifests.ts";
import {
  CODEX_CLI_INSPECTED_SOURCE_COMMIT,
  CODEX_CLI_INSPECTED_SOURCE_TAG,
  CODEX_CLI_INSPECTED_VERSION,
  CODEX_CLI_WORKSPACE_COMMIT_PERMISSION_PROFILE,
} from "./codex-cli-runtime-adapter.ts";
import type { CodexCliRuntimeAdapterConfig } from "./types.ts";

export const CODEX_CLI_RUNTIME_ADAPTER_VERSION = "0.1.0-pilot";

/** Keeps existing Backend v1 components and replaces only the Runtime composition slot. */
export function codexCliPilotManifests(
  backend: BackendManifestConfig,
  runtime: CodexCliRuntimeAdapterConfig,
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
  return {
    ...existing,
    runtime: {
      schema: "platform/backend-capability-manifest",
      schema_version: 1,
      body: {
        backend_kind: "RUNTIME",
        adapter_id: "codex-cli-runtime",
        adapter_version: CODEX_CLI_RUNTIME_ADAPTER_VERSION,
        backend_instance_id: runtime.adapter_instance_id,
        features: {
          inspected_cli_version: CODEX_CLI_INSPECTED_VERSION,
          inspected_source_tag: CODEX_CLI_INSPECTED_SOURCE_TAG,
          inspected_source_commit: CODEX_CLI_INSPECTED_SOURCE_COMMIT,
          persistent_session: true,
          explicit_thread_resume: true,
          structured_turn_result: "STRUCTURED_PROTOCOL",
          authoritative_thread_identity: true,
          isolated_workspace_git_commit: true,
          workspace_git_permission_profile: CODEX_CLI_WORKSPACE_COMMIT_PERMISSION_PROFILE,
          git_config_write: false,
          git_hooks_write: false,
          git_object_redirection_write: false,
          git_commondir_write: false,
          git_gitdir_write: false,
          git_worktrees_metadata_write: false,
          approval_elevation: false,
          effective_provider_identity: "UNAVAILABLE_IN_JSONL",
          resolved_model_identity: "UNAVAILABLE_IN_JSONL",
          model_catalog: "UNAVAILABLE",
          create_only_session: false,
          session_creation_requires_initialization_turn: true,
          backend_session_status_query: false,
          backend_session_close: false,
          active_turn_cancellation: false,
          explicit_thread_resume_across_cli_processes: true,
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
