/**
 * The immutable artifact tables (TD §18.1a): Compiled Profile, Task Contract snapshot,
 * CapabilityGrant and operator-action.
 *
 * All four share the §18.1a rules — whole envelope stored, re-hashed on load, idempotent on
 * identical content, fail-closed on conflicting content — implemented with the small helpers in
 * `immutable-artifact.ts`. There is no generic artifact framework and no update or delete path.
 */

import type { CapabilityGrantResult } from "../capability/broker.ts";
import type { CompileResult } from "../profile/compiler.ts";
import type { TaskContractResult } from "../contract/task-contract.ts";
import type { CanonicalObject, CanonicalValue } from "../schemas/canonical-json.ts";
import { canonicalize } from "../schemas/canonical-json.ts";
import { hashEnvelope, makeEnvelope, type SchemaEnvelope } from "../schemas/envelope.ts";
import { isUlid } from "../schemas/identifiers.ts";
import type { DatabaseSync } from "./database.ts";
import type { CapabilityGrantRow, GrantRole } from "./domain-types.ts";
import { StoreError } from "./errors.ts";
import { assertSameContent, envelopeText, loadVerifiedEnvelope } from "./immutable-artifact.ts";

// --- compiled_profile_snapshot -------------------------------------------------------

export class CompiledProfileStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(database: DatabaseSync, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  /** Stores the whole `platform/compiled-profile` envelope under its own hash. */
  put(compiled: CompileResult): string {
    const json = envelopeText(compiled.envelope);
    const existing = this.#row(compiled.compiled_hash);
    if (existing !== undefined) {
      assertSameContent("compiled profile", compiled.compiled_hash, existing.envelope_json, json);
      return compiled.compiled_hash;
    }
    this.#database
      .prepare(
        "INSERT INTO compiled_profile_snapshot (compiled_hash, envelope_json, created_at) VALUES (?, ?, ?)",
      )
      .run(compiled.compiled_hash, json, this.#now());
    return compiled.compiled_hash;
  }

  /** Returns the verified envelope, or `undefined`. Corrupt rows fail closed rather than load. */
  get(compiledHash: string): SchemaEnvelope<CanonicalObject> | undefined {
    const row = this.#row(compiledHash);
    if (row === undefined) return undefined;
    return loadVerifiedEnvelope("compiled profile", compiledHash, row.envelope_json, compiledHash);
  }

  /** The `effective` projection callers need for policy lookups (TD §18.1a authority rule). */
  require(compiledHash: string): SchemaEnvelope<CanonicalObject> {
    const envelope = this.get(compiledHash);
    if (envelope === undefined) {
      throw new StoreError("DOMAIN_ROW_MISSING", `no compiled profile stored for ${compiledHash}`);
    }
    return envelope;
  }

  count(): number {
    return countRows(this.#database, "compiled_profile_snapshot");
  }

  #row(compiledHash: string): { envelope_json: string } | undefined {
    return this.#database
      .prepare("SELECT envelope_json FROM compiled_profile_snapshot WHERE compiled_hash = ?")
      .get(compiledHash) as { envelope_json: string } | undefined;
  }
}

// --- task_contract_snapshot ------------------------------------------------------------

export class TaskContractSnapshotStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(database: DatabaseSync, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  put(contract: TaskContractResult): string {
    const snapshotId = contract.body.snapshot_id;
    const json = envelopeText(contract.envelope);
    const existing = this.#row(snapshotId);
    if (existing !== undefined) {
      assertSameContent("task contract", snapshotId, existing.envelope_json, json);
      return snapshotId;
    }
    this.#database
      .prepare(
        "INSERT INTO task_contract_snapshot (snapshot_id, hash, envelope_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(snapshotId, contract.hash, json, this.#now());
    return snapshotId;
  }

  get(snapshotId: string): SchemaEnvelope<CanonicalObject> | undefined {
    const row = this.#row(snapshotId);
    if (row === undefined) return undefined;
    return loadVerifiedEnvelope("task contract", snapshotId, row.envelope_json, row.hash);
  }

  hashOf(snapshotId: string): string | undefined {
    return this.#row(snapshotId)?.hash;
  }

  count(): number {
    return countRows(this.#database, "task_contract_snapshot");
  }

  #row(snapshotId: string): { hash: string; envelope_json: string } | undefined {
    return this.#database
      .prepare("SELECT hash, envelope_json FROM task_contract_snapshot WHERE snapshot_id = ?")
      .get(snapshotId) as { hash: string; envelope_json: string } | undefined;
  }
}

// --- capability_grant ---------------------------------------------------------------------

/** Where a grant is anchored: SUPERVISOR at the run, ACTOR/AUDITOR at the attempt (§18.1a). */
export type GrantScope =
  | { readonly kind: "RUN"; readonly run_id: string }
  | { readonly kind: "ATTEMPT"; readonly attempt_key: string };

/** A stored grant row as `put`/`get` read it: its content, and the scope it is anchored to. */
interface GrantRowContent {
  readonly grant_hash: string;
  readonly run_id: string | null;
  readonly attempt_key: string | null;
  readonly envelope_json: string;
}

export class CapabilityGrantStore {
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(database: DatabaseSync, now: () => string) {
    this.#database = database;
    this.#now = now;
  }

  /**
   * Persists an already-issued grant. Batch 8 never issues one — the Broker (§12.5) does, and the
   * envelope is stored exactly as issued.
   */
  put(grant: CapabilityGrantResult, scope: GrantScope): string {
    const grantId = grant.body.grant_id;
    const role = grant.body.role;
    if ((role === "SUPERVISOR") !== (scope.kind === "RUN")) {
      throw new StoreError(
        "DOMAIN_ROW_INVALID",
        `a ${role} grant may not be anchored to a ${scope.kind.toLowerCase()}`,
      );
    }

    const runId = scope.kind === "RUN" ? scope.run_id : null;
    const attemptKey = scope.kind === "ATTEMPT" ? scope.attempt_key : null;

    const json = envelopeText(grant.envelope);
    const existing = this.#row(grantId);
    if (existing !== undefined) {
      // §18.1a — a grant identity is anchored exactly once. The anchor is not part of the envelope,
      // so two runs (or two attempts) can compute byte-identical grants: without this check the
      // second write would pass as an idempotent no-op, leaving that scope with no grant row while
      // its caller was told the grant was stored.
      if (existing.run_id !== runId || existing.attempt_key !== attemptKey) {
        const anchor =
          existing.run_id === null ? `attempt ${existing.attempt_key}` : `run ${existing.run_id}`;
        throw new StoreError(
          "DOMAIN_ROW_INVALID",
          `capability grant ${grantId} is already anchored to ${anchor}; it may not be re-anchored`,
        );
      }
      assertSameContent("capability grant", grantId, existing.envelope_json, json);
      return grantId;
    }

    this.#database
      .prepare(
        `INSERT INTO capability_grant
           (grant_id, grant_hash, role, run_id, attempt_key, envelope_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(grantId, grant.grant_hash, role, runId, attemptKey, json, this.#now());
    return grantId;
  }

  get(grantId: string): SchemaEnvelope<CanonicalObject> | undefined {
    const row = this.#row(grantId);
    if (row === undefined) return undefined;
    return loadVerifiedEnvelope("capability grant", grantId, row.envelope_json, row.grant_hash);
  }

  meta(grantId: string): CapabilityGrantRow | undefined {
    const row = this.#database
      .prepare(
        "SELECT grant_id, grant_hash, role, run_id, attempt_key, created_at FROM capability_grant WHERE grant_id = ?",
      )
      .get(grantId) as
      | {
          grant_id: string;
          grant_hash: string;
          role: GrantRole;
          run_id: string | null;
          attempt_key: string | null;
          created_at: string;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          grant_id: row.grant_id,
          grant_hash: row.grant_hash,
          role: row.role,
          run_id: row.run_id,
          attempt_key: row.attempt_key,
          created_at: row.created_at,
        };
  }

  /** The run-scoped grant (SUPERVISOR) of one run, if it was ever issued (§18.1a). */
  forRun(runId: string): readonly CapabilityGrantRow[] {
    const rows = this.#database
      .prepare(
        `SELECT grant_id, grant_hash, role, run_id, attempt_key, created_at
           FROM capability_grant WHERE run_id = ? ORDER BY grant_id ASC`,
      )
      .all(runId) as unknown as CapabilityGrantRow[];
    return rows.map((row) => ({ ...row }));
  }

  /** Both attempt-scoped grants of one attempt, in role order. */
  forAttempt(attemptKey: string): readonly CapabilityGrantRow[] {
    const rows = this.#database
      .prepare(
        `SELECT grant_id, grant_hash, role, run_id, attempt_key, created_at
           FROM capability_grant WHERE attempt_key = ? ORDER BY role ASC`,
      )
      .all(attemptKey) as unknown as CapabilityGrantRow[];
    return rows.map((row) => ({ ...row }));
  }

  count(): number {
    return countRows(this.#database, "capability_grant");
  }

  #row(grantId: string): GrantRowContent | undefined {
    return this.#database
      .prepare(
        "SELECT grant_hash, run_id, attempt_key, envelope_json FROM capability_grant WHERE grant_id = ?",
      )
      .get(grantId) as GrantRowContent | undefined;
  }
}

// --- operator_action -----------------------------------------------------------------------

export const OPERATOR_ACTION_SCHEMA = "platform/operator-action";

/** TD §7.6 v1 — an immutable approval issuance record. There is no revocation in v1. */
export interface OperatorActionInput {
  readonly action_id: string;
  readonly field_path: string;
  readonly approved_value: CanonicalValue;
  readonly recorded_by: string;
  readonly recorded_at: string;
}

export interface OperatorActionRecord {
  readonly action_id: string;
  readonly status: "RESOLVED";
  readonly field_path: string;
  readonly approved_value: CanonicalValue;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly record_hash: string;
}

export class OperatorActionStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /** Records an approval. `status` is always `RESOLVED`: v1 has no other value (M0-31). */
  put(input: OperatorActionInput): OperatorActionRecord {
    if (!isUlid(input.action_id)) {
      throw new StoreError("DOMAIN_ROW_INVALID", "operator action id must be a ULID");
    }
    for (const [field, value] of [
      ["field_path", input.field_path],
      ["recorded_by", input.recorded_by],
      ["recorded_at", input.recorded_at],
    ] as const) {
      if (typeof value !== "string" || value.length === 0) {
        throw new StoreError("DOMAIN_ROW_INVALID", `operator action ${field} must be non-empty`);
      }
    }

    const body = {
      action_id: input.action_id,
      status: "RESOLVED",
      field_path: input.field_path,
      approved_value: input.approved_value,
      recorded_by: input.recorded_by,
      recorded_at: input.recorded_at,
    } as unknown as CanonicalObject;
    const envelope = makeEnvelope(OPERATOR_ACTION_SCHEMA, 1, body);
    const recordHash = hashEnvelope(envelope);
    const json = envelopeText(envelope);

    const existing = this.#row(input.action_id);
    if (existing !== undefined) {
      assertSameContent("operator action", input.action_id, existing.envelope_json, json);
      return this.get(input.action_id) as OperatorActionRecord;
    }

    this.#database
      .prepare(
        `INSERT INTO operator_action
           (action_id, status, field_path, approved_value_json, recorded_by, recorded_at,
            record_hash, envelope_json)
         VALUES (?, 'RESOLVED', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.action_id,
        input.field_path,
        canonicalize(input.approved_value),
        input.recorded_by,
        input.recorded_at,
        recordHash,
        json,
      );

    return {
      action_id: input.action_id,
      status: "RESOLVED",
      field_path: input.field_path,
      approved_value: input.approved_value,
      recorded_by: input.recorded_by,
      recorded_at: input.recorded_at,
      record_hash: recordHash,
    };
  }

  get(actionId: string): OperatorActionRecord | undefined {
    const row = this.#row(actionId);
    if (row === undefined) return undefined;
    loadVerifiedEnvelope("operator action", actionId, row.envelope_json, row.record_hash);
    return {
      action_id: actionId,
      status: "RESOLVED",
      field_path: row.field_path,
      approved_value: JSON.parse(row.approved_value_json) as CanonicalValue,
      recorded_by: row.recorded_by,
      recorded_at: row.recorded_at,
      record_hash: row.record_hash,
    };
  }

  count(): number {
    return countRows(this.#database, "operator_action");
  }

  #row(actionId: string):
    | {
        field_path: string;
        approved_value_json: string;
        recorded_by: string;
        recorded_at: string;
        record_hash: string;
        envelope_json: string;
      }
    | undefined {
    return this.#database
      .prepare(
        `SELECT field_path, approved_value_json, recorded_by, recorded_at, record_hash, envelope_json
           FROM operator_action WHERE action_id = ?`,
      )
      .get(actionId) as
      | {
          field_path: string;
          approved_value_json: string;
          recorded_by: string;
          recorded_at: string;
          record_hash: string;
          envelope_json: string;
        }
      | undefined;
  }
}

function countRows(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}
