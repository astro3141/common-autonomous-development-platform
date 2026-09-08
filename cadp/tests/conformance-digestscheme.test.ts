/**
 * Execution Plane TD B1(3)'s NAMED implementation gap in the Authority Plane's inherited §2.1
 * contract (AP Part A, §2 row): `data.cadp.approved_digest_schemes` in the ACTIVE policy content
 * governs every new write, and "a digest with an unapproved scheme is invalid input, never a
 * different-but-equal identity". The evidence path validated a `SubjectBinding.content_digest`'s
 * typed SHAPE only (`validSubjectBindings`, `records.ts`), while `assertSchemesApproved` ran over
 * K3 digests alone. These legs pin the closed gap and its deliberate limits:
 *
 *   D1  an evidence draft whose binding carries an unapproved scheme is refused
 *       DIGEST_SCHEME_UNAPPROVED BEFORE the seal, leaving zero evidence rows
 *   D2  every binding is covered, not just the first
 *   D3  the same binding under an approved scheme seals, carrying the digest verbatim
 *   D4  a binding with NO content_digest seals untouched — required-ness is NOT imported here
 *       (TD B1(3): it is owned by product construction and the composition gate)
 *   D5  malformed digests stay `records.ts`'s shape refusal, and never a crash
 *   D6  K3 sealing is unchanged
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { makeHarness, sealScriptedRequest, stopSharedOpa, PRINCIPALS } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

after(() => stopSharedOpa());

const VALUE = "b".repeat(64);

const commit = (object_id: string, content_digest?: unknown) => ({
  authority_ref: "cadp-store:k04",
  namespace: "commit",
  object_id,
  ...(content_digest === undefined ? {} : { content_digest }),
});

/** A minimal REVIEW draft: the kind the reviewer identity may produce, per the reference registry. */
const reviewDraft = (subject_bindings: unknown[]) =>
  ({
    evidence_kind: "REVIEW",
    subject_bindings,
    availability: "PRESENT",
    claim_schema: "cadp.review.v1",
    claim: { verdict: "APPROVE", body_digest: "a".repeat(64) },
    producer_ref: "reviewer:claude-code",
    source_ref: "digest-scheme-test",
    source_relation: "INDEPENDENT_OBSERVATION",
  }) as never;

const evidenceRows = (h: Harness): number =>
  (h.store.db.prepare("SELECT COUNT(*) AS n FROM evidence_envelope").get() as { n: number }).n;

test("D1/D2: an evidence subject binding carrying an unapproved digest scheme is refused before seal", async () => {
  const h = await makeHarness();
  try {
    const before = evidenceRows(h);
    const unapproved = { algorithm: "sha256", canonicalization: "not-a-scheme", value: VALUE };
    for (const subject_bindings of [
      [commit("sha-d1", unapproved)],
      // D2: the check is over EVERY binding that carries a digest, not the first one only.
      [commit("sha-d2a"), commit("sha-d2b", { algorithm: "sha512", canonicalization: "cadp-jcs-1", value: VALUE })],
      [commit("sha-d2c", { algorithm: "sha256", canonicalization: "cadp-jcs-2", value: VALUE }), commit("sha-d2d")],
    ]) {
      assert.throws(
        () => h.ingress.submitEvidence(reviewDraft(subject_bindings), PRINCIPALS.reviewer),
        (error: unknown) => (error as { reason?: string }).reason === "DIGEST_SCHEME_UNAPPROVED",
        JSON.stringify(subject_bindings),
      );
    }
    assert.equal(evidenceRows(h), before, "a refused draft seals nothing");
  } finally {
    h.close();
  }
});

test("D3/D4: an approved scheme seals verbatim, and a binding with no content_digest seals untouched", async () => {
  const h = await makeHarness();
  try {
    const approved = { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: VALUE };
    const sealed = h.ingress.submitEvidence(reviewDraft([commit("sha-d3", approved)]), PRINCIPALS.reviewer);
    assert.deepEqual(sealed.subject_bindings[0]?.content_digest, approved, "the approved digest is sealed unchanged");

    // D4: no digest is DEMANDED — digests that exist are validated, absence is not this layer's business.
    const digestless = h.ingress.submitEvidence(reviewDraft([commit("sha-d4")]), PRINCIPALS.reviewer);
    assert.equal(digestless.subject_bindings[0]?.content_digest, undefined);
    assert.equal(digestless.subject_bindings[0]?.object_id, "sha-d4");

    // Each of the three bootstrap schemes the active config must retain is accepted alike; the
    // check reads the policy set, and knows nothing about which namespace carries which scheme.
    for (const canonicalization of ["raw-bytes-1", "cadp-jcs-1", "cadp-bundle-payload-1"]) {
      const envelope = h.ingress.submitEvidence(
        reviewDraft([commit(`sha-${canonicalization}`, { algorithm: "sha256", canonicalization, value: VALUE })]),
        PRINCIPALS.reviewer,
      );
      assert.equal(envelope.subject_bindings[0]?.content_digest?.canonicalization, canonicalization);
    }
  } finally {
    h.close();
  }
});

test("D5: malformed content_digests remain the schema layer's refusal and never crash the ingress", async () => {
  const h = await makeHarness();
  try {
    const before = evidenceRows(h);
    for (const malformed of [
      null,
      {},
      { algorithm: "sha256" },
      { canonicalization: "cadp-jcs-1", value: VALUE },
      { algorithm: 7, canonicalization: "cadp-jcs-1", value: VALUE },
      { algorithm: "sha256", canonicalization: "cadp-jcs-1" },
      { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: 7 },
      { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: "not-hex" },
      "cadp-jcs-1:" + VALUE,
    ]) {
      assert.throws(
        () => h.ingress.submitEvidence(reviewDraft([commit("sha-d5", malformed)]), PRINCIPALS.reviewer),
        (error: unknown) =>
          (error as Error).message.includes("binding.content_digest") ||
          (error as { reason?: string }).reason === "DIGEST_SCHEME_UNAPPROVED",
        JSON.stringify(malformed),
      );
    }
    // A non-array subject_bindings stays the schema layer's refusal too, not a TypeError.
    assert.throws(
      () => h.ingress.submitEvidence(reviewDraft("not-an-array" as never), PRINCIPALS.reviewer),
      (error: unknown) => (error as Error).message.includes("bindings must be an array"),
    );
    assert.equal(evidenceRows(h), before, "no malformed draft sealed a row");
  } finally {
    h.close();
  }
});

test("D6: K3 sealing is unchanged by the evidence-path check", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h);
    assert.equal(request.material_digest.canonicalization, "cadp-jcs-1");
    assert.equal(request.request_digest.canonicalization, "cadp-jcs-1");
    assert.ok(h.store.effectRequest(request.effect_id) !== undefined, "the K3 record is sealed as before");
  } finally {
    h.close();
  }
});
