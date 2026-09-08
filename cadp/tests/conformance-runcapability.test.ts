/**
 * AP B5 — the run capability: minting at the requester-verified dispatch, seal-time membership
 * over the presented capability, and recheck #19's durable proof. Control A4 of §C, leg by leg.
 *
 * A4 as the TD states it: an enrolled requester holding run R1's capability presents it on an
 * R2-bound request (`RUN_CAPABILITY_INVALID`); presents another holder's exfiltrated capability
 * (`RUN_CAPABILITY_HOLDER_MISMATCH`); presents none on a run-bound request
 * (`RUN_CAPABILITY_REQUIRED`); binds no run at all (`RUN_BINDING_REQUIRED`); a non-enrolled
 * requester carries a `work_run_ref` (`NOT_RUN_ENROLLED`); the run scope grades on the WORK_START's
 * LATEST conclusive K7 state, with both flips asserted — `UNKNOWN` → reconciled `COMMITTED`, and
 * `NO_EFFECT_CONFIRMED` → a permitted next ordinal reaching `COMMITTED` — for the SAME capability,
 * never re-delivered; a foreign principal's dispatch of a sealed `WORK_START`
 * (`WORK_START_DISPATCH_REQUESTER_MISMATCH`, nothing minted, no outcome written) followed by the
 * sealed requester's own dispatch, which proves the run was not stranded; delivery exactly once;
 * and recheck #19's `RUN_MEMBERSHIP_UNPROVEN` when the durable row is absent (reached through the
 * Ingress's TEST-ONLY guard-bite knob, which is what makes the row load-bearing rather than
 * decorative). Zero `effect_request` rows on every refusal leg, and the secret in no error text,
 * no stored row and no incident.
 *
 * Every case runs against a `cadp.kernel-config.v2` harness whose
 * `run_profile_enrolled_requester_refs` is non-empty, because the whole mechanism is gated on
 * exactly that. The last test is the complementary claim: under `cadp.kernel-config.v1` nothing
 * here exists — no gate, no membership row, no minting — so the running v0.4 deployment is
 * untouched. (The v2-with-empty-enrollment case is the rest of the suite: every other v2 harness
 * enrolls nobody and is unaffected by this lane.)
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { startKernelApi } from "../kernel/api.ts";
import { IngressRejection } from "../kernel/ingress.ts";
import type { Principal } from "../kernel/ingress.ts";
import type { SubjectBinding, TargetRef } from "../kernel/records.ts";
import type {
  AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
} from "../kernel/adapters/types.ts";
import { REFERENCE_IDENTITIES } from "../deployment/referencePolicy.ts";
import { DEFAULT_WORK_RUN_REF, PRINCIPALS, makeHarness, stopSharedOpa, v2ConfigOverrides } from "./support/harness.ts";
import type { Harness, HarnessOptions } from "./support/harness.ts";

after(() => stopSharedOpa());

/** A second `workflow`-class principal, enrolled alongside A: the other holder of A4's legs. */
const PRINCIPAL_B: Principal = { principal: "cadp-workflow-b" };
const IDENTITY_B = {
  principal: "cadp-workflow-b",
  producer_ref: "workflow:cadp-work-b",
  identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" },
};
const REQUESTER_A = "workflow:cadp-work";
const REQUESTER_B = "workflow:cadp-work-b";
/** `worker:codex-cli` is registered but NOT enrolled — the `NOT_RUN_ENROLLED` leg's caller. */
const PRINCIPAL_C = PRINCIPALS.worker;
const REQUESTER_C = "worker:codex-cli";

const RUN_TARGET: TargetRef = { authority_ref: "temporal:cadp-test", target_type: "WORKFLOW", target_id: "cadp-test" };

/**
 * A scripted `WORK_START` target: the reference `WORK_START` adapter is Temporal-backed and out of
 * this suite's reach, and the run capability needs a `WORK_START` that actually DISPATCHES so that
 * B5(1)'s minting and B5(2)'s K7 grading have real outcomes to grade. Behaviour per dispatch
 * ordinal is injected, exactly as `ScriptedTarget` does for the other operations.
 */
class RunStartTarget implements TargetAdapterV1 {
  readonly operations: AdapterOperation[] = [
    {
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      available: true,
      idempotency: "NONE",
      dispatch_precondition: "NONE",
      reconcile: "BY_QUERY_PREDICATE",
      no_effect_proof_supported: true,
    },
  ];

  /** Dispatch results consumed in order; the default is a bound receipt (⇒ `COMMITTED`). */
  readonly scripted: DispatchResult[] = [];
  onReconcile: ((effect_id: string, material: Record<string, unknown>) => ReconcileResult) | undefined;

  describe() {
    return { target_type: RUN_TARGET.target_type, authority_ref: RUN_TARGET.authority_ref, operations: this.operations };
  }

  serialization_domain(): string {
    return "run-start-domain";
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    return { target_ref: RUN_TARGET, claim: { namespace: RUN_TARGET.target_id } };
  }

