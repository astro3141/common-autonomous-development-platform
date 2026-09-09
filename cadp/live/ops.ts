/**
 * Shared live-composition operations (#61): the plan / governed-WORK_START / run-polling glue
 * used by both the CLI (`ctl.ts`) and the MCP tool surface (`mcpServer.ts`).
 *
 * Nothing here is authority: `sealPlan` produces proposal plus planner-observation evidence, `startWork` goes through the
 * ordinary governed admission (policy gates every start), and `pollRun`/`runSnapshot` are
 * observations. Callers own presentation; `log` defaults to silent so a protocol server's stdout
 * stays clean.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifest } from "./env.ts";
import type { LiveEnvManifest } from "./env.ts";
import { KernelClient } from "../clients/kernelClient.ts";
import { jcs, jcsDigest, sha256Hex } from "../kernel/canonical.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA } from "../kernel/policyBundle.ts";
import { workerProfileDigest } from "../product/workerProfile.ts";
import { assertReviewIndependence, resolveReviewProvider } from "../product/reviewProviders.ts";
import { resolvePlanProvider } from "../product/planProviders.ts";
import { imageIdentity } from "../product/isolation.ts";
import { brokerPostJson } from "../product/brokerTransport.ts";
import { SURFACE_BUDGETS } from "../product/timeouts.ts";
import { parseWorkProposal } from "../product/planner.ts";
import { resolveWorkerProvider, WORKER_PROVIDERS } from "../product/workerProviders.ts";
import type { WorkProposalV1 } from "../product/planner.ts";
import { devEffectFloorViolation } from "../product/workBounds.ts";
import { classifyRun, nextAction } from "../product/driver.ts";
import type { ItemStatus, RunSnapshot } from "../product/driver.ts";
import { attribution, collectRun, humanWait } from "../product/observationProjection.ts";
import { backendScanClient, backendScanPrincipal, submitBackendExecutionEvidence } from "../product/backendExecution.ts";
import type { EvidenceDraft } from "../kernel/ingress.ts";
import type { EvidenceEnvelopeV1 } from "../kernel/records.ts";

export type Log = (line: Record<string, unknown>) => void;
const SILENT: Log = () => {};

export function liveClient(dir: string, principal: string): KernelClient {
  const m = loadManifest(dir);
  const token = m.tokens[principal];
  if (token === undefined) throw new Error(`no token for ${principal}`);
  return new KernelClient(m.api_url, token);
}

/** #127: a malformed CLI bound refuses at entry — it must never become NaN→null in sealed material. */
export function boundArg(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`malformed work bound '${raw}' — need a positive integer`);
  return value;
}

export function temporalNamespaceId(m: LiveEnvManifest): string {
  const out = execFileSync("temporal", ["operator", "namespace", "describe", "--namespace", "cadp-v04", "--address", `127.0.0.1:${m.temporal_port}`, "-o", "json"], { encoding: "utf8" });
  const parsed = JSON.parse(out) as { namespaceInfo?: { id?: string } };
  return parsed.namespaceInfo?.id ?? "cadp-v04";
}

/**
 * Proposal-only planning (#61): run the commodity planner surface over the whole intent and seal
 * the typed proposal as WORK_PROPOSAL evidence with exact provenance, plus its role-qualified
 * BACKEND_EXECUTION sibling. Neither confers authority — each item still enters through the
 * ordinary governed WORK_START, without either planner envelope in gate evidence.
 */
interface SealPlanDependencies {
  manifest?: LiveEnvManifest;
  resolveBase?: (repoFullName: string, baseRef: string) => string;
  broker?: <T>(url: string, path: string, body: unknown, options: { rpc_ms: number }) => Promise<T>;
  clientForPrincipal?: (principal: string) => { submitEvidence(draft: EvidenceDraft): Promise<EvidenceEnvelopeV1> };
}

