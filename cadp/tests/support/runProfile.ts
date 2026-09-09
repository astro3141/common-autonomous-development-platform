/**
 * Shared fixtures for the AP B5 run-profile lanes: the `cadp.allocation-key.run-origin.v1` contract
 * as bundle data, a `WORK_START`-capable scripted target, and the seal/dispatch helpers both the
 * run-origin (PART 1) and run-capability (PART 2) conformance files run against.
 *
 * One module so the two files cannot drift into two compositions: PART 2's presentation legs are
 * only meaningful against the SAME registry content, the same enrolled `requester_ref` domain and
 * the same origin seal that PART 1's witness and minting legs were established on.
 */

import assert from "node:assert/strict";

import type { Principal } from "../../kernel/ingress.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA } from "../../kernel/policyBundle.ts";
import type { AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim } from "../../kernel/adapters/types.ts";
import type { SubjectBinding, TargetRef } from "../../kernel/records.ts";
import { REFERENCE_IDENTITIES } from "../../deployment/referencePolicy.ts";
import { PRINCIPALS, V2_ALLOCATION_SCHEMAS, V2_ALLOCATION_SCHEMA_DESCRIPTORS, makeHarness, v2ConfigOverrides } from "./harness.ts";
import type { Harness } from "./harness.ts";

/** The reference run-profile holder (WP §5.2): the Temporal-backed `workflow:cadp-work`. */
export const REQUESTER_A = "workflow:cadp-work";

/** A second registered `workflow`-class requester — the "other holder" of every borrowing leg. */
export const REQUESTER_B = "workflow:cadp-work-b";
export const PRINCIPAL_B: Principal = { principal: "cadp-workflow-b" };
export const IDENTITY_B = {
  principal: "cadp-workflow-b",
  producer_ref: REQUESTER_B,
  identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" },
};

/** A third registered `workflow`-class requester, enrolled by NO fixture — the B5(3) outsider. */
export const REQUESTER_C = "workflow:cadp-work-c";
export const PRINCIPAL_C: Principal = { principal: "cadp-workflow-c" };
export const IDENTITY_C = {
  principal: "cadp-workflow-c",
  producer_ref: REQUESTER_C,
  identity_class: { vendor: "temporalio", product: "temporal-workflow", account: "cadp-v04", process_class: "workflow" },
};

/** AP B3(4)(a): the authority the fixture bundles declare for the kernel work-run namespace. */
export const WORK_RUN_AUTHORITY = "cadp-store:k04";

/**
 * WP §3.6's wire shape as bundle data: exactly `{schema, origin_key, purpose}`, `origin_key` the
 * single non-reserved field with role ENTROPY and value contract NONEMPTY_STRING. The Kernel holds
 * no canonical copy of this — it is the schema owner's, carried by the bundle (AP B2(2)(i)).
 */
export const RUN_ORIGIN_DESCRIPTOR = {
  schema: RUN_ORIGIN_ALLOCATION_SCHEMA,
  fields: [{ field: "origin_key", role: "ENTROPY", value_contract: "NONEMPTY_STRING" }],
};

/** `binding_projection: []` (nothing is PROJECTED) and the one fixed `work-start`↔`WORK_START` pair. */
export const RUN_ORIGIN_MAPPING = {
  schema: RUN_ORIGIN_ALLOCATION_SCHEMA,
  binding_projection: [] as ReadonlyArray<{ tuple_field: string; authority_ref: string; namespace: string }>,
  purpose_relation: [{ purpose: "work-start", operation_kind: "WORK_START" }],
};

/** A `WORK_START`-capable target, so an origin can be admitted and dispatched through the real PEP. */
export class WorkStartTarget implements TargetAdapterV1 {
  readonly target_type = "WORKFLOW";

  readonly authority_ref = "temporal:cadp-v04";

  /** Returning `undefined` for an ordinal falls back to the adapter's own binding ACCEPTED result. */
  onDispatch: ((effect_id: string, ordinal: number) => DispatchResult | undefined) | undefined;

  describe(): { target_type: string; authority_ref: string; operations: readonly AdapterOperation[] } {
    return {
      target_type: this.target_type,
      authority_ref: this.authority_ref,
      operations: [
        {
          operation_kind: "WORK_START", material_schema: "cadp.work-start.v1", available: true,
          idempotency: "NONE", dispatch_precondition: "NONE", reconcile: "BY_QUERY_PREDICATE",
          no_effect_proof_supported: true,
        },
      ],
    };
  }

