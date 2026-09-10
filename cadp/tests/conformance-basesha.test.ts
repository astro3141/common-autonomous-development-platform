/**
 * `cadp/live/ops.ts` — the live composition's own conformance, in two parts.
 *
 * PART 1, base-sha resolution: the sealed `base_sha` is the DECLARED ref's tip at seal time, never
 * the manifest's setup-time snapshot, and an unresolvable ref refuses rather than falling back.
 *
 * PART 2, WP §3.6's RUN ORIGIN path. The `WORK_START` that originates a run mints its own scope's
 * identity from an `origin_key` decided ONCE per logical origin, binds that `effect_id` as its own
 * `work-run` subject (AP B5(9)), and seals material carrying NO wall-clock input. The claims:
 *
 *   - invoking one `origin_key` twice returns ONE `effect_id`, re-seals IDEMPOTENTLY, and puts
 *     BYTE-IDENTICAL material — the three legs that make a retry a retry rather than a
 *     `REQUEST_DIGEST_CONFLICT` incident and a scope hold (WP control 14);
 *   - EXACTLY ONE `work-run` binding, naming the request's own `effect_id` (B5(9) legs 2 and 3);
 *   - `workPlan` derives a stable, distinct `origin_key` per `(proposal_evidence_id, index)` and
 *     THREADS it into `startWork`, so re-running a plan converges instead of forking;
 *   - a direct start MINTS exactly one uuid, makes it durable BEFORE the first kernel call, carries
 *     it on every failure, and REUSES it verbatim when the caller retries with it;
 *   - `resource_prefix` and the v0.4 fallback's `step_ordinal` are functions of the `origin_key`
 *     alone — proved by moving `Date.now` between two invocations and comparing bytes;
 *   - `base_sha`, the one input that drifts without the clock, is resolved ONCE per origin and
 *     PINNED, so a retry after `refs/heads/main` moves seals the same bytes rather than conflicting
 *     on the identity it just converged onto — proved by moving the REF between two invocations;
 *   - the v0.4 GENERATION SEAM: a `cadp.kernel-config.v1` kernel (and a v2 bundle carrying no
 *     run-origin registry entry) still gets the zero-sentinel `cadp.allocation-key.v1` tuple and NO
 *     work-run binding, so the live v0.4 pilot's sealed request is what it is today.
 *
 * The kernel-side legs of the same mechanism — that the Ingress ADJUDICATES what this file seals as
 * a run origin, writes the `run_membership(E, E)` witness for it, and raises none of B5(3)-(5)'s
 * refusal codes on it — are cross-kernel and live in `conformance-runorigin.test.ts` PART 6.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ORIGIN_BASE_RECORD_FILE,
  ORIGIN_KEY_RECORD_FILE,
  StartWorkOriginError,
  mintOriginKey,
  originResourcePrefix,
  originStepOrdinal,
  pinOriginBaseSha,
  readOriginBaseRecords,
  readOriginKeyRecords,
  resolveBaseSha,
  startWork,
  workPlan,
  workPlanOriginKey,
} from "../live/ops.ts";
import type { StartWorkDependencies, StartWorkKernelClient } from "../live/ops.ts";
import { KernelApiError } from "../clients/kernelClient.ts";
import { jcs, sha256Hex } from "../kernel/canonical.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA } from "../kernel/policyBundle.ts";
import type { AllocationTuple, SealRequestBody } from "../kernel/ingress.ts";
import type { LiveEnvManifest } from "../live/env.ts";
import type { WorkProposalV1 } from "../product/planner.ts";
import type { ItemStatus } from "../product/driver.ts";

const SHA = "8cbc629d3adf9f29c8e21ecb69a11a7cfbcbe4f1";

// ================================================================ PART 1 — base sha

test("resolveBaseSha seals the ref tip reported by ls-remote, not any cached value", () => {
  const calls: string[][] = [];
  const sha = resolveBaseSha("owner/repo", "refs/heads/main", (cmd, args) => {
    calls.push([cmd, ...args]);
    return `${SHA}\trefs/heads/main\n`;
  });
  assert.equal(sha, SHA);
  assert.deepEqual(calls, [["git", "ls-remote", "https://github.com/owner/repo.git", "refs/heads/main"]], "exactly one resolution against the declared ref");
});

test("resolveBaseSha fails closed on an unresolvable ref (no stale-manifest fallback)", () => {
  assert.throws(
    () => resolveBaseSha("owner/repo", "refs/heads/main", () => ""),
    /refusing to seal a stale base/u,
    "empty ls-remote output (ref absent) must refuse, never fall back",
  );
  assert.throws(
    () => resolveBaseSha("owner/repo", "refs/heads/main", () => "not-a-sha\trefs/heads/main\n"),
    /refusing to seal a stale base/u,
    "garbled output must refuse",
  );
  assert.throws(
    () => resolveBaseSha("owner/repo", "refs/heads/main", () => {
      throw new Error("network unreachable");
    }),
    /network unreachable.*refusing to seal a stale base/su,
    "a resolution error must surface the cause and refuse",
  );
});

// ================================================================ PART 2 — the run origin

/**
 * What a deployment's kernel knows about `cadp.allocation-key.run-origin.v1`, which is the ONE axis
 * the origin path negotiates on:
 *  - `v0.5`             — registered, so the origin tuple allocates;
 *  - `v0.4`             — a `cadp.kernel-config.v1` kernel, whose hard-coded validation accepts
 *                         `cadp.allocation-key.v1` and refuses everything else
 *                         `ALLOCATION_TUPLE_INVALID` on the `schema` field. This is the LIVE pilot;
 *  - `v2-unregistered`  — a v2 bundle carrying no run-origin registry entry.
 */
