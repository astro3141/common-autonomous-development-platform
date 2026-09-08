/**
 * AP B4 — assembly completeness and the commit-time recheck #18.
 *
 * These are the KERNEL-side legs of §C control A3. The fixture-policy leg of A3 (a non-existential
 * `PR_CREATE` predicate under which the withheld `REJECT` flips the outcome) is composition-side
 * and is not asserted here; what is asserted here are the ASSEMBLY FACTS the TD states:
 *
 *   B4(2)/B4(3)  the sealed K4 carries the UNION of the caller's refs and the complete queried
 *                set, deduplicated by `evidence_id` and ordered canonically by it — the caller may
 *                add and can never subtract;
 *   B4(2)        a request whose `work_bindings` name no binding in a declared `subject_namespace`
 *                REFUSES `ASSEMBLY_SUBJECT_UNBOUND` with no `AdmissionInputV1` row — the rule is
 *                never vacuously satisfied;
 *   B4(4)        a matched row that fails verify-on-read refuses and seals no partial set;
 *   B4(5)        recheck #18 refuses `ASSEMBLY_INCOMPLETE_AT_COMMIT` when a contrary envelope is
 *                sealed AFTER assembly and before `admit_and_dispatch`;
 *   scope        an `operation_kind` no entry lists assembles exactly as before, and a
 *                `cadp.kernel-config.v1` deployment's assembly is byte-identical to v0.4's.
 *
 * The gate under test is the ingress/PEP one, so the fixture policy is deliberately the SIMPLEST
 * one that yields ALLOW for the operation: `extra_plain_allow_operations`. Whether the complete
 * set satisfies a gate remains the evaluator's decision (B4(6)) and is not this file's claim.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after } from "node:test";

import { jcs } from "../kernel/canonical.ts";
import type { AllocationTuple } from "../kernel/ingress.ts";
import type { EvidenceEnvelopeV1, SubjectBinding, TargetRef } from "../kernel/records.ts";
import type {
  AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
} from "../kernel/adapters/types.ts";
import {
  DEFAULT_WORK_RUN_REF, PRINCIPALS, makeHarness, sealScriptedRequest, stopSharedOpa, v2ConfigOverrides,
} from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

after(() => stopSharedOpa());

const REPO = "github.com/astro3141/cadp";
const BASE_SHA = "1111111111111111111111111111111111111111";
const CANDIDATE_SHA = "2222222222222222222222222222222222222222";
/** The exact subject key the declared `{REVIEW, commit, [PR_CREATE]}` entry resolves to. */
const COMMIT_KEY = `github.com|commit|${CANDIDATE_SHA}`;

/** A3's declaration, verbatim: REVIEW, over the `commit` namespace, for `PR_CREATE`. */
const REVIEW_ON_COMMIT = [{ evidence_kind: "REVIEW", subject_namespace: "commit", operation_kinds: ["PR_CREATE"] }];

/**
 * A scripted target that offers `PR_CREATE`, so the recheck-#18 leg reaches the admission
 * transaction. Everything about it is deliberately trivial — no precondition, no native key — the
 * subject under test being the recheck list, not the adapter contract (which §6's own suite owns).
 */
class ScriptedPrTarget implements TargetAdapterV1 {
  readonly operations: AdapterOperation[] = [
    {
      operation_kind: "PR_CREATE", material_schema: "test.scripted-write.v1", available: true,
      idempotency: "NONE", dispatch_precondition: "NONE", reconcile: "BY_QUERY_PREDICATE", no_effect_proof_supported: true,
    },
  ];
  readonly dispatched: string[] = [];

  describe() {
    return { target_type: "SCRIPTED_PR", authority_ref: "scripted:pr", operations: this.operations };
  }

  serialization_domain(): string {
    return "scripted-pr-domain";
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    return { target_ref: this.targetRef(), claim: { tenant: "scripted-pr-1" } };
  }

  async current_revision(subject: SubjectBinding): Promise<RevisionRead> {
    return { revision_or_version: subject.revision_or_version, availability: "PRESENT" };
  }

  async verify_material(): Promise<void> {}

  async dispatch_precondition_read(): Promise<string | undefined> {
    return undefined;
  }

  async dispatch(effect_id: string, ordinal: number, _t: TargetRef, _op: string, material: Record<string, unknown>): Promise<DispatchResult> {
    this.dispatched.push(effect_id);
    return { kind: "ACCEPTED", target_operation_ref: `pr-${effect_id}-${ordinal}`, receipt_claim: { body_digest: material["body_digest"], applied: true } };
  }

