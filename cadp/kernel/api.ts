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
import type { AllocationTuple, EvidenceDraft, RequestDraft } from "./ingress.ts";
import { Pep } from "./pep.ts";
import { Reconciler } from "./reconciler.ts";
import { executeRootOperation, RootRejection } from "./rootListener.ts";
import type { BreakGlassDocument } from "./rootListener.ts";
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

type ProcessClass = "workflow" | "worker" | "evidence-adapter" | "human-surface" | "deployment-control" | string;

const METHOD_REACH: Record<string, readonly ProcessClass[]> = {
  put_blob: ["workflow", "worker", "evidence-adapter", "deployment-control"],
  allocate_effect_id: ["workflow"],
  seal_effect_request: ["workflow"],
  submit_evidence: ["workflow", "worker", "evidence-adapter", "deployment-control", "human-surface"],
  assemble_admission_input: ["workflow"],
  evaluate: ["workflow"],
  admit_and_dispatch: ["workflow"],
  get_effect_state: ["workflow", "worker", "evidence-adapter", "deployment-control", "human-surface"],
  request_reconcile: ["workflow", "deployment-control"],
  list_effects: ["workflow", "worker"],
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
        const tuple = JSON.parse(raw.toString("utf8")) as AllocationTuple;
        return send(200, { effect_id: deps.ingress.allocateEffectId(tuple) });
      }
      case "seal_effect_request": {
        const draft = JSON.parse(raw.toString("utf8")) as RequestDraft;
        return send(200, deps.ingress.sealEffectRequest(draft, { principal }));
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
        const body = JSON.parse(raw.toString("utf8")) as { effect_id: string; decision_id: string };
        const result = await deps.pep.admitAndDispatch(body.effect_id, body.decision_id);
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
