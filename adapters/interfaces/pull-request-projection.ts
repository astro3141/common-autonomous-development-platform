/**
 * PullRequestProjectionAdapterV1 — the #52 delivery-projection boundary.
 *
 * A pull request is a *projection* of an already bound, verified and audited ADP candidate —
 * never lifecycle authority (Spec/#52): opening one moves no Platform state, and PR/review/check
 * state is never read back as a lifecycle fact. The adapter's whole mutation reach is
 *
 *   push the exact candidate commit to one Platform-chosen head ref
 *   open one pull request from that ref
 *
 * and nothing else — no merge, close, label, comment, review or issue mutation.
 *
 * Reconciliation mirrors the D24 shape because the failure physics are the same (an external
 * create whose acknowledgement can be lost): `NO_EFFECT_CONFIRMED` is a target-authoritative
 * proof that no pull request exists for the head ref, `COMMITTED` returns the exact existing
 * projection, and everything unprovable is `UNKNOWN`.
 */

export interface PullRequestProjectionRequestV1 {
  readonly op_key: string;
  /** Platform-chosen deterministic head ref name (no refs/ prefix), e.g. `adp/candidate/...`. */
  readonly head_branch: string;
  /** The exact bound candidate SHA; the adapter must publish this commit and no other. */
  readonly candidate_commit: string;
  readonly base_branch: string;
  readonly title: string;
  readonly body: string;
}

export interface PullRequestReceiptV1 {
  /** Adapter-assigned PR identity (number as decimal string). */
  readonly pr_ref: string;
  readonly url: string;
  readonly head_branch: string;
  readonly candidate_commit: string;
}

export type PullRequestReconcileResult =
  | { readonly status: "NO_EFFECT_CONFIRMED" }
  | { readonly status: "COMMITTED"; readonly receipt: PullRequestReceiptV1 }
  | { readonly status: "UNKNOWN" };

/** A definitive no-effect failure: this projection cannot and did not happen. */
export class PullRequestProjectionFailedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "PullRequestProjectionFailedError";
  }
}

export interface PullRequestProjectionAdapterV1 {
  publish_candidate_pull_request(request: PullRequestProjectionRequestV1): {
    readonly status: "COMMITTED";
    readonly receipt: PullRequestReceiptV1;
  };
  reconcile_pull_request(
    head_branch: string,
    candidate_commit: string,
  ): PullRequestReconcileResult;
}
