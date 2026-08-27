/**
 * MVP1-B10 correction — the §11 stage-boundary drift gate (M1-11).
 *
 * D (pure evaluator), O (observation assembly), C (frozen capability basis), P (precedence),
 * L (lifecycle) and A (production authority). The evaluator is exercised on constructed
 * observations; everything else runs the real seams over a real Attempt.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateCapabilityRequirements,
  evaluateFrozenEnforcementRequirements,
} from "../core/capability/compatibility.ts";
import type {
  CapabilityEnforcementMap,
  CapabilityGrantV1Body,
  RequestedCapabilities,
} from "../core/capability/types.ts";
import type { TaskContractV1Body } from "../core/contract/types.ts";
import { assembleDriftObservation } from "../core/execution/assemble-drift-observation.ts";
import {
  ABSENT,
  observed,
  UNAVAILABLE,
  type DriftCurrentState,
  type DriftFrozenState,
  type DriftObservationV1,
  type DriftOutcome,
} from "../core/execution/drift-observation.ts";
import { evaluateStageBoundaryDrift } from "../core/execution/stage-boundary-drift.ts";
import { loadFrozenAuditorCapability, startAuditing } from "../core/execution/start-auditing.ts";
import {
  buildContractDriftDecision,
  driftCause,
  driftDecisionRemainsValid,
} from "../core/humandecision/drift-decision.ts";
import type { PendingDecisionV1 } from "../core/humandecision/types.ts";
import type { DriftDecisionBasis } from "../core/humandecision/drift-decision.ts";
import { isTerminalTask } from "../core/store/domain-types.ts";
import { STATE_TRANSITION_KIND } from "../core/statemachine/transition-commit.ts";
import { CAPABILITY_NAMES } from "../core/schemas/capability-vocabulary.ts";
import { TRANSITION_REASON_CODES } from "../core/statemachine/types.ts";
import { TaskSourceError } from "../core/tasksource/errors.ts";
import {
  DRIFT_POLICY_DEFAULTS,
  type CompiledProfileV1Body,
  type DriftRule,
  type DriftTarget,
} from "../core/profile/types.ts";
import { contractBuild, TASK_KEY, withWorld, type DomainWorld } from "./support/domain-fixtures.ts";
import { task as taskDefinition } from "./support/decision-fixtures.ts";
import {
  auditingWorld,
  DRIFT_CHANNEL,
  DRIFT_DECISION_ID,
  PROFILE_DOCUMENTS,
  type AuditingWorld,
} from "./support/execution-fixtures.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const start = (w: AuditingWorld, decision_id = DRIFT_DECISION_ID) =>
  startAuditing(w, {
    attempt_key: w.attempt_key,
    decision_id,
    report_channel: DRIFT_CHANNEL,
  });

const runtimeCalls = (w: AuditingWorld) => ({
  spawns: w.runtime.spawnCalls.length,
  turns: w.runtime.sendCalls.length,
});

// --- constructed observations, for the pure evaluator -------------------------------------------

const everyCapability = <Value>(value: Value): Readonly<Record<string, Value>> =>
  Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, value]));

const REQUESTED = everyCapability(true) as RequestedCapabilities;
const ENFORCEMENT = everyCapability("ENFORCED") as CapabilityEnforcementMap;

const FROZEN: DriftFrozenState = {
  project_profile: { id: "alpha", version: 1, hash: `sha256:${"1".repeat(64)}` },
  execution_policy: { id: "guarded", version: 1, hash: `sha256:${"2".repeat(64)}` },
  task: { ref: "T-101", version: "1", definition_hash: `sha256:${"3".repeat(64)}` },
  contract_sources: [{ path: "SPEC.md", content_hash: `sha256:${"4".repeat(64)}` }],
  base_head: "head-canonical-1",
  verification_profile: { adapter: "example-verifier", config: {} },
  capability_requirements: {},
  auditor_capability: {
    source_runtime_manifest_hash: `sha256:${"5".repeat(64)}`,
    requested: REQUESTED,
    enforcement: ENFORCEMENT,
  },
};

/** The current world, observed successfully and agreeing with the frozen one at every target. */
const AGREEING: DriftCurrentState = {
  project_profile: observed(FROZEN.project_profile),
  execution_policy: observed(FROZEN.execution_policy),
  task_definition: observed({
    version: FROZEN.task.version,
    definition_hash: FROZEN.task.definition_hash,
  }),
  contract_sources: observed(FROZEN.contract_sources),
  canonical_head: observed(FROZEN.base_head),
  verification_profile: observed(FROZEN.verification_profile),
  capability_requirements: observed(FROZEN.capability_requirements),
  auditor_stage: observed({
    has_auditor: true,
    auditor_profile_declared: true,
    requirement_met: true,
  }),
};

const observation = (
  current: Partial<DriftCurrentState> = {},
  policy: Partial<Record<DriftTarget, DriftRule>> = {},
): DriftObservationV1 => ({
  boundary: "VERIFYING_TO_AUDITING",
  frozen: FROZEN,
  current: { ...AGREEING, ...current },
  policy: { ...DRIFT_POLICY_DEFAULTS, ...policy },
});

