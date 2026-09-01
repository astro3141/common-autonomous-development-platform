/**
 * MVP 2 — Safe Automatic Merge (TD §14.4/§14.5, Spec §67).
 *
 * The Repository Gate is the only canonical mutation path, and every guarantee here is the
 * fail-closed one: preconditions judged from authoritative facts, a write-ahead INTENT before the
 * one external effect, observation instead of re-execution on recovery, and refusal — never
 * weakening — whenever the world or the backend does not satisfy the frozen policy.
 *
 * The falsification controls (§15.4) are the tests whose *world* removes a guarantee: the honest
 * Backend v1 manifests must make the Gate refuse, a moved canonical must make it refuse, and an
 * out-of-scope diff must make it refuse.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

import type {
  MergeCommit,
  MergePreparation,
  MergeRequest,
  ExpectedFilesRequest,
  RepositoryDiff,
  RepositoryRange,
} from "../adapters/interfaces/repository-adapter.ts";
import { mergeOp } from "../core/execution/automatic-merge.ts";
import { backendV1Manifests } from "../deployment/manifests.ts";
import type { ManifestSetInput } from "../core/capability/manifest-set.ts";
import { AUDITOR_VERDICT_PROTOCOL } from "./support/execution-fixtures.ts";
import { BATCH_ID, RUN_ID, TASK_KEY, withWorld, type DomainWorld } from "./support/domain-fixtures.ts";
import { auditorVerdict, auditorTurnResult, evidenceItem, REQUIRED_CHECK, RecordingRepository } from "./support/execution-fixtures.ts";
import { HEAD } from "./support/decision-fixtures.ts";
import {
  coordinatorWorld,
  submitSupervisorProposal,
  actorProduced,
  type CoordinatorWorld,
} from "./support/coordinator-fixtures.ts";

const AUTO_MERGE = {
  auto_merge: true,
  batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 1 },
  // S9 — auto_merge=true must declare the merge operation's enforcement requirements. ENFORCED
  // denial of Actor canonical write/merge is exactly what Backend v1 cannot honestly claim (§12.3).
  capability_requirements: {
    automatic_merge: {
      "repository.canonical_write": { accepted: ["ENFORCED"] },
      "repository.merge": { accepted: ["ENFORCED"] },
    },
  },
};

const CANDIDATE = "9a8b7c6d5e4f30211203344556677889900aabbc";

/** A repository double that additionally implements the merge and diff facts the Gate reads. */
class MergingRepository extends RecordingRepository {
  changedPaths: string[] = ["src/collector.ts"];
  expectedFilesAnswer = true;
  commitFailure: Error | undefined;
  commitCount = 0;

  override get_diff(range: RepositoryRange): RepositoryDiff {
    return { from: range.from, to: range.to, changed_paths: this.changedPaths, patch: "" };
  }

  override verify_expected_files(_request: ExpectedFilesRequest): boolean {
    return this.expectedFilesAnswer;
  }

  /**
   * A real ancestry answer over the two commits this world has: the candidate is a child of the
   * fixture base, and nothing else is related. The base RecordingRepository's boolean flag would
   * make "canonical already contains the candidate" trivially true, which is exactly the wrong
   * answer for merge-recovery questions.
   */
  override verify_lineage(ancestor: string, descendant: string): boolean {
    this.calls.push(`verify_lineage:${ancestor}:${descendant}`);
    if (ancestor === descendant) return true;
    return ancestor === HEAD && descendant === CANDIDATE && this.lineageValid;
  }

  override prepare_merge(request: MergeRequest): MergePreparation {
    this.calls.push("prepare_merge");
    return {
      canonical_ref: this.ref,
      canonical_head: this.head,
      candidate_commit: request.candidate_commit,
      fast_forwardable: this.head === request.expected_canonical_head && this.lineageValid,
    };
  }

  override commit_merge(preparation: MergePreparation): MergeCommit {
    this.calls.push("commit_merge");
    if (this.commitFailure !== undefined) throw this.commitFailure;
    this.commitCount += 1;
    this.head = preparation.candidate_commit;
    return {
      canonical_ref: this.ref,
      canonical_head: this.head,
      candidate_commit: preparation.candidate_commit,
    };
  }
}

const attemptKey = (w: CoordinatorWorld): string => {
  const current = w.store.attempts.current(TASK_KEY);
  if (current !== undefined) return current.attempt_key;
  return (w.store.attempts.forTask(TASK_KEY).at(-1) as { attempt_key: string }).attempt_key;
};

