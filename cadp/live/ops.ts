/**
 * Shared live-composition operations (#61): the plan / governed-WORK_START / run-polling glue
 * used by both the CLI (`ctl.ts`) and the MCP tool surface (`mcpServer.ts`).
 *
 * Nothing here is authority: `sealPlan` produces proposal plus planner-observation evidence, `startWork` goes through the
 * ordinary governed admission (policy gates every start), and `pollRun`/`runSnapshot` are
 * observations. Callers own presentation; `log` defaults to silent so a protocol server's stdout
 * stays clean.
 *
 * `startWork` carries TWO origin paths, selected by `options.originProfile` and defaulting to the
 * v0.4 one this deployment runs: the checked-out `cadp.allocation-key.v1` zero-sentinel allocation
 * (unchanged, wall-clock ordinal and all), and the v0.5 RUN-ORIGIN path of WP §3.6 / AP B1(5),
 * B5(9) — `cadp.allocation-key.run-origin.v1` keyed by a stable `origin_key`, a self-referential
 * work-run binding, and sealed material pinned at origin creation so one logical origin retries
 * onto byte-identical bytes. See `startWorkV05` and the environment audit above
 * `ORIGIN_MATERIAL_INPUT_KEYS`.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadManifest } from "./env.ts";
import type { LiveEnvManifest } from "./env.ts";
import { KernelClient } from "../clients/kernelClient.ts";
import { jcsDigest, sha256Hex } from "../kernel/canonical.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA } from "../kernel/policyBundle.ts";
import type { AllocationTuple, SealRequestBody } from "../kernel/ingress.ts";
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

/** The base ref the development vertical DECLARES and resolves against — one literal, two uses. */
const DEV_BASE_REF = "refs/heads/main";

/** The v0.4 origin allocation's placeholder `work_run_ref`: a run identity no run ever has. */
const ZERO_WORK_RUN_REF = "cadp-v04:effect:00000000-0000-7000-8000-000000000000";

/** The DECLARED kernel work-run subject pair (`kernel_subject_namespaces`), for the origin self-binding. */
const WORK_RUN_AUTHORITY = "cadp-store:k04";

export type OriginProfile = "v04" | "v05";

/** The immutable image identity bound into WORK_START material (TD §11 version exactness). */
export interface SurfaceImageIdentity {
  readonly image: string;
  readonly image_digest: string;
  readonly tool_versions: Record<string, string>;
}

/**
 * The kernel surface one governed start uses, named structurally so a test can inject a scripted
 * client (and count its calls) without a live deployment. `KernelClient` satisfies it as it is.
 */
export type WorkStartKernelClient = Pick<
  KernelClient,
  "allocateEffectId" | "putBlob" | "sealEffectRequest" | "assembleAdmissionInput" | "evaluate" | "admitAndDispatch"
>;

/**
 * The SEAMS of one start, all of them environment reads. Injecting them is what lets the origin
 * conformance tests flip an environment field (a moved ref, a rebuilt worker image) between two
 * attempts at ONE origin and assert the sealed material did not move with it.
 */
export interface StartWorkDependencies {
  manifest?: LiveEnvManifest;
  client?: WorkStartKernelClient;
  namespaceId?: string;
  resolveBase?: (repoFullName: string, baseRef: string) => string;
  /** Reads `<dir>/worker-image` and inspects the built image (docker). */
  surfaceImage?: (dir: string) => SurfaceImageIdentity;
  /** The ONE mint of a direct start's `origin_key` (WP §3.6: decided once, verbatim on retry). */
  newOriginKey?: () => string;
}