  async current_revision(subject: SubjectBinding): Promise<RevisionRead> {
    return { revision_or_version: subject.revision_or_version, availability: "PRESENT" };
  }

  async verify_material(): Promise<void> {}

  async dispatch_precondition_read(): Promise<string | undefined> {
    return undefined;
  }

  async dispatch(effect_id: string, _o: number, _t: TargetRef, _k: string, material: Record<string, unknown>): Promise<DispatchResult> {
    return this.scripted.shift() ?? {
      kind: "ACCEPTED",
      target_operation_ref: `run-${effect_id}`,
      receipt_claim: { workflow_id: material["workflow_id"] },
    };
  }

  async reconcile(effect_id: string, _o: number, _t: TargetRef, _k: string, material: Record<string, unknown>): Promise<ReconcileResult> {
    return this.onReconcile?.(effect_id, material) ?? { kind: "UNKNOWN", unknown_reason: "no scripted reconciliation" };
  }

  receipt_binds(_k: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    return receipt["workflow_id"] === material["workflow_id"];
  }
}

interface RunHarness {
  h: Harness;
  runTarget: RunStartTarget;
}

async function runHarness(options: HarnessOptions = {}): Promise<RunHarness> {
  const runTarget = new RunStartTarget();
  const h = await makeHarness({
    ...options,
    identityRegistry: [...REFERENCE_IDENTITIES, IDENTITY_B],
    extraAdapters: [runTarget, ...(options.extraAdapters ?? [])],
    configOverrides: v2ConfigOverrides({
      run_profile_enrolled_requester_refs: [REQUESTER_A, REQUESTER_B],
      ...(options.configOverrides ?? {}),
    }) as never,
  });
  h.sealReach();
  await h.sealTargetIdentity();
  await h.pep.refreshTargetIdentity(runTarget);
  return { h, runTarget };
}

let ordinal = 0;

function scriptedMaterial(h: Harness, body: string): string {
  const bodyBytes = Buffer.from(body, "utf8");
  const material = {
    tenant: "scripted-1",
    resource_id: "r-1",
    body_digest: createHash("sha256").update(bodyBytes).digest("hex"),
    body_cas_key: h.ingress.putBlob(bodyBytes),
  };
  return h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
}

function workRunBinding(work_run_ref: string): SubjectBinding {
  return { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: work_run_ref };
}

/**
 * Seal a `WORK_START` — the run-capability-minting request (B5(1)). It binds the run it was
 * ALLOCATED under (B2(3.4) projects the v1 tuple's `work_run_ref` onto the work-run subject); the
 * run it MINTS is its own `effect_id` (Spec v0.5 §5.2), which is what the capability row is keyed by.
 */
function sealWorkStart(
  h: Harness,
  principal: Principal,
  requester_ref: string,
  parent = DEFAULT_WORK_RUN_REF,
  capability?: string,
): string {
  const allocation_tuple = {
    schema: "cadp.allocation-key.v1",
    work_run_ref: parent,
    step_ordinal: (ordinal += 1),
    purpose: "work-start",
  };
  const effect_id = h.ingress.allocateEffectId(allocation_tuple, principal);
  const material = {
    workflow_id: `cadp-work-${effect_id}`,
    workflow_type: "cadpWork",
    task_queue: "cadp-worker",
    bounds: { max_steps: 8, max_effects: 50 },
  };
  h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref,
      work_bindings: [workRunBinding(parent)],
      target_ref: RUN_TARGET,
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
      prior_effect_refs: [],
      allocation_tuple,
    },
    principal,
    capability === undefined ? {} : { run_capability: capability },
  );
  return effect_id;
}

/** Assemble → evaluate → `admit_and_dispatch` as `principal`, asserting the decision ALLOWed. */
async function admit(h: Harness, effect_id: string, principal: Principal | undefined) {
  const input = h.ingress.assembleAdmissionInput(effect_id, []);
  const evaluated = await h.evaluate(input.input_digest.value);
  assert.equal(evaluated.kind, "DECISION", `evaluation for ${effect_id}`);
  if (evaluated.kind !== "DECISION") throw new Error("unreachable");
  assert.equal(evaluated.decision.outcome, "ALLOW", `decision for ${effect_id}: ${evaluated.decision.reason_codes.join(",")}`);
  return h.pep.admitAndDispatch(effect_id, evaluated.decision.decision_id, principal);
}

/** Start a run and return its `work_run_ref` and the one-shot capability its dispatch delivered. */
async function startRun(
  rh: RunHarness,
  principal: Principal,
  requester_ref: string,
  scripted: DispatchResult[] = [],
): Promise<{ work_run_ref: string; capability: string }> {
  rh.runTarget.scripted.push(...scripted);
  const effect_id = sealWorkStart(rh.h, principal, requester_ref);
  const admitted = await admit(rh.h, effect_id, principal);
  assert.equal(admitted.kind, "ADMITTED", `WORK_START ${effect_id}: ${JSON.stringify(admitted)}`);
  if (admitted.kind !== "ADMITTED") throw new Error("unreachable");
  assert.equal(typeof admitted.run_capability, "string", "the initial verified dispatch delivers the capability");
  return { work_run_ref: effect_id, capability: admitted.run_capability! };
}

