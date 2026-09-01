/**
 * GitHubIssuesTaskSource — TaskSourceV1 (TD §8.1) over the issues of one configured repository.
 *
 * The GitHub issue is the task *intent/input surface* only (#52): labels, comments, milestones,
 * projects and PR state are never read as lifecycle facts, and nothing here mutates GitHub. The
 * four read operations observe issue identity, title, body and open/closed state — exactly what
 * the §8.1a normalization boundary needs, through the representation contract in
 * `representation.ts`.
 *
 *   task_ref  = the issue number as a decimal string (adapter-scoped, opaque to Core, §6.1 D+)
 *   version   = the issue's `updated_at` timestamp (provenance/change label, outside the hash)
 *   body      = the exact definition-marker payload when present, else the derived title/body form
 *
 * `get_dependencies` is authoritatively empty: this representation contract declares no
 * dependency semantics, and #52 explicitly forbids inventing label/issue-graph scheduling.
 * Unreadable is never absent: a transport failure surfaces as `DOCUMENT_UNREADABLE`, and only an
 * authoritative 404 becomes `TASK_NOT_FOUND`.
 */

import { TaskSourceError } from "../../core/tasksource/errors.ts";
import { normalizeTaskDefinition } from "../../core/tasksource/task-definition.ts";
import type {
  ExternalTaskState,
  TaskCandidate,
  TaskDefinition,
  TaskDependency,
  TaskDiscoveryContextV1,
  TaskSourceV1,
} from "../../core/tasksource/types.ts";
import { deriveBodyFromIssue, parseDefinitionMarker } from "./representation.ts";
import { GitHubTransportError, type GitHubTransportV1 } from "./transport.ts";

export interface GitHubIssuesTaskSourceConfig {
  readonly owner: string;
  readonly repo: string;
  /** Bounded discovery: how many open issues one pass may surface. */
  readonly discovery_limit?: number;
}

const PER_PAGE = 100;

interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: string;
  readonly updated_at: string;
  readonly pull_request?: unknown;
}

export class GitHubIssuesTaskSource implements TaskSourceV1 {
  readonly #transport: GitHubTransportV1;
  readonly #config: GitHubIssuesTaskSourceConfig;

  constructor(transport: GitHubTransportV1, config: GitHubIssuesTaskSourceConfig) {
    if (config.owner.length === 0 || config.repo.length === 0) {
      throw new TaskSourceError("CONFIG_INVALID", "/github", "owner and repo are required");
    }
    this.#transport = transport;
    this.#config = config;
  }

  discover_tasks(context: TaskDiscoveryContextV1): readonly TaskCandidate[] {
    const limit = this.#config.discovery_limit ?? PER_PAGE;
    const issues = this.#listIssues("open").slice(0, limit);
    return issues.map((issue) => ({
      task_ref: String(issue.number),
      title: issue.title,
      summary: firstLine(issue.body ?? ""),
      external_state: stateOf(issue),
      discovered_at: context.observed_at,
    }));
  }

  get_task(task_ref: string): TaskDefinition {
    const issue = this.#getIssue(task_ref);
    // A present-but-mangled definition marker throws DEFINITION_INVALID via normalization:
    // published semantics that cannot be read back exactly must never degrade to the derived form.
    const body = parseDefinitionMarker(issue.body ?? "") ?? deriveBodyFromIssue(issue.title, issue.body ?? "");
    return normalizeTaskDefinition(
      { task_ref, version: issue.updated_at, body },
      `/github-issue/${task_ref}`,
    );
  }

  get_dependencies(task_ref: string): readonly TaskDependency[] {
    void task_ref;
    return [];
  }

  get_task_state(task_ref: string): ExternalTaskState {
    return stateOf(this.#getIssue(task_ref));
  }

  #getIssue(task_ref: string): GitHubIssue {
    if (!/^[1-9][0-9]*$/u.test(task_ref)) {
      throw new TaskSourceError("TASK_NOT_FOUND", `/github-issue/${task_ref}`, "not an issue ref");
    }
    let raw: unknown;
    try {
      raw = this.#transport.api({
        method: "GET",
        path: `repos/${this.#config.owner}/${this.#config.repo}/issues/${task_ref}`,
      });
    } catch (error) {
      if (error instanceof GitHubTransportError && /\b404\b|Not Found/iu.test(error.message)) {
        throw new TaskSourceError("TASK_NOT_FOUND", `/github-issue/${task_ref}`, "issue does not exist");
      }
      throw new TaskSourceError(
        "DOCUMENT_UNREADABLE",
        `/github-issue/${task_ref}`,
        error instanceof Error ? error.message : String(error),
      );
    }
    const issue = asIssue(raw, task_ref);
    if (issue.pull_request !== undefined) {
      // A PR is not a task representation on this surface.
      throw new TaskSourceError("TASK_NOT_FOUND", `/github-issue/${task_ref}`, "ref is a pull request");
    }
    return issue;
  }

  /** Complete bounded enumeration; a failed page is unreadable, never an empty tail. */
  #listIssues(state: "open" | "all"): readonly GitHubIssue[] {
    const issues: GitHubIssue[] = [];
    for (let page = 1; ; page += 1) {
      let raw: unknown;
      try {
        raw = this.#transport.api({
          method: "GET",
          path: `repos/${this.#config.owner}/${this.#config.repo}/issues?state=${state}&per_page=${PER_PAGE}&page=${page}`,
        });
      } catch (error) {
        throw new TaskSourceError(
          "DOCUMENT_UNREADABLE",
          `/github-issues/page/${page}`,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!Array.isArray(raw)) {
        throw new TaskSourceError("DOCUMENT_MALFORMED", `/github-issues/page/${page}`, "not an array");
      }
      for (const entry of raw) {
        const issue = asIssue(entry, "list");
        if (issue.pull_request === undefined) issues.push(issue);
      }
      if (raw.length < PER_PAGE) return issues;
    }
  }
}

function asIssue(raw: unknown, where: string): GitHubIssue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TaskSourceError("DOCUMENT_MALFORMED", `/github-issue/${where}`, "issue is not an object");
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record["number"] !== "number" ||
    typeof record["title"] !== "string" ||
    typeof record["state"] !== "string" ||
    typeof record["updated_at"] !== "string" ||
    (record["body"] !== null && typeof record["body"] !== "string" && record["body"] !== undefined)
  ) {
    throw new TaskSourceError("DOCUMENT_MALFORMED", `/github-issue/${where}`, "unexpected issue shape");
  }
  return {
    number: record["number"],
    title: record["title"],
    body: (record["body"] ?? null) as string | null,
    state: record["state"],
    updated_at: record["updated_at"],
    ...(record["pull_request"] === undefined ? {} : { pull_request: record["pull_request"] }),
  };
}

function stateOf(issue: GitHubIssue): ExternalTaskState {
  if (issue.state === "open") return "READY";
  if (issue.state === "closed") return "CLOSED";
  return "UNKNOWN";
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
