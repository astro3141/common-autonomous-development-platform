/**
 * PR #43 independent-review findings — regressions and falsification controls.
 *
 * Each test reproduces the reviewed defect's exact scenario and pins the fail-closed answer the
 * Spec/TD determines. Finding numbers refer to the review at comment 5479029297 on PR #43.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";

import { FileReportAdapter } from "../adapters/file-report/index.ts";
import { recoverRun } from "../core/coordinator/production-recovery.ts";
import { monitorOnce } from "../core/coordinator/monitor.ts";
import { recordFinding, FindingError } from "../core/operability/index.ts";
import type { ManifestSetInput } from "../core/capability/manifest-set.ts";
import { compose, type Composition } from "../deployment/compose.ts";
import { openRun } from "../deployment/open-run.ts";
import { AUDITOR_VERDICT_PROTOCOL } from "./support/execution-fixtures.ts";
import { STATE_TRANSITION_KIND } from "../core/statemachine/transition-commit.ts";
import { BATCH_ID, discover, RUN_ID, TASK_KEY, withWorld } from "./support/domain-fixtures.ts";
import {
  auditorVerdict,
  auditorTurnResult,
  evidenceItem,
  REQUIRED_CHECK,
} from "./support/execution-fixtures.ts";
import {
  actorProduced,
  coordinatorWorld,
  mergeAnswer,
  submitSupervisorProposal,
  type CoordinatorWorld,
} from "./support/coordinator-fixtures.ts";
import { buildRoutingRecommendations } from "../core/operability/routing.ts";
import { pilotWorld, ScriptedGateway } from "./support/deployment-fixtures.ts";
import { createRequire } from "node:module";

const createRequireForTest = createRequire;

const CANDIDATE = "9a8b7c6d5e4f30211203344556677889900aabbc";
const SINGLE = { batch_policy: { max_tasks: 1, max_rework: 2, concurrency: 1 } };

// --- F5: malformed Manifest set fails CLOSED during recovery -------------------------------------

test("F5: an unreadable manifest set pauses the run, reports CAPABILITY_UNAVAILABLE, and blocks resume forever", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    w.tick();
    submitSupervisorProposal(w, world);
    w.tick();
    w.tick();

    const broken = { runtime: { garbage: true } } as unknown as ManifestSetInput;
    const report = recoverRun({ ...w, manifests: broken }, { run_id: RUN_ID });
    assert.notEqual(report.classification, "CONSISTENT", "never a clean bill");
    assert.equal(
      report.actions.some((action) => action.kind === "CAPABILITY_UNAVAILABLE"),
      true,
    );
    assert.equal(w.store.batches.require(BATCH_ID).status, "PAUSED_SAFELY");
    assert.equal(w.store.runs.require(RUN_ID).status, "PAUSED_SAFELY");

    // The falsification control that mattered: a SECOND pass must still not reconcile — the
    // paused state must never launder the unreadable manifests into CONSISTENT.
    const second = recoverRun({ ...w, manifests: broken }, { run_id: RUN_ID });
    assert.notEqual(second.classification, "CONSISTENT");
    assert.equal(
      second.actions.some((action) => action.kind === "CAPABILITY_UNAVAILABLE"),
      true,
    );
  }, SINGLE);
});

// --- F6: run discovery is store-authoritative ----------------------------------------------------

test("F6: a lost run pointer resumes the same run from the store — never a second active run", () => {
  const world = pilotWorld();
  let first: Composition | undefined;
  let second: Composition | undefined;
  try {
    first = compose(world.config, { runtime_gateway: new ScriptedGateway() });
    const opened = openRun(first);
    first.dispose();
    first = undefined;

    // Crash window: the bootstrap transaction committed, the pointer write was lost.
    rmSync(join(dirname(world.config.store_path), "current-run.json"), { force: true });

    second = compose(world.config, { runtime_gateway: new ScriptedGateway() });
    const reopened = openRun(second);
    assert.equal(reopened.run_id, opened.run_id, "the same run, recovered from the store");
    assert.equal(second.store.runs.activeForProject("pilot").length, 1, "exactly one active run");
  } finally {
    first?.dispose();
    second?.dispose();
    world.dispose();
  }
});

test("F6: a torn pointer file changes nothing — the store remains the discovery authority", () => {
  const world = pilotWorld();
  let first: Composition | undefined;
  let second: Composition | undefined;
  try {
    first = compose(world.config, { runtime_gateway: new ScriptedGateway() });
    const opened = openRun(first);
    first.dispose();
    first = undefined;

    const pointer = join(dirname(world.config.store_path), "current-run.json");
    appendFileSync(pointer, '{"run_id": "run:GARB'); // torn write

    second = compose(world.config, { runtime_gateway: new ScriptedGateway() });
    assert.equal(openRun(second).run_id, opened.run_id);
  } finally {
    first?.dispose();
    second?.dispose();
    world.dispose();
  }
});

// --- F7: injective file naming -------------------------------------------------------------------

test("F7: distinct op_keys never collide onto one notification identity", () => {
  const root = mkdtempSync(join(tmpdir(), "f7-"));
  try {
    const adapter = new FileReportAdapter(root);
    // The reviewed collision pair: "/" versus its literal escape.
    assert.equal(adapter.deliver({ op_key: "op:a/b", channel: "c", payload: { n: 1 } as never }).delivered, true);
    assert.equal(
      adapter.deliver({ op_key: "op:a_2f_b", channel: "c", payload: { n: 2 } as never }).delivered,
      true,
    );
    // Adversarial pairs that must all stay distinct (underscore forgery, unicode, dots).
    const pairs: readonly [string, string][] = [
      ["op:x_y", "op:x_5f_y"],
      ["op:α", "op:_3b1_"],
      ["op:a.b", "op:a_2e_b"],
    ];
    let n = 3;
    for (const [left, right] of pairs) {
      assert.equal(adapter.deliver({ op_key: left, channel: "c", payload: { n: n++ } as never }).delivered, true);
      assert.equal(adapter.deliver({ op_key: right, channel: "c", payload: { n: n++ } as never }).delivered, true);
    }
    const lines = readFileSync(join(root, "c.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 8, "every distinct op_key produced its own notification");
    const keys = new Set(lines.map((line) => (JSON.parse(line) as { op_key: string }).op_key));
    assert.equal(keys.size, 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- F8: exactly one consumer-visible line across the crash window -------------------------------

test("F8: a crash between the log line and the index yields exactly one line after retry", () => {
  const root = mkdtempSync(join(tmpdir(), "f8-"));
  try {
    const request = { op_key: "op:x:report:1", channel: "ops", payload: { n: 1 } as never };
    // Simulate the reviewed fault: the log line was fsynced, the crash hit before the index.
    mkdirSync(join(root, "delivered"), { recursive: true });
    appendFileSync(join(root, "ops.jsonl"), `${JSON.stringify(request)}\n`);

    const retry = new FileReportAdapter(root);
    assert.equal(retry.deliver(request).delivered, true);
    const lines = readFileSync(join(root, "ops.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "one logical notification (§21.1), not two");

    // And a replay after the successful retry is still one line.
    assert.equal(retry.deliver(request).delivered, true);
    assert.equal(readFileSync(join(root, "ops.jsonl"), "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- F11: Supervisor pacing is batch-scoped ------------------------------------------------------

test("F11: an unrelated validation entry does not answer this batch's outstanding turn", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");

    // A validation journaled for a different batch (same store, different context).
    world.store.decisions.append({
      kind: "decision_validation",
      refKey: "unrelated-proposal",
      payload: { batch_id: "batch:run:01JQ8ZK5T7RC9V2W4X6Y8Z0ZZ:1", result: "ACCEPTED" } as never,
    });
    // And a legacy entry with no batch context at all.
    world.store.decisions.append({
      kind: "decision_validation",
      refKey: "legacy",
      payload: { result: "ACCEPTED" } as never,
    });

    assert.equal(w.tick(), "SUPERVISOR_AWAITING_PROPOSAL", "the turn stays outstanding");
    assert.equal(w.runtime.sendCalls.length, 1, "no second turn was spent");

    // The batch's own answer unblocks it.
    submitSupervisorProposal(w, world);
    assert.equal(w.tick(), "ACTIVATED");
  }, { batch_policy: { max_tasks: 2, max_rework: 2, concurrency: 2 } });
});

// --- F12: monitoring observes the current rework turn --------------------------------------------

function driveToRework(world: Parameters<Parameters<typeof withWorld>[0]>[0]): CoordinatorWorld {
  const w = coordinatorWorld(world);
  w.tick();
  submitSupervisorProposal(w, world);
  w.tick();
  w.tick();
  actorProduced(w, CANDIDATE, 1);
  w.tick();
  const attempt = w.store.attempts.current(TASK_KEY)!;
  const hash = w.store.contracts.hashOf(attempt.contract_snapshot_id) as string;
  w.verification.completeWith([
    evidenceItem({ check_id: REQUIRED_CHECK, target_commit: CANDIDATE, task_contract_hash: hash }),
  ]);
  w.tick();
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
  w.runtime.turnResults.set(
    JSON.stringify(handle?.value),
    auditorTurnResult({
      body: auditorVerdict(review, { verdict: "FIX_REQUIRED" }),
      protocol: AUDITOR_VERDICT_PROTOCOL,
    }),
  );
  w.verification.settlement = { kind: "SETTLED" };
  w.tick(); // AUDIT_COMPLETED → REWORKING
  w.tick(); // REWORK_STARTED → IMPLEMENTING (turn 2 running, turn 1 terminal)
  return w;
}

test("F12: a terminal prior turn never produces EXTERNAL_COMPLETION_UNPROJECTED for the running rework turn", () => {
  withWorld((world) => {
    const w = driveToRework(world);
    assert.equal(w.store.attempts.current(TASK_KEY)?.state, "IMPLEMENTING");
    assert.equal(w.store.attempts.current(TASK_KEY)?.rework_count, 1);

    const negatives = monitorOnce(w, {
      run_id: RUN_ID,
      now: new Date(Date.now() + 1000).toISOString(),
      trigger_config: { stale_after_ms: 1e12, intent_unresolved_after_ms: 1e12, config_ref: "t" },
    });
    assert.equal(
      negatives.anomalies.some(
        (anomaly) => anomaly.anomaly_kind === "EXTERNAL_COMPLETION_UNPROJECTED",
      ),
      false,
      "negative control: the stale prior turn is history, not an anomaly",
    );

    // Positive control: the *current* turn completes unprojected → the anomaly appears.
    actorProduced(w, "1122334455667788990011223344556677889900", 2);
    const positives = monitorOnce(w, {
      run_id: RUN_ID,
      now: new Date(Date.now() + 1000).toISOString(),
      trigger_config: { stale_after_ms: 1e12, intent_unresolved_after_ms: 1e12, config_ref: "t" },
    });
    assert.equal(
      positives.anomalies.some(
        (anomaly) => anomaly.anomaly_kind === "EXTERNAL_COMPLETION_UNPROJECTED",
      ),
      true,
      "positive control: the current ordinal's completion is observed",
    );
  }, SINGLE);
});

// --- F18: transition evidence is the exact state_transition entry --------------------------------

test("F18: a Finding transition ref resolves only an actual state_transition at that seq", () => {
  withWorld((world) => {
    world.store.decisions.append({ kind: "unrelated_probe", refKey: "x", payload: {} as never });
    const finding = {
      finding_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0RG1",
      subject_ref: RUN_ID,
      classification: "BUG" as const,
      summary: "probe",
      evidence_refs: ["transition:1"],
      observation_refs: [],
      discovered_at: "t",
      classifier: "HUMAN" as const,
      classifier_ref: "probe",
      escaped_from: null,
      supersedes_finding_ref: null,
    };
    // seq 1 is `unrelated_probe` — it must not pass as transition evidence.
    assert.throws(() => recordFinding(world.store, finding), FindingError);

    // A real transition at a known seq resolves. Drive one admission to create it.
    const w = coordinatorWorld(world);
    w.tick();
    submitSupervisorProposal(w, world);
    const transition = world.store.decisions
      .read()
      .find((entry) => entry.kind === "state_transition");
    assert.notEqual(transition, undefined);
    const recorded = recordFinding(world.store, {
      ...finding,
      evidence_refs: [`transition:${transition!.seq}`],
    });
    assert.equal(recorded.replayed, false);
  }, SINGLE);
});

// --- F17 (companion): symlink fixture helper reused below in deployment tests --------------------
export const makeSymlink = (target: string, at: string): void => symlinkSync(target, at);

// --- F1: the production gateway validates the backend surface, fail-closed -----------------------

test("F1: a missing, unresolvable or unrecognized backend package fails before any side effect", async () => {
  const { BackendProductionGateway, GatewayUnavailable } = await import(
    "../adapters/backend-v1/index.ts"
  );
  const { writeFileSync } = await import("node:fs");
  const base = mkdtempSync(join(tmpdir(), "f1-"));
  try {
    const request = { op_key: "op:c", role: "SUPERVISOR", runtime_profile: "agent", cwd: base };

    // No install at all (RA-4 C3).
    const none = new BackendProductionGateway({
      core_dist_dir: base,
      agent_extension_dir: null,
      controller_agent_id: "controller",
      controller_cwd: base,
    });
    assert.throws(() => none.ensure_session(request), GatewayUnavailable);

    // A directory with no readable package.json.
    const bare = join(base, "bare");
    mkdirSync(bare);
    const unreadable = new BackendProductionGateway({
      core_dist_dir: base,
      agent_extension_dir: bare,
      controller_agent_id: "controller",
      controller_cwd: base,
    });
    assert.throws(() => unreadable.ensure_session(request), GatewayUnavailable);

    // A package whose entry loads but exposes no AcpRuntime surface.
    const wrong = join(base, "wrong");
    mkdirSync(wrong);
    writeFileSync(join(wrong, "package.json"), JSON.stringify({ name: "wrong", main: "index.cjs" }));
    writeFileSync(join(wrong, "index.cjs"), "module.exports = { somethingElse: true };\n");
    const unrecognized = new BackendProductionGateway({
      core_dist_dir: base,
      agent_extension_dir: wrong,
      controller_agent_id: "controller",
      controller_cwd: base,
    });
    assert.throws(() => unrecognized.ensure_session(request), /audited AcpRuntime surface/);

    // The audited reality: an async ensureSession is refused BEFORE any call is made.
    const asyncPkg = join(base, "async");
    mkdirSync(asyncPkg);
    writeFileSync(join(asyncPkg, "package.json"), JSON.stringify({ name: "a", main: "index.cjs" }));
    writeFileSync(
      join(asyncPkg, "index.cjs"),
      `let calls = 0;
module.exports = {
  AcpRuntime: {
    ensureSession: async () => { calls += 1; return { agentId: "a", sessionId: "s" }; },
    startTurn: () => ({ result: Promise.resolve({ status: "completed" }) }),
  },
  calls: () => calls,
};\n`,
    );
    const asyncGateway = new BackendProductionGateway({
      core_dist_dir: base,
      agent_extension_dir: asyncPkg,
      controller_agent_id: "controller",
      controller_cwd: base,
      derive_session_input: () => ({ trusted_input: "derived-by-deployment", agent: "agent" }),
    });
    assert.throws(() => asyncGateway.ensure_session(request), /asynchronous/);
    const probe = createRequireForTest(join(asyncPkg, "package.json"))(join(asyncPkg, "index.cjs")) as {
      calls: () => number;
    };
    assert.equal(probe.calls(), 0, "the async API was refused before any call — zero side effects");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("F1: without a deployment-owned trusted-input derivation, every session path refuses (I-TD5)", async () => {
  const { BackendProductionGateway } = await import("../adapters/backend-v1/index.ts");
  const { writeFileSync } = await import("node:fs");
  const base = mkdtempSync(join(tmpdir(), "f1b-"));
  try {
    const pkg = join(base, "pkg");
    mkdirSync(pkg);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "p", main: "index.cjs" }));
    writeFileSync(
      join(pkg, "index.cjs"),
      `let calls = 0;
module.exports = {
  AcpRuntime: {
    ensureSession: (input) => { calls += 1; return { agentId: input.agent, sessionId: "s-1" }; },
    startTurn: () => ({ result: Promise.resolve({ status: "completed" }) }),
  },
  calls: () => calls,
};\n`,
    );
    const gateway = new BackendProductionGateway({
      core_dist_dir: base,
      agent_extension_dir: pkg,
      controller_agent_id: "controller",
      controller_cwd: base,
    });
    assert.throws(
      () =>
        gateway.ensure_session({ op_key: "op:c", role: "ACTOR", runtime_profile: "agent", cwd: base }),
      /host owns session identity/,
    );
    const probe = createRequireForTest(join(pkg, "package.json"))(join(pkg, "index.cjs")) as {
      calls: () => number;
    };
    assert.equal(probe.calls(), 0, "refused before the call");

    // With a derivation and a conforming sync API, the session resolves through the real shape.
    const configured = new BackendProductionGateway({
      core_dist_dir: base,
      agent_extension_dir: pkg,
      controller_agent_id: "controller",
      controller_cwd: base,
      derive_session_input: (request) => ({ trusted_input: "host-derived", agent: request.runtime_profile }),
    });
    const ref = configured.ensure_session({
      op_key: "op:c",
      role: "ACTOR",
      runtime_profile: "agent",
      cwd: base,
    });
    assert.deepEqual(ref, { agent_id: "agent", session_id: "s-1" });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// --- F2: Runtime→Workflow controller propagation is one handle, not two --------------------------

test("F2: the workflow adapter accepts exactly the runtime adapter's controller handle", async () => {
  const { compose } = await import("../deployment/compose.ts");
  const world = pilotWorld();
  let composition: Composition | undefined;
  try {
    const gateway = new ScriptedGateway();
    composition = compose(world.config, { runtime_gateway: gateway });
    const { runtime } = composition.deps;
    const workflow = (composition.deps.verification as unknown as {
      // reach the composed workflow adapter through the verification stack is not public surface;
      // compose wires the same instance into `verification`, so exercise it directly instead:
    });
    void workflow;

    // Re-create the exact production pair to exercise the wiring contract directly.
    const { BackendWorkflowAdapter } = await import("../adapters/backend-v1/index.ts");
    const calls: Record<string, unknown>[] = [];
    const transport = {
      invoke(request: Readonly<Record<string, unknown>>): unknown {
        calls.push({ ...request });
        return { workflowId: "wf-1" };
      },
    };
    const adapter = new BackendWorkflowAdapter({
      transport,
      controller_binding: () =>
        runtime.acquire_workflow_controller() as unknown as Record<string, never>,
    });

    // The controller the Runtime actually issues is accepted...
    const controller = runtime.acquire_workflow_controller();
    const handle = adapter.start(controller, { request_id: "op:x" } as never);
    assert.equal(calls.length, 1, "the accepted start reached the wire once");

    // ...and a fabricated handle — including the previously hard-coded stand-in — is refused
    // with ZERO wire calls (the reviewed negative control).
    const before = calls.length;
    assert.throws(
      () =>
        adapter.audit_decide(
          {
            controller_agent_id: "platform-controller",
            controller_session_id: "managed",
          } as never,
          handle,
          "PASS",
          [],
        ),
      /does not speak as/,
    );
    assert.equal(calls.length, before, "the refused controller produced zero wire calls");
  } finally {
    composition?.dispose();
    world.dispose();
  }
});

// --- F17: I-TD6 path separation is enforced before any directory exists --------------------------

test("F17: a result channel equal to, inside, or symlink-aliasing the repository is refused before mkdir", async () => {
  const { compose } = await import("../deployment/compose.ts");
  const { ConfigError } = await import("../deployment/config.ts");
  const world = pilotWorld();
  try {
    const attempt = (result_channel_root: string): void => {
      const config = { ...world.config, result_channel_root };
      assert.throws(() => compose(config, { runtime_gateway: new ScriptedGateway() }), ConfigError);
    };
    // Equal to the repository root.
    attempt(world.config.repository.root);
    // Inside the repository.
    attempt(join(world.config.repository.root, "result-channel"));
    // Inside the workspace root.
    attempt(join(world.config.repository.workspace_root, "channel"));
    // Containing the repository (the repository inside the channel).
    attempt(dirname(world.config.repository.root));
    // A symlink alias whose target is the repository.
    mkdirSync(dirname(world.config.store_path), { recursive: true });
    const alias = join(dirname(world.config.store_path), "alias-link");
    makeSymlink(world.config.repository.root, alias);
    attempt(alias);

    // A genuinely disjoint path passes (the pilot default).
    const fine = compose(world.config, { runtime_gateway: new ScriptedGateway() });
    fine.dispose();
  } finally {
    world.dispose();
  }
});

// --- F14: production refuses a v1 Project Profile ------------------------------------------------

test("F14: a v1 project profile (no supervisor binding) refuses to compose — no store, no run, no INTENT", async () => {
  const { compose } = await import("../deployment/compose.ts");
  const { ConfigError } = await import("../deployment/config.ts");
  const { writeFileSync, existsSync } = await import("node:fs");
  const { pilotProjectProfile } = await import("./support/deployment-fixtures.ts");
  const world = pilotWorld();
  try {
    const v1 = { ...pilotProjectProfile() } as Record<string, unknown>;
    delete v1["supervisor_profile"];
    writeFileSync(world.config.profiles.project_profile_path, JSON.stringify(v1));

    assert.throws(
      () => compose(world.config, { runtime_gateway: new ScriptedGateway() }),
      ConfigError,
    );
    assert.equal(existsSync(world.config.store_path), false, "no store was even created");
  } finally {
    world.dispose();
  }
});

// --- F3: startup runs §22.2 reconciliation before anything else ----------------------------------

test("F3: bootRun reconciles a persisted mid-flight run before any tick can start an external op", async () => {
  const { bootRun } = await import("../deployment/boot.ts");
  const { backendV1Manifests } = await import("../deployment/manifests.ts");
  const { CAPABILITY_NAMES } = await import("../core/schemas/capability-vocabulary.ts");
  const { submitProposal } = await import("../core/admission/submit-proposal.ts");
  const { ulid } = await import("../deployment/identities.ts");
  const {
    PILOT_TASK_REF,
    PILOT_CLASSIFICATION,
    PILOT_PIPELINE,
    PILOT_ACTOR_PROFILE,
    PILOT_VERIFICATION_PROFILE,
    PILOT_SCOPE,
  } = await import("./support/deployment-fixtures.ts");

  // The frozen policy demands ENFORCED shell; the first composition's backend claims it.
  const world = pilotWorld({
    capability_requirements: {
      actor_execution: { "shell.execute": { accepted: ["ENFORCED"] } },
      auditor_execution: {
        "repository.read": { accepted: ["ENFORCED", "AVAILABLE_WITH_REDUCED_ASSURANCE", "NOT_YET_AUDITED"] },
      },
    },
  });
  const gateway = new ScriptedGateway();
  const strong = backendV1Manifests({ backend_instance_id: "audited-host" }) as {
    runtime: { body: Record<string, unknown> };
    workflow: unknown;
    repository: unknown;
    verification: unknown;
  };
  const enforced: Record<string, { allow: string; deny: string }> = {};
  for (const name of CAPABILITY_NAMES) enforced[name] = { allow: "ENFORCED", deny: "ENFORCED" };
  strong.runtime = { ...strong.runtime, body: { ...strong.runtime.body, capability_enforcement: enforced } };

  let first: Composition | undefined;
  let second: Composition | undefined;
  try {
    first = compose(world.config, {
      runtime_gateway: gateway,
      manifests: strong as never,
      preflight: () => ({ status: "READY" }),
    });
    const opened = openRun(first);
    first.coordinator.tickOnce(opened.run_id); // SUPERVISOR_REQUESTED
    const definition = first.deps.taskSource.get_task(PILOT_TASK_REF);
    const head = first.deps.repository.snapshot_canonical().head;
    submitProposal(
      { store: first.store, taskSource: first.deps.taskSource, repository: first.deps.repository, manifests: first.deps.manifests },
      {
        run_id: opened.run_id,
        batch_id: opened.batch_id,
        observed_at: new Date().toISOString(),
        proposal: {
          proposal_id: ulid(),
          decision: "START_TASK",
          task_ref: PILOT_TASK_REF,
          classification: PILOT_CLASSIFICATION,
          pipeline_id: PILOT_PIPELINE,
          actor_profile: PILOT_ACTOR_PROFILE,
          verification_profile: PILOT_VERIFICATION_PROFILE,
          repository_scope_id: PILOT_SCOPE,
          expected: {
            task_version: definition.version,
            task_definition_hash: definition.definition_hash,
            base_head: head,
            compiled_profile_hash: first.compiled.compiled_hash,
          },
          reason_refs: [],
        },
      },
    );
    first.coordinator.tickOnce(opened.run_id); // ACTIVATED
    first.coordinator.tickOnce(opened.run_id); // IMPLEMENTATION_STARTED (mid-flight)
    first.dispose();
    first = undefined;

    // Restart with the honest Backend v1 (shell NOT_YET_AUDITED — weaker than the frozen policy).
    second = compose(world.config, {
      runtime_gateway: gateway,
      preflight: () => ({ status: "READY" }),
    });
    const boot = bootRun(second);
    assert.equal(boot.opened.run_id, opened.run_id);
    assert.equal(boot.report.classification, "EXPLAINABLE");
    assert.equal(
      boot.report.actions.some((action) => action.kind === "CAPABILITY_HELD"),
      true,
      "the weakened backend was fail-closed by reconciliation, before any tick",
    );
    const task = second.store.tasks.require("task:pilot:T-1");
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.state_reason?.code, "CAPABILITY_BOUNDARY_CHANGED");
    // The first tick after boot starts nothing external for this task.
    assert.equal(gateway.turns.length, 2, "supervisor + actor turns from before the restart only");
    second.coordinator.tickOnce(opened.run_id);
    assert.equal(gateway.turns.length, 2, "no new external turn after the fail-closed boot");
  } finally {
    first?.dispose();
    second?.dispose();
    world.dispose();
  }
});

// --- F4: full-width reconciliation over the authoritative owners ---------------------------------

test("F4: a lost runtime session with a surviving valid candidate catches up to VERIFYING (§22.3 R-1)", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    w.tick();
    submitSupervisorProposal(w, world);
    w.tick();
    w.tick(); // IMPLEMENTING
    const attempt = w.store.attempts.current(TASK_KEY)!;

    // The runtime reports the session as gone; the repository still holds the candidate.
    w.repository.candidate = CANDIDATE;
    const stored = w.store.adapterMetadata.get(attempt.attempt_key, "runtime", "actor_turn:1");
    w.runtime.turnResults.set(JSON.stringify(stored?.value), {
      session_handle: {} as never,
      turn_handle: stored?.value as never,
      backend_status: "SESSION_LOST",
      termination_reason: "gateway restarted",
      started_at: "t1",
      completed_at: "t2",
      provenance: { runtime_backend: "fake", identity_authority: "BACKEND", result_channel: "TURN_TEXT" },
    });

    const report = recoverRun(w, { run_id: RUN_ID });
    assert.equal(report.classification, "EXPLAINABLE");
    assert.equal(
      report.actions.some((action) => action.kind === "TURN_LOSS_CAUGHT_UP"),
      true,
    );
    assert.equal(w.store.attempts.current(TASK_KEY)?.state, "VERIFYING");
    assert.equal(w.store.attempts.current(TASK_KEY)?.candidate_commit, CANDIDATE);

    // Second-pass idempotency: the caught-up world reconciles clean.
    const second = recoverRun(w, { run_id: RUN_ID });
    assert.deepEqual(second.classification, "CONSISTENT");
  }, SINGLE);
});

test("F4: a lost session with no usable candidate reworks through the sealed rejection branch", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    w.tick();
    submitSupervisorProposal(w, world);
    w.tick();
    w.tick();
    const attempt = w.store.attempts.current(TASK_KEY)!;
    w.repository.candidate = null; // nothing was produced
    const stored = w.store.adapterMetadata.get(attempt.attempt_key, "runtime", "actor_turn:1");
    w.runtime.turnResults.set(JSON.stringify(stored?.value), {
      session_handle: {} as never,
      turn_handle: stored?.value as never,
      backend_status: "RUNTIME_ERROR",
      termination_reason: "runtime died",
      started_at: "t1",
      completed_at: "t2",
      provenance: { runtime_backend: "fake", identity_authority: "BACKEND", result_channel: "TURN_TEXT" },
    });

    const report = recoverRun(w, { run_id: RUN_ID });
    assert.equal(
      report.actions.some((action) => action.kind === "TURN_LOSS_CAUGHT_UP"),
      true,
    );
    assert.equal(w.store.attempts.current(TASK_KEY)?.state, "REWORKING", "rework budget remains");
  }, SINGLE);
});

test("F4: an unanswerable verification authority fail-closes the attempt (owner-unavailable rule)", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    w.tick();
    submitSupervisorProposal(w, world);
    w.tick();
    w.tick();
    actorProduced(w, CANDIDATE, 1);
    w.tick(); // VERIFYING

    const broken = {
      ...w,
      verification: new Proxy(w.verification, {
        get(target, property) {
          if (property === "get_verification_result") {
            return () => {
              throw new Error("verification backend unreachable");
            };
          }
          return Reflect.get(target, property);
        },
      }),
    };
    const report = recoverRun(broken as never, { run_id: RUN_ID });
    assert.equal(
      report.actions.some((action) => action.kind === "ATTEMPT_HELD_RECOVERY_CONFLICT"),
      true,
    );
    const task = w.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.state_reason?.code, "RECOVERY_CONFLICT");
  }, SINGLE);
});

test("F4: a READY attempt with an indeterminate actor-turn INTENT fail-closes, never resends", async () => {
  const { actorTurnOp } = await import("../core/execution/actor-operations.ts");
  await withWorld(async (world) => {
    const w = coordinatorWorld(world);
    w.tick();
    submitSupervisorProposal(w, world);
    w.tick(); // ACTIVATED → READY
    const attempt = w.store.attempts.current(TASK_KEY)!;
    // The reviewed crash window: the turn INTENT is durable, the call's outcome is unknown.
    w.store.idempotency.beginIntent(actorTurnOp(attempt.attempt_key, 1));

    const sends = w.runtime.sendCalls.length;
    const report = recoverRun(w, { run_id: RUN_ID });
    assert.equal(
      report.actions.some((action) => action.kind === "ATTEMPT_HELD_RECOVERY_CONFLICT"),
      true,
    );
    assert.equal(w.store.tasks.require(TASK_KEY).state_reason?.code, "RECOVERY_CONFLICT");
    assert.equal(w.runtime.sendCalls.length, sends, "the indeterminate turn was never resent");
  }, SINGLE);
});

test("F4: an unanswerable repository under MERGING stops the batch (canonical-mutation rule)", async () => {
  const { commitAttemptFact } = await import("../core/statemachine/transition-commit.ts");
  withWorld((world) => {
    const w = coordinatorWorld(world);
    // Fabricate the narrow durable state directly at the state machine: MERGING with a repository
    // that cannot answer. (The full auto-merge drive is proven in b14; this isolates §22.2.)
    w.tick();
    submitSupervisorProposal(w, world);
    w.tick();
    w.tick();
    actorProduced(w, CANDIDATE, 1);
    w.tick(); // VERIFYING
    const attempt = w.store.attempts.current(TASK_KEY)!;
    // VERIFYING → ... → MERGING is a long drive; enter MERGING through the sealed guard chain.
    const hash = w.store.contracts.hashOf(attempt.contract_snapshot_id) as string;
    w.verification.completeWith([
      evidenceItem({ check_id: REQUIRED_CHECK, target_commit: CANDIDATE, task_contract_hash: hash }),
    ]);
    w.tick(); // AUDIT_STARTED
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
    w.runtime.turnResults.set(
      JSON.stringify(handle?.value),
      auditorTurnResult({ body: auditorVerdict(review), protocol: AUDITOR_VERDICT_PROTOCOL }),
    );
    w.verification.settlement = { kind: "SETTLED" };
    w.tick(); // AUDIT_COMPLETED → READY_TO_MERGE
    commitAttemptFact(w.store, {
      attempt_key: attempt.attempt_key,
      fact: { kind: "AUTOMATIC_MERGE_STARTED", gate_preconditions_met: true },
    });
    assert.equal(w.store.attempts.current(TASK_KEY)?.state, "MERGING");

    const broken = {
      ...w,
      repository: new Proxy(w.repository, {
        get(target, property) {
          if (property === "snapshot_canonical") {
            return () => {
              throw new Error("repository unreachable");
            };
          }
          return Reflect.get(target, property);
        },
      }),
    };
    const report = recoverRun(broken as never, { run_id: RUN_ID });
    assert.equal(
      report.actions.some((action) => action.kind === "CANONICAL_PAUSED"),
      true,
    );
    assert.equal(w.store.batches.require(BATCH_ID).status, "PAUSED_SAFELY");
    assert.equal(w.store.runs.require(RUN_ID).status, "PAUSED_SAFELY");
  }, SINGLE);
});

test("F4: external CLOSED under an open decision goes STALE and parks the task (§22.3 row 4)", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    w.tick();
    submitSupervisorProposal(w, world);
    w.tick();
    w.tick();
    actorProduced(w, CANDIDATE, 1);
    w.tick();
    const attempt = w.store.attempts.current(TASK_KEY)!;
    const hash = w.store.contracts.hashOf(attempt.contract_snapshot_id) as string;
    w.verification.completeWith([
      evidenceItem({ check_id: REQUIRED_CHECK, target_commit: CANDIDATE, task_contract_hash: hash }),
    ]);
    w.tick();
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
    w.runtime.turnResults.set(
      JSON.stringify(handle?.value),
      auditorTurnResult({ body: auditorVerdict(review), protocol: AUDITOR_VERDICT_PROTOCOL }),
    );
    w.verification.settlement = { kind: "SETTLED" };
    w.tick(); // READY_TO_MERGE
    w.tick(); // MERGE_APPROVAL_OPENED — an open human decision now exists
    const open = w.store.pendingDecisions.openFor(TASK_KEY);
    assert.equal(open.length, 1);

    // The authoritative external source closed the task while the question was open.
    w.tasks.externalStates["T-101"] = "CLOSED";
    const report = recoverRun(w, { run_id: RUN_ID });
    assert.equal(
      report.actions.some((action) => action.kind === "EXTERNAL_CLOSED_HELD"),
      true,
    );
    assert.equal(
      w.store.pendingDecisions.require(open[0]!.body.decision_id).body.status,
      "STALE",
    );
    const task = w.store.tasks.require(TASK_KEY);
    assert.equal(task.platform_state, "HELD");
    assert.equal(task.state_reason?.code, "EXTERNAL_CLOSED");
    // One idempotent STALE notification was enqueued.
    assert.equal(
      w.store.outbox
        .pending()
        .some((row) => row.op_key.includes(`report-stale:${open[0]!.body.decision_id}`)),
      true,
    );
  }, SINGLE);
});

// --- F10: "safe independent runnable" is a judgement, not a row count ----------------------------

/** Drives the single fixture task to an open merge approval, then into §20.1 WAITING. */
function driveToApprovalWaiting(world: Parameters<Parameters<typeof withWorld>[0]>[0]): CoordinatorWorld {
  const w = coordinatorWorld(world);
  assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
  submitSupervisorProposal(w, world);
  assert.equal(w.tick(), "ACTIVATED");
  assert.equal(w.tick(), "IMPLEMENTATION_STARTED");
  actorProduced(w, CANDIDATE, 1);
  assert.equal(w.tick(), "VERIFICATION_STARTED");
  const attempt = w.store.attempts.current(TASK_KEY)!;
  const hash = w.store.contracts.hashOf(attempt.contract_snapshot_id) as string;
  w.verification.completeWith([
    evidenceItem({ check_id: REQUIRED_CHECK, target_commit: CANDIDATE, task_contract_hash: hash }),
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
  w.runtime.turnResults.set(
    JSON.stringify(handle?.value),
    auditorTurnResult({ body: auditorVerdict(review), protocol: AUDITOR_VERDICT_PROTOCOL }),
  );
  w.verification.settlement = { kind: "SETTLED" };
  assert.equal(w.tick(), "AUDIT_COMPLETED");
  assert.equal(w.tick(), "MERGE_APPROVAL_OPENED");
  assert.equal(w.tick(), "BATCH_WAITING");
  assert.equal(w.store.batches.require(BATCH_ID).status, "WAITING");
  return w;
}

const TWO_TASKS = { batch_policy: { max_tasks: 2, max_rework: 2, concurrency: 1 } };

test("F10: a DISCOVERED row with a blocked HARD dependency never resumes a WAITING batch", () => {
  withWorld((world) => {
    const w = driveToApprovalWaiting(world);

    // A second candidate appears mid-WAITING — but its HARD dependency is externally open.
    discover(world, "task-b");
    w.tasks.dependencies = [
      { task_ref: "task-b", depends_on_ref: "task-dep", kind: "HARD" },
    ];
    w.tasks.externalStates["task-dep"] = "READY";

    // The pre-fix judgement was "a DISCOVERED row exists" — which would resume here.
    assert.notEqual(w.tick(), "BATCH_RESUMED");
    assert.equal(w.store.batches.require(BATCH_ID).status, "WAITING");

    // Falsification (fail-closed): the dependency is CLOSED but the TaskSource cannot answer —
    // an unanswerable authority never clears a dependency (§8.4a).
    w.tasks.externalStates["task-dep"] = "CLOSED";
    w.tasks.stateFailure = new Error("task source unreachable");
    assert.notEqual(w.tick(), "BATCH_RESUMED");
    assert.equal(w.store.batches.require(BATCH_ID).status, "WAITING");

    // The authority answers and the dependency is genuinely satisfied → the batch resumes.
    w.tasks.stateFailure = undefined;
    assert.equal(w.tick(), "BATCH_RESUMED");
    assert.equal(w.store.batches.require(BATCH_ID).status, "RUNNING");
  }, TWO_TASKS);
});

// --- F13: §22.5 signal vocabulary, keyed thresholds and coverage honesty -------------------------

test("F13: staleness thresholds resolve pipeline:state → state → default, with provenance", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    submitSupervisorProposal(w, world);
    assert.equal(w.tick(), "ACTIVATED");
    assert.equal(w.tick(), "IMPLEMENTATION_STARTED");
    const pipeline = w.store.tasks.require(TASK_KEY).pipeline_id as string;
    const later = new Date(Date.now() + 1000).toISOString();

    // Most specific key wins: the pipeline:state override fires despite lax broader levels.
    const specific = monitorOnce(w, {
      run_id: RUN_ID,
      now: later,
      trigger_config: {
        stale_after_ms: 1e12,
        stale_after_ms_by_state: { IMPLEMENTING: 1e12 },
        stale_after_ms_by_pipeline_state: { [`${pipeline}:IMPLEMENTING`]: 0 },
        intent_unresolved_after_ms: 1e12,
        config_ref: "t",
      },
    });
    const stale = specific.anomalies.find((a) => a.anomaly_kind === "DURABLE_PROGRESS_STALE");
    assert.notEqual(stale, undefined);
    assert.equal(stale?.threshold_ref, `t#by_pipeline_state[${pipeline}:IMPLEMENTING]`);

    // The state key shields against a pre-fix flat default: default 0 alone must NOT fire here.
    const shielded = monitorOnce(w, {
      run_id: RUN_ID,
      now: later,
      trigger_config: {
        stale_after_ms: 0,
        stale_after_ms_by_state: { IMPLEMENTING: 1e12 },
        intent_unresolved_after_ms: 1e12,
        config_ref: "t",
      },
    });
    assert.equal(
      shielded.anomalies.some((a) => a.anomaly_kind === "DURABLE_PROGRESS_STALE"),
      false,
      "a per-state threshold overrides the default",
    );

    // No override at all → the default fires and says so.
    const fallback = monitorOnce(w, {
      run_id: RUN_ID,
      now: later,
      trigger_config: { stale_after_ms: 0, intent_unresolved_after_ms: 1e12, config_ref: "t" },
    });
    const viaDefault = fallback.anomalies.find((a) => a.anomaly_kind === "DURABLE_PROGRESS_STALE");
    assert.equal(viaDefault?.threshold_ref, "t#default");
  }, SINGLE, { now: () => new Date().toISOString() });
});

