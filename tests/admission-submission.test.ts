/**
 * M1B4-AC1 ~ M1B4-AC16, AC22 ~ AC37 — production Proposal submission: fresh fact assembly,
 * V1–V11, and the one lifecycle transition this batch performs (TD §9.2, §19.3, §26 step 5–7).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AdmissionError } from "../core/admission/errors.ts";
import { assembleDecisionInput } from "../core/admission/fact-assembly.ts";
import { submitProposal } from "../core/admission/submit-proposal.ts";
import { DECISION_VALIDATION_LOG_KIND } from "../core/decision/decision-log.ts";
import { commitAdmission, STATE_TRANSITION_KIND } from "../core/statemachine/transition-commit.ts";
import { TransitionError } from "../core/statemachine/errors.ts";
import { validateDecision } from "../core/decision/validator.ts";
import { TaskSourceError } from "../core/tasksource/errors.ts";
import {
  BATCH_ID,
  BINDING,
  RUN_ID,
  SCOPE_ID,
  TASK_KEY,
  discover,
  type DomainWorld,
  withWorld,
} from "./support/domain-fixtures.ts";
import { HEAD, selection, task, taskControl } from "./support/decision-fixtures.ts";
import {
  authoritiesFor,
  manifestSetInput,
  StubRepository,
  StubTaskSource,
  type AdmissionWorld,
} from "./support/admission-fixtures.ts";

const OBSERVED_AT = "2026-08-11T09:00:00Z";

const submit = (
  world: DomainWorld,
  authorities: AdmissionWorld,
  proposal: unknown,
  overrides: { decision_id?: string; report_channel?: string } = {},
) =>
  submitProposal(authorities, {
    run_id: RUN_ID,
    batch_id: BATCH_ID,
    proposal,
    observed_at: OBSERVED_AT,
    ...overrides,
  });

/** Everything a rejection must leave exactly as it was. */
const durable = (world: DomainWorld) => ({
  task: world.store.tasks.require(TASK_KEY).platform_state,
  admitted_at: world.store.tasks.require(TASK_KEY).admitted_at,
  selectionFields: world.store.tasks.require(TASK_KEY).classification,
  attempts: world.store.attempts.forTask(TASK_KEY).length,
  contracts: world.store.contracts.count(),
  grants: world.store.grants.count(),
  pending: world.store.pendingDecisions.count(),
  metadata: world.store.adapterMetadata.count(),
  view: world.store.batchView.project(BATCH_ID),
});

// --- accepted admission ------------------------------------------------------------------

test("M1B4-AC22 ~ AC32 / §51: an ACCEPTED START_TASK admits the task and nothing more", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);
    const proposal = selection({ profile: world.profile });

    const result = submit(world, authorities, proposal);

    assert.deepEqual(result.result, { kind: "ACCEPTED" });
    assert.equal(result.admitted, true);
    assert.equal(result.task_key, TASK_KEY);

    // M1B4-AC23 / AC24 — the transition and the selection fields come from the validated Proposal.
    const row = world.store.tasks.require(TASK_KEY);
    assert.equal(row.platform_state, "SELECTED");
    assert.equal(row.classification, "IMPLEMENTABLE");
    assert.equal(row.pipeline_id, "standard");
    assert.equal(row.actor_profile, "implementation");
    assert.equal(row.verification_profile, "full");
    assert.equal(row.admitted_at, OBSERVED_AT, "caller-controlled time, not a clock");

    // M1B4-AC25 ~ AC27 — admitted counts; active and writable do not, because there is no Attempt.
    assert.deepEqual(world.store.batchView.project(BATCH_ID), {
      admitted_task_count: 1,
      active_task_count: 0,
      active_writable_candidate_count: 0,
    });

    // M1B4-AC28 ~ AC32
    assert.equal(world.store.attempts.forTask(TASK_KEY).length, 0);
    assert.equal(world.store.contracts.count(), 0);
    assert.equal(world.store.grants.count(), 0);
    assert.equal(world.store.adapterMetadata.count(), 0);
    assert.equal(world.store.idempotency.count(), 0, "no INTENT for a front-half decision");
    assert.deepEqual(
      authorities.repository.calls,
      ["snapshot_canonical"],
      "no workspace, no merge primitive",
    );
  });
});

