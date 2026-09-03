/**
 * In-process reference composition for the conformance suite (TD §13): real store (SQLite
 * harness), real CAS, real OPA sidecar evaluator, real kernel components; the target is a
 * scripted TargetAdapterV1 whose behaviours are controlled per test (fault injection at the
 * transport seam — the kernel path stays the production path).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cas } from "../../kernel/cas.ts";
import { Ingress } from "../../kernel/ingress.ts";
import type { Principal } from "../../kernel/ingress.ts";
import { OpaEvaluator, evaluateAndSeal } from "../../kernel/evaluator.ts";
import type { EvaluateOutcome } from "../../kernel/evaluator.ts";
import { Pep } from "../../kernel/pep.ts";
import { Reconciler } from "../../kernel/reconciler.ts";
import { runGenesis } from "../../kernel/genesis.ts";
import { generateRootKey } from "../../kernel/sig.ts";
import { ConstitutionalStore } from "../../kernel/store.ts";
import { makeAdapterRegistry } from "../../kernel/adapters/types.ts";
import type {
  AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
} from "../../kernel/adapters/types.ts";
import type { EvidenceEnvelopeV1, SubjectBinding, TargetRef } from "../../kernel/records.ts";
import { StorePolicyAdapter } from "../../kernel/adapters/storePolicy.ts";
import { rawDigest, jcsDigest } from "../../kernel/canonical.ts";
import { buildReferenceBundle, buildReferenceKernelConfig } from "../../deployment/referencePolicy.ts";
import type { ReferencePolicyInput } from "../../deployment/referencePolicy.ts";

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
    {
      operation_kind: "SCRIPTED_GUARDED_WRITE", material_schema: "test.scripted-write.v1", available: true,
      idempotency: "NONE", dispatch_precondition: "PEP_READ_THEN_ACT", reconcile: "BY_QUERY_PREDICATE", no_effect_proof_supported: true,
    },
  ];

  /** The "target side": committed effects observed at the target, keyed by effect_id|ordinal. */
  readonly committed = new Map<string, Record<string, unknown>>();
  /** Every transport call that REACHED the target and took effect (external-effect delta). */
  readonly effects: string[] = [];
  onPreconditionRead: (() => string | undefined) | undefined;
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
    return this.onPreconditionRead?.();
  }

  async dispatch(effect_id: string, ordinal: number, _t: TargetRef, op: string, material: Record<string, unknown>): Promise<DispatchResult> {
    // NATIVE_KEY target-side dedup: same idempotency key never takes effect twice.
    if (op === "SCRIPTED_KEYED_WRITE" && this.committed.has(effect_id)) {
      const result = this.onDispatch?.(effect_id, ordinal, material);
      if (result !== undefined && result.kind !== "ACCEPTED") return result;
      return {
        kind: "ACCEPTED",
        target_operation_ref: `scripted-op-${effect_id}-dedup`,
        receipt_claim: { body_digest: material["body_digest"], applied: true, deduplicated: true },
      };
    }
    const result = this.onDispatch?.(effect_id, ordinal, material) ?? {
      kind: "ACCEPTED" as const,
      target_operation_ref: `scripted-op-${effect_id}-${ordinal}`,
      receipt_claim: { body_digest: material["body_digest"], applied: true },
    };
    if (result.kind === "ACCEPTED") {
      this.committed.set(`${effect_id}`, material);
      this.effects.push(effect_id);
    }
    return result;
  }

  /** Target-side commit used by fault-injection scripts (the call took effect even if the reply was lost). */
  commitSilently(effect_id: string, material: Record<string, unknown>): void {
    this.committed.set(effect_id, material);
    this.effects.push(effect_id);
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
  humanApprove(effect_id: string): EvidenceEnvelopeV1;
  activatePolicy(input: { revision: number; paramOverrides?: Record<string, unknown>; configOverrides?: ReferencePolicyInput["configOverrides"]; rego?: string; expectedSeqOverride?: number }): Promise<{ admitted: unknown; bundle: Uint8Array; effect_id: string }>;
  close(): void;
}

let sharedEvaluator: OpaEvaluator | undefined;

