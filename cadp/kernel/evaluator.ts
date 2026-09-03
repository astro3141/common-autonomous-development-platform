/**
 * D4 — policy evaluator integration (TD §5). Reference: OPA sidecar on a unix socket,
 * bundle served by the PEP from CAS bytes (`persist: false`, no external bundle server).
 * The Sealer refuses to seal without the four-part integrity proof (§5.2). Evaluator
 * failure produces NO PolicyDecisionV1 (§5.3).
 */

import { spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { join } from "node:path";

import { Cas } from "./cas.ts";
import { jcs, jcsDigest, nowIso, recordDigest, sha256Hex } from "./canonical.ts";
import { newId } from "./ids.ts";
import { Ingress, IngressRejection } from "./ingress.ts";
import { resolveActivePolicy } from "./policyState.ts";
import type { ActivePolicy } from "./policyState.ts";
import { validatePolicyDecision } from "./records.ts";
import type { AdmissionInputV1, Constraint, EffectRequestV1, EvidenceEnvelopeV1, PolicyDecisionV1, PolicyRefV1 } from "./records.ts";
import { ConstitutionalStore } from "./store.ts";

export interface ResolvedAdmissionBundle {
  readonly admission_input: AdmissionInputV1;
  readonly effect_request: EffectRequestV1;
  /** The K3 material object re-read from CAS and digest-verified (TD §6.6) — K4-bound, not extra input. */
  readonly effect_material: Record<string, unknown>;
  readonly evidence: readonly EvidenceEnvelopeV1[];
  readonly policy_ref: PolicyRefV1;
  readonly now: string;
}

export interface RawDecision {
  readonly outcome: "ALLOW" | "DENY" | "REQUIRE_EVIDENCE";
  readonly reason_codes: readonly string[];
  readonly constraints: readonly Constraint[];
  readonly revision_echo?: string;
}

export class EvaluationUnavailable extends Error {
  readonly retryable = true;
}

export class EvaluatorIntegrityFailure extends Error {}

export interface EvaluatorPort {
  evaluate(bundle: ResolvedAdmissionBundle): Promise<RawDecision>;
  identity(): { evaluator_ref: string; evaluator_version: string; loaded_policy_content_digest: string };
  integrityRef(): string;
  /** Load/refresh the policy content; must verify byte identity (TD §5.2). */
  ensureLoaded(active: ActivePolicy): Promise<void>;
}

// ------------------------------------------------------------------ OPA sidecar

function opaRequest(socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, method, path, headers: { "content-type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, json: text.length > 0 ? JSON.parse(text) : undefined });
          } catch {
            reject(new EvaluationUnavailable(`OPA returned unparseable body: ${text.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", (error) => reject(new EvaluationUnavailable(`OPA transport: ${error.message}`)));
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new EvaluationUnavailable("OPA request timeout"));
    });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

export class OpaEvaluator implements EvaluatorPort {
  #process: ChildProcess | undefined;
  #socketPath: string;
  #bundlePath: string;
  #loadedContentDigest = "";
  #loadedManifestRevision = "";
  #opaVersion = "unknown";

  readonly workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
    mkdirSync(workDir, { recursive: true });
    this.#socketPath = join(workDir, "opa.sock");
    this.#bundlePath = join(workDir, "bundle.tar.gz");
  }

  async start(): Promise<void> {
    if (this.#process !== undefined) return;
    const config = {
      bundles: { cadp: { resource: `file://${this.#bundlePath}`, persist: false, polling: { min_delay_seconds: 1, max_delay_seconds: 2 } } },
      status: { console: true }, // enables GET /v1/status (TD §5.2: active_revision proof)
    };
    const configPath = join(this.workDir, "opa-config.json");
    writeFileSync(configPath, JSON.stringify(config));
    // The bundle file must exist and be valid BEFORE spawn: an unreadable first bundle puts
    // the OPA bundle plugin into failure backoff and stalls activation.
    if (!existsSync(this.#bundlePath)) {
      throw new EvaluationUnavailable("OPA started before any bundle was served (call ensureLoaded first)");
    }
    this.#process = spawn("opa", ["run", "--server", "--addr", `unix://${this.#socketPath}`, "--config-file", configPath, "--log-level", "error"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    // status.console floods stderr with large status dumps; an unread pipe would block OPA.
    this.#process.stderr?.resume();
    this.#process.on("exit", () => { this.#process = undefined; });
    await this.#waitReady();
    this.#opaVersion = await new Promise<string>((resolve) => {
      const p = spawn("opa", ["version"]);
      const chunks: Buffer[] = [];
      p.stdout.on("data", (c: Buffer) => chunks.push(c));
      p.on("exit", () => {
        const m = /Version: ([\d.]+)/u.exec(Buffer.concat(chunks).toString("utf8"));
        resolve(m?.[1] ?? "unknown");
      });
    });
  }

  async #waitReady(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      try {
        const res = await opaRequest(this.#socketPath, "GET", "/health");
        if (res.status === 200) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new EvaluationUnavailable("OPA sidecar did not become healthy");
  }

  stop(): void {
    this.#process?.kill("SIGTERM");
    this.#process = undefined;
  }

  /**
   * PEP-served bundle load (TD §5.2): CAS bytes verified, written to a PEP-owned path.
   * OPA's file loader reads the bundle exactly once, so serving a NEW activation restarts
   * the sidecar on the new bytes — the PEP, not a bundle server, owns what OPA loads.
   */
  async ensureLoaded(active: ActivePolicy): Promise<void> {
    const contentDigest = active.activation.content_digest;
    if (this.#process !== undefined && this.#loadedContentDigest === contentDigest) return;
    if (sha256Hex(active.bundleBytes) !== contentDigest) {
      throw new EvaluatorIntegrityFailure("bundle bytes do not re-digest to the active content_digest");
    }
    if (this.#process !== undefined && this.#loadedContentDigest !== contentDigest) {
      const exited = new Promise<void>((resolve) => this.#process?.once("exit", () => resolve()));
      this.stop();
      await exited;
    }
    writeFileSync(this.#bundlePath, active.bundleBytes);
    if (this.#process === undefined) await this.start();
    // Wait until /v1/status reports the new manifest revision with no error.
    const expected = active.refRow.manifest_revision;
    for (let i = 0; i < 100; i += 1) {
      const status = await this.#bundleStatus();
      if (status.active_revision === expected && status.error === undefined) {
        this.#loadedContentDigest = contentDigest;
        this.#loadedManifestRevision = expected;
        return;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new EvaluatorIntegrityFailure(`OPA did not activate bundle revision ${expected}`);
  }

  async #bundleStatus(): Promise<{ active_revision?: string; error?: string }> {
    const res = await opaRequest(this.#socketPath, "GET", "/v1/status");
    const bundles = (res.json as { result?: { bundles?: Record<string, { active_revision?: string; message?: string; code?: string }> } })?.result?.bundles;
    const cadp = bundles?.["cadp"];
    if (cadp === undefined) return {};
    return { active_revision: cadp.active_revision, error: cadp.code !== undefined && cadp.code !== "" ? cadp.message : undefined };
  }

  async evaluate(bundle: ResolvedAdmissionBundle): Promise<RawDecision> {
    const res = await opaRequest(this.#socketPath, "POST", "/v1/data/cadp/admission", { input: bundle });
    if (res.status !== 200) throw new EvaluationUnavailable(`OPA status ${res.status}`);
    const result = (res.json as { result?: unknown }).result as RawDecision | undefined;
    if (result === undefined || typeof result.outcome !== "string") {
      throw new EvaluationUnavailable("OPA result missing outcome (undefined document)");
    }
    if (!["ALLOW", "DENY", "REQUIRE_EVIDENCE"].includes(result.outcome)) {
      throw new EvaluationUnavailable(`unknown outcome ${result.outcome}`);
    }
    // §5.2: revision_echo must be the manifest revision OPA loaded, checked by the Sealer.
    const status = await this.#bundleStatus();
    if (status.active_revision !== this.#loadedManifestRevision || status.error !== undefined) {
      throw new EvaluatorIntegrityFailure(`OPA active_revision ${status.active_revision} != served ${this.#loadedManifestRevision}`);
    }
    if (result.revision_echo !== this.#loadedManifestRevision) {
      throw new EvaluatorIntegrityFailure(`revision_echo ${result.revision_echo} != ${this.#loadedManifestRevision}`);
    }
    return {
      outcome: result.outcome,
      reason_codes: Array.isArray(result.reason_codes) ? result.reason_codes : [],
      constraints: Array.isArray(result.constraints) ? result.constraints : [],
      revision_echo: result.revision_echo,
    };
  }

  identity(): { evaluator_ref: string; evaluator_version: string; loaded_policy_content_digest: string } {
    return {
      evaluator_ref: "opa-sidecar",
      evaluator_version: this.#opaVersion,
      loaded_policy_content_digest: this.#loadedContentDigest,
    };
  }

  integrityRef(): string {
    return `opa:${this.#opaVersion};bundle_revision:${this.#loadedManifestRevision};content:${this.#loadedContentDigest};channel:unix:${this.#socketPath}`;
  }
}

// ------------------------------------------------------------------ evaluation + sealing

export type EvaluateOutcome =
  | { kind: "DECISION"; decision: PolicyDecisionV1 }
  | { kind: "POLICY_NOT_ACTIVE" }
  | { kind: "EVALUATION_UNAVAILABLE"; detail: string };

/**
 * Kernel `evaluate(input_digest)` (TD §12, §5.1): fail-closed active-policy pre-check,
 * complete-input bundle assembly (CAS claims resolved), evaluation, sealing.
 */
export async function evaluateAndSeal(
  store: ConstitutionalStore,
  cas: Cas,
  ingress: Ingress,
  evaluator: EvaluatorPort,
  input_digest: string,
  clock: () => number = Date.now,
): Promise<EvaluateOutcome> {
  const active = resolveActivePolicy(store, cas);
  const input = store.admissionInput(input_digest);
  if (input === undefined) throw new IngressRejection("INPUT_NOT_FOUND", input_digest);

  // Kernel fail-closed pre-check (r6): the K4-bound policy must BE the active row.
  if (
    input.policy_ref.policy_id !== active.activation.policy_id ||
    input.policy_ref.revision !== active.activation.revision ||
    input.policy_ref.content_digest.value !== active.activation.content_digest
  ) {
    return { kind: "POLICY_NOT_ACTIVE" };
  }

  const request = store.effectRequest(input.effect_request_ref);
  if (request === undefined) throw new IngressRejection("EFFECT_NOT_FOUND", input.effect_request_ref);
  if (request.request_digest.value !== input.effect_request_digest.value) {
    return { kind: "POLICY_NOT_ACTIVE" }; // input no longer matches its request — never evaluable
  }

  const evidence: EvidenceEnvelopeV1[] = [];
  for (const ref of input.evidence_refs) {
    const envelope = store.evidenceById(ref.evidence_id);
    if (envelope === undefined || envelope.envelope_digest.value !== ref.envelope_digest.value) {
      throw new IngressRejection("EVIDENCE_NOT_FOUND", ref.evidence_id);
    }
    evidence.push(envelope);
  }

  await evaluator.ensureLoaded(active);

  // §6.6: the evaluator re-reads the exact material bytes from CAS (digest-verified on read).
  let effect_material: Record<string, unknown>;
  try {
    effect_material = JSON.parse(Buffer.from(cas.get(request.material_ref)).toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    return { kind: "EVALUATION_UNAVAILABLE", detail: `material unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (jcsDigest(effect_material).value !== request.material_digest.value) {
    return { kind: "EVALUATION_UNAVAILABLE", detail: "material bytes do not re-digest to material_digest" };
  }

  const now = nowIso(clock);
  const bundle: ResolvedAdmissionBundle = {
    admission_input: input,
    effect_request: request,
    effect_material,
    evidence,
    policy_ref: input.policy_ref,
    now,
  };

  let raw: RawDecision;
  try {
    raw = await evaluator.evaluate(bundle);
  } catch (error) {
    if (error instanceof EvaluatorIntegrityFailure) {
      ingress.sealIncident("EVALUATOR_INTEGRITY_FAILURE", error.message, [
        { authority_ref: "cadp-store:k04", namespace: "effect", object_id: request.effect_id },
      ]);
      return { kind: "EVALUATION_UNAVAILABLE", detail: `integrity: ${error.message}` };
    }
    if (error instanceof EvaluationUnavailable) return { kind: "EVALUATION_UNAVAILABLE", detail: error.message };
    throw error;
  }

  // Sealer integrity gate (§5.2 a–d): loaded content == decision policy == active row.
  const id = evaluator.identity();
  if (id.loaded_policy_content_digest !== active.activation.content_digest) {
    ingress.sealIncident("EVALUATOR_INTEGRITY_FAILURE", "evaluator loaded content differs from the active policy", [
      { authority_ref: "cadp-store:k04", namespace: "effect", object_id: request.effect_id },
    ]);
    return { kind: "EVALUATION_UNAVAILABLE", detail: "integrity: loaded content mismatch" };
  }

  const decided_at = now;
  const not_after = new Date(Date.parse(decided_at) + active.config.decision_ttl_s * 1000).toISOString();
  const base: Record<string, unknown> = {
    decision_id: newId("decision", clock),
    policy_ref: input.policy_ref,
    admission_input_digest: input.input_digest,
    outcome: raw.outcome,
    reason_codes: raw.reason_codes,
    constraints: raw.constraints,
    evaluator: {
      evaluator_ref: id.evaluator_ref,
      evaluator_version: id.evaluator_version,
      integrity_ref: evaluator.integrityRef(),
    },
    decided_at,
    not_after,
  };
  const decision = { ...base, decision_digest: recordDigest(base, "decision_digest") } as unknown as PolicyDecisionV1;
  validatePolicyDecision(decision);
  store.withImmediate(() => store.insertPolicyDecision(decision));
  return { kind: "DECISION", decision };
}

export { jcs as _jcsForTests };