type KernelGeneration = "v0.5" | "v0.4" | "v2-unregistered";

/**
 * A stand-in kernel implementing exactly the three behaviours these claims are about: allocation is
 * IDEMPOTENT on the canonical tuple, a re-seal of one `effect_id` with identical semantic content
 * is a no-op while a differing one is `REQUEST_DIGEST_CONFLICT`, and CAS is content addressed.
 * Everything downstream of the seal is ALLOW/COMMITTED, so a refusal here could only come from this
 * file's own path. The REAL Ingress adjudicates the same seals in `conformance-runorigin.test.ts`
 * PART 6; this stand-in is what makes the byte-level claims cheap to state.
 */
class StandInKernel {
  readonly generation: KernelGeneration;

  readonly allocationTuples: AllocationTuple[] = [];

  readonly seals: SealRequestBody[] = [];

  readonly blobs: string[] = [];

  /** effect_id → the K3 semantic payload of the row that exists for it. */
  readonly requests = new Map<string, string>();

  /** The allocation rows, shareable with a second instance to model a restart. */
  readonly allocations: Map<string, string>;

  conflicts = 0;

  /** Set to a method name to make that call fail, for the durability claims. */
  failAt: "sealEffectRequest" | undefined;

  #next = 0;

  constructor(generation: KernelGeneration = "v0.5", allocations = new Map<string, string>()) {
    this.generation = generation;
    this.allocations = allocations;
  }

  async allocateEffectId(tuple: AllocationTuple): Promise<{ effect_id: string }> {
    this.allocationTuples.push(tuple);
    if (tuple.schema === RUN_ORIGIN_ALLOCATION_SCHEMA) {
      if (this.generation === "v0.4") throw new KernelApiError(422, "ALLOCATION_TUPLE_INVALID", "schema");
      if (this.generation === "v2-unregistered") throw new KernelApiError(422, "ALLOCATION_SCHEMA_UNREGISTERED", tuple.schema);
    }
    const key = jcs(tuple);
    const existing = this.allocations.get(key);
    if (existing !== undefined) return { effect_id: existing };
    this.#next += 1;
    const effect_id = `cadp-v04:effect:0000000${this.#next}-0000-7000-8000-000000000000`;
    this.allocations.set(key, effect_id);
    return { effect_id };
  }

  async putBlob(bytes: Uint8Array): Promise<{ cas_key: string }> {
    this.blobs.push(Buffer.from(bytes).toString("utf8"));
    return { cas_key: `cas://sha256/${sha256Hex(bytes)}` };
  }

  async sealEffectRequest(body: SealRequestBody): Promise<{ request_digest: { value: string } }> {
    this.seals.push(body);
    if (this.failAt === "sealEffectRequest") throw new KernelApiError(503, "UNAVAILABLE", "stand-in kernel down");
    const { allocation_tuple: _tuple, ...draft } = body;
    const semantic = jcs({
      work_bindings: draft.work_bindings, target_ref: draft.target_ref, operation_kind: draft.operation_kind,
      material_schema: draft.material_schema, material_ref: draft.material_ref, prior_effect_refs: draft.prior_effect_refs,
    });
    const prior = this.requests.get(draft.effect_id);
    if (prior !== undefined && prior !== semantic) {
      this.conflicts += 1;
      throw new KernelApiError(422, "REQUEST_DIGEST_CONFLICT", draft.effect_id);
    }
    this.requests.set(draft.effect_id, semantic);
    return { request_digest: { value: sha256Hex(semantic) } };
  }

