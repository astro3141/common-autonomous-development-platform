/**
 * AP B5(2)-(5) part 2 — the PRESENTATION half of the run-capability mechanism: the seal-time
 * membership checks of B5(3)-(5), the ordinary member path's four legs of B5(4) with their exact
 * codes, the K7 usability gate of B5(2) read on the run's LATEST CONCLUSIVE state, the
 * `x-cadp-run-capability` transport of B6(3), and the PEP's recheck #19.
 *
 * These are the §C control A4 legs the merged part-1 file does not cover, run against the SAME
 * fixtures (`support/runProfile.ts`) so the two halves cannot drift into two compositions: the
 * origin seal, its witness and its one-shot mint are part 1's and are consumed here, not re-proven.
 *
 * The whole regime is gated on the run profile being ENABLED — a `cadp.kernel-config.v2` bundle
 * enrolling at least one `requester_ref` — so a `cadp.kernel-config.v1` deployment and a v2
 * deployment that has not switched the profile on are unaffected. The last two tests are those
 * complementary claims.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { startKernelApi } from "../kernel/api.ts";
import { IngressRejection, RUN_CAPABILITY_HEADER } from "../kernel/ingress.ts";
import { DEFAULT_WORK_RUN_REF, PRINCIPALS, makeHarness, stopSharedOpa, v2ConfigOverrides } from "./support/harness.ts";
import {
  IDENTITY_B, IDENTITY_C, PRINCIPAL_B, PRINCIPAL_C, REQUESTER_A, REQUESTER_B, REQUESTER_C, WORK_RUN_AUTHORITY,
  WorkStartTarget, count, dispatch, originRun, runProfileConfig, runProfileHarness, sealRunBound, sealWorkStart,
} from "./support/runProfile.ts";
import type { RunProfileHarness } from "./support/runProfile.ts";
import { REFERENCE_IDENTITIES } from "../deployment/referencePolicy.ts";

after(() => stopSharedOpa());

/** Both holders enrolled: the cross-holder borrowing legs need a SECOND enrolled requester. */
function twoHolderConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return runProfileConfig({ run_profile_enrolled_requester_refs: [REQUESTER_A, REQUESTER_B], ...overrides });
}

/** A base64url (unpadded) 256-bit value that is not any minted secret — the "wrong secret" input. */
function foreignCapability(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Assert one refusal leg completely: the exact reason code, ZERO new `effect_request` rows, ZERO
 * new `run_membership` rows, and — B6(3)'s logging prohibition — no presented secret anywhere in
 * the thrown message or stack.
 */
function refuses(
  rp: RunProfileHarness,
  seal: () => void,
  reason: string,
  presented: string | undefined,
  note: string,
): IngressRejection {
  const requests = count(rp.h, "effect_request");
  const memberships = count(rp.h, "run_membership");
  let thrown: unknown;
  try {
    seal();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof IngressRejection, `${note}: expected an IngressRejection, got ${String(thrown)}`);
  assert.equal((thrown as IngressRejection).reason, reason, `${note}: ${(thrown as Error).message}`);
  assert.equal(count(rp.h, "effect_request"), requests, `${note}: zero effect_request rows`);
  assert.equal(count(rp.h, "run_membership"), memberships, `${note}: zero run_membership rows`);
  if (presented !== undefined) {
    assert.equal((thrown as Error).message.includes(presented), false, `${note}: the refusal text names the secret`);
    assert.equal((thrown as Error).stack?.includes(presented), false, `${note}: the stack names the secret`);
    const raw = Buffer.from(presented, "base64url");
    for (const encoding of [raw.toString("hex"), raw.toString("base64")]) {
      assert.equal((thrown as Error).message.includes(encoding), false, `${note}: the refusal text encodes the secret`);
    }
  }
  return thrown as IngressRejection;
}

// ================================================ A4 — the happy path, end to end

test("A4: origin seals with no header, mints once, and its capability seals a follow-up into the run", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    // The origin presents NO capability — B5(9)'s exemption is exactly the presentation legs — and
    // its own initial dispatch is the ONE delivery of the run's secret (B5(1), B5(7)).
    const run = await originRun(rp, "origin-happy");
    assert.equal(count(h, "run_capability"), 1, "minted exactly once");
    assert.equal(h.store.runMembership(run.effect_id)?.work_run_ref, run.effect_id, "the origin's own witness");

    // The ordinary member path of B5(4): a NON-`WORK_START` request bound to that run, presenting
    // the delivered capability, passes every leg — digest against the row for THIS run, holder
    // against the STAMPED `requester_ref`, and the run's latest conclusive K7 state COMMITTED.
    const follow = sealRunBound(rp, { work_run_ref: run.effect_id, capability: run.capability });
    assert.equal(h.store.effectRequest(follow.effect_id)?.effect_id, follow.effect_id, "the follow-up SEALS");

    // B5(5): the durable proof, written in the SAME transaction as the `effect_request` row, with
    // the run in the second column — NOT the self-referential shape, which only an origin gets.
    const proof = h.store.runMembership(follow.effect_id);
    assert.equal(proof?.effect_id, follow.effect_id);
    assert.equal(proof?.work_run_ref, run.effect_id, "run_membership(follow_up, E)");
    assert.notEqual(proof?.work_run_ref, follow.effect_id, "a member is not an origin");
    assert.equal(count(h, "run_membership"), 2, "the origin's witness and the member's proof");
    assert.equal(count(h, "run_capability"), 1, "sealing a member mints nothing");

    // Recheck #19 finds that row inside the admission transaction and the follow-up admits.
    const admitted = await dispatch(h, follow.effect_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal((admitted as { run_capability?: string }).run_capability, undefined, "a member never mints");
  } finally {
    rp.h.close();
  }
});

