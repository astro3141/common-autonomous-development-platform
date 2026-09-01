/**
 * LocalGitRepositoryAdapter — the first production RepositoryAdapter (TD §14.3).
 *
 * Standard Git primitives, used directly: `rev-parse`, `status`, `diff`, `merge-base
 * --is-ancestor`, local `clone`, and `merge --ff-only`. There is no object-database reader, no
 * workspace manager and no Git abstraction layer — this is one adapter plus a private argv helper.
 *
 * It knows no policy. Nothing here consults `auto_merge`, verification results, audit verdicts,
 * capability grants or the Platform Store: every operation reads repository facts and returns
 * them. What those facts *mean* is the Repository Gate's question (TD §14.3), and the Gate does
 * not exist yet — so `prepare_merge`/`commit_merge` are mechanical primitives with no caller in
 * production code.
 *
 * The adapter is also Runtime-independent by construction (TD §14.3, v1.1): workspaces are local
 * isolated clones, never a Runtime's workspace service. Keeping each `.git` directory inside its
 * assigned workspace lets a workspace-write Runtime create commits without gaining write access
 * to canonical Git metadata.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

import type {
  CandidateInspection,
  CreateFeatureWorkspaceRequestV1,
  ExpectedFilesRequest,
  FeatureWorkspace,
  MergeCommit,
  MergePreparation,
  MergeRequest,
  RepositoryAdapter,
  RepositoryCanonicalSnapshot,
  RepositoryDiff,
  RepositoryRange,
} from "../interfaces/repository-adapter.ts";
import { git, gitLine, GitError, runGit } from "./git.ts";

/**
 * Adapter-owned config, exactly like the TaskSource adapters: the Project Profile carries
 * `repository: { adapter, config }` and keeps `config` opaque (TD §7.1a), so the schema lives
 * here. Nothing is defaulted or guessed — in particular the canonical ref is never assumed from
 * the current checkout, and `process.cwd()` is never a repository authority.
 */
export interface LocalGitRepositoryConfig {
  /** Absolute path to the canonical repository working tree. */
  readonly root: string;
  /** The canonical ref, e.g. `refs/heads/main`. Configured, never inferred. */
  readonly canonical_ref: string;
  /** Directory feature workspaces are created under. Must be outside the repository root. */
  readonly workspace_root: string;
}

export const LOCAL_GIT_CONFIG_FIELDS: readonly string[] = [
  "root",
  "canonical_ref",
  "workspace_root",
];

export class RepositoryConfigError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`repository config ${field}: ${detail}`);
    this.name = "RepositoryConfigError";
    this.field = field;
  }
}

/** Validates the adapter's own config shape. Core never interprets these values. */
export function validateLocalGitRepositoryConfig(input: unknown): LocalGitRepositoryConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RepositoryConfigError("/", "expected an object");
  }
  const config = input as Record<string, unknown>;
  for (const field of LOCAL_GIT_CONFIG_FIELDS) {
    if (!Object.hasOwn(config, field)) {
      throw new RepositoryConfigError(field, "is required");
    }
  }
  for (const key of Object.keys(config)) {
    if (!LOCAL_GIT_CONFIG_FIELDS.includes(key)) {
      throw new RepositoryConfigError(key, "is not a known field");
    }
  }

  const read = (field: string): string => {
    const value = config[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new RepositoryConfigError(field, "expected a non-empty string");
    }
    return value;
  };

  const root = read("root");
  const workspace_root = read("workspace_root");
  if (!isAbsolute(root)) throw new RepositoryConfigError("root", "must be an absolute path");
  if (!isAbsolute(workspace_root)) {
    throw new RepositoryConfigError("workspace_root", "must be an absolute path");
  }
  if (contains(resolve(root), resolve(workspace_root))) {
    throw new RepositoryConfigError("workspace_root", "must not be inside the repository root");
  }

  return { root: resolve(root), canonical_ref: read("canonical_ref"), workspace_root };
}

