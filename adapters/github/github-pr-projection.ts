/**
 * GitHubPullRequestProjection — `PullRequestProjectionAdapterV1` over one GitHub repository.
 *
 * Publish = push the exact candidate SHA to the requested head ref (never force; an existing ref
 * at a different commit is a definitive conflict), then open one PR. Reconcile = authoritative
 * REST list of pull requests for the exact head ref: found + head SHA equal → the same committed
 * projection; an authoritative empty answer → no effect; anything unprovable → UNKNOWN.
 */

import {
  PullRequestProjectionFailedError,
  type PullRequestProjectionAdapterV1,
  type PullRequestProjectionRequestV1,
  type PullRequestReceiptV1,
  type PullRequestReconcileResult,
} from "../interfaces/pull-request-projection.ts";
import { GitHubTransportError, type GitHubTransportV1 } from "./transport.ts";

export interface GitHubPrProjectionConfig {
  readonly owner: string;
  readonly repo: string;
  /** Local canonical clone the exact SHA is pushed from. */
  readonly canonical_repo_path: string;
}

export class GitHubPullRequestProjection implements PullRequestProjectionAdapterV1 {
  readonly #transport: GitHubTransportV1;
  readonly #config: GitHubPrProjectionConfig;

  constructor(transport: GitHubTransportV1, config: GitHubPrProjectionConfig) {
    this.#transport = transport;
    this.#config = config;
  }

  publish_candidate_pull_request(request: PullRequestProjectionRequestV1): {
    readonly status: "COMMITTED";
    readonly receipt: PullRequestReceiptV1;
  } {
    // #78 — read-only target binding before any external effect: the canonical clone's push
    // remote must name exactly the configured owner/repo. "The operator knows this origin is
    // correct" is not a control; a mismatch or an unprovable target refuses definitively
    // before reconcile listing, push and PR creation alike.
    this.#assertTargetBinding();
    // Convergence before effect: an existing PR for this head ref either is this projection
    // (same candidate) or proves a definitive conflict. Unprovable state stays a plain throw so
    // the caller's INTENT remains reconcilable and no external effect is attempted over it.
    const existing = this.reconcile_pull_request(request.head_branch, request.candidate_commit);
    if (existing.status === "COMMITTED") return { status: "COMMITTED", receipt: existing.receipt };
    if (existing.status === "UNKNOWN") {
      throw new Error(`pull request state for ${request.head_branch} is unprovable; not publishing`);
    }

    try {
      this.#transport.push_commit(
        this.#config.canonical_repo_path,
        request.candidate_commit,
        `refs/heads/${request.head_branch}`,
      );
    } catch (error) {
      // A non-fast-forward rejection means the ref names a different commit: this projection can
      // never happen as requested — definitive, not retryable.
      if (error instanceof GitHubTransportError && /reject|fast-forward|fetch first/iu.test(error.message)) {
        throw new PullRequestProjectionFailedError(
          `head ref ${request.head_branch} already names a different commit`,
        );
      }
      throw error;
    }

    const created = this.#transport.api({
      method: "POST",
      path: `repos/${this.#config.owner}/${this.#config.repo}/pulls`,
      body: {
        title: request.title,
        head: request.head_branch,
        base: request.base_branch,
        body: request.body,
      },
    });
    const pr = asPull(created);
    return {
      status: "COMMITTED",
      receipt: {
        pr_ref: String(pr.number),
        url: pr.url,
        head_branch: request.head_branch,
        candidate_commit: request.candidate_commit,
      },
    };
  }

  /** Proves configured owner/repo ↔ canonical clone push remote, or refuses definitively. */
  #assertTargetBinding(): void {
    let url: string;
    try {
      url = this.#transport.remote_url(this.#config.canonical_repo_path);
    } catch (error) {
      throw new PullRequestProjectionFailedError(
        `push target cannot be proven: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const target = parseGitHubTarget(url);
    if (target === null || target.owner !== this.#config.owner || target.repo !== this.#config.repo) {
      throw new PullRequestProjectionFailedError(
        `canonical push remote ${JSON.stringify(url)} does not name the configured ` +
          `${this.#config.owner}/${this.#config.repo}; refusing before any external effect`,
      );
    }
  }

  reconcile_pull_request(
    head_branch: string,
    candidate_commit: string,
  ): PullRequestReconcileResult {
    let raw: unknown;
    try {
      raw = this.#transport.api({
        method: "GET",
        path: `repos/${this.#config.owner}/${this.#config.repo}/pulls?state=all&head=${this.#config.owner}:${head_branch}&per_page=100`,
      });
    } catch {
      return { status: "UNKNOWN" };
    }
    if (!Array.isArray(raw)) return { status: "UNKNOWN" };
    if (raw.length === 0) return { status: "NO_EFFECT_CONFIRMED" };

    const pulls = raw.map(asPullOrNull).filter((pull) => pull !== null);
    if (pulls.length !== raw.length) return { status: "UNKNOWN" };
    const exact = pulls.filter((pull) => pull.head_sha === candidate_commit);
    if (exact.length === 1 && pulls.length === 1) {
      const pull = exact[0]!;
      return {
        status: "COMMITTED",
        receipt: {
          pr_ref: String(pull.number),
          url: pull.url,
          head_branch,
          candidate_commit,
        },
      };
    }
    // PRs exist for the ref but not (only) at the exact candidate: a projection for *this*
    // candidate provably cannot be created against that ref.
    throw new PullRequestProjectionFailedError(
      `head ref ${head_branch} carries a pull request for a different commit`,
    );
  }
}

interface PullShape {
  readonly number: number;
  readonly url: string;
  readonly head_sha: string;
}

function asPull(raw: unknown): PullShape {
  const pull = asPullOrNull(raw);
  if (pull === null) throw new Error("pull request response has an unexpected shape");
  return pull;
}

function asPullOrNull(raw: unknown): PullShape | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const head = record["head"];
  const head_sha =
    typeof head === "object" && head !== null && !Array.isArray(head)
      ? (head as Record<string, unknown>)["sha"]
      : undefined;
  if (typeof record["number"] !== "number" || typeof head_sha !== "string") return null;
  const url = typeof record["html_url"] === "string" ? record["html_url"] : "";
  return { number: record["number"], url, head_sha };
}

/** Parses `owner/repo` out of the measured GitHub remote forms (https and ssh); null otherwise. */
function parseGitHubTarget(url: string): { readonly owner: string; readonly repo: string } | null {
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(url) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(url) ??
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(url);
  return match === null ? null : { owner: match[1]!, repo: match[2]! };
}
