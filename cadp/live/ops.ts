/**
 * Shared live-composition operations (#61): the plan / governed-WORK_START / run-polling glue
 * used by both the CLI (`ctl.ts`) and the MCP tool surface (`mcpServer.ts`).
 *
 * Nothing here is authority: `sealPlan` produces proposal plus planner-observation evidence, `startWork` goes through the
 * ordinary governed admission (policy gates every start), and `pollRun`/`runSnapshot` are
 * observations. Callers own presentation; `log` defaults to silent so a protocol server's stdout
 * stays clean.
 *
 * `startWork` is also the RUN ORIGIN path of WP §3.6: it allocates the originating `WORK_START`'s
 * identity under `cadp.allocation-key.run-origin.v1` from an `origin_key` decided ONCE per logical
 * origin, binds that `effect_id` as the request's own `work-run` subject (AP B5(9)), and seals
 * material carrying no wall-clock input, so one origin retries onto one identity with byte-
 * identical material instead of forking into a second run. See `workPlanOriginKey` for the two
 * derivations, `recordMintedOrigin` for the durability contract a minted key carries, and
 * `runOriginUnavailable` for the v0.4 generation seam that keeps the live pilot unchanged.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifest } from "./env.ts";
import type { LiveEnvManifest } from "./env.ts";
import { KernelApiError, KernelClient } from "../clients/kernelClient.ts";
import { jcsDigest, sha256Hex } from "../kernel/canonical.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA } from "../kernel/policyBundle.ts";
import type { AllocationTuple } from "../kernel/ingress.ts";
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

// ---------------------------------------------------------------- run origin (WP §3.6)

/**
 * WP §3.6 — `origin_key` is a WORKFLOW-OWNED OPAQUE IDEMPOTENCY DISCRIMINATOR: the Workflow side
 * decides it ONCE, when it creates a logical run origin, and preserves it VERBATIM across every
 * retry of that origin, which is what makes the retry converge on the SAME `effect_id`.
 *
 * It identifies the ORIGIN, never the work's CONTENT. A tuple keyed on `{repo_id, base_sha,
 * work_item}` would collide two DISTINCT runs over byte-identical work onto one `effect_id`, and
 * the second origin's first seal — differing on `bounds`/`worker_product`/`review_product`, or on
 * the record path on `resource_prefix` — would land `REQUEST_DIGEST_CONFLICT`, a K3 incident and a
 * scope hold rather than a second run (WP §3.6; AP control A5 leg o-i). That is the failure this
 * discriminator makes unconstructible, so nothing about the work is digested to name its origin.
 *
 * This composition has exactly two derivations and no third:
 *
 *  - `workPlan`: the stable `(proposal_evidence_id, item index)` pair, which is already present at
 *    origin creation. The encoding is INJECTIVE — a kernel evidence id carries no `#`, so the text
 *    after the final `#` is the index and the pair is recoverable — and, decisively, it is
 *    REPRODUCIBLE FROM THE SEALED PROPOSAL ALONE. That is why the plan path needs no local state
 *    record: re-running `workPlan` over the same `proposal_evidence_id` re-derives every item's
 *    `origin_key` verbatim with nothing local to lose, so there is no minted secret to make durable.
 *  - a direct `startWork`: no such pair exists, so one is MINTED with `crypto.randomUUID` exactly
 *    once per logical start and made durable BEFORE the first kernel call (`recordMintedOrigin`).
 */
export function workPlanOriginKey(proposalEvidenceId: string, index: number): string {
  return `cadp-origin:v1:work-plan:${proposalEvidenceId}#${index}`;
}

/** One minted `origin_key` for one logical direct start. Called ONCE — never once per attempt. */
export function mintOriginKey(): string {
  return `cadp-origin:v1:direct:${randomUUID()}`;
}

/** WP §3.6's wire shape, formed here and nowhere else: EXACTLY `{schema, origin_key, purpose}`. */
function runOriginTuple(origin_key: string): AllocationTuple {
  return { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key, purpose: "work-start" };
}

/**
 * The v0.4 all-zero placeholder `work_run_ref`. It is kept for the GENERATION FALLBACK below and
 * for nothing else: a `cadp.kernel-config.v1` deployment accepts no other allocation schema, so
 * this is the tuple the live v0.4 pilot still allocates its origin identity under.
 */