export class LocalGitRepositoryAdapter implements RepositoryAdapter {
  readonly #root: string;
  readonly #canonicalRef: string;
  readonly #workspaceRoot: string;
  readonly #workspacePaths = new Set<string>();
  readonly #candidateWorkspaces = new Map<string, string>();

  /**
   * Fails closed unless the configured root is an existing directory, is a Git repository, and
   * the configured canonical ref resolves. A misconfigured adapter never half-works.
   */
  constructor(config: unknown) {
    const validated = validateLocalGitRepositoryConfig(config);
    this.#root = validated.root;
    this.#canonicalRef = validated.canonical_ref;
    this.#workspaceRoot = validated.workspace_root;

    if (!existsSync(this.#root) || !statSync(this.#root).isDirectory()) {
      throw new RepositoryConfigError("root", `${this.#root} is not an existing directory`);
    }
    const repository = runGit(this.#root, ["rev-parse", "--git-dir"]);
    if (!repository.ok) {
      throw new RepositoryConfigError("root", `${this.#root} is not a Git repository`);
    }
    if (!runGit(this.#root, ["rev-parse", "--verify", "--quiet", this.#canonicalRef]).ok) {
      throw new RepositoryConfigError(
        "canonical_ref",
        `${this.#canonicalRef} does not resolve in ${this.#root}`,
      );
    }
  }

  /** Read-only: resolves the configured ref, independent of what the root has checked out. */
  snapshot_canonical(): RepositoryCanonicalSnapshot {
    return {
      ref: this.#canonicalRef,
      head: gitLine(this.#root, "resolve canonical ref", [
        "rev-parse",
        "--verify",
        this.#canonicalRef,
      ]),
    };
  }

  /** Exact identity comparison. An abbreviated id is simply not the canonical head. */
  verify_canonical_head(expected_head: string): boolean {
    assertCommitish(expected_head, "expected_head");
    return this.snapshot_canonical().head === expected_head;
  }

  /**
   * Idempotent create-or-reacquire (TD §14.3, M1-8).
   *
   * The workspace's identity comes from the caller's `op_key`, not from whatever directory happens
   * to be free: the same operation always names the same path and branch, so a retry after a crash
   * re-acquires the clone it already made instead of building a second one. A workspace that
   * exists but sits on a different base is a mismatch, and mismatches fail closed rather than
   * being "fixed" by allocating another workspace.
   */
  create_feature_workspace(request: CreateFeatureWorkspaceRequestV1): FeatureWorkspace {
    assertCommitish(request.base_head, "base_head");
    assertOpKey(request.op_key);
    const base = this.#resolveCommit(request.base_head, "base_head");

    // Deterministic from the op_key alone — never from a directory scan (M1-8).
    const name = workspaceNameFor(request.op_key);
    const path = join(this.#workspaceRoot, name);

    if (existsSync(path)) {
      return this.#reacquireWorkspace({ path, name, base });
    }

    // `--no-hardlinks` makes the workspace's object store independent as well as keeping its
    // index, refs and locks inside `path`. The source is a local configured path, never a remote.
    git(this.#workspaceRoot, "create isolated feature workspace", [
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      "--",
      this.#root,
      path,
    ]);
    git(path, "detach canonical source", ["remote", "remove", "origin"]);
    git(path, "create feature branch", ["checkout", "--quiet", "-b", name, base]);
    this.#copyCommitIdentity(path);

    const head = gitLine(path, "read workspace head", ["rev-parse", "--verify", "HEAD"]);
    if (head !== base) {
      // The workspace is not what was asked for, so no handle is returned for it.
      throw new GitError(
        "create feature workspace",
        ["checkout", "--quiet", "-b", name, base],
        `workspace HEAD ${head} is not the requested base ${base}`,
      );
    }
    this.#assertIsolatedWorkspace(path, name);
    mkdirSync(this.#workspaceMetadataRoot(), { recursive: true });
    writeFileSync(this.#baseHeadMarker(name), `${base}\n`, "utf8");
    const workspace = { path, base_head: base, branch: name };
    this.#workspacePaths.add(path);
    return workspace;
  }

  /**
   * The creation base is recorded beside, not inside, assigned workspaces. The Runtime receives
   * only the workspace child path, so the Actor cannot rewrite this adapter-owned identity while
   * still retaining the `.git` writes required to commit. A branch tip cannot answer "what was
   * this cut from?" once work has been committed on top of it.
   */
  #workspaceMetadataRoot(): string {
    return join(this.#workspaceRoot, ".adp-workspace-metadata");
  }

  #baseHeadMarker(workspaceName: string): string {
    return join(this.#workspaceMetadataRoot(), `${workspaceName}.base-head`);
  }

  /**
   * The same op_key found an existing clone. It is only the same logical workspace if it was
   * created from the same base; anything else is a conflict the caller must see.
   */
  #reacquireWorkspace(params: { path: string; name: string; base: string }): FeatureWorkspace {
    this.#assertIsolatedWorkspace(params.path, params.name);
    const branch = runGit(params.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch.ok || branch.stdout.trim() !== params.name) {
      throw new GitError(
        "reacquire feature workspace",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        `${params.path} is not the workspace of branch ${params.name}`,
      );
    }
    // The branch tip may have moved on (the Actor commits); the recorded *base* is what identifies
    // the workspace, so the comparison is exact rather than an ancestry guess.
    const marker = this.#baseHeadMarker(params.name);
    const recorded = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
    if (recorded !== params.base) {
      throw new GitError(
        "reacquire feature workspace",
        ["rev-parse", "--absolute-git-dir"],
        `existing workspace ${params.name} was created from ${recorded || "an unrecorded base"}, not ${params.base}`,
      );
    }
    this.#workspacePaths.add(params.path);
    return { path: params.path, base_head: params.base, branch: params.name };
  }

  /** The candidate is whatever the workspace actually points at — never what a caller claims. */
  inspect_candidate(workspace: FeatureWorkspace): CandidateInspection {
    this.#registerWorkspace(workspace);
    const head = gitLine(workspace.path, "inspect candidate", ["rev-parse", "--verify", "HEAD"]);
    const present = head !== workspace.base_head;
    if (present) this.#candidateWorkspaces.set(head, workspace.path);
    return {
      present,
      candidate_commit: present ? head : null,
      base_head: workspace.base_head,
    };
  }

  /** Repository output verbatim: no diff model, no parsing beyond splitting the path list. */
  get_diff(range: RepositoryRange): RepositoryDiff {
    const from = this.#resolveCommit(range.from, "from");
    const to = this.#resolveCommit(range.to, "to");
    const options = this.#readOptions(from, to);
    return {
      from,
      to,
      changed_paths: this.#changedPaths(from, to, options),
      patch: git(this.#root, "read diff", ["diff", from, to, "--"], options),
    };
  }

  /**
   * TD's wording is `tracked clean`, so untracked files are deliberately not dirt: a modified or
   * staged tracked file is, an unadded new file is not.
   */
  verify_tracked_clean(workspace?: FeatureWorkspace): boolean {
    const cwd = workspace === undefined ? this.#root : workspace.path;
    return gitLine(cwd, "read tracked state", ["status", "--porcelain", "--untracked-files=no"]) === "";
  }

  /** Mechanical scope comparison: are the range's changed paths inside the allowed prefixes? */
  verify_expected_files(request: ExpectedFilesRequest): boolean {
    const allowed = request.allowed_paths.map((path, index) =>
      normalizeRepoPath(path, `allowed_paths/${index}`),
    );
    const from = this.#resolveCommit(request.from, "from");
    const to = this.#resolveCommit(request.to, "to");

    return this.#changedPaths(from, to, this.#readOptions(from, to)).every((changed) =>
      allowed.some((prefix) => changed === prefix || changed.startsWith(`${prefix}/`)),
    );
  }

  /**
   * TD §14.3 M1-4 — true when `ancestor_commit` is an ancestor of, or identical to,
   * `descendant_commit`. Both commits are resolved first, so an unknown commit is an operational
   * failure rather than a quiet `false`.
   */
  verify_lineage(ancestor_commit: string, descendant_commit: string): boolean {
    const ancestor = this.#resolveCommit(ancestor_commit, "ancestor_commit");
    const descendant = this.#resolveCommit(descendant_commit, "descendant_commit");

    const run = runGit(
      this.#root,
      ["merge-base", "--is-ancestor", ancestor, descendant],
      this.#readOptions(ancestor, descendant),
    );
    if (run.ok) return true;
    // git exits 1 for "not an ancestor" and something else for a real failure.
    if (run.stderr.trim() === "") return false;
    throw new GitError("verify lineage", ["merge-base", "--is-ancestor"], run.stderr.trim());
  }

  /**
   * Reads the facts a merge would be performed against. No verdict: whether the merge *may*
   * happen is the Gate's question, and this returns only what the repository says.
   */
  prepare_merge(request: MergeRequest): MergePreparation {
    const candidate = this.#resolveCommit(request.candidate_commit, "candidate_commit");
    assertCommitish(request.expected_canonical_head, "expected_canonical_head");
    const canonical = this.snapshot_canonical();

    if (canonical.head !== request.expected_canonical_head) {
      throw new GitError(
        "prepare merge",
        ["rev-parse", this.#canonicalRef],
        `canonical head ${canonical.head} is not the expected ${request.expected_canonical_head}`,
      );
    }

    return {
      canonical_ref: canonical.ref,
      canonical_head: canonical.head,
      candidate_commit: candidate,
      fast_forwardable: this.verify_lineage(canonical.head, candidate),
    };
  }

  /**
   * The one canonical mutation this adapter performs, and only the one its caller prepared. An
   * isolated candidate is first copied from its local workspace object store without creating a
   * ref, then `git merge --ff-only` advances canonical. No rebase, merge commit, force or network.
   */
  commit_merge(preparation: MergePreparation): MergeCommit {
    const canonical = this.snapshot_canonical();
    if (canonical.head !== preparation.canonical_head) {
      throw new GitError(
        "commit merge",
        ["rev-parse", this.#canonicalRef],
        `canonical head moved to ${canonical.head} since the merge was prepared`,
      );
    }

    // The merge runs against the canonical checkout, so the root must be on the canonical ref.
    // Checking that out here would be a repository mutation, so a mismatch fails closed instead.
    const checkedOut = gitLine(this.#root, "read canonical checkout", ["symbolic-ref", "-q", "HEAD"]);
    if (checkedOut !== preparation.canonical_ref) {
      throw new GitError(
        "commit merge",
        ["symbolic-ref", "HEAD"],
        `the repository root has ${checkedOut} checked out, not ${preparation.canonical_ref}`,
      );
    }

    const candidate = this.#resolveCommit(preparation.candidate_commit, "candidate_commit");
    if (!this.verify_lineage(canonical.head, candidate)) {
      throw new GitError(
        "commit merge",
        ["merge", "--ff-only", candidate],
        `candidate ${candidate} is not a descendant of canonical ${canonical.head}`,
      );
    }

    // Read operations use a process-local alternate-object view and leave canonical untouched.
    // Object transfer is delayed until this explicitly authorized mutation primitive.
    if (!this.#canonicalHasCommit(candidate)) {
      const workspacePath = this.#candidateWorkspaces.get(candidate);
      if (workspacePath === undefined) {
        throw new GitError(
          "commit merge",
          ["fetch", "--no-tags", "--no-write-fetch-head"],
          `BACKEND_CAPABILITY_GAP: no isolated workspace owns candidate ${candidate}`,
        );
      }
      git(this.#root, "import approved local candidate", [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        workspacePath,
        candidate,
      ]);
      if (!this.#canonicalHasCommit(candidate)) {
        throw new GitError(
          "commit merge",
          ["fetch", "--no-tags", "--no-write-fetch-head"],
          `candidate ${candidate} was not imported into canonical`,
        );
      }
    }

    git(this.#root, "commit merge", ["merge", "--ff-only", candidate]);

    return {
      canonical_ref: preparation.canonical_ref,
      canonical_head: this.snapshot_canonical().head,
      candidate_commit: candidate,
    };
  }

  // --- private helpers ---------------------------------------------------------------

  /** Resolves a canonical commit or one observed in an adapter-owned isolated workspace. */
  #resolveCommit(commitish: string, field: string): string {
    assertCommitish(commitish, field);
    const run = runGit(this.#root, ["rev-parse", "--verify", "--quiet", `${commitish}^{commit}`]);
    if (run.ok && run.stdout.trim() !== "") return run.stdout.trim();

    for (const workspacePath of this.#workspacePaths) {
      const workspaceRun = runGit(workspacePath, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${commitish}^{commit}`,
      ]);
      if (!workspaceRun.ok || workspaceRun.stdout.trim() === "") continue;
      const resolved = workspaceRun.stdout.trim();
      this.#candidateWorkspaces.set(resolved, workspacePath);
      return resolved;
    }

    throw new GitError(
      "resolve commit",
      ["rev-parse", "--verify", field],
      `${field} does not name a commit`,
    );
  }

  #changedPaths(
    from: string,
    to: string,
    options: { readonly alternate_object_directories?: readonly string[] } = {},
  ): readonly string[] {
    return git(
      this.#root,
      "read changed paths",
      ["diff", "--name-only", from, to, "--"],
      options,
    )
      .split("\n")
      .filter((line) => line !== "");
  }

  /** Gives one read-only git process access to candidate objects without changing canonical. */
  #readOptions(...commits: readonly string[]): {
    readonly alternate_object_directories?: readonly string[];
  } {
    const directories = new Set<string>();
    for (const commit of commits) {
      if (this.#canonicalHasCommit(commit)) continue;
      const workspacePath = this.#candidateWorkspaces.get(commit);
      if (workspacePath === undefined) {
        throw new GitError(
          "locate candidate object store",
          ["rev-parse", "--git-path", "objects"],
          `BACKEND_CAPABILITY_GAP: no isolated workspace owns candidate ${commit}`,
        );
      }
      const objectPath = resolve(
        workspacePath,
        gitLine(workspacePath, "locate candidate object store", [
          "rev-parse",
          "--git-path",
          "objects",
        ]),
      );
      if (!contains(realpathSync(workspacePath), realpathSync(objectPath))) {
        throw new GitError(
          "locate candidate object store",
          ["rev-parse", "--git-path", "objects"],
          `candidate object store ${objectPath} escapes workspace ${workspacePath}`,
        );
      }
      directories.add(objectPath);
    }
    return directories.size === 0
      ? {}
      : { alternate_object_directories: [...directories] };
  }

  #canonicalHasCommit(commit: string): boolean {
    return runGit(this.#root, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]).ok;
  }

  /** Copies only commit identity settings; no hooks, remotes or arbitrary config cross the boundary. */
  #copyCommitIdentity(workspacePath: string): void {
    for (const key of ["user.name", "user.email", "commit.gpgsign"] as const) {
      const configured = runGit(this.#root, ["config", "--local", "--get", key]);
      if (!configured.ok) continue;
      const value = configured.stdout.replace(/\n$/, "");
      if (value === "") continue;
      git(workspacePath, "copy commit identity", ["config", "--local", key, value]);
    }
  }

  /** A linked worktree or escaped/symlinked handle is not a workspace-write-safe workspace. */
  #assertIsolatedWorkspace(workspacePath: string, branch: string): void {
    const expectedPath = resolve(this.#workspaceRoot, branch);
    if (
      !/^ws-[A-Za-z0-9._-]+$/.test(branch) ||
      resolve(workspacePath) !== expectedPath ||
      !contains(resolve(this.#workspaceRoot), expectedPath)
    ) {
      throw new GitError(
        "validate feature workspace",
        ["rev-parse", "--absolute-git-dir"],
        `workspace ${workspacePath} is outside its assigned path ${expectedPath}`,
      );
    }
    if (!existsSync(workspacePath) || !lstatSync(workspacePath).isDirectory()) {
      throw new GitError(
        "validate feature workspace",
        ["rev-parse", "--absolute-git-dir"],
        `workspace ${workspacePath} is not a directory`,
      );
    }

    const realWorkspaceRoot = realpathSync(this.#workspaceRoot);
    const realWorkspace = realpathSync(workspacePath);
    if (!contains(realWorkspaceRoot, realWorkspace)) {
      throw new GitError(
        "validate feature workspace",
        ["rev-parse", "--absolute-git-dir"],
        `workspace ${workspacePath} escapes workspace_root`,
      );
    }

    const dotGit = join(workspacePath, ".git");
    const gitDir = runGit(workspacePath, ["rev-parse", "--absolute-git-dir"]);
    if (
      !existsSync(dotGit) ||
      !lstatSync(dotGit).isDirectory() ||
      !gitDir.ok ||
      realpathSync(dotGit) !== realpathSync(gitDir.stdout.trim())
    ) {
      throw new GitError(
        "validate feature workspace",
        ["rev-parse", "--absolute-git-dir"],
        `BACKEND_CAPABILITY_GAP: ${workspacePath} does not contain its own Git metadata`,
      );
    }

    if (gitLine(workspacePath, "verify detached source", ["remote"]) !== "") {
      throw new GitError(
        "validate feature workspace",
        ["remote"],
        `workspace ${workspacePath} retains a repository remote`,
      );
    }
  }

  #registerWorkspace(workspace: FeatureWorkspace): void {
    assertCommitish(workspace.base_head, "base_head");
    this.#assertIsolatedWorkspace(workspace.path, workspace.branch);
    const marker = this.#baseHeadMarker(workspace.branch);
    const recorded = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
    if (recorded !== workspace.base_head) {
      throw new GitError(
        "validate feature workspace",
        ["rev-parse", "--absolute-git-dir"],
        `workspace base ${recorded || "is unrecorded"}, not ${workspace.base_head}`,
      );
    }
    this.#workspacePaths.add(workspace.path);
  }

}

// --- local predicates ------------------------------------------------------------------

const contains = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

/**
 * Commit-ish and ref values go into argv positions, so a value that starts with `-` would be read
 * as an option. Rejecting it is simpler and stricter than hoping a `--` guard is in the right
 * place, and no legitimate commit identity starts with a dash.
 */
/**
 * A filesystem/git-safe name for one operation (M1-8). `op_key` is structured text
 * (`op:<attempt>:workspace`, where the attempt key itself may contain ':'), so the separators are
 * folded to `-` and anything outside a conservative set is escaped by code point. The mapping is
 * total and injective, which is what keeps two different operations from aliasing onto one
 * worktree. This is a local naming detail, not a Core identifier contract — nothing reads it back.
 */
function workspaceNameFor(opKey: string): string {
  const encoded = [...opKey]
    .map((character) =>
      /[A-Za-z0-9._-]/.test(character)
        ? character
        : `_${character.codePointAt(0)?.toString(16) ?? ""}_`,
    )
    .join("");
  return `ws-${encoded}`;
}

function assertOpKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RepositoryConfigError("op_key", "expected a non-empty operation identity");
  }
}

function assertCommitish(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RepositoryConfigError(field, "expected a non-empty commit identity");
  }
  if (value.startsWith("-")) {
    throw new RepositoryConfigError(field, "must not start with '-'");
  }
  if (/[\s\0]/.test(value)) {
    throw new RepositoryConfigError(field, "must not contain whitespace");
  }
}

/** Repository-relative paths only: no absolute path and no escape above the repository root. */
function normalizeRepoPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RepositoryConfigError(field, "expected a non-empty repository-relative path");
  }
  if (isAbsolute(value) || value.startsWith("-")) {
    throw new RepositoryConfigError(field, "must be a repository-relative path");
  }

  const normalized = normalize(value).replaceAll("\\", "/").replace(/\/+$/, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new RepositoryConfigError(field, "must not escape the repository root");
  }
  if (normalized === "" || normalized === ".") {
    throw new RepositoryConfigError(field, "must name a path inside the repository");
  }
  return normalized;
}
