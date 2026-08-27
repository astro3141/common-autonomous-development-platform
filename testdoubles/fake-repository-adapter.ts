/**
 * FakeRepositoryAdapter — scripted responses + call recording only (Spec §63, TD §25).
 * No git, no filesystem, no merge rule.
 *
 * It records the arguments each operation is called with, so a Core test can assert *what* was
 * asked as well as in which order — the direction of a lineage question, for instance.
 */

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
} from "../adapters/interfaces/repository-adapter.ts";
import { ScriptedResponses, type FakeCall } from "./scripted.ts";

export class FakeRepositoryAdapter implements RepositoryAdapter {
  readonly calls: FakeCall[] = [];

  readonly snapshots = new ScriptedResponses<RepositoryCanonicalSnapshot>();
  readonly workspaces = new ScriptedResponses<FeatureWorkspace>();
  readonly inspections = new ScriptedResponses<CandidateInspection>();
  readonly diffs = new ScriptedResponses<RepositoryDiff>();
  readonly trackedCleanFacts = new ScriptedResponses<boolean>();
  readonly expectedFilesFacts = new ScriptedResponses<boolean>();
  readonly lineageFacts = new ScriptedResponses<boolean>();
  readonly canonicalHeadFacts = new ScriptedResponses<boolean>();
  readonly mergePreparations = new ScriptedResponses<MergePreparation>();
  readonly mergeCommits = new ScriptedResponses<MergeCommit>();

  snapshot_canonical(): RepositoryCanonicalSnapshot {
    this.calls.push({ method: "snapshot_canonical", args: [] });
    return this.snapshots.take("snapshot_canonical");
  }

  create_feature_workspace(request: CreateFeatureWorkspaceRequestV1): FeatureWorkspace {
    this.calls.push({ method: "create_feature_workspace", args: [request] });
    return this.workspaces.take("create_feature_workspace");
  }

  inspect_candidate(workspace: FeatureWorkspace): CandidateInspection {
    this.calls.push({ method: "inspect_candidate", args: [workspace] });
    return this.inspections.take("inspect_candidate");
  }

  get_diff(range: RepositoryRange): RepositoryDiff {
    this.calls.push({ method: "get_diff", args: [range] });
    return this.diffs.take("get_diff");
  }

  verify_tracked_clean(workspace?: FeatureWorkspace): boolean {
    this.calls.push({ method: "verify_tracked_clean", args: workspace === undefined ? [] : [workspace] });
    return this.trackedCleanFacts.take("verify_tracked_clean");
  }

  verify_expected_files(request: ExpectedFilesRequest): boolean {
    this.calls.push({ method: "verify_expected_files", args: [request] });
    return this.expectedFilesFacts.take("verify_expected_files");
  }

  verify_lineage(ancestor_commit: string, descendant_commit: string): boolean {
    this.calls.push({ method: "verify_lineage", args: [ancestor_commit, descendant_commit] });
    return this.lineageFacts.take("verify_lineage");
  }

  verify_canonical_head(expected_head: string): boolean {
    this.calls.push({ method: "verify_canonical_head", args: [expected_head] });
    return this.canonicalHeadFacts.take("verify_canonical_head");
  }

  prepare_merge(request: MergeRequest): MergePreparation {
    this.calls.push({ method: "prepare_merge", args: [request] });
    return this.mergePreparations.take("prepare_merge");
  }

  commit_merge(preparation: MergePreparation): MergeCommit {
    this.calls.push({ method: "commit_merge", args: [preparation] });
    return this.mergeCommits.take("commit_merge");
  }
}