const V04_ORIGIN_SENTINEL_WORK_RUN_REF = "cadp-v04:effect:00000000-0000-7000-8000-000000000000";

/**
 * The v0.4 fallback tuple's `step_ordinal`, a DETERMINISTIC function of the origin's own
 * `origin_key` — the wall clock (`Math.floor(Date.now() / 1000) % 1000000`) is GONE from this path.
 * A wall-clock ordinal means one logical origin mints a fresh effect identity on every attempt and
 * can never be replayed onto its own (WP §3.6, measured gap). The range is 1..999999, the shape the
 * v0.4 tuple already has, and the value is `POSITIVE_INTEGER` as that schema's descriptor requires.
 */
export function originStepOrdinal(origin_key: string): number {
  return (Number.parseInt(sha256Hex(origin_key).slice(0, 12), 16) % 999_999) + 1;
}

/**
 * The record vertical's `resource_prefix`, a DETERMINISTIC function of the origin's `origin_key`.
 * It replaces `live-${Date.now() % 100000}`, which WP §3.6 names as the checked-out instance of
 * replay-unstable SEALED MATERIAL: two attempts at one origin sealed different `args`, hence a
 * different `args_digest` and `material_ref`, so the converged `effect_id` re-sealed with a
 * different semantic payload — `REQUEST_DIGEST_CONFLICT`, an incident and a scope hold, leaving the
 * origin unretryable for the store's lifetime. Distinct origins still get distinct prefixes (the
 * origin_key is what distinguishes them), which is what keeps two record runs off one resource.
 */
export function originResourcePrefix(origin_key: string): string {
  return `live-${sha256Hex(origin_key).slice(0, 12)}`;
}

/** The durability record a MINTED `origin_key` leaves before anything can fail. */
export interface OriginKeyRecord {
  origin_key: string;
  work_item_digest: string;
  created_at: string;
}

export const ORIGIN_KEY_RECORD_FILE = "origin-keys.json";

/**
 * ORIGIN-KEY DURABILITY. A minted `origin_key` is the ONLY thing that can bring a retry back onto
 * the same origin, so it must survive the process that minted it: if a direct start dies between
 * minting and its first kernel call, a retry that minted a FRESH uuid would fork the logical origin
 * into two run identities, which is exactly what WP §3.6's "decide once, preserve verbatim" forbids.
 * The record is therefore written BEFORE the first kernel call, and the same key is additionally
 * emitted through the `log` callback and carried on every error this path throws.
 *
 * RECOVERY FLOW for a crashed or refused direct start: read `<dir>/origin-keys.json`, take the
 * record whose `work_item_digest` matches the start being retried (it is the newest such line), and
 * re-invoke `startWork(..., { originKey })` with that `origin_key` verbatim. The allocation
 * re-derives the same key and returns the SAME `effect_id`, so the retry converges on the origin
 * instead of forking it. `workPlan`'s derived keys need no record at all — see `workPlanOriginKey`.
 *
 * The file is APPEND-ONLY, one JSON object per line, written with a single `appendFileSync`: a
 * read-modify-write of a JSON array would have to parse whatever is already there, which turns one
 * corrupt byte into a start that either refuses or silently discards prior records. A torn final
 * line costs at most the record being written, never a record already on disk.
 */
export function recordMintedOrigin(dir: string, record: OriginKeyRecord): void {
  appendFileSync(join(dir, ORIGIN_KEY_RECORD_FILE), `${JSON.stringify(record)}\n`, "utf8");
}

/** The recovery-flow read of the file above. Unparseable lines are skipped, never fatal. */
export function readOriginKeyRecords(dir: string): OriginKeyRecord[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, ORIGIN_KEY_RECORD_FILE), "utf8");
  } catch {
    return []; // no direct start has minted here yet
  }
  const records: OriginKeyRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as OriginKeyRecord);
    } catch { /* a torn final line from a crash mid-append: skip it, keep every complete record */ }
  }
  return records;
}

/**
 * Every failure of an origin whose `origin_key` this process decided carries that key, so a
 * caller that never reaches the returned result still learns which origin to retry with. The
 * message names the exact re-invocation, because the recovery is a caller action.
 */
export class StartWorkOriginError extends Error {
  readonly origin_key: string;

