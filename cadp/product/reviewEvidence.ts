/**
 * REVIEW (`cadp.review.v1`) evidence production — the claim contract and the one submission path
 * that builds it (#259 P0b).
 *
 * The defect this module closes: the claim used to carry `{verdict, body_digest, reviewer_run_id}`
 * and nothing else, while the reviewer's stdout — the FULL Primary-Reviewer text — was dropped
 * after the workflow parsed one verdict line and one reason line out of it. The digest was
 * therefore unverifiable against anything retained, and the post-STOP team-lead repair lane could
 * not quote a single finding byte-for-byte. Now the exact bytes go into the kernel CAS and the
 * claim names them, so `{body_digest, body_cas_key}` is a SELF-VERIFYING pair: fetch the bytes at
 * the key, sha256 them, compare to the digest.
 *
 * Structured like ./backendExecution.ts: the submission takes an injected client, so the seam is
 * exercisable against a real kernel without the Temporal activity host.
 */

import { createHash } from "node:crypto";

import type { KernelClient } from "../clients/kernelClient.ts";
import type { EvidenceEnvelopeV1 } from "../kernel/records.ts";

export const REVIEW_CLAIM_SCHEMA = "cadp.review.v1";

/** The kernel CAS key shape (TD §2.3; `casKeyOf` in cadp/kernel/cas.ts): `cas://sha256/<hex>`. */
const CAS_KEY = /^cas:\/\/sha256\/([0-9a-f]{64})$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** The closed key set of a `cadp.review.v1` claim. Extending the contract means editing it here. */
const REVIEW_CLAIM_KEYS = ["verdict", "body_digest", "body_cas_key", "reviewer_run_id"] as const;

export interface ReviewClaimV1 {
  readonly verdict: string;
  /** sha256 (hex) over exactly the bytes stored at `body_cas_key`. */
  readonly body_digest: string;
  /** Kernel CAS key of the reviewer's FULL stdout bytes. */
  readonly body_cas_key: string;
  readonly reviewer_run_id: string;
}

export class ReviewClaimInvalid extends Error {
  readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super(`cadp.review.v1 claim invalid: ${errors.join("; ")}`);
    this.errors = errors;
  }
}

/** The REVIEW producer_ref of a review provider — the kernel stamps it from the authenticated principal. */
export function reviewProducerRef(provider: string): string {
  return provider === "claude" ? "reviewer:claude-code" : `reviewer:${provider}`;
}

/**
 * The reviewer's body as the EXACT bytes to store, with the digest taken over those same bytes —
 * one function, so the pair can never be computed over two different byte strings.
 *
 * NO TRUNCATION, and none is wanted: the 60 000-char cap belongs to the reviewer PROMPT (a context
 * hint bounding the diff embedded in it — see `brokerReview` in ./surfaceBroker.ts), never to
 * retained evidence. A review whose findings run past any cap is exactly the review a repair lane
 * needs whole. Secret hygiene holds by construction: these bytes are the reviewer surface's OWN
 * text, produced inside its isolated container from an already NUL-sanitized prompt that carries no
 * kernel secret, and they are stored as-is rather than re-rendered with anything from this host.
 */
