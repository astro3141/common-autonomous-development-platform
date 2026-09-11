/**
 * AP B1/B2 — requester-scoped allocation, the allocation binding storage, and the
 * allocation-to-first-seal contract that closes the pre-K3 window (WP §3.3).
 *
 * The legs here are the ones §C references rather than duplicates: WP controls 7 (candidate),
 * 8 (base), 9 (purpose) and 10 (principal) as first-seal refusals BEFORE any K3 record exists;
 * WP controls 1/2 as retry convergence and cross-principal distinctness; the typed-tuple legs of
 * B2(2)(i); the contract-drift refusal and its one-call recovery (B2(3.3), B2(9), B1(2)); the
 * cross-principal re-seal closure of B2(10); and the kernel-namespace ambiguity lock of B3(4)(b).
 * Two legs carry a real guard-bite through the Ingress's TEST-ONLY `disabledRules` knob.
 *
 * Every case runs against a `cadp.kernel-config.v2` harness, because every rule below is gated on
 * the active config's schema string. The last test is the complementary claim: under
 * `cadp.kernel-config.v1` the v0.4 allocation and seal behaviour is unchanged, unscoped key
 * included — this lane must not touch the running v0.4 reference deployment.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test, { after } from "node:test";

import { startKernelApi } from "../../kernel/api.ts";
import { Cas } from "../../kernel/cas.ts";
import { jcs, sha256Hex } from "../../kernel/canonical.ts";
import { Ingress, IngressRejection } from "../../kernel/ingress.ts";
import type { AllocationTuple, Principal } from "../../kernel/ingress.ts";
import { ConstitutionalStore } from "../../kernel/store.ts";
import type { SubjectBinding } from "../../kernel/records.ts";
import { REFERENCE_IDENTITIES } from "../../deployment/referencePolicy.ts";
import {
  DEFAULT_WORK_RUN_REF, PEP_REF, PRINCIPALS, V2_ALLOCATION_SCHEMAS, makeHarness, runChain,
  sealScriptedRequest, stopSharedOpa, v2ConfigOverrides,
} from "../support/harness.ts";
import type { Harness, HarnessOptions } from "../support/harness.ts";

after(() => stopSharedOpa());

/** A second `workflow`-class principal: the non-owner of every cross-principal leg below. */
const PRINCIPAL_B: Principal = { principal: "cadp-workflow-b" };
const IDENTITY_B = {
  principal: "cadp-workflow-b",
  producer_ref: "workflow:cadp-work-b",
  identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" },
};
const REQUESTER_A = "workflow:cadp-work";
const REQUESTER_B = "workflow:cadp-work-b";

const REPO = "github.com/astro3141/cadp";
const BASE_SHA = "1111111111111111111111111111111111111111";
const CANDIDATE_SHA = "2222222222222222222222222222222222222222";

function externalTuple(overrides: Record<string, unknown> = {}): AllocationTuple {
  return {
    schema: "cadp.allocation-key.external.v1",
    repo_id: REPO,
    candidate_base_sha: BASE_SHA,
    candidate_sha: CANDIDATE_SHA,
    purpose: "pr-create",
    ...overrides,
  } as AllocationTuple;
}

/** The `work_bindings` an external-candidate first seal must carry (WP §3.4, projected by B2(2)(iii)). */
function externalBindings(overrides: { repo?: string; base?: string; candidate?: string } = {}): SubjectBinding[] {
  return [
    { authority_ref: "github.com", namespace: "repository", object_id: overrides.repo ?? REPO },
    { authority_ref: "github.com", namespace: "base-commit", object_id: overrides.base ?? BASE_SHA },
    { authority_ref: "github.com", namespace: "commit", object_id: overrides.candidate ?? CANDIDATE_SHA },
  ];
}

function v2Harness(options: HarnessOptions = {}): Promise<Harness> {
  return makeHarness({
    ...options,
    identityRegistry: options.identityRegistry ?? [...REFERENCE_IDENTITIES, IDENTITY_B],
    configOverrides: v2ConfigOverrides(options.configOverrides ?? {}) as never,
  });
}

/** Seal a request through the production path, with the tuple as B6(1)'s transport sibling. */
function seal(
  h: Harness,
  principal: Principal,
  options: {
    effect_id: string;
    requester_ref?: string;
    operation_kind?: string;
    work_bindings?: SubjectBinding[];
    /** `unknown`, not `AllocationTuple`: the shape-guard legs present malformed transport here. */
    allocation_tuple?: unknown;
    body?: string;
  },
) {
  const bodyBytes = Buffer.from(options.body ?? "external-candidate", "utf8");
  const material = {
    tenant: "scripted-1",
    resource_id: "r-1",
    body_digest: createHash("sha256").update(bodyBytes).digest("hex"),
    body_cas_key: h.ingress.putBlob(bodyBytes),
  };
  return h.ingress.sealEffectRequest(
    {
      effect_id: options.effect_id,
      requester_ref: options.requester_ref ?? REQUESTER_A,
      work_bindings: options.work_bindings ?? externalBindings(),
      target_ref: h.target.targetRef(),
      operation_kind: options.operation_kind ?? "PR_CREATE",
      material_schema: "test.scripted-write.v1",
      material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
      prior_effect_refs: [],
      ...(options.allocation_tuple === undefined ? {} : { allocation_tuple: options.allocation_tuple }),
    },
    principal,
  );
}

function refusal(fn: () => unknown, reason: string, note: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { reason?: string }).reason, reason, `${note}: ${String((error as Error).message)}`);
    return true;
  }, note);
}

