/**
 * Capability model — Manifest, Broker, compatibility and receipt validation (TD §12).
 *
 * Pure Core calculation only. No Manifest loader, no Decision Validator, no persistence.
 */

export { issueCapabilityGrant, type BrokerInput, type CapabilityGrantResult } from "./broker.ts";
export {
  evaluateCapabilityRequirements,
  type CapabilityCheck,
  type CompatibilityResult,
} from "./compatibility.ts";
export { deriveEnforcement, deriveRequestedCapabilities } from "./derive.ts";
export { CapabilityError, type CapabilityErrorReason } from "./errors.ts";
export { validateManifestSet, type ManifestSetInput } from "./manifest-set.ts";
export {
  validateEnforcementReceipt,
  type ReceiptValidation,
  type ReceiptValidationInput,
  type ReceiptValidationReason,
} from "./receipt.ts";
export { hashManifest, isRuntimeManifest, validateManifest } from "./validate-manifest.ts";
export * from "./types.ts";
