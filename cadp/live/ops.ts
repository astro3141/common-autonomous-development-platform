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
import { jcsDigest, sha256Hex } from "../kernel/canonical.ts";
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

// ===================================================== the v0.5 run-origin path (AP TD A4/A5, B5)

/**
 * WHICH ALLOCATION CONTRACT A START ORIGINATES UNDER. The run-origin migration is CONDITIONAL, not
 * a wholesale replacement:
 *
 *  - `"v04"` (the DEFAULT, and what the live v0.4 deployment exercises) is byte-for-byte what this
 *    module has always done: the `cadp.allocation-key.v1` zero-sentinel tuple with a clock-derived
 *    `step_ordinal`, the clock-derived record-vertical `resource_prefix`, no work-run binding, no
 *    `allocation_tuple` on the seal, and no origin record on disk. Nothing on that branch may
 *    change: a v0.4 deployment's sealed WORK_START material must stay identical to today's.
 *  - `"v05"` allocates under `cadp.allocation-key.run-origin.v1` with a stable `origin_key`, seals
 *    exactly one self-referential work-run binding (AP B5(9)'s ORIGIN-OR-REFUSED, whose durable
 *    `run_membership(E, E)` row is the minting witness), derives the `resource_prefix` from the
 *    `origin_key`, and carries no clock anywhere.
 *
 * The gate is an EXPLICIT option rather than the deployment's active kernel config because ops.ts
 * cannot read that config: `manifest.kernel_config_path` names the kernel SERVICE config
 * (`KernelServiceConfig` — ports, db path, adapter credentials), not the sealed `data.cadp`
 * `cadp.kernel-config.v1|v2` bundle content, which lives inside the store the Kernel owns and is
 * exposed by no `KernelClient` read. The v0.5 genesis composition is what passes `"v05"`; every
 * existing caller keeps the default and therefore keeps v0.4.
 */
export type OriginProfile = "v04" | "v05";

/** The exact subset of the Kernel API a start uses — the injection seam the ops tests drive. */
export type OpsKernelClient = Pick<
  KernelClient,
  "putBlob" | "allocateEffectId" | "sealEffectRequest" | "assembleAdmissionInput" | "evaluate" | "admitAndDispatch"
>;

export const ORIGIN_RECORD_SCHEMA = "cadp.live.origin-record.v1";

/** The kernel work-run subject pair a v0.5 deployment declares in `kernel_subject_namespaces`. */
const WORK_RUN_AUTHORITY = "cadp-store:k04";

const DEV_BASE_REF = "refs/heads/main";

