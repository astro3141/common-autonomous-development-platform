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
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifest } from "./env.ts";
import type { LiveEnvManifest } from "./env.ts";
import { KernelApiError, KernelClient } from "../clients/kernelClient.ts";
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
import type { EvidenceDraft, SealRequestBody } from "../kernel/ingress.ts";
import type { EffectRequestV1, EvidenceEnvelopeV1 } from "../kernel/records.ts";

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

/**
 * WP §3.6 — the ORIGIN KEY, and the schema id of the one derivation this composition performs.
 *
 * `origin_key` is a WORKFLOW-OWNED OPAQUE IDEMPOTENCY DISCRIMINATOR: the Workflow side decides it
 * ONCE when it creates a logical run origin and reproduces it VERBATIM on every retry of that
 * origin. It names the ORIGIN, never the work's CONTENT — two distinct runs over byte-identical
 * work (same repository, same base, same work item) are two origins and carry two keys, which is
 * why nothing about the work is read to form one. A content fingerprint would collide those two on
 * one `effect_id` and land the second first seal in `REQUEST_DIGEST_CONFLICT` (an incident and a
 * scope hold) instead of starting a second run.
 */
export const PLAN_ORIGIN_KEY_SCHEMA = "cadp.live.origin-key.plan.v1";

/**
 * The `workPlan` derivation (WP §3.6): the stable pair already present at origin creation — the
 * sealed proposal's evidence id and the item's index within that proposal — encoded INJECTIVELY.
 * The index is decimal digits and comes FIRST, so the second `:` delimits it unambiguously and the
 * remainder is the whole evidence id however many colons it happens to contain; two different
 * `(proposal, index)` pairs therefore cannot encode to one string. No digest, and so no
 * digest-scheme question: the discriminator names the origin, and there is nothing to digest.
 */
export function planOriginKey(proposalEvidenceId: string, itemIndex: number): string {
  if (proposalEvidenceId === "") throw new Error("origin_key needs a proposal evidence id — refusing to derive one from nothing");
  if (!Number.isSafeInteger(itemIndex) || itemIndex < 0) throw new Error(`malformed proposal item index '${itemIndex}'`);
  return `${PLAN_ORIGIN_KEY_SCHEMA}:${itemIndex}:${proposalEvidenceId}`;
}

/**
 * WP §3.6's material replay-stability contract, on the one field of this composition that broke it:
 * the record vertical's `resource_prefix` is now a function of the ORIGIN and of nothing else. Two
 * attempts at one origin therefore seal byte-identical `args` — same `args_digest`, same
 * `material_ref`, an idempotent re-seal — where the wall-clock `live-${Date.now() % 100000}` it
 * replaces sealed different material each attempt and made the origin unretryable for the store's
 * lifetime (its identity being stable while its material was not). Two DISTINCT origins still get
 * distinct prefixes, their `origin_key`s differing. The digest is over the opaque key only to fix
 * the prefix's shape and length whatever characters the key itself carries.
 */
export function originResourcePrefix(origin_key: string): string {
  return `live-${sha256Hex(origin_key).slice(0, 16)}`;
}

/**
 * The seams `startWork` is driven through in conformance tests, exactly as `sealPlan` has: the
 * live composition's real defaults shell out to `docker`, `git` and `temporal` and talk to a
 * running kernel, none of which an ops-level replay assertion needs.
 */
interface StartWorkDependencies {
  manifest?: LiveEnvManifest;
  client?: StartWorkClient;
  namespaceId?: (m: LiveEnvManifest) => string;
  resolveBase?: (repoFullName: string, baseRef: string) => string;
  imageIdentity?: () => { image: string; image_digest: string; tool_versions: Record<string, string> };
  /** The `origin_key` mint of a DIRECT start, replaced so a test can count its calls (A4/A5). */
  mintOriginKey?: () => string;
}

/** The kernel reach one governed WORK_START needs — the subset of `KernelClient` used below. */
type StartWorkClient = Pick<
  KernelClient,
  "allocateEffectId" | "putBlob" | "sealEffectRequest" | "getEffectState" | "assembleAdmissionInput" | "evaluate" | "admitAndDispatch"
>;

/**
 * WP §3.6 — THE ORIGIN'S OWN PRIOR SEAL, which is the durable per-origin state this composition has:
 * the allocation converges the identity, so `effect_id` is already this origin's name, and K3 either
 * holds that origin's sealed request or it does not.
 *
 * `undefined` means ONLY "this origin has never sealed" — the kernel's 404 EFFECT_NOT_FOUND, and
 * nothing else. Any other failure is a read we did not get an answer to, and is re-thrown rather
 * than read as absence: treating an unavailable kernel as "no prior seal" would send the caller down
 * the re-derivation path and re-present drifted material under an already-sealed identity, which is
 * the exact `REQUEST_DIGEST_CONFLICT` this read exists to make unreachable.
 */