test("F13: an unanswerable repository degrades coverage — it never kills the packet and never claims divergence", () => {
  withWorld((world) => {
    const w = driveToApprovalWaiting(world);
    const report = monitorOnce(
      {
        store: w.store,
        runtime: w.runtime,
        repository: {
          snapshot_canonical() {
            throw new Error("repository unavailable");
          },
        } as never,
      },
      {
        run_id: RUN_ID,
        now: "2026-08-31T00:00:00Z",
        trigger_config: { stale_after_ms: 1e12, intent_unresolved_after_ms: 1e12, config_ref: "t" },
      },
    );
    assert.equal(report.authority_coverage.repository, "UNAVAILABLE");
    assert.equal(report.authority_coverage.store, "AVAILABLE");
    assert.equal(
      report.anomalies.some((a) => a.anomaly_kind === "TERMINAL_DIVERGENCE"),
      false,
      "absence of an answer is never a confident claim (§22.5)",
    );
  }, TWO_TASKS);
});

test("F13: a candidate already in canonical history while the Platform still awaits approval is TERMINAL_DIVERGENCE", () => {
  withWorld((world) => {
    const w = driveToApprovalWaiting(world);

    // Negative control: canonical does not contain the candidate → no divergence.
    w.repository.head = "0000000000000000000000000000000000000000";
    w.repository.lineageValid = false;
    const clean = monitorOnce(w, {
      run_id: RUN_ID,
      now: "2026-08-31T00:00:00Z",
      trigger_config: { stale_after_ms: 1e12, intent_unresolved_after_ms: 1e12, config_ref: "t" },
    });
    assert.equal(clean.anomalies.some((a) => a.anomaly_kind === "TERMINAL_DIVERGENCE"), false);

    // The candidate reached canonical outside the Platform → observed, and only observed.
    w.repository.head = CANDIDATE;
    const attempt = w.store.attempts.current(TASK_KEY)!;
    const before = w.store.decisions.count();
    const diverged = monitorOnce(w, {
      run_id: RUN_ID,
      now: "2026-08-31T00:00:00Z",
      trigger_config: { stale_after_ms: 1e12, intent_unresolved_after_ms: 1e12, config_ref: "t" },
    });
    const anomaly = diverged.anomalies.find((a) => a.anomaly_kind === "TERMINAL_DIVERGENCE");
    assert.equal(anomaly?.subject_ref, attempt.attempt_key);
    assert.equal(diverged.authority_coverage.repository, "AVAILABLE");
    // Observation is not authority: the attempt did not move and nothing was journalled.
    assert.equal(w.store.attempts.current(TASK_KEY)?.state, "READY_TO_MERGE");
    assert.equal(w.store.decisions.count(), before);
  }, TWO_TASKS);
});

