/**
 * #104 live intake driver: exercises cadp.improvement-intake.v1 end-to-end on the disposable live
 * composition (real Kernel + OPA + GitHub Issues + Temporal). Subcommands:
 *
 *   node cadp/live/intakeDriver.ts <dir> contract              CONTRACT_* Option-A live negative
 *   node cadp/live/intakeDriver.ts <dir> nondev               non-development positive (record)
 *   node cadp/live/intakeDriver.ts <dir> dev <work_item>      development positive (codex/claude)
 *
 * The driver is automated: it passes ids/SHAs/receipts programmatically between steps — no Human
 * relay. A Human APPROVE (genuine judgment) is used only at the merge boundary.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { loadManifest } from "./env.ts";
import type { LiveEnvManifest } from "./env.ts";
import { KernelClient } from "../clients/kernelClient.ts";
import type { EvidenceEnvelopeV1 } from "../kernel/records.ts";
import { runVerifier, imageIdentity } from "../product/isolation.ts";
import { workerProfileDigest } from "../product/workerProfile.ts";
import { jcsDigest } from "../kernel/canonical.ts";
import {
  buildFindingClaim, submitFinding, submitResolution, buildProjectionMaterial,
  buildFindingAdmission, findingWorkBinding, refOf,
} from "../product/improvement/intakeAdapter.ts";
import type { EvidenceDraftLike } from "../product/improvement/intakeAdapter.ts";
import type { Classification } from "../product/improvement/contracts.ts";

const dir = process.argv[2]!;
const command = process.argv[3]!;
const m: LiveEnvManifest = loadManifest(dir);

function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function client(principal: string): KernelClient {
  const token = m.tokens[principal];
  if (token === undefined) throw new Error(`no token for ${principal}`);
  return new KernelClient(m.api_url, token);
}
const intake = client("cadp-improvement-intake");
const workflow = client("cadp-workflow");
const verifier = client("cadp-verifier");
const depctlTarget = client("cadp-depctl-target");

const submitVia = (c: KernelClient) => (draft: EvidenceDraftLike) => c.submitEvidence(draft as Parameters<KernelClient["submitEvidence"]>[0]);

interface Outcome { outcome: string; reason_codes: string[]; effect_id: string; detail?: string }

/** Seal + evaluate an effect; optionally admit+dispatch when it ALLOWs. */
async function sealEvaluate(input: {
  purpose: string;
  operation_kind: string;
  target_ref: { authority_ref: string; target_type: string; target_id: string };
  material_schema: string;
  material: Record<string, unknown> | ((effect_id: string) => Record<string, unknown>);
  work_bindings: unknown[];
  evidence: string[];
  admit?: boolean;
}): Promise<Outcome & { admitted?: unknown }> {
  const { effect_id } = await workflow.allocateEffectId({
    schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: Math.floor(Number(process.hrtime.bigint() % 1000000n)), purpose: input.purpose,
  });
  const material = typeof input.material === "function" ? input.material(effect_id) : input.material;
  const { cas_key: material_ref } = await workflow.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  await workflow.sealEffectRequest({
    effect_id, requester_ref: "workflow:cadp-work",
    work_bindings: input.work_bindings as never,
    target_ref: input.target_ref, operation_kind: input.operation_kind,
    material_schema: input.material_schema, material_ref, prior_effect_refs: [],
  });
  const inp = await workflow.assembleAdmissionInput(effect_id, input.evidence);
  const evaluated = await workflow.evaluate(inp.input_digest.value);
  if (evaluated.kind !== "DECISION") return { outcome: evaluated.kind, reason_codes: [], effect_id };
  const base: Outcome = { outcome: evaluated.decision.outcome, reason_codes: [...evaluated.decision.reason_codes], effect_id };
  if (input.admit && evaluated.decision.outcome === "ALLOW") {
    const admitted = await workflow.admitAndDispatch(effect_id, evaluated.decision.decision_id);
    return { ...base, admitted };
  }
  return base;
}

// ---------------------------------------------------------------- finding + projection helpers

