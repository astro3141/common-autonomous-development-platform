/** HTTP client for the Kernel API (TD §12) used by workflow activities, adapters and tests. */

import type { AllocationTuple, EvidenceDraft, RequestDraft } from "../kernel/ingress.ts";
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

  async #call<T>(method: string, body: Uint8Array | unknown): Promise<T> {
    const isRaw = body instanceof Uint8Array;
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": isRaw ? "application/octet-stream" : "application/json",
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

  sealEffectRequest(draft: RequestDraft): Promise<EffectRequestV1> {
    return this.#call("seal_effect_request", draft);
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

  admitAndDispatch(effect_id: string, decision_id: string): Promise<
    | { kind: "ADMITTED"; admission: EffectAdmissionV1; outcome: EffectOutcomeV1 }
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
}
