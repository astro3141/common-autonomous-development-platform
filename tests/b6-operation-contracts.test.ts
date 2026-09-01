/**
 * MVP1-B6 areas A–C — the two M1-8 contracts are exactly what TD fixes, and the production
 * LocalGit workspace identity is deterministic, injective and fail-closed.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { LocalGitRepositoryAdapter } from "../adapters/local-git/local-git-repository-adapter.ts";
import { withGitRepo } from "./support/temp-git-repo.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The member names an `interface X { ... }` block declares, in source order. */
function interfaceFields(file: string, name: string): string[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const start = source.indexOf(`export interface ${name} {`);
  assert.notEqual(start, -1, `${name} is not declared in ${file}`);
  const body = source.slice(start, source.indexOf("\n}", start));
  return [...body.matchAll(/^\s+readonly\s+([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map(
    (match) => match[1] as string,
  );
}

// --- area A: RuntimeOperationContextV1 -----------------------------------------------------

test("B6-2 (A): the operation context is exactly one field, and no metadata bag exists", () => {
  assert.deepEqual(
    interfaceFields("adapters/interfaces/runtime-adapter.ts", "RuntimeOperationContextV1"),
    ["op_key"],
  );

  const source = readFileSync(join(ROOT, "adapters/interfaces/runtime-adapter.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const forbidden of [
    /AdapterContext/,
    /\bheaders\b/,
    /trace_?context/i,
    /\bmetadata\b/,
    /extension|extras|\bbag\b/i,
  ]) {
    assert.equal(forbidden.test(source), false, `runtime-adapter.ts declares ${forbidden}`);
  }

  // The context leads both operations that carry an external identity, and no other.
  const spawn = /spawn_session\(\s*operation_context: RuntimeOperationContextV1,/.test(source);
  const send = /send_turn\(\s*operation_context: RuntimeOperationContextV1,/.test(source);
  assert.equal(spawn && send, true, "spawn_session and send_turn take the context first");
  assert.equal(
    (source.match(/RuntimeOperationContextV1/g) ?? []).length,
    3,
    "the declaration plus exactly two operations",
  );
});

// --- area B: CreateFeatureWorkspaceRequestV1 -------------------------------------------------

test("B6-3 (B): the workspace request is exactly two fields and the result is unchanged", () => {
  assert.deepEqual(
    interfaceFields("adapters/interfaces/repository-adapter.ts", "CreateFeatureWorkspaceRequestV1"),
    ["base_head", "op_key"],
  );
  // No new workspace result type: `FeatureWorkspace` is still the three-member B3 fact.
  assert.deepEqual(
    interfaceFields("adapters/interfaces/repository-adapter.ts", "FeatureWorkspace"),
    ["path", "base_head", "branch"],
  );

  // §4 — the rest of the B3 primitive surface is untouched.
  const source = readFileSync(join(ROOT, "adapters/interfaces/repository-adapter.ts"), "utf8");
  const operations = [...source.matchAll(/^\s{2}([a-z_]+)\(/gm)].map((match) => match[1] as string);
  assert.deepEqual(operations, [
    "snapshot_canonical",
    "create_feature_workspace",
    "inspect_candidate",
    "get_diff",
    "verify_tracked_clean",
    "verify_expected_files",
    "verify_lineage",
    "verify_canonical_head",
    "prepare_merge",
    "commit_merge",
  ]);
});

// --- area C: LocalGit deterministic create-or-reacquire ---------------------------------------

const OP_A = "op:attempt:task:alpha:T-101:1:workspace";
const OP_B = "op:attempt:task:alpha:T-102:1:workspace";

test("B6-4 / B6-5 (C): the same op key names the same isolated clone", () => {
  withGitRepo((repo) => {
    const base = repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());

    const first = adapter.create_feature_workspace({ base_head: base, op_key: OP_A });
    const again = adapter.create_feature_workspace({ base_head: base, op_key: OP_A });

    assert.deepEqual(again, first, "same path, same branch, same base");
    const linkedWorktrees = repo
      .git(["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree ") && line.includes("ws-"));
    assert.equal(linkedWorktrees.length, 0, "the workspace is not linked to canonical metadata");
    assert.equal(statSync(join(first.path, ".git")).isDirectory(), true);

    // The name is derived from the operation, not from a first-free scan.
    assert.equal(first.branch.startsWith("ws-"), true);
    assert.equal(first.branch.includes("1"), true, "the attempt ordinal survives the encoding");
  });
});

test("B6-5 (C): a re-acquisition still works after the branch has moved on", () => {
  withGitRepo((repo) => {
    const base = repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());
    const workspace = adapter.create_feature_workspace({ base_head: base, op_key: OP_A });

    // The Actor commits; the workspace is still the same logical workspace.
    repo.commit({ path: "work.txt", content: "x\n", message: "B", cwd: workspace.path });

    const reacquired = adapter.create_feature_workspace({ base_head: base, op_key: OP_A });
    assert.deepEqual(reacquired, workspace);
  });
});

test("B6-6 (C): the same op key against a different base fails closed", () => {
  withGitRepo((repo) => {
    const a = repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const b = repo.commit({ path: "b.txt", content: "b\n", message: "B" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());

    const workspace = adapter.create_feature_workspace({ base_head: a, op_key: OP_A });
    assert.throws(() => adapter.create_feature_workspace({ base_head: b, op_key: OP_A }));

    // No second workspace was created by the failed call.
    const linkedWorktrees = repo
      .git(["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree ") && line.includes("ws-"));
    assert.equal(linkedWorktrees.length, 0);
    assert.equal(statSync(join(workspace.path, ".git")).isDirectory(), true);
  });
});

test("B6-4 (C): different op keys never alias, and the encoding is injective", () => {
  withGitRepo((repo) => {
    const base = repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());

    const first = adapter.create_feature_workspace({ base_head: base, op_key: OP_A });
    const second = adapter.create_feature_workspace({ base_head: base, op_key: OP_B });

    assert.notEqual(first.path, second.path);
    assert.notEqual(first.branch, second.branch);
    assert.equal(existsSync(first.path) && existsSync(second.path), true);

    // Keys that differ only in a separator must not collide once encoded.
    const tricky = ["op:a:b", "op-a-b", "op:a-b", "op_a_b"];
    const names = new Set(
      tricky.map(
        (op_key) => adapter.create_feature_workspace({ base_head: base, op_key }).branch,
      ),
    );
    assert.equal(names.size, tricky.length, "the encoding is injective");
  });
});

test("B6-4 (C): an empty operation identity is refused before any git command runs", () => {
  withGitRepo((repo) => {
    const base = repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());

    assert.throws(() => adapter.create_feature_workspace({ base_head: base, op_key: "" }));
    assert.equal(repo.git(["worktree", "list", "--porcelain"]).includes("ws-"), false);
  });
});
