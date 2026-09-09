/**
 * AP B5(2)-(5), B5(9) and B6(3) part 2 — the PRESENTATION half of the run-capability mechanism:
 * the seal-time membership checks (`RUN_BINDING_REQUIRED`, `NOT_RUN_ENROLLED`,
 * `RUN_CAPABILITY_REQUIRED`, `RUN_CAPABILITY_INVALID`, `RUN_CAPABILITY_HOLDER_MISMATCH`) and
 * Spec v0.5 §5.2's K7 usability grading (`RUN_SCOPE_UNRESOLVED`, `RUN_SCOPE_REFUSED`) applied on
 * EVERY presentation; the `x-cadp-run-capability` header as the one transport, in no digest and in
 * no error text; and §4.4 recheck #19's durable `run_membership` requirement at admission.
 *
 * These are the §C control A4 legs the minting-half suite (`conformance-runorigin.test.ts`) does
 * not cover, plus the WP §3.6 origin-path replay-stability legs of A5 against `cadp/live/ops.ts`.
 * The two files share the run profile's shape: a `cadp.kernel-config.v2` bundle carrying the
 * run-origin allocation contract, the declared kernel work-run pair (B3(4)(a)) and a NON-EMPTY
 * `run_profile_enrolled_requester_refs` — which is what puts the run profile in force at all. The
 * last tests are the complementary claims: with no requester enrolled, and under a whole
 * `cadp.kernel-config.v1` deployment, a presented header changes nothing anywhere.
 *
 * SOURCE BYTES: every binary value here is produced programmatically (`randomBytes`, `Buffer`,
 * base64url text). No literal in this file is anything but plain UTF-8.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { startKernelApi } from "../kernel/api.ts";
import { IngressRejection } from "../kernel/ingress.ts";
import type { Principal } from "../kernel/ingress.ts";
import { KernelClient } from "../clients/kernelClient.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA } from "../kernel/policyBundle.ts";
import { recordDigest } from "../kernel/canonical.ts";
import { recordResourcePrefix, startWork, workPlanOriginKey } from "../live/ops.ts";
import type { LiveEnvManifest } from "../live/env.ts";
import type { AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim } from "../kernel/adapters/types.ts";
import type { EffectRequestV1, SubjectBinding, TargetRef } from "../kernel/records.ts";
import { REFERENCE_IDENTITIES } from "../deployment/referencePolicy.ts";
import {
  DEFAULT_WORK_RUN_REF, PRINCIPALS, V2_ALLOCATION_SCHEMAS, V2_ALLOCATION_SCHEMA_DESCRIPTORS,
  makeHarness, stopSharedOpa, v2ConfigOverrides,
} from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

after(() => stopSharedOpa());

const REQUESTER_A = "workflow:cadp-work";
const REQUESTER_B = "workflow:cadp-work-b";
const PRINCIPAL_B: Principal = { principal: "cadp-workflow-b" };
const IDENTITY_B = {
  principal: "cadp-workflow-b",
  producer_ref: REQUESTER_B,
  identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" },
};

const WORK_RUN_AUTHORITY = "cadp-store:k04";

/** WP §3.6's wire shape as bundle data, carried by the composition exactly as B2(2)(i) requires. */
const RUN_ORIGIN_DESCRIPTOR = {
  schema: RUN_ORIGIN_ALLOCATION_SCHEMA,
  fields: [{ field: "origin_key", role: "ENTROPY", value_contract: "NONEMPTY_STRING" }],
};

const RUN_ORIGIN_MAPPING = {
  schema: RUN_ORIGIN_ALLOCATION_SCHEMA,
  binding_projection: [] as ReadonlyArray<{ tuple_field: string; authority_ref: string; namespace: string }>,
  purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START" }],
};

/** A `WORK_START`-capable target, so an origin runs through the real PEP and the real adapters. */
class WorkStartTarget implements TargetAdapterV1 {
  readonly target_type = "WORKFLOW";

  readonly authority_ref = "temporal:cadp-v04";

  onDispatch: ((effect_id: string, ordinal: number, material: Record<string, unknown>) => DispatchResult) | undefined;

  describe(): { target_type: string; authority_ref: string; operations: readonly AdapterOperation[] } {
    return {
      target_type: this.target_type,
      authority_ref: this.authority_ref,
      operations: [
        {
          operation_kind: "WORK_START", material_schema: "cadp.work-start.v1", available: true,
          idempotency: "NONE", dispatch_precondition: "NONE", reconcile: "BY_QUERY_PREDICATE",
          no_effect_proof_supported: true,
        },
      ],
    };
  }

  serialization_domain(): string {
    return "work-start-domain";
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    return { target_ref: this.targetRef(), claim: { namespace: "cadp-v04" } };
  }

  async current_revision(subject: SubjectBinding): Promise<RevisionRead> {
    return { revision_or_version: subject.revision_or_version, availability: "PRESENT" };
  }

  async verify_material(): Promise<void> {}

  async dispatch_precondition_read(): Promise<string | undefined> {
    return undefined;
  }

  async dispatch(effect_id: string, ordinal: number, _t: TargetRef, _op: string, material: Record<string, unknown>): Promise<DispatchResult> {
    return this.onDispatch?.(effect_id, ordinal, material) ?? {
      kind: "ACCEPTED",
      target_operation_ref: `wf-${effect_id}-${ordinal}`,
      receipt_claim: { workflow_id: material["workflow_id"], started: true },
    };
  }

  async reconcile(effect_id: string, _o: number, _t: TargetRef, _op: string, material: Record<string, unknown>): Promise<ReconcileResult> {
    return { kind: "COMMITTED", target_operation_ref: `wf-${effect_id}`, receipt_claim: { workflow_id: material["workflow_id"], started: true } };
  }

