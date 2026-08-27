/**
 * MVP 1 artifact stores (TD §18.1c): adapter metadata, verification evidence and audit records.
 *
 * Two different kinds live here on purpose:
 *
 * - `adapter_metadata` is a **current projection** — upsertable, no hash, no state, no history.
 * - `verification_evidence` / `audit_record` are **immutable artifacts** — same identity with the
 *   same content is idempotent, different content fails closed, and there is no update or delete.
 *
 * None of them calls an adapter. The Coordinator supplies already-observed, already-validated
 * values; in particular `binding_valid` is the Coordinator's §15.2 revalidation result, never a
 * claim made by whoever produced the evidence.
 */

import { canonicalize, type CanonicalObject, type CanonicalValue } from "../schemas/canonical-json.ts";
import { isDigest } from "../schemas/digest.ts";
import { isUlid } from "../schemas/identifiers.ts";
import type { DatabaseSync } from "./database.ts";
import {
  AUDIT_VERDICTS,
  EVIDENCE_ASSURANCE_LEVELS,
  VERIFICATION_RESULTS,
  type AdapterMetadataRow,
  type AuditRecordRow,
  type AuditVerdictV1,
  type EvidenceAssuranceLevel,
  type VerificationEvidenceRow,
  type VerificationResult,
} from "./domain-types.ts";
import { StoreError } from "./errors.ts";
import { assertSameContent } from "./immutable-artifact.ts";
import { isSecretBearingKey } from "./restricted-key-denylist.ts";

const invalid = (detail: string): StoreError => new StoreError("DOMAIN_ROW_INVALID", detail);

// --- adapter_metadata ------------------------------------------------------------------

function assertNoSecretKeys(key: string, value: CanonicalValue): void {
  if (isSecretBearingKey(key)) {
    throw new StoreError(
      "DOMAIN_ROW_INVALID",
      `adapter metadata key ${JSON.stringify(key)} names a restricted identifier (I-TD7)`,
    );
  }
  walkKeys(value, (nested) => {
    if (isSecretBearingKey(nested)) {
      throw new StoreError(
        "DOMAIN_ROW_INVALID",
        `adapter metadata value contains the restricted key ${JSON.stringify(nested)} (I-TD7)`,
      );
    }
  });
}

function walkKeys(value: CanonicalValue, visit: (key: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, visit);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, nested] of Object.entries(value as CanonicalObject)) {
      visit(key);
      walkKeys(nested as CanonicalValue, visit);
    }
  }
}

export interface AdapterMetadataInput {
  readonly entity_key: string;
  readonly adapter_id: string;
  readonly key: string;
  readonly value: CanonicalValue;
}

