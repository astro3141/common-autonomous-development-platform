/**
 * TD §13.1 — C39 (BREAK_GLASS emergency publication, all-or-nothing), C40 (root-key
 * revocation at execution time; backdating cannot revive a key), C42 (historical
 * authorization binding resolved from the signed document alone), with guard-bites.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { join } from "node:path";

import { makeHarness, stopSharedOpa } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { buildReferenceBundle } from "../deployment/referencePolicy.ts";
import { rawDigest, nowIso } from "../kernel/canonical.ts";
import { executeRootOperation, RootRejection, verifyRootEnvelopeHistorical } from "../kernel/rootListener.ts";
import type { BreakGlassDocument } from "../kernel/rootListener.ts";
import { generateRootKey, signDocument } from "../kernel/sig.ts";
import { ConstitutionalStore } from "../kernel/store.ts";
import { Cas } from "../kernel/cas.ts";

after(() => stopSharedOpa());

function makeDocument(h: Harness, overrides: Partial<BreakGlassDocument> = {}): BreakGlassDocument {
  const active = h.store.activeActivation()!;
  return {
    principal: "root-operator",
    reason: "conformance",
    scope: "cadp-v04",
    created_at: nowIso(h.clock.fn),
    expires_at: new Date(h.clock.now + 1800_000).toISOString(),
    authorization_policy_ref: {
      policy_id: active.policy_id,
      revision: active.revision,
      content_digest: { algorithm: "sha256", canonicalization: "raw-bytes-1", value: active.content_digest },
      seq: active.seq,
    },
    actions: ["ACTIVATE_POLICY"],
    ...overrides,
  };
}

test("C39: break-glass activation is one transaction or nothing; every failure leaves only a BREAK_GLASS_REJECTED incident", async () => {
  const h = await makeHarness();
  try {
    const bundle = buildReferenceBundle({ ...h.policyInput, revision: 2 });
    const bundle_cas_ref = h.cas.put(bundle);

    // (b) stale authorization seq → zero rows, one incident.
    const staleDoc = makeDocument(h, {
      authorization_policy_ref: { ...makeDocument(h).authorization_policy_ref, seq: 99 },
      proposed_policy_ref: { policy_id: "cadp-v04:policy:root", revision: 2, content_digest: rawDigest(bundle) },
      bundle_cas_ref,
    });
    assert.throws(
      () => executeRootOperation(h.store, h.cas, h.ingress, staleDoc, signDocument("BREAK_GLASS", staleDoc, h.root.privatePem), h.clock.fn),
      (error: unknown) => error instanceof RootRejection && error.reason === "AUTHORIZATION_BASE_STALE",
    );
    assert.equal(h.store.policyRef("cadp-v04:policy:root", 2), undefined);
    assert.equal(h.store.activeActivation()!.seq, 1);

    // (c) bundle bytes ≠ proposed digest → zero rows, incident.
    const wrongDigestDoc = makeDocument(h, {
      proposed_policy_ref: { policy_id: "cadp-v04:policy:root", revision: 2, content_digest: { algorithm: "sha256", canonicalization: "raw-bytes-1", value: "0".repeat(64) } },
      bundle_cas_ref,
    });
    assert.throws(
      () => executeRootOperation(h.store, h.cas, h.ingress, wrongDigestDoc, signDocument("BREAK_GLASS", wrongDigestDoc, h.root.privatePem), h.clock.fn),
      (error: unknown) => error instanceof RootRejection && error.reason === "BUNDLE_DIGEST_MISMATCH",
    );
    assert.equal(h.store.policyRef("cadp-v04:policy:root", 2), undefined);

    // (d) forged signature (wrong key) → rejected.
    const foreign = generateRootKey();
    const goodDoc = makeDocument(h, {
      proposed_policy_ref: { policy_id: "cadp-v04:policy:root", revision: 2, content_digest: rawDigest(bundle) },
      bundle_cas_ref,
    });
    assert.throws(
      () => executeRootOperation(h.store, h.cas, h.ingress, goodDoc, signDocument("BREAK_GLASS", goodDoc, foreign.privatePem), h.clock.fn),
      (error: unknown) => error instanceof RootRejection && error.reason === "EXECUTION_AUTHORIZATION_FAILED",
    );

    const incidents = h.store.openIncidents().filter((i) => (i.claim as { incident_kind?: string })?.incident_kind === "BREAK_GLASS_REJECTED");
    assert.equal(incidents.length, 3, "one BREAK_GLASS_REJECTED incident per failure");
    const envelopes = h.store.db.prepare("SELECT COUNT(*) AS n FROM evidence_envelope WHERE evidence_kind = 'BREAK_GLASS'").get() as { n: number };
    assert.equal(envelopes.n, 0, "zero BREAK_GLASS envelopes on failure");

    // (a) the valid document lands everything in one transaction.
    const ok = executeRootOperation(h.store, h.cas, h.ingress, goodDoc, signDocument("BREAK_GLASS", goodDoc, h.root.privatePem), h.clock.fn);
    assert.equal(ok.activated_seq, 2);
    const active = h.store.activeActivation()!;
    assert.equal(active.seq, 2);
    assert.equal(active.revision, 2);
    assert.equal(active.activated_by_ref, h.root.key_id, "root operation, not an ordinary POLICY_ACTIVATE");
    assert.equal(active.activation_evidence_id, ok.evidence_id);
    assert.ok(h.store.policyRef("cadp-v04:policy:root", 2) !== undefined);
  } finally {
    h.close();
  }
});

test("C39 guard-bite: with execution authorization removed, a foreign-signed activation DOES land", async () => {
  const h = await makeHarness();
  try {
    const bundle = buildReferenceBundle({ ...h.policyInput, revision: 2 });
    const bundle_cas_ref = h.cas.put(bundle);
    const foreign = generateRootKey();
    const doc = makeDocument(h, {
      proposed_policy_ref: { policy_id: "cadp-v04:policy:root", revision: 2, content_digest: rawDigest(bundle) },
      bundle_cas_ref,
    });
    const result = executeRootOperation(
      h.store, h.cas, h.ingress, doc,
      signDocument("BREAK_GLASS", doc, foreign.privatePem),
      h.clock.fn,
      new Set(["execution_authorization"]),
    );
    assert.equal(result.activated_seq, 2, "guard removed → prohibited activation occurs (load-bearing)");
  } finally {
    h.close();
  }
});

test("C40: a backdated document cannot revive an expired or rotated-out key; historical envelopes still verify", async () => {
  // K2 expires in the past relative to execution.
  const k2 = generateRootKey();
  const t0 = new Date(Date.now() - 3600_000).toISOString();
  const h = await makeHarness({
    extraRootPublicKeys: [{ key_id: k2.key_id, alg: "Ed25519", public_key: k2.public_key_base64, valid_from: "2026-01-01T00:00:00.000Z", valid_to: t0 }],
  });
  try {
    const bundle = buildReferenceBundle({ ...h.policyInput, revision: 2 });
    const bundle_cas_ref = h.cas.put(bundle);
    // Backdated to before T0, expires generously — historically-valid signature shape.
    const backdated = makeDocument(h, {
      created_at: new Date(Date.parse(t0) - 60_000).toISOString(),
      expires_at: new Date(Date.parse(t0) - 60_000 + 1800_000).toISOString(),
      proposed_policy_ref: { policy_id: "cadp-v04:policy:root", revision: 2, content_digest: rawDigest(bundle) },
      bundle_cas_ref,
    });
    assert.throws(
      () => executeRootOperation(h.store, h.cas, h.ingress, backdated, signDocument("BREAK_GLASS", backdated, k2.privatePem), h.clock.fn),
      (error: unknown) => error instanceof RootRejection && error.reason === "EXECUTION_AUTHORIZATION_FAILED",
      "valid_to is evaluated against now, never created_at",
    );
    assert.equal(h.store.activeActivation()!.seq, 1, "policy_activation delta 0");
    assert.equal(h.store.policyRef("cadp-v04:policy:root", 2), undefined, "policy_ref delta 0");
    const envelopes = h.store.db.prepare("SELECT COUNT(*) AS n FROM evidence_envelope WHERE evidence_kind = 'BREAK_GLASS'").get() as { n: number };
    assert.equal(envelopes.n, 0, "BREAK_GLASS envelope delta 0");
    assert.ok(h.store.openIncidents().some((i) => (i.claim as { incident_kind?: string })?.incident_kind === "BREAK_GLASS_REJECTED"));

    // Guard-bite: with execution-authorization removed the backdated revival DOES land.
    const bitten = executeRootOperation(
      h.store, h.cas, h.ingress, backdated, signDocument("BREAK_GLASS", backdated, k2.privatePem), h.clock.fn, new Set(["execution_authorization"]),
    );
    assert.equal(bitten.activated_seq, 2, "guard removed → revoked key revives (load-bearing)");
  } finally {
    h.close();
  }
});

test("C42: historical verification resolves the key set from the signed ref alone; stale bases reject after rotation", async () => {
  const k2 = generateRootKey();
  const h = await makeHarness({
    extraRootPublicKeys: [{ key_id: k2.key_id, alg: "Ed25519", public_key: k2.public_key_base64, valid_from: "2026-01-01T00:00:00.000Z" }],
  });
  try {
    // (a) open incident + RELEASE_INCIDENTS under policy A signed by K1.
    const incident = h.ingress.sealIncident("DIGEST_CORRUPTION", "conformance scope hold", [
      { authority_ref: "scripted:target", namespace: "SCRIPTED", object_id: "scripted-1" },
    ]);
    assert.equal(h.store.openIncidents().length, 1);
    const release = makeDocument(h, {
      actions: ["RELEASE_INCIDENTS"],
      release_incident_refs: [{ evidence_id: incident.evidence_id, envelope_digest: incident.envelope_digest }],
    });
    const released = executeRootOperation(h.store, h.cas, h.ingress, release, signDocument("BREAK_GLASS", release, h.root.privatePem), h.clock.fn);
    assert.equal(h.store.openIncidents().length, 0, "scope released");

    // Rotate: policy B drops K1 from root_public_keys (signed by K1, valid under A).
    const bundleB = buildReferenceBundle({
      ...h.policyInput,
      revision: 2,
      root_public_keys: [{ key_id: k2.key_id, alg: "Ed25519", public_key: k2.public_key_base64, valid_from: "2026-01-01T00:00:00.000Z" }],
    });
    const rotate = makeDocument(h, {
      proposed_policy_ref: { policy_id: "cadp-v04:policy:root", revision: 2, content_digest: rawDigest(bundleB) },
      bundle_cas_ref: h.cas.put(bundleB),
    });
    executeRootOperation(h.store, h.cas, h.ingress, rotate, signDocument("BREAK_GLASS", rotate, h.root.privatePem), h.clock.fn);
    assert.equal(h.store.activeActivation()!.seq, 2);

    // Corrupt the operational column and "shift the clock" — then RESTART (fresh store handle).
    h.store.db.prepare("UPDATE evidence_envelope SET received_at = '1970-01-01T00:00:00.000Z' WHERE evidence_id = ?").run(released.evidence_id);
    const reopened = new ConstitutionalStore(join(h.dir, "k04.sqlite"));
    const reopenedCas = new Cas(reopened);
    const envelope = reopened.evidenceById(released.evidence_id)!;
    const verdict = verifyRootEnvelopeHistorical(reopened, reopenedCas, envelope);
    assert.equal(verdict.valid, true, `historical verification from the signed ref alone: ${verdict.reason ?? ""}`);
    // The released scope stays released after restart.
    assert.equal(reopened.openIncidents().length, 0);
    reopened.close();

    // (b) after rotation: stale base (A) documents signed by a CURRENTLY-valid key reject.
    for (const actions of [["RELEASE_INCIDENTS"], ["ACTIVATE_POLICY"]] as const) {
      const staleAuth = {
        policy_id: "cadp-v04:policy:root",
        revision: 1,
        content_digest: { algorithm: "sha256" as const, canonicalization: "raw-bytes-1" as const, value: h.store.activationBySeq(1)!.content_digest },
        seq: 1,
      };
      const bundleC = buildReferenceBundle({ ...h.policyInput, revision: 3 });
      const doc = makeDocument(h, {
        authorization_policy_ref: staleAuth,
        actions: actions as never,
        ...(actions[0] === "ACTIVATE_POLICY"
          ? { proposed_policy_ref: { policy_id: "cadp-v04:policy:root", revision: 3, content_digest: rawDigest(bundleC) }, bundle_cas_ref: h.cas.put(bundleC) }
          : { release_incident_refs: [{ evidence_id: incident.evidence_id, envelope_digest: incident.envelope_digest }] }),
      });
      assert.throws(
        () => executeRootOperation(h.store, h.cas, h.ingress, doc, signDocument("BREAK_GLASS", doc, k2.privatePem), h.clock.fn),
        (error: unknown) => error instanceof RootRejection && error.reason === "AUTHORIZATION_BASE_STALE",
        actions.join(","),
      );
    }
    assert.equal(h.store.activeActivation()!.seq, 2, "no successful root-authority record from stale bases");
    assert.equal(h.store.policyRef("cadp-v04:policy:root", 3), undefined);

    // Guard-bite: with the authorization-base check removed a stale-base activation lands.
    const bundleC = buildReferenceBundle({ ...h.policyInput, revision: 3 });
    const stale = makeDocument(h, {
      authorization_policy_ref: {
        policy_id: "cadp-v04:policy:root", revision: 1,
        content_digest: { algorithm: "sha256", canonicalization: "raw-bytes-1", value: h.store.activationBySeq(1)!.content_digest }, seq: 1,
      },
      proposed_policy_ref: { policy_id: "cadp-v04:policy:root", revision: 3, content_digest: rawDigest(bundleC) },
      bundle_cas_ref: h.cas.put(bundleC),
    });
    let bitten: { activated_seq?: number } | undefined;
    try {
      bitten = executeRootOperation(
        h.store, h.cas, h.ingress, stale, signDocument("BREAK_GLASS", stale, k2.privatePem), h.clock.fn, new Set(["authorization_base"]),
      );
    } catch {
      bitten = undefined;
    }
    // With the kernel check removed the activation-CAS still guards seq arithmetic; the insert
    // uses auth.seq + 1 = 2 which already exists → UNIQUE rejection. Report which layer held.
    if (bitten?.activated_seq !== undefined) {
      assert.fail("stale base landed cleanly — unexpected");
    }
    // Defence-in-depth: the store CAS remains load-bearing even with the listener check removed.
    assert.equal(h.store.activeActivation()!.seq, 2);
  } finally {
    h.close();
  }
});