  receipt_binds(_op: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    return receipt["workflow_id"] === material["workflow_id"];
  }

  targetRef(): TargetRef {
    return { authority_ref: this.authority_ref, target_type: this.target_type, target_id: "cadp-v04" };
  }
}

/** The v2 bundle this lane needs: the run-origin contract registered, the declared pair, enrollment. */
function runProfileConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return v2ConfigOverrides({
    allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS, RUN_ORIGIN_DESCRIPTOR],
    allocation_schemas: [...V2_ALLOCATION_SCHEMAS, RUN_ORIGIN_MAPPING],
    run_profile_enrolled_requester_refs: [REQUESTER_A, REQUESTER_B],
    ...overrides,
  });
}

interface RunProfileHarness {
  h: Harness;
  target: WorkStartTarget;
}

async function runProfileHarness(
  configOverrides: Record<string, unknown> = runProfileConfig(),
  disabledChecks?: ReadonlySet<string>,
): Promise<RunProfileHarness> {
  const target = new WorkStartTarget();
  const h = await makeHarness({
    identityRegistry: [...REFERENCE_IDENTITIES, IDENTITY_B],
    extraAdapters: [target],
    configOverrides: configOverrides as never,
    ...(disabledChecks === undefined ? {} : { disabledChecks }),
  });
  h.sealReach();
  await h.sealTargetIdentity();
  await h.pep.refreshTargetIdentity(target);
  return { h, target };
}

let originCounter = 0;
let memberCounter = 0;

/** Allocate under `run-origin.v1` and seal the self-bound `WORK_START` it names (B5(9), no header). */
function sealOrigin(
  rp: RunProfileHarness,
  options: { origin_key?: string; principal?: Principal; requester_ref?: string; selfBind?: boolean } = {},
): string {
  const { h, target } = rp;
  const principal = options.principal ?? PRINCIPALS.workflow;
  const tuple = {
    schema: RUN_ORIGIN_ALLOCATION_SCHEMA,
    origin_key: options.origin_key ?? `origin-${(originCounter += 1)}`,
    purpose: "work-start",
  };
  const effect_id = h.ingress.allocateEffectId(tuple, principal);
  const material = {
    workflow_id: `cadp-work-${effect_id}`,
    workflow_type: "cadpWork",
    task_queue: "cadp-worker",
    bounds: { max_steps: 8, max_effects: 6 },
  };
  h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: options.requester_ref ?? REQUESTER_A,
      // B5(9) leg 3: the origin binds its OWN effect_id. `selfBind: false` binds nothing at all,
      // which is leg 2's "none" case and B5(3)'s `RUN_BINDING_REQUIRED`.
      work_bindings: options.selfBind === false
        ? []
        : [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: effect_id }],
      target_ref: target.targetRef(),
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
      prior_effect_refs: [],
      allocation_tuple: tuple,
    },
    principal,
  );
  return effect_id;
}

/** assemble → evaluate → admit, with the caller B5(1)'s dispatch equality is checked against. */
async function dispatch(h: Harness, effect_id: string, caller?: Principal) {
  const input = h.ingress.assembleAdmissionInput(effect_id, []);
  const evaluated = await h.evaluate(input.input_digest.value);
  assert.equal(evaluated.kind, "DECISION", `expected a decision for ${effect_id}`);
  const decision = (evaluated as { decision: { decision_id: string; outcome: string } }).decision;
  assert.equal(decision.outcome, "ALLOW", `expected ALLOW for ${effect_id}`);
  return h.pep.admitAndDispatch(effect_id, decision.decision_id, caller);
}

/** One whole run: origin sealed, dispatched by its own requester, capability delivered once. */
async function mintRun(
  rp: RunProfileHarness,
  options: { origin_key?: string; principal?: Principal; requester_ref?: string } = {},
): Promise<{ run: string; secret: string }> {
  const run = sealOrigin(rp, options);
  const admitted = await dispatch(rp.h, run, options.principal ?? PRINCIPALS.workflow);
  assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
  const secret = (admitted as { run_capability?: string }).run_capability;
  assert.equal(typeof secret, "string", "the verified initial dispatch of a witnessed origin delivers");
  return { run, secret: secret! };
}

/**
 * Seal an ORDINARY run-bound member request — a `SCRIPTED_WRITE` against the harness target,
 * allocated under `cadp.allocation-key.v1` whose PROJECTED `work_run_ref` is the run it binds —
 * presenting `capability` as B6(3)'s transport header when one is given.
 */
function sealMember(rp: RunProfileHarness, options: {
  work_run_ref: string;
  capability?: string;
  principal?: Principal;
  requester_ref?: string;
  body?: string;
  bind?: boolean;
}): EffectRequestV1 {
  const { h } = rp;
  const principal = options.principal ?? PRINCIPALS.workflow;
  const tuple = {
    schema: "cadp.allocation-key.v1",
    work_run_ref: options.work_run_ref,
    step_ordinal: (memberCounter += 1),
    purpose: "record-write",
  };
  const effect_id = h.ingress.allocateEffectId(tuple, principal);
  const bodyBytes = Buffer.from(options.body ?? "member-body", "utf8");
  const material = {
    tenant: "scripted-1",
    resource_id: "r-1",
    body_digest: createHash("sha256").update(bodyBytes).digest("hex"),
    body_cas_key: h.ingress.putBlob(bodyBytes),
  };
  return h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: options.requester_ref ?? REQUESTER_A,
      work_bindings: options.bind === false
        ? []
        : [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: options.work_run_ref }],
      target_ref: h.target.targetRef(),
      operation_kind: "SCRIPTED_WRITE",
      material_schema: "test.scripted-write.v1",
      material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
      prior_effect_refs: [],
      allocation_tuple: tuple,
    },
    principal,
    options.capability === undefined ? {} : { run_capability: options.capability },
  );
}

