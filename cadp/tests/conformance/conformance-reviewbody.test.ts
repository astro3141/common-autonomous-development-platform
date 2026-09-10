/**
 * #259 P0b — the Primary Reviewer's FULL text is retained durably, is self-verifying, and is
 * recoverable BYTE-IDENTICALLY through the operator path a team lead actually has after a STOP.
 *
 * Before this lane the `REVIEW` claim held `{verdict, body_digest, reviewer_run_id}` and nothing
 * retained the bytes the digest was over: the digest was unverifiable against anything kept, and
 * the post-STOP repair lane could quote only the workflow's parsed one-line reason. These legs pin
 * the closed gap:
 *
 *   R1  the real review activity puts the reviewer's stdout into kernel CAS and seals the pair
 *       {body_cas_key, body_digest}; both rounds of a run store their own body
 *   R2  the OPERATIONAL retrieval path — `readReviewBody`, the function behind
 *       `ctl review-body <dir> <evidence_id>` — returns the round-2 reviewer text byte-identically
 *       after a second REQUEST_CHANGES. It goes evidence id → REVIEW claim → pair re-verification
 *       → CAS bytes, with no kernel token, no test seam and no generic blob API
 *   R3  no truncation: a >60 KB body round-trips byte-for-byte (the 60 000-char cap bounds the
 *       reviewer PROMPT, never the stored evidence)
 *   R4  fail-closed submission: a REVIEW claim missing `body_cas_key`, naming bytes CAS does not
 *       hold, or whose `body_digest` is not the digest of those bytes, is refused before the seal
 *   R5  fail-closed retrieval: with the ingress rule disabled (the guard-bite knob), a sealed
 *       REVIEW whose pair does not verify yields a THROW, never unverified bytes; a non-REVIEW
 *       evidence id is refused too
 *   R6  no other evidence kind's claim shape is constrained by any of this
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { startKernelApi } from "../../kernel/api.ts";
import { readReviewBody } from "../../live/reviewBody.ts";
import { reviewCandidate } from "../../product/activities.ts";
import { makeHarness, reviewBodyPair, stopSharedOpa, PRINCIPALS } from "./support/harness.ts";
import type { Harness } from "./support/harness.ts";

after(() => stopSharedOpa());

const TOKENS = new Map([
  ["tok-wf", "cadp-workflow"],
  ["tok-reviewer", "cadp-reviewer-claude"],
  ["tok-scan-claude", "cadp-backend-scan-claude"],
]);

const RUN_REF = "cadp-v04:effect:00000000-0000-7000-8000-00000000rb01";
const SHA_ROUND_1 = "a".repeat(40);
const SHA_ROUND_2 = "b".repeat(40);

/** The reviewer's own words, verbatim — including the findings the repair lane must quote. */
const ROUND_1_STDOUT = `REQUEST_CHANGES
the seam stores a digest of bytes nothing retains

Findings:
  1. cadp/product/activities.ts:583 — body_digest is computed over stdout that is then dropped.
  2. no operator path recovers the text after a STOP.
`;

/**
 * R3: deliberately past the broker's 60 000-character PROMPT cap, so a body that "should" have
 * been cut proves it was not. Non-ASCII on purpose: the round-trip is over BYTES, not characters.
 */
const ROUND_2_STDOUT = `REQUEST_CHANGES
still not retrievable — 전문 회수 경로가 없음

${"x".repeat(70_000)}
tail-marker-that-a-60000-char-cap-would-have-eaten
`;

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface ScriptedBroker {
  url: string;
  calls: Array<Record<string, unknown>>;
  close(): void;
}

/**
 * The surface broker seam, scripted: `/review` answers with the queued verdict + stdout. The
 * activity under test is the REAL one — only the isolated reviewer container behind the broker is
 * replaced, exactly as the rest of the suite replaces the target adapter.
 */