export function reviewBody(stdout: string): { bytes: Uint8Array; body_digest: string } {
  const bytes = Buffer.from(stdout, "utf8");
  return { bytes, body_digest: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * Validate a `cadp.review.v1` claim before submission — the product-side claim contract, exactly
 * where the improvement vertical keeps its own (`./improvement/contracts.ts`, control 3/4).
 *
 * It deliberately does NOT move into the kernel: the Ingress treats `claim` as opaque content under
 * `claim_schema` and refuses to hold schema knowledge (the COVERED FIELDS note in
 * cadp/kernel/ingress.ts states why), and an `adapter_registry` entry has a closed key set
 * describing a producer's evidence kinds and provenance — it constrains no claim key. The producing
 * adapter is therefore the lane that enforces this contract, which is also why evidence of every
 * other kind, and every other kind's claim, is untouched by P0b.
 *
 * `verdict` is only required to be a non-empty string: which verdict vocabulary is meaningful is
 * the reviewer's output contract (./reviewProviders.ts) and the policy's business, not this pair's.
 */
export function validateReviewClaim(claim: unknown): { ok: true } | { ok: false; errors: string[] } {
  if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
    return { ok: false, errors: ["claim must be an object"] };
  }
  const errors: string[] = [];
  const c = claim as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!(REVIEW_CLAIM_KEYS as readonly string[]).includes(key)) errors.push(`unknown claim key ${key}`);
  }
  if (typeof c["verdict"] !== "string" || c["verdict"].length === 0) errors.push("verdict must be a non-empty string");
  if (typeof c["reviewer_run_id"] !== "string" || c["reviewer_run_id"].length === 0) {
    errors.push("reviewer_run_id must be a non-empty string");
  }
  const digest = c["body_digest"];
  if (typeof digest !== "string" || !SHA256_HEX.test(digest)) errors.push("body_digest must be a sha256 hex digest");
  const key = c["body_cas_key"];
  if (typeof key !== "string" || key.length === 0) {
    // The P0b defect itself: a digest with no retained bytes behind it verifies against nothing.
    errors.push("body_cas_key must name the kernel CAS object holding the reviewer's full stdout");
  } else {
    const match = CAS_KEY.exec(key);
    if (match === null) errors.push(`body_cas_key is not a kernel CAS key: ${key}`);
    else if (typeof digest === "string" && match[1] !== digest) {
      // Self-verifying or nothing: the key must address the bytes the digest was taken over.
      errors.push("body_cas_key does not address the bytes body_digest was computed over");
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Build a validated `cadp.review.v1` claim; throws rather than submitting an unverifiable pair. */
export function buildReviewClaim(input: ReviewClaimV1): ReviewClaimV1 {
  const claim: ReviewClaimV1 = {
    verdict: input.verdict,
    body_digest: input.body_digest,
    body_cas_key: input.body_cas_key,
    reviewer_run_id: input.reviewer_run_id,
  };
  const v = validateReviewClaim(claim);
  if (!v.ok) throw new ReviewClaimInvalid(v.errors);
  return claim;
}

/**
 * Put the reviewer's full stdout in the kernel CAS and seal the REVIEW envelope naming those exact
 * bytes. The blob is written with the REVIEWER'S OWN client, the same authenticated principal that
 * produces the envelope (its reach includes `put_blob`) — the review body is never laundered
 * through the workflow's credential.
 *
 * Order matters: the bytes are durable BEFORE the claim that names them is sealed, so no sealed
 * claim can point at an object that was never stored.
 *
 * The only size bound on the way in is the ACTIVE policy's own `cas_upload_max_bytes` (268435456 in
 * the reference config — the bound the implement bundle already rides under, which no review body
 * approaches). Exceeding it is a kernel REFUSAL that fails this activity, never a silent trim: this
 * path has no cap of its own to cut the text with.
 */
export async function submitReviewEvidence(input: {
  client: Pick<KernelClient, "putBlob" | "submitEvidence">;
  review_provider: string;
  candidate_sha: string;
  /** The reviewer surface's raw stdout, stored whole. */
  stdout: string;
  verdict: string;
  reviewer_run_id: string;
}): Promise<{ envelope: EvidenceEnvelopeV1; body_cas_key: string; body_digest: string }> {
  const { bytes, body_digest } = reviewBody(input.stdout);
  const { cas_key: body_cas_key } = await input.client.putBlob(bytes);
  const envelope = await input.client.submitEvidence({
    evidence_kind: "REVIEW",
    subject_bindings: [
      { authority_ref: "github.com", namespace: "commit", object_id: input.candidate_sha, revision_or_version: input.candidate_sha },
    ],
    availability: "PRESENT",
    claim_schema: REVIEW_CLAIM_SCHEMA,
    claim: buildReviewClaim({ verdict: input.verdict, body_digest, body_cas_key, reviewer_run_id: input.reviewer_run_id }),
    producer_ref: reviewProducerRef(input.review_provider),
    source_ref: `${input.review_provider}:read-only-profile`,
    source_relation: "INDEPENDENT_OBSERVATION",
  });
  return { envelope, body_cas_key, body_digest };
}