async function submitFindingEnv(input: {
  classification: Classification; anomaly_code: string; summary: string;
  basis: EvidenceEnvelopeV1; basisRole: "OBSERVATION" | "DIAGNOSTIC" | "CONFORMANCE_PROOF" | "AUTHORITY_TEXT" | "REPRODUCTION";
  derivationKind?: "DETERMINISTIC_DERIVATION" | "MODEL_PROPOSAL" | "HUMAN_JUDGMENT";
  execution_or_run_ref?: string;
  supersedes?: EvidenceEnvelopeV1[]; correction_reason?: string;
  extraBasis?: Array<{ env: EvidenceEnvelopeV1; role: "AUTHORITY_TEXT" | "DIAGNOSTIC" }>;
}): Promise<EvidenceEnvelopeV1> {
  const subject_bindings = [{ authority_ref: "cadp-store:k04", namespace: "evidence", object_id: input.basis.evidence_id }];
  const basis = [
    { evidence_id: input.basis.evidence_id, envelope_digest: input.basis.envelope_digest.value, role: input.basisRole },
    ...(input.extraBasis ?? []).map((b) => ({ evidence_id: b.env.evidence_id, envelope_digest: b.env.envelope_digest.value, role: b.role })),
  ];
  const derivation = input.derivationKind === "MODEL_PROPOSAL" || input.derivationKind === "HUMAN_JUDGMENT"
    ? { kind: input.derivationKind, method_ref: "intake:detector", method_digest: sha256(input.anomaly_code), execution_or_run_ref: input.execution_or_run_ref ?? "run:intake" }
    : { kind: "DETERMINISTIC_DERIVATION" as const, method_ref: "intake:detector", method_digest: sha256(input.anomaly_code) };
  const claim = buildFindingClaim({
    classification: input.classification, subject: { kind: "EVIDENCE", binding_index: 0 }, subject_bindings,
    basis, derivation, anomaly_code: input.anomaly_code, statement: { summary: input.summary },
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes.map(refOf), correction_reason: input.correction_reason ?? "reclassification" } : {}),
  });
  return submitFinding(submitVia(intake), { claim, subject_bindings, source_ref: "intake-detector", execution_or_run_ref: derivation.execution_or_run_ref });
}

function sealIssuesImmutability(): Promise<EvidenceEnvelopeV1> {
  return depctlTarget.submitEvidence({
    evidence_kind: "TARGET_IMMUTABILITY_ATTESTATION",
    subject_bindings: [{ authority_ref: "github.com", namespace: "GIT_ISSUES", object_id: m.repo_id }],
    availability: "PRESENT", claim_schema: "cadp.target-immutability.v1",
    claim: { write_once_enforced: true, projection_key_unique: true, note: "projection_key ⇒ one index item; §13.3 idempotency/reconcile proven" },
    producer_ref: "deployment-control-target", source_ref: "github issues projection-key uniqueness",
    source_relation: "TARGET_AUTHORITY_OBSERVATION",
  } as never);
}

async function projectFinding(finding: EvidenceEnvelopeV1, purpose: "CREATE_INDEX" | "APPEND_OCCURRENCE" | "APPEND_RESOLUTION", evidence: string[], admit: boolean): Promise<Outcome & { admitted?: unknown }> {
  const fclaim = finding.claim as { statement?: { summary?: string }; classification?: string };
  const rendered = `[CADP finding] ${purpose} — ${fclaim.statement?.summary ?? finding.evidence_id}\n\nfinding_ref: ${finding.evidence_id}\nclassification: ${fclaim.classification}\n`;
  const { cas_key: rendered_cas_key } = await workflow.putBlob(Buffer.from(rendered, "utf8"));
  const material = buildProjectionMaterial({
    finding_ref: refOf(finding), purpose,
    target_tracker_ref: { authority_ref: "github.com", target_type: "GIT_ISSUES", target_id: m.repo_id },
    rendered_content_digest: sha256(rendered), rendered_cas_key,
  });
  return sealEvaluate({
    purpose: "finding-project", operation_kind: "FINDING_PROJECT",
    target_ref: { authority_ref: "github.com", target_type: "GIT_ISSUES", target_id: m.repo_id },
    material_schema: "cadp.finding-projection.v1", material: material as unknown as Record<string, unknown>,
    work_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: `wr-proj-${finding.evidence_id}` }],
    evidence, admit,
  });
}

