/**
 * Production composition-root conformance (TD §0/§11, #117 §5.1).
 *
 * The governed transition is only real if the DEPLOYED kernel can reach it. These controls assert
 * over `composeTargetAdapters` — the exact list `startKernelService` registers and probes — rather
 * than over the test harness's own registry, which can (and did) diverge from it.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { makeHarness, stopSharedOpa, PEP_REF, PRINCIPALS } from "./support/harness.ts";
import { composeTargetAdapters } from "../kernel/kernelService.ts";
import type { KernelServiceConfig } from "../kernel/kernelService.ts";
import { makeAdapterRegistry } from "../kernel/adapters/types.ts";
import { findingSealTargetRef, findingSealWorkBindings } from "../kernel/adapters/findingSeal.ts";
import { Pep } from "../kernel/pep.ts";
import {
  FINDING_SEAL_AUTHORITY_REF, FINDING_SEAL_OPERATION, FINDING_SEAL_TARGET_TYPE,
  GOVERNED_PRODUCER_REF, GOVERNED_TRANSITION_MATERIAL_SCHEMA,
} from "../product/improvement/transition.ts";
import { nextId } from "./support/transition.ts";

after(() => stopSharedOpa());

/**
 * A deployment with NO external target configured. `composeTargetAdapters` reads only the three
 * optional credential blocks, so the remaining fields are inert here — the point of the config is
 * precisely that the governed row must appear without any of them.
 */
const MINIMAL_CONFIG: KernelServiceConfig = {
  db_path: "unused-by-composition",
  opa_dir: "unused-by-composition",
  api_port: 0,
  root_port: 0,
  secret_dir: "unused-by-composition",
  pep_ref: PEP_REF,
};

test("FC22: the production composition root registers the governed FINDING_SEAL target", async () => {
  const h = await makeHarness();
  try {
    const registry = makeAdapterRegistry(composeTargetAdapters(MINIMAL_CONFIG, h));
    const adapter = registry.byTarget(findingSealTargetRef());
    assert.ok(adapter !== undefined, "a deployed kernel must resolve an adapter for the EVIDENCE_SEAL target");

    const described = adapter.describe();
    assert.equal(described.target_type, FINDING_SEAL_TARGET_TYPE);
    assert.equal(described.authority_ref, FINDING_SEAL_AUTHORITY_REF);
    const operation = described.operations.find((o) => o.operation_kind === FINDING_SEAL_OPERATION);
    assert.ok(operation !== undefined, "the governed row must declare the FINDING_SEAL operation");
    assert.equal(operation.material_schema, GOVERNED_TRANSITION_MATERIAL_SCHEMA);
    assert.equal(operation.available, true);
  } finally { h.close(); }
});

test("FC22: the governed row is always-on — no external credential block gates it", async () => {
  const h = await makeHarness();
  try {
    const governedRows = (config: KernelServiceConfig) =>
      composeTargetAdapters(config, h).filter((a) => a.describe().target_type === FINDING_SEAL_TARGET_TYPE);
    // Exactly one row, with or without the optional blocks: never absent, never duplicated.
    assert.equal(governedRows(MINIMAL_CONFIG).length, 1);
    assert.equal(governedRows({ ...MINIMAL_CONFIG, temporal: { address: "localhost:7233", namespace: "cadp", horizon_s: 60 } }).length, 1);
    assert.equal(governedRows({ ...MINIMAL_CONFIG, record: { base_url: "https://record.invalid" } }).length, 1);
  } finally { h.close(); }
});

test("FC22: the startKernelService identity probe covers the governed adapter", async () => {
  const h = await makeHarness();
  try {
    // The probe loop body from `startKernelService`, run over the production list.
    for (const adapter of composeTargetAdapters(MINIMAL_CONFIG, h)) {
      await h.pep.refreshTargetIdentity(adapter);
    }
    const ref = findingSealTargetRef();
    const sealed = h.store.latestEvidenceOfKind(
      "PEP_TARGET_IDENTITY",
      `${ref.authority_ref}|${ref.target_type}|${ref.target_id}`,
    );
    assert.ok(sealed !== undefined, "recheck #9 refuses admissions to a target with no fresh identity evidence");
    const claim = sealed.claim as { target_id?: string; governed_producer_ref?: string };
    assert.equal(claim.target_id, ref.target_id);
    assert.equal(claim.governed_producer_ref, GOVERNED_PRODUCER_REF);
  } finally { h.close(); }
});

test("FC22 guard bite: dropping the governed row reproduces NO_ADAPTER_FOR_TARGET", async () => {
  const h = await makeHarness();
  try {
    // A real sealed governed-transition effect request. The adapter lookup in `admitAndDispatch`
    // precedes every decision and material read, so this is enough to exercise the composition.
    const effect_id = h.ingress.allocateEffectId({
      schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
      step_ordinal: nextId(), purpose: "finding-seal",
    });
    const material_ref = h.ingress.putBlob(
      Buffer.from(JSON.stringify({ schema: GOVERNED_TRANSITION_MATERIAL_SCHEMA, idempotency_key: `cadp-v04:${effect_id}` }), "utf8"),
    );
    h.ingress.sealEffectRequest(
      {
        effect_id, requester_ref: "workflow:cadp-work",
        work_bindings: findingSealWorkBindings("cadp-v04:evidence:predecessor", "cadp-v04:effect:00000000-0000-7000-8000-000000000000"),
        target_ref: findingSealTargetRef(),
        operation_kind: FINDING_SEAL_OPERATION,
        material_schema: GOVERNED_TRANSITION_MATERIAL_SCHEMA,
        material_ref, prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    );

    const production = composeTargetAdapters(MINIMAL_CONFIG, h);
    const bitten = production.filter((a) => a.describe().target_type !== FINDING_SEAL_TARGET_TYPE);

    // The exact pre-repair defect: a deployed kernel could not reach the governed path at all.
    const withoutRow = new Pep(h.store, h.cas, h.ingress, makeAdapterRegistry(bitten), PEP_REF);
    const refused = await withoutRow.admitAndDispatch(effect_id, "cadp-v04:decision:unused");
    assert.equal(refused.kind, "REFUSAL");
    assert.equal((refused as { reason?: string }).reason, "NO_ADAPTER_FOR_TARGET");

    // With the production composition the target resolves, so admission proceeds past the lookup
    // and any refusal is a policy/decision outcome — never a missing-adapter one.
    const withRow = new Pep(h.store, h.cas, h.ingress, makeAdapterRegistry(production), PEP_REF);
    const admitted = await withRow.admitAndDispatch(effect_id, "cadp-v04:decision:unused");
    assert.notEqual((admitted as { reason?: string }).reason, "NO_ADAPTER_FOR_TARGET");
  } finally { h.close(); }
});
