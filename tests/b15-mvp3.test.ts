/**
 * MVP 3 — Subflow / Hold-next / Batch (Spec §47/§48/§68; TD §19.1, §20.1, §27).
 *
 * What MVP 3 adds and this file proves:
 *
 *   - a batch runs more than one task, and the Coordinator paces Supervisor turns by durable
 *     facts (answered proposals + a free concurrency slot), never by an in-memory cursor;
 *   - §20.1 WAITING is entered and left through the guard, from real counts;
 *   - START_SUBFLOW is validated-but-not-applied: the Proposal names no parent and no contract
 *     rule derives one (CONTRACT_AMBIGUITY, durable observation); the sealed explicit-parent
 *     linkage — suspension on admission, resume on child completion (Spec §47) — is proven
 *     directly at the state machine;
 *   - DEFER_TASK and RESUME_PARENT are applied lifecycle decisions now.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  MergeCommit,
  MergePreparation,
  MergeRequest,
  ExpectedFilesRequest,
  RepositoryDiff,
  RepositoryRange,
} from "../adapters/interfaces/repository-adapter.ts";
import { submitProposal } from "../core/admission/submit-proposal.ts";
import { AUDITOR_VERDICT_PROTOCOL } from "./support/execution-fixtures.ts";
import { commitAdmission } from "../core/statemachine/transition-commit.ts";
import {
  BATCH_ID,
  BINDING,
  PROJECT,
  RUN_ID,
  SCOPE_ID,
  SELECTION,
  discover,
  withWorld,
  type DomainWorld,
} from "./support/domain-fixtures.ts";
import {
  auditorVerdict,
  auditorTurnResult,
  evidenceItem,
  REQUIRED_CHECK,
  RecordingRepository,
} from "./support/execution-fixtures.ts";
import { HEAD, selection, task, taskControl } from "./support/decision-fixtures.ts";
import { coordinatorWorld, type CoordinatorWorld } from "./support/coordinator-fixtures.ts";

const A_REF = "T-101";
const B_REF = "T-202";
const A_KEY = `task:${PROJECT}:${A_REF}`;
const B_KEY = `task:${PROJECT}:${B_REF}`;

const CA = "9a8b7c6d5e4f30211203344556677889900aabbc";
const CB = "1122334455667788990011223344556677889900";

/** A repository whose ancestry is the real chain HEAD → CA → CB, with working merge primitives. */
class ChainRepository extends RecordingRepository {
  readonly parents = new Map<string, string>([
    [CA, HEAD],
    [CB, CA],
  ]);
  commitCount = 0;

  override verify_lineage(ancestor: string, descendant: string): boolean {
    this.calls.push(`verify_lineage:${ancestor}:${descendant}`);
    let current: string | undefined = descendant;
    while (current !== undefined) {
      if (current === ancestor) return true;
      current = this.parents.get(current);
    }
    return false;
  }

  override get_diff(range: RepositoryRange): RepositoryDiff {
    return { from: range.from, to: range.to, changed_paths: ["src/one.ts"], patch: "" };
  }

  override verify_expected_files(_request: ExpectedFilesRequest): boolean {
    return true;
  }

  override prepare_merge(request: MergeRequest): MergePreparation {
    return {
      canonical_ref: this.ref,
      canonical_head: this.head,
      candidate_commit: request.candidate_commit,
      fast_forwardable:
        this.head === request.expected_canonical_head &&
        this.verify_lineage(this.head, request.candidate_commit),
    };
  }

  override commit_merge(preparation: MergePreparation): MergeCommit {
    this.commitCount += 1;
    this.head = preparation.candidate_commit;
    return {
      canonical_ref: this.ref,
      canonical_head: this.head,
      candidate_commit: preparation.candidate_commit,
    };
  }
}

/** Auto-merge policy for two tasks, one at a time (concurrency 1). */
const TWO_TASK_AUTO = {
  auto_merge: true,
  batch_policy: { max_tasks: 2, max_rework: 2, concurrency: 1 },
  capability_requirements: {
    automatic_merge: {
      "repository.canonical_write": { accepted: ["ENFORCED"] },
      "repository.merge": { accepted: ["ENFORCED"] },
    },
  },
};