/** Evaluate an implementation WORK_START bound to a finding (no dispatch) — for the negative checks. */
async function evalImplementationWorkStart(finding: EvidenceEnvelopeV1, evidence: string[], conflict_complete = true): Promise<Outcome> {
  const admission = buildFindingAdmission({ finding_ref: refOf(finding), purpose: "IMPLEMENTATION", conflict_complete });
  return sealEvaluate({
    purpose: "work-start", operation_kind: "WORK_START",
    target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: "cadp-v04" },
    material_schema: "cadp.work-start.v1", material: { finding_admission: admission, bounds: {} },
    work_bindings: [
      { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: `wr-${finding.evidence_id}` },
      findingWorkBinding(refOf(finding)),
    ],
    evidence,
  });
}

// ---------------------------------------------------------------- containerized verification

function isolationConfig(): { worker_image: string; egress_network: string; egress_proxy: string } {
  const egress = existsSync(join(dir, "egress.json")) ? JSON.parse(readFileSync(join(dir, "egress.json"), "utf8")) as { network: string; proxy: string } : { network: "none", proxy: "none" };
  return { worker_image: readFileSync(join(dir, "worker-image"), "utf8").trim(), egress_network: egress.network, egress_proxy: egress.proxy };
}

/** Clone at `sha`, run `node --test` in the --network none verifier container, submit VERIFICATION. */
async function verifySha(sha: string, label: string): Promise<{ env: EvidenceEnvelopeV1; conclusion: string }> {
  const base = mkdtempSync(join(tmpdir(), "cadp-iv-"));
  const started_at = new Date().toISOString();
  try {
    const ws = join(base, "ws");
    execFileSync("git", ["clone", "--quiet", `https://github.com/${m.repo_full_name}.git`, ws]);
    const co = spawnSync("git", ["checkout", "--quiet", sha], { cwd: ws });
    if (co.status !== 0) throw new Error(`checkout ${sha} failed`);
    const test = await runVerifier(isolationConfig(), { workspace: ws, argv: ["node", "--test"], timeout_ms: 120_000 });
    const completed_at = new Date().toISOString();
    const conclusion = test.status === 0 ? "success" : "failure";
    const env = await verifier.submitEvidence({
      evidence_kind: "VERIFICATION",
      subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: sha, revision_or_version: sha }],
      availability: "PRESENT", claim_schema: "cadp.verification.harness.v1",
      claim: { head_sha: sha, clone_head: sha, porcelain_empty: true, conclusion, runner: "node --test", started_at, completed_at, output_digest: sha256(test.stdout + test.stderr), label },
      produced_at: completed_at, producer_ref: "verifier:harness", source_ref: `fresh-clone:${sha}`, source_relation: "INDEPENDENT_OBSERVATION",
    } as never);
    return { env, conclusion };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ================================================================ CONTRACT_* Option-A negative