function count(h: Harness, table: string): number {
  return (h.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function rows(h: Harness): { requests: number; memberships: number; capabilities: number } {
  return {
    requests: count(h, "effect_request"),
    memberships: count(h, "run_membership"),
    capabilities: count(h, "run_capability"),
  };
}

/** Assert a seal refuses with an exact code, leaves ZERO rows behind, and names no secret. */
function refusesSeal(
  h: Harness,
  fn: () => unknown,
  reason: string,
  note: string,
  secrets: readonly string[] = [],
): IngressRejection {
  const before = rows(h);
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof IngressRejection, `${note}: expected IngressRejection, got ${String(thrown)}`);
  const rejection = thrown as IngressRejection;
  assert.equal(rejection.reason, reason, `${note}: ${rejection.message}`);
  const after = rows(h);
  assert.equal(after.requests, before.requests, `${note}: zero effect_request rows on a refusal`);
  assert.equal(after.memberships, before.memberships, `${note}: zero run_membership rows on a refusal`);
  assert.equal(after.capabilities, before.capabilities, `${note}: no capability row moves on a refusal`);
  // B6(3): a refusal names a reason code, never the presented secret or any prefix of it.
  for (const secret of secrets) {
    assert.equal(rejection.message.includes(secret), false, `${note}: the message leaks the presented value`);
    assert.equal((rejection.stack ?? "").includes(secret), false, `${note}: the stack leaks the presented value`);
    assert.equal(rejection.message.includes(secret.slice(0, 8)), false, `${note}: the message leaks a prefix`);
  }
  return rejection;
}

// ================================================ B5(4) — the happy path, end to end

test("A4: origin seals with no header, mints once at dispatch, and the delivered capability seals a follow-up", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    // o1: the origin presents NO capability and is NOT refused RUN_CAPABILITY_REQUIRED — B5(9)'s
    // exemption covers exactly the presentation legs, for a run that cannot exist yet.
    const run = sealOrigin(rp);
    assert.equal(h.store.runMembership(run)?.work_run_ref, run, "the origin's self-referential witness");

    const admitted = await dispatch(h, run, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal((admitted as { outcome: { result: string } }).outcome.result, "COMMITTED");
    const secret = (admitted as { run_capability: string }).run_capability;
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/u, "B6(3): unpadded base64url of 32 raw bytes");
    assert.equal(count(h, "run_capability"), 1);

    // The member path: digest match against THIS run's row, holder match, K7 COMMITTED ⇒ SEALS.
    const follow = sealMember(rp, { work_run_ref: run, capability: secret });
    assert.equal(h.store.effectRequest(follow.effect_id)?.effect_id, follow.effect_id, "the follow-up SEALS");
    // B5(5): the durable membership proof for the follow-up, written in its own sealing transaction.
    assert.equal(h.store.runMembership(follow.effect_id)?.work_run_ref, run);
    assert.equal(count(h, "run_membership"), 2, "the origin's witness and the follow-up's proof");

    // And it admits: recheck #19 finds that row inside the admission transaction.
    const followAdmitted = await dispatch(h, follow.effect_id, PRINCIPALS.workflow);
    assert.equal(followAdmitted.kind, "ADMITTED", JSON.stringify(followAdmitted));
    assert.equal((followAdmitted as { run_capability?: string }).run_capability, undefined, "no mint on a member");
    assert.equal(count(h, "run_capability"), 1, "still exactly one row: delivery is one-shot");

    // The same capability keeps working for further members of the same run: usability is graded
    // on every presentation and the run is COMMITTED, so nothing here is single-use.
    const second = sealMember(rp, { work_run_ref: run, capability: secret, body: "member-body-2" });
    assert.equal(h.store.runMembership(second.effect_id)?.work_run_ref, run);
  } finally {
    rp.h.close();
  }
});

// ================================================ B5(4) — the four presentation refusals

test("A4: presenting none, a wrong secret, another holder's capability, or another run's capability", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    const { run: r1, secret: c1 } = await mintRun(rp, { origin_key: "origin-r1" });
    // A SECOND run held by the SAME requester, for the same-holder borrowing leg.
    const { run: r2, secret: c2 } = await mintRun(rp, { origin_key: "origin-r2" });
    // And a run held by ANOTHER enrolled requester, for the exfiltration leg.
    const { run: rb, secret: cb } = await mintRun(rp, {
      origin_key: "origin-rb", principal: PRINCIPAL_B, requester_ref: REQUESTER_B,
    });
    assert.equal(h.store.runCapability(rb)?.holder_ref, REQUESTER_B);

    // (i) an enrolled requester's run-bound request presenting NOTHING.
    refusesSeal(h, () => sealMember(rp, { work_run_ref: r1 }), "RUN_CAPABILITY_REQUIRED", "no header presented", [c1]);

    // (ii) a well-formed but WRONG secret: canonical wire shape, no matching row.
    const wrong = randomBytes(32).toString("base64url");
    refusesSeal(h, () => sealMember(rp, { work_run_ref: r1, capability: wrong }), "RUN_CAPABILITY_INVALID", "wrong secret", [wrong, c1]);

    // (iii) EXFILTRATION: A presents B's genuinely valid capability on a request bound to B's run.
    // The row exists and its digest matches, so only the holder leg can refuse this one.
    refusesSeal(
      h,
      () => sealMember(rp, { work_run_ref: rb, capability: cb }),
      "RUN_CAPABILITY_HOLDER_MISMATCH",
      "another holder's capability",
      [cb],
    );

    // (iv) SAME-HOLDER BORROWING: A holds BOTH r1 and r2 and presents r1's capability on an
    // r2-bound request. The row lookup is scoped to THIS request's work_run_ref BEFORE any holder
    // comparison, so this is INVALID — a holder match on the wrong run would escape r2's budget.
    const borrowed = refusesSeal(
      h,
      () => sealMember(rp, { work_run_ref: r2, capability: c1 }),
      "RUN_CAPABILITY_INVALID",
      "same-holder wrong-run borrowing",
      [c1, c2],
    );
    assert.notEqual(borrowed.reason, "RUN_CAPABILITY_HOLDER_MISMATCH", "the holder matches; the RUN does not");

    // Positive controls, so the four refusals are attributed to the presentations and not to the
    // store: each run's OWN capability still seals against its OWN run.
    assert.ok(sealMember(rp, { work_run_ref: r1, capability: c1 }).effect_id);
    assert.ok(sealMember(rp, { work_run_ref: r2, capability: c2 }).effect_id);
    assert.ok(sealMember(rp, { work_run_ref: rb, capability: cb, principal: PRINCIPAL_B, requester_ref: REQUESTER_B }).effect_id);
  } finally {
    rp.h.close();
  }
});