test("M1B4-AC36 / §54: the validation entry and the transition entry stay separate", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);
    const result = submit(world, authorities, selection({ profile: world.profile }));

    const entries = world.store.decisions.read();
    const validations = entries.filter((entry) => entry.kind === DECISION_VALIDATION_LOG_KIND);
    const transitions = entries.filter((entry) => entry.kind === STATE_TRANSITION_KIND);

    assert.equal(validations.length, 1);
    assert.equal(validations[0]?.seq, result.validation_seq);
    assert.deepEqual((validations[0]?.payload as Record<string, unknown>)["result"], "ACCEPTED");
    // One transition for the discovery that seeded the task, one for the admission.
    assert.equal(transitions.length, 2);
    assert.equal(transitions.at(-1)?.seq, result.transition_seq);
    assert.notEqual(result.validation_seq, result.transition_seq);
  });
});

// --- fresh fact rejection (§50) ------------------------------------------------------------

test("M1B4-AC33 / §50: a TaskDefinition that drifted since the Proposal is rejected by V3", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource(task({ version: "2" }));
    const authorities = authoritiesFor(world, { taskSource: source });
    const before = durable(world);

    const result = submit(world, authorities, selection({ profile: world.profile }));

    assert.deepEqual(result.result, { kind: "POLICY_REJECTED", reason_code: "TASK_DRIFT" });
    assert.equal(result.admitted, false);
    assert.deepEqual(durable(world), before, "M1B4-AC15: nothing moved");
    assert.equal(source.calls.includes("get_task:T-101"), true, "the source was read fresh");
  });
});

test("M1B4-AC34 / §50: a canonical head that moved since the Proposal is rejected by V8", () => {
  withWorld((world) => {
    discover(world);
    const repository = new StubRepository("head-canonical-2");
    const authorities = authoritiesFor(world, { repository });
    const before = durable(world);

    const result = submit(world, authorities, selection({ profile: world.profile }));

    assert.deepEqual(result.result, {
      kind: "POLICY_REJECTED",
      reason_code: "REPOSITORY_STATE_MISMATCH",
    });
    assert.deepEqual(durable(world), before);
    assert.deepEqual(repository.calls, ["snapshot_canonical"], "the head was read fresh");
  });
});

/** A Policy that insists the Actor's feature-write capability is fully enforced. */
const REQUIRES_ENFORCED_FEATURE_WRITE = {
  capability_requirements: {
    actor_execution: { "repository.feature_write": { accepted: ["ENFORCED"] } },
  },
};

/** Manifests where exactly that assurance has been weakened. */
const WEAKENED = () =>
  manifestSetInput({ "repository.feature_write": { allow: "NOT_YET_AUDITED" } });

test("M1B4-AC35 / AC16 / §50: a weakened Backend manifest is rejected by V10", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world, { manifests: WEAKENED() });
    const before = durable(world);

    const result = submit(world, authorities, selection({ profile: world.profile }));

    assert.equal(result.result.kind, "BACKEND_INCOMPATIBLE");
    if (result.result.kind === "BACKEND_INCOMPATIBLE") {
      assert.equal(result.result.detail.operation_id, "actor_execution");
      assert.equal(result.result.detail.failure.capability, "repository.feature_write");
      assert.equal(result.result.detail.failure.actual, "NOT_YET_AUDITED");
      assert.equal(result.result.detail.failure.passed, false);
    }
    assert.equal(result.admitted, false);
    assert.deepEqual(durable(world), before, "M1B4-AC16: no transition, no Contract, no Grant");
  }, REQUIRES_ENFORCED_FEATURE_WRITE);
});

