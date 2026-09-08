/**
 * #127 — malformed WORK_START numeric bounds fail closed.
 *
 * The self-host pilot measured the fail-open path this suite closes: a NaN bound (flattened to
 * null by JSON serialization) made `ordinal + 1 > bound` silently false, so the declared bound
 * simply stopped existing. Three independent guards are proven here:
 *
 *   WB1/WB2  the reference policy DENIES a WORK_START whose bounds are not well-formed positive
 *            integers (reason `malformed_work_bounds`), and ALLOWS well-formed ones;
 *   WB3      guard-bite: with the `work_bounds_ok` conjunct removed from the rego, the same
 *            malformed WORK_START ALLOWs — the policy check is load-bearing, not decorative;
 *   WB4      the PEP's MAX_EFFECTS_IN_WORK_RUN narrowing refuses a declared-but-malformed
 *            `max_effects` instead of silently widening to the policy cap;
 *   WB5      the workflow-entry validator classifies every malformed shape (NaN, Infinity, the
 *            null they become across JSON, fractional, zero, negative, string, bad deadline).
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { makeHarness, stopSharedOpa, sealScriptedRequest, runChain, PRINCIPALS } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { REFERENCE_REGO } from "../deployment/referencePolicy.ts";
import { malformedWorkBounds } from "../product/workflows.ts";

after(() => stopSharedOpa());

let ordinal = 9000;

/** Seal a plain (non-intake) WORK_START whose material carries `bounds`, and evaluate it. */
async function evalPlainWorkStart(h: Harness, bounds: unknown): Promise<{ outcome: string; reason_codes: string[]; effect_id: string }> {
  const material: Record<string, unknown> = { workflow_id: "cadp-work-x", workflow_type: "cadpWork", task_queue: "cadp-worker" };
  if (bounds !== undefined) material["bounds"] = bounds;
  const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const effect_id = h.ingress.allocateEffectId({
    schema: "cadp.allocation-key.v1",
    work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: (ordinal += 1),
    purpose: "work-start",
  }, PRINCIPALS.workflow);
  h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: "workflow:cadp-work",
      work_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: `wr-${effect_id}` }],
      target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: "cadp-v04" },
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref,
      prior_effect_refs: [],
    },
    PRINCIPALS.workflow,
  );
  const input = h.ingress.assembleAdmissionInput(effect_id, []);
  const evaluated = await h.evaluate(input.input_digest.value);
  if (evaluated.kind !== "DECISION") return { outcome: evaluated.kind, reason_codes: [], effect_id };
  return { outcome: evaluated.decision.outcome, reason_codes: [...evaluated.decision.reason_codes], effect_id };
}

// The malformed shapes WB1 sweeps. `null` is what NaN/Infinity become across JSON transport.
const MALFORMED: Array<[string, unknown]> = [
  ["max_steps null (NaN over JSON)", { max_steps: null, max_effects: 6 }],
  ["max_effects null (NaN over JSON)", { max_steps: 8, max_effects: null }],
  ["zero", { max_steps: 0, max_effects: 6 }],
  ["negative", { max_steps: 8, max_effects: -2 }],
  ["fractional", { max_steps: 3.5, max_effects: 6 }],
  ["string", { max_steps: "8", max_effects: 6 }],
  ["missing max_effects", { max_steps: 8 }],
  ["bounds missing entirely", undefined],
  ["bounds empty object", {}],
  ["over the policy step cap", { max_steps: 5000, max_effects: 6 }],
  ["unparseable deadline", { max_steps: 8, max_effects: 6, deadline: "tomorrow-ish" }],
];

test("WB1: every malformed WORK_START bound shape is DENIED with malformed_work_bounds", async () => {
  const h = await makeHarness();
  try {
    for (const [label, bounds] of MALFORMED) {
      const result = await evalPlainWorkStart(h, bounds);
      assert.equal(result.outcome, "DENY", `${label}: expected DENY, got ${result.outcome}`);
      assert.ok(result.reason_codes.includes("malformed_work_bounds"), `${label}: ${JSON.stringify(result.reason_codes)}`);
    }
  } finally {
    h.close();
  }
});