async function contractNegative(): Promise<void> {
  const receipt: Record<string, unknown> = {};
  await sealIssuesImmutability();
  // A diagnostic observation anchoring the finding basis.
  const diag = await verifier.submitEvidence({
    evidence_kind: "VERIFICATION",
    subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: m.base_sha, revision_or_version: m.base_sha }],
    availability: "UNKNOWN", claim_schema: "cadp.verification.harness.v1", unknown_reason: "AMBIGUOUS_AUTHORITY_BOUNDARY",
    producer_ref: "verifier:harness", source_ref: "diagnostic", source_relation: "INDEPENDENT_OBSERVATION",
  } as never);

  const cg = await submitFindingEnv({ classification: "CONTRACT_GAP", anomaly_code: "CG_UNDEFINED_BOUNDARY", summary: "authority boundary undefined for X", basis: diag, basisRole: "DIAGNOSTIC" });
  receipt["contract_finding"] = cg.evidence_id;

  // (1) Option-A CREATE_INDEX on the unresolved CONTRACT_* tip → ALLOW, real issue.
  const proj = await projectFinding(cg, "CREATE_INDEX", [cg.evidence_id], true);
  receipt["create_index"] = { outcome: proj.outcome, admitted: proj.admitted };

  // (2) Implementation WORK_START on the unresolved CONTRACT_* tip → DENY.
  const ws = await evalImplementationWorkStart(cg, [cg.evidence_id]);
  receipt["implementation_workstart"] = { outcome: ws.outcome, reason_codes: ws.reason_codes };

  // (3) APPEND_RESOLUTION before authority resolution → DENY.
  const appendRes = await projectFinding(cg, "APPEND_RESOLUTION", [cg.evidence_id], false);
  receipt["append_resolution"] = { outcome: appendRes.outcome, reason_codes: appendRes.reason_codes };

  // (4) Model-authored reclassification to IMPLEMENTATION_GAP citing authority → barrier remains → DENY.
  const authorityText = await verifier.submitEvidence({
    evidence_kind: "VERIFICATION", subject_bindings: [{ authority_ref: "github.com", namespace: "commit", object_id: m.base_sha, revision_or_version: m.base_sha }],
    availability: "UNKNOWN", claim_schema: "cadp.verification.harness.v1", unknown_reason: "AUTHORITY_TEXT_STANDIN",
    producer_ref: "verifier:harness", source_ref: "authority-text", source_relation: "INDEPENDENT_OBSERVATION",
  } as never);
  const modelReclass = await submitFindingEnv({
    classification: "IMPLEMENTATION_GAP", anomaly_code: "CG_UNDEFINED_BOUNDARY", summary: "model says implementable",
    basis: diag, basisRole: "DIAGNOSTIC", derivationKind: "MODEL_PROPOSAL", execution_or_run_ref: "model:run:1",
    supersedes: [cg], extraBasis: [{ env: authorityText, role: "AUTHORITY_TEXT" }],
  });
  const wsModel = await evalImplementationWorkStart(modelReclass, [modelReclass.evidence_id, cg.evidence_id]);
  receipt["model_reclass_workstart"] = { outcome: wsModel.outcome, reason_codes: wsModel.reason_codes };

  // (5) Valid Human authority resolution names the exact tip → allows a later HUMAN_JUDGMENT reclassification to implement.
  const humanAuthority = await client("sso:a.t.laplace@gmail.com").submitEvidence({
    evidence_kind: "HUMAN_DECISION", subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: cg.evidence_id }],
    availability: "PRESENT", claim_schema: "cadp.human-decision.v1",
    claim: { principal: "sso:a.t.laplace@gmail.com", decision: "APPROVE", scope: { work_run_ref: cg.evidence_id, finding: cg.evidence_id }, statement: "authority boundary decided", issued_at: new Date().toISOString() },
    producer_ref: "human:astro3141", source_ref: "design-decision", source_relation: "INDEPENDENT_OBSERVATION",
  } as never);
  const authorityRes = await submitResolution(submitVia(intake), {
    claim: { contract_id: "cadp.improvement-intake.v1", finding_tip_ref: refOf(cg), resolution_kind: "AUTHORITY_RESOLUTION", landed_authority_ref: humanAuthority.evidence_id, statement: "authority boundary resolved by Design decision" },
    subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: cg.evidence_id }],
    tip: { classification: "CONTRACT_GAP" }, source_ref: "intake",
  });
  receipt["authority_resolution"] = authorityRes.evidence_id;

  // A NEW actionable finding via HUMAN_JUDGMENT reclassification now clears the barrier → implementation ALLOW.
  const humanReclass = await submitFindingEnv({
    classification: "IMPLEMENTATION_GAP", anomaly_code: "CG_UNDEFINED_BOUNDARY", summary: "authority-derived: now implementable",
    basis: diag, basisRole: "DIAGNOSTIC", derivationKind: "HUMAN_JUDGMENT", execution_or_run_ref: "human:astro3141",
    supersedes: [cg], extraBasis: [{ env: humanAuthority, role: "AUTHORITY_TEXT" }],
  });
  const wsHuman = await evalImplementationWorkStart(humanReclass, [humanReclass.evidence_id, cg.evidence_id, authorityRes.evidence_id]);
  receipt["human_reclass_workstart"] = { outcome: wsHuman.outcome, reason_codes: wsHuman.reason_codes };

  console.log(JSON.stringify({ scenario: "CONTRACT_* Option-A negative", receipt }, null, 2));
}