export async function sealPlan(
  dir: string,
  intent: string,
  planProduct?: string,
  dependencies: SealPlanDependencies = {},
): Promise<{ proposal_evidence_id: string; items: WorkProposalV1["items"]; notes?: string }> {
  const m = dependencies.manifest ?? loadManifest(dir);
  // plan_product select: fail closed on an unknown provider before any surface runs; omitted
  // keeps the claude default. Each provider submits under its OWN principal (honest attribution).
  const planProvider = resolvePlanProvider(planProduct !== undefined && planProduct !== "" ? planProduct : "claude");
  const planPrincipal = planProvider === "claude" ? "cadp-planner" : `cadp-planner-${planProvider}`;
  // The planner reads the base it proposes against — resolved fresh, same rationale as WORK_START.
  const base_sha = (dependencies.resolveBase ?? resolveBaseSha)(m.repo_full_name, "refs/heads/main");
  const result = await (dependencies.broker ?? brokerPostJson)<{ proposal: WorkProposalV1; stdout_digest: string; backend_model?: string; backend_locator?: string; backend_effort?: string; backend_effort_locator?: string; backend_requested_effort?: string }>(
    `http://127.0.0.1:${m.broker_port}`,
    "/plan",
    { repo_full_name: m.repo_full_name, base_sha, intent, plan_product: planProvider },
    { rpc_ms: SURFACE_BUDGETS.plan.rpc_ms },
  );
  const clientForPrincipal = dependencies.clientForPrincipal ?? ((principal: string) => liveClient(dir, principal));
  const subjectBindings = [
    { authority_ref: "cadp-store:k04", namespace: "work-intent", object_id: sha256Hex(intent) },
    { authority_ref: "github.com", namespace: "repo-base", object_id: `${m.repo_id}@${base_sha}` },
  ];
  const envelope = await clientForPrincipal(planPrincipal).submitEvidence({
    evidence_kind: "WORK_PROPOSAL",
    subject_bindings: subjectBindings,
    availability: "PRESENT",
    claim_schema: "cadp.work-proposal.v1",
    claim: { ...result.proposal, intent, stdout_digest: result.stdout_digest },
    producer_ref: planProvider === "claude" ? "planner:claude-code" : `planner:${planProvider}`,
    source_ref: `planner:${base_sha}:${sha256Hex(intent).slice(0, 16)}`,
    source_relation: "SELF_REPORT",
  });
  const scanClient = dependencies.clientForPrincipal !== undefined
    ? clientForPrincipal(backendScanPrincipal(planProvider))
    : backendScanClient(m.api_url, planProvider, (principal) => m.tokens[principal]);
  await submitBackendExecutionEvidence({
    client: scanClient,
    provider: planProvider,
    surface_role: "PLANNER",
    subject_bindings: subjectBindings,
    model: result.backend_model,
    locator: result.backend_locator,
    effort: result.backend_effort,
    effort_locator: result.backend_effort_locator,
    requested_effort: result.backend_requested_effort,
  });
  return {
    proposal_evidence_id: envelope.evidence_id,
    items: result.proposal.items,
    ...(result.proposal.notes !== undefined ? { notes: result.proposal.notes } : {}),
  };
}

/** Fetch + fail-closed re-validate a sealed WORK_PROPOSAL. */
export async function loadProposal(dir: string, proposalEvidenceId: string): Promise<WorkProposalV1> {
  const { envelope } = await liveClient(dir, "cadp-observer").getEvidence(proposalEvidenceId);
  if (envelope.evidence_kind !== "WORK_PROPOSAL") throw new Error(`evidence ${proposalEvidenceId} is ${envelope.evidence_kind}, not WORK_PROPOSAL`);
  const claim = envelope.claim as Record<string, unknown>;
  return parseWorkProposal(
    JSON.stringify({ schema: claim["schema"], items: claim["items"], ...(claim["notes"] !== undefined ? { notes: claim["notes"] } : {}) }),
  );
}

/**
 * Resolve the CURRENT tip of the declared base ref at seal time. The manifest's `base_sha` is the
 * ref tip AT ENV SETUP and only ever gets staler: the 7th #149 pilot implemented on a base four
 * merges behind main, and the (correctly verified, correctly reviewed) candidate then conflicted
 * at merge. `base_ref` is what the material DECLARES the run builds on, so the sealed `base_sha`
 * must be that ref's tip when the run is sealed — resolved fresh, never the manifest snapshot.
 * Fail closed on any resolution problem: sealing a knowingly stale base is worse than refusing.
 */
