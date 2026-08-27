/**
 * TaskSource discovery → durable task materialization (TD §8.3, §8.4 M1-1, §19.3, §26 step 3).
 *
 * One pass turns what a TaskSource currently observes into the durable `task` projection, and
 * nothing else. The governing invariant is TD §8.3:
 *
 *     TaskSource observation != Platform lifecycle authority
 *
 * so the only Platform state this file can bring into existence is `DISCOVERED`, and only as the
 * initial state of a row that did not exist yet. Every later observation of that task rewrites
 * exactly one column — the external snapshot — plus its observation time. Selection, admission,
 * Contract, Grant, Attempt and every state transition stay with the Coordinator.
 *
 * The pass is also split in two halves on purpose (§8.4): all external reads happen first and
 * outside any transaction, and only a fully gathered, fully normalized observation set opens the
 * single `BEGIN IMMEDIATE` that writes it. A TaskSource that fails halfway therefore leaves the
 * previous observation exactly as it was.
 */

import { taskKey as buildTaskKey } from "../schemas/identifiers.ts";
import type { CanonicalObject } from "../schemas/canonical-json.ts";
import { StoreError } from "../store/errors.ts";
import type { ExternalTaskSnapshotV1 } from "../store/domain-types.ts";
import type { PlatformStore } from "../store/platform-store.ts";
import { normalizeTaskDefinition } from "../tasksource/task-definition.ts";
import { TaskSourceError } from "../tasksource/errors.ts";
import {
  EXTERNAL_TASK_STATES,
  type TaskCandidate,
  type TaskDiscoveryContextV1,
  type TaskSourceV1,
} from "../tasksource/types.ts";

/**
 * The journal kind for a persisted TaskSource observation.
 *
 * Deliberately not a lifecycle vocabulary: it says "this external observation was persisted", not
 * that a task was admitted, started, held or completed (§8.3). It is distinct from
 * `state_transition`, and it never becomes a task's `state_reason_log_seq`.
 */
export const TASK_OBSERVATION_KIND = "task_observation";

/** Whether the pass created the durable row or refreshed the one already there. */
export type ObservationOutcome = "MATERIALIZED" | "REFRESHED";

export interface DiscoveryPassCommand {
  readonly run_id: string;
  /** The caller's active batch. A TaskSource never selects a batch (§8.4). */
  readonly batch_id: string;
  readonly context: TaskDiscoveryContextV1;
}

export interface TaskObservationResult {
  readonly task_key: string;
  readonly external_task_ref: string;
  readonly outcome: ObservationOutcome;
  readonly snapshot: ExternalTaskSnapshotV1;
  /** `decision_log.seq` of this observation. History only — never a state reason. */
  readonly observation_seq: number;
}

export interface DiscoveryPassResult {
  readonly run_id: string;
  readonly batch_id: string;
  readonly project_id: string;
  readonly observed_at: string;
  /**
   * Candidate order, preserved verbatim. This is presentation only: discovery order carries no
   * priority, admission rank or scheduling meaning, and nothing about it is durable (§8.3).
   */
  readonly observations: readonly TaskObservationResult[];
}

/** One gathered observation: everything needed to write, computed before any transaction opens. */
interface GatheredObservation {
  readonly task_key: string;
  readonly external_task_ref: string;
  readonly snapshot: ExternalTaskSnapshotV1;
}

/**
 * Runs one discovery pass against `source` and materializes it into `store`.
 *
 * Exactly two TaskSource operations are used: one `discover_tasks`, then one `get_task` per unique
 * candidate. `get_dependencies`, `get_task_state` and any projection writeback are outside this
 * path — dependencies are read fresh at admission time, and the external state of a pass comes
 * from the candidates of that same pass so a single observation can never be self-inconsistent.
 */
