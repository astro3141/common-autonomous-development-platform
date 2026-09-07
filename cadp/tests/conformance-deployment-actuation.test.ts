import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";

import {
  DEPLOY_MATERIAL_SCHEMA,
  DEPLOY_OPERATION,
  DEPLOYMENT_ACTUATION_TARGET_TYPE,
  DeploymentActuationAdapter,
} from "../kernel/adapters/deploymentActuation.ts";
import { MaterialIncomplete } from "../kernel/adapters/types.ts";
import { composeTargetAdapters, type KernelServiceConfig } from "../kernel/kernelService.ts";
import { makeHarness, PRINCIPALS } from "./support/harness.ts";

const REPO_ID = "repo-1";
const SHA = "0123456789abcdef0123456789abcdef01234567";

test("DEPLOY exposes the closed cadp.deploy.v1 operation without dispatch", async () => {
  const adapter = new DeploymentActuationAdapter(REPO_ID, () => true);
  const operation = adapter.describe().operations[0];
  assert.equal(operation.operation_kind, DEPLOY_OPERATION);
  assert.equal(operation.material_schema, DEPLOY_MATERIAL_SCHEMA);

  const valid = { repo_id: REPO_ID, sha: SHA, components: ["broker", "worker"] };
  await adapter.verify_material(DEPLOY_OPERATION, valid);

  for (const material of [
    { ...valid, surprise: true },
    { ...valid, components: [] },
    { ...valid, components: ["kernel"] },
    { ...valid, components: ["broker", "kernel"] },
  ]) {
    await assert.rejects(adapter.verify_material(DEPLOY_OPERATION, material), MaterialIncomplete);
  }

  // Item 1 has no process actuator: even calling the port directly cannot mutate a process.
  const before = process.pid;
  const result = await adapter.dispatch("effect", 1, {
    authority_ref: "deployment-control", target_type: "DEPLOYMENT", target_id: "cadp-v04-live",
  }, DEPLOY_OPERATION, valid);
  assert.equal(result.kind, "AMBIGUOUS");
  assert.equal(process.pid, before, "refused/unsupported material has process delta 0");
});

test("deployment describe availability requires fresh passing reach and immutability attestations", async () => {
  const h = await makeHarness();
  try {
    const tokenFile = `${h.dir}/github-token`;
    writeFileSync(tokenFile, "unused\n", "utf8");
    const config: KernelServiceConfig = {
      db_path: "unused", opa_dir: "unused", api_port: 0, root_port: 0,
      secret_dir: "unused", pep_ref: "pep", github: { repo_id: REPO_ID, repo_full_name: "o/r", token_file: tokenFile },
    };
    const available = () => composeTargetAdapters(config, h)
      .find((a) => a.describe().target_type === DEPLOYMENT_ACTUATION_TARGET_TYPE)!
      .describe().operations[0]!.available;

    assert.equal(available(), false);
    h.clock.now = Date.now() - 3_700_000;
    h.sealReach(false);
    h.ingress.submitEvidence({
      evidence_kind: "TARGET_IMMUTABILITY_ATTESTATION",
      subject_bindings: [{ authority_ref: "github.com", namespace: "GIT_REPOSITORY", object_id: REPO_ID }],
      availability: "PRESENT", claim_schema: "cadp.target-immutability.v1",
      claim: { write_once_enforced: true }, producer_ref: "deployment-control-target",
      source_ref: "github.com", source_relation: "TARGET_AUTHORITY_OBSERVATION",
    }, PRINCIPALS.depctlTarget);
    assert.equal(available(), false, "stale attestations do not open availability");
    h.clock.now = Date.now();
    h.sealReach(false);
    assert.equal(available(), false, "fresh reach cannot cure stale immutability evidence");
    h.ingress.submitEvidence({
      evidence_kind: "TARGET_IMMUTABILITY_ATTESTATION",
      subject_bindings: [{ authority_ref: "github.com", namespace: "GIT_REPOSITORY", object_id: REPO_ID }],
      availability: "PRESENT", claim_schema: "cadp.target-immutability.v1",
      claim: { write_once_enforced: true }, producer_ref: "deployment-control-target",
      source_ref: "github.com", source_relation: "TARGET_AUTHORITY_OBSERVATION",
    }, PRINCIPALS.depctlTarget);
    assert.equal(available(), true);
    h.sealReach(true);
    assert.equal(available(), false, "a fresh failing reach attestation closes availability");
  } finally { h.close(); }
});
