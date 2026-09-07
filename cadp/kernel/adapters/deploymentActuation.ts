/**
 * Deployment-actuation TargetAdapterV1 (TD §20.3, §20.6 item 1).
 *
 * This item deliberately provides only the closed DEPLOY material verifier and the
 * attestation-gated describe row. Process actuation is not reachable until the later
 * dispatch implementation item lands.
 */

import type { TargetRef, SubjectBinding } from "../records.ts";
import type {
  AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
} from "./types.ts";
import { MaterialIncomplete } from "./types.ts";

export const DEPLOYMENT_ACTUATION_AUTHORITY_REF = "deployment-control";
export const DEPLOYMENT_ACTUATION_TARGET_TYPE = "DEPLOYMENT";
export const DEPLOYMENT_ACTUATION_TARGET_ID = "cadp-v04-live";
export const DEPLOY_OPERATION = "DEPLOY";
export const DEPLOY_MATERIAL_SCHEMA = "cadp.deploy.v1";

const COMPONENTS = new Set(["broker", "worker"]);
const MATERIAL_KEYS = new Set(["repo_id", "sha", "components", "expected_prior"]);
const IDENTITY_KEYS = new Set(["code_sha", "image_digest", "pid"]);

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MaterialIncomplete(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new MaterialIncomplete(`${field} has unknown key ${key}`);
  }
}

export class DeploymentActuationAdapter implements TargetAdapterV1 {
  readonly repoId: string | undefined;
  readonly attestationsFreshAndPassing: () => boolean;

  constructor(
    repoId: string | undefined,
    attestationsFreshAndPassing: () => boolean,
  ) {
    this.repoId = repoId;
    this.attestationsFreshAndPassing = attestationsFreshAndPassing;
  }

  describe(): { target_type: string; authority_ref: string; operations: readonly AdapterOperation[] } {
    return {
      target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE,
      authority_ref: DEPLOYMENT_ACTUATION_AUTHORITY_REF,
      operations: [{
        operation_kind: DEPLOY_OPERATION,
        material_schema: DEPLOY_MATERIAL_SCHEMA,
        available: this.attestationsFreshAndPassing(),
        idempotency: "NATIVE_PRECONDITION",
        dispatch_precondition: "NONE",
        reconcile: "BY_QUERY_PREDICATE",
        no_effect_proof_supported: true,
      }],
    };
  }

  serialization_domain(): string { return `deployment:${DEPLOYMENT_ACTUATION_TARGET_ID}`; }

  async prove_identity(): Promise<TargetIdentityClaim> {
    return {
      target_ref: {
        authority_ref: DEPLOYMENT_ACTUATION_AUTHORITY_REF,
        target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE,
        target_id: DEPLOYMENT_ACTUATION_TARGET_ID,
      },
      claim: { deployment_id: DEPLOYMENT_ACTUATION_TARGET_ID },
    };
  }

  async current_revision(_subject: SubjectBinding): Promise<RevisionRead> { return { availability: "UNKNOWN" }; }

  async verify_material(operation_kind: string, material: Record<string, unknown>): Promise<void> {
    if (operation_kind !== DEPLOY_OPERATION) return;
    rejectUnknown(material, MATERIAL_KEYS, DEPLOY_MATERIAL_SCHEMA);
    if (typeof material["repo_id"] !== "string" || material["repo_id"].length === 0) {
      throw new MaterialIncomplete("DEPLOY material requires repo_id");
    }
    if (this.repoId === undefined || material["repo_id"] !== this.repoId) {
      throw new MaterialIncomplete("DEPLOY repo_id must name the governed repository");
    }
    if (typeof material["sha"] !== "string" || !/^[0-9a-f]{40}$/u.test(material["sha"])) {
      throw new MaterialIncomplete("DEPLOY sha must be a 40-character lowercase git sha");
    }
    const components = material["components"];
    if (!Array.isArray(components) || components.length === 0) {
      throw new MaterialIncomplete("DEPLOY components must be a non-empty array");
    }
    const named = new Set<string>();
    for (const component of components) {
      if (typeof component !== "string" || !COMPONENTS.has(component)) {
        throw new MaterialIncomplete(`DEPLOY component ${String(component)} is outside the closed actuation set`);
      }
      if (named.has(component)) throw new MaterialIncomplete(`DEPLOY component ${component} is duplicated`);
      named.add(component);
    }

    if (material["expected_prior"] !== undefined) {
      const expected = object(material["expected_prior"], "expected_prior");
      rejectUnknown(expected, named, "expected_prior");
      for (const component of named) {
        if (!(component in expected)) throw new MaterialIncomplete(`expected_prior is missing ${component}`);
        const identity = object(expected[component], `expected_prior.${component}`);
        rejectUnknown(identity, IDENTITY_KEYS, `expected_prior.${component}`);
        if (typeof identity["code_sha"] !== "string" || !/^[0-9a-f]{40}$/u.test(identity["code_sha"])) {
          throw new MaterialIncomplete(`expected_prior.${component}.code_sha must be a git sha`);
        }
        if (identity["image_digest"] !== undefined && typeof identity["image_digest"] !== "string") {
          throw new MaterialIncomplete(`expected_prior.${component}.image_digest must be a string`);
        }
        if (identity["pid"] !== undefined && (!Number.isInteger(identity["pid"]) || (identity["pid"] as number) <= 0)) {
          throw new MaterialIncomplete(`expected_prior.${component}.pid must be a positive integer`);
        }
      }
    }
  }

  async dispatch_precondition_read(): Promise<string | undefined> { return undefined; }

  async dispatch(_effect: string, _ordinal: number, _target: TargetRef, operation_kind: string): Promise<DispatchResult> {
    return { kind: "AMBIGUOUS", raw_observation: `${operation_kind} dispatch is not implemented` };
  }

  async reconcile(_effect: string, _ordinal: number, _target: TargetRef, operation_kind: string): Promise<ReconcileResult> {
    return { kind: "UNKNOWN", unknown_reason: `${operation_kind} reconciliation is not implemented` };
  }

  receipt_binds(): boolean { return false; }
}