// ================================================ B6(3) — STRICT canonical decoding

test("B6(3): non-canonical encodings of a VALID secret are refused RUN_CAPABILITY_INVALID", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    // The standard-alphabet leg only differs from the canonical text when the secret's own bytes
    // encode a `-` or `_`, so mint until one does rather than assert a vacuous equality.
    let run = "";
    let secret = "";
    for (let attempt = 0; attempt < 24 && !/[-_]/u.test(secret); attempt += 1) {
      ({ run, secret } = await mintRun(rp, { origin_key: `origin-alphabet-${attempt}` }));
    }
    assert.match(secret, /[-_]/u, "no capability carrying a base64url-specific character was minted");
    const raw = Buffer.from(secret, "base64url");

    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    // The 43rd character carries 4 significant bits and 2 slack bits, so its canonical form has an
    // index divisible by 4; the next index decodes to the SAME 32 bytes with the slack bits set.
    const lastIndex = ALPHABET.indexOf(secret[42]!);
    assert.equal(lastIndex % 4, 0, "a canonical encoding leaves the trailing bits clear");
    const variants: ReadonlyArray<[string, string]> = [
      ["padded", `${secret}=`],
      ["standard alphabet", raw.toString("base64").replace(/=+$/u, "")],
      ["44 characters", `${secret}A`],
      ["non-canonical trailing bits", `${secret.slice(0, 42)}${ALPHABET[lastIndex + 1]!}`],
    ];

    for (const [note, variant] of variants) {
      assert.notEqual(variant, secret, `${note}: the variant must differ from the canonical text`);
      refusesSeal(h, () => sealMember(rp, { work_run_ref: run, capability: variant }), "RUN_CAPABILITY_INVALID", note, [secret, variant]);
    }

    // The point of the leg, asserted rather than assumed: a PERMISSIVE decode of three of those
    // four variants yields the stored digest's exact preimage, so `Buffer.from(v, "base64url")`
    // alone would have accepted them as the same capability. The strict canonical check is the
    // only thing that refuses them.
    for (const note of ["padded", "standard alphabet", "non-canonical trailing bits"] as const) {
      const variant = variants.find(([name]) => name === note)![1];
      assert.ok(Buffer.from(variant, "base64url").equals(raw), `${note}: permissive decode WOULD match`);
      assert.equal(
        createHash("sha256").update(Buffer.from(variant, "base64url")).digest("hex"),
        h.store.runCapability(run)!.capability_digest,
        `${note}: permissive decode digests onto the stored row`,
      );
    }

    // Positive control: the canonical text of the very same secret SEALS.
    assert.ok(sealMember(rp, { work_run_ref: run, capability: secret }).effect_id);
  } finally {
    rp.h.close();
  }
});

// ================================================ B5(2) — K7 usability, graded on every presentation

test("A4: UNKNOWN refuses RUN_SCOPE_UNRESOLVED, and reconciliation to COMMITTED flips the SAME capability", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    rp.target.onDispatch = () => ({ kind: "AMBIGUOUS", raw_observation: "transport timeout" });
    const { run, secret } = await mintRun(rp);
    assert.equal(h.store.outcomesByEffect(run).at(-1)?.result, "UNKNOWN");
    // Delivery already happened: minting is at admission and K7 grades USABILITY, never delivery.
    assert.equal(count(h, "run_capability"), 1);

    refusesSeal(h, () => sealMember(rp, { work_run_ref: run, capability: secret }), "RUN_SCOPE_UNRESOLVED", "UNKNOWN scope", [secret]);

    // `request_reconcile`'s path, whose reach is not the holder's alone and which touches no
    // secret: the reconciler writes the conclusive outcome with its own observer_ref.
    rp.target.onDispatch = undefined;
    await h.reconciler.reconcileEffect(run);
    const conclusive = h.store.outcomesByEffect(run).find((o) => o.result === "COMMITTED");
    assert.ok(conclusive !== undefined, "reconciliation returned COMMITTED");
    assert.match(String(conclusive!.observer_ref), /:reconciler$/u);

    // THE FLIP: the SAME already-delivered capability, never re-delivered, now seals.
    const follow = sealMember(rp, { work_run_ref: run, capability: secret });
    assert.equal(h.store.runMembership(follow.effect_id)?.work_run_ref, run);
    assert.equal(count(h, "run_capability"), 1, "no re-delivery and no second row");
    const dump = JSON.stringify(h.store.db.prepare("SELECT * FROM effect_outcome").all());
    assert.equal(dump.includes(secret), false, "no reconciler path handles the secret");
  } finally {
    rp.h.close();
  }
});

