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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** The composition's own durable first-creation record for one run origin (WP §3.6). */
export const ORIGIN_PIN_SCHEMA = "cadp.run-origin-pin.v1";

function originPinPath(dir: string, origin_key: string): string {
  // The key is opaque (a derived digest on the `workPlan` path, a minted UUID on a direct start), so
  // it is hashed into the filename rather than trusted as one.
  return join(dir, "run-origins", `${sha256Hex(origin_key)}.json`);
}

function readOriginPin(path: string, origin_key: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // ENOENT is the FIRST attempt at this origin. Any other read failure is not evidence of that,
    // and treating it as one would resolve a fresh base for an origin that may already have sealed.
    if ((e as { code?: string }).code === "ENOENT") return undefined;
    throw e;
  }
  let pinned: { schema?: unknown; origin_key?: unknown; base_sha?: unknown };
  try {
    pinned = JSON.parse(raw) as typeof pinned;
  } catch {
    throw new Error(`unreadable run-origin pin at ${path} — refusing to re-seal this origin on an unpinned base`);
  }
  if (pinned.schema !== ORIGIN_PIN_SCHEMA || pinned.origin_key !== origin_key || typeof pinned.base_sha !== "string" || !/^[0-9a-f]{40}$/u.test(pinned.base_sha)) {
    throw new Error(`damaged run-origin pin at ${path} — refusing to re-seal this origin on an unpinned base`);
  }
  return pinned.base_sha;
}

/**
 * WP §3.6 origin-path first-creation PIN of the one sealed-material field this composition resolves
 * live. `resolveBaseSha` reads a MUTABLE remote ref, so a retry of an origin after `main` moves would
 * resolve a different tip and re-present the converged `effect_id` with drifted `args` — a different
 * `args_digest`, hence `REQUEST_DIGEST_CONFLICT` (Spec v0.5 K3), an incident and a scope hold, and
 * the origin unretryable for the store's lifetime. WP §3.6 requires the origin path to pin the
 * FIRST-CREATION value, so the first attempt at an origin resolves once and records it durably under
 * the live directory, and EVERY later attempt at that same `origin_key` reads it back verbatim and
 * never resolves again. A damaged or foreign pin fails closed: re-sealing an origin on an unpinned
 * base is exactly the drift this exists to prevent.
 *
 * Only the live-resolved field is pinned, deliberately. The rest of an origin's args — `bounds`, the
 * provider selections, each vertical's own fields — are fixed by the caller's own inputs under WP
 * §3.6 caller obligations (1)/(3) and are already pure functions of them; pinning those too would
 * silently overwrite a caller that changed them instead of letting the re-seal refuse honestly.
 */
export function pinOriginBaseSha(dir: string, origin_key: string, resolve: () => string): string {
  const path = originPinPath(dir, origin_key);
  const pinned = readOriginPin(path, origin_key);
  if (pinned !== undefined) return pinned;
  const base_sha = resolve();
  mkdirSync(join(dir, "run-origins"), { recursive: true });
  try {
    // `wx`: the first writer wins. A concurrent attempt at the SAME origin must adopt that value
    // rather than overwrite it — two attempts sealing two bases is the drift, whichever wrote last.
    writeFileSync(path, `${JSON.stringify({ schema: ORIGIN_PIN_SCHEMA, origin_key, base_sha })}\n`, { flag: "wx" });
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw e;
    const raced = readOriginPin(path, origin_key);
    if (raced === undefined) throw new Error(`run-origin pin at ${path} vanished mid-write — refusing to seal an unpinned base`);
    return raced;
  }
  return base_sha;
}

/**
 * WP §3.6 — the `workPlan` path's `origin_key`, decided ONCE per logical run origin and reproduced
 * VERBATIM on every retry of that origin. Derived canonically (`cadp-jcs-1` preimage, SHA-256) from
 * the pair already present at origin creation: the sealed proposal's `evidence_id` and the item's
 * INDEX in it. It identifies ONE LOGICAL ORIGIN, never the work's content — two items whose work
 * text is byte-identical sit at different indices and therefore carry different `origin_key`s, so
 * the identity-vs-content collision WP §3.6 exists to survive is unconstructible rather than
 * merely unlikely. Nothing about the item's content enters the preimage, deliberately.
 */
