/**
 * Opt-in macOS enforcement regression for Issue #46.
 *
 * This executes the exact named-profile argv used by CodexCliRuntimeAdapter through `codex
 * sandbox`. It needs the inspected local Codex CLI and Homebrew Git, so the ordinary hermetic suite
 * skips it unless an operator deliberately enables the probe.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_CLI_WORKSPACE_COMMIT_PERMISSION_PROFILE,
  CODEX_CLI_WORKSPACE_COMMIT_SANDBOX_ARGS,
} from "../adapters/codex-cli-runtime/index.ts";
import { LocalGitRepositoryAdapter } from "../adapters/local-git/index.ts";

const ENABLED = process.env["ADP_CODEX_CLI_SANDBOX_ENFORCEMENT"] === "1";
const CODEX = process.env["ADP_CODEX_CLI_BIN"] ?? "/opt/homebrew/bin/codex";
const GIT = process.env["ADP_SANDBOX_GIT_BIN"] ?? "/opt/homebrew/bin/git";

test(
  "#46: the real Codex named sandbox permits candidate commit and denies Git indirection/canonical writes",
  {
    skip: ENABLED ? false : "set ADP_CODEX_CLI_SANDBOX_ENFORCEMENT=1 for the local macOS probe",
    timeout: 120_000,
  },
  () => {
    assert.equal(process.platform, "darwin", "the inspected enforcement seam is macOS Seatbelt");
    assert.equal(existsSync(CODEX), true, `Codex CLI not found at ${CODEX}`);
    assert.equal(existsSync(GIT), true, `Git not found at ${GIT}`);

    const root = mkdtempSync(join(homedir(), ".adp-codex-sandbox-enforcement."));
    const canonical = join(root, "canonical");
    const workspaceRoot = join(root, "workspaces");
    mkdirSync(canonical);
    mkdirSync(workspaceRoot);

    try {
      git(canonical, ["init", "--quiet"]);
      git(canonical, ["symbolic-ref", "HEAD", "refs/heads/trunk"]);
      git(canonical, ["config", "user.name", "ADP Sandbox Probe"]);
      git(canonical, ["config", "user.email", "adp-sandbox@example.invalid"]);
      git(canonical, ["config", "commit.gpgsign", "false"]);
      writeFileSync(join(canonical, "base.txt"), "base\n", "utf8");
      git(canonical, ["add", "--", "base.txt"]);
      git(canonical, ["commit", "--quiet", "-m", "base"]);
      const base = git(canonical, ["rev-parse", "HEAD"]).trim();
      const canonicalStatus = git(canonical, ["status", "--porcelain=v1"]);

      const repository = new LocalGitRepositoryAdapter({
        root: canonical,
        canonical_ref: "refs/heads/trunk",
        workspace_root: workspaceRoot,
      });
      const workspace = repository.create_feature_workspace({
        base_head: base,
        op_key: "op:issue-46:real-sandbox-enforcement:workspace",
      });

      // The held positive control: normal Actor mutation, index write, object write and ref update.
      assertAllowed("Actor file mutation", sandbox(workspace.path, ["/usr/bin/touch", "actor.txt"]));
      assertAllowed("git add", sandbox(workspace.path, [GIT, "add", "--", "actor.txt"]));
      assertAllowed(
        "candidate commit",
        sandbox(workspace.path, [GIT, "commit", "--quiet", "-m", "actor candidate"]),
      );
      const candidate = git(workspace.path, ["rev-parse", "HEAD"]).trim();
      assert.notEqual(candidate, base);
      assert.equal(repository.inspect_candidate(workspace).candidate_commit, candidate);
      assert.equal(git(workspace.path, ["status", "--porcelain=v1"]), "");

      const denied: Record<string, number | null> = {};
      const deny = (name: string, command: readonly string[]): void => {
        const result = sandbox(workspace.path, command);
        assertDenied(name, result);
        denied[name] = result.status;
      };

      // Git-directory indirection must not be creatable or rewritable by the Actor.
      deny("git_commondir", ["/usr/bin/touch", ".git/commondir"]);
      deny("git_gitdir", ["/usr/bin/touch", ".git/gitdir"]);
      deny("git_worktrees", ["/bin/mkdir", ".git/worktrees"]);

      // Existing config, hooks, and object-redirection carve-outs remain held.
      deny("git_config", ["/usr/bin/touch", ".git/config"]);
      deny("git_config_worktree", ["/usr/bin/touch", ".git/config.worktree"]);
      deny("git_hooks", ["/usr/bin/touch", ".git/hooks/adp-probe"]);
      deny("git_objects_info", ["/usr/bin/touch", ".git/objects/info/alternates"]);

      // The assigned workspace is not authority to mutate any canonical plane.
      deny("canonical_file", ["/usr/bin/touch", join(canonical, "forbidden.txt")]);
      deny("canonical_index", [GIT, "-C", canonical, "commit", "--allow-empty", "-m", "forbidden"]);
      deny("canonical_object_db", [
        "/usr/bin/touch",
        join(canonical, ".git", "objects", "adp-probe"),
      ]);

      assert.equal(existsSync(join(workspace.path, ".git", "commondir")), false);
      assert.equal(existsSync(join(workspace.path, ".git", "gitdir")), false);
      assert.equal(existsSync(join(workspace.path, ".git", "worktrees")), false);
      assert.equal(existsSync(join(workspace.path, ".git", "hooks", "adp-probe")), false);
      assert.equal(existsSync(join(workspace.path, ".git", "objects", "info", "alternates")), false);
      assert.equal(existsSync(join(canonical, "forbidden.txt")), false);
      assert.equal(git(canonical, ["rev-parse", "HEAD"]).trim(), base);
      assert.equal(git(canonical, ["status", "--porcelain=v1"]), canonicalStatus);

      const canonicalObject = spawnSync(GIT, ["cat-file", "-e", `${candidate}^{commit}`], {
        cwd: canonical,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.notEqual(canonicalObject.status, 0, "candidate entered canonical before Human merge");

      console.log(
        `CODEX_CLI_SANDBOX_ENFORCEMENT_RESULT=${JSON.stringify({
          profile: CODEX_CLI_WORKSPACE_COMMIT_PERMISSION_PROFILE,
          base_commit: base,
          candidate_commit: candidate,
          candidate_commit_created: true,
          denied,
          candidate_absent_from_canonical_object_store: true,
          canonical_unchanged: true,
        })}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

function git(cwd: string, argv: readonly string[]): string {
  return execFileSync(GIT, [...argv], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sandbox(cwd: string, command: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(
    CODEX,
    [
      "sandbox",
      ...CODEX_CLI_WORKSPACE_COMMIT_SANDBOX_ARGS,
      "--permission-profile",
      CODEX_CLI_WORKSPACE_COMMIT_PERMISSION_PROFILE,
      "--cd",
      cwd,
      "--",
      ...command,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function assertAllowed(name: string, result: SpawnSyncReturns<string>): void {
  assert.equal(result.error, undefined, `${name}: ${String(result.error)}`);
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
}

function assertDenied(name: string, result: SpawnSyncReturns<string>): void {
  assert.equal(result.error, undefined, `${name}: ${String(result.error)}`);
  assert.notEqual(result.status, 0, `${name}: write unexpectedly succeeded`);
  assert.match(`${result.stdout}\n${result.stderr}`, /Operation not permitted/);
}