export function materializeDiscoveryPass(
  store: PlatformStore,
  source: TaskSourceV1,
  command: DiscoveryPassCommand,
): DiscoveryPassResult {
  const observedAt = command.context.observed_at;
  if (typeof observedAt !== "string" || observedAt.length === 0) {
    throw invalidObservation("/context/observed_at", "must be a non-empty timestamp");
  }

  // --- external observation collection (no durable write may start here) ---------------
  const target = resolveTarget(store, command);
  const candidates = validateCandidates(source.discover_tasks(command.context));

  const gathered: GatheredObservation[] = candidates.map((candidate, index) => {
    const location = `/candidates/${index}`;
    const raw = source.get_task(candidate.task_ref);
    // The B8.1a normalization boundary, reused as-is: the body is revalidated and the hash is
    // recomputed, so an adapter-supplied `definition_hash` that disagrees fails closed here.
    const definition = normalizeTaskDefinition(
      {
        task_ref: raw.task_ref,
        version: raw.version,
        ...(raw.definition_hash === undefined ? {} : { definition_hash: raw.definition_hash }),
        body: raw.body,
      },
      location,
    );

    // §8.4 — the definition must describe the candidate that was asked for. Binding another
    // task's definition to this candidate would silently corrupt the projection.
    if (definition.task_ref !== candidate.task_ref) {
      throw new TaskSourceError(
        "DEFINITION_INVALID",
        `${location}/task_ref`,
        `get_task(${JSON.stringify(candidate.task_ref)}) returned a definition for ` +
          `${JSON.stringify(definition.task_ref)}`,
      );
    }

    return {
      // §6.1 D+ — the ref is opaque and may contain ':'; the shared helper keeps it verbatim.
      task_key: buildTaskKey(target.project_id, candidate.task_ref),
      external_task_ref: candidate.task_ref,
      snapshot: {
        external_state: candidate.external_state,
        version: definition.version,
        definition_hash: definition.definition_hash,
        observed_at: observedAt,
      },
    };
  });

  // --- durable materialization (one transaction, all or nothing) ------------------------
  const observations = store.withTransaction(() => {
    // Re-read at write time: the rows the pass is about must still be the rows it validated.
    resolveTarget(store, command);

    return gathered.map((observation) => {
      const existing = store.tasks.get(observation.task_key);
      let outcome: ObservationOutcome;

      if (existing === undefined) {
        store.tasks.discover({
          task_key: observation.task_key,
          batch_id: command.batch_id,
          project_id: target.project_id,
          external_task_ref: observation.external_task_ref,
          external_snapshot: observation.snapshot,
          at: observedAt,
        });
        outcome = "MATERIALIZED";
      } else {
        // §8.4 — a task identity belongs to the batch it was materialized in. Re-homing it or
        // refreshing it from another batch's pass are both silent authority changes, so the pass
        // fails closed instead. Batch-level task movement has no TD semantics to implement.
        if (existing.batch_id !== command.batch_id) {
          throw new StoreError(
            "DOMAIN_ROW_INVALID",
            `${observation.task_key} already belongs to ${existing.batch_id}; a discovery pass ` +
              `for ${command.batch_id} may not re-home or refresh it`,
          );
        }
        store.tasks.observe(observation.task_key, observation.snapshot, observedAt);
        outcome = "REFRESHED";
      }

      const appended = store.decisions.append({
        kind: TASK_OBSERVATION_KIND,
        refKey: observation.task_key,
        ts: observedAt,
        payload: {
          run_id: command.run_id,
          batch_id: command.batch_id,
          task_key: observation.task_key,
          external_task_ref: observation.external_task_ref,
          outcome,
          external_snapshot: observation.snapshot as unknown as CanonicalObject,
        } as unknown as CanonicalObject,
      });

      return {
        task_key: observation.task_key,
        external_task_ref: observation.external_task_ref,
        outcome,
        snapshot: observation.snapshot,
        observation_seq: appended.seq,
      };
    });
  });

  return {
    run_id: command.run_id,
    batch_id: command.batch_id,
    project_id: target.project_id,
    observed_at: observedAt,
    observations,
  };
}

// --- local validation ------------------------------------------------------------------

interface PassTarget {
  readonly project_id: string;
}

/**
 * §8.4 — the caller supplies both identities, so the pass verifies they belong together before
 * writing anything. No batch is chosen, resolved or scheduled here.
 */
function resolveTarget(store: PlatformStore, command: DiscoveryPassCommand): PassTarget {
  const run = store.runs.require(command.run_id);
  const batch = store.batches.require(command.batch_id);
  if (batch.run_id !== command.run_id) {
    throw new StoreError(
      "DOMAIN_ROW_INVALID",
      `${command.batch_id} belongs to ${batch.run_id}, not ${command.run_id}`,
    );
  }
  // `admission_closed` is deliberately not consulted: materialization is an observation, not an
  // admission (§19.3), and a closed batch still needs a truthful external projection.
  return { project_id: run.project_id };
}

/**
 * Candidate shape and pass-level injectivity. A duplicate `task_ref` fails the whole pass rather
 * than picking a winner: with a duplicate present the pass cannot know which observation is the
 * task's, and last-write-wins would make the durable projection depend on adapter iteration order.
 * A concrete adapter may reject duplicates too; this boundary does not rely on that.
 */
function validateCandidates(input: readonly TaskCandidate[]): readonly TaskCandidate[] {
  if (!Array.isArray(input)) {
    throw invalidObservation("/candidates", "discover_tasks must return an array");
  }

  const seen = new Set<string>();
  input.forEach((candidate, index) => {
    const location = `/candidates/${index}`;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw invalidObservation(location, "expected a candidate object");
    }
    if (typeof candidate.task_ref !== "string" || candidate.task_ref.length === 0) {
      throw invalidObservation(`${location}/task_ref`, "expected a non-empty string");
    }
    if (!EXTERNAL_TASK_STATES.includes(candidate.external_state)) {
      throw invalidObservation(
        `${location}/external_state`,
        `${JSON.stringify(candidate.external_state)} is not a known ExternalTaskState`,
      );
    }
    if (seen.has(candidate.task_ref)) {
      throw new TaskSourceError(
        "DUPLICATE_TASK_REF",
        `${location}/task_ref`,
        `${JSON.stringify(candidate.task_ref)} appears twice in one discovery pass`,
      );
    }
    seen.add(candidate.task_ref);
  });

  return input;
}

/** Reuses the TaskSource-local taxonomy; this batch introduces no new failure vocabulary. */
function invalidObservation(location: string, detail: string): TaskSourceError {
  return new TaskSourceError("DEFINITION_INVALID", location, detail);
}
