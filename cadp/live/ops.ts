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
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

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

/** The one base ref the development vertical declares it builds on. */
const BASE_REF = "refs/heads/main";

/** The kernel work-run authority (`kernel_subject_namespaces` declares `{cadp-store:k04, work-run}`). */
const WORK_RUN_AUTHORITY = "cadp-store:k04";

/** The v0.4 tuple's fixed `work_run_ref` sentinel: a WORK_START names no run it is a step of. */
const ZERO_SENTINEL_WORK_RUN_REF = "cadp-v04:effect:00000000-0000-7000-8000-000000000000";

export type StartVertical = "development" | "record";

/**
 * AP TD A4/A5 and B5 — the ORIGIN PROFILE `startWork` allocates the WORK_START under.
 *
 * `"v04"` is the DEFAULT and is exactly what the live v0.4 deployment runs today: the
 * `cadp.allocation-key.v1` zero-sentinel tuple with a wall-clock `step_ordinal`, no `work-run`
 * binding, no allocation tuple presented at the seal, and the clock-derived record-vertical
 * `resource_prefix`. Nothing on that branch reads or writes `origin-keys.json`, and every sealed
 * byte it produces is the byte it produces today (v1 byte identity, the regression pin in
 * `conformance-basesha.test.ts`).
 *
 * `"v05"` is the run-origin path: allocation under `cadp.allocation-key.run-origin.v1` keyed by a
 * stable `origin_key`, exactly one `work-run` binding naming the allocated `effect_id` ITSELF
 * (AP TD B5(9) legs 2 and 3 — what makes the request an adjudicated ORIGIN and writes its durable
 * `run_membership(E, E)` witness), the origin-derived record-vertical `resource_prefix`, no clock
 * anywhere, and material pinned by the origin record so a retry re-seals byte-identically.
 *
 * The profile is an EXPLICIT option rather than a probe of the deployment's active kernel config
 * because `ops.ts` cannot read one: `manifest.json` carries ports, tokens, repo identity and the
 * kernel SERVICE config path, and the ACTIVE POLICY's schema (`cadp.kernel-config.v1` vs `.v2`,
 * the gate every run-profile rule is stated over) lives in the constitutional store behind the
 * Kernel API, which exposes no read of it. Defaulting to `"v04"` is therefore the fail-closed
 * choice: the live v0.4 deployment exercises the default branch unchanged, and the v0.5 genesis
 * composition passes `"v05"` explicitly.
 */
export type OriginProfile = "v04" | "v05";

/** The built worker image's exact identity, as `imageIdentity` resolves it from the docker daemon. */
export interface SurfaceImage {
  readonly image: string;
  readonly image_digest: string;
  readonly tool_versions: Record<string, string>;
}

/** The Kernel API surface one governed WORK_START needs; `KernelClient` is the live implementation. */
export type StartWorkKernelClient = Pick<
  KernelClient,
  "allocateEffectId" | "putBlob" | "sealEffectRequest" | "assembleAdmissionInput" | "evaluate" | "admitAndDispatch"
>;

/**
 * Injection seams for the conformance suite. Every default is the live production function, so a
 * caller that passes nothing runs exactly the composition the deployment runs.
 */
export interface StartWorkDependencies {
  manifest?: LiveEnvManifest;
  client?: StartWorkKernelClient;
  resolveBase?: (repoFullName: string, baseRef: string) => string;
  resolveImage?: (image: string) => SurfaceImage;
  resolveNamespace?: (m: LiveEnvManifest) => string;
  now?: () => string;
}

