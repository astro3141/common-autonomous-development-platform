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
 * D7 is the OTHER Execution Plane leg this file carries, and the reason its manifest entry is
 * many-to-many (EP-B1 above, EP-C1 here): control C1's **AUTHORITY DIRECT-INGRESS** locator leg,
 * the one C1 leg that RUNS at this checkout because it deliberately BYPASSES the broker path. A
 * crafted `BACKEND_EXECUTION` envelope whose `claim.observed.output_artifact` is PRESENT with no
 * locator is refused `OBSERVED_WITHOUT_LOCATOR` by the ALREADY-IMPLEMENTED
 * `assertBackendObservedLocators` (`cadp/kernel/ingress.ts`).
 *
 * It belongs beside D1–D6 because it is the same seam from the same side: both legs are what the
 * Authority ingress owes GENERICALLY about a directly submitted envelope, independent of whether a
 * well-behaved producer built it. C1 splits the locator observable into two controls precisely
 * because they are different: C1(i)'s product path refuses a locator-less result AT THE BROKER, so
 * nothing is ever submitted and NO ingress refusal code is observable there. This is C1(ii), the
 * ingress SAFETY NET as DEFENCE-IN-DEPTH BEHIND that refusal, for any producer that does not come
 * through this broker — and NEVER the production path's expected observable.
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
 * The `execution-output` binding of EP B1(2), carried verbatim: the subject in `object_id`
 * (`<execution_request_digest.value>/<the broker-minted attempt identity>`) and the artifact's own
 * digest in `content_digest`, typed and under an approved scheme. It is here so D7's two legs differ
 * in the locator ALONE — the scheme leg D1–D6 pins is satisfied identically on both sides of it.
 */
const EXECUTION_OUTPUT_BINDING = {
  authority_ref: "cadp-store:k04",
  namespace: "execution-output",
  object_id: `${"a".repeat(64)}/cadp-surface-worker-d7`,
  content_digest: { algorithm: "sha256", canonicalization: "raw-bytes-1", value: "c".repeat(64) },
};

/**
 * A CRAFTED `BACKEND_EXECUTION` draft, built by hand precisely because the broker would never emit
 * one: C1(i)'s malformed-result rule refuses a result missing `output_artifact_locator` at
 * construction, so this envelope reaches the Ingress only by bypassing that path entirely — which is
 * exactly the producer C1(ii)'s safety net exists for. `observed.model` keeps its own (legitimately
 * session-file) locator throughout, so the only thing either leg varies is `output_artifact`.
 */
const backendDraft = (output_artifact: unknown) =>
  ({
    evidence_kind: "BACKEND_EXECUTION",
    subject_bindings: [
      { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-0000000000d7" },
      { authority_ref: "cadp-store:k04", namespace: "surface-role", object_id: "WORKER" },
      EXECUTION_OUTPUT_BINDING,
    ],
    availability: "PRESENT",
    claim_schema: "cadp.backend.v1",
    claim: {
      requested: { model: "gpt-5.3-codex" },
      observed: {
        model: { availability: "PRESENT", value: "gpt-5.3-codex", locator: "session:rollout-d7.jsonl" },
        output_artifact,
      },
    },
    producer_ref: "backend-scan:codex",
    source_ref: "digest-scheme-d7",
    source_relation: "SELF_REPORT",
  }) as never;

test("D7 (EP-C1(ii)): a crafted PRESENT output_artifact submitted DIRECTLY, bypassing the broker, is refused for want of a locator", async () => {
  const h = await makeHarness();
  try {
    const before = evidenceRows(h);
    for (const locatorless of [
      // No locator member at all — the shape C1(i) refuses at the broker and this net catches here.
      { availability: "PRESENT", value: "c".repeat(64) },
      // Present but empty, and present but not a string: the rule is locator PRESENCE, and neither
      // of these locates anything. Locator SHAPE stays the plane's own obligation (EP B1(3)).
      { availability: "PRESENT", value: "c".repeat(64), locator: "" },
      { availability: "PRESENT", value: "c".repeat(64), locator: 7 },
    ]) {
      assert.throws(
        () => h.ingress.submitEvidence(backendDraft(locatorless), PRINCIPALS.backendScan),
        (error: unknown) => (error as { reason?: string }).reason === "OBSERVED_WITHOUT_LOCATOR",
        JSON.stringify(locatorless),
      );
    }
    assert.equal(evidenceRows(h), before, "a refused BACKEND_EXECUTION draft seals nothing");

    // The same envelope, differing in the locator ALONE, seals — so the refusals above are the
    // locator leg biting, not the draft being unsealable for some unrelated reason.
    const sealed = h.ingress.submitEvidence(
      backendDraft({ availability: "PRESENT", value: "c".repeat(64), locator: "cas:d7-artifact-bytes" }),
      PRINCIPALS.backendScan,
    );
    assert.equal(sealed.evidence_kind, "BACKEND_EXECUTION");
    assert.deepEqual(sealed.subject_bindings[2], EXECUTION_OUTPUT_BINDING, "the approved-scheme artifact binding is sealed verbatim");
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
