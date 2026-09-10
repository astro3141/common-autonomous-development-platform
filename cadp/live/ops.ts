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
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadManifest } from "./env.ts";
import type { LiveEnvManifest } from "./env.ts";
import { KernelClient } from "../clients/kernelClient.ts";
import { jcsDigest, nowIso, sha256Hex } from "../kernel/canonical.ts";
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

// ================================================================ WORK_START: the two origin paths

/**
 * The v0.4 allocation's zero sentinel: under `cadp.allocation-key.v1` every tuple names a
 * `work_run_ref`, and a WORK_START's own run does not exist yet — so it names none.
 */
const V04_WORK_RUN_SENTINEL = "cadp-v04:effect:00000000-0000-7000-8000-000000000000";

/** The kernel work-run `(authority_ref, namespace)` pair a v0.5 origin binds ITSELF on (AP B5(9)). */
const WORK_RUN_AUTHORITY = "cadp-store:k04";

/**
 * Which allocation path a start takes. AP B5's run-origin migration is CONDITIONAL, never a
 * wholesale replacement: `v04` is the path this deployment has always taken (the zero-sentinel
 * `cadp.allocation-key.v1` tuple, the clock-derived `step_ordinal`, the clock-derived record
 * `resource_prefix`, no work-run binding, no origin record) and is the DEFAULT, so the live v0.4
 * deployment and every existing caller are byte-for-byte unmoved. `v05` is the run-origin path,
 * which only a `cadp.kernel-config.v2` deployment can admit at all: its Ingress is the one that
 * reads the allocation row as authority for the seal, adjudicates `is_run_origin`, and writes the
 * `run_membership(E, E)` minting witness. The v0.5 genesis composition passes `"v05"`.
 *
 * The choice is an EXPLICIT option rather than a config read because ops.ts holds no readable copy
 * of the ACTIVE kernel config: `manifest.kernel_config_path` names the kernel SERVICE config (db
 * path, ports, credentials), not the constitutional `data.cadp` bundle, and the active bundle lives
 * behind the store the operator ctl does not open on this path.
 */
export type OriginProfile = "v04" | "v05";

export interface StartWorkOptions {
  /** v0.4 only: the `step_ordinal` to allocate under. The v0.5 tuple carries no ordinal at all. */
  ordinalArg?: string;
  log?: Log;
  /** Defaults to `"v04"` — the current live behavior. */
  originProfile?: OriginProfile;
  /**
   * v0.5 only: the caller's `origin_key` for THIS logical origin. Omitted, `startWork` mints one
   * (`crypto.randomUUID`) exactly once and makes it durable before it can fail; presented, the
   * start converges on the identical `effect_id` and the identical sealed material as the
   * invocation that created the record. Inert under `v04`, which has no origin identity to name.
   */
  originKey?: string;
}

type ImageIdentity = ReturnType<typeof imageIdentity>;

/**
 * The seams a test (or an alternative composition) substitutes. Every default is exactly what
 * `startWork` did before they existed, so an omitted dependency is the live behavior.
 */
export interface StartWorkDependencies {
  manifest?: LiveEnvManifest;
  client?: Pick<KernelClient, "allocateEffectId" | "putBlob" | "sealEffectRequest" | "assembleAdmissionInput" | "evaluate" | "admitAndDispatch">;
  namespaceId?: (m: LiveEnvManifest) => string;
  resolveBase?: (repoFullName: string, baseRef: string) => string;
  workerImage?: (dir: string) => ImageIdentity;
  /** The MINT. Defaults to `crypto.randomUUID`; called at most once per `startWork`. */
  newOriginKey?: () => string;
}

interface Surfaces {
  workerProduct: ReturnType<typeof resolveWorkerProvider>;
  reviewProduct: ReturnType<typeof resolveReviewProvider>;
  externalVerification: boolean;
}

/** The surface selections `extra` names, all validated fail-closed before anything is sealed. */
function selectSurfaces(vertical: "development" | "record", extra: string[]): Surfaces {
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
  return { workerProduct, reviewProduct, externalVerification: extra[6] === "external" };
}

/**
 * The development `args`, byte-for-byte (key order included: `args` is sealed through
 * `JSON.stringify`, not JCS, so the literal below IS the CAS object). Shared by both origin paths:
 * they differ only in WHERE `base_sha` came from, never in what is built out of it.
 */