export interface StartWorkOptions {
  ordinalArg?: string;
  log?: Log;
  /**
   * WHICH allocation path this start takes, and the ONLY switch between them.
   *
   * `"v04"` (the DEFAULT, and what the live v0.4 deployment therefore exercises) is the checked-out
   * path unchanged: the `cadp.allocation-key.v1` zero-sentinel tuple with a wall-clock
   * `step_ordinal`, the record vertical's wall-clock `resource_prefix`, a freshly resolved
   * `base_sha` on every attempt, no work-run binding and no origin record — byte-identical sealed
   * material to today, because a v1 kernel config accepts no other allocation schema (`#allocateV04`).
   *
   * `"v05"` is the run-origin path of WP §3.6 / AP B1(5), B5(9): allocate under
   * `cadp.allocation-key.run-origin.v1` with a stable `origin_key`, self-bind the allocated
   * `effect_id` as the run, and reproduce the whole sealed material byte-for-byte on every retry of
   * that origin. It is passed by the v0.5 genesis composition, whose active bundle registers the
   * run-origin contract and enrolls `workflow:cadp-work`; passing it at a v1 deployment would be
   * refused `ALLOCATION_TUPLE_INVALID` at allocation, before anything is sealed.
   *
   * The active config's schema string is the rule this gates on, and it is NOT readable from here:
   * the constitutional config lives in the kernel's own store and the API exposes no read of it, so
   * an explicit option is the seam this module actually has. Defaulting to `"v04"` keeps the
   * deployment that never passes it exactly where it is.
   */
  originProfile?: OriginProfile;
  /**
   * The v0.5 origin's stable `origin_key`. Passed by `workPlan` (derived from the proposal and the
   * item index) and by a RETRY of a direct start recovering the key its first attempt minted;
   * omitted on a first direct start, which mints one. Ignored under `"v04"`, which has no origin key.
   */
  originKey?: string;
  dependencies?: StartWorkDependencies;
}

export interface StartWorkResult {
  effect_id: string;
  workflow_id: string;
  /** Present on the v0.5 path: the key that re-derives this exact `effect_id` and material. */
  origin_key?: string;
}

// ================================================================= the origin record (v0.5 only)

/**
 * THE ENVIRONMENT AUDIT, and the invariant it serves.
 *
 * On the v0.5 origin path every sealed-material field is reconstructed from exactly three things:
 * the function ARGUMENTS, the `origin_key`, and this record. Nothing is recomputed from the
 * environment on a retry — because one logical origin converges on ONE `effect_id` (AP B1(2)), and
 * a re-seal of that `effect_id` carrying drifted material is not a retry but a
 * `REQUEST_DIGEST_CONFLICT`: a K3 incident and a scope hold, leaving the origin unretryable for the
 * store's lifetime (WP §3.6, control 14).
 *
 * The audit of `startWork`'s WORK_START material found EXACTLY these environment-resolved inputs,
 * and every one of them is pinned in the record at origin creation:
 *   - `repo_id`, `repo_full_name` — read from `<dir>/manifest.json` (development args);
 *   - `base_sha` — `git ls-remote` against the declared base ref (development args), the field
 *     whose drift is the loudest: the ref moves on its own between two attempts;
 *   - `surface_image` — `<dir>/worker-image` plus `docker image inspect` / a version probe
 *     (`imageIdentity`), which feeds BOTH `material.surface_image` and `worker_profile_digest`;
 *   - `temporal_namespace_id` — the `temporal` CLI, which feeds `material.continuation_target` AND
 *     the request's `target_ref.target_id`.
 * Everything else in the material is argument-derived (`bounds`, the provider selections,
 * `work_item`, the payload count), code-derived (`base_ref`, `tenant`, `workflow_type`,
 * `task_queue`, `workerProfileDigest()` over the provider registry), or origin-derived
 * (`workflow_id` from the allocated `effect_id`, the record vertical's `resource_prefix` from the
 * `origin_key`) — and every one of those is reproduced by re-running the same code over the same
 * arguments.
 *
 * A NEW environment-derived material field that does not join this record is exactly the drift the
 * invariant forbids: it would be re-read on retry and re-seal the converged `effect_id` with
 * different bytes. Adding one means adding it to `ORIGIN_MATERIAL_INPUT_KEYS` below (whose
 * validation is exact, so an old record then fails closed and names its own file) — never a
 * per-field fallback that quietly re-reads the environment.
 */
const ORIGIN_MATERIAL_INPUT_KEYS: Record<"development" | "record", readonly string[]> = {
  development: ["repo_id", "repo_full_name", "base_sha", "surface_image", "temporal_namespace_id"],
  record: ["surface_image", "temporal_namespace_id"],
};

/** Bumped when the record's key set changes; an unknown version fails closed rather than guessing. */
const ORIGIN_RECORD_VERSION = 1;

const ORIGIN_RECORD_KEYS: readonly string[] = [
  "record_version", "origin_key", "vertical", "work_item_digest", "material_inputs", "created_at",
];

export interface OriginMaterialInputs {
  readonly repo_id?: string;
  readonly repo_full_name?: string;
  readonly base_sha?: string;
  readonly surface_image: SurfaceImageIdentity;
  readonly temporal_namespace_id: string;
}