function submit(
  w: CoordinatorWorld,
  world: DomainWorld,
  options: {
    readonly ref: string;
    readonly decision?: string;
    readonly base_head?: string;
    readonly classification?: string;
  },
): ReturnType<typeof submitProposal> {
  const definition = task({ task_ref: options.ref });
  w.tasks.definition = definition;
  return submitProposal(
    { store: w.store, taskSource: w.tasks, repository: w.repository as never, manifests: w.manifests },
    {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      observed_at: "2026-08-21T09:00:00Z",
      proposal:
        options.decision === undefined || options.decision === "START_TASK" || options.decision === "START_SUBFLOW"
          ? selection({
              profile: world.profile,
              definition,
              base_head: options.base_head ?? HEAD,
              ...(options.decision === undefined ? {} : { decision: options.decision }),
              ...(options.classification === undefined ? {} : { classification: options.classification }),
            })
          : taskControl({ profile: world.profile, definition, decision: options.decision }),
    },
  );
}

/** Drives the current writable task from IMPLEMENTING through verification and audit to MERGED. */
function completeActiveTask(
  w: CoordinatorWorld,
  taskKey: string,
  candidate: string,
  repository: ChainRepository,
): void {
  const attempt = () => w.store.attempts.current(taskKey)!;
  repository.candidate = candidate;
  const key = attempt().attempt_key;
  const stored = w.store.adapterMetadata
    .forEntity(key)
    .find((row) => row.key.startsWith("actor_turn:"));
  assert.notEqual(stored, undefined);
  w.runtime.turnResults.set(JSON.stringify(stored?.value), {
    session_handle: {} as never,
    turn_handle: stored?.value as never,
    backend_status: "COMPLETED",
    termination_reason: "end_turn",
    started_at: "t1",
    completed_at: "t2",
    provenance: { runtime_backend: "fake", identity_authority: "BACKEND", result_channel: "TURN_TEXT" },
  });
  assert.equal(w.tick(), "VERIFICATION_STARTED");

  const hash = w.store.contracts.hashOf(attempt().contract_snapshot_id) as string;
  w.verification.completeWith([
    evidenceItem({
      evidence_id: `01JQ8ZK5T7RC9V2W4X6Y8Z0${candidate === CA ? "N01" : "N02"}`.slice(0, 26),
      check_id: REQUIRED_CHECK,
      target_commit: candidate,
      task_contract_hash: hash,
    }),
  ]);
  assert.equal(w.tick(), "AUDIT_STARTED");

  const review = {
    candidate_commit: candidate,
    task_contract_hash: hash,
    evidence_ids: w.store.verificationEvidence
      .forAttempt(key)
      .filter((row) => row.target_commit === candidate)
      .map((row) => row.evidence_id),
  };
  const handle = w.store.adapterMetadata
    .forEntity(key)
    .find((row) => row.key.startsWith("auditor_turn-1:") && row.key.endsWith(candidate));
  assert.notEqual(handle, undefined);
  w.runtime.turnResults.set(
    JSON.stringify(handle?.value),
    auditorTurnResult({ body: auditorVerdict(review), protocol: AUDITOR_VERDICT_PROTOCOL }),
  );
  w.verification.settlement = { kind: "SETTLED" };
  assert.equal(w.tick(), "AUDIT_COMPLETED");
  assert.equal(w.tick(), "AUTO_MERGE_STARTED");
  assert.equal(w.tick(), "AUTO_MERGE_COMPLETED");
  assert.equal(w.store.tasks.require(taskKey).platform_state, "COMPLETED");
}

test("B15-1: a two-task batch completes task by task, with durable Supervisor pacing", () => {
  withWorld((world) => {
    const repository = new ChainRepository(HEAD);
    const w = coordinatorWorld(world, { repository });
    discover(world, B_REF);

    // Turn 1 → proposal A → activation → implementation.
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    assert.equal(w.tick(), "SUPERVISOR_AWAITING_PROPOSAL", "no second turn before an answer");
    assert.deepEqual(submit(w, world, { ref: A_REF }).result, { kind: "ACCEPTED" });
    assert.equal(w.tick(), "ACTIVATED");
    assert.equal(w.tick(), "IMPLEMENTATION_STARTED");

    completeActiveTask(w, A_KEY, CA, repository);
    assert.equal(repository.head, CA);

    // A is terminal → the slot is free → the Coordinator asks again, for B.
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    assert.deepEqual(
      submit(w, world, { ref: B_REF, base_head: CA }).result,
      { kind: "ACCEPTED" },
      "B admits on the moved canonical",
    );
    assert.equal(w.tick(), "ACTIVATED");
    assert.equal(w.tick(), "IMPLEMENTATION_STARTED");
    completeActiveTask(w, B_KEY, CB, repository);

    assert.equal(w.tick(), "RUN_COMPLETED");
    assert.equal(w.store.batches.require(BATCH_ID).status, "COMPLETED");
    assert.equal(repository.commitCount, 2, "two guarded merges, no more");
  }, TWO_TASK_AUTO);
});