// ================================================ A4 — the four member-path legs of B5(4)

test("A4/B5(4): required, invalid, holder-mismatch and same-holder wrong-run borrowing, each with its exact code", async () => {
  const rp = await runProfileHarness(twoHolderConfig());
  try {
    const { h } = rp;
    const r1 = await originRun(rp, "origin-r1"); // held by A
    const r2 = await originRun(rp, "origin-r2"); // ALSO held by A — the same-holder borrowing leg
    const rb = await originRun(rp, "origin-b", PRINCIPAL_B, REQUESTER_B); // held by B

    // (1) RUN_CAPABILITY_REQUIRED — an enrolled requester's run-bound request presenting NONE.
    // Distinct from RUN_BINDING_REQUIRED, which covers only the missing-binding case, and from
    // recheck #19's RUN_MEMBERSHIP_UNPROVEN, which is a PEP-time code and is raised on no seal leg.
    const required = refuses(
      rp, () => sealRunBound(rp, { work_run_ref: r1.effect_id }), "RUN_CAPABILITY_REQUIRED", undefined, "no header",
    );
    assert.doesNotMatch(required.reason, /RUN_BINDING_REQUIRED|RUN_MEMBERSHIP_UNPROVEN/u);

    // (2) RUN_CAPABILITY_INVALID — a well-formed 256-bit value that is not the run's secret.
    const wrong = foreignCapability();
    refuses(
      rp, () => sealRunBound(rp, { work_run_ref: r1.effect_id, capability: wrong }),
      "RUN_CAPABILITY_INVALID", wrong, "wrong secret",
    );
    // And a malformed presentation is the same ordinary refusal, never a crash: the decode is
    // lenient, the digest cannot match, and the length check runs before the constant-time compare.
    for (const malformed of ["", "not base64url!!", "AAAA", "A".repeat(500)]) {
      refuses(
        rp, () => sealRunBound(rp, { work_run_ref: r1.effect_id, capability: malformed }),
        malformed === "" ? "RUN_CAPABILITY_REQUIRED" : "RUN_CAPABILITY_INVALID", undefined, `malformed ${JSON.stringify(malformed)}`,
      );
    }

    // (3) RUN_CAPABILITY_HOLDER_MISMATCH — B's genuinely valid capability for its OWN run,
    // exfiltrated and presented by A on a request bound to that same run. The row exists and the
    // digest matches; only `holder_ref` differs, so the holder leg is what refuses.
    refuses(
      rp, () => sealRunBound(rp, { work_run_ref: rb.effect_id, capability: rb.capability }),
      "RUN_CAPABILITY_HOLDER_MISMATCH", rb.capability, "exfiltrated capability, non-holder",
    );

    // (4) SAME-HOLDER WRONG-RUN BORROWING — A presents its OWN valid, holder-matching, COMMITTED
    // capability for R1 on a request bound to R2, which A also holds. The row lookup is scoped to
    // THIS request's exact `work_run_ref` BEFORE any holder comparison, so this is
    // RUN_CAPABILITY_INVALID and NOT the holder code: possession of a valid capability confers
    // nothing outside the one run it names (Spec v0.5 §5.3).
    const borrowed = refuses(
      rp, () => sealRunBound(rp, { work_run_ref: r2.effect_id, capability: r1.capability }),
      "RUN_CAPABILITY_INVALID", r1.capability, "same holder, wrong run",
    );
    assert.notEqual(borrowed.reason, "RUN_CAPABILITY_HOLDER_MISMATCH", "the run scoping decides, not the holder");
    // Symmetric in the other direction, so the leg is not an artefact of which run was created first.
    refuses(
      rp, () => sealRunBound(rp, { work_run_ref: r1.effect_id, capability: r2.capability }),
      "RUN_CAPABILITY_INVALID", r2.capability, "same holder, wrong run (reversed)",
    );

    // The positive control on the same store, so the four refusals are attributed to the legs and
    // not to a build that refuses everything: each holder's OWN capability on its OWN run SEALS.
    sealRunBound(rp, { work_run_ref: r1.effect_id, capability: r1.capability });
    sealRunBound(rp, { work_run_ref: r2.effect_id, capability: r2.capability });
    sealRunBound(rp, {
      work_run_ref: rb.effect_id, capability: rb.capability, principal: PRINCIPAL_B, requester_ref: REQUESTER_B,
    });
    assert.equal(count(h, "run_capability"), 3, "no refusal minted, revoked or rewrote anything");
  } finally {
    rp.h.close();
  }
});