  serialization_domain(): string {
    return "work-start-domain";
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    return { target_ref: this.targetRef(), claim: { namespace: "cadp-v04" } };
  }

  async current_revision(subject: SubjectBinding): Promise<RevisionRead> {
    return { revision_or_version: subject.revision_or_version, availability: "PRESENT" };
  }

  async verify_material(): Promise<void> {}

  async dispatch_precondition_read(): Promise<string | undefined> {
    return undefined;
  }

  async dispatch(effect_id: string, ordinal: number, _t: TargetRef, _op: string, material: Record<string, unknown>): Promise<DispatchResult> {
    return this.onDispatch?.(effect_id, ordinal) ?? {
      kind: "ACCEPTED",
      target_operation_ref: `wf-${effect_id}-${ordinal}`,
      receipt_claim: { workflow_id: material["workflow_id"], started: true },
    };
  }

  async reconcile(effect_id: string, _o: number, _t: TargetRef, _op: string, material: Record<string, unknown>): Promise<ReconcileResult> {
    return { kind: "COMMITTED", target_operation_ref: `wf-${effect_id}`, receipt_claim: { workflow_id: material["workflow_id"], started: true } };
  }

  receipt_binds(_op: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    return receipt["workflow_id"] === material["workflow_id"];
  }

  targetRef(): TargetRef {
    return { authority_ref: this.authority_ref, target_type: this.target_type, target_id: "cadp-v04" };
  }
}

/** The v2 config these lanes need: the run-origin contract registered, requester A enrolled. */
export function runProfileConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return v2ConfigOverrides({
    allocation_schema_descriptors: [...V2_ALLOCATION_SCHEMA_DESCRIPTORS, RUN_ORIGIN_DESCRIPTOR],
    allocation_schemas: [...V2_ALLOCATION_SCHEMAS, RUN_ORIGIN_MAPPING],
    run_profile_enrolled_requester_refs: [REQUESTER_A],
    ...overrides,
  });
}

export interface RunProfileHarness {
  h: Harness;
  target: WorkStartTarget;
}

export async function runProfileHarness(
  configOverrides: Record<string, unknown> = runProfileConfig(),
  disabledChecks?: ReadonlySet<string>,
  disabledIngressRules?: ReadonlySet<string>,
): Promise<RunProfileHarness> {
  const target = new WorkStartTarget();
  const h = await makeHarness({
    identityRegistry: [...REFERENCE_IDENTITIES, IDENTITY_B, IDENTITY_C],
    extraAdapters: [target],
    configOverrides: configOverrides as never,
    ...(disabledChecks === undefined ? {} : { disabledChecks }),
    ...(disabledIngressRules === undefined ? {} : { disabledIngressRules }),
  });
  h.sealReach();
  await h.sealTargetIdentity();
  await h.pep.refreshTargetIdentity(target);
  return { h, target };
}

let originCounter = 0;
let stepCounter = 0;

/** Allocate under `run-origin.v1` and seal the `WORK_START` it names, self-bound unless told otherwise. */
export function sealWorkStart(
  rp: RunProfileHarness,
  options: {
    origin_key?: string;
    principal?: Principal;
    requester_ref?: string;
    /** The `work-run` binding's `object_id`; defaults to the request's OWN effect_id (leg 3). */
    work_run_ref?: string;
    authority_ref?: string;
    /** Omit the `work-run` binding entirely — B5(9) leg 2's "none" case (B5(3)). */
    unbound?: boolean;
    /** AP B6(3) transport: presented as the `x-cadp-run-capability` header would be. */
    capability?: string;
  } = {},
): { effect_id: string; tuple: Record<string, unknown> } {
  const { h, target } = rp;
  const principal = options.principal ?? PRINCIPALS.workflow;
  const tuple = {
    schema: RUN_ORIGIN_ALLOCATION_SCHEMA,
    origin_key: options.origin_key ?? `origin-${(originCounter += 1)}`,
    purpose: "work-start",
  };
  const effect_id = h.ingress.allocateEffectId(tuple, principal);
  const material = {
    workflow_id: `cadp-work-${effect_id}`,
    workflow_type: "cadpWork",
    task_queue: "cadp-worker",
    bounds: { max_steps: 8, max_effects: 6 },
  };
  h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: options.requester_ref ?? REQUESTER_A,
      work_bindings: options.unbound === true ? [] : [{
        authority_ref: options.authority_ref ?? WORK_RUN_AUTHORITY,
        namespace: "work-run",
        object_id: options.work_run_ref ?? effect_id,
      }],
      target_ref: target.targetRef(),
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
      prior_effect_refs: [],
      allocation_tuple: tuple,
    },
    principal,
    options.capability === undefined ? {} : { run_capability: options.capability },
  );
  return { effect_id, tuple };
}

