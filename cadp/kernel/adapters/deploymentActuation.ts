/**
 * Deployment-actuation TargetAdapterV1 (TD §20.3, implementation item 1).
 *
 * This item deliberately exposes no actuator. It only declares DEPLOY, reports whether the
 * pre-deploy attestations are usable, and validates the closed cadp.deploy.v1 material.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SubjectBinding, TargetRef } from "../records.ts";
import { resolveActivePolicy } from "../policyState.ts";
import { Cas } from "../cas.ts";
import { ConstitutionalStore } from "../store.ts";
import { MaterialIncomplete } from "./types.ts";
import type {
  AdapterOperation, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
} from "./types.ts";

export const DEPLOY_OPERATION = "DEPLOY" as const;
export const DEPLOY_MATERIAL_SCHEMA = "cadp.deploy.v1" as const;
export const DEPLOYMENT_ACTUATION_TARGET_TYPE = "DEPLOYMENT_ACTUATION" as const;
export const DEPLOYMENT_ACTUATION_AUTHORITY_REF = "cadp-host" as const;
export const DEPLOYMENT_ACTUATION_TARGET_ID = "cadp-v04-live" as const;

const COMPONENTS = new Set(["broker", "worker"]);
const TOP_LEVEL_KEYS = new Set(["repo_id", "sha", "components", "expected_prior"]);
const IDENTITY_KEYS = new Set(["code_sha", "image_digest", "pid"]);

export interface DeploymentPreconditionReads {
  /** Target-authoritative GitHub compare of material.sha...main. */
  compareToMain(sha: string): Promise<{ status_code: number; compare_status?: string }>;
  /** Observation of the exact checkout from which broker/worker would be spawned. */
  checkout(): Promise<{ head: string; porcelain: string }>;
}

const execFileAsync = promisify(execFile);

export function liveCheckoutRead(repoRoot: string): () => Promise<{ head: string; porcelain: string }> {
  return async () => {
    const [head, status] = await Promise.all([
      execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }),
      execFileAsync("git", ["-C", repoRoot, "status", "--porcelain"], { encoding: "utf8" }),
    ]);
    return { head: head.stdout.trim(), porcelain: status.stdout };
  };
}