test("A4: NO_EFFECT_CONFIRMED refuses RUN_SCOPE_REFUSED, and an ordinal-2 COMMITTED flips the SAME capability", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    // Ordinal 1 confirms no effect, which recheck #12 permits a further ordinal after.
    rp.target.onDispatch = (_e, ordinal, material) =>
      ordinal === 1
        ? { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true } }
        : { kind: "ACCEPTED", target_operation_ref: "wf-retry", receipt_claim: { workflow_id: material["workflow_id"], started: true } };
    const { run, secret } = await mintRun(rp);
    assert.equal(h.store.outcomesByEffect(run).at(-1)?.result, "NO_EFFECT_CONFIRMED");

    // While that is the LATEST conclusive state — deliberately not "forever".
    refusesSeal(h, () => sealMember(rp, { work_run_ref: run, capability: secret }), "RUN_SCOPE_REFUSED", "NO_EFFECT scope", [secret]);

    const second = await dispatch(h, run, PRINCIPALS.workflow);
    assert.equal(second.kind, "ADMITTED", JSON.stringify(second));
    assert.equal((second as { admission: { dispatch_ordinal: number } }).admission.dispatch_ordinal, 2);
    assert.equal((second as { outcome: { result: string } }).outcome.result, "COMMITTED");
    // B6(4)/B5(1): the retry is not the initial dispatch — no field, no second row, no re-delivery.
    assert.equal((second as { run_capability?: string }).run_capability, undefined);
    assert.equal(count(h, "run_capability"), 1);

    // THE SECOND FLIP: the same capability, unchanged and never re-delivered, now passes the gate.
    const follow = sealMember(rp, { work_run_ref: run, capability: secret });
    assert.equal(h.store.runMembership(follow.effect_id)?.work_run_ref, run);
  } finally {
    rp.h.close();
  }
});

test("A4 negative control: while the re-admitted ordinal 2 is UNRESOLVED the presentation is not REFUSED", async () => {
  // "Latest conclusive" is not "any conclusive": with ordinal 1 NO_EFFECT_CONFIRMED and ordinal 2
  // admitted but unresolved, the scope is UNRESOLVED — neither the earlier RUN_SCOPE_REFUSED nor
  // a seal. A build reading the FIRST outcome would answer REFUSED here and would also refuse
  // after ordinal 2 committed, denying a genuinely committed run its own scope.
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    rp.target.onDispatch = (_e, ordinal) =>
      ordinal === 1
        ? { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true } }
        : { kind: "AMBIGUOUS", raw_observation: "transport timeout" };
    const { run, secret } = await mintRun(rp);
    refusesSeal(h, () => sealMember(rp, { work_run_ref: run, capability: secret }), "RUN_SCOPE_REFUSED", "ordinal 1 refused", [secret]);

    const second = await dispatch(h, run, PRINCIPALS.workflow);
    assert.equal(second.kind, "ADMITTED", JSON.stringify(second));
    assert.equal((second as { outcome: { result: string } }).outcome.result, "UNKNOWN");
    refusesSeal(h, () => sealMember(rp, { work_run_ref: run, capability: secret }), "RUN_SCOPE_UNRESOLVED", "ordinal 2 unresolved", [secret]);
  } finally {
    rp.h.close();
  }
});

// ================================================ B5(3) — enrollment and the mandatory binding

test("A4: an enrolled requester's UNBOUND request is RUN_BINDING_REQUIRED; a non-enrolled requester's BOUND one is NOT_RUN_ENROLLED", async () => {
  // Only A is enrolled here, so B is the non-enrolled requester carrying a binding.
  const rp = await runProfileHarness(runProfileConfig({ run_profile_enrolled_requester_refs: [REQUESTER_A] }));
  try {
    const { h } = rp;
    const { run, secret } = await mintRun(rp, { origin_key: "origin-enrollment" });

    // B5(3): REFUSED, not merely uncounted. The run-origin schema projects nothing, so this
    // request reaches the run-profile legs with B2(3)'s legs all satisfied — the refusal is
    // B5(3)'s and not an allocation-projection artefact.
    refusesSeal(h, () => sealOrigin(rp, { origin_key: "origin-unbound", selfBind: false }), "RUN_BINDING_REQUIRED", "enrolled, no work-run binding");

    // B5(3): enrollment cannot be acquired by presenting a binding — with or without a capability.
    refusesSeal(
      h,
      () => sealMember(rp, { work_run_ref: run, principal: PRINCIPAL_B, requester_ref: REQUESTER_B }),
      "NOT_RUN_ENROLLED",
      "non-enrolled requester carrying a binding",
    );
    refusesSeal(
      h,
      () => sealMember(rp, { work_run_ref: run, capability: secret, principal: PRINCIPAL_B, requester_ref: REQUESTER_B }),
      "NOT_RUN_ENROLLED",
      "non-enrolled requester presenting a capability too",
      [secret],
    );
  } finally {
    rp.h.close();
  }
});

// ================================================ §4.4 recheck #19 — the durable membership proof