/** Seal an ordinary run-bound request, presenting the capability as B6(3)'s transport header. */
function sealRunBound(
  h: Harness,
  principal: Principal,
  requester_ref: string,
  options: { work_run_ref?: string; capability?: string; body?: string } = {},
): string {
  const allocation_tuple = {
    schema: "cadp.allocation-key.v1",
    work_run_ref: options.work_run_ref ?? DEFAULT_WORK_RUN_REF,
    step_ordinal: (ordinal += 1),
    purpose: "record-write",
  };
  const effect_id = h.ingress.allocateEffectId(allocation_tuple, principal);
  h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref,
      work_bindings: options.work_run_ref === undefined ? [] : [workRunBinding(options.work_run_ref)],
      target_ref: h.target.targetRef(),
      operation_kind: "SCRIPTED_WRITE",
      material_schema: "test.scripted-write.v1",
      material_ref: scriptedMaterial(h, options.body ?? `run-bound-${effect_id}`),
      prior_effect_refs: [],
      allocation_tuple,
    },
    principal,
    options.capability === undefined ? {} : { run_capability: options.capability },
  );
  return effect_id;
}

function refusalOf(fn: () => unknown, reason: string, note: string): IngressRejection {
  let caught: unknown;
  assert.throws(fn, (error: unknown) => {
    caught = error;
    assert.equal((error as { reason?: string }).reason, reason, `${note}: ${String((error as Error).message)}`);
    return true;
  }, note);
  return caught as IngressRejection;
}

function count(h: Harness, table: "effect_request" | "run_capability" | "run_membership"): number {
  return (h.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function incidents(h: Harness): number {
  return (h.store.db.prepare("SELECT COUNT(*) AS n FROM evidence_envelope WHERE evidence_kind = 'KERNEL_INCIDENT'").get() as { n: number }).n;
}

/** Every durable text the store holds, for the "the secret is nowhere" sweep (B5(1), B6(3)). */
function storedText(h: Harness): string {
  const tables: Array<[string, string]> = [
    ["evidence_envelope", "envelope_json"],
    ["effect_request", "request_json"],
    ["admission_input", "input_json"],
    ["policy_decision", "decision_json"],
    ["effect_admission", "admission_json"],
    ["effect_outcome", "outcome_json"],
  ];
  let text = "";
  for (const [table, column] of tables) {
    for (const row of h.store.db.prepare(`SELECT ${column} AS j FROM ${table}`).all() as Array<{ j: string }>) text += row.j;
  }
  for (const row of h.store.db.prepare("SELECT * FROM run_capability").all() as Array<Record<string, string>>) {
    text += JSON.stringify(row);
  }
  return text;
}

// ================================================================ B5(1) — minting and delivery

test("B5(1)/B6(4): a foreign principal's dispatch of a sealed WORK_START mints nothing; the sealed requester's does", async () => {
  const { h } = await runHarness();
  try {
    const effect_id = sealWorkStart(h, PRINCIPALS.workflow, REQUESTER_A);

    // A4: requester C dispatches A's WORK_START. Refused on the stamped-vs-sealed `requester_ref`
    // equality (B5(1)) — no capability in C's result, no `run_capability` row, no outcome row.
    const foreign = await admit(h, effect_id, PRINCIPAL_B);
    assert.equal(foreign.kind, "REFUSAL");
    assert.equal((foreign as { reason: string }).reason, "WORK_START_DISPATCH_REQUESTER_MISMATCH");
    assert.ok(!("run_capability" in foreign), "a refused dispatch carries no capability");
    assert.equal(count(h, "run_capability"), 0, "nothing is minted on the refusal");
    assert.equal(h.store.outcomesByEffect(effect_id).length, 0, "no outcome is written on the refusal");
    assert.equal(h.store.admissionsByEffect(effect_id).length, 0, "no admission is written on the refusal");

    // An UNAUTHENTICATED caller (no principal at all) cannot mint either: absence is not authority.
    const anonymous = await h.pep.admitAndDispatch(effect_id, "no-such-decision", undefined);
    assert.equal((anonymous as { reason: string }).reason, "WORK_START_DISPATCH_REQUESTER_MISMATCH");
    assert.equal(count(h, "run_capability"), 0);

    // A4: A's own later dispatch still mints and delivers — the run was not stranded by C's attempt.
    const admitted = await admit(h, effect_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED");
    if (admitted.kind !== "ADMITTED") throw new Error("unreachable");
    const secret = admitted.run_capability!;
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/u, "base64url, unpadded, of 32 raw bytes");
    assert.equal(count(h, "run_capability"), 1);

    // B5(1): the row stores the DIGEST OVER THE RAW BYTES, never the secret and never a digest of
    // its transport text; `holder_ref` is the sealed requester the secret went to.
    const row = h.store.runCapability(effect_id)!;
    assert.equal(row.holder_ref, REQUESTER_A);
    assert.equal(row.capability_digest, createHash("sha256").update(Buffer.from(secret, "base64url")).digest("hex"));
    assert.notEqual(row.capability_digest, createHash("sha256").update(secret, "utf8").digest("hex"));

    // B6(4)/B5(7): "returned exactly once" on the wire — a further call returns none.
    const again = await admit(h, effect_id, PRINCIPALS.workflow);
    assert.equal((again as { reason: string }).reason, "EFFECT_ALREADY_COMMITTED");
    assert.ok(!("run_capability" in again), "no re-delivery, ever");
    assert.equal(count(h, "run_capability"), 1, "and no second row");

    // B6(4): a NON-minting dispatch never carries the field at all.
    const bound = sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: effect_id, capability: secret });
    const ordinaryDispatch = await admit(h, bound, PRINCIPALS.workflow);
    assert.equal(ordinaryDispatch.kind, "ADMITTED", JSON.stringify(ordinaryDispatch));
    assert.ok(!("run_capability" in ordinaryDispatch), "a non-minting dispatch delivers nothing");

    assert.equal(storedText(h).includes(secret), false, "the secret is in no stored row");
    assert.equal(incidents(h), 0, "none of this raises an incident");
  } finally {
    h.close();
  }
});

