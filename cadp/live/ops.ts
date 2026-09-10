/**
 * Shared live-composition operations (#61): the plan / governed-WORK_START / run-polling glue
 * used by both the CLI (`ctl.ts`) and the MCP tool surface (`mcpServer.ts`).
 *
 * Nothing here is authority: `sealPlan` produces proposal plus planner-observation evidence, `startWork` goes through the
 * ordinary governed admission (policy gates every start), and `pollRun`/`runSnapshot` are
 * observations. Callers own presentation; `log` defaults to silent so a protocol server's stdout
 * stays clean.
 *
 * `startWork` carries the two allocation profiles of the v0.4→v0.5 transition side by side: the
 * DEFAULT `"v04"` path is the live deployment's and is unchanged, and `"v05"` is the run-origin path
 * of WP §3.6 / AP B5(9) — `cadp.allocation-key.run-origin.v1`, the self-referential work-run binding,
 * and the origin-record discipline that makes one logical origin seal byte-identical material across
 * every retry. See `StartWorkOptions.originProfile` and `OriginMaterialInputs`.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { AllocationTuple, EvidenceDraft, SealRequestBody } from "../kernel/ingress.ts";
import type {
  AdmissionInputV1, EffectAdmissionV1, EffectOutcomeV1, EffectRequestV1, EvidenceEnvelopeV1, PolicyDecisionV1,
} from "../kernel/records.ts";

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

/** The worker image identity bound into WORK_START material: the built tag plus its docker/in-image probes. */
function workerImageIdentity(dir: string): { image: string; image_digest: string; tool_versions: Record<string, string> } {
  return imageIdentity(readFileSync(join(dir, "worker-image"), "utf8").trim());
}

/**
 * The declared `(authority_ref, namespace)` work-run pair of this deployment's
 * `kernel_subject_namespaces` (AP B3(4)(a)). `declaredWorkRunRef` reads the EXACT pair and nothing
 * else, so the v0.5 origin's self-binding must carry this authority: an off-authority
 * `{other, work-run, …}` binding is not a kernel work-run subject at all and is graded as the "no
 * binding" case (`RUN_BINDING_REQUIRED`), not as a self-origin.
 */
export const WORK_RUN_BINDING_AUTHORITY = "cadp-store:k04";

/** Where one origin's record lives, relative to the deployment dir. ONE FILE PER ORIGIN — see below. */
const ORIGIN_RECORD_DIR = "origin-keys";

const ORIGIN_RECORD_SCHEMA = "cadp.live.origin-record.v1";

/**
 * THE ENVIRONMENT-RESOLVED SEALED-MATERIAL INPUTS OF A v0.5 `WORK_START`, and the whole of the
 * audit this shape records. WP §3.6's replay-stability invariant is general, not a list of patched
 * fields: on the origin path EVERY sealed-material field that is resolved from the ENVIRONMENT at
 * start time is resolved EXACTLY ONCE, at origin creation, and persisted here; a retry rebuilds the
 * material EXCLUSIVELY from {this record + the function arguments + the `origin_key`} and
 * recomputes NOTHING from the environment.
 *
 * AUDIT of `startWork`'s `WORK_START` material (both verticals), field by field.
 *
 * ENVIRONMENT-RESOLVED — every one of them is a member below:
 *   - `args.development.repo_id`, `args.development.repo_full_name` ← `manifest.json`;
 *   - `args.development.base_sha` ← `resolveBaseSha` (a live `git ls-remote` of the declared ref);
 *   - `material.surface_image` and the image half of `material.worker_profile_digest`
 *     (`image`, `image_digest`, `tool_versions`) ← the `worker-image` file, `docker image inspect`
 *     and an in-image version probe;
 *   - `material.continuation_target` ← `temporalNamespaceId` (a live Temporal CLI query).
 *
 * NOT environment-resolved, so deliberately NOT recorded — each is a pure function of the function
 * arguments, of the `origin_key`, of the allocated `effect_id`, or of code:
 *   - `args.bounds`, `args.development.work_item`, `worker_product`, `review_product`,
 *     `external_verification`, `args.record.payloads` ← the `extra` argument vector;
 *   - `args.record.resource_prefix` ← the `origin_key` (`originResourcePrefix`), on this path;
 *   - `args.vertical`, `base_ref`, `require_human_merge`, `tenant`, `material.workflow_type`,
 *     `material.task_queue`, `material.material_schema` ← literals;
 *   - the profile half of `material.worker_profile_digest` ← `workerProfileDigest()`, pure code;
 *   - `material.workflow_id` ← the allocated `effect_id`; `material.args_cas_key` /
 *     `material.args_digest` / `material.bounds` ← the `args` object built from the above.
 *
 * A FUTURE FIELD MUST CONSCIOUSLY JOIN THIS RECORD. A new environment-derived sealed-material field
 * added without a member here is exactly the drift this invariant forbids: its first attempt and
 * its retry would seal different bytes under one converged `effect_id`, which is
 * `REQUEST_DIGEST_CONFLICT` — an incident and a scope hold, and an origin unretryable for the
 * store's lifetime (Spec v0.5 K3, WP §3.6).
 */
