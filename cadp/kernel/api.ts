/**
 * Kernel API surface (TD §12): ten calls, per-method caller matrix keyed by the ACTIVE
 * policy's identity_registry process_class, principals mapped from bearer tokens (the
 * single-host stand-in for mTLS/SPIFFE workload identity — the token file lives in the
 * PEP-owned secret path). The root listener is a SEPARATE server bound to the root
 * identity; the ordinary API rejects GENESIS/BREAK_GLASS unconditionally (C29).
 */

import * as http from "node:http";

import { Cas } from "./cas.ts";
import { evaluateAndSeal } from "./evaluator.ts";
import type { EvaluatorPort } from "./evaluator.ts";
import { Ingress, IngressRejection } from "./ingress.ts";
import type { AllocationTuple, EvidenceDraft, SealRequestBody } from "./ingress.ts";
import { Pep } from "./pep.ts";
import { Reconciler } from "./reconciler.ts";
import { executeRootOperation, RootRejection } from "./rootListener.ts";
import type { BreakGlassDocument } from "./rootListener.ts";
import { digestsEqual, recordDigest } from "./canonical.ts";
import { identityEntry, resolveActivePolicy } from "./policyState.ts";
import type { Sig1 } from "./sig.ts";
import { ConstitutionalStore } from "./store.ts";

export interface ApiDeps {
  store: ConstitutionalStore;
  cas: Cas;
  ingress: Ingress;
  pep: Pep;
  reconciler: Reconciler;
  evaluator: EvaluatorPort;
  /** bearer token → exact principal string. */
  tokens: ReadonlyMap<string, string>;
  clock?: () => number;
}

type ProcessClass = "workflow" | "worker" | "evidence-adapter" | "human-surface" | "deployment-control" | "observer" | string;

/**
 * TD §12 r8: `observer` is the read-only constitutional caller class (#96/#106 B1). Its reach is
 * exactly the four read methods and nothing else — in particular NOT `evaluate` or
 * `assemble_admission_input`, which write K5/K4 rows (#96 review B2): a diagnostic reader must
 * never be able to manufacture the very facts it reports.
 */
const METHOD_REACH: Record<string, readonly ProcessClass[]> = {
  put_blob: ["workflow", "worker", "evidence-adapter", "deployment-control"],
  allocate_effect_id: ["workflow"],
  seal_effect_request: ["workflow"],
  submit_evidence: ["workflow", "worker", "evidence-adapter", "deployment-control", "human-surface", "agent-surface"],
  assemble_admission_input: ["workflow"],
  evaluate: ["workflow"],
  admit_and_dispatch: ["workflow"],
  get_effect_state: ["workflow", "worker", "evidence-adapter", "deployment-control", "human-surface", "agent-surface", "observer"],
  request_reconcile: ["workflow", "deployment-control"],
  list_effects: ["workflow", "observer"],
  get_evidence: ["workflow", "evidence-adapter", "deployment-control", "human-surface", "observer"],
  list_evidence: ["workflow", "deployment-control", "observer"],
};

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function startKernelApi(deps: ApiDeps, port: number): Promise<{ port: number; close(): void }> {
  const server = http.createServer((req, res) => {
    void handle(deps, req, res);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : port,
        close: () => server.close(),
      });
    });
  });
}

