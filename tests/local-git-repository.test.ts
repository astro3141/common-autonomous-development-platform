/**
 * RG1 ~ RG38 — LocalGitRepositoryAdapter against a real temporary Git repository (TD §14.3).
 *
 * Every test builds its own repository under the OS temp directory; no test touches a project
 * repository, a remote or the developer's git configuration.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  LocalGitRepositoryAdapter,
  RepositoryConfigError,
  validateLocalGitRepositoryConfig,
} from "../adapters/local-git/local-git-repository-adapter.ts";
import { GitError } from "../adapters/local-git/git.ts";
import { CANONICAL_REF, withGitRepo, type TempGitRepo } from "./support/temp-git-repo.ts";

/**
 * A workspace request (M1-8). `op_key` is the operation's identity, so every arrangement that
 * wants a *distinct* workspace has to ask under a distinct one.
 */
const request = (base_head: string, op_key = "op:att-1:workspace") => ({ base_head, op_key });

/** The shared arrangement: canonical A, a workspace off A, and a candidate B inside it. */
const withCandidate = <T>(
  body: (context: {
    repo: TempGitRepo;
    adapter: LocalGitRepositoryAdapter;
    base: string;
    workspace: ReturnType<LocalGitRepositoryAdapter["create_feature_workspace"]>;
    candidate: string;
  }) => T,
): T =>
  withGitRepo((repo) => {
    const base = repo.commit({ path: "README.md", content: "base\n", message: "A" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());
    const workspace = adapter.create_feature_workspace(request(base));
    const candidate = repo.commit({
      path: "src.txt",
      content: "candidate\n",
      message: "B",
      cwd: workspace.path,
    });
    return body({ repo, adapter, base, workspace, candidate });
  });

// --- construction and config ----------------------------------------------------------

test("M1B3-AC6: the canonical ref comes from config and is never guessed", () => {
  withGitRepo((repo) => {
    const a = repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());

    // The repository's branch is `trunk`; nothing about `main` or `master` is assumed.
    assert.equal(adapter.snapshot_canonical().ref, CANONICAL_REF);
    assert.equal(adapter.snapshot_canonical().head, a);

    assert.throws(
      () => new LocalGitRepositoryAdapter({ ...repo.config(), canonical_ref: "refs/heads/absent" }),
      (error: unknown) => error instanceof RepositoryConfigError && error.field === "canonical_ref",
    );
  });
});

test("M1B3-AC1: construction fails closed on a missing directory or a non-repository", () => {
  withGitRepo((repo) => {
    repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    assert.throws(
      () => new LocalGitRepositoryAdapter({ ...repo.config(), root: join(repo.root, "absent") }),
      (error: unknown) => error instanceof RepositoryConfigError && error.field === "root",
    );
    // An existing directory that is not a Git repository is refused just as firmly.
    const plain = join(repo.workspaceRoot, "plain");
    mkdirSync(plain);
    assert.throws(
      () => new LocalGitRepositoryAdapter({ ...repo.config(), root: plain }),
      (error: unknown) => error instanceof RepositoryConfigError && error.field === "root",
    );
  });
});

test("M1B3-AC6: the adapter config schema is exact and never defaulted", () => {
  withGitRepo((repo) => {
    const config = repo.config();
    assert.deepEqual(validateLocalGitRepositoryConfig(config), {
      ...config,
      root: repo.root,
    });
    for (const broken of [
      {},
      { ...config, root: undefined },
      { ...config, canonical_ref: "" },
      { ...config, extra: 1 },
      { ...config, root: "relative/path" },
      { ...config, workspace_root: join(repo.root, "inside") },
    ]) {
      assert.throws(() => validateLocalGitRepositoryConfig(broken), RepositoryConfigError);
    }
  });
});

// --- RG1 ~ RG5: canonical snapshot ------------------------------------------------------

