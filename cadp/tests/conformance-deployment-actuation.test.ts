/** TD §20.6 item 1: closed DEPLOY declaration/material, with no actuator. */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  DEPLOY_MATERIAL_SCHEMA,
  DEPLOY_OPERATION,
  DEPLOYMENT_ACTUATION_TARGET_TYPE,
  DeploymentActuationAdapter,
} from "../kernel/adapters/deploymentActuation.ts";
import { MaterialIncomplete } from "../kernel/adapters/types.ts";
import { resolveActivePolicy } from "../kernel/policyState.ts";
import { nowIso } from "../kernel/canonical.ts";
import { startKernelApi } from "../kernel/api.ts";
import type { EvidenceEnvelopeV1 } from "../kernel/records.ts";
import { PRINCIPALS, makeHarness, runChain, sealScriptedRequest, stopSharedOpa } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import type { ComponentIdentity, DeploymentComponentRunner } from "../kernel/adapters/deploymentActuation.ts";

after(() => stopSharedOpa());

const REPO_ID = "repo-deploy-conformance";
const SHA = "a".repeat(40);

function adapterFor(h: Awaited<ReturnType<typeof makeHarness>>): DeploymentActuationAdapter {
  return new DeploymentActuationAdapter(h.store, h.cas, REPO_ID, h.clock.fn);
}

function pinnedAdapter(
  h: Awaited<ReturnType<typeof makeHarness>>,
  compareStatus: string,
  head = SHA,
  porcelain = "",
): DeploymentActuationAdapter {
  return new DeploymentActuationAdapter(h.store, h.cas, REPO_ID, h.clock.fn, {
    compareToMain: async () => ({ status_code: 200, compare_status: compareStatus }),
    checkout: async () => ({ head, porcelain }),
  });
}

function sealImmutability(h: Awaited<ReturnType<typeof makeHarness>>, passing = true) {
  return h.ingress.submitEvidence(
    {
      evidence_kind: "TARGET_IMMUTABILITY_ATTESTATION",
      subject_bindings: [{ authority_ref: "github.com", namespace: "GIT_REPOSITORY", object_id: REPO_ID }],
      availability: "PRESENT",
      claim_schema: "cadp.target-immutability.v1",
      claim: { write_once_enforced: passing },
      producer_ref: "deployment-control-target",
      source_ref: "github.com",
      source_relation: "TARGET_AUTHORITY_OBSERVATION",
    },
    PRINCIPALS.depctlTarget,
  );
}

function sealPostDeployAttest(h: Harness, effectId: string, reachPassing = true): void {
  h.ingress.submitEvidence({
    evidence_kind: "CREDENTIAL_REACH_ATTESTATION",
    subject_bindings: [
      { authority_ref: "cadp-store:k04", namespace: "deployment", object_id: "cadp-v04-live" },
      { authority_ref: "cadp-store:k04", namespace: "effect", object_id: effectId },
    ],
    availability: "PRESENT", claim_schema: "cadp.credential-reach.v1",
    claim: { alternate_path_found: !reachPassing, probes: [{ target: "scripted", result: reachPassing ? "http 000" : "http 200" }], network_policy_digest: "scripted", secret_acl_digest: "scripted" },
    producer_ref: "deployment-control-probe", source_ref: "scripted deployment-control probe",
    source_relation: "INDEPENDENT_OBSERVATION",
  }, PRINCIPALS.depctlProbe);
  h.ingress.submitEvidence({
    evidence_kind: "TARGET_IMMUTABILITY_ATTESTATION",
    subject_bindings: [
      { authority_ref: "github.com", namespace: "GIT_REPOSITORY", object_id: REPO_ID },
      { authority_ref: "cadp-store:k04", namespace: "effect", object_id: effectId },
    ],
    availability: "PRESENT", claim_schema: "cadp.target-immutability.v1",
    claim: { write_once_enforced: true, negative_probe: { scripted: true } },
    producer_ref: "deployment-control-target", source_ref: "scripted target authority",
    source_relation: "TARGET_AUTHORITY_OBSERVATION",
  }, PRINCIPALS.depctlTarget);
}

let deployStep = 2000;