  constructor(origin_key: string, dir: string, cause: unknown) {
    super(
      `${cause instanceof Error ? cause.message : String(cause)} — origin_key ${origin_key}; retry with ` +
        `startWork(..., { originKey: "${origin_key}" }) to converge on the same effect_id ` +
        `(recorded in ${join(dir, ORIGIN_KEY_RECORD_FILE)})`,
    );
    this.name = "StartWorkOriginError";
    this.origin_key = origin_key;
    this.cause = cause;
  }
}

/**
 * The exact seam between the v0.5 origin path and the v0.4 one, and the two refusals that ARE that
 * seam — neither is a caller error and neither may be swallowed more broadly than this:
 *  - `ALLOCATION_TUPLE_INVALID` on `schema`: a `cadp.kernel-config.v1` deployment, whose hard-coded
 *    validation accepts `cadp.allocation-key.v1` and nothing else. This is the LIVE v0.4 pilot.
 *  - `ALLOCATION_SCHEMA_UNREGISTERED`: a v2 deployment whose bundle carries no run-origin registry
 *    entry — the registry-inactive posture, which must behave exactly as v0.4 does here.
 * Any other refusal (a malformed tuple, an unregistered purpose, an unregistered principal) is a
 * real error about THIS request and is rethrown unchanged rather than retried under another schema.
 */
function runOriginUnavailable(error: unknown): boolean {
  if (!(error instanceof KernelApiError)) return false;
  if (error.reason === "ALLOCATION_SCHEMA_UNREGISTERED") return true;
  return error.reason === "ALLOCATION_TUPLE_INVALID" && error.detail === "schema";
}

/** The exact Kernel API slice `startWork` uses; `KernelClient` satisfies it structurally. */
export type StartWorkKernelClient = Pick<
  KernelClient,
  "allocateEffectId" | "putBlob" | "sealEffectRequest" | "assembleAdmissionInput" | "evaluate" | "admitAndDispatch"
>;

/** Injection seams for the non-kernel reads `startWork` performs (git, docker, the temporal CLI). */
export interface StartWorkDependencies {
  manifest?: LiveEnvManifest;
  client?: StartWorkKernelClient;
  namespaceId?: (m: LiveEnvManifest) => string;
  resolveBase?: (repoFullName: string, baseRef: string) => string;
  imageIdentity?: (dir: string) => { image: string; image_digest: string; tool_versions: Record<string, string> };
  now?: () => string;
}

/**
 * Allocate this origin's `WORK_START` identity (WP §3.6). The run-origin tuple is what this path
 * presents; the v0.4 tuple is reached ONLY through the generation seam above, so a v0.5 deployment
 * never sees the zero sentinel and a v0.4 deployment is byte-identical to what it is today apart
 * from the ordinal, which is now the origin's own rather than the clock's.
 */
async function allocateOrigin(
  c: StartWorkKernelClient,
  origin_key: string,
  ordinalArg: string | undefined,
): Promise<{ effect_id: string; tuple: AllocationTuple; run_origin: boolean }> {
  const tuple = runOriginTuple(origin_key);
  try {
    return { effect_id: (await c.allocateEffectId(tuple)).effect_id, tuple, run_origin: true };
  } catch (error) {
    if (!runOriginUnavailable(error)) throw error;
  }
  // `ordinalArg` is a v0.4-tuple override and has no meaning under `run-origin.v1`, whose key set
  // is exactly `{schema, origin_key, purpose}` — presenting a `step_ordinal` there would be a key
  // outside the descriptor's set and refused `ALLOCATION_TUPLE_INVALID` (AP B2(5)).
  const fallback: AllocationTuple = {
    schema: "cadp.allocation-key.v1",
    work_run_ref: V04_ORIGIN_SENTINEL_WORK_RUN_REF,
    step_ordinal: ordinalArg !== undefined ? Number(ordinalArg) : originStepOrdinal(origin_key),
    purpose: "work-start",
  };
  return { effect_id: (await c.allocateEffectId(fallback)).effect_id, tuple: fallback, run_origin: false };
}

