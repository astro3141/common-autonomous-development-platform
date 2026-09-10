/**
 * Team-lead repair-lane read path (#259 P0b): recover the FULL text of one `REVIEW` evidence row.
 *
 * A stopped run's trace names the review evidence of each round (`round_<n>_review_evidence_id`).
 * After the STOP the team lead needs the reviewer's findings VERBATIM, not the workflow's parsed
 * one-line reason — this is the whole operational path to them, and it is deliberately the
 * thinnest one that exists:
 *
 *   - READ-ONLY and OFFLINE. Like `ctl attest-schedule`, it opens the store file directly for
 *     operator work and constructs a `Cas` over it. It writes nothing, seals nothing, evaluates
 *     nothing, and holds no kernel token.
 *   - NOT a generic blob surface. No new kernel API, no widened authority: the input is an
 *     EVIDENCE ID, the kind must be `REVIEW`, and the only bytes reachable are the ones that
 *     row's own claim names. A caller cannot ask for an arbitrary CAS key through it.
 *   - FAIL-CLOSED. The envelope must recompute to its own `envelope_digest` (§2.5 verify-on-read,
 *     the same refusal `get_evidence` makes), `Cas.get` re-digests the bytes against their key
 *     (§2.3), and the claim's own `body_digest` is re-verified against those exact bytes. Any
 *     mismatch throws; unverified bytes are never returned and therefore never printed.
 */

import { join } from "node:path";

import { Cas } from "../kernel/cas.ts";
import { digestsEqual, recordDigest, sha256Hex } from "../kernel/canonical.ts";
import { ConstitutionalStore } from "../kernel/store.ts";

export class ReviewBodyUnavailable extends Error {}

/**
 * The exact reviewer stdout bytes behind `evidence_id`, or a throw. `dir` is a live-composition
 * directory (the store file is its `k04.sqlite`, the same path every other read-only operator
 * command in `ctl.ts` opens).
 */
export function readReviewBody(dir: string, evidence_id: string): Uint8Array {
  const store = new ConstitutionalStore(join(dir, "k04.sqlite"));
  try {
    const envelope = store.evidenceById(evidence_id);
    if (envelope === undefined) throw new ReviewBodyUnavailable(`no evidence row ${evidence_id}`);
    if (envelope.evidence_kind !== "REVIEW") {
      throw new ReviewBodyUnavailable(`${evidence_id} is ${envelope.evidence_kind}, not REVIEW`);
    }
    const recomputed = recordDigest(envelope as unknown as Record<string, unknown>, "envelope_digest");
    if (!digestsEqual(recomputed, envelope.envelope_digest)) {
      throw new ReviewBodyUnavailable(`stored envelope ${evidence_id} does not recompute its own digest`);
    }
    const claim = envelope.claim as { body_digest?: unknown; body_cas_key?: unknown } | undefined;
    const body_digest = claim?.body_digest;
    const body_cas_key = claim?.body_cas_key;
    if (typeof body_cas_key !== "string" || typeof body_digest !== "string") {
      throw new ReviewBodyUnavailable(`${evidence_id} carries no {body_cas_key, body_digest} pair`);
    }
    const bytes = new Cas(store).get(body_cas_key);
    if (sha256Hex(bytes) !== body_digest) {
      throw new ReviewBodyUnavailable(`${evidence_id}: bytes at ${body_cas_key} do not match claim.body_digest`);
    }
    return bytes;
  } finally {
    store.close();
  }
}