export interface OriginRecord {
  readonly record_version: number;
  readonly origin_key: string;
  readonly vertical: "development" | "record";
  /** The ARGUMENT identity of this origin — verified against a presented start, never adopted. */
  readonly work_item_digest: string;
  readonly material_inputs: OriginMaterialInputs;
  /** Record metadata for an operator reading the directory; it enters no sealed material. */
  readonly created_at: string;
}

/**
 * ONE FILE PER ORIGIN, named by `sha256Hex(origin_key)`: no shared file, no lock, no TTL, no
 * reclamation — a reclaimer that mistakes a live origin for a stale one destroys the very pin the
 * record exists to be. The name is a digest rather than the key itself so a caller-supplied key
 * needs no filesystem-safety rules (the key is kept verbatim INSIDE the record and re-verified on
 * every adoption, so a hand-edited or colliding file is caught rather than adopted).
 */
export function originRecordPath(dir: string, origin_key: string): string {
  return join(dir, "origin-keys", `${sha256Hex(origin_key)}.json`);
}

function originRecordInvalid(path: string, detail: string): Error {
  return new Error(
    `origin record ${path} is unusable (${detail}) — refusing to guess the pinned material; ` +
    "delete or repair the file deliberately, or start a NEW origin with a new origin_key",
  );
}

/**
 * COMPLETE OR REFUSED. An adopted record is validated against EXACTLY the enumerated keys, and an
 * unparseable, incomplete, extra-keyed or unknown-version record throws — naming its own file —
 * before any kernel call. There is deliberately no per-field environment fallback: falling back is
 * how a partially pinned origin re-reads a moved ref and re-seals its `effect_id` with new bytes.
 *
 * The pairing that makes fail-closed safe rather than merely strict: the record is written ONLY as
 * one complete object and ONLY after every environment resolution succeeded, so RECORD-EXISTS
 * implies RESOLUTION-COMPLETED implies MATERIAL-FULLY-PINNED, and NO-RECORD implies nothing
 * happened yet — a resolution failure writes nothing and no kernel call was made either, so the
 * clean retry re-resolves everything from scratch, which is correct.
 */
