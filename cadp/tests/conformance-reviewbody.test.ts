import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash } from "node:crypto";

import { makeHarness, stopSharedOpa, PRINCIPALS } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";
import { startKernelApi } from "../kernel/api.ts";
import { KernelClient } from "../clients/kernelClient.ts";
import {
  REVIEW_CLAIM_SCHEMA, ReviewClaimInvalid, buildReviewClaim, reviewBody, reviewProducerRef, submitReviewEvidence,
  validateReviewClaim,
} from "../product/reviewEvidence.ts";
import type { ReviewClaimV1 } from "../product/reviewEvidence.ts";
import { submitBackendExecutionEvidence } from "../product/backendExecution.ts";
import { REFERENCE_ADAPTERS } from "../deployment/referencePolicy.ts";
import { attribution } from "../product/observationProjection.ts";

/**
 * #259 P0b — the Primary Reviewer's FULL text is durable.
 *
 * The defect: the `REVIEW` claim carried `{verdict, body_digest = sha256(reviewer stdout),
 * reviewer_run_id}` and the stdout itself was dropped once the workflow had parsed one verdict line
 * and one reason line out of it. The digest therefore verified against nothing retained, and the
 * post-STOP team-lead repair lane had only that parsed line — it could not quote a finding.
 *
 * The repair is a SELF-VERIFYING PAIR: the exact bytes go into the kernel CAS, and the claim names
 * them next to their digest. These controls exercise the real seam (`submitReviewEvidence`, the
 * function the review activity calls) against the real Kernel API — real reach matrix, real ingress,
 * real CAS — and then do the verification a repair lane would do: fetch by key, re-digest, compare.
 *
 *   B1  both review rounds store a body; each claim's key fetches bytes that re-digest to its digest
 *   B2  no truncation: a >60 KB stdout comes back byte-identical (the 60 000-char cap is the PROMPT's)
 *   B3  the claim contract: a claim with no `body_cas_key`, or one whose key and digest disagree, is
 *       refused, and nothing is sealed when it is
 *   B4  other evidence kinds — and the claim-opaque kernel they are sealed by — are unchanged
 */

after(() => stopSharedOpa());

const TOKENS = new Map([
  ["tok-reviewer-codex", "cadp-reviewer-codex"],
  ["tok-scan", "cadp-backend-scan"],
  ["tok-obs", "cadp-observer"],
]);

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

async function withApi(h: Harness, run: (url: string) => Promise<void>): Promise<void> {
  const api = await startKernelApi(
    { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens: TOKENS },
    0,
  );
  try {
    await run(`http://127.0.0.1:${api.port}`);
  } finally {
    api.close();
  }
}

/** What a repair lane can do with a sealed claim and nothing else: fetch the bytes, re-digest them. */
function quoteBody(h: Harness, claim: ReviewClaimV1): string {
  const bytes = h.cas.get(claim.body_cas_key);
  assert.equal(sha256(bytes), claim.body_digest, "stored bytes must re-digest to the claim's body_digest");
  return Buffer.from(bytes).toString("utf8");
}

// ------------------------------------------------------------------ B1: both rounds