function developmentArgs(
  inputs: { repo_id: string; repo_full_name: string; base_sha: string },
  extra: string[],
  surfaces: Surfaces,
) {
  return {
    vertical: "development" as const,
    bounds: { max_steps: boundArg(extra[1], 8), max_effects: boundArg(extra[2], 6) },
    development: {
      repo_id: inputs.repo_id,
      repo_full_name: inputs.repo_full_name,
      base_ref: "refs/heads/main",
      base_sha: inputs.base_sha,
      work_item: extra[0]!,
      worker_product: surfaces.workerProduct,
      review_product: surfaces.reviewProduct,
      external_verification: surfaces.externalVerification,
      require_human_merge: true,
    },
  };
}

/** The record `args`; `resource_prefix` is the one field the two origin paths derive differently. */
function recordArgs(extra: string[], resource_prefix: string) {
  return {
    vertical: "record" as const,
    bounds: { max_steps: boundArg(extra[1], 6), max_effects: boundArg(extra[2], 4) },
    record: {
      tenant: "cadp-disposable",
      resource_prefix,
      payloads: Array.from({ length: boundArg(extra[0], 2) }, (_, i) => `live payload ${i + 1}`),
    },
  };
}

type WorkStartArgs = ReturnType<typeof developmentArgs> | ReturnType<typeof recordArgs>;

/** The `cadp.work-start.v1` material, byte-for-byte on both paths (again `JSON.stringify` order). */
function workStartMaterial(input: {
  effect_id: string;
  args: WorkStartArgs;
  args_cas_key: string;
  image: ImageIdentity;
  namespaceId: string;
}) {
  // TD §11 version exactness: bind the immutable built-image digest + observed tool versions
  // into the WORK_START worker profile, so the reviewed/live composition names the exact image.
  const worker_profile_digest = jcsDigest({
    profile: workerProfileDigest(),
    surface_image: input.image.image,
    image_digest: input.image.image_digest,
    tool_versions: input.image.tool_versions,
  }).value;
  return {
    workflow_id: `cadp-work-${input.effect_id}`,
    workflow_type: "cadpWork",
    task_queue: "cadp-worker",
    args_cas_key: input.args_cas_key,
    args_digest: jcsDigest(input.args).value,
    bounds: input.args.bounds,
    worker_profile_digest,
    surface_image: input.image,
    continuation_target: `temporal:cadp-v04:${input.namespaceId}`,
  };
}

/** The provenance bindings both paths seal; neither is authority, and neither is a work-run pair. */
function provenanceBindings(vertical: "development" | "record", extra: string[]) {
  return [
    { authority_ref: "github.com", namespace: "work-item", object_id: vertical === "development" ? `dev:${extra[0]}` : `record:${extra[0]}` },
    // Optional exact provenance: the WORK_PROPOSAL this item came from. A binding, never authority.
    ...(vertical === "development" && extra[3] !== undefined && extra[3] !== ""
      ? [{ authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: extra[3] }]
      : []),
  ];
}

function workerImageIdentity(dir: string): ImageIdentity {
  return imageIdentity(readFileSync(join(dir, "worker-image"), "utf8").trim());
}

/** assemble → evaluate → admit, identical on both paths. `undefined` = refused, honestly logged. */
async function admitWorkStart(
  c: NonNullable<StartWorkDependencies["client"]>,
  effect_id: string,
  material: { workflow_id: string },
  request_digest: string,
  log: Log,
  context: Record<string, unknown>,
): Promise<{ effect_id: string; workflow_id: string } | undefined> {
  const input = await c.assembleAdmissionInput(effect_id, []);
  const evaluated = await c.evaluate(input.input_digest.value);
  if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
    log({ ...context, effect_id, evaluated });
    return undefined;
  }
  const admitted = await c.admitAndDispatch(effect_id, evaluated.decision.decision_id);
  // B6(3): under v0.5 THIS response is where the run capability is delivered, and this line goes to
  // the operator's stdout. The secret is redacted rather than rendered; nothing on this path needs
  // it, and a log is not a place a 256-bit capability may come to rest. A v0.4 response carries no
  // such field, so the line it logs is unchanged.
  const rendered = admitted as unknown as Record<string, unknown>;
  const logged = rendered["run_capability"] === undefined ? admitted : { ...rendered, run_capability: "[redacted]" };
  log({ ...context, effect_id, workflow_id: material.workflow_id, request_digest, admitted: logged });
  if (admitted.kind !== "ADMITTED" || admitted.outcome.result !== "COMMITTED") return undefined;
  return { effect_id, workflow_id: material.workflow_id };
}