function countRows(h: Harness, table: "effect_allocation" | "effect_request"): number {
  return (h.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function incidents(h: Harness): number {
  return (h.store.db.prepare("SELECT COUNT(*) AS n FROM evidence_envelope WHERE evidence_kind = 'KERNEL_INCIDENT'").get() as { n: number }).n;
}

// ================================================================ B1 — allocation

test("B1(2): allocation converges per principal and separates principals; the row records the contract", async () => {
  const h = await v2Harness();
  try {
    const tuple = externalTuple();
    const a = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    // WP control 1: a retry by the same principal under an unchanged contract converges — one
    // logical effect, one identity, no second row.
    assert.equal(h.ingress.allocateEffectId({ ...tuple }, PRINCIPALS.workflow), a, "retry converges");
    // WP control 2: an identical tuple from another principal is a DIFFERENT effect identity.
    const b = h.ingress.allocateEffectId(tuple, PRINCIPAL_B);
    assert.notEqual(b, a, "the key is requester-scoped");
    assert.equal(countRows(h, "effect_allocation"), 2);

    const row = h.store.allocationByEffectId(a)!;
    assert.equal(row.binding?.requester_ref, REQUESTER_A, "the STAMPED requester, never a body field");
    assert.equal(row.binding?.allocation_schema, "cadp.allocation-key.external.v1");
    assert.equal(row.binding?.purpose, "pr-create");
    // B2(1): the binding digest is over the `cadp-jcs-1` form of the wire tuple AS RECEIVED.
    assert.equal(row.binding?.allocation_binding_digest, sha256Hex(jcs(tuple)));
    // B2(1): the contract digest is over `allocation_contract_payload.v1` — the schema's
    // descriptor entry and `allocation_schemas` entry verbatim, under exactly those two member
    // names. Spelled out here from the bundle data rather than taken from the implementation's
    // helper, so the pinned preimage is asserted and not assumed.
    assert.equal(
      row.binding?.allocation_contract_digest,
      sha256Hex(jcs({
        descriptor: {
          schema: "cadp.allocation-key.external.v1",
          fields: [
            { field: "repo_id", role: "PROJECTED", value_contract: "NONEMPTY_STRING" },
            { field: "candidate_base_sha", role: "PROJECTED", value_contract: "NONEMPTY_STRING" },
            { field: "candidate_sha", role: "PROJECTED", value_contract: "NONEMPTY_STRING" },
          ],
        },
        allocation_schema: V2_ALLOCATION_SCHEMAS[1],
      })),
    );
    assert.equal(incidents(h), 0, "allocation raises no incident");
  } finally {
    h.close();
  }
});

test("B2(2)(i)/B2(5): the tuple is validated on BOTH axes — descriptor key set and value_contract", async () => {
  const h = await v2Harness();
  try {
    const base = {
      schema: "cadp.allocation-key.v1",
      work_run_ref: DEFAULT_WORK_RUN_REF,
      step_ordinal: 1,
      purpose: "record-write",
    };
    // The typed-tuple legs of §C: `step_ordinal` is ENTROPY, projected nowhere and re-verified at
    // no seal, so a key-set-only migration would let these mint DISTINCT effect_ids for one
    // logical step — the retry-convergence break the value contract exists to refuse.
    for (const step_ordinal of ["1", 0, -1, 1.5]) {
      refusal(
        () => h.ingress.allocateEffectId({ ...base, step_ordinal } as never, PRINCIPALS.workflow),
        "ALLOCATION_TUPLE_INVALID",
        `step_ordinal ${JSON.stringify(step_ordinal)}`,
      );
    }
    // The EFFECT_ID leg: a nonempty string lacking the effect-id shape.
    refusal(
      () => h.ingress.allocateEffectId({ ...base, work_run_ref: "not-an-effect-id" }, PRINCIPALS.workflow),
      "ALLOCATION_TUPLE_INVALID",
      "work_run_ref shape",
    );
    // Key set: unknown key, missing key, and (B1(1)) a presented requester field.
    refusal(
      () => h.ingress.allocateEffectId({ ...base, candidate_sha: CANDIDATE_SHA }, PRINCIPALS.workflow),
      "ALLOCATION_TUPLE_INVALID",
      "unknown key",
    );
    const { step_ordinal: _dropped, ...missing } = base;
    refusal(() => h.ingress.allocateEffectId(missing as never, PRINCIPALS.workflow), "ALLOCATION_TUPLE_INVALID", "missing key");
    refusal(
      () => h.ingress.allocateEffectId({ ...base, requester_ref: REQUESTER_B }, PRINCIPALS.workflow),
      "ALLOCATION_TUPLE_INVALID",
      "presented requester_ref",
    );
    assert.equal(countRows(h, "effect_allocation"), 0, "no effect_allocation row for any refused tuple");

    // Positive control, so the refusals are attributed to the values and not to the tuple.
    const allocated = h.ingress.allocateEffectId(base, PRINCIPALS.workflow);
    assert.equal(countRows(h, "effect_allocation"), 1);

    // Positive convergence leg: the contract is a PARSED-VALUE rule, not a lexical one. The three
    // wire forms parse to one value, canonicalize to one preimage and mint ONE identity.
    for (const lexeme of ["1", "1.0", "1e0"]) {
      const wire = JSON.parse(`{"schema":"cadp.allocation-key.v1","work_run_ref":"${DEFAULT_WORK_RUN_REF}","step_ordinal":${lexeme},"purpose":"record-write"}`);
      assert.equal(h.ingress.allocateEffectId(wire, PRINCIPALS.workflow), allocated, `wire form ${lexeme}`);
    }
    assert.equal(countRows(h, "effect_allocation"), 1, "one row and one identity across the three lexemes");
  } finally {
    h.close();
  }
});

test("B2(5)/B1(1): schema, purpose and principal refusals all precede any effect_allocation row", async () => {
  const h = await v2Harness();
  try {
    // No descriptor and no mapping ⇒ unallocatable, so no allocation can exist that a first seal
    // would have to check against nothing.
    refusal(
      () => h.ingress.allocateEffectId({ schema: "cadp.allocation-key.unknown.v9", purpose: "pr-create" }, PRINCIPALS.workflow),
      "ALLOCATION_SCHEMA_UNREGISTERED",
      "unregistered schema",
    );
    // The v0.4 `allocation_purposes` membership check is unchanged, code included (B2(5)).
    refusal(
      () => h.ingress.allocateEffectId(externalTuple({ purpose: "not-a-purpose" }), PRINCIPALS.workflow),
      "ALLOCATION_TUPLE_INVALID",
      "purpose outside allocation_purposes",
    );
    // Registered purpose, but this schema's entry pairs no operation_kind with it: the new
    // allocation-time totality refusal that keeps every allocation checkable at first seal.
    refusal(
      () => h.ingress.allocateEffectId(externalTuple({ purpose: "record-write" }), PRINCIPALS.workflow),
      "ALLOCATION_PURPOSE_NOT_REGISTERED",
      "purpose with no purpose_relation entry",
    );
    refusal(
      () => h.ingress.allocateEffectId(externalTuple(), { principal: "cadp-not-registered" }),
      "FORBIDDEN_FOR_PRINCIPAL",
      "unregistered principal",
    );
    assert.equal(countRows(h, "effect_allocation"), 0);
  } finally {
    h.close();
  }
});

// ================================================================ B2(3) — the first seal

test("B2(3): WP controls 7-10 — candidate, base, purpose and principal refused BEFORE any K3 record", async () => {
  const h = await v2Harness();
  try {
    const tuple = externalTuple();
    const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);

    const legs: Array<[string, string, () => unknown]> = [
      // control 7 — a first seal naming a different candidate than the allocation.
      ["candidate", "ALLOCATION_BINDING_MISMATCH", () =>
        seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: tuple, work_bindings: externalBindings({ candidate: "3".repeat(40) }) })],
      // control 8 — a different base revision.
      ["base", "ALLOCATION_BINDING_MISMATCH", () =>
        seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: tuple, work_bindings: externalBindings({ base: "4".repeat(40) }) })],
      // Zero bindings on a projected target pair is the same refusal as a mismatching one.
      ["unbound", "ALLOCATION_BINDING_MISMATCH", () =>
        seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: tuple, work_bindings: externalBindings().slice(0, 2) })],
      // The full (authority_ref, namespace) pair is matched: the same sha under another authority
      // is not the allocated subject (B2(4)).
      ["other authority", "ALLOCATION_BINDING_MISMATCH", () =>
        seal(h, PRINCIPALS.workflow, {
          effect_id, allocation_tuple: tuple,
          work_bindings: [...externalBindings().slice(0, 2), { authority_ref: "forge.example", namespace: "commit", object_id: CANDIDATE_SHA }],
        })],
      // control 9 — the sealed operation_kind is not the one paired with the allocated purpose.
      ["purpose", "ALLOCATION_PURPOSE_MISMATCH", () =>
        seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: tuple, operation_kind: "PR_MERGE" })],
      // control 10 — a first seal by a principal other than the allocator.
      ["principal", "ALLOCATION_PRINCIPAL_MISMATCH", () =>
        seal(h, PRINCIPAL_B, { effect_id, allocation_tuple: tuple, requester_ref: REQUESTER_B })],
      // B6(1)/B6(2): the tuple is required on a first seal, and a different one is refused.
      ["tuple absent", "ALLOCATION_TUPLE_REQUIRED", () => seal(h, PRINCIPALS.workflow, { effect_id })],
      ["tuple different", "ALLOCATION_BINDING_MISMATCH", () =>
        seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: externalTuple({ candidate_sha: "5".repeat(40) }) })],
      // A caller-invented effect identity has no allocation row at all (Spec v0.5 K3).
      ["never allocated", "ALLOCATION_NOT_FOUND", () =>
        seal(h, PRINCIPALS.workflow, { effect_id: "cadp-v04:effect:00000000-0000-7000-8000-0000000000ff", allocation_tuple: tuple })],
    ];
    for (const [note, reason, attempt] of legs) {
      refusal(attempt, reason, note);
      assert.equal(countRows(h, "effect_request"), 0, `${note}: zero effect_request rows`);
      assert.equal(incidents(h), 0, `${note}: zero KERNEL_INCIDENT rows`);
    }

    // Positive control, so every refusal above is attributed to its own leg and not to the shape:
    // the conforming first seal SEALS, and its `request_digest` carries no allocation_tuple —
    // B6(1)'s "transport, never a draft field" over the implemented parse.
    const sealed = seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: tuple });
    assert.equal(countRows(h, "effect_request"), 1);
    assert.equal((sealed as unknown as Record<string, unknown>)["allocation_tuple"], undefined);
    const stored = h.store.effectRequest(effect_id)!;
    assert.deepEqual(stored, sealed, "the stored K3 row is the sealed record");
    assert.ok(!Object.keys(stored).includes("allocation_tuple"), "the tuple is in no K3 field");
    // B6(2): a re-seal may repeat the tuple (idempotent) and is refused if it differs.
    assert.equal(seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: tuple }).request_digest.value, sealed.request_digest.value);
    refusal(
      () => seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: externalTuple({ candidate_sha: "6".repeat(40) }) }),
      "ALLOCATION_BINDING_MISMATCH",
      "re-seal with a different tuple",
    );
    assert.equal(incidents(h), 0, "no incident on any of it");
  } finally {
    h.close();
  }
});

