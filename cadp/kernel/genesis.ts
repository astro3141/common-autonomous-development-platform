/**
 * Genesis (TD §9.4): out-of-band root procedure — the only publication path other than a
 * `POLICY_ACTIVATE` dispatch or a root-signed `BREAK_GLASS(ACTIVATE_POLICY)`. Runs under the
 * fixed bootstrap trust set `cadp-bootstrap-1`; no agent/model participates.
 */

import { Cas } from "./cas.ts";
import { BOOTSTRAP_SCHEMES, jcsDigest, nowIso, recordDigest, sha256Hex } from "./canonical.ts";
import { newId } from "./ids.ts";
import { manifestOf, parseManifestRevision, payloadDigestOf, dataJsonOf, validateKernelConfig } from "./policyBundle.ts";
import { schemaSetDigest, validateEvidenceEnvelope } from "./records.ts";
import type { EvidenceEnvelopeV1 } from "./records.ts";
import { signDocument, verifySignature } from "./sig.ts";
import type { Sig1 } from "./sig.ts";
import { ConstitutionalStore } from "./store.ts";

export interface GenesisInput {
  readonly bundleBytes: Uint8Array;
  readonly policy_id: string;
  readonly rootPrivatePem: string;
  /** Read once from `secret/cadp-v04/root/pubkeys` at genesis (TD §2.1). */
  readonly rootPublicKeysBase64: readonly string[];
  readonly pep_identity: string;
  readonly secret_path: string;
  readonly clock?: () => number;
}

export function bootstrapSetDigest(rootPublicKeysBase64: readonly string[]): string {
  return jcsDigest({
    algorithms: ["sha256"],
    canonicalizations: BOOTSTRAP_SCHEMES.map((s) => s.canonicalization),
    schema_digests: schemaSetDigest().value,
    root_public_keys: [...rootPublicKeysBase64],
  }).value;
}

export function runGenesis(store: ConstitutionalStore, cas: Cas, input: GenesisInput): { activation_seq: number; genesis_evidence_id: string } {
  const clock = input.clock ?? Date.now;
  if (store.activeActivation() !== undefined) throw new Error("genesis refused: policy_activation already has rows");

  // Validate the genesis bundle under the bootstrap set (identical checks to publication).
  const content_digest = sha256Hex(input.bundleBytes);
  const payload = payloadDigestOf(input.bundleBytes);
  const manifest = manifestOf(input.bundleBytes);
  const parsed = manifest?.revision === undefined ? undefined : parseManifestRevision(manifest.revision);
  if (parsed === undefined || parsed.policy_id !== input.policy_id || parsed.revision !== 1 || parsed.payloadHex !== payload.value) {
    throw new Error("genesis bundle manifest.revision does not match its payload identity");
  }
  const config = validateKernelConfig((dataJsonOf(input.bundleBytes) as { cadp?: unknown } | undefined)?.cadp);
  if (config.root_public_keys.length === 0) throw new Error("genesis bundle must carry root_public_keys");

  const bundle_cas_key = cas.put(input.bundleBytes);
  const bootstrap_digest = bootstrapSetDigest(input.rootPublicKeysBase64);

  const policy_ref = {
    policy_id: input.policy_id,
    revision: 1,
    content_digest: { algorithm: "sha256" as const, canonicalization: "raw-bytes-1" as const, value: content_digest },
  };

  // Root-signed genesis document.
  const document = {
    policy_ref,
    issuer_ref: "",
    pep_identity: input.pep_identity,
    secret_path: input.secret_path,
    bootstrap_set_digest: bootstrap_digest,
    created_at: nowIso(clock),
  };
  const signature: Sig1 = signDocument("GENESIS", { ...document, issuer_ref: undefined }, input.rootPrivatePem);
  const signedDocument = { ...document, issuer_ref: signature.key_id };
  const finalSignature = signDocument("GENESIS", signedDocument, input.rootPrivatePem);

  // The Ingress validates with the bootstrap set and the root public keys.
  if (!input.rootPublicKeysBase64.some((pk) => verifySignature("GENESIS", signedDocument, finalSignature, pk))) {
    throw new Error("genesis document signature does not verify against secret/cadp-v04/root/pubkeys");
  }
  cas.put(Buffer.from(JSON.stringify(signedDocument), "utf8"));

  const evidence_id = newId("evidence", clock);
  const base: Record<string, unknown> = {
    evidence_id,
    evidence_kind: "GENESIS",
    subject_bindings: [
      { authority_ref: "cadp-store:k04", namespace: "policy", object_id: `${input.policy_id}@1` },
    ],
    availability: "PRESENT",
    claim_schema: "cadp.genesis.v1",
    claim: { ...signedDocument, signature: finalSignature },
    producer_ref: finalSignature.key_id,
    source_ref: "root-genesis-procedure",
    produced_at: signedDocument.created_at,
    provenance: { source_relation: "INDEPENDENT_OBSERVATION", integrity: "SIGNED_ATTESTATION", attestation_ref: finalSignature.key_id },
  };
  base["claim_digest"] = jcsDigest(base["claim"]);
  const envelope = { ...base, envelope_digest: recordDigest(base, "envelope_digest") } as unknown as EvidenceEnvelopeV1;
  validateEvidenceEnvelope(envelope);

  store.withImmediate(() => {
    store.insertPolicyRef({
      policy_id: input.policy_id,
      revision: 1,
      content_digest,
      issuer_ref: finalSignature.key_id,
      bundle_cas_key,
      payload_digest: payload.value,
      manifest_revision: manifest!.revision!,
    });
    store.insertEvidence(envelope, nowIso(clock));
    store.insertActivation({
      seq: 1,
      expected_prev_seq: 0,
      policy_id: input.policy_id,
      revision: 1,
      content_digest,
      activated_by_ref: finalSignature.key_id,
      activation_evidence_id: evidence_id,
      activated_at: nowIso(clock),
    });
  });

  return { activation_seq: 1, genesis_evidence_id: evidence_id };
}