export function resolveBaseSha(
  repo_full_name: string,
  base_ref: string,
  run: (cmd: string, args: string[]) => string = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 15_000 }),
): string {
  let out: string;
  try {
    out = run("git", ["ls-remote", `https://github.com/${repo_full_name}.git`, base_ref]);
  } catch (e) {
    throw new Error(`cannot resolve ${base_ref} for ${repo_full_name} (${e instanceof Error ? e.message : String(e)}) — refusing to seal a stale base`);
  }
  const sha = out.split(/\s+/u)[0];
  if (sha === undefined || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`cannot resolve ${base_ref} for ${repo_full_name} (unexpected ls-remote output) — refusing to seal a stale base`);
  }
  return sha;
}

/**
 * WP §3.6 — the `origin_key` for a `workPlan`-driven origin, derived canonically from the STABLE
 * pair already present at origin creation: the sealed `WORK_PROPOSAL`'s `evidence_id` and the item's
 * index. Decided ONCE per logical origin (this pair does not move under retry) and reproduced
 * VERBATIM on every retry, under a collision-resistant encoding.
 *
 * It identifies ONE LOGICAL ORIGIN, never the work's content: two distinct origins over byte-
 * identical work carry distinct keys (different proposals, or different indices), so they receive
 * distinct `effect_id`s and neither can collide the other onto one identity. Nothing about the work
 * is digested to name it — there is no `work_item` and no `repo_id` in the preimage.
 */
export function workPlanOriginKey(proposal_evidence_id: string, item_index: number): string {
  return `cadp.run-origin.work-plan.v1:${sha256Hex(jcs({ item_index, proposal_evidence_id }))}`;
}

/**
 * WP §3.6 origin-path MATERIAL REPLAY STABILITY: the record vertical's `resource_prefix` is a
 * function of the STABLE `origin_key` and never of the wall clock. The prohibited shape it
 * replaces, named exactly, was `live-${Date.now() % 100000}`: two attempts at ONE origin sealed
 * different `args`, hence a different `args_digest` and `material_ref`, so the retry re-presented
 * the converged `effect_id` with drifted semantic payload — `REQUEST_DIGEST_CONFLICT`, a K3
 * incident and a scope hold, leaving the origin unretryable for the store's lifetime.
 */
export function recordResourcePrefix(origin_key: string): string {
  return `live-${sha256Hex(origin_key).slice(0, 10)}`;
}

/** Seams a test can substitute for the live environment's own (the `sealPlan` pattern). */
export interface StartWorkDependencies {
  manifest?: LiveEnvManifest;
  client?: KernelClient;
  namespaceId?: (m: LiveEnvManifest) => string;
  resolveBase?: (repoFullName: string, baseRef: string) => string;
  /** Resolves the built image's immutable identity (a `docker inspect` at the live seam). */
  imageIdentity?: (image: string) => { image: string; image_digest: string; tool_versions: Record<string, string> };
  /** The contents of the deployment's `worker-image` file, read from `dir` when absent. */
  workerImage?: string;
}