// ================================================ A4 — B5(3), enrollment ↔ binding

test("A4/B5(3): an enrolled requester's unbound request is RUN_BINDING_REQUIRED; a non-enrolled bound one is NOT_RUN_ENROLLED", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    const run = await originRun(rp, "origin-enrollment");

    // RUN_BINDING_REQUIRED: refused, not merely uncounted (Spec v0.5 §5.1). Raised AHEAD of B5(9)'s
    // adjudication, so a `WORK_START` with no kernel work-run subject gets this exact code rather
    // than the origin rule's less exact RUN_CAPABILITY_INVALID.
    refuses(
      rp, () => sealWorkStart(rp, { origin_key: "origin-unbound", unbound: true }),
      "RUN_BINDING_REQUIRED", undefined, "enrolled, no work-run binding",
    );
    // Presenting a valid capability does not supply the missing binding either.
    refuses(
      rp, () => sealWorkStart(rp, { origin_key: "origin-unbound-2", unbound: true, capability: run.capability }),
      "RUN_BINDING_REQUIRED", run.capability, "enrolled, no binding, capability presented",
    );

    // NOT_RUN_ENROLLED: enrollment cannot be ACQUIRED by presenting a binding (WP §5.2), and
    // presenting a genuinely valid capability for a COMMITTED run does not acquire it either — the
    // enrollment leg is decided before any capability leg runs.
    refuses(
      rp,
      () => sealRunBound(rp, { work_run_ref: run.effect_id, principal: PRINCIPAL_C, requester_ref: REQUESTER_C }),
      "NOT_RUN_ENROLLED", undefined, "non-enrolled, run-bound",
    );
    refuses(
      rp,
      () => sealRunBound(rp, {
        work_run_ref: run.effect_id, capability: run.capability, principal: PRINCIPAL_C, requester_ref: REQUESTER_C,
      }),
      "NOT_RUN_ENROLLED", run.capability, "non-enrolled, run-bound, capability presented",
    );

    // An OFF-AUTHORITY `{other, work-run, R}` binding is not a kernel work-run subject (B3(4)(a)),
    // so it can never make its bearer a member — but it IS what the kernel's namespace-only readers
    // count (`effect_request.work_run_ref`, `MAX_EFFECTS_IN_WORK_RUN`, `list_effects`). Both sides
    // of B5(3) close over it, so no seal can put an effect on a run's budget without membership:
    // the ENROLLED requester's off-authority binding is leg 2's "none" case, RUN_BINDING_REQUIRED;
    // the NON-enrolled requester's is NOT_RUN_ENROLLED.
    refuses(
      rp, () => sealWorkStart(rp, { origin_key: "origin-off-authority", authority_ref: "other" }),
      "RUN_BINDING_REQUIRED", undefined, "enrolled, off-authority work-run binding",
    );
    refuses(
      rp,
      () => sealWorkStart(rp, {
        origin_key: "origin-off-authority-c", authority_ref: "other", work_run_ref: run.effect_id,
        principal: PRINCIPAL_C, requester_ref: REQUESTER_C, capability: run.capability,
      }),
      "NOT_RUN_ENROLLED", run.capability, "non-enrolled, off-authority work-run binding",
    );

    // The positive half of the same rule: a NON-enrolled requester's request that binds no kernel
    // work-run subject at all still seals exactly as it does today — the rule refuses acquisition,
    // it does not forbid the outsider from acting outside every run.
    const outside = sealWorkStart(rp, { origin_key: "origin-outsider", principal: PRINCIPAL_C, requester_ref: REQUESTER_C, unbound: true });
    assert.equal(h.store.effectRequest(outside.effect_id)?.effect_id, outside.effect_id);
    assert.equal(h.store.runMembership(outside.effect_id), undefined, "and acquires no membership by it");

    // The store invariant the two legs together buy, asserted directly: under an active run profile
    // every `effect_request` row with a non-null `work_run_ref` has a `run_membership` row carrying
    // the same value — no effect is ever counted against a run it is not a proven member of.
    const counted = h.store.db.prepare(
      `SELECT r.effect_id AS effect_id, r.work_run_ref AS run, m.work_run_ref AS proof
       FROM effect_request r LEFT JOIN run_membership m ON m.effect_id = r.effect_id
       WHERE r.work_run_ref IS NOT NULL`,
    ).all() as Array<{ effect_id: string; run: string; proof: string | null }>;
    assert.ok(counted.length > 0, "the invariant is not vacuous");
    for (const row of counted) {
      assert.equal(row.proof, row.run, `${row.effect_id} is counted against ${row.run} without proving membership`);
    }
  } finally {
    rp.h.close();
  }
});