/**
 * One governed WORK_START through the ordinary admission chain. `undefined` = refused, honestly
 * logged. This is the RUN ORIGIN (WP §3.6): the `WORK_START` that originates a run has no run to
 * belong to yet, so it mints its own scope's identity through `cadp.allocation-key.run-origin.v1`
 * and binds its own Platform-issued `effect_id` as its `work-run` subject, which is the self-origin
 * relation AP B5(9) authenticates at seal.
 *
 * `options.originKey` is the RETRY seam and the whole of the caller contract: pass the origin's own
 * key back and the allocation converges on the same `effect_id`; omit it and one is minted here,
 * exactly once, and made durable before anything can fail (`recordMintedOrigin`).
 */
export async function startWork(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: {
    ordinalArg?: string;
    log?: Log;
    /** WP §3.6: this logical origin's key, decided by the caller ONCE and repeated verbatim. */
    originKey?: string;
    dependencies?: StartWorkDependencies;
  } = {},
): Promise<{ effect_id: string; workflow_id: string; origin_key: string } | undefined> {
  const log = options.log ?? SILENT;
  const dependencies = options.dependencies ?? {};
  const m = dependencies.manifest ?? loadManifest(dir);
  const c = dependencies.client ?? liveClient(dir, "cadp-workflow");
  const namespaceId = (dependencies.namespaceId ?? temporalNamespaceId)(m);

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

  // The logical origin is decided HERE — once — and after the fail-closed entry checks above, none
  // of which has created an origin to record. A minted key is emitted and persisted BEFORE the
  // first kernel call, so a process that dies at any point past this line leaves the key it would
  // need to converge rather than a fork.
  const minted = options.originKey === undefined;
  const origin_key = options.originKey ?? mintOriginKey();
  if (minted) {
    const record: OriginKeyRecord = {
      origin_key,
      work_item_digest: jcsDigest({ vertical, work_item: extra[0] ?? "" }).value,
      created_at: (dependencies.now ?? (() => new Date().toISOString()))(),
    };
    // EMITTED first, then PERSISTED: if the append itself fails (a read-only deployment dir, say)
    // the start refuses with nothing kernel-side done — and the operator has already been handed
    // the key, so even that refusal cannot lose it.
    log({ origin: "MINTED", origin_key, vertical, work_item_digest: record.work_item_digest });
    recordMintedOrigin(dir, record);
  }
  try {
    // WP §3.6, ORIGIN IDENTITY FIRST: the allocation returns the `effect_id` the seal below binds
    // as its own `work-run` subject, so identity precedes material on this path by construction.
    const { effect_id, tuple, run_origin } = await allocateOrigin(c, origin_key, options.ordinalArg);
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
              //
              // NOT wall-clock derived, but the one remaining input on this branch that a retry
              // could observe differently: WP §3.6 names it as the second instance of the
              // replay-stability shape (a retry after `refs/heads/main` moves seals a different
              // `base_sha` for the same origin) and requires the origin path to pin its
              // first-creation value. Pinning it needs a durable per-origin ARGS record, which is a
              // wider state contract than this lane's minted-key record, and is left to that lane.
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
              // A function of THIS origin's key, never of the wall clock (WP §3.6; see
              // `originResourcePrefix` for the conflict a clock-derived prefix seals into a retry).
              resource_prefix: originResourcePrefix(origin_key),
              payloads: Array.from({ length: boundArg(extra[0], 2) }, (_, i) => `live payload ${i + 1}`),
            },
          };

    const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
    // TD §11 version exactness: bind the immutable built-image digest + observed tool versions
    // into the WORK_START worker profile, so the reviewed/live composition names the exact image.
    const image = (dependencies.imageIdentity ?? ((d: string) => imageIdentity(readFileSync(join(d, "worker-image"), "utf8").trim())))(dir);
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
        { authority_ref: "github.com", namespace: "work-item", object_id: vertical === "development" ? `dev:${extra[0]}` : `record:${extra[0]}` },
        // AP B5(9) legs 2 and 3: EXACTLY ONE binding on the declared kernel work-run pair, naming
        // this request's OWN `effect_id`. That self-origin relation is what the Ingress
        // authenticates at seal, and its `run_membership(E, E)` row is the durable witness that
        // makes this effect minting at its own initial dispatch (AP B5(1)(b), B5(5)).
        //
        // Sealed only on the v0.5 origin path. Under the v0.4 generation seam the kernel expresses
        // no run profile at all, so the binding would authenticate nothing while still joining this
        // effect to its own run's `MAX_EFFECTS_IN_WORK_RUN` count — a live v0.4 behaviour delta for
        // no v0.4 gain. On the v0.5 path that count including the origin is the mechanism's own.
        ...(run_origin ? [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: effect_id }] : []),
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
      // AP B6(1)/B2(3): transport, never a draft field — the Ingress strips it before anything reads
      // the draft, so the sealed record and its `request_digest` are byte-identical to a seal that
      // presented nothing. A v2 first seal REQUIRES it (`ALLOCATION_TUPLE_REQUIRED`); a v1
      // deployment holds no allocation binding to check it against and ignores it exactly as today.
      allocation_tuple: tuple,
    });
    const input = await c.assembleAdmissionInput(effect_id, []);
    const evaluated = await c.evaluate(input.input_digest.value);
    if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
      // The refusal is honestly logged WITH its origin_key: this origin's identity is already
      // allocated and sealed, so the retry that converges onto it is the one carrying this key.
      log({ effect_id, origin_key, evaluated });
      return undefined;
    }
    const admitted = await c.admitAndDispatch(effect_id, evaluated.decision.decision_id);
    // AP B6(4): the VERIFIED INITIAL DISPATCH of a witnessed origin delivers this run's capability
    // in that response. It is a SECRET — a bearer credential for the whole run scope — so only its
    // PRESENCE is logged; the response is never rendered whole. Handing it to the run's holder is
    // the delivery lane's job, not this log line's.
    const { run_capability, ...admittedForLog } = admitted as typeof admitted & { run_capability?: string };
    log({
      effect_id, origin_key, run_origin, workflow_id: material.workflow_id,
      request_digest: request.request_digest.value, admitted: admittedForLog,
      ...(run_capability !== undefined ? { run_capability_delivered: true } : {}),
    });
    if (admitted.kind !== "ADMITTED" || admitted.outcome.result !== "COMMITTED") return undefined;
    return { effect_id, workflow_id: material.workflow_id, origin_key };
  } catch (error) {
    throw new StartWorkOriginError(origin_key, dir, error);
  }
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
interface WorkPlanDependencies {
  loadProposal?: (dir: string, proposalEvidenceId: string) => Promise<WorkProposalV1>;
  startWork?: typeof startWork;
  pollRun?: (dir: string, workRunRef: string, workflowId: string, deadlineMs: number) => Promise<ItemStatus>;
}

