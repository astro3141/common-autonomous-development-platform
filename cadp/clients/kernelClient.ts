/** HTTP client for the Kernel API (TD §12) used by workflow activities, adapters and tests. */

import type { AllocationTuple, EvidenceDraft, SealRequestBody } from "../kernel/ingress.ts";
import type {
  AdmissionInputV1, EffectAdmissionV1, EffectOutcomeV1, EffectRequestV1, EvidenceEnvelopeV1, PolicyDecisionV1,
} from "../kernel/records.ts";

export interface EffectState {
  request: EffectRequestV1;
  inputs: AdmissionInputV1[];
  decisions: PolicyDecisionV1[];
  admissions: EffectAdmissionV1[];
  outcomes: EffectOutcomeV1[];
}

export class KernelApiError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string, detail?: string) {
    super(`kernel api ${status} ${reason}${detail !== undefined ? `: ${detail}` : ""}`);
    this.status = status;
    this.reason = reason;
  }
}

export class KernelClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async #call<T>(method: string, body: Uint8Array | unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const isRaw = body instanceof Uint8Array;
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": isRaw ? "application/octet-stream" : "application/json",
        ...extraHeaders,
      },
      body: isRaw ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
    });
    const json = (await res.json()) as T & { error?: string; detail?: string };
    if (res.status >= 400) throw new KernelApiError(res.status, json.error ?? "UNKNOWN", json.detail);
    return json;
  }

  putBlob(bytes: Uint8Array): Promise<{ cas_key: string }> {
    return this.#call("put_blob", bytes);
  }

  allocateEffectId(tuple: AllocationTuple): Promise<{ effect_id: string }> {
    return this.#call("allocate_effect_id", tuple);
  }

  /**
   * AP B6(1): `allocation_tuple` rides as an optional top-level sibling, never as a draft field.
   * AP B6(3): the run capability rides as the `x-cadp-run-capability` HEADER — base64url unpadded
   * of the raw 32 secret bytes — and never as a body or draft field. It is passed in its own
   * argument for exactly that reason, and this client writes it nowhere else.
   */
  sealEffectRequest(body: SealRequestBody, run_capability?: string): Promise<EffectRequestV1> {
    return this.#call("seal_effect_request", body, run_capability === undefined ? {} : { "x-cadp-run-capability": run_capability });
  }

  submitEvidence(draft: EvidenceDraft): Promise<EvidenceEnvelopeV1> {
    return this.#call("submit_evidence", draft);
  }

  assembleAdmissionInput(effect_id: string, evidence_refs: string[]): Promise<AdmissionInputV1> {
    return this.#call("assemble_admission_input", { effect_id, evidence_refs });
  }

  evaluate(input_digest: string): Promise<
    | { kind: "DECISION"; decision: PolicyDecisionV1 }
    | { kind: "POLICY_NOT_ACTIVE" }
    | { kind: "EVALUATION_UNAVAILABLE"; detail: string }
  > {
    return this.#call("evaluate", { input_digest });
  }

  /**
   * AP B5(1)/B6(4): the body is unchanged at `{ effect_id, decision_id }` — the principal is the
   * bearer token's, resolved by the kernel. `run_capability` is present on the result EXACTLY on
   * the verified initial dispatch of a run-capability-minting `WORK_START`, and this result is its
   * ONLY delivery: nothing re-delivers it, so a caller that drops it cannot recover it (B5(7)).
   */
  admitAndDispatch(effect_id: string, decision_id: string): Promise<
    | { kind: "ADMITTED"; admission: EffectAdmissionV1; outcome: EffectOutcomeV1; run_capability?: string }
    | { kind: "REFUSAL"; reason: string; detail?: string }
  > {
    return this.#call("admit_and_dispatch", { effect_id, decision_id });
  }

  getEffectState(effect_id: string): Promise<EffectState> {
    return this.#call("get_effect_state", { effect_id });
  }

  requestReconcile(effect_id: string): Promise<{ ack: boolean }> {
    return this.#call("request_reconcile", { effect_id });
  }

  listEffects(work_run_ref: string): Promise<{ effect_ids: string[] }> {
    return this.#call("list_effects", { work_run_ref });
  }

  /** K2 read (TD §12 r8); the kernel refuses with 409 DIGEST_CORRUPTION instead of serving a corrupted row. */
  getEvidence(evidence_id: string): Promise<{ envelope: EvidenceEnvelopeV1 }> {
    return this.#call("get_evidence", { evidence_id });
  }

  /** Envelope summaries bound to a work run. An empty list is this store's answer, not universal absence. */
  listEvidence(work_run_ref: string): Promise<{
    evidence: Array<Pick<EvidenceEnvelopeV1, "evidence_id" | "evidence_kind" | "availability" | "producer_ref" | "produced_at" | "envelope_digest">>;
  }> {
    return this.#call("list_evidence", { work_run_ref });
  }
}