// ================================================================ B5(3)/B5(4) — seal-time membership

test("B5(4): the enrolled holder seals with its own run's capability, and the membership row is written", async () => {
  const rh = await runHarness();
  const { h } = rh;
  try {
    const r1 = await startRun(rh, PRINCIPALS.workflow, REQUESTER_A);
    const effect_id = sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: r1.work_run_ref, capability: r1.capability });

    const membership = h.store.runMembership(effect_id)!;
    assert.equal(membership.work_run_ref, r1.work_run_ref, "B5(5): the durable proof, in the seal's own transaction");
    // Recheck #19's positive control: with the row present the admission proceeds normally.
    const admitted = await admit(h, effect_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal(incidents(h), 0);
  } finally {
    h.close();
  }
});

test("A4: every borrowing leg refuses with its exact code and leaves ZERO effect_request rows", async () => {
  const rh = await runHarness();
  const { h } = rh;
  try {
    const r1 = await startRun(rh, PRINCIPALS.workflow, REQUESTER_A);
    const r2 = await startRun(rh, PRINCIPAL_B, REQUESTER_B);
    const before = count(h, "effect_request");

    // R1's capability on an R2-bound request: the row for THIS request's work_run_ref is R2's, and
    // R1's secret does not digest to it. The first leg of B5(4).
    const invalid = refusalOf(
      () => sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: r2.work_run_ref, capability: r1.capability }),
      "RUN_CAPABILITY_INVALID",
      "R1's capability on an R2-bound request",
    );

    // B's exfiltrated R2 capability presented by A: the digest matches R2's row, so possession is
    // not the question — the row binds one capability to one HOLDER.
    const holder = refusalOf(
      () => sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: r2.work_run_ref, capability: r2.capability }),
      "RUN_CAPABILITY_HOLDER_MISMATCH",
      "B's capability presented by A",
    );

    // An enrolled requester's run-bound request presenting none — distinct from RUN_BINDING_REQUIRED.
    refusalOf(
      () => sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: r1.work_run_ref }),
      "RUN_CAPABILITY_REQUIRED",
      "run-bound, no header",
    );

    // An enrolled requester's UNBOUND effect is REFUSED, not merely uncounted (Spec v0.5 §5.1).
    refusalOf(
      () => sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { capability: r1.capability }),
      "RUN_BINDING_REQUIRED",
      "enrolled, no work-run binding",
    );

    // Enrollment cannot be acquired by presenting a binding (WP §5.2; WP control 5).
    refusalOf(
      () => sealRunBound(h, PRINCIPAL_C, REQUESTER_C, { work_run_ref: r1.work_run_ref }),
      "NOT_RUN_ENROLLED",
      "non-enrolled carrying a work_run_ref",
    );
    // ...and presenting a real capability with it changes nothing.
    refusalOf(
      () => sealRunBound(h, PRINCIPAL_C, REQUESTER_C, { work_run_ref: r1.work_run_ref, capability: r1.capability }),
      "NOT_RUN_ENROLLED",
      "non-enrolled presenting a capability",
    );

    // A malformed presentation is a refusal, never a thrown TypeError or a 500: wrong length, wrong
    // alphabet, padded, and empty each fail the digest comparison they can never satisfy.
    for (const malformed of [
      randomBytes(32).toString("base64url"), // a well-formed secret that is nobody's
      randomBytes(16).toString("base64url"), // too short to be a 256-bit secret
      randomBytes(33).toString("base64url"), // too long
      "",
      "not base64url!!",
    ]) {
      refusalOf(
        () => sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: r1.work_run_ref, capability: malformed }),
        "RUN_CAPABILITY_INVALID",
        `malformed capability ${JSON.stringify(malformed)}`,
      );
    }

    // A4: ZERO `effect_request` rows for every refused leg, and no incident — a caller error
    // against a run it does not hold is never a scope hold on anyone.
    assert.equal(count(h, "effect_request"), before, "no refusal sealed anything");
    assert.equal(count(h, "run_membership"), 0, "and no refusal proved a membership");
    assert.equal(incidents(h), 0);

    // B6(3): no refusal text carries the presented secret or any prefix of it.
    for (const [error, secret] of [[invalid, r1.capability], [holder, r2.capability]] as const) {
      assert.equal(error.message.includes(secret), false, "the secret is not in the error message");
      assert.equal(error.message.includes(secret.slice(0, 8)), false, "nor is any prefix of it");
    }
    assert.equal(storedText(h).includes(r1.capability), false, "nor in any stored row");
    assert.equal(storedText(h).includes(r2.capability), false, "nor in any stored row");
  } finally {
    h.close();
  }
});