test("B1: each review round's claim names CAS bytes that re-digest to its body_digest", async () => {
  const h = await makeHarness();
  try {
    // The shape a two-round development run produces: round 1 REQUEST_CHANGES with the findings the
    // repair lane must be able to quote, round 2 APPROVE on the follow-up candidate.
    const rounds = [
      {
        candidate_sha: "1".repeat(40),
        verdict: "REQUEST_CHANGES",
        stdout: [
          "REQUEST_CHANGES",
          "cadp/kernel/ingress.ts:1162 seals the envelope before the kind-specific rule runs",
          "",
          "Findings:",
          "  1. §9.1 producer stamping is fine, but the claim pair is not self-verifying.",
          "  2. The 60 000-char cap is a prompt bound; quoting it as an evidence bound is wrong.",
          "Unicode and control bytes survive: é 漢 🙂\ttab\r\n",
        ].join("\n"),
      },
      {
        candidate_sha: "2".repeat(40),
        verdict: "APPROVE",
        stdout: "APPROVE\nthe follow-up commit addresses both findings\n",
      },
    ];

    await withApi(h, async (url) => {
      const reviewer = new KernelClient(url, "tok-reviewer-codex");
      const observer = new KernelClient(url, "tok-obs");
      const produced: Array<{ evidence_id: string; body_cas_key: string }> = [];

      for (const [index, round] of rounds.entries()) {
        const out = await submitReviewEvidence({
          client: reviewer,
          review_provider: "codex",
          candidate_sha: round.candidate_sha,
          stdout: round.stdout,
          verdict: round.verdict,
          reviewer_run_id: `codex-p:${index + 1}`,
        });

        // Read the claim back through the kernel's own read path, not from the submit result.
        const { envelope } = await observer.getEvidence(out.envelope.evidence_id);
        assert.equal(envelope.evidence_kind, "REVIEW");
        assert.equal(envelope.claim_schema, REVIEW_CLAIM_SCHEMA);
        assert.equal(envelope.producer_ref, "reviewer:codex");
        const claim = envelope.claim as ReviewClaimV1;

        assert.deepEqual(Object.keys(claim).sort(), ["body_cas_key", "body_digest", "reviewer_run_id", "verdict"]);
        assert.equal(claim.verdict, round.verdict);
        assert.equal(claim.body_cas_key, out.body_cas_key);
        assert.equal(claim.body_digest, out.body_digest);
        assert.equal(validateReviewClaim(claim).ok, true);
        // The pair verifies, and the recovered text is the reviewer's stdout byte-for-byte — the
        // whole review, not the one line the workflow parses out of it.
        assert.equal(quoteBody(h, claim), round.stdout);
        produced.push({ evidence_id: out.envelope.evidence_id, body_cas_key: out.body_cas_key });
      }

      // Both rounds are retained, each with its OWN body: round 2 does not displace round 1's text.
      assert.equal(new Set(produced.map((p) => p.evidence_id)).size, 2);
      assert.equal(new Set(produced.map((p) => p.body_cas_key)).size, 2);
      assert.equal(Buffer.from(h.cas.get(produced[0]!.body_cas_key)).toString("utf8"), rounds[0]!.stdout);
      assert.equal(Buffer.from(h.cas.get(produced[1]!.body_cas_key)).toString("utf8"), rounds[1]!.stdout);
    });
  } finally {
    h.close();
  }
});

test("B1a: the read-only attribution projection carries the pair, so the body is reachable from it", async () => {
  const h = await makeHarness();
  try {
    const stdout = "REQUEST_CHANGES\nthe projection must point at this text, not restate it\n";
    await withApi(h, async (url) => {
      const out = await submitReviewEvidence({
        client: new KernelClient(url, "tok-reviewer-codex"),
        review_provider: "codex",
        candidate_sha: "3".repeat(40),
        stdout,
        verdict: "REQUEST_CHANGES",
        reviewer_run_id: "codex-p:1",
      });
      const report = attribution({
        summaries: { query: "COMPLETE", value: { evidence: [] } },
        effectIds: { query: "COMPLETE", value: { effect_ids: [] } },
        envelopes: {},
        byKind: (kind: string) => (kind === "REVIEW" ? [out.envelope] : []),
        effects: [],
      } as unknown as Parameters<typeof attribution>[0]) as {
        review: Array<{ evidence_id: string; subject: string[]; verdict?: string; body_digest?: string; body_cas_key?: string }>;
      };
      assert.equal(report.review.length, 1);
      const row = report.review[0]!;
      assert.equal(row.evidence_id, out.envelope.evidence_id);
      assert.deepEqual(row.subject, [`commit:${"3".repeat(40)}`]);
      assert.equal(row.verdict, "REQUEST_CHANGES");
      assert.equal(row.body_digest, out.body_digest);
      assert.equal(row.body_cas_key, out.body_cas_key);
      // The projection is enough on its own to recover the text it points at.
      assert.equal(quoteBody(h, { ...(out.envelope.claim as ReviewClaimV1), body_cas_key: row.body_cas_key! }), stdout);
    });
  } finally {
    h.close();
  }
});

// ------------------------------------------------------------------ B2: no truncation