export function planOriginKey(proposal_evidence_id: string, item_index: number): string {
  return sha256Hex(jcs({ schema: "cadp.run-origin-key.v1", proposal_evidence_id, item_index }));
}

/**
 * WP §3.6's wire tuple, exactly these three keys: `schema` and `purpose` are the two reserved kernel
 * fields (AP B2(5)) and `origin_key` is the schema's single non-reserved field. It carries NO
 * `work_run_ref` — a tuple naming the identity would have to contain the value it is being derived
 * to produce (AP B5(9)) — and projects nothing onto any subject binding, the origin's self-binding
 * being verified at seal by the Authority Plane's run-origin rule rather than by a projection.
 */
export function runOriginTuple(origin_key: string): { schema: string; origin_key: string; purpose: string } {
  return { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key, purpose: "work-start" };
}

/**
 * WP §3.6 origin-path material replay stability. The record vertical's `resource_prefix` was
 * `live-${Date.now() % 100000}` — replay-UNSTABLE sealed material: one logical origin converges on
 * one `effect_id`, so a retry re-presents that id with a different `args_digest`, which is a
 * `REQUEST_DIGEST_CONFLICT` (Spec v0.5 K3), an incident and a scope hold rather than a retry, and
 * the origin is then unretryable for the store's lifetime. It is now a pure function of the stable
 * `origin_key` and of nothing else — in particular, of no clock.
 */
export function recordResourcePrefix(origin_key: string): string {
  return `live-${sha256Hex(origin_key).slice(0, 8)}`;
}

/**
 * The `WORK_START` sealed args for one origin — a PURE function of the origin's fixed inputs, so
 * one logical origin re-seals BYTE-IDENTICAL material (WP §3.6). Every clock-derived field is gone
 * from it, and the one field the composition resolves from a MUTABLE remote (`base_sha`) is supplied
 * by the caller already pinned to the origin's first creation (see `pinOriginBaseSha`).
 */
export function workStartArgs(
  vertical: "development" | "record",
  extra: string[],
  origin_key: string,
  resolved: {
    repo_id: string;
    repo_full_name: string;
    base_sha: string;
    worker_product: string;
    review_product: string;
    external_verification: boolean;
  },
): Record<string, unknown> {
  if (vertical === "development") {
    return {
      vertical,
      bounds: { max_steps: boundArg(extra[1], 8), max_effects: boundArg(extra[2], 6) },
      development: {
        repo_id: resolved.repo_id,
        repo_full_name: resolved.repo_full_name,
        base_ref: "refs/heads/main",
        base_sha: resolved.base_sha,
        work_item: extra[0]!,
        worker_product: resolved.worker_product,
        review_product: resolved.review_product,
        external_verification: resolved.external_verification,
        require_human_merge: true,
      },
    };
  }
  return {
    vertical,
    bounds: { max_steps: boundArg(extra[1], 6), max_effects: boundArg(extra[2], 4) },
    record: {
      tenant: "cadp-disposable",
      resource_prefix: recordResourcePrefix(origin_key),
      payloads: Array.from({ length: boundArg(extra[0], 2) }, (_, i) => `live payload ${i + 1}`),
    },
  };
}