export async function workPlan(
  dir: string,
  proposalEvidenceId: string,
  maxItemsArg?: string,
  log: Log = SILENT,
  dependencies: WorkPlanDependencies = {},
): Promise<Array<Record<string, unknown>>> {
  const proposal = await (dependencies.loadProposal ?? loadProposal)(dir, proposalEvidenceId);
  const start = dependencies.startWork ?? startWork;
  const poll = dependencies.pollRun ?? pollRun;
  const maxItems = boundArg(maxItemsArg, proposal.items.length);
  const results: Array<Record<string, unknown>> = [];
  for (const [index, item] of proposal.items.slice(0, maxItems).entries()) {
    // WP §3.6: this item's logical origin, derived from the stable pair the driver already holds
    // and threaded into `startWork` so a re-run of this plan converges on the SAME `effect_id`
    // rather than forking the item into a second run identity. Derived, so nothing is minted and
    // no local record is needed to reproduce it — the sealed proposal is the whole input.
    const originKey = workPlanOriginKey(proposalEvidenceId, index);
    log({ driver: "starting", index, origin_key: originKey, work_item: item.work_item, bounds: { max_steps: item.max_steps, max_effects: item.max_effects } });
    const started = await start(dir, "development", [item.work_item, String(item.max_steps), String(item.max_effects), proposalEvidenceId], { log, originKey });
    if (started === undefined) {
      results.push({ index, origin_key: originKey, work_item: item.work_item, status: "NOT_ADMITTED" });
      break; // fail closed: an item the gate refused halts the loop
    }
    const settled = await poll(dir, started.effect_id, started.workflow_id, 30 * 60_000);
    results.push({ index, origin_key: started.origin_key, work_item: item.work_item, work_run_ref: started.effect_id, workflow_id: started.workflow_id, ...settled });
    log({ driver: "settled", index, ...settled });
    if (nextAction(settled) === "HALT") break;
  }
  return results;
}