test("B15-2: §20.1 WAITING is entered on a blocking decision and left when it resolves", () => {
  withWorld((world) => {
    const repository = new ChainRepository(HEAD);
    const w = coordinatorWorld(world, { repository });

    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    assert.deepEqual(submit(w, world, { ref: A_REF }).result, { kind: "ACCEPTED" });
    assert.equal(w.tick(), "ACTIVATED");
    assert.equal(w.tick(), "IMPLEMENTATION_STARTED");

    // The human-merge path: A reaches READY_TO_MERGE and blocks on the approval.
    repository.candidate = CA;
    const attempt = w.store.attempts.current(A_KEY)!;
    const stored = w.store.adapterMetadata
      .forEntity(attempt.attempt_key)
      .find((row) => row.key.startsWith("actor_turn:"));
    w.runtime.turnResults.set(JSON.stringify(stored?.value), {
      session_handle: {} as never,
      turn_handle: stored?.value as never,
      backend_status: "COMPLETED",
      termination_reason: "end_turn",
      started_at: "t1",
      completed_at: "t2",
      provenance: { runtime_backend: "fake", identity_authority: "BACKEND", result_channel: "TURN_TEXT" },
    });
    assert.equal(w.tick(), "VERIFICATION_STARTED");
    const hash = w.store.contracts.hashOf(attempt.contract_snapshot_id) as string;
    w.verification.completeWith([
      evidenceItem({ check_id: REQUIRED_CHECK, target_commit: CA, task_contract_hash: hash }),
    ]);
    assert.equal(w.tick(), "AUDIT_STARTED");
    const review = {
      candidate_commit: CA,
      task_contract_hash: hash,
      evidence_ids: w.store.verificationEvidence
        .forAttempt(attempt.attempt_key)
        .filter((row) => row.target_commit === CA)
        .map((row) => row.evidence_id),
    };
    const handle = w.store.adapterMetadata
      .forEntity(attempt.attempt_key)
      .find((row) => row.key.startsWith("auditor_turn-1:") && row.key.endsWith(CA));
    w.runtime.turnResults.set(
      JSON.stringify(handle?.value),
      auditorTurnResult({ body: auditorVerdict(review), protocol: AUDITOR_VERDICT_PROTOCOL }),
    );
    w.verification.settlement = { kind: "SETTLED" };
    assert.equal(w.tick(), "AUDIT_COMPLETED");
    assert.equal(w.tick(), "MERGE_APPROVAL_OPENED");

    // Everything is blocked on a person and nothing else is runnable → WAITING (§20.1).
    assert.equal(w.tick(), "BATCH_WAITING");
    assert.equal(w.store.batches.require(BATCH_ID).status, "WAITING");

    // The person answers; the batch resumes through the guard and the merge applies.
    const decision = w.store.pendingDecisions.openFor(A_KEY)[0]!.body;
    w.store.withTransaction(() => {
      w.store.pendingDecisions.resolve(decision.decision_id, {
        kind: "OPTION",
        chosen_option: "APPROVE",
        free_form: null,
        resolved_by: "operator@example",
        resolved_at: "2026-08-21T10:00:00Z",
        approval_binding: null,
        applied_transition_ref: null,
      });
    });
    assert.equal(w.tick(), "MERGE_APPROVAL_APPLIED");
    assert.equal(w.tick(), "BATCH_RESUMED");
    assert.equal(w.store.batches.require(BATCH_ID).status, "RUNNING");
  }, { batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 1 } });
});