/**
 * One governed WORK_START through the ordinary admission chain. `undefined` = refused, honestly
 * logged. `options.originProfile` selects which allocation path is taken and DEFAULTS to the v0.4
 * one this deployment has always run (see `OriginProfile`).
 */
export async function startWork(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: StartWorkOptions = {},
  dependencies: StartWorkDependencies = {},
): Promise<{ effect_id: string; workflow_id: string; origin_key?: string } | undefined> {
  return (options.originProfile ?? "v04") === "v05"
    ? startWorkV05(dir, vertical, extra, options, dependencies)
    : startWorkV04(dir, vertical, extra, options, dependencies);
}

/**
 * The v0.4/v1 path, statement for statement what `startWork` has always done: the zero-sentinel
 * `cadp.allocation-key.v1` tuple under a clock-derived `step_ordinal`, the clock-derived record
 * `resource_prefix`, the two provenance bindings and no others, every environment field read fresh
 * at the point it has always been read, and NO contact with the origin-record store — a v0.4 start
 * neither reads nor writes `<dir>/origin-keys/`. `options.originKey` is inert here: v1 allocation
 * has no origin identity to name, exactly as the run-capability header is inert under v0.4.
 */
async function startWorkV04(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: StartWorkOptions,
  deps: StartWorkDependencies,
): Promise<{ effect_id: string; workflow_id: string } | undefined> {
  const log = options.log ?? SILENT;
  const m = deps.manifest ?? loadManifest(dir);
  const c = deps.client ?? liveClient(dir, "cadp-workflow");
  const namespaceId = (deps.namespaceId ?? temporalNamespaceId)(m);

  const surfaces = selectSurfaces(vertical, extra);
  const args: WorkStartArgs =
    vertical === "development"
      ? developmentArgs(
          {
            repo_id: m.repo_id,
            repo_full_name: m.repo_full_name,
            // Resolved fresh at seal time — the manifest's setup-time snapshot goes stale (see
            // resolveBaseSha). The sealed sha stays deterministic for the run's whole lifetime.
            base_sha: (deps.resolveBase ?? resolveBaseSha)(m.repo_full_name, "refs/heads/main"),
          },
          extra,
          surfaces,
        )
      : recordArgs(extra, `live-${Date.now() % 100000}`);

  const ordinal = options.ordinalArg !== undefined ? Number(options.ordinalArg) : Math.floor(Date.now() / 1000) % 1000000;
  const { effect_id } = await c.allocateEffectId({
    schema: "cadp.allocation-key.v1",
    work_run_ref: V04_WORK_RUN_SENTINEL,
    step_ordinal: ordinal,
    purpose: "work-start",
  });
  const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
  const image = (deps.workerImage ?? workerImageIdentity)(dir);
  const material = workStartMaterial({ effect_id, args, args_cas_key, image, namespaceId });
  const { cas_key: material_ref } = await c.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const request = await c.sealEffectRequest({
    effect_id,
    requester_ref: "workflow:cadp-work",
    work_bindings: provenanceBindings(vertical, extra),
    target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: namespaceId },
    operation_kind: "WORK_START",
    material_schema: "cadp.work-start.v1",
    material_ref,
    prior_effect_refs: [],
  });
  return admitWorkStart(c, effect_id, material, request.request_digest.value, log, {});
}