function parseOriginRecord(path: string): OriginRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw originRecordInvalid(path, `unparseable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw originRecordInvalid(path, "not a JSON object");
  const record = parsed as Record<string, unknown>;
  if (record["record_version"] !== ORIGIN_RECORD_VERSION) throw originRecordInvalid(path, `unknown record_version ${JSON.stringify(record["record_version"])}`);
  const vertical = record["vertical"];
  if (vertical !== "development" && vertical !== "record") throw originRecordInvalid(path, `unknown vertical ${JSON.stringify(vertical)}`);
  for (const key of ORIGIN_RECORD_KEYS) {
    if (record[key] === undefined) throw originRecordInvalid(path, `missing ${key}`);
  }
  for (const key of Object.keys(record)) {
    if (!ORIGIN_RECORD_KEYS.includes(key)) throw originRecordInvalid(path, `unknown key ${key}`);
  }
  for (const key of ["origin_key", "work_item_digest", "created_at"]) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) throw originRecordInvalid(path, `${key} must be a nonempty string`);
  }
  const inputs = record["material_inputs"];
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) throw originRecordInvalid(path, "material_inputs must be a JSON object");
  const declared = ORIGIN_MATERIAL_INPUT_KEYS[vertical];
  const given = inputs as Record<string, unknown>;
  for (const key of declared) {
    if (given[key] === undefined) throw originRecordInvalid(path, `material_inputs.${key} is missing`);
  }
  for (const key of Object.keys(given)) {
    if (!declared.includes(key)) throw originRecordInvalid(path, `material_inputs has no field ${key} for the ${vertical} vertical`);
  }
  for (const key of declared) {
    if (key === "surface_image") continue;
    if (typeof given[key] !== "string" || (given[key] as string).length === 0) throw originRecordInvalid(path, `material_inputs.${key} must be a nonempty string`);
  }
  return {
    record_version: ORIGIN_RECORD_VERSION,
    origin_key: record["origin_key"] as string,
    vertical,
    work_item_digest: record["work_item_digest"] as string,
    // NORMALISED into the key order the sealed material uses, so the material's bytes depend on the
    // record's VALUES and never on the order some writer happened to serialise them in.
    material_inputs: {
      ...(vertical === "development"
        ? { repo_id: given["repo_id"] as string, repo_full_name: given["repo_full_name"] as string, base_sha: given["base_sha"] as string }
        : {}),
      surface_image: parseSurfaceImage(given["surface_image"], path),
      temporal_namespace_id: given["temporal_namespace_id"] as string,
    },
    created_at: record["created_at"] as string,
  };
}

function parseSurfaceImage(value: unknown, path: string): SurfaceImageIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw originRecordInvalid(path, "material_inputs.surface_image must be a JSON object");
  const given = value as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!["image", "image_digest", "tool_versions"].includes(key)) throw originRecordInvalid(path, `material_inputs.surface_image has no field ${key}`);
  }
  const { image, image_digest, tool_versions } = given;
  if (typeof image !== "string" || image.length === 0) throw originRecordInvalid(path, "material_inputs.surface_image.image must be a nonempty string");
  if (typeof image_digest !== "string" || image_digest.length === 0) throw originRecordInvalid(path, "material_inputs.surface_image.image_digest must be a nonempty string");
  if (typeof tool_versions !== "object" || tool_versions === null || Array.isArray(tool_versions)) throw originRecordInvalid(path, "material_inputs.surface_image.tool_versions must be a JSON object");
  const versions: Record<string, string> = {};
  for (const [key, entry] of Object.entries(tool_versions as Record<string, unknown>)) {
    if (typeof entry !== "string") throw originRecordInvalid(path, `material_inputs.surface_image.tool_versions.${key} must be a string`);
    versions[key] = entry;
  }
  return { image, image_digest, tool_versions: versions };
}

/**
 * ARGUMENT-DERIVED fields are VERIFIED against an adopted record; ENVIRONMENT-derived ones are
 * ADOPTED from it. One `origin_key` names ONE logical origin with ONE argument set, so re-using a
 * key with different arguments is a caller contract violation — never a silent adoption that would
 * carry the presented arguments' `work_item` into the recorded origin's identity, or the recorded
 * base into the presented work. It throws BEFORE any kernel call, on the read path and on the
 * write-race path alike (both go through here).
 */
function assertOriginArguments(record: OriginRecord, path: string, origin_key: string, vertical: string, work_item_digest: string): void {
  if (record.origin_key !== origin_key) {
    throw originRecordInvalid(path, `records origin_key ${record.origin_key}, not the presented ${origin_key}`);
  }
  if (record.vertical !== vertical || record.work_item_digest !== work_item_digest) {
    throw new Error(
      `origin_key ${origin_key} was created for a DIFFERENT work item ` +
      `(recorded ${record.vertical}/${record.work_item_digest}, presented ${vertical}/${work_item_digest}) — ` +
      `one origin_key identifies one logical origin with one argument set; use a new origin_key for different arguments (${path})`,
    );
  }
}

/**
 * Read-or-create, first-writer-wins, no lock. The write is `linkSync` of a fully written temp file
 * rather than `renameSync`: rename OVERWRITES, so two racers that both saw no file would both
 * rename and the loser's record would silently replace the winner's — the very loss a lock-free
 * scheme must not have. `link` fails `EEXIST` instead, so the racer READS BACK the winner's record
 * and adopts its material (a record is not content-deterministic — two racers may resolve different
 * base shas — so converging on the winner is what keeps one origin on one set of bytes).
 */
function commitOriginRecord(path: string, record: OriginRecord, vertical: string, work_item_digest: string): OriginRecord {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    try {
      linkSync(tmp, path);
      return record;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  const winner = parseOriginRecord(path);
  assertOriginArguments(winner, path, record.origin_key, vertical, work_item_digest);
  return winner;
}

/**
 * The ONE place the v0.5 path touches the environment for material: an existing record is adopted
 * verbatim (`resolve` is never called — which is why a moved ref, a rebuilt image or an absent
 * manifest cannot move an origin's bytes), and only a first-time origin resolves, and then records
 * BEFORE the first kernel call so a crashed process leaves a recoverable pin.
 */
function openOriginRecord(params: {
  dir: string;
  origin_key: string;
  vertical: "development" | "record";
  work_item_digest: string;
  resolve: () => OriginMaterialInputs;
}): OriginRecord {
  const path = originRecordPath(params.dir, params.origin_key);
  if (existsSync(path)) {
    const existing = parseOriginRecord(path);
    assertOriginArguments(existing, path, params.origin_key, params.vertical, params.work_item_digest);
    return existing;
  }
  const record: OriginRecord = {
    record_version: ORIGIN_RECORD_VERSION,
    origin_key: params.origin_key,
    vertical: params.vertical,
    work_item_digest: params.work_item_digest,
    material_inputs: params.resolve(),
    created_at: new Date().toISOString(),
  };
  return commitOriginRecord(path, record, params.vertical, params.work_item_digest);
}

/**
 * The `origin_key` of one `workPlan` item: the stable pair already present at origin creation —
 * the sealed proposal's `evidence_id` and the item's index — under a canonical digest, so the same
 * pair always derives the same key and two different pairs never share one. DERIVED, not minted,
 * and therefore needing no file record of its own to survive a crash: re-running `workPlan` over
 * the same proposal re-derives the identical key from the identical inputs (the origin RECORD is
 * still consulted for the MATERIAL, which is what pins a moved base ref for derived keys too).
 *
 * This digests the origin's COORDINATES, never the work's content (WP §3.6): two proposals
 * proposing byte-identical work are two origins and get two keys, so they can never collide on one
 * `effect_id`.
 */
export function planItemOriginKey(proposal_evidence_id: string, index: number): string {
  return `plan-item:${jcsDigest({ schema: "cadp.origin-key.plan-item.v1", proposal_evidence_id, index }).value}`;
}

/**
 * The record vertical's `resource_prefix`, a pure function of the origin's stable key — replacing
 * `live-${Date.now() % 100000}`, which is sealed material derived from the wall clock and therefore
 * different on every attempt at one origin (WP §3.6 names it as the checked-out instance to remove).
 */
export function originResourcePrefix(origin_key: string): string {
  return `live-${jcsDigest({ schema: "cadp.origin-resource-prefix.v1", origin_key }).value.slice(0, 12)}`;
}

// ================================================================= one governed WORK_START

/** The provider/bounds selection every start validates at entry, in the order it always has. */
function startSelection(vertical: "development" | "record", extra: string[]): {
  workerProduct: ReturnType<typeof resolveWorkerProvider>;
  reviewProduct: ReturnType<typeof resolveReviewProvider>;
  externalVerification: boolean;
} {
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
 * The ARGUMENT identity of one origin: every argument-derived input that reaches the sealed request,
 * canonically digested. Two invocations agreeing here seal identical material given one record;
 * disagreeing, they are two different logical origins and must not share an `origin_key`.
 *
 * It is deliberately the SEMANTIC argument set, not the raw `extra` array, so a retry spelling the
 * same start with an omitted trailing `""` is the same origin rather than a spurious violation. It
 * is a RECORD guard only: it never enters the allocation tuple, which identifies the origin and
 * not its content (WP §3.6).
 */
function startArgumentDigest(
  vertical: "development" | "record",
  extra: string[],
  selection: ReturnType<typeof startSelection>,
): string {
  return jcsDigest(
    vertical === "development"
      ? {
          schema: "cadp.origin-arguments.v1",
          vertical,
          work_item: extra[0] ?? "",
          max_steps: boundArg(extra[1], 8),
          max_effects: boundArg(extra[2], 6),
          proposal_evidence_id: extra[3] ?? "",
          worker_product: selection.workerProduct,
          review_product: selection.reviewProduct,
          external_verification: selection.externalVerification,
        }
      : {
          schema: "cadp.origin-arguments.v1",
          vertical,
          payload_count: boundArg(extra[0], 2),
          max_steps: boundArg(extra[1], 6),
          max_effects: boundArg(extra[2], 4),
        },
  ).value;
}

/** The development args, in the exact key order whose `JSON.stringify` bytes are the CAS blob. */
function developmentArgs(
  extra: string[],
  selection: ReturnType<typeof startSelection>,
  env: { repo_id: string; repo_full_name: string; base_sha: string },
): Record<string, unknown> {
  return {
    vertical: "development",
    bounds: { max_steps: boundArg(extra[1], 8), max_effects: boundArg(extra[2], 6) },
    development: {
      repo_id: env.repo_id,
      repo_full_name: env.repo_full_name,
      base_ref: DEV_BASE_REF,
      base_sha: env.base_sha,
      work_item: extra[0]!,
      worker_product: selection.workerProduct,
      review_product: selection.reviewProduct,
      external_verification: selection.externalVerification,
      require_human_merge: true,
    },
  };
}

/** The record args, same rule: the key order IS the blob. */
function recordArgs(extra: string[], resource_prefix: string): Record<string, unknown> {
  return {
    vertical: "record",
    bounds: { max_steps: boundArg(extra[1], 6), max_effects: boundArg(extra[2], 4) },
    record: {
      tenant: "cadp-disposable",
      resource_prefix,
      payloads: Array.from({ length: boundArg(extra[0], 2) }, (_, i) => `live payload ${i + 1}`),
    },
  };
}

/**
 * allocate → CAS → seal → assemble → evaluate → admit: the tail both profiles share, differing in
 * exactly two ways, both of them the v0.5 origin contract (AP B5(9), B6(1)):
 *   - `origin` seals the allocated `effect_id` as its OWN `work-run` binding on the declared kernel
 *     pair — the self-binding that makes this request `is_run_origin` and writes the durable
 *     `run_membership(E, E)` witness — and carries the allocation tuple as the seal's transport
 *     sibling;
 *   - `image` is a THUNK so v0.4 keeps reading `<dir>/worker-image` exactly where it always did
 *     (after the allocation), while v0.5 hands back the identity its origin record pinned.
 */
async function sealWorkStart(params: {
  c: WorkStartKernelClient;
  log: Log;
  vertical: "development" | "record";
  extra: string[];
  args: Record<string, unknown>;
  namespaceId: string;
  tuple: AllocationTuple;
  origin: boolean;
  image: () => SurfaceImageIdentity;
}): Promise<{ effect_id: string; workflow_id: string } | undefined> {
  const { c, log, vertical, extra, args, namespaceId } = params;
  const { effect_id } = await c.allocateEffectId(params.tuple);
  const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
  // TD §11 version exactness: bind the immutable built-image digest + observed tool versions
  // into the WORK_START worker profile, so the reviewed/live composition names the exact image.
  const image = params.image();
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
    bounds: args["bounds"],
    worker_profile_digest,
    surface_image: image,
    continuation_target: `temporal:cadp-v04:${namespaceId}`,
  };
  const { cas_key: material_ref } = await c.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const body: SealRequestBody = {
    effect_id,
    requester_ref: "workflow:cadp-work",
    work_bindings: [
      { authority_ref: "github.com", namespace: "work-item", object_id: vertical === "development" ? `dev:${extra[0]}` : `record:${extra[0]}` },
      // Optional exact provenance: the WORK_PROPOSAL this item came from. A binding, never authority.
      ...(vertical === "development" && extra[3] !== undefined && extra[3] !== ""
        ? [{ authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: extra[3] }]
        : []),
      // AP B5(9) leg 3: EXACTLY ONE binding on the declared work-run pair, naming this request's
      // own `effect_id`. Allocation precedes sealing, so the Platform-issued identity is already in
      // hand — which is why the origin tuple can carry no `work_run_ref` of its own (AP B1(5)).
      ...(params.origin ? [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: effect_id }] : []),
    ],
    target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: namespaceId },
    operation_kind: "WORK_START",
    material_schema: "cadp.work-start.v1",
    material_ref,
    prior_effect_refs: [],
    // AP B6(1): transport, never a draft field. A re-seal may repeat it; repeating it identically
    // is what an idempotent retry of one origin does.
    ...(params.origin ? { allocation_tuple: params.tuple } : {}),
  };
  const request = await c.sealEffectRequest(body);
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

/** One governed WORK_START through the ordinary admission chain. `undefined` = refused, honestly logged. */
export async function startWork(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: StartWorkOptions = {},
): Promise<StartWorkResult | undefined> {
  return (options.originProfile ?? "v04") === "v05"
    ? startWorkV05(dir, vertical, extra, options)
    : startWorkV04(dir, vertical, extra, options);
}

/**
 * THE v0.4 PATH, unchanged in every observable: the same reads in the same order, the same
 * zero-sentinel `cadp.allocation-key.v1` tuple with its wall-clock `step_ordinal`, the same
 * freshly-resolved `base_sha`, the same wall-clock `resource_prefix`, no work-run binding, no
 * allocation tuple on the seal and no origin record read or written. The v0.5 migration is
 * CONDITIONAL: a v1 deployment accepts no other allocation schema, so this branch is not a legacy
 * fallback but the correct path for the live v0.4 composition, and it stays byte-identical.
 */
async function startWorkV04(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: StartWorkOptions,
): Promise<StartWorkResult | undefined> {
  const log = options.log ?? SILENT;
  const deps = options.dependencies ?? {};
  const m = deps.manifest ?? loadManifest(dir);
  const c = deps.client ?? liveClient(dir, "cadp-workflow");
  const namespaceId = deps.namespaceId ?? temporalNamespaceId(m);

  const selection = startSelection(vertical, extra);
  const args =
    vertical === "development"
      ? developmentArgs(extra, selection, {
          repo_id: m.repo_id,
          repo_full_name: m.repo_full_name,
          // Resolved fresh at seal time — the manifest's setup-time snapshot goes stale (see
          // resolveBaseSha). The sealed sha stays deterministic for the run's whole lifetime.
          base_sha: (deps.resolveBase ?? resolveBaseSha)(m.repo_full_name, DEV_BASE_REF),
        })
      : recordArgs(extra, `live-${Date.now() % 100000}`);

  const ordinal = options.ordinalArg !== undefined ? Number(options.ordinalArg) : Math.floor(Date.now() / 1000) % 1000000;
  return sealWorkStart({
    c, log, vertical, extra, args, namespaceId,
    tuple: { schema: "cadp.allocation-key.v1", work_run_ref: ZERO_WORK_RUN_REF, step_ordinal: ordinal, purpose: "work-start" },
    origin: false,
    image: () => (deps.surfaceImage ?? liveSurfaceImage)(dir),
  });
}

/** `<dir>/worker-image` plus the built image's identity — the live environment read v0.5 pins. */
function liveSurfaceImage(dir: string): SurfaceImageIdentity {
  return imageIdentity(readFileSync(join(dir, "worker-image"), "utf8").trim());
}

/**
 * THE v0.5 RUN-ORIGIN PATH (WP §3.6; AP B1(5), B5(9), controls A4/A5).
 *
 * The order below is the contract, not a convenience:
 *  1. VALIDATE the arguments — a malformed start refuses before an `origin_key` exists at all;
 *  2. DECIDE the `origin_key` once: the caller's (a `workPlan` derivation, or a retry recovering a
 *     recorded key) or ONE `crypto.randomUUID`;
 *  3. EMIT a minted key through the log immediately, so it is visible before anything can fail;
 *  4. CONSULT THE ORIGIN RECORD FIRST — before the manifest, before the client, before any kernel
 *     call. A record that exists is adopted and the material is reconstructed EXCLUSIVELY from
 *     {record, arguments, origin_key}: a moved base ref, a rebuilt worker image or a missing or
 *     malformed `manifest.json` cannot move this origin's bytes, and recovery cannot be blocked by
 *     them. (`liveClient` still reads the manifest for the API url and token — those are
 *     OPERATIONAL CONNECTION details, not material; a broken manifest therefore fails at the
 *     connection, never at material reconstruction. A caller that injects a client reconstructs and
 *     seals with no manifest at all.) A first-time origin resolves the environment ONCE and records
 *     it BEFORE the first kernel call, so a crash leaves a recoverable pin;
 *  5. seal the origin: allocate under `run-origin.v1`, self-bind the allocated `effect_id`.
 *
 * Every failure from step 2 onwards carries the `origin_key` in its message and in an `origin_key`
 * property, and the success returns it — the WP contract requires ONE key per logical origin
 * preserved VERBATIM across retries, so a minted key that a failure swallowed would fork the run
 * into a second origin on the next attempt.
 *
 * THE RECOVERY FLOW, for the operator and for `auto-dev`: read the minted key from the log line or
 * from the thrown error (or, after a crash that logged nothing, from `<dir>/origin-keys/*.json` —
 * one file per origin, each carrying its own `origin_key` and the material it pinned), then
 * re-invoke this same start with `options.originKey` set to it. It converges on the same
 * `effect_id`, rebuilds byte-identical material from the record, and the re-seal is an idempotent
 * no-op rather than a `REQUEST_DIGEST_CONFLICT`.
 */
async function startWorkV05(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: StartWorkOptions,
): Promise<StartWorkResult | undefined> {
  const log = options.log ?? SILENT;
  const deps = options.dependencies ?? {};
  // The origin path has NO step ordinal — the tuple is exactly `{schema, origin_key, purpose}`, and
  // the wall-clock fallback that stood in for one is gone. A caller still presenting an ordinal is
  // asking for a discriminator this path does not have; refusing says so, where ignoring it would
  // read as "the ordinal still separates two starts" and quietly collide them on one origin.
  if (options.ordinalArg !== undefined) {
    throw new Error(`step_ordinal (${options.ordinalArg}) has no meaning on the v0.5 run-origin path — origin_key is the only discriminator`);
  }
  const selection = startSelection(vertical, extra);
  const work_item_digest = startArgumentDigest(vertical, extra, selection);
  const mint = deps.newOriginKey ?? ((): string => randomUUID());
  const origin_key = options.originKey ?? mint();
  const path = originRecordPath(dir, origin_key);
  if (options.originKey === undefined) {
    log({ origin_profile: "v05", origin_key, minted: true, origin_record: path, recover_with: "startWork(..., { originKey })" });
  }
  try {
    const record = openOriginRecord({
      dir, origin_key, vertical, work_item_digest,
      resolve: (): OriginMaterialInputs => {
        // FIRST-TIME ONLY: every environment read of this origin, performed exactly once and then
        // pinned. Nothing here runs again for this origin_key, on any later attempt.
        const m = deps.manifest ?? loadManifest(dir);
        return {
          ...(vertical === "development"
            ? {
                repo_id: m.repo_id,
                repo_full_name: m.repo_full_name,
                base_sha: (deps.resolveBase ?? resolveBaseSha)(m.repo_full_name, DEV_BASE_REF),
              }
            : {}),
          surface_image: (deps.surfaceImage ?? liveSurfaceImage)(dir),
          temporal_namespace_id: deps.namespaceId ?? temporalNamespaceId(m),
        };
      },
    });
    const inputs = record.material_inputs;
    const args =
      vertical === "development"
        ? developmentArgs(extra, selection, {
            repo_id: inputs.repo_id!,
            repo_full_name: inputs.repo_full_name!,
            base_sha: inputs.base_sha!,
          })
        : recordArgs(extra, originResourcePrefix(origin_key));
    const c = deps.client ?? liveClient(dir, "cadp-workflow");
    const started = await sealWorkStart({
      c, log, vertical, extra, args,
      namespaceId: inputs.temporal_namespace_id,
      tuple: { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key, purpose: "work-start" },
      origin: true,
      image: () => inputs.surface_image,
    });
    return started === undefined ? undefined : { ...started, origin_key };
  } catch (error) {
    throw withOriginContext(error, origin_key, path);
  }
}

/**
 * Every v0.5 failure names its origin. The caught error is DECORATED rather than replaced, so an
 * `IngressRejection`'s reason code and a `KernelApiError`'s status survive for the caller that
 * grades on them, and the key a retry must present survives for the operator.
 */
function withOriginContext(error: unknown, origin_key: string, path: string): unknown {
  const decorated = error instanceof Error ? error : new Error(String(error));
  (decorated as { origin_key?: string }).origin_key = origin_key;
  if (!decorated.message.includes(origin_key)) {
    decorated.message = `${decorated.message} [origin_key=${origin_key}; recorded at ${path} — retry with this key to converge on the same effect_id]`;
  }
  return decorated;
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

export interface WorkPlanOptions {
  /** Threaded verbatim into every item's start; `"v04"` (the default) keeps the live path as it is. */
  originProfile?: OriginProfile;
  dependencies?: {
    loadProposal?: (dir: string, proposalEvidenceId: string) => Promise<WorkProposalV1>;
    startWork?: typeof startWork;
  };
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
  const profile = options.originProfile ?? "v04";
  const proposal = await (deps.loadProposal ?? loadProposal)(dir, proposalEvidenceId);
  const maxItems = boundArg(maxItemsArg, proposal.items.length);
  const results: Array<Record<string, unknown>> = [];
  for (const [index, item] of proposal.items.slice(0, maxItems).entries()) {
    log({ driver: "starting", index, work_item: item.work_item, bounds: { max_steps: item.max_steps, max_effects: item.max_effects } });
    // The origin key of item i is DERIVED from the pair that already identifies it — this proposal
    // and this index — so it is decided once per logical origin and re-derived identically on every
    // retry of the plan, with no minting and no file record needed to remember it. Inert under
    // "v04", which has no origin key at all.
    const started = await (deps.startWork ?? startWork)(
      dir,
      "development",
      [item.work_item, String(item.max_steps), String(item.max_effects), proposalEvidenceId],
      { log, originProfile: profile, ...(profile === "v05" ? { originKey: planItemOriginKey(proposalEvidenceId, index) } : {}) },
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