test("B15-3: START_SUBFLOW is validated-but-not-applied; the sealed explicit-parent linkage suspends and resumes", () => {
  withWorld((world) => {
    const repository = new ChainRepository(HEAD);
    const w = coordinatorWorld(world, { repository });
    discover(world, B_REF);

    // Parent A reaches VERIFYING: its attempt no longer holds the writable slot (§19.3c).
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    assert.deepEqual(submit(w, world, { ref: A_REF }).result, { kind: "ACCEPTED" });
    assert.equal(w.tick(), "ACTIVATED");
    assert.equal(w.tick(), "IMPLEMENTATION_STARTED");
    repository.candidate = CA;
    const parentAttempt = w.store.attempts.current(A_KEY)!;
    const stored = w.store.adapterMetadata
      .forEntity(parentAttempt.attempt_key)
      .find((row) => row.key.startsWith("actor_turn:"));
    w.runtime.turnResults.set(JSON.stringify(stored?.value), {
      session_handle: {} as never,
      turn_handle: stored?.value as never,
      backend_status: "COMPLETED",
      termination_reason: "end_turn",
      started_at: "t1",
      completed_at: "t2",
      provenance: { runtime_backend: "fake", identity_authority: "BACKEND", result_channel: "TURN_TEXT" },
    });
    assert.equal(w.tick(), "VERIFICATION_STARTED");
    assert.equal(w.store.attempts.current(A_KEY)?.state, "VERIFYING");

    // PR #43 finding 9 — even with a unique in-flight candidate, the Platform must not derive a
    // parent from a Proposal that names none: that reading was implementation-decided contract
    // semantics (CONTRACT_AMBIGUITY, Spec §47). The Proposal validates; nothing is applied.
    repository.candidate = null;
    const refused = submit(w, world, { ref: B_REF, decision: "START_SUBFLOW", classification: "SPLIT_NEEDED" });
    assert.deepEqual(refused.result, { kind: "ACCEPTED" }, "validation itself accepts");
    assert.equal(refused.admitted, false, "but no parent rule exists to apply");
    assert.equal(w.store.tasks.require(B_KEY).platform_state, "DISCOVERED");
    assert.equal(w.store.tasks.require(A_KEY).platform_state, "ACTIVE", "the parent is untouched");
    assert.equal(w.store.decisions.countByKind("contract_ambiguity_observed"), 1);

    // The sealed mechanism, driven with the explicit parent reference a governance-fixed contract
    // (e.g. a ProposalV2 parent field) would supply: linkage and suspension in one transaction.
    commitAdmission(w.store, {
      task_key: B_KEY,
      selection: SELECTION,
      repository_scope_id: SCOPE_ID,
      selection_binding: BINDING,
      admitted_at: "t-admit",
      hard_dependencies_clear: true,
      subflow_parent_task_key: A_KEY,
    });
    assert.equal(w.store.tasks.require(B_KEY).platform_state, "SELECTED");
    assert.equal(w.store.tasks.require(B_KEY).parent_task_key, A_KEY, "the child is linked");
    assert.equal(w.store.tasks.require(A_KEY).platform_state, "SUSPENDED", "the parent parked");

    // A suspended parent advances nothing; the child runs the whole pipeline to COMPLETED.
    assert.equal(w.tick(), "ACTIVATED");
    assert.equal(w.tick(), "IMPLEMENTATION_STARTED");
    completeActiveTask(w, B_KEY, CB, repository);

    // Child COMPLETED → the parent resumes (Spec §47), with its attempt exactly where it was.
    assert.equal(w.tick(), "PARENT_RESUMED");
    assert.equal(w.store.tasks.require(A_KEY).platform_state, "ACTIVE");
    assert.equal(w.store.attempts.current(A_KEY)?.state, "VERIFYING");
  }, {
    ...TWO_TASK_AUTO,
    allow_auto_subflow: true,
    // V11 rule 2 is sealed: the ACTIVE parent holds a concurrency slot until it is terminal, so a
    // subflow beside it needs a second slot. The writable slot stays single (rule 3).
    batch_policy: { max_tasks: 2, max_rework: 2, concurrency: 2 },
    classification_policy: { IMPLEMENTABLE: "AUTO_EXECUTE", SPLIT_NEEDED: "AUTO_SUBFLOW" },
  });
});