  async assembleAdmissionInput(effect_id: string): Promise<{ input_digest: { value: string } }> {
    return { input_digest: { value: sha256Hex(effect_id) } };
  }

  async evaluate(input_digest: string): Promise<{ kind: "DECISION"; decision: { decision_id: string; outcome: "ALLOW" } }> {
    return { kind: "DECISION", decision: { decision_id: `decision-${input_digest.slice(0, 8)}`, outcome: "ALLOW" } };
  }

  async admitAndDispatch(): Promise<{ kind: "ADMITTED"; outcome: { result: "COMMITTED" } }> {
    return { kind: "ADMITTED", outcome: { result: "COMMITTED" } };
  }

  /** Per seal: the `object_id`s bound on the kernel work-run namespace. */
  workRunBindings(): Array<{ effect_id: string; object_ids: string[] }> {
    return this.seals.map((s) => ({
      effect_id: s.effect_id,
      object_ids: s.work_bindings.filter((b) => b.namespace === "work-run").map((b) => b.object_id),
    }));
  }

  /** The `args` blob of each seal — the vertical-specific half of the sealed material. */
  argsBlobs(): string[] {
    return this.blobs.filter((b) => b.includes("\"vertical\""));
  }

  client(): StartWorkKernelClient {
    return this as unknown as StartWorkKernelClient;
  }
}

const MANIFEST = {
  repo_id: "R_kgDOtest",
  repo_full_name: "owner/repo",
  base_sha: "stale-manifest-snapshot",
} as unknown as LiveEnvManifest;

