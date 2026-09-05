/**
 * Constitutional Store (TD §3) — single-host harness backend: SQLite (WAL, BEGIN IMMEDIATE),
 * the TD §3.1 alternative to PostgreSQL 16. The store contract is what matters:
 * transactional insert + unique constraints, a single-writer primitive per effect_id,
 * durable commit, and no runtime UPDATE/DELETE — this module contains no UPDATE or DELETE
 * statement on any constitutional table (§2.4; the DB role restriction of the Postgres
 * reference is enforced here at the adapter layer).
 */

import { DatabaseSync } from "node:sqlite";

import { jcs } from "./canonical.ts";
import type { Digest } from "./canonical.ts";
import type { AdmissionInputV1, EffectAdmissionV1, EffectOutcomeV1, EffectRequestV1, EvidenceEnvelopeV1, PolicyDecisionV1, PolicyRefV1 } from "./records.ts";

const BASE_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS policy_ref (
  policy_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  issuer_ref TEXT NOT NULL,
  bundle_cas_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  manifest_revision TEXT NOT NULL,
  PRIMARY KEY (policy_id, revision)
);

CREATE TABLE IF NOT EXISTS policy_activation (
  seq INTEGER PRIMARY KEY,
  expected_prev_seq INTEGER NOT NULL UNIQUE,
  policy_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  activated_by_ref TEXT NOT NULL,
  activation_evidence_id TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  CHECK (seq = expected_prev_seq + 1)
);