export interface OriginMaterialInputs {
  /** `material.continuation_target` = `temporal:cadp-v04:<namespace_id>`. */
  readonly namespace_id: string;
  /** `material.surface_image` verbatim, and the image half of `worker_profile_digest`. */
  readonly surface_image: { readonly image: string; readonly image_digest: string; readonly tool_versions: Record<string, string> };
  /** Development vertical only: `args.development.repo_id`. */
  readonly repo_id?: string;
  /** Development vertical only: `args.development.repo_full_name`. */
  readonly repo_full_name?: string;
  /** Development vertical only: `args.development.base_sha`, the ref tip AT ORIGIN CREATION. */
  readonly base_sha?: string;
}

/**
 * One logical origin's durable record. Written BEFORE the first kernel call of the origin's first
 * attempt and never rewritten, so it serves two distinct obligations at once:
 *
 *  (1) DURABILITY OF A MINTED KEY (WP §3.6 caller obligation 1). A direct start mints its
 *      `origin_key` itself; if a failure swallowed it, the retry would mint a SECOND key and fork
 *      one logical origin into two run identities. The record means a crashed process leaves the
 *      key recoverable on disk, not only in a log line.
 *  (2) MATERIAL FIXING (WP §3.6 replay stability), for EVERY v0.5 origin — minted, caller-passed
 *      and `workPlan`-derived keys alike. `material_inputs` is the environment, resolved once.
 */
export interface OriginRecord {
  readonly schema: typeof ORIGIN_RECORD_SCHEMA;
  readonly origin_key: string;
  readonly vertical: "development" | "record";
  /**
   * `cadp-jcs-1` digest of `{vertical, extra}` — the whole argument vector this origin was created
   * for, not just the work item. It is NOT identity (the `origin_key` is) and never enters sealed
   * material; it exists so a retry that silently changed an argument is refused HERE, before the
   * kernel is asked to re-seal one `effect_id` with different bytes.
   */
  readonly work_item_digest: string;
  readonly material_inputs: OriginMaterialInputs;
  /** Wall clock, for the human reading a recovered record. Never sealed, never an identity input. */
  readonly created_at: string;
}

/**
 * ONE FILE PER ORIGIN, named by `sha256Hex(origin_key)`. A minted key is a UUID and a derived one is
 * a hex digest, both already filesystem-safe — but a CALLER-PASSED key is an opaque string, so the
 * name is always the digest and the key itself lives inside the record. No shared index file: a
 * shared file would need a lock, and a lock needs stale-lock reclamation, which can steal a live
 * lock and lose a record. There is no lock here, no TTL, no reclamation and no deletion.
 */
export function originRecordPath(dir: string, origin_key: string): string {
  return join(dir, ORIGIN_RECORD_DIR, `${sha256Hex(origin_key)}.json`);
}

/**
 * The documented RECOVERY READ. A start that crashed leaves its record here: read it, then
 * re-invoke `startWork` with the recorded `origin_key` to converge on the same `effect_id` and
 * re-seal byte-identical material.
 */
export function readOriginRecord(dir: string, origin_key: string): OriginRecord | undefined {
  const path = originRecordPath(dir, origin_key);
  if (!existsSync(path)) return undefined;
  // The file is untrusted input — a foreign, truncated or hand-edited one fails closed HERE rather
  // than seeding sealed material, so the shape is established before any member is read for meaning.
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const inputs = parsed["material_inputs"];
  if (
    parsed["schema"] !== ORIGIN_RECORD_SCHEMA || parsed["origin_key"] !== origin_key ||
    typeof inputs !== "object" || inputs === null
  ) {
    throw new Error(`${path} is not the origin record for ${origin_key}`);
  }
  return parsed as unknown as OriginRecord;
}