test("M1B4-AC15 / §53: a policy rejection leaves the whole durable world untouched", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);
    const before = durable(world);

    // An unknown classification: V5 rejects before any of the later steps.
    const result = submit(
      world,
      authorities,
      selection({ profile: world.profile, classification: "NOT_A_CLASSIFICATION" }),
    );

    assert.deepEqual(result.result, {
      kind: "POLICY_REJECTED",
      reason_code: "CLASSIFICATION_UNKNOWN",
    });
    assert.deepEqual(durable(world), before);
    assert.equal(world.store.outbox.count(), 0, "no report was enqueued");
  });
});

test("M1B4-AC14: every one of the four result kinds is journalled once", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);
    const seen: string[] = [];

    seen.push(
      submit(world, authorities, { proposal_id: "not-a-proposal" }).result.kind,
      submit(world, authorities, selection({ profile: world.profile, classification: "NOPE" }))
        .result.kind,
      submit(world, authoritiesFor(world, { manifests: WEAKENED() }), selection({ profile: world.profile }))
        .result.kind,
      submit(world, authorities, selection({ profile: world.profile })).result.kind,
    );

    assert.deepEqual(seen, [
      "POLICY_REJECTED",
      "POLICY_REJECTED",
      "BACKEND_INCOMPATIBLE",
      "ACCEPTED",
    ]);
    assert.equal(
      world.store.decisions.read().filter((e) => e.kind === DECISION_VALIDATION_LOG_KIND).length,
      4,
      "one validation entry per submission, whatever the outcome",
    );
  }, REQUIRES_ENFORCED_FEATURE_WRITE);
});

// --- assembly boundaries -------------------------------------------------------------------

test("M1B4-AC2 / AC3: the routing context is exactly run/batch/proposal and never enters the body", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);
    const proposal = selection({ profile: world.profile });

    const assembled = assembleDecisionInput(authorities, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      proposal,
    });

    assert.deepEqual(Object.keys(assembled.input.proposal as object).sort(), [
      "actor_profile",
      "classification",
      "decision",
      "expected",
      "pipeline_id",
      "proposal_id",
      "reason_refs",
      "repository_scope_id",
      "task_ref",
      "verification_profile",
    ]);
    assert.equal("run_id" in (assembled.input.proposal as object), false);
    assert.equal("batch_id" in (assembled.input.proposal as object), false);
  });
});

test("M1B4-AC2: a run/batch mismatch or an ineligible batch fails before the validator runs", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);
    const proposal = selection({ profile: world.profile });

    assert.throws(
      () =>
        submitProposal(authorities, {
          run_id: "run:01JQ8ZK5T7RC9V2W4X6Y8Z0ZZZ",
          batch_id: BATCH_ID,
          proposal,
          observed_at: OBSERVED_AT,
        }),
    );
    world.store.withTransaction(() => world.store.runs.setStatus(RUN_ID, "PAUSED_SAFELY"));
    assert.throws(
      () => submit(world, authorities, proposal),
      (error: unknown) =>
        error instanceof AdmissionError && error.reason === "SUBMISSION_CONTEXT_INVALID",
    );
    assert.equal(world.store.decisions.read().some((e) => e.kind === DECISION_VALIDATION_LOG_KIND), false);
  });
});

