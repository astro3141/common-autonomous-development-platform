/**
 * ChildTaskMaterializationSnapshotV1 (TD §8.4b/§18.1g, D24 — prospective MVP 3).
 *
 * The immutable pre-effect authority of one bounded child materialisation: the validated
 * Supervisor semantics (complete child body + explicit parent intent) frozen as a typed envelope
 * *before* any external effect, so a restart reconstructs the exact request from durable state —
 * never from a log scan or raw Model output. `materialization_id` is the accepted F Proposal's
 * Platform-assigned `proposal_id`; no new identity service exists. Operation status stays with
 * the existing idempotency record; audit/provenance events stay with `decision_log`.
 */

import { hashTaskDefinitionBody, normalizeTaskDefinitionBody } from "../tasksource/task-definition.ts";
import type { CanonicalObject } from "../schemas/canonical-json.ts";
import { hashEnvelope, makeEnvelope, type SchemaEnvelope } from "../schemas/envelope.ts";
import { isUlid } from "../schemas/identifiers.ts";

export const CHILD_MATERIALIZATION_SCHEMA = "platform/child-task-materialization";

/** §9.1 F — the exact tagged parent intent, frozen verbatim from the validated Proposal. */
export type MaterializationParentIntentV1 =
  | {
      readonly kind: "DISCOVERED_TASK";
      readonly task_key: string;
      readonly task_ref: string;
      readonly task_version: string;
      readonly task_definition_hash: string;
    }
  | {
      readonly kind: "ACTIVE_ATTEMPT";
      readonly task_key: string;
      readonly attempt_key: string;
      readonly task_contract_hash: string;
      readonly attempt_state: string;
    };

export interface ChildTaskMaterializationSnapshotV1 {
  readonly materialization_id: string;
  readonly batch_id: string;
  readonly compiled_profile_hash: string;
  /** The Compiled Profile v3's sole configured source — never a Model selection. */
  readonly task_source_id: string;
  readonly parent_intent: MaterializationParentIntentV1;
  readonly child_definition_body: CanonicalObject;
  /** §8.1a envelope hash of the child body, Platform-computed. */
  readonly child_definition_hash: string;
  /** Order-sensitive immutable copy of the Proposal's reason_refs. */
  readonly reason_refs: readonly string[];
}

export interface SealedMaterializationSnapshot {
  readonly envelope: SchemaEnvelope<CanonicalObject>;
  readonly hash: string;
  readonly body: ChildTaskMaterializationSnapshotV1;
}

/** Validates and seals the exact snapshot body; the hash is the envelope hash (§6). */
export function sealMaterializationSnapshot(input: ChildTaskMaterializationSnapshotV1): SealedMaterializationSnapshot {
  if (!isUlid(input.materialization_id)) {
    throw new Error("materialization_id must be the accepted Proposal's ULID");
  }
  // The body is re-normalized and re-hashed here so no caller-supplied hash is ever trusted.
  const body = normalizeTaskDefinitionBody(input.child_definition_body, "/child_definition_body");
  const child_definition_hash = hashTaskDefinitionBody(body);
  if (child_definition_hash !== input.child_definition_hash) {
    throw new Error("child_definition_hash does not match the Platform-computed body hash");
  }
  const exact: ChildTaskMaterializationSnapshotV1 = {
    materialization_id: input.materialization_id,
    batch_id: input.batch_id,
    compiled_profile_hash: input.compiled_profile_hash,
    task_source_id: input.task_source_id,
    parent_intent: input.parent_intent,
    child_definition_body: body as unknown as CanonicalObject,
    child_definition_hash,
    reason_refs: [...input.reason_refs],
  };
  const envelope = makeEnvelope(CHILD_MATERIALIZATION_SCHEMA, 1, exact as unknown as CanonicalObject);
  return { envelope, hash: hashEnvelope(envelope), body: exact };
}

/** The stable §21 external operation identity. */
export const materializeChildOp = (batch_id: string, materialization_id: string): string =>
  `op:${batch_id}:materialize-child:${materialization_id}`;