/**
 * FIRST-WRITER-WINS, with no lock. The record is immutable once written, but it is NOT
 * content-deterministic — two racing attempts at one origin can resolve DIFFERENT `base_sha`s — so
 * publishing must not overwrite: whoever wrote first owns the origin's material, and the racer
 * ADOPTS it (which is why this returns what the file holds, never what the caller proposed).
 *
 * The idiom is write-tmp-then-`linkSync`, not write-tmp-then-`renameSync`: both publish atomically,
 * but `rename` OVERWRITES, so a racer could replace the winner's record after the winner had
 * already sealed against it — and an `existsSync` guard before the rename only narrows that window
 * instead of closing it. `link` fails `EEXIST` atomically, which IS first-writer-wins. The tmp file
 * is written whole first, so a crash mid-write can never publish a truncated record.
 */
function createOriginRecord(dir: string, record: OriginRecord): OriginRecord {
  const path = originRecordPath(dir, record.origin_key);
  mkdirSync(join(dir, ORIGIN_RECORD_DIR), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  try {
    linkSync(tmp, path);
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
  const published = readOriginRecord(dir, record.origin_key);
  if (published === undefined) throw new Error(`origin record for ${record.origin_key} vanished after publication`);
  return published;
}

/**
 * WP §3.6's named derivation for the `workPlan` path: the stable pair already present at origin
 * creation — the sealed proposal's evidence id and the item's index — under a canonical injective
 * encoding. Decided ONCE per logical origin BY CONSTRUCTION, so this path needs no durability
 * record for the KEY: a crashed driver re-derives it from the same proposal id and index. (The
 * MATERIAL record is a separate obligation and the derived path takes it too — see `startWork`.)
 *
 * Nothing about the work's CONTENT is digested: two proposals naming byte-identical items are two
 * origins, because their proposal ids differ. A content fingerprint would instead collide them on
 * one `effect_id` and the second seal would land `REQUEST_DIGEST_CONFLICT` (WP §3.6).
 */
export function workPlanOriginKey(proposalEvidenceId: string, itemIndex: number): string {
  return jcsDigest({
    schema: "cadp.live.origin-key.work-plan.v1",
    proposal_evidence_id: proposalEvidenceId,
    item_index: itemIndex,
  }).value;
}

/**
 * The record vertical's `resource_prefix` on the v0.5 origin path: a deterministic function of the
 * origin's stable `origin_key`, replacing `live-${Date.now() % 100000}`. The prefix's job is that
 * distinct runs write distinct resources, and the `origin_key` is exactly the discriminator that
 * distinguishes origins — so this keeps the job while making the sealed `args` byte-reproducible
 * for one origin, which a wall-clock prefix cannot be (WP §3.6).
 */
export function originResourcePrefix(origin_key: string): string {
  return `live-${sha256Hex(`cadp.live.resource-prefix.v1:${origin_key}`).slice(0, 12)}`;
}

/**
 * The v0.5 origin path's failure shape, and the reason it exists: a minted `origin_key` that a
 * failure swallowed would be re-minted by the retry, and two keys for one logical origin is the run
 * fork WP §3.6's verbatim-preservation obligation forbids. So the key is emitted through the log the
 * moment it is minted, persisted in the origin record before the first kernel call, AND carried by
 * every failure after it is decided — message included, so a caller that only prints `e.message`
 * (as `ctl auto-dev` does) still leaves the key recoverable.
 *
 * EVERY failure of a v0.5 start is this shape, not only the kernel's: the key is decided before the
 * manifest read, the client mint and the argument refusals, so a `loadManifest` ENOENT or an unknown
 * `worker_product` surfaces the key too. Such a failure precedes the origin record, so
 * `origin_record_path` may name a file that does not exist yet — which is not a lost origin: nothing
 * was resolved, recorded or sealed, so re-invoking with this key creates the record then and still
 * yields ONE origin and ONE `effect_id`. The record's absence tells the recovering operator exactly
 * that: this origin never reached its material.
 */
export class OriginStartFailure extends Error {
  readonly origin_key: string;

  readonly origin_record_path: string;

  constructor(origin_key: string, origin_record_path: string, cause: unknown) {
    super(
      `${cause instanceof Error ? cause.message : String(cause)} [origin_key=${origin_key}; retry by re-invoking startWork with this origin_key — record: ${origin_record_path}]`,
      { cause },
    );
    this.name = "OriginStartFailure";
    this.origin_key = origin_key;
    this.origin_record_path = origin_record_path;
  }
}

/**
 * v0.5 only: a sealed-material field the origin record MUST carry. A missing member is refused
 * rather than re-resolved from the environment — silently re-resolving is precisely the drift the
 * replay-stability invariant forbids.
 */
function pinned<T>(value: T | undefined, field: string, origin_key: string): T {
  if (value === undefined) {
    throw new Error(`origin record for ${origin_key} carries no ${field} — refusing to re-resolve it from the environment on a retry (WP §3.6)`);
  }
  return value;
}

/**
 * AP B6(3)/B6(4): `admit_and_dispatch` carries the freshly minted `run_capability` on the verified
 * initial dispatch of a run origin, and the delivery is one-shot. The v0.4 branch logs its result
 * verbatim (no v0.4 dispatch can ever deliver one — minting is expressible only under a v2 config),
 * but the origin path must never log it, so its line carries this projection instead.
 */
function withoutRunCapability(admitted: unknown): unknown {
  if (typeof admitted !== "object" || admitted === null) return admitted;
  const { run_capability, ...rest } = admitted as Record<string, unknown>;
  return run_capability === undefined ? rest : { ...rest, run_capability: "<withheld: AP B6(3)>" };
}

/** The Kernel methods `startWork` uses. `KernelClient` satisfies it; tests inject at this seam. */
export interface StartWorkKernelClient {
  allocateEffectId(tuple: AllocationTuple): Promise<{ effect_id: string }>;
  putBlob(bytes: Uint8Array): Promise<{ cas_key: string }>;
  sealEffectRequest(body: SealRequestBody): Promise<EffectRequestV1>;
  assembleAdmissionInput(effect_id: string, evidence_refs: string[]): Promise<AdmissionInputV1>;
  evaluate(input_digest: string): Promise<
    | { kind: "DECISION"; decision: PolicyDecisionV1 }
    | { kind: "POLICY_NOT_ACTIVE" }
    | { kind: "EVALUATION_UNAVAILABLE"; detail: string }
  >;
  admitAndDispatch(effect_id: string, decision_id: string): Promise<
    | { kind: "ADMITTED"; admission: EffectAdmissionV1; outcome: EffectOutcomeV1; run_capability?: string }
    | { kind: "REFUSAL"; reason: string; detail?: string }
  >;
}

/** The environment seams `startWork` reads, injectable exactly as `sealPlan`'s are. */
export interface StartWorkDependencies {
  manifest?: LiveEnvManifest;
  client?: StartWorkKernelClient;
  namespaceId?: (m: LiveEnvManifest) => string;
  resolveBase?: (repoFullName: string, baseRef: string) => string;
  workerImage?: (dir: string) => { image: string; image_digest: string; tool_versions: Record<string, string> };
  /** Defaults to `crypto.randomUUID`; injected only to make a test's minted key deterministic. */
  mintOriginKey?: () => string;
}

export interface StartWorkOptions {
  ordinalArg?: string;
  log?: Log;
  /**
   * WHICH ALLOCATION PATH THIS START TAKES, and why it is an explicit option rather than a read of
   * the deployment's active kernel config. The gate must be the deployment's active
   * `data.cadp.schema` (v1 ⇒ v0.4's tuple, v2 ⇒ the run-origin tuple), and `ops.ts` cannot read it:
   * the live manifest's `kernel_config_path` is the kernel SERVICE config (db path, ports), not the
   * policy bundle, and the active bundle lives in the store behind the API, which exposes no
   * active-policy read (`clients/kernelClient.ts`). Opening `k04.sqlite` from here would both
   * couple the live surface to kernel storage and be wrong whenever the kernel is not co-located.
   *
   * So: an explicit flag, DEFAULTING TO `"v04"`. The live v0.4 deployment therefore exercises the
   * default branch unchanged — byte-identical tuple and byte-identical sealed material — and the
   * v0.5 genesis composition passes `"v05"`.
   *
   * A MISMATCH CANNOT PASS SILENTLY, which is what makes an explicit flag safe here: `"v05"` against
   * a v1 deployment is refused at `allocate_effect_id` (v1 accepts `cadp.allocation-key.v1` and
   * nothing else), and `"v04"` against a v2 deployment is refused at the first seal —
   * `cadp.allocation-key.v1` marks `work_run_ref` PROJECTED, so B2(3.4) demands a sealed `work-run`
   * binding equal to the zero sentinel and this branch seals none (`ALLOCATION_BINDING_MISMATCH`,
   * before any K3 record exists). Either way nothing is sealed under the wrong contract.
   */
  originProfile?: "v04" | "v05";
  /**
   * v0.5 only: THE origin_key of this logical origin, decided by the caller and preserved VERBATIM
   * across every retry of it (WP §3.6 caller obligation 1). `workPlan` passes its derived key; a
   * retry of a direct start passes the key the first attempt minted and recorded. Omitted on a
   * direct start, `startWork` mints one itself — exactly once, and durably.
   */
  originKey?: string;
  dependencies?: StartWorkDependencies;
}

/**
 * One governed WORK_START through the ordinary admission chain. `undefined` = refused, honestly logged.
 *
 * TWO ALLOCATION PATHS, selected by `options.originProfile` and NOT by anything the kernel is asked:
 *
 *  - `"v04"` (the DEFAULT, and what the live v0.4 deployment runs): unchanged. The
 *    `cadp.allocation-key.v1` tuple with its zero-sentinel `work_run_ref` and its wall-clock
 *    `step_ordinal`, no `work-run` binding, no presented `allocation_tuple`, the record vertical's
 *    wall-clock `resource_prefix`, and not one read or write of an origin record.
 *  - `"v05"`: `cadp.allocation-key.run-origin.v1` with `{schema, origin_key, purpose}` and nothing
 *    else (WP §3.6), EXACTLY ONE `work-run` binding naming the allocated `effect_id` itself so
 *    AP B5(9) adjudicates the seal as the run's origin, the `origin_key`-derived `resource_prefix`,
 *    no `step_ordinal` at all — and the material-fixing discipline that makes one logical origin
 *    seal byte-identical material forever: see `OriginMaterialInputs`.
 */
export async function startWork(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: StartWorkOptions = {},
): Promise<{ effect_id: string; workflow_id: string; origin_key?: string; run_capability?: string } | undefined> {
  const log = options.log ?? SILENT;
  const originProfile = options.originProfile ?? "v04";
  const deps = options.dependencies ?? {};

  // ---------------------------------------------------------------- v0.5 origin identity
  // THE KEY IS DECIDED FIRST — before the manifest is read, before a client is built, before a
  // single argument is validated. Nothing above this point can fail, and everything below it runs
  // inside `startOrigin`, under the catch that attaches the key to the error. That ordering IS the
  // durability obligation: a minted key that a failure swallowed would be re-minted by the retry,
  // and two keys for one logical origin is the run fork WP §3.6's verbatim-preservation obligation
  // forbids. Loading the manifest, minting the kernel client and resolving the worker/review
  // providers are all fallible, so none of them may run before the key exists.
  // A minted key is emitted through the log the moment it is decided, carried by every subsequent
  // failure via `OriginStartFailure`, and persisted in the origin record before the first kernel
  // call. `workPlan`'s derived keys need no such emission: they are re-derivable from the proposal
  // id and the item index.
  // WP §3.6 gives `origin_key` the `NONEMPTY_STRING` value contract, so an empty one is refused here
  // rather than sent to be refused as `ALLOCATION_TUPLE_INVALID` after a record has been written.
  // This one refusal may precede the mint: it rejects a key the CALLER passed, so on that path there
  // is no minted key to lose (`originKey === ""` and "mint one" are mutually exclusive).
  if (options.originKey === "") throw new Error("originKey must be a non-empty string (WP §3.6: NONEMPTY_STRING)");
  const minted = originProfile === "v05" && options.originKey === undefined;
  const origin_key = originProfile === "v05" ? options.originKey ?? (deps.mintOriginKey ?? randomUUID)() : undefined;
  if (minted && origin_key !== undefined) {
    log({
      origin: "MINTED", origin_key, origin_record: originRecordPath(dir, origin_key),
      recovery: "re-invoke startWork with this origin_key to converge on the same effect_id",
    });
  }
  try {
    return await startOrigin();
  } catch (error) {
    // v0.4 propagates its errors exactly as it does today; only the origin path re-throws with the
    // key attached, and never swallows the cause.
    if (origin_key === undefined) throw error;
    throw new OriginStartFailure(origin_key, originRecordPath(dir, origin_key), error);
  }

  /**
   * EVERY FALLIBLE STEP OF A START, for both profiles: the environment reads, the argument
   * refusals, the origin's material and the kernel chain. It is a nested function for exactly one
   * reason — the `catch` above must cover every failure that can happen once an `origin_key`
   * exists, so a minted key is never lost to a thrown error, whether it was thrown by the kernel or
   * by `loadManifest`, `liveClient` or a provider select. The step order within it is untouched, so
   * the v0.4 branch's observable sequence of external reads and refusals is exactly today's.
   */
  async function startOrigin(): Promise<{ effect_id: string; workflow_id: string; origin_key?: string; run_capability?: string } | undefined> {
    const m = deps.manifest ?? loadManifest(dir);
    const c: StartWorkKernelClient = deps.client ?? liveClient(dir, "cadp-workflow");
    // v0.4 resolves the Temporal namespace HERE, exactly where it does today and ahead of the
    // argument refusals below, so the default branch's observable order of external reads is
    // unchanged. The v0.5 path resolves it inside the origin-material step instead — once per
    // origin, and never again on a retry.
    const v04NamespaceId = originProfile === "v04" ? (deps.namespaceId ?? temporalNamespaceId)(m) : undefined;

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
    // The run-origin tuple carries no `step_ordinal` at all, so an operator-supplied ordinal has no
    // place to go on this path: fail closed rather than accept an argument that would be ignored.
    if (originProfile === "v05" && options.ordinalArg !== undefined) {
      throw new Error("ordinalArg is a v0.4 allocation input; cadp.allocation-key.run-origin.v1 carries no step_ordinal");
    }

    // -------------------------------------------------------------- v0.5 origin material
    // The environment is read EXACTLY ONCE per origin, at origin creation, and recorded. On every
    // later attempt `inputs` comes from the record and nothing here touches `ls-remote`, the
    // `worker-image` file, docker or the Temporal CLI — so a ref that has moved, or an image that
    // has been rebuilt, cannot drift this origin's sealed bytes (see `OriginMaterialInputs`).
    let inputs: OriginMaterialInputs | undefined;
    if (origin_key !== undefined) {
      const work_item_digest = jcsDigest({ vertical, extra }).value;
      const recorded = readOriginRecord(dir, origin_key);
      if (recorded !== undefined) {
        // The digest covers the vertical and the whole argument vector, so this one comparison is
        // the whole "args fixed at first origin creation" obligation.
        if (recorded.work_item_digest !== work_item_digest) {
          throw new Error(`origin ${origin_key} was created for different WORK_START arguments — one logical origin is one set of arguments (a changed argument needs a NEW origin_key, never this one)`);
        }
        inputs = recorded.material_inputs;
      } else {
        // The record is written BEFORE the first kernel call below, so a process that crashes at
        // any point after this line leaves both the key and its material recoverable on disk.
        // `createOriginRecord` returns what the FILE holds: a racer that lost adopts the winner's
        // material rather than sealing its own.
        inputs = createOriginRecord(dir, {
          schema: ORIGIN_RECORD_SCHEMA,
          origin_key,
          vertical,
          work_item_digest,
          material_inputs: {
            namespace_id: (deps.namespaceId ?? temporalNamespaceId)(m),
            surface_image: (deps.workerImage ?? workerImageIdentity)(dir),
            ...(vertical === "development"
              ? {
                  repo_id: m.repo_id,
                  repo_full_name: m.repo_full_name,
                  base_sha: (deps.resolveBase ?? resolveBaseSha)(m.repo_full_name, "refs/heads/main"),
                }
              : {}),
          },
          created_at: new Date().toISOString(),
        }).material_inputs;
      }
    }
    const args =
      vertical === "development"
        ? {
            vertical,
            bounds: { max_steps: boundArg(extra[1], 8), max_effects: boundArg(extra[2], 6) },
            development: {
              repo_id: inputs === undefined ? m.repo_id : pinned(inputs.repo_id, "repo_id", origin_key!),
              repo_full_name: inputs === undefined ? m.repo_full_name : pinned(inputs.repo_full_name, "repo_full_name", origin_key!),
              base_ref: "refs/heads/main",
              // v0.4: resolved fresh at seal time — the manifest's setup-time snapshot goes stale
              // (see resolveBaseSha). v0.5: the tip AT ORIGIN CREATION, read back from the origin
              // record, because on the origin path a retry after the ref moved must seal the SAME
              // bytes under the same converged effect_id, not a fresher base (WP §3.6).
              base_sha: inputs === undefined
                ? (deps.resolveBase ?? resolveBaseSha)(m.repo_full_name, "refs/heads/main")
                : pinned(inputs.base_sha, "base_sha", origin_key!),
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
              // v0.4: unchanged. v0.5: a deterministic function of the origin's stable key — WP §3.6
              // forbids deriving ANY sealed-material field from the wall clock on the origin path.
              resource_prefix: origin_key === undefined ? `live-${Date.now() % 100000}` : originResourcePrefix(origin_key),
              payloads: Array.from({ length: boundArg(extra[0], 2) }, (_, i) => `live payload ${i + 1}`),
            },
          };

    const tuple: AllocationTuple = origin_key === undefined
      ? {
          schema: "cadp.allocation-key.v1",
          work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
          // The clock fallback stays on the v0.4 branch and ONLY on it.
          step_ordinal: options.ordinalArg !== undefined ? Number(options.ordinalArg) : Math.floor(Date.now() / 1000) % 1000000,
          purpose: "work-start",
        }
      // WP §3.6: EXACTLY these three keys. `origin_key` is the single non-reserved field (ENTROPY,
      // NONEMPTY_STRING) and nothing is PROJECTED, so the tuple names no `work_run_ref` — the
      // self-origin relation is authenticated at seal by AP B5(9), not by an allocation projection.
      : { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key, purpose: "work-start" };
    const { effect_id } = await c.allocateEffectId(tuple);
    const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
    // TD §11 version exactness: bind the immutable built-image digest + observed tool versions
    // into the WORK_START worker profile, so the reviewed/live composition names the exact image.
    // v0.5 reads the identity resolved at origin creation — a rebuilt image must not drift the
    // sealed bytes of an origin that has already been created.
    const image = inputs === undefined ? (deps.workerImage ?? workerImageIdentity)(dir) : inputs.surface_image;
    const worker_profile_digest = jcsDigest({
      profile: workerProfileDigest(),
      surface_image: image.image,
      image_digest: image.image_digest,
      tool_versions: image.tool_versions,
    }).value;
    const namespaceId = v04NamespaceId ?? pinned(inputs?.namespace_id, "namespace_id", origin_key!);
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
        ...(vertical === "development" && extra[3] !== undefined && extra[3] !== ""
          ? [{ authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: extra[3] }]
          : []),
        // AP B5(9) legs 2 and 3 / Spec v0.5 §5.3: EXACTLY ONE binding on the declared work-run pair,
        // naming this request's OWN allocated effect_id. That is what makes this seal the run's
        // ORIGIN — it originates the scope's identity, and identity only — and what makes the
        // Ingress write the `run_membership(E, E)` witness in the same transaction as the K3 row.
        // Exactly one: a second binding in a declared kernel namespace is KERNEL_NAMESPACE_AMBIGUOUS,
        // and the other two bindings above are in `work-item` / `work-proposal`, never `work-run`.
        ...(origin_key === undefined
          ? []
          : [{ authority_ref: WORK_RUN_BINDING_AUTHORITY, namespace: "work-run", object_id: effect_id }]),
      ],
      target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: namespaceId },
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref,
      prior_effect_refs: [],
      // AP B6(1): transport, never a draft field — the Ingress strips it before the draft is read,
      // so it enters no record and no digest. REQUIRED on a first seal under a v2 config; on a
      // re-seal it is ignored-if-identical, which is what makes a retry idempotent rather than a
      // second falsehood about the same allocation (B6(2)).
      ...(origin_key === undefined ? {} : { allocation_tuple: tuple }),
    });
    const input = await c.assembleAdmissionInput(effect_id, []);
    const evaluated = await c.evaluate(input.input_digest.value);
    if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
      // The refused return stays `undefined` (the caller's contract). A minted key is still
      // recoverable: it was logged at mint time and persisted in the origin record above.
      log(origin_key === undefined ? { effect_id, evaluated } : { effect_id, origin_key, evaluated });
      return undefined;
    }
    const admitted = await c.admitAndDispatch(effect_id, evaluated.decision.decision_id);
    log(
      origin_key === undefined
        ? { effect_id, workflow_id: material.workflow_id, request_digest: request.request_digest.value, admitted }
        : { effect_id, origin_key, workflow_id: material.workflow_id, request_digest: request.request_digest.value, admitted: withoutRunCapability(admitted) },
    );
    if (admitted.kind !== "ADMITTED" || admitted.outcome.result !== "COMMITTED") return undefined;
    return {
      effect_id,
      workflow_id: material.workflow_id,
      ...(origin_key === undefined ? {} : { origin_key }),
      // AP B5(7)/B6(4): the origin's initial dispatch delivers the run capability ONCE and nothing
      // re-delivers it, so it is handed to the caller — whose secret custody it is — and is never
      // logged (see `withoutRunCapability`) and never persisted here. Plumbing it to this run's
      // later member effects is the composition's lane, not this function's.
      ...(admitted.run_capability === undefined ? {} : { run_capability: admitted.run_capability }),
    };
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

