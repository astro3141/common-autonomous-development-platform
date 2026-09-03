/**
 * Active-policy resolution with verify-on-read (TD §3.3 restart reads / §4.4 #1):
 * the active policy is the `policy_activation` row with the highest seq; its bundle bytes
 * must re-digest to the activation's content_digest, and `data.cadp` must validate.
 */

import { Cas } from "./cas.ts";
import { sha256Hex } from "./canonical.ts";
import { dataJsonOf, validateKernelConfig } from "./policyBundle.ts";
import type { KernelConfig } from "./policyBundle.ts";
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

/** Registry lookups are exact string matches only (TD §5.4). */
export function identityEntry(config: KernelConfig, principal: string) {
  return config.identity_registry.find((e) => e.principal === principal);
}

export function adapterEntry(config: KernelConfig, producer_ref: string) {
  return config.adapter_registry.find((e) => e.producer_ref === producer_ref);
}
