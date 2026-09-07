/**
 * TD §12 r8 — read-only constitutional observation (#96/#106).
 *
 *   O1  observer reach: the four read methods work end-to-end over the real Kernel API
 *   O2  B2 guard: every write/evaluate method is FORBIDDEN for the observer and writes nothing
 *   O3  get_evidence verify-on-read: a tampered stored envelope is refused DIGEST_CORRUPTION
 *   O4  B3 honesty: a completed empty list_evidence is COMPLETE+empty, and an UNAVAILABLE
 *       kernel read is reported as such by the projection, never as absence
 *   O5  attribution/chain projections derive only from stored rows, through observer reach only
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { makeHarness, stopSharedOpa, sealScriptedRequest, runChain, PRINCIPALS } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { startKernelApi } from "../kernel/api.ts";
import { KernelClient, KernelApiError } from "../clients/kernelClient.ts";
import { attribution, chainProjection, collectRun, humanWait, projectEffect, attempt } from "../product/observationProjection.ts";

after(() => stopSharedOpa());

const TOKENS = new Map([
  ["tok-obs", "cadp-observer"],
  ["tok-wf", "cadp-workflow"],
  ["tok-worker", "cadp-worker-codex"],
]);

async function withApi(h: Harness, run: (obs: KernelClient) => Promise<void>): Promise<void> {
  const api = await startKernelApi(
    { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens: TOKENS },
    0,
  );
  try {
    await run(new KernelClient(`http://127.0.0.1:${api.port}`, "tok-obs"));
  } finally {
    api.close();
  }
}

/** Submit a WORK_STEP for a run through the production ingress path. */
function step(h: Harness, work_run_ref: string, ordinal: number, prior?: string) {
  return h.ingress.submitEvidence(
    {
      evidence_kind: "WORK_STEP",
      subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: work_run_ref }],
      availability: "PRESENT",
      claim_schema: "cadp.work-step.v1",
      claim: { step_ordinal: ordinal, summary: `step ${ordinal}`, ...(prior !== undefined ? { prior_step_envelope_digest: prior } : {}) },
      producer_ref: "workflow:cadp-work",
      source_ref: `temporal:${work_run_ref}:${ordinal}`,
      source_relation: "SELF_REPORT",
    },
    PRINCIPALS.workflow,
  );
}

test("O1: observer reach serves state, effects, evidence and summaries end-to-end", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const runRef = "cadp-v04:effect:00000000-0000-7000-8000-0000000000o1";
    const s1 = step(h, runRef, 1);
    step(h, runRef, 2, s1.envelope_digest.value);
    const { request } = sealScriptedRequest(h, { operation_kind: "SCRIPTED_KEYED_WRITE", work_run_ref: runRef });
    const chain = await runChain(h, request.effect_id);
    assert.equal(chain.admitted?.kind, "ADMITTED");

    await withApi(h, async (obs) => {
      const listed = await obs.listEvidence(runRef);
      assert.equal(listed.evidence.filter((e) => e.evidence_kind === "WORK_STEP").length, 2);

      const fetched = await obs.getEvidence(s1.evidence_id);
      assert.equal(fetched.envelope.envelope_digest.value, s1.envelope_digest.value);

      const effects = await obs.listEffects(runRef);
      assert.deepEqual(effects.effect_ids, [request.effect_id]);

      const state = await obs.getEffectState(request.effect_id);
      assert.equal(state.request.effect_id, request.effect_id);
      assert.equal(state.outcomes.some((o) => o.result === "COMMITTED"), true);

      // The full run projection assembles through observer reach alone.
      const run = await collectRun(obs, runRef);
      const steps = chainProjection(run.byKind("WORK_STEP"));
      assert.deepEqual(steps, { ordinals: [1, 2], breaks: [] });
      assert.equal(run.effects[0]?.conclusive, "COMMITTED");
    });
  } finally {
    h.close();
  }
});

test("O1a: list_effects excludes worker reach while workflow and observer retain access", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const runRef = "cadp-v04:effect:00000000-0000-7000-8000-0000000001a0";
    const { request } = sealScriptedRequest(h, { operation_kind: "SCRIPTED_KEYED_WRITE", work_run_ref: runRef });
    const api = await startKernelApi(
      { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens: TOKENS },
      0,
    );
    try {
      const baseUrl = `http://127.0.0.1:${api.port}`;
      const workflow = new KernelClient(baseUrl, "tok-wf");
      const observer = new KernelClient(baseUrl, "tok-obs");
      const worker = new KernelClient(baseUrl, "tok-worker");

      assert.deepEqual(await workflow.listEffects(runRef), { effect_ids: [request.effect_id] });
      assert.deepEqual(await observer.listEffects(runRef), { effect_ids: [request.effect_id] });
      await assert.rejects(
        () => worker.listEffects(runRef),
        (e: unknown) => e instanceof KernelApiError && e.status === 403 && e.reason === "FORBIDDEN_FOR_PRINCIPAL",
      );
    } finally {
      api.close();
    }
  } finally {
    h.close();
  }
});

