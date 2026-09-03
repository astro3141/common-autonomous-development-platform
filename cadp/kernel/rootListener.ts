/**
 * Root listener (TD §9.4 r7): accepts `cadp.break-glass.v1` signed documents only.
 * Execution authorization is checked against the CURRENTLY ACTIVE policy's root_public_keys
 * (a backdated created_at cannot revive a revoked key — C40); the document's signed
 * `authorization_policy_ref` must equal the exact active activation row (C42); all effects of
 * the operation land in ONE store transaction or none, leaving a BREAK_GLASS_REJECTED incident
 * on failure (C39). This is a root operation, not a governed effect: no K3/K5/K6/K7.
 */

import { Cas } from "./cas.ts";
import { jcsDigest, nowIso, recordDigest, sha256Hex } from "./canonical.ts";
import type { Digest } from "./canonical.ts";
import { newId } from "./ids.ts";
import { Ingress } from "./ingress.ts";
import { PublicationRefusal, verifyProposedBundle } from "./policyPublication.ts";
import { resolveActivePolicy } from "./policyState.ts";
import { validateEvidenceEnvelope } from "./records.ts";
import type { EvidenceEnvelopeV1 } from "./records.ts";
import { verifySignature } from "./sig.ts";
import type { Sig1 } from "./sig.ts";
import { ConstitutionalStore } from "./store.ts";
import { dataJsonOf, validateKernelConfig } from "./policyBundle.ts";
import { bootstrapSetDigest } from "./genesis.ts";

export interface BreakGlassDocument {
  readonly principal: string;
  readonly reason: string;
  readonly scope: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly authorization_policy_ref: {
    readonly policy_id: string;
    readonly revision: number;
    readonly content_digest: Digest;
    readonly seq: number;
  };
  readonly actions: ReadonlyArray<"ACTIVATE_POLICY" | "RELEASE_INCIDENTS">;
  readonly proposed_policy_ref?: { policy_id: string; revision: number; content_digest: Digest };
  readonly bundle_cas_ref?: string;
  readonly release_incident_refs?: ReadonlyArray<{ evidence_id: string; envelope_digest: Digest }>;
}

export class RootRejection extends Error {
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.reason = reason;
  }
}

