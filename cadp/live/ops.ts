/**
 * Shared live-composition operations (#61): the plan / governed-WORK_START / run-polling glue
 * used by both the CLI (`ctl.ts`) and the MCP tool surface (`mcpServer.ts`).
 *
 * Nothing here is authority: `sealPlan` produces proposal plus planner-observation evidence, `startWork` goes through the
 * ordinary governed admission (policy gates every start), and `pollRun`/`runSnapshot` are
 * observations. Callers own presentation; `log` defaults to silent so a protocol server's stdout
 * stays clean.
 *
 * `startWork` carries TWO allocation paths, chosen by `originProfile` and defaulting to the one
 * this deployment runs today (see `OriginProfile`). Under `"v04"` it allocates the
 * `cadp.allocation-key.v1` zero-sentinel tuple with a clock-derived `step_ordinal` and seals exactly
 * the material it seals today. Under `"v05"` it is a RUN ORIGIN in the AP TD A4/A5/B5 sense: it
 * allocates `cadp.allocation-key.run-origin.v1` under a Workflow-decided `origin_key`, binds its own
 * allocated `effect_id` as its `work-run` subject, and fixes every replay-unstable material input in
 * `<dir>/origin-keys.json` — so one logical origin is one `effect_id` over byte-identical material,
 * retry after retry, which is what keeps a retried start an idempotent no-op instead of a
 * `REQUEST_DIGEST_CONFLICT`. Neither path confers authority; both enter the same admission chain.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifest } from "./env.ts";
import type { LiveEnvManifest } from "./env.ts";
import { KernelClient } from "../clients/kernelClient.ts";
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

// ---------------------------------------------------------------- v0.5 run origins (AP TD A4/A5/B5)

/**
 * WHICH allocation contract this deployment's `WORK_START` originates under. The Kernel API exposes
 * no read of the ACTIVE `data.cadp` schema string (`clients/kernelClient.ts` has ten calls and none
 * of them is a config read), and the deployment's `kernel-config.json` is the SERVICE config, not
 * the governed bundle — so ops.ts cannot observe the seam it would otherwise gate on. The gate is
 * therefore an EXPLICIT caller declaration, defaulting to `"v04"`: the live v0.4 deployment (and
 * every existing `ctl.ts` / `mcpServer.ts` call site, none of which passes it) keeps today's
 * `cadp.allocation-key.v1` zero-sentinel allocation, byte for byte. The v0.5 genesis composition is
 * what passes `"v05"`.
 */
export type OriginProfile = "v04" | "v05";

/**
 * One logical run origin's FIXED inputs, appended to `<dir>/origin-keys.json` BEFORE the first
 * kernel call of that origin's first attempt (AP TD A5, WP §3.6 "origin-path material replay
 * stability"). Two jobs, both about the same failure:
 *
 *  (1) DURABILITY of a MINTED key. A direct start decides its `origin_key` itself, and the WP
 *      contract requires that key to be preserved VERBATIM across every retry of that origin. A
 *      key that only ever existed inside a process that then crashed is not preserved — the retry
 *      mints a fresh UUID, allocates a SECOND `effect_id`, and forks the run. Writing the record
 *      before anything can fail leaves a crashed attempt recoverable.
 *  (2) MATERIAL FIXING for EVERY v0.5 origin, minted and derived alike. Tuple convergence alone is
 *      not enough: one `origin_key` re-presents one `effect_id`, so a retry whose sealed material
 *      DRIFTED lands `REQUEST_DIGEST_CONFLICT` (Spec v0.5 K3) — an incident and a scope hold, and
 *      the origin is unretryable for the store's lifetime. `base_sha` is exactly such a drift: it
 *      is a live `ls-remote` of `refs/heads/main` (see `resolveBaseSha`), so a retry after the base
 *      branch moves would seal a different `args_digest` under the same `effect_id`. The record
 *      pins the FIRST resolution and every retry replays it verbatim.
 *
 * RECOVERY FLOW, for an operator whose direct start died: read `<dir>/origin-keys.json`, take the
 * `origin_key` of the record whose `work_item_digest` matches the item (it is also on the start's
 * own log line and on the thrown `StartWorkOriginError`), and re-invoke `startWork` with
 * `{ originKey: <that key> }`. That converges on the same `effect_id` and re-seals byte-identical
 * material — an idempotent no-op if the first attempt got as far as sealing.
 *
 * `workPlan`'s derived keys need no record for (1): `proposal_evidence_id` + item index is stable
 * and recomputable at any time, so a crashed plan run re-derives the identical key with no file to
 * consult. They still go through the record for (2), because material fixing is a property of the
 * ORIGIN and not of how its key was decided.
 */