test("F13: the same subject re-held for the same reason within the window is RECOVERY_OR_HOLD_REPEATED", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    submitSupervisorProposal(w, world);
    assert.equal(w.tick(), "ACTIVATED");
    assert.equal(w.tick(), "IMPLEMENTATION_STARTED");

    for (const decision of ["d1", "d2", "d3"]) {
      w.store.decisions.append({
        kind: STATE_TRANSITION_KIND,
        refKey: TASK_KEY,
        payload: {
          primary_entity_key: TASK_KEY,
          task: { to: "HELD" },
          reason_code: `BLOCKED_BY_DECISION:${decision}`,
        } as never,
      });
    }

    const report = monitorOnce(w, {
      run_id: RUN_ID,
      now: new Date(Date.now() + 1000).toISOString(),
      trigger_config: {
        stale_after_ms: 1e12,
        intent_unresolved_after_ms: 1e12,
        repeat_window_ms: 86_400_000,
        repeat_count: 3,
        config_ref: "t",
      },
    });
    const repeated = report.anomalies.find((a) => a.anomaly_kind === "RECOVERY_OR_HOLD_REPEATED");
    assert.notEqual(repeated, undefined, "three normalised BLOCKED_BY_DECISION holds in-window");
    assert.equal(repeated?.threshold_ref, "t#repeat[3@86400000ms]");
    assert.equal(
      repeated?.signal_refs.some((ref) => ref.includes("HELD(BLOCKED_BY_DECISION) ×3")),
      true,
      "distinct decision ids normalise to one reason — the §22.5 repetition, not three novelties",
    );

    // Falsification: below the configured count, no claim.
    const under = monitorOnce(w, {
      run_id: RUN_ID,
      now: new Date(Date.now() + 1000).toISOString(),
      trigger_config: {
        stale_after_ms: 1e12,
        intent_unresolved_after_ms: 1e12,
        repeat_window_ms: 86_400_000,
        repeat_count: 4,
        config_ref: "t",
      },
    });
    assert.equal(
      under.anomalies.some((a) => a.anomaly_kind === "RECOVERY_OR_HOLD_REPEATED"),
      false,
    );
  }, SINGLE, { now: () => new Date().toISOString() });
});