/** A stage the current world no longer permits — the restrictive REEVALUATE case. */
const DISALLOWED_STAGE = observed({
  has_auditor: true,
  auditor_profile_declared: true,
  requirement_met: false,
});

const MOVED_REF = { id: "alpha", version: 2, hash: `sha256:${"9".repeat(64)}` };

// --- D: the pure evaluator ------------------------------------------------------------------------

test("D1: a world that agrees at every target continues", () => {
  assert.deepEqual(evaluateStageBoundaryDrift(observation()), { kind: "CONTINUE" });
});

test("D2 / D4 / D5: CONTINUE_SNAPSHOT targets are observed and do not stop the boundary", () => {
  const cases: readonly [DriftTarget, Partial<DriftCurrentState>][] = [
    ["project_profile", { project_profile: observed(MOVED_REF) }],
    [
      "contract_source",
      { contract_sources: observed([{ path: "SPEC.md", content_hash: `sha256:${"a".repeat(64)}` }]) },
    ],
    ["verification_profile", { verification_profile: observed({ adapter: "other", config: {} }) }],
  ];
  for (const [target, current] of cases) {
    assert.equal(DRIFT_POLICY_DEFAULTS[target].action, "CONTINUE_SNAPSHOT");
    assert.deepEqual(
      evaluateStageBoundaryDrift(observation(current)),
      { kind: "CONTINUE" },
      target,
    );
  }
});

test("D3: a changed task definition under the default rule invalidates", () => {
  assert.equal(DRIFT_POLICY_DEFAULTS.task_definition.action, "INVALIDATE_AT_BOUNDARY");
  assert.deepEqual(
    evaluateStageBoundaryDrift(
      observation({ task_definition: observed({ version: "2", definition_hash: FROZEN.task.definition_hash }) }),
    ),
    { kind: "INVALIDATE", target: "task_definition" },
  );
  // A definition that is simply gone is a successful observation, and the same consequence.
  assert.deepEqual(evaluateStageBoundaryDrift(observation({ task_definition: ABSENT })), {
    kind: "INVALIDATE",
    target: "task_definition",
  });
});

test("D6 / D7: a changed policy stops the boundary only when the remaining stage is disallowed", () => {
  assert.equal(DRIFT_POLICY_DEFAULTS.execution_policy.action, "REEVALUATE_AT_BOUNDARY");
  assert.deepEqual(
    evaluateStageBoundaryDrift(observation({ execution_policy: observed(MOVED_REF) })),
    { kind: "CONTINUE" },
    "D6: expansion or an irrelevant change keeps the frozen Attempt running",
  );
  assert.deepEqual(
    evaluateStageBoundaryDrift(
      observation({ execution_policy: observed(MOVED_REF), auditor_stage: DISALLOWED_STAGE }),
    ),
    { kind: "HOLD", target: "execution_policy" },
    "D7",
  );
  // The pipeline this contract names is gone: observed, and the stage cannot run under it.
  assert.deepEqual(
    evaluateStageBoundaryDrift(
      observation({ execution_policy: observed(MOVED_REF), auditor_stage: ABSENT }),
    ),
    { kind: "HOLD", target: "execution_policy" },
  );
});

test("D8 / D9: a changed requirement holds only when it no longer accepts the frozen grant", () => {
  const changed = observed({
    auditor_execution: { "repository.read": { accepted: ["ENFORCED"] as never } },
  });
  assert.deepEqual(
    evaluateStageBoundaryDrift(observation({ capability_requirements: changed })),
    { kind: "CONTINUE" },
    "D8",
  );
  assert.deepEqual(
    evaluateStageBoundaryDrift(
      observation({ capability_requirements: changed, auditor_stage: DISALLOWED_STAGE }),
    ),
    { kind: "HOLD", target: "capability_requirements" },
    "D9",
  );
});

test("D10: no Backend manifest is an input, so Backend movement cannot change the result", () => {
  // The frozen capability basis is the grant's own three fields. There is nowhere for a manifest
  // body — historical or fresh — to enter, so §11's answer is stable under Backend movement.
  assert.deepEqual(Object.keys(FROZEN.auditor_capability).sort(), [
    "enforcement",
    "requested",
    "source_runtime_manifest_hash",
  ]);
  const before = evaluateStageBoundaryDrift(observation());
  const after = evaluateStageBoundaryDrift(
    observation({}, {}),
  );
  assert.deepEqual(before, after);

  // And structurally: neither the read model nor the evaluator can name one.
  for (const file of ["drift-observation.ts", "stage-boundary-drift.ts"]) {
    const code = stripped(join(ROOT, "core/execution", file));
    for (const forbidden of [/RuntimeManifestBody/, /capability_enforcement/, /validateManifestSet/]) {
      assert.equal(forbidden.test(code), false, `${file} names ${forbidden}`);
    }
  }
});

