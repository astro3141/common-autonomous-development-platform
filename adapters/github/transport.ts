/**
 * GitHubTransportV1 — the one process seam every GitHub-surface adapter shares.
 *
 * Production speaks through the authenticated `gh` CLI (`gh api`) and plain `git push` from the
 * canonical clone; tests inject a fake. The transport is deliberately dumb: no pagination policy,
 * no retry, no interpretation — those judgements belong to the adapters, because they are exactly
 * the places where "couldn't read" must stay distinct from "read and absent" (TD §8.4b, §15).
 *
 * Credentials stay behind this boundary (I-TD7): the CLI's ambient authentication is used and no
 * token value ever crosses into an adapter, model text, or Platform durable state.
 */

import { spawnSync } from "node:child_process";

export class GitHubTransportError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "GitHubTransportError";
  }
}

export interface GitHubApiRequest {
  readonly method: "GET" | "POST";
  /** REST path, e.g. `repos/{owner}/{repo}/issues?per_page=100&page=1`. */
  readonly path: string;
  /** JSON body for POST. */
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface GitHubTransportV1 {
  /** One REST call. Returns parsed JSON; any failure throws `GitHubTransportError`. */
  api(request: GitHubApiRequest): unknown;
  /**
   * Pushes the exact commit SHA from the local canonical clone to a remote ref, creating or
   * fast-forwarding it. A push that would move the ref to a *different* commit than requested
   * must fail rather than force.
   */
  push_commit(local_repo_path: string, sha: string, remote_ref: string): void;
}

/** Production transport over the authenticated `gh` CLI. */
export class GhCliTransport implements GitHubTransportV1 {
  api(request: GitHubApiRequest): unknown {
    const args = ["api", "-X", request.method, request.path];
    if (request.body !== undefined) {
      args.push("--input", "-");
    }
    const result = spawnSync("gh", args, {
      encoding: "utf8",
      input: request.body === undefined ? undefined : JSON.stringify(request.body),
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error !== undefined) {
      throw new GitHubTransportError(`gh api spawn failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new GitHubTransportError(
        `gh api ${request.method} ${request.path} exited ${result.status}: ${truncate(result.stderr)}`,
      );
    }
    try {
      return JSON.parse(result.stdout === "" ? "null" : result.stdout) as unknown;
    } catch {
      throw new GitHubTransportError(`gh api ${request.path} returned non-JSON output`);
    }
  }

  push_commit(local_repo_path: string, sha: string, remote_ref: string): void {
    // No --force: an existing ref at a different commit is a conflict the caller must see.
    const result = spawnSync("git", ["push", "origin", `${sha}:${remote_ref}`], {
      cwd: local_repo_path,
      encoding: "utf8",
    });
    if (result.error !== undefined) {
      throw new GitHubTransportError(`git push spawn failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new GitHubTransportError(
        `git push ${sha}:${remote_ref} exited ${result.status}: ${truncate(result.stderr)}`,
      );
    }
  }
}

function truncate(text: string): string {
  const line = text.trim().split("\n").at(-1) ?? "";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
