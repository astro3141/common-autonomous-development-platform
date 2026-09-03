/**
 * Record-service TargetAdapterV1 (TD §6.4 non-development reference): `RECORD_WRITE` with
 * `NATIVE_KEY` idempotency (`cadp-v04:<effect_id>`), authoritative primary read for both
 * COMMITTED and NO_EFFECT_CONFIRMED proofs. The governed credential (API base URL stands in
 * for the API key custody seam in the single-host harness) is held by this adapter inside
 * the PEP only.
 */

import * as http from "node:http";

import { Cas } from "../cas.ts";
import type { SubjectBinding, TargetRef } from "../records.ts";
import { MaterialIncomplete } from "./types.ts";
import type {
  AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
} from "./types.ts";

interface HttpReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: unknown;
}

class TransportAmbiguous extends Error {}

function request(baseUrl: string, method: string, path: string, body?: unknown, timeout_ms = 5000): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: { "content-type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, json: text.length > 0 ? JSON.parse(text) : undefined });
          } catch {
            reject(new TransportAmbiguous(`unparseable body (status ${res.statusCode})`));
          }
        });
      },
    );
    req.on("error", (error) => reject(new TransportAmbiguous(`transport: ${error.message}`)));
    req.setTimeout(timeout_ms, () => {
      req.destroy();
      reject(new TransportAmbiguous("timeout"));
    });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

export class RecordServiceAdapter implements TargetAdapterV1 {
  readonly baseUrl: string;
  readonly cas: Cas;
  readonly tenant: string;

  constructor(baseUrl: string, cas: Cas, tenant = "cadp-disposable") {
    this.baseUrl = baseUrl;
    this.cas = cas;
    this.tenant = tenant;
  }

  describe(): { target_type: string; authority_ref: string; operations: readonly AdapterOperation[] } {
    return {
      target_type: "RECORD_SERVICE",
      authority_ref: "record-service:disposable",
      operations: [
        {
          operation_kind: "RECORD_WRITE",
          material_schema: "cadp.record-write.v1",
          available: true,
          idempotency: "NATIVE_KEY",
          dispatch_precondition: "NONE",
          reconcile: "BY_QUERY_PREDICATE",
          no_effect_proof_supported: true,
        },
      ],
    };
  }

  serialization_domain(material: Record<string, unknown>): string {
    return `record-service:${String(material["tenant"])}`;
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    const reply = await request(this.baseUrl, "GET", "/whoami");
    if (reply.status !== 200) throw new Error(`whoami ${reply.status}`);
    const claim = reply.json as { tenant: string; principal: string };
    return {
      target_ref: { authority_ref: "record-service:disposable", target_type: "RECORD_SERVICE", target_id: claim.tenant },
      claim: { tenant: claim.tenant, principal: claim.principal },
    };
  }

  async current_revision(_subject: SubjectBinding): Promise<RevisionRead> {
    return { availability: "UNKNOWN" };
  }

  async verify_material(operation_kind: string, material: Record<string, unknown>): Promise<void> {
    if (operation_kind !== "RECORD_WRITE") return;
    const key = material["body_cas_key"];
    if (typeof key !== "string") throw new MaterialIncomplete("RECORD_WRITE material requires body_cas_key");
    const bytes = this.cas.get(key); // throws CasMissing/CasCorruption → pre-K6 refusal by the PEP
    const digest = material["body_digest"];
    if (typeof digest !== "string" || digest !== sha256(bytes)) {
      throw new MaterialIncomplete("body bytes do not re-digest to material.body_digest");
    }
  }

  async dispatch_precondition_read(): Promise<string | undefined> {
    return undefined;
  }

  async dispatch(
    effect_id: string,
    _ordinal: number,
    _target: TargetRef,
    _operation: string,
    material: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const bytes = this.cas.get(String(material["body_cas_key"]));
    let reply: HttpReply;
    try {
      reply = await request(this.baseUrl, "PUT", "/records", {
        tenant: material["tenant"],
        resource_id: material["resource_id"],
        idempotency_key: material["idempotency_key"],
        body_base64: Buffer.from(bytes).toString("base64"),
      });
    } catch (error) {
      return { kind: "AMBIGUOUS", raw_observation: error instanceof Error ? error.message : String(error) };
    }
    if (reply.status === 201 || reply.status === 200) {
      const receipt = reply.json as Record<string, unknown>;
      return { kind: "ACCEPTED", target_operation_ref: `record:${receipt["record_id"]}`, receipt_claim: receipt };
    }
    if (reply.status === 422) {
      // Target-authoritative validated rejection before any effect.
      return { kind: "REJECTED_NO_EFFECT", proof_claim: reply.json as Record<string, unknown> };
    }
    return { kind: "AMBIGUOUS", raw_observation: `status ${reply.status}` };
  }

  async reconcile(
    _effect_id: string,
    _ordinal: number,
    _target: TargetRef,
    _operation: string,
    material: Record<string, unknown>,
  ): Promise<ReconcileResult> {
    const key = String(material["idempotency_key"]);
    let reply: HttpReply;
    try {
      reply = await request(this.baseUrl, "GET", `/records?idempotency_key=${encodeURIComponent(key)}`);
    } catch (error) {
      return { kind: "UNKNOWN", unknown_reason: `reconcile read failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (reply.status !== 200) return { kind: "UNKNOWN", unknown_reason: `reconcile read status ${reply.status}` };
    // §6.4: absence proof requires the primary read authority header; otherwise UNKNOWN (C10).
    const authority = reply.headers["x-read-authority"];
    const body = reply.json as { records: Array<Record<string, unknown>>; write_log: Array<unknown> };
    if (body.records.length === 1) {
      const record = body.records[0]!;
      return { kind: "COMMITTED", target_operation_ref: `record:${record["record_id"]}`, receipt_claim: record };
    }
    if (body.records.length === 0) {
      if (authority !== "primary") return { kind: "UNKNOWN", unknown_reason: "absence read not served from primary" };
      if (body.write_log.length > 0) return { kind: "UNKNOWN", unknown_reason: "write_log shows an in-flight write for the key" };
      return { kind: "NO_EFFECT_CONFIRMED", proof_claim: { idempotency_key: key, records: 0, write_log: 0, read_authority: "primary" } };
    }
    return { kind: "UNKNOWN", unknown_reason: `key matched ${body.records.length} records` };
  }

  receipt_binds(_operation: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    // §6.4 receipt binding: body_digest in the receipt is a function of the material bytes.
    return receipt["body_digest"] === material["body_digest"] && receipt["idempotency_key"] === material["idempotency_key"];
  }
}

import { createHash } from "node:crypto";
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
