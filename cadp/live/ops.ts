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

// ==================================================================== v0.5 run origins (AP TD A4/A5, B5)

/**
 * WHICH ALLOCATION CONTRACT a start allocates its `WORK_START` effect identity under.
 *
 * `"v04"` is the DEFAULT and is what this composition has run since v0.4: the
 * `cadp.allocation-key.v1` zero-sentinel tuple with a wall-clock `step_ordinal`, no work-run
 * binding, and — on the record vertical — a wall-clock `resource_prefix`. That branch is untouched
 * here, byte for byte, and NOTHING in this section is reached on it: no origin key is minted, no
 * `origin-keys/` file is read or written, and no material input is pinned. The live v0.4
 * deployment exercises exactly this branch.
 *
 * `"v05"` is AP TD B5's RUN ORIGIN: allocation under `cadp.allocation-key.run-origin.v1` keyed by a
 * stable `origin_key`, exactly one self-referential work-run binding, and material fixed once at
 * origin creation. The v0.5 genesis composition passes `originProfile: "v05"`.
 *
 * WHY AN EXPLICIT OPTION rather than a read of the deployment's ACTIVE kernel config: the only
 * config ops.ts can read is `<dir>/kernel-config.json`, which is the GENESIS bundle's config and
 * not the active one — a `POLICY_ACTIVATE` supersedes it and the Kernel API exposes no read of the
 * active bundle — so gating a byte-identity-critical branch on it would be a guess about a file
 * that may already be superseded. The composition that stands the deployment up knows its
 * generation; the default is the current v0.4 behaviour for everyone who does not say.
 */
export type OriginProfile = "v04" | "v05";

/** AP B3(4)(a): the authority side of the DECLARED work-run `(authority_ref, namespace)` pair. */
const WORK_RUN_AUTHORITY = "cadp-store:k04";

export const ORIGIN_RECORD_VERSION = 1;

/** The environment-resolved material inputs an origin pins. See the audit on `openOrigin`. */
export interface OriginMaterialInputs {
  readonly namespace_id: string;
  readonly surface_image: { image: string; image_digest: string; tool_versions: Record<string, string> };
  readonly worker_profile_digest: string;
  /** Development vertical only — the record vertical's args name no repository and no base. */
  readonly base_sha?: string;
  readonly repo_id?: string;
  readonly repo_full_name?: string;
}

export interface OriginRecord {
  readonly record_version: number;
  readonly origin_key: string;
  readonly vertical: "development" | "record";
  /** The ARGUMENT identity of this origin — verified against, never adopted from, the record. */
  readonly work_item_digest: string;
  readonly material_inputs: OriginMaterialInputs;
  readonly created_at: string;
}

/**
 * The audit's ENVIRONMENT-DERIVED key set, per vertical, checked for EXACT equality on every read
 * (see `openOrigin`). A field added to the material must consciously join this list, and doing so
 * makes every pre-existing record fail closed rather than half-pin the origin it names.
 */
const MATERIAL_INPUT_KEYS: Record<"development" | "record", readonly string[]> = {
  development: ["base_sha", "namespace_id", "repo_full_name", "repo_id", "surface_image", "worker_profile_digest"],
  record: ["namespace_id", "surface_image", "worker_profile_digest"],
};

const ORIGIN_RECORD_KEYS: readonly string[] = [
  "created_at", "material_inputs", "origin_key", "record_version", "vertical", "work_item_digest",
];

const SURFACE_IMAGE_KEYS: readonly string[] = ["image", "image_digest", "tool_versions"];

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
}

export function originRecordDir(dir: string): string {
  return join(dir, "origin-keys");
}

/**
 * ONE FILE PER ORIGIN, named by `sha256Hex(origin_key)` — never by the key itself. A caller-passed
 * key is caller data, and hashing is what keeps it structurally incapable of becoming a path
 * component (`../…` cannot escape the deployment directory). The key is kept INSIDE the record, so
 * the documented recovery flow needs nothing the filename would have carried.
 */
export function originRecordPath(dir: string, origin_key: string): string {
  return join(originRecordDir(dir), `${sha256Hex(origin_key)}.json`);
}

