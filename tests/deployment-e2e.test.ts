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