export function executeRootOperation(
  store: ConstitutionalStore,
  cas: Cas,
  ingress: Ingress,
  document: BreakGlassDocument,
  signature: Sig1,
  clock: () => number = Date.now,
): { evidence_id: string; activated_seq?: number } {
  const reject = (reason: string, detail: string): never => {
    ingress.sealIncident("BREAK_GLASS_REJECTED", `${reason}: ${detail} (document digest ${jcsDigest(document).value})`, [
      { authority_ref: "cadp-store:k04", namespace: "root-operation", object_id: jcsDigest(document).value },
    ]);
    throw new RootRejection(reason, detail);
  };

  const now = clock();
  const active = resolveActivePolicy(store, cas);

  // Step 1 — execution authorization (cadp-sig-1): key in the CURRENTLY ACTIVE root set.
  const key = active.config.root_public_keys.find((k) => k.key_id === signature.key_id);
  if (key === undefined) return reject("EXECUTION_AUTHORIZATION_FAILED", "key_id not in the active policy's root_public_keys");
  if (!verifySignature("BREAK_GLASS", document, signature, key.public_key)) {
    return reject("EXECUTION_AUTHORIZATION_FAILED", "signature does not verify");
  }
  const createdMs = Date.parse(document.created_at);
  const expiresMs = Date.parse(document.expires_at);
  if (Number.isNaN(createdMs) || Number.isNaN(expiresMs)) return reject("EXECUTION_AUTHORIZATION_FAILED", "invalid document times");
  if (Date.parse(key.valid_from) > createdMs || createdMs > now) {
    return reject("EXECUTION_AUTHORIZATION_FAILED", "valid_from ≤ created_at ≤ now violated");
  }
  if (key.valid_to !== undefined && now > Date.parse(key.valid_to)) {
    // Evaluated against now, never created_at (C40).
    return reject("EXECUTION_AUTHORIZATION_FAILED", "key expired at execution time");
  }
  if (!(createdMs <= now && now < expiresMs)) return reject("EXECUTION_AUTHORIZATION_FAILED", "created_at ≤ now < expires_at violated");
  if (expiresMs - createdMs > active.config.break_glass_max_lifetime_s * 1000) {
    return reject("EXECUTION_AUTHORIZATION_FAILED", "lifetime exceeds break_glass_max_lifetime_s");
  }
  if (!Array.isArray(document.actions) || document.actions.length === 0) return reject("DOCUMENT_INVALID", "actions must be non-empty");

  // Step 2 — authorization base must be the exact currently active row, whatever the actions.
  const auth = document.authorization_policy_ref;
  if (
    auth === undefined ||
    auth.policy_id !== active.activation.policy_id ||
    auth.revision !== active.activation.revision ||
    auth.content_digest?.value !== active.activation.content_digest ||
    auth.seq !== active.activation.seq
  ) {
    return reject("AUTHORIZATION_BASE_STALE", "authorization_policy_ref does not equal the currently active policy_activation row");
  }

  // Step 3 — ACTIVATE_POLICY: exactly the ordinary publication checks (#17).
  let verified: { payload_digest: string; manifest_revision: string } | undefined;
  if (document.actions.includes("ACTIVATE_POLICY")) {
    if (document.proposed_policy_ref === undefined || document.bundle_cas_ref === undefined) {
      return reject("DOCUMENT_INVALID", "ACTIVATE_POLICY requires proposed_policy_ref and bundle_cas_ref");
    }
    try {
      verified = verifyProposedBundle(cas, store, document.proposed_policy_ref, document.bundle_cas_ref);
    } catch (error) {
      return reject(
        error instanceof PublicationRefusal ? error.reason : "PUBLICATION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // Step 4 — RELEASE_INCIDENTS: every ref must resolve to an open incident with matching digest.
  if (document.actions.includes("RELEASE_INCIDENTS")) {
    const open = new Map(store.openIncidents().map((i) => [i.evidence_id, i]));
    for (const ref of document.release_incident_refs ?? []) {
      const incident = open.get(ref.evidence_id);
      if (incident === undefined) return reject("RELEASE_TARGET_INVALID", `${ref.evidence_id} is not an open KERNEL_INCIDENT`);
      if (incident.envelope_digest.value !== ref.envelope_digest.value) {
        return reject("RELEASE_TARGET_INVALID", `envelope_digest mismatch for ${ref.evidence_id}`);
      }
    }
    if ((document.release_incident_refs ?? []).length === 0) return reject("DOCUMENT_INVALID", "RELEASE_INCIDENTS with no refs");
  }

  // Step 5 — one store transaction under the policy_activation serialization domain.
  const evidence_id = newId("evidence", clock);
  const claim = { ...document, signature };
  const base: Record<string, unknown> = {
    evidence_id,
    evidence_kind: "BREAK_GLASS",
    subject_bindings: [
      { authority_ref: "cadp-store:k04", namespace: "root-operation", object_id: jcsDigest(document).value },
      ...(document.release_incident_refs ?? []).map((r) => ({
        authority_ref: "cadp-store:k04", namespace: "evidence", object_id: r.evidence_id,
      })),
    ],
    availability: "PRESENT",
    claim_schema: "cadp.break-glass.v1",
    claim,
    claim_digest: jcsDigest(claim),
    producer_ref: signature.key_id,
    source_ref: "root-listener",
    produced_at: document.created_at,
    provenance: { source_relation: "INDEPENDENT_OBSERVATION", integrity: "SIGNED_ATTESTATION", attestation_ref: signature.key_id },
  };
  const envelope = { ...base, envelope_digest: recordDigest(base, "envelope_digest") } as unknown as EvidenceEnvelopeV1;
  validateEvidenceEnvelope(envelope);

  try {
    return store.withImmediate(() => {
      const current = store.activeActivation();
      if (current === undefined || current.seq !== auth.seq) {
        throw new RootRejection("AUTHORIZATION_BASE_STALE", "active row changed before commit");
      }
      store.insertEvidence(envelope, nowIso(clock));
      let activated_seq: number | undefined;
      if (document.actions.includes("ACTIVATE_POLICY")) {
        const proposed = document.proposed_policy_ref!;
        const existing = store.policyRef(proposed.policy_id, proposed.revision);
        if (existing === undefined) {
          store.insertPolicyRef({
            policy_id: proposed.policy_id,
            revision: proposed.revision,
            content_digest: proposed.content_digest.value,
            issuer_ref: signature.key_id,
            bundle_cas_key: document.bundle_cas_ref!,
            payload_digest: verified!.payload_digest,
            manifest_revision: verified!.manifest_revision,
          });
        } else if (existing.content_digest !== proposed.content_digest.value) {
          throw new RootRejection("POLICY_REF_CONFLICT", "existing row has a different digest");
        }
        activated_seq = auth.seq + 1;
        store.insertActivation({
          seq: activated_seq,
          expected_prev_seq: auth.seq,
          policy_id: proposed.policy_id,
          revision: proposed.revision,
          content_digest: proposed.content_digest.value,
          activated_by_ref: signature.key_id,
          activation_evidence_id: evidence_id,
          activated_at: nowIso(clock),
        });
      }
      return { evidence_id, activated_seq };
    });
  } catch (error) {
    if (error instanceof RootRejection) return reject(error.reason, error.message);
    return reject("ROOT_TRANSACTION_FAILED", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Historical verification (TD §9.4 r6/r7, C42): the authorizing key set is resolved from the
 * signed document itself — never from operational context, `received_at`, or ambient history.
 */
export function verifyRootEnvelopeHistorical(
  store: ConstitutionalStore,
  cas: Cas,
  envelope: EvidenceEnvelopeV1,
  bootstrapRootKeysBase64: readonly string[] = [],
): { valid: boolean; reason?: string } {
  const claim = envelope.claim as (BreakGlassDocument & { signature: Sig1; bootstrap_set_digest?: string }) | undefined;
  if (claim?.signature === undefined) return { valid: false, reason: "no signature in claim" };
  const { signature, ...document } = claim;

  if (envelope.evidence_kind === "GENESIS") {
    // GENESIS resolves against the bootstrap set whose digest the envelope claim records.
    if (claim.bootstrap_set_digest !== bootstrapSetDigest(bootstrapRootKeysBase64)) {
      return { valid: false, reason: "bootstrap_set_digest mismatch" };
    }
    const ok = bootstrapRootKeysBase64.some((pk) => verifySignature("GENESIS", document, signature, pk));
    return ok ? { valid: true } : { valid: false, reason: "signature does not verify against the bootstrap set" };
  }

  // BREAK_GLASS: resolve root_public_keys from the exact policy content the signed
  // authorization_policy_ref names (immutable rows — deterministic after any rotation).
  const auth = (document as BreakGlassDocument).authorization_policy_ref;
  const activation = store.activationBySeq(auth.seq);
  if (activation === undefined || activation.policy_id !== auth.policy_id || activation.revision !== auth.revision || activation.content_digest !== auth.content_digest.value) {
    return { valid: false, reason: "authorization_policy_ref does not resolve to an immutable activation row" };
  }
  const refRow = store.policyRef(auth.policy_id, auth.revision);
  if (refRow === undefined || refRow.content_digest !== auth.content_digest.value) {
    return { valid: false, reason: "policy_ref row mismatch" };
  }
  const bundleBytes = cas.get(refRow.bundle_cas_key);
  if (sha256Hex(bundleBytes) !== auth.content_digest.value) return { valid: false, reason: "bundle bytes corrupt" };
  const config = validateKernelConfig((dataJsonOf(bundleBytes) as { cadp?: unknown })?.cadp);
  const key = config.root_public_keys.find((k) => k.key_id === signature.key_id);
  if (key === undefined) return { valid: false, reason: "signing key not in the named policy's root_public_keys" };
  // Document-time validity against that exact set (historical rule).
  const createdMs = Date.parse((document as BreakGlassDocument).created_at);
  if (Date.parse(key.valid_from) > createdMs) return { valid: false, reason: "key not yet valid at document time" };
  if (key.valid_to !== undefined && createdMs > Date.parse(key.valid_to)) return { valid: false, reason: "key expired at document time" };
  const ok = verifySignature("BREAK_GLASS", document, signature, key.public_key);
  return ok ? { valid: true } : { valid: false, reason: "signature does not verify" };
}