test("RG1 / RG3 / RG4 / M1B3-AC7 / AC8: canonical facts are exact and follow the ref", () => {
  withGitRepo((repo) => {
    const a = repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());

    assert.equal(adapter.snapshot_canonical().head, a, "RG1");
    assert.equal(adapter.verify_canonical_head(a), true, "RG3");
    // An abbreviated id is not the canonical identity: no prefix matching.
    assert.equal(adapter.verify_canonical_head(a.slice(0, 8)), false);

    const b = repo.commit({ path: "b.txt", content: "b\n", message: "B" });
    assert.equal(adapter.snapshot_canonical().head, b);
    assert.equal(adapter.verify_canonical_head(a), false, "RG4");
    assert.equal(adapter.verify_canonical_head(b), true);
  });
});

test("RG2 / M1B3-AC7: a non-canonical checkout does not change the canonical fact", () => {
  withGitRepo((repo) => {
    const a = repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());

    // Someone checks out a side branch and commits on it; canonical must not move.
    repo.git(["checkout", "--quiet", "-b", "side"]);
    repo.commit({ path: "side.txt", content: "side\n", message: "S" });

    assert.equal(adapter.snapshot_canonical().head, a);
    assert.equal(adapter.verify_canonical_head(a), true);
  });
});

test("RG5 / M1B3-AC7 / AC15: observation operations mutate nothing", () => {
  withCandidate(({ repo, adapter, base, workspace, candidate }) => {
    const before = {
      canonical: repo.head(),
      workspace: repo.head(workspace.path),
      status: repo.git(["status", "--porcelain"]),
      reflog: repo.git(["reflog", "--all"]),
    };

    adapter.snapshot_canonical();
    adapter.verify_canonical_head(base);
    adapter.inspect_candidate(workspace);
    adapter.get_diff({ from: base, to: candidate });
    adapter.verify_tracked_clean();
    adapter.verify_tracked_clean(workspace);
    adapter.verify_expected_files({ from: base, to: candidate, allowed_paths: ["src.txt"] });
    adapter.verify_lineage(base, candidate);

    assert.equal(repo.head(), before.canonical);
    assert.equal(repo.head(workspace.path), before.workspace);
    assert.equal(repo.git(["status", "--porcelain"]), before.status);
    assert.equal(repo.git(["reflog", "--all"]), before.reflog, "no ref moved");
  });
});

// --- RG6 ~ RG11: workspaces --------------------------------------------------------------

test("RG6 ~ RG10 / M1B3-AC9 ~ AC11: a workspace starts at the supplied base and isolates canonical", () => {
  withGitRepo((repo) => {
    const a = repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const b = repo.commit({ path: "b.txt", content: "b\n", message: "B" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());

    // Deliberately not the canonical head: the workspace must follow the argument, not HEAD.
    const workspace = adapter.create_feature_workspace(request(a));

    assert.equal(workspace.base_head, a, "RG6");
    assert.equal(repo.head(workspace.path), a, "RG7");
    assert.equal(adapter.snapshot_canonical().head, b, "RG8");
    assert.notEqual(workspace.path, repo.root, "RG9");
    assert.equal(workspace.path.startsWith(repo.workspaceRoot), true);
    assert.equal(existsSync(join(workspace.path, "a.txt")), true);
    assert.equal(existsSync(join(workspace.path, "b.txt")), false, "the workspace is at A, not B");

    // RG10 — an Actor-like edit and commit inside the workspace leaves canonical alone.
    const candidate = repo.commit({
      path: "work.txt",
      content: "actor output\n",
      message: "C",
      cwd: workspace.path,
    });
    assert.equal(adapter.snapshot_canonical().head, b);
    assert.equal(repo.head(workspace.path), candidate);
    assert.equal(existsSync(join(repo.root, "work.txt")), false);

    // A different operation on the same base gets its own workspace — never a silent alias.
    const second = adapter.create_feature_workspace(request(a, "op:att-2:workspace"));
    assert.notEqual(second.path, workspace.path);
    assert.equal(repo.head(second.path), a);
  });
});

test("RG11 / M1B3-AC10: an unknown or malformed base fails closed with no workspace left", () => {
  withGitRepo((repo) => {
    repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());

    for (const base of ["0".repeat(40), "not-a-commit", "", "--upload-pack=x", "a b"]) {
      assert.throws(() => adapter.create_feature_workspace(request(base)));
    }
    assert.equal(repo.git(["worktree", "list", "--porcelain"]).includes("ws-"), false);
  });
});

