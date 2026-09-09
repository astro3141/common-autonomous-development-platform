/**
 * Publication checks shared by the `POLICY_ACTIVATE` recheck #17 and the root listener's
 * `BREAK_GLASS(ACTIVATE_POLICY)` path (TD §4.4 #17, §5.2, §9.4 step 3): raw re-digest,
 * payload/manifest identity, kernel-config validation, and policy_ref conflict detection.
 */

import { Cas } from "./cas.ts";
import { sha256Hex } from "./canonical.ts";
import type { Digest } from "./canonical.ts";
import {
  allocationContractEntriesOf, dataJsonOf, manifestOf, manifestRevisionString, parseManifestRevision, payloadDigestOf,
  RUN_ORIGIN_ALLOCATION_SCHEMA, validateKernelConfig,
} from "./policyBundle.ts";
import type { SealedAllocationContract } from "./policyBundle.ts";
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
 * AP B2(2)(ii) as extended for `cadp.allocation-key.run-origin.v1`: the run-origin allocation
 * contract as the SEALED STORE carries it — the entries of the EARLIEST activation that carried
 * that schema id at all, scanned in activation order.
 *
 * The comparison is against the sealed store and never against the currently active bundle, which
 * is what stops a contract being laundered by withdrawing it in one activation and re-adding a
 * different one in the next: an earlier activation still carries the original, and every
 * activation between them had to equal it, so the earliest is the fixed point.
 */
export function sealedRunOriginContract(store: ConstitutionalStore, cas: Cas): SealedAllocationContract | undefined {
  const active = store.activeActivation();
  if (active === undefined) return undefined;
  for (let seq = 1; seq <= active.seq; seq += 1) {
    const activation = store.activationBySeq(seq);
    if (activation === undefined) continue; // no row for a seq that was never activated
    const refRow = store.policyRef(activation.policy_id, activation.revision);
    if (refRow === undefined) continue;
    // A read failure here is store corruption, not a policy question: it propagates rather than
    // being swallowed into a silent "no prior contract", which would be fail-OPEN on immutability.
    const data = dataJsonOf(cas.get(refRow.bundle_cas_key)) as { cadp?: unknown } | undefined;
    const contract = allocationContractEntriesOf(data?.cadp, RUN_ORIGIN_ALLOCATION_SCHEMA);
    if (contract.descriptor !== undefined || contract.allocation_schema !== undefined) return contract;
  }
  return undefined;
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
    // The sealed run-origin contract is resolved here, at the one seam every activation decision
    // passes through (recheck #17 and the root listener's `BREAK_GLASS(ACTIVATE_POLICY)` alike),
    // so B2(2)(ii)'s cross-activation comparison cannot be reached around by either path.
    validateKernelConfig(data?.cadp, sealedRunOriginContract(store, cas));
  } catch (error) {
    throw new PublicationRefusal("KERNEL_CONFIG_INVALID", error instanceof Error ? error.message : String(error));
  }
  const existing = store.policyRef(proposed.policy_id, proposed.revision);
  if (existing !== undefined && existing.content_digest !== proposed.content_digest.value) {
    throw new PublicationRefusal("POLICY_REF_CONFLICT", `(policy_id, revision) already published with a different digest`);
  }
  return { bundleBytes, payload_digest: payload.value, manifest_revision: manifest.revision };
}