async function scriptedBroker(replies: Array<{ verdict: string; reason: string; stdout: string }>): Promise<ScriptedBroker> {
  const queue = [...replies];
  const calls: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      const next = queue.shift();
      res.writeHead(next === undefined ? 500 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(next ?? { error: "no scripted review left" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => server.close() };
}

/** Run `body` with the activity-host environment the real worker process holds. */
async function withActivityEnv(kernelUrl: string, brokerUrl: string, body: () => Promise<void>): Promise<void> {
  const vars: Record<string, string> = {
    CADP_KERNEL_URL: kernelUrl,
    CADP_BROKER_URL: brokerUrl,
    CADP_WORKFLOW_TOKEN: "tok-wf",
    CADP_REVIEWER_TOKEN: "tok-reviewer",
    CADP_BACKEND_SCAN_TOKEN_CLAUDE: "tok-scan-claude",
  };
  const prior = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    await body();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function reviewClaim(h: Harness, evidence_id: string): Record<string, unknown> {
  const envelope = h.store.evidenceById(evidence_id);
  assert.ok(envelope !== undefined, `no evidence row ${evidence_id}`);
  assert.equal(envelope.evidence_kind, "REVIEW");
  return envelope.claim as Record<string, unknown>;
}

test("R1/R2/R3: two REQUEST_CHANGES rounds store their full reviewer text; the operator path returns round 2 byte-identically", async () => {
  const h = await makeHarness();
  const broker = await scriptedBroker([
    { verdict: "REQUEST_CHANGES", reason: "the seam stores a digest of bytes nothing retains", stdout: ROUND_1_STDOUT },
    { verdict: "REQUEST_CHANGES", reason: "still not retrievable", stdout: ROUND_2_STDOUT },
  ]);
  const api = await startKernelApi(
    { store: h.store, cas: h.cas, ingress: h.ingress, pep: h.pep, reconciler: h.reconciler, evaluator: h.evaluator, tokens: TOKENS },
    0,
  );
  try {
    await withActivityEnv(`http://127.0.0.1:${api.port}`, broker.url, async () => {
      // The development workflow reviews at most twice (product/workflows.ts): round 1, then — on
      // REQUEST_CHANGES — a NEW candidate reviewed again. Both rounds run the same activity, so
      // driving it twice over the two candidate shas is that flow's exact evidence sequence.
      const round1 = await reviewCandidate({
        work_run_ref: RUN_REF, step_ordinal: 1, repo_full_name: "astro3141/cadp-disposable",
        repo_id: "1", candidate_sha: SHA_ROUND_1, work_item: "retain the reviewer body",
      });
      const round2 = await reviewCandidate({
        work_run_ref: RUN_REF, step_ordinal: 2, repo_full_name: "astro3141/cadp-disposable",
        repo_id: "1", candidate_sha: SHA_ROUND_2, work_item: "retain the reviewer body",
        prior_step_envelope_digest: round1.work_step_envelope_digest,
      });
      assert.equal(round1.verdict, "REQUEST_CHANGES");
      assert.equal(round2.verdict, "REQUEST_CHANGES");
      assert.equal(broker.calls.length, 2);

      // R1: BOTH rounds sealed the pair, and each names its OWN body.
      for (const [round, stdout] of [[round1, ROUND_1_STDOUT], [round2, ROUND_2_STDOUT]] as const) {
        const claim = reviewClaim(h, round.review_evidence_id);
        assert.equal(claim["body_cas_key"], round.review_body_cas_key);
        assert.equal(claim["body_digest"], sha256Hex(Buffer.from(stdout, "utf8")));
        assert.equal(claim["verdict"], "REQUEST_CHANGES");
      }
      assert.notEqual(round1.review_body_cas_key, round2.review_body_cas_key);

      // R2: the OPERATIONAL path — the exact function `ctl review-body <dir> <evidence_id>` runs.
      // Not `h.cas.get`: nothing here reaches CAS except through the evidence row's own claim.
      const recovered2 = readReviewBody(h.dir, round2.review_evidence_id);
      assert.deepEqual(Buffer.from(recovered2), Buffer.from(ROUND_2_STDOUT, "utf8"), "round-2 review text is byte-identical");
      // R3: no truncation — the body is well past the 60 000-char PROMPT cap and arrives whole.
      assert.ok(recovered2.byteLength > 70_000, `recovered ${recovered2.byteLength} bytes`);
      assert.equal(Buffer.from(recovered2).toString("utf8").includes("tail-marker-that-a-60000-char-cap-would-have-eaten"), true);

      // Round 1 is recoverable too, and the two rounds do not alias.
      const recovered1 = readReviewBody(h.dir, round1.review_evidence_id);
      assert.deepEqual(Buffer.from(recovered1), Buffer.from(ROUND_1_STDOUT, "utf8"));
      assert.equal(Buffer.from(recovered1).toString("utf8").includes("cadp/product/activities.ts:583"), true);

      // Self-verifying: the claim's digest is the digest of exactly the bytes the key returned.
      for (const [round, bytes] of [[round1, recovered1], [round2, recovered2]] as const) {
        assert.equal(sha256Hex(bytes), reviewClaim(h, round.review_evidence_id)["body_digest"]);
      }

      // R6: the reviewer's BACKEND_EXECUTION sibling is sealed by the same activity, unchanged and
      // with no body pair of its own.
      const backend = h.store.evidenceById(round2.backend_evidence_id);
      assert.equal(backend?.evidence_kind, "BACKEND_EXECUTION");
      assert.equal((backend?.claim as Record<string, unknown>)["body_cas_key"], undefined);
    });
  } finally {
    api.close();
    broker.close();
    h.close();
  }
});

test("R4: a REVIEW claim without a verifiable {body_cas_key, body_digest} pair is refused before the seal", async () => {
  const h = await makeHarness();
  try {
    const rows = () => (h.store.db.prepare("SELECT COUNT(*) AS n FROM evidence_envelope").get() as { n: number }).n;
    const before = rows();
    const good = reviewBodyPair(h, "a real reviewer body");
    const submit = (claim: Record<string, unknown>) =>
      h.ingress.submitEvidence(
        {
          evidence_kind: "REVIEW",
          subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: SHA_ROUND_1 }],
          availability: "PRESENT",
          claim_schema: "cadp.review.v1",
          claim,
          producer_ref: "reviewer:claude-code",
          source_ref: "claude:read-only-profile",
          source_relation: "INDEPENDENT_OBSERVATION",
        } as never,
        PRINCIPALS.reviewer,
      );
    const refused = (claim: Record<string, unknown>, why: string) =>
      assert.throws(
        () => submit(claim),
        (error: unknown) => (error as { reason?: string }).reason === "REVIEW_CLAIM_INVALID",
        why,
      );

    refused({ verdict: "APPROVE", body_digest: good.body_digest }, "no body_cas_key at all");
    refused({ verdict: "APPROVE", body_cas_key: good.body_cas_key }, "no body_digest at all");
    refused({ verdict: "APPROVE", body_digest: good.body_digest, body_cas_key: "not-a-cas-key" }, "malformed key");
    refused(
      { verdict: "APPROVE", body_digest: good.body_digest, body_cas_key: `cas://sha256/${"9".repeat(64)}` },
      "key names bytes CAS does not hold",
    );
    refused(
      { verdict: "APPROVE", body_digest: sha256Hex("some other text"), body_cas_key: good.body_cas_key },
      "digest is not the digest of the stored bytes",
    );
    assert.equal(rows(), before, "every refused draft sealed nothing");

    // The verifiable pair seals, and its stored body is exactly what was put.
    const sealed = submit({ verdict: "APPROVE", ...good });
    assert.deepEqual(Buffer.from(readReviewBody(h.dir, sealed.evidence_id)), Buffer.from("a real reviewer body", "utf8"));
  } finally {
    h.close();
  }
});

test("R5: the operator path never returns unverified bytes, and refuses anything that is not a REVIEW row", async () => {
  // The guard-bite knob (TD §13.1) disables ONLY the ingress rule, so a REVIEW whose pair does not
  // verify can exist to be read back — which is how the retrieval path's own re-verification is
  // proved load-bearing rather than redundant with the submission check.
  const h = await makeHarness({ disabledIngressRules: new Set(["review_body_retained"]) });
  try {
    const real = reviewBodyPair(h, "the bytes actually stored");
    const lying = h.ingress.submitEvidence(
      {
        evidence_kind: "REVIEW",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: SHA_ROUND_1 }],
        availability: "PRESENT",
        claim_schema: "cadp.review.v1",
        claim: { verdict: "APPROVE", body_digest: sha256Hex("bytes that were never stored"), body_cas_key: real.body_cas_key },
        producer_ref: "reviewer:claude-code",
        source_ref: "claude:read-only-profile",
        source_relation: "INDEPENDENT_OBSERVATION",
      } as never,
      PRINCIPALS.reviewer,
    );
    assert.throws(
      () => readReviewBody(h.dir, lying.evidence_id),
      /do not match claim\.body_digest/u,
      "a pair that does not verify must throw, not print",
    );

    const noPair = h.ingress.submitEvidence(
      {
        evidence_kind: "REVIEW",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: SHA_ROUND_2 }],
        availability: "PRESENT",
        claim_schema: "cadp.review.v1",
        claim: { verdict: "APPROVE", body_digest: real.body_digest },
        producer_ref: "reviewer:claude-code",
        source_ref: "claude:read-only-profile",
        source_relation: "INDEPENDENT_OBSERVATION",
      } as never,
      PRINCIPALS.reviewer,
    );
    assert.throws(() => readReviewBody(h.dir, noPair.evidence_id), /carries no \{body_cas_key, body_digest\} pair/u);
    assert.throws(() => readReviewBody(h.dir, "cadp-v04:evidence:does-not-exist"), /no evidence row/u);

    // Not a blob surface: only a REVIEW row's own claim can name bytes to return.
    const verification = h.ingress.submitEvidence(
      {
        evidence_kind: "VERIFICATION",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: SHA_ROUND_1 }],
        availability: "PRESENT",
        claim_schema: "cadp.verification.harness.v1",
        claim: { head_sha: SHA_ROUND_1, conclusion: "success", runner: "node --test", completed_at: "2026-01-01T00:00:00.000Z" },
        produced_at: "2026-01-01T00:00:00.000Z",
        producer_ref: "verifier:harness",
        source_ref: "test",
        source_relation: "INDEPENDENT_OBSERVATION",
      } as never,
      PRINCIPALS.verifier,
    );
    assert.throws(() => readReviewBody(h.dir, verification.evidence_id), /is VERIFICATION, not REVIEW/u);
  } finally {
    h.close();
  }
});

