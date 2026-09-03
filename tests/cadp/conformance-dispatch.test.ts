/**
 * TD §13.1 — C9/C9b (ambiguity + no blind retry, NONE vs NATIVE_KEY), C16 (unsupported
 * constraint), C25/C34 (Temporal horizon + receipt provenance), C36 (pre-K6 refusal
 * succession). C9 carries its guard-bite (removing #12 mints the duplicate).
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { makeHarness, runChain, sealScriptedRequest, stopSharedOpa } from "./support/harness.ts";
import { REFERENCE_REGO } from "../../cadp/deployment/referencePolicy.ts";
import { TemporalAdapter } from "../../cadp/kernel/adapters/temporal.ts";
import type { TemporalTransport } from "../../cadp/kernel/adapters/temporal.ts";
import { jcsDigest } from "../../cadp/kernel/canonical.ts";

after(() => stopSharedOpa());

test("C9: ambiguous accepted call → UNKNOWN; blind retry refused; reconcile → COMMITTED; delta 1; guard-bite mints delta 2", async () => {
  for (const biteMode of [false, true]) {
    const h = await makeHarness(biteMode ? { disabledChecks: new Set(["recheck12_ordinal"]) } : {});
    try {
      h.sealReach();
      await h.sealTargetIdentity();
      const { request, material } = sealScriptedRequest(h);
      // Injection: the server accepted and applied the write, but the response was lost.
      h.target.onDispatch = (effect_id, _ordinal, mat) => {
        h.target.commitSilently(effect_id, mat);
        return { kind: "AMBIGUOUS", raw_observation: "timeout after server accept (injected)" };
      };
      const first = await runChain(h, request.effect_id);
      assert.ok(first.admitted?.kind === "ADMITTED");
      assert.equal(first.admitted?.kind === "ADMITTED" ? first.admitted.outcome.result : "", "UNKNOWN", "immediate UNKNOWN");

      // Orchestrator requests admission again (the #89 AMB1 blind retry).
      const input2 = h.ingress.assembleAdmissionInput(request.effect_id, []);
      const evaluated2 = await h.evaluate(input2.input_digest.value);
      if (evaluated2.kind !== "DECISION") throw new Error("expected decision");
      const second = await h.pep.admitAndDispatch(request.effect_id, evaluated2.decision.decision_id);
      if (biteMode) {
        assert.equal(second.kind, "ADMITTED", "guard-bite: with #12 removed the blind retry is admitted");
        assert.equal(h.target.effects.length, 2, "guard-bite: duplicate external effect minted (delta 2)");
      } else {
        assert.ok(second.kind === "REFUSAL" && second.reason === "PRIOR_DISPATCH_UNRESOLVED", JSON.stringify(second));
        // Reconciliation resolves from the target, not from a retry.
        h.target.onDispatch = undefined;
        await h.reconciler.reconcileEffect(request.effect_id);
        const outcomes = h.store.outcomesByEffect(request.effect_id);
        assert.ok(outcomes.some((o) => o.result === "COMMITTED"), "reconcile finds the applied write");
        assert.equal(h.target.effects.length, 1, "external effect delta exactly 1");
        assert.equal(h.target.committed.get(request.effect_id)!["body_digest"], material["body_digest"]);
      }
    } finally {
      h.close();
    }
  }
});

test("C9b: NATIVE_KEY — second ordinal admitted after fresh recheck; target deduplicates; record delta 1", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h, { operation_kind: "SCRIPTED_KEYED_WRITE" });
    h.target.onDispatch = (effect_id, _ordinal, mat) => {
      h.target.commitSilently(effect_id, mat);
      return { kind: "AMBIGUOUS", raw_observation: "timeout after server accept (injected)" };
    };
    const first = await runChain(h, request.effect_id);
    assert.equal(first.admitted?.kind === "ADMITTED" ? first.admitted.outcome.result : "", "UNKNOWN");

    // NATIVE_KEY (proven, within horizon): the next ordinal IS admissible; the target dedups.
    h.target.onDispatch = undefined;
    const input2 = h.ingress.assembleAdmissionInput(request.effect_id, []);
    const evaluated2 = await h.evaluate(input2.input_digest.value);
    if (evaluated2.kind !== "DECISION") throw new Error("expected decision");
    const second = await h.pep.admitAndDispatch(request.effect_id, evaluated2.decision.decision_id);
    assert.equal(second.kind, "ADMITTED", JSON.stringify(second));
    assert.equal(second.kind === "ADMITTED" ? second.outcome.result : "", "COMMITTED");
    assert.equal(second.kind === "ADMITTED" ? second.admission.dispatch_ordinal : 0, 2);
    assert.equal(h.target.effects.length, 1, "record count 1 — the key deduplicated the retry");
  } finally {
    h.close();
  }
});

test("C16: an unsupported constraint fails closed with an incident and no admission", async () => {
  const rego = REFERENCE_REGO.replace(
    "# ---------------------------------------------------------------- constraints",
    `# ---------------------------------------------------------------- constraints

constraints contains {"kind": "FOO", "args": [1]} if op == "SCRIPTED_WRITE"
`,
  );
  const h = await makeHarness({ rego });
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h);
    const { evaluated, admitted } = await runChain(h, request.effect_id);
    assert.equal(evaluated.kind, "DECISION");
    assert.ok(admitted?.kind === "REFUSAL" && admitted.reason === "UNSUPPORTED_CONSTRAINT", JSON.stringify(admitted));
    assert.equal(h.store.admissionsByEffect(request.effect_id).length, 0);
    assert.ok(h.store.openIncidents().some((i) => (i.claim as { incident_kind?: string })?.incident_kind === "UNSUPPORTED_CONSTRAINT"));
  } finally {
    h.close();
  }
});

test("C36: a pre-K6 precondition refusal is not an effect; successors must not cite it", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    // PEP_READ_THEN_ACT requires a fresh immutability attestation (#14).
    const { PRINCIPALS } = await import("./support/harness.ts");
    h.ingress.submitEvidence(
      {
        evidence_kind: "TARGET_IMMUTABILITY_ATTESTATION",
        subject_bindings: [{ authority_ref: "scripted:target", namespace: "SCRIPTED", object_id: "scripted-1" }],
        availability: "PRESENT",
        claim_schema: "cadp.target-immutability.v1",
        claim: { write_once_enforced: true, ruleset: "scripted", negative_probe: "rejected" },
        producer_ref: "deployment-control-target",
        source_ref: "scripted:target",
        source_relation: "TARGET_AUTHORITY_OBSERVATION",
      },
      PRINCIPALS.depctlTarget,
    );
    const refusedReq = sealScriptedRequest(h, { operation_kind: "SCRIPTED_GUARDED_WRITE", body: "will-be-stale" });
    h.target.onPreconditionRead = () => "subject moved: bound rev-a, observed rev-b";
    const refused = await runChain(h, refusedReq.request.effect_id);
    assert.ok(refused.admitted?.kind === "REFUSAL" && refused.admitted.reason === "DISPATCH_PRECONDITION_FAILED");
    assert.equal(h.store.admissionsByEffect(refusedReq.request.effect_id).length, 0, "no K6");
    assert.equal(h.store.outcomesByEffect(refusedReq.request.effect_id).length, 0, "no K7");
    h.target.onPreconditionRead = undefined;

    // (b) successor naming the refused request in prior_effect_refs → PRIOR_REF_NOT_AN_EFFECT.
    const bad = sealScriptedRequest(h, { body: "successor-bad", prior_effect_refs: [refusedReq.request.effect_id] });
    const badResult = await runChain(h, bad.request.effect_id);
    assert.ok(badResult.admitted?.kind === "REFUSAL" && badResult.admitted.reason === "PRIOR_REF_NOT_AN_EFFECT", JSON.stringify(badResult.admitted));

    // (a) successor without prior refs → admitted normally.
    const good = sealScriptedRequest(h, { body: "successor-good" });
    const goodResult = await runChain(h, good.request.effect_id);
    assert.equal(goodResult.admitted?.kind, "ADMITTED");
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------- Temporal (scripted transport)

function scriptedTemporal(state: {
  executions: Map<string, { run_id: string; memo: Record<string, unknown>; status: string }>;
  failDescribe?: boolean;
}): TemporalTransport {
  return {
    async describeNamespace() {
      return { namespace_id: "ns-scripted", retention_s: 3600 };
    },
    async start(input) {
      const existing = state.executions.get(input.workflow_id);
      if (existing !== undefined) return { kind: "already_started" };
      state.executions.set(input.workflow_id, { run_id: `run-${state.executions.size + 1}`, memo: input.memo, status: "RUNNING" });
      return { kind: "started", run_id: state.executions.get(input.workflow_id)!.run_id };
    },
    async describe(workflow_id) {
      if (state.failDescribe === true) return { kind: "ambiguous", detail: "describe outage (injected)" };
      const found = state.executions.get(workflow_id);
      return found === undefined ? { kind: "not_found" } : { kind: "found", ...found };
    },
  };
}

test("C34: COMMITTED only from a target-returned memo; describe outage → UNKNOWN; foreign memo → never COMMITTED", async () => {
  const h = await makeHarness();
  try {
    const state = { executions: new Map<string, { run_id: string; memo: Record<string, unknown>; status: string }>(), failDescribe: false };
    const adapter = new TemporalAdapter(scriptedTemporal(state), h.cas, "cadp-v04", 3600);
    const args = { work: "test" };
    const argsBytes = Buffer.from(JSON.stringify(args), "utf8");
    const args_cas_key = h.cas.put(argsBytes);
    const args_digest = jcsDigest(args).value;
    const effect_id = "cadp-v04:effect:00000000-0000-7000-8000-00000000c034";
    const material = { workflow_id: `cadp-work-${effect_id}`, workflow_type: "cadpWork", task_queue: "q", args_cas_key, args_digest };
    const target = { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: "ns-scripted" };

    // Start succeeds but Describe fails → AMBIGUOUS (→ UNKNOWN at the PEP), never COMMITTED.
    state.failDescribe = true;
    const ambiguous = await adapter.dispatch(effect_id, 1, target, "WORK_START", material);
    assert.equal(ambiguous.kind, "AMBIGUOUS");

    // Describe healthy + matching memo → ACCEPTED with the TARGET-returned memo.
    state.failDescribe = false;
    const reconciled = await adapter.reconcile(effect_id, 1, target, "WORK_START", material, { admitted_at: new Date().toISOString() });
    assert.equal(reconciled.kind, "COMMITTED");
    assert.ok(adapter.receipt_binds("WORK_START", material, (reconciled as { receipt_claim: Record<string, unknown> }).receipt_claim));

    // Same workflow id occupied by ANOTHER effect's memo: receipt must NOT bind.
    state.executions.set(material.workflow_id, {
      run_id: "run-x",
      memo: { cadp_effect_id: "cadp-v04:effect:00000000-0000-7000-8000-00000000dead", cadp_args_digest: "0".repeat(64) },
      status: "RUNNING",
    });
    const foreign = await adapter.reconcile(effect_id, 1, target, "WORK_START", material, { admitted_at: new Date().toISOString() });
    assert.equal(foreign.kind, "COMMITTED", "adapter surfaces the found execution");
    assert.equal(
      adapter.receipt_binds("WORK_START", material, (foreign as { receipt_claim: Record<string, unknown> }).receipt_claim),
      false,
      "…but the receipt does not bind → PEP writes UNKNOWN(RECEIPT_UNBOUND) + RECEIPT_MATERIAL_MISMATCH",
    );
  } finally {
    h.close();
  }
});

test("C25: outside the retention horizon NOT_FOUND is UNKNOWN(RETENTION_EXPIRED), inside it is authoritative", async () => {
  const h = await makeHarness();
  try {
    const state = { executions: new Map<string, { run_id: string; memo: Record<string, unknown>; status: string }>() };
    const adapter = new TemporalAdapter(scriptedTemporal(state), h.cas, "cadp-v04", 60); // 60s horizon
    const args = { work: "test" };
    const args_cas_key = h.cas.put(Buffer.from(JSON.stringify(args), "utf8"));
    const material = {
      workflow_id: "cadp-work-cadp-v04:effect:00000000-0000-7000-8000-00000000c025",
      workflow_type: "cadpWork", task_queue: "q", args_cas_key, args_digest: jcsDigest(args).value,
    };
    const target = { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: "ns-scripted" };
    const effect = "cadp-v04:effect:00000000-0000-7000-8000-00000000c025";

    const inside = await adapter.reconcile(effect, 1, target, "WORK_START", material, { admitted_at: new Date().toISOString() });
    assert.equal(inside.kind, "NO_EFFECT_CONFIRMED", "inside horizon: Temporal's NOT_FOUND is authoritative");

    const outside = await adapter.reconcile(effect, 1, target, "WORK_START", material, {
      admitted_at: new Date(Date.now() - 120_000).toISOString(),
    });
    assert.equal(outside.kind, "UNKNOWN");
    assert.equal((outside as { unknown_reason: string }).unknown_reason, "RETENTION_EXPIRED");

    // Kernel side: a COMMITTED effect never admits a next ordinal regardless of Temporal state.
    h.sealReach();
    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h, { operation_kind: "SCRIPTED_KEYED_WRITE" });
    const first = await runChain(h, request.effect_id);
    assert.equal(first.admitted?.kind === "ADMITTED" ? first.admitted.outcome.result : "", "COMMITTED");
    const input2 = h.ingress.assembleAdmissionInput(request.effect_id, []);
    const evaluated2 = await h.evaluate(input2.input_digest.value);
    if (evaluated2.kind !== "DECISION") throw new Error("expected decision");
    const second = await h.pep.admitAndDispatch(request.effect_id, evaluated2.decision.decision_id);
    assert.ok(second.kind === "REFUSAL" && second.reason === "EFFECT_ALREADY_COMMITTED", JSON.stringify(second));
  } finally {
    h.close();
  }
});