test("B2(3.4): exactly one binding per projected target pair — two is AMBIGUOUS, same object_id included", async () => {
  const h = await v2Harness();
  try {
    // Two bindings on the projected commit pair: once with a second sha that does NOT match the
    // allocation, once with a duplicate of the one that does — "exactly one", not "at least one".
    const cases = [["the allocated sha", CANDIDATE_SHA], ["another sha", "7".repeat(40)]] as const;
    for (const [index, [note, second]] of cases.entries()) {
      // A distinct base per leg, so each leg allocates its own effect identity.
      const base = `${index}`.repeat(40);
      const tuple = externalTuple({ candidate_base_sha: base });
      const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
      refusal(
        () => seal(h, PRINCIPALS.workflow, {
          effect_id,
          allocation_tuple: tuple,
          work_bindings: [
            ...externalBindings({ base }),
            { authority_ref: "github.com", namespace: "commit", object_id: second },
          ],
        }),
        "ALLOCATION_BINDING_AMBIGUOUS",
        `two commit bindings, second = ${note}`,
      );
      assert.equal(countRows(h, "effect_request"), 0, "zero effect_request rows");
      assert.equal(incidents(h), 0, "zero KERNEL_INCIDENT rows");
    }
    // Scope note, asserted rather than implied: two bindings in a namespace that no projection
    // names and that `kernel_subject_namespaces` does not declare still seal — `records.ts`
    // imposes no SubjectBinding uniqueness and this contract adds none.
    const effect_id = h.ingress.allocateEffectId(externalTuple({ candidate_sha: "8".repeat(40) }), PRINCIPALS.workflow);
    seal(h, PRINCIPALS.workflow, {
      effect_id,
      allocation_tuple: externalTuple({ candidate_sha: "8".repeat(40) }),
      work_bindings: [
        ...externalBindings({ candidate: "8".repeat(40) }),
        { authority_ref: "github.com", namespace: "issue", object_id: "1" },
        { authority_ref: "github.com", namespace: "issue", object_id: "2" },
      ],
    });
    assert.equal(countRows(h, "effect_request"), 1);
  } finally {
    h.close();
  }
});