/**
 * One governed WORK_START through the ordinary admission chain. `undefined` = refused, honestly
 * logged.
 *
 * This is the v0.5 RUN-ORIGIN path (WP §3.6, AP B5(9)): the allocation is
 * `cadp.allocation-key.run-origin.v1` keyed on a stable `origin_key` — supplied by `workPlan` for
 * a plan item, MINTED ONCE here for a direct CLI/MCP start — and the seal binds exactly one
 * `work-run` subject whose `object_id` is the allocated `effect_id` itself, which is the
 * self-binding `is_run_origin` requires. The wall-clock `step_ordinal` and the all-zero placeholder
 * `work_run_ref` of the old `cadp.allocation-key.v1` tuple are gone from this path: they made two
 * attempts at one logical origin mint two effect identities and made one attempt unreplayable onto
 * its own.
 *
 * DEPLOYMENT REQUIREMENT, stated rather than discovered at runtime: this path needs an active
 * `cadp.kernel-config.v2` bundle registering `cadp.allocation-key.run-origin.v1`. A
 * `cadp.kernel-config.v1` deployment refuses the allocation `ALLOCATION_TUPLE_INVALID` — v0.5 is a
 * new genesis in a new store namespace (Spec v0.5 §10), not an in-place upgrade of a v0.4 store.
 *
 * MATERIAL REPLAY STABILITY, both instances WP §3.6 names: the record vertical's clock-derived
 * `resource_prefix` is a function of `origin_key` (see `recordResourcePrefix`), and the development
 * vertical's `base_sha` — resolved from a MUTABLE remote ref, so live-varying rather than
 * clock-varying — is resolved ONCE at the origin's first creation and read back verbatim on every
 * later attempt at that `origin_key` (see `pinOriginBaseSha`). Every other sealed field is already a
 * pure function of the origin's fixed inputs, so one logical origin re-seals byte-identical material.
 */
export async function startWork(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: { originKey?: string; log?: Log } = {},
): Promise<{ effect_id: string; workflow_id: string } | undefined> {
  const log = options.log ?? SILENT;
  const m = loadManifest(dir);
  const c = liveClient(dir, "cadp-workflow");
  const namespaceId = temporalNamespaceId(m);

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
  // WP §3.6 caller obligation (1): the discriminator is decided ONCE per logical origin and
  // reproduced verbatim on retry, never re-derived per attempt and never derived from the wall
  // clock. `workPlan` supplies the stable one for a plan item; a direct start has no such pair and
  // mints one here, collision-resistantly, for this invocation.
  const origin_key = options.originKey ?? randomUUID();
  const args = workStartArgs(vertical, extra, origin_key, {
    repo_id: m.repo_id,
    repo_full_name: m.repo_full_name,
    // Resolved fresh at the origin's FIRST creation — the manifest's setup-time snapshot goes stale
    // (see resolveBaseSha) — and PINNED to that origin, so a retry of it after `main` moves seals
    // the same base rather than drifting the converged effect_id's material (WP §3.6).
    base_sha: vertical === "development"
      ? pinOriginBaseSha(dir, origin_key, () => resolveBaseSha(m.repo_full_name, "refs/heads/main"))
      : "",
    worker_product: workerProduct,
    review_product: reviewProduct,
    external_verification: externalVerification,
  });

  const { effect_id } = await c.allocateEffectId(runOriginTuple(origin_key));
  const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
  // TD §11 version exactness: bind the immutable built-image digest + observed tool versions
  // into the WORK_START worker profile, so the reviewed/live composition names the exact image.
  const image = imageIdentity(readFileSync(join(dir, "worker-image"), "utf8").trim());
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
      // WP §3.6 caller obligation (2) / AP B5(9) leg 3: EXACTLY ONE binding on the declared kernel
      // work-run pair, naming this request's OWN Platform-issued `effect_id`. The allocation
      // returned it before the seal, so the caller re-presents it and the core compares it against
      // the `effect_id` the request names — which is the whole of what makes leg 3 checkable.
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
    // AP B6(1): the allocated tuple, verbatim, as one optional top-level sibling of the draft keys.
    // REQUIRED on a first seal; ignored-if-identical and refused-if-different on an idempotent
    // re-seal, which is exactly what a retry of one origin is.
    allocation_tuple: runOriginTuple(origin_key),
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
    // WP §3.6: the item's `origin_key` is derived from the stable pair already present at origin
    // creation — this proposal's `evidence_id` and this item's index — and is therefore the SAME
    // value on every retry of this origin, which is what makes the retry converge on one
    // `effect_id` instead of minting a second logical run.
    const started = await startWork(
      dir,
      "development",
      [item.work_item, String(item.max_steps), String(item.max_effects), proposalEvidenceId],
      { log, originKey: planOriginKey(proposalEvidenceId, index) },
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