// ================================================ A4 — B5(2), the K7 usability gate

test("A4/B5(2): UNKNOWN is RUN_SCOPE_UNRESOLVED, and reconciliation to COMMITTED flips the SAME capability with no re-delivery", async () => {
  const rp = await runProfileHarness();
  try {
    const { h, target } = rp;
    // The origin's dispatch is AMBIGUOUS, so its outcome is UNKNOWN — the capability WAS delivered
    // at that dispatch and its `run_capability` row exists; only usability is in question (B5(2)).
    target.onDispatch = () => ({ kind: "AMBIGUOUS", raw_observation: "transport reply lost" });
    const { effect_id: run } = sealWorkStart(rp, { origin_key: "origin-unknown" });
    const admitted = await dispatch(h, run, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal((admitted as { outcome: { result: string } }).outcome.result, "UNKNOWN");
    const capability = (admitted as { run_capability: string }).run_capability;
    const row = h.store.runCapability(run)!;
    assert.equal(row.holder_ref, REQUESTER_A, "the row exists: minting is delivery, not grading");

    refuses(
      rp, () => sealRunBound(rp, { work_run_ref: run, capability }),
      "RUN_SCOPE_UNRESOLVED", capability, "presented while UNKNOWN",
    );

    // `request_reconcile`'s path — the Reconciler writes the outcome with its own observer_ref,
    // OUTSIDE any `admit_and_dispatch` result, and touches no secret on the way (B5(2)).
    target.onDispatch = undefined;
    await h.reconciler.reconcileEffect(run);
    assert.ok(h.store.outcomesByEffect(run).some((o) => o.result === "COMMITTED"), "reconciliation resolved it");

    // THE FLIP, asserted: the SAME already-delivered capability, unchanged and never re-delivered.
    const follow = sealRunBound(rp, { work_run_ref: run, capability });
    assert.equal(h.store.effectRequest(follow.effect_id)?.effect_id, follow.effect_id, "the same presentation now SEALS");
    assert.equal(count(h, "run_capability"), 1, "no re-delivery: still one row");
    assert.deepEqual(h.store.runCapability(run), row, "the row is byte-unchanged — no rotation, no reissue");
  } finally {
    rp.h.close();
  }
});

test("A4/B5(2): NO_EFFECT_CONFIRMED is RUN_SCOPE_REFUSED, and an ordinal-2 COMMITTED flips it without re-delivering", async () => {
  const rp = await runProfileHarness();
  try {
    const { h, target } = rp;
    // Ordinal 1 returns a proven no-effect, which recheck #12 permits a further ordinal after.
    target.onDispatch = (_e, ordinal) =>
      ordinal === 1
        ? { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true, read_authority: "primary" } }
        : undefined; // the adapter default: an ACCEPTED result whose receipt BINDS to the material
    const { effect_id: run } = sealWorkStart(rp, { origin_key: "origin-noeffect" });
    const first = await dispatch(h, run, PRINCIPALS.workflow);
    assert.equal((first as { outcome: { result: string } }).outcome.result, "NO_EFFECT_CONFIRMED");
    const capability = (first as { run_capability: string }).run_capability;
    const row = h.store.runCapability(run)!;

    // Refused WHILE that is the latest conclusive state — deliberately not "forever".
    refuses(
      rp, () => sealRunBound(rp, { work_run_ref: run, capability }),
      "RUN_SCOPE_REFUSED", capability, "presented while NO_EFFECT_CONFIRMED",
    );

    // The permitted next admission of the same effect_id, at dispatch_ordinal 2, reaching COMMITTED.
    const second = await dispatch(h, run, PRINCIPALS.workflow);
    assert.equal(second.kind, "ADMITTED", JSON.stringify(second));
    assert.equal((second as { admission: { dispatch_ordinal: number } }).admission.dispatch_ordinal, 2);
    assert.equal((second as { outcome: { result: string } }).outcome.result, "COMMITTED");
    // The DELIVERY half of the same leg (B5(1), B6(4)): the retry re-delivers nothing and writes
    // no second row — "returned exactly once" keyed on INITIAL dispatch, not on call outcome.
    assert.equal((second as { run_capability?: string }).run_capability, undefined, "no field on the ordinal-2 result");
    assert.equal(count(h, "run_capability"), 1, "no second run_capability row");
    assert.deepEqual(h.store.runCapability(run), row, "the same row, byte-unchanged");

    // THE SECOND FLIP: the SAME already-delivered capability now passes the usability gate.
    const follow = sealRunBound(rp, { work_run_ref: run, capability });
    assert.equal(h.store.effectRequest(follow.effect_id)?.effect_id, follow.effect_id);
    assert.equal(h.store.runMembership(follow.effect_id)?.work_run_ref, run);
  } finally {
    rp.h.close();
  }
});