test("B2: a >60 KB reviewer stdout is stored and fetched back byte-identical (the cap is the prompt's)", async () => {
  const h = await makeHarness();
  try {
    // Deliberately past the broker's 60 000-char PROMPT cap, and multibyte so a byte/char confusion
    // anywhere on the path would show up as a length or digest mismatch rather than silently.
    const big = `REQUEST_CHANGES\nfinding at the end survives\n${"é漢🙂 padding line with text\n".repeat(3_000)}TAIL MARKER: the last finding\n`;
    const expected = Buffer.from(big, "utf8");
    assert.ok(expected.length > 60_000, "fixture must exceed the 60 000-char prompt cap");

    await withApi(h, async (url) => {
      const out = await submitReviewEvidence({
        client: new KernelClient(url, "tok-reviewer-codex"),
        review_provider: "codex",
        candidate_sha: "4".repeat(40),
        stdout: big,
        verdict: "REQUEST_CHANGES",
        reviewer_run_id: "codex-p:1",
      });
      const stored = h.cas.get(out.body_cas_key);
      assert.equal(stored.length, expected.length, "no truncation: every stored byte is retained");
      assert.deepEqual(Buffer.from(stored), expected);
      assert.equal(sha256(stored), out.body_digest);
      const recovered = Buffer.from(stored).toString("utf8");
      assert.equal(recovered, big);
      assert.ok(recovered.endsWith("TAIL MARKER: the last finding\n"), "the LAST finding survives, not a head slice");
    });
  } finally {
    h.close();
  }
});

// ------------------------------------------------------------------ B3: the claim contract

test("B3: a REVIEW claim without body_cas_key, or with one that disagrees with body_digest, fails validation", () => {
  const { body_digest } = reviewBody("APPROVE\nfine\n");
  const key = `cas://sha256/${body_digest}`;
  const valid: ReviewClaimV1 = { verdict: "APPROVE", body_digest, body_cas_key: key, reviewer_run_id: "codex-p:1" };
  assert.deepEqual(validateReviewClaim(valid), { ok: true });
  assert.deepEqual(buildReviewClaim(valid), valid);

  // The pre-P0b claim shape: a digest with no retained bytes behind it.
  const bodyless = { verdict: "APPROVE", body_digest, reviewer_run_id: "codex-p:1" };
  const missing = validateReviewClaim(bodyless);
  assert.equal(missing.ok, false);
  assert.ok(missing.ok === false && missing.errors.some((e) => e.includes("body_cas_key")));
  assert.throws(() => buildReviewClaim(bodyless as ReviewClaimV1), ReviewClaimInvalid);

  // A key that addresses OTHER bytes than the digest was taken over is not a self-verifying pair.
  const crossed = validateReviewClaim({ ...valid, body_cas_key: `cas://sha256/${"0".repeat(64)}` });
  assert.equal(crossed.ok, false);
  assert.ok(crossed.ok === false && crossed.errors.some((e) => e.includes("does not address the bytes")));

  // Shapes that are not kernel CAS keys at all, and a digest that is not a sha256 hex.
  for (const bad of ["", "sha256/" + body_digest, `cas://sha256/${body_digest.toUpperCase()}`, "cas://sha512/" + body_digest]) {
    assert.equal(validateReviewClaim({ ...valid, body_cas_key: bad }).ok, false, `must refuse body_cas_key ${bad}`);
  }
  assert.equal(validateReviewClaim({ ...valid, body_digest: "not-a-digest" }).ok, false);
  assert.equal(validateReviewClaim({ ...valid, verdict: "" }).ok, false);
  assert.equal(validateReviewClaim({ ...valid, reviewer_run_id: "" }).ok, false);
  // Closed key set — secret hygiene: the claim carries the pair and nothing a host could add to it.
  const extra = validateReviewClaim({ ...valid, reviewer_token: "secret" });
  assert.equal(extra.ok, false);
  assert.ok(extra.ok === false && extra.errors.some((e) => e.includes("unknown claim key reviewer_token")));

  // The digest is taken over exactly the bytes `reviewBody` hands to the CAS put.
  const body = reviewBody("REQUEST_CHANGES\né漢🙂\n");
  assert.equal(body.body_digest, sha256(body.bytes));
  assert.equal(Buffer.from(body.bytes).toString("utf8"), "REQUEST_CHANGES\né漢🙂\n");
});