/**
 * THE ENVIRONMENT AUDIT of the development- and record-vertical WORK_START material, and the
 * INVARIANT the v0.5 origin path holds over it.
 *
 * INVARIANT. On the v0.5 origin path every sealed-material field that is resolved from the
 * ENVIRONMENT at start time — anything read from a file, the manifest, a subprocess, a daemon or
 * the clock, as opposed to being derived purely from `startWork`'s own arguments and the
 * `origin_key` — is resolved EXACTLY ONCE, at origin creation, and persisted in that origin's
 * `origin-keys.json` record. A retry carrying an existing record reconstructs the material
 * EXCLUSIVELY from {the record + the function arguments + the origin_key} and recomputes NOTHING
 * from the environment. This is what makes one logical origin one `effect_id` with ONE sealed
 * material byte-string: the allocation converges on the same `effect_id` for the same `origin_key`
 * (control A5 leg o-ii), so any environment drift between attempts — a moved ref, a rebuilt image —
 * would otherwise re-seal the SAME effect identity with DIFFERENT bytes, which the Ingress grades
 * `REQUEST_DIGEST_CONFLICT` (an incident plus a scope hold), not as the idempotent no-op a retry
 * must be.
 *
 * THE AUDIT — every environment-resolved input the WORK_START material and its sealed request
 * actually have, and the field of this record each becomes:
 *   1. `base_sha`             — `resolveBaseSha` (a live `git ls-remote` against the declared ref);
 *   2. `repo_id`/`repo_full_name` — the deployment `manifest.json`;
 *   3. `surface_image`        — `<dir>/worker-image` (a file) resolved through the docker daemon
 *                               (`imageIdentity`: image digest + observed tool versions);
 *   4. `worker_profile_digest`— the JCS digest OVER (3) together with `workerProfileDigest()`, so
 *                               it is environment-derived through the image and is pinned whole
 *                               rather than recomputed from a re-read image;
 *   5. `temporal_namespace_id`— the `temporal` CLI; it is BOTH `continuation_target` in the
 *                               material AND `target_ref.target_id` in the sealed request, which
 *                               the Ingress's re-seal comparison covers, so it is pinned too.
 * NOT in this record, because they are not environment-resolved: the whole of `args` other than
 * (1) and (2) is a pure function of `vertical` and `extra` (work item, bounds, worker/review
 * product, external-verification flag, payload count); the record vertical's `resource_prefix` is a
 * pure function of the `origin_key` (`originResourcePrefix`); and the WALL CLOCK — which supplied
 * that prefix and the v1 tuple's `step_ordinal` — is not consulted at all on this path.
 *
 * A NEW environment-derived field added to the material WITHOUT joining this record is exactly the
 * drift this invariant forbids: it would be re-read on the retry and re-seal the origin's
 * `effect_id` with different bytes. Adding one to `startArgs`/`startMaterial` therefore means
 * adding it here and to `resolveMaterialInputs` in the same change.
 */
export interface OriginMaterialInputs {
  readonly temporal_namespace_id: string;
  readonly surface_image: SurfaceImage;
  readonly worker_profile_digest: string;
  /** Development vertical only — the record vertical's args declare no repo and no base. */
  readonly base_sha?: string;
  readonly repo_id?: string;
  readonly repo_full_name?: string;
}

/**
 * One logical origin's durable record. Append-only and first-write-wins: an entry is never
 * rewritten, so the pinned material of an origin that has reached the Kernel cannot move under it.
 * The file backing these records is written under an exclusive lock and published by atomic rename
 * (`withOriginLock` / `writeOriginRecords`), so neither a concurrent start nor a crash mid-write can
 * lose an already-pinned origin or leave a torn file behind.
 */
export interface OriginRecordV1 {
  readonly origin_key: string;
  readonly work_item_digest: string;
  readonly material_inputs: OriginMaterialInputs;
  readonly created_at: string;
}

/** The deployment-local origin state file. Operator state, never authority and never evidence. */
export function originKeysPath(dir: string): string {
  return join(dir, "origin-keys.json");
}

/**
 * Read the records. Deliberately UNLOCKED: every publish is an atomic rename (`writeOriginRecords`),
 * so a reader observes one complete version of the file or the other, never a half-written one.
 */
export function readOriginRecords(dir: string): OriginRecordV1[] {
  const path = originKeysPath(dir);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  // Fail closed: guessing at a damaged origin file would mean re-resolving a pinned origin's
  // material from the environment, which is the one thing this file exists to prevent.
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a JSON array — refusing to guess an origin's pinned material`);
  return parsed as OriginRecordV1[];
}

/** The record for one `origin_key`, or `undefined` when this origin has never been created here. */
export function originRecord(dir: string, originKey: string): OriginRecordV1 | undefined {
  return readOriginRecords(dir).find((entry) => entry.origin_key === originKey);
}