/**
 * One governed WORK_START through the ordinary admission chain. `undefined` = refused, honestly
 * logged.
 *
 * THE v0.5 RUN-ORIGIN PATH (WP §3.6, AP B1(5), AP B5(9)). The allocation is
 * `cadp.allocation-key.run-origin.v1` = `{schema, origin_key, purpose}` — the v0.4 zero-sentinel
 * `work_run_ref` tuple is gone from this path — and the seal binds EXACTLY ONE work-run subject,
 * the Platform-issued `effect_id` this very allocation returned, which is the self-binding
 * `is_run_origin` requires (leg 3). Caller obligations, discharged here:
 *  (1) `origin_key` is decided ONCE per logical origin and reproduced VERBATIM across retries —
 *      threaded in by `workPlan` from the proposal pair, or MINTED ONCE here for a direct start;
 *  (2) the origin binds its own `effect_id`, the allocation having already returned it; and
 *  (3) the sealed material carries NO wall-clock-derived field (the record vertical's
 *      `resource_prefix` is now a function of `origin_key`).
 *
 * TWO HONEST RESIDUALS, neither in this lane's scope and both stated rather than hidden:
 *  - a deployment must be a `cadp.kernel-config.v2` (v0.5) genesis carrying the run-origin
 *    contract; a `cadp.kernel-config.v1` (v0.4) store refuses this tuple `ALLOCATION_TUPLE_INVALID`
 *    at allocation, which is Spec v0.5 §10's generation boundary, not a fallback to design around;
 *  - `base_sha` is still resolved by a live `ls-remote` AT SEAL TIME (`resolveBaseSha`), so a retry
 *    of one development origin after the base branch moves still seals drifted material. WP §3.6
 *    names that as the same replay-stability obligation and requires the first-creation value to be
 *    pinned; doing so needs first-creation args the caller does not durably hold today, so it stays
 *    outstanding here and is NOT discharged by this change.
 */