/**
 * Seal an ORDINARY run-bound request — a `SCRIPTED_WRITE` on the harness's scripted target,
 * allocated under `cadp.allocation-key.v1`, whose PROJECTED `work_run_ref` is the run it names. This
 * is B5(4)'s member path: not `WORK_START`-shaped, so B5(9) never adjudicates it and it must
 * present a capability for the run it binds.
 */
export function sealRunBound(
  rp: RunProfileHarness,
  options: {
    work_run_ref: string;
    /** AP B6(3) transport: the presented `x-cadp-run-capability` value, or none. */
    capability?: string;
    principal?: Principal;
    requester_ref?: string;
    body?: string;
    /** Re-seal an existing `effect_id` instead of allocating a fresh one (K3 idempotency). */
    effect_id?: string;
    allocated_work_run_ref?: string;
  },
): { effect_id: string } {
  const { h } = rp;
  const principal = options.principal ?? PRINCIPALS.workflow;
  const bodyBytes = Buffer.from(options.body ?? "run-bound-body", "utf8");
  const tuple = {
    schema: "cadp.allocation-key.v1",
    work_run_ref: options.allocated_work_run_ref ?? options.work_run_ref,
    step_ordinal: (stepCounter += 1),
    purpose: "record-write",
  };
  const effect_id = options.effect_id ?? h.ingress.allocateEffectId(tuple, principal);
  const material = { tenant: "scripted-1", resource_id: "r-1", body_cas_key: h.ingress.putBlob(bodyBytes) };
  h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: options.requester_ref ?? REQUESTER_A,
      work_bindings: [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: options.work_run_ref }],
      target_ref: h.target.targetRef(),
      operation_kind: "SCRIPTED_WRITE",
      material_schema: "test.scripted-write.v1",
      material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
      prior_effect_refs: [],
      ...(options.effect_id === undefined ? { allocation_tuple: tuple } : {}),
    },
    principal,
    options.capability === undefined ? {} : { run_capability: options.capability },
  );
  return { effect_id };
}

/** assemble → evaluate → admit, with the caller the dispatch equality of B5(1) is checked against. */
export async function dispatch(h: Harness, effect_id: string, caller?: Principal) {
  const input = h.ingress.assembleAdmissionInput(effect_id, []);
  const evaluated = await h.evaluate(input.input_digest.value);
  assert.equal(evaluated.kind, "DECISION", `expected a decision for ${effect_id}`);
  const decision = (evaluated as { decision: { decision_id: string; outcome: string } }).decision;
  assert.equal(decision.outcome, "ALLOW", `expected ALLOW for ${effect_id}`);
  return h.pep.admitAndDispatch(effect_id, decision.decision_id, caller);
}

export function count(h: Harness, table: string): number {
  return (h.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * A COMMITTED origin run and the one-shot capability its initial dispatch delivered (AP B5(1)) —
 * what an enrolled requester needs before it may seal ANY other run-bound request (B5(3)/B5(4)).
 */
export async function originRun(
  rp: RunProfileHarness,
  origin_key: string,
  caller: Principal = PRINCIPALS.workflow,
  requester_ref: string = REQUESTER_A,
): Promise<{ effect_id: string; capability: string }> {
  const { effect_id } = sealWorkStart(rp, { origin_key, principal: caller, requester_ref });
  const admitted = await dispatch(rp.h, effect_id, caller);
  assert.equal(admitted.kind, "ADMITTED", JSON.stringify(admitted));
  assert.equal((admitted as { outcome: { result: string } }).outcome.result, "COMMITTED");
  const capability = (admitted as { run_capability?: string }).run_capability;
  assert.equal(typeof capability, "string", "the origin's initial dispatch delivers exactly once");
  return { effect_id, capability: capability! };
}