test("B5(4): a WORK_START bound to another holder's REAL run is a run-bound request like any other", async () => {
  const rh = await runHarness();
  const { h } = rh;
  try {
    const r2 = await startRun(rh, PRINCIPAL_B, REQUESTER_B);
    const before = count(h, "effect_request");

    // A starts a run "inside" B's run R2. That effect lands on R2's `MAX_EFFECTS_IN_WORK_RUN`
    // budget, so it is a run-bound request and B5(4) applies to it exactly as to any other:
    // presenting none is RUN_CAPABILITY_REQUIRED, and presenting B's own is a HOLDER_MISMATCH.
    refusalOf(
      () => sealWorkStart(h, PRINCIPALS.workflow, REQUESTER_A, r2.work_run_ref),
      "RUN_CAPABILITY_REQUIRED",
      "a minting WORK_START bound to another run, presenting none",
    );
    refusalOf(
      () => sealWorkStart(h, PRINCIPALS.workflow, REQUESTER_A, r2.work_run_ref, r2.capability),
      "RUN_CAPABILITY_HOLDER_MISMATCH",
      "a minting WORK_START presenting the other holder's capability",
    );
    assert.equal(count(h, "effect_request"), before, "neither attempt sealed anything");

    // The holder's own nested run seals with its own capability, and proves that membership.
    const nested = sealWorkStart(h, PRINCIPAL_B, REQUESTER_B, r2.work_run_ref, r2.capability);
    assert.equal(h.store.runMembership(nested)?.work_run_ref, r2.work_run_ref);
  } finally {
    h.close();
  }
});

test("B5(4): a run whose capability is not yet minted is GATED, never exempt — the origin carve-out is the run's own identity", async () => {
  const rh = await runHarness();
  const { h } = rh;
  try {
    const r1 = await startRun(rh, PRINCIPALS.workflow, REQUESTER_A);
    // B's run, SEALED but never dispatched: its `effect_request` row exists and no capability has
    // been minted for it. Absence of a `run_capability` row is NOT origin — were it exempt, A could
    // bind this run with nothing presented and land its effects on B's `MAX_EFFECTS_IN_WORK_RUN`
    // budget the moment B dispatches, which is the Spec v0.5 §5.3 borrowing B5 exists to prevent.
    const pending = sealWorkStart(h, PRINCIPAL_B, REQUESTER_B);
    assert.equal(h.store.runCapability(pending), undefined, "nothing has been minted for that run");
    const before = count(h, "effect_request");

    for (const [leg, seal, reason] of [
      ["an ordinary request bound to it, presenting none",
        () => sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: pending }), "RUN_CAPABILITY_REQUIRED"],
      ["an ordinary request bound to it, presenting another run's capability",
        () => sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: pending, capability: r1.capability }), "RUN_CAPABILITY_INVALID"],
      ["a minting WORK_START bound to it, presenting none",
        () => sealWorkStart(h, PRINCIPALS.workflow, REQUESTER_A, pending), "RUN_CAPABILITY_REQUIRED"],
      ["a minting WORK_START bound to it, presenting another run's capability",
        () => sealWorkStart(h, PRINCIPALS.workflow, REQUESTER_A, pending, r1.capability), "RUN_CAPABILITY_INVALID"],
      // Not even that run's own requester: no capability exists for it yet, so none can be shown.
      ["its own requester's minting WORK_START bound to it",
        () => sealWorkStart(h, PRINCIPAL_B, REQUESTER_B, pending), "RUN_CAPABILITY_REQUIRED"],
    ] as const) {
      refusalOf(seal, reason, leg);
    }
    assert.equal(count(h, "effect_request"), before, "zero effect_request rows on every refused leg");
    assert.equal(count(h, "run_membership"), 0, "and no refusal proved a membership");
    assert.equal(incidents(h), 0);
  } finally {
    h.close();
  }
});