test("WB2: well-formed bounds ALLOW, with and without an RFC3339 deadline", async () => {
  const h = await makeHarness();
  try {
    const plain = await evalPlainWorkStart(h, { max_steps: 8, max_effects: 6 });
    assert.equal(plain.outcome, "ALLOW", JSON.stringify(plain));
    const dated = await evalPlainWorkStart(h, { max_steps: 1, max_effects: 1, deadline: "2027-01-01T00:00:00.000Z" });
    assert.equal(dated.outcome, "ALLOW", JSON.stringify(dated));
  } finally {
    h.close();
  }
});

test("WB3 guard-bite: removing the work_bounds_ok conjunct re-admits the malformed WORK_START", async () => {
  const bitten = REFERENCE_REGO.replaceAll("\n\twork_bounds_ok", "");
  assert.notEqual(bitten, REFERENCE_REGO, "the conjunct must exist to be removed");
  const h = await makeHarness({ rego: bitten });
  try {
    const result = await evalPlainWorkStart(h, { max_steps: null, max_effects: 6 });
    assert.equal(result.outcome, "ALLOW", "without the guard the malformed bound is fail-open — the control is load-bearing");
  } finally {
    h.close();
  }
});

test("WB4: the PEP refuses a declared-but-malformed max_effects instead of widening to the policy cap", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();

    // A WORK_START request whose sealed material declares max_effects: null (NaN over JSON).
    const malformed = await evalPlainWorkStart(h, { max_steps: null, max_effects: null });
    assert.equal(malformed.outcome, "DENY");

    // An ordinary effect inside that work-run: policy allows it (plain scripted op) and attaches
    // MAX_EFFECTS_IN_WORK_RUN; the PEP must refuse at the narrowing, not fall back to the cap.
    const { request } = sealScriptedRequest(h, { operation_kind: "SCRIPTED_KEYED_WRITE", work_run_ref: malformed.effect_id });
    const chain = await runChain(h, request.effect_id);
    assert.ok(chain.admitted !== undefined, "expected a decision");
    assert.equal(chain.admitted.kind, "REFUSAL", JSON.stringify(chain.admitted));
    assert.match((chain.admitted as { detail?: string }).detail ?? "", /MALFORMED_WORK_BOUNDS/u);

    // Positive control: a well-formed declared bound narrows and admits.
    const wellFormed = await evalPlainWorkStart(h, { max_steps: 8, max_effects: 6 });
    assert.equal(wellFormed.outcome, "ALLOW");
    const ok = sealScriptedRequest(h, { operation_kind: "SCRIPTED_KEYED_WRITE", work_run_ref: wellFormed.effect_id });
    const okChain = await runChain(h, ok.request.effect_id);
    assert.equal(okChain.admitted?.kind, "ADMITTED", JSON.stringify(okChain.admitted));
  } finally {
    h.close();
  }
});

test("WB5: the workflow-entry validator classifies every malformed shape and passes well-formed bounds", () => {
  const bad: Array<[Parameters<typeof malformedWorkBounds>[0], RegExp]> = [
    [{ max_steps: Number.NaN, max_effects: 6 }, /max_steps=NaN/u],
    [{ max_steps: Number.POSITIVE_INFINITY, max_effects: 6 }, /max_steps=Infinity/u],
    [{ max_steps: 8, max_effects: 0 }, /max_effects=0/u],
    [{ max_steps: 8, max_effects: -1 }, /max_effects=-1/u],
    [{ max_steps: 2.5, max_effects: 6 }, /max_steps=2.5/u],
    [JSON.parse('{"max_steps":null,"max_effects":6}') as Parameters<typeof malformedWorkBounds>[0], /max_steps=null/u],
    [{ max_steps: 8, max_effects: 6, deadline: "not-a-time" }, /deadline=not-a-time/u],
  ];
  for (const [bounds, expected] of bad) {
    const verdict = malformedWorkBounds(bounds);
    assert.ok(verdict !== undefined && expected.test(verdict), `${JSON.stringify(bounds)} → ${String(verdict)}`);
  }
  assert.equal(malformedWorkBounds({ max_steps: 8, max_effects: 6 }), undefined);
  assert.equal(malformedWorkBounds({ max_steps: 1, max_effects: 1, deadline: "2027-01-01T00:00:00.000Z" }), undefined);
});
