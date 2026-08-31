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
import { BATCH_ID, RUN_ID, TASK_KEY, withWorld } from "./support/domain-fixtures.ts";
import {
  auditorVerdict,
  auditorTurnResult,
  evidenceItem,
  REQUIRED_CHECK,
} from "./support/execution-fixtures.ts";
import {
  actorProduced,
  coordinatorWorld,
  submitSupervisorProposal,
  type CoordinatorWorld,
} from "./support/coordinator-fixtures.ts";
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
      negatives.some((anomaly) => anomaly.anomaly_kind === "EXTERNAL_COMPLETION_UNPROJECTED"),
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
      positives.some((anomaly) => anomaly.anomaly_kind === "EXTERNAL_COMPLETION_UNPROJECTED"),
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