/**
 * The v0.5 run-origin path (AP B5(9), controls A4/A5). One logical origin — one `origin_key` — is
 * ONE `effect_id` over ONE byte-identical sealed material for the store's lifetime:
 *
 *   - the allocation tuple is `cadp.allocation-key.run-origin.v1` carrying exactly
 *     `{schema, origin_key, purpose:"work-start"}`: no run reference (the request IS the run's
 *     origin) and NO `step_ordinal`, so no wall clock enters the effect identity;
 *   - the request seals EXACTLY ONE work-run binding, whose `object_id` is the allocated
 *     `effect_id` itself — B5(9) leg 3, which is what makes this request an adjudicated origin and
 *     earns it the `run_membership(E, E)` witness its own dispatch mints against;
 *   - every environment-derived material input is taken from the origin record (below), never
 *     re-resolved, so a retry after a moved ref or a rebuilt image re-seals byte-identically and is
 *     an idempotent no-op rather than a `REQUEST_DIGEST_CONFLICT`;
 *   - the record vertical's `resource_prefix` is a function of the `origin_key`, not of `Date.now`.
 *
 * RECOVERY. A crashed or refused direct start leaves its minted `origin_key` in three places: the
 * `log` callback (emitted before anything can fail), the `origin_key` field of every error thrown
 * past this point, and `<dir>/origin-keys/<key>.json`. The operator flow is: read the record file
 * (or the log line), then re-invoke with `{ originProfile: "v05", originKey: <the recorded key> }`,
 * which converges on the same `effect_id` and the same bytes. `workPlan`'s keys need no such
 * recovery step: they are DERIVED from `proposal_evidence_id` + item index, so re-running the same
 * plan re-derives them with no file to consult (the record still fixes their MATERIAL, which is a
 * different concern and applies to derived and minted keys alike).
 */
async function startWorkV05(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: StartWorkOptions,
  deps: StartWorkDependencies,
): Promise<{ effect_id: string; workflow_id: string; origin_key: string } | undefined> {
  const log = options.log ?? SILENT;
  if (options.ordinalArg !== undefined) {
    throw new Error("ordinalArg has no meaning on the v0.5 origin path — the run-origin tuple carries no step_ordinal");
  }
  const minted = options.originKey === undefined;
  const origin_key = options.originKey ?? (deps.newOriginKey ?? randomUUID)();
  const record_path = originRecordPath(dir, origin_key);
  // DURABILITY leg one: the key is observable BEFORE the first thing that can fail. A minted key
  // that only existed inside a frame that threw would send the retry to a fresh UUID and fork the
  // run, which is exactly what one-origin-one-effect_id forbids.
  log({ origin_key, origin_key_source: minted ? "MINTED" : "PRESENTED", origin_record: record_path });
  try {
    const m = deps.manifest ?? loadManifest(dir);
    const c = deps.client ?? liveClient(dir, "cadp-workflow");
    const surfaces = selectSurfaces(vertical, extra);
    const identity = {
      origin_key,
      vertical,
      work_item_digest: argumentIdentityDigest(vertical, extra, surfaces),
    };
    // DURABILITY leg two, and the MATERIAL FIXING: resolve-once-and-record, or adopt the record
    // that already exists. Either way this completes BEFORE the first kernel call.
    const record = openOriginRecord(record_path, identity, () => resolveMaterialInputs(dir, m, vertical, deps));
    const inputs = record.material_inputs;

    const args: WorkStartArgs =
      vertical === "development"
        ? developmentArgs({ repo_id: inputs.repo_id, repo_full_name: inputs.repo_full_name, base_sha: inputs.base_sha! }, extra, surfaces)
        : recordArgs(extra, recordResourcePrefix(origin_key));
    const { effect_id } = await c.allocateEffectId(runOriginTuple(origin_key));
    const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
    const material = workStartMaterial({ effect_id, args, args_cas_key, image: inputs.worker_image, namespaceId: inputs.temporal_namespace_id });
    const { cas_key: material_ref } = await c.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
    const request = await c.sealEffectRequest({
      effect_id,
      requester_ref: "workflow:cadp-work",
      work_bindings: [
        ...provenanceBindings(vertical, extra),
        // B5(9) legs 2 and 3: exactly one binding on the declared kernel work-run pair, naming
        // this request's OWN effect_id. The run's identity IS this effect's identity.
        { authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: effect_id },
      ],
      target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: inputs.temporal_namespace_id },
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref,
      prior_effect_refs: [],
      // B6(1): the allocated tuple rides back as transport, which a v2 first seal REQUIRES.
      allocation_tuple: runOriginTuple(origin_key),
    });
    const admitted = await admitWorkStart(c, effect_id, material, request.request_digest.value, log, { origin_key });
    return admitted === undefined ? undefined : { ...admitted, origin_key };
  } catch (error) {
    throw originStartError(error, origin_key, record_path);
  }
}