test("M1B4-AC6 / AC7 / §9: an unreadable TaskSource is an operational failure, not TASK_NOT_FOUND", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    const authorities = authoritiesFor(world, { taskSource: source });
    const proposal = selection({ profile: world.profile });
    const before = durable(world);

    for (const failure of [
      new TaskSourceError("DOCUMENT_UNREADABLE", "plan.md", "no such document"),
      new TaskSourceError("DOCUMENT_MALFORMED", "plan.md:3", "bad block"),
      new TaskSourceError("DEFINITION_HASH_MISMATCH", "/definition_hash", "mismatch"),
      new Error("the source process died"),
    ]) {
      source.failure = failure;
      assert.throws(() => submit(world, authorities, proposal), (error: unknown) => error === failure);
    }

    assert.deepEqual(durable(world), before, "no state and no validator call");
    assert.equal(
      world.store.decisions.read().some((e) => e.kind === DECISION_VALIDATION_LOG_KIND),
      false,
    );

    // A genuine "no such ref", by contrast, becomes the typed NOT_FOUND view and V2 rejects it.
    source.failure = new TaskSourceError("TASK_NOT_FOUND", "/task_ref", "unknown ref");
    const result = submit(world, authorities, proposal);
    assert.deepEqual(result.result, { kind: "POLICY_REJECTED", reason_code: "TASK_NOT_FOUND" });
    assert.deepEqual(durable(world), before);
  });
});

test("M1B4-AC6 / §10: a Proposal never materializes a durable task as a side effect", () => {
  withWorld((world) => {
    const source = new StubTaskSource(task({ task_ref: "T-999" }));
    const authorities = authoritiesFor(world, { taskSource: source });

    assert.throws(
      () =>
        submit(
          world,
          authorities,
          selection({ profile: world.profile, definition: task({ task_ref: "T-999" }) }),
        ),
      (error: unknown) => error instanceof AdmissionError && error.reason === "TASK_NOT_MATERIALIZED",
    );

    assert.equal(world.store.tasks.inBatch(BATCH_ID).length, 0, "nothing was discovered on the fly");
    assert.equal(source.calls.includes("discover_tasks"), false);
  });
});

test("M1B4-AC6 / §11: the Proposal, the fresh definition and the durable row must agree", () => {
  withWorld((world) => {
    discover(world);
    // The source answers with a definition for a different task than the one asked for.
    const source = new StubTaskSource(task({ task_ref: "T-202" }));
    const authorities = authoritiesFor(world, { taskSource: source });

    assert.throws(
      () => submit(world, authorities, selection({ profile: world.profile })),
      (error: unknown) => error instanceof AdmissionError && error.reason === "TASK_IDENTITY_MISMATCH",
    );
  });
});

test("M1B4-AC38: an opaque task_ref containing ':' survives assembly unparsed", () => {
  withWorld((world) => {
    const ref = "area:sub:T-7";
    discover(world, ref);
    const definition = task({ task_ref: ref });
    const authorities = authoritiesFor(world, { taskSource: new StubTaskSource(definition) });

    const result = submit(world, authorities, selection({ profile: world.profile, definition }));

    assert.equal(result.task_key, `task:alpha:${ref}`);
    assert.equal(result.result.kind, "ACCEPTED");
    assert.equal(world.store.tasks.require(`task:alpha:${ref}`).platform_state, "SELECTED");
  });
});

test("M1B4-AC11: the batch view comes from the Store projection, not a Coordinator counter", () => {
  withWorld(
    (world) => {
      discover(world, "T-1");
      discover(world, "T-2");
      const authorities = authoritiesFor(world);

      const first = task({ task_ref: "T-1" });
      authorities.taskSource.definition = first;
      submit(world, authorities, selection({ profile: world.profile, definition: first }));
      assert.equal(world.store.batchView.admitted(BATCH_ID), 1);

      // max_tasks = 1, so V11 refuses the second selection using the durable count.
      const second = task({ task_ref: "T-2" });
      authorities.taskSource.definition = second;
      const result = submit(world, authorities, selection({ profile: world.profile, definition: second }));

      assert.deepEqual(result.result, {
        kind: "POLICY_REJECTED",
        reason_code: "BATCH_MAX_TASKS_REACHED",
      });
      assert.equal(world.store.tasks.require("task:alpha:T-2").platform_state, "DISCOVERED");
    },
    { batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 2 } },
  );
});

// --- dependency boundary ---------------------------------------------------------------------

