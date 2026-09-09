/**
 * Publication checks shared by the `POLICY_ACTIVATE` recheck #17 and the root listener's
 * `BREAK_GLASS(ACTIVATE_POLICY)` path (TD §4.4 #17, §5.2, §9.4 step 3): raw re-digest,
 * payload/manifest identity, kernel-config validation, and policy_ref conflict detection.
 */

import { Cas } from "./cas.ts";
import { sha256Hex } from "./canonical.ts";
import type { Digest } from "./canonical.ts";
import { dataJsonOf, manifestOf, manifestRevisionString, parseManifestRevision, payloadDigestOf, validateKernelConfig } from "./policyBundle.ts";
import type { ActivatedAllocationContracts } from "./policyBundle.ts";
import { ConstitutionalStore } from "./store.ts";

export interface ProposedPolicyRef {
  readonly policy_id: string;
  readonly revision: number;
  readonly content_digest: Digest;
}

export class PublicationRefusal extends Error {
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.reason = reason;
  }
}

export interface VerifiedBundle {
  readonly bundleBytes: Uint8Array;
  readonly payload_digest: string;
  readonly manifest_revision: string;
}

/**
 * AP B2(2)(ii): the allocation-contract entries EVERY prior activation in the sealed store carried,
 * read from each activation's own sealed bundle bytes rather than from the currently active one —
 * which is what makes the immutability comparison unlaunderable by withdraw-then-re-add.
 *
 * The FIRST activation to carry a given schema id wins the comparison. That is not an arbitrary
 * choice of representative: the rule is enforced at every activation, so every later sealed copy
 * of an id is already byte-identical to the first, and pinning the earliest keeps the comparison
 * stable under any future relaxation of a later one.
 *
 * A prior bundle that cannot be read or parsed is deliberately NOT swallowed: the caller wraps
 * this in the refusal path, so an unreadable history refuses the activation instead of silently
 * validating against an empty history (fail-closed).
 *
 * Reading EVERY activation, not only the ones whose config schema still carries these registries,
 * is what makes the comparison survive an intervening activation that carries none of them: a
 * sealed run-origin contract stays sealed history, so no sequence of activations can reach a
 * SECOND contract for that id (AP B1(5); control A5 leg o-v).
 */
export function activatedAllocationContracts(store: ConstitutionalStore, cas: Cas): ActivatedAllocationContracts {
  const descriptors = new Map<string, unknown>();
  const allocation_schemas = new Map<string, unknown>();
  const latest = store.activeActivation();
  for (let seq = 1; latest !== undefined && seq <= latest.seq; seq += 1) {
    const activation = store.activationBySeq(seq);
    if (activation === undefined) continue; // a gap is impossible under the CHECK, and is not this rule's to report
    const refRow = store.policyRef(activation.policy_id, activation.revision);
    if (refRow === undefined) continue;
    const cadp = (dataJsonOf(cas.get(refRow.bundle_cas_key)) as { cadp?: Record<string, unknown> } | undefined)?.cadp;
    for (const [key, into] of [["allocation_schema_descriptors", descriptors], ["allocation_schemas", allocation_schemas]] as const) {
      const entries = cadp?.[key];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries as Array<Record<string, unknown>>) {
        const schema = entry?.["schema"];
        if (typeof schema !== "string" || into.has(schema)) continue;
        into.set(schema, entry);
      }
    }
  }
  return { descriptors, allocation_schemas };
}

/** All #17 bundle checks except the activation-base check (#13, caller-owned). */
export function verifyProposedBundle(cas: Cas, store: ConstitutionalStore, proposed: ProposedPolicyRef, bundle_cas_ref: string): VerifiedBundle {
  let bundleBytes: Uint8Array;
  try {
    bundleBytes = cas.get(bundle_cas_ref);
  } catch {
    throw new PublicationRefusal("MATERIAL_INCOMPLETE", `bundle_cas_ref ${bundle_cas_ref} missing or corrupt`);
  }
  if (sha256Hex(bundleBytes) !== proposed.content_digest.value) {
    throw new PublicationRefusal("BUNDLE_DIGEST_MISMATCH", "CAS bytes do not re-digest to proposed content_digest");
  }
  const payload = payloadDigestOf(bundleBytes);
  const manifest = manifestOf(bundleBytes);
  if (manifest?.revision === undefined) throw new PublicationRefusal("MANIFEST_INVALID", "bundle has no .manifest.revision");
  const parsed = parseManifestRevision(manifest.revision);
  if (
    parsed === undefined ||
    parsed.policy_id !== proposed.policy_id ||
    parsed.revision !== proposed.revision ||
    parsed.payloadHex !== payload.value
  ) {
    throw new PublicationRefusal("MANIFEST_REVISION_MISMATCH", `manifest ${manifest.revision} != ${manifestRevisionString(proposed.policy_id, proposed.revision, payload.value)}`);
  }
  const data = dataJsonOf(bundleBytes) as { cadp?: unknown } | undefined;
  try {
    // The sealed store's already-activated allocation contract is assembled INSIDE this try, so an
    // unreadable activation history refuses the activation (`KERNEL_CONFIG_INVALID`) rather than
    // escaping the refusal path as an internal error (AP B2(2)(ii)).
    validateKernelConfig(data?.cadp, activatedAllocationContracts(store, cas));
  } catch (error) {
    throw new PublicationRefusal("KERNEL_CONFIG_INVALID", error instanceof Error ? error.message : String(error));
  }
  const existing = store.policyRef(proposed.policy_id, proposed.revision);
  if (existing !== undefined && existing.content_digest !== proposed.content_digest.value) {
    throw new PublicationRefusal("POLICY_REF_CONFLICT", `(policy_id, revision) already published with a different digest`);
  }
  return { bundleBytes, payload_digest: payload.value, manifest_revision: manifest.revision };
}