/**
 * The lock guarding the origin file's read-modify-write, and how long a caller waits for it.
 *
 * An unlocked read-modify-write is a LOST-UPDATE hole in the durability this file exists to give:
 * two starts that read the same array and write back their own entry publish one of the two pinned
 * origins and silently drop the other, and the dropped origin then re-resolves its material from the
 * environment on its retry — the exact drift the material-pinning invariant forbids. Timings here
 * are operator-side liveness only; nothing in this section reaches sealed material, so the v0.5
 * path's "no wall clock" property is untouched by the clock reads below.
 */
const ORIGIN_LOCK_POLL_MS = 25;
const ORIGIN_LOCK_WAIT_MS = 10_000;
/** A holder that died leaves its lock behind; break one only once it is far older than any live
 *  critical section (which is a couple of file operations — the material resolution happens OUTSIDE
 *  the lock, so no `git ls-remote` or docker read is ever held across it). */
const ORIGIN_LOCK_STALE_MS = 30_000;

export interface OriginLockOptions {
  /** Total time to wait for a held lock before refusing (default `ORIGIN_LOCK_WAIT_MS`). */
  readonly waitMs?: number;
  /** Age at which a lock is presumed abandoned by a dead holder (default `ORIGIN_LOCK_STALE_MS`). */
  readonly staleMs?: number;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` holding the deployment's exclusive origin-file lock. `open(…, "wx")` is the atomic
 * create-if-absent primitive here: exactly one process can hold the lock file at a time, so a
 * concurrent start waits rather than racing the array. Any tool that hand-edits `origin-keys.json`
 * (a recovery flow, say) must take this same lock.
 */
export function withOriginLock<T>(dir: string, fn: () => T, options: OriginLockOptions = {}): T {
  const lock = `${originKeysPath(dir)}.lock`;
  const staleMs = options.staleMs ?? ORIGIN_LOCK_STALE_MS;
  // Bounded by ATTEMPTS, not by a deadline read off the clock, so a pinned/adjusted clock can
  // never turn "wait ten seconds" into an unbounded spin.
  const attempts = Math.max(1, Math.ceil((options.waitMs ?? ORIGIN_LOCK_WAIT_MS) / ORIGIN_LOCK_POLL_MS));
  let holder = "";
  for (let attempt = 0; ; attempt += 1) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, `${JSON.stringify({ pid: process.pid })}\n`); // diagnostics for a stuck lock
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        holder = readFileSync(lock, "utf8").trim();
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          rmSync(lock, { force: true }); // abandoned by a dead holder — reclaim and retry at once
          continue;
        }
      } catch {
        /* the holder released it between our open and our stat — fall through and retry, still
           under the attempt bound, so a lock that keeps flickering can never spin here forever */
      }
      if (attempt >= attempts) throw new Error(`${lock} is held by another start (${holder}) — refusing to write origin records unlocked`);
      sleepSync(ORIGIN_LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Publish `records` by write-temp → fsync → rename. The rename is atomic, so a reader (and a crash
 * at any instant) sees either the whole previous file or the whole new one — never the truncated
 * half of an in-place rewrite, which `readOriginRecords` would have to fail closed on, stranding
 * every origin already pinned in it.
 */
function writeOriginRecords(dir: string, records: OriginRecordV1[]): void {
  const path = originKeysPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify(records, null, 2)}\n`);
    fsyncSync(fd); // the bytes reach the disk BEFORE the rename publishes them
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  let dirFd: number | undefined;
  try {
    dirFd = openSync(dir, "r");
    fsyncSync(dirFd); // and the rename itself survives a power loss, where the platform allows it
  } catch {
    /* not every platform permits fsync on a directory; the rename is still atomic */
  } finally {
    if (dirFd !== undefined) closeSync(dirFd);
  }
}

/**
 * Append unless the key is already recorded; the FIRST record for a key always wins. Read, check
 * and publish happen under the lock as ONE critical section — a concurrent start for another origin
 * can no longer read a stale array and write this record back out of existence. `appended` reports
 * which side of that check won, so the caller's log tells the truth under contention.
 */