test("A4/B5(2) negative control: while ordinal 2 is admitted but UNRESOLVED the code is UNRESOLVED, not the earlier REFUSED", async () => {
  const rp = await runProfileHarness();
  try {
    const { h, target } = rp;
    target.onDispatch = (_e, ordinal) =>
      ordinal === 1
        ? { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true, read_authority: "primary" } }
        : { kind: "AMBIGUOUS", raw_observation: "retry reply lost" };
    const { effect_id: run } = sealWorkStart(rp, { origin_key: "origin-unresolved-retry" });
    const first = await dispatch(h, run, PRINCIPALS.workflow);
    const capability = (first as { run_capability: string }).run_capability;
    refuses(rp, () => sealRunBound(rp, { work_run_ref: run, capability }), "RUN_SCOPE_REFUSED", capability, "ordinal 1 NO_EFFECT");

    const second = await dispatch(h, run, PRINCIPALS.workflow);
    assert.equal((second as { admission: { dispatch_ordinal: number } }).admission.dispatch_ordinal, 2);
    assert.equal((second as { outcome: { result: string } }).outcome.result, "UNKNOWN");
    // "Latest conclusive" is the LATEST ADMITTED DISPATCH's, so a freshly admitted, still-open
    // ordinal 2 is UNRESOLVED — not the earlier ordinal's REFUSED, and not a seal.
    refuses(
      rp, () => sealRunBound(rp, { work_run_ref: run, capability }),
      "RUN_SCOPE_UNRESOLVED", capability, "ordinal 2 admitted but unresolved",
    );
  } finally {
    rp.h.close();
  }
});

test("A4/B5(2) guard-bite: pinning the gate to the FIRST outcome denies a COMMITTED run its own scope", async () => {
  // TD §13.1: the same scenario as the NO_EFFECT_CONFIRMED leg, against an Ingress whose K7 read has
  // been reduced to the effect's FIRST outcome. The run's `WORK_START` is committed at the target at
  // ordinal 2, and the presentation STILL refuses — the retry-semantics divergence made observable,
  // which is what makes "latest conclusive" load-bearing rather than a detail of phrasing.
  const rp = await runProfileHarness(runProfileConfig(), undefined, new Set(["run_scope_latest_conclusive"]));
  try {
    const { h, target } = rp;
    target.onDispatch = (_e, ordinal) =>
      ordinal === 1
        ? { kind: "REJECTED_NO_EFFECT", proof_claim: { authoritative_absence: true, read_authority: "primary" } }
        : undefined; // the adapter default: an ACCEPTED result whose receipt BINDS to the material
    const { effect_id: run } = sealWorkStart(rp, { origin_key: "origin-firstoutcome" });
    const first = await dispatch(h, run, PRINCIPALS.workflow);
    const capability = (first as { run_capability: string }).run_capability;
    const second = await dispatch(h, run, PRINCIPALS.workflow);
    assert.equal((second as { outcome: { result: string } }).outcome.result, "COMMITTED");
    assert.ok(h.store.outcomesByEffect(run).some((o) => o.result === "COMMITTED"), "committed at the target");
    refuses(
      rp, () => sealRunBound(rp, { work_run_ref: run, capability }),
      "RUN_SCOPE_REFUSED", capability, "first-outcome gate on a COMMITTED run",
    );
  } finally {
    rp.h.close();
  }
});

