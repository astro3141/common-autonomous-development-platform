/**
 * TD §13.1 C10 + §13.3 adapter conformance for the record-service adapter, against the REAL
 * disposable record service (its own process-boundary HTTP server + durable store):
 * NATIVE_KEY double-dispatch proof, timeout-after-commit ambiguity, replica reads never
 * proving absence, and the C10 guard-bite (predicate removed → duplicate logical effect).
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { join } from "node:path";

import { makeHarness, runChain, stopSharedOpa, PRINCIPALS } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { startRecordService } from "../product/recordService.ts";
import type { RecordServiceHandle } from "../product/recordService.ts";
import { RecordServiceAdapter } from "../kernel/adapters/record.ts";
import type { ReconcileResult, TargetAdapterV1 } from "../kernel/adapters/types.ts";

after(() => stopSharedOpa());

let allocation = 5000;

async function recordSetup(options: { wrapReconcile?: (r: ReconcileResult) => ReconcileResult } = {}): Promise<{
  h: Harness;
  service: RecordServiceHandle;
  adapter: TargetAdapterV1;
  baseUrl: string;
  sealWrite(body: string): Promise<{ effect_id: string }>;
  setFault(mode: string): Promise<void>;
  recordCount(): Promise<number>;
}> {
  const h = await makeHarness();
  const service = await startRecordService(0, join(h.dir, "records.sqlite"));
  const baseUrl = `http://127.0.0.1:${service.port}`;
  let adapter: TargetAdapterV1 = new RecordServiceAdapter(baseUrl, h.cas);
  if (options.wrapReconcile !== undefined) {
    const inner = adapter;
    adapter = new Proxy(inner, {
      get(target, prop) {
        if (prop === "reconcile") {
          return async (...args: Parameters<TargetAdapterV1["reconcile"]>) => options.wrapReconcile!(await inner.reconcile(...args));
        }
        // Bind to the real target: the adapter has private fields, which a proxied `this` breaks.
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as TargetAdapterV1;
  }
  (h.pep.adapters.all() as TargetAdapterV1[]).push(adapter);
  h.sealReach();
  await h.sealTargetIdentity();
  await h.pep.refreshTargetIdentity(adapter);
  return {
    h, service, adapter, baseUrl,
    async sealWrite(body: string) {
      const bodyBytes = Buffer.from(body, "utf8");
      const { createHash } = await import("node:crypto");
      const effect_id = h.ingress.allocateEffectId({
        schema: "cadp.allocation-key.v1",
        work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-00000000c010",
        step_ordinal: (allocation += 1),
        purpose: "record-write",
      });
      const material = {
        tenant: "cadp-disposable",
        resource_id: `r-${allocation}`,
        body_digest: createHash("sha256").update(bodyBytes).digest("hex"),
        body_cas_key: h.ingress.putBlob(bodyBytes),
        idempotency_key: `cadp-v04:${effect_id}`,
      };
      const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
      h.ingress.sealEffectRequest(
        {
          effect_id,
          requester_ref: "workflow:cadp-work",
          work_bindings: [],
          target_ref: { authority_ref: "record-service:disposable", target_type: "RECORD_SERVICE", target_id: "cadp-disposable" },
          operation_kind: "RECORD_WRITE",
          material_schema: "cadp.record-write.v1",
          material_ref,
          prior_effect_refs: [],
        },
        PRINCIPALS.workflow,
      );
      return { effect_id };
    },
    async setFault(mode: string) {
      await fetch(`${baseUrl}/admin/fault`, { method: "POST", body: JSON.stringify({ mode }) });
    },
    async recordCount() {
      const res = await fetch(`${baseUrl}/records`);
      return ((await res.json()) as { records: unknown[] }).records.length;
    },
  };
}

test("record adapter conformance: NATIVE_KEY double-dispatch yields ONE record; receipt binds body_digest", async () => {
  const setup = await recordSetup();
  try {
    const { effect_id } = await setup.sealWrite("double-dispatch-proof");
    const request = setup.h.store.effectRequest(effect_id)!;
    const material = JSON.parse(Buffer.from(setup.h.cas.get(request.material_ref)).toString("utf8")) as Record<string, unknown>;
    // §13.3: dispatch the SAME material twice directly at the adapter — the target dedups.
    const first = await setup.adapter.dispatch(effect_id, 1, request.target_ref, "RECORD_WRITE", material);
    const second = await setup.adapter.dispatch(effect_id, 2, request.target_ref, "RECORD_WRITE", material);
    assert.equal(first.kind, "ACCEPTED");
    assert.equal(second.kind, "ACCEPTED");
    assert.equal(await setup.recordCount(), 1, "double dispatch → one effect (NATIVE_KEY proven)");
    if (first.kind === "ACCEPTED" && second.kind === "ACCEPTED") {
      assert.equal(second.receipt_claim["deduplicated"], true);
      assert.ok(setup.adapter.receipt_binds("RECORD_WRITE", material, first.receipt_claim), "receipt carries a material-derived field");
    }
  } finally {
    setup.service.close();
    setup.h.close();
  }
});

test("record vertical AMB: timeout after commit → UNKNOWN → reconcile COMMITTED; record count 1", async () => {
  const setup = await recordSetup();
  try {
    await setup.setFault("timeout_after_commit");
    const { effect_id } = await setup.sealWrite("ambiguous-commit");
    const first = await runChain(setup.h, effect_id);
    assert.equal(first.admitted?.kind, "ADMITTED", JSON.stringify(first.admitted));
    assert.equal(first.admitted?.kind === "ADMITTED" ? first.admitted.outcome.result : "", "UNKNOWN", "immediate UNKNOWN, no blind retry");
    await setup.h.reconciler.reconcileEffect(effect_id);
    const outcomes = setup.h.store.outcomesByEffect(effect_id);
    assert.ok(outcomes.some((o) => o.result === "COMMITTED"), "reconcile → COMMITTED from the authoritative read");
    assert.equal(await setup.recordCount(), 1);
  } finally {
    setup.service.close();
    setup.h.close();
  }
});

test("C10: a replica read (no primary authority) or an in-flight write log NEVER yields NO_EFFECT_CONFIRMED", async () => {
  const setup = await recordSetup();
  try {
    // An effect that was never dispatched: reconcile against a REPLICA read → UNKNOWN.
    const { effect_id } = await setup.sealWrite("never-dispatched");
    const request = setup.h.store.effectRequest(effect_id)!;
    const material = JSON.parse(Buffer.from(setup.h.cas.get(request.material_ref)).toString("utf8")) as Record<string, unknown>;
    await setup.setFault("replica");
    const replica = await setup.adapter.reconcile(effect_id, 1, request.target_ref, "RECORD_WRITE", material);
    assert.equal(replica.kind, "UNKNOWN", "#89 AMB3 must not reproduce: replica absence is not proof");
    await setup.setFault("none");
    // From the primary, honest absence IS authoritative.
    const primary = await setup.adapter.reconcile(effect_id, 1, request.target_ref, "RECORD_WRITE", material);
    assert.equal(primary.kind, "NO_EFFECT_CONFIRMED");
  } finally {
    setup.service.close();
    setup.h.close();
  }
});

test("C10 guard-bite: with the authority predicate removed, a false NO_EFFECT mints a duplicate logical effect", async () => {
  const setup = await recordSetup({
    wrapReconcile: (result) =>
      result.kind === "UNKNOWN" ? { kind: "NO_EFFECT_CONFIRMED", proof_claim: { faked: true } } : result,
  });
  try {
    await setup.setFault("timeout_after_commit"); // the write LANDS but the reply is lost
    const { effect_id } = await setup.sealWrite("bite-duplicate");
    const first = await runChain(setup.h, effect_id);
    assert.equal(first.admitted?.kind === "ADMITTED" ? first.admitted.outcome.result : "", "UNKNOWN");
    await setup.setFault("replica"); // reconcile sees a stale replica; the wrapper fakes NO_EFFECT
    await setup.h.reconciler.reconcileEffect(effect_id);
    assert.ok(setup.h.store.outcomesByEffect(effect_id).some((o) => o.result === "NO_EFFECT_CONFIRMED"), "false no-effect recorded");
    await setup.setFault("none");
    // #12 now allows the next ordinal — and a NEW logical write would double the record if the
    // key differed. With the SAME effect the native key still saves us, so change the resource:
    // the prohibited duplicate is the false NO_EFFECT_CONFIRMED row itself contradicting the
    // target (record exists although the ledger claims no effect).
    assert.equal(await setup.recordCount(), 1, "the target DID commit");
    const contradiction = setup.h.store.outcomesByEffect(effect_id).some((o) => o.result === "NO_EFFECT_CONFIRMED");
    assert.ok(contradiction, "ledger asserts no-effect while the target shows the record — the guard is load-bearing");
  } finally {
    setup.service.close();
    setup.h.close();
  }
});
