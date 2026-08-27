/**
 * Capability Broker — CapabilityGrant v1 construction (TD §12.5, §12.7).
 *
 * Pure composition: validate → derive requested → derive enforcement → build body → hash. No
 * clock, no randomness, no store, no adapter call. `grant_id` is supplied by the caller precisely
 * so this stays deterministic; Batch 5 does not decide who allocates ULIDs.
 */

import { hashEnvelope, makeEnvelope, type SchemaEnvelope } from "../schemas/envelope.ts";
import { isUlid } from "../schemas/identifiers.ts";
import type { CanonicalObject } from "../schemas/canonical-json.ts";
import type { ExecutionPolicyV1Body } from "../profile/types.ts";
import { deriveEnforcement, deriveRequestedCapabilities } from "./derive.ts";
import { grantError } from "./errors.ts";
import { hashManifest } from "./validate-manifest.ts";
import {
  CAPABILITY_GRANT_SCHEMA,
  CORE_EXECUTION_ROLES,
  type CapabilityGrantV1Body,
  type CoreExecutionRole,
  type RuntimeManifestBody,
  type TaskContractCapabilityView,
  type ValidatedManifest,
} from "./types.ts";

export interface BrokerInput {
  /** Caller-supplied ULID — the Broker never generates identity. */
  readonly grant_id: string;
  readonly role: CoreExecutionRole;
  readonly effective_policy: ExecutionPolicyV1Body;
  readonly runtime_manifest: ValidatedManifest<RuntimeManifestBody>;
  /**
   * TD §12.7 seam — **required**, so the finalization order holds at the type level: the B6 Task
   * Contract builder must construct the view before a grant can be issued, and no caller can
   * bypass the seam by omitting it.
   *
   * v1 capability derivation does not read its contents; no path→capability inference exists. If a
   * future revision adds task-specific restriction here, existing callers already supply it.
   */
  readonly task_contract_capability_view: TaskContractCapabilityView;
}

export interface CapabilityGrantResult {
  readonly envelope: SchemaEnvelope<CanonicalObject>;
  readonly grant_hash: string;
  readonly body: CapabilityGrantV1Body;
}

export function issueCapabilityGrant(input: BrokerInput): CapabilityGrantResult {
  if (!isUlid(input.grant_id)) {
    throw grantError("/grant_id", `expected a ULID, got ${JSON.stringify(input.grant_id)}`);
  }
  if (!(CORE_EXECUTION_ROLES as readonly string[]).includes(input.role)) {
    throw grantError("/role", `expected one of ${CORE_EXECUTION_ROLES.join(" | ")}`);
  }
  if (input.runtime_manifest.body.backend_kind !== "RUNTIME") {
    throw grantError("/runtime_manifest", "expected a RUNTIME manifest");
  }

  const requested = deriveRequestedCapabilities(input.effective_policy, input.role);
  const enforcement = deriveEnforcement(requested, input.runtime_manifest.body);

  const body: CapabilityGrantV1Body = {
    grant_id: input.grant_id,
    role: input.role,
    // Recomputed from the validated body so a caller cannot bind an arbitrary hash.
    source_runtime_manifest_hash: hashManifest(input.runtime_manifest.body),
    requested,
    enforcement,
  };

  // grant_hash is the envelope hash; it is deliberately not a member of the body.
  const envelope = makeEnvelope(CAPABILITY_GRANT_SCHEMA, 1, body as unknown as CanonicalObject);
  return { envelope, grant_hash: hashEnvelope(envelope), body };
}