// ================================================ A4 — the never-witnessed run is permanently unusable

test("A4 w1: a never-witnessed WORK_START is never anyone's run scope — REQUIRED with none, INVALID with anything", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    // A `WORK_START` sealed while its requester was NOT enrolled: never adjudicated, so no
    // `run_membership(E,E)` witness, so no mint was ever authorized and no `run_capability` row can
    // exist for it (B5(1)(α)). Naming it as a run is therefore permanently refused.
    const outside = sealWorkStart(rp, { origin_key: "origin-never-witnessed", principal: PRINCIPAL_C, requester_ref: REQUESTER_C, unbound: true });
    const admitted = await dispatch(h, outside.effect_id, PRINCIPAL_C);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal((admitted as { run_capability?: string }).run_capability, undefined, "no witness ⇒ no mint");
    assert.equal(h.store.runCapability(outside.effect_id), undefined);

    refuses(rp, () => sealRunBound(rp, { work_run_ref: outside.effect_id }), "RUN_CAPABILITY_REQUIRED", undefined, "presenting none");
    const anything = foreignCapability();
    refuses(
      rp, () => sealRunBound(rp, { work_run_ref: outside.effect_id, capability: anything }),
      "RUN_CAPABILITY_INVALID", anything, "presenting anything",
    );
    // Same for a run ref that names no effect at all.
    refuses(rp, () => sealRunBound(rp, { work_run_ref: DEFAULT_WORK_RUN_REF }), "RUN_CAPABILITY_REQUIRED", undefined, "fabricated run ref");
  } finally {
    rp.h.close();
  }
});

// ================================================ recheck #19 (AP B5(5))

test("#19: an enrolled requester's run-bound effect without its durable membership row is RUN_MEMBERSHIP_UNPROVEN", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    const run = await originRun(rp, "origin-recheck19");
    const follow = sealRunBound(rp, { work_run_ref: run.effect_id, capability: run.capability });
    assert.equal(h.store.runMembership(follow.effect_id)?.work_run_ref, run.effect_id);

    // FAULT INJECTION at the store, which is the only way to reach #19 through the seal path: the
    // seal always writes the row, so #19's subject is a store in which it is ABSENT — the crash,
    // restore-from-partial-backup or tampering case the recheck exists to fail closed on. Authority
    // after restart is reconstructed from rows, never from process memory (TD v0.4 §4.5).
    h.store.db.prepare("DELETE FROM run_membership WHERE effect_id = ?").run(follow.effect_id);
    assert.equal(h.store.runMembership(follow.effect_id), undefined);

    const refused = await dispatch(h, follow.effect_id, PRINCIPALS.workflow);
    assert.equal(refused.kind, "REFUSAL", JSON.stringify(refused));
    assert.equal((refused as { reason: string }).reason, "RUN_MEMBERSHIP_UNPROVEN");
    assert.equal(h.store.admissionsByEffect(follow.effect_id).length, 0, "no admission");
    assert.equal(h.store.outcomesByEffect(follow.effect_id).length, 0, "no outcome");

    // A row naming a DIFFERENT run does not satisfy it either: the match is on `work_run_ref`.
    h.store.insertRunMembership(follow.effect_id, DEFAULT_WORK_RUN_REF);
    const mismatched = await dispatch(h, follow.effect_id, PRINCIPALS.workflow);
    assert.equal((mismatched as { reason: string }).reason, "RUN_MEMBERSHIP_UNPROVEN", JSON.stringify(mismatched));
  } finally {
    rp.h.close();
  }
});