/** The non-kernel reads `startWork` performs (the temporal CLI, `git ls-remote`, docker), injected. */
function deps(kernel: StandInKernel): StartWorkDependencies {
  return {
    manifest: MANIFEST,
    client: kernel.client(),
    namespaceId: () => "namespace-1",
    resolveBase: () => SHA,
    imageIdentity: () => ({ image: "cadp-worker:test", image_digest: "sha256:feed", tool_versions: { "codex-cli": "1.0.0" } }),
    now: () => "2026-09-10T00:00:00.000Z",
  };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cadp-ops-"));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run `body` with `Date.now` pinned to `at`, so any wall-clock dependence shows up as a byte delta. */
async function atClock<T>(at: number, body: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => at;
  try {
    return await body();
  } finally {
    Date.now = real;
  }
}

const DEV = ["improve the thing", "8", "6"];
const RECORD = ["2", "6", "4"];

test("workPlan derives a stable, distinct origin_key per (proposal_evidence_id, item index)", () => {
  const proposal = "cadp-v04:evidence:01999a70-0000-7000-8000-000000000001";
  const other = "cadp-v04:evidence:01999a70-0000-7000-8000-000000000002";

  assert.equal(workPlanOriginKey(proposal, 0), workPlanOriginKey(proposal, 0), "same pair, same key — decided once, reproduced verbatim");
  assert.notEqual(workPlanOriginKey(proposal, 0), workPlanOriginKey(proposal, 1), "two items of one plan are two DISTINCT origins");
  assert.notEqual(workPlanOriginKey(proposal, 0), workPlanOriginKey(other, 0), "the same index under another proposal is another origin");

  // Injective, which is what makes "distinct origins ⇒ distinct keys" structural rather than
  // probabilistic: a kernel evidence id carries no `#`, so the pair is recoverable from the key.
  const key = workPlanOriginKey(proposal, 12);
  assert.equal(key.slice(key.lastIndexOf("#") + 1), "12");
  assert.equal(key.slice(0, key.lastIndexOf("#")).endsWith(proposal), true);

  // WP §3.6: the discriminator identifies the ORIGIN, never the work's CONTENT — nothing about the
  // repository, base revision or work item is an input to it.
  assert.equal(key.includes(SHA), false);
});

test("workPlan THREADS its derived key into startWork — one key per item, nothing minted", async () => {
  const dir = tempDir();
  const items = [
    { work_item: "item one", max_steps: 8, max_effects: 6 },
    { work_item: "item two", max_steps: 8, max_effects: 6 },
  ];
  const proposal = "cadp-v04:evidence:01999a70-0000-7000-8000-00000000000a";
  const threaded: Array<string | undefined> = [];
  const settled: ItemStatus = { status: "COMPLETED", trace: { completed: true } };

  const run = async () =>
    workPlan(dir, proposal, undefined, () => {}, {
      loadProposal: async () => ({ schema: "cadp.work-proposal.v1", items } as unknown as WorkProposalV1),
      startWork: async (_dir, _vertical, _extra, options) => {
        threaded.push(options?.originKey);
        return { effect_id: `effect-${options?.originKey ?? "none"}`, workflow_id: "wf", origin_key: options!.originKey! };
      },
      pollRun: async () => settled,
    });

  const first = await run();
  assert.deepEqual(threaded, [workPlanOriginKey(proposal, 0), workPlanOriginKey(proposal, 1)], "each item's key is the derived one");
  assert.equal(new Set(threaded).size, 2, "two items, two distinct origins");

  // Re-running the plan re-derives the SAME keys: the sealed proposal is the whole input, so the
  // driver needs no local record and the re-run converges on the same origins instead of forking.
  const second = await run();
  assert.deepEqual(threaded.slice(2), threaded.slice(0, 2), "a re-run reproduces both keys verbatim");
  assert.deepEqual(second.map((r) => r["work_run_ref"]), first.map((r) => r["work_run_ref"]), "and therefore the same effect identities");
  assert.deepEqual(first.map((r) => r["origin_key"]), [workPlanOriginKey(proposal, 0), workPlanOriginKey(proposal, 1)], "the result reports the origin it started");
  assert.equal(readOriginKeyRecords(dir).length, 0, "a derived key mints nothing, so it records nothing");
});

test("one origin_key ⇒ one effect_id, an IDEMPOTENT re-seal, and byte-identical material", async () => {
  const dir = tempDir();
  const kernel = new StandInKernel();
  const originKey = workPlanOriginKey("cadp-v04:evidence:01999a70-0000-7000-8000-00000000000b", 0);

  const first = await atClock(1_757_000_000_000, () => startWork(dir, "development", DEV, { originKey, dependencies: deps(kernel) }));
  const second = await atClock(1_757_900_000_000, () => startWork(dir, "development", DEV, { originKey, dependencies: deps(kernel) }));

  assert.notEqual(first, undefined);
  assert.equal(first!.effect_id, second!.effect_id, "the same origin re-derives the same allocation key and gets the SAME effect_id");
  assert.equal(first!.origin_key, originKey, "the result carries the origin it started");
  assert.equal(kernel.allocations.size, 1, "exactly ONE allocation row for the origin, not one per attempt");
  assert.deepEqual(kernel.allocationTuples[0], kernel.allocationTuples[1], "and the retry presents the same tuple");
  assert.deepEqual(
    kernel.allocationTuples[0],
    { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: originKey, purpose: "work-start" },
    "EXACTLY {schema, origin_key, purpose} — no work_run_ref, no step_ordinal (WP §3.6)",
  );

  assert.equal(kernel.seals.length, 2, "the retry re-presents the effect identity");
  assert.equal(kernel.conflicts, 0, "and the re-seal is IDEMPOTENT — no REQUEST_DIGEST_CONFLICT, no incident, no scope hold");
  assert.equal(kernel.requests.size, 1, "one K3 row for the origin");
  assert.equal(kernel.seals[0]!.material_ref, kernel.seals[1]!.material_ref, "the material is content-addressed to the same CAS key");
  assert.deepEqual(kernel.blobs.slice(0, 2), kernel.blobs.slice(2, 4), "and both attempts put BYTE-IDENTICAL args and material blobs");
});

test("the origin seals EXACTLY ONE work-run binding, naming its own effect_id", async () => {
  const dir = tempDir();
  const kernel = new StandInKernel();
  const started = await startWork(dir, "development", [...DEV, "cadp-v04:evidence:proposal", "codex"], {
    originKey: "origin-self-binding",
    dependencies: deps(kernel),
  });

  const bound = kernel.workRunBindings();
  assert.equal(bound.length, 1);
  assert.deepEqual(bound[0]!.object_ids, [started!.effect_id], "AP B5(9) legs 2 and 3: ONE binding on the kernel work-run pair, naming the request's OWN effect_id");
  const binding = kernel.seals[0]!.work_bindings.find((b) => b.namespace === "work-run")!;
  assert.equal(binding.authority_ref, "cadp-store:k04", "on the DECLARED kernel authority — an off-authority binding is not a work-run subject at all");
  // The rest are unchanged provenance bindings, never a second run binding.
  assert.deepEqual(kernel.seals[0]!.work_bindings.map((b) => b.namespace), ["work-item", "work-run", "work-proposal"]);
  assert.equal(kernel.seals[0]!.allocation_tuple !== undefined, true, "AP B6(1): the allocated tuple rides as transport on the seal");
});

test("the record vertical's resource_prefix is a function of its origin_key, never of the clock", async () => {
  const dir = tempDir();
  const kernel = new StandInKernel();
  const originKey = "origin-record-1";

  await atClock(1_757_000_000_000, () => startWork(dir, "record", RECORD, { originKey, dependencies: deps(kernel) }));
  await atClock(1_799_999_999_999, () => startWork(dir, "record", RECORD, { originKey, dependencies: deps(kernel) }));

  const args = kernel.argsBlobs();
  assert.equal(args.length, 2);
  assert.equal(args[0], args[1], "two attempts at one origin seal BYTE-IDENTICAL args across a moved clock");
  assert.equal(kernel.conflicts, 0, "which is why the retry is idempotent rather than a K3 conflict");
  const parsed = JSON.parse(args[0]!) as { record: { resource_prefix: string } };
  assert.equal(parsed.record.resource_prefix, originResourcePrefix(originKey));
  assert.equal(/^live-[0-9a-f]{12}$/u.test(parsed.record.resource_prefix), true, "no wall-clock remnant in the prefix");

  // Distinct origins still get distinct prefixes — what keeps two record runs off one resource,
  // now done by the origin_key rather than by the clock.
  assert.notEqual(originResourcePrefix("origin-record-2"), originResourcePrefix(originKey));
});

test("the v0.4 generation seam: the unchanged zero-sentinel tuple, a DETERMINISTIC ordinal, and no work-run binding", async () => {
  for (const generation of ["v0.4", "v2-unregistered"] as const) {
    const dir = tempDir();
    const kernel = new StandInKernel(generation);
    const originKey = "origin-v04-seam";

    const first = await atClock(1_757_000_000_000, () => startWork(dir, "development", DEV, { originKey, dependencies: deps(kernel) }));
    const second = await atClock(1_799_999_999_999, () => startWork(dir, "development", DEV, { originKey, dependencies: deps(kernel) }));

    assert.equal(kernel.allocationTuples[0]!.schema, RUN_ORIGIN_ALLOCATION_SCHEMA, `${generation}: the origin tuple is what the path presents FIRST`);
    assert.deepEqual(
      kernel.allocationTuples[1],
      {
        schema: "cadp.allocation-key.v1",
        work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
        step_ordinal: originStepOrdinal(originKey),
        purpose: "work-start",
      },
      `${generation}: the seam falls back to v0.4's tuple, byte for byte, with the ordinal now the ORIGIN's rather than the clock's`,
    );
    const ordinal = originStepOrdinal(originKey);
    assert.equal(Number.isInteger(ordinal) && ordinal >= 1, true, "POSITIVE_INTEGER, as that schema's descriptor requires");
    assert.deepEqual(
      kernel.workRunBindings(),
      [{ effect_id: first!.effect_id, object_ids: [] }, { effect_id: second!.effect_id, object_ids: [] }],
      `${generation}: no work-run binding — a v0.4 kernel expresses no run profile, and the binding would only join this effect to its own run's effect count`,
    );
    assert.deepEqual(kernel.seals[0]!.work_bindings.map((b) => b.namespace), ["work-item"], `${generation}: the live v0.4 request's bindings are what they are today`);
    assert.equal(first!.effect_id, second!.effect_id, `${generation}: the deterministic ordinal makes even the v0.4 tuple converge for one origin`);
    assert.equal(kernel.conflicts, 0, `${generation}: and the re-seal stays idempotent`);
  }
});

test("an explicit ordinalArg still overrides the v0.4 fallback ordinal, and is never presented in the origin tuple", async () => {
  const dir = tempDir();
  const v04 = new StandInKernel("v0.4");
  await startWork(dir, "development", DEV, { originKey: "origin-ordinal", ordinalArg: "77", dependencies: deps(v04) });
  assert.equal((v04.allocationTuples[1] as { step_ordinal: number }).step_ordinal, 77);

  const v05 = new StandInKernel();
  await startWork(dir, "development", DEV, { originKey: "origin-ordinal", ordinalArg: "77", dependencies: deps(v05) });
  assert.deepEqual(
    Object.keys(v05.allocationTuples[0]!).sort(),
    ["origin_key", "purpose", "schema"],
    "a step_ordinal in a run-origin tuple would be a key outside the descriptor's set (ALLOCATION_TUPLE_INVALID, AP B2(5))",
  );
});

test("a direct start MINTS one origin_key, and a failed attempt leaves it recoverable from the error, the log and the state file", async () => {
  const dir = tempDir();
  const kernel = new StandInKernel();
  kernel.failAt = "sealEffectRequest";
  const lines: Array<Record<string, unknown>> = [];

  const failure: unknown = await startWork(dir, "development", DEV, { log: (l) => lines.push(l), dependencies: deps(kernel) })
    .then(() => undefined, (e: unknown) => e);

  assert.equal(failure instanceof StartWorkOriginError, true, "the failure carries the origin's key rather than losing it");
  const thrown = failure as StartWorkOriginError;
  assert.equal(
    /^cadp-origin:v1:direct:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(thrown.origin_key),
    true,
    "minted with crypto.randomUUID",
  );
  assert.match(thrown.message, /stand-in kernel down/u, "and does not swallow the underlying failure");
  assert.match(thrown.message, /originKey/u, "the message names the exact retry");

  // EMITTED through the log and PERSISTED, both BEFORE the first kernel call — which is what makes
  // a crashed process recoverable rather than a fork on the next attempt.
  assert.deepEqual(lines.filter((l) => l["origin"] === "MINTED").map((l) => l["origin_key"]), [thrown.origin_key]);
  const records = readOriginKeyRecords(dir);
  assert.equal(records.length, 1, `one record in ${ORIGIN_KEY_RECORD_FILE}`);
  assert.equal(records[0]!.origin_key, thrown.origin_key);
  assert.equal(records[0]!.created_at, "2026-09-10T00:00:00.000Z");
  assert.equal(records[0]!.work_item_digest.includes(DEV[0]!), false, "a digest of the intent, not the intent");

  // THE RECOVERY FLOW: read the file, re-invoke with the recorded key. The allocation the failed
  // attempt already made is re-derived, so the retry converges on that effect_id instead of forking.
  const restarted = new StandInKernel("v0.5", kernel.allocations);
  const recovered = await startWork(dir, "development", DEV, {
    originKey: readOriginKeyRecords(dir)[0]!.origin_key,
    dependencies: deps(restarted),
  });

  assert.equal(recovered!.origin_key, thrown.origin_key, "the recorded key is preserved VERBATIM — no second uuid");
  assert.equal(recovered!.effect_id, kernel.allocations.get(jcs(kernel.allocationTuples[0]!)), "and derives the SAME allocation tuple, hence the same effect_id");
  assert.deepEqual(restarted.allocationTuples[0], kernel.allocationTuples[0], "the same tuple, byte for byte");
  assert.equal(restarted.allocations.size, 1, "one allocation for the logical origin across the crash");
  assert.equal(readOriginKeyRecords(dir).length, 1, "a retry carrying a key mints nothing and records nothing");
});

test("two direct starts are two DISTINCT origins, even over byte-identical work", async () => {
  const dir = tempDir();
  const kernel = new StandInKernel();
  const first = await startWork(dir, "development", DEV, { dependencies: deps(kernel) });
  const second = await startWork(dir, "development", DEV, { dependencies: deps(kernel) });

  assert.notEqual(first!.origin_key, second!.origin_key, "same repository, same base, same work item — distinct ORIGINS (WP §3.6, AP control A5 leg o-i)");
  assert.notEqual(first!.effect_id, second!.effect_id, "so two effect identities, never one collision");
  assert.equal(kernel.conflicts, 0, "which is exactly what keeps the second seal off a REQUEST_DIGEST_CONFLICT");
  assert.equal(readOriginKeyRecords(dir).length, 2, "each minted key is durable before its own first kernel call");
  assert.notEqual(mintOriginKey(), mintOriginKey(), "the mint is per-origin, never a constant");
});

test("the development origin's sealed material carries no wall-clock input", async () => {
  const dir = tempDir();
  const kernel = new StandInKernel();
  const originKey = "origin-dev-clock";
  await atClock(1_700_000_000_000, () => startWork(dir, "development", DEV, { originKey, dependencies: deps(kernel) }));
  await atClock(1_899_999_999_999, () => startWork(dir, "development", DEV, { originKey, dependencies: deps(kernel) }));

  assert.deepEqual(kernel.blobs.slice(0, 2), kernel.blobs.slice(2, 4), "args and material are byte-identical across a two-century clock move");
  assert.equal(kernel.conflicts, 0);
  // `base_sha` is the other input a retry could observe differently — not from the clock, but from
  // the ref moving. It is held fixed here and asserted stable under a MOVING ref below.
  assert.equal((JSON.parse(kernel.argsBlobs()[0]!) as { development: { base_sha: string } }).development.base_sha, SHA);
});

// ---------------------------------------------------------------- the origin's pinned base sha

/** A `refs/heads/main` that MOVES between attempts — a merge landing under a retry. */
function movingRef(shas: string[]): { resolve: () => string; calls: () => number } {
  let i = 0;
  return { resolve: () => shas[Math.min(i++, shas.length - 1)]!, calls: () => i };
}

const MOVED_SHA = "1f2e3d4c5b6a798807162534435261708091a2b3";

test("the origin's base_sha is resolved ONCE and pinned — a retry under a MOVED ref replays it", async () => {
  const dir = tempDir();
  const kernel = new StandInKernel();
  const ref = movingRef([SHA, MOVED_SHA]);
  // A derived (workPlan) origin: it re-derives its KEY from the sealed proposal, but nothing there
  // names the ref tip when the item first started, so it needs the pin exactly as a minted one does.
  const originKey = workPlanOriginKey("cadp-v04:evidence:01999a70-0000-7000-8000-00000000000c", 0);
  const dependencies = { ...deps(kernel), resolveBase: ref.resolve };

  const first = await startWork(dir, "development", DEV, { originKey, dependencies });
  const second = await startWork(dir, "development", DEV, { originKey, dependencies });

  assert.equal(ref.calls(), 1, "the ref is resolved once per ORIGIN, not once per attempt — the retry reads its pin");
  const args = kernel.argsBlobs().map((a) => JSON.parse(a) as { development: { base_sha: string } });
  assert.deepEqual(args.map((a) => a.development.base_sha), [SHA, SHA], "the retry seals the origin's FIRST-CREATION base, not the tip it would resolve now");
  assert.equal(args[0]!.development.base_sha === MOVED_SHA, false, "the moved tip is not what this origin declares");
  assert.deepEqual(kernel.blobs.slice(0, 2), kernel.blobs.slice(2, 4), "so both attempts put byte-identical args and material");
  assert.equal(first!.effect_id, second!.effect_id, "one origin, one effect identity");
  assert.equal(kernel.conflicts, 0, "and the re-seal is IDEMPOTENT — the moved ref cannot make it a REQUEST_DIGEST_CONFLICT");

  const pins = readOriginBaseRecords(dir);
  assert.deepEqual(pins.map((p) => [p.origin_key, p.base_ref, p.base_sha]), [[originKey, "refs/heads/main", SHA]], `one pin for the origin in ${ORIGIN_BASE_RECORD_FILE}`);
  assert.equal(pins[0]!.created_at, "2026-09-10T00:00:00.000Z");
  assert.equal(readOriginKeyRecords(dir).length, 0, "and a derived key still mints and records no key of its own");
});

test("the pin is per ORIGIN: distinct origins under a moving ref each declare their own base", async () => {
  const dir = tempDir();
  const kernel = new StandInKernel();
  const ref = movingRef([SHA, MOVED_SHA]);
  const dependencies = { ...deps(kernel), resolveBase: ref.resolve };

  await startWork(dir, "development", DEV, { originKey: "origin-base-a", dependencies });
  await startWork(dir, "development", DEV, { originKey: "origin-base-b", dependencies });
  await startWork(dir, "development", DEV, { originKey: "origin-base-a", dependencies });

  const sealed = kernel.argsBlobs().map((a) => (JSON.parse(a) as { development: { base_sha: string } }).development.base_sha);
  assert.deepEqual(sealed, [SHA, MOVED_SHA, SHA], "a NEW origin builds on the tip it finds; a RETRY of an existing one replays its own pin");
  assert.equal(ref.calls(), 2, "two origins, two resolutions");
  assert.deepEqual(readOriginBaseRecords(dir).map((p) => p.origin_key), ["origin-base-a", "origin-base-b"], "one record per origin, appended in creation order");
  assert.equal(kernel.conflicts, 0);
});

test("a crashed direct start pins its base before it can fail, and the recorded key replays both", async () => {
  const dir = tempDir();
  const kernel = new StandInKernel();
  kernel.failAt = "sealEffectRequest";
  const ref = movingRef([SHA, MOVED_SHA]);

  // The reviewer's scenario end to end: the first attempt dies at the seal, `refs/heads/main` moves,
  // and the operator retries from the recorded key. Identity AND material must both converge.
  const thrown = await startWork(dir, "development", DEV, { dependencies: { ...deps(kernel), resolveBase: ref.resolve } })
    .then(() => undefined, (e: unknown) => e as StartWorkOriginError);
  assert.equal(thrown instanceof StartWorkOriginError, true);

  const recorded = readOriginKeyRecords(dir)[0]!.origin_key;
  const restarted = new StandInKernel("v0.5", kernel.allocations);
  const recovered = await startWork(dir, "development", DEV, {
    originKey: recorded,
    dependencies: { ...deps(restarted), resolveBase: ref.resolve },
  });

  assert.equal(recovered!.origin_key, thrown!.origin_key, "the minted key survives the crash");
  assert.equal(ref.calls(), 1, "and so does the base it pinned — the retry never re-resolves the moved ref");
  assert.deepEqual(
    [kernel.argsBlobs()[0], restarted.argsBlobs()[0]],
    [kernel.argsBlobs()[0], kernel.argsBlobs()[0]],
    "the recovered attempt seals BYTE-IDENTICAL args to the attempt that crashed",
  );
  assert.equal(restarted.conflicts, 0, "which is what keeps the recovery off REQUEST_DIGEST_CONFLICT");
  assert.deepEqual(readOriginBaseRecords(dir).map((p) => p.base_sha), [SHA], "one pin for the logical origin across the crash");
});

test("pinning fails SAFE: a corrupt or torn pin re-resolves rather than sealing garbage or stranding the origin", () => {
  const dir = tempDir();
  const now = () => "2026-09-10T00:00:00.000Z";
  const pinFile = join(dir, ORIGIN_BASE_RECORD_FILE);

  assert.equal(pinOriginBaseSha(dir, "origin-pin", "refs/heads/main", () => SHA, now), SHA, "first creation resolves and records");
  assert.equal(pinOriginBaseSha(dir, "origin-pin", "refs/heads/main", () => MOVED_SHA, now), SHA, "and every later attempt replays it, whatever the ref says now");
  assert.equal(pinOriginBaseSha(dir, "origin-pin", "refs/heads/other", () => MOVED_SHA, now), MOVED_SHA, "the pin is per (origin, declared ref) — another ref is another base");
  assert.equal(pinOriginBaseSha(dir, "origin-other", "refs/heads/main", () => MOVED_SHA, now), MOVED_SHA, "and another origin is another base");

  // A crash mid-append and a record whose sha is not one: neither may become sealed material, and
  // neither may leave the origin permanently unretryable.
  writeFileSync(pinFile, `${JSON.stringify({ origin_key: "origin-bad", base_ref: "refs/heads/main", base_sha: "not-a-sha", created_at: now() })}\n{"origin_key":"origin-torn"`, "utf8");
  assert.deepEqual(readOriginBaseRecords(dir).map((p) => p.origin_key), ["origin-bad"], "the torn final line costs only itself");
  assert.equal(pinOriginBaseSha(dir, "origin-bad", "refs/heads/main", () => SHA, now), SHA, "a garbled pin is re-resolved, never sealed as-is");
  assert.equal(pinOriginBaseSha(dir, "origin-bad", "refs/heads/main", () => MOVED_SHA, now), SHA, "and the sound record it appends pins the origin from then on");

  rmSync(pinFile);
  assert.equal(pinOriginBaseSha(dir, "origin-pin", "refs/heads/main", () => MOVED_SHA, now), MOVED_SHA, "with no file at all it resolves — deployment-local state, the stated residual");
});