/**
 * The ARGUMENT identity of one start: everything the caller passed, and nothing the environment
 * resolved. It is what an adopted record is VERIFIED against — one `origin_key` is ONE logical
 * origin with ONE argument set.
 */
export function workItemDigest(vertical: "development" | "record", extra: readonly (string | undefined)[]): string {
  return jcsDigest({
    schema: "cadp.live.work-origin-arguments.v1",
    vertical,
    extra: Array.from(extra, (value) => value ?? null),
  }).value;
}

/**
 * A proposal item's stable `origin_key`: a pure function of `(proposal_evidence_id, item_index)`.
 * Because it is DERIVED, it needs no file record to be recoverable — re-running the same plan item
 * re-derives the identical key with nothing read back from disk. (The origin record such a start
 * writes is for MATERIAL pinning, which every v0.5 origin needs, not for key recovery, which only
 * a MINTED key needs.)
 */
export function planItemOriginKey(proposal_evidence_id: string, item_index: number): string {
  return jcsDigest({ schema: "cadp.live.work-origin.v1", proposal_evidence_id, item_index }).value;
}

/** The record vertical's resource prefix on the origin path: a deterministic function of the key. */
export function originResourcePrefix(origin_key: string): string {
  return `live-${jcsDigest({ schema: "cadp.live.record-resource-prefix.v1", origin_key }).value.slice(0, 12)}`;
}

/**
 * RECORD COMPLETENESS, fail-closed: an adopted record is either COMPLETE or the start REFUSES.
 * There is no per-field environment fallback — a record missing a field is not a record to be
 * topped up from a second reading of the world, it is a file the operator repairs or deletes
 * deliberately. Unparseable, of an unknown `record_version`, or carrying anything other than
 * EXACTLY the enumerated keys (top level and `material_inputs` alike) ⇒ throw, naming the path,
 * before any kernel call.
 *
 * The write path guarantees the positive case by construction: the record is only ever written as
 * ONE complete object AFTER all environment resolution succeeded. So RECORD-EXISTS implies
 * RESOLUTION-COMPLETED implies MATERIAL FULLY PINNED, and NO-RECORD implies nothing happened yet —
 * a resolution failure writes nothing and no kernel call was made either, so the clean retry
 * re-resolves everything from scratch, which is the correct behaviour rather than a lost origin.
 */