  async reconcile(): Promise<ReconcileResult> {
    return { kind: "NO_EFFECT_CONFIRMED", proof_claim: { authoritative_absence: true, read_authority: "primary" } };
  }

  receipt_binds(_op: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    return receipt["body_digest"] === material["body_digest"];
  }

  targetRef(): TargetRef {
    return { authority_ref: "scripted:pr", target_type: "SCRIPTED_PR", target_id: "pr-1" };
  }
}

interface AssemblyHarness {
  h: Harness;
  pr: ScriptedPrTarget;
}

async function makeAssemblyHarness(
  options: { v2?: boolean; declaration?: unknown; disabledIngressRules?: ReadonlySet<string>; disabledChecks?: ReadonlySet<string> } = {},
): Promise<AssemblyHarness> {
  const pr = new ScriptedPrTarget();
  const h = await makeHarness({
    extraAdapters: [pr],
    disabledIngressRules: options.disabledIngressRules,
    disabledChecks: options.disabledChecks,
    paramOverrides: {
      extra_plain_allow_operations: ["SCRIPTED_WRITE", "SCRIPTED_KEYED_WRITE", "SCRIPTED_GUARDED_WRITE", "PR_CREATE"],
    },
    ...(options.v2 === false
      ? {}
      : { configOverrides: v2ConfigOverrides({ subject_complete_assembly: options.declaration ?? REVIEW_ON_COMMIT }) as never }),
  });
  h.sealReach();
  await h.sealTargetIdentity();
  await h.pep.refreshTargetIdentity(pr);
  return { h, pr };
}

/** The three `work_bindings` WP §3.4 mandates for an external candidate (projected by B2(2)(iii)). */
function externalBindings(): SubjectBinding[] {
  return [
    { authority_ref: "github.com", namespace: "repository", object_id: REPO },
    { authority_ref: "github.com", namespace: "base-commit", object_id: BASE_SHA },
    { authority_ref: "github.com", namespace: "commit", object_id: CANDIDATE_SHA },
  ];
}

let stepCounter = 0;

/**
 * Seal a `PR_CREATE` against the scripted PR target. Under v2 the external allocation schema binds
 * the candidate — which is what puts a `commit` subject in the sealed record for B4(2) to read;
 * the `unbound` variant allocates under `cadp.allocation-key.v1` instead, whose only projection is
 * the work run, so the sealed request names no `commit` binding at all.
 */
function sealPrCreate(h: Harness, options: { v2?: boolean; unbound?: boolean } = {}): string {
  const v2 = options.v2 !== false;
  const bodyBytes = Buffer.from(`pr-body-${(stepCounter += 1)}`, "utf8");
  const material = {
    tenant: "scripted-pr-1",
    resource_id: "r-1",
    head_sha: CANDIDATE_SHA,
    body_digest: createHash("sha256").update(bodyBytes).digest("hex"),
    body_cas_key: h.ingress.putBlob(bodyBytes),
  };
  // The external schema is the one that binds the candidate; `unbound` (and the v1-config leg,
  // where the external schema does not exist at all) allocates under `cadp.allocation-key.v1`,
  // whose only projection is the work run — so the sealed request names no `commit` binding.
  const external = v2 && options.unbound !== true;
  const tuple: AllocationTuple = external
    ? { schema: "cadp.allocation-key.external.v1", repo_id: REPO, candidate_base_sha: BASE_SHA, candidate_sha: CANDIDATE_SHA, purpose: "pr-create" }
    : { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: stepCounter, purpose: "pr-create" };
  const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
  const request = h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: "workflow:cadp-work",
      work_bindings: external
        ? externalBindings()
        : [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: DEFAULT_WORK_RUN_REF }],
      target_ref: { authority_ref: "scripted:pr", target_type: "SCRIPTED_PR", target_id: "pr-1" },
      operation_kind: "PR_CREATE",
      material_schema: "test.scripted-write.v1",
      material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
      prior_effect_refs: [],
      ...(v2 ? { allocation_tuple: tuple } : {}),
    },
    PRINCIPALS.workflow,
  );
  return request.effect_id;
}

