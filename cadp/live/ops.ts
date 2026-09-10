/**
 * Shared live-composition operations (#61): the plan / governed-WORK_START / run-polling glue
 * used by both the CLI (`ctl.ts`) and the MCP tool surface (`mcpServer.ts`).
 *
 * Nothing here is authority: `sealPlan` produces proposal plus planner-observation evidence, `startWork` goes through the
 * ordinary governed admission (policy gates every start), and `pollRun`/`runSnapshot` are
 * observations. Callers own presentation; `log` defaults to silent so a protocol server's stdout
 * stays clean.
 *
 * WP §3.6 (the run-origin path) is a SECOND allocation branch inside `startWork`, selected by
 * `options.originProfile` and defaulting to `"v04"` — the live v0.4 deployment, `ctl.ts` and
 * `mcpServer.ts` all take the default and are byte-for-byte unchanged by it. See `OriginProfile`.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

// --------------------------------------------------------------------- WP §3.6 the origin path
//
// The Workflow Plane TD §3.6 states the run-origin allocation contract and the caller obligations
// that come with it. Everything between here and `startWork` is the Workflow side of that contract;
// none of it is authority, and none of it applies to a v0.4 deployment.

/**
 * WP §3.6 / AP B5(9): the DECLARED `(authority_ref, namespace)` work-run subject pair a v0.5 origin
 * binds ITSELF on. The Ingress reads the declared pair exactly — an off-authority `{other,
 * work-run, …}` binding is not a kernel work-run subject at all (AP B3(4)(a)) — so this pair is the
 * deployment's `kernel_subject_namespaces` entry and nothing else.
 */
const WORK_RUN_AUTHORITY = "cadp-store:k04";
const WORK_RUN_NAMESPACE = "work-run";

/**
 * The v0.4 origin allocation's ALL-ZERO placeholder run ref. WP §3.6 names it as the measured gap:
 * an origin `WORK_START` has no prior run to present, so `cadp.allocation-key.v1` — whose first
 * field is exactly a `work_run_ref` — can only be fed a sentinel, and the entropy that actually
 * separates two origins ends up in a wall-clock `step_ordinal`. It stays EXACTLY as it is on the
 * `v04` branch: this constant is the same string that branch has always sent, named rather than
 * moved, so the tuple it forms is byte-identical to today's.
 */
const V04_ORIGIN_WORK_RUN_SENTINEL = "cadp-v04:effect:00000000-0000-7000-8000-000000000000";

/**
 * Which allocation path a `startWork` takes. This is a DEPLOYMENT property — whether the active
 * kernel config is `cadp.kernel-config.v1` or `.v2` with this requester enrolled in the run profile
 * — and `ops.ts` cannot read it: the deployment's `kernel-config.json` is the kernel SERVICE's
 * wiring (ports, db path, target credentials), the active `data.cadp` lives inside the sealed OPA
 * bundle, and the Kernel API exposes no read of it. So the profile is an EXPLICIT option with the
 * conservative default:
 *
 *  - `v04` (DEFAULT, and what every checked-out caller gets — `ctl.ts`, `mcpServer.ts`, the live
 *    v0.4 deployment): the existing zero-sentinel `cadp.allocation-key.v1` tuple, the wall-clock
 *    `step_ordinal`, the wall-clock record `resource_prefix`, today's `work_bindings` and no
 *    `allocation_tuple` on the seal. Byte-identical material to what this function sealed before
 *    the origin path existed — under a v1 config none of the v0.5 rules can even apply (AP B5(3)),
 *    so there is nothing for a v0.4 deployment to opt into and nothing it may be silently moved to.
 *  - `v05`: WP §3.6's origin path. The v0.5 genesis composition passes `"v05"`.
 */
export type OriginProfile = "v04" | "v05";

/** The deployment-dir file a MINTED `origin_key` is recorded in before anything can fail. */
export const ORIGIN_KEY_RECORD_FILE = "origin-keys.json";