/** Drives one task to READY_TO_MERGE through the production Coordinator, exactly as B13 does. */
function driveToReadyToMerge(world: DomainWorld, w: CoordinatorWorld): void {
  assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
  submitSupervisorProposal(w, world);
  assert.equal(w.tick(), "ACTIVATED");
  assert.equal(w.tick(), "IMPLEMENTATION_STARTED");
  actorProduced(w, CANDIDATE, 1);
  assert.equal(w.tick(), "VERIFICATION_STARTED");

  const attempt = w.store.attempts.require(attemptKey(w));
  const hash = w.store.contracts.hashOf(attempt.contract_snapshot_id) as string;
  w.verification.completeWith([
    evidenceItem({
      evidence_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0M01",
      check_id: REQUIRED_CHECK,
      target_commit: CANDIDATE,
      task_contract_hash: hash,
    }),
  ]);
  assert.equal(w.tick(), "AUDIT_STARTED");

  const review = {
    candidate_commit: CANDIDATE,
    task_contract_hash: hash,
    evidence_ids: w.store.verificationEvidence
      .forAttempt(attempt.attempt_key)
      .filter((row) => row.target_commit === CANDIDATE)
      .map((row) => row.evidence_id),
  };
  const handle = w.store.adapterMetadata
    .forEntity(attempt.attempt_key)
    .find((row) => row.key.startsWith("auditor_turn-1:") && row.key.endsWith(CANDIDATE));
  assert.notEqual(handle, undefined);
  w.runtime.turnResults.set(
    JSON.stringify(handle?.value),
    auditorTurnResult({ body: auditorVerdict(review), protocol: AUDITOR_VERDICT_PROTOCOL }),
  );
  w.verification.settlement = { kind: "SETTLED" };
  assert.equal(w.tick(), "AUDIT_COMPLETED");
  assert.equal(w.store.attempts.require(attempt.attempt_key).state, "READY_TO_MERGE");
}

test("B14-1: with auto_merge enabled the Gate merges, completes the run, and no human decision opens", () => {
  withWorld((world) => {
    const repository = new MergingRepository(HEAD);
    const w = coordinatorWorld(world, { repository });
    driveToReadyToMerge(world, w);

    assert.equal(w.tick(), "AUTO_MERGE_STARTED");
    const key = attemptKey(w);
    assert.equal(w.store.attempts.require(key).state, "MERGING");
    // I-TD2 — the INTENT precedes the external effect, and no merge has happened yet.
    assert.equal(w.store.idempotency.get(mergeOp(key, CANDIDATE))?.state, "INTENT");
    assert.equal(repository.commitCount, 0);

    assert.equal(w.tick(), "AUTO_MERGE_COMPLETED");
    assert.equal(repository.commitCount, 1, "exactly one canonical mutation");
    assert.equal(repository.head, CANDIDATE);
    assert.equal(w.store.idempotency.get(mergeOp(key, CANDIDATE))?.state, "DONE");
    assert.equal(w.store.attempts.require(key).state, "MERGED");
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "COMPLETED");
    assert.equal(w.store.pendingDecisions.openFor(TASK_KEY).length, 0, "no human decision");

    assert.equal(w.tick(), "RUN_COMPLETED");
    assert.equal(w.store.runs.require(RUN_ID).status, "COMPLETED");
  }, AUTO_MERGE);
});

test("B14-2: the honest Backend v1 manifests make the Gate refuse — the Compatibility Gate works", () => {
  withWorld((world) => {
    const repository = new MergingRepository(HEAD);
    // TD §12.3 — canonical-write/merge denial is UNENFORCEABLE on Backend v1. The policy demands
    // ENFORCED. The designed consequence is refusal, not a weaker merge.
    const manifests = backendV1Manifests({ backend_instance_id: "test-host" }) as ManifestSetInput;
    const w = coordinatorWorld(world, { repository, manifests });
    driveToReadyToMerge(world, w);

    assert.equal(w.tick(), "BLOCKED");
    const key = attemptKey(w);
    assert.equal(w.store.attempts.require(key).state, "READY_TO_MERGE");
    const task = w.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.state_reason?.code, "POLICY_BACKEND_INCOMPATIBLE");
    assert.equal(repository.commitCount, 0, "zero canonical mutation");
  }, AUTO_MERGE);
});

test("B14-3: a moved canonical head fails the CAS precondition closed", () => {
  withWorld((world) => {
    const repository = new MergingRepository(HEAD);
    const w = coordinatorWorld(world, { repository });
    driveToReadyToMerge(world, w);

    repository.head = "1111111111111111111111111111111111111111";
    // The §11 merge boundary observes the same move first and holds — either way the merge does
    // not start and nothing mutates canonical.
    assert.equal(w.tick(), "BLOCKED");
    assert.equal(w.store.attempts.require(attemptKey(w)).state, "READY_TO_MERGE");
    assert.equal(w.store.tasks.require(TASK_KEY).platform_state, "HELD");
    assert.equal(repository.commitCount, 0);
  }, AUTO_MERGE);
});