test("R6: evidence kinds other than REVIEW keep their exact v0.4/v1 claim shapes", async () => {
  const h = await makeHarness();
  try {
    // One PRESENT claim per non-REVIEW kind the reference registry declares, each with NO body
    // pair: all seal, so nothing about the REVIEW rule leaked into the shared submission path.
    const workStep = h.ingress.submitEvidence(
      {
        evidence_kind: "WORK_STEP",
        subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: RUN_REF }],
        availability: "PRESENT",
        claim_schema: "cadp.work-step.v1",
        claim: { step_ordinal: 1, summary: "unchanged" },
        producer_ref: "workflow:cadp-work",
        source_ref: `temporal:${RUN_REF}`,
        source_relation: "SELF_REPORT",
      } as never,
      PRINCIPALS.workflow,
    );
    assert.equal((workStep.claim as Record<string, unknown>)["body_cas_key"], undefined);

    const backend = h.ingress.submitEvidence(
      {
        evidence_kind: "BACKEND_EXECUTION",
        subject_bindings: [
          { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: RUN_REF },
          { authority_ref: "cadp-store:k04", namespace: "surface-role", object_id: "REVIEWER" },
        ],
        availability: "PRESENT",
        claim_schema: "cadp.backend.v1",
        claim: { requested: { provider: "codex" }, observed: { model: { availability: "UNKNOWN" } } },
        producer_ref: "backend-scan:codex",
        source_ref: "codex session log scan",
        source_relation: "SELF_REPORT",
      } as never,
      PRINCIPALS.backendScan,
    );
    assert.equal(backend.evidence_kind, "BACKEND_EXECUTION");

    // An UNKNOWN REVIEW carries no claim at all (Spec K2) and is untouched by the rule.
    const unknownReview = h.ingress.submitEvidence(
      {
        evidence_kind: "REVIEW",
        subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: SHA_ROUND_2 }],
        availability: "UNKNOWN",
        claim_schema: "cadp.review.v1",
        unknown_reason: "reviewer surface never produced output",
        producer_ref: "reviewer:claude-code",
        source_ref: "claude:read-only-profile",
        source_relation: "INDEPENDENT_OBSERVATION",
      } as never,
      PRINCIPALS.reviewer,
    );
    assert.equal(unknownReview.availability, "UNKNOWN");
  } finally {
    h.close();
  }
});