/** WP §3.6's wire shape: exactly the three keys, `origin_key` the single non-reserved field. */
function runOriginTuple(origin_key: string): { schema: string; origin_key: string; purpose: string } {
  return { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key, purpose: "work-start" };
}

/**
 * The record vertical's resource namespace, a deterministic function of the origin's stable
 * `origin_key` — the same origin names the same resources on every retry, where
 * `live-${Date.now() % 100000}` named different ones each time (and collided every 100 s).
 */
function recordResourcePrefix(origin_key: string): string {
  return `live-${sha256Hex(`cadp.live.record-prefix.v1\n${origin_key}`).slice(0, 8)}`;
}

/** Every error past the mint carries the key the recovery flow needs. */
function originStartError(error: unknown, origin_key: string, record_path: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`${message} [origin_key=${origin_key}; retry with { originProfile: "v05", originKey: "${origin_key}" }; origin record ${record_path}]`, { cause: error });
  return Object.assign(wrapped, { origin_key, origin_record: record_path });
}

// ================================================================ the origin record (v0.5 only)

/**
 * THE ENVIRONMENT AUDIT of the development- and record-vertical WORK_START material.
 *
 * These are ALL the fields a start resolves from the ENVIRONMENT — the manifest, a file in the
 * deployment dir, a subprocess, the network — rather than deriving purely from `startWork`'s
 * arguments and the `origin_key`:
 *
 *   repo_id, repo_full_name  ← manifest.json      → `args.development.{repo_id,repo_full_name}`
 *   base_sha                 ← `git ls-remote`    → `args.development.base_sha`
 *                              (development only; `null` for the record vertical, which declares no base)
 *   worker_image             ← <dir>/worker-image → `material.surface_image` AND, through its three
 *                              + `docker inspect`    members, `material.worker_profile_digest`
 *   temporal_namespace_id    ← `temporal operator  → `material.continuation_target` AND the sealed
 *                              namespace describe`   `target_ref.target_id`
 *
 * Everything else that reaches the sealed bytes is argument-derived, origin-derived or a code
 * constant: the bounds/work_item/payload count and the three surface selections come from `extra`,
 * `workflow_id` is a function of the `effect_id` (hence of the `origin_key`), `args_cas_key` and
 * `args_digest` are functions of `args`, the record `resource_prefix` is a function of the
 * `origin_key`, `workerProfileDigest()` digests code constants, and `workflow_type`, `task_queue`,
 * `base_ref`, `tenant` and `require_human_merge` are literals.
 *
 * THE INVARIANT this record enforces: on the v0.5 origin path every field in that list is resolved
 * EXACTLY ONCE, at origin creation, and persisted here. A retry that finds a record reconstructs
 * the material EXCLUSIVELY from {the record + the function arguments + the origin_key} and
 * recomputes NOTHING from the environment — so a moved `refs/heads/main`, a rebuilt worker image or
 * a re-created Temporal namespace cannot make one logical origin seal two different byte strings
 * under one `effect_id` (which is a `REQUEST_DIGEST_CONFLICT` and a stuck run).
 *
 * A NEW environment-derived material field added WITHOUT joining `MaterialInputs` and
 * `REQUIRED_MATERIAL_INPUT_KEYS` is exactly the drift this invariant forbids: it would be re-read
 * on every retry and would reopen that conflict. Joining the record is a deliberate act, and the
 * exact-key validation below is what makes forgetting it fail loudly on the NEXT retry rather than
 * quietly at the seal.
 */
interface MaterialInputs {
  repo_id: string;
  repo_full_name: string;
  /** `null` on the record vertical, which resolves no base at all — absent is a different thing. */
  base_sha: string | null;
  worker_image: ImageIdentity;
  temporal_namespace_id: string;
}