// ================================================================ B5(2) — K7-gated usability

test("B5(2): an UNKNOWN WORK_START refuses RUN_SCOPE_UNRESOLVED, and a reconciled COMMITTED flips the SAME capability", async () => {
  const rh = await runHarness();
  const { h, runTarget } = rh;
  try {
    // The dispatch is AMBIGUOUS ⇒ the outcome is UNKNOWN, but the capability WAS delivered: minting
    // is at the initial dispatch (B5(1)) and only USABILITY turns on the later K7 (B5(2)).
    const run = await startRun(rh, PRINCIPALS.workflow, REQUESTER_A, [{ kind: "AMBIGUOUS", raw_observation: "transport lost" }]);
    assert.equal(h.store.runCapability(run.work_run_ref)?.holder_ref, REQUESTER_A, "the row exists while UNKNOWN");

    refusalOf(
      () => sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: run.work_run_ref, capability: run.capability }),
      "RUN_SCOPE_UNRESOLVED",
      "presented while the WORK_START is UNKNOWN",
    );

    // `request_reconcile` returns COMMITTED — written by the reconciler, outside any
    // `admit_and_dispatch` result and touching no secret at all.
    runTarget.onReconcile = (effect_id, material) => ({
      kind: "COMMITTED",
      target_operation_ref: `run-${effect_id}`,
      receipt_claim: { workflow_id: material["workflow_id"] },
    });
    await h.reconciler.reconcileEffect(run.work_run_ref);
    assert.ok(h.store.outcomesByEffect(run.work_run_ref).some((o) => o.result === "COMMITTED"), "reconciled to COMMITTED");

    // ASSERT THE FLIP: the SAME capability, never re-delivered, now seals.
    const sealed = sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: run.work_run_ref, capability: run.capability });
    assert.equal(h.store.runMembership(sealed)?.work_run_ref, run.work_run_ref);
    assert.equal(count(h, "run_capability"), 1, "no re-delivery and no second row");
  } finally {
    h.close();
  }
});

test("B5(2): NO_EFFECT_CONFIRMED refuses RUN_SCOPE_REFUSED, and a retry ordinal reaching COMMITTED flips the SAME capability", async () => {
  const rh = await runHarness();
  const { h } = rh;
  try {
    // Ordinal 1 is a proven no-effect; ordinal 2 (which recheck #12 permits after one) commits.
    const run = await startRun(rh, PRINCIPALS.workflow, REQUESTER_A, [
      { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true } },
    ]);
    refusalOf(
      () => sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: run.work_run_ref, capability: run.capability }),
      "RUN_SCOPE_REFUSED",
      "presented while NO_EFFECT_CONFIRMED is the latest conclusive state",
    );

    const retry = await admit(h, run.work_run_ref, PRINCIPALS.workflow);
    assert.equal(retry.kind, "ADMITTED", JSON.stringify(retry));
    if (retry.kind !== "ADMITTED") throw new Error("unreachable");
    assert.equal(retry.admission.dispatch_ordinal, 2, "the permitted next admission");
    // The delivery half of the leg: the retry re-delivers NOTHING and mints no second row.
    assert.ok(!("run_capability" in retry), "the ordinal-2 result carries no capability");
    assert.equal(count(h, "run_capability"), 1);

    // ASSERT THE SECOND FLIP: the same already-delivered capability now passes the usability gate.
    const sealed = sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: run.work_run_ref, capability: run.capability });
    assert.equal(h.store.runMembership(sealed)?.work_run_ref, run.work_run_ref);
  } finally {
    h.close();
  }
});

test("B5(2) negative control: an OPEN retry ordinal reads UNRESOLVED, not the earlier REFUSED", async () => {
  const rh = await runHarness();
  const { h } = rh;
  try {
    const run = await startRun(rh, PRINCIPALS.workflow, REQUESTER_A, [
      { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true } },
    ]);
    rh.runTarget.scripted.push({ kind: "AMBIGUOUS", raw_observation: "retry transport lost" });
    const retry = await admit(h, run.work_run_ref, PRINCIPALS.workflow);
    assert.equal(retry.kind, "ADMITTED", JSON.stringify(retry));

    // "Latest conclusive" is not "any": with ordinal 2 admitted and unresolved, the grading is
    // UNRESOLVED — neither the earlier REFUSED nor a seal.
    refusalOf(
      () => sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: run.work_run_ref, capability: run.capability }),
      "RUN_SCOPE_UNRESOLVED",
      "the latest admitted dispatch has no conclusive outcome",
    );
    assert.equal(count(h, "run_membership"), 0);
  } finally {
    h.close();
  }
});

// ================================================================ B5(5) — recheck #19