const priorBroker = { code_sha: "b".repeat(40), image_digest: "sha256:broker", pid: 123 };
const priorWorker = { code_sha: "b".repeat(40), image_digest: "sha256:worker", pid: 124 };

function deployMaterial(components = ["broker"]) {
  return { repo_id: REPO_ID, sha: SHA, components, expected_prior: Object.fromEntries(components.map((c) => [c, c === "broker" ? priorBroker : priorWorker])) };
}

function sealDeploy(h: Harness, material = deployMaterial()): string {
  const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const effect_id = h.ingress.allocateEffectId({
    schema: "cadp.allocation-key.v1",
    work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: (deployStep += 1),
    purpose: "deploy",
  });
  h.ingress.sealEffectRequest({
    effect_id,
    requester_ref: "workflow:cadp-work",
    work_bindings: [],
    target_ref: { authority_ref: "cadp-host", target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE, target_id: "cadp-v04-live" },
    operation_kind: DEPLOY_OPERATION,
    material_schema: DEPLOY_MATERIAL_SCHEMA,
    material_ref,
    prior_effect_refs: [],
  }, PRINCIPALS.workflow);
  return effect_id;
}

function agentApprove(h: Harness, effect_id: string): EvidenceEnvelopeV1 {
  const request = h.store.effectRequest(effect_id)!;
  return h.ingress.submitEvidence({
    evidence_kind: "AGENT_DECISION",
    subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: effect_id }],
    availability: "PRESENT",
    claim_schema: "cadp.human-decision.v1",
    claim: {
      principal: "agent:claude-owner", decision: "APPROVE",
      scope: { effect_id, target_ref: request.target_ref, material_digest: request.material_digest.value },
      presented_request_digest: request.request_digest,
      statement: "delegated approval must not authorize deployment", issued_at: nowIso(h.clock.fn),
    },
    producer_ref: "agent:claude-owner",
    source_ref: `agent-deploy-${effect_id}`,
    source_relation: "INDEPENDENT_OBSERVATION",
  }, { principal: "cadp-agent-owner" });
}

async function deployDecision(h: Harness, effect_id: string, evidence_refs: string[]) {
  const input = h.ingress.assembleAdmissionInput(effect_id, evidence_refs);
  const evaluated = await h.evaluate(input.input_digest.value);
  assert.equal(evaluated.kind, "DECISION");
  return evaluated.decision;
}

test("DEPLOY declares cadp.deploy.v1 and stays unavailable until both attestations pass", async () => {
  const h = await makeHarness();
  try {
    const adapter = adapterFor(h);
    const operation = () => adapter.describe().operations.find((row) => row.operation_kind === DEPLOY_OPERATION)!;
    assert.equal(adapter.describe().target_type, DEPLOYMENT_ACTUATION_TARGET_TYPE);
    assert.equal(operation().material_schema, DEPLOY_MATERIAL_SCHEMA);
    assert.equal(operation().available, false, "neither attestation exists");

    h.sealReach();
    assert.equal(operation().available, false, "reach alone cannot open deployment actuation");
    sealImmutability(h, false);
    assert.equal(operation().available, false, "a fresh failing immutability attestation cannot open it");
    sealImmutability(h, true);
    assert.equal(operation().available, true);
  } finally { h.close(); }
});

test("DEPLOY availability uses only the injected clock and flips exactly after the freshness boundary", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    sealImmutability(h, true);
    const reach = h.store.latestEvidenceOfKind("CREDENTIAL_REACH_ATTESTATION")!;
    const config = resolveActivePolicy(h.store, h.cas).config;
    const boundary = Date.parse(reach.produced_at) + config.reach_attestation_max_age_s * 1000;
    let now = boundary;
    const adapter = new DeploymentActuationAdapter(h.store, h.cas, REPO_ID, () => now);

    // The freshness predicate is inclusive at the exact boundary.
    assert.equal(adapter.describe().operations[0]!.available, true, "age == max_age is fresh");
    now = boundary + 1;
    assert.equal(adapter.describe().operations[0]!.available, false, "age == max_age + 1ms is stale");
  } finally { h.close(); }
});