test("canonical_head is MERGE_ONLY: observed here, acted on at the merge boundary", () => {
  const moved = { canonical_head: observed("moved-canonical-head") };
  assert.deepEqual(evaluateStageBoundaryDrift(observation(moved)), { kind: "CONTINUE" });
  assert.deepEqual(
    evaluateStageBoundaryDrift({
      ...observation(moved),
      boundary: "READY_TO_MERGE_TO_MERGING",
    }),
    { kind: "HOLD", target: "canonical_head" },
  );
});

// --- P: precedence -----------------------------------------------------------------------------------

test("P1 ~ P5: INVALIDATE > UNAVAILABLE > HOLD > CONTINUE, whatever order the facts arrive in", () => {
  const holding: Partial<DriftCurrentState> = {
    execution_policy: observed(MOVED_REF),
    auditor_stage: DISALLOWED_STAGE,
  };
  const unavailable: Partial<DriftCurrentState> = { contract_sources: UNAVAILABLE };
  const invalidating: Partial<DriftCurrentState> = { task_definition: ABSENT };
  const continuing: Partial<DriftCurrentState> = { project_profile: observed(MOVED_REF) };

  const kindOf = (...parts: Partial<DriftCurrentState>[]): DriftOutcome["kind"] =>
    evaluateStageBoundaryDrift(observation(Object.assign({}, ...parts))).kind;

  assert.equal(kindOf(holding, continuing), "HOLD", "P1");
  assert.equal(kindOf(unavailable, holding), "UNAVAILABLE", "P2");
  assert.equal(kindOf(invalidating, unavailable), "INVALIDATE", "P3");
  assert.equal(kindOf(invalidating, holding, continuing), "INVALIDATE", "P4");

  // P5 — the same facts, assembled in every order, always give the same answer. Key order is not
  // consulted: precedence walks the fixed target list.
  const permutations = [
    [invalidating, unavailable, holding, continuing],
    [continuing, holding, unavailable, invalidating],
    [holding, invalidating, continuing, unavailable],
    [unavailable, continuing, invalidating, holding],
  ];
  const results = permutations.map((parts) =>
    evaluateStageBoundaryDrift(observation(Object.assign({}, ...parts))),
  );
  for (const result of results) {
    assert.deepEqual(result, { kind: "INVALIDATE", target: "task_definition" });
  }
});

// --- O: observation assembly, through the real seams ---------------------------------------------

interface Assembled {
  readonly w: AuditingWorld;
  readonly contract: TaskContractV1Body;
  readonly compiled: CompiledProfileV1Body;
  readonly grant: CapabilityGrantV1Body;
}

function assembly(world: DomainWorld): Assembled {
  const w = auditingWorld(world);
  const attempt = world.store.attempts.require(w.attempt_key);
  const contract = world.store.contracts.get(attempt.contract_snapshot_id)
    ?.body as unknown as TaskContractV1Body;
  const compiled = world.store.batchView.compiledProfileFor(
    world.store.tasks.require(TASK_KEY).batch_id,
  );
  return {
    w,
    contract,
    compiled,
    grant: loadFrozenAuditorCapability(world.store, w.attempt_key, contract),
  };
}

const assemble = (input: Assembled): DriftObservationV1 =>
  assembleDriftObservation(input.w, {
    boundary: "VERIFYING_TO_AUDITING",
    attempt: input.w.store.attempts.require(input.w.attempt_key),
    contract: input.contract,
    compiled: input.compiled,
    auditor_grant: input.grant,
  });

test("O1 / O2: both Profile components are read as a ref and a body, and agree with the frozen ones", () => {
  withWorld((world) => {
    const input = assembly(world);
    const current = assemble(input).current;

    assert.deepEqual(current.project_profile, observed(input.compiled.project_profile), "O1");
    assert.deepEqual(current.execution_policy, observed(input.compiled.execution_policy), "O2");
    assert.equal(current.auditor_stage.status, "OBSERVED");
    assert.deepEqual(evaluateStageBoundaryDrift(assemble(input)), { kind: "CONTINUE" });
  });
});

test("O3 / O4: a selected pipeline or verification profile that is gone is ABSENT, not UNAVAILABLE", () => {
  withWorld((world) => {
    const input = assembly(world);
    const project = world.inputs.project;

    input.w.current.put(PROFILE_DOCUMENTS.project_profile_path, {
      ...project,
      version: 2,
      pipelines: { other: { steps: ["ACTOR", "VERIFY"] } },
      verification_profiles: { other: { adapter: "example-verifier", config: {} } },
    });

    const current = assemble(input).current;
    assert.equal(current.auditor_stage.status, "ABSENT", "O3");
    assert.equal(current.verification_profile.status, "ABSENT", "O4");
  });
});

