/**
 * Production-composition vertical E2E (ADP_ALIVE).
 *
 * One task crosses the whole Platform lifecycle through `deployment/compose` + `openRun` + the
 * HTTP ingress + `ProductionCoordinator.tickOnce()`, with **real** everything the environment can
 * make real: a real git canonical and worktree (LocalGitRepositoryAdapter), a real task document
 * (ProjectDocumentTaskSource), real Profile documents (DocumentProfileSource + compiler), a real
 * SQLite store file, a real file report transport and the real Backend v1 runtime adapter over its
 * gateway seam. What is scripted is exactly the two external backends this machine does not have:
 * the runtime gateway (at the measured RA-1 seam) and the verification backend.
 *
 * The Actor's "model work" is played by the test **in the real worktree**: it writes the file and
 * makes the commit, so candidate authority, lineage, tracked-clean and the merge observation are
 * all judged by git itself. The human merge is a real `git merge --ff-only` on the canonical.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AUDITOR_VERDICT_PROTOCOL, RuntimeResultChannel } from "../adapters/runtime-result-channel/index.ts";
import { ulid } from "../deployment/identities.ts";
import { compose, type Composition } from "../deployment/compose.ts";
import { openRun } from "../deployment/open-run.ts";
import { startIngress, type Ingress } from "../deployment/ingress.ts";
import { FakeVerificationAdapter } from "../testdoubles/fake-verification-adapter.ts";
import { WORKSPACE_METADATA_KEY, REPOSITORY_ADAPTER } from "../core/execution/start-implementation.ts";
import type { TickStep } from "../core/coordinator/production-coordinator.ts";
import {
  pilotWorld,
  ScriptedGateway,
  PILOT_ACTOR_PROFILE,
  PILOT_CHECK,
  PILOT_CLASSIFICATION,
  PILOT_PIPELINE,
  PILOT_SCOPE,
  PILOT_TASK_REF,
  PILOT_VERIFICATION_PROFILE,
} from "./support/deployment-fixtures.ts";

const TASK_KEY = `task:pilot:${PILOT_TASK_REF}`;

async function post(base: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = (await response.json()) as unknown;
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(answer)}`);
  return answer;
}

test("ALIVE-1: one task crosses the full lifecycle through the production composition", async () => {
  const world = pilotWorld();
  const gateway = new ScriptedGateway();
  const verification = new FakeVerificationAdapter();
  let composition: Composition | undefined;
  let ingress: Ingress | undefined;

  try {
    composition = compose(world.config, {
      runtime_gateway: gateway,
      verification,
      preflight: () => ({ status: "READY" }),
    });
    const { store, coordinator, deps } = composition;
    const opened = openRun(composition);
    ingress = await startIngress(deps, {
      host: "127.0.0.1",
      port: 0,
      report_channel: "operations",
    });
    const api = `http://127.0.0.1:${ingress.port()}`;

    const tick = (): TickStep => coordinator.tickOnce(opened.run_id);
    const attempt = () => store.attempts.current(TASK_KEY);

    // --- discovery happened at openRun; the Coordinator asks the Supervisor -------------------
    assert.equal(store.tasks.require(TASK_KEY).platform_state, "DISCOVERED");
    assert.equal(tick(), "SUPERVISOR_REQUESTED");
    assert.equal(gateway.turns.length, 1, "one Supervisor turn was requested");

    // --- the Supervisor submits the Proposal through the real HTTP ingress ---------------------
    const definition = deps.taskSource.get_task(PILOT_TASK_REF);
    const head = deps.repository.snapshot_canonical().head;
    assert.equal(head, world.base_head);
    const submitted = (await post(api, "/v1/proposals", {
      run_id: opened.run_id,
      batch_id: opened.batch_id,
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
          compiled_profile_hash: composition.compiled.compiled_hash,
        },
        reason_refs: [],
      },
    })) as { result: { kind: string }; admitted: boolean };
    assert.deepEqual(submitted.result, { kind: "ACCEPTED" });
    assert.equal(submitted.admitted, true);
    assert.equal(store.tasks.require(TASK_KEY).platform_state, "SELECTED");

    // --- activation freezes the real contract: sources, scope, grants --------------------------
    assert.equal(tick(), "ACTIVATED");
    const active = attempt();
    assert.notEqual(active, undefined);
    assert.equal(active?.state, "READY");
    assert.equal(active?.base_head, head);

    // --- the Actor launch creates a real worktree and a real (scripted-gateway) session --------
    assert.equal(tick(), "IMPLEMENTATION_STARTED");
    const workspace = store.adapterMetadata.get(
      active?.attempt_key ?? "",
      REPOSITORY_ADAPTER,
      WORKSPACE_METADATA_KEY,
    )?.value as { path: string; branch: string };
    assert.notEqual(workspace, undefined, "a durable workspace projection exists");
    assert.equal(existsSync(workspace.path), true, "the worktree really exists");

    // --- the "model" implements: a real commit in the real worktree ----------------------------
    const candidate = world.repo.commit({
      path: "src/feature.txt",
      content: "marker\n",
      message: "feat: add the feature marker",
      cwd: workspace.path,
    });
    const actorTurn = gateway.turns.at(-1);
    assert.notEqual(actorTurn, undefined);
    gateway.complete(actorTurn!.session, actorTurn!.request_id);

    // --- candidate authority is git's own answer ----------------------------------------------
    assert.equal(tick(), "VERIFICATION_STARTED");
    assert.equal(attempt()?.state, "VERIFYING");
    assert.equal(attempt()?.candidate_commit, candidate);

    // --- verification completes with correctly bound evidence ----------------------------------
    const contractHash = store.contracts.hashOf(attempt()?.contract_snapshot_id ?? "") as string;
    verification.completeWith([
      {
        evidence_id: ulid(),
        check_id: PILOT_CHECK,
        result: "PASS",
        assurance_level: "REEXECUTED",
        target_commit: candidate,
        task_contract_hash: contractHash,
        executor_identity: "platform-verifier@pilot",
        timestamp: new Date().toISOString(),
      },
    ]);
    assert.equal(tick(), "AUDIT_STARTED");
    assert.equal(attempt()?.state, "AUDITING");

    // --- the Auditor submits its verdict through the real result channel ----------------------
    const auditorTurn = gateway.turns.at(-1);
    assert.notEqual(auditorTurn, undefined);
    const channel = new RuntimeResultChannel(world.config.result_channel_root);
    const sessionRef = `${auditorTurn!.session.agent_id}:${auditorTurn!.session.session_id}`;
    const evidenceIds = store.verificationEvidence
      .forAttempt(attempt()?.attempt_key ?? "")
      .filter((row) => row.target_commit === candidate)
      .map((row) => row.evidence_id);
    const submittedVerdict = channel.submit(sessionRef, AUDITOR_VERDICT_PROTOCOL, {
      verdict: "AUDIT_PASS",
      findings: [],
      reviewed: {
        candidate_commit: candidate,
        task_contract_hash: contractHash,
        evidence_ids: evidenceIds,
      },
    });
    assert.equal((submittedVerdict as { accepted?: boolean }).accepted, true);
    gateway.complete(auditorTurn!.session, auditorTurn!.request_id);
    verification.settlement = { kind: "SETTLED" };

    assert.equal(tick(), "AUDIT_COMPLETED");
    assert.equal(attempt()?.state, "READY_TO_MERGE");

    // --- the merge approval opens and a person answers through the ingress ---------------------
    assert.equal(tick(), "MERGE_APPROVAL_OPENED");
    const open = store.pendingDecisions.openFor(TASK_KEY);
    assert.equal(open.length, 1);
    const decision = open[0]!.body;
    assert.equal(decision.category, "MERGE_APPROVAL");
    await post(api, `/v1/decisions/${decision.decision_id}/resolution`, {
      chosen_option: "APPROVE",
      resolved_by: "operator@pilot",
    });

    assert.equal(tick(), "MERGE_APPROVAL_APPLIED");
    assert.equal(attempt()?.state, "APPROVED_FOR_MANUAL_MERGE");

    // Approval is permission, not a merge: canonical has not moved and nothing merged it.
    assert.equal(deps.repository.snapshot_canonical().head, head);

    // --- the person performs the real merge; only git can say it happened ----------------------
    world.repo.git(["fetch", "--quiet", "--no-tags", workspace.path, candidate]);
    world.repo.git(["merge", "--ff-only", candidate]);
    assert.equal(tick(), "MERGE_OBSERVED");

    const rows = store.attempts.forTask(TASK_KEY);
    assert.equal(rows.at(-1)?.state, "MERGED");
    assert.equal(store.tasks.require(TASK_KEY).platform_state, "COMPLETED");
    assert.equal(readFileSync(join(world.repo.root, "src/feature.txt"), "utf8"), "marker\n");

    // --- batch + run completion, and the summary goes out through the real file transport ------
    assert.equal(tick(), "RUN_COMPLETED");
    assert.equal(store.runs.require(opened.run_id).status, "COMPLETED");
    // One pending notification per tick; drain until the outbox is empty (§21.1).
    for (let i = 0; i < 10 && store.outbox.pending().length > 0; i += 1) {
      assert.equal(tick(), "REPORT_DELIVERED");
    }
    const log = readFileSync(join(world.base, "reports", "operations.jsonl"), "utf8");
    assert.match(log, /BATCH_COMPLETE/);
    assert.match(log, /PENDING_DECISION/);

    // --- the read model over HTTP agrees with durable state ------------------------------------
    const projection = (await (
      await fetch(`${api}/v1/runs/${encodeURIComponent(opened.run_id)}`)
    ).json()) as { run: { status: string } };
    assert.equal(projection.run.status, "COMPLETED");
  } finally {
    await ingress?.close();
    composition?.dispose();
    world.dispose();
  }
});

test("ALIVE-2: with a compliant backend and auto_merge policy, the Gate performs a real ff-only merge", async () => {
  const { CAPABILITY_NAMES } = await import("../core/schemas/capability-vocabulary.ts");
  const { submitProposal } = await import("../core/admission/submit-proposal.ts");
  const { mergeOp } = await import("../core/execution/automatic-merge.ts");
  const { backendV1Manifests } = await import("../deployment/manifests.ts");

  const world = pilotWorld({
    auto_merge: true,
    capability_requirements: {
      actor_execution: {
        "repository.feature_write": { accepted: ["ENFORCED", "AVAILABLE_WITH_REDUCED_ASSURANCE"] },
        "shell.execute": { accepted: ["ENFORCED", "AVAILABLE_WITH_REDUCED_ASSURANCE", "NOT_YET_AUDITED"] },
      },
      auditor_execution: {
        "repository.read": { accepted: ["ENFORCED", "AVAILABLE_WITH_REDUCED_ASSURANCE", "NOT_YET_AUDITED"] },
      },
      automatic_merge: {
        "repository.canonical_write": { accepted: ["ENFORCED"] },
        "repository.merge": { accepted: ["ENFORCED"] },
      },
    },
  });
  const gateway = new ScriptedGateway();
  const verification = new FakeVerificationAdapter();

  // A hypothetical audited backend (§14.5 P-a satisfied): every boundary ENFORCED. The honest
  // Backend v1 manifests are proven to refuse in B14-2; this world states the activation
  // precondition explicitly instead of weakening anything.
  const manifests = backendV1Manifests({ backend_instance_id: "audited-host" }) as {
    runtime: { body: Record<string, unknown> };
    workflow: unknown;
    repository: unknown;
    verification: unknown;
  };
  const enforced: Record<string, { allow: string; deny: string }> = {};
  for (const name of CAPABILITY_NAMES) enforced[name] = { allow: "ENFORCED", deny: "ENFORCED" };
  manifests.runtime = {
    ...manifests.runtime,
    body: { ...manifests.runtime.body, capability_enforcement: enforced },
  };

  let composition: Composition | undefined;
  try {
    composition = compose(world.config, {
      runtime_gateway: gateway,
      verification,
      manifests: manifests as never,
      preflight: () => ({ status: "READY" }),
    });
    const { store, coordinator, deps } = composition;
    const opened = openRun(composition);
    const tick = (): TickStep => coordinator.tickOnce(opened.run_id);
    const attempt = () => store.attempts.current(TASK_KEY);

    assert.equal(tick(), "SUPERVISOR_REQUESTED");
    const definition = deps.taskSource.get_task(PILOT_TASK_REF);
    const head = deps.repository.snapshot_canonical().head;
    const submitted = submitProposal(
      { store, taskSource: deps.taskSource, repository: deps.repository, manifests: deps.manifests },
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
            compiled_profile_hash: composition.compiled.compiled_hash,
          },
          reason_refs: [],
        },
      },
    );
    assert.deepEqual(submitted.result, { kind: "ACCEPTED" });

    assert.equal(tick(), "ACTIVATED");
    assert.equal(tick(), "IMPLEMENTATION_STARTED");
    const workspace = store.adapterMetadata.get(
      attempt()?.attempt_key ?? "",
      REPOSITORY_ADAPTER,
      WORKSPACE_METADATA_KEY,
    )?.value as { path: string };
    const candidate = world.repo.commit({
      path: "src/feature.txt",
      content: "auto\n",
      message: "feat: auto-merged marker",
      cwd: workspace.path,
    });
    const actorTurn = gateway.turns.at(-1)!;
    gateway.complete(actorTurn.session, actorTurn.request_id);
    assert.equal(tick(), "VERIFICATION_STARTED");

    const contractHash = store.contracts.hashOf(attempt()?.contract_snapshot_id ?? "") as string;
    verification.completeWith([
      {
        evidence_id: ulid(),
        check_id: PILOT_CHECK,
        result: "PASS",
        assurance_level: "REEXECUTED",
        target_commit: candidate,
        task_contract_hash: contractHash,
        executor_identity: "platform-verifier@pilot",
        timestamp: new Date().toISOString(),
      },
    ]);
    assert.equal(tick(), "AUDIT_STARTED");

    const auditorTurn = gateway.turns.at(-1)!;
    const channel = new RuntimeResultChannel(world.config.result_channel_root);
    channel.submit(
      `${auditorTurn.session.agent_id}:${auditorTurn.session.session_id}`,
      AUDITOR_VERDICT_PROTOCOL,
      {
        verdict: "AUDIT_PASS",
        findings: [],
        reviewed: {
          candidate_commit: candidate,
          task_contract_hash: contractHash,
          evidence_ids: store.verificationEvidence
            .forAttempt(attempt()?.attempt_key ?? "")
            .filter((row) => row.target_commit === candidate)
            .map((row) => row.evidence_id),
        },
      },
    );
    gateway.complete(auditorTurn.session, auditorTurn.request_id);
    verification.settlement = { kind: "SETTLED" };
    assert.equal(tick(), "AUDIT_COMPLETED");

    // --- MVP 2: the Gate merges, for real, with git as the executor -----------------------------
    const key = attempt()?.attempt_key ?? "";
    assert.equal(tick(), "AUTO_MERGE_STARTED");
    assert.equal(deps.repository.snapshot_canonical().head, head, "INTENT precedes the effect");
    assert.equal(tick(), "AUTO_MERGE_COMPLETED");
    assert.equal(deps.repository.snapshot_canonical().head, candidate, "a real ff-only merge");
    assert.equal(world.repo.head(), candidate);
    assert.equal(store.idempotency.get(mergeOp(key, candidate))?.state, "DONE");
    assert.equal(store.tasks.require(TASK_KEY).platform_state, "COMPLETED");
    assert.equal(store.pendingDecisions.openFor(TASK_KEY).length, 0, "no human decision opened");
    assert.equal(tick(), "RUN_COMPLETED");
  } finally {
    composition?.dispose();
    world.dispose();
  }
});

test("ALIVE-3: a platform restart mid-implementation resumes from durable state and completes", async () => {
  const { recoverRun } = await import("../core/coordinator/production-recovery.ts");
  const { submitProposal } = await import("../core/admission/submit-proposal.ts");

  const world = pilotWorld();
  // The backend outlives the platform process: the same gateway and verification instances span
  // both compositions, exactly as a real runtime would.
  const gateway = new ScriptedGateway();
  const verification = new FakeVerificationAdapter();
  let first: Composition | undefined;
  let second: Composition | undefined;

  try {
    first = compose(world.config, {
      runtime_gateway: gateway,
      verification,
      preflight: () => ({ status: "READY" }),
    });
    const opened = openRun(first);
    assert.equal(first.coordinator.tickOnce(opened.run_id), "SUPERVISOR_REQUESTED");
    const definition = first.deps.taskSource.get_task(PILOT_TASK_REF);
    const head = first.deps.repository.snapshot_canonical().head;
    const submitted = submitProposal(
      {
        store: first.store,
        taskSource: first.deps.taskSource,
        repository: first.deps.repository,
        manifests: first.deps.manifests,
      },
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
    assert.deepEqual(submitted.result, { kind: "ACCEPTED" });
    assert.equal(first.coordinator.tickOnce(opened.run_id), "ACTIVATED");
    assert.equal(first.coordinator.tickOnce(opened.run_id), "IMPLEMENTATION_STARTED");

    // --- crash: the platform process dies mid-implementation ---------------------------------
    first.dispose();
    first = undefined;

    // --- restart: a new composition over the same directory -----------------------------------
    second = compose(world.config, {
      runtime_gateway: gateway,
      verification,
      preflight: () => ({ status: "READY" }),
    });
    const resumed = openRun(second);
    assert.deepEqual(resumed, opened, "the same run, not a second one");

    const report = recoverRun(second.deps, { run_id: opened.run_id });
    assert.equal(report.classification, "CONSISTENT", "durable state reconciles after restart");

    const { store, coordinator, deps } = second;
    const attempt = () => store.attempts.current(TASK_KEY);
    assert.equal(attempt()?.state, "IMPLEMENTING", "exactly where the crash left it");

    // The model finishes its work in the real (still existing) worktree.
    const workspace = store.adapterMetadata.get(
      attempt()?.attempt_key ?? "",
      REPOSITORY_ADAPTER,
      WORKSPACE_METADATA_KEY,
    )?.value as { path: string };
    assert.equal(existsSync(workspace.path), true, "the worktree survived the restart");
    const candidate = world.repo.commit({
      path: "src/feature.txt",
      content: "restart\n",
      message: "feat: finished after the restart",
      cwd: workspace.path,
    });
    const actorTurn = gateway.turns.at(-1)!;
    gateway.complete(actorTurn.session, actorTurn.request_id);

    assert.equal(coordinator.tickOnce(opened.run_id), "VERIFICATION_STARTED");
    const contractHash = store.contracts.hashOf(attempt()?.contract_snapshot_id ?? "") as string;
    verification.completeWith([
      {
        evidence_id: ulid(),
        check_id: PILOT_CHECK,
        result: "PASS",
        assurance_level: "REEXECUTED",
        target_commit: candidate,
        task_contract_hash: contractHash,
        executor_identity: "platform-verifier@pilot",
        timestamp: new Date().toISOString(),
      },
    ]);
    assert.equal(coordinator.tickOnce(opened.run_id), "AUDIT_STARTED");

    const auditorTurn = gateway.turns.at(-1)!;
    const channel = new RuntimeResultChannel(world.config.result_channel_root);
    channel.submit(
      `${auditorTurn.session.agent_id}:${auditorTurn.session.session_id}`,
      AUDITOR_VERDICT_PROTOCOL,
      {
        verdict: "AUDIT_PASS",
        findings: [],
        reviewed: {
          candidate_commit: candidate,
          task_contract_hash: contractHash,
          evidence_ids: store.verificationEvidence
            .forAttempt(attempt()?.attempt_key ?? "")
            .filter((row) => row.target_commit === candidate)
            .map((row) => row.evidence_id),
        },
      },
    );
    gateway.complete(auditorTurn.session, auditorTurn.request_id);
    verification.settlement = { kind: "SETTLED" };
    assert.equal(coordinator.tickOnce(opened.run_id), "AUDIT_COMPLETED");
    assert.equal(coordinator.tickOnce(opened.run_id), "MERGE_APPROVAL_OPENED");

    const decision = store.pendingDecisions.openFor(TASK_KEY)[0]!.body;
    store.withTransaction(() => {
      store.pendingDecisions.resolve(decision.decision_id, {
        kind: "OPTION",
        chosen_option: "APPROVE",
        free_form: null,
        resolved_by: "operator@pilot",
        resolved_at: new Date().toISOString(),
        approval_binding: null,
        applied_transition_ref: null,
      });
    });
    assert.equal(coordinator.tickOnce(opened.run_id), "MERGE_APPROVAL_APPLIED");
    world.repo.git(["fetch", "--quiet", "--no-tags", workspace.path, candidate]);
    world.repo.git(["merge", "--ff-only", candidate]);
    assert.equal(coordinator.tickOnce(opened.run_id), "MERGE_OBSERVED");
    assert.equal(coordinator.tickOnce(opened.run_id), "RUN_COMPLETED");
    assert.equal(deps.repository.snapshot_canonical().head, candidate);
  } finally {
    first?.dispose();
    second?.dispose();
    world.dispose();
  }
});

test("ALIVE-4: total backend loss across a restart — no duplicate turn, honest waiting, fail-closed catch-up", async () => {
  const { recoverRun } = await import("../core/coordinator/production-recovery.ts");
  const { submitProposal } = await import("../core/admission/submit-proposal.ts");
  const { RUNTIME_ADAPTER } = await import("../core/execution/start-implementation.ts");
  const { actorTurnMetadataKey } = await import("../core/execution/actor-operations.ts");

  const world = pilotWorld();
  const gateway = new ScriptedGateway();
  let first: Composition | undefined;
  let second: Composition | undefined;

  try {
    first = compose(world.config, {
      runtime_gateway: gateway,
      verification: new FakeVerificationAdapter(),
      preflight: () => ({ status: "READY" }),
    });
    const opened = openRun(first);
    assert.equal(first.coordinator.tickOnce(opened.run_id), "SUPERVISOR_REQUESTED");
    const definition = first.deps.taskSource.get_task(PILOT_TASK_REF);
    const head = first.deps.repository.snapshot_canonical().head;
    const submitted = submitProposal(
      {
        store: first.store,
        taskSource: first.deps.taskSource,
        repository: first.deps.repository,
        manifests: first.deps.manifests,
      },
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
    assert.deepEqual(submitted.result, { kind: "ACCEPTED" });
    assert.equal(first.coordinator.tickOnce(opened.run_id), "ACTIVATED");
    assert.equal(first.coordinator.tickOnce(opened.run_id), "IMPLEMENTATION_STARTED");
    assert.equal(gateway.turns.length >= 1, true, "the actor turn was spawned before the crash");

    // --- crash: platform AND backend die together ---------------------------------------------
    first.dispose();
    first = undefined;
    const freshGateway = new ScriptedGateway(); // the backend restarted: no session, no status

    second = compose(world.config, {
      runtime_gateway: freshGateway,
      verification: new FakeVerificationAdapter(),
      preflight: () => ({ status: "READY" }),
    });
    const resumed = openRun(second);
    assert.deepEqual(resumed, opened, "the same run, not a second one");
    const { store, coordinator, deps } = second;
    const attempt = () => store.attempts.current(TASK_KEY)!;
    const attemptKey = attempt().attempt_key;

    // 1) No authority answers about the turn → that is honest waiting, never a re-spawn.
    const silent = recoverRun(deps, { run_id: opened.run_id });
    assert.equal(silent.classification, "CONSISTENT", "no terminal projection = still running");
    assert.equal(attempt().state, "IMPLEMENTING");
    assert.equal(freshGateway.turns.length, 0, "recovery spawned nothing");
    // The ordinary tick polls the turn, finds no terminal projection and fails *loudly* — a
    // failed tick is logged by main and harms nothing durable; it never manufactures a result.
    assert.throws(() => coordinator.tickOnce(opened.run_id), /no terminal projection/);
    assert.equal(attempt().state, "IMPLEMENTING");
    assert.equal(freshGateway.turns.length, 0, "the tick spawned nothing either — zero duplicate turns");

    // 2) The backend answers through the durable handle: the session is gone (§22.3 R-1).
    const handle = store.adapterMetadata.get(attemptKey, RUNTIME_ADAPTER, actorTurnMetadataKey(1))
      ?.value as { agent_id: string; session_id: string; request_id: string };
    freshGateway.lose(
      { agent_id: handle.agent_id, session_id: handle.session_id },
      handle.request_id,
    );

    const caught = recoverRun(deps, { run_id: opened.run_id });
    assert.equal(caught.classification, "EXPLAINABLE");
    assert.equal(
      caught.actions.some((action) => action.kind === "TURN_LOSS_CAUGHT_UP"),
      true,
      "the loss is reconciled through the sealed judge, not improvised",
    );
    // No commit ever landed in the worktree, so the repository judges the candidate ABSENT and
    // the sealed policy answers with a rework — the lost turn itself is never replayed.
    assert.equal(attempt().attempt_key, attemptKey, "same attempt; nothing was cloned");
    assert.equal(attempt().state, "REWORKING");
    assert.equal(freshGateway.turns.length, 0, "catch-up spawned no turn");

    // 3) The rework turn cannot safely go out: the lost turn's result-channel slot is still armed
    // and a restarted adapter refuses to guess which slot to destroy (I-TD12). The attempt parks
    // fail-closed for a person — and still nothing was spawned. Zero duplicate turns, ever.
    assert.equal(coordinator.tickOnce(opened.run_id), "BLOCKED");
    assert.equal(store.tasks.require(TASK_KEY).platform_state, "HELD");
    assert.equal(store.tasks.require(TASK_KEY).state_reason?.code, "RECOVERY_CONFLICT");
    assert.equal(freshGateway.turns.length, 0, "no turn was ever replayed or spawned");
  } finally {
    first?.dispose();
    second?.dispose();
    world.dispose();
  }
});