async function priorOriginSeal(c: StartWorkClient, effect_id: string): Promise<EffectRequestV1 | undefined> {
  try {
    return (await c.getEffectState(effect_id)).request;
  } catch (error) {
    if (error instanceof KernelApiError && error.status === 404 && error.reason === "EFFECT_NOT_FOUND") return undefined;
    throw error;
  }
}

/**
 * The work an origin's request DECLARES, in the sealed record's own vocabulary: derived from the
 * caller's arguments and the allocated identity, never from anything external or mutable.
 */
function workStartBindings(effect_id: string, vertical: "development" | "record", extra: string[]): SealRequestBody["work_bindings"] {
  return [
    // Spec v0.5 §5.3 / AP B5(9) legs 2-3: EXACTLY ONE binding on the kernel's declared work-run
    // pair, carrying this request's OWN `effect_id`. That self-origin relation is what the
    // Ingress adjudicates, and the `run_membership(E, E)` witness it writes is the only thing
    // that ever makes this effect minting at its own initial dispatch (AP B5(1)(b)). A second
    // work-run binding would be `KERNEL_NAMESPACE_AMBIGUOUS`, so there is exactly one.
    { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: effect_id },
    { authority_ref: "github.com", namespace: "work-item", object_id: vertical === "development" ? `dev:${extra[0]}` : `record:${extra[0]}` },
    // Optional exact provenance: the WORK_PROPOSAL this item came from. A binding, never authority.
    ...(vertical === "development" && extra[3] !== undefined && extra[3] !== ""
      ? [{ authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: extra[3] }]
      : []),
  ];
}

/**
 * One governed WORK_START through the ordinary admission chain. `undefined` = refused, honestly
 * logged.
 *
 * This is the RUN ORIGIN path (Spec v0.5 §5.3, AP B5(9), WP §3.6). The allocation is
 * `cadp.allocation-key.run-origin.v1` — exactly `{schema, origin_key, purpose}` — because no other
 * schema can mint the identity of a run's origin: `cadp.allocation-key.v1` projects its
 * `work_run_ref` onto a sealed binding, and here that value IS the `effect_id` being allocated, so
 * the caller would have to know it before allocating it. `origin_key` is decided ONCE per logical
 * origin: `workPlan` derives it from the proposal item's stable coordinates, a direct start mints
 * one, and a RETRY of either passes the same key back through `options.originKey` and converges on
 * the same `effect_id` (A5 leg o-ii — this schema's allocation contract is immutable for the
 * store's lifetime, so the convergence carries no contract qualifier).
 *
 * Allocation precedes sealing, so the Platform-issued `effect_id` is in hand before the seal: it is
 * re-presented as this request's OWN and ONLY `work-run` binding, which is what B5(9)'s legs 2 and
 * 3 adjudicate as the self-origin relation. Exactly one such binding — a second would be
 * `KERNEL_NAMESPACE_AMBIGUOUS` — and the allocated tuple rides as `allocation_tuple`, the stripped
 * transport sibling B6(1) requires at a first seal and never a record field.
 *
 * NOTHING sealed below is derived from the wall clock, and on a RETRY nothing is DERIVED AT ALL: the
 * origin's identity is stable, so its material must be too, or a retry re-presents one `effect_id`
 * with a different semantic payload and lands `REQUEST_DIGEST_CONFLICT` instead of being idempotent
 * (WP §3.6, control 14). Killing the wall clock is necessary and not sufficient — `base_sha` is
 * resolved from a MUTABLE ref, so a retry taken after `refs/heads/main` moves would seal a different
 * base under an identity that cannot move. So the order below is: ALLOCATE first, then ask K3
 * whether this origin has already sealed. If it has, its sealed request is RE-PRESENTED VERBATIM —
 * same `material_ref`, same `target_ref`, same bindings, so the Ingress's semantic comparison is an
 * equality by construction and the re-seal is the idempotent no-op that returns the stored row. The
 * first seal is where the base is resolved and pinned; every later attempt inherits it, and no
 * external fact (the ref tip, the built image, the Temporal namespace) is even READ on that path.
 */