/** A REVIEW envelope bound to the effect's exact candidate commit — the A3 subject. */
function sealReview(h: Harness, verdict: "APPROVE" | "REJECT", note: string): EvidenceEnvelopeV1 {
  return h.ingress.submitEvidence(
    {
      evidence_kind: "REVIEW",
      subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: CANDIDATE_SHA }],
      availability: "PRESENT",
      claim_schema: "cadp.review.v1",
      claim: { verdict, body_digest: "1".repeat(64), note },
      producer_ref: "reviewer:claude-code",
      source_ref: "test",
      source_relation: "INDEPENDENT_OBSERVATION",
    },
    PRINCIPALS.reviewer,
  );
}

function admissionInputRows(h: Harness): number {
  return (h.store.db.prepare("SELECT COUNT(*) AS n FROM admission_input").get() as { n: number }).n;
}

function refusal(fn: () => unknown, reason: string, note: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { reason?: string }).reason, reason, `${note}: ${String((error as Error).message)}`);
    return true;
  }, note);
}

const sorted = (ids: readonly string[]) => [...ids].sort();

// ================================================================ B4(2)/B4(3) — the union

test("B4(2)/B4(3): the sealed K4 carries BOTH REVIEWs on the exact commit, in canonical order, though the caller passed one", async () => {
  const { h } = await makeAssemblyHarness();
  try {
    const effect_id = sealPrCreate(h);
    const approve = sealReview(h, "APPROVE", "approve");
    const reject = sealReview(h, "REJECT", "reject");

    // The caller withholds the unfavourable envelope — the exact power B4 removes.
    const input = h.ingress.assembleAdmissionInput(effect_id, [approve.evidence_id]);

    const carried = input.evidence_refs.map((r) => r.evidence_id);
    assert.deepEqual(sorted(carried), sorted([approve.evidence_id, reject.evidence_id]), "union: the caller may add, never subtract");
    // B4(3): ordered canonically by evidence_id, so input_digest is deterministic.
    assert.deepEqual(carried, sorted(carried), "canonical order by evidence_id");
    // The digests are the stored envelopes' own, so recheck #3's exact-binding leg holds.
    for (const ref of input.evidence_refs) {
      assert.equal(ref.envelope_digest.value, h.store.evidenceById(ref.evidence_id)!.envelope_digest.value);
    }

    // Determinism, asserted rather than assumed: the same complete set assembles to the same K4
    // whatever order the caller lists its own refs in, and whatever it repeats.
    const again = h.ingress.assembleAdmissionInput(effect_id, [reject.evidence_id, approve.evidence_id, approve.evidence_id]);
    assert.deepEqual(again.evidence_refs.map((r) => r.evidence_id), carried, "deduplicated and canonically ordered");
    assert.equal(
      jcs({ ...again, assembled_at: input.assembled_at, input_digest: input.input_digest }),
      jcs(input),
      "the K4 differs only in its timestamp: the evidence set is not the caller's choice",
    );
  } finally {
    h.close();
  }
});

test("B4(3) guard-bite: with the completeness rule removed, the withheld REJECT never reaches K4", async () => {
  const { h } = await makeAssemblyHarness({ disabledIngressRules: new Set(["assembly_completeness"]) });
  try {
    const effect_id = sealPrCreate(h);
    const approve = sealReview(h, "APPROVE", "approve");
    sealReview(h, "REJECT", "reject");
    const input = h.ingress.assembleAdmissionInput(effect_id, [approve.evidence_id]);
    // The prohibited delta: the evaluator is shown exactly what the caller chose to show it.
    assert.deepEqual(input.evidence_refs.map((r) => r.evidence_id), [approve.evidence_id], "caller selection restored");
  } finally {
    h.close();
  }
});

// ================================================================ B4(2) — unbound subject

test("B4(2): a PR_CREATE binding no commit subject refuses ASSEMBLY_SUBJECT_UNBOUND with no K4 row", async () => {
  const { h } = await makeAssemblyHarness();
  try {
    const effect_id = sealPrCreate(h, { unbound: true });
    sealReview(h, "APPROVE", "approve");
    const before = admissionInputRows(h);
    refusal(
      () => h.ingress.assembleAdmissionInput(effect_id, []),
      "ASSEMBLY_SUBJECT_UNBOUND",
      "a declared kind over an unbound subject is never vacuously satisfied",
    );
    assert.equal(admissionInputRows(h), before, "no AdmissionInputV1 row");
  } finally {
    h.close();
  }
});

// ================================================================ B4(4) — fail closed