interface OriginRecordV1 {
  record_version: 1;
  /** ARGUMENT-derived, and therefore VERIFIED against a presenting invocation, never adopted. */
  origin_key: string;
  vertical: "development" | "record";
  work_item_digest: string;
  /** ENVIRONMENT-derived, and therefore ADOPTED by a presenting invocation, never re-resolved. */
  material_inputs: MaterialInputs;
  created_at: string;
}

const ORIGIN_RECORD_VERSION = 1;
const REQUIRED_RECORD_KEYS = ["created_at", "material_inputs", "origin_key", "record_version", "vertical", "work_item_digest"] as const;
const REQUIRED_MATERIAL_INPUT_KEYS = ["base_sha", "repo_full_name", "repo_id", "temporal_namespace_id", "worker_image"] as const;
const REQUIRED_WORKER_IMAGE_KEYS = ["image", "image_digest", "tool_versions"] as const;

/**
 * ONE FILE PER ORIGIN — no shared file, no lock, no reclamation. A lock over a shared file needs a
 * stale-lock policy, and every stale-lock policy can steal a live lock and lose a record; a record
 * that is its own file needs none of it.
 *
 * The stem is the `origin_key` itself when it is filesystem-safe (a `randomUUID` and a derived hex
 * digest both are), and its sha256 otherwise, so a caller-chosen key can never escape the
 * directory or collide with a neighbour's name. The `origin_key` is kept INSIDE the record and
 * verified on adoption, which closes the (absurd but free to close) case of a literal key equal to
 * some other key's digest.
 */
export function originRecordPath(dir: string, origin_key: string): string {
  const stem = /^[A-Za-z0-9._-]{1,120}$/u.test(origin_key) && !origin_key.startsWith(".") ? origin_key : sha256Hex(origin_key);
  return join(dir, "origin-keys", `${stem}.json`);
}

/** The ARGUMENT identity of one origin: everything `extra` decides, and nothing the environment does. */
function argumentIdentityDigest(vertical: "development" | "record", extra: string[], surfaces: Surfaces): string {
  return jcsDigest(
    vertical === "development"
      ? {
          vertical,
          work_item: extra[0] ?? "",
          max_steps: boundArg(extra[1], 8),
          max_effects: boundArg(extra[2], 6),
          proposal_evidence_id: extra[3] !== undefined && extra[3] !== "" ? extra[3] : null,
          worker_product: surfaces.workerProduct,
          review_product: surfaces.reviewProduct,
          external_verification: surfaces.externalVerification,
        }
      : {
          vertical,
          payloads: boundArg(extra[0], 2),
          max_steps: boundArg(extra[1], 6),
          max_effects: boundArg(extra[2], 4),
        },
  ).value;
}

/** The audit's whole set, resolved exactly once — at origin creation and nowhere else. */
function resolveMaterialInputs(
  dir: string,
  m: LiveEnvManifest,
  vertical: "development" | "record",
  deps: StartWorkDependencies,
): MaterialInputs {
  return {
    repo_id: m.repo_id,
    repo_full_name: m.repo_full_name,
    base_sha: vertical === "development" ? (deps.resolveBase ?? resolveBaseSha)(m.repo_full_name, "refs/heads/main") : null,
    worker_image: (deps.workerImage ?? workerImageIdentity)(dir),
    temporal_namespace_id: (deps.namespaceId ?? temporalNamespaceId)(m),
  };
}

function assertExactKeys(value: unknown, required: readonly string[], path: string, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`origin record ${path} is unusable: ${what} is not an object`);
  }
  const present = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...required].sort();
  if (present.length !== expected.length || present.some((key, i) => key !== expected[i])) {
    throw new Error(`origin record ${path} is unusable: ${what} carries keys [${present.join(", ")}], not exactly [${expected.join(", ")}]`);
  }
  return value as Record<string, unknown>;
}

/**
 * COMPLETE OR REFUSED. An adopted record is never patched from the environment field by field: a
 * per-field fallback is precisely the drift the invariant above forbids, only harder to see. An
 * unparseable record, an unknown `record_version` or a missing/extra key is an operator-visible
 * refusal naming the file, raised BEFORE any kernel call — the operator deletes or repairs the file
 * deliberately, and the code never guesses on their behalf.
 *
 * This pairs with how records are WRITTEN: one complete object, written only AFTER every
 * environment resolution succeeded. So RECORD EXISTS ⇒ resolution completed ⇒ the material is fully
 * pinned; NO RECORD ⇒ nothing happened yet (a resolution failure writes nothing, and no kernel call
 * was made either, so the clean retry re-resolves everything from scratch and is correct).
 */