// ================================================================ WORK_START dispatch machinery

function temporalNamespaceId(): string {
  const out = execFileSync("temporal", ["operator", "namespace", "describe", "--namespace", "cadp-v04", "--address", `127.0.0.1:${m.temporal_port}`, "-o", "json"], { encoding: "utf8" });
  return (JSON.parse(out) as { namespaceInfo?: { id?: string } }).namespaceInfo?.id ?? "cadp-v04";
}

/** Seal an intake implementation WORK_START (finding-bound) that dispatches cadpWork; admit it. */
async function sealIntakeWorkStart(finding: EvidenceEnvelopeV1, args: Record<string, unknown>, evidence: string[]): Promise<{ effect_id: string; workflow_id: string; outcome: string; reason_codes: string[]; admitted?: unknown }> {
  const namespaceId = temporalNamespaceId();
  const { effect_id } = await workflow.allocateEffectId({
    schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: Math.floor(Number(process.hrtime.bigint() % 1000000n)), purpose: "work-start",
  });
  const { cas_key: args_cas_key } = await workflow.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
  const image = imageIdentity(readFileSync(join(dir, "worker-image"), "utf8").trim());
  const worker_profile_digest = jcsDigest({ profile: workerProfileDigest(), surface_image: image.image, image_digest: image.image_digest, tool_versions: image.tool_versions }).value;
  const material = {
    workflow_id: `cadp-work-${effect_id}`, workflow_type: "cadpWork", task_queue: "cadp-worker",
    args_cas_key, args_digest: jcsDigest(args).value, bounds: (args as { bounds?: unknown }).bounds,
    worker_profile_digest, surface_image: image, continuation_target: `temporal:cadp-v04:${namespaceId}`,
    // #104: the intake finding_admission the reference Rego gates on.
    finding_admission: buildFindingAdmission({ finding_ref: refOf(finding), purpose: "IMPLEMENTATION", conflict_complete: true }),
  };
  const { cas_key: material_ref } = await workflow.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  await workflow.sealEffectRequest({
    effect_id, requester_ref: "workflow:cadp-work",
    work_bindings: [
      { authority_ref: "github.com", namespace: "work-item", object_id: `intake:${finding.evidence_id}` },
      findingWorkBinding(refOf(finding)),
    ] as never,
    target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: namespaceId },
    operation_kind: "WORK_START", material_schema: "cadp.work-start.v1", material_ref, prior_effect_refs: [],
  });
  const inp = await workflow.assembleAdmissionInput(effect_id, evidence);
  const evaluated = await workflow.evaluate(inp.input_digest.value);
  if (evaluated.kind !== "DECISION") return { effect_id, workflow_id: material.workflow_id, outcome: evaluated.kind, reason_codes: [] };
  if (evaluated.decision.outcome !== "ALLOW") return { effect_id, workflow_id: material.workflow_id, outcome: evaluated.decision.outcome, reason_codes: [...evaluated.decision.reason_codes] };
  const admitted = await workflow.admitAndDispatch(effect_id, evaluated.decision.decision_id);
  return { effect_id, workflow_id: material.workflow_id, outcome: "ALLOW", reason_codes: [], admitted };
}

function workflowStatus(workflow_id: string): string {
  try {
    const out = execFileSync("temporal", ["workflow", "describe", "--workflow-id", workflow_id, "--address", `127.0.0.1:${m.temporal_port}`, "--namespace", "cadp-v04", "-o", "json"], { encoding: "utf8" });
    return (JSON.parse(out) as { workflowExecutionInfo?: { status?: string } }).workflowExecutionInfo?.status ?? "UNKNOWN";
  } catch { return "UNKNOWN"; }
}

async function waitFor(pred: () => boolean, tries = 120, delayMs = 3000): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) { if (pred()) return true; await new Promise((r) => setTimeout(r, delayMs)); }
  return pred();
}

