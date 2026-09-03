/**
 * Live GitHubTransport (TD §6.4/§11): api.github.com REST + git CLI. The token is loaded by
 * the Kernel Service from the secret path and never leaves this process. Pushes materialize
 * the verified bundle in an ephemeral bare repository and push exactly `new_sha:ref` with
 * `--force-with-lease=<ref>:<expected_old_sha>`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GitHubTransport } from "./github.ts";

export class LiveGitHubTransport implements GitHubTransport {
  readonly #token: string;
  readonly #fullName: string; // owner/name — used for the push remote only

  constructor(token: string, fullName: string) {
    this.#token = token;
    this.#fullName = fullName;
  }

  async api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    // Numeric repo ids route through /repositories/<id>.
    const rewritten = path.replace(/^\/repos\/(\d+)(\/|$)/u, "/repositories/$1$2");
    const res = await fetch(`https://api.github.com${rewritten}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    return { status: res.status, json };
  }

  async verifyBundle(bundleBytes: Uint8Array, new_sha: string): Promise<string | undefined> {
    const dir = mkdtempSync(join(tmpdir(), "cadp-bundle-"));
    try {
      const bundlePath = join(dir, "candidate.bundle");
      writeFileSync(bundlePath, bundleBytes);
      const verify = spawnSync("git", ["bundle", "verify", bundlePath], { encoding: "utf8", cwd: dir });
      if (verify.status !== 0) return `verify failed: ${verify.stderr.trim().slice(0, 300)}`;
      const heads = spawnSync("git", ["bundle", "list-heads", bundlePath], { encoding: "utf8", cwd: dir });
      const lines = heads.stdout.trim().split("\n").filter((l) => l.length > 0);
      if (lines.length !== 1) return `bundle must carry exactly one ref, has ${lines.length}`;
      const tip = lines[0]!.split(" ")[0];
      if (tip !== new_sha) return `bundle tip ${tip} is not new_sha ${new_sha}`;
      return undefined;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async push(
    _repo_id: string,
    ref: string,
    new_sha: string,
    expected_old_sha: string,
    bundleBytes: Uint8Array,
  ): Promise<{ kind: "ok" } | { kind: "rejected"; detail: string } | { kind: "ambiguous"; detail: string }> {
    const dir = mkdtempSync(join(tmpdir(), "cadp-push-"));
    try {
      const bundlePath = join(dir, "candidate.bundle");
      writeFileSync(bundlePath, bundleBytes);
      const bare = join(dir, "bare.git");
      let r = spawnSync("git", ["init", "--bare", bare], { encoding: "utf8" });
      if (r.status !== 0) return { kind: "ambiguous", detail: `init: ${r.stderr}` };
      r = spawnSync("git", ["--git-dir", bare, "fetch", bundlePath, `${new_sha}:refs/cadp/incoming`], { encoding: "utf8" });
      if (r.status !== 0) return { kind: "ambiguous", detail: `bundle fetch: ${r.stderr.slice(0, 300)}` };
      const remote = `https://x-access-token:${this.#token}@github.com/${this.#fullName}.git`;
      r = spawnSync(
        "git",
        ["--git-dir", bare, "push", `--force-with-lease=${ref}:${expected_old_sha}`, remote, `${new_sha}:${ref}`],
        { encoding: "utf8", timeout: 60_000 },
      );
      if (r.status === 0) return { kind: "ok" };
      const stderr = (r.stderr ?? "").toString();
      if (/stale info|\[rejected\]|non-fast-forward|failed to push some refs|protected branch|GH013/u.test(stderr)) {
        return { kind: "rejected", detail: stderr.slice(0, 500) };
      }
      return { kind: "ambiguous", detail: stderr.slice(0, 500) || `push exited ${r.status}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async whoami(): Promise<{ account_id: string; login: string }> {
    const res = await this.api("GET", "/user");
    if (res.status !== 200) throw new Error(`GET /user ${res.status}`);
    const user = res.json as { id: number; login: string };
    return { account_id: String(user.id), login: user.login };
  }

  async repo(repo_id: string): Promise<{ repo_id: string; full_name: string; permissions: Record<string, unknown> } | undefined> {
    const res = await this.api("GET", /^\d+$/u.test(repo_id) ? `/repos/${repo_id}` : `/repos/${repo_id}`);
    if (res.status !== 200) return undefined;
    const repo = res.json as { id: number; full_name: string; permissions?: Record<string, unknown> };
    return { repo_id: String(repo.id), full_name: repo.full_name, permissions: repo.permissions ?? {} };
  }
}
