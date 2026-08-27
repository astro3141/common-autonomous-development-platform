/**
 * ProjectDocumentTaskSource — the first concrete TaskSource (TD §8.2).
 *
 * It owns its config schema (the Profile Compiler keeps that config opaque), parses the configured
 * documents with `markdown-sections-v1`, and exposes exactly the four v1 read operations. There is
 * no projection capability, no cache and no durable state: every call re-reads and re-parses, so
 * all four methods necessarily agree.
 */

import { readFileSync } from "node:fs";

import { TaskSourceError } from "./errors.ts";
import { parseTaskDocument, type ParsedTask } from "./markdown-sections-v1.ts";
import { normalizeTaskDefinition } from "./task-definition.ts";
import type {
  ExternalTaskState,
  TaskCandidate,
  TaskDefinition,
  TaskDependency,
  TaskDiscoveryContextV1,
  TaskSourceV1,
} from "./types.ts";

export const MARKDOWN_SECTIONS_V1 = "markdown-sections-v1";

export interface ProjectDocumentTaskSourceConfig {
  readonly paths: readonly string[];
  readonly parser: typeof MARKDOWN_SECTIONS_V1;
}

/** Reads one configured document. Injectable so tests need no filesystem. */
export type DocumentReader = (path: string) => string;

const defaultReader: DocumentReader = (path) => readFileSync(path, "utf8");

/** Adapter-owned config validation (§8.2) — exactly `{ paths, parser }`. */
export function validateProjectDocumentConfig(input: unknown): ProjectDocumentTaskSourceConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw configError("/", "expected an object");
  }
  const config = input as Record<string, unknown>;

  for (const key of Object.keys(config)) {
    if (key !== "paths" && key !== "parser") throw configError("/", `unknown field "${key}"`);
  }
  if (!Object.hasOwn(config, "paths")) throw configError("/", 'missing required field "paths"');
  if (!Object.hasOwn(config, "parser")) throw configError("/", 'missing required field "parser"');

  if (config["parser"] !== MARKDOWN_SECTIONS_V1) {
    throw configError("/parser", `unsupported parser; expected "${MARKDOWN_SECTIONS_V1}"`);
  }

  const raw = config["paths"];
  if (!Array.isArray(raw)) throw configError("/paths", "expected an array");
  if (raw.length === 0) throw configError("/paths", "must not be empty");

  const paths = raw.map((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      throw configError(`/paths/${index}`, "expected a non-empty string");
    }
    return value;
  });
  const seen = new Set<string>();
  for (const [index, path] of paths.entries()) {
    if (seen.has(path)) throw configError(`/paths/${index}`, `duplicate path ${JSON.stringify(path)}`);
    seen.add(path);
  }

  return { paths, parser: MARKDOWN_SECTIONS_V1 };
}

export class ProjectDocumentTaskSource implements TaskSourceV1 {
  readonly #config: ProjectDocumentTaskSourceConfig;
  readonly #read: DocumentReader;

  constructor(config: unknown, read: DocumentReader = defaultReader) {
    this.#config = validateProjectDocumentConfig(config);
    this.#read = read;
  }

  discover_tasks(context: TaskDiscoveryContextV1): readonly TaskCandidate[] {
    // Every candidate of one call carries the caller's observation time — no clock, no mtime.
    const observed_at = context.observed_at;
    return this.#parseAll().map((task) => ({
      task_ref: task.task_ref,
      title: task.title,
      summary: summaryOf(task),
      external_state: task.state,
      discovered_at: observed_at,
    }));
  }

  get_task(task_ref: string): TaskDefinition {
    const task = this.#find(task_ref);
    return normalizeTaskDefinition(
      {
        task_ref: task.task_ref,
        version: task.version,
        body: {
          title: task.title,
          description: task.description,
          references: [...task.references],
          acceptance_notes: [...task.acceptance],
        },
      },
      task.source_path,
    );
  }

  get_dependencies(task_ref: string): readonly TaskDependency[] {
    const task = this.#find(task_ref);
    return task.dependencies.map((dependency) => ({
      task_ref: task.task_ref,
      depends_on_ref: dependency.ref,
      kind: dependency.kind,
    }));
  }

  get_task_state(task_ref: string): ExternalTaskState {
    return this.#find(task_ref).state;
  }

  /** Parses every configured document in path order, then document order. */
  #parseAll(): ParsedTask[] {
    const tasks: ParsedTask[] = [];
    const seen = new Map<string, string>();

    for (const path of this.#config.paths) {
      let text: string;
      try {
        text = this.#read(path);
      } catch (error) {
        throw new TaskSourceError(
          "DOCUMENT_UNREADABLE",
          path,
          error instanceof Error ? error.message : String(error),
        );
      }

      for (const task of parseTaskDocument(path, text)) {
        const previous = seen.get(task.task_ref);
        if (previous !== undefined) {
          // Neither first-wins nor last-wins: a colliding ref would break task_key injectivity.
          throw new TaskSourceError(
            "DUPLICATE_TASK_REF",
            path,
            `task_ref ${JSON.stringify(task.task_ref)} already declared in ${previous}`,
          );
        }
        seen.set(task.task_ref, path);
        tasks.push(task);
      }
    }
    return tasks;
  }

  #find(task_ref: string): ParsedTask {
    const task = this.#parseAll().find((candidate) => candidate.task_ref === task_ref);
    if (task === undefined) {
      throw new TaskSourceError("TASK_NOT_FOUND", "-", `no task with ref ${JSON.stringify(task_ref)}`);
    }
    return task;
  }
}

/** First non-empty physical line of the description, else the title (§8.2). */
function summaryOf(task: ParsedTask): string {
  for (const line of task.description.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return task.title;
}

function configError(location: string, detail: string): TaskSourceError {
  return new TaskSourceError("CONFIG_INVALID", location, detail);
}