test("O5 / O6 / O7: an operational read failure is UNAVAILABLE at exactly that target", () => {
  withWorld((world) => {
    const input = assembly(world);

    input.w.tasks.failure = new Error("the task source is down");
    assert.equal(assemble(input).current.task_definition.status, "UNAVAILABLE", "O5");
    input.w.tasks.failure = undefined;

    input.w.current.contractFailure = new Error("the source tree is unreadable");
    assert.equal(assemble(input).current.contract_sources.status, "UNAVAILABLE", "O6");
    input.w.current.contractFailure = undefined;

    input.w.repository.snapshot_canonical = () => {
      throw new Error("the repository is unreachable");
    };
    assert.equal(assemble(input).current.canonical_head.status, "UNAVAILABLE", "O7");
  });
});

test("O8: a task the source genuinely does not have is ABSENT, not an outage", () => {
  withWorld((world) => {
    const input = assembly(world);
    input.w.tasks.failure = new TaskSourceError("TASK_NOT_FOUND", "/task", "no such task");

    const current = assemble(input).current;
    assert.equal(current.task_definition.status, "ABSENT");
    assert.deepEqual(evaluateStageBoundaryDrift(assemble(input)), {
      kind: "INVALIDATE",
      target: "task_definition",
    });
  });
});

test("O9 / O10: the raw bytes decide, and nothing else about the file does", () => {
  withWorld((world) => {
    const input = assembly(world);
    const frozen = assemble(input).frozen.contract_sources;
    const path = frozen[0]?.path as string;

    // O10 — re-reading identical bytes is identical; no modification time or handle is consulted.
    input.w.current.bytes.set(path, new TextEncoder().encode("spec\n"));
    assert.deepEqual(assemble(input).current.contract_sources, observed([...frozen]));

    // O9 — one byte more (a trailing newline) is a different hash and therefore drift.
    input.w.current.bytes.set(path, new TextEncoder().encode("spec\n\n"));
    const changed = assemble(input).current.contract_sources;
    assert.equal(changed.status, "OBSERVED");
    assert.notEqual(
      changed.status === "OBSERVED" ? changed.value[0]?.content_hash : "",
      frozen[0]?.content_hash,
    );

    // A declared source that is gone is ABSENT — a successful observation.
    input.w.current.bytes.delete(path);
    assert.equal(assemble(input).current.contract_sources.status, "ABSENT");
  });
});

// --- C: the frozen capability basis -----------------------------------------------------------------

const withGrantRef = (
  contract: TaskContractV1Body,
  auditor: { grant_id?: string; grant_hash?: string },
  manifest_hash?: string,
): TaskContractV1Body => ({
  ...contract,
  capability_grants: {
    ...contract.capability_grants,
    auditor: { ...contract.capability_grants.auditor, ...auditor },
  },
  backend_requirements: {
    ...contract.backend_requirements,
    ...(manifest_hash === undefined ? {} : { runtime_manifest_hash: manifest_hash }),
  },
});

test("C1 / C6: the exactly-bound grant is the basis, and no Manifest body is needed for it", () => {
  withWorld((world) => {
    const input = assembly(world);
    assert.equal(input.grant.role, "AUDITOR");
    assert.equal(
      input.grant.source_runtime_manifest_hash,
      input.contract.backend_requirements.runtime_manifest_hash,
    );

    // C6 — the observation's frozen basis is the grant's own fields. No manifest body is stored,
    // and nothing resolves one from the hash.
    assert.deepEqual(assemble(input).frozen.auditor_capability, {
      source_runtime_manifest_hash: input.grant.source_runtime_manifest_hash,
      requested: input.grant.requested,
      enforcement: input.grant.enforcement,
    });
  });
});