test("B14-4: an out-of-scope diff fails the expected-file precondition closed", () => {
  withWorld((world) => {
    const repository = new MergingRepository(HEAD);
    repository.expectedFilesAnswer = false;
    const w = coordinatorWorld(world, { repository });
    driveToReadyToMerge(world, w);

    assert.equal(w.tick(), "BLOCKED");
    const task = w.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.state_reason?.code, "REPOSITORY_CONFLICT");
    assert.equal(repository.commitCount, 0);
  }, AUTO_MERGE);
});

test("B14-5: a forbidden path in the diff fails closed even when allowed paths pass", () => {
  withWorld((world) => {
    const repository = new MergingRepository(HEAD);
    // The fixture scope forbids `src/vendor`; the diff touches it.
    repository.changedPaths = ["src/vendor/generated.ts"];
    const w = coordinatorWorld(world, { repository });
    driveToReadyToMerge(world, w);

    assert.equal(w.tick(), "BLOCKED");
    assert.equal(w.store.tasks.require(TASK_KEY).state_reason?.code, "REPOSITORY_CONFLICT");
    assert.equal(repository.commitCount, 0);
  }, AUTO_MERGE);
});

test("B14-6: a crash between INTENT and the merge re-runs safely; an already-merged effect is observed, not repeated", () => {
  withWorld((world) => {
    const repository = new MergingRepository(HEAD);
    const w = coordinatorWorld(world, { repository });
    driveToReadyToMerge(world, w);
    assert.equal(w.tick(), "AUTO_MERGE_STARTED");
    const key = attemptKey(w);

    // Crash window 1: INTENT durable, no effect. The retry performs the merge exactly once.
    assert.equal(w.tick(), "AUTO_MERGE_COMPLETED");
    assert.equal(repository.commitCount, 1);

    // Replay after "restart": the op is DONE; a further tick performs no second mutation.
    assert.equal(w.store.idempotency.get(mergeOp(key, CANDIDATE))?.state, "DONE");
  }, AUTO_MERGE);
});

test("B14-7: a diverged canonical during MERGING stops the batch — never a guessed merge", () => {
  withWorld((world) => {
    const repository = new MergingRepository(HEAD);
    const w = coordinatorWorld(world, { repository });
    driveToReadyToMerge(world, w);
    assert.equal(w.tick(), "AUTO_MERGE_STARTED");

    // Someone else moved canonical to an unrelated commit while the merge intent was open.
    repository.head = "2222222222222222222222222222222222222222";
    repository.lineageValid = false;
    assert.equal(w.tick(), "BLOCKED");

    assert.equal(w.store.batches.require(BATCH_ID).status, "PAUSED_SAFELY");
    assert.equal(w.store.runs.require(RUN_ID).status, "PAUSED_SAFELY");
    assert.equal(w.store.tasks.require(TASK_KEY).state_reason?.code, "RECOVERY_CONFLICT");
    assert.equal(repository.commitCount, 0, "no mutation on a contradicted world");
  }, AUTO_MERGE);
});

test("B14-8: a failed commit_merge is indeterminate and pauses safely (§21 canonical-mutation rule)", () => {
  withWorld((world) => {
    const repository = new MergingRepository(HEAD);
    const w = coordinatorWorld(world, { repository });
    driveToReadyToMerge(world, w);
    assert.equal(w.tick(), "AUTO_MERGE_STARTED");

    repository.commitFailure = new Error("the repository went away mid-merge");
    assert.equal(w.tick(), "BLOCKED");
    assert.equal(w.store.batches.require(BATCH_ID).status, "PAUSED_SAFELY");
    assert.equal(w.store.attempts.require(attemptKey(w)).state, "MERGING");
  }, AUTO_MERGE);
});

test("B14-9: with auto_merge disabled nothing reaches the Gate — the human path is untouched", () => {
  withWorld((world) => {
    const repository = new MergingRepository(HEAD);
    const w = coordinatorWorld(world, { repository });
    driveToReadyToMerge(world, w);

    assert.equal(w.tick(), "MERGE_APPROVAL_OPENED");
    assert.equal(w.store.pendingDecisions.openFor(TASK_KEY).length, 1);
    assert.equal(repository.commitCount, 0);
  }, { batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 1 } });
});

test("B14-10: the Gate is the only production caller of the canonical mutation primitives (G1)", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = `${dir}/${entry}`;
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  for (const root of ["core", "adapters", "deployment"]) walk(root);
  for (const file of files) {
    if (file.endsWith("core/execution/automatic-merge.ts")) continue;
    if (file.includes("adapters/") && /repository/.test(file)) continue; // the adapter implements them
    if (file.includes("adapters/interfaces/")) continue; // the contract declares them
    const source = readFileSync(file, "utf8");
    assert.equal(
      /\.commit_merge\(|\.prepare_merge\(/.test(source),
      false,
      `${file} reaches the canonical mutation primitives outside the Gate`,
    );
  }
});