test("DEPLOY closed material refuses unknown keys, empty components, and every out-of-set name without process effects", async () => {
  const h = await makeHarness();
  try {
    const adapter = adapterFor(h);
    let processDelta = 0; // Item 1 exposes no process transport and verify_material cannot mutate it.
    const base = deployMaterial();
    const invalid: Array<Record<string, unknown>> = [
      { repo_id: REPO_ID, sha: SHA, components: ["broker"] },
      { ...base, operator_note: "smuggled" },
      { ...base, components: [] },
      ...["kernel", "record", "temporal", "anything-else"].map((component) => ({ ...base, components: [component] })),
    ];
    for (const material of invalid) {
      await assert.rejects(
        adapter.verify_material(DEPLOY_OPERATION, material),
        MaterialIncomplete,
      );
      assert.equal(processDelta, 0);
    }
    await adapter.verify_material(DEPLOY_OPERATION, {
      repo_id: REPO_ID,
      sha: SHA,
      components: ["broker", "worker"],
      expected_prior: {
        broker: { code_sha: "b".repeat(40), image_digest: "sha256:broker", pid: 123 },
        worker: { code_sha: "b".repeat(40), image_digest: "sha256:worker", pid: 124 },
      },
    });
    assert.equal(processDelta, 0);
  } finally { h.close(); }
});

test("DEPLOY pre-K6 refuses unmerged/diverged ancestry and checkout drift without process effects", async () => {
  const h = await makeHarness();
  try {
    const material = deployMaterial();
    const cases = [
      { adapter: pinnedAdapter(h, "behind"), detail: /status behind/ },
      { adapter: pinnedAdapter(h, "diverged"), detail: /status diverged/ },
      { adapter: pinnedAdapter(h, "identical", "b".repeat(40)), detail: /local HEAD/ },
      { adapter: pinnedAdapter(h, "identical", SHA, " M cadp/product/worker.ts\n"), detail: /worktree is dirty/ },
    ];
    let pidDelta = 0;
    for (const row of cases) {
      const refusal = await row.adapter.dispatch_precondition_read(DEPLOY_OPERATION, material);
      assert.match(refusal ?? "", row.detail);
      assert.equal(pidDelta, 0);
    }
  } finally { h.close(); }
});

test("DEPLOY admits main itself through scripted compare and pin reads", async () => {
  const h = await makeHarness();
  try {
    const adapter = pinnedAdapter(h, "identical");
    const material = deployMaterial();
    await adapter.verify_material(DEPLOY_OPERATION, material);
    assert.equal(await adapter.dispatch_precondition_read(DEPLOY_OPERATION, material), undefined);
    assert.equal((await adapter.dispatch("effect", 1, {
        authority_ref: "cadp-host", target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE, target_id: "cadp-v04-live",
      }, DEPLOY_OPERATION, material)).kind, "AMBIGUOUS");
  } finally { h.close(); }
});

test("DEPLOY is AD3-shaped: only an exactly-scoped HUMAN_DECISION clears the gate", async () => {
  const h = await makeHarness({ paramOverrides: { delegated_merge_producers: ["agent:claude-owner"] } });
  try {
    const deploy = sealDeploy(h);
    const agent = agentApprove(h, deploy);
    const delegated = await deployDecision(h, deploy, [agent.evidence_id]);
    assert.equal(delegated.outcome, "REQUIRE_EVIDENCE", "agent_merge_ok must remain merge-only");
    assert.deepEqual(delegated.reason_codes, ["HUMAN_DECISION"]);

    const otherDeploy = sealDeploy(h, { ...deployMaterial(["worker"]), sha: "b".repeat(40) });
    const otherHuman = h.humanApprove(otherDeploy);
    const wrongEffect = await deployDecision(h, deploy, [otherHuman.evidence_id]);
    assert.equal(wrongEffect.outcome, "REQUIRE_EVIDENCE", "a decision for another effect cannot clear DEPLOY");
    assert.ok(wrongEffect.reason_codes.includes("HUMAN_DECISION"));

    const request = h.store.effectRequest(deploy)!;
    const wrongMaterial = h.ingress.submitEvidence({
      evidence_kind: "HUMAN_DECISION",
      subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: deploy }],
      availability: "PRESENT",
      claim_schema: "cadp.human-decision.v1",
      claim: {
        principal: "sso:a.t.laplace@gmail.com", decision: "APPROVE",
        scope: { effect_id: deploy, target_ref: request.target_ref, material_digest: "f".repeat(64) },
        presented_request_digest: request.request_digest,
        statement: "wrong material digest", issued_at: nowIso(h.clock.fn),
      },
      producer_ref: "human:astro3141", source_ref: `wrong-material-${deploy}`,
      source_relation: "INDEPENDENT_OBSERVATION",
    }, PRINCIPALS.human);
    const mismatched = await deployDecision(h, deploy, [wrongMaterial.evidence_id]);
    assert.equal(mismatched.outcome, "REQUIRE_EVIDENCE", "a decision for another material cannot clear DEPLOY");
    assert.ok(mismatched.reason_codes.includes("HUMAN_DECISION"));

    const exactHuman = h.humanApprove(deploy);
    const allowed = await deployDecision(h, deploy, [exactHuman.evidence_id]);
    assert.equal(allowed.outcome, "ALLOW");
  } finally { h.close(); }
});

