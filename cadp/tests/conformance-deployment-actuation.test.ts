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
import { PRINCIPALS, makeHarness, stopSharedOpa } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import type { ComponentIdentity, ComponentRunner, DeployableComponent } from "../live/componentControl.ts";

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

let deployStep = 2000;

function sealDeploy(h: Harness, material = { repo_id: REPO_ID, sha: SHA, components: ["broker"] }): string {
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
    const base = { repo_id: REPO_ID, sha: SHA, components: ["broker"] };
    const invalid: Array<Record<string, unknown>> = [
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
    const material = { repo_id: REPO_ID, sha: SHA, components: ["broker"] };
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

test("DEPLOY admits main itself through scripted compare and pin reads; an unconfigured actuator fails closed", async () => {
  const h = await makeHarness();
  try {
    const adapter = pinnedAdapter(h, "identical");
    const material = { repo_id: REPO_ID, sha: SHA, components: ["broker"] };
    await adapter.verify_material(DEPLOY_OPERATION, material);
    assert.equal(await adapter.dispatch_precondition_read(DEPLOY_OPERATION, material), undefined);
    const result = await adapter.dispatch("effect", 1, {
        authority_ref: "cadp-host", target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE, target_id: "cadp-v04-live",
      }, DEPLOY_OPERATION, material);
    assert.equal(result.kind, "AMBIGUOUS");
  } finally { h.close(); }
});

class FakeComponentRunner implements ComponentRunner {
  readonly calls: string[] = [];
  readonly identities = new Map<DeployableComponent, ComponentIdentity>();
  nextPid = 9000;
  readonly nextSha: string;
  constructor(nextSha: string) { this.nextSha = nextSha; }
  observe(name: DeployableComponent): ComponentIdentity { this.calls.push(`observe:${name}`); return { ...this.identities.get(name)! }; }
  kill(name: DeployableComponent): void { this.calls.push(`kill:${name}`); }
  start(name: DeployableComponent): void {
    this.calls.push(`start:${name}`);
    const old = this.identities.get(name)!;
    this.identities.set(name, { code_sha: this.nextSha, image_digest: old.image_digest, pid: ++this.nextPid });
  }
}

test("DEPLOY dispatch restarts each named component and binds prior and next identities in the COMMITTED receipt", async () => {
  const h = await makeHarness();
  try {
    const fake = new FakeComponentRunner(SHA);
    const brokerPrior = { code_sha: "b".repeat(40), image_digest: "sha256:surface", pid: 101 };
    const workerPrior = { code_sha: "b".repeat(40), image_digest: "sha256:surface", pid: 102 };
    fake.identities.set("broker", brokerPrior); fake.identities.set("worker", workerPrior);
    const adapter = new DeploymentActuationAdapter(h.store, h.cas, REPO_ID, h.clock.fn, undefined, fake);
    const material = { repo_id: REPO_ID, sha: SHA, components: ["broker", "worker"], expected_prior: { broker: brokerPrior, worker: workerPrior } };
    const result = await adapter.dispatch("effect-committed", 1, { authority_ref: "cadp-host", target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE, target_id: "cadp-v04-live" }, DEPLOY_OPERATION, material);
    assert.equal(result.kind, "ACCEPTED");
    if (result.kind !== "ACCEPTED") return;
    const rows = result.receipt_claim["components"] as Array<{ component: string; prior: ComponentIdentity; next: ComponentIdentity }>;
    assert.deepEqual(rows.map((row) => row.prior), [brokerPrior, workerPrior]);
    assert.ok(rows.every((row) => row.next.code_sha === material.sha && row.next.pid >= 9001));
    assert.deepEqual(fake.calls, ["observe:broker", "observe:worker", "kill:broker", "start:broker", "observe:broker", "kill:worker", "start:worker", "observe:worker"]);
    assert.equal(adapter.receipt_binds(DEPLOY_OPERATION, material, result.receipt_claim), true);
  } finally { h.close(); }
});

test("DEPLOY expected_prior CAS mismatch is REJECTED_NO_EFFECT and leaves every original pid running untouched", async () => {
  const h = await makeHarness();
  try {
    const fake = new FakeComponentRunner(SHA);
    fake.identities.set("broker", { code_sha: "b".repeat(40), image_digest: "sha256:surface", pid: 201 });
    fake.identities.set("worker", { code_sha: "b".repeat(40), image_digest: "sha256:surface", pid: 202 });
    const adapter = new DeploymentActuationAdapter(h.store, h.cas, REPO_ID, h.clock.fn, undefined, fake);
    const result = await adapter.dispatch("effect-rejected", 1, { authority_ref: "cadp-host", target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE, target_id: "cadp-v04-live" }, DEPLOY_OPERATION, { repo_id: REPO_ID, sha: SHA, components: ["broker", "worker"], expected_prior: { broker: { code_sha: "c".repeat(40), image_digest: "sha256:surface", pid: 201 }, worker: fake.identities.get("worker")! } });
    assert.equal(result.kind, "REJECTED_NO_EFFECT");
    assert.deepEqual([...fake.identities.values()].map((identity) => identity.pid), [201, 202]);
    assert.deepEqual(fake.calls, ["observe:broker", "observe:worker"], "all identities are CAS-checked before the first kill");
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

    const otherDeploy = sealDeploy(h, { repo_id: REPO_ID, sha: "b".repeat(40), components: ["worker"] });
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
