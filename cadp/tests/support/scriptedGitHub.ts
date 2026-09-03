/**
 * Scripted GitHubTransport: a stateful in-memory repository (refs, pulls, write-once
 * candidate ruleset) so C20/C21/C41 fault-interleavings are forced deterministically at the
 * transport seam while the GitHubAdapter code under test stays the production code.
 */

import type { GitHubTransport } from "../../kernel/adapters/github.ts";

export class ScriptedGitHubRepo implements GitHubTransport {
  readonly repo_id = "424242";
  readonly full_name = "astro3141/cadp-scripted";
  readonly refs = new Map<string, string>();
  readonly pulls: Array<{ number: number; head_ref: string; head_sha: string; base_ref: string; state: string; merged: boolean; merge_commit_sha?: string }> = [];
  rulesetActive = true;
  bundleDefect: string | undefined;
  /** Called between the precondition GET and the POST (the C20 pause window). */
  beforePrCreate: (() => void) | undefined;
  pushAmbiguous = false;
  prCreated = 0;

  /** An out-of-band principal attempts to move/delete a ref; the ruleset guards candidates. */
  outOfBandMove(ref: string, sha: string | undefined): "rejected" | "moved" {
    if (this.rulesetActive && ref.startsWith("refs/heads/cadp/candidate/") && this.refs.has(ref)) {
      return "rejected";
    }
    if (sha === undefined) this.refs.delete(ref);
    else this.refs.set(ref, sha);
    return "moved";
  }

  async api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const refMatch = /\/repos\/[^/]+\/git\/ref\/(.+)$/u.exec(path);
    if (method === "GET" && refMatch !== null) {
      const ref = `refs/${decodeURIComponent(refMatch[1]!)}`;
      const sha = this.refs.get(ref);
      return sha === undefined ? { status: 404, json: { message: "Not Found" } } : { status: 200, json: { object: { sha } } };
    }
    if (method === "GET" && /\/git\/commits\//u.test(path)) {
      return { status: 200, json: {} };
    }
    if (method === "POST" && /\/pulls$/u.test(path)) {
      this.beforePrCreate?.();
      const b = body as { title: string; head: string; base: string };
      const headRef = `refs/heads/${b.head}`;
      const sha = this.refs.get(headRef);
      if (sha === undefined) return { status: 422, json: { message: "head invalid" } };
      const number = this.pulls.length + 1;
      this.pulls.push({ number, head_ref: headRef, head_sha: sha, base_ref: `refs/heads/${b.base}`, state: "open", merged: false });
      this.prCreated += 1;
      return { status: 201, json: { number, head: { sha }, html_url: `https://github.test/pull/${number}` } };
    }
    const listMatch = /\/pulls\?state=all&head=([^&]+)/u.exec(path);
    if (method === "GET" && listMatch !== null) {
      const headRef = `refs/heads/${decodeURIComponent(listMatch[1]!).split(":")[1]}`;
      const items = this.pulls.filter((p) => p.head_ref === headRef).map((p) => ({ number: p.number, head: { sha: p.head_sha } }));
      return { status: 200, json: items };
    }
    const mergeMatch = /\/pulls\/(\d+)\/merge$/u.exec(path);
    if (method === "PUT" && mergeMatch !== null) {
      const pr = this.pulls.find((p) => p.number === Number(mergeMatch[1]));
      if (pr === undefined) return { status: 404, json: {} };
      const requested = (body as { sha?: string }).sha;
      if (requested !== undefined && requested !== pr.head_sha) {
        return { status: 409, json: { message: "Head branch was modified" } };
      }
      pr.merged = true;
      pr.state = "closed";
      pr.merge_commit_sha = `merge-of-${pr.head_sha}`;
      return { status: 200, json: { merged: true, sha: pr.merge_commit_sha } };
    }
    const prMatch = /\/pulls\/(\d+)$/u.exec(path);
    if (method === "GET" && prMatch !== null) {
      const pr = this.pulls.find((p) => p.number === Number(prMatch[1]));
      if (pr === undefined) return { status: 404, json: {} };
      return { status: 200, json: { merged: pr.merged, merge_commit_sha: pr.merge_commit_sha ?? null, head: { sha: pr.head_sha } } };
    }
    return { status: 404, json: { message: `unscripted ${method} ${path}` } };
  }

  async verifyBundle(_bytes: Uint8Array, _new_sha: string): Promise<string | undefined> {
    return this.bundleDefect;
  }

  async push(
    _repo: string,
    ref: string,
    new_sha: string,
    expected_old_sha: string,
    _bundle: Uint8Array,
  ): Promise<{ kind: "ok" } | { kind: "rejected"; detail: string } | { kind: "ambiguous"; detail: string }> {
    if (this.pushAmbiguous) return { kind: "ambiguous", detail: "connection reset mid-push (injected)" };
    const current = this.refs.get(ref);
    const zero = "0".repeat(40);
    if (expected_old_sha === zero) {
      if (current !== undefined) return { kind: "rejected", detail: "[rejected] (stale info: ref exists)" };
      this.refs.set(ref, new_sha);
      return { kind: "ok" };
    }
    if (current !== expected_old_sha) return { kind: "rejected", detail: "[rejected] (stale info)" };
    this.refs.set(ref, new_sha);
    return { kind: "ok" };
  }

  async whoami(): Promise<{ account_id: string; login: string }> {
    return { account_id: "77", login: "cadp-pep" };
  }

  async repo(): Promise<{ repo_id: string; full_name: string; permissions: Record<string, unknown> }> {
    return { repo_id: this.repo_id, full_name: this.full_name, permissions: { push: true } };
  }
}