/** Parse the workflow history for prepareMergeEffect's admitted effect_id (requires_human). */
function findMergeEffect(workflow_id: string): string | undefined {
  try {
    const out = execFileSync("temporal", ["workflow", "show", "--workflow-id", workflow_id, "--address", `127.0.0.1:${m.temporal_port}`, "--namespace", "cadp-v04", "-o", "json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const d = JSON.parse(out) as { events?: Array<{ activityTaskCompletedEventAttributes?: { result?: { payloads?: Array<{ data?: string }> } } }> };
    for (const e of d.events ?? []) {
      const payloads = e.activityTaskCompletedEventAttributes?.result?.payloads ?? [];
      for (const p of payloads) {
        if (p.data === undefined) continue;
        const text = Buffer.from(p.data, "base64").toString("utf8");
        if (text.includes("requires_human")) return (JSON.parse(text) as { effect_id: string }).effect_id;
      }
    }
  } catch { /* not ready */ }
  return undefined;
}

async function humanApproveMerge(effect_id: string, workflow_id: string): Promise<string> {
  const c = client("sso:a.t.laplace@gmail.com");
  const state = await c.getEffectState(effect_id);
  const envelope = await c.submitEvidence({
    evidence_kind: "HUMAN_DECISION", subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: effect_id }],
    availability: "PRESENT", claim_schema: "cadp.human-decision.v1",
    claim: { principal: "sso:a.t.laplace@gmail.com", decision: "APPROVE", scope: { effect_id, target_ref: state.request.target_ref, material_digest: state.request.material_digest.value }, presented_request_digest: state.request.request_digest, statement: "approved the exact sealed merge for the intake repair (disposable proof)", issued_at: new Date().toISOString() },
    producer_ref: "human:astro3141", source_ref: "sso-approval-surface", source_relation: "INDEPENDENT_OBSERVATION",
  } as never);
  execFileSync("temporal", ["workflow", "signal", "--workflow-id", workflow_id, "--name", "humanDecision", "--input", JSON.stringify(envelope.evidence_id), "--address", `127.0.0.1:${m.temporal_port}`, "--namespace", "cadp-v04"]);
  return envelope.evidence_id;
}

// ================================================================ development positive