function fakeRunner(initial: Record<string, ComponentIdentity>, nextPid = 9000): DeploymentComponentRunner & { calls: string[] } {
  const identities = structuredClone(initial);
  const calls: string[] = [];
  return {
    calls,
    async observe(component) { calls.push(`observe:${component}`); return { ...identities[component]! }; },
    async kill(component) { calls.push(`kill:${component}`); },
    async start(component) {
      calls.push(`start:${component}`);
      identities[component] = { ...identities[component]!, code_sha: SHA, pid: nextPid += 1 };
    },
  };
}

test("DEPLOY dispatch remains UNKNOWN until reconcile invokes scripted post-deploy attest", async () => {
  const h = await makeHarness();
  try {
    const runner = fakeRunner({ broker: priorBroker, worker: priorWorker });
    const effectId = "effect-committed-path";
    const admittedAt = new Date(h.clock.now).toISOString();
    let attestCalls = 0;
    const adapter = new DeploymentActuationAdapter(h.store, h.cas, REPO_ID, h.clock.fn, {
      compareToMain: async () => ({ status_code: 200, compare_status: "identical" }),
      checkout: async () => ({ head: SHA, porcelain: "" }),
    }, runner, async (boundEffectId) => {
      attestCalls += 1;
      assert.equal(boundEffectId, effectId);
      sealPostDeployAttest(h, boundEffectId);
    });
    const material = deployMaterial(["broker", "worker"]);
    await adapter.verify_material(DEPLOY_OPERATION, material);
    const result = await adapter.dispatch(effectId, 1, {
      authority_ref: "cadp-host", target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE, target_id: "cadp-v04-live",
    }, DEPLOY_OPERATION, material);
    assert.equal(result.kind, "AMBIGUOUS", "pid-start is transport acceptance, never COMMITTED");
    assert.deepEqual(runner.calls, [
      "observe:broker", "observe:worker", "kill:broker", "start:broker", "observe:broker",
      "kill:worker", "start:worker", "observe:worker",
    ]);
    h.clock.now += 1;
    const reconciled = await adapter.reconcile(effectId, 1, {
      authority_ref: "cadp-host", target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE, target_id: "cadp-v04-live",
    }, DEPLOY_OPERATION, material, { admitted_at: admittedAt });
    assert.equal(attestCalls, 1);
    assert.equal(reconciled.kind, "COMMITTED");
    if (reconciled.kind !== "COMMITTED") return;
    const receipt = reconciled.receipt_claim;
    assert.equal(adapter.receipt_binds(DEPLOY_OPERATION, material, receipt), true);
    const rows = receipt.components as Array<{ component: string; prior: ComponentIdentity; next: ComponentIdentity }>;
    assert.deepEqual(rows.find((row) => row.component === "broker")!.prior, priorBroker);
    assert.deepEqual(rows.find((row) => row.component === "worker")!.prior, priorWorker);
    for (const row of rows) {
      assert.equal(row.next.code_sha, SHA);
      assert.notEqual(row.next.pid, row.prior.pid);
    }
  } finally { h.close(); }
});

