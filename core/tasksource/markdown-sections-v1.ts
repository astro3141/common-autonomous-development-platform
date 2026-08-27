/**
 * `markdown-sections-v1` parser (TD §8.2).
 *
 * A small line-oriented scanner — not a Markdown implementation. It recognises exactly the task
 * grammar and ignores everything outside a `## Task` block; anything structurally wrong *inside* a
 * block fails closed. No external dependency, no AST, no general Markdown semantics.
 */

import { TaskSourceError } from "./errors.ts";
import { DEPENDENCY_KINDS, EXTERNAL_TASK_STATES, type DependencyKind, type ExternalTaskState } from "./types.ts";

const TASK_HEADING = "## Task";
const METADATA_KEYS = ["task-ref", "version", "state", "title"] as const;
const SUBSECTIONS = ["### Description", "### Dependencies", "### References", "### Acceptance"] as const;

/** One task exactly as written in the document, before any Platform projection. */
export interface ParsedTask {
  readonly task_ref: string;
  readonly version: string;
  readonly state: ExternalTaskState;
  readonly title: string;
  readonly description: string;
  readonly dependencies: readonly { readonly kind: DependencyKind; readonly ref: string }[];
  readonly references: readonly string[];
  readonly acceptance: readonly string[];
  /** Source document path, for error locations and duplicate reporting. */
  readonly source_path: string;
}

/** Parses one document in its own order. Blank lines are formatting; other stray lines are errors. */
export function parseTaskDocument(path: string, text: string): ParsedTask[] {
  const lines = text.split(/\r?\n/);
  const tasks: ParsedTask[] = [];

  let index = 0;
  // Everything before the first `## Task` is free prose and is ignored.
  while (index < lines.length && line(lines, index) !== TASK_HEADING) index += 1;

  while (index < lines.length) {
    index += 1; // consume the `## Task` heading
    tasks.push(parseBlock(path, lines, () => index, (next) => (index = next)));
  }
  return tasks;
}

function parseBlock(
  path: string,
  lines: readonly string[],
  get: () => number,
  set: (next: number) => void,
): ParsedTask {
  let index = get();

  const metadata: Record<string, string> = {};
  for (const key of METADATA_KEYS) {
    index = skipBlank(lines, index);
    const current = line(lines, index);
    const prefix = `${key}:`;
    if (current === undefined || !current.startsWith(prefix)) {
      throw malformed(path, index, `expected "${prefix}" in this position`);
    }
    const value = current.slice(prefix.length).trim();
    if (value.length === 0) throw malformed(path, index, `"${key}" must not be empty`);
    metadata[key] = value;
    index += 1;
  }

  // A repeated metadata key would already have failed the ordered scan above; a stray one is caught
  // when the Description heading is expected.
  const sections: string[][] = [];
  for (const [position, heading] of SUBSECTIONS.entries()) {
    index = skipBlank(lines, index);
    if (line(lines, index) !== heading) {
      throw malformed(path, index, `expected "${heading}"`);
    }
    index += 1;
    const stop = position === SUBSECTIONS.length - 1 ? undefined : SUBSECTIONS[position + 1];
    const collected: string[] = [];
    while (index < lines.length) {
      const current = line(lines, index) as string;
      if (current === TASK_HEADING) break;
      if (stop !== undefined && current.trim() === stop) break;
      if (stop === undefined && SUBSECTIONS.includes(current.trim() as (typeof SUBSECTIONS)[number])) {
        throw malformed(path, index, "subsection out of order");
      }
      collected.push(current);
      index += 1;
    }
    sections.push(collected);
  }

  set(index);

  const state = metadata["state"] as string;
  if (!(EXTERNAL_TASK_STATES as readonly string[]).includes(state)) {
    // No silent normalization to UNKNOWN — only an explicit UNKNOWN is UNKNOWN.
    throw malformed(path, index, `invalid state "${state}"`);
  }

  return {
    task_ref: metadata["task-ref"] as string,
    version: metadata["version"] as string,
    state: state as ExternalTaskState,
    title: metadata["title"] as string,
    description: trimBoundaryBlankLines(sections[0] as string[]).join("\n"),
    dependencies: parseDependencies(path, sections[1] as string[]),
    references: parseItems(path, sections[2] as string[]),
    acceptance: parseItems(path, sections[3] as string[]),
    source_path: path,
  };
}

function parseDependencies(
  path: string,
  body: readonly string[],
): { kind: DependencyKind; ref: string }[] {
  const result: { kind: DependencyKind; ref: string }[] = [];
  for (const raw of body) {
    if (raw.trim().length === 0) continue;
    const item = listItem(path, raw);
    const kind = DEPENDENCY_KINDS.find((candidate) => item.startsWith(`${candidate}:`));
    if (kind === undefined) {
      throw malformedLine(path, raw, 'dependency must start with "HARD:" or "SOFT:"');
    }
    // Everything after the first prefix is the ref, so a ref may itself contain ":".
    const ref = item.slice(kind.length + 1).trim();
    if (ref.length === 0) throw malformedLine(path, raw, "dependency ref must not be empty");
    result.push({ kind, ref });
  }
  return result;
}

function parseItems(path: string, body: readonly string[]): string[] {
  const result: string[] = [];
  for (const raw of body) {
    if (raw.trim().length === 0) continue;
    const item = listItem(path, raw);
    if (item.length === 0) throw malformedLine(path, raw, "list item must not be empty");
    result.push(item);
  }
  return result;
}

function listItem(path: string, raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("- ")) {
    throw malformedLine(path, raw, 'expected a "- " list item');
  }
  return trimmed.slice(2).trim();
}

/** Only the formatting blank lines at the section boundaries are removed. */
function trimBoundaryBlankLines(body: readonly string[]): string[] {
  let start = 0;
  let end = body.length;
  while (start < end && (body[start] as string).trim().length === 0) start += 1;
  while (end > start && (body[end - 1] as string).trim().length === 0) end -= 1;
  return body.slice(start, end);
}

function skipBlank(lines: readonly string[], index: number): number {
  let next = index;
  while (next < lines.length && (lines[next] as string).trim().length === 0) next += 1;
  return next;
}

function line(lines: readonly string[], index: number): string | undefined {
  const value = lines[index];
  return value === undefined ? undefined : value.trimEnd();
}

function malformed(path: string, index: number, detail: string): TaskSourceError {
  return new TaskSourceError("DOCUMENT_MALFORMED", `${path}:${index + 1}`, detail);
}

function malformedLine(path: string, raw: string, detail: string): TaskSourceError {
  return new TaskSourceError("DOCUMENT_MALFORMED", path, `${detail} (in ${JSON.stringify(raw)})`);
}