// --- F15: the execution observation's role chain is Core-stamped, never adapter-claimed ----------

test("F15: schema v2 passes through and the frozen role chain overrides every adapter claim", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");
    submitSupervisorProposal(w, world);
    assert.equal(w.tick(), "ACTIVATED");
    assert.equal(w.tick(), "IMPLEMENTATION_STARTED");

    // The adapter reports a v2 observation whose chain fields all lie (I-TD3: model/adapter
    // output is never authoritative for identity).
    w.repository.candidate = CANDIDATE;
    const attempt = w.store.attempts.current(TASK_KEY)!;
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
      schema_version: 2,
      execution_observation: {
        schema_version: 2,
        subject: { kind: "UNKNOWN" },
        role: "SUPERVISOR",
        role_profile_id: "model-invented",
        runtime_profile: "model-invented",
        requested_binding_ref: "req-1",
        actual: { provider: "p", model: "m", binding_ref: "bind-1" },
        failure_attribution: null,
      },
    } as never);
    assert.equal(w.tick(), "VERIFICATION_STARTED");

    const projection = w.store.adapterMetadata
      .forEntity(attempt.attempt_key)
      .find((row) => row.key === "actor_turn_result:1");
    assert.notEqual(projection, undefined, "the redacted turn is a durable measurement source (§5.12)");
    const turn = projection?.value as {
      schema_version: number;
      execution_observation: {
        subject: { attempt_key?: string };
        role: string;
        role_profile_id: string;
        runtime_profile: string;
        requested_binding_ref: string;
        actual: { binding_ref: string };
      };
    };
    assert.equal(turn.schema_version, 2, "the v2 schema version survives the projection");

    // Core stamped the frozen chain (§13.2a/§13.5): durable selection + batch-bound profile.
    const observation = turn.execution_observation;
    assert.equal(observation.subject.attempt_key, attempt.attempt_key);
    assert.equal(observation.role, "ACTOR");
    const task = w.store.tasks.require(TASK_KEY);
    assert.equal(observation.role_profile_id, task.actor_profile);
    const compiled = w.store.batchView.compiledProfileFor(BATCH_ID);
    assert.equal(
      observation.runtime_profile,
      compiled.effective.project.roles[task.actor_profile as string]?.runtime_profile,
      "the runtime profile resolves through the frozen Compiled Profile, never the adapter claim",
    );

    // Adapter-observed facts that are genuinely the backend's to report pass through untouched.
    assert.equal(observation.requested_binding_ref, "req-1");
    assert.equal(observation.actual.binding_ref, "bind-1");
  }, SINGLE);
});