export async function startWork(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: { originKey?: string; log?: Log; dependencies?: StartWorkDependencies } = {},
): Promise<{ effect_id: string; workflow_id: string } | undefined> {
  const log = options.log ?? SILENT;
  const dependencies = options.dependencies ?? {};
  const m = dependencies.manifest ?? loadManifest(dir);
  const c = dependencies.client ?? liveClient(dir, "cadp-workflow");
  const namespaceId = (dependencies.namespaceId ?? temporalNamespaceId)(m);
  // WP §3.6 caller obligation (1). A direct CLI/MCP start has no stable pair to derive from, so it
  // MINTS one collision-resistant key ONCE, at this invocation, and preserves it for this origin.
  const origin_key = options.originKey ?? randomUUID();

  if (vertical === "development") {
    const floor = devEffectFloorViolation(boundArg(extra[2], 6));
    if (floor !== undefined) throw new Error(floor); // fail closed before anything is sealed
  }
  // worker_product select (extra[4] on the dev path; extra[3] is the proposal id): fail closed on
  // an unknown provider at entry, before anything is sealed.
  const workerProduct = resolveWorkerProvider(extra[4] !== undefined && extra[4] !== "" ? extra[4] : "codex");
  // review_product select (extra[5], optional; omitted keeps the claude default). §8.4 reviewer
  // independence fails closed HERE, before anything is sealed or any surface spends compute.
  const reviewProduct = resolveReviewProvider(extra[5] !== undefined && extra[5] !== "" ? extra[5] : "claude");
  assertReviewIndependence(WORKER_PROVIDERS[workerProduct].identity_class_product, reviewProduct);
  // extra[6]: opt-in external verification backend (#57). Only the exact literal enables it —
  // anything else fails closed rather than silently running without the second verifier.
  if (extra[6] !== undefined && extra[6] !== "" && extra[6] !== "external") throw new Error(`unknown external-verification flag: ${extra[6]} (use "external" or omit)`);
  const externalVerification = extra[6] === "external";
  const args =
    vertical === "development"
      ? {
          vertical,
          bounds: { max_steps: boundArg(extra[1], 8), max_effects: boundArg(extra[2], 6) },
          development: {
            repo_id: m.repo_id,
            repo_full_name: m.repo_full_name,
            base_ref: "refs/heads/main",
            // Resolved fresh at seal time — the manifest's setup-time snapshot goes stale (see
            // resolveBaseSha). The sealed sha stays deterministic for the run's whole lifetime.
            // WP §3.6 RESIDUAL, named at the line it lives on: for ONE ORIGIN this is still a
            // seal-time read, so a retry after the base branch moves seals drifted material. The
            // origin path owes a first-creation pin here; it is not discharged by this lane.
            base_sha: (dependencies.resolveBase ?? resolveBaseSha)(m.repo_full_name, "refs/heads/main"),
            work_item: extra[0]!,
            worker_product: workerProduct,
            review_product: reviewProduct,
            external_verification: externalVerification,
            require_human_merge: true,
          },
        }
      : {
          vertical,
          bounds: { max_steps: boundArg(extra[1], 6), max_effects: boundArg(extra[2], 4) },
          record: {
            tenant: "cadp-disposable",
            // WP §3.6: a function of the stable origin_key, never of the wall clock.
            resource_prefix: recordResourcePrefix(origin_key),
            payloads: Array.from({ length: boundArg(extra[0], 2) }, (_, i) => `live payload ${i + 1}`),
          },
        };

  // AP B1(5)/WP §3.6: the run-origin tuple carries EXACTLY the three keys and no `work_run_ref` —
  // a tuple naming the identity would have to contain the value it is being derived to produce.
  // The Date.now-based `step_ordinal` fallback this replaces is gone from the origin path: it made
  // one logical origin allocate a FRESH identity on every retry (other verticals and paths that
  // legitimately key steps under `cadp.allocation-key.v1` are untouched).
  const allocation_tuple = { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key, purpose: "work-start" };
  const { effect_id } = await c.allocateEffectId(allocation_tuple);
  const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
  // TD §11 version exactness: bind the immutable built-image digest + observed tool versions
  // into the WORK_START worker profile, so the reviewed/live composition names the exact image.
  const image = (dependencies.imageIdentity ?? imageIdentity)(
    (dependencies.workerImage ?? readFileSync(join(dir, "worker-image"), "utf8")).trim(),
  );
  const worker_profile_digest = jcsDigest({
    profile: workerProfileDigest(),
    surface_image: image.image,
    image_digest: image.image_digest,
    tool_versions: image.tool_versions,
  }).value;
  const material = {
    workflow_id: `cadp-work-${effect_id}`,
    workflow_type: "cadpWork",
    task_queue: "cadp-worker",
    args_cas_key,
    args_digest: jcsDigest(args).value,
    bounds: args.bounds,
    worker_profile_digest,
    surface_image: image,
    continuation_target: `temporal:cadp-v04:${namespaceId}`,
  };
  const { cas_key: material_ref } = await c.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const request = await c.sealEffectRequest({
    effect_id,
    requester_ref: "workflow:cadp-work",
    work_bindings: [
      // AP B5(9) leg 3: the origin ORIGINATES its run scope's identity by binding its own
      // Platform-issued `effect_id` as its one work-run subject, on the exact declared kernel pair.
      { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: effect_id },
      { authority_ref: "github.com", namespace: "work-item", object_id: vertical === "development" ? `dev:${extra[0]}` : `record:${extra[0]}` },
      // Optional exact provenance: the WORK_PROPOSAL this item came from. A binding, never authority.
      ...(vertical === "development" && extra[3] !== undefined && extra[3] !== ""
        ? [{ authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: extra[3] }]
        : []),
    ],
    target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: namespaceId },
    operation_kind: "WORK_START",
    material_schema: "cadp.work-start.v1",
    material_ref,
    prior_effect_refs: [],
    // AP B6(1): the allocated tuple re-presented as TRANSPORT on the first seal. The Ingress strips
    // it before the draft is used, so it is never a draft field and never enters `request_digest`.
    allocation_tuple,
  });
  const input = await c.assembleAdmissionInput(effect_id, []);
  const evaluated = await c.evaluate(input.input_digest.value);
  if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
    log({ effect_id, evaluated });
    return undefined;
  }
  const admitted = await c.admitAndDispatch(effect_id, evaluated.decision.decision_id);
  log({ effect_id, workflow_id: material.workflow_id, request_digest: request.request_digest.value, admitted });
  if (admitted.kind !== "ADMITTED" || admitted.outcome.result !== "COMMITTED") return undefined;
  return { effect_id, workflow_id: material.workflow_id };
}

const KNOWN_STATUSES = ["RUNNING", "COMPLETED", "FAILED", "TERMINATED", "TIMED_OUT", "CANCELLED"] as const;