test("recheck #19: an enrolled requester's run-bound effect with no membership row is RUN_MEMBERSHIP_UNPROVEN", async () => {
  // The row is absent because the effect was SEALED while the run profile was not in force, and a
  // later POLICY_ACTIVATE enrolled its requester. Nothing back-dates a membership row — the store
  // has no runtime UPDATE and no back-dating insert — so admission refuses, fail-closed.
  for (const bite of [false, true]) {
    const rp = await runProfileHarness(
      runProfileConfig({ run_profile_enrolled_requester_refs: [] }),
      bite ? new Set(["recheck19_run_membership"]) : undefined,
    );
    try {
      const { h } = rp;
      const member = sealMember(rp, { work_run_ref: DEFAULT_WORK_RUN_REF });
      assert.equal(h.store.runMembership(member.effect_id), undefined, "sealed with the profile off: no proof");

      const activated = await h.activatePolicy({
        revision: 2,
        configOverrides: runProfileConfig({ run_profile_enrolled_requester_refs: [REQUESTER_A] }) as never,
      });
      assert.equal((activated.admitted as { kind: string }).kind, "ADMITTED", JSON.stringify(activated.admitted));

      const admitted = await dispatch(h, member.effect_id, PRINCIPALS.workflow);
      if (bite) {
        // GUARD-BITE (TD §13.1): with #19 removed the unproven admission goes through, and an
        // effect that never proved membership at seal is admitted into a run — the prohibited
        // durable delta, so the recheck is load-bearing safety and not defence in depth.
        assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
        assert.equal(h.store.admissionsByEffect(member.effect_id).length, 1);
      } else {
        assert.equal(admitted.kind, "REFUSAL", JSON.stringify(admitted));
        assert.equal((admitted as { reason: string }).reason, "RUN_MEMBERSHIP_UNPROVEN");
        assert.equal(h.store.admissionsByEffect(member.effect_id).length, 0, "no admission row");
        assert.equal(h.store.outcomesByEffect(member.effect_id).length, 0, "no outcome row");
      }
    } finally {
      rp.h.close();
    }
  }
});

// ================================================ B6(3) — the header is transport and nothing else

test("B6(3): the presented header enters no digest, no record and no error text, over the wire", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    const { run, secret } = await mintRun(rp);
    const tokens = new Map<string, string>([["tok-a", "cadp-workflow"]]);
    const api = await startKernelApi(
      { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens },
      0,
    );
    try {
      const seal = async (capability: string | undefined, body: Record<string, unknown>) => {
        const res = await fetch(`http://127.0.0.1:${api.port}/seal_effect_request`, {
          method: "POST",
          headers: {
            authorization: "Bearer tok-a",
            "content-type": "application/json",
            ...(capability === undefined ? {} : { "x-cadp-run-capability": capability }),
          },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };
      const draftFor = (work_run_ref: string) => {
        const tuple = { schema: "cadp.allocation-key.v1", work_run_ref, step_ordinal: (memberCounter += 1), purpose: "record-write" };
        const bodyBytes = Buffer.from("wire-body", "utf8");
        const material = {
          tenant: "scripted-1", resource_id: "r-1",
          body_digest: createHash("sha256").update(bodyBytes).digest("hex"),
          body_cas_key: h.ingress.putBlob(bodyBytes),
        };
        return {
          effect_id: h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow),
          requester_ref: REQUESTER_A,
          work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: work_run_ref }],
          target_ref: h.target.targetRef(),
          operation_kind: "SCRIPTED_WRITE",
          material_schema: "test.scripted-write.v1",
          material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
          prior_effect_refs: [],
          allocation_tuple: tuple,
        };
      };

      const sealed = await seal(secret, draftFor(run));
      assert.equal(sealed.status, 200, JSON.stringify(sealed.json));
      // The sealed record IS the whole preimage of its own digest, and the header is nowhere in it.
      const record = sealed.json as unknown as EffectRequestV1;
      assert.equal(
        recordDigest(record as unknown as Record<string, unknown>, "request_digest").value,
        record.request_digest.value,
        "the record recomputes to its own digest with no hidden input",
      );
      assert.equal(JSON.stringify(record).includes(secret), false, "the record holds no capability");
      assert.equal(Object.keys(record).includes("run_capability"), false);
      assert.equal(Buffer.from(h.cas.get(record.material_ref)).toString("utf8").includes(secret), false, "nor the material");

      // A refusal over the wire: the 422 body names a reason code and never the presented value.
      const wrong = randomBytes(32).toString("base64url");
      const refused = await seal(wrong, draftFor(run));
      assert.equal(refused.status, 422);
      assert.equal(refused.json["error"], "RUN_CAPABILITY_INVALID");
      assert.equal(JSON.stringify(refused.json).includes(wrong), false, "the refusal body leaks nothing");
      assert.equal(JSON.stringify(refused.json).includes(secret), false);

      // And the same request through the client's typed transport seam seals identically.
      const client = new KernelClient(`http://127.0.0.1:${api.port}`, "tok-a");
      const viaClient = await client.sealEffectRequest(draftFor(run) as never, { run_capability: secret });
      assert.equal(h.store.effectRequest(viaClient.effect_id)?.effect_id, viaClient.effect_id);
    } finally {
      api.close();
    }
    // Nothing durable holds the presented value, in any encoding, on any table.
    const raw = Buffer.from(secret, "base64url");
    for (const table of (h.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name)) {
      const dump = JSON.stringify(h.store.db.prepare(`SELECT * FROM ${table}`).all());
      for (const encoding of [secret, raw.toString("hex"), raw.toString("base64")]) {
        assert.equal(dump.includes(encoding), false, `${table} holds the secret`);
      }
    }
  } finally {
    rp.h.close();
  }
});