test("#19 guard-bite: with the recheck disabled, the unproven admission PASSES — the item is load-bearing", async () => {
  const rp = await runProfileHarness(runProfileConfig(), new Set(["recheck19_run_membership"]));
  try {
    const { h } = rp;
    const run = await originRun(rp, "origin-recheck19-bite");
    const follow = sealRunBound(rp, { work_run_ref: run.effect_id, capability: run.capability });
    h.store.db.prepare("DELETE FROM run_membership WHERE effect_id = ?").run(follow.effect_id);

    const admitted = await dispatch(h, follow.effect_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
    assert.equal(h.store.admissionsByEffect(follow.effect_id).length, 1, "the prohibited admission");
    assert.equal(h.store.runMembership(follow.effect_id), undefined, "with no durable membership proof");
  } finally {
    rp.h.close();
  }
});

// ================================================ B6(3) — the header is transport and nothing else

test("B6(3): the presented header enters no digest, no record and no CAS blob", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    const run = await originRun(rp, "origin-transport");
    const follow = sealRunBound(rp, { work_run_ref: run.effect_id, capability: run.capability, body: "transport-body" });
    const sealed = h.store.effectRequest(follow.effect_id)!;

    // TWO SEALS OF ONE IDENTICAL REQUEST WITH DIFFERENT HEADERS ⇒ IDENTICAL DIGESTS. The re-seal
    // presents a DIFFERENT value; the K3 semantic payload does not contain the header, so this is
    // an ordinary idempotent re-seal returning the stored row rather than a REQUEST_DIGEST_CONFLICT.
    const incidentsBefore = h.store.openIncidents().length;
    const other = foreignCapability();
    sealRunBound(rp, { effect_id: follow.effect_id, work_run_ref: run.effect_id, capability: other, body: "transport-body" });
    const reSealed = h.store.effectRequest(follow.effect_id)!;
    assert.equal(reSealed.request_digest.value, sealed.request_digest.value, "same request_digest under a different header");
    assert.equal(reSealed.material_digest.value, sealed.material_digest.value, "same material_digest");
    assert.equal(JSON.stringify(reSealed), JSON.stringify(sealed), "the stored row is byte-unchanged");
    assert.equal(h.store.openIncidents().length, incidentsBefore, "and no incident, so the header is not semantic payload");
    // Omitting it entirely is the same idempotent re-seal (B6(2)'s shape, applied to the header).
    sealRunBound(rp, { effect_id: follow.effect_id, work_run_ref: run.effect_id, body: "transport-body" });
    assert.equal(h.store.effectRequest(follow.effect_id)!.request_digest.value, sealed.request_digest.value);

    // And no encoding of any presented value is anywhere durable — swept over every table, which
    // covers `effect_request.request_json`, the CAS blobs and every sealed envelope.
    const tables = (h.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    for (const table of tables) {
      const dump = JSON.stringify(h.store.db.prepare(`SELECT * FROM ${table}`).all());
      for (const secret of [run.capability, other]) {
        const raw = Buffer.from(secret, "base64url");
        for (const [encoding, needle] of [["base64url", secret], ["hex", raw.toString("hex")], ["base64", raw.toString("base64")]] as const) {
          assert.equal(dump.includes(needle), false, `${table} holds a presented capability as ${encoding}`);
        }
      }
    }
  } finally {
    rp.h.close();
  }
});

test("B6(3) over the wire: the capability rides as the x-cadp-run-capability header, never as a body field", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    const tokens = new Map<string, string>([["tok-a", "cadp-workflow"]]);
    const api = await startKernelApi(
      { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens },
      0,
    );
    try {
      const run = await originRun(rp, "origin-wire");
      const material = { tenant: "scripted-1", resource_id: "r-1", body_cas_key: h.ingress.putBlob(Buffer.from("wire", "utf8")) };
      const material_ref = h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
      const seal = async (headers: Record<string, string>) => {
        const allocation_tuple = {
          schema: "cadp.allocation-key.v1", work_run_ref: run.effect_id, step_ordinal: 9001, purpose: "record-write",
        };
        const effect_id = h.ingress.allocateEffectId(allocation_tuple, PRINCIPALS.workflow);
        const res = await fetch(`http://127.0.0.1:${api.port}/seal_effect_request`, {
          method: "POST",
          headers: { authorization: "Bearer tok-a", "content-type": "application/json", ...headers },
          body: JSON.stringify({
            effect_id,
            requester_ref: REQUESTER_A,
            work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: run.effect_id }],
            target_ref: h.target.targetRef(),
            operation_kind: "SCRIPTED_WRITE",
            material_schema: "test.scripted-write.v1",
            material_ref,
            prior_effect_refs: [],
            allocation_tuple,
            // A body member of the header's name must NOT satisfy the check: the transport is the
            // header and only the header (B6(3)). It is also not a `RequestDraft` key, so it is
            // dropped from the sealed record entirely.
            [RUN_CAPABILITY_HEADER]: run.capability,
            run_capability: run.capability,
          }),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown>, effect_id };
      };

      const spoofed = await seal({});
      assert.equal(spoofed.status, 422, JSON.stringify(spoofed.body));
      assert.equal(spoofed.body["error"], "RUN_CAPABILITY_REQUIRED", "a body field is not the transport");
      assert.equal(String(spoofed.body["detail"]).includes(run.capability), false, "and the 422 body never carries a secret");

      const presented = await seal({ [RUN_CAPABILITY_HEADER]: run.capability });
      assert.equal(presented.status, 200, JSON.stringify(presented.body));
      // The body members named like the header never reached `EffectRequestV1`.
      assert.equal(presented.body["run_capability"], undefined);
      assert.equal(presented.body[RUN_CAPABILITY_HEADER], undefined);
      assert.equal(JSON.stringify(presented.body).includes(run.capability), false, "the sealed record carries no secret");
      assert.equal(h.store.runMembership(presented.effect_id)?.work_run_ref, run.effect_id);
    } finally {
      api.close();
    }
  } finally {
    rp.h.close();
  }
});