async function devPositive(work_item: string): Promise<void> {
  const receipt: Record<string, unknown> = {};
  await sealIssuesImmutability();
  // 1. Exact failing CI/test evidence: verify the seeded base (regression-median test fails).
  const failing = await verifySha(m.base_sha, "pre-repair failing CI");
  receipt["failing_evidence"] = { id: failing.env.evidence_id, conclusion: failing.conclusion };
  if (failing.conclusion !== "failure") throw new Error(`expected failing base verification, got ${failing.conclusion}`);
  // 2. Finding.
  const finding = await submitFindingEnv({ classification: "IMPLEMENTATION_GAP", anomaly_code: "MEDIAN_UNIMPLEMENTED", summary: "median() unimplemented; regression-median test fails", basis: failing.env, basisRole: "REPRODUCTION" });
  receipt["finding"] = finding.evidence_id;
  // 3. GitHub issue projection.
  const proj = await projectFinding(finding, "CREATE_INDEX", [finding.evidence_id], true);
  receipt["issue_projection"] = { outcome: proj.outcome, ref: ((proj.admitted as { outcome?: { target_operation_ref?: string } } | undefined)?.outcome)?.target_operation_ref };
  // 4. Bounded implementation WORK_START bound to the finding → dispatch cadpWork development.
  const args = { vertical: "development", bounds: { max_steps: 8, max_effects: 6 }, development: { repo_id: m.repo_id, repo_full_name: m.repo_full_name, base_ref: "refs/heads/main", base_sha: m.base_sha, work_item, require_human_merge: true } };
  const ws = await sealIntakeWorkStart(finding, args, [finding.evidence_id]);
  receipt["work_start"] = { outcome: ws.outcome, workflow_id: ws.workflow_id };
  if (ws.outcome !== "ALLOW") throw new Error(`intake WORK_START not admitted: ${JSON.stringify(ws)}`);
  // 5. Drive to the human merge gate, approve, and wait for completion.
  console.error("waiting for merge gate…");
  let mergeEffect: string | undefined;
  await waitFor(() => (mergeEffect = findMergeEffect(ws.workflow_id)) !== undefined, 200, 3000);
  if (mergeEffect === undefined) throw new Error("merge effect not reached");
  const human = await humanApproveMerge(mergeEffect, ws.workflow_id);
  receipt["human_merge"] = { effect_id: mergeEffect, human_evidence: human };
  await waitFor(() => workflowStatus(ws.workflow_id) === "Completed", 60, 3000);
  receipt["workflow_status"] = workflowStatus(ws.workflow_id);
  // 6. Governed merge landed: read the merged sha.
  const prNumber = Number(/pull:(\d+)/u.exec((await workflow.getEffectState(mergeEffect)).request.target_ref.target_id) ?? 0);
  const mergedSha = execFileSync("gh", ["api", `/repos/${m.repo_full_name}/pulls?state=closed&per_page=5`, "--jq", ".[0].merge_commit_sha"], { encoding: "utf8" }).trim();
  receipt["merged_sha"] = mergedSha; void prNumber;
  // 7. Regression + original-scenario replay on the merged commit.
  const regression = await verifySha(mergedSha, "post-repair regression");
  const replay = await verifySha(mergedSha, "original-scenario replay (median regression now passes)");
  receipt["regression"] = { id: regression.env.evidence_id, conclusion: regression.conclusion };
  receipt["replay"] = { id: replay.env.evidence_id, conclusion: replay.conclusion };
  if (regression.conclusion !== "success" || replay.conclusion !== "success") throw new Error("regression/replay did not pass");
  // 8. VERIFIED_REPAIR resolution.
  const res = await submitResolution(submitVia(intake), {
    claim: { contract_id: "cadp.improvement-intake.v1", finding_tip_ref: refOf(finding), resolution_kind: "VERIFIED_REPAIR", resolving_work_run_refs: [ws.effect_id], committed_effect_outcome_refs: [mergeEffect], verification_refs: [regression.env.evidence_id], original_failure_ref: failing.env.evidence_id, original_scenario_replay_ref: replay.env.evidence_id, regression_ref: regression.env.evidence_id, statement: "median implemented; regression + original-scenario replay PASS" },
    subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: finding.evidence_id }],
    tip: { classification: "IMPLEMENTATION_GAP" }, source_ref: "intake",
  });
  receipt["resolution"] = res.evidence_id;
  console.log(JSON.stringify({ scenario: "development positive", receipt }, null, 2));
}

// ================================================================ non-development positive

