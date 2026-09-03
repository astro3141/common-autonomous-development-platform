/**
 * In-process reference composition for the conformance suite (TD §13): real store (SQLite
 * harness), real CAS, real OPA sidecar evaluator, real kernel components; the target is a
 * scripted TargetAdapterV1 whose behaviours are controlled per test (fault injection at the
 * transport seam — the kernel path stays the production path).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cas } from "../../../cadp/kernel/cas.ts";
import { Ingress } from "../../../cadp/kernel/ingress.ts";
import type { Principal } from "../../../cadp/kernel/ingress.ts";
import { OpaEvaluator, evaluateAndSeal } from "../../../cadp/kernel/evaluator.ts";
import type { EvaluateOutcome } from "../../../cadp/kernel/evaluator.ts";
import { Pep } from "../../../cadp/kernel/pep.ts";
import { Reconciler } from "../../../cadp/kernel/reconciler.ts";
import { runGenesis } from "../../../cadp/kernel/genesis.ts";
import { generateRootKey } from "../../../cadp/kernel/sig.ts";
import { ConstitutionalStore } from "../../../cadp/kernel/store.ts";
import { makeAdapterRegistry } from "../../../cadp/kernel/adapters/types.ts";
import type {
  AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
} from "../../../cadp/kernel/adapters/types.ts";
import type { SubjectBinding, TargetRef } from "../../../cadp/kernel/records.ts";
import { buildReferenceBundle, buildReferenceKernelConfig } from "../../../cadp/deployment/referencePolicy.ts";
import type { ReferencePolicyInput } from "../../../cadp/deployment/referencePolicy.ts";

export const PEP_REF = "spiffe://cadp-v04/cadp/pep";

export const PRINCIPALS = {
  workflow: { principal: "cadp-workflow" },
  worker: { principal: "cadp-worker-codex" },
  backendScan: { principal: "cadp-backend-scan" },
  reviewer: { principal: "cadp-reviewer-claude" },
  verifier: { principal: "cadp-verifier" },
  human: { principal: "sso:a.t.laplace@gmail.com" },
  depctlProbe: { principal: "cadp-depctl-probe" },
  depctlTarget: { principal: "cadp-depctl-target" },
} satisfies Record<string, Principal>;

/** A scripted governed target: dispatch/reconcile behaviours are injected per test. */
export class ScriptedTarget implements TargetAdapterV1 {
  target_type = "SCRIPTED";
  authority_ref = "scripted:target";
  operations: AdapterOperation[] = [
    {
      operation_kind: "SCRIPTED_WRITE", material_schema: "test.scripted-write.v1", available: true,
      idempotency: "NONE", dispatch_precondition: "NONE", reconcile: "BY_QUERY_PREDICATE", no_effect_proof_supported: true,
    },
    {
      operation_kind: "SCRIPTED_KEYED_WRITE", material_schema: "test.scripted-write.v1", available: true,
      idempotency: "NATIVE_KEY", idempotency_horizon_s: 3600, dispatch_precondition: "NONE", reconcile: "BY_QUERY_PREDICATE", no_effect_proof_supported: true,
    },
  ];

  /** The "target side": committed effects observed at the target, keyed by effect_id|ordinal. */
  readonly committed = new Map<string, Record<string, unknown>>();
  onDispatch: ((effect_id: string, ordinal: number, material: Record<string, unknown>) => DispatchResult) | undefined;
  onReconcile: ((effect_id: string, ordinal: number, material: Record<string, unknown>) => ReconcileResult) | undefined;
  onRevision: ((subject: SubjectBinding) => RevisionRead) | undefined;

  describe() {
    return { target_type: this.target_type, authority_ref: this.authority_ref, operations: this.operations };
  }

  serialization_domain(): string {
    return "scripted-domain";
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    return {
      target_ref: { authority_ref: this.authority_ref, target_type: this.target_type, target_id: "scripted-1" },
      claim: { tenant: "scripted-1" },
    };
  }