// --- F16: routing recommendations are §5.14 evaluation units with required refs ------------------

test("F16: a recommendation names its full §5.14 unit and per-category measurement refs", () => {
  withWorld((world) => {
    const w = driveToApprovalWaiting(world);
    const attempt = w.store.attempts.current(TASK_KEY)!;
    mergeAnswer(w, w.store.pendingDecisions.openFor(TASK_KEY)[0]!.body.decision_id, "APPROVE");
    assert.equal(w.tick(), "MERGE_APPROVAL_APPLIED");
    assert.equal(w.store.attempts.current(TASK_KEY)?.state, "APPROVED_FOR_MANUAL_MERGE");
    // The human merges manually; the Platform confirms the repository fact.
    w.repository.head = CANDIDATE;
    w.until(() => w.store.attempts.forTask(TASK_KEY).some((row) => row.state === "MERGED"));

    const rows = buildRoutingRecommendations(w.store, {
      run_id: RUN_ID,
      generated_at: "2026-08-31T00:00:00Z",
    });
    assert.equal(rows.length, 1);
    const row = rows[0]!;

    // The §5.14 unit axes are all present — never one global leaderboard row.
    assert.equal(row.role, "ACTOR");
    assert.equal(row.task_or_corpus_class, w.store.tasks.require(TASK_KEY).classification);
    const task = w.store.tasks.require(TASK_KEY);
    const compiled = w.store.batchView.compiledProfileFor(BATCH_ID);
    assert.equal(
      row.candidate_runtime_profile,
      compiled.effective.project.roles[task.actor_profile as string]?.runtime_profile,
    );
    assert.equal(
      row.assurance_context.includes(REQUIRED_CHECK),
      true,
      "the assurance axis is derived from the frozen verification policy, not a constant",
    );
    assert.notEqual(row.input_completeness, undefined);

    // §5.14 required refs: every category traces to attempt-level measurement sources.
    assert.deepEqual(row.quality_refs, [`measurement:${attempt.attempt_key}`]);
    assert.deepEqual(row.failure_refs, [], "no failure attribution exists for a merged attempt");
    assert.equal(row.sample_size, 1);
    assert.deepEqual(row.completed_rate, { kind: "REPORTED", value: 1 });
    // Honest UNKNOWN, not an estimate (finding 16's companion invariant).
    assert.deepEqual(row.cost_refs, [], "no cost source series exists, so no cost ref is invented");
  }, SINGLE);
});