export interface HarnessOptions {
  paramOverrides?: Record<string, unknown>;
  configOverrides?: ReferencePolicyInput["configOverrides"];
  disabledChecks?: ReadonlySet<string>;
  extraAdapters?: TargetAdapterV1[];
  rego?: string;
  extraRootPublicKeys?: Array<{ key_id: string; alg: "Ed25519"; public_key: string; valid_from: string; valid_to?: string }>;
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
      ...(options.extraRootPublicKeys ?? []),
    ],
    paramOverrides: { extra_plain_allow_operations: ["SCRIPTED_WRITE", "SCRIPTED_KEYED_WRITE", "SCRIPTED_GUARDED_WRITE"], ...options.paramOverrides },
    configOverrides: options.configOverrides,
    rego: options.rego,
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
  const storePolicyAdapter = new StorePolicyAdapter(store, cas, ingress, clock);
  const registry = makeAdapterRegistry([target, storePolicyAdapter, ...(options.extraAdapters ?? [])]);
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
      await pep.refreshTargetIdentity(storePolicyAdapter);
    },
    humanApprove(effect_id: string): EvidenceEnvelopeV1 {
      const request = store.effectRequest(effect_id);
      if (request === undefined) throw new Error(`no request ${effect_id}`);
      return ingress.submitEvidence(
        {
          evidence_kind: "HUMAN_DECISION",
          subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: effect_id }],
          availability: "PRESENT",
          claim_schema: "cadp.human-decision.v1",
          claim: {
            principal: "sso:a.t.laplace@gmail.com",
            decision: "APPROVE",
            scope: { effect_id, target_ref: request.target_ref, material_digest: request.material_digest.value },
            presented_request_digest: request.request_digest,
            statement: "approved in conformance harness",
            issued_at: new Date(clock()).toISOString(),
          },
          producer_ref: "human:astro3141",
          source_ref: "sso-approval-page",
          source_relation: "INDEPENDENT_OBSERVATION",
        },
        PRINCIPALS.human,
      );
    },
    async activatePolicy(input) {
      const bundleB = buildReferenceBundle({
        ...policyInput,
        revision: input.revision,
        paramOverrides: { ...policyInput.paramOverrides, ...input.paramOverrides },
        configOverrides: { ...policyInput.configOverrides, ...input.configOverrides },
        rego: input.rego ?? policyInput.rego,
      });
      const bundle_cas_ref = ingress.putBlob(bundleB);
      const active = store.activeActivation()!;
      const material = {
        proposed_policy_ref: {
          policy_id: "cadp-v04:policy:root",
          revision: input.revision,
          content_digest: rawDigest(bundleB),
          issuer_ref: "workflow:cadp-work",
        },
        bundle_cas_ref,
        expected_active_policy_ref: {
          policy_id: active.policy_id,
          revision: active.revision,
          content_digest: { algorithm: "sha256", canonicalization: "raw-bytes-1", value: active.content_digest },
          seq: input.expectedSeqOverride ?? active.seq,
        },
      };
      const material_ref = ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
      const effect_id = ingress.allocateEffectId({
        schema: "cadp.allocation-key.v1",
        work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
        step_ordinal: (allocationCounter += 1),
        purpose: "policy-activate",
      });
      ingress.sealEffectRequest(
        {
          effect_id,
          requester_ref: "workflow:cadp-work",
          work_bindings: [],
          target_ref: { authority_ref: "cadp-store:k04", target_type: "POLICY_ACTIVATION", target_id: "k04" },
          operation_kind: "POLICY_ACTIVATE",
          material_schema: "cadp.policy-activate.v1",
          material_ref,
          prior_effect_refs: [],
        },
        PRINCIPALS.workflow,
      );
      const human = harness.humanApprove(effect_id);
      const inputRec = ingress.assembleAdmissionInput(effect_id, [human.evidence_id]);
      const evaluated = await harness.evaluate(inputRec.input_digest.value);
      if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
        return { admitted: { kind: "NOT_ALLOWED", evaluated }, bundle: bundleB, effect_id };
      }
      const admitted = await pep.admitAndDispatch(effect_id, evaluated.decision.decision_id);
      return { admitted, bundle: bundleB, effect_id };
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
  const effect_id =
    options.effect_id ??
    h.ingress.allocateEffectId({
      schema: "cadp.allocation-key.v1",
      work_run_ref: options.work_run_ref ?? "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
      step_ordinal: allocationCounter += 1,
      purpose: "record-write",
    });
  const material: Record<string, unknown> = {
    tenant: "scripted-1",
    resource_id: "r-1",
    body_digest,
    body_cas_key,
  };
  if ((options.operation_kind ?? "SCRIPTED_WRITE") === "SCRIPTED_KEYED_WRITE") {
    material["idempotency_key"] = `cadp-v04:${effect_id}`;
  }
  const materialBytes = Buffer.from(JSON.stringify(material), "utf8");
  const material_ref = h.ingress.putBlob(materialBytes);
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