export interface OriginKeyRecordV1 {
  readonly origin_key: string;
  /** The item this origin was created for, as a digest — never the work's content in the clear. */
  readonly work_item_digest: string;
  readonly created_at: string;
  /** The development vertical's pinned base tip. Absent on the record vertical, which resolves none. */
  readonly base_sha?: string;
}

export function originKeysPath(dir: string): string {
  return join(dir, "origin-keys.json");
}

/** The recorded origins, or `[]` when no origin has ever been created under this deployment. */
export function readOriginKeyRecords(dir: string): OriginKeyRecordV1[] {
  let raw: string;
  try {
    raw = readFileSync(originKeysPath(dir), "utf8");
  } catch (error) {
    // ABSENT is the only readable "no origins yet". Any other read failure — a permission problem,
    // a directory in its place — must NOT degrade to an empty list: "no record" is precisely what
    // makes a retry resolve fresh material and re-seal one effect_id with different bytes, so a
    // swallowed read error here is exactly the REQUEST_DIGEST_CONFLICT this file exists to prevent.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  // Same rule for a damaged file.
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${originKeysPath(dir)} is not a JSON array — refusing to guess a run origin's fixed material`);
  return parsed as OriginKeyRecordV1[];
}

export function findOriginKeyRecord(dir: string, origin_key: string): OriginKeyRecordV1 | undefined {
  return readOriginKeyRecords(dir).find((record) => record.origin_key === origin_key);
}

/** Append-then-rename, so a crash mid-write leaves the previous list intact rather than a truncated one. */
function appendOriginKeyRecord(dir: string, record: OriginKeyRecordV1): void {
  const path = originKeysPath(dir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify([...readOriginKeyRecords(dir), record], null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * WP §3.6's named `workPlan` derivation: the pair `proposal_evidence_id` + item INDEX is already
 * present at origin creation, is decided ONCE per logical origin, and reproduces verbatim on any
 * retry of the same plan. Injective under the stated encoding — an index is decimal digits and
 * carries no `#`, so splitting at the LAST `#` recovers both components exactly — which is what
 * keeps two items of one proposal, and the same index of two proposals, on distinct origins.
 *
 * It is deliberately NOT a function of the work's content: two distinct origins over byte-identical
 * work must carry distinct keys, and a content fingerprint would collide them on one `effect_id`.
 */
export function workPlanOriginKey(proposalEvidenceId: string, index: number): string {
  if (proposalEvidenceId.includes("#")) throw new Error(`proposal evidence id ${proposalEvidenceId} carries the origin-key separator '#'`);
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`item index ${index} is not a plan position`);
  return `cadp-work-plan:${proposalEvidenceId}#${index}`;
}

/**
 * The record vertical's `resource_prefix` as a pure function of the origin — replacing
 * `live-${Date.now() % 100000}`, which is sealed material derived from the wall clock and therefore
 * re-seals one `effect_id` with a different `args_digest` on every retry (WP §3.6, control 14).
 * Same origin ⇒ same prefix forever; distinct origins ⇒ distinct prefixes, because distinct
 * `origin_key`s are what distinguishes them.
 */
export function originResourcePrefix(origin_key: string): string {
  return `live-${sha256Hex(`cadp-live-record-resource-prefix:${origin_key}`).slice(0, 10)}`;
}

/**
 * A failure of a v0.5 origin start, carrying the `origin_key` OUT with it. Without this a failed
 * direct start would swallow the one value a retry must preserve, and the retry would mint a fresh
 * UUID and fork the run. The key is also emitted through the log callback the moment it is minted
 * and recorded in `<dir>/origin-keys.json` before the first kernel call — three independent places,
 * because a process that dies mid-start reaches only some of them.
 */
export class StartWorkOriginError extends Error {
  readonly origin_key: string;

  readonly origin_keys_path: string;

  constructor(origin_key: string, origin_keys_path: string, cause: unknown) {
    super(
      `${cause instanceof Error ? cause.message : String(cause)} — run origin ${origin_key} (recorded in ${origin_keys_path}); ` +
        "retry with THIS origin_key, never a fresh one, to converge on the same effect_id",
      { cause },
    );
    this.name = "StartWorkOriginError";
    this.origin_key = origin_key;
    this.origin_keys_path = origin_keys_path;
  }
}

export interface StartWorkOptions {
  /** v0.4 only: the `cadp.allocation-key.v1` step ordinal. A run-origin tuple has no ordinal. */
  ordinalArg?: string;
  log?: Log;
  originProfile?: OriginProfile;
  /**
   * v0.5 only: an `origin_key` the CALLER already decided — `workPlan`'s derived key, or a key
   * recovered from `<dir>/origin-keys.json` when retrying a start that died. Omitted on a direct
   * start, which mints one exactly once per invocation.
   */
  originKey?: string;
}

/** Exactly the kernel calls one governed WORK_START makes; `KernelClient` satisfies it structurally. */
export type WorkKernelClient = Pick<
  KernelClient,
  "allocateEffectId" | "putBlob" | "sealEffectRequest" | "assembleAdmissionInput" | "evaluate" | "admitAndDispatch"
>;

/** Composition seams (same rationale as `SealPlanDependencies`): the live defaults are the real ones. */
export interface StartWorkDependencies {
  manifest?: LiveEnvManifest;
  client?: WorkKernelClient;
  namespaceId?: (m: LiveEnvManifest) => string;
  resolveBase?: (repoFullName: string, baseRef: string) => string;
  workerImage?: () => { image: string; image_digest: string; tool_versions: Record<string, string> };
  /** How a DIRECT start mints its one `origin_key`; `crypto.randomUUID` live. */
  mintOriginKey?: () => string;
  /** `created_at` of a new origin record. Bookkeeping only — never a sealed-material input. */
  now?: () => string;
}

export interface StartedWork {
  effect_id: string;
  workflow_id: string;
  /** Present on the v0.5 origin path only: the key a retry of THIS origin must re-present. */
  origin_key?: string;
}

interface FixedOrigin {
  readonly origin_key: string;
  readonly minted: boolean;
  readonly record: OriginKeyRecordV1;
}

/**
 * Decide the origin and FIX its material, before any kernel call and before any commodity lookup:
 * mint or accept the `origin_key`, emit it, then either replay the recorded material inputs or
 * resolve them once and record them. Everything after this point can fail without forking the run.
 */
function fixRunOrigin(
  dir: string,
  vertical: "development" | "record",
  work_item_ref: string,
  m: LiveEnvManifest,
  options: StartWorkOptions,
  dependencies: StartWorkDependencies,
  log: Log,
): FixedOrigin {
  const mint = dependencies.mintOriginKey ?? ((): string => randomUUID());
  const minted = options.originKey === undefined;
  const origin_key = options.originKey ?? mint();
  // EMITTED first: the log line is the one record that exists even if the filesystem write fails.
  if (minted) log({ origin_start: "ORIGIN_KEY_MINTED", origin_key, origin_keys_path: originKeysPath(dir) });
  const recorded = findOriginKeyRecord(dir, origin_key);
  if (recorded !== undefined) {
    // A retry of a KNOWN origin: the recorded inputs are replayed VERBATIM and `resolveBaseSha` is
    // not called again, so a base ref that moved since the first attempt cannot drift this seal.
    if (vertical === "development" && recorded.base_sha === undefined) {
      throw new Error(`origin ${origin_key} was recorded without a base_sha — refusing to re-resolve one for a development origin`);
    }
    log({ origin_start: "ORIGIN_RECORD_REPLAYED", origin_key, ...(recorded.base_sha !== undefined ? { base_sha: recorded.base_sha } : {}) });
    return { origin_key, minted, record: recorded };
  }
  const base_sha = vertical === "development" ? (dependencies.resolveBase ?? resolveBaseSha)(m.repo_full_name, "refs/heads/main") : undefined;
  const record: OriginKeyRecordV1 = {
    origin_key,
    work_item_digest: sha256Hex(work_item_ref),
    created_at: (dependencies.now ?? (() => new Date().toISOString()))(),
    ...(base_sha !== undefined ? { base_sha } : {}),
  };
  appendOriginKeyRecord(dir, record);
  log({ origin_start: "ORIGIN_RECORD_WRITTEN", origin_key, ...(base_sha !== undefined ? { base_sha } : {}) });
  return { origin_key, minted, record };
}

/** The work-run subject pair every kernel reader resolves a run scope on (AP B3(4)(a)). */
const WORK_RUN_AUTHORITY = "cadp-store:k04";

/** One governed WORK_START through the ordinary admission chain. `undefined` = refused, honestly logged. */
export async function startWork(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: StartWorkOptions = {},
  dependencies: StartWorkDependencies = {},
): Promise<StartedWork | undefined> {
  const log = options.log ?? SILENT;
  const originProfile = options.originProfile ?? "v04";
  // The two cross-profile inputs, refused rather than silently ignored: an `origin_key` means
  // nothing to a v0.4 allocation, and `cadp.allocation-key.run-origin.v1` has exactly three keys
  // and no `step_ordinal` for an ordinal argument to land in.
  if (originProfile === "v04" && options.originKey !== undefined) {
    throw new Error("originKey is a v0.5 run-origin input — a cadp.allocation-key.v1 allocation has no origin to preserve");
  }
  if (originProfile === "v05" && options.ordinalArg !== undefined) {
    throw new Error("step_ordinal is not a field of cadp.allocation-key.run-origin.v1 — a v0.5 origin carries no ordinal");
  }
  const m = dependencies.manifest ?? loadManifest(dir);

  // ENTRY VALIDATION, hoisted above the origin phase and the two commodity lookups below it. It
  // reads only its own arguments, seals nothing and calls nothing, so no v0.4 sealed byte moves;
  // what it buys is that a malformed invocation is refused BEFORE an origin_key is minted or
  // recorded, instead of leaving an unused origin behind for an item that never started.
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
  const work_item_ref = vertical === "development" ? `dev:${extra[0]}` : `record:${extra[0]}`;

  // The v0.5 origin phase. Under `"v04"` NOTHING here runs: no key is minted, `origin-keys.json` is
  // neither read nor written, and the branch below is the checked-out one unchanged.
  const origin = originProfile === "v05" ? fixRunOrigin(dir, vertical, work_item_ref, m, options, dependencies, log) : undefined;
  const originLog: { origin_key?: string } = origin !== undefined ? { origin_key: origin.origin_key } : {};

  try {
    const c = dependencies.client ?? liveClient(dir, "cadp-workflow");
    const namespaceId = (dependencies.namespaceId ?? temporalNamespaceId)(m);
    const args =
      vertical === "development"
        ? {
            vertical,
            bounds: { max_steps: boundArg(extra[1], 8), max_effects: boundArg(extra[2], 6) },
            development: {
              repo_id: m.repo_id,
              repo_full_name: m.repo_full_name,
              base_ref: "refs/heads/main",
              // v0.4: resolved fresh at seal time — the manifest's setup-time snapshot goes stale
              // (see resolveBaseSha). v0.5: the origin's PINNED first resolution, replayed from the
              // origin record, so a base ref that moved between two attempts of ONE origin cannot
              // re-seal that origin's effect_id with different bytes. Read as an assertion, not a
              // fallback: `fixRunOrigin` resolves-and-records the base for every NEW development
              // origin and REFUSES a replayed one that pins none, so an origin here always has it.
              base_sha: origin !== undefined
                ? origin.record.base_sha!
                : (dependencies.resolveBase ?? resolveBaseSha)(m.repo_full_name, "refs/heads/main"),
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
              // v0.4 keeps the clock-derived prefix byte-for-byte; a v0.5 origin derives it from
              // the origin_key, which is what makes its sealed material replay-stable.
              resource_prefix: origin !== undefined ? originResourcePrefix(origin.origin_key) : `live-${Date.now() % 100000}`,
              payloads: Array.from({ length: boundArg(extra[0], 2) }, (_, i) => `live payload ${i + 1}`),
            },
          };

    // AP TD B5(9)/WP §3.6. v0.5: exactly `{schema, origin_key, purpose}` — no `work_run_ref` (the
    // origin's self-binding is a seal-time adjudication, not an allocation projection) and NO
    // wall-clock ordinal. v0.4: the zero-sentinel tuple exactly as it stands today.
    const tuple: AllocationTuple =
      origin !== undefined
        ? { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: origin.origin_key, purpose: "work-start" }
        : {
            schema: "cadp.allocation-key.v1",
            work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
            step_ordinal: options.ordinalArg !== undefined ? Number(options.ordinalArg) : Math.floor(Date.now() / 1000) % 1000000,
            purpose: "work-start",
          };
    const { effect_id } = await c.allocateEffectId(tuple);
    const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
    // TD §11 version exactness: bind the immutable built-image digest + observed tool versions
    // into the WORK_START worker profile, so the reviewed/live composition names the exact image.
    const image = (dependencies.workerImage ?? (() => imageIdentity(readFileSync(join(dir, "worker-image"), "utf8").trim())))();
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
        { authority_ref: "github.com", namespace: "work-item", object_id: work_item_ref },
        // Optional exact provenance: the WORK_PROPOSAL this item came from. A binding, never authority.
        ...(vertical === "development" && extra[3] !== undefined && extra[3] !== ""
          ? [{ authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: extra[3] }]
          : []),
        // AP TD B5(9) leg 3, v0.5 only: EXACTLY ONE work-run binding, on the declared pair, whose
        // object_id is this request's OWN allocated effect_id. That self-reference is what makes
        // the seal an ORIGIN (writing the `run_membership(E, E)` witness) rather than a member
        // request the Ingress would refuse for presenting no capability.
        ...(origin !== undefined ? [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: effect_id }] : []),
      ],
      target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: namespaceId },
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref,
      prior_effect_refs: [],
      // AP B6(1): transport, never a draft field. Required on a first seal under a v0.5 bundle;
      // on a retry's re-seal it is ignored-if-identical, which is what this path re-presents.
      ...(origin !== undefined ? { allocation_tuple: tuple } : {}),
    });
    const input = await c.assembleAdmissionInput(effect_id, []);
    const evaluated = await c.evaluate(input.input_digest.value);
    if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
      log({ effect_id, evaluated, ...originLog });
      return undefined;
    }
    const admitted = await c.admitAndDispatch(effect_id, evaluated.decision.decision_id);
    log({ effect_id, workflow_id: material.workflow_id, request_digest: request.request_digest.value, admitted, ...originLog });
    if (admitted.kind !== "ADMITTED" || admitted.outcome.result !== "COMMITTED") return undefined;
    return { effect_id, workflow_id: material.workflow_id, ...originLog };
  } catch (error) {
    if (origin === undefined) throw error;
    // Every failure path of a v0.5 origin carries the key out — through the log AND the error — so
    // a retry can re-present it instead of minting a second identity for the same logical origin.
    log({ origin_start: "FAILED", origin_key: origin.origin_key, origin_keys_path: originKeysPath(dir), detail: error instanceof Error ? error.message : String(error) });
    throw new StartWorkOriginError(origin.origin_key, originKeysPath(dir), error);
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
export interface WorkPlanDependencies {
  loadProposal?: (dir: string, proposalEvidenceId: string) => Promise<WorkProposalV1>;
  startWork?: typeof startWork;
  pollRun?: (dir: string, workRunRef: string, workflowId: string, deadlineMs: number) => Promise<ItemStatus>;
}

export async function workPlan(
  dir: string,
  proposalEvidenceId: string,
  maxItemsArg?: string,
  log: Log = SILENT,
  options: { originProfile?: OriginProfile } = {},
  dependencies: WorkPlanDependencies = {},
): Promise<Array<Record<string, unknown>>> {
  const originProfile = options.originProfile ?? "v04";
  const proposal = await (dependencies.loadProposal ?? loadProposal)(dir, proposalEvidenceId);
  const maxItems = boundArg(maxItemsArg, proposal.items.length);
  const results: Array<Record<string, unknown>> = [];
  for (const [index, item] of proposal.items.slice(0, maxItems).entries()) {
    log({ driver: "starting", index, work_item: item.work_item, bounds: { max_steps: item.max_steps, max_effects: item.max_effects } });
    // The origin_key is DERIVED here, once, from the pair that already identifies this logical
    // origin — and re-derives identically on any retry of the same plan, which is what the WP
    // contract asks of the Workflow side. `startWork` still consults the origin record for the
    // MATERIAL inputs (`base_sha`), so a moved ref between two attempts of one item cannot drift
    // that item's sealed bytes either.
    const started = await (dependencies.startWork ?? startWork)(
      dir,
      "development",
      [item.work_item, String(item.max_steps), String(item.max_effects), proposalEvidenceId],
      { log, originProfile, ...(originProfile === "v05" ? { originKey: workPlanOriginKey(proposalEvidenceId, index) } : {}) },
    );
    if (started === undefined) {
      results.push({ index, work_item: item.work_item, status: "NOT_ADMITTED" });
      break; // fail closed: an item the gate refused halts the loop
    }
    const settled = await (dependencies.pollRun ?? pollRun)(dir, started.effect_id, started.workflow_id, 30 * 60_000);
    results.push({ index, work_item: item.work_item, work_run_ref: started.effect_id, workflow_id: started.workflow_id, ...settled });
    log({ driver: "settled", index, ...settled });
    if (nextAction(settled) === "HALT") break;
  }
  return results;
}