export class AdapterMetadataStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /**
   * Records the current value for `(entity_key, adapter_id, key)`. This is a projection, so
   * writing a newer value over an older one is the normal case — there is no conflict rule and no
   * version to bump.
   */
  put(input: AdapterMetadataInput): AdapterMetadataRow {
    const entity_key = nonEmpty(input.entity_key, "entity_key");
    const adapter_id = nonEmpty(input.adapter_id, "adapter_id");
    const key = nonEmpty(input.key, "key");

    let valueJson: string;
    try {
      valueJson = canonicalize(input.value);
    } catch (error) {
      throw invalid(
        `adapter metadata value is not expressible in the §6 data model: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    assertNoSecretKeys(key, input.value);

    this.#database
      .prepare(
        `INSERT INTO adapter_metadata (entity_key, adapter_id, key, value_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (entity_key, adapter_id, key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(entity_key, adapter_id, key, valueJson);

    return { entity_key, adapter_id, key, value: input.value };
  }

  get(entityKey: string, adapterId: string, key: string): AdapterMetadataRow | undefined {
    const row = this.#database
      .prepare(
        "SELECT value_json FROM adapter_metadata WHERE entity_key = ? AND adapter_id = ? AND key = ?",
      )
      .get(entityKey, adapterId, key) as { value_json: string } | undefined;
    if (row === undefined) return undefined;
    return {
      entity_key: entityKey,
      adapter_id: adapterId,
      key,
      value: JSON.parse(row.value_json) as CanonicalValue,
    };
  }

  /** Every metadata entry attached to one Platform entity, in a deterministic order. */
  forEntity(entityKey: string): readonly AdapterMetadataRow[] {
    const rows = this.#database
      .prepare(
        `SELECT entity_key, adapter_id, key, value_json FROM adapter_metadata
          WHERE entity_key = ? ORDER BY adapter_id ASC, key ASC`,
      )
      .all(entityKey) as unknown as {
      entity_key: string;
      adapter_id: string;
      key: string;
      value_json: string;
    }[];
    return rows.map((row) => ({
      entity_key: row.entity_key,
      adapter_id: row.adapter_id,
      key: row.key,
      value: JSON.parse(row.value_json) as CanonicalValue,
    }));
  }

  count(): number {
    return countRows(this.#database, "adapter_metadata");
  }
}

// --- verification_evidence ---------------------------------------------------------------

/**
 * TD §15.2 — the `platform/verification-evidence` v1 body. Structurally the same shape the
 * VerificationAdapter interface declares; this is the Core-owned durable side of it.
 */
export interface VerificationEvidenceV1 {
  readonly evidence_id: string;
  readonly check_id: string;
  readonly result: VerificationResult;
  readonly assurance_level: EvidenceAssuranceLevel;
  readonly target_commit: string;
  readonly task_contract_hash: string;
  readonly executor_identity: string;
  readonly run_reference?: string;
  readonly artifact_digest?: string;
  readonly log_digest?: string;
  readonly timestamp: string;
}

export interface VerificationEvidenceInput {
  readonly attempt_key: string;
  readonly evidence: VerificationEvidenceV1;
  /** The Coordinator's §15.2 revalidation result — not the producer's claim (TD §18.1c). */
  readonly binding_valid: boolean;
}

export class VerificationEvidenceStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /** Immutable insert: identical content replays, different content under one id fails closed. */
  put(input: VerificationEvidenceInput): VerificationEvidenceRow {
    const row = validateEvidence(input);
    const envelopeJson = canonicalize(evidenceBody(input.evidence) as CanonicalValue);

    const existing = this.#raw(row.evidence_id);
    if (existing !== undefined) {
      assertSameContent(
        "verification evidence",
        row.evidence_id,
        canonicalize(rowProjection(existing.projection)),
        canonicalize(rowProjection(row)),
      );
      assertSameContent("verification evidence", row.evidence_id, existing.envelope_json, envelopeJson);
      return row;
    }

    this.#database
      .prepare(
        `INSERT INTO verification_evidence
           (evidence_id, attempt_key, check_id, result, assurance_level, target_commit,
            task_contract_hash, executor_identity, run_reference, artifact_digest, log_digest,
            timestamp, binding_valid, envelope_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.evidence_id,
        row.attempt_key,
        row.check_id,
        row.result,
        row.assurance_level,
        row.target_commit,
        row.task_contract_hash,
        row.executor_identity,
        row.run_reference,
        row.artifact_digest,
        row.log_digest,
        row.timestamp,
        row.binding_valid ? 1 : 0,
        envelopeJson,
      );
    return row;
  }

  get(evidenceId: string): VerificationEvidenceRow | undefined {
    const raw = this.#raw(evidenceId);
    return raw === undefined ? undefined : raw.projection;
  }

  /** The required read: every evidence row bound to one attempt (TD §18.1c). */
  forAttempt(attemptKey: string): readonly VerificationEvidenceRow[] {
    const rows = this.#database
      .prepare(`${EVIDENCE_COLUMNS} WHERE attempt_key = ? ORDER BY evidence_id ASC`)
      .all(attemptKey) as unknown as EvidenceDbRow[];
    return rows.map(toEvidenceRow);
  }

  /** The stored `platform/verification-evidence` v1 body. */
  envelope(evidenceId: string): VerificationEvidenceV1 | undefined {
    const raw = this.#raw(evidenceId);
    return raw === undefined ? undefined : (JSON.parse(raw.envelope_json) as VerificationEvidenceV1);
  }

  count(): number {
    return countRows(this.#database, "verification_evidence");
  }

  #raw(
    evidenceId: string,
  ): { projection: VerificationEvidenceRow; envelope_json: string } | undefined {
    const row = this.#database
      .prepare(`${EVIDENCE_WITH_ENVELOPE} WHERE evidence_id = ?`)
      .get(evidenceId) as (EvidenceDbRow & { envelope_json: string }) | undefined;
    return row === undefined
      ? undefined
      : { projection: toEvidenceRow(row), envelope_json: row.envelope_json };
  }
}

const EVIDENCE_FIELDS = `evidence_id, attempt_key, check_id, result, assurance_level,
       target_commit, task_contract_hash, executor_identity, run_reference, artifact_digest,
       log_digest, timestamp, binding_valid`;
const EVIDENCE_COLUMNS = `SELECT ${EVIDENCE_FIELDS} FROM verification_evidence`;
const EVIDENCE_WITH_ENVELOPE = `SELECT ${EVIDENCE_FIELDS}, envelope_json FROM verification_evidence`;

// --- audit_record ---------------------------------------------------------------------------

/** TD §16.2 — one entry of `findings`. */
export interface AuditorFindingV1 {
  readonly id: string;
  readonly severity: string;
  readonly description: string;
  readonly evidence_refs: readonly string[];
}

export const AUDITOR_FINDING_FIELDS: readonly string[] = [
  "id",
  "severity",
  "description",
  "evidence_refs",
];

/** TD §16.2 — what the Auditor says it judged on. Exactly three members. */
export interface AuditorReviewedV1 {
  readonly candidate_commit: string;
  readonly task_contract_hash: string;
  readonly evidence_ids: readonly string[];
}

export const AUDITOR_REVIEWED_FIELDS: readonly string[] = [
  "candidate_commit",
  "task_contract_hash",
  "evidence_ids",
];

/**
 * TD §16.2 — `platform-auditor-verdict-v1`.
 *
 * The field set is exact. §16.2 states outright that Git HEAD, Verification PASS and merge
 * eligibility "에 해당 필드 자체가 없다" — the Auditor may reference them but never declare them
 * (Spec §35) — so an envelope carrying any other top-level member is not this schema and is
 * rejected rather than trimmed.
 */
export interface AuditorVerdictV1 {
  readonly verdict: AuditVerdictV1;
  readonly findings: readonly AuditorFindingV1[];
  /** TD §16.2: present when the verdict is `FIX_REQUIRED`. Item shape is not fixed by the TD. */
  readonly required_fix?: readonly CanonicalValue[];
  readonly reviewed: AuditorReviewedV1;
}

export const AUDITOR_VERDICT_FIELDS: readonly string[] = [
  "verdict",
  "findings",
  "required_fix",
  "reviewed",
];

export interface AuditRecordInput {
  readonly audit_id: string;
  readonly attempt_key: string;
  readonly candidate_commit: string;
  readonly task_contract_hash: string;
  /** Already validated per §16.2; a malformed envelope never becomes a record (TD §18.1c). */
  readonly envelope: AuditorVerdictV1;
  readonly workflow_ref?: string;
  readonly committed_via: string;
  readonly recorded_at: string;
}

export class AuditRecordStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /**
   * Immutable insert. Several audit cycles may exist for one attempt (rework, re-audit), so there
   * is deliberately no uniqueness on `attempt_key` — each cycle carries its own `audit_id`.
   */
  put(input: AuditRecordInput): AuditRecordRow {
    // The durable copy is the *validated* envelope (TD §18.1c), never the caller's raw object.
    const { row, envelope } = validateAudit(input);
    const envelopeJson = canonicalize(envelope as unknown as CanonicalValue);

    const existing = this.#raw(row.audit_id);
    if (existing !== undefined) {
      assertSameContent(
        "audit record",
        row.audit_id,
        canonicalize(existing.projection as unknown as CanonicalValue),
        canonicalize(row as unknown as CanonicalValue),
      );
      assertSameContent("audit record", row.audit_id, existing.envelope_json, envelopeJson);
      return row;
    }

    this.#database
      .prepare(
        `INSERT INTO audit_record
           (audit_id, attempt_key, candidate_commit, task_contract_hash, verdict, envelope_json,
            workflow_ref, committed_via, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.audit_id,
        row.attempt_key,
        row.candidate_commit,
        row.task_contract_hash,
        row.verdict,
        envelopeJson,
        row.workflow_ref,
        row.committed_via,
        row.recorded_at,
      );
    return row;
  }

  get(auditId: string): AuditRecordRow | undefined {
    return this.#raw(auditId)?.projection;
  }

  /** Every audit cycle of one attempt, oldest identity first. */
  forAttempt(attemptKey: string): readonly AuditRecordRow[] {
    const rows = this.#database
      .prepare(`${AUDIT_COLUMNS} WHERE attempt_key = ? ORDER BY audit_id ASC`)
      .all(attemptKey) as unknown as AuditDbRow[];
    return rows.map(toAuditRow);
  }

  envelope(auditId: string): AuditorVerdictV1 | undefined {
    const raw = this.#raw(auditId);
    return raw === undefined ? undefined : (JSON.parse(raw.envelope_json) as AuditorVerdictV1);
  }

  count(): number {
    return countRows(this.#database, "audit_record");
  }

  #raw(auditId: string): { projection: AuditRecordRow; envelope_json: string } | undefined {
    const row = this.#database
      .prepare(`${AUDIT_WITH_ENVELOPE} WHERE audit_id = ?`)
      .get(auditId) as (AuditDbRow & { envelope_json: string }) | undefined;
    return row === undefined
      ? undefined
      : { projection: toAuditRow(row), envelope_json: row.envelope_json };
  }
}

const AUDIT_FIELDS = `audit_id, attempt_key, candidate_commit, task_contract_hash, verdict,
       workflow_ref, committed_via, recorded_at`;
const AUDIT_COLUMNS = `SELECT ${AUDIT_FIELDS} FROM audit_record`;
const AUDIT_WITH_ENVELOPE = `SELECT ${AUDIT_FIELDS}, envelope_json FROM audit_record`;

// --- validation ---------------------------------------------------------------------------------

function validateEvidence(input: VerificationEvidenceInput): VerificationEvidenceRow {
  const evidence = input.evidence;
  if (typeof input.binding_valid !== "boolean") {
    throw invalid("binding_valid must be a boolean the Coordinator computed (§15.2)");
  }
  if (!isUlid(evidence.evidence_id)) throw invalid("evidence_id must be a ULID");
  if (!VERIFICATION_RESULTS.includes(evidence.result)) {
    throw invalid(`result must be one of ${VERIFICATION_RESULTS.join(", ")}`);
  }
  if (!EVIDENCE_ASSURANCE_LEVELS.includes(evidence.assurance_level)) {
    throw invalid(`assurance_level must be one of ${EVIDENCE_ASSURANCE_LEVELS.join(", ")}`);
  }
  if (!isDigest(evidence.task_contract_hash)) {
    throw invalid("task_contract_hash must be sha256:<lowercase-hex>");
  }
  for (const digest of [evidence.artifact_digest, evidence.log_digest]) {
    if (digest !== undefined && !isDigest(digest)) {
      throw invalid("an optional digest must be sha256:<lowercase-hex> when present");
    }
  }

  return {
    evidence_id: evidence.evidence_id,
    attempt_key: nonEmpty(input.attempt_key, "attempt_key"),
    check_id: nonEmpty(evidence.check_id, "check_id"),
    result: evidence.result,
    assurance_level: evidence.assurance_level,
    target_commit: nonEmpty(evidence.target_commit, "target_commit"),
    task_contract_hash: evidence.task_contract_hash,
    executor_identity: nonEmpty(evidence.executor_identity, "executor_identity"),
    run_reference: optional(evidence.run_reference, "run_reference"),
    artifact_digest: evidence.artifact_digest ?? null,
    log_digest: evidence.log_digest ?? null,
    timestamp: nonEmpty(evidence.timestamp, "timestamp"),
    binding_valid: input.binding_valid,
  };
}

/**
 * TD §16.2 — the full `platform-auditor-verdict-v1` validator. An envelope that does not satisfy
 * this is not a verdict at all, so it can never reach `audit_record` (TD §18.1c: only a validated
 * verdict is promoted). The Coordinator records such an attempt as `AUDIT_INVALID` in the
 * decision journal instead; that mapping belongs to the Auditor orchestration, not to this store.
 */
export function validateAuditorVerdict(input: unknown): AuditorVerdictV1 {
  const envelope = asObject(input, "the auditor verdict envelope");
  exactFields(envelope, AUDITOR_VERDICT_FIELDS, "the auditor verdict envelope", ["required_fix"]);

  const verdict = envelope["verdict"];
  if (!AUDIT_VERDICTS.includes(verdict as AuditVerdictV1)) {
    throw invalid(`verdict must be one of ${AUDIT_VERDICTS.join(", ")}`);
  }

  const findings = validateFindings(envelope["findings"]);

  // §16.2 states the conditional in one direction only: required_fix is present for FIX_REQUIRED.
  let required_fix: readonly CanonicalValue[] | undefined;
  if (Object.hasOwn(envelope, "required_fix")) {
    if (!Array.isArray(envelope["required_fix"])) throw invalid("required_fix must be an array");
    required_fix = envelope["required_fix"] as readonly CanonicalValue[];
  } else if (verdict === "FIX_REQUIRED") {
    throw invalid("a FIX_REQUIRED verdict must carry required_fix (§16.2)");
  }

  const reviewed = validateReviewed(envelope["reviewed"]);

  return required_fix === undefined
    ? { verdict: verdict as AuditVerdictV1, findings, reviewed }
    : { verdict: verdict as AuditVerdictV1, findings, required_fix, reviewed };
}

function validateFindings(value: unknown): readonly AuditorFindingV1[] {
  if (!Array.isArray(value)) throw invalid("findings must be an array (§16.2)");
  return value.map((item, index) => {
    const finding = asObject(item, `findings/${index}`);
    exactFields(finding, AUDITOR_FINDING_FIELDS, `findings/${index}`);
    const refs = finding["evidence_refs"];
    if (!Array.isArray(refs)) throw invalid(`findings/${index}/evidence_refs must be an array`);
    return {
      id: nonEmpty(finding["id"], `findings/${index}/id`),
      severity: nonEmpty(finding["severity"], `findings/${index}/severity`),
      description: nonEmpty(finding["description"], `findings/${index}/description`),
      evidence_refs: refs.map((ref, at) =>
        nonEmpty(ref, `findings/${index}/evidence_refs/${at}`),
      ),
    };
  });
}

function validateReviewed(value: unknown): AuditorReviewedV1 {
  const reviewed = asObject(value, "reviewed");
  exactFields(reviewed, AUDITOR_REVIEWED_FIELDS, "reviewed");

  const task_contract_hash = reviewed["task_contract_hash"];
  if (typeof task_contract_hash !== "string" || !isDigest(task_contract_hash)) {
    throw invalid("reviewed.task_contract_hash must be sha256:<lowercase-hex>");
  }

  const ids = reviewed["evidence_ids"];
  if (!Array.isArray(ids)) throw invalid("reviewed.evidence_ids must be an array (§16.2)");
  const evidence_ids = ids.map((id, index) => {
    // §15.2 gives every evidence a ULID identity, so a reference must look like one.
    if (typeof id !== "string" || !isUlid(id)) {
      throw invalid(`reviewed.evidence_ids/${index} must be an evidence ULID`);
    }
    return id;
  });

  return {
    candidate_commit: nonEmpty(reviewed["candidate_commit"], "reviewed.candidate_commit"),
    task_contract_hash,
    evidence_ids,
  };
}

function validateAudit(input: AuditRecordInput): {
  readonly row: AuditRecordRow;
  readonly envelope: AuditorVerdictV1;
} {
  if (!isUlid(input.audit_id)) throw invalid("audit_id must be a ULID");

  // Full §16.2 validation first — nothing malformed gets as far as the projection comparison.
  const envelope = validateAuditorVerdict(input.envelope);

  const candidate_commit = nonEmpty(input.candidate_commit, "candidate_commit");
  const task_contract_hash = input.task_contract_hash;
  if (!isDigest(task_contract_hash)) {
    throw invalid("task_contract_hash must be sha256:<lowercase-hex>");
  }

  // §16.2 — `reviewed.*` must match the attempt's authoritative values exactly.
  if (envelope.reviewed.candidate_commit !== candidate_commit) {
    throw invalid("reviewed.candidate_commit does not match the attempt's candidate");
  }
  if (envelope.reviewed.task_contract_hash !== task_contract_hash) {
    throw invalid("reviewed.task_contract_hash does not match the attempt's contract");
  }

  const row: AuditRecordRow = {
    audit_id: input.audit_id,
    attempt_key: nonEmpty(input.attempt_key, "attempt_key"),
    candidate_commit,
    task_contract_hash,
    // AV9 — the row's verdict is *taken from* the validated envelope, so the two cannot diverge.
    verdict: envelope.verdict,
    workflow_ref: optional(input.workflow_ref, "workflow_ref"),
    committed_via: nonEmpty(input.committed_via, "committed_via"),
    recorded_at: nonEmpty(input.recorded_at, "recorded_at"),
  };
  return { row, envelope };
}

// --- helpers -------------------------------------------------------------------------------------

interface EvidenceDbRow {
  evidence_id: string;
  attempt_key: string;
  check_id: string;
  result: VerificationResult;
  assurance_level: EvidenceAssuranceLevel;
  target_commit: string;
  task_contract_hash: string;
  executor_identity: string;
  run_reference: string | null;
  artifact_digest: string | null;
  log_digest: string | null;
  timestamp: string;
  binding_valid: number;
}

interface AuditDbRow {
  audit_id: string;
  attempt_key: string;
  candidate_commit: string;
  task_contract_hash: string;
  verdict: AuditVerdictV1;
  workflow_ref: string | null;
  committed_via: string;
  recorded_at: string;
}

const toEvidenceRow = (row: EvidenceDbRow): VerificationEvidenceRow => ({
  evidence_id: row.evidence_id,
  attempt_key: row.attempt_key,
  check_id: row.check_id,
  result: row.result,
  assurance_level: row.assurance_level,
  target_commit: row.target_commit,
  task_contract_hash: row.task_contract_hash,
  executor_identity: row.executor_identity,
  run_reference: row.run_reference,
  artifact_digest: row.artifact_digest,
  log_digest: row.log_digest,
  timestamp: row.timestamp,
  binding_valid: row.binding_valid === 1,
});

const toAuditRow = (row: AuditDbRow): AuditRecordRow => ({
  audit_id: row.audit_id,
  attempt_key: row.attempt_key,
  candidate_commit: row.candidate_commit,
  task_contract_hash: row.task_contract_hash,
  verdict: row.verdict,
  workflow_ref: row.workflow_ref,
  committed_via: row.committed_via,
  recorded_at: row.recorded_at,
});

/** The §15.2 body, with absent optionals omitted rather than stored as null. */
function evidenceBody(evidence: VerificationEvidenceV1): CanonicalObject {
  const body: Record<string, unknown> = {
    evidence_id: evidence.evidence_id,
    check_id: evidence.check_id,
    result: evidence.result,
    assurance_level: evidence.assurance_level,
    target_commit: evidence.target_commit,
    task_contract_hash: evidence.task_contract_hash,
    executor_identity: evidence.executor_identity,
    timestamp: evidence.timestamp,
  };
  if (evidence.run_reference !== undefined) body["run_reference"] = evidence.run_reference;
  if (evidence.artifact_digest !== undefined) body["artifact_digest"] = evidence.artifact_digest;
  if (evidence.log_digest !== undefined) body["log_digest"] = evidence.log_digest;
  return body as CanonicalObject;
}

const rowProjection = (row: VerificationEvidenceRow): CanonicalValue =>
  ({ ...row }) as unknown as CanonicalValue;

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Every required field present, nothing unknown — the §16.2 field set is exact. */
function exactFields(
  object: Record<string, unknown>,
  fields: readonly string[],
  where: string,
  optionalFields: readonly string[] = [],
): void {
  for (const field of fields) {
    if (optionalFields.includes(field)) continue;
    if (!Object.hasOwn(object, field)) throw invalid(`${where} is missing "${field}"`);
  }
  for (const key of Object.keys(object)) {
    if (!fields.includes(key)) throw invalid(`${where} has unknown field "${key}"`);
  }
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`${field} must be a non-empty string`);
  }
  return value;
}

function optional(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  return nonEmpty(value, field);
}

function countRows(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}