test("B6(3): two identical drafts sealed with DIFFERENT headers produce identical digests", async () => {
  // Run on a store where the run profile is not in force, which is the only configuration in which
  // two DIFFERENT header values can both be carried by an otherwise byte-identical seal: the
  // capability check is downstream of, and has no input into, the digest computation.
  const rp = await runProfileHarness(runProfileConfig({ run_profile_enrolled_requester_refs: [] }));
  try {
    const { h } = rp;
    const bodyBytes = Buffer.from("digest-invariance", "utf8");
    const material = {
      tenant: "scripted-1", resource_id: "r-1",
      body_digest: createHash("sha256").update(bodyBytes).digest("hex"),
      body_cas_key: h.ingress.putBlob(bodyBytes),
    };
    const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
    const headers = [randomBytes(32).toString("base64url"), `${randomBytes(32).toString("base64url")}=not-even-canonical`];
    const sealedPair = headers.map((run_capability) => {
      const tuple = { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: (memberCounter += 1), purpose: "record-write" };
      return h.ingress.sealEffectRequest(
        {
          effect_id: h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow),
          requester_ref: REQUESTER_A,
          work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: DEFAULT_WORK_RUN_REF }],
          target_ref: h.target.targetRef(),
          operation_kind: "SCRIPTED_WRITE",
          material_schema: "test.scripted-write.v1",
          material_ref,
          prior_effect_refs: [],
          allocation_tuple: tuple,
        },
        PRINCIPALS.workflow,
        { run_capability },
      );
    });
    const [first, second] = sealedPair as [EffectRequestV1, EffectRequestV1];
    assert.equal(first.material_digest.value, second.material_digest.value, "the header is not in the material digest");
    // Everything the request digest covers, except the two values that are meant to differ.
    const semantic = (r: EffectRequestV1) => JSON.stringify({
      requester_ref: r.requester_ref, work_bindings: r.work_bindings, target_ref: r.target_ref,
      operation_kind: r.operation_kind, material_schema: r.material_schema, material_digest: r.material_digest,
      material_ref: r.material_ref, prior_effect_refs: r.prior_effect_refs,
    });
    assert.equal(semantic(first), semantic(second), "the header is in no covered field");
    for (const [index, record] of sealedPair.entries()) {
      assert.equal(
        recordDigest(record as unknown as Record<string, unknown>, "request_digest").value,
        record.request_digest.value,
        `record ${index} recomputes from its own members alone`,
      );
      assert.equal(JSON.stringify(record).includes(headers[index]!), false);
    }
  } finally {
    rp.h.close();
  }
});

// ================================================ the complementary claim: v1 is untouched

test("v1 config: a presented header changes nothing — no membership, no capability, no refusal", async () => {
  const target = new WorkStartTarget();
  const h = await makeHarness({ identityRegistry: [...REFERENCE_IDENTITIES, IDENTITY_B], extraAdapters: [target] });
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    await h.pep.refreshTargetIdentity(target);
    const seal = (run_capability?: string) => {
      const bodyBytes = Buffer.from("v1-body", "utf8");
      const material = {
        tenant: "scripted-1", resource_id: "r-1",
        body_digest: createHash("sha256").update(bodyBytes).digest("hex"),
        body_cas_key: h.ingress.putBlob(bodyBytes),
      };
      const effect_id = h.ingress.allocateEffectId(
        { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: (memberCounter += 1), purpose: "record-write" },
        PRINCIPALS.workflow,
      );
      return h.ingress.sealEffectRequest(
        {
          effect_id,
          requester_ref: REQUESTER_A,
          work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: DEFAULT_WORK_RUN_REF }],
          target_ref: h.target.targetRef(),
          operation_kind: "SCRIPTED_WRITE",
          material_schema: "test.scripted-write.v1",
          material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
          prior_effect_refs: [],
        },
        PRINCIPALS.workflow,
        run_capability === undefined ? {} : { run_capability },
      );
    };
    // Under v1 the enrolled set is not expressible, so no rule here can apply: an unbound request,
    // a bound one, one presenting a garbage capability and one presenting none all seal alike.
    const withHeader = seal("not-a-capability");
    const withoutHeader = seal();
    assert.equal(withHeader.material_digest.value, withoutHeader.material_digest.value);
    assert.equal(h.store.runMembership(withHeader.effect_id), undefined, "v1 writes no membership row");
    assert.equal(count(h, "run_membership"), 0);
    assert.equal(count(h, "run_capability"), 0);

    const admitted = await dispatch(h, withHeader.effect_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal((admitted as { run_capability?: string }).run_capability, undefined);
  } finally {
    h.close();
  }
});

// ================================================ WP §3.6 — the ops.ts origin path

/** The live composition's seams, replaced by the in-process harness (no docker, no Temporal, no git). */
function opsDependencies(h: Harness, api: { port: number }, token: string) {
  const manifest = {
    dir: h.dir, api_url: `http://127.0.0.1:${api.port}`, root_url: "", api_port: api.port, root_port: 0,
    record_port: 0, temporal_port: 0, temporal_ui_port: 0, broker_port: 0,
    repo_full_name: "astro3141/cadp", repo_id: "github.com/astro3141/cadp",
    base_sha: "0".repeat(40), tokens: { "cadp-workflow": token }, root_key_id: "root-1",
    kernel_config_path: "", policy_content_digest: "",
  } as LiveEnvManifest;
  return {
    manifest,
    client: new KernelClient(manifest.api_url, token),
    namespaceId: () => "cadp-v04",
    resolveBase: () => "a".repeat(40),
    workerImage: "cadp-worker:test",
    imageIdentity: (image: string) => ({ image, image_digest: "sha256:test", tool_versions: { "codex-cli": "1.0.0" } }),
  };
}