// --- RG12 ~ RG15: candidate ---------------------------------------------------------------

test("RG12 / M1B3-AC14: a workspace still on its base reports no candidate", () => {
  withGitRepo((repo) => {
    const a = repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());
    const workspace = adapter.create_feature_workspace(request(a));

    const inspection = adapter.inspect_candidate(workspace);
    assert.equal(inspection.present, false);
    assert.equal(inspection.candidate_commit, null, "the base is never offered as a candidate");
    assert.equal(inspection.base_head, a);

    // An uncommitted working-tree change is still not a candidate.
    writeFileSync(join(workspace.path, "a.txt"), "edited\n");
    assert.equal(adapter.inspect_candidate(workspace).present, false);
    assert.equal(repo.head(workspace.path), a, "nothing was auto-committed");
  });
});

test("RG13 / RG14 / RG15 / M1B3-AC13: the candidate is read from Git, not from a claim", () => {
  withCandidate(({ repo, adapter, workspace, candidate }) => {
    assert.deepEqual(adapter.inspect_candidate(workspace), {
      present: true,
      candidate_commit: candidate,
      base_head: workspace.base_head,
    });

    // RG14 — a second commit moves the candidate to the new workspace HEAD.
    const second = repo.commit({
      path: "src.txt",
      content: "more\n",
      message: "C",
      cwd: workspace.path,
    });
    assert.equal(adapter.inspect_candidate(workspace).candidate_commit, second);

    // RG15 — the adapter takes no candidate argument at all, so no claim can override the fact.
    assert.equal(adapter.inspect_candidate.length, 1);
    assert.equal(adapter.inspect_candidate(workspace).candidate_commit, repo.head(workspace.path));
  });
});

// --- RG16 ~ RG19: tracked-clean ------------------------------------------------------------

test("RG16 ~ RG19 / M1B3-AC16: tracked-clean follows tracked files only", () => {
  withCandidate(({ repo, adapter, workspace }) => {
    assert.equal(adapter.verify_tracked_clean(workspace), true, "RG16");

    writeFileSync(join(workspace.path, "src.txt"), "modified\n");
    assert.equal(adapter.verify_tracked_clean(workspace), false, "RG17");

    repo.git(["add", "--", "src.txt"], workspace.path);
    assert.equal(adapter.verify_tracked_clean(workspace), false, "RG18");

    repo.commit({ path: "src.txt", content: "modified\n", message: "D", cwd: workspace.path });
    assert.equal(adapter.verify_tracked_clean(workspace), true, "RG19");

    // TD says *tracked* clean: an untracked file is deliberately not dirt.
    writeFileSync(join(workspace.path, "scratch.log"), "noise\n");
    assert.equal(adapter.verify_tracked_clean(workspace), true, "untracked files are not tracked dirt");

    // With no argument the question is about the canonical checkout instead.
    assert.equal(adapter.verify_tracked_clean(), true);
    writeFileSync(join(repo.root, "README.md"), "canonical edit\n");
    assert.equal(adapter.verify_tracked_clean(), false);
    assert.equal(adapter.verify_tracked_clean(workspace), true, "the two scopes are independent");
  });
});

// --- RG20 ~ RG23: diff ----------------------------------------------------------------------

test("RG20 ~ RG23 / M1B3-AC15: the diff is the repository's own, stable and read-only", () => {
  withCandidate(({ repo, adapter, base, workspace, candidate }) => {
    repo.commit({ path: "unrelated.txt", content: "canonical only\n", message: "U" });

    const diff = adapter.get_diff({ from: base, to: candidate });
    assert.deepEqual(diff.changed_paths, ["src.txt"], "RG20");
    assert.equal(diff.changed_paths.includes("unrelated.txt"), false, "RG21");
    assert.equal(diff.from, base);
    assert.equal(diff.to, candidate);
    assert.match(diff.patch, /\+candidate/);

    assert.deepEqual(adapter.get_diff({ from: base, to: candidate }), diff, "RG22");

    // RG23 — reading a diff changes nothing, in either tree.
    assert.equal(repo.head(workspace.path), candidate);
    assert.equal(repo.git(["status", "--porcelain"]), "");
    assert.throws(() => adapter.get_diff({ from: base, to: "0".repeat(40) }));
  });
});