test("B2(5): the INTERNAL schema is not exempt — the same binding and purpose legs run against v1's entry", async () => {
  const h = await v2Harness();
  try {
    const R1 = DEFAULT_WORK_RUN_REF;
    const R2 = "cadp-v04:effect:00000000-0000-7000-8000-000000000022";
    const tuple = { schema: "cadp.allocation-key.v1", work_run_ref: R1, step_ordinal: 1, purpose: "record-write" };
    const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    // §C's v1 leg of controls 7/8: allocated for run R1, first-sealed naming run R2 — the sealed
    // work-run binding's object_id ≠ the allocated `work_run_ref`, by the one generic projection
    // comparison of B2(3.4), with no v1-specific path.
    refusal(
      () => seal(h, PRINCIPALS.workflow, {
        effect_id, allocation_tuple: tuple, operation_kind: "SCRIPTED_WRITE",
        work_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: R2 }],
      }),
      "ALLOCATION_BINDING_MISMATCH",
      "internal schema, R2-bound first seal",
    );
    // §C's v1 purpose leg: the allocated purpose pairs with SCRIPTED_WRITE in this bundle, so any
    // other sealed operation_kind is refused — the identical refusal on the identical code path.
    refusal(
      () => seal(h, PRINCIPALS.workflow, {
        effect_id, allocation_tuple: tuple, operation_kind: "PR_CREATE",
        work_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: R1 }],
      }),
      "ALLOCATION_PURPOSE_MISMATCH",
      "internal schema, mismatching operation_kind",
    );
    assert.equal(countRows(h, "effect_request"), 0, "zero effect_request rows");
    assert.equal(incidents(h), 0, "zero KERNEL_INCIDENT rows");
    // Positive control on the same allocation.
    seal(h, PRINCIPALS.workflow, {
      effect_id, allocation_tuple: tuple, operation_kind: "SCRIPTED_WRITE",
      work_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: R1 }],
    });
    assert.equal(countRows(h, "effect_request"), 1);
  } finally {
    h.close();
  }
});

test("B3(4)(b): two bindings in a DECLARED kernel namespace are refused pre-K3; guard-bite lands the divergence", async () => {
  for (const bite of [false, true]) {
    const h = await v2Harness(bite ? { disabledIngressRules: new Set(["kernel_namespace_lock"]) } : {});
    try {
      const R1 = DEFAULT_WORK_RUN_REF;
      const R2 = "cadp-v04:effect:00000000-0000-7000-8000-000000000022";
      const tuple = { schema: "cadp.allocation-key.v1", work_run_ref: R1, step_ordinal: 1, purpose: "record-write" };
      const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
      // `{other, work-run, R2}` ordered FIRST, the projection-satisfying `{cadp-store:k04,
      // work-run, R1}` second: the exact-pair projection passes on R1 while every kernel consumer
      // that still selects by namespace alone reads R2.
      const work_bindings: SubjectBinding[] = [
        { authority_ref: "other", namespace: "work-run", object_id: R2 },
        { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: R1 },
      ];
      const attempt = () => seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: tuple, operation_kind: "SCRIPTED_WRITE", work_bindings });
      if (!bite) {
        refusal(attempt, "KERNEL_NAMESPACE_AMBIGUOUS", "two work-run bindings");
        assert.equal(countRows(h, "effect_request"), 0, "zero effect_request rows");
        assert.equal(incidents(h), 0, "zero KERNEL_INCIDENT rows");
      } else {
        // Guard-bite: with the lock removed the request SEALS and the store's own work-run index
        // records R2 — the effect counted against a run it is not bound to, which is the delta.
        attempt();
        assert.deepEqual(h.store.effectIdsByWorkRun(R2), [effect_id], "the kernel reads R2");
        assert.deepEqual(h.store.effectIdsByWorkRun(R1), [], "while the projection passed on R1");
      }
    } finally {
      h.close();
    }
  }
});

