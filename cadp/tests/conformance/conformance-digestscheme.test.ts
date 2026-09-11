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
 *
 * D7 is the OTHER control this file carries, EP-C1's AUTHORITY DIRECT-INGRESS locator leg. It is
 * here rather than with the product-path legs because it is the same observable this file's other
 * legs are: what the generic Ingress refuses about a crafted evidence draft, with no broker in the
 * path at all. C1 splits the locator legs into two controls precisely because the two paths yield
 * DIFFERENT observables — B1(2)'s malformed-result rule means a result with a digest but no locator
 * is refused broker-side and never reaches the Ingress, so the product path's observable is a
 * BACKEND_EXECUTION delta of zero and no ingress code at all. D7 is the other half: the ingress
 * safety net as DEFENCE-IN-DEPTH BEHIND that refusal, for any producer that does not come through
 * this broker — never the production path's expected observable.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { makeHarness, reviewBodyPair, sealScriptedRequest, stopSharedOpa, PRINCIPALS } from "../support/harness.ts";
import type { Harness } from "../support/harness.ts";

after(() => stopSharedOpa());

const VALUE = "b".repeat(64);

const commit = (object_id: string, content_digest?: unknown) => ({
  authority_ref: "cadp-store:k04",
  namespace: "commit",
  object_id,
  ...(content_digest === undefined ? {} : { content_digest }),
});

/** A minimal REVIEW draft: the kind the reviewer identity may produce, per the reference registry. */
const reviewDraft = (h: Harness, subject_bindings: unknown[]) =>
  ({
    evidence_kind: "REVIEW",
    subject_bindings,
    availability: "PRESENT",
    claim_schema: "cadp.review.v1",
    claim: { verdict: "APPROVE", ...reviewBodyPair(h, "digest-scheme review body") },
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
        () => h.ingress.submitEvidence(reviewDraft(h, subject_bindings), PRINCIPALS.reviewer),
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
    const sealed = h.ingress.submitEvidence(reviewDraft(h, [commit("sha-d3", approved)]), PRINCIPALS.reviewer);
    assert.deepEqual(sealed.subject_bindings[0]?.content_digest, approved, "the approved digest is sealed unchanged");

    // D4: no digest is DEMANDED — digests that exist are validated, absence is not this layer's business.
    const digestless = h.ingress.submitEvidence(reviewDraft(h, [commit("sha-d4")]), PRINCIPALS.reviewer);
    assert.equal(digestless.subject_bindings[0]?.content_digest, undefined);
    assert.equal(digestless.subject_bindings[0]?.object_id, "sha-d4");

    // Each of the three bootstrap schemes the active config must retain is accepted alike; the
    // check reads the policy set, and knows nothing about which namespace carries which scheme.
    for (const canonicalization of ["raw-bytes-1", "cadp-jcs-1", "cadp-bundle-payload-1"]) {
      const envelope = h.ingress.submitEvidence(
        reviewDraft(h, [commit(`sha-${canonicalization}`, { algorithm: "sha256", canonicalization, value: VALUE })]),
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
        () => h.ingress.submitEvidence(reviewDraft(h, [commit("sha-d5", malformed)]), PRINCIPALS.reviewer),
        (error: unknown) =>
          (error as Error).message.includes("binding.content_digest") ||
          (error as { reason?: string }).reason === "DIGEST_SCHEME_UNAPPROVED",
        JSON.stringify(malformed),
      );
    }
    // A non-array subject_bindings stays the schema layer's refusal too, not a TypeError.
    assert.throws(
      () => h.ingress.submitEvidence(reviewDraft(h, "not-an-array" as never), PRINCIPALS.reviewer),
      (error: unknown) => (error as Error).message.includes("bindings must be an array"),
    );
    assert.equal(evidenceRows(h), before, "no malformed draft sealed a row");
  } finally {
    h.close();
  }
});

/**
 * The crafted `BACKEND_EXECUTION` draft D7 submits DIRECTLY, with no broker anywhere in the path.
 * It is built to reach the locator rule rather than trip anything earlier: the surface-role binding
 * `assertBackendSurfaceRole` demands is present, and the artifact binding carries its
 * `content_digest` under an APPROVED scheme, so D1–D6's scheme leg passes on this very draft and the
 * only thing left to refuse is the locator. `observed.output_artifact` is the C1 field specifically —
 * C13 (`conformance-authority.test.ts`) already pins `observed.model`, and the two are separate
 * facts about separate legs of the rule.
 */
const backendDraft = (output_artifact: Record<string, unknown>) =>
  ({
    evidence_kind: "BACKEND_EXECUTION",
    subject_bindings: [
      { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-0000000000d7" },
      { authority_ref: "cadp-store:k04", namespace: "surface-role", object_id: "WORKER" },
      {
        authority_ref: "cadp-store:k04",
        namespace: "execution-output",
        object_id: `${"c".repeat(64)}/attempt-d7`,
        content_digest: { algorithm: "sha256", canonicalization: "raw-bytes-1", value: VALUE },
      },
    ],
    availability: "PRESENT",
    claim_schema: "cadp.backend.v1",
    claim: { requested: {}, observed: { output_artifact } },
    producer_ref: "backend-scan:codex",
    source_ref: "digest-scheme-direct-ingress",
    source_relation: "SELF_REPORT",
  }) as never;

test("D7 (EP-C1): a crafted BACKEND_EXECUTION submitted DIRECTLY with a PRESENT output_artifact and no locator is refused", async () => {
  const h = await makeHarness();
  try {
    const before = evidenceRows(h);
    // The safety net bites on the direct submission the broker never mediated.
    assert.throws(
      () => h.ingress.submitEvidence(backendDraft({ availability: "PRESENT", value: VALUE }), PRINCIPALS.backendScan),
      (error: unknown) => (error as { reason?: string }).reason === "OBSERVED_WITHOUT_LOCATOR",
    );
    // An empty-string locator is no locator: presence is the rule, so it cannot be satisfied vacuously.
    assert.throws(
      () => h.ingress.submitEvidence(backendDraft({ availability: "PRESENT", value: VALUE, locator: "" }), PRINCIPALS.backendScan),
      (error: unknown) => (error as { reason?: string }).reason === "OBSERVED_WITHOUT_LOCATOR",
    );
    assert.equal(evidenceRows(h), before, "a refused direct submission seals nothing");

    // ATTRIBUTION: the same crafted draft with a locator seals, so the two refusals above are the
    // locator's absence alone — not the surface-role binding, the artifact digest's scheme, or the
    // claim schema, each of which is byte-identical across all three submissions.
    const sealed = h.ingress.submitEvidence(
      backendDraft({ availability: "PRESENT", value: VALUE, locator: "cas://d7-artifact" }),
      PRINCIPALS.backendScan,
    );
    assert.equal(sealed.evidence_kind, "BACKEND_EXECUTION");
    assert.equal(evidenceRows(h), before + 1);
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