CREATE TABLE IF NOT EXISTS evidence_envelope (
  evidence_id TEXT PRIMARY KEY,
  envelope_digest TEXT NOT NULL UNIQUE,
  evidence_kind TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  work_run_ref TEXT,
  step_ordinal INTEGER,
  producer_ref TEXT,
  source_ref TEXT,
  edge_evidence_id TEXT,
  edge_envelope_digest TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_kind_idx ON evidence_envelope (evidence_kind);
CREATE UNIQUE INDEX IF NOT EXISTS work_step_unique
  ON evidence_envelope (work_run_ref, step_ordinal) WHERE evidence_kind = 'WORK_STEP';

CREATE TABLE IF NOT EXISTS evidence_subject (
  evidence_id TEXT NOT NULL,
  subject_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_subject_idx ON evidence_subject (subject_key);

CREATE TABLE IF NOT EXISTS effect_allocation (
  allocation_key TEXT PRIMARY KEY,
  effect_id TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS effect_request (
  effect_id TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL,
  material_cas_key TEXT NOT NULL,
  work_run_ref TEXT
);
CREATE INDEX IF NOT EXISTS effect_request_run_idx ON effect_request (work_run_ref);

CREATE TABLE IF NOT EXISTS admission_input (
  input_digest TEXT PRIMARY KEY,
  effect_id TEXT NOT NULL REFERENCES effect_request(effect_id),
  policy_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  input_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_decision (
  decision_id TEXT PRIMARY KEY,
  decision_digest TEXT NOT NULL UNIQUE,
  admission_input_digest TEXT NOT NULL REFERENCES admission_input(input_digest),
  outcome TEXT NOT NULL,
  not_after TEXT,
  decision_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS effect_admission (
  admission_id TEXT PRIMARY KEY,
  admission_digest TEXT NOT NULL UNIQUE,
  effect_id TEXT NOT NULL,
  dispatch_ordinal INTEGER NOT NULL,
  effect_request_digest TEXT NOT NULL,
  policy_decision_ref TEXT NOT NULL,
  admission_json TEXT NOT NULL,
  UNIQUE (effect_id, dispatch_ordinal)
);

CREATE TABLE IF NOT EXISTS effect_outcome (
  outcome_id TEXT PRIMARY KEY,
  outcome_digest TEXT NOT NULL UNIQUE,
  effect_id TEXT NOT NULL,
  admission_digest TEXT NOT NULL,
  result TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  outcome_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS effect_outcome_effect_idx ON effect_outcome (effect_id);

CREATE TABLE IF NOT EXISTS cas_blob (
  digest_key TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`;

/**
 * v1.1 governed-writer constraints (TD §3.2 delta, #117 §5.3): the constraint-level backstop to the
 * two transactional lookups, exactly as `work_step_unique` backstops `insertWorkStep` (C33).
 * (a) replay idempotency on the effect-bound `source_ref`; (b) at most ONE governed outgoing edge
 * per predecessor, for all time — the invariant no admission-time evidence list can bypass. Both
 * are partial indexes scoped to the reserved governed producer constant (invariant P), so every
 * other producer's rows are unconstrained exactly as before.
 */
const GOVERNED_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS governed_replay_unique
  ON evidence_envelope (producer_ref, source_ref) WHERE producer_ref = 'governed:reclassification';
CREATE UNIQUE INDEX IF NOT EXISTS governed_edge_unique
  ON evidence_envelope (producer_ref, edge_evidence_id, edge_envelope_digest)
  WHERE producer_ref = 'governed:reclassification' AND edge_evidence_id IS NOT NULL;
`;

export interface ActivationRow {
  readonly seq: number;
  readonly expected_prev_seq: number;
  readonly policy_id: string;
  readonly revision: number;
  readonly content_digest: string;
  readonly activated_by_ref: string;
  readonly activation_evidence_id: string;
  readonly activated_at: string;
}

export interface PolicyRefRow {
  readonly policy_id: string;
  readonly revision: number;
  readonly content_digest: string;
  readonly issuer_ref: string;
  readonly bundle_cas_key: string;
  readonly payload_digest: string;
  readonly manifest_revision: string;
}

export class UniqueViolation extends Error {
  readonly constraint: string;
  constructor(constraint: string) {
    super(`unique constraint violated: ${constraint}`);
    this.constraint = constraint;
  }
}

function mapSqliteError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed: (.+)/u.test(message)) {
      throw new UniqueViolation(/UNIQUE constraint failed: (.+)/u.exec(message)![1]!);
    }
    throw error;
  }
}

export class ConstitutionalStore {
  readonly db: DatabaseSync;

  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 10000;");
    this.db.exec(BASE_DDL);
    // `CREATE TABLE IF NOT EXISTS` leaves a pre-v1.1 evidence_envelope untouched, so the governed
    // columns are added idempotently before the indexes that key on them. Append-only: no existing
    // row is rewritten and every added column is nullable (§2.4 — no UPDATE/DELETE anywhere).
    const columns = new Set(
      (this.db.prepare("SELECT name FROM pragma_table_info('evidence_envelope')").all() as Array<{ name: string }>).map((r) => r.name),
    );
    for (const column of ["producer_ref", "source_ref", "edge_evidence_id", "edge_envelope_digest"]) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE evidence_envelope ADD COLUMN ${column} TEXT`);
    }
    this.db.exec(GOVERNED_DDL);
  }

  close(): void {
    this.db.close();
  }

  /** BEGIN IMMEDIATE transaction (TD §3.4 SQLite variant). Synchronous body only. */
  withImmediate<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }

  // -------------------------------------------------------------- policy

  insertPolicyRef(row: PolicyRefRow): void {
    mapSqliteError(() =>
      this.db
        .prepare(
          `INSERT INTO policy_ref (policy_id, revision, content_digest, issuer_ref, bundle_cas_key, payload_digest, manifest_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(row.policy_id, row.revision, row.content_digest, row.issuer_ref, row.bundle_cas_key, row.payload_digest, row.manifest_revision),
    );
  }

  policyRef(policy_id: string, revision: number): PolicyRefRow | undefined {
    return this.db
      .prepare("SELECT * FROM policy_ref WHERE policy_id = ? AND revision = ?")
      .get(policy_id, revision) as PolicyRefRow | undefined;
  }

  insertActivation(row: ActivationRow): void {
    mapSqliteError(() =>
      this.db
        .prepare(
          `INSERT INTO policy_activation (seq, expected_prev_seq, policy_id, revision, content_digest, activated_by_ref, activation_evidence_id, activated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(row.seq, row.expected_prev_seq, row.policy_id, row.revision, row.content_digest, row.activated_by_ref, row.activation_evidence_id, row.activated_at),
    );
  }

  activeActivation(): ActivationRow | undefined {
    return this.db.prepare("SELECT * FROM policy_activation ORDER BY seq DESC LIMIT 1").get() as ActivationRow | undefined;
  }

  activationBySeq(seq: number): ActivationRow | undefined {
    return this.db.prepare("SELECT * FROM policy_activation WHERE seq = ?").get(seq) as ActivationRow | undefined;
  }

  // -------------------------------------------------------------- evidence

  insertEvidence(
    envelope: EvidenceEnvelopeV1,
    received_at: string,
    work_run_ref?: string,
    step_ordinal?: number,
    /** The v1.1 governed-edge key T(F), derived by the STORE from the draft's own supersedes singleton. */
    governed_edge?: { evidence_id: string; envelope_digest: string },
  ): void {
    mapSqliteError(() => {
      this.db
        .prepare(
          `INSERT INTO evidence_envelope (evidence_id, envelope_digest, evidence_kind, envelope_json, work_run_ref, step_ordinal, producer_ref, source_ref, edge_evidence_id, edge_envelope_digest, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          envelope.evidence_id, envelope.envelope_digest.value, envelope.evidence_kind, jcs(envelope),
          work_run_ref ?? null, step_ordinal ?? null, envelope.producer_ref, envelope.source_ref,
          governed_edge?.evidence_id ?? null, governed_edge?.envelope_digest ?? null, received_at,
        );
      const subject = this.db.prepare("INSERT INTO evidence_subject (evidence_id, subject_key) VALUES (?, ?)");
      for (const b of envelope.subject_bindings) {
        subject.run(envelope.evidence_id, `${b.authority_ref}|${b.namespace}|${b.object_id}`);
      }
    });
  }

  /** §5.3 rule (a): the registry-opted replay key (producer_ref, source_ref = cadp-v04:<effect_id>). */
  evidenceByProducerSourceRef(producer_ref: string, source_ref: string): EvidenceEnvelopeV1 | undefined {
    const row = this.db
      .prepare("SELECT envelope_json FROM evidence_envelope WHERE producer_ref = ? AND source_ref = ?")
      .get(producer_ref, source_ref) as { envelope_json: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.envelope_json) as EvidenceEnvelopeV1);
  }

  /** §5.3 rule (b) / invariant U: the single governed outgoing edge of a predecessor, if any. */
  evidenceByGovernedEdge(producer_ref: string, edge_evidence_id: string, edge_envelope_digest: string): EvidenceEnvelopeV1 | undefined {
    const row = this.db
      .prepare("SELECT envelope_json FROM evidence_envelope WHERE producer_ref = ? AND edge_evidence_id = ? AND edge_envelope_digest = ?")
      .get(producer_ref, edge_evidence_id, edge_envelope_digest) as { envelope_json: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.envelope_json) as EvidenceEnvelopeV1);
  }

  /** Every governed envelope naming this predecessor — the invariant-U count control (FC15). */
  governedEdgeCount(producer_ref: string, edge_evidence_id: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM evidence_envelope WHERE producer_ref = ? AND edge_evidence_id = ?")
      .get(producer_ref, edge_evidence_id) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  evidenceById(evidence_id: string): EvidenceEnvelopeV1 | undefined {
    const row = this.db.prepare("SELECT envelope_json FROM evidence_envelope WHERE evidence_id = ?").get(evidence_id) as
      | { envelope_json: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.envelope_json) as EvidenceEnvelopeV1);
  }

  workStepByOrdinal(work_run_ref: string, step_ordinal: number): EvidenceEnvelopeV1 | undefined {
    const row = this.db
      .prepare("SELECT envelope_json FROM evidence_envelope WHERE evidence_kind = 'WORK_STEP' AND work_run_ref = ? AND step_ordinal = ?")
      .get(work_run_ref, step_ordinal) as { envelope_json: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.envelope_json) as EvidenceEnvelopeV1);
  }

  latestEvidenceOfKind(evidence_kind: string, subject_key?: string): EvidenceEnvelopeV1 | undefined {
    const row = (subject_key === undefined
      ? this.db
          .prepare("SELECT envelope_json FROM evidence_envelope WHERE evidence_kind = ? ORDER BY received_at DESC, rowid DESC LIMIT 1")
          .get(evidence_kind)
      : this.db
          .prepare(
            `SELECT e.envelope_json FROM evidence_envelope e JOIN evidence_subject s ON s.evidence_id = e.evidence_id
             WHERE e.evidence_kind = ? AND s.subject_key = ? ORDER BY e.received_at DESC, e.rowid DESC LIMIT 1`,
          )
          .get(evidence_kind, subject_key)) as { envelope_json: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.envelope_json) as EvidenceEnvelopeV1);
  }

  /** Open KERNEL_INCIDENT envelopes (not yet released by a BREAK_GLASS release naming them). */
  openIncidents(): EvidenceEnvelopeV1[] {
    const incidents = this.db
      .prepare("SELECT envelope_json FROM evidence_envelope WHERE evidence_kind = 'KERNEL_INCIDENT' ORDER BY rowid")
      .all() as Array<{ envelope_json: string }>;
    const releases = this.db
      .prepare("SELECT envelope_json FROM evidence_envelope WHERE evidence_kind = 'BREAK_GLASS' ORDER BY rowid")
      .all() as Array<{ envelope_json: string }>;
    const released = new Set<string>();
    for (const r of releases) {
      const env = JSON.parse(r.envelope_json) as EvidenceEnvelopeV1;
      const claim = env.claim as { release_incident_refs?: Array<{ evidence_id: string }> } | undefined;
      for (const ref of claim?.release_incident_refs ?? []) released.add(ref.evidence_id);
    }
    return incidents
      .map((r) => JSON.parse(r.envelope_json) as EvidenceEnvelopeV1)
      .filter((env) => !released.has(env.evidence_id));
  }

  // -------------------------------------------------------------- allocation / request

  insertAllocation(allocation_key: string, effect_id: string): void {
    mapSqliteError(() =>
      this.db.prepare("INSERT INTO effect_allocation (allocation_key, effect_id) VALUES (?, ?)").run(allocation_key, effect_id),
    );
  }

  allocationByKey(allocation_key: string): string | undefined {
    const row = this.db.prepare("SELECT effect_id FROM effect_allocation WHERE allocation_key = ?").get(allocation_key) as
      | { effect_id: string }
      | undefined;
    return row?.effect_id;
  }

  insertEffectRequest(request: EffectRequestV1, material_cas_key: string, work_run_ref?: string): void {
    mapSqliteError(() =>
      this.db
        .prepare(
          "INSERT INTO effect_request (effect_id, request_digest, request_json, material_cas_key, work_run_ref) VALUES (?, ?, ?, ?, ?)",
        )
        .run(request.effect_id, request.request_digest.value, jcs(request), material_cas_key, work_run_ref ?? null),
    );
  }

  effectRequest(effect_id: string): EffectRequestV1 | undefined {
    const row = this.db.prepare("SELECT request_json FROM effect_request WHERE effect_id = ?").get(effect_id) as
      | { request_json: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.request_json) as EffectRequestV1);
  }

  effectIdsByWorkRun(work_run_ref: string): string[] {
    const rows = this.db.prepare("SELECT effect_id FROM effect_request WHERE work_run_ref = ? ORDER BY rowid").all(work_run_ref) as Array<{
      effect_id: string;
    }>;
    return rows.map((r) => r.effect_id);
  }

  // -------------------------------------------------------------- input / decision

  insertAdmissionInput(input: AdmissionInputV1): void {
    mapSqliteError(() =>
      this.db
        .prepare("INSERT INTO admission_input (input_digest, effect_id, policy_id, revision, input_json) VALUES (?, ?, ?, ?, ?)")
        .run(input.input_digest.value, input.effect_request_ref, input.policy_ref.policy_id, input.policy_ref.revision, jcs(input)),
    );
  }

  admissionInput(input_digest: string): AdmissionInputV1 | undefined {
    const row = this.db.prepare("SELECT input_json FROM admission_input WHERE input_digest = ?").get(input_digest) as
      | { input_json: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.input_json) as AdmissionInputV1);
  }

  admissionInputsByEffect(effect_id: string): AdmissionInputV1[] {
    const rows = this.db.prepare("SELECT input_json FROM admission_input WHERE effect_id = ? ORDER BY rowid").all(effect_id) as Array<{
      input_json: string;
    }>;
    return rows.map((r) => JSON.parse(r.input_json) as AdmissionInputV1);
  }

  insertPolicyDecision(decision: PolicyDecisionV1): void {
    mapSqliteError(() =>
      this.db
        .prepare(
          "INSERT INTO policy_decision (decision_id, decision_digest, admission_input_digest, outcome, not_after, decision_json) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          decision.decision_id,
          decision.decision_digest.value,
          decision.admission_input_digest.value,
          decision.outcome,
          decision.not_after ?? null,
          jcs(decision),
        ),
    );
  }

  policyDecision(decision_id: string): PolicyDecisionV1 | undefined {
    const row = this.db.prepare("SELECT decision_json FROM policy_decision WHERE decision_id = ?").get(decision_id) as
      | { decision_json: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.decision_json) as PolicyDecisionV1);
  }

  decisionsByInputDigests(digests: readonly string[]): PolicyDecisionV1[] {
    const out: PolicyDecisionV1[] = [];
    const stmt = this.db.prepare("SELECT decision_json FROM policy_decision WHERE admission_input_digest = ? ORDER BY rowid");
    for (const d of digests) {
      for (const row of stmt.all(d) as Array<{ decision_json: string }>) {
        out.push(JSON.parse(row.decision_json) as PolicyDecisionV1);
      }
    }
    return out;
  }

  // -------------------------------------------------------------- admission / outcome

  insertAdmission(admission: EffectAdmissionV1): void {
    mapSqliteError(() =>
      this.db
        .prepare(
          `INSERT INTO effect_admission (admission_id, admission_digest, effect_id, dispatch_ordinal, effect_request_digest, policy_decision_ref, admission_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          admission.admission_id,
          admission.admission_digest.value,
          admission.effect_id,
          admission.dispatch_ordinal,
          admission.effect_request_digest.value,
          admission.policy_decision_ref,
          jcs(admission),
        ),
    );
  }

  admissionsByEffect(effect_id: string): EffectAdmissionV1[] {
    const rows = this.db
      .prepare("SELECT admission_json FROM effect_admission WHERE effect_id = ? ORDER BY dispatch_ordinal")
      .all(effect_id) as Array<{ admission_json: string }>;
    return rows.map((r) => JSON.parse(r.admission_json) as EffectAdmissionV1);
  }

  allAdmissions(): EffectAdmissionV1[] {
    const rows = this.db.prepare("SELECT admission_json FROM effect_admission ORDER BY rowid").all() as Array<{ admission_json: string }>;
    return rows.map((r) => JSON.parse(r.admission_json) as EffectAdmissionV1);
  }

  insertOutcome(outcome: EffectOutcomeV1): void {
    mapSqliteError(() =>
      this.db
        .prepare(
          "INSERT INTO effect_outcome (outcome_id, outcome_digest, effect_id, admission_digest, result, observed_at, outcome_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          outcome.outcome_id,
          outcome.outcome_digest.value,
          outcome.effect_id,
          outcome.admission_digest.value,
          outcome.result,
          outcome.observed_at,
          jcs(outcome),
        ),
    );
  }

  outcomesByEffect(effect_id: string): EffectOutcomeV1[] {
    const rows = this.db.prepare("SELECT outcome_json FROM effect_outcome WHERE effect_id = ? ORDER BY rowid").all(effect_id) as Array<{
      outcome_json: string;
    }>;
    return rows.map((r) => JSON.parse(r.outcome_json) as EffectOutcomeV1);
  }

  outcomesByAdmissionDigest(admission_digest: string): EffectOutcomeV1[] {
    const rows = this.db
      .prepare("SELECT outcome_json FROM effect_outcome WHERE admission_digest = ? ORDER BY rowid")
      .all(admission_digest) as Array<{ outcome_json: string }>;
    return rows.map((r) => JSON.parse(r.outcome_json) as EffectOutcomeV1);
  }

  // -------------------------------------------------------------- CAS

  insertBlob(digest_key: string, bytes: Uint8Array, created_at: string): void {
    mapSqliteError(() =>
      this.db.prepare("INSERT INTO cas_blob (digest_key, bytes, size, created_at) VALUES (?, ?, ?, ?)").run(digest_key, bytes, bytes.length, created_at),
    );
  }

  blob(digest_key: string): Uint8Array | undefined {
    const row = this.db.prepare("SELECT bytes FROM cas_blob WHERE digest_key = ?").get(digest_key) as { bytes: Uint8Array } | undefined;
    return row?.bytes;
  }
}

export type { PolicyRefV1 };