// ================================================ the complementary claims: nothing else changes

test("run profile OFF: a v2 bundle enrolling nobody keeps every seal path exactly as it was", async () => {
  // The same v2 bundle and the same registered run-origin contract, with an EMPTY enrollment set —
  // the reference posture until the run profile is switched on. B5(3)'s two codes cannot fire:
  // nobody is enrolled, so `RUN_BINDING_REQUIRED` has no subject, and `NOT_RUN_ENROLLED` does not
  // arm on a bundle that never enabled the profile.
  const rp = await runProfileHarness(runProfileConfig({ run_profile_enrolled_requester_refs: [] }));
  try {
    const { h } = rp;
    const bound = sealRunBound(rp, { work_run_ref: DEFAULT_WORK_RUN_REF });
    assert.equal(h.store.effectRequest(bound.effect_id)?.effect_id, bound.effect_id, "a run-bound seal with no capability");
    const unbound = sealWorkStart(rp, { origin_key: "origin-profile-off", unbound: true });
    assert.equal(h.store.effectRequest(unbound.effect_id)?.effect_id, unbound.effect_id, "and an unbound one");
    assert.equal(count(h, "run_membership"), 0, "no membership rows exist to prove or require");
    assert.equal(count(h, "run_capability"), 0);

    // Recheck #19 is likewise inert: the run-bound effect admits with no membership row at all.
    const admitted = await dispatch(h, bound.effect_id, PRINCIPALS.workflow);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
  } finally {
    rp.h.close();
  }
});

test("v1 config: the seal and admission paths are byte-identical — no membership rules, no recheck #19", async () => {
  const target = new WorkStartTarget();
  const h = await makeHarness({ identityRegistry: [...REFERENCE_IDENTITIES, IDENTITY_B, IDENTITY_C], extraAdapters: [target] });
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    await h.pep.refreshTargetIdentity(target);
    const effect_id = h.ingress.allocateEffectId(
      { schema: "cadp.allocation-key.v1", work_run_ref: DEFAULT_WORK_RUN_REF, step_ordinal: 1, purpose: "record-write" },
      PRINCIPALS.workflow,
    );
    const material = { tenant: "scripted-1", resource_id: "r-1", body_cas_key: h.ingress.putBlob(Buffer.from("v1", "utf8")) };
    // Under v1 a run-bound request presents nothing, is refused nothing, and acquires nothing —
    // the run profile is not even expressible, so none of B5(3)-(5) can arm.
    const sealed = h.ingress.sealEffectRequest(
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
    );
    assert.equal(sealed.effect_id, effect_id);
    assert.equal(h.store.runMembership(effect_id), undefined, "v1 writes no membership row");

    // A capability presented under v1 changes nothing at all — there is no rule to read it.
    const ignored = h.ingress.sealEffectRequest(
      {
        effect_id,
        requester_ref: REQUESTER_A,
        work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: DEFAULT_WORK_RUN_REF }],
        target_ref: h.target.targetRef(),
        operation_kind: "SCRIPTED_WRITE",
        material_schema: "test.scripted-write.v1",
        material_ref: sealed.material_ref,
        prior_effect_refs: [],
      },
      PRINCIPALS.workflow,
      { run_capability: foreignCapability() },
    );
    assert.equal(ignored.request_digest.value, sealed.request_digest.value, "idempotent re-seal, no incident");

    const input = h.ingress.assembleAdmissionInput(effect_id, []);
    const evaluated = await h.evaluate(input.input_digest.value);
    const admitted = await h.pep.admitAndDispatch(effect_id, (evaluated as { decision: { decision_id: string } }).decision.decision_id);
    assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
  } finally {
    h.close();
  }
});

// A `v2ConfigOverrides` bundle without the run-origin contract is the other untouched shape: it is
// exercised by the whole of `conformance-allocation.test.ts` and `conformance-assembly.test.ts`,
// which run unchanged, so this file asserts only that the fixture itself still enrols nobody.
test("the shared v2 fixture enrols nobody, which is what keeps every other v2 conformance file inert", () => {
  assert.deepEqual(v2ConfigOverrides()["run_profile_enrolled_requester_refs"], []);
});