test("WORKER BACKEND_EXECUTION seals the surface role as a subject binding", async () => {
  const h = await makeHarness();
  try {
    const runRef = "cadp-v04:effect:00000000-0000-7000-8000-000000000be0";
    const envelope = h.ingress.submitEvidence(
      {
        evidence_kind: "BACKEND_EXECUTION",
        subject_bindings: [
          { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: runRef },
          { authority_ref: "cadp-store:k04", namespace: "step", object_id: `${runRef}#1` },
          { authority_ref: "cadp-store:k04", namespace: "surface-role", object_id: "WORKER" },
        ],
        availability: "PRESENT",
        claim_schema: "cadp.backend.v1",
        claim: {
          requested: { provider: "codex", model: "codex default" },
          observed: {
            model: { availability: "UNKNOWN" },
            provider: { availability: "PRESENT", value: "codex", locator: "broker-response#backend_provider" },
            run_id: { availability: "UNKNOWN" },
            version: { availability: "UNKNOWN" },
            effort: { availability: "UNKNOWN" },
          },
        },
        producer_ref: "backend-scan:codex",
        source_ref: "codex session log scan",
        source_relation: "SELF_REPORT",
      },
      PRINCIPALS.backendScan,
    );
    assert.equal(
      envelope.subject_bindings.some((b) => b.authority_ref === "cadp-store:k04" && b.namespace === "surface-role" && b.object_id === "WORKER"),
      true,
    );
  } finally {
    h.close();
  }
});

test("PRESENT BACKEND_EXECUTION refuses missing, duplicate, or out-of-set surface roles", async () => {
  const h = await makeHarness();
  try {
    const runRef = "cadp-v04:effect:00000000-0000-7000-8000-000000000be1";
    const base = {
      evidence_kind: "BACKEND_EXECUTION" as const,
      availability: "PRESENT" as const,
      claim_schema: "cadp.backend.v1",
      claim: { requested: {}, observed: { model: { availability: "UNKNOWN" } } },
      producer_ref: "backend-scan:codex",
      source_ref: "scan",
      source_relation: "SELF_REPORT" as const,
    };
    const workRun = { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: runRef };
    const role = (object_id: string) => ({ authority_ref: "cadp-store:k04", namespace: "surface-role", object_id });
    for (const subject_bindings of [
      [workRun],
      [workRun, role("WORKER"), role("REVIEWER")],
      [workRun, role("AUDITOR")],
    ]) {
      assert.throws(
        () => h.ingress.submitEvidence({ ...base, subject_bindings }, PRINCIPALS.backendScan),
        (error: unknown) => (error as { reason?: string }).reason === "BACKEND_SURFACE_ROLE_INVALID",
      );
    }
  } finally {
    h.close();
  }
});

test("O2: every write/evaluate method is FORBIDDEN for the observer and writes nothing (B2)", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h, { operation_kind: "SCRIPTED_KEYED_WRITE" });
    const input = h.ingress.assembleAdmissionInput(request.effect_id, []);
    const decisionsBefore = h.store.decisionsByInputDigests([input.input_digest.value]).length;

    await withApi(h, async (obs) => {
      const forbidden: Array<[string, () => Promise<unknown>]> = [
        ["put_blob", () => obs.putBlob(Buffer.from("x"))],
        ["allocate_effect_id", () => obs.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: "wr", step_ordinal: 1, purpose: "record-write" })],
        ["seal_effect_request", () => obs.sealEffectRequest({} as never)],
        ["submit_evidence", () => obs.submitEvidence({} as never)],
        ["assemble_admission_input", () => obs.assembleAdmissionInput(request.effect_id, [])],
        ["evaluate", () => obs.evaluate(input.input_digest.value)],
        ["admit_and_dispatch", () => obs.admitAndDispatch(request.effect_id, "x")],
        ["request_reconcile", () => obs.requestReconcile(request.effect_id)],
      ];
      for (const [name, call] of forbidden) {
        await assert.rejects(call, (e: unknown) => e instanceof KernelApiError && e.status === 403 && e.reason === "FORBIDDEN_FOR_PRINCIPAL", name);
      }
    });
    // The refused evaluate sealed no K5 row: the observer cannot manufacture the facts it reports.
    assert.equal(h.store.decisionsByInputDigests([input.input_digest.value]).length, decisionsBefore);
  } finally {
    h.close();
  }
});