test("B5(5): recheck #19 refuses RUN_MEMBERSHIP_UNPROVEN when the durable row is absent", async () => {
  // Guard-bite (TD §13.1): with the seal-time rule removed the run-bound request seals with no
  // capability and no membership row — and the PEP then refuses it at commit time. That is what
  // makes the durable row load-bearing rather than a restatement of the seal's own check.
  const rh = await runHarness({ disabledIngressRules: new Set(["run_membership"]) });
  const { h } = rh;
  try {
    const effect_id = sealRunBound(h, PRINCIPALS.workflow, REQUESTER_A, { work_run_ref: DEFAULT_WORK_RUN_REF });
    assert.equal(h.store.runMembership(effect_id), undefined, "the guard-bite removed the proof");

    const admitted = await admit(h, effect_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "REFUSAL");
    assert.equal((admitted as { reason: string }).reason, "RUN_MEMBERSHIP_UNPROVEN");
    assert.equal(h.store.admissionsByEffect(effect_id).length, 0, "no admission row, no dispatch");
    assert.equal(h.target.effects.length, 0, "external-effect delta 0");
  } finally {
    h.close();
  }
});

test("B5(5): recheck #19 reads the SAME origin predicate — a WORK_START bound to another's run is not origin", async () => {
  // The PEP half of the seal-time leg above: even with the seal-time rule guard-bitten away, a
  // minting `WORK_START` bound to a run that is NOT its own — here one sealed but never dispatched,
  // so no capability row exists for it — has no origin exemption at admission either. Were the two
  // predicates to disagree, the PEP would admit into another requester's run exactly what the seal
  // refuses, and recheck #19 would be unreachable for the minting operation.
  const rh = await runHarness({ disabledIngressRules: new Set(["run_membership"]) });
  const { h } = rh;
  try {
    const pending = sealWorkStart(h, PRINCIPAL_B, REQUESTER_B);
    const borrowed = sealWorkStart(h, PRINCIPALS.workflow, REQUESTER_A, pending);
    assert.equal(h.store.runMembership(borrowed), undefined, "the guard-bite removed the proof");

    const admitted = await admit(h, borrowed, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "REFUSAL", JSON.stringify(admitted));
    assert.equal((admitted as { reason: string }).reason, "RUN_MEMBERSHIP_UNPROVEN");
    assert.equal(h.store.admissionsByEffect(borrowed).length, 0, "no admission row, no dispatch");
    assert.equal(count(h, "run_capability"), 0, "and the refused dispatch minted nothing");

    // The run's OWN origin is unaffected: the same requester's `WORK_START` on its own run admits,
    // mints and delivers, so the fix closes the borrowing leg without closing the bootstrap.
    const own = await admit(h, pending, PRINCIPAL_B);
    assert.equal(own.kind, "ADMITTED", JSON.stringify(own));
    assert.equal(typeof (own as { run_capability?: string }).run_capability, "string");
  } finally {
    h.close();
  }
});

// ================================================================ B6 — the wire framing