function parseOriginRecord(path: string, text: string): OriginRecord {
  const refuse = (detail: string): never => {
    throw new Error(`origin record ${path} ${detail} — repair or delete it deliberately; this start refuses rather than re-reading the environment`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return refuse(`is unparseable (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refuse("is not a JSON object");
  const record = parsed as Record<string, unknown>;
  if (record["record_version"] !== ORIGIN_RECORD_VERSION) {
    return refuse(`has record_version ${JSON.stringify(record["record_version"])}, and this build writes ${ORIGIN_RECORD_VERSION}`);
  }
  if (!hasExactKeys(record, ORIGIN_RECORD_KEYS)) return refuse(`does not carry exactly ${ORIGIN_RECORD_KEYS.join(", ")}`);
  const vertical = record["vertical"];
  if (vertical !== "development" && vertical !== "record") return refuse(`names an unknown vertical ${JSON.stringify(vertical)}`);
  for (const field of ["origin_key", "work_item_digest", "created_at"]) {
    if (typeof record[field] !== "string" || record[field] === "") return refuse(`has a missing or non-string ${field}`);
  }
  const inputs = record["material_inputs"];
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) return refuse("has a non-object material_inputs");
  const material = inputs as Record<string, unknown>;
  if (!hasExactKeys(material, MATERIAL_INPUT_KEYS[vertical])) {
    return refuse(`material_inputs does not carry exactly ${MATERIAL_INPUT_KEYS[vertical].join(", ")} for the ${vertical} vertical`);
  }
  for (const [field, value] of Object.entries(material)) {
    if (field === "surface_image") {
      if (typeof value !== "object" || value === null || Array.isArray(value) || !hasExactKeys(value as Record<string, unknown>, SURFACE_IMAGE_KEYS)) {
        return refuse(`material_inputs.surface_image does not carry exactly ${SURFACE_IMAGE_KEYS.join(", ")}`);
      }
    } else if (typeof value !== "string" || value === "") {
      return refuse(`material_inputs.${field} is missing or not a non-empty string`);
    }
  }
  return record as unknown as OriginRecord;
}

function readOriginRecord(dir: string, origin_key: string): OriginRecord | undefined {
  const path = originRecordPath(dir, origin_key);
  if (!existsSync(path)) return undefined;
  return parseOriginRecord(path, readFileSync(path, "utf8"));
}

/**
 * FIRST-WRITER-WINS with NO shared file, NO lock, NO TTL and NO reclamation. One file per origin,
 * written to a tmp name in the same directory and published atomically.
 *
 * A record is IMMUTABLE once written but is NOT content-deterministic — two concurrent starts under
 * one key may resolve different `base_sha` values — so the publish must never overwrite: the racer
 * that loses reads the winner's record back and ADOPTS its material, which is what makes concurrent
 * same-key starts converge on one effect_id and one sealed material with no lock at all. The
 * publish is therefore `linkSync` (atomic, and `EEXIST` when a winner is already there) rather than
 * `renameSync`, which would silently clobber the winner and lose the material the loser must adopt.
 * A stale-lock reclamation is exactly what this design avoids: there is no lock to steal.
 */
function publishOriginRecord(dir: string, record: OriginRecord): { record: OriginRecord; adopted: boolean } {
  const path = originRecordPath(dir, record.origin_key);
  mkdirSync(originRecordDir(dir), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  try {
    linkSync(tmp, path);
    return { record, adopted: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { record: parseOriginRecord(path, readFileSync(path, "utf8")), adopted: true };
  } finally {
    unlinkSync(tmp);
  }
}

/**
 * THE ADOPTION GUARD, applied on BOTH paths an existing record is adopted through (the read path
 * and the write-race path) and BEFORE any kernel call. Environment-derived fields are ADOPTED from
 * the record; ARGUMENT-derived fields are VERIFIED against it. One `origin_key` identifies ONE
 * logical origin with ONE argument set — reusing a key with different arguments is a caller
 * contract violation, and adopting it silently would carry the recorded material into a start whose
 * arguments describe a different piece of work.
 */
function assertOriginArguments(
  record: OriginRecord,
  presented: { origin_key: string; vertical: string; work_item_digest: string },
  path: string,
): void {
  if (
    record.origin_key === presented.origin_key &&
    record.vertical === presented.vertical &&
    record.work_item_digest === presented.work_item_digest
  ) return;
  throw new Error(
    `origin_key ${presented.origin_key} already identifies a different logical origin: ${path} records ` +
      `origin_key ${record.origin_key} / vertical ${record.vertical} / work_item_digest ${record.work_item_digest}, ` +
      `this start presents vertical ${presented.vertical} / work_item_digest ${presented.work_item_digest}. ` +
      "One origin_key is ONE logical origin with ONE argument set.",
  );
}

/** The composed WORK_START worker-profile digest — the static profile bound to the built image. */
function workerProfileDigestFor(image: OriginMaterialInputs["surface_image"]): string {
  return jcsDigest({
    profile: workerProfileDigest(),
    surface_image: image.image,
    image_digest: image.image_digest,
    tool_versions: image.tool_versions,
  }).value;
}

interface OriginEnvironment {
  manifest: LiveEnvManifest;
  namespaceId: (m: LiveEnvManifest) => string;
  workerImage: () => OriginMaterialInputs["surface_image"];
  resolveBase: (repo_full_name: string, base_ref: string) => string;
  now: () => string;
  log: Log;
}

/**
 * OPEN THE ORIGIN — the one place a v0.5 start touches the environment, and the whole of the
 * material-pinning invariant.
 *
 * THE INVARIANT. On the v0.5 origin path EVERY sealed-material field that is resolved from the
 * ENVIRONMENT at start time — anything read from the network, a file, the manifest or a tool, as
 * opposed to derived purely from the function arguments and the `origin_key` — is resolved EXACTLY
 * ONCE, at origin creation, and persisted in this record. A retry that finds a record reconstructs
 * the material EXCLUSIVELY from {the record + the function arguments + the origin_key} and
 * recomputes NOTHING from the environment. One logical origin is therefore one effect_id AND one
 * byte-identical sealed material even when the base ref moved, the worker image was rebuilt or the
 * Temporal namespace was recreated between the attempts — which is what keeps a retry an idempotent
 * re-seal instead of a `REQUEST_DIGEST_CONFLICT`. Two DIFFERENT logical origins are unaffected:
 * different keys, different (fresh) records, and a moved ref legitimately shows up in the second.
 *
 * THE AUDIT this record is written against — every environment read the development- and
 * record-vertical WORK_START material construction below performs:
 *   - `base_sha`             — `resolveBaseSha`, a `git ls-remote` against the live ref (DEVELOPMENT);
 *   - `repo_id`/`repo_full_name` — the deployment manifest file (DEVELOPMENT: the record vertical's
 *     args name no repository);
 *   - `namespace_id`         — `temporalNamespaceId`, the `temporal` CLI against the live cluster;
 *     it is both `continuation_target` and the sealed `target_ref.target_id`;
 *   - `surface_image`        — `<dir>/worker-image` plus `docker image inspect` and a `docker run`
 *     that reads tool versions INSIDE the image, so the tag alone is NOT a pin;
 *   - `worker_profile_digest` — the static worker profile composed with `surface_image`, pinned as
 *     the composed digest.
 * Everything else in the sealed material is a function of the arguments, of the `origin_key`, or of
 * the content of those five — `workflow_id` (from the effect_id the origin_key derives),
 * `args_cas_key`, `args_digest`, `bounds`, and the record vertical's `resource_prefix` — and
 * therefore needs no record. A NEW ENVIRONMENT-DERIVED FIELD ADDED TO THE MATERIAL WITHOUT JOINING
 * `MATERIAL_INPUT_KEYS` IS EXACTLY THE DRIFT THIS INVARIANT FORBIDS.
 */
function openOrigin(
  dir: string,
  origin_key: string,
  vertical: "development" | "record",
  extra: readonly (string | undefined)[],
  env: OriginEnvironment,
): OriginRecord {
  const path = originRecordPath(dir, origin_key);
  const presented = { origin_key, vertical, work_item_digest: workItemDigest(vertical, extra) };
  const existing = readOriginRecord(dir, origin_key);
  if (existing !== undefined) {
    assertOriginArguments(existing, presented, path);
    env.log({ origin: "adopted", origin_key, origin_record: path });
    return existing; // every environment-derived field comes from HERE; nothing is re-read
  }
  // No record ⇒ nothing has happened yet for this origin. Resolve the WHOLE audited set once, then
  // publish it as ONE complete object — before the first kernel call, so a crash after the write
  // leaves a recoverable origin and a crash before it leaves nothing to recover from.
  const namespace_id = env.namespaceId(env.manifest);
  const surface_image = env.workerImage();
  const worker_profile_digest = workerProfileDigestFor(surface_image);
  const material_inputs: OriginMaterialInputs = vertical === "development"
    ? {
        base_sha: env.resolveBase(env.manifest.repo_full_name, "refs/heads/main"),
        namespace_id,
        repo_full_name: env.manifest.repo_full_name,
        repo_id: env.manifest.repo_id,
        surface_image,
        worker_profile_digest,
      }
    : { namespace_id, surface_image, worker_profile_digest };
  const published = publishOriginRecord(dir, {
    record_version: ORIGIN_RECORD_VERSION,
    origin_key,
    vertical,
    work_item_digest: presented.work_item_digest,
    material_inputs,
    created_at: env.now(),
  });
  // The race LOSER adopts the winner's record and is held to the SAME argument-identity check as
  // the read path: two starts under one key with different arguments never both proceed.
  if (published.adopted) assertOriginArguments(published.record, presented, path);
  env.log({ origin: published.adopted ? "adopted" : "recorded", origin_key, origin_record: path });
  return published.record;
}

/** A start that failed on the origin path, carrying the `origin_key` a retry must be re-invoked with. */
export class WorkStartOriginError extends Error {
  readonly origin_key: string;

  readonly origin_record: string;

  constructor(origin_key: string, origin_record: string, cause: unknown) {
    super(
      `work start for origin_key ${origin_key} failed: ${cause instanceof Error ? cause.message : String(cause)} ` +
        `(retry VERBATIM with this origin_key to converge on the same effect_id; its record, if the environment ` +
        `was resolved, is ${origin_record})`,
      { cause },
    );
    this.name = "WorkStartOriginError";
    this.origin_key = origin_key;
    this.origin_record = origin_record;
  }
}

/**
 * B6(3): the run capability minted at a run origin's verified initial dispatch rides in the
 * ADMITTED reply, and no rendering of it may reach a log. Under v0.4 no reply carries the field, so
 * this projects the same JSON the log line has always carried.
 *
 * The secret is dropped here rather than returned: PRESENTING it on the run's follow-up effects is
 * B5(3)-(4)'s presentation lane (a secure channel to the worker, not a return value of this
 * function), and a start that has nowhere to put it must not leave it lying in a log line meanwhile.
 */
function redactRunCapability(admitted: object): Record<string, unknown> {
  const shown = { ...admitted } as Record<string, unknown>;
  if (shown["run_capability"] !== undefined) shown["run_capability"] = "[redacted]";
  return shown;
}

/** The Kernel surface one start uses; an interface so the origin path is drivable in-process. */
export type StartWorkClient = Pick<
  KernelClient,
  "allocateEffectId" | "putBlob" | "sealEffectRequest" | "assembleAdmissionInput" | "evaluate" | "admitAndDispatch"
>;

export interface StartWorkDependencies {
  manifest?: LiveEnvManifest;
  client?: StartWorkClient;
  namespaceId?: (m: LiveEnvManifest) => string;
  resolveBase?: (repo_full_name: string, base_ref: string) => string;
  workerImage?: () => OriginMaterialInputs["surface_image"];
  /** The ONE place an origin key is minted (control A4: once per logical origin, never per attempt). */
  mintOriginKey?: () => string;
  now?: () => string;
}

export interface StartWorkOptions {
  /** v0.4 only: the wall-clock `step_ordinal` override. The v0.5 origin path has no ordinal. */
  ordinalArg?: string;
  log?: Log;
  originProfile?: OriginProfile;
  /**
   * The v0.5 logical origin's key, decided ONCE by the caller and preserved VERBATIM across
   * retries. `workPlan` derives one per item; a direct start that omits it gets a minted one.
   */
  originKey?: string;
  dependencies?: StartWorkDependencies;
}

/**
 * One governed WORK_START through the ordinary admission chain. `undefined` = refused, honestly
 * logged.
 *
 * RECOVERY, for a direct start whose `origin_key` this function minted: the key is emitted through
 * `log` the moment it is minted, is carried by every failure path's thrown `WorkStartOriginError`,
 * is returned in the result, and is persisted with the pinned material under
 * `<dir>/origin-keys/<sha256(origin_key)>.json` BEFORE the first kernel call. So a crashed process
 * always leaves a recoverable record, and the flow is: list `<dir>/origin-keys/`, read the record,
 * re-invoke `startWork` with `{ originKey: <the record's origin_key> }` — which converges on the
 * SAME effect_id and re-seals byte-identical material.
 */
export async function startWork(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: StartWorkOptions = {},
): Promise<{ effect_id: string; workflow_id: string; origin_key?: string } | undefined> {
  const log = options.log ?? SILENT;
  const deps = options.dependencies ?? {};
  const profile = options.originProfile ?? "v04";
  const m = deps.manifest ?? loadManifest(dir);
  const c = deps.client ?? liveClient(dir, "cadp-workflow");
  const workerImage = deps.workerImage ?? (() => imageIdentity(readFileSync(join(dir, "worker-image"), "utf8").trim()));
  // v0.4 resolves the namespace exactly where it always has, before the argument checks below.
  // v0.5 resolves it inside `openOrigin` instead — once per origin, and never when a record pins it.
  let namespaceId = profile === "v04" ? (deps.namespaceId ?? temporalNamespaceId)(m) : "";

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

  // The two inputs that belong to exactly one branch, refused rather than silently ignored on the
  // other: an `origin_key` has no meaning in the v1 zero-sentinel tuple, and a `step_ordinal` has
  // none in a run origin (a clock reading there would allocate a NEW effect_id per attempt, which
  // is precisely what control A5 forbids).
  if (profile === "v04" && options.originKey !== undefined) {
    throw new Error('originKey is a v0.5 run-origin input — pass originProfile: "v05" to allocate under the run-origin contract');
  }
  if (profile === "v05" && options.ordinalArg !== undefined) {
    throw new Error("ordinalArg is a v0.4 allocation input — a v0.5 run origin derives its effect identity from origin_key alone");
  }

  // WP §3.6/control A4: the Workflow side decides the `origin_key` ONCE per logical origin and
  // preserves it VERBATIM across retries. A key minted HERE is therefore made visible before
  // anything that can fail — logged on the next line, carried by every throw below, persisted with
  // the pinned material before the first kernel call, and returned in the result. The argument
  // checks above deliberately run FIRST: they refuse deterministically, touch no kernel state and
  // seal nothing, so a start that fails one of them is not yet an origin at all.
  const origin_key = profile === "v05" ? options.originKey ?? (deps.mintOriginKey ?? randomUUID)() : undefined;
  if (origin_key !== undefined && options.originKey === undefined) {
    log({ origin: "minted", origin_key, origin_record: originRecordPath(dir, origin_key) });
  }

  // Everything from here on is wrapped for ONE reason: on the origin path every failure must carry
  // the `origin_key` the retry has to be re-invoked with. With no origin (the v0.4 default) the
  // caught error is re-thrown as-is, so that branch's failures are exactly what they are today.
  try {
    const origin = origin_key === undefined
      ? undefined
      : openOrigin(dir, origin_key, vertical, extra, {
          manifest: m,
          namespaceId: deps.namespaceId ?? temporalNamespaceId,
          workerImage,
          resolveBase: deps.resolveBase ?? resolveBaseSha,
          now: deps.now ?? (() => new Date().toISOString()),
          log,
        });
    if (origin !== undefined) namespaceId = origin.material_inputs.namespace_id;

    const args =
      vertical === "development"
        ? {
            vertical,
            bounds: { max_steps: boundArg(extra[1], 8), max_effects: boundArg(extra[2], 6) },
            development: {
              repo_id: origin?.material_inputs.repo_id ?? m.repo_id,
              repo_full_name: origin?.material_inputs.repo_full_name ?? m.repo_full_name,
              base_ref: "refs/heads/main",
              // v0.4: resolved fresh at seal time — the manifest's setup-time snapshot goes stale
              // (see resolveBaseSha). v0.5: the tip this ORIGIN resolved, adopted from its record,
              // so a ref that moved between two attempts at ONE origin cannot re-seal different
              // bytes under the same effect_id.
              base_sha: origin?.material_inputs.base_sha ?? (deps.resolveBase ?? resolveBaseSha)(m.repo_full_name, "refs/heads/main"),
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
              // v0.5: a deterministic function of this origin's stable key, so the sealed material
              // is byte-reproducible. v0.4 keeps the wall-clock prefix, unchanged.
              resource_prefix: origin_key === undefined ? `live-${Date.now() % 100000}` : originResourcePrefix(origin_key),
              payloads: Array.from({ length: boundArg(extra[0], 2) }, (_, i) => `live payload ${i + 1}`),
            },
          };

    // v0.4: the zero-sentinel tuple with its wall-clock ordinal. v0.5: AP B5's run origin —
    // exactly `{schema, origin_key, purpose}`, and one origin_key is one effect_id for the store's
    // lifetime (control A5), so the retry below re-derives this identity instead of forking a run.
    const tuple: AllocationTuple = origin_key === undefined
      ? {
          schema: "cadp.allocation-key.v1",
          work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
          step_ordinal: options.ordinalArg !== undefined ? Number(options.ordinalArg) : Math.floor(Date.now() / 1000) % 1000000,
          purpose: "work-start",
        }
      : { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key, purpose: "work-start" };
    const { effect_id } = await c.allocateEffectId(tuple);
    const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
    // TD §11 version exactness: bind the immutable built-image digest + observed tool versions
    // into the WORK_START worker profile, so the reviewed/live composition names the exact image.
    // On the origin path both come from the record — the image is re-read from nothing.
    const image = origin?.material_inputs.surface_image ?? workerImage();
    const worker_profile_digest = origin?.material_inputs.worker_profile_digest ?? workerProfileDigestFor(image);
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
        // B5(9) legs 2 and 3: EXACTLY ONE binding on the declared work-run pair, naming this
        // request's OWN effect_id. That self-reference is what the Ingress adjudicates as a run
        // ORIGIN, and the `run_membership(E, E)` row it writes is the durable witness that makes
        // this WORK_START minting at its own verified initial dispatch.
        ...(origin_key === undefined ? [] : [{ authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: effect_id }]),
      ],
      target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: namespaceId },
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref,
      prior_effect_refs: [],
      // B6(1): the allocated tuple rides as transport and is required on a v0.5 first seal.
      ...(origin_key === undefined ? {} : { allocation_tuple: tuple }),
    });
    const input = await c.assembleAdmissionInput(effect_id, []);
    const evaluated = await c.evaluate(input.input_digest.value);
    if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
      log({ effect_id, evaluated, ...(origin_key === undefined ? {} : { origin_key }) });
      return undefined;
    }
    const admitted = await c.admitAndDispatch(effect_id, evaluated.decision.decision_id);
    log({
      effect_id,
      workflow_id: material.workflow_id,
      request_digest: request.request_digest.value,
      admitted: redactRunCapability(admitted),
      ...(origin_key === undefined ? {} : { origin_key }),
    });
    if (admitted.kind !== "ADMITTED" || admitted.outcome.result !== "COMMITTED") {
      // A retry of ONE logical origin whose WORK_START already dispatched is refused
      // EFFECT_ALREADY_COMMITTED: the run STARTED, and the honest answer is the same handle rather
      // than a NOT_ADMITTED the caller would answer by starting a second run. The re-seal above
      // already proved the material is byte-identical — a different one would have conflicted.
      if (origin_key !== undefined && admitted.kind === "REFUSAL" && admitted.reason === "EFFECT_ALREADY_COMMITTED") {
        return { effect_id, workflow_id: material.workflow_id, origin_key };
      }
      return undefined;
    }
    return { effect_id, workflow_id: material.workflow_id, ...(origin_key === undefined ? {} : { origin_key }) };
  } catch (error) {
    if (origin_key === undefined || error instanceof WorkStartOriginError) throw error;
    throw new WorkStartOriginError(origin_key, originRecordPath(dir, origin_key), error);
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
export async function workPlan(
  dir: string,
  proposalEvidenceId: string,
  maxItemsArg?: string,
  log: Log = SILENT,
  options: { originProfile?: OriginProfile } = {},
): Promise<Array<Record<string, unknown>>> {
  const proposal = await loadProposal(dir, proposalEvidenceId);
  const maxItems = boundArg(maxItemsArg, proposal.items.length);
  const profile = options.originProfile ?? "v04";
  const results: Array<Record<string, unknown>> = [];
  for (const [index, item] of proposal.items.slice(0, maxItems).entries()) {
    log({ driver: "starting", index, work_item: item.work_item, bounds: { max_steps: item.max_steps, max_effects: item.max_effects } });
    // The driver's own origin decision, made ONCE per (proposal, item) and stable by construction:
    // a re-run of the same plan item re-derives the identical key with nothing read back from
    // disk, so these keys — unlike a minted one — need no file record to be recoverable. They are
    // passed only under the v0.5 profile, where an origin_key is meaningful.
    const started = await startWork(dir, "development", [item.work_item, String(item.max_steps), String(item.max_effects), proposalEvidenceId], {
      log,
      ...(profile === "v05" ? { originProfile: profile, originKey: planItemOriginKey(proposalEvidenceId, index) } : {}),
    });
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
