/**
 * RepositoryAdapter — Spec §42, TD §14.3.
 *
 * Facts and primitives only. Policy belongs to the Repository Gate (TD §14.3: "Adapter는 정책을
 * 모르고 Gate는 git 명령을 직접 만들지 않는다"), so no precondition set, no merge rule and no
 * conflict classification appears here.
 *
 * The public operation set is exactly Spec §42's ten operations — no operation is added, removed
 * or renamed. What this module does fix is the *typed request/result form* of those operations,
 * which TD §14.3 explicitly leaves to the repository convention:
 *
 *     verify_lineage(ancestor_commit, descendant_commit) -> boolean
 *           # 현재 repo convention의 동등한 typed request/result 형태여도 된다
 *
 * Until MVP 1 there was no consumer, so each fact stayed a structureless opaque brand. The first
 * consumer (LocalGitRepositoryAdapter, TD §14.3) needs to *read* the facts the Gate's checks are
 * defined over — canonical HEAD, candidate SHA, changed paths — so those results carry exactly
 * the members TD §14.3/§14.4 name and nothing more. Every commit identity is an opaque, non-empty
 * repository-owned string: the Platform never parses it, fixes its length, or confuses it with a
 * `sha256:` artifact hash (TD §6).
 */

/** Spec §42 — canonical repository snapshot; also the `repository_snapshot` input of Spec §37. */
export interface RepositoryCanonicalSnapshot {
  /** The configured canonical ref, resolved rather than assumed from the current checkout. */
  readonly ref: string;
  /** Commit identity the canonical ref points at. */
  readonly head: string;
}

/** Spec §42 — a feature workspace created from a base head (TD §14.3: Platform-owned, not Runtime). */
export interface FeatureWorkspace {
  /** Filesystem location the Actor will be pointed at. */
  readonly path: string;
  /** The base the workspace was created from, re-read from the workspace itself. */
  readonly base_head: string;
  /** Local branch the workspace checked out. Never pushed anywhere by the adapter. */
  readonly branch: string;
}

/**
 * Spec §42 — inspection result for the candidate.
 *
 * Absence is a first-class answer (TD §19.3): a workspace still sitting on its base has no
 * candidate, and the adapter reports that instead of offering the base as one.
 */
export interface CandidateInspection {
  readonly present: boolean;
  readonly candidate_commit: string | null;
  /** The base the workspace was created from, for the caller's own lineage question. */
  readonly base_head: string;
}

/** Spec §42 — diff fact. Repository output, never an interpretation of it. */
export interface RepositoryDiff {
  readonly from: string;
  readonly to: string;
  /** Repository-relative paths the range touches, in the repository's own order. */
  readonly changed_paths: readonly string[];
  /** The textual patch exactly as the repository produced it. */
  readonly patch: string;
}

/** What a diff or expected-file question is asked over. */
export interface RepositoryRange {
  readonly from: string;
  readonly to: string;
}

/** Spec §42 — the mechanical expected-file question: does this range stay inside these paths? */
export interface ExpectedFilesRequest extends RepositoryRange {
  /** Repository-relative path prefixes the range is allowed to touch. */
  readonly allowed_paths: readonly string[];
}

/** Spec §42 — prepared merge, before the Gate commits it. Facts only; no verdict is implied. */
export interface MergePreparation {
  readonly canonical_ref: string;
  readonly canonical_head: string;
  readonly candidate_commit: string;
  /** Whether the candidate is a descendant of the current canonical head. */
  readonly fast_forwardable: boolean;
}

/** What the Gate asks the adapter to prepare. */
export interface MergeRequest {
  readonly candidate_commit: string;
  /** Canonical head the caller believes it is merging onto (TD §14.4 G3: HEAD CAS). */
  readonly expected_canonical_head: string;
}

/** Spec §42 — result of the mechanical merge commit. */
export interface MergeCommit {
  readonly canonical_ref: string;
  /** Canonical head after the merge, re-read from the repository. */
  readonly canonical_head: string;
  readonly candidate_commit: string;
}

/**
 * TD §14.3 (M1-8) — the exact workspace request. Two fields, nothing else.
 *
 * Creating a worktree is an external filesystem mutation, so it carries the Platform's operation
 * identity: the same `op_key` must resolve to the same logical workspace rather than making a
 * second one. `op_key` is an external side-effect identity only — never Model input, and never
 * repository semantic authority.
 */
export interface CreateFeatureWorkspaceRequestV1 {
  readonly base_head: string;
  readonly op_key: string;
}

export interface RepositoryAdapter {
  snapshot_canonical(): RepositoryCanonicalSnapshot;

  /**
   * Idempotent create-or-reacquire (TD §14.3):
   *
   *   same op_key + same base_head       → the same logical workspace, no second worktree
   *   same op_key + different base_head  → deterministic conflict, fail-closed
   *   different op_key                   → a distinct logical workspace, never a silent alias
   */
  create_feature_workspace(request: CreateFeatureWorkspaceRequestV1): FeatureWorkspace;

  inspect_candidate(workspace: FeatureWorkspace): CandidateInspection;

  get_diff(range: RepositoryRange): RepositoryDiff;

  /** Tracked-file cleanliness of a workspace, or of the canonical checkout when omitted. */
  verify_tracked_clean(workspace?: FeatureWorkspace): boolean;

  verify_expected_files(request: ExpectedFilesRequest): boolean;

  /** TD §14.3 M1-4 — true when `ancestor_commit` is an ancestor of, or equal to, `descendant_commit`. */
  verify_lineage(ancestor_commit: string, descendant_commit: string): boolean;

  verify_canonical_head(expected_head: string): boolean;

  prepare_merge(request: MergeRequest): MergePreparation;

  commit_merge(preparation: MergePreparation): MergeCommit;
}