// ================================================================ B2(10) — the cross-principal gate

test("B2(10): a non-owner's re-seal of a SEALED effect is refused with no incident and no scope hold", async () => {
  for (const bite of [false, true]) {
    const h = await v2Harness(bite ? { disabledIngressRules: new Set(["allocation_principal_gate"]) } : {});
    try {
      h.sealReach();
      await h.sealTargetIdentity();
      // A allocates E and first-seals it normally.
      const { request } = sealScriptedRequest(h);
      const before = JSON.stringify(h.store.effectRequest(request.effect_id));

      // B calls seal_effect_request on E with arbitrary material, and again with a byte-identical
      // copy of A's. B's stamped requester_ref is the ONLY thing that differs in the second case —
      // which is exactly what the K3 semantic payload would conflict on.
      const attempts = [
        () => seal(h, PRINCIPAL_B, {
          effect_id: request.effect_id, requester_ref: REQUESTER_B, operation_kind: "SCRIPTED_WRITE",
          work_bindings: [...request.work_bindings], body: "B's own material",
        }),
        () => seal(h, PRINCIPAL_B, {
          effect_id: request.effect_id, requester_ref: REQUESTER_B, operation_kind: "SCRIPTED_WRITE",
          work_bindings: [...request.work_bindings], body: "scripted-body",
        }),
      ];
      if (!bite) {
        for (const attempt of attempts) refusal(attempt, "ALLOCATION_PRINCIPAL_MISMATCH", "non-owner re-seal");
        assert.equal(incidents(h), 0, "ZERO KERNEL_INCIDENT rows");
        assert.equal(h.ingress.scopeHeld(request), undefined, "ZERO scope holds on the owner's effect");
        assert.equal(JSON.stringify(h.store.effectRequest(request.effect_id)), before, "stored row byte-unchanged");
        // And A's effect admits and dispatches afterwards, unaffected.
        const chain = await runChain(h, request.effect_id);
        assert.equal(chain.admitted?.kind, "ADMITTED", JSON.stringify(chain.admitted));
        assert.equal(h.target.effects.length, 1, "external effect delta 1");
      } else {
        // Guard-bite: with the pre-comparison removed, B's call reaches the K3 semantic
        // comparison, which differs on the stamped requester_ref alone — REQUEST_DIGEST_CONFLICT,
        // a KERNEL_INCIDENT, and a scope hold on A's effect. That is the prohibited durable delta.
        refusal(attempts[0]!, "REQUEST_DIGEST_CONFLICT", "guard-bitten non-owner re-seal");
        assert.equal(incidents(h), 1, "guard-bite: an incident B could raise on A's effect");
        assert.notEqual(h.ingress.scopeHeld(request), undefined, "guard-bite: A's effect scope is frozen by B");
      }
    } finally {
      h.close();
    }
  }
});

test("B2(7): under concurrent first seals the mismatching one never lands, in either interleaving", async () => {
  for (const mismatchFirst of [false, true]) {
    const h = await v2Harness();
    try {
      const tuple = externalTuple();
      const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
      // A second kernel instance over the same store file — the C15 shape. BEGIN IMMEDIATE
      // serializes whole transactions, so each run realizes one interleaving; both are asserted.
      // The legs compare against the IMMUTABLE allocation row, never against a race-visible
      // request row, so no ordering makes the mismatching seal land.
      const store2 = new ConstitutionalStore(join(h.dir, "k04.sqlite"));
      const cas2 = new Cas(store2, h.clock.fn);
      const ingress2 = new Ingress(store2, cas2, PEP_REF, h.clock.fn);
      const second: Harness = { ...h, store: store2, cas: cas2, ingress: ingress2 };
      const matching = () => seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: tuple });
      const mismatching = () => seal(second, PRINCIPALS.workflow, {
        effect_id, allocation_tuple: tuple, work_bindings: externalBindings({ candidate: "9".repeat(40) }),
      });
      if (mismatchFirst) {
        refusal(mismatching, "ALLOCATION_BINDING_MISMATCH", "mismatching seal races first");
        matching();
      } else {
        matching();
        // After the matching row exists the mismatching seal is an ordinary K3 comparison against
        // it — different material, the owner's own re-seal: REQUEST_DIGEST_CONFLICT, unchanged.
        refusal(mismatching, "REQUEST_DIGEST_CONFLICT", "mismatching seal races second");
      }
      assert.equal(countRows(h, "effect_request"), 1, "exactly one effect_request row");
      const stored = h.store.effectRequest(effect_id)!;
      assert.ok(
        stored.work_bindings.some((b) => b.namespace === "commit" && b.object_id === CANDIDATE_SHA),
        "the landed row is the ALLOCATED candidate, never the mismatching one",
      );
      store2.close();
    } finally {
      h.close();
    }
  }
});

// ================================================================ B2(3.3)/B2(9) — contract drift