test("C2 ~ C5: a grant that does not bind fails closed, with no transition", () => {
  withWorld((world) => {
    const input = assembly(world);
    const store = world.store;
    const before = store.decisions.read().length;
    const actor = input.contract.capability_grants.actor;

    const broken: readonly [string, TaskContractV1Body][] = [
      // C2 — the contract names a different envelope hash than the stored grant carries.
      ["C2", withGrantRef(input.contract, { grant_hash: `sha256:${"0".repeat(64)}` })],
      // C3 — a real grant of the wrong role is never usable as the Auditor's.
      ["C3", withGrantRef(input.contract, { grant_id: actor.grant_id, grant_hash: actor.grant_hash })],
      // C4 — the grant was issued against a different Backend manifest than the contract froze.
      ["C4", withGrantRef(input.contract, {}, `sha256:${"7".repeat(64)}`)],
      // C5 — the named grant is not there at all.
      ["C5", withGrantRef(input.contract, { grant_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0F09" })],
    ];

    for (const [label, contract] of broken) {
      assert.throws(
        () => loadFrozenAuditorCapability(store, input.w.attempt_key, contract),
        label,
      );
    }
    assert.equal(store.decisions.read().length, before, "no transition, no reason code");
    assert.equal(store.tasks.require(TASK_KEY).platform_state, "ACTIVE");
    assert.equal(
      TRANSITION_REASON_CODES.includes("DRIFT_CHECK_UNAVAILABLE"),
      true,
      "and this is deliberately not that code",
    );
  });
});

test("C7: §11 fact assembly queries no Backend manifest at all", () => {
  const assembler = stripped(join(ROOT, "core/execution/assemble-drift-observation.ts"));
  for (const forbidden of [
    /manifests/,
    /validateManifestSet/,
    /RuntimeManifestBody/,
    /deriveEnforcement/,
    /evaluateCapabilityRequirements\(/,
  ]) {
    assert.equal(forbidden.test(assembler), false, `the assembler names ${forbidden}`);
  }
  assert.match(assembler, /evaluateFrozenEnforcementRequirements/);
});

test("C8 ~ C11: accepted-set membership, with no ranking and no implicit acceptance", () => {
  const frozen = { ...ENFORCEMENT, "repository.read": "NOT_YET_AUDITED" } as CapabilityEnforcementMap;
  const check = (accepted: readonly string[], enforcement = ENFORCEMENT) =>
    evaluateFrozenEnforcementRequirements(REQUESTED, enforcement, {
      "repository.read": { accepted: accepted as never },
    }).compatible;

  assert.equal(check(["ENFORCED", "NOT_YET_AUDITED"]), true, "C8");
  assert.equal(check(["NOT_YET_AUDITED"]), false, "C9: no ranking rescues a stronger actual");
  assert.equal(check(["NOT_YET_AUDITED"], frozen), true, "C10: only when explicitly accepted");
  assert.equal(check(["ENFORCED"], frozen), false, "C10");
  assert.equal(
    evaluateFrozenEnforcementRequirements(REQUESTED, ENFORCEMENT, {}).compatible,
    true,
    "C11: an operation the policy does not constrain is compatible",
  );

  // One rule, one implementation: the Manifest-shaped entry point still exists and is untouched.
  assert.equal(typeof evaluateCapabilityRequirements, "function");
});

// --- L: lifecycle -------------------------------------------------------------------------------------

/** Makes the current world restrictive enough that the remaining Auditor stage is disallowed. */
function disallowAuditor(w: AuditingWorld, world: DomainWorld): void {
  w.current.put(PROFILE_DOCUMENTS.execution_policy_path, {
    ...world.inputs.policy,
    version: 2,
    capability_requirements: {
      auditor_execution: { "repository.read": { accepted: ["NOT_YET_AUDITED"] } },
    },
  });
}

test("L1: a boundary that continues reaches AUDITING through the existing launch", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    assert.equal(start(w).kind, "AUDITING");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "AUDITING");
    assert.equal(world.store.pendingDecisions.openFor(TASK_KEY).length, 0, "no decision was opened");
  });
});

test("R1 / L2: HOLD blocks on its CONTRACT_DECISION, and the drift cause stays queryable", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    disallowAuditor(w, world);
    const before = runtimeCalls(w);

    const outcome = start(w);
    assert.equal(outcome.kind, "DRIFT_HELD");
    assert.equal(outcome.kind === "DRIFT_HELD" ? outcome.target : "", "execution_policy");

    assert.equal(world.store.attempts.require(w.attempt_key).state, "VERIFYING");
    const task = world.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "HELD");
    // M1-12 — the current blocker is the decision, exactly as §17.2 requires of every TASK_ONLY
    // decision. The causal fact lives in the transition and in the decision's own provenance.
    assert.equal(task.state_reason?.code, `BLOCKED_BY_DECISION:${DRIFT_DECISION_ID}`);

    const open = world.store.pendingDecisions.openFor(TASK_KEY);
    assert.equal(open.length, 1);
    const decision = open[0]?.body as PendingDecisionV1;
    assert.equal(decision.category, "CONTRACT_DECISION");
    assert.equal(decision.blocking_scope, "TASK_ONLY");
    assert.deepEqual(driftCause(decision), {
      attempt_key: w.attempt_key,
      target: "execution_policy",
    });
    assert.deepEqual(runtimeCalls(w), before, "no Auditor Runtime call");
  });
});