// --- RG24 ~ RG26: expected files --------------------------------------------------------------

test("RG24 ~ RG26 / M1B3-AC17 / AC43: expected-file scope is a mechanical path comparison", () => {
  withCandidate(({ repo, adapter, base, workspace }) => {
    const candidate = repo.commit({
      path: "second.txt",
      content: "second\n",
      message: "C2",
      cwd: workspace.path,
    });

    // RG24 — the exact changed set is inside the allowed scope.
    assert.equal(
      adapter.verify_expected_files({
        from: base,
        to: candidate,
        allowed_paths: ["src.txt", "second.txt"],
      }),
      true,
    );
    // RG25 — one changed path outside the scope fails the whole question.
    assert.equal(
      adapter.verify_expected_files({ from: base, to: candidate, allowed_paths: ["src.txt"] }),
      false,
    );
    assert.equal(
      adapter.verify_expected_files({ from: base, to: candidate, allowed_paths: [] }),
      false,
      "an empty scope allows nothing",
    );

    // RG26 — escaping inputs fail closed rather than being normalized into something allowed.
    for (const escape of ["/etc", "../outside", "src/../../outside", "", "-x", ".."]) {
      assert.throws(
        () =>
          adapter.verify_expected_files({ from: base, to: candidate, allowed_paths: [escape] }),
        RepositoryConfigError,
        `${escape} must fail closed`,
      );
    }
    assert.equal(repo.head(workspace.path), candidate, "nothing was mutated by the checks");
  });
});