/**
 * THE ENVIRONMENT-RESOLVED MATERIAL-INPUT SET — the audit this invariant is stated over.
 *
 * INVARIANT (v0.5 origin path only): every sealed-material field that is resolved from the
 * ENVIRONMENT at start time — anything read from a file, a subprocess, the manifest or the
 * network, as opposed to derived purely from `startWork`'s own arguments and the `origin_key` — is
 * resolved EXACTLY ONCE, at origin creation, and persisted here. A retry that finds an origin
 * record rebuilds the material EXCLUSIVELY from {this record + the function arguments +
 * `origin_key`} and recomputes NOTHING from the environment. That is what makes one logical origin
 * one `effect_id` AND one byte-identical sealed material, so a retry re-seals as the idempotent
 * no-op TD §3.3 defines rather than colliding with `REQUEST_DIGEST_CONFLICT`.
 *
 * The audit of `startWork`'s development-vertical WORK_START material found exactly these
 * environment seams, and this record carries all of them:
 *
 *   - `repo_id`, `repo_full_name`  — read from the deployment manifest file (`loadManifest`).
 *   - `base_sha`                   — `resolveBaseSha`, a `git ls-remote` against the declared ref.
 *                                    THE moving one: a ref that advances between two attempts at
 *                                    one origin is precisely the drift this record freezes. Absent
 *                                    for a RECORD-vertical origin, whose material has no base at
 *                                    all: resolving one there would add a network dependency (and
 *                                    a failure mode) the v0.4 record path does not have. The
 *                                    vertical is part of the verified argument identity, so one
 *                                    origin's record can never disagree with itself about this.
 *   - `surface_image`              — the `worker-image` file's tag, then `docker image inspect` and
 *                                    a `docker run` for tool versions (`imageIdentity`). Feeds BOTH
 *                                    `material.surface_image` and `material.worker_profile_digest`.
 *   - `namespace_id`               — the `temporal operator namespace describe` CLI read. Feeds
 *                                    `material.continuation_target` and the request's `target_ref`.
 *
 * Everything else in the material is argument- or origin-derived and therefore already stable:
 * `workflow_id`/`args_cas_key`/`args_digest` follow from the `effect_id` and the args, `bounds`,
 * `work_item`, the provider selections and the external-verification flag are arguments,
 * `workerProfileDigest()` is a pure function of the pinned provider registry, and the record
 * vertical's `resource_prefix` is a pure function of the `origin_key` (see `originResourcePrefix`).
 *
 * A NEW environment-derived material field added WITHOUT joining this record is exactly the drift
 * the invariant forbids: it would re-read on retry, move the material bytes under a fixed
 * `effect_id`, and reintroduce `REQUEST_DIGEST_CONFLICT`. Adding one must be a conscious extension
 * of `OriginMaterialInputs` and of the seam list the ops tests flip.
 */
export interface OriginMaterialInputs {
  readonly repo_id: string;
  readonly repo_full_name: string;
  /** Development vertical only — see the audit note above. */
  readonly base_sha?: string;
  readonly surface_image: { image: string; image_digest: string; tool_versions: Record<string, string> };
  readonly namespace_id: string;
}

/**
 * ONE logical origin, as a durable record. `work_item_digest`/`arguments_digest` are
 * ARGUMENT-derived and are VERIFIED against every invocation that adopts this record;
 * `material_inputs` are ENVIRONMENT-derived and are ADOPTED from it.
 */
export interface OriginRecordV1 {
  readonly schema: typeof ORIGIN_RECORD_SCHEMA;
  readonly origin_key: string;
  readonly work_item_digest: string;
  readonly arguments_digest: string;
  readonly material_inputs: OriginMaterialInputs;
  readonly created_at: string;
}

/** A start failure that names the `origin_key` the caller must retry under (see `startWork`). */
export class OriginStartError extends Error {
  readonly origin_key: string;

  constructor(message: string, origin_key: string, cause?: unknown) {
    super(`${message} [origin_key=${origin_key}]`);
    this.name = "OriginStartError";
    this.origin_key = origin_key;
    if (cause !== undefined) this.cause = cause;
  }
}

function originStartError(error: unknown, origin_key: string): OriginStartError {
  if (error instanceof OriginStartError) return error;
  return new OriginStartError(error instanceof Error ? error.message : String(error), origin_key, error);
}

/**
 * ONE FILE PER ORIGIN, under `<dir>/origin-keys/`. Deliberately NOT one shared file: a shared file
 * needs a lock, a lock needs stale-lock reclamation, and reclamation can steal a live lock and lose
 * a record. There is no lock here, no TTL, no reclamation and no deletion.
 *
 * A `origin_key` this module MINTS is a UUID and one it DERIVES is a hex digest, both already
 * filesystem-safe; a key a caller passes may be anything, so a name outside the safe set is stored
 * under `sha256Hex(origin_key)` with the key itself kept inside the record.
 */
export function originRecordPath(dir: string, origin_key: string): string {
  const name = /^[A-Za-z0-9._-]{1,120}$/u.test(origin_key) ? origin_key : sha256Hex(origin_key);
  return join(dir, "origin-keys", `${name}.json`);
}