/**
 * One minted-origin record. `work_item_digest` is what an operator matches a crashed invocation
 * back to: the canonical digest of the whole logical start (`vertical` + the `extra` positions,
 * which carry the work item, the bounds and the provider selections — every input that WP §3.6
 * requires be fixed at first origin creation and reproduced verbatim on retry). `created_at` is
 * wall clock and is deliberately NOT sealed material: this file is a recovery log, never an input
 * to any allocation tuple or `WORK_START` args.
 */
export interface OriginKeyRecord {
  readonly origin_key: string;
  readonly work_item_digest: string;
  readonly created_at: string;
}

/** Read the deployment's minted-origin records; an absent file is an empty history, not an error. */
export function readOriginKeyRecords(dir: string): OriginKeyRecord[] {
  const path = join(dir, ORIGIN_KEY_RECORD_FILE);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${path} is not an origin-key record array`);
  return parsed as OriginKeyRecord[];
}

/**
 * Append one minted `origin_key`, BEFORE the first kernel call. Fails closed: a mint we could not
 * record is a mint a crash would lose, and losing it is exactly the fork this record exists to
 * prevent — a retry that cannot recover the key mints a second one and originates a SECOND run.
 */
function appendOriginKeyRecord(dir: string, record: OriginKeyRecord): void {
  writeFileSync(join(dir, ORIGIN_KEY_RECORD_FILE), `${JSON.stringify([...readOriginKeyRecords(dir), record], null, 2)}\n`);
}

/**
 * WP §3.6's `workPlan` derivation: the stable pair `proposal_evidence_id` + item INDEX, which is
 * already present at origin creation, canonically digested into one opaque discriminator. Decided
 * ONCE per logical origin by construction — it is a pure function of the sealed proposal's identity
 * and the item's position in it, so every retry of that item recomputes the same key with no state
 * anywhere. That is why the `workPlan` path writes NO `origin-keys.json` record: there is nothing to
 * recover, the key is re-derivable from the two arguments the driver was invoked with.
 *
 * A canonical digest rather than a concatenation, on the v0.4 §7.4 discipline: `a|1` and `a|` + `1`
 * must not be able to name the same origin as some other pair. Fails closed on inputs that would
 * collapse distinct origins onto one key.
 */
export function planOriginKey(proposalEvidenceId: string, itemIndex: number): string {
  if (proposalEvidenceId === "") throw new Error("cannot derive an origin_key from an empty proposal_evidence_id");
  if (!Number.isSafeInteger(itemIndex) || itemIndex < 0) throw new Error(`malformed proposal item index '${itemIndex}'`);
  return jcsDigest({ scheme: "cadp.origin-key.work-plan.v1", proposal_evidence_id: proposalEvidenceId, item_index: itemIndex }).value;
}

/**
 * The record vertical's `resource_prefix` as a function of the origin's own `origin_key` — WP §3.6's
 * replay-stability invariant over SEALED MATERIAL, which is broader than the allocation key. The
 * clock-derived `live-${Date.now() % 100000}` it replaces on this path is replay-UNSTABLE: one
 * logical origin converges on one `effect_id`, so a retry re-presents that `effect_id` carrying
 * different `args` — a different semantic payload for the same K3 identity, which is
 * `REQUEST_DIGEST_CONFLICT`, an incident and a scope hold rather than a retry.
 *
 * Distinct origins still get distinct prefixes (the key is the origin's identity), and the shape
 * `live-<hex>` is unchanged so the record service sees the same kind of string it always has.
 */
export function originResourcePrefix(originKey: string): string {
  if (originKey === "") throw new Error("cannot derive a resource_prefix from an empty origin_key");
  return `live-${jcsDigest({ scheme: "cadp.record-resource-prefix.v1", origin_key: originKey }).value.slice(0, 12)}`;
}

/**
 * A v0.5 origin start that failed AFTER its `origin_key` was decided. WP §3.6 requires the Workflow
 * side to decide the key ONCE per logical origin and preserve it VERBATIM across retries, so a
 * failure must never be the thing that loses it: the key is in this error's own `message` (a caller
 * that only reads `.message` — `ctl.ts`'s `autoDev` does — still surfaces it), in its `origin_key`
 * property, in the `log` line emitted before the first kernel call, and, for a MINTED key, in the
 * deployment's `origin-keys.json`. `cause` carries the original failure unchanged.
 */
export class OriginStartFailure extends Error {
  readonly origin_key: string;

  constructor(origin_key: string, cause: unknown) {
    super(
      `work start for origin ${origin_key} failed (${cause instanceof Error ? cause.message : String(cause)}) — ` +
        `retry with { originKey: "${origin_key}" } to converge on the same effect_id`,
      { cause },
    );
    this.name = "OriginStartFailure";
    this.origin_key = origin_key;
  }
}

/**
 * The composition seams `startWork` reaches the world through. Every default is the live one; a test
 * (or a non-live composition) substitutes the ones it must not run for real — the `temporal` CLI,
 * `git ls-remote`, `docker image inspect`, the Kernel API and the two non-deterministic sources.
 * Same shape and same rationale as `SealPlanDependencies` above.
 */
export interface StartWorkDependencies {
  manifest?: LiveEnvManifest;
  client?: Pick<KernelClient, "allocateEffectId" | "putBlob" | "sealEffectRequest" | "assembleAdmissionInput" | "evaluate" | "admitAndDispatch">;
  namespaceId?: string;
  resolveBase?: (repoFullName: string, baseRef: string) => string;
  identifyImage?: (image: string) => ReturnType<typeof imageIdentity>;
  /** The ONE entropy source of a minted `origin_key` (WP §3.6: minted once, never re-derived). */
  randomUUID?: () => string;
  /** `created_at` for the recovery record only — never an input to any sealed field. */
  now?: () => string;
}

/**
 * One governed WORK_START through the ordinary admission chain. `undefined` = refused, honestly
 * logged.
 *
 * ORIGIN PROFILE (WP §3.6). `options.originProfile` selects the allocation path and defaults to
 * `"v04"`, which is byte-for-byte the path this function has always taken. Only the `"v05"` branch
 * allocates under `cadp.allocation-key.run-origin.v1`, binds the self-referential work run, derives
 * the record `resource_prefix` from the origin key and drops the wall-clock ordinal.
 *
 * RECOVERING A MINTED ORIGIN (WP §3.6 caller obligation 1). A direct `v05` start with no
 * `originKey` mints one with `crypto.randomUUID`, emits it through `log`, and appends it to
 * `<dir>/origin-keys.json` BEFORE the first kernel call — so a process that dies anywhere after
 * that leaves a recoverable record instead of an orphaned run. The recovery flow is: read
 * `<dir>/origin-keys.json` (`readOriginKeyRecords`), match the invocation by `work_item_digest`,
 * and re-invoke this function with `{ originKey: <the recorded key> }`. That converges on the SAME
 * `effect_id` and, on the record vertical, re-seals byte-identical material — an idempotent no-op
 * rather than a K3 conflict. `workPlan`'s keys need no such record at all: they are derived
 * (`planOriginKey`) from the two arguments the driver was invoked with.
 *
 * ONE RESIDUAL, stated rather than implied: on the DEVELOPMENT vertical the sealed `base_sha` is the
 * declared ref's tip AT SEAL TIME, so a retry after `refs/heads/main` moves re-seals the converged
 * `effect_id` with drifted material. `options.baseSha` is the seam that pins it — a retry re-presents
 * the first creation's value (from that attempt's own sealed args, or from whatever the composition
 * driving the origin recorded) — and the record file deliberately holds only what WP §3.6 asks of
 * it: the origin's IDENTITY, not a copy of its material.
 */
export async function startWork(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: {
    ordinalArg?: string;
    log?: Log;
    /** WP §3.6. Defaults to the v0.4 path; the v0.5 genesis composition passes `"v05"`. */
    originProfile?: OriginProfile;
    /** The origin's decided key: derived by `workPlan`, or a MINTED key re-presented on retry. */
    originKey?: string;
    /**
     * The base sha this origin was FIRST created against, re-presented on retry. WP §3.6's material
     * replay-stability invariant covers the development branch too: `resolveBaseSha` reads the ref's
     * CURRENT tip, so a retry after main moves would seal different `args` for the same converged
     * `effect_id`. Omitted resolves fresh, which is what a first creation does on both branches.
     */
    baseSha?: string;
  } = {},
  dependencies: StartWorkDependencies = {},
): Promise<{ effect_id: string; workflow_id: string; origin_key?: string } | undefined> {
  const log = options.log ?? SILENT;
  const profile = options.originProfile ?? "v04";
  const m = dependencies.manifest ?? loadManifest(dir);
  const c = dependencies.client ?? liveClient(dir, "cadp-workflow");
  const namespaceId = dependencies.namespaceId ?? temporalNamespaceId(m);

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

  // WP §3.6, caller obligation 1 — DECIDE THE ORIGIN KEY ONCE, and make it durable and visible
  // before anything that could fail. Placed here, after the fail-closed argument legs above (which
  // are pure and allocate nothing, so a refusal among them leaves no origin to converge on) and
  // ahead of EVERY kernel call and of `resolveBaseSha`'s network read. `originKey`/`baseSha` are
  // v0.5-only inputs: accepting them silently under `v04` would let a caller believe it had pinned
  // an origin the v1 tuple cannot express, so they fail closed instead.
  if (profile === "v04" && (options.originKey !== undefined || options.baseSha !== undefined)) {
    throw new Error("originKey/baseSha are v0.5 origin-path inputs; originProfile 'v04' allocates under cadp.allocation-key.v1");
  }
  let originKey: string | undefined;
  if (profile === "v05") {
    originKey = options.originKey;
    if (originKey === undefined) {
      // A DIRECT start: mint exactly once, here and nowhere else. Emitted and recorded before the
      // first kernel call, so a crash at any point below leaves the key recoverable and the retry
      // converges instead of originating a second run.
      originKey = (dependencies.randomUUID ?? randomUUID)();
      appendOriginKeyRecord(dir, {
        origin_key: originKey,
        work_item_digest: jcsDigest({ scheme: "cadp.origin-intent.v1", vertical, extra }).value,
        created_at: (dependencies.now ?? (() => new Date().toISOString()))(),
      });
      log({ origin_profile: profile, origin_key: originKey, origin_source: "minted", origin_key_record: join(dir, ORIGIN_KEY_RECORD_FILE) });
    } else {
      log({ origin_profile: profile, origin_key: originKey, origin_source: "provided" });
    }
  }

  try {
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
              // On the v0.5 origin path a retry may re-present the FIRST creation's value instead
              // (`options.baseSha`), which is WP §3.6's material replay-stability pin.
              base_sha: options.baseSha ?? (dependencies.resolveBase ?? resolveBaseSha)(m.repo_full_name, "refs/heads/main"),
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
              // v0.4: the wall-clock prefix, unchanged. v0.5: a deterministic function of THIS
              // origin's key, so one origin's retries seal byte-identical args (WP §3.6).
              resource_prefix: originKey === undefined ? `live-${Date.now() % 100000}` : originResourcePrefix(originKey),
              payloads: Array.from({ length: boundArg(extra[0], 2) }, (_, i) => `live payload ${i + 1}`),
            },
          };

    // The two allocation tuples, and the ONE place the branch is taken. Under `v04` the wall-clock
    // ordinal is evaluated exactly as before; under `v05` it is not evaluated at all — the origin
    // path reads no clock, which is what makes its allocation and its material replayable.
    const allocation =
      originKey === undefined
        ? {
            schema: "cadp.allocation-key.v1",
            work_run_ref: V04_ORIGIN_WORK_RUN_SENTINEL,
            step_ordinal: options.ordinalArg !== undefined ? Number(options.ordinalArg) : Math.floor(Date.now() / 1000) % 1000000,
            purpose: "work-start",
          }
        : // WP §3.6: exactly these three keys. `origin_key` is the schema's single non-reserved
          // field; a vertical's own field (`repo_id`, say) would be outside the descriptor's set
          // and refused ALLOCATION_TUPLE_INVALID, which is what makes this tuple record-general.
          { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: originKey, purpose: "work-start" };
    const { effect_id } = await c.allocateEffectId(allocation);
    const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
    // TD §11 version exactness: bind the immutable built-image digest + observed tool versions
    // into the WORK_START worker profile, so the reviewed/live composition names the exact image.
    const image = (dependencies.identifyImage ?? imageIdentity)(readFileSync(join(dir, "worker-image"), "utf8").trim());
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
        // WP §3.6 caller obligation 2 / AP B5(9) leg 3: on the v0.5 origin path, EXACTLY ONE
        // binding on the declared work-run pair, and its object_id is this WORK_START's OWN
        // Platform-issued effect_id — the allocation returned it above, before this seal. That
        // self-reference IS what the Ingress adjudicates as the run origin, and what makes it write
        // the `run_membership(E, E)` witness. The v0.4 branch binds no work run at all, unchanged.
        ...(originKey === undefined ? [] : [{ authority_ref: WORK_RUN_AUTHORITY, namespace: WORK_RUN_NAMESPACE, object_id: effect_id }]),
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
      // AP B6(1): the allocated tuple rides as transport on a v2 first seal and is REQUIRED there.
      // Omitted entirely on the v0.4 branch, whose v1 allocation row carries no v2 binding to
      // compare it against — so that branch's request body is byte-identical to today's.
      ...(originKey === undefined ? {} : { allocation_tuple: allocation }),
    });
    const input = await c.assembleAdmissionInput(effect_id, []);
    const evaluated = await c.evaluate(input.input_digest.value);
    if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
      log({ effect_id, evaluated, ...(originKey === undefined ? {} : { origin_key: originKey }) });
      return undefined;
    }
    const admitted = await c.admitAndDispatch(effect_id, evaluated.decision.decision_id);
    log({ effect_id, workflow_id: material.workflow_id, request_digest: request.request_digest.value, admitted, ...(originKey === undefined ? {} : { origin_key: originKey }) });
    if (admitted.kind !== "ADMITTED" || admitted.outcome.result !== "COMMITTED") return undefined;
    return { effect_id, workflow_id: material.workflow_id, ...(originKey === undefined ? {} : { origin_key: originKey }) };
  } catch (error) {
    // v0.4 rethrows untouched. On the origin path the decided key rides out with the failure, so no
    // retry has to guess it — see `OriginStartFailure` and the recovery flow above.
    if (originKey === undefined) throw error;
    throw new OriginStartFailure(originKey, error);
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
  options: { originProfile?: OriginProfile } = {},
  dependencies: WorkPlanDependencies = {},
): Promise<Array<Record<string, unknown>>> {
  const profile = options.originProfile ?? "v04";
  const proposal = await (dependencies.loadProposal ?? loadProposal)(dir, proposalEvidenceId);
  const maxItems = boundArg(maxItemsArg, proposal.items.length);
  const results: Array<Record<string, unknown>> = [];
  for (const [index, item] of proposal.items.slice(0, maxItems).entries()) {
    // WP §3.6: the origin key is DERIVED, not minted — the sealed proposal's evidence id and the
    // item's index are exactly the "stable pair already present at origin creation", so re-running
    // this driver over the same proposal re-derives the same key for the same item and converges on
    // its `effect_id`. Nothing is persisted for it: unlike a minted key there is no state to lose.
    const origin_key = profile === "v05" ? planOriginKey(proposalEvidenceId, index) : undefined;
    log({ driver: "starting", index, work_item: item.work_item, bounds: { max_steps: item.max_steps, max_effects: item.max_effects }, ...(origin_key === undefined ? {} : { origin_key }) });
    const started = await (dependencies.startWork ?? startWork)(
      dir,
      "development",
      [item.work_item, String(item.max_steps), String(item.max_effects), proposalEvidenceId],
      { log, originProfile: profile, ...(origin_key === undefined ? {} : { originKey: origin_key }) },
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