test("B2(3.3)/B1(2): a projection swap refuses the stale effect_id and re-allocation recovers in one call", async () => {
  const h = await v2Harness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();

    // Positive control first, so the refusal below is shown to be an ENTRY digest and not a
    // policy-wide one: an unrelated activation leaves this schema's entry byte-identical and
    // invalidates no allocation made before it.
    const unrelatedTuple = externalTuple({ candidate_sha: "a".repeat(40) });
    const unrelated = h.ingress.allocateEffectId(unrelatedTuple, PRINCIPALS.workflow);
    const added = await h.activatePolicy({
      revision: 2,
      configOverrides: {
        identity_registry: [...REFERENCE_IDENTITIES, IDENTITY_B, {
          principal: "cadp-workflow-c", producer_ref: "workflow:cadp-work-c",
          identity_class: { ...IDENTITY_B.identity_class },
        }],
      } as never,
    });
    assert.equal((added.admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(added.admitted));
    seal(h, PRINCIPALS.workflow, {
      effect_id: unrelated, allocation_tuple: unrelatedTuple,
      work_bindings: externalBindings({ candidate: "a".repeat(40) }),
    });
    assert.equal(h.store.effectRequest(unrelated)?.effect_id, unrelated, "an unrelated policy change seals fine");

    // Now the swap: the entry that mapped `candidate_sha` onto the commit target now maps
    // `candidate_base_sha` onto it, and vice versa. No other change.
    const tuple = externalTuple();
    const stale = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    const swapped = [
      V2_ALLOCATION_SCHEMAS[0],
      {
        ...V2_ALLOCATION_SCHEMAS[1],
        binding_projection: [
          { tuple_field: "repo_id", authority_ref: "github.com", namespace: "repository" },
          { tuple_field: "candidate_base_sha", authority_ref: "github.com", namespace: "commit" },
          { tuple_field: "candidate_sha", authority_ref: "github.com", namespace: "base-commit" },
        ],
      },
    ];
    const activated = await h.activatePolicy({ revision: 3, configOverrides: { allocation_schemas: swapped } as never });
    assert.equal((activated.admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(activated.admitted));

    // The byte-identical tuple re-presented with `work_bindings` arranged to satisfy the NEW
    // projection: every other equality passes, and the seal is still refused — without this leg
    // it would seal an effect whose material is the inverse of what was allocated.
    const newProjection = externalBindings({ base: CANDIDATE_SHA, candidate: BASE_SHA });
    refusal(
      () => seal(h, PRINCIPALS.workflow, { effect_id: stale, allocation_tuple: tuple, work_bindings: newProjection }),
      "ALLOCATION_CONTRACT_CHANGED",
      "swapped projection under a byte-identical tuple",
    );
    assert.equal(h.store.effectRequest(stale), undefined, "zero effect_request rows for the stale id");
    assert.equal(incidents(h), 0, "zero KERNEL_INCIDENT rows");

    // Recovery, in ONE call: the key is contract-scoped, so the same principal re-presenting the
    // same tuple derives a different key, lands on a FRESH row carrying the new digest, and its
    // first seal under the new projection SEALS.
    const fresh = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    assert.notEqual(fresh, stale, "re-allocation converges on a fresh effect_id, not the stale row");
    seal(h, PRINCIPALS.workflow, { effect_id: fresh, allocation_tuple: tuple, work_bindings: newProjection });
    assert.equal(h.store.effectRequest(fresh)?.effect_id, fresh, "the fresh id seals under the new contract");
    assert.equal(h.store.effectRequest(stale), undefined, "the stale id carries zero effect_request rows, forever");
  } finally {
    h.close();
  }
});

test("B2(3.3): a WITHDRAWN allocation_schemas entry fails the same leg — there is no digest to equal", async () => {
  const h = await v2Harness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const tuple = externalTuple();
    const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    const activated = await h.activatePolicy({
      revision: 2,
      configOverrides: { allocation_schemas: [V2_ALLOCATION_SCHEMAS[0]] } as never,
    });
    assert.equal((activated.admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(activated.admitted));
    refusal(
      () => seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: tuple }),
      "ALLOCATION_CONTRACT_CHANGED",
      "withdrawn entry",
    );
    assert.equal(h.store.effectRequest(effect_id), undefined);
  } finally {
    h.close();
  }
});

// ================================================================ v1-config regression

test("v1 config: allocation and seal keep the v0.4 behaviour exactly — unscoped key, no binding, no gate", async () => {
  const h = await makeHarness({ identityRegistry: [...REFERENCE_IDENTITIES, IDENTITY_B] });
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const tuple = { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: 1, purpose: "record-write" };
    const a = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
    // The v0.4 key is NOT requester-scoped: two principals converge on one effect_id, and one row.
    assert.equal(h.ingress.allocateEffectId(tuple, PRINCIPAL_B), a, "v1 key derivation is unchanged");
    assert.equal(countRows(h, "effect_allocation"), 1);
    const row = h.store.allocationByEffectId(a)!;
    assert.equal(row.binding, undefined, "a v1 row carries no allocation binding");

    // B1(1)'s two stamping rules are v0.5 contract and stay INSIDE the v2 gate: under a v1 config
    // the principal is unused and an extra tuple member is ignored by the hard-coded checks, both
    // exactly as in v0.4 — the same tuple, the same key, the same one row. (Over the wire an
    // unregistered principal is still refused by `api.ts`'s reach matrix, under every config.)
    assert.equal(h.ingress.allocateEffectId(tuple, { principal: "cadp-not-registered" }), a, "v1 ignores the principal");
    assert.equal(
      h.ingress.allocateEffectId({ ...tuple, requester_ref: REQUESTER_B }, PRINCIPALS.workflow),
      a,
      "v1 derives its key from the four hard-coded fields, ignoring any extra member",
    );
    assert.equal(countRows(h, "effect_allocation"), 1, "neither call minted a second allocation");

    // A v1 seal needs no allocation_tuple, binds nothing to the allocation, and — as in v0.4 — an
    // effect_id that was never allocated is still accepted.
    const { request } = sealScriptedRequest(h);
    assert.equal(h.store.effectRequest(request.effect_id)?.effect_id, request.effect_id);
    const invented = "cadp-v04:effect:00000000-0000-7000-8000-0000000000c1";
    seal(h, PRINCIPALS.workflow, {
      effect_id: invented, operation_kind: "SCRIPTED_WRITE", work_bindings: [],
    });
    assert.equal(h.store.effectRequest(invented)?.effect_id, invented, "no ALLOCATION_NOT_FOUND under a v1 config");
    assert.equal(incidents(h), 0);
  } finally {
    h.close();
  }
});