async function temporalStatus(m: LiveEnvManifest, workflowId: string): Promise<{ workflow_status: RunSnapshot["workflow_status"]; trace?: Record<string, unknown> }> {
  const { Connection, Client } = await import("@temporalio/client");
  const connection = await Connection.connect({ address: `127.0.0.1:${m.temporal_port}` });
  try {
    const handle = new Client({ connection, namespace: "cadp-v04" }).workflow.getHandle(workflowId);
    const description = await handle.describe();
    const name = description.status.name.toUpperCase();
    const workflow_status = (KNOWN_STATUSES as readonly string[]).includes(name) ? (name as RunSnapshot["workflow_status"]) : "UNKNOWN";
    if (workflow_status === "COMPLETED") return { workflow_status, trace: (await handle.result()) as Record<string, unknown> };
    return { workflow_status };
  } catch {
    return { workflow_status: "UNKNOWN" };
  } finally {
    await connection.close();
  }
}

/** One observation of a run: Temporal status (commodity) + kernel projections (observer-style reads). */
export async function runSnapshot(dir: string, workRunRef: string, workflowId?: string): Promise<{
  item: ItemStatus;
  human_wait: string[];
  attribution: Record<string, unknown>;
}> {
  const m = loadManifest(dir);
  const c = liveClient(dir, "cadp-observer");
  const status = workflowId !== undefined ? await temporalStatus(m, workflowId) : { workflow_status: "UNKNOWN" as const };
  const run = await collectRun(c, workRunRef);
  const wait = humanWait(run.effects);
  return {
    item: classifyRun({ ...status, human_wait: wait, deadline_exceeded: false }),
    human_wait: wait,
    attribution: attribution(run),
  };
}

/** Poll one work run until it settles: Temporal status + kernel human-wait projection. */
export async function pollRun(dir: string, workRunRef: string, workflowId: string, deadlineMs: number): Promise<ItemStatus> {
  const m = loadManifest(dir);
  const c = liveClient(dir, "cadp-observer");
  const startedAt = Date.now();
  for (;;) {
    const status = await temporalStatus(m, workflowId);
    const run = await collectRun(c, workRunRef);
    const item = classifyRun({ ...status, human_wait: humanWait(run.effects), deadline_exceeded: Date.now() - startedAt > deadlineMs });
    if (nextAction(item) !== "CONTINUE_POLLING") return item;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

/**
 * Proposal driver (#61): run a sealed WORK_PROPOSAL's items sequentially through the ordinary
 * governed WORK_START. Deterministic glue, zero authority: policy gates every start, an item that
 * reaches its Human merge gate is delivered (merges batch out-of-band via human-approve), and any
 * failed/stopped/stalled run halts the loop fail-closed.
 */
export async function workPlan(dir: string, proposalEvidenceId: string, maxItemsArg?: string, log: Log = SILENT): Promise<Array<Record<string, unknown>>> {
  const proposal = await loadProposal(dir, proposalEvidenceId);
  const maxItems = boundArg(maxItemsArg, proposal.items.length);
  const results: Array<Record<string, unknown>> = [];
  for (const [index, item] of proposal.items.slice(0, maxItems).entries()) {
    log({ driver: "starting", index, work_item: item.work_item, bounds: { max_steps: item.max_steps, max_effects: item.max_effects } });
    // WP §3.6: the origin's identity discriminator, derived from the pair that is already stable at
    // origin creation — so a retry of this driver over the same proposal converges on the SAME
    // `effect_id` per item instead of originating a second run for one logical origin.
    const started = await startWork(
      dir,
      "development",
      [item.work_item, String(item.max_steps), String(item.max_effects), proposalEvidenceId],
      { log, originKey: workPlanOriginKey(proposalEvidenceId, index) },
    );
    if (started === undefined) {
      results.push({ index, work_item: item.work_item, status: "NOT_ADMITTED" });
      break; // fail closed: an item the gate refused halts the loop
    }
    const settled = await pollRun(dir, started.effect_id, started.workflow_id, 30 * 60_000);
    results.push({ index, work_item: item.work_item, work_run_ref: started.effect_id, workflow_id: started.workflow_id, ...settled });
    log({ driver: "settled", index, ...settled });
    if (nextAction(settled) === "HALT") break;
  }
  return results;
}