test("B4(4): a matched row failing verify-on-read refuses, seals a DIGEST_CORRUPTION incident and writes no K4", async () => {
  const { h } = await makeAssemblyHarness();
  try {
    const effect_id = sealPrCreate(h);
    const approve = sealReview(h, "APPROVE", "approve");
    const reject = sealReview(h, "REJECT", "reject");
    // Corrupt the QUERIED row — the one the caller withheld — at the storage layer.
    const stored = JSON.parse(
      (h.store.db.prepare("SELECT envelope_json AS j FROM evidence_envelope WHERE evidence_id = ?").get(reject.evidence_id) as { j: string }).j,
    ) as Record<string, unknown>;
    (stored["claim"] as Record<string, unknown>)["verdict"] = "APPROVE";
    h.store.db.prepare("UPDATE evidence_envelope SET envelope_json = ? WHERE evidence_id = ?").run(JSON.stringify(stored), reject.evidence_id);

    const before = admissionInputRows(h);
    refusal(() => h.ingress.assembleAdmissionInput(effect_id, [approve.evidence_id]), "DIGEST_CORRUPTION", "a partial set is never sealed");
    assert.equal(admissionInputRows(h), before, "no AdmissionInputV1 row");
    const incidents = h.store.db
      .prepare("SELECT envelope_json AS j FROM evidence_envelope WHERE evidence_kind = 'KERNEL_INCIDENT'")
      .all() as Array<{ j: string }>;
    assert.ok(
      incidents.some((row) => (JSON.parse(row.j) as EvidenceEnvelopeV1).claim !== undefined &&
        ((JSON.parse(row.j) as EvidenceEnvelopeV1).claim as { incident_kind?: string }).incident_kind === "DIGEST_CORRUPTION"),
      "DIGEST_CORRUPTION incident sealed in its own transaction",
    );
  } finally {
    h.close();
  }
});

test("B4(4): a completeness query that cannot be executed refuses ASSEMBLY_QUERY_FAILED with no K4 row", async () => {
  const { h } = await makeAssemblyHarness();
  try {
    const effect_id = sealPrCreate(h);
    const approve = sealReview(h, "APPROVE", "approve");
    const before = admissionInputRows(h);
    // Fault injection at the store seam: the kernel path under test stays the production path.
    const real = h.store.evidenceBySubjectKey.bind(h.store);
    (h.store as { evidenceBySubjectKey: (key: string) => never }).evidenceBySubjectKey = (key: string) => {
      throw new Error(`injected read failure on ${key}`);
    };
    try {
      refusal(
        () => h.ingress.assembleAdmissionInput(effect_id, [approve.evidence_id]),
        "ASSEMBLY_QUERY_FAILED",
        "an unexecutable completeness query is a refusal, never a caller-only assembly",
      );
    } finally {
      (h.store as { evidenceBySubjectKey: unknown }).evidenceBySubjectKey = real;
    }
    assert.equal(admissionInputRows(h), before, "no AdmissionInputV1 row");
    // Positive control, so the refusal is attributed to the injected failure and not to the setup.
    assert.equal(h.ingress.assembleAdmissionInput(effect_id, [approve.evidence_id]).evidence_refs.length, 1);
  } finally {
    h.close();
  }
});

// ================================================================ B4(5) — recheck #18

test("B4(5): a contrary envelope sealed AFTER assembly refuses at recheck #18 with ASSEMBLY_INCOMPLETE_AT_COMMIT", async () => {
  const { h, pr } = await makeAssemblyHarness();
  try {
    const effect_id = sealPrCreate(h);
    const approve = sealReview(h, "APPROVE", "approve");
    const input = h.ingress.assembleAdmissionInput(effect_id, [approve.evidence_id]);
    const evaluated = await h.evaluate(input.input_digest.value);
    assert.equal(evaluated.kind, "DECISION");
    assert.equal(evaluated.kind === "DECISION" ? evaluated.decision.outcome : undefined, "ALLOW", "the decision under test is an ALLOW");

    // A producer seals a contrary REVIEW on the same exact subject AFTER assembly. The decision is
    // now stale: it was taken over a set that is no longer the complete one.
    const late = sealReview(h, "REJECT", "late reject");

    const admitted = await h.pep.admitAndDispatch(effect_id, (evaluated as { decision: { decision_id: string } }).decision.decision_id);
    assert.equal(admitted.kind, "REFUSAL");
    assert.equal((admitted as { reason: string }).reason, "ASSEMBLY_INCOMPLETE_AT_COMMIT");
    assert.match((admitted as { detail?: string }).detail ?? "", new RegExp(late.evidence_id), "the refusal names the envelope the input does not carry");
    assert.deepEqual(pr.dispatched, [], "no dispatch: the refusal is inside the admission transaction");
    assert.equal((h.store.db.prepare("SELECT COUNT(*) AS n FROM effect_admission").get() as { n: number }).n, 0, "no K6 row");

    // Fail-closed, not a dead end (B4(5)): a fresh assembly and evaluation resolve it, and the
    // fresh K4 carries all three envelopes.
    const fresh = h.ingress.assembleAdmissionInput(effect_id, []);
    assert.deepEqual(
      fresh.evidence_refs.map((r) => r.evidence_id),
      sorted([approve.evidence_id, late.evidence_id]),
      "the fresh complete set carries both, the caller having named neither",
    );
    const reEvaluated = await h.evaluate(fresh.input_digest.value);
    assert.equal(reEvaluated.kind, "DECISION");
    const readmitted = await h.pep.admitAndDispatch(effect_id, (reEvaluated as { decision: { decision_id: string } }).decision.decision_id);
    assert.equal(readmitted.kind, "ADMITTED", JSON.stringify(readmitted));
    assert.deepEqual(pr.dispatched, [effect_id], "the re-assembled admission dispatches");
  } finally {
    h.close();
  }
});

