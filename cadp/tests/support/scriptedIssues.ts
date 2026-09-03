/**
 * Scripted GitHub Issues transport (TD §13.3 conformance for FINDING_PROJECT). In-memory issues +
 * comments store behind the exact GitHubTransport.api() seam; the adapter/kernel path stays the
 * production path. Fault knobs model post-send reply loss and enumeration lag (UNKNOWN, never
 * no-effect-by-absence).
 */

import type { GitHubTransport } from "../../kernel/adapters/github.ts";

interface Issue { number: number; body: string; html_url: string }
interface Comment { id: number; body: string }

export class ScriptedIssues implements GitHubTransport {
  readonly issues: Issue[] = [];
  readonly comments = new Map<number, Comment[]>();
  #nextIssue = 1;
  #nextComment = 1000;

  /** When set, a POST create/comment records the effect but the reply is reported as lost. */
  dropCreateReply = false;
  /** When true, GET enumerations hide issues/comments (post-send lag) so reconcile is UNKNOWN. */
  hideOnList = false;
  /** Count of real issue-create effects that took the target side (external-effect delta). */
  createdIssues = 0;
  createdComments = 0;

  async api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const [rawPath] = path.split("?");
    const query = new URLSearchParams(path.includes("?") ? path.slice(path.indexOf("?") + 1) : "");
    // POST /repos/{id}/issues
    if (method === "POST" && /\/issues$/u.test(rawPath!)) {
      const b = body as { title: string; body: string };
      const issue: Issue = { number: this.#nextIssue++, body: b.body, html_url: `https://github.test/i/${this.#nextIssue}` };
      this.issues.push(issue);
      this.createdIssues += 1;
      if (this.dropCreateReply) return Promise.reject(new Error("network reset after send"));
      return { status: 201, json: issue };
    }
    // POST /repos/{id}/issues/{n}/comments
    const cm = /\/issues\/(\d+)\/comments$/u.exec(rawPath!);
    if (method === "POST" && cm) {
      const n = Number(cm[1]);
      const b = body as { body: string };
      const comment: Comment = { id: this.#nextComment++, body: b.body };
      const list = this.comments.get(n) ?? [];
      list.push(comment);
      this.comments.set(n, list);
      this.createdComments += 1;
      if (this.dropCreateReply) return Promise.reject(new Error("network reset after send"));
      return { status: 201, json: comment };
    }
    // GET /repos/{id}/issues (list)
    if (method === "GET" && /\/issues$/u.test(rawPath!)) {
      const page = Number(query.get("page") ?? "1");
      const items = this.hideOnList ? [] : this.issues;
      return { status: 200, json: page === 1 ? items : [] };
    }
    // GET /repos/{id}/issues/{n}/comments (list)
    const gc = /\/issues\/(\d+)\/comments$/u.exec(rawPath!);
    if (method === "GET" && gc) {
      const n = Number(gc[1]);
      const page = Number(query.get("page") ?? "1");
      const items = this.hideOnList ? [] : (this.comments.get(n) ?? []);
      return { status: 200, json: page === 1 ? items : [] };
    }
    return { status: 404, json: { message: `unscripted ${method} ${rawPath}` } };
  }

  async push(): Promise<{ kind: "ambiguous"; detail: string }> {
    return { kind: "ambiguous", detail: "push not supported by issues transport" };
  }
  async verifyBundle(): Promise<string | undefined> { return "not supported"; }
  async whoami(): Promise<{ account_id: string; login: string }> { return { account_id: "acct-1", login: "cadp-test" }; }
  async repo(repo_id: string): Promise<{ repo_id: string; full_name: string; permissions: Record<string, unknown> }> {
    return { repo_id, full_name: `cadp-test/${repo_id}`, permissions: { push: true } };
  }
}