test("withholding post-deploy envelopes leaves DEPLOY reconciliation not COMMITTED", async () => {
  const h = await makeHarness();
  try {
    const runner = fakeRunner({ broker: priorBroker });
    const material = deployMaterial();
    const adapter = new DeploymentActuationAdapter(h.store, h.cas, REPO_ID, h.clock.fn, undefined, runner, async () => {});
    const admittedAt = new Date(h.clock.now).toISOString();
    await adapter.dispatch("deploy-withheld", 1, adapterTarget(), DEPLOY_OPERATION, material);
    h.clock.now += 1;
    const result = await adapter.reconcile("deploy-withheld", 1, adapterTarget(), DEPLOY_OPERATION, material, { admitted_at: admittedAt });
    assert.equal(result.kind, "UNKNOWN");
  } finally { h.close(); }
});

test("a failing reach attest after restart cannot commit and recheck #8 refuses an ordinary admission", async () => {
  const h = await makeHarness();
  try {
    const runner = fakeRunner({ broker: priorBroker });
    const material = deployMaterial();
    const admittedAt = new Date(h.clock.now).toISOString();
    await new DeploymentActuationAdapter(h.store, h.cas, REPO_ID, h.clock.fn, undefined, runner)
      .dispatch("deploy-failing", 1, adapterTarget(), DEPLOY_OPERATION, material);
    h.clock.now += 1;
    // A new adapter instance models kernel restart; its injected invocation runs no real probe.
    const restarted = new DeploymentActuationAdapter(h.store, h.cas, REPO_ID, h.clock.fn, undefined, runner, async (effectId) => {
      sealPostDeployAttest(h, effectId, false);
    });
    const result = await restarted.reconcile("deploy-failing", 1, adapterTarget(), DEPLOY_OPERATION, material, { admitted_at: admittedAt });
    assert.equal(result.kind, "UNKNOWN");

    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h);
    const ordinary = await runChain(h, request.effect_id);
    assert.equal(ordinary.admitted?.kind, "REFUSAL");
    if (ordinary.admitted?.kind === "REFUSAL") assert.equal(ordinary.admitted.reason, "ALTERNATE_CREDENTIAL_PATH_FOUND");
  } finally { h.close(); }
});

function adapterTarget() {
  return { authority_ref: "cadp-host", target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE, target_id: "cadp-v04-live" } as const;
}

test("DEPLOY expected_prior mismatch is REJECTED_NO_EFFECT before any kill or start", async () => {
  const h = await makeHarness();
  try {
    const runner = fakeRunner({ broker: priorBroker, worker: priorWorker });
    const adapter = new DeploymentActuationAdapter(h.store, h.cas, REPO_ID, h.clock.fn, undefined, runner);
    const material = deployMaterial(["broker", "worker"]);
    material.expected_prior.worker = { ...priorWorker, pid: 999 };
    const result = await adapter.dispatch("effect-cas-mismatch", 1, {
      authority_ref: "cadp-host", target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE, target_id: "cadp-v04-live",
    }, DEPLOY_OPERATION, material);
    assert.equal(result.kind, "REJECTED_NO_EFFECT");
    assert.deepEqual(runner.calls, ["observe:broker", "observe:worker"]);
  } finally { h.close(); }
});

test("C29: workflow retains admit_and_dispatch reach and cadp-depctl principals do not", async () => {
  const h = await makeHarness();
  const tokens = new Map([
    ["tok-workflow", "cadp-workflow"],
    ["tok-depctl-probe", "cadp-depctl-probe"],
    ["tok-depctl-target", "cadp-depctl-target"],
  ]);
  const api = await startKernelApi(
    { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens, clock: h.clock.fn },
    0,
  );
  try {
    const call = async (token: string) => {
      const response = await fetch(`http://127.0.0.1:${api.port}/admit_and_dispatch`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ effect_id: "missing", decision_id: "missing" }),
      });
      return { status: response.status, body: await response.json() as { error?: string; detail?: string } };
    };
    for (const token of ["tok-depctl-probe", "tok-depctl-target"]) {
      const denied = await call(token);
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error, "FORBIDDEN_FOR_PRINCIPAL");
    }
    const workflow = await call("tok-workflow");
    assert.notEqual(workflow.status, 403, "workflow is the sole class with admission reach");
  } finally {
    api.close();
    h.close();
  }
});