function appendOriginRecord(dir: string, record: OriginRecordV1): { record: OriginRecordV1; appended: boolean } {
  return withOriginLock(dir, () => {
    const records = readOriginRecords(dir);
    const existing = records.find((entry) => entry.origin_key === record.origin_key);
    if (existing !== undefined) return { record: existing, appended: false };
    records.push(record);
    writeOriginRecords(dir, records);
    return { record, appended: true };
  });
}

/**
 * `workPlan`'s origin key: a pure function of the SEALED proposal's evidence id and the item's
 * index within that proposal. Stable across retries by construction and distinct per item, so the
 * plan driver needs NO file record to recover a key — re-running the same plan derives the same
 * keys and therefore converges on the same `effect_id`s. (The origin RECORD is still consulted for
 * material pinning: derived keys and minted keys are unified on that path, so a moved base ref
 * cannot re-seal a plan item's origin with different bytes either.)
 */
export function planOriginKey(proposalEvidenceId: string, index: number): string {
  return `cadp-live-plan:${proposalEvidenceId}:${index}`;
}

/**
 * The record vertical's `resource_prefix` on the origin path: a deterministic function of the
 * origin's stable `origin_key`, replacing `live-${Date.now() % 100000}`. Same origin ⇒ same prefix
 * ⇒ byte-identical `args`; distinct origins ⇒ distinct prefixes, so two runs never collide on the
 * governed record service's resource ids.
 */
export function originResourcePrefix(originKey: string): string {
  return `live-${sha256Hex(originKey).slice(0, 12)}`;
}

/** WP §3.6's wire shape, exactly: `{schema, origin_key, purpose}` and no fourth member. */
export function runOriginTuple(originKey: string): { schema: string; origin_key: string; purpose: string } {
  return { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: originKey, purpose: "work-start" };
}

/**
 * A failed start on the v0.5 path, carrying the origin's key so the failure itself is a RECOVERY
 * RECORD: a minted key must never be lost to a crash, or the retry would mint a fresh one and fork
 * the run onto a second effect identity. The key is on the error, in the message, on the log
 * callback (emitted the moment it is minted) and — from before the first Kernel call — in
 * `origin-keys.json`.
 */
export class OriginStartFailure extends Error {
  readonly origin_key: string;