// ================================================================ input-shape guard

/**
 * A refusal that is also NOT a crash. `api.ts` maps `IngressRejection` to 422 and EVERYTHING else
 * to 500, so `instanceof` here is the difference between the mandated refusal and a server error:
 * a `TypeError` out of a dereference would satisfy a reason-only assertion never, and a bare
 * `assert.throws` always — this asserts the class first and the reason second.
 */
function shapeRefusal(fn: () => unknown, reason: string, note: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof IngressRejection, `${note}: expected an IngressRejection, got ${String(error)}`);
    assert.equal(error.reason, reason, `${note}: ${error.message}`);
    return true;
  }, note);
}

/** Every non-object a `JSON.parse` body can be, plus the object shapes with no usable `schema`. */
const MALFORMED_TUPLES: readonly unknown[] = [null, [], 42, "cadp.allocation-key.v1", true, {}, { schema: 5 }, { schema: "" }];

test("B2(5): a malformed v2 allocation body is ALLOCATION_TUPLE_INVALID, never a server error", async () => {
  const h = await v2Harness();
  try {
    // The tuple arrives from `JSON.parse` under a cast, so the Ingress must settle its SHAPE before
    // reading a member: the requester-field sweep, `Object.keys`, `purpose` and the descriptor field
    // sweep all dereference it, and a `TypeError` out of any of them is a 500 where B2(5) mandates a
    // refusal. `null` is the case the reviewer found: it is `typeof "object"` and dereferences.
    for (const tuple of MALFORMED_TUPLES) {
      shapeRefusal(
        () => h.ingress.allocateEffectId(tuple as never, PRINCIPALS.workflow),
        "ALLOCATION_TUPLE_INVALID",
        `allocate ${JSON.stringify(tuple) ?? "undefined"}`,
      );
      assert.equal(countRows(h, "effect_allocation"), 0, `${JSON.stringify(tuple)}: no effect_allocation row`);
    }
    assert.equal(incidents(h), 0, "a malformed body raises no incident");

    // Positive control: the refusals above are attributed to the shapes, not to a broken harness.
    const effect_id = h.ingress.allocateEffectId(externalTuple(), PRINCIPALS.workflow);
    assert.equal(countRows(h, "effect_allocation"), 1);
    assert.ok(effect_id.startsWith("cadp-v04:effect:"));
  } finally {
    h.close();
  }
});

test("B6(1)/B2(3.2): a malformed allocation_tuple on a seal is refused, never a server error", async () => {
  const h = await v2Harness();
  try {
    const tuple = externalTuple();
    const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);

    // A non-object cannot be the allocated tuple — every v2 allocation goes through the shape guard,
    // so the stored binding always digests an object. B2(3.2)'s refusal is therefore the contract's
    // answer to all of these, and no B2(3.4) member read is ever reached with a non-object.
    for (const malformed of [null, [], 42, "external", true]) {
      shapeRefusal(
        () => seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: malformed }),
        "ALLOCATION_BINDING_MISMATCH",
        `first seal with allocation_tuple ${JSON.stringify(malformed)}`,
      );
      assert.equal(countRows(h, "effect_request"), 0, `${JSON.stringify(malformed)}: zero effect_request rows`);
      assert.equal(incidents(h), 0, `${JSON.stringify(malformed)}: zero KERNEL_INCIDENT rows`);
    }
    // An OMITTED tuple stays the distinct B6(1) refusal: absent is not malformed.
    shapeRefusal(() => seal(h, PRINCIPALS.workflow, { effect_id }), "ALLOCATION_TUPLE_REQUIRED", "first seal with no tuple");

    // Positive control, then the re-seal leg: B6(2) reads the tuple again on an existing row, so the
    // same guard has to hold there — and a refused re-seal must leave the sealed row untouched.
    const sealed = seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: tuple });
    assert.equal(countRows(h, "effect_request"), 1);
    for (const malformed of [null, [], 42, "external", true]) {
      shapeRefusal(
        () => seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: malformed }),
        "ALLOCATION_BINDING_MISMATCH",
        `re-seal with allocation_tuple ${JSON.stringify(malformed)}`,
      );
    }
    assert.deepEqual(h.store.effectRequest(effect_id), sealed, "the sealed K3 row survives every refused re-seal");
    assert.equal(countRows(h, "effect_request"), 1);
    assert.equal(incidents(h), 0, "a malformed re-presented tuple is a caller error, not an incident");
  } finally {
    h.close();
  }
});

/** Every non-object a `JSON.parse` seal body can be. `null` is the one that used to destructure. */
const MALFORMED_BODIES: readonly unknown[] = [null, [], 42, "external", true];

