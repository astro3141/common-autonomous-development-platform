/**
 * A throwaway Git repository for adapter integration tests.
 *
 * Everything is created under the OS temp directory and removed again, and every git invocation
 * is repository-local: identity comes from `git config` inside the temp repo, so the developer's
 * global configuration is neither read as authority nor modified. The canonical branch is called
 * `trunk` on purpose — a test that passed only for `main` would not prove the adapter avoids
 * hardcoding a branch name.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CANONICAL_BRANCH = "trunk";
export const CANONICAL_REF = `refs/heads/${CANONICAL_BRANCH}`;

const run = (cwd: string, argv: readonly string[]): string =>
  execFileSync("git", [...argv], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export interface TempGitRepo {
  readonly root: string;
  readonly workspaceRoot: string;
  /** Adapter config for this repository. */
  config(): { root: string; canonical_ref: string; workspace_root: string };
  /** Writes a file and commits it on the current branch of `cwd`, returning the new commit id. */
  commit(options: { path: string; content: string; message: string; cwd?: string }): string;
  /** Current commit of `cwd` (the canonical root by default). */
  head(cwd?: string): string;
  /** Raw git, for arranging repository state a test needs. */
  git(argv: readonly string[], cwd?: string): string;
  dispose(): void;
}

export function tempGitRepo(): TempGitRepo {
  const base = mkdtempSync(join(tmpdir(), "platform-git-"));
  const root = join(base, "canonical");
  const workspaceRoot = join(base, "workspaces");
  mkdirSync(root);
  mkdirSync(workspaceRoot);

  run(root, ["init", "--quiet"]);
  run(root, ["symbolic-ref", "HEAD", CANONICAL_REF]);
  run(root, ["config", "user.name", "Platform Test"]);
  run(root, ["config", "user.email", "platform-test@example.invalid"]);
  run(root, ["config", "commit.gpgsign", "false"]);

  const repo: TempGitRepo = {
    root,
    workspaceRoot,
    config: () => ({ root, canonical_ref: CANONICAL_REF, workspace_root: workspaceRoot }),
    commit({ path, content, message, cwd = root }) {
      writeFileSync(join(cwd, path), content);
      run(cwd, ["add", "--", path]);
      run(cwd, ["commit", "--quiet", "-m", message]);
      return run(cwd, ["rev-parse", "HEAD"]).trim();
    },
    head: (cwd = root) => run(cwd, ["rev-parse", "HEAD"]).trim(),
    git: (argv, cwd = root) => run(cwd, argv),
    dispose() {
      rmSync(base, { recursive: true, force: true });
    },
  };

  return repo;
}

/** Runs `body` against a fresh repository and always cleans the temp directory up. */
export function withGitRepo<T>(body: (repo: TempGitRepo) => T): T {
  const repo = tempGitRepo();
  try {
    return body(repo);
  } finally {
    repo.dispose();
  }
}
