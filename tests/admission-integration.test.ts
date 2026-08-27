/**
 * M1B4-AC8, AC9, AC33 ~ AC35 — the front half against the two production adapters: a real
 * `ProjectDocumentTaskSource` and a real `LocalGitRepositoryAdapter` over a temp repository.
 *
 * These prove the facts are genuinely observed rather than replayed from durable snapshots: the
 * document and the repository are moved on disk between submissions, and the validator notices.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bootstrapRun } from "../core/admission/bootstrap.ts";
import { submitProposal } from "../core/admission/submit-proposal.ts";
import { materializeDiscoveryPass } from "../core/discovery/materialize.ts";
import { hashTaskDefinitionBody } from "../core/tasksource/task-definition.ts";
import { ProjectDocumentTaskSource } from "../core/tasksource/project-document-task-source.ts";
import { LocalGitRepositoryAdapter } from "../adapters/local-git/local-git-repository-adapter.ts";
import type { DocumentReader } from "../core/tasksource/project-document-task-source.ts";
import { compiled, PROPOSAL_ID } from "./support/decision-fixtures.ts";
import { manifestSetInput } from "./support/admission-fixtures.ts";
import { tempStore } from "./support/temp-store.ts";
import { withGitRepo, type TempGitRepo } from "./support/temp-git-repo.ts";
import { singleDocumentConfig, taskBlock } from "./support/task-fixtures.ts";

const RUN_ID = "run:01JQ8ZK5T7RC9V2W4X6Y8Z0D01";
const BATCH_ID = `${"batch:"}${RUN_ID}:1`;
const PROJECT = "alpha";
const TASK_REF = "T-100";
const TASK_KEY = `task:${PROJECT}:${TASK_REF}`;
const OBSERVED_AT = "2026-08-11T09:00:00Z";

/** A run bootstrapped over a real repository and a real document, with one materialized task. */
function withLiveWorld<T>(
  body: (context: {
    repo: TempGitRepo;
    store: ReturnType<ReturnType<typeof tempStore>["open"]>;
    taskSource: ProjectDocumentTaskSource;
    repository: LocalGitRepositoryAdapter;
    document: { text: string };
    base: string;
  }) => T,
): T {
  return withGitRepo((repo) => {
    const base = repo.commit({ path: "README.md", content: "base\n", message: "A" });
    const temp = tempStore();
    const store = temp.open();

    const document = { text: taskBlock({ ref: TASK_REF, version: "1", dependencies: [] }) };
    const read: DocumentReader = (path) => {
      if (path !== "plan.md") throw new Error(`no such document: ${path}`);
      return document.text;
    };
    const taskSource = new ProjectDocumentTaskSource(singleDocumentConfig(), read);
    const repository = new LocalGitRepositoryAdapter(repo.config());

    try {
      bootstrapRun(store, {
        run_id: RUN_ID,
        batch_id: BATCH_ID,
        project_id: PROJECT,
        compiled_profile: compiled(),
      });
      materializeDiscoveryPass(store, taskSource, {
        run_id: RUN_ID,
        batch_id: BATCH_ID,
        context: { observed_at: OBSERVED_AT },
      });
      return body({ repo, store, taskSource, repository, document, base });
    } finally {
      store.close();
      temp.dispose();
    }
  });
}

/** A START_TASK Proposal whose expectations match the document and the repository right now. */
const proposalFor = (options: {
  version: string;
  definition_hash: string;
  base_head: string;
  compiled_profile_hash: string;
}): Record<string, unknown> => ({
  proposal_id: PROPOSAL_ID,
  decision: "START_TASK",
  task_ref: TASK_REF,
  classification: "IMPLEMENTABLE",
  pipeline_id: "standard",
  actor_profile: "implementation",
  verification_profile: "full",
  repository_scope_id: "collector",
  expected: {
    task_version: options.version,
    task_definition_hash: options.definition_hash,
    base_head: options.base_head,
    compiled_profile_hash: options.compiled_profile_hash,
  },
  reason_refs: [],
});

const currentHash = (taskSource: ProjectDocumentTaskSource): string =>
  hashTaskDefinitionBody(taskSource.get_task(TASK_REF).body);

test("M1B4-AC8 / AC9 / §51: a live document and repository admit the task end to end", () => {
  withLiveWorld(({ store, taskSource, repository, base }) => {
    const profile = compiled();
    const result = submitProposal(
      { store, taskSource, repository, manifests: manifestSetInput() },
      {
        run_id: RUN_ID,
        batch_id: BATCH_ID,
        observed_at: OBSERVED_AT,
        proposal: proposalFor({
          version: "1",
          definition_hash: currentHash(taskSource),
          base_head: base,
          compiled_profile_hash: profile.compiled_hash,
        }),
      },
    );

    assert.deepEqual(result.result, { kind: "ACCEPTED" });
    assert.equal(result.admitted, true);

    const row = store.tasks.require(TASK_KEY);
    assert.equal(row.platform_state, "SELECTED");
    assert.equal(row.classification, "IMPLEMENTABLE");
    assert.equal(row.admitted_at, OBSERVED_AT);
    assert.equal(store.batchView.admitted(BATCH_ID), 1);
    assert.equal(store.attempts.forTask(TASK_KEY).length, 0);
    assert.equal(store.contracts.count(), 0);
    assert.equal(store.grants.count(), 0);
  });
});