function parseOriginRecord(path: string, text: string): OriginRecordV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`origin record ${path} is unparseable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = assertExactKeys(parsed, REQUIRED_RECORD_KEYS, path, "the record");
  if (record["record_version"] !== ORIGIN_RECORD_VERSION) {
    throw new Error(`origin record ${path} is version ${JSON.stringify(record["record_version"])}, not ${ORIGIN_RECORD_VERSION}`);
  }
  const inputs = assertExactKeys(record["material_inputs"], REQUIRED_MATERIAL_INPUT_KEYS, path, "material_inputs");
  const image = assertExactKeys(inputs["worker_image"], REQUIRED_WORKER_IMAGE_KEYS, path, "material_inputs.worker_image");
  if (record["vertical"] !== "development" && record["vertical"] !== "record") {
    throw new Error(`origin record ${path} names an unknown vertical ${JSON.stringify(record["vertical"])}`);
  }
  const vertical = record["vertical"] as "development" | "record";
  const base_sha = inputs["base_sha"];
  const baseShaOk = vertical === "development" ? typeof base_sha === "string" && /^[0-9a-f]{40}$/u.test(base_sha) : base_sha === null;
  if (!baseShaOk) throw new Error(`origin record ${path} carries base_sha ${JSON.stringify(base_sha)}, which the ${vertical} vertical cannot use`);
  for (const [key, value] of [["origin_key", record["origin_key"]], ["work_item_digest", record["work_item_digest"]], ["created_at", record["created_at"]], ["repo_id", inputs["repo_id"]], ["repo_full_name", inputs["repo_full_name"]], ["temporal_namespace_id", inputs["temporal_namespace_id"]], ["worker_image.image", image["image"]], ["worker_image.image_digest", image["image_digest"]]] as const) {
    if (typeof value !== "string" || value === "") throw new Error(`origin record ${path} carries a non-string ${key}`);
  }
  const tool_versions = image["tool_versions"];
  if (typeof tool_versions !== "object" || tool_versions === null || Array.isArray(tool_versions) || Object.values(tool_versions).some((v) => typeof v !== "string")) {
    throw new Error(`origin record ${path} carries a malformed material_inputs.worker_image.tool_versions`);
  }
  return {
    record_version: ORIGIN_RECORD_VERSION,
    origin_key: record["origin_key"] as string,
    vertical,
    work_item_digest: record["work_item_digest"] as string,
    material_inputs: {
      repo_id: inputs["repo_id"] as string,
      repo_full_name: inputs["repo_full_name"] as string,
      base_sha: base_sha as string | null,
      worker_image: {
        image: image["image"] as string,
        image_digest: image["image_digest"] as string,
        tool_versions: tool_versions as Record<string, string>,
      },
      temporal_namespace_id: inputs["temporal_namespace_id"] as string,
    },
    created_at: record["created_at"] as string,
  };
}

type OriginIdentity = Pick<OriginRecordV1, "origin_key" | "vertical" | "work_item_digest">;

/**
 * ADOPTION IS GUARDED. Environment-derived fields are adopted from the record; ARGUMENT-derived
 * fields are VERIFIED against it, on the read path and on the write-race path alike. One
 * `origin_key` identifies ONE logical origin with ONE argument set: presenting a recorded key with
 * different arguments is a caller contract violation and is refused BEFORE any kernel call, never
 * silently adopted into a seal that would then carry the other origin's material.
 */
function assertOriginIdentity(record: OriginRecordV1, presented: OriginIdentity, path: string): void {
  if (record.origin_key !== presented.origin_key) {
    throw new Error(`origin record ${path} belongs to origin_key ${record.origin_key}, not ${presented.origin_key}`);
  }
  if (record.vertical !== presented.vertical) {
    throw new Error(`origin_key ${presented.origin_key} was created for the ${record.vertical} vertical, presented as ${presented.vertical} (record ${path})`);
  }
  if (record.work_item_digest !== presented.work_item_digest) {
    throw new Error(
      `origin_key ${presented.origin_key} was created for a different work item: recorded work_item_digest ${record.work_item_digest}, presented ${presented.work_item_digest} (record ${path}). ` +
        "One origin_key identifies ONE logical origin with ONE argument set — reuse it verbatim for a retry, or mint a new key for new arguments.",
    );
  }
}

/**
 * Read the origin's record, or create it. Concurrency without a lock: the record is written to a
 * tmp name in the SAME directory (so the content is complete before it has a name anyone reads) and
 * then LINKED into place. `link` is the atomic create-if-absent primitive — `rename` would clobber
 * a record that is already there, and clobbering is the one thing this must never do, because two
 * racers on one key may have resolved DIFFERENT environments (a ref that moved between them) and
 * the loser adopting the winner's material is what makes them converge on one seal. So: first
 * writer wins, the loser reads the winner's record back and adopts it, and no lock, TTL,
 * reclamation or deletion exists to go wrong.
 */
function openOriginRecord(path: string, identity: OriginIdentity, resolve: () => MaterialInputs): OriginRecordV1 {
  if (existsSync(path)) {
    const existing = parseOriginRecord(path, readFileSync(path, "utf8"));
    assertOriginIdentity(existing, identity, path);
    return existing;
  }
  const record: OriginRecordV1 = {
    record_version: ORIGIN_RECORD_VERSION,
    origin_key: identity.origin_key,
    vertical: identity.vertical,
    work_item_digest: identity.work_item_digest,
    material_inputs: resolve(), // every environment read of this start happens HERE, once
    created_at: nowIso(),
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  try {
    linkSync(tmp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const winner = parseOriginRecord(path, readFileSync(path, "utf8"));
    assertOriginIdentity(winner, identity, path);
    return winner;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* the tmp link is best-effort cleanup; the record itself is already durable */
    }
  }
  return record;
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
 *
 * `options.originProfile` is passed straight through to every item's `startWork` and defaults to
 * `"v04"`, so the live driver is unmoved. `dependencies` are `startWork`'s seams plus a `proposal`
 * that skips the K2 read, for compositions (and tests) that already hold the parsed proposal.
 */
export async function workPlan(
  dir: string,
  proposalEvidenceId: string,
  maxItemsArg?: string,
  log: Log = SILENT,
  options: { originProfile?: OriginProfile } = {},
  dependencies: StartWorkDependencies & { proposal?: WorkProposalV1 } = {},
): Promise<Array<Record<string, unknown>>> {
  const { proposal: presetProposal, ...startDependencies } = dependencies;
  const proposal = presetProposal ?? (await loadProposal(dir, proposalEvidenceId));
  const maxItems = boundArg(maxItemsArg, proposal.items.length);
  const results: Array<Record<string, unknown>> = [];
  const originProfile = options.originProfile ?? "v04";
  for (const [index, item] of proposal.items.slice(0, maxItems).entries()) {
    log({ driver: "starting", index, work_item: item.work_item, bounds: { max_steps: item.max_steps, max_effects: item.max_effects } });
    // The plan's origin keys are DERIVED, not minted: the sealed proposal and the item's position
    // in it already identify the logical origin exactly, so re-running the same plan re-derives the
    // same keys with no file to consult and no minting to recover. (The origin RECORD still fixes
    // this origin's material — that is the separate move that keeps a retry byte-identical when
    // main has moved under it, and it applies to derived and minted keys alike.) Inert under v04.
    const started = await startWork(
      dir,
      "development",
      [item.work_item, String(item.max_steps), String(item.max_effects), proposalEvidenceId],
      { log, originProfile, originKey: workPlanOriginKey(proposalEvidenceId, index) },
      startDependencies,
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

/**
 * The stable `origin_key` of one plan item: a function of the sealed proposal's evidence id and the
 * item's index in it, and of nothing else. Two items of one proposal are two logical origins (leg
 * o-i's distinctness), the same item of the same proposal is one logical origin on every re-run,
 * and no wall clock, counter or process-local state enters it.
 */
export function workPlanOriginKey(proposalEvidenceId: string, index: number): string {
  return jcsDigest({ schema: "cadp.live.work-plan-origin.v1", proposal_evidence_id: proposalEvidenceId, item_index: index }).value;
}