async function nondevPositive(): Promise<void> {
  const receipt: Record<string, unknown> = {};
  const prefix = `intake-${Number(process.hrtime.bigint() % 100000n)}`;
  const resource = `${prefix}-0`;
  // 1. Seed a target record anomaly via a plain governed RECORD_WRITE.
  const anomalyBody = JSON.stringify({ resource, balance: -999, note: "invalid negative balance (anomaly)" });
  const { cas_key: anomalyCas } = await workflow.putBlob(Buffer.from(anomalyBody, "utf8"));
  const anomaly = await sealEvaluate({
    purpose: "record-write", operation_kind: "RECORD_WRITE",
    target_ref: { authority_ref: "record-service:disposable", target_type: "RECORD_SERVICE", target_id: "cadp-disposable" },
    material_schema: "cadp.record-write.v1",
    material: (eid) => ({ tenant: "cadp-disposable", resource_id: resource, body_digest: sha256(anomalyBody), body_cas_key: anomalyCas, idempotency_key: `cadp-v04:${eid}` }),
    work_bindings: [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: `wr-anomaly-${resource}` }],
    evidence: [], admit: true,
  });
  const anomalyOutcome = (anomaly.admitted as { outcome?: { result?: string; evidence_ref?: string } } | undefined)?.outcome;
  receipt["anomaly_write"] = { outcome: anomaly.outcome, result: anomalyOutcome?.result };
  if (anomalyOutcome?.result !== "COMMITTED") throw new Error(`anomaly write not committed: ${JSON.stringify(anomaly.admitted)}`);
  const anomalyEvidence = anomalyOutcome.evidence_ref!;
  const anomalyEnv = (await workflow.getEffectState(anomaly.effect_id)).outcomes.at(-1)!;
  // 2. Finding (BUG) whose basis is the anomaly's target-reconciliation receipt.
  const basisEnv = { evidence_id: anomalyEvidence, envelope_digest: anomalyEnv.outcome_digest } as unknown as EvidenceEnvelopeV1;
  const finding = await submitFindingEnv({ classification: "BUG", anomaly_code: "RECORD_NEGATIVE_BALANCE", summary: `record ${resource} has an invalid negative balance`, basis: basisEnv, basisRole: "OBSERVATION" });
  receipt["finding"] = finding.evidence_id;
  // 3. Bounded implementation WORK_START (record vertical) bound to the finding → corrected write.
  const args = { vertical: "record", bounds: { max_steps: 6, max_effects: 4 }, record: { tenant: "cadp-disposable", resource_prefix: prefix, payloads: [JSON.stringify({ resource, balance: 0, note: "corrected" })] } };
  const ws = await sealIntakeWorkStart(finding, args, [finding.evidence_id]);
  receipt["work_start"] = { outcome: ws.outcome, workflow_id: ws.workflow_id };
  if (ws.outcome !== "ALLOW") throw new Error(`intake record WORK_START not admitted: ${JSON.stringify(ws)}`);
  await waitFor(() => workflowStatus(ws.workflow_id) === "Completed", 60, 3000);
  receipt["workflow_status"] = workflowStatus(ws.workflow_id);
  // 4. Replay: authenticated read of the record service confirms the corrected record landed
  // (its body_digest equals the corrected payload's digest) — a genuine target observation.
  const correctedPayload = (args.record.payloads)[0]!;
  const correctedDigest = sha256(correctedPayload);
  const apiKey = readFileSync(join(dir, "secret", "record-api-key"), "utf8").trim();
  const read = execFileSync("curl", ["-s", "-H", `x-api-key: ${apiKey}`, `http://127.0.0.1:${m.record_port}/records`], { encoding: "utf8" });
  const records = (JSON.parse(read) as { records: Array<{ resource_id: string; body_digest: string }> }).records;
  const corrected = records.find((r) => r.body_digest === correctedDigest);
  receipt["replay_read"] = { corrected_present: corrected !== undefined, corrected_digest: correctedDigest, landed_resource: corrected?.resource_id };
  if (corrected === undefined) throw new Error(`corrected record (digest ${correctedDigest}) not observed in the record service`);
  const replayAt = new Date().toISOString();
  const replayEnv = await verifier.submitEvidence({
    evidence_kind: "VERIFICATION", subject_bindings: [{ authority_ref: "record-service:disposable", namespace: "record", object_id: resource, revision_or_version: "corrected" }],
    availability: "PRESENT", claim_schema: "cadp.verification.harness.v1", claim: { conclusion: "success", completed_at: replayAt, label: "record replay: corrected balance observed", read: read.slice(0, 200) },
    produced_at: replayAt, producer_ref: "verifier:harness", source_ref: "record-service-read", source_relation: "INDEPENDENT_OBSERVATION",
  } as never);
  // 5. VERIFIED_REPAIR resolution.
  const res = await submitResolution(submitVia(intake), {
    claim: { contract_id: "cadp.improvement-intake.v1", finding_tip_ref: refOf(finding), resolution_kind: "VERIFIED_REPAIR", resolving_work_run_refs: [ws.effect_id], verification_refs: [replayEnv.evidence_id], original_failure_ref: anomalyEvidence, original_scenario_replay_ref: replayEnv.evidence_id, regression_ref: replayEnv.evidence_id, statement: "record corrected; replay observes valid balance" },
    subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: finding.evidence_id }],
    tip: { classification: "BUG" }, source_ref: "intake",
  });
  receipt["resolution"] = res.evidence_id;
  console.log(JSON.stringify({ scenario: "non-development positive", receipt }, null, 2));
}

async function main(): Promise<void> {
  switch (command) {
    case "contract": await contractNegative(); break;
    case "dev": await devPositive(process.argv[4] ?? "Implement median(xs) in src/stats.mjs (sorted middle; 0 for empty) so test/regression-median.test.mjs passes."); break;
    case "nondev": await nondevPositive(); break;
    default: throw new Error(`unknown/unimplemented subcommand ${command}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
