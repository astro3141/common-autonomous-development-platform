/**
 * Backend v1 component manifests — TD §12.3 transcribed as data (IG-6).
 *
 * These are the conservative, pre-audit declarations the TD fixed: nothing here has been promoted
 * beyond what the 2026-08 read-only audit measured. `receipt_supported` is false (measured — the
 * backend has no enforcement-receipt concept), Actor canonical-write/merge denial is
 * `UNENFORCEABLE_CAPABILITY_BOUNDARY`, and everything unaudited stays `NOT_YET_AUDITED`. The
 * direct consequence is the designed one: a policy that requires `ENFORCED` denial for
 * `automatic_merge` is rejected by V10 before any spawn — that is the Compatibility Gate working,
 * not a defect (TD §12.3).
 */

import type { ManifestSetInput } from "../core/capability/manifest-set.ts";
import { CAPABILITY_NAMES } from "../core/schemas/capability-vocabulary.ts";

export interface BackendManifestConfig {
  /** Non-secret installation identifier (I-TD7). */
  readonly backend_instance_id: string;
}

const MANIFEST_SCHEMA = "platform/backend-capability-manifest";

/** TD §12.3 — directional enforcement for the OpenClaw Backend v1 runtime, capability by capability. */
const RUNTIME_ENFORCEMENT: Readonly<Record<string, { allow: string; deny: string }>> = {
  "repository.read": { allow: "NOT_YET_AUDITED", deny: "NOT_YET_AUDITED" },
  "repository.feature_write": { allow: "AVAILABLE_WITH_REDUCED_ASSURANCE", deny: "NOT_YET_AUDITED" },
  "repository.canonical_write": { allow: "NOT_YET_AUDITED", deny: "UNENFORCEABLE_CAPABILITY_BOUNDARY" },
  "repository.merge": { allow: "NOT_YET_AUDITED", deny: "UNENFORCEABLE_CAPABILITY_BOUNDARY" },
  "repository.create_workspace": { allow: "NOT_YET_AUDITED", deny: "NOT_YET_AUDITED" },
  "shell.execute": { allow: "NOT_YET_AUDITED", deny: "NOT_YET_AUDITED" },
  "runtime.spawn_child": { allow: "NOT_YET_AUDITED", deny: "NOT_YET_AUDITED" },
  "remote.feature_push": { allow: "NOT_YET_AUDITED", deny: "NOT_YET_AUDITED" },
  "remote.canonical_push": { allow: "NOT_YET_AUDITED", deny: "NOT_YET_AUDITED" },
  "remote.create_pr": { allow: "NOT_YET_AUDITED", deny: "NOT_YET_AUDITED" },
  "destructive.git_clean": { allow: "NOT_YET_AUDITED", deny: "NOT_YET_AUDITED" },
  "destructive.reset_hard": { allow: "NOT_YET_AUDITED", deny: "NOT_YET_AUDITED" },
};

/** The production Backend v1 manifest set (OpenClaw runtime + durable-jobs + local git/verifier). */
export function backendV1Manifests(config: BackendManifestConfig): ManifestSetInput {
  // The table above must cover the vocabulary exactly; a drifted list is a build-time defect.
  for (const capability of CAPABILITY_NAMES) {
    if (RUNTIME_ENFORCEMENT[capability] === undefined) {
      throw new Error(`runtime enforcement table is missing ${capability}`);
    }
  }

  return {
    runtime: {
      schema: MANIFEST_SCHEMA,
      schema_version: 1,
      body: {
        backend_kind: "RUNTIME",
        adapter_id: "openclaw-runtime",
        adapter_version: "0.1.0",
        backend_instance_id: config.backend_instance_id,
        features: {
          persistent_session: true,
          structured_turn_result: "RESULT_CHANNEL",
          authoritative_session_identity: true,
        },
        receipt_supported: false,
        capability_enforcement: RUNTIME_ENFORCEMENT,
      },
    },
    workflow: {
      schema: MANIFEST_SCHEMA,
      schema_version: 1,
      body: {
        backend_kind: "WORKFLOW",
        adapter_id: "durable-jobs-workflow",
        adapter_version: "0.1.0",
        backend_instance_id: config.backend_instance_id,
        features: {
          journaled_store: true,
          idempotent_start: true,
          audit_gate: "DETERMINISTIC_ONLY",
          ownership_gate: "ENFORCED",
        },
      },
    },
    repository: {
      schema: MANIFEST_SCHEMA,
      schema_version: 1,
      body: {
        backend_kind: "REPOSITORY",
        adapter_id: "local-git-repository",
        adapter_version: "0.1.0",
        backend_instance_id: config.backend_instance_id,
        features: { worktree: true, lineage: true, ff_only: true },
      },
    },
    verification: {
      schema: MANIFEST_SCHEMA,
      schema_version: 1,
      body: {
        backend_kind: "VERIFICATION",
        adapter_id: "local-verification",
        adapter_version: "0.1.0",
        backend_instance_id: config.backend_instance_id,
        features: { reexecuted: true },
      },
    },
  };
}
