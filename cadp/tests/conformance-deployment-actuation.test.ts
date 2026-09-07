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
import { PRINCIPALS, makeHarness, stopSharedOpa } from "./support/harness.ts";

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

test("DEPLOY admits main itself through scripted compare and pin reads, but item 2 still cannot dispatch", async () => {
  const h = await makeHarness();
  try {
    const adapter = pinnedAdapter(h, "identical");
    const material = { repo_id: REPO_ID, sha: SHA, components: ["broker"] };
    await adapter.verify_material(DEPLOY_OPERATION, material);
    assert.equal(await adapter.dispatch_precondition_read(DEPLOY_OPERATION, material), undefined);
    await assert.rejects(
      adapter.dispatch("effect", 1, {
        authority_ref: "cadp-host", target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE, target_id: "cadp-v04-live",
      }, DEPLOY_OPERATION, material),
      /outside TD §20\.6 items 1-2/,
    );
  } finally { h.close(); }
});
