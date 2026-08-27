/**
 * BackendManifestSet validation (TD §12.2a).
 *
 * Exactly one manifest per kind. The set is a typed aggregate input only — it has no envelope and
 * no hash of its own; each component hash is the authority.
 */

import { CapabilityError } from "./errors.ts";
import { isRuntimeManifest, validateManifest } from "./validate-manifest.ts";
import type { BackendKind, BackendManifestSet, ValidatedManifest } from "./types.ts";

export interface ManifestSetInput {
  readonly runtime: unknown;
  readonly workflow: unknown;
  readonly repository: unknown;
  readonly verification: unknown;
}

const SLOTS: ReadonlyArray<readonly [keyof ManifestSetInput, BackendKind]> = [
  ["runtime", "RUNTIME"],
  ["workflow", "WORKFLOW"],
  ["repository", "REPOSITORY"],
  ["verification", "VERIFICATION"],
];

/** Validates all four components and checks that each slot holds its own kind. */
export function validateManifestSet(input: ManifestSetInput): BackendManifestSet {
  const validated = {} as Record<keyof ManifestSetInput, ValidatedManifest>;

  for (const [slot, kind] of SLOTS) {
    const manifest = validateManifest(input[slot]);
    if (manifest.body.backend_kind !== kind) {
      throw new CapabilityError(
        "MANIFEST_SET_INVALID",
        `/${slot}`,
        `slot expects backend_kind ${kind}, found ${manifest.body.backend_kind}`,
      );
    }
    validated[slot] = manifest;
  }

  const runtime = validated.runtime;
  if (!isRuntimeManifest(runtime)) {
    throw new CapabilityError("MANIFEST_SET_INVALID", "/runtime", "runtime slot is not a RUNTIME manifest");
  }

  return {
    runtime,
    workflow: validated.workflow,
    repository: validated.repository,
    verification: validated.verification,
  };
}