/** The driver's own seams, injectable exactly as `sealPlan`'s and `startWork`'s are. */
export interface WorkPlanDependencies {
  loadProposal?: (dir: string, proposalEvidenceId: string) => Promise<WorkProposalV1>;
  startWork?: typeof startWork;
  pollRun?: (dir: string, workRunRef: string, workflowId: string, deadlineMs: number) => Promise<ItemStatus>;
}

/**
 * Proposal driver (#61): run a sealed WORK_PROPOSAL's items sequentially through the ordinary
 * governed WORK_START. Deterministic glue, zero authority: policy gates every start, an item that
 * reaches its Human merge gate is delivered (merges batch out-of-band via human-approve), and any
 * failed/stopped/stalled run halts the loop fail-closed.
 *
 * `originProfile` is threaded straight through to each item's `startWork` and DEFAULTS to `"v04"`, so
 * the live v0.4 driver is unchanged. Under `"v05"` each item gets its DERIVED `origin_key` (see
 * `workPlanOriginKey`), which is what makes re-running one proposal item converge on that item's own
 * `effect_id` rather than originate a second run.
 */
export async function workPlan(
  dir: string,
  proposalEvidenceId: string,
  maxItemsArg?: string,
  log: Log = SILENT,
  options: { originProfile?: "v04" | "v05"; dependencies?: WorkPlanDependencies } = {},
): Promise<Array<Record<string, unknown>>> {
  const originProfile = options.originProfile ?? "v04";
  const deps = options.dependencies ?? {};
  const proposal = await (deps.loadProposal ?? loadProposal)(dir, proposalEvidenceId);
  const maxItems = boundArg(maxItemsArg, proposal.items.length);
  const results: Array<Record<string, unknown>> = [];
  for (const [index, item] of proposal.items.slice(0, maxItems).entries()) {
    log({ driver: "starting", index, work_item: item.work_item, bounds: { max_steps: item.max_steps, max_effects: item.max_effects } });
    // WP §3.6: on this path the origin's discriminator is DERIVED, not minted — the sealed
    // proposal's evidence id and this item's index are both already present at origin creation and
    // re-derive the same key on every retry of the same item, which is what makes a re-run of one
    // proposal item converge on its own effect_id instead of starting a second run.
    const originKey = originProfile === "v05" ? workPlanOriginKey(proposalEvidenceId, index) : undefined;
    const started = await (deps.startWork ?? startWork)(
      dir,
      "development",
      [item.work_item, String(item.max_steps), String(item.max_effects), proposalEvidenceId],
      { log, originProfile, ...(originKey === undefined ? {} : { originKey }) },
    );
    if (started === undefined) {
      results.push({ index, work_item: item.work_item, status: "NOT_ADMITTED", ...(originKey === undefined ? {} : { origin_key: originKey }) });
      break; // fail closed: an item the gate refused halts the loop
    }
    const settled = await (deps.pollRun ?? pollRun)(dir, started.effect_id, started.workflow_id, 30 * 60_000);
    results.push({
      index, work_item: item.work_item, work_run_ref: started.effect_id, workflow_id: started.workflow_id,
      ...(started.origin_key === undefined ? {} : { origin_key: started.origin_key }), ...settled,
    });
    log({ driver: "settled", index, ...settled });
    if (nextAction(settled) === "HALT") break;
  }
  return results;
}