export async function startWork(
  dir: string,
  vertical: "development" | "record",
  extra: string[],
  options: { originKey?: string; log?: Log; dependencies?: StartWorkDependencies } = {},
): Promise<{ effect_id: string; workflow_id: string; origin_key: string } | undefined> {
  const log = options.log ?? SILENT;
  const dependencies = options.dependencies ?? {};
  const m = dependencies.manifest ?? loadManifest(dir);
  const c = dependencies.client ?? liveClient(dir, "cadp-workflow");

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
  // WP §3.6 caller obligation (1): decided ONCE per logical origin, here, before anything reads it.
  // A direct start MINTS — `crypto.randomUUID`, called exactly once per invocation however many
  // places consume the key — and returns it below so a retry of THIS origin passes it back rather
  // than minting a second identity for the same logical run. `workPlan` supplies its own derived
  // key instead, so nothing on that path is ever minted.
  const mintOriginKey = dependencies.mintOriginKey ?? ((): string => randomUUID());
  const origin_key = options.originKey ?? mintOriginKey();
  // #127 on EVERY path: a malformed bound refuses HERE, before an identity is allocated, whether or
  // not this attempt goes on to derive material (a retry does not, and must still refuse one).
  const bounds =
    vertical === "development"
      ? { max_steps: boundArg(extra[1], 8), max_effects: boundArg(extra[2], 6) }
      : { max_steps: boundArg(extra[1], 6), max_effects: boundArg(extra[2], 4) };
  const payloadCount = vertical === "record" ? boundArg(extra[0], 2) : 0;

  // AP B1(5): exactly the three keys of `cadp.allocation-key.run-origin.v1`. No `work_run_ref` (a
  // tuple naming this identity would have to contain the value it is derived to produce) and no
  // `step_ordinal` — the wall-clock ordinal this replaces gave one logical origin a fresh identity
  // per second, which is precisely the fork A5 exists to make unconstructible.
  //
  // The allocation is FIRST, before any material is derived: it is what converges this attempt onto
  // the origin's one identity, and only with that identity in hand can the origin be asked whether
  // it has already sealed.
  const allocation_tuple = { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key, purpose: "work-start" as const };
  const { effect_id } = await c.allocateEffectId(allocation_tuple);
  // A pure function of the effect identity, so a retry names the workflow the first seal named
  // without reading the sealed material back — the Kernel API serves no blob reads (TD §12).
  const workflow_id = `cadp-work-${effect_id}`;
  const work_bindings = workStartBindings(effect_id, vertical, extra);
  const prior = await priorOriginSeal(c, effect_id);
  let draft: SealRequestBody;

  if (prior !== undefined) {
    // THE RETRY (WP §3.6, control 14). This origin already sealed, so its sealed request is the
    // pinned material: `material_ref` (and with it `base_sha`, the bounds, the image and every other
    // first-creation fact) and `target_ref` are re-presented VERBATIM, never re-derived. The
    // Ingress's re-seal comparison is over exactly these fields, so equality is by construction and
    // the seal below is the idempotent no-op that returns the stored row — for any base ref, any
    // image and any clock, which is the whole of what replay stability means here.
    //
    // What IS recomputed is the declared work, and only to CHECK it: an `origin_key` names one run,
    // so re-presenting one for different work is a caller error. Refusing it is honest where
    // silently inheriting the first seal's material would run work nobody asked for under a name
    // that says otherwise. The material itself is unreadable and deliberately uncompared —
    // inheriting it is the point, and a retry that wants different material wants a new origin.
    if (jcsDigest({ work_bindings: prior.work_bindings }).value !== jcsDigest({ work_bindings }).value) {
      throw new Error(
        `origin_key '${origin_key}' already sealed ${effect_id} for different work — one origin_key names ONE run; use a new origin for different work`,
      );
    }
    log({ effect_id, origin_key, replay: "PINNED", material_ref: prior.material_ref });
    draft = {
      effect_id,
      requester_ref: prior.requester_ref,
      work_bindings: prior.work_bindings,
      target_ref: prior.target_ref,
      operation_kind: prior.operation_kind,
      material_schema: prior.material_schema,
      material_ref: prior.material_ref,
      prior_effect_refs: prior.prior_effect_refs,
      // AP B6(1)/B6(2): a re-seal may repeat the tuple, and repeating the ALLOCATED one is never
      // what turns an idempotent re-seal into a conflict.
      allocation_tuple,
    };
  } else {
    // THE FIRST SEAL: the one attempt that reads the world, and so the one that PINS it.
    const namespaceId = (dependencies.namespaceId ?? temporalNamespaceId)(m);
    const args =
      vertical === "development"
        ? {
            vertical,
            bounds,
            development: {
              repo_id: m.repo_id,
              repo_full_name: m.repo_full_name,
              base_ref: "refs/heads/main",
              // Resolved fresh AT ORIGIN CREATION — the manifest's setup-time snapshot goes stale
              // (see resolveBaseSha) — and pinned by the seal for the run's whole lifetime. The ref
              // is mutable, so this value is stable only because no later attempt on this origin
              // resolves it again: a retry takes the branch above and re-presents this seal's
              // `material_ref`. Resolving it per attempt is what made one origin able to seal two
              // different bases under one immovable `effect_id` — REQUEST_DIGEST_CONFLICT, an
              // incident and a scope hold rather than a retry.
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
            bounds,
            record: {
              tenant: "cadp-disposable",
              // WP §3.6: a function of the ORIGIN, never of the wall clock — see originResourcePrefix.
              resource_prefix: originResourcePrefix(origin_key),
              payloads: Array.from({ length: payloadCount }, (_, i) => `live payload ${i + 1}`),
            },
          };
    const { cas_key: args_cas_key } = await c.putBlob(Buffer.from(JSON.stringify(args), "utf8"));
    // TD §11 version exactness: bind the immutable built-image digest + observed tool versions
    // into the WORK_START worker profile, so the reviewed/live composition names the exact image.
    const image = (dependencies.imageIdentity ?? (() => imageIdentity(readFileSync(join(dir, "worker-image"), "utf8").trim())))();
    const worker_profile_digest = jcsDigest({
      profile: workerProfileDigest(),
      surface_image: image.image,
      image_digest: image.image_digest,
      tool_versions: image.tool_versions,
    }).value;
    const material = {
      workflow_id,
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
    draft = {
      effect_id,
      requester_ref: "workflow:cadp-work",
      work_bindings,
      target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: namespaceId },
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref,
      prior_effect_refs: [],
      // AP B6(1): transport, stripped before anything reads the draft — never a record field.
      allocation_tuple,
    };
  }

  const request = await c.sealEffectRequest(draft);
  const input = await c.assembleAdmissionInput(effect_id, []);
  const evaluated = await c.evaluate(input.input_digest.value);
  if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
    log({ effect_id, evaluated });
    return undefined;
  }
  const admitted = await c.admitAndDispatch(effect_id, evaluated.decision.decision_id);
  log({ effect_id, workflow_id, request_digest: request.request_digest.value, admitted });
  if (admitted.kind !== "ADMITTED" || admitted.outcome.result !== "COMMITTED") return undefined;
  // `origin_key` is returned so a retry of THIS origin re-presents it verbatim (WP §3.6): the
  // minted case has no other way to know the value, and a second mint would be a second run.
  return { effect_id, workflow_id, origin_key };
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
  pollRun?: typeof pollRun;
}

