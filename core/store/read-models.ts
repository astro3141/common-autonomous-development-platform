/**
 * Durable projection of the Batch 7 `DecisionValidationBatchView` (TD §9.2e, §19.3c).
 *
 * Three queries, no counter columns and no hidden "active" flag. The pipeline shape comes from
 * the batch's own immutable Compiled Profile, so a later Profile edit cannot retroactively change
 * what a running batch counts.
 */

import type { DecisionValidationBatchView } from "../decision/types.ts";
import type { CompileResult } from "../profile/compiler.ts";
import type { CompiledProfileV1Body } from "../profile/types.ts";
import type { CompiledProfileStore } from "./artifact-stores.ts";
import type { DatabaseSync } from "./database.ts";
import { WRITABLE_ATTEMPT_STATES } from "./domain-types.ts";

const WRITABLE_LIST = WRITABLE_ATTEMPT_STATES.map((state) => `'${state}'`).join(", ");

export class BatchViewProjector {
  readonly #database: DatabaseSync;
  readonly #profiles: CompiledProfileStore;

  constructor(database: DatabaseSync, profiles: CompiledProfileStore) {
    this.#database = database;
    this.#profiles = profiles;
  }

  project(batchId: string): DecisionValidationBatchView {
    return {
      admitted_task_count: this.admitted(batchId),
      active_task_count: this.active(batchId),
      active_writable_candidate_count: this.writable(batchId),
    };
  }

  /**
   * Tasks that passed SELECTED at least once. A plain row count would be wrong: DISCOVERED tasks
   * are durable too, and a task that has since completed or been held still consumed admission.
   */
  admitted(batchId: string): number {
    return this.#count(
      "SELECT count(*) AS n FROM task WHERE batch_id = ? AND admitted_at IS NOT NULL",
      batchId,
    );
  }

  /**
   * Execution concurrency is TaskState-based. A HELD task with a live attempt — the human-merge
   * pause (§19.4), a drift hold (§11.1), an audit HUMAN_REQUIRED — does not occupy a slot, which
   * is what keeps Hold-and-Continue (Spec §48) possible.
   */
  active(batchId: string): number {
    return this.#count(
      "SELECT count(*) AS n FROM task WHERE batch_id = ? AND platform_state = 'ACTIVE'",
      batchId,
    );
  }

  /** ACTIVE + the pipeline has an ACTOR step + the live attempt holds the writable slot. */
  writable(batchId: string): number {
    const rows = this.#database
      .prepare(
        `SELECT t.pipeline_id AS pipeline_id
           FROM task t
           JOIN task_attempt a ON a.task_key = t.task_key
          WHERE t.batch_id = ?
            AND t.platform_state = 'ACTIVE'
            AND a.state IN (${WRITABLE_LIST})`,
      )
      .all(batchId) as unknown as { pipeline_id: string | null }[];
    if (rows.length === 0) return 0;

    const effective = this.#effective(batchId).effective;
    let count = 0;
    for (const row of rows) {
      if (row.pipeline_id === null) continue;
      const pipeline = effective.project.pipelines[row.pipeline_id];
      if (pipeline !== undefined && pipeline.steps.includes("ACTOR")) count += 1;
    }
    return count;
  }

  /** The batch's frozen Compiled Profile — the authority for policy limits and pipelines. */
  #effective(batchId: string): CompiledProfileV1Body {
    return this.#profiles.require(this.#compiledHash(batchId)).body as unknown as CompiledProfileV1Body;
  }

  #compiledHash(batchId: string): string {
    const row = this.#database
      .prepare("SELECT compiled_profile_hash AS hash FROM batch WHERE batch_id = ?")
      .get(batchId) as { hash: string } | undefined;
    if (row === undefined) {
      throw new Error(`batch ${JSON.stringify(batchId)} does not exist`);
    }
    return row.hash;
  }

  /** The Compiled Profile body frozen by this batch (public: transitions read policy from it). */
  compiledProfileFor(batchId: string): CompiledProfileV1Body {
    return this.#effective(batchId);
  }

  /**
   * The batch's own immutable snapshot in `CompileResult` shape (TD §7.4) — what the Task Contract
   * builder needs, so activation never reaches for whatever the Profile Registry holds now.
   */
  compiledProfileSnapshotFor(batchId: string): CompileResult {
    const hash = this.#compiledHash(batchId);
    const envelope = this.#profiles.require(hash);
    return {
      envelope,
      compiled_hash: hash,
      body: envelope.body as unknown as CompiledProfileV1Body,
    };
  }

  #count(sql: string, batchId: string): number {
    const row = this.#database.prepare(sql).get(batchId) as { n: number };
    return row.n;
  }
}
