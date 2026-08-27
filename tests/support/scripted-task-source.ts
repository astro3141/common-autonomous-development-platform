/**
 * A test-local scripted TaskSource.
 *
 * The materializer is written against `TaskSourceV1`, so tests need no concrete adapter and no
 * filesystem. It records every call so the read-call boundaries can be asserted directly.
 */

import { hashTaskDefinitionBody } from "../../core/tasksource/task-definition.ts";
import type {
  ExternalTaskState,
  TaskCandidate,
  TaskDefinition,
  TaskDependency,
  TaskDiscoveryContextV1,
  TaskSourceV1,
} from "../../core/tasksource/types.ts";

export interface ScriptedTask {
  readonly ref: string;
  readonly state?: ExternalTaskState;
  readonly version?: string;
  readonly title?: string;
  readonly description?: string;
  /** Replaces what `get_task` returns for this ref, verbatim and unvalidated. */
  readonly definition?: unknown;
  /** Makes `get_task` throw for this ref, the way an unreadable source would. */
  readonly getTaskFails?: string;
}

export interface CallLog {
  discover_tasks: number;
  get_task: string[];
  get_dependencies: string[];
  get_task_state: string[];
}

export const definitionBody = (task: ScriptedTask) => ({
  title: task.title ?? `Task ${task.ref}`,
  description: task.description ?? "Neutral description.",
  references: ["docs/DESIGN.md#section"],
  acceptance_notes: ["Output stays byte-identical."],
});

/** The hash the Platform will recompute for this scripted task. */
export const definitionHashOf = (task: ScriptedTask): string =>
  hashTaskDefinitionBody(definitionBody(task));

export class ScriptedTaskSource implements TaskSourceV1 {
  readonly calls: CallLog = {
    discover_tasks: 0,
    get_task: [],
    get_dependencies: [],
    get_task_state: [],
  };

  readonly #tasks: readonly ScriptedTask[];
  readonly #discoverFails: string | undefined;

  constructor(tasks: readonly ScriptedTask[], discoverFails?: string) {
    this.#tasks = tasks;
    this.#discoverFails = discoverFails;
  }

  discover_tasks(context: TaskDiscoveryContextV1): readonly TaskCandidate[] {
    this.calls.discover_tasks += 1;
    if (this.#discoverFails !== undefined) throw new Error(this.#discoverFails);
    return this.#tasks.map((task) => ({
      task_ref: task.ref,
      title: task.title ?? `Task ${task.ref}`,
      summary: "Neutral summary.",
      external_state: task.state ?? "READY",
      discovered_at: context.observed_at,
    }));
  }

  get_task(task_ref: string): TaskDefinition {
    this.calls.get_task.push(task_ref);
    const task = this.#find(task_ref);
    if (task.getTaskFails !== undefined) throw new Error(task.getTaskFails);
    if (task.definition !== undefined) return task.definition as TaskDefinition;

    const body = definitionBody(task);
    return {
      task_ref: task.ref,
      version: task.version ?? "1",
      definition_hash: hashTaskDefinitionBody(body),
      body,
    };
  }

  get_dependencies(task_ref: string): readonly TaskDependency[] {
    this.calls.get_dependencies.push(task_ref);
    return [];
  }

  get_task_state(task_ref: string): ExternalTaskState {
    this.calls.get_task_state.push(task_ref);
    return this.#find(task_ref).state ?? "READY";
  }

  #find(task_ref: string): ScriptedTask {
    const task = this.#tasks.find((candidate) => candidate.ref === task_ref);
    if (task === undefined) throw new Error(`no scripted task ${task_ref}`);
    return task;
  }
}