test("R2 / L3: INVALIDATE blocks on its REATTEMPT_DECISION, with the cause on the Attempt", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    // The authoritative definition moved on; the frozen rule for that target invalidates.
    w.tasks.definition = taskDefinition({ version: "2" });
    const before = runtimeCalls(w);

    const outcome = start(w);
    assert.equal(outcome.kind, "DRIFT_INVALIDATED");
    assert.equal(outcome.kind === "DRIFT_INVALIDATED" ? outcome.target : "", "task_definition");

    const attempt = world.store.attempts.require(w.attempt_key);
    assert.equal(attempt.state, "INVALIDATED");
    assert.equal(attempt.state_reason?.code, "CONTRACT_DRIFT");
    const held = world.store.tasks.require(TASK_KEY);
    assert.equal(held.platform_state, "HELD");
    // §17.2 — a task parked on a decision is labelled by that decision; the §24 cause stays on
    // the attempt row and in the transition journal, which is where an invalidation records it.
    assert.equal(held.state_reason?.code, `BLOCKED_BY_DECISION:${DRIFT_DECISION_ID}`);

    const open = world.store.pendingDecisions.openFor(TASK_KEY);
    assert.equal(open.length, 1);
    const decision = open[0]?.body as PendingDecisionV1;
    assert.equal(decision.category, "REATTEMPT_DECISION");
    assert.equal(decision.subject.kind, "TASK");
    assert.equal(decision.blocking_scope, "TASK_ONLY");
    assert.deepEqual(decision.options, ["REATTEMPT_WITH_NEW_SNAPSHOT", "ABANDON"]);
    assert.deepEqual(driftCause(decision), {
      attempt_key: w.attempt_key,
      target: "task_definition",
    });
    assert.deepEqual(runtimeCalls(w), before, "no Auditor Runtime call");

    // Nothing was recompiled, rebuilt or restarted on the Platform's own initiative.
    assert.equal(world.store.attempts.current(TASK_KEY), undefined);
    assert.equal(world.store.contracts.get(attempt.contract_snapshot_id) !== undefined, true);
  });
});

test("L4: UNAVAILABLE holds under its own reason and opens no decision", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    delete w.current.documents[PROFILE_DOCUMENTS.execution_policy_path];
    const before = runtimeCalls(w);

    const outcome = start(w);
    assert.equal(outcome.kind, "DRIFT_CHECK_UNAVAILABLE");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "VERIFYING");
    assert.equal(world.store.tasks.require(TASK_KEY).state_reason?.code, "DRIFT_CHECK_UNAVAILABLE");
    assert.equal(world.store.pendingDecisions.openFor(TASK_KEY).length, 0);
    assert.deepEqual(runtimeCalls(w), before);
  });
});

test("L5: a second pass after a stop outcome opens nothing and launches nothing", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    disallowAuditor(w, world);
    assert.equal(start(w).kind, "DRIFT_HELD");
    const after = runtimeCalls(w);

    // The task is no longer ACTIVE, so the use-case refuses before doing anything at all.
    assert.throws(() => start(w, "01JQ8ZK5T7RC9V2W4X6Y8Z0D02"), /not ACTIVE/);
    assert.equal(world.store.pendingDecisions.openFor(TASK_KEY).length, 1);
    assert.deepEqual(runtimeCalls(w), after);
  });
});

test("L6: a stop-outcome transaction that fails rolls back completely and runs nothing", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    disallowAuditor(w, world);
    const before = runtimeCalls(w);

    // The same decision id already identifies a different decision, so the insert inside the
    // hold transaction fails. The hold, its journal entry and the decision go together.
    world.store.withTransaction(() => {
      world.store.pendingDecisions.open(
        buildContractDriftDecision({
          decision_id: DRIFT_DECISION_ID,
          task_key: TASK_KEY,
          attempt_key: w.attempt_key,
          target: "contract_source",
        }),
      );
    });

    assert.throws(() => start(w));
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "VERIFYING");
    assert.deepEqual(runtimeCalls(w), before, "no Runtime effect from a rolled-back stop");
  });
});

test("L7: canonical movement is observed at this boundary and changes nothing", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    const attempt = world.store.attempts.require(w.attempt_key);
    w.repository.head = "moved-canonical-head";

    assert.equal(start(w).kind, "AUDITING");
    const after = world.store.attempts.require(w.attempt_key);
    assert.equal(after.base_head, attempt.base_head, "no rebase, no change of base");
    assert.equal(after.candidate_commit, attempt.candidate_commit);
    assert.equal(
      w.repository.calls.some((call) => call.startsWith("prepare_merge")),
      false,
    );
  });
});

// --- A: production authority ---------------------------------------------------------------------------

const stripped = (file: string): string =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