function readOriginRecord(dir: string, origin_key: string): OriginRecordV1 | undefined {
  const path = originRecordPath(dir, origin_key);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as OriginRecordV1;
}

/**
 * FIRST-WRITER-WINS, with no lock at all.
 *
 * A record is immutable once written, but it is NOT content-deterministic: two racers on the same
 * `origin_key` may resolve DIFFERENT `base_sha` values, so "both wrote, both are equivalent" is
 * false and the last writer must not win. The write is therefore an ATOMIC CREATE-IF-ABSENT: the
 * bytes go to a unique tmp name in the SAME directory (so the payload is whole before it is
 * visible), and `linkSync` publishes it under the real name. `link` fails `EEXIST` against an
 * existing target, which is the whole point — `rename` would silently CLOBBER the winner, and an
 * `existsSync` pre-check followed by a `rename` is the same clobber with a wider window. On
 * `EEXIST` the racer reads the winner's record back and adopts its material verbatim, so concurrent
 * same-key starts converge on ONE record, ONE `effect_id` and ONE sealed material.
 */
function writeOriginRecord(dir: string, record: OriginRecordV1): OriginRecordV1 {
  const path = originRecordPath(dir, record.origin_key);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  try {
    linkSync(tmp, path);
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return JSON.parse(readFileSync(path, "utf8")) as OriginRecordV1;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* the tmp name is ours alone; a failed cleanup is not a start failure */
    }
  }
}

/**
 * The ARGUMENT-derived identity of one start, digested so a record can be checked against it.
 *
 * Taken over the EFFECTIVE arguments — the normalized values that actually reach the sealed request
 * — rather than the raw `extra` vector. Two spellings of one argument set (an omitted bound and the
 * same bound stated explicitly) would seal byte-identically, so they are ONE logical origin and a
 * recovery retry that spells them differently must converge rather than be refused. Everything that
 * WOULD change what seals is in here: the vertical, the bounds, the work item, the provider
 * selections, the external-verification flag and the WORK_PROPOSAL provenance binding.
 *
 * `work_item_digest` is carried separately because it is the field a human recovering a crashed
 * start matches on when reading `<dir>/origin-keys/` (see `startWork`).
 */
function originArgumentIdentity(
  vertical: "development" | "record",
  extra: readonly string[],
  effective: Record<string, unknown>,
): { work_item_digest: string; arguments_digest: string } {
  return {
    work_item_digest: sha256Hex(extra[0] ?? ""),
    arguments_digest: jcsDigest({ schema: "cadp.live.origin-arguments.v1", vertical, ...effective }).value,
  };
}

/**
 * THE ADOPTION GUARD, run on BOTH adoption paths (the read path and the write-race path) and BEFORE
 * any kernel call. Environment-derived fields are adopted from the record; ARGUMENT-derived fields
 * are verified against it. One `origin_key` identifies ONE logical origin with ONE argument set, so
 * presenting a recorded key with different arguments is a caller contract violation — never a
 * silent adoption that would carry the recorded material into a seal describing other work.
 */
function assertOriginArguments(
  record: OriginRecordV1,
  identity: { work_item_digest: string; arguments_digest: string },
  origin_key: string,
): OriginRecordV1 {
  if (record.work_item_digest !== identity.work_item_digest || record.arguments_digest !== identity.arguments_digest) {
    throw new OriginStartError(
      `origin_key ${origin_key} is already bound to a different logical origin — recorded ` +
        `work_item_digest=${record.work_item_digest} arguments_digest=${record.arguments_digest}, presented ` +
        `work_item_digest=${identity.work_item_digest} arguments_digest=${identity.arguments_digest}; ` +
        `one origin_key identifies ONE logical origin with ONE argument set`,
      origin_key,
    );
  }
  return record;
}

/** Fail closed on a record missing a material input this vertical's material needs. */
function requireRecorded(value: string | undefined, field: string, origin_key: string): string {
  if (value === undefined) throw new OriginStartError(`origin record is missing material input ${field}`, origin_key);
  return value;
}