/** Shared with PR_CREATE so both describe rows use one injected-clock immutability predicate. */
export function freshPassingImmutabilityAttestation(
  store: ConstitutionalStore,
  cas: Cas,
  repoId: string,
  clock: () => number,
): boolean {
  try {
    const attestation = store.latestEvidenceOfKind(
      "TARGET_IMMUTABILITY_ATTESTATION",
      `github.com|GIT_REPOSITORY|${repoId}`,
    );
    if (attestation === undefined) return false;
    const maxAge = resolveActivePolicy(store, cas).config.target_immutability_attestation_max_age_s * 1000;
    return attestation.availability === "PRESENT"
      && clock() - Date.parse(attestation.produced_at) <= maxAge
      && (attestation.claim as { write_once_enforced?: boolean }).write_once_enforced === true;
  } catch {
    return false;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new MaterialIncomplete(`${path}: unknown key ${unknown}`);
}

export class DeploymentActuationAdapter implements TargetAdapterV1 {
  readonly store: ConstitutionalStore;
  readonly cas: Cas;
  readonly repoId: string | undefined;
  readonly clock: () => number;
  readonly preconditionReads: DeploymentPreconditionReads | undefined;

  constructor(
    store: ConstitutionalStore,
    cas: Cas,
    repoId: string | undefined,
    clock: () => number,
    preconditionReads?: DeploymentPreconditionReads,
  ) {
    this.store = store;
    this.cas = cas;
    this.repoId = repoId;
    this.clock = clock;
    this.preconditionReads = preconditionReads;
  }

  describe(): { target_type: string; authority_ref: string; operations: readonly AdapterOperation[] } {
    return {
      target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE,
      authority_ref: DEPLOYMENT_ACTUATION_AUTHORITY_REF,
      operations: [{
        operation_kind: DEPLOY_OPERATION,
        material_schema: DEPLOY_MATERIAL_SCHEMA,
        available: this.#attestationsFreshAndPassing(),
        idempotency: "NATIVE_PRECONDITION",
        dispatch_precondition: "PEP_READ_THEN_ACT",
        reconcile: "BY_QUERY_PREDICATE",
        no_effect_proof_supported: true,
      }],
    };
  }

  #attestationsFreshAndPassing(): boolean {
    if (this.repoId === undefined) return false;
    try {
      const config = resolveActivePolicy(this.store, this.cas).config;
      const now = this.clock();
      const reach = this.store.latestEvidenceOfKind("CREDENTIAL_REACH_ATTESTATION");
      return reach?.availability === "PRESENT"
        && now - Date.parse(reach.produced_at) <= config.reach_attestation_max_age_s * 1000
        && (reach.claim as { alternate_path_found?: boolean }).alternate_path_found === false
        && freshPassingImmutabilityAttestation(this.store, this.cas, this.repoId, () => now);
    } catch {
      return false;
    }
  }

  serialization_domain(): string { return "deployment-actuation"; }

  async prove_identity(): Promise<TargetIdentityClaim> {
    return {
      target_ref: {
        authority_ref: DEPLOYMENT_ACTUATION_AUTHORITY_REF,
        target_type: DEPLOYMENT_ACTUATION_TARGET_TYPE,
        target_id: DEPLOYMENT_ACTUATION_TARGET_ID,
      },
      claim: { target_id: DEPLOYMENT_ACTUATION_TARGET_ID, component_set: ["broker", "worker"] },
    };
  }

  async current_revision(_subject: SubjectBinding): Promise<RevisionRead> {
    return { availability: "UNKNOWN" };
  }

  async verify_material(operation_kind: string, material: Record<string, unknown>): Promise<void> {
    if (operation_kind !== DEPLOY_OPERATION) return;
    closedKeys(material, TOP_LEVEL_KEYS, DEPLOY_MATERIAL_SCHEMA);
    if (typeof material["repo_id"] !== "string" || material["repo_id"].length === 0) {
      throw new MaterialIncomplete("repo_id missing");
    }
    if (typeof material["sha"] !== "string" || material["sha"].length === 0) {
      throw new MaterialIncomplete("sha missing");
    }
    const components = material["components"];
    if (!Array.isArray(components) || components.length === 0) {
      throw new MaterialIncomplete("components must be a non-empty subset of {broker, worker}");
    }
    if (components.some((component) => typeof component !== "string" || !COMPONENTS.has(component))) {
      throw new MaterialIncomplete("components contains a name outside {broker, worker}");
    }
    if (new Set(components).size !== components.length) {
      throw new MaterialIncomplete("components must be a subset (no duplicates)");
    }

    const expected = material["expected_prior"];
    if (expected === undefined) return; // First-ever DEPLOY may omit it (§20.4).
    if (!object(expected)) throw new MaterialIncomplete("expected_prior must be an object");
    for (const component of components) {
      if (!(component in expected)) throw new MaterialIncomplete(`expected_prior.${component} missing`);
    }
    for (const [component, identity] of Object.entries(expected)) {
      if (!COMPONENTS.has(component) || !components.includes(component)) {
        throw new MaterialIncomplete(`expected_prior: unexpected component ${component}`);
      }
      if (!object(identity)) throw new MaterialIncomplete(`expected_prior.${component} must be an object`);
      closedKeys(identity, IDENTITY_KEYS, `expected_prior.${component}`);
      if (typeof identity["code_sha"] !== "string" || identity["code_sha"].length === 0) {
        throw new MaterialIncomplete(`expected_prior.${component}.code_sha missing`);
      }
      if (identity["image_digest"] !== undefined && typeof identity["image_digest"] !== "string") {
        throw new MaterialIncomplete(`expected_prior.${component}.image_digest must be a string`);
      }
      if (identity["pid"] !== undefined && (!Number.isInteger(identity["pid"]) || (identity["pid"] as number) <= 0)) {
        throw new MaterialIncomplete(`expected_prior.${component}.pid must be a positive integer`);
      }
    }
  }

  async dispatch_precondition_read(operation_kind: string, material: Record<string, unknown>): Promise<string | undefined> {
    if (operation_kind !== DEPLOY_OPERATION) return undefined;
    if (this.preconditionReads === undefined) return "DEPLOY precondition reads are unavailable";

    const sha = String(material["sha"]);
    let compared: { status_code: number; compare_status?: string };
    try {
      compared = await this.preconditionReads.compareToMain(sha);
    } catch (error) {
      return `GitHub compare ${sha}...main unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (compared.status_code !== 200 || compared.compare_status === undefined) {
      return `GitHub compare ${sha}...main unreadable (status ${compared.status_code})`;
    }
    if (compared.compare_status !== "ahead" && compared.compare_status !== "identical") {
      return `GitHub compare ${sha}...main status ${compared.compare_status}; expected ahead or identical`;
    }

    let checkout: { head: string; porcelain: string };
    try {
      checkout = await this.preconditionReads.checkout();
    } catch (error) {
      return `local checkout unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (checkout.head !== sha) return `local HEAD at ${checkout.head}, material sha ${sha}`;
    if (checkout.porcelain.length !== 0) return "local worktree is dirty";
    return undefined;
  }

  async dispatch(_effect: string, _ordinal: number, _target: TargetRef, operation: string): Promise<never> {
    throw new Error(`${operation} dispatch is outside TD §20.6 items 1-2`);
  }

  async reconcile(): Promise<never> {
    throw new Error("DEPLOY reconciliation is outside TD §20.6 item 1");
  }

  receipt_binds(): boolean { return false; }
}