  constructor(originKey: string, cause: unknown) {
    super(`work start for origin_key ${originKey} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "OriginStartFailure";
    this.origin_key = originKey;
  }
}

interface StartSelection {
  readonly workerProduct: ReturnType<typeof resolveWorkerProvider>;
  readonly reviewProduct: ReturnType<typeof resolveReviewProvider>;
  readonly externalVerification: boolean;
}

/**
 * The fail-closed ENTRY validations, unchanged and in their existing order: nothing below is
 * sealed, resolved or spent until every one of them has passed. Shared by both origin profiles, so
 * the two branches can never disagree about what a well-formed start is.
 */
function startSelection(vertical: StartVertical, extra: string[]): StartSelection {
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
 * The WORK_START `args`, byte-identical on both profiles for the same inputs. The two verticals'
 * environment-resolved members arrive already resolved — freshly on the v0.4 branch, from the
 * origin record on the v0.5 branch — which is what keeps ONE args construction serving both.
 */
function startArgs(
  vertical: StartVertical,
  extra: string[],
  selection: StartSelection,
  resolved: { development?: { repo_id: string; repo_full_name: string; base_sha: string }; record?: { resource_prefix: string } },
): { vertical: StartVertical; bounds: { max_steps: number; max_effects: number }; development?: Record<string, unknown>; record?: Record<string, unknown> } {
  if (vertical === "development") {
    const development = resolved.development!;
    return {
      vertical,
      bounds: { max_steps: boundArg(extra[1], 8), max_effects: boundArg(extra[2], 6) },
      development: {
        repo_id: development.repo_id,
        repo_full_name: development.repo_full_name,
        base_ref: BASE_REF,
        // Resolved fresh at seal time — the manifest's setup-time snapshot goes stale (see
        // resolveBaseSha). The sealed sha stays deterministic for the run's whole lifetime.
        base_sha: development.base_sha,
        work_item: extra[0]!,
        worker_product: selection.workerProduct,
        review_product: selection.reviewProduct,
        external_verification: selection.externalVerification,
        require_human_merge: true,
      },
    };
  }
  return {
    vertical,
    bounds: { max_steps: boundArg(extra[1], 6), max_effects: boundArg(extra[2], 4) },
    record: {
      tenant: "cadp-disposable",
      resource_prefix: resolved.record!.resource_prefix,
      payloads: Array.from({ length: boundArg(extra[0], 2) }, (_, i) => `live payload ${i + 1}`),
    },
  };
}

/**
 * TD §11 version exactness: bind the immutable built-image digest + observed tool versions into
 * the WORK_START worker profile, so the reviewed/live composition names the exact image.
 */
function workerProfileOf(image: SurfaceImage): string {
  return jcsDigest({
    profile: workerProfileDigest(),
    surface_image: image.image,
    image_digest: image.image_digest,
    tool_versions: image.tool_versions,
  }).value;
}

/** The sealed WORK_START material, one construction for both profiles. */
function startMaterial(
  effect_id: string,
  args: ReturnType<typeof startArgs>,
  args_cas_key: string,
  inputs: { worker_profile_digest: string; surface_image: SurfaceImage; temporal_namespace_id: string },
): Record<string, unknown> & { workflow_id: string } {
  return {
    workflow_id: `cadp-work-${effect_id}`,
    workflow_type: "cadpWork",
    task_queue: "cadp-worker",
    args_cas_key,
    args_digest: jcsDigest(args).value,
    bounds: args.bounds,
    worker_profile_digest: inputs.worker_profile_digest,
    surface_image: inputs.surface_image,
    continuation_target: `temporal:cadp-v04:${inputs.temporal_namespace_id}`,
  };
}

/** The work-item binding and its optional WORK_PROPOSAL provenance — identical on both profiles. */
function startWorkBindings(vertical: StartVertical, extra: string[]): Array<{ authority_ref: string; namespace: string; object_id: string }> {
  return [
    { authority_ref: "github.com", namespace: "work-item", object_id: vertical === "development" ? `dev:${extra[0]}` : `record:${extra[0]}` },
    // Optional exact provenance: the WORK_PROPOSAL this item came from. A binding, never authority.
    ...(vertical === "development" && extra[3] !== undefined && extra[3] !== ""
      ? [{ authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: extra[3] }]
      : []),
  ];
}

export interface StartWorkOptions {
  ordinalArg?: string;
  log?: Log;
  /**
   * The origin profile this deployment runs (see `OriginProfile`). Defaults to `"v04"`, which is
   * the live v0.4 behaviour, byte for byte.
   */
  originProfile?: OriginProfile;
  /**
   * The `origin_key` of the logical origin this call starts (v0.5 only; INERT under `"v04"`, whose
   * v1 tuple has no origin field — it is threaded unconditionally so one composition serves both
   * profiles). Omitted on the v0.5 path, `startWork` mints one with `crypto.randomUUID` EXACTLY
   * ONCE and makes it recoverable; a retry of the same logical start passes the recorded key back
   * in and converges on the same `effect_id`.
   */
  originKey?: string;
  dependencies?: StartWorkDependencies;
}

export type StartWorkResult = { effect_id: string; workflow_id: string; origin_key?: string };

/**
 * One governed WORK_START through the ordinary admission chain. `undefined` = refused, honestly
 * logged. The profile decides which allocation contract the run is originated under; `"v04"` — the
 * default, and what every existing caller gets — is unchanged.
 */
export async function startWork(
  dir: string,
  vertical: StartVertical,
  extra: string[],
  options: StartWorkOptions = {},
): Promise<StartWorkResult | undefined> {
  if ((options.originProfile ?? "v04") === "v04") return startWorkV04(dir, vertical, extra, options);
  const log = options.log ?? SILENT;
  // MINTED FIRST, and emitted before anything that can fail: a direct start that dies before its
  // key is durable would otherwise retry under a fresh UUID and fork the run onto a second effect
  // identity. `randomUUID` is called exactly once per call, and never again on a retry that
  // carries a key back in.
  const originKey = options.originKey ?? randomUUID();
  if (options.originKey === undefined) {
    log({ origin: "minted", origin_key: originKey, recover_with: "startWork(..., { originKey })" });
  }
  try {
    return await startWorkOrigin(dir, vertical, extra, originKey, options, log);
  } catch (error) {
    // Every failure path carries the key: a caller that logs the error alone still holds it.
    throw new OriginStartFailure(originKey, error);
  }
}

/**
 * The v0.4 path, UNCHANGED: the `cadp.allocation-key.v1` zero-sentinel tuple with its clock-derived
 * `step_ordinal`, the clock-derived record-vertical `resource_prefix`, no `work-run` binding, no
 * allocation tuple presented at the seal, and no reference whatsoever to `origin-keys.json`. The
 * live v0.4 deployment runs exactly this, and the environment reads happen in exactly the order
 * they happen today.
 */
async function startWorkV04(
  dir: string,
  vertical: StartVertical,
  extra: string[],
  options: StartWorkOptions,
): Promise<StartWorkResult | undefined> {
  const log = options.log ?? SILENT;
  const deps = options.dependencies ?? {};
  const m = deps.manifest ?? loadManifest(dir);
  const c = deps.client ?? liveClient(dir, "cadp-workflow");
  const namespaceId = (deps.resolveNamespace ?? temporalNamespaceId)(m);

  const selection = startSelection(vertical, extra);
  const args = startArgs(vertical, extra, selection, {
    ...(vertical === "development"
      ? {
          development: {
            repo_id: m.repo_id,
            repo_full_name: m.repo_full_name,
            base_sha: (deps.resolveBase ?? resolveBaseSha)(m.repo_full_name, BASE_REF),
          },
        }
      : { record: { resource_prefix: `live-${Date.now() % 100000}` } }),
  });

  const ordinal = options.ordinalArg !== undefined ? Number(options.ordinalArg) : Math.floor(Date.now() / 1000) % 1000000;
  const { effect_id } = await c.allocateEffectId({
    schema: "cadp.allocation-key.v1",
    work_run_ref: ZERO_SENTINEL_WORK_RUN_REF,
    step_ordinal: ordinal,
    purpose: "work-start",
  });
  const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
  const image = (deps.resolveImage ?? imageIdentity)(readFileSync(join(dir, "worker-image"), "utf8").trim());
  const material = startMaterial(effect_id, args, args_cas_key, {
    worker_profile_digest: workerProfileOf(image),
    surface_image: image,
    temporal_namespace_id: namespaceId,
  });
  const { cas_key: material_ref } = await c.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const request = await c.sealEffectRequest({
    effect_id,
    requester_ref: "workflow:cadp-work",
    work_bindings: startWorkBindings(vertical, extra),
    target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: namespaceId },
    operation_kind: "WORK_START",
    material_schema: "cadp.work-start.v1",
    material_ref,
    prior_effect_refs: [],
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

/**
 * AP B6(3): on the verified initial dispatch of a run ORIGIN the admit response carries the ONE
 * delivered `run_capability`, and no rendering of that secret may reach a refusal message, a store
 * row or the process's own log. The origin path therefore logs this projection of the response —
 * every member except the secret — rather than the response object itself. The v0.4 branch needs
 * no such projection: its `WORK_START` is never an origin, so nothing is ever minted for it.
 */
function withoutRunCapability(admitted: object): Record<string, unknown> {
  const { run_capability, ...rest } = admitted as Record<string, unknown> & { run_capability?: unknown };
  return rest;
}

/**
 * Resolve — ONCE, for a brand-new origin — every environment input the audit on
 * `OriginMaterialInputs` enumerates. Called on no other path: an origin that already has a record
 * reconstructs its material from that record and never reaches here.
 */
function resolveMaterialInputs(dir: string, vertical: StartVertical, m: LiveEnvManifest, deps: StartWorkDependencies): OriginMaterialInputs {
  const image = (deps.resolveImage ?? imageIdentity)(readFileSync(join(dir, "worker-image"), "utf8").trim());
  return {
    temporal_namespace_id: (deps.resolveNamespace ?? temporalNamespaceId)(m),
    surface_image: image,
    worker_profile_digest: workerProfileOf(image),
    // The record vertical declares no repo and no base, so nothing resolves one for it — a
    // `git ls-remote` it would never seal is an environment read this path must not make.
    ...(vertical === "development"
      ? {
          base_sha: (deps.resolveBase ?? resolveBaseSha)(m.repo_full_name, BASE_REF),
          repo_id: m.repo_id,
          repo_full_name: m.repo_full_name,
        }
      : {}),
  };
}

/**
 * The v0.5 RUN-ORIGIN path (AP TD A4/A5, B5(9)).
 *
 * ORDER IS THE CONTRACT here, and it is: consult the origin record → resolve-and-persist if this
 * origin is new → only then call the Kernel. Every v0.5 origin goes through it, MINTED and DERIVED
 * keys alike (`workPlan`'s `proposal_evidence_id`+index keys are already stable and need no file
 * record to be recovered, but they DO need the same material pinning: a base ref that moves between
 * two attempts at one plan item would otherwise re-seal that item's `effect_id` with different
 * bytes). RECOVERY FLOW for a crashed direct start: read `<dir>/origin-keys.json`, take the record's
 * `origin_key`, and re-invoke `startWork` with `{ originKey }` — the allocation converges on the
 * same `effect_id`, the material is rebuilt from the record, and the re-seal is the idempotent
 * no-op the Ingress returns for identical semantic content.
 */
async function startWorkOrigin(
  dir: string,
  vertical: StartVertical,
  extra: string[],
  originKey: string,
  options: StartWorkOptions,
  log: Log,
): Promise<StartWorkResult | undefined> {
  const deps = options.dependencies ?? {};
  const m = deps.manifest ?? loadManifest(dir);
  const c = deps.client ?? liveClient(dir, "cadp-workflow");
  const selection = startSelection(vertical, extra);

  // The origin record: read first, written (once) BEFORE the first Kernel call, never rewritten.
  // The environment resolution stays OUTSIDE the file lock — a `git ls-remote` held across it would
  // serialise unrelated starts — and its result is discarded if the locked check finds this origin
  // already recorded, since the first record for a key wins whatever a racing start resolved.
  const recorded = originRecord(dir, originKey);
  const outcome = recorded !== undefined
    ? { record: recorded, appended: false }
    : appendOriginRecord(dir, {
        origin_key: originKey,
        work_item_digest: sha256Hex(extra[0] ?? ""),
        material_inputs: resolveMaterialInputs(dir, vertical, m, deps),
        created_at: (deps.now ?? (() => new Date().toISOString()))(),
      });
  const record = outcome.record;
  log({ origin: outcome.appended ? "recorded" : "reused", origin_key: originKey, work_item_digest: record.work_item_digest });
  const inputs = record.material_inputs;
  if (vertical === "development" && (inputs.base_sha === undefined || inputs.repo_id === undefined || inputs.repo_full_name === undefined)) {
    // Fail closed rather than re-resolve: a record without the development inputs was written for
    // another vertical, so this key names a different logical origin than the caller believes.
    throw new Error(`origin ${originKey} was recorded without development material inputs — it is not this origin`);
  }

  const args = startArgs(vertical, extra, selection, {
    ...(vertical === "development"
      ? { development: { repo_id: inputs.repo_id!, repo_full_name: inputs.repo_full_name!, base_sha: inputs.base_sha! } }
      : { record: { resource_prefix: originResourcePrefix(originKey) } }),
  });

  // A5 leg o-ii: one `origin_key` derives one `effect_id` for the store's lifetime, so this call is
  // the retry's convergence point. No `step_ordinal` and no clock: the run-origin contract's key
  // set is exactly `{schema, origin_key, purpose}`.
  const tuple = runOriginTuple(originKey);
  const { effect_id } = await c.allocateEffectId(tuple);
  const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
  const material = startMaterial(effect_id, args, args_cas_key, {
    worker_profile_digest: inputs.worker_profile_digest,
    surface_image: inputs.surface_image,
    temporal_namespace_id: inputs.temporal_namespace_id,
  });
  const { cas_key: material_ref } = await c.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const request = await c.sealEffectRequest({
    effect_id,
    requester_ref: "workflow:cadp-work",
    work_bindings: [
      ...startWorkBindings(vertical, extra),
      // B5(9) legs 2 and 3: EXACTLY ONE binding on the declared work-run pair, naming this
      // request's OWN `effect_id`. That self-reference is what the Ingress adjudicates as a run
      // ORIGIN (writing the `run_membership(E, E)` witness its initial dispatch mints against);
      // anything else here is `RUN_CAPABILITY_INVALID`, and omitting it is `RUN_BINDING_REQUIRED`.
      { authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: effect_id },
    ],
    target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: inputs.temporal_namespace_id },
    operation_kind: "WORK_START",
    material_schema: "cadp.work-start.v1",
    material_ref,
    prior_effect_refs: [],
    // B6(1): the allocated tuple is re-presented as transport at the first seal, and repeating it
    // on a re-seal is what B6(2) permits — the same tuple, so the retry stays an idempotent no-op.
    allocation_tuple: tuple,
  });
  const input = await c.assembleAdmissionInput(effect_id, []);
  const evaluated = await c.evaluate(input.input_digest.value);
  if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
    log({ effect_id, origin_key: originKey, evaluated });
    return undefined;
  }
  // The origin's OWN verified initial dispatch is where B5(1) mints the run capability and B6(4)
  // delivers it, once, in THIS response. `ops.ts` neither holds nor renders it: B6(3) forbids any
  // rendering of the secret reaching the process's own log, so the response is logged through
  // `withoutRunCapability` and never as itself.
  const admitted = await c.admitAndDispatch(effect_id, evaluated.decision.decision_id);
  log({ effect_id, origin_key: originKey, workflow_id: material.workflow_id, request_digest: request.request_digest.value, admitted: withoutRunCapability(admitted) });
  if (admitted.kind !== "ADMITTED" || admitted.outcome.result !== "COMMITTED") return undefined;
  return { effect_id, workflow_id: material.workflow_id, origin_key: originKey };
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
 * The plan driver's options: the origin profile it starts its items under (threaded straight to
 * `startWork`, defaulting to the live v0.4 behaviour) plus the same kind of injection seams
 * `sealPlan` carries — the proposal read and the settle loop, whose defaults are the live
 * `loadProposal` and `pollRun`.
 */
export interface WorkPlanOptions {
  originProfile?: OriginProfile;
  dependencies?: StartWorkDependencies;
  loadProposal?: (dir: string, proposalEvidenceId: string) => Promise<WorkProposalV1>;
  settle?: (dir: string, workRunRef: string, workflowId: string, deadlineMs: number) => Promise<ItemStatus>;
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
  const proposal = await (options.loadProposal ?? loadProposal)(dir, proposalEvidenceId);
  const maxItems = boundArg(maxItemsArg, proposal.items.length);
  const results: Array<Record<string, unknown>> = [];
  for (const [index, item] of proposal.items.slice(0, maxItems).entries()) {
    // The item's origin key: DERIVED, not minted, from the sealed proposal's evidence id and this
    // item's index (`planOriginKey`). It is therefore stable across a re-run of the same plan with
    // no file record needed to recover it, and distinct per item, so two items of one proposal are
    // two logical origins. Inert under the `"v04"` profile, which allocates no origin at all.
    const originKey = planOriginKey(proposalEvidenceId, index);
    log({ driver: "starting", index, work_item: item.work_item, origin_key: originKey, bounds: { max_steps: item.max_steps, max_effects: item.max_effects } });
    const started = await startWork(
      dir,
      "development",
      [item.work_item, String(item.max_steps), String(item.max_effects), proposalEvidenceId],
      { log, originKey, ...(options.originProfile !== undefined ? { originProfile: options.originProfile } : {}), ...(options.dependencies !== undefined ? { dependencies: options.dependencies } : {}) },
    );
    if (started === undefined) {
      results.push({ index, work_item: item.work_item, origin_key: originKey, status: "NOT_ADMITTED" });
      break; // fail closed: an item the gate refused halts the loop
    }
    const settled = await (options.settle ?? pollRun)(dir, started.effect_id, started.workflow_id, 30 * 60_000);
    results.push({ index, work_item: item.work_item, origin_key: originKey, work_run_ref: started.effect_id, workflow_id: started.workflow_id, ...settled });
    log({ driver: "settled", index, ...settled });
    if (nextAction(settled) === "HALT") break;
  }
  return results;
}
