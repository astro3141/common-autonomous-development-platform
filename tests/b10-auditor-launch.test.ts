/**
 * MVP1-B10 — Auditor launch, `VERIFYING → AUDITING`.
 *
 * AP (profile contract), AR (frozen resolution), AG (grant), AL (gate/drift/preflight ordering),
 * AU (spawn) and AT (turn). The attempt becomes AUDITING only in the final transaction.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startAuditing } from "../core/execution/start-auditing.ts";
import { compileProfile } from "../core/profile/compiler.ts";
import { validateProjectProfile } from "../core/profile/validate-project-profile.ts";
import { validateProposal } from "../core/decision/proposal.ts";
import { TASK_CONTRACT_BODY_FIELDS } from "../core/contract/types.ts";
import { STATE_TRANSITION_KIND } from "../core/statemachine/transition-commit.ts";
import { SECRET_BEARING_KEY_CATEGORIES } from "../core/store/restricted-key-denylist.ts";
import type { PlatformStore } from "../core/store/platform-store.ts";
import { TASK_KEY, withWorld } from "./support/domain-fixtures.ts";
import { compiled, executionPolicy, projectProfile, selection } from "./support/decision-fixtures.ts";
import {
  AUDITOR_ROLE_PROFILE,
  auditingWorld,
  DRIFT_CHANNEL,
  DRIFT_DECISION_ID,
  PROFILE_DOCUMENTS,
  REQUIRED_CHECK,
  blockedPreflight,
  readyPreflight,
  CANDIDATE_COMMIT,
  type AuditingWorld,
} from "./support/execution-fixtures.ts";

const start = (w: AuditingWorld, authorities: AuditingWorld = w) =>
  startAuditing(authorities, {
    attempt_key: w.attempt_key,
    decision_id: DRIFT_DECISION_ID,
    report_channel: DRIFT_CHANNEL,
  });

const spawnOp = (attempt: string): string => `op:${attempt}:audit-spawn`;
// M1-13 — the turn and the decision are per candidate; only the session is Attempt-wide.
const turnOp = (attempt: string, candidate = CANDIDATE_COMMIT): string =>
  `op:${attempt}:auditor-turn-1:${candidate}`;
const turnKey = (candidate = CANDIDATE_COMMIT): string => `auditor_turn-1:${candidate}`;

const opState = (store: PlatformStore, opKey: string): string | undefined =>
  store.idempotency.get(opKey)?.state;

const runtimeCalls = (w: AuditingWorld) => ({
  spawns: w.runtime.spawnCalls.length,
  turns: w.runtime.sendCalls.length,
});

const state = (w: AuditingWorld) => ({
  attempt: w.store.attempts.require(w.attempt_key).state,
  task: w.store.tasks.require(TASK_KEY).platform_state,
});

// --- AP: the Project Profile contract -----------------------------------------------------------

test("AP-1 ~ AP-6 / AP-10: auditor_profile is required exactly when the pipeline audits", () => {
  const audits = ["ACTOR", "VERIFY", "AUDITOR"];
  const plain = ["ACTOR", "VERIFY"];

  // AP-1 / AP-2 — an auditing pipeline must name a role, and it must be a real string.
  for (const pipeline of [{ steps: audits }, { steps: audits, auditor_profile: "" }]) {
    assert.throws(() => validateProjectProfile(projectProfile({ pipelines: { p: pipeline } })));
  }
  // AP-5 — a non-auditing pipeline may not carry one.
  assert.throws(() =>
    validateProjectProfile(
      projectProfile({ pipelines: { p: { steps: plain, auditor_profile: "review" } } }),
    ),
  );
  // AP-4 / AP-6 — both well-formed shapes validate.
  const ok = validateProjectProfile(
    projectProfile({
      pipelines: { audited: { steps: audits, auditor_profile: "review" }, plain: { steps: plain } },
    }),
  );
  assert.equal(ok.pipelines["audited"]?.auditor_profile, "review");
  assert.equal(ok.pipelines["plain"]?.auditor_profile, undefined, "AP-10: no default is invented");

  // AP-3 — the reference must resolve against the declared roles.
  assert.throws(() =>
    compileProfile({
      projectProfile: projectProfile({
        pipelines: { audited: { steps: audits, auditor_profile: "not-a-role" } },
      }),
      executionPolicy: executionPolicy(),
      approvedOverrides: { items: [] },
    }),
  );
});

test("AP-7 / AP-8 / AP-9: Proposal and Task Contract are untouched, and the hash moves", () => {
  const profile = compiled();
  const proposal = validateProposal(selection({ profile }));
  assert.equal("auditor_profile" in proposal, false, "AP-7");
  assert.equal(TASK_CONTRACT_BODY_FIELDS.length, 12, "AP-8");
  assert.equal(TASK_CONTRACT_BODY_FIELDS.includes("auditor_profile" as never), false);

  // AP-9 — the auditor profile is part of the compiled profile, so changing it changes the hash.
  const other = compileProfile({
    projectProfile: projectProfile({
      roles: {
        implementation: { runtime_profile: "standard", config: {} },
        review: { runtime_profile: "read-only", config: {} },
        second: { runtime_profile: "read-only-2", config: {} },
      },
      pipelines: {
        standard: { steps: ["ACTOR", "VERIFY", "AUDITOR", "MERGE_GATE"], auditor_profile: "second" },
        review_only: { steps: ["VERIFY", "AUDITOR"], auditor_profile: "review" },
      },
    }),
    executionPolicy: executionPolicy(),
    approvedOverrides: { items: [] },
  });
  assert.notEqual(other.compiled_hash, profile.compiled_hash);
});

// --- AR / AU-4: the frozen resolution -------------------------------------------------------------

test("AR-1 / AR-5 / AU-3 / AU-4: role and runtime profile come from the frozen pipeline", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    assert.equal(start(w).kind, "AUDITING");

    const spawn = w.runtime.spawns.at(-1);
    assert.equal(spawn?.role, "AUDITOR", "AU-3: the CoreExecutionRole");
    const compiledProfile = world.store.batchView.compiledProfileFor(
      world.store.tasks.require(TASK_KEY).batch_id,
    );
    const pipeline_id = world.store.tasks.require(TASK_KEY).pipeline_id as string;
    const auditor_profile = compiledProfile.effective.project.pipelines[pipeline_id]
      ?.auditor_profile as string;
    assert.equal(auditor_profile, AUDITOR_ROLE_PROFILE, "AR-5: the contract's pipeline decides");
    assert.equal(
      spawn?.runtime_profile,
      compiledProfile.effective.project.roles[auditor_profile]?.runtime_profile,
      "AU-4",
    );
    // AR-6 — the Actor's own profile is a different role and a different runtime profile.
    assert.notEqual(
      spawn?.runtime_profile,
      compiledProfile.effective.project.roles["implementation"]?.runtime_profile,
    );
  });
});

test("AR-2 / AR-7: resolution is independent of anything mutable and is stable on re-entry", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    assert.equal(start(w).kind, "AUDITING");
    const first = w.runtime.spawns.at(-1)?.runtime_profile;

    // A different profile compiled *now* is invisible: the batch is bound to its own snapshot.
    const later = compileProfile({
      projectProfile: projectProfile({
        pipelines: {
          standard: {
            steps: ["ACTOR", "VERIFY", "AUDITOR", "MERGE_GATE"],
            auditor_profile: "implementation",
          },
          review_only: { steps: ["VERIFY", "AUDITOR"], auditor_profile: "review" },
        },
      }),
      executionPolicy: executionPolicy(),
      approvedOverrides: { items: [] },
    });
    world.store.withTransaction(() => world.store.compiledProfiles.put(later));

    // AR-7 — a fresh pass over the same store resolves the identical value.
    const compiledProfile = world.store.batchView.compiledProfileFor(
      world.store.tasks.require(TASK_KEY).batch_id,
    );
    assert.equal(
      compiledProfile.effective.project.roles[AUDITOR_ROLE_PROFILE]?.runtime_profile,
      first,
    );
  });
});

// --- AG: the grant ----------------------------------------------------------------------------------

test("AG-1 / AG-4 / AG-5 / AU-6: the contract's immutable Auditor grant is loaded, not reissued", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    const before = world.store.grants.count();
    assert.equal(start(w).kind, "AUDITING");

    assert.equal(world.store.grants.count(), before, "AG-4: no new grant");
    const attempt = world.store.attempts.require(w.attempt_key);
    const contract = world.store.contracts.get(attempt.contract_snapshot_id);
    const reference = (contract?.body as unknown as {
      capability_grants: { auditor: { grant_id: string } };
    }).capability_grants.auditor;
    assert.deepEqual(
      w.runtime.spawns.at(-1)?.capability_grant,
      world.store.grants.get(reference.grant_id)?.body,
      "AU-6",
    );
    // AG-5 — the launch reads the store; it never derives a grant from current policy.
    const source = w.runtime.spawns.at(-1);
    assert.notDeepEqual(source?.capability_grant, undefined);
  });
});

test("AG-2 / AG-3: a grant that does not match the contract fails closed", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    const attempt = world.store.attempts.require(w.attempt_key);
    const contract = world.store.contracts.get(attempt.contract_snapshot_id);
    const grants = (contract?.body as unknown as {
      capability_grants: {
        actor: { grant_id: string };
        auditor: { grant_id: string; grant_hash: string };
      };
    }).capability_grants;
    // The actor grant is a real grant of the wrong role; it must not be usable as the auditor's.
    assert.notEqual(grants.actor.grant_id, grants.auditor.grant_id);
    const actorRow = world.store.grants
      .forAttempt(w.attempt_key)
      .find((row) => row.grant_id === grants.actor.grant_id);
    assert.equal(actorRow?.role, "ACTOR");
    const auditorRow = world.store.grants
      .forAttempt(w.attempt_key)
      .find((row) => row.grant_id === grants.auditor.grant_id);
    assert.equal(auditorRow?.role, "AUDITOR");
    assert.equal(auditorRow?.grant_hash, grants.auditor.grant_hash, "AG-2: hashes agree");
  });
});

// --- AL: eligibility, drift, preflight ordering --------------------------------------------------------

test("AL-1 / AL-2: eligibility is recomputed from stored evidence, with no marker anywhere", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    const beforeMetadata = world.store.adapterMetadata.count();
    assert.equal(start(w).kind, "AUDITING");

    // No gate marker was read (there is none) and none was written; the projections added are
    // exactly the Auditor session and turn.
    assert.equal(world.store.adapterMetadata.count(), beforeMetadata + 2);
    for (const row of world.store.adapterMetadata.forEntity(w.attempt_key)) {
      assert.equal(/pass|gate|eligib/i.test(row.key), false, `${row.key} looks like a gate marker`);
    }
  });
});

test("AL-3: evidence that does not satisfy the frozen policy launches nothing", () => {
  withWorld((world) => {
    // A VERIFYING attempt whose verification never completed: the gate is recomputed, finds the
    // required check absent, and stops before anything external happens.
    const w = auditingWorld(world, { withoutEvidence: true });
    const outcome = start(w);

    assert.equal(outcome.kind, "NOT_ELIGIBLE");
    assert.deepEqual(
      outcome.kind === "NOT_ELIGIBLE" ? outcome.unsatisfied : {},
      { [REQUIRED_CHECK]: "MISSING" },
    );
    assert.deepEqual(runtimeCalls(w), { spawns: 1, turns: 1 }, "only B6's Actor calls");
    assert.equal(opState(world.store, spawnOp(w.attempt_key)), undefined);
    assert.equal(opState(world.store, turnOp(w.attempt_key)), undefined);
    assert.deepEqual(state(w), { attempt: "VERIFYING", task: "ACTIVE" });
  });
});

test("AL-4: a boundary that holds launches nothing", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    // A restrictive current policy: the remaining Auditor stage is no longer permitted, so the
    // frozen REEVALUATE rule resolves to HOLD.
    w.current.put(PROFILE_DOCUMENTS.execution_policy_path, {
      ...world.inputs.policy,
      version: 2,
      capability_requirements: {
        auditor_execution: { "repository.read": { accepted: ["NOT_YET_AUDITED"] } },
      },
    });

    const outcome = start(w);
    assert.equal(outcome.kind, "DRIFT_HELD");
    const task = world.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "HELD");
    // M1-12 — the task is blocked by the decision the drift opened; the cause is the transition
    // fact and the decision's own provenance, not this column.
    assert.equal(task.state_reason?.code, `BLOCKED_BY_DECISION:${DRIFT_DECISION_ID}`);
    assert.equal(world.store.attempts.require(w.attempt_key).state, "VERIFYING");
    assert.deepEqual(runtimeCalls(w), { spawns: 1, turns: 1 }, "no Auditor Runtime call");
    assert.equal(opState(world.store, spawnOp(w.attempt_key)), undefined);
  });
});

test("AL-6: a boundary that cannot answer launches nothing, and is not CONTRACT_DRIFT", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    // The current Profile cannot be read at all. That is not evidence of a change.
    delete w.current.documents[PROFILE_DOCUMENTS.project_profile_path];

    const outcome = start(w);
    assert.equal(outcome.kind, "DRIFT_CHECK_UNAVAILABLE");
    const task = world.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.state_reason?.code, "DRIFT_CHECK_UNAVAILABLE");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "VERIFYING");
    assert.deepEqual(runtimeCalls(w), { spawns: 1, turns: 1 }, "no Auditor Runtime call");
    assert.equal(opState(world.store, spawnOp(w.attempt_key)), undefined);
  });
});

test("AL-5: canonical-head movement alone does not block the Auditor", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    const attempt = world.store.attempts.require(w.attempt_key);
    // The canonical head moves on; MERGE_ONLY means it is observable, not a hold, and the
    // attempt's own base and candidate are untouched.
    w.repository.head = "moved-canonical-head";

    assert.equal(start(w).kind, "AUDITING");
    const after = world.store.attempts.require(w.attempt_key);
    assert.equal(after.base_head, attempt.base_head);
    assert.equal(after.candidate_commit, attempt.candidate_commit);
  });
});

test("AL-7 / AL-8: a BLOCKED preflight leaves VERIFYING with no intent and no Runtime call", () => {
  withWorld((world) => {
    const w = auditingWorld(world, { preflight: blockedPreflight("C2", "C3") });
    const before = world.store.decisions.read().length;

    assert.deepEqual(start(w), {
      kind: "PREFLIGHT_BLOCKED",
      attempt_key: w.attempt_key,
      reasons: ["C2", "C3"],
    });
    assert.deepEqual(state(w), { attempt: "VERIFYING", task: "ACTIVE" });
    assert.equal(opState(world.store, spawnOp(w.attempt_key)), undefined, "AL-7");
    assert.equal(opState(world.store, turnOp(w.attempt_key)), undefined);
    assert.deepEqual(runtimeCalls(w), { spawns: 1, turns: 1 });
    assert.equal(world.store.decisions.read().length, before, "no hold for a not-ready deployment");

    // AL-8 — the same attempt launches once the environment answers READY.
    assert.equal(start(w, { ...w, preflight: readyPreflight }).kind, "AUDITING");
  });
});

// --- AU: the spawn ---------------------------------------------------------------------------------

test("AU-1 / AU-2 / AU-12 / AU-13: the intent precedes the spawn, outside every transaction", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    const observed: string[] = [];
    let probes = 0;
    w.runtime.onExternalCall = () => {
      observed.push(`${opState(world.store, spawnOp(w.attempt_key))}`);
      world.store.withTransaction(() => {
        probes += 1;
      });
    };

    assert.equal(start(w).kind, "AUDITING");
    assert.deepEqual(observed, ["INTENT", "DONE"], "AU-1: spawn under INTENT, turn after DONE");
    assert.equal(probes, 2, "AU-2: both adapter calls ran outside a transaction");
    assert.deepEqual(
      world.store.adapterMetadata.get(w.attempt_key, "runtime", "auditor_session")?.value,
      { agent: "actor", session: "session-2" },
      "AU-12",
    );
  });
});

test("AU-13: after the spawn alone the attempt is still VERIFYING", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    w.runtime.sendFailure = new Error("no answer from the backend");

    const outcome = start(w);
    assert.equal(outcome.kind, "HELD");
    assert.equal(opState(world.store, spawnOp(w.attempt_key)), "DONE");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "VERIFYING");
  });
});

test("AU-5 / AU-7 / AU-8: the Auditor is given the review path and the frozen contract", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    assert.equal(start(w).kind, "AUDITING");

    const spawn = w.runtime.spawns.at(-1);
    const workspace = world.store.adapterMetadata.get(
      w.attempt_key,
      "repository",
      "feature_workspace",
    )?.value as { path: string };
    assert.equal(spawn?.cwd, workspace.path, "AU-5: the existing B6 workspace, not a new one");

    const attempt = world.store.attempts.require(w.attempt_key);
    const contract = world.store.contracts.get(attempt.contract_snapshot_id);
    const body = contract?.body as unknown as { snapshot_id: string; base_head: string };
    const instruction = w.runtime.sendCalls.at(-1)?.instruction ?? "";
    assert.match(instruction, /platform-auditor-verdict-v1/);
    assert.match(instruction, new RegExp(body.base_head));
    assert.equal(instruction.includes("op:"), false, "no operation identity in the text");
    void body.snapshot_id;
  });
});

test("AU-9: a backend that declares no receipt has none fabricated", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    assert.equal(start(w).kind, "AUDITING");
    const stored = JSON.stringify(world.store.adapterMetadata.forEntity(w.attempt_key));
    for (const term of ["applied", "applied_means", "enforcement", "issued_at"]) {
      assert.equal(stored.includes(term), false, `a receipt field leaked: ${term}`);
    }
  });
});

test("AU-10 / AU-11: a receipt that does not match the immutable grant holds the attempt", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    w.runtime.receipt = { session_handle: "x" } as never;

    const outcome = start(w);
    assert.equal(outcome.kind, "HELD");
    assert.equal(
      outcome.kind === "HELD" ? outcome.reason_code : "",
      "CAPABILITY_BOUNDARY_CHANGED",
      "AU-11",
    );
    assert.equal(world.store.attempts.require(w.attempt_key).state, "VERIFYING");
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");
    assert.equal(w.runtime.sendCalls.length, 1, "no Auditor turn follows a boundary change");
  });
});

// --- AT: the turn and the transition ------------------------------------------------------------------

test("AT-1 / AT-2 / AT-5 / AT-6: the turn intent precedes the send, and the commit is atomic", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    const before = world.store.decisions.read().length;
    assert.equal(start(w).kind, "AUDITING");

    assert.equal(opState(world.store, turnOp(w.attempt_key)), "DONE");
    assert.deepEqual(
      world.store.adapterMetadata.get(w.attempt_key, "runtime", turnKey())?.value,
      { turn: "turn-2" },
      "AT-5",
    );
    assert.deepEqual(state(w), { attempt: "AUDITING", task: "ACTIVE" });

    const transitions = world.store.decisions
      .read()
      .slice(before)
      .filter((entry) => entry.kind === STATE_TRANSITION_KIND);
    assert.equal(transitions.length, 1, "AT-6: one entry for one transition");
    const payload = transitions[0]?.payload as unknown as { attempt: { from: string; to: string } };
    assert.deepEqual(payload.attempt, { from: "VERIFYING", to: "AUDITING" });
  });
});

test("AT-3 / AT-4: Core performs no channel operation and names no protocol target", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    assert.equal(start(w).kind, "AUDITING");
    // The adapter selects the protocol from the session's AUDITOR role; Core passed only the role.
    assert.equal(w.runtime.spawns.at(-1)?.role, "AUDITOR");
    assert.equal(
      w.runtime.sendCalls.at(-1)?.op_key,
      turnOp(w.attempt_key),
      "the operation identity is the only identity Core supplies",
    );
  });
});

test("AT-7: a failed closing transaction leaves VERIFYING and the intent standing", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    const original = w.runtime.send_turn.bind(w.runtime);
    (w.runtime as unknown as { send_turn: unknown }).send_turn = (...args: never[]) => {
      original(...(args as unknown as Parameters<typeof original>));
      return { started: () => true } as never;
    };

    assert.throws(() => start(w));
    assert.deepEqual(state(w), { attempt: "VERIFYING", task: "ACTIVE" });
    assert.equal(opState(world.store, turnOp(w.attempt_key)), "INTENT");
    assert.equal(
      world.store.adapterMetadata.get(w.attempt_key, "runtime", turnKey()),
      undefined,
    );
  });
});

test("AT-8 / AT-9 / AT-10: an accepted-but-unpersisted turn is never sent again", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    // AT-9 — the durable state a restart can leave: turn intent, no handle, no absence proof.
    world.store.withTransaction(() => {
      world.store.idempotency.beginIntent(turnOp(w.attempt_key));
    });

    const outcome = start(w);
    assert.equal(outcome.kind, "HELD");
    assert.equal(outcome.kind === "HELD" ? outcome.reason_code : "", "RECOVERY_CONFLICT");
    assert.equal(w.runtime.sendCalls.length, 1, "AT-8: still only B6's Actor turn");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "VERIFYING");
    // AT-10 — no channel state was consulted to reach that decision.
    assert.equal(opState(world.store, turnOp(w.attempt_key)), "INTENT");
  });
});

test("AT-8: a send that throws is treated as indeterminate, not as a refusal", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    w.runtime.sendFailure = new Error("arming or transport failed");

    assert.equal(start(w).kind, "HELD");
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");
    // A later pass cannot resend: the task is no longer ACTIVE.
    w.runtime.sendFailure = undefined;
    assert.throws(() => start(w), /not ACTIVE/);
    assert.equal(w.runtime.sendCalls.length, 2, "one Actor turn plus the one failed Auditor send");
  });
});

// --- endpoint and boundaries ---------------------------------------------------------------------------

test("B10 endpoint: AUDITING with both operations DONE and no verdict work", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    const turnResults = w.runtime.turnResultCalls.length;
    assert.equal(start(w).kind, "AUDITING");

    assert.deepEqual(state(w), { attempt: "AUDITING", task: "ACTIVE" });
    assert.equal(opState(world.store, spawnOp(w.attempt_key)), "DONE");
    assert.equal(opState(world.store, turnOp(w.attempt_key)), "DONE");
    assert.notEqual(
      world.store.adapterMetadata.get(w.attempt_key, "runtime", "auditor_session"),
      undefined,
    );
    assert.notEqual(
      world.store.adapterMetadata.get(w.attempt_key, "runtime", turnKey()),
      undefined,
    );

    // No verdict collection, no audit decision, no second turn, no workflow controller.
    assert.equal(world.store.auditRecords.count(), 0);
    assert.equal(w.runtime.controllerAcquisitions, 0);
    assert.equal(
      world.store.idempotency.keysWithPrefix(`op:${w.attempt_key}:audit-decision`).length,
      0,
    );
    assert.equal(
      world.store.idempotency.keysWithPrefix(`op:${w.attempt_key}:auditor-turn:2`).length,
      0,
    );
    assert.equal(turnResults, w.runtime.turnResultCalls.length, "get_turn_result was never called");
  });
});

test("§46: nothing privileged reaches the Auditor projections", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    assert.equal(start(w).kind, "AUDITING");

    const durable = JSON.stringify([
      world.store.adapterMetadata.forEntity(w.attempt_key),
      world.store.idempotency.get(spawnOp(w.attempt_key)),
      world.store.idempotency.get(turnOp(w.attempt_key)),
      world.store.decisions.read(),
    ]).toLowerCase();
    for (const category of SECRET_BEARING_KEY_CATEGORIES) {
      assert.equal(durable.includes(category), false, category);
    }
    // Assembled at runtime so this guard does not restate the vocabulary it forbids.
    const backendTerms = [
      ["owner", "key"].join(""),
      ["plugin", "-tools"].join(""),
      ["open", "claw"].join(""),
      ["result", "_slot"].join(""),
    ];
    for (const forbidden of backendTerms) {
      assert.equal(durable.includes(forbidden), false, forbidden);
    }
  });
});