test("M1B4-AC12 / AC13: dependencies are read fresh for a selection and never persisted", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    // An external prerequisite that the source reports as finished (TD §8.4a first branch).
    source.dependencies = [{ task_ref: "T-101", depends_on_ref: "T-100", kind: "HARD" }];
    source.externalStates["T-100"] = "CLOSED";
    const authorities = authoritiesFor(world, { taskSource: source });

    const result = submit(world, authorities, selection({ profile: world.profile }));

    assert.deepEqual(result.result, { kind: "ACCEPTED" });
    assert.equal(result.admitted, true);
    assert.deepEqual(result.observed_dependencies, source.dependencies, "observed and reported");
    assert.equal(source.calls.filter((call) => call.startsWith("get_dependencies")).length, 1);
    assert.equal(source.calls.filter((call) => call === "get_task_state:T-100").length, 1);

    // Nothing durable records them, and the fact itself is not stored either.
    const payloads = world.store.decisions.read().map((entry) => JSON.stringify(entry.payload));
    assert.equal(payloads.some((payload) => payload.includes("depends_on_ref")), false);
    assert.equal(payloads.some((payload) => payload.includes("hard_dependencies_clear")), false);
    assert.equal(world.store.adapterMetadata.count(), 0);
  });
});

test("M1B4-AC12: a non-selection decision issues no dependency read", () => {
  withWorld((world) => {
    discover(world);
    const source = new StubTaskSource();
    const authorities = authoritiesFor(world, { taskSource: source });

    submit(world, authorities, taskControl({ profile: world.profile }));

    assert.equal(source.calls.some((call) => call.startsWith("get_dependencies")), false);
  });
});

// --- authority boundary ------------------------------------------------------------------------

test("M1B4-AC37 / §56: the state-machine guard is the final authority after ACCEPTED", () => {
  withWorld(
    (world) => {
      discover(world, "T-1");
      discover(world, "T-2");
      const authorities = authoritiesFor(world);

      // Assemble and validate the second task while the batch still has room.
      const second = task({ task_ref: "T-2" });
      authorities.taskSource.definition = second;
      const assembled = assembleDecisionInput(authorities, {
        run_id: RUN_ID,
        batch_id: BATCH_ID,
        proposal: selection({ profile: world.profile, definition: second }),
      });
      assert.deepEqual(assembled.input.batch, {
        admitted_task_count: 0,
        active_task_count: 0,
        active_writable_candidate_count: 0,
      });

      // Someone else fills the batch in between, so the assembled view is now stale.
      const first = task({ task_ref: "T-1" });
      authorities.taskSource.definition = first;
      submit(world, authorities, selection({ profile: world.profile, definition: first }));

      // The validator, judging the stale input it was given, still says ACCEPTED …
      assert.deepEqual(validateDecision(assembled.input), { kind: "ACCEPTED" });

      // … and the commit-time durable guard refuses anyway. ACCEPTED is not a licence to mutate.
      assert.throws(
        () =>
          commitAdmission(world.store, {
            task_key: "task:alpha:T-2",
            selection: {
              classification: "IMPLEMENTABLE",
              pipeline_id: "standard",
              actor_profile: "implementation",
              verification_profile: "full",
            },
            repository_scope_id: SCOPE_ID,
            selection_binding: BINDING,
            admitted_at: OBSERVED_AT,
            hard_dependencies_clear: true,
          }),
        (error: unknown) => error instanceof TransitionError && error.reason === "ADMISSION_REJECTED",
      );
      assert.equal(world.store.tasks.require("task:alpha:T-2").platform_state, "DISCOVERED");
    },
    { batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 2 } },
  );
});

test("M1B4-AC22: only START_TASK admits; other accepted decisions report without transitioning", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);

    const result = submit(world, authorities, taskControl({ profile: world.profile }));

    assert.deepEqual(result.result, { kind: "ACCEPTED" });
    assert.equal(result.admitted, false);
    assert.equal(result.transition_seq, null);
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "DISCOVERED");
  });
});