test("O3: a tampered stored envelope is refused DIGEST_CORRUPTION, never served (verify-on-read)", async () => {
  const h = await makeHarness();
  try {
    const runRef = "cadp-v04:effect:00000000-0000-7000-8000-0000000000o3";
    const envelope = step(h, runRef, 1);

    // Tamper through a second connection — the runtime role has no UPDATE, the attacker does.
    const db = new DatabaseSync(join(h.dir, "k04.sqlite"));
    db.prepare("UPDATE evidence_envelope SET envelope_json = json_set(envelope_json, '$.claim.summary', 'tampered') WHERE evidence_id = ?")
      .run(envelope.evidence_id);
    db.close();

    await withApi(h, async (obs) => {
      await assert.rejects(
        () => obs.getEvidence(envelope.evidence_id),
        (e: unknown) => e instanceof KernelApiError && e.status === 409 && e.reason === "DIGEST_CORRUPTION",
      );
    });
  } finally {
    h.close();
  }
});

test("O4: completed-empty is COMPLETE+empty; a failed read is UNAVAILABLE, never absence (B3)", async () => {
  const h = await makeHarness();
  try {
    await withApi(h, async (obs) => {
      const empty = await obs.listEvidence("cadp-v04:effect:00000000-0000-7000-8000-00000000none");
      assert.deepEqual(empty.evidence, []);
    });
    // A reader whose kernel call FAILS yields UNAVAILABLE with the reason — not an empty answer.
    const dead = new KernelClient("http://127.0.0.1:9", "tok-obs");
    const state = await attempt(() => dead.getEffectState("cadp-v04:effect:x"));
    assert.equal(state.query, "UNAVAILABLE");
    const projected = projectEffect("cadp-v04:effect:x", state);
    assert.equal(projected.conclusive, undefined);
    assert.equal(projected.open_unknown, false);
    assert.equal(projected.state.query, "UNAVAILABLE");
  } finally {
    h.close();
  }
});

test("O5: attribution and human-wait derive only from stored rows through observer reach", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const runRef = "cadp-v04:effect:00000000-0000-7000-8000-0000000000o5";
    step(h, runRef, 1);
    h.ingress.submitEvidence(
      {
        evidence_kind: "WORK_BOUND_STOP",
        subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: runRef }],
        availability: "PRESENT",
        claim_schema: "cadp.work-bound-stop.v1",
        claim: { bound: "MAX_STEPS", at_step: 2 },
        producer_ref: "workflow:cadp-work",
        source_ref: `temporal:${runRef}:stop`,
        source_relation: "SELF_REPORT",
      },
      PRINCIPALS.workflow,
    );
    const { request } = sealScriptedRequest(h, { operation_kind: "SCRIPTED_KEYED_WRITE", work_run_ref: runRef });
    const chain = await runChain(h, request.effect_id);
    assert.equal(chain.admitted?.kind, "ADMITTED");

    // Evidence cited by an admission input but bound to a non-work-run subject (the live-pilot
    // gap): a REVIEW about a commit must still reach the run's attribution.
    const review = h.ingress.submitEvidence(
      {
        evidence_kind: "REVIEW",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: "a".repeat(40) }],
        availability: "PRESENT",
        claim_schema: "cadp.review.v1",
        claim: { verdict: "APPROVE", body_digest: "d".repeat(64) },
        producer_ref: "reviewer:claude-code",
        source_ref: "review:o5",
        source_relation: "INDEPENDENT_OBSERVATION",
      },
      PRINCIPALS.reviewer,
    );
    const cited = sealScriptedRequest(h, { operation_kind: "SCRIPTED_KEYED_WRITE", work_run_ref: runRef });
    const citedChain = await runChain(h, cited.request.effect_id, [review.evidence_id]);
    assert.equal(citedChain.admitted?.kind, "ADMITTED");

    await withApi(h, async (obs) => {
      const run = await collectRun(obs, runRef);
      const report = attribution(run) as { derived_domain: string; bound_stops: string[]; review: Array<{ verdict?: string }> };
      assert.equal(report.derived_domain, "BOUNDED_STOP");
      assert.deepEqual(report.bound_stops, ["MAX_STEPS"]);
      assert.deepEqual(report.review.map((r) => r.verdict), ["APPROVE"], "input-cited evidence reaches the run projection");
    });

    // humanWait fires on exactly REQUIRE_EVIDENCE + HUMAN_DECISION (the reference-policy shape).
    const waiting = humanWait([
      { effect_id: "e1", admissions: 0, open_unknown: false, latest_decision: { outcome: "REQUIRE_EVIDENCE", reason_codes: ["HUMAN_DECISION"] }, state: { query: "UNAVAILABLE", reason: "n/a" } },
      { effect_id: "e2", admissions: 0, open_unknown: false, latest_decision: { outcome: "DENY", reason_codes: ["HUMAN_DECISION"] }, state: { query: "UNAVAILABLE", reason: "n/a" } },
      { effect_id: "e3", admissions: 1, open_unknown: false, latest_decision: { outcome: "ALLOW", reason_codes: [] }, state: { query: "UNAVAILABLE", reason: "n/a" } },
    ]);
    assert.deepEqual(waiting, ["e1"]);
  } finally {
    h.close();
  }
});