test("B15-4: START_SUBFLOW records the CONTRACT_AMBIGUITY durably — nothing admitted, nothing suspended", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    discover(world, B_REF);
    const outcome = submit(w, world, { ref: B_REF, decision: "START_SUBFLOW" });
    assert.deepEqual(outcome.result, { kind: "ACCEPTED" }, "validation itself accepts");
    assert.equal(outcome.admitted, false, "but nothing was admitted");
    assert.equal(w.store.tasks.require(B_KEY).platform_state, "DISCOVERED");
    assert.equal(w.store.decisions.countByKind("contract_ambiguity_observed"), 1);
    const entry = w.store.decisions
      .read()
      .find((row) => row.kind === "contract_ambiguity_observed");
    const payload = entry?.payload as {
      classification?: string;
      subject?: string;
      contract_refs?: string[];
    };
    assert.equal(payload.classification, "CONTRACT_AMBIGUITY");
    assert.equal(payload.subject, "subflow_parent_binding");
    assert.equal(payload.contract_refs?.includes("spec:§47"), true, "the observation names its contract");
  }, { ...TWO_TASK_AUTO, allow_auto_subflow: true, classification_policy: { IMPLEMENTABLE: "AUTO_SUBFLOW" } });
});

test("B15-5: DEFER_TASK is applied — a discovered task defers and never admits", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    const outcome = submit(w, world, { ref: A_REF, decision: "DEFER_TASK" });
    assert.deepEqual(outcome.result, { kind: "ACCEPTED" });
    assert.equal(w.store.tasks.require(A_KEY).platform_state, "DEFERRED");
    assert.equal(w.store.tasks.require(A_KEY).admitted_at, null);
  });
});

test("B15-6: RESUME_PARENT is applied — an explicit, validated resume of a suspended parent", () => {
  withWorld((world) => {
    const repository = new ChainRepository(HEAD);
    const w = coordinatorWorld(world, { repository });
    discover(world, B_REF);

    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    assert.deepEqual(submit(w, world, { ref: A_REF }).result, { kind: "ACCEPTED" });
    assert.equal(w.tick(), "ACTIVATED");
    assert.equal(w.tick(), "IMPLEMENTATION_STARTED");
    repository.candidate = CA;
    const attempt = w.store.attempts.current(A_KEY)!;
    const stored = w.store.adapterMetadata
      .forEntity(attempt.attempt_key)
      .find((row) => row.key.startsWith("actor_turn:"));
    w.runtime.turnResults.set(JSON.stringify(stored?.value), {
      session_handle: {} as never,
      turn_handle: stored?.value as never,
      backend_status: "COMPLETED",
      termination_reason: "end_turn",
      started_at: "t1",
      completed_at: "t2",
      provenance: { runtime_backend: "fake", identity_authority: "BACKEND", result_channel: "TURN_TEXT" },
    });
    assert.equal(w.tick(), "VERIFICATION_STARTED");
    repository.candidate = null;
    // Finding 9 — the suspension precondition comes from the sealed explicit-parent linkage, not
    // from a Proposal-derived parent (that derivation is a recorded CONTRACT_AMBIGUITY).
    commitAdmission(w.store, {
      task_key: B_KEY,
      selection: SELECTION,
      repository_scope_id: SCOPE_ID,
      selection_binding: BINDING,
      admitted_at: "t-admit",
      hard_dependencies_clear: true,
      subflow_parent_task_key: A_KEY,
    });
    assert.equal(w.store.tasks.require(A_KEY).platform_state, "SUSPENDED");

    // The Supervisor decides the parent should resume now — child or no child.
    const resumed = submit(w, world, { ref: A_REF, decision: "RESUME_PARENT" });
    assert.deepEqual(resumed.result, { kind: "ACCEPTED" });
    assert.equal(w.store.tasks.require(A_KEY).platform_state, "ACTIVE");
  }, {
    ...TWO_TASK_AUTO,
    allow_auto_subflow: true,
    // V11 rule 2 is sealed: the ACTIVE parent holds a concurrency slot until it is terminal, so a
    // subflow beside it needs a second slot. The writable slot stays single (rule 3).
    batch_policy: { max_tasks: 2, max_rework: 2, concurrency: 2 },
    classification_policy: { IMPLEMENTABLE: "AUTO_EXECUTE", SPLIT_NEEDED: "AUTO_SUBFLOW" },
  });
});