/**
 * The record vertical's `resource_prefix` as a pure function of the origin — replacing
 * `live-${Date.now() % 100000}`, whose every re-invocation moved the sealed bytes. Distinct origins
 * still get distinct prefixes (distinct `origin_key`s), which is all the prefix was ever for.
 */
export function originResourcePrefix(origin_key: string): string {
  return `live-${sha256Hex(`cadp.live.resource-prefix.v1\n${origin_key}`).slice(0, 12)}`;
}

/**
 * `workPlan`'s DERIVED origin key: a pure function of the sealed proposal's evidence id and the
 * item's index within it. Deterministic by construction, so — unlike a minted key — it needs no
 * durable record to survive a crash: re-running the same plan re-derives the same keys, which then
 * find the same origin records and converge on the same `effect_id`s.
 */
export function planOriginKey(proposalEvidenceId: string, index: number): string {
  return sha256Hex(`cadp.live.origin.work-plan.v1\n${proposalEvidenceId}\n${index}`);
}

/** Injection seams for the ops tests; production takes every default. */
export interface StartWorkDependencies {
  manifest?: LiveEnvManifest;
  client?: OpsKernelClient;
  resolveBase?: (repoFullName: string, baseRef: string) => string;
  workerImageTag?: (dir: string) => string;
  imageIdentity?: (image: string) => OriginMaterialInputs["surface_image"];
  namespaceId?: (m: LiveEnvManifest) => string;
  mintOriginKey?: () => string;
  now?: () => string;
}

export interface StartWorkOptions {
  /** v0.4 only: an explicit `step_ordinal` in place of the clock-derived one. */
  ordinalArg?: string;
  log?: Log;
  /** Defaults to `"v04"` — the live v0.4 deployment's branch, unchanged. */
  originProfile?: OriginProfile;
  /**
   * v0.5 only: the caller's own `origin_key` for this logical origin. The WP contract puts the
   * decision on the Workflow side — decided ONCE per logical origin and preserved VERBATIM across
   * retries — so a retry passes the key its first attempt used and converges on that attempt's
   * `effect_id` and material.
   */
  originKey?: string;
  dependencies?: StartWorkDependencies;
}

export interface StartWorkResult {
  effect_id: string;
  workflow_id: string;
  /** Present on the v0.5 origin path: the key this run originated under. */
  origin_key?: string;
}

/**
 * One governed WORK_START through the ordinary admission chain. `undefined` = refused, honestly
 * logged.
 *
 * ORIGIN-KEY DURABILITY (v0.5). A minted key is the run's identity, so it must be recoverable
 * before anything can fail. It is minted FIRST, emitted through `log` immediately, carried on every
 * failure this function throws (`OriginStartError.origin_key`, and named in the message), returned
 * in the result, and persisted to `<dir>/origin-keys/<origin_key>.json` BEFORE the first kernel
 * call. RECOVERY FLOW for a crashed or failed start: read `<dir>/origin-keys/`, take the record
 * whose `work_item_digest` matches the work being retried, and re-invoke `startWork` with
 * `originKey` set to its `origin_key` — the allocation, the material and the seal then converge on
 * the first attempt's. `workPlan`'s derived keys need no such record to be recoverable (see
 * `planOriginKey`), but they take the SAME record path for material fixing.
 */