test("M1B3-AC17: a directory prefix matches its files but not a same-prefix sibling", () => {
  withGitRepo((repo) => {
    const base = repo.commit({ path: "seed.txt", content: "seed\n", message: "A" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());
    const workspace = adapter.create_feature_workspace(request(base));

    writeFileSync(join(workspace.path, "srcfile.txt"), "sibling\n");
    repo.git(["add", "--", "srcfile.txt"], workspace.path);
    repo.git(["commit", "--quiet", "-m", "sibling"], workspace.path);
    const candidate = repo.head(workspace.path);

    assert.equal(
      adapter.verify_expected_files({ from: base, to: candidate, allowed_paths: ["src"] }),
      false,
      "`src` must not match `srcfile.txt`",
    );
    assert.equal(
      adapter.verify_expected_files({ from: base, to: candidate, allowed_paths: ["srcfile.txt"] }),
      true,
    );
  });
});

// --- RG27 ~ RG32: lineage ---------------------------------------------------------------------

test("RG27 ~ RG30 / M1B3-AC18 ~ AC21: verify_lineage is ancestor → descendant", () => {
  withGitRepo((repo) => {
    const a = repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const b = repo.commit({ path: "b.txt", content: "b\n", message: "B" });
    const c = repo.commit({ path: "c.txt", content: "c\n", message: "C" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());

    assert.equal(adapter.verify_lineage(a, c), true, "RG27");
    assert.equal(adapter.verify_lineage(b, c), true);
    assert.equal(adapter.verify_lineage(c, c), true, "RG28: self");
    assert.equal(adapter.verify_lineage(c, a), false, "RG29: reverse");
    assert.equal(adapter.verify_lineage(c, b), false);

    // RG30 — an unrelated root commit shares no ancestry in either direction.
    repo.git(["checkout", "--quiet", "--orphan", "detached"]);
    repo.git(["rm", "-rf", "--quiet", "."]);
    const unrelated = repo.commit({ path: "z.txt", content: "z\n", message: "Z" });
    assert.equal(adapter.verify_lineage(unrelated, c), false);
    assert.equal(adapter.verify_lineage(c, unrelated), false);

    // An unknown commit is an operational failure, never a quiet `false`.
    assert.throws(() => adapter.verify_lineage("0".repeat(40), c));
    assert.throws(() => adapter.verify_lineage(a, "not-a-commit"));
  });
});

test("RG31 / M1B3-AC22: the Actor direction is verify_lineage(base_head, candidate)", () => {
  withCandidate(({ adapter, base, candidate }) => {
    assert.equal(adapter.verify_lineage(base, candidate), true);
    assert.equal(adapter.verify_lineage(candidate, base), false, "the direction is not symmetric");
  });
});

test("RG32 / RG cluster / M1B3-AC23: the manual-merge direction is verify_lineage(candidate, canonical)", () => {
  withCandidate(({ repo, adapter, base, candidate }) => {
    // Before any human merge, canonical does not contain the candidate.
    assert.equal(adapter.snapshot_canonical().head, base);
    assert.equal(adapter.verify_lineage(candidate, adapter.snapshot_canonical().head), false);

    // A human merges the candidate outside the Platform, exactly as MVP 1 §19.4 expects.
    repo.git(["merge", "--ff-only", candidate]);

    const canonical = adapter.snapshot_canonical();
    assert.equal(canonical.head, candidate);
    assert.equal(adapter.verify_lineage(candidate, canonical.head), true);

    // And it stays reflected once canonical moves on past the candidate.
    const later = repo.commit({ path: "later.txt", content: "later\n", message: "D" });
    assert.equal(adapter.verify_lineage(candidate, adapter.snapshot_canonical().head), true);
    assert.equal(adapter.snapshot_canonical().head, later);
  });
});

test("§26 / M1B3-AC23: the three human-merge branches are decidable from primitives alone", () => {
  withCandidate(({ repo, adapter, base, candidate }) => {
    /** Exactly the projection TD §19.4 describes — expressed here, not implemented in Core. */
    const observe = (): string => {
      const canonical = adapter.snapshot_canonical();
      if (adapter.verify_lineage(candidate, canonical.head)) return "reflected";
      if (canonical.head === base) return "unchanged";
      return "mismatch";
    };

    assert.equal(observe(), "unchanged");

    // Canonical moves somewhere else entirely: neither reflected nor untouched.
    repo.commit({ path: "other.txt", content: "other\n", message: "X" });
    assert.equal(observe(), "mismatch");

    repo.git(["merge", "--no-edit", candidate]);
    assert.equal(observe(), "reflected");
  });
});

// --- RG33 ~ RG38: mechanical merge --------------------------------------------------------------

test("RG33 / RG34 / M1B3-AC24 / AC25: a fast-forward candidate merges mechanically", () => {
  withCandidate(({ repo, adapter, base, candidate }) => {
    const preparation = adapter.prepare_merge({
      candidate_commit: candidate,
      expected_canonical_head: base,
    });
    assert.deepEqual(preparation, {
      canonical_ref: CANONICAL_REF,
      canonical_head: base,
      candidate_commit: candidate,
      fast_forwardable: true,
    });
    assert.equal(adapter.snapshot_canonical().head, base, "preparing merges nothing");

    const merged = adapter.commit_merge(preparation);
    assert.equal(merged.canonical_head, candidate, "RG34");
    assert.equal(adapter.snapshot_canonical().head, candidate);
    assert.equal(adapter.verify_canonical_head(candidate), true);

    // RG37 / RG38 — a fast-forward, so canonical *is* the candidate: no new commit was authored.
    assert.equal(repo.git(["rev-list", "--count", `${base}..${candidate}`]).trim(), "1");
    assert.equal(repo.git(["rev-parse", `${candidate}^@`]).trim(), base, "no merge commit");
    assert.equal(repo.git(["log", "--merges", "--oneline"]).trim(), "");
  });
});

test("RG35 / RG36 / M1B3-AC26: a divergent canonical rejects the merge and does not move", () => {
  withCandidate(({ repo, adapter, base, candidate }) => {
    const preparation = adapter.prepare_merge({
      candidate_commit: candidate,
      expected_canonical_head: base,
    });

    // Canonical advances independently, so the candidate is no longer a fast-forward.
    const diverged = repo.commit({ path: "diverged.txt", content: "d\n", message: "D" });

    assert.throws(() => adapter.commit_merge(preparation), GitError, "RG35: stale preparation");
    assert.equal(adapter.snapshot_canonical().head, diverged, "RG36");

    // Re-preparing against the current head reports the fact rather than a verdict.
    const repeated = adapter.prepare_merge({
      candidate_commit: candidate,
      expected_canonical_head: diverged,
    });
    assert.equal(repeated.fast_forwardable, false);

    assert.throws(() => adapter.commit_merge(repeated), GitError, "non-ff is refused");
    assert.equal(adapter.snapshot_canonical().head, diverged, "canonical is untouched");
    assert.equal(repo.git(["log", "--merges", "--oneline"]).trim(), "", "RG38: no merge commit");
    assert.equal(repo.git(["status", "--porcelain"]), "", "no half-finished merge state");
  });
});

test("M1B3-AC24: prepare_merge reads facts and refuses a stale expected head", () => {
  withCandidate(({ adapter, base, candidate }) => {
    assert.throws(
      () =>
        adapter.prepare_merge({ candidate_commit: candidate, expected_canonical_head: candidate }),
      GitError,
    );
    assert.throws(
      () =>
        adapter.prepare_merge({ candidate_commit: "0".repeat(40), expected_canonical_head: base }),
      GitError,
    );
  });
});

test("M1B3-AC25: commit_merge refuses when the root is not on the canonical ref", () => {
  withCandidate(({ repo, adapter, base, candidate }) => {
    const preparation = adapter.prepare_merge({
      candidate_commit: candidate,
      expected_canonical_head: base,
    });
    repo.git(["checkout", "--quiet", "-b", "side"]);

    assert.throws(() => adapter.commit_merge(preparation), GitError);
    assert.equal(adapter.snapshot_canonical().head, base, "canonical never moved");
  });
});

// --- identity hygiene -----------------------------------------------------------------------

test("M1B3-AC42: no repository value is ever interpreted as a shell string or an option", () => {
  withGitRepo((repo) => {
    const a = repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const adapter = new LocalGitRepositoryAdapter(repo.config());
    const marker = join(repo.root, "pwned.txt");

    for (const hostile of [
      "a.txt; touch pwned.txt",
      "$(touch pwned.txt)",
      "`touch pwned.txt`",
      "--output=pwned.txt",
      "-x",
    ]) {
      assert.throws(() => adapter.verify_lineage(hostile, a));
      assert.throws(() => adapter.create_feature_workspace(request(hostile)));
      assert.throws(() => adapter.verify_canonical_head(hostile));
    }
    // A path is allowed to be an odd filename — argv means it is only ever a path — but an
    // option-shaped or escaping one is refused outright.
    assert.equal(
      adapter.verify_expected_files({ from: a, to: a, allowed_paths: ["a.txt; touch pwned.txt"] }),
      true,
      "an empty range trivially stays in scope; the shell never saw the value",
    );
    for (const refused of ["--output=pwned.txt", "-x", "/etc", "../pwned.txt"]) {
      assert.throws(() =>
        adapter.verify_expected_files({ from: a, to: a, allowed_paths: [refused] }),
      );
    }
    assert.equal(existsSync(marker), false, "no injected command ran");
    assert.equal(readFileSync(join(repo.root, "a.txt"), "utf8"), "a\n");
  });
});

test("M1B3-AC38: commit identity is opaque and never confused with an artifact hash", () => {
  withCandidate(({ adapter, base, candidate }) => {
    for (const id of [base, candidate, adapter.snapshot_canonical().head]) {
      assert.equal(typeof id, "string");
      assert.equal(id.length > 0, true);
      assert.equal(id.startsWith("sha256:"), false, "a Git id is not a Platform artifact hash");
    }
    // Nothing in the adapter asserts a 40-character identity.
    assert.equal(adapter.verify_lineage(base, candidate), true);
  });
});