async function handle(deps: ApiDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    const method = (req.url ?? "/").replace(/^\//u, "").split("?")[0]!;
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") === true ? auth.slice(7) : undefined;
    const principal = token !== undefined ? deps.tokens.get(token) : undefined;
    if (principal === undefined) return send(401, { error: "UNAUTHENTICATED" });

    // Reach matrix: process_class from the ACTIVE registry (exact match; unregistered rejected).
    const active = resolveActivePolicy(deps.store, deps.cas);
    const identity = identityEntry(active.config, principal);
    if (identity === undefined) return send(403, { error: "FORBIDDEN_FOR_PRINCIPAL", detail: "unregistered principal" });
    const allowed = METHOD_REACH[method];
    if (allowed === undefined) return send(404, { error: "NO_SUCH_METHOD" });
    if (!allowed.includes(identity.identity_class.process_class)) {
      return send(403, { error: "FORBIDDEN_FOR_PRINCIPAL", detail: `${identity.identity_class.process_class} may not call ${method}` });
    }

    const raw = await readBody(req);

    switch (method) {
      case "put_blob": {
        const key = deps.ingress.putBlob(raw);
        return send(200, { cas_key: key });
      }
      case "allocate_effect_id": {
        // AP B1(1): the allocation branch now passes the same authenticated principal the seal and
        // submit branches already do; the Ingress resolves it to the stamped `requester_ref`.
        const tuple = JSON.parse(raw.toString("utf8")) as AllocationTuple;
        return send(200, { effect_id: deps.ingress.allocateEffectId(tuple, { principal }) });
      }
      case "seal_effect_request": {
        // AP B6(1): `allocation_tuple` rides as one optional top-level sibling of the draft keys;
        // the Ingress strips it, so it never reaches `EffectRequestV1` or `request_digest`.
        const body = JSON.parse(raw.toString("utf8")) as SealRequestBody;
        // AP B6(3): the run capability travels as the header `x-cadp-run-capability` — never a body
        // field, never a draft field, never a record field. It is read here, handed to the Ingress
        // in its own transport argument, and written to nothing else: no log line, no trace, no
        // error detail. A repeated header (`string[]` from Node) is not one presented capability
        // and is treated as none, which fails closed at `RUN_CAPABILITY_REQUIRED`.
        const presented = req.headers["x-cadp-run-capability"];
        const transport = typeof presented === "string" ? { run_capability: presented } : {};
        return send(200, deps.ingress.sealEffectRequest(body, { principal }, transport));
      }
      case "submit_evidence": {
        const draft = JSON.parse(raw.toString("utf8")) as EvidenceDraft;
        return send(200, deps.ingress.submitEvidence(draft, { principal }));
      }
      case "assemble_admission_input": {
        const body = JSON.parse(raw.toString("utf8")) as { effect_id: string; evidence_refs: string[] };
        return send(200, deps.ingress.assembleAdmissionInput(body.effect_id, body.evidence_refs));
      }
      case "evaluate": {
        const body = JSON.parse(raw.toString("utf8")) as { input_digest: string };
        const outcome = await evaluateAndSeal(deps.store, deps.cas, deps.ingress, deps.evaluator, body.input_digest, deps.clock);
        return send(200, outcome);
      }
      case "admit_and_dispatch": {
        // AP B5(1)/B6(4): the request body is unchanged at `{ effect_id, decision_id }`; the
        // principal is the one already resolved from `authorization`, never a body field. The
        // result carries the optional `run_capability` field EXACTLY on the verified initial
        // dispatch of a minting `WORK_START` (B6(4)) — and this response is its only channel.
        const body = JSON.parse(raw.toString("utf8")) as { effect_id: string; decision_id: string };
        const result = await deps.pep.admitAndDispatch(body.effect_id, body.decision_id, { principal });
        return send(200, result);
      }
      case "get_effect_state": {
        const body = JSON.parse(raw.toString("utf8")) as { effect_id: string };
        const request = deps.store.effectRequest(body.effect_id);
        if (request === undefined) return send(404, { error: "EFFECT_NOT_FOUND" });
        const inputs = deps.store.admissionInputsByEffect(body.effect_id);
        return send(200, {
          request,
          inputs,
          decisions: deps.store.decisionsByInputDigests(inputs.map((i) => i.input_digest.value)),
          admissions: deps.store.admissionsByEffect(body.effect_id),
          outcomes: deps.store.outcomesByEffect(body.effect_id),
        });
      }
      case "request_reconcile": {
        const body = JSON.parse(raw.toString("utf8")) as { effect_id: string };
        await deps.reconciler.reconcileEffect(body.effect_id);
        return send(200, { ack: true });
      }
      case "list_effects": {
        const body = JSON.parse(raw.toString("utf8")) as { work_run_ref: string };
        return send(200, { effect_ids: deps.store.effectIdsByWorkRun(body.work_run_ref) });
      }
      case "get_evidence": {
        // K2 read (TD §12 r8). Verify-on-read: a stored envelope that no longer recomputes its
        // own digest is corruption, never truth — refused with 409, not served.
        const body = JSON.parse(raw.toString("utf8")) as { evidence_id: string };
        const envelope = deps.store.evidenceById(body.evidence_id);
        if (envelope === undefined) return send(404, { error: "EVIDENCE_NOT_FOUND" });
        const recomputed = recordDigest(envelope as unknown as Record<string, unknown>, "envelope_digest");
        if (!digestsEqual(recomputed, envelope.envelope_digest)) {
          return send(409, { error: "DIGEST_CORRUPTION", detail: `stored envelope ${body.evidence_id} does not recompute` });
        }
        return send(200, { envelope });
      }
      case "list_evidence": {
        // Summaries only; bodies come one at a time through get_evidence's verify-on-read. A 200
        // with an empty list means "this kernel's store holds no such row" — the caller must not
        // read it as universal absence (#96 review B3); a failed call establishes nothing.
        const body = JSON.parse(raw.toString("utf8")) as { work_run_ref: string };
        const subjectKey = `cadp-store:k04|work-run|${body.work_run_ref}`;
        const evidence = deps.store.evidenceBySubjectKey(subjectKey).map((e) => ({
          evidence_id: e.evidence_id,
          evidence_kind: e.evidence_kind,
          availability: e.availability,
          producer_ref: e.producer_ref,
          produced_at: e.produced_at,
          envelope_digest: e.envelope_digest,
        }));
        return send(200, { evidence });
      }
      default:
        return send(404, { error: "NO_SUCH_METHOD" });
    }
  } catch (error) {
    if (error instanceof IngressRejection) {
      return send(422, { error: error.reason, detail: error.message });
    }
    return send(500, { error: "INTERNAL", detail: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Root listener (TD §9.4/§12): separate server, root bearer token only, enabled only while a
 * root operation is being performed. Accepts exactly one method.
 */
export function startRootListener(
  deps: Pick<ApiDeps, "store" | "cas" | "ingress"> & { rootToken: string; clock?: () => number },
  port: number,
): Promise<{ port: number; close(): void }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      try {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${deps.rootToken}`) return send(401, { error: "UNAUTHENTICATED" });
        if ((req.url ?? "") !== "/root/break_glass") return send(404, { error: "NO_SUCH_METHOD" });
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString("utf8")) as { document: BreakGlassDocument; signature: Sig1 };
        const result = executeRootOperation(deps.store, deps.cas, deps.ingress, body.document, body.signature, deps.clock);
        return send(200, result);
      } catch (error) {
        if (error instanceof RootRejection) return send(422, { error: error.reason, detail: error.message });
        return send(500, { error: "INTERNAL", detail: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : port,
        close: () => server.close(),
      });
    });
  });
}