export async function startWork(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: StartWorkOptions = {},
): Promise<StartWorkResult | undefined> {
  if ((options.originProfile ?? "v04") === "v04") return await startWorkOnce(dir, vertical, extra, options, undefined);
  // The run-origin tuple has no `step_ordinal` at all, so an ordinal presented against it names a
  // field that does not exist. Refused rather than dropped: silently ignoring a caller's explicit
  // allocation input is exactly the kind of drift this migration exists to remove.
  if (options.ordinalArg !== undefined) throw new Error("ordinalArg is a v0.4 allocation input; the v0.5 run-origin tuple carries no step_ordinal");
  const deps = options.dependencies ?? {};
  const minted = options.originKey === undefined;
  const origin_key = options.originKey ?? (deps.mintOriginKey ?? randomUUID)();
  // Emitted BEFORE any work that can fail: a crashed start must leave its key visible even if it
  // dies before the record is written, or a retry mints a second key and forks the run.
  (options.log ?? SILENT)({ origin_profile: "v05", origin_key, origin_key_minted: minted });
  try {
    return await startWorkOnce(dir, vertical, extra, options, origin_key);
  } catch (error) {
    throw originStartError(error, origin_key);
  }
}

async function startWorkOnce(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: StartWorkOptions,
  origin_key: string | undefined,
): Promise<StartWorkResult | undefined> {
  const log = options.log ?? SILENT;
  const deps = options.dependencies ?? {};
  const m = deps.manifest ?? loadManifest(dir);
  const c: OpsKernelClient = deps.client ?? liveClient(dir, "cadp-workflow");
  const resolveBase = deps.resolveBase ?? resolveBaseSha;
  const readImageIdentity = deps.imageIdentity ?? imageIdentity;
  const readNamespaceId = deps.namespaceId ?? temporalNamespaceId;
  const readWorkerImageTag = deps.workerImageTag ?? ((d: string) => readFileSync(join(d, "worker-image"), "utf8").trim());
  // v0.4 reads the namespace HERE, exactly where it always has, so a deployment whose temporal CLI
  // is unavailable still fails at the step it fails at today. On the v0.5 branch the read is an
  // audited material input and belongs to origin creation instead (`OriginMaterialInputs`).
  const v04NamespaceId = origin_key === undefined ? readNamespaceId(m) : undefined;

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
  // The bounds and the payload count, normalized once: they are both the argument identity a v0.5
  // origin record is verified against and what the args below carry, and computing them in one
  // place is what keeps those two from ever disagreeing.
  const bounds =
    vertical === "development"
      ? { max_steps: boundArg(extra[1], 8), max_effects: boundArg(extra[2], 6) }
      : { max_steps: boundArg(extra[1], 6), max_effects: boundArg(extra[2], 4) };
  const payloadCount = vertical === "development" ? undefined : boundArg(extra[0], 2);
  const proposalRef = vertical === "development" && extra[3] !== undefined && extra[3] !== "" ? extra[3] : undefined;

  // ORIGIN RECORD (v0.5 only). Consulted for EVERY v0.5 origin — minted, caller-passed and
  // workPlan-derived alike — and BEFORE the first kernel call: an existing record's environment
  // inputs are adopted verbatim (nothing is re-resolved), an absent one is created by resolving
  // each audited seam exactly once and publishing the record first-writer-wins.
  let record: OriginRecordV1 | undefined;
  if (origin_key !== undefined) {
    const identity = originArgumentIdentity(vertical, extra, {
      bounds,
      ...(vertical === "development"
        ? {
            work_item: extra[0] ?? null,
            worker_product: workerProduct,
            review_product: reviewProduct,
            external_verification: externalVerification,
            proposal_evidence_id: proposalRef ?? null,
          }
        : { payload_count: payloadCount }),
    });
    const existing = readOriginRecord(dir, origin_key);
    if (existing !== undefined) {
      record = assertOriginArguments(existing, identity, origin_key);
      log({ origin_key, origin_record: "ADOPTED", base_sha: record.material_inputs.base_sha });
    } else {
      const resolved: OriginMaterialInputs = {
        repo_id: m.repo_id,
        repo_full_name: m.repo_full_name,
        ...(vertical === "development" ? { base_sha: resolveBase(m.repo_full_name, DEV_BASE_REF) } : {}),
        surface_image: readImageIdentity(readWorkerImageTag(dir)),
        namespace_id: readNamespaceId(m),
      };
      // The write-race path adopts the WINNER's record, so it runs the same guard: a racer that
      // presented different arguments under one key must be refused, not silently converged.
      record = assertOriginArguments(
        writeOriginRecord(dir, {
          schema: ORIGIN_RECORD_SCHEMA,
          origin_key,
          ...identity,
          material_inputs: resolved,
          created_at: (deps.now ?? (() => new Date().toISOString()))(),
        }),
        identity,
        origin_key,
      );
      log({ origin_key, origin_record: "CREATED", base_sha: record.material_inputs.base_sha });
    }
  }
  const inputs = record?.material_inputs;
  const namespaceId = inputs?.namespace_id ?? v04NamespaceId!;

  const args =
    vertical === "development"
      ? {
          vertical,
          bounds,
          development: {
            repo_id: inputs?.repo_id ?? m.repo_id,
            repo_full_name: inputs?.repo_full_name ?? m.repo_full_name,
            base_ref: DEV_BASE_REF,
            // v0.4: resolved fresh at seal time — the manifest's setup-time snapshot goes stale
            // (see resolveBaseSha). v0.5: resolved once at origin creation and adopted from the
            // origin record thereafter, so a ref that MOVES between two attempts at one origin
            // cannot move the sealed bytes under a fixed effect_id. A v0.5 record whose
            // development origin carries no `base_sha` is a corrupt record, not a licence to
            // re-resolve: re-resolving is exactly the drift the invariant forbids.
            base_sha: origin_key === undefined
              ? resolveBase(m.repo_full_name, DEV_BASE_REF)
              : requireRecorded(inputs?.base_sha, "base_sha", origin_key),
            work_item: extra[0]!,
            worker_product: workerProduct,
            review_product: reviewProduct,
            external_verification: externalVerification,
            require_human_merge: true,
          },
        }
      : {
          vertical,
          bounds,
          record: {
            tenant: "cadp-disposable",
            resource_prefix: origin_key === undefined ? `live-${Date.now() % 100000}` : originResourcePrefix(origin_key),
            payloads: Array.from({ length: payloadCount! }, (_, i) => `live payload ${i + 1}`),
          },
        };

  // ALLOCATION. v0.4 keeps the `cadp.allocation-key.v1` zero-sentinel tuple and its clock-derived
  // `step_ordinal`. v0.5 allocates under `cadp.allocation-key.run-origin.v1` — EXACTLY the three
  // keys WP §3.6 declares, no `step_ordinal` and therefore no wall clock anywhere on this path, so
  // one `origin_key` derives one `effect_id` for the store's lifetime (control A5 leg o-ii).
  const allocation_tuple =
    origin_key === undefined
      ? {
          schema: "cadp.allocation-key.v1",
          work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
          step_ordinal: options.ordinalArg !== undefined ? Number(options.ordinalArg) : Math.floor(Date.now() / 1000) % 1000000,
          purpose: "work-start",
        }
      : { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key, purpose: "work-start" };
  const { effect_id } = await c.allocateEffectId(allocation_tuple);
  const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
  // TD §11 version exactness: bind the immutable built-image digest + observed tool versions
  // into the WORK_START worker profile, so the reviewed/live composition names the exact image.
  const image = inputs?.surface_image ?? readImageIdentity(readWorkerImageTag(dir));
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
      // Optional exact provenance: the WORK_PROPOSAL this item came from. A binding, never authority.
      ...(proposalRef === undefined ? [] : [{ authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: proposalRef }]),
      // AP B5(9), v0.5 only: EXACTLY ONE work-run binding on the declared pair, naming this
      // request's OWN effect_id. That self-reference is what makes this WORK_START a run ORIGIN —
      // the seal writes `run_membership(E, E)`, the witness its initial dispatch mints against.
      ...(origin_key === undefined ? [] : [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: effect_id }]),
    ],
    target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: namespaceId },
    operation_kind: "WORK_START",
    material_schema: "cadp.work-start.v1",
    material_ref,
    prior_effect_refs: [],
    // AP B6(1): the tuple rides as an optional top-level sibling of the draft, never as a draft
    // field, and only where an allocation-bound (v2) deployment is what the caller is talking to.
    ...(origin_key === undefined ? {} : { allocation_tuple }),
  });
  const originFields = origin_key === undefined ? {} : { origin_key };
  const input = await c.assembleAdmissionInput(effect_id, []);
  const evaluated = await c.evaluate(input.input_digest.value);
  if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
    log({ effect_id, ...originFields, evaluated });
    return undefined;
  }
  const admitted = await c.admitAndDispatch(effect_id, evaluated.decision.decision_id);
  log({ effect_id, ...originFields, workflow_id: material.workflow_id, request_digest: request.request_digest.value, admitted });
  if (admitted.kind !== "ADMITTED" || admitted.outcome.result !== "COMMITTED") return undefined;
  return { effect_id, workflow_id: material.workflow_id, ...originFields };
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