test("B6(3)/B6(4) over the wire: the capability is a HEADER on the seal and a field on the initial dispatch only", async () => {
  const rh = await runHarness();
  const { h } = rh;
  const tokens = new Map<string, string>([["tok-workflow", "cadp-workflow"]]);
  const api = await startKernelApi(
    { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens },
    0,
  );
  try {
    const call = async (method: string, body: unknown, run_capability?: string) => {
      const res = await fetch(`http://127.0.0.1:${api.port}/${method}`, {
        method: "POST",
        headers: {
          authorization: "Bearer tok-workflow",
          "content-type": "application/json",
          ...(run_capability === undefined ? {} : { "x-cadp-run-capability": run_capability }),
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };

    // The minting WORK_START, dispatched over the wire by its sealed requester: the response
    // carries `run_capability` (B6(4)) and the request body was exactly `{effect_id, decision_id}`.
    const work_run_ref = sealWorkStart(h, PRINCIPALS.workflow, REQUESTER_A);
    const input = h.ingress.assembleAdmissionInput(work_run_ref, []);
    const evaluated = await h.evaluate(input.input_digest.value);
    if (evaluated.kind !== "DECISION") throw new Error("evaluation unavailable");
    const dispatched = await call("admit_and_dispatch", { effect_id: work_run_ref, decision_id: evaluated.decision.decision_id });
    assert.equal(dispatched.status, 200);
    assert.equal(dispatched.json["kind"], "ADMITTED", JSON.stringify(dispatched.json));
    const secret = dispatched.json["run_capability"] as string;
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/u);

    // The seal, over the wire: no header ⇒ 422 RUN_CAPABILITY_REQUIRED; the header ⇒ it seals. The
    // capability is never in the body, and the refusal detail never carries it.
    const allocation_tuple = {
      schema: "cadp.allocation-key.v1",
      work_run_ref,
      step_ordinal: (ordinal += 1),
      purpose: "record-write",
    };
    const { effect_id } = (await call("allocate_effect_id", allocation_tuple)).json as unknown as { effect_id: string };
    const draft = {
      effect_id,
      requester_ref: REQUESTER_A,
      work_bindings: [workRunBinding(work_run_ref)],
      target_ref: h.target.targetRef(),
      operation_kind: "SCRIPTED_WRITE",
      material_schema: "test.scripted-write.v1",
      material_ref: scriptedMaterial(h, "wire-bound"),
      prior_effect_refs: [],
      allocation_tuple,
    };
    const refused = await call("seal_effect_request", draft);
    assert.equal(refused.status, 422);
    assert.equal(refused.json["error"], "RUN_CAPABILITY_REQUIRED");
    assert.equal(String(refused.json["detail"] ?? "").includes(secret), false, "the refusal detail carries no secret");

    // A body-carried capability is NOT a presentation: the header is the only channel (B6(3)).
    const bodyCarried = await call("seal_effect_request", { ...draft, run_capability: secret });
    assert.equal(bodyCarried.status, 422);
    assert.equal(bodyCarried.json["error"], "RUN_CAPABILITY_REQUIRED");

    const sealed = await call("seal_effect_request", draft, secret);
    assert.equal(sealed.status, 200, JSON.stringify(sealed.json));
    assert.equal(h.store.runMembership(effect_id)?.work_run_ref, work_run_ref);
    // The sealed record carries no trace of the capability, and neither does any stored row.
    assert.equal(JSON.stringify(sealed.json).includes(secret), false, "the sealed K3 record carries no secret");
    assert.equal(storedText(h).includes(secret), false);

    // B6(4): a repeat dispatch of the same WORK_START returns no `run_capability` field at all.
    const repeat = await call("admit_and_dispatch", { effect_id: work_run_ref, decision_id: evaluated.decision.decision_id });
    assert.equal("run_capability" in repeat.json, false, "no re-delivery over the wire");
  } finally {
    api.close();
    h.close();
  }
});

// ================================================================ v1 regression

test("v1 regression: under `cadp.kernel-config.v1` the run profile does not exist at all", async () => {
  const runTarget = new RunStartTarget();
  const h = await makeHarness({ extraAdapters: [runTarget] });
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    await h.pep.refreshTargetIdentity(runTarget);

    // A v1 WORK_START dispatches exactly as it did in v0.4: no principal is required, nothing is
    // minted, and the result carries no `run_capability` field.
    const effect_id = sealWorkStartV1(h);
    const admitted = await admit(h, effect_id, undefined);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.ok(!("run_capability" in admitted), "v1 mints nothing");
    assert.equal(count(h, "run_capability"), 0);

    // A v1 run-bound request seals with no header and writes no membership row; a v1 UNBOUND
    // request seals too — `RUN_BINDING_REQUIRED` is a v0.5 enrollment rule and does not exist here.
    const bound = h.ingress.sealEffectRequest(
      {
        effect_id: h.ingress.allocateEffectId(
          { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: (ordinal += 1), purpose: "record-write" },
          PRINCIPALS.workflow,
        ),
        requester_ref: REQUESTER_A,
        work_bindings: [workRunBinding(effect_id)],
        target_ref: h.target.targetRef(),
        operation_kind: "SCRIPTED_WRITE",
        material_schema: "test.scripted-write.v1",
        material_ref: scriptedMaterial(h, "v1-bound"),
        prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    );
    assert.equal(h.store.runMembership(bound.effect_id), undefined, "v1 proves no membership");
    assert.equal(count(h, "run_membership"), 0);

    const unbound = h.ingress.sealEffectRequest(
      {
        effect_id: h.ingress.allocateEffectId(
          { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: (ordinal += 1), purpose: "record-write" },
          PRINCIPALS.workflow,
        ),
        requester_ref: REQUESTER_A,
        work_bindings: [],
        target_ref: h.target.targetRef(),
        operation_kind: "SCRIPTED_WRITE",
        material_schema: "test.scripted-write.v1",
        material_ref: scriptedMaterial(h, "v1-unbound"),
        prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
    );
    assert.equal(typeof unbound.effect_id, "string", "an unbound v1 seal is untouched");
    // And recheck #19 never fires: the v1 recheck list is exactly #1–#18.
    const admittedBound = await admit(h, bound.effect_id, undefined);
    assert.equal(admittedBound.kind, "ADMITTED", JSON.stringify(admittedBound));
  } finally {
    h.close();
  }
});

/** The v0.4 WORK_START seal: no allocation tuple transport, no run-profile rule in sight. */
function sealWorkStartV1(h: Harness): string {
  const effect_id = h.ingress.allocateEffectId(
    { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: (ordinal += 1), purpose: "work-start" },
    PRINCIPALS.workflow,
  );
  const material = {
    workflow_id: `cadp-work-${effect_id}`,
    workflow_type: "cadpWork",
    task_queue: "cadp-worker",
    bounds: { max_steps: 8, max_effects: 50 },
  };
  h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: REQUESTER_A,
      work_bindings: [],
      target_ref: RUN_TARGET,
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
      prior_effect_refs: [],
    },
    PRINCIPALS.workflow,
  );
  return effect_id;
}