test("A5/WP §3.6: one origin_key gives ONE effect_id and a BYTE-IDENTICAL re-seal on the ops.ts origin path", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    const tokens = new Map<string, string>([["tok-a", "cadp-workflow"]]);
    const api = await startKernelApi(
      { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens },
      0,
    );
    try {
      const dependencies = opsDependencies(h, api, "tok-a");
      const originKey = workPlanOriginKey("cadp-v04:evidence:00000000-0000-7000-8000-0000000000aa", 0);
      const started = await startWork(h.dir, "development", ["do the thing", "8", "6"], { originKey, dependencies });
      assert.ok(started !== undefined, "the origin was admitted and committed");
      const run = started!.effect_id;

      // AP B5(9): the ops path seals a genuine ORIGIN — one work-run binding, its own effect_id.
      const request = h.store.effectRequest(run)!;
      const bound = request.work_bindings.filter((b) => b.namespace === "work-run");
      assert.deepEqual(bound, [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: run }]);
      assert.equal(h.store.runMembership(run)?.work_run_ref, run, "the durable minting witness");
      assert.equal(count(h, "run_capability"), 1, "and it minted exactly once at its own dispatch");

      // WP §3.6 / A5 control 14: RETRY the same logical origin. The identity converges AND the
      // material is byte-reproducible, so the re-seal is IDEMPOTENT — one request row, an unchanged
      // request_digest, zero incidents and zero scope holds, not a REQUEST_DIGEST_CONFLICT.
      // SCOPE NOTE, so this leg is not over-read: the injected `resolveBase` stands for a PINNED
      // base, which is the case this lane's change covers. The development path still resolves
      // `base_sha` live at seal time, so a retry after the base branch MOVES still drifts — the
      // outstanding half of WP §3.6's obligation, named in `cadp/live/ops.ts` and not asserted here.
      const retried = await startWork(h.dir, "development", ["do the thing", "8", "6"], { originKey, dependencies });
      // The retry's dispatch is refused (the first one COMMITTED), which is recheck #12's business
      // and not this control's; what this control asserts is the SEAL.
      assert.equal(retried, undefined, "a committed origin admits no further dispatch");
      const reSealed = h.store.effectRequest(run)!;
      assert.equal(reSealed.request_digest.value, request.request_digest.value, "byte-identical material");
      assert.equal(
        (h.store.db.prepare("SELECT COUNT(*) AS n FROM effect_request WHERE effect_id = ?").get(run) as { n: number }).n,
        1,
        "one effect_request row for one logical origin",
      );
      assert.equal(h.store.openIncidents().length, 0, "zero KERNEL_INCIDENT rows, hence zero scope holds");
      assert.equal(count(h, "run_membership"), 1, "and no second membership row");

      // A5 o-i: a DIFFERENT origin_key over byte-identical work content is a DIFFERENT origin.
      const other = await startWork(h.dir, "development", ["do the thing", "8", "6"], {
        originKey: workPlanOriginKey("cadp-v04:evidence:00000000-0000-7000-8000-0000000000aa", 1),
        dependencies,
      });
      assert.ok(other !== undefined);
      assert.notEqual(other!.effect_id, run, "distinct origins never collide on one effect_id");
      assert.equal(h.store.openIncidents().length, 0, "and neither conflicts with the other");
    } finally {
      api.close();
    }
  } finally {
    rp.h.close();
  }
});

test("WP §3.6: the record vertical allocates under run-origin.v1 and its material carries no wall clock", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    const tokens = new Map<string, string>([["tok-a", "cadp-workflow"]]);
    const api = await startKernelApi(
      { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens },
      0,
    );
    try {
      const dependencies = opsDependencies(h, api, "tok-a");
      const originKey = "record-origin-fixed";
      const started = await startWork(h.dir, "record", ["2", "6", "4"], { originKey, dependencies });
      assert.ok(started !== undefined);
      const run = started!.effect_id;

      const material = JSON.parse(Buffer.from(h.cas.get(h.store.effectRequest(run)!.material_ref)).toString("utf8")) as { args_cas_key: string; args_digest: string };
      const args = JSON.parse(Buffer.from(h.cas.get(material.args_cas_key)).toString("utf8")) as { record: { resource_prefix: string } };
      // The prohibited shape was `live-${Date.now() % 100000}`; the required one is a function of
      // the stable origin_key, so one origin's args are byte-reproducible across attempts.
      assert.equal(args.record.resource_prefix, recordResourcePrefix(originKey));
      assert.doesNotMatch(args.record.resource_prefix, /^live-\d{1,5}$/u, "no wall-clock prefix survives");
      assert.equal(h.store.runMembership(run)?.work_run_ref, run, "the record vertical originates too");

      // The whole point: a retry at a different wall-clock instant re-seals the SAME material.
      h.clock.now += 3_600_000;
      const retried = await startWork(h.dir, "record", ["2", "6", "4"], { originKey, dependencies });
      assert.equal(retried, undefined, "a committed origin admits no further dispatch");
      assert.equal(h.store.openIncidents().length, 0, "no REQUEST_DIGEST_CONFLICT, hence no scope hold");
      assert.equal(count(h, "run_membership"), 1);

      // And the record path presents ONLY the three run-origin keys — no development-only field.
      const allocation = h.store.db
        .prepare("SELECT allocation_schema FROM effect_allocation WHERE effect_id = ?")
        .get(run) as { allocation_schema: string };
      assert.equal(allocation.allocation_schema, RUN_ORIGIN_ALLOCATION_SCHEMA);
    } finally {
      api.close();
    }
  } finally {
    rp.h.close();
  }
});