/** Injection seams for the driver's ops tests; production takes every default. */
export interface WorkPlanDependencies {
  loadProposal?: (dir: string, proposalEvidenceId: string) => Promise<WorkProposalV1>;
  startWork?: typeof startWork;
  pollRun?: typeof pollRun;
  startWorkDependencies?: StartWorkDependencies;
}

export interface WorkPlanOptions {
  originProfile?: OriginProfile;
  dependencies?: WorkPlanDependencies;
}

/**
 * Proposal driver (#61): run a sealed WORK_PROPOSAL's items sequentially through the ordinary
 * governed WORK_START. Deterministic glue, zero authority: policy gates every start, an item that
 * reaches its Human merge gate is delivered (merges batch out-of-band via human-approve), and any
 * failed/stopped/stalled run halts the loop fail-closed.
 */
export async function workPlan(
  dir: string,
  proposalEvidenceId: string,
  maxItemsArg?: string,
  log: Log = SILENT,
  options: WorkPlanOptions = {},
): Promise<Array<Record<string, unknown>>> {
  const deps = options.dependencies ?? {};
  const proposal = await (deps.loadProposal ?? loadProposal)(dir, proposalEvidenceId);
  const maxItems = boundArg(maxItemsArg, proposal.items.length);
  const results: Array<Record<string, unknown>> = [];
  for (const [index, item] of proposal.items.slice(0, maxItems).entries()) {
    log({ driver: "starting", index, work_item: item.work_item, bounds: { max_steps: item.max_steps, max_effects: item.max_effects } });
    // The origin key is DERIVED from the sealed proposal's evidence id and this item's index, so
    // one plan item is one logical origin however many times the plan is re-run. Threaded on every
    // profile; `startWork` uses it only on the v0.5 branch, where it is also what fixes the item's
    // material through the origin record.
    const started = await (deps.startWork ?? startWork)(
      dir,
      "development",
      [item.work_item, String(item.max_steps), String(item.max_effects), proposalEvidenceId],
      {
        log,
        originKey: planOriginKey(proposalEvidenceId, index),
        ...(options.originProfile !== undefined ? { originProfile: options.originProfile } : {}),
        ...(deps.startWorkDependencies !== undefined ? { dependencies: deps.startWorkDependencies } : {}),
      },
    );
    if (started === undefined) {
      results.push({ index, work_item: item.work_item, status: "NOT_ADMITTED" });
      break; // fail closed: an item the gate refused halts the loop
    }
    const settled = await (deps.pollRun ?? pollRun)(dir, started.effect_id, started.workflow_id, 30 * 60_000);
    results.push({ index, work_item: item.work_item, work_run_ref: started.effect_id, workflow_id: started.workflow_id, ...settled });
    log({ driver: "settled", index, ...settled });
    if (nextAction(settled) === "HALT") break;
  }
  return results;
}