  async current_revision(subject: SubjectBinding): Promise<RevisionRead> {
    if (this.onRevision !== undefined) return this.onRevision(subject);
    return { revision_or_version: subject.revision_or_version, availability: "PRESENT" };
  }

  async verify_material(): Promise<void> {}

  async dispatch_precondition_read(): Promise<string | undefined> {
    return undefined;
  }

  async dispatch(effect_id: string, ordinal: number, _t: TargetRef, _op: string, material: Record<string, unknown>): Promise<DispatchResult> {
    const result = this.onDispatch?.(effect_id, ordinal, material) ?? {
      kind: "ACCEPTED" as const,
      target_operation_ref: `scripted-op-${effect_id}-${ordinal}`,
      receipt_claim: { body_digest: material["body_digest"], applied: true },
    };
    if (result.kind === "ACCEPTED") this.committed.set(`${effect_id}`, material);
    return result;
  }

  async reconcile(effect_id: string, ordinal: number, _t: TargetRef, _op: string, material: Record<string, unknown>): Promise<ReconcileResult> {
    if (this.onReconcile !== undefined) return this.onReconcile(effect_id, ordinal, material);
    const seen = this.committed.get(effect_id);
    if (seen !== undefined) {
      return { kind: "COMMITTED", target_operation_ref: `scripted-op-${effect_id}`, receipt_claim: { body_digest: seen["body_digest"], applied: true } };
    }
    return { kind: "NO_EFFECT_CONFIRMED", proof_claim: { authoritative_absence: true, read_authority: "primary" } };
  }

  receipt_binds(_op: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    return receipt["body_digest"] === material["body_digest"];
  }

  targetRef(): TargetRef {
    return { authority_ref: this.authority_ref, target_type: this.target_type, target_id: "scripted-1" };
  }
}

export interface Harness {
  dir: string;
  store: ConstitutionalStore;
  cas: Cas;
  ingress: Ingress;
  pep: Pep;
  reconciler: Reconciler;
  evaluator: OpaEvaluator;
  target: ScriptedTarget;
  root: ReturnType<typeof generateRootKey>;
  policyInput: ReferencePolicyInput;
  clock: { now: number; fn: () => number };
  evaluate(input_digest: string): Promise<EvaluateOutcome>;
  sealReach(alternate?: boolean): void;
  sealTargetIdentity(): Promise<void>;
  close(): void;
}

let sharedEvaluator: OpaEvaluator | undefined;

