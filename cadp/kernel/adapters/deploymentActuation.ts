/**
 * Deployment-actuation TargetAdapterV1 (TD §20.3–20.6).
 * Dispatch restarts the closed component set; reconciliation owns the mandatory post-deploy
 * deployment-control attest and is the only path that can report DEPLOY as COMMITTED.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SubjectBinding, TargetRef } from "../records.ts";
import { resolveActivePolicy } from "../policyState.ts";
import { Cas } from "../cas.ts";
import { ConstitutionalStore } from "../store.ts";
import { MaterialIncomplete } from "./types.ts";
import type {
  AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
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

export interface ComponentIdentity { code_sha: string; image_digest: string; pid: number }
export interface DeploymentComponentRunner {
  observe(component: "broker" | "worker"): Promise<ComponentIdentity>;
  kill(component: "broker" | "worker"): Promise<void>;
  start(component: "broker" | "worker"): Promise<void>;
}

/** Runs the existing deployment-control probes and seals both envelopes for this effect. */
export type DeploymentAttestInvoker = (effectId: string) => Promise<void>;

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
  readonly componentRunner: DeploymentComponentRunner | undefined;
  readonly attest: DeploymentAttestInvoker | undefined;

  constructor(
    store: ConstitutionalStore,
    cas: Cas,
    repoId: string | undefined,
    clock: () => number,
    preconditionReads?: DeploymentPreconditionReads,
    componentRunner?: DeploymentComponentRunner,
    attest?: DeploymentAttestInvoker,
  ) {
    this.store = store;
    this.cas = cas;
    this.repoId = repoId;
    this.clock = clock;
    this.preconditionReads = preconditionReads;
    this.componentRunner = componentRunner;
    this.attest = attest;
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
    if (expected === undefined) throw new MaterialIncomplete("expected_prior missing");
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

  async dispatch(effect: string, ordinal: number, _target: TargetRef, operation: string, material: Record<string, unknown>): Promise<DispatchResult> {
    if (operation !== DEPLOY_OPERATION || this.componentRunner === undefined) {
      return { kind: "AMBIGUOUS", raw_observation: `${operation} component runner unavailable` };
    }
    const components = material["components"] as Array<"broker" | "worker">;
    const expected = material["expected_prior"] as Record<string, Record<string, unknown>>;
    const prior: Record<string, ComponentIdentity> = {};

    // Observe and compare the whole named set before touching any component.
    for (const component of components) prior[component] = await this.componentRunner.observe(component);
    for (const component of components) {
      const want = expected[component]!;
      const got = prior[component]!;
      const matches = want["code_sha"] === got.code_sha
        && (want["image_digest"] === undefined || want["image_digest"] === got.image_digest)
        && (want["pid"] === undefined || want["pid"] === got.pid);
      if (!matches) return {
        kind: "REJECTED_NO_EFFECT",
        proof_claim: { reason: "expected_prior_mismatch", component, expected_prior: want, observed_prior: got },
      };
    }

    const receipts: Array<{ component: string; prior: ComponentIdentity; next: ComponentIdentity }> = [];
    for (const component of components) {
      await this.componentRunner.kill(component);
      await this.componentRunner.start(component);
      const next = await this.componentRunner.observe(component);
      receipts.push({ component, prior: prior[component]!, next });
    }
    // Starting processes is transport acceptance, not proof of the DEPLOY effect.  The receipt is
    // reconstructed from target observation during reconcile, after deployment-control attests.
    return { kind: "AMBIGUOUS", raw_observation: `deploy:${effect}:${ordinal}:restart accepted; post-deploy attestation pending` };
  }

  async reconcile(
    effectId: string,
    ordinal: number,
    _target: TargetRef,
    operation: string,
    material: Record<string, unknown>,
    context?: { admitted_at?: string },
  ): Promise<ReconcileResult> {
    if (operation !== DEPLOY_OPERATION || this.componentRunner === undefined) {
      return { kind: "UNKNOWN", unknown_reason: "DEPLOY component observation unavailable" };
    }
    if (this.attest !== undefined) {
      try { await this.attest(effectId); }
      catch (error) {
        return { kind: "UNKNOWN", unknown_reason: `post-deploy attest failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }

    const admittedAt = context?.admitted_at === undefined ? Number.NaN : Date.parse(context.admitted_at);
    const effectSubject = `cadp-store:k04|effect|${effectId}`;
    const hasEffect = (envelope: { subject_bindings: readonly SubjectBinding[] }) =>
      envelope.subject_bindings.some((s) => `${s.authority_ref}|${s.namespace}|${s.object_id}` === effectSubject);
    const reach = this.store.latestEvidenceOfKind(
      "CREDENTIAL_REACH_ATTESTATION", "cadp-store:k04|deployment|cadp-v04-live",
    );
    const immutable = this.store.latestEvidenceOfKind(
      "TARGET_IMMUTABILITY_ATTESTATION", `github.com|GIT_REPOSITORY|${String(material["repo_id"])}`,
    );
    const postAdmission = (envelope: { produced_at: string }) => Date.parse(envelope.produced_at) > admittedAt;
    const failingReachWasSealed = this.store.evidenceBySubjectKey(effectSubject).some((envelope) =>
      envelope.evidence_kind === "CREDENTIAL_REACH_ATTESTATION"
      && postAdmission(envelope)
      && (envelope.claim as { alternate_path_found?: boolean } | undefined)?.alternate_path_found !== false);
    if (reach === undefined || immutable === undefined || !hasEffect(reach) || !hasEffect(immutable)
      || !postAdmission(reach) || !postAdmission(immutable)
      || reach.availability !== "PRESENT" || immutable.availability !== "PRESENT"
      || failingReachWasSealed
      || (reach.claim as { alternate_path_found?: boolean }).alternate_path_found !== false
      || (immutable.claim as { write_once_enforced?: boolean }).write_once_enforced !== true) {
      return { kind: "UNKNOWN", unknown_reason: "post-deploy attestations absent, unbound, pre-admission, or failing" };
    }

    const components = material["components"] as Array<"broker" | "worker">;
    const expected = material["expected_prior"] as Record<string, ComponentIdentity>;
    const rows = [] as Array<{ component: string; prior: ComponentIdentity; next: ComponentIdentity }>;
    for (const component of components) {
      const next = await this.componentRunner.observe(component);
      if (next.pid <= 0 || next.code_sha !== material["sha"]) {
        return { kind: "UNKNOWN", unknown_reason: `DEPLOY component ${component} is not alive at the deployed identity` };
      }
      rows.push({ component, prior: expected[component]!, next });
    }
    return { kind: "COMMITTED", target_operation_ref: `deploy:${effectId}:${ordinal}`, receipt_claim: { components: rows } };
  }

  receipt_binds(operation: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    if (operation !== DEPLOY_OPERATION || !Array.isArray(receipt["components"])) return false;
    const wanted = material["components"] as string[];
    const rows = receipt["components"] as Array<Record<string, unknown>>;
    return rows.length === wanted.length && wanted.every((component) => {
      const row = rows.find((candidate) => candidate["component"] === component);
      const next = row?.["next"] as Record<string, unknown> | undefined;
      return next?.["code_sha"] === material["sha"];
    });
  }
}
