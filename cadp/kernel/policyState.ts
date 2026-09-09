/**
 * Active-policy resolution with verify-on-read (TD §3.3 restart reads / §4.4 #1):
 * the active policy is the `policy_activation` row with the highest seq; its bundle bytes
 * must re-digest to the activation's content_digest, and `data.cadp` must validate.
 */

import { Cas } from "./cas.ts";
import { jcs, sha256Hex } from "./canonical.ts";
import { dataJsonOf, validateKernelConfig } from "./policyBundle.ts";
import type { KernelConfig, SealedAllocationContractEntries, SealedAllocationContracts } from "./policyBundle.ts";
import type { PolicyRefV1 } from "./records.ts";
import { ConstitutionalStore } from "./store.ts";
import type { ActivationRow, PolicyRefRow } from "./store.ts";

export interface ActivePolicy {
  readonly activation: ActivationRow;
  readonly refRow: PolicyRefRow;
  readonly policy_ref: PolicyRefV1;
  readonly config: KernelConfig;
  readonly bundleBytes: Uint8Array;
}

export class PolicyStateError extends Error {}

const configCache = new Map<string, KernelConfig>();

export function resolveActivePolicy(store: ConstitutionalStore, cas: Cas): ActivePolicy {
  const activation = store.activeActivation();
  if (activation === undefined) throw new PolicyStateError("no policy_activation row exists (pre-genesis)");
  const refRow = store.policyRef(activation.policy_id, activation.revision);
  if (refRow === undefined) throw new PolicyStateError("active activation references a missing policy_ref row");
  if (refRow.content_digest !== activation.content_digest) {
    throw new PolicyStateError("policy_ref.content_digest does not match the activation row");
  }
  const bundleBytes = cas.get(refRow.bundle_cas_key);
  if (sha256Hex(bundleBytes) !== activation.content_digest) {
    throw new PolicyStateError("active policy bundle bytes do not re-digest to content_digest");
  }
  let config = configCache.get(activation.content_digest);
  if (config === undefined) {
    const data = dataJsonOf(bundleBytes) as { cadp?: unknown } | undefined;
    config = validateKernelConfig(data?.cadp);
    configCache.set(activation.content_digest, config);
  }
  return {
    activation,
    refRow,
    policy_ref: {
      policy_id: activation.policy_id,
      revision: activation.revision,
      content_digest: { algorithm: "sha256", canonicalization: "raw-bytes-1", value: activation.content_digest },
      issuer_ref: refRow.issuer_ref,
    },
    config,
    bundleBytes,
  };
}

/**
 * AP B2(2)(ii): the allocation-contract history of the SEALED STORE — for each allocation schema
 * id, the two registry entries as the EARLIEST activation that carried them sealed them, in
 * `cadp-jcs-1` form. Read from `policy_activation` rows and their immutable bundles, never from
 * the currently active bundle alone, which is what makes an entry unlaunderable by withdrawing it
 * in one activation and re-adding a different one in the next.
 *
 * Deliberately tolerant of shape here and nowhere else: every bundle scanned ALREADY passed
 * `validateKernelConfig` at its own activation, so a non-array registry or a non-object entry is
 * a pre-v2 (or absent) registry rather than an error to raise while validating a NEW bundle. A
 * bundle whose bytes cannot be read or do not re-digest is a different matter and throws, which
 * fails the activation closed — an unreadable history can never be silently treated as empty.
 */
export function sealedAllocationContracts(store: ConstitutionalStore, cas: Cas): SealedAllocationContracts {
  const history = new Map<string, SealedAllocationContractEntries>();
  for (const activation of store.activations()) {
    const refRow = store.policyRef(activation.policy_id, activation.revision);
    if (refRow === undefined) throw new PolicyStateError("an activation references a missing policy_ref row");
    const bundleBytes = cas.get(refRow.bundle_cas_key);
    if (sha256Hex(bundleBytes) !== activation.content_digest) {
      throw new PolicyStateError(`activation ${activation.seq} bundle bytes do not re-digest to content_digest`);
    }
    const cadp = (dataJsonOf(bundleBytes) as { cadp?: unknown } | undefined)?.cadp as Record<string, unknown> | undefined;
    if (typeof cadp !== "object" || cadp === null) continue;
    for (const registry of ["allocation_schema_descriptors", "allocation_schemas"] as const) {
      const entries = cadp[registry];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const schema = (entry as Record<string, unknown>)["schema"];
        if (typeof schema !== "string" || schema.length === 0) continue;
        const prior = history.get(schema) ?? {};
        // FIRST activation carrying it wins: later activations can only have re-sealed something
        // byte-identical (the immutability rule refused anything else), so the earliest row is
        // the contract, and reading it first keeps that true even for a schema the rule does not
        // claim — this function records history and enforces nothing.
        if (registry === "allocation_schema_descriptors") {
          if (prior.descriptor === undefined) history.set(schema, { ...prior, descriptor: jcs(entry) });
        } else if (prior.allocation_schema === undefined) {
          history.set(schema, { ...prior, allocation_schema: jcs(entry) });
        }
      }
    }
  }
  return history;
}

/** Registry lookups are exact string matches only (TD §5.4). */
export function identityEntry(config: KernelConfig, principal: string) {
  return config.identity_registry.find((e) => e.principal === principal);
}

export function adapterEntry(config: KernelConfig, producer_ref: string) {
  return config.adapter_registry.find((e) => e.producer_ref === producer_ref);
}