test("B3a: an unverifiable pair fails closed — no envelope is submitted", async () => {
  let submitted = 0;
  // A client whose CAS put answers with a key for OTHER bytes (the failure the pair exists to catch).
  const liar = {
    putBlob: async () => ({ cas_key: `cas://sha256/${"9".repeat(64)}` }),
    submitEvidence: async () => { submitted += 1; throw new Error("unreachable"); },
  };
  await assert.rejects(
    submitReviewEvidence({
      client: liar as unknown as Parameters<typeof submitReviewEvidence>[0]["client"],
      review_provider: "codex",
      candidate_sha: "5".repeat(40),
      stdout: "APPROVE\nfine\n",
      verdict: "APPROVE",
      reviewer_run_id: "codex-p:1",
    }),
    ReviewClaimInvalid,
  );
  assert.equal(submitted, 0, "nothing is sealed when the pair does not verify");
});

test("B3b: producer attribution is unchanged by the refactor — each provider keeps its own producer_ref", () => {
  assert.equal(reviewProducerRef("claude"), "reviewer:claude-code");
  assert.equal(reviewProducerRef("grok"), "reviewer:grok");
  assert.equal(reviewProducerRef("codex"), "reviewer:codex");
  for (const provider of ["claude", "grok", "codex"]) {
    const entry = REFERENCE_ADAPTERS.find((a) => a.producer_ref === reviewProducerRef(provider));
    assert.deepEqual(entry?.evidence_kinds, ["REVIEW"], `${provider} stays the REVIEW producer it was`);
  }
});

// ------------------------------------------------------------------ B4: nothing else changed

test("B4: other evidence kinds, and the claim-opaque kernel that seals them, are unchanged", async () => {
  const h = await makeHarness();
  try {
    await withApi(h, async (url) => {
      // (a) BACKEND_EXECUTION — produced in the same review step — keeps its exact claim shape.
      const backendId = await submitBackendExecutionEvidence({
        client: new KernelClient(url, "tok-scan"),
        provider: "codex",
        surface_role: "REVIEWER",
        subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: "cadp-v04:effect:00000000-0000-7000-8000-0000000000b4" }],
        model: "gpt-5.6-sol",
        locator: "sessions/rollout.jsonl#offset=1",
      });
      const observer = new KernelClient(url, "tok-obs");
      const backend = (await observer.getEvidence(backendId)).envelope;
      assert.equal(backend.claim_schema, "cadp.backend.v1");
      assert.deepEqual(Object.keys(backend.claim as object).sort(), ["observed", "requested"]);
      assert.ok(!JSON.stringify(backend.claim).includes("body_cas_key"), "no review field leaks into another kind");
    });

    // (b) The kernel Ingress is untouched: it still seals `claim` opaquely under `claim_schema`, so
    // a v0.4/v1 REVIEW envelope of the pre-P0b shape (and every other kind's evidence) seals exactly
    // as before. The new contract is enforced where the claim is BUILT — the producing adapter —
    // which is why no adapter_registry entry and no policy rule had to move for P0b.
    const legacy = h.ingress.submitEvidence(
      {
        evidence_kind: "REVIEW",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: "6".repeat(40), revision_or_version: "6".repeat(40) }],
        availability: "PRESENT",
        claim_schema: REVIEW_CLAIM_SCHEMA,
        claim: { verdict: "APPROVE", body_digest: "a".repeat(64) },
        producer_ref: "reviewer:claude-code",
        source_ref: "claude:read-only-profile",
        source_relation: "INDEPENDENT_OBSERVATION",
      },
      PRINCIPALS.reviewer,
    );
    assert.equal(legacy.availability, "PRESENT");
    assert.equal(validateReviewClaim(legacy.claim).ok, false, "the product contract is what refuses the bodyless claim");

    // (c) The reviewer's registry entry still declares only producer/kind/provenance — the registry
    // constrains no claim key, so extending the claim needed no registry or schema change.
    for (const entry of REFERENCE_ADAPTERS.filter((a) => a.evidence_kinds.includes("REVIEW"))) {
      assert.deepEqual(Object.keys(entry).sort(), ["evidence_kinds", "produced_at_source", "producer_ref", "source_relation"]);
    }
  } finally {
    h.close();
  }
});