export async function workPlan(
  dir: string,
  proposalEvidenceId: string,
  maxItemsArg?: string,
  log: Log = SILENT,
  dependencies: WorkPlanDependencies = {},
): Promise<Array<Record<string, unknown>>> {
  const start = dependencies.startWork ?? startWork;
  const poll = dependencies.pollRun ?? pollRun;
  const proposal = await (dependencies.loadProposal ?? loadProposal)(dir, proposalEvidenceId);
  const maxItems = boundArg(maxItemsArg, proposal.items.length);
  const results: Array<Record<string, unknown>> = [];
  for (const [index, item] of proposal.items.slice(0, maxItems).entries()) {
    // WP §3.6: the item's origin key is DERIVED, not minted — the `(proposal, index)` pair is
    // already stable at origin creation, so a re-run of this driver over the same proposal
    // converges on the same `effect_id` per item instead of forking a second run for each.
    const originKey = planOriginKey(proposalEvidenceId, index);
    log({ driver: "starting", index, work_item: item.work_item, bounds: { max_steps: item.max_steps, max_effects: item.max_effects } });
    const started = await start(dir, "development", [item.work_item, String(item.max_steps), String(item.max_effects), proposalEvidenceId], { log, originKey });
    if (started === undefined) {
      results.push({ index, work_item: item.work_item, status: "NOT_ADMITTED" });
      break; // fail closed: an item the gate refused halts the loop
    }
    const settled = await poll(dir, started.effect_id, started.workflow_id, 30 * 60_000);
    results.push({ index, work_item: item.work_item, work_run_ref: started.effect_id, workflow_id: started.workflow_id, ...settled });
    log({ driver: "settled", index, ...settled });
    if (nextAction(settled) === "HALT") break;
  }
  return results;
}
