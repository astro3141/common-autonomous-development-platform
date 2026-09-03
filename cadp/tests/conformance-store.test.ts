/**
 * TD §13.1 — C4 (tampered evidence → corruption incident + scope hold), C8 (request digest
 * conflict), C15 (concurrent admission race across two kernel instances), C23 (allocation key
 * ambiguity), C33 (WORK_STEP replay vs conflict), C37 (UNKNOWN envelope stays claim-less).
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { join } from "node:path";

import { makeHarness, runChain, sealScriptedRequest, stopSharedOpa, PRINCIPALS, PEP_REF, ScriptedTarget } from "./support/harness.ts";
import { ConstitutionalStore } from "../kernel/store.ts";
import { Cas } from "../kernel/cas.ts";
import { Ingress } from "../kernel/ingress.ts";
import { Pep } from "../kernel/pep.ts";
import { makeAdapterRegistry } from "../kernel/adapters/types.ts";

after(() => stopSharedOpa());

test("C4: a flipped byte in a stored claim refuses admission, seals DIGEST_CORRUPTION, and holds the scope", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h);
    const review = h.ingress.submitEvidence(
      {
        evidence_kind: "REVIEW",
        subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "commit", object_id: "sha-c4" }],
        availability: "PRESENT",
        claim_schema: "cadp.review.v1",
        claim: { verdict: "APPROVE", body_digest: "a".repeat(64) },
        producer_ref: "reviewer:claude-code",
        source_ref: "test",
        source_relation: "INDEPENDENT_OBSERVATION",
      },
      PRINCIPALS.reviewer,
    );
    const input = h.ingress.assembleAdmissionInput(request.effect_id, [review.evidence_id]);
    const evaluated = await h.evaluate(input.input_digest.value);
    if (evaluated.kind !== "DECISION") throw new Error("expected decision");
    const stored = h.store.db.prepare("SELECT envelope_json FROM evidence_envelope WHERE evidence_id = ?").get(review.evidence_id) as { envelope_json: string };
    h.store.db
      .prepare("UPDATE evidence_envelope SET envelope_json = ? WHERE evidence_id = ?")
      .run(stored.envelope_json.replace("APPROVE", "APPROVX"), review.evidence_id);

    const refused = await h.pep.admitAndDispatch(request.effect_id, evaluated.decision.decision_id);
    assert.ok(refused.kind === "REFUSAL", JSON.stringify(refused));
    assert.equal(h.target.committed.size, 0, "target delta 0");
    const incidents = h.store.openIncidents();
    assert.ok(incidents.some((i) => (i.claim as { incident_kind?: string })?.incident_kind === "DIGEST_CORRUPTION"), "incident sealed");

    // Scope hold: a NEW effect on the held target scope is refused at #7.
    const fresh = sealScriptedRequest(h, { body: "fresh-after-corruption" });
    const { admitted: held } = await runChain(h, fresh.request.effect_id);
    assert.ok(held?.kind === "REFUSAL" && held.reason === "SCOPE_HELD", JSON.stringify(held));
  } finally {
    h.close();
  }
});

test("C8: same allocation key with changed material is a REQUEST_DIGEST_CONFLICT; no second row; scope held", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const first = sealScriptedRequest(h, { body: "original" });
    // Same effect_id, different material → conflict + incident.
    assert.throws(
      () => sealScriptedRequest(h, { effect_id: first.request.effect_id, body: "changed" }),
      (error: unknown) => (error as { reason?: string }).reason === "REQUEST_DIGEST_CONFLICT",
    );
    assert.equal(h.store.effectRequest(first.request.effect_id)!.material_digest.value, first.request.material_digest.value, "stored row unchanged");
    // Idempotent identical re-seal returns the stored row without an incident.
    const again = sealScriptedRequest(h, { effect_id: first.request.effect_id, body: "original" });
    assert.equal(again.request.request_digest.value, first.request.request_digest.value);
    // Scope hold: the conflicted effect cannot be admitted.
    const { admitted } = await runChain(h, first.request.effect_id);
    assert.ok(admitted?.kind === "REFUSAL" && admitted.reason === "SCOPE_HELD", JSON.stringify(admitted));
    assert.equal(h.target.committed.size, 0);
  } finally {
    h.close();
  }
});

test("C15: two kernel instances racing one effect produce exactly one admission; loser sees ADMISSION_LOST_RACE", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h);
    const input = h.ingress.assembleAdmissionInput(request.effect_id, []);
    const evaluated = await h.evaluate(input.input_digest.value);
    if (evaluated.kind !== "DECISION") throw new Error("expected decision");

    // Second kernel instance: its own store connection, ingress, PEP over the same database.
    const store2 = new ConstitutionalStore(join(h.dir, "k04.sqlite"));
    const cas2 = new Cas(store2);
    const ingress2 = new Ingress(store2, cas2, `${PEP_REF}-2`);
    const target2 = new ScriptedTarget();
    const pep2 = new Pep(store2, cas2, ingress2, makeAdapterRegistry([target2]), `${PEP_REF}-2`);

    const [a, b] = await Promise.all([
      h.pep.admitAndDispatch(request.effect_id, evaluated.decision.decision_id),
      pep2.admitAndDispatch(request.effect_id, evaluated.decision.decision_id),
    ]);
    const admittedCount = [a, b].filter((r) => r.kind === "ADMITTED").length;
    const loser = [a, b].find((r) => r.kind === "REFUSAL") as { reason: string } | undefined;
    assert.equal(admittedCount, 1, `exactly one winner: ${JSON.stringify([a.kind, b.kind])}`);
    // SQLite BEGIN IMMEDIATE serializes whole transactions, so the loser usually observes the
    // winner's row (#12 → PRIOR_DISPATCH_UNRESOLVED, an instruction to re-read). When the txs
    // truly overlap it hits the unique constraint (ADMISSION_LOST_RACE). Both are fail-closed
    // re-read instructions; neither is a second dispatch.
    assert.ok(
      loser !== undefined && ["ADMISSION_LOST_RACE", "PRIOR_DISPATCH_UNRESOLVED"].includes(loser.reason),
      `loser refused with a re-read instruction: ${JSON.stringify(loser)}`,
    );
    assert.equal(h.store.admissionsByEffect(request.effect_id).length, 1, "exactly one effect_admission row");
    // The (effect_id, dispatch_ordinal) unique constraint is the store-level backstop.
    const row = h.store.admissionsByEffect(request.effect_id)[0]!;
    assert.throws(
      () =>
        h.store.db
          .prepare("INSERT INTO effect_admission (admission_id, admission_digest, effect_id, dispatch_ordinal, effect_request_digest, policy_decision_ref, admission_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run("cadp-v04:admission:duplicate", "dup-digest", row.effect_id, row.dispatch_ordinal, "x", "y", "{}"),
      /UNIQUE constraint failed/u,
    );
    store2.close();
  } finally {
    h.close();
  }
});

test("C23: allocation tuples are canonical JSON — no concatenation ambiguity; malformed tuples rejected", async () => {
  const h = await makeHarness();
  try {
    const run = "cadp-v04:effect:00000000-0000-7000-8000-00000000c023";
    const a = h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: run, step_ordinal: 12, purpose: "record-write" });
    // The raw-concatenation collision candidate {run, 1, "2record-write"} is simply an unknown
    // purpose (closed vocabulary) — and even a known-purpose pair cannot collide because the
    // tuple is typed canonical JSON.
    const b = h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: run, step_ordinal: 1, purpose: "record-write" });
    assert.notEqual(a, b);
    const aAgain = h.ingress.allocateEffectId({ schema: "cadp.allocation-key.v1", work_run_ref: run, step_ordinal: 12, purpose: "record-write" });
    assert.equal(a, aAgain, "idempotent on the canonical tuple");

    for (const bad of [
      { schema: "cadp.allocation-key.v1", work_run_ref: run, step_ordinal: 0, purpose: "record-write" },
      { schema: "cadp.allocation-key.v1", work_run_ref: run, step_ordinal: 1.5, purpose: "record-write" },
      { schema: "cadp.allocation-key.v1", work_run_ref: run, step_ordinal: "01" as unknown as number, purpose: "record-write" },
      { schema: "cadp.allocation-key.v1", work_run_ref: run, step_ordinal: 1, purpose: "2record-write" },
      { schema: "cadp.allocation-key.v1", work_run_ref: "not-an-effect-id", step_ordinal: 1, purpose: "record-write" },
    ]) {
      assert.throws(
        () => h.ingress.allocateEffectId(bad as never),
        (error: unknown) => (error as { reason?: string }).reason === "ALLOCATION_TUPLE_INVALID",
        JSON.stringify(bad),
      );
    }
    const rows = h.store.db.prepare("SELECT COUNT(*) AS n FROM effect_allocation").get() as { n: number };
    assert.equal(rows.n, 2, "no effect_allocation row for rejected tuples");
  } finally {
    h.close();
  }
});

test("C33: WORK_STEP replay converges on the same envelope; a different payload is a held conflict", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const run = "cadp-v04:effect:00000000-0000-7000-8000-00000000c033";
    const draft = {
      evidence_kind: "WORK_STEP" as const,
      subject_bindings: [
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: run },
        { authority_ref: "cadp-store:k04", namespace: "step-input", object_id: "i1" },
        { authority_ref: "cadp-store:k04", namespace: "step-output", object_id: "o1" },
      ],
      availability: "PRESENT" as const,
      claim_schema: "cadp.work-step.v1",
      claim: { step_ordinal: 2, summary: "step two" },
      producer_ref: "workflow:cadp-work",
      source_ref: "temporal:run",
      source_relation: "SELF_REPORT" as const,
    };
    const first = h.ingress.submitEvidence(draft, PRINCIPALS.workflow);
    const replay = h.ingress.submitEvidence(draft, PRINCIPALS.workflow);
    assert.equal(replay.evidence_id, first.evidence_id, "replay returns the SAME evidence_id");
    const count = h.store.db
      .prepare("SELECT COUNT(*) AS n FROM evidence_envelope WHERE evidence_kind = 'WORK_STEP' AND work_run_ref = ?")
      .get(run) as { n: number };
    assert.equal(count.n, 1, "exactly one row per ordinal");
    assert.equal(h.store.openIncidents().length, 0, "no incident on replay");

    // (ii) different payload for the same ordinal → WORK_STEP_CONFLICT + scope hold on the run.
    assert.throws(
      () => h.ingress.submitEvidence({ ...draft, claim: { step_ordinal: 2, summary: "DIFFERENT" } }, PRINCIPALS.workflow),
      (error: unknown) => (error as { reason?: string }).reason === "WORK_STEP_CONFLICT",
    );
    assert.ok(h.store.openIncidents().some((i) => (i.claim as { incident_kind?: string })?.incident_kind === "WORK_STEP_CONFLICT"));
    // The next effect of that run is refused (scope hold).
    const { request } = sealScriptedRequest(h, { work_run_ref: run });
    const { admitted } = await runChain(h, request.effect_id);
    assert.ok(admitted?.kind === "REFUSAL" && admitted.reason === "SCOPE_HELD", JSON.stringify(admitted));
  } finally {
    h.close();
  }
});

test("C37: an UNKNOWN envelope is claim-less with unknown_reason; received_at is only an impl column", async () => {
  const h = await makeHarness();
  try {
    const envelope = h.ingress.submitEvidence(
      {
        evidence_kind: "BACKEND_EXECUTION",
        subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-00000000c037" }],
        availability: "UNKNOWN",
        claim_schema: "cadp.backend.v1",
        unknown_reason: "session log absent",
        producer_ref: "backend-scan:codex",
        source_ref: "scan",
        source_relation: "SELF_REPORT",
      },
      PRINCIPALS.backendScan,
    );
    assert.equal(envelope.claim, undefined);
    assert.equal(envelope.claim_digest, undefined);
    assert.equal(envelope.unknown_reason, "session log absent");
    const raw = h.store.db.prepare("SELECT envelope_json, received_at FROM evidence_envelope WHERE evidence_id = ?").get(envelope.evidence_id) as {
      envelope_json: string;
      received_at: string;
    };
    assert.ok(!raw.envelope_json.includes("received_at"), "received_at is NOT in the K2 record");
    assert.ok(raw.received_at.length > 0, "…but exists as an operational column");
    // A PRESENT draft with claim + UNKNOWN is rejected by schema validation.
    assert.throws(() =>
      h.ingress.submitEvidence(
        {
          evidence_kind: "BACKEND_EXECUTION",
          subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-00000000c037" }],
          availability: "UNKNOWN",
          claim_schema: "cadp.backend.v1",
          claim: { smuggled: true },
          unknown_reason: "x",
          producer_ref: "backend-scan:codex",
          source_ref: "scan",
          source_relation: "SELF_REPORT",
        },
        PRINCIPALS.backendScan,
      ),
    );
  } finally {
    h.close();
  }
});