test("A1 / A2: production assembles and evaluates; no drift outcome can be supplied to it", () => {
  const launch = stripped(join(ROOT, "core/execution/start-auditing.ts"));

  // A1 — the real pair, called on the production path.
  assert.match(launch, /evaluateStageBoundaryDrift\(\s*assembleDriftObservation\(/);

  // A2 — the old scriptable seam is gone, and nothing in the module accepts an outcome.
  for (const forbidden of [
    /\\bStageBoundaryDrift\\b/,
    /authorities\.drift/,
    /drift\s*:\s*\(\)/,
    /readonly drift\b/,
  ]) {
    assert.equal(forbidden.test(launch), false, `start-auditing still has ${forbidden}`);
  }
  // The authorities are the three read seams plus what B10 already had — no outcome among them.
  const authorities = launch.slice(
    launch.indexOf("export interface AuditingAuthorities {"),
  );
  const members = [...authorities.slice(0, authorities.indexOf("\n}")).matchAll(/readonly (\w+):/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(members, [
    "store",
    "repository",
    "runtime",
    "manifests",
    "profiles",
    "taskSource",
    "contractSources",
    "preflight",
  ]);
});

test("A3: the evaluator does no I/O and reaches nothing outside pure Core", () => {
  const file = join(ROOT, "core/execution/stage-boundary-drift.ts");
  const code = stripped(file);
  for (const forbidden of [
    /node:(fs|path|child_process|net|http|https|sqlite)/,
    /PlatformStore|store\./,
    /Adapter\b/,
    /ProfileSource|TaskSourceV1|ContractSourceReader/,
    /withTransaction|commitAttemptFact|pendingDecisions|idempotency/,
    /Date\.now|new Date\(|Math\.random/,
  ]) {
    assert.equal(forbidden.test(code), false, `the evaluator contains ${forbidden}`);
  }
  for (const specifier of [...readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)].map(
    (match) => match[1] as string,
  )) {
    assert.equal(
      specifier.startsWith("../schemas/") ||
        specifier.startsWith("../profile/") ||
        specifier.startsWith("./"),
      true,
      `${relative(ROOT, file)} imports ${specifier}`,
    );
  }
});

test("A4: a current Profile is observed, never adopted into the running Attempt", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    const project = world.inputs.project;
    // The current Profile would give the Auditor a different runtime profile. It does not.
    w.current.put(PROFILE_DOCUMENTS.project_profile_path, {
      ...project,
      version: 2,
      roles: {
        implementation: { runtime_profile: "standard", config: {} },
        review: { runtime_profile: "expanded-now", config: {} },
      },
    });

    assert.equal(start(w).kind, "AUDITING");
    assert.equal(
      w.runtime.spawns.at(-1)?.runtime_profile,
      world.profile.body.effective.project.roles["review"]?.runtime_profile,
      "the frozen resolution, not the current one",
    );
    assert.notEqual(w.runtime.spawns.at(-1)?.runtime_profile, "expanded-now");
  });
});

test("A5: the drift modules are the only new Core surface, and they add no durable table", () => {
  // The read seams are declared in Core and implemented outside it, like every other authority.
  const profileTypes = stripped(join(ROOT, "core/profile/types.ts"));
  assert.match(profileTypes, /export interface ProfileSource \{/);
  assert.equal(/readFileSync|node:fs|JSON\.parse/.test(profileTypes), false);

  const contractTypes = stripped(join(ROOT, "core/contract/types.ts"));
  assert.match(contractTypes, /export interface ContractSourceReader \{/);
  assert.equal(/readFileSync|node:fs/.test(contractTypes), false);

  for (const file of [
    "core/execution/drift-observation.ts",
    "core/execution/stage-boundary-drift.ts",
    "core/execution/assemble-drift-observation.ts",
  ]) {
    const code = stripped(join(ROOT, file));
    for (const forbidden of [
      /CREATE TABLE|INSERT INTO|UPDATE |DELETE FROM/,
      /drift_observation|contract_drift_table|drift_generation/,
      /audit_decide|auditor-turn:2|get_turn_result/,
    ]) {
      assert.equal(forbidden.test(code), false, `${file} contains ${forbidden}`);
    }
  }
});

// --- R: drift cause vs blocking reason (M1-12) --------------------------------------------------

/** The durable facts §17.2's STALE question is asked over. Read, never inferred. */
const basisFor = (world: DomainWorld, attempt_key: string): DriftDecisionBasis => {
  const current = world.store.attempts.current(TASK_KEY);
  return {
    source_attempt_state: world.store.attempts.get(attempt_key)?.state,
    newer_attempt_exists: current !== undefined && current.attempt_key !== attempt_key,
    task_terminal: isTerminalTask(world.store.tasks.require(TASK_KEY).platform_state),
  };
};

test("R3: HOLD and INVALIDATE block the task the same way, through the same helper", () => {
  const reasons = [
    withWorld((world) => {
      const w = auditingWorld(world);
      disallowAuditor(w, world);
      assert.equal(start(w).kind, "DRIFT_HELD");
      return world.store.tasks.require(TASK_KEY).state_reason?.code;
    }),
    withWorld((world) => {
      const w = auditingWorld(world);
      w.tasks.definition = taskDefinition({ version: "2" });
      assert.equal(start(w).kind, "DRIFT_INVALIDATED");
      return world.store.tasks.require(TASK_KEY).state_reason?.code;
    }),
  ];
  assert.deepEqual(reasons, [
    `BLOCKED_BY_DECISION:${DRIFT_DECISION_ID}`,
    `BLOCKED_BY_DECISION:${DRIFT_DECISION_ID}`,
  ]);

  // One implementation, not two: the drift-specific insertion path is gone, and the §17.2
  // representation is whatever `commitAttemptFact`'s `decision` field already does. M1-13 moved
  // that single implementation into its own module so B11's boundary shares it verbatim.
  const stopBody = stripped(join(ROOT, "core/execution/drift-lifecycle.ts"));
  assert.equal(/openPendingDecision/.test(stopBody), false, "the second insertion path is gone");
  assert.equal(/within:/.test(stopBody), false, "no decision is opened through `within`");
  assert.equal(
    (stopBody.match(/commitAttemptFact\(/g) ?? []).length,
    2,
    "one commit for UNAVAILABLE, one shared commit for HOLD and INVALIDATE",
  );
  // Exactly one of the two commits carries a decision, and it is the HOLD/INVALIDATE one.
  const commits = stopBody.split("commitAttemptFact(").slice(1);
  assert.equal(commits.length, 2);
  assert.equal(commits.filter((body) => /\n    decision,/.test(body)).length, 1);
  // And there is exactly one such implementation in the whole execution package.
  const execution = readdirSync(join(ROOT, "core/execution")).filter((n) => n.endsWith(".ts"));
  const implementations = execution.filter((name) =>
    /function applyDriftStop/.test(stripped(join(ROOT, "core/execution", name))),
  );
  assert.deepEqual(implementations, ["drift-lifecycle.ts"]);

  const commit = stripped(join(ROOT, "core/statemachine/transition-commit.ts"));
  assert.equal(
    (commit.match(/function openDecision\(/g) ?? []).length,
    1,
    "one place opens a decision",
  );
  assert.equal(/export function openPendingDecision/.test(commit), false);
});

test("R6: a REATTEMPT_DECISION is not stale merely because its source Attempt is INVALIDATED", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    w.tasks.definition = taskDefinition({ version: "2" });
    assert.equal(start(w).kind, "DRIFT_INVALIDATED");

    const basis = basisFor(world, w.attempt_key);
    assert.equal(basis.source_attempt_state, "INVALIDATED");
    assert.equal(
      driftDecisionRemainsValid("REATTEMPT_DECISION", basis),
      true,
      "the condition it exists to resolve is exactly the one that is true",
    );
    // The generic reading would have killed it on creation.
    assert.equal(driftDecisionRemainsValid("CONTRACT_DECISION", basis), false);
    assert.equal(world.store.pendingDecisions.require(DRIFT_DECISION_ID).body.status, "OPEN");
  });
});

test("R7: a later Attempt, or a terminal task, supersedes the open drift decision", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    w.tasks.definition = taskDefinition({ version: "2" });
    assert.equal(start(w).kind, "DRIFT_INVALIDATED");
    const invalidated = world.store.attempts.require(w.attempt_key);

    // A human resolution eventually starts Attempt N+1. From that moment the old question is
    // about a world that has moved on.
    world.store.withTransaction(() => {
      const built = contractBuild(world, { attempt: 2 })();
      world.store.contracts.put(built.contract);
      world.store.attempts.create({
        attempt_key: `attempt:${TASK_KEY}:2`,
        task_key: TASK_KEY,
        n: 2,
        contract_snapshot_id: built.contract.body.snapshot_id,
        base_head: invalidated.base_head,
      });
    });

    const basis = basisFor(world, w.attempt_key);
    assert.equal(basis.newer_attempt_exists, true);
    assert.equal(driftDecisionRemainsValid("REATTEMPT_DECISION", basis), false);
    assert.equal(
      driftDecisionRemainsValid("REATTEMPT_DECISION", {
        ...basis,
        newer_attempt_exists: false,
        task_terminal: true,
      }),
      false,
      "a terminal task closes the question too",
    );
    // A source Attempt whose row is gone leaves nothing to be valid about.
    assert.equal(
      driftDecisionRemainsValid("REATTEMPT_DECISION", {
        source_attempt_state: undefined,
        newer_attempt_exists: false,
        task_terminal: false,
      }),
      false,
    );
  });
});