test("B6(1): a malformed seal BODY is refused by the draft legs, never a server error", async () => {
  const h = await v2Harness();
  try {
    const effect_id = h.ingress.allocateEffectId(externalTuple(), PRINCIPALS.workflow);

    // The body arrives from `JSON.parse` under a cast exactly as the allocation tuple does, and
    // B6(1)'s strip — `const { allocation_tuple, ...draft } = body` — is itself a dereference of it.
    // Rest-destructuring `null` is a `TypeError` raised before any refusal leg, which `api.ts` turns
    // into a 500; every other non-object destructures to an empty draft and is refused by S3. All of
    // them must land on that same refusal: a body carrying no `requester_ref` is not the caller's.
    for (const body of MALFORMED_BODIES) {
      shapeRefusal(
        () => h.ingress.sealEffectRequest(body, PRINCIPALS.workflow),
        "REQUESTER_REF_MISMATCH",
        `seal body ${JSON.stringify(body) ?? "undefined"}`,
      );
      assert.equal(countRows(h, "effect_request"), 0, `${JSON.stringify(body)}: zero effect_request rows`);
      assert.equal(incidents(h), 0, `${JSON.stringify(body)}: zero KERNEL_INCIDENT rows`);
    }
    // An object body with no draft keys was already refused there; the guard maps the others onto it.
    shapeRefusal(() => h.ingress.sealEffectRequest({}, PRINCIPALS.workflow), "REQUESTER_REF_MISMATCH", "seal body {}");

    // Positive control: the refusals above are attributed to the shapes, not to a broken harness,
    // and the allocated identity is still sealable afterwards.
    const sealed = seal(h, PRINCIPALS.workflow, { effect_id, allocation_tuple: externalTuple() });
    assert.equal(sealed.effect_id, effect_id);
    assert.equal(countRows(h, "effect_request"), 1);
  } finally {
    h.close();
  }
});

test("B1/B6 over the wire: malformed bodies at both v2 entry points answer 422, never 500", async () => {
  const h = await v2Harness();
  try {
    const tokens = new Map<string, string>([["tok-workflow", "cadp-workflow"]]);
    const api = await startKernelApi(
      { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens },
      0,
    );
    try {
      // RAW bodies, not `JSON.stringify` of a value: this is the byte sequence a caller sends, and
      // `api.ts` is the entry point where an escaping `TypeError` becomes `{"error":"INTERNAL"}`.
      const call = async (method: string, body: string) => {
        const res = await fetch(`http://127.0.0.1:${api.port}/${method}`, {
          method: "POST",
          headers: { authorization: "Bearer tok-workflow", "content-type": "application/json" },
          body,
        });
        return { status: res.status, json: (await res.json()) as { error?: string; detail?: string } };
      };

      for (const body of MALFORMED_TUPLES.map((t) => JSON.stringify(t))) {
        const res = await call("allocate_effect_id", body);
        assert.equal(res.status, 422, `allocate ${body}: ${JSON.stringify(res.json)}`);
        assert.equal(res.json.error, "ALLOCATION_TUPLE_INVALID", `allocate ${body}`);
      }
      assert.equal(countRows(h, "effect_allocation"), 0, "no allocation row from any malformed body");

      // The seal entry point, over the wire, with the allocated identity and a malformed sibling.
      const tuple = externalTuple();
      const allocated = await call("allocate_effect_id", JSON.stringify(tuple));
      assert.equal(allocated.status, 200);
      const effect_id = (allocated.json as unknown as { effect_id: string }).effect_id;
      const material = {
        tenant: "scripted-1",
        resource_id: "r-1",
        body_digest: createHash("sha256").update(Buffer.from("external-candidate", "utf8")).digest("hex"),
        body_cas_key: h.ingress.putBlob(Buffer.from("external-candidate", "utf8")),
      };
      const draft = {
        effect_id,
        requester_ref: REQUESTER_A,
        work_bindings: externalBindings(),
        target_ref: h.target.targetRef(),
        operation_kind: "PR_CREATE",
        material_schema: "test.scripted-write.v1",
        material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
        prior_effect_refs: [],
      };
      for (const malformed of ["null", "[]", "42", '"external"', "true"]) {
        const res = await call("seal_effect_request", `{"allocation_tuple":${malformed},${JSON.stringify(draft).slice(1)}`);
        assert.equal(res.status, 422, `seal with allocation_tuple ${malformed}: ${JSON.stringify(res.json)}`);
        assert.equal(res.json.error, "ALLOCATION_BINDING_MISMATCH", `seal with allocation_tuple ${malformed}`);
      }
      // ...and the WHOLE body malformed, which is the strip's own dereference rather than the
      // sibling's. `null` is the shape that used to leave `api.ts` as a 500 before any leg ran.
      for (const body of MALFORMED_BODIES.map((b) => JSON.stringify(b))) {
        const res = await call("seal_effect_request", body);
        assert.equal(res.status, 422, `seal body ${body}: ${JSON.stringify(res.json)}`);
        assert.equal(res.json.error, "REQUESTER_REF_MISMATCH", `seal body ${body}`);
      }
      assert.equal(countRows(h, "effect_request"), 0, "no K3 row from any malformed seal body");
      assert.equal(incidents(h), 0);

      // Positive control over the same wire: the conforming body still seals with a 200.
      const ok = await call("seal_effect_request", JSON.stringify({ ...draft, allocation_tuple: tuple }));
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      assert.equal(countRows(h, "effect_request"), 1);
    } finally {
      api.close();
    }
  } finally {
    h.close();
  }
});