test("B4(5) guard-bite: with recheck #18 removed, the stale decision admits and the effect lands", async () => {
  // The knob is the PEP's TEST-ONLY guard-bite harness (TD §13.1); production never passes it.
  const { h, pr } = await makeAssemblyHarness({ disabledChecks: new Set(["recheck18_assembly_complete"]) });
  try {
    const effect_id = sealPrCreate(h);
    const approve = sealReview(h, "APPROVE", "approve");
    const input = h.ingress.assembleAdmissionInput(effect_id, [approve.evidence_id]);
    const evaluated = await h.evaluate(input.input_digest.value);
    assert.equal(evaluated.kind, "DECISION");
    sealReview(h, "REJECT", "late reject");
    const admitted = await h.pep.admitAndDispatch(effect_id, (evaluated as { decision: { decision_id: string } }).decision.decision_id);
    // The prohibited durable delta: an effect dispatched on a decision the store already contradicts.
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.deepEqual(pr.dispatched, [effect_id], "the stale decision reached the target");
  } finally {
    h.close();
  }
});

// ================================================================ scope

test("scope: an operation_kind no entry lists assembles exactly as before — the caller's refs, verbatim", async () => {
  const { h } = await makeAssemblyHarness();
  try {
    // Two REVIEWs exist on the commit subject; the declaration lists PR_CREATE only.
    const approve = sealReview(h, "APPROVE", "approve");
    sealReview(h, "REJECT", "reject");
    const human = h.ingress.submitEvidence(
      {
        evidence_kind: "REVIEW",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: CANDIDATE_SHA }],
        availability: "PRESENT",
        claim_schema: "cadp.review.v1",
        claim: { verdict: "APPROVE", body_digest: "2".repeat(64), note: "third" },
        producer_ref: "reviewer:claude-code",
        source_ref: "test",
        source_relation: "INDEPENDENT_OBSERVATION",
      },
      PRINCIPALS.reviewer,
    );
    const { request } = sealScriptedRequest(h, { work_run_ref: DEFAULT_WORK_RUN_REF });
    const input = h.ingress.assembleAdmissionInput(request.effect_id, [human.evidence_id, approve.evidence_id]);
    assert.deepEqual(
      input.evidence_refs.map((r) => r.evidence_id),
      [human.evidence_id, approve.evidence_id],
      "SCRIPTED_WRITE is listed by no entry: caller refs only, in the caller's order",
    );
  } finally {
    h.close();
  }
});

test("scope: under cadp.kernel-config.v1 assembly is v0.4's — caller refs only, undeduplicated, in order", async () => {
  const { h } = await makeAssemblyHarness({ v2: false });
  try {
    const effect_id = sealPrCreate(h, { v2: false });
    const approve = sealReview(h, "APPROVE", "approve");
    sealReview(h, "REJECT", "reject");
    const input = h.ingress.assembleAdmissionInput(effect_id, [approve.evidence_id, approve.evidence_id]);
    assert.deepEqual(
      input.evidence_refs.map((r) => r.evidence_id),
      [approve.evidence_id, approve.evidence_id],
      "v1: the caller's list verbatim — no union, no dedup, no reordering",
    );
  } finally {
    h.close();
  }
});
