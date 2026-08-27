/**
 * CapabilityEnforcementReceipt pure validation (TD §12.6 R1–R8, M0-18/M0-19).
 *
 * Returns a result; it performs no transition, no suppression and no write. A failure maps to
 * `CAPABILITY_BOUNDARY_CHANGED` upstream, but that mapping and the HELD/send_turn handling belong
 * to the Coordinator batch.
 *
 * The receipt and spawn-result types come from the adapter boundary (Batch 3) because the values
 * being validated are literally what crosses that boundary; the import is type-only.
 */

import type {
  CapabilityEnforcementReceipt,
  RuntimeSpawnResult,
} from "../../adapters/interfaces/index.ts";
import { CAPABILITY_NAMES, ENFORCEMENT_ASSURANCES } from "../schemas/capability-vocabulary.ts";
import type {
  CapabilityGrantV1Body,
  CapabilityName,
  CapabilityRequirementMap,
  RuntimeManifestBody,
} from "./types.ts";

export type ReceiptValidationReason =
  /** receipt_supported=true but the spawn result carries none. */
  | "RECEIPT_MISSING"
  /** receipt_supported=false but a receipt was returned. */
  | "RECEIPT_UNEXPECTED"
  | "SESSION_HANDLE_MISMATCH"
  | "GRANT_HASH_MISMATCH"
  | "MANIFEST_HASH_MISMATCH"
  /** `applied` holds an unknown capability or an invalid assurance. */
  | "APPLIED_INVALID"
  /** `applied` is not the complete twelve-capability map. */
  | "APPLIED_INCOMPLETE"
  /** `applied[c]` differs from the grant's expectation. */
  | "ENFORCEMENT_MISMATCH"
  /** A selected operation requirement is not met by the applied assurance. */
  | "REQUIREMENT_NOT_MET";

export type ReceiptValidation =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: ReceiptValidationReason;
      readonly capability?: CapabilityName;
      readonly detail: string;
    };

export interface ReceiptValidationInput {
  readonly runtime_manifest: RuntimeManifestBody;
  readonly spawn_result: RuntimeSpawnResult;
  readonly grant: CapabilityGrantV1Body;
  /** The grant envelope hash the Platform holds. */
  readonly grant_hash: string;
  /** Later supplied by `task.backend_requirements.runtime_manifest_hash`. */
  readonly expected_runtime_manifest_hash: string;
  /** Optional: the already-selected operation's requirement map (R8). */
  readonly requirements?: CapabilityRequirementMap;
}

const invalid = (
  reason: ReceiptValidationReason,
  detail: string,
  capability?: CapabilityName,
): ReceiptValidation => ({ valid: false, reason, detail, ...(capability ? { capability } : {}) });

export function validateEnforcementReceipt(input: ReceiptValidationInput): ReceiptValidation {
  const receipt = input.spawn_result.enforcement_receipt;

  // R1 — presence follows receipt_supported exactly, and nothing else (M0-19).
  if (input.runtime_manifest.receipt_supported) {
    if (receipt === undefined) {
      return invalid("RECEIPT_MISSING", "receipt_supported is true but the spawn returned no receipt");
    }
  } else {
    if (receipt !== undefined) {
      return invalid("RECEIPT_UNEXPECTED", "receipt_supported is false but a receipt was returned");
    }
    // A receipt-free spawn is a conforming result; nothing further to check.
    return { valid: true };
  }

  return validatePresentReceipt(receipt, input);
}

function validatePresentReceipt(
  receipt: CapabilityEnforcementReceipt,
  input: ReceiptValidationInput,
): ReceiptValidation {
  // R2
  if (receipt.session_handle !== input.spawn_result.session_handle) {
    return invalid("SESSION_HANDLE_MISMATCH", "receipt is not bound to the spawned session");
  }
  // R3
  if (receipt.grant_hash !== input.grant_hash) {
    return invalid("GRANT_HASH_MISMATCH", "receipt does not reference the issued grant");
  }
  // R4 — one runtime manifest hash across grant, receipt and task contract.
  if (
    receipt.backend_manifest_hash !== input.grant.source_runtime_manifest_hash ||
    receipt.backend_manifest_hash !== input.expected_runtime_manifest_hash
  ) {
    return invalid("MANIFEST_HASH_MISMATCH", "receipt runtime manifest hash breaks the chain");
  }

  const applied = receipt.applied as Readonly<Record<string, unknown>>;

  // R5
  for (const [key, value] of Object.entries(applied)) {
    if (!(CAPABILITY_NAMES as readonly string[]).includes(key)) {
      return invalid("APPLIED_INVALID", `unknown capability "${key}" in applied`);
    }
    if (typeof value !== "string" || !(ENFORCEMENT_ASSURANCES as readonly string[]).includes(value)) {
      return invalid("APPLIED_INVALID", `invalid assurance for "${key}"`, key as CapabilityName);
    }
  }
  // R6 — applied is the complete twelve-capability map (TD §12.6).
  for (const capability of CAPABILITY_NAMES) {
    if (applied[capability] === undefined) {
      return invalid("APPLIED_INCOMPLETE", `applied is missing "${capability}"`, capability);
    }
  }

  // R7 — exact equality; assurance is a set vocabulary, not an ordering.
  for (const capability of CAPABILITY_NAMES) {
    if (applied[capability] !== input.grant.enforcement[capability]) {
      return invalid(
        "ENFORCEMENT_MISMATCH",
        `applied ${String(applied[capability])} != granted ${input.grant.enforcement[capability]}`,
        capability,
      );
    }
  }

  // R8 — optional selected-operation requirements.
  const requirements = input.requirements;
  if (requirements !== undefined) {
    for (const capability of CAPABILITY_NAMES) {
      const requirement = requirements[capability];
      if (requirement === undefined) continue;
      const actual = applied[capability] as (typeof ENFORCEMENT_ASSURANCES)[number];
      if (!requirement.accepted.includes(actual)) {
        return invalid(
          "REQUIREMENT_NOT_MET",
          `applied ${actual} is not in the accepted set`,
          capability,
        );
      }
    }
  }

  // applied_means is adapter/runtime-owned evidence: carried, never interpreted.
  return { valid: true };
}