test("R8: drift causality is read structurally — no free-form text is parsed", () => {
  withWorld((world) => {
    const w = auditingWorld(world);
    disallowAuditor(w, world);
    assert.equal(start(w).kind, "DRIFT_HELD");
    const decision = world.store.pendingDecisions.require(DRIFT_DECISION_ID).body;

    // Three structured sources, all typed: the category, the Core-owned provenance grammar, and
    // the transition entry that names the decision.
    assert.equal(decision.category, "CONTRACT_DECISION");
    assert.deepEqual(driftCause(decision), {
      attempt_key: w.attempt_key,
      target: "execution_policy",
    });
    const transitions = world.store.decisions
      .read()
      .filter((entry) => entry.kind === STATE_TRANSITION_KIND)
      .map((entry) => entry.payload as unknown as { pending_decision_id: string | null });
    assert.equal(
      transitions.some((payload) => payload.pending_decision_id === DRIFT_DECISION_ID),
      true,
    );

    // The human-facing text is never an input to any of that.
    const reader = stripped(join(ROOT, "core/humandecision/drift-decision.ts"));
    const cause = reader.slice(reader.indexOf("export function driftCause"));
    assert.equal(/question/.test(cause.slice(0, cause.indexOf("\n}"))), false);
    assert.equal(/new RegExp|\.match\(|\.test\(/.test(reader), false, "no regex over the record");

    // And a decision from another origin is simply not a drift decision, rather than mis-parsed.
    assert.equal(driftCause({ ...decision, created_from: "proposal:X" }), undefined);
  });
});