export interface HarnessOptions {
  paramOverrides?: Record<string, unknown>;
  configOverrides?: ReferencePolicyInput["configOverrides"];
  disabledChecks?: ReadonlySet<string>;
  extraAdapters?: TargetAdapterV1[];
}

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "cadp-h-"));
  const store = new ConstitutionalStore(join(dir, "k04.sqlite"));
  const clockBox = { now: Date.now(), fn: () => clockBox.now };
  // Tests advance a virtual clock but default to wall time to keep OPA freshness real.
  clockBox.fn = () => clockBox.now;
  const tick = () => (clockBox.now = Math.max(clockBox.now + 1, Date.now()));
  const clock = () => tick();
  const cas = new Cas(store, clock);
  const ingress = new Ingress(store, cas, PEP_REF, clock);
  const root = generateRootKey();
  const policyInput: ReferencePolicyInput = {
    policy_id: "cadp-v04:policy:root",
    revision: 1,
    root_public_keys: [
      { key_id: root.key_id, alg: "Ed25519", public_key: root.public_key_base64, valid_from: "2026-01-01T00:00:00.000Z" },
    ],
    paramOverrides: { extra_plain_allow_operations: ["SCRIPTED_WRITE", "SCRIPTED_KEYED_WRITE"], ...options.paramOverrides },
    configOverrides: options.configOverrides,
  };
  const bundle = buildReferenceBundle(policyInput);
  runGenesis(store, cas, {
    bundleBytes: bundle,
    policy_id: "cadp-v04:policy:root",
    rootPrivatePem: root.privatePem,
    rootPublicKeysBase64: [root.public_key_base64],
    pep_identity: PEP_REF,
    secret_path: "secret/cadp-v04/pep",
    clock,
  });

  if (sharedEvaluator === undefined) {
    sharedEvaluator = new OpaEvaluator(mkdtempSync(join(tmpdir(), "cadp-opa-")));
  }
  const evaluator = sharedEvaluator;

  const target = new ScriptedTarget();
  const registry = makeAdapterRegistry([target, ...(options.extraAdapters ?? [])]);
  const pep = new Pep(store, cas, ingress, registry, PEP_REF, clock, options.disabledChecks ?? new Set());
  const reconciler = new Reconciler(store, cas, ingress, pep, registry, clock);

  const harness: Harness = {
    dir, store, cas, ingress, pep, reconciler, evaluator, target, root, policyInput,
    clock: { get now() { return clockBox.now; }, set now(v: number) { clockBox.now = v; }, fn: clock } as Harness["clock"],
    evaluate: (input_digest: string) => evaluateAndSeal(store, cas, ingress, evaluator, input_digest, clock),
    sealReach(alternate = false) {
      ingress.submitEvidence(
        {
          evidence_kind: "CREDENTIAL_REACH_ATTESTATION",
          subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "deployment", object_id: "cadp-v04" }],
          availability: "PRESENT",
          claim_schema: "cadp.credential-reach.v1",
          claim: {
            alternate_path_found: alternate,
            probes: [{ target: "scripted:target", result: alternate ? "http 200 (leaked credential)" : "http 000" }],
            network_policy_digest: "harness",
            secret_acl_digest: "harness",
          },
          producer_ref: "deployment-control-probe",
          source_ref: "deployment-control",
          source_relation: "INDEPENDENT_OBSERVATION",
        },
        PRINCIPALS.depctlProbe,
      );
    },
    async sealTargetIdentity() {
      await pep.refreshTargetIdentity(target);
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

export function stopSharedOpa(): void {
  sharedEvaluator?.stop();
  sharedEvaluator = undefined;
}

/** Seal a scripted-target effect request through the production path. */
export function sealScriptedRequest(
  h: Harness,
  options: {
    effect_id?: string;
    body?: string;
    operation_kind?: string;
    prior_effect_refs?: string[];
    work_run_ref?: string;
  } = {},
) {
  const bodyBytes = Buffer.from(options.body ?? "scripted-body", "utf8");
  const body_digest = require_sha(bodyBytes);
  const body_cas_key = h.ingress.putBlob(bodyBytes);
  const material = {
    tenant: "scripted-1",
    resource_id: "r-1",
    body_digest,
    body_cas_key,
    idempotency_key: "",
  };
  const materialBytes = Buffer.from(JSON.stringify(material), "utf8");
  const material_ref = h.ingress.putBlob(materialBytes);
  const effect_id =
    options.effect_id ??
    h.ingress.allocateEffectId({
      schema: "cadp.allocation-key.v1",
      work_run_ref: options.work_run_ref ?? "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
      step_ordinal: allocationCounter += 1,
      purpose: "record-write",
    });
  const work_bindings = options.work_run_ref === undefined
    ? []
    : [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: options.work_run_ref }];
  const request = h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: "workflow:cadp-work",
      work_bindings,
      target_ref: h.target.targetRef(),
      operation_kind: options.operation_kind ?? "SCRIPTED_WRITE",
      material_schema: "test.scripted-write.v1",
      material_ref,
      prior_effect_refs: options.prior_effect_refs ?? [],
    },
    PRINCIPALS.workflow,
  );
  return { request, material };
}

let allocationCounter = 0;

import { createHash } from "node:crypto";
function require_sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Full positive chain: assemble → evaluate → admit; returns each stage for assertions. */
export async function runChain(h: Harness, effect_id: string, evidence: string[] = []) {
  const input = h.ingress.assembleAdmissionInput(effect_id, evidence);
  const evaluated = await h.evaluate(input.input_digest.value);
  if (evaluated.kind !== "DECISION") return { input, evaluated, admitted: undefined };
  const admitted = await h.pep.admitAndDispatch(effect_id, evaluated.decision.decision_id);
  return { input, evaluated, admitted };
}