test("M1B4-AC9 / §50: a canonical head that really advanced is caught by V8, not by a snapshot", () => {
  withLiveWorld(({ repo, store, taskSource, repository, base }) => {
    const profile = compiled();
    const proposal = proposalFor({
      version: "1",
      definition_hash: currentHash(taskSource),
      base_head: base,
      compiled_profile_hash: profile.compiled_hash,
    });

    // A real commit on the canonical branch, after the Proposal was written.
    const moved = repo.commit({ path: "other.txt", content: "moved\n", message: "B" });
    assert.notEqual(moved, base);
    assert.equal(
      store.tasks.require(TASK_KEY).external_snapshot.observed_at,
      OBSERVED_AT,
      "the durable snapshot still describes the old observation",
    );

    const result = submitProposal(
      { store, taskSource, repository, manifests: manifestSetInput() },
      { run_id: RUN_ID, batch_id: BATCH_ID, observed_at: OBSERVED_AT, proposal },
    );

    assert.deepEqual(result.result, {
      kind: "POLICY_REJECTED",
      reason_code: "REPOSITORY_STATE_MISMATCH",
    });
    assert.equal(store.tasks.require(TASK_KEY).platform_state, "DISCOVERED");
    assert.equal(repository.snapshot_canonical().head, moved, "the fact came from the repository");
  });
});

test("M1B4-AC6 / §50: a document that really changed is caught by V3, not by the durable snapshot", () => {
  withLiveWorld(({ store, taskSource, repository, document, base }) => {
    const profile = compiled();
    const proposal = proposalFor({
      version: "1",
      definition_hash: currentHash(taskSource),
      base_head: base,
      compiled_profile_hash: profile.compiled_hash,
    });

    // The task's document is edited after the Proposal was written.
    document.text = taskBlock({
      ref: TASK_REF,
      version: "2",
      description: "Rewritten scope.",
      dependencies: [],
    });

    const result = submitProposal(
      { store, taskSource, repository, manifests: manifestSetInput() },
      { run_id: RUN_ID, batch_id: BATCH_ID, observed_at: OBSERVED_AT, proposal },
    );

    assert.deepEqual(result.result, { kind: "POLICY_REJECTED", reason_code: "TASK_DRIFT" });
    assert.equal(store.tasks.require(TASK_KEY).platform_state, "DISCOVERED");
    assert.equal(store.batchView.admitted(BATCH_ID), 0);
  });
});

test("M1B4-AC34: the durable materialization is untouched by a rejected submission", () => {
  withLiveWorld(({ repo, store, taskSource, repository, base }) => {
    const before = store.tasks.require(TASK_KEY);
    repo.commit({ path: "other.txt", content: "moved\n", message: "B" });

    submitProposal(
      { store, taskSource, repository, manifests: manifestSetInput() },
      {
        run_id: RUN_ID,
        batch_id: BATCH_ID,
        observed_at: OBSERVED_AT,
        proposal: proposalFor({
          version: "1",
          definition_hash: currentHash(taskSource),
          base_head: base,
          compiled_profile_hash: compiled().compiled_hash,
        }),
      },
    );

    // M1B4-AC43 — submission is not a discovery pass: the snapshot is not refreshed either.
    assert.deepEqual(store.tasks.require(TASK_KEY), before);
  });
});

test("§39: bootstrapRun opens exactly one run and one batch bound to the compiled profile", () => {
  withLiveWorld(({ store }) => {
    const run = store.runs.require(RUN_ID);
    const batch = store.batches.require(BATCH_ID);
    const profile = compiled();

    assert.equal(run.project_id, PROJECT);
    assert.equal(run.status, "RUNNING");
    assert.equal(run.compiled_profile_hash, profile.compiled_hash);
    assert.equal(batch.run_id, RUN_ID);
    assert.equal(batch.ordinal, 1);
    assert.equal(batch.compiled_profile_hash, profile.compiled_hash);
    assert.equal(store.batchView.compiledProfileFor(BATCH_ID).effective.policy.auto_merge, false);
  });
});

test("§42: a bootstrap that fails leaves no partial run behind", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    bootstrapRun(store, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      project_id: PROJECT,
      compiled_profile: compiled(),
    });
    // The same batch id a second time violates the primary key inside the same transaction.
    assert.throws(() =>
      bootstrapRun(store, {
        run_id: "run:01JQ8ZK5T7RC9V2W4X6Y8Z0D02",
        batch_id: BATCH_ID,
        project_id: PROJECT,
        compiled_profile: compiled(),
      }),
    );
    assert.equal(store.runs.get("run:01JQ8ZK5T7RC9V2W4X6Y8Z0D02"), undefined, "no orphan run");
  } finally {
    store.close();
    temp.dispose();
  }
});
