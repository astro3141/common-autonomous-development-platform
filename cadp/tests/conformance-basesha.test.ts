/**
 * `cadp/live/ops.ts` conformance — the live composition's WORK_START path.
 *
 * PART 1, base resolution: the sealed `base_sha` is the declared ref's tip as `ls-remote` reports
 * it, never a cached manifest value, and every resolution problem refuses rather than seals a
 * knowingly stale base.
 *
 * PART 2, the v0.4 ALLOCATION PATH AS A REGRESSION PIN (the default branch, and the one the live
 * v0.4 deployment runs): the `cadp.allocation-key.v1` tuple with its zero-sentinel `work_run_ref`
 * and wall-clock `step_ordinal`, no presented `allocation_tuple`, no `work-run` binding, the record
 * vertical's wall-clock `resource_prefix`, and not one read or write under `origin-keys/`. Every
 * expected value here is spelled literally rather than imported from the implementation, so a change
 * to the v0.4 branch fails this file instead of agreeing with it.
 *
 * PART 3, the v0.5 RUN-ORIGIN PATH (WP §3.6, AP B1(5)/B5(9)): the `{schema, origin_key, purpose}`
 * tuple and nothing else, the single self-referential `work-run` binding, the `origin_key`-derived
 * `resource_prefix`, no `step_ordinal` anywhere, and the two replay properties the origin path lives
 * or dies by — one `origin_key` derives one `effect_id`, and one logical origin seals BYTE-IDENTICAL
 * material forever, even after the base ref moved, the worker image was rebuilt and the Temporal
 * namespace was re-read.
 *
 * PART 4, ORIGIN DURABILITY: a direct start mints its `origin_key` exactly once with
 * `crypto.randomUUID`, and a failure cannot swallow it — it is emitted through the log at mint time,
 * persisted under `origin-keys/` before the first kernel call, and carried by the thrown error. The
 * recovery flow (read the record, re-invoke with the recorded key) converges on the same allocation
 * tuple and re-seals the recorded material.
 *
 * PART 5, `workPlan`'s DERIVED keys: stable and distinct by `proposal_evidence_id` + item index, and
 * threaded into each `startWork` — the one origin path that needs no durability record for its KEY.
 *
 * The cross-kernel half of these claims — that the tuple and bindings built here are adjudicated as
 * a run origin by the real Ingress, write the one `run_membership(E, E)` witness, and re-seal as an
 * idempotent no-op with zero `KERNEL_INCIDENT` rows — is asserted in `conformance-runorigin.test.ts`
 * PART 6 against the real kernel. This file asserts what `ops.ts` itself constructs.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OriginStartFailure, WORK_RUN_BINDING_AUTHORITY, originRecordPath, originResourcePrefix, readOriginRecord,
  resolveBaseSha, startWork, workPlan, workPlanOriginKey,
} from "../live/ops.ts";
import type { StartWorkDependencies, StartWorkKernelClient, StartWorkOptions } from "../live/ops.ts";
import type { LiveEnvManifest } from "../live/env.ts";
import { jcs, sha256Hex } from "../kernel/canonical.ts";
import type { AllocationTuple, SealRequestBody } from "../kernel/ingress.ts";
import type { AdmissionInputV1, EffectRequestV1 } from "../kernel/records.ts";
import type { WorkProposalV1 } from "../product/planner.ts";

const SHA = "8cbc629d3adf9f29c8e21ecb69a11a7cfbcbe4f1";

// ============================================================ PART 1 — base resolution

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

// ============================================================ the ops test rig
//
// `startWork`'s environment seams are injected at the ONE dependency object the function exposes, so
// these cases exercise the real construction — tuple, args, material, bindings, origin record — with
// no live deployment, no git, no docker and no Temporal CLI. The kernel seam is a recording fake
// whose only modelled kernel behaviour is allocation convergence (AP B1(2): one tuple, one
// `effect_id`) and K3's idempotent re-seal; every claim that depends on more than that is asserted
// against the REAL Ingress in `conformance-runorigin.test.ts` PART 6 instead of against this fake.

const MANIFEST = { repo_id: "github.com/owner/repo", repo_full_name: "owner/repo" } as unknown as LiveEnvManifest;

const IMAGE_A = { image: "cadp-worker:a", image_digest: "sha256:aaa", tool_versions: { "codex-cli": "1.0.0" } };
const IMAGE_B = { image: "cadp-worker:b", image_digest: "sha256:bbb", tool_versions: { "codex-cli": "2.0.0" } };
const SHA_B = "1111111111111111111111111111111111111111";

interface FakeKernel {
  client: StartWorkKernelClient;
  tuples: AllocationTuple[];
  seals: SealRequestBody[];
  /** The bytes actually put for the n-th seal's `args` / `material` objects. */
  argsBytes(n: number): Uint8Array;
  materialBytes(n: number): Uint8Array;
  args(n: number): Record<string, unknown>;
  material(n: number): Record<string, unknown>;
}

function fakeKernel(options: { failAt?: "allocate" | "seal"; outcome?: "ALLOW" | "DENY" } = {}): FakeKernel {
  const blobs = new Map<string, Uint8Array>();
  const allocated = new Map<string, string>();
  const requests = new Map<string, EffectRequestV1>();
  const tuples: AllocationTuple[] = [];
  const seals: SealRequestBody[] = [];
  let minted = 0;
  const client: StartWorkKernelClient = {
    async allocateEffectId(tuple) {
      if (options.failAt === "allocate") throw new Error("injected kernel failure at allocate_effect_id");
      tuples.push(JSON.parse(JSON.stringify(tuple)) as AllocationTuple);
      const key = jcs(tuple);
      let effect_id = allocated.get(key);
      if (effect_id === undefined) {
        minted += 1;
        effect_id = `cadp-v04:effect:00000000-0000-7000-8000-${String(minted).padStart(12, "0")}`;
        allocated.set(key, effect_id);
      }
      return { effect_id };
    },
    async putBlob(bytes) {
      const cas_key = `cadp-v04:cas:${sha256Hex(bytes)}`;
      blobs.set(cas_key, Uint8Array.from(bytes));
      return { cas_key };
    },
    async sealEffectRequest(body) {
      if (options.failAt === "seal") throw new Error("injected kernel failure at seal_effect_request");
      seals.push(body);
      const existing = requests.get(body.effect_id);
      const row = existing ?? ({
        ...body,
        request_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256Hex(jcs({ material_ref: body.material_ref, work_bindings: body.work_bindings })) },
      } as unknown as EffectRequestV1);
      requests.set(body.effect_id, row);
      return row;
    },
    async assembleAdmissionInput(effect_id) {
      return { input_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: `input-${effect_id}` } } as unknown as AdmissionInputV1;
    },
    async evaluate(input_digest) {
      return { kind: "DECISION", decision: { decision_id: `decision-${input_digest}`, outcome: options.outcome ?? "ALLOW" } } as never;
    },
    async admitAndDispatch() {
      return { kind: "ADMITTED", admission: {}, outcome: { result: "COMMITTED" } } as never;
    },
  };
  const blob = (cas_key: string): Uint8Array => {
    const bytes = blobs.get(cas_key);
    assert.ok(bytes !== undefined, `blob ${cas_key} was never put`);
    return bytes;
  };
  const materialBytes = (n: number): Uint8Array => blob(seals[n]!.material_ref);
  const material = (n: number): Record<string, unknown> => JSON.parse(Buffer.from(materialBytes(n)).toString("utf8")) as Record<string, unknown>;
  const argsBytes = (n: number): Uint8Array => blob(material(n)["args_cas_key"] as string);
  return {
    client, tuples, seals, materialBytes, material, argsBytes,
    args: (n) => JSON.parse(Buffer.from(argsBytes(n)).toString("utf8")) as Record<string, unknown>,
  };
}

function deployment(): string {
  return mkdtempSync(join(tmpdir(), "cadp-ops-"));
}

function dependencies(kernel: FakeKernel, overrides: Partial<StartWorkDependencies> = {}): StartWorkDependencies {
  return {
    manifest: MANIFEST,
    client: kernel.client,
    namespaceId: () => "ns-a",
    resolveBase: () => SHA,
    workerImage: () => IMAGE_A,
    ...overrides,
  };
}

/** The dev-path `extra` vector: [work_item, max_steps, max_effects, proposal_id, …]. */
const DEV_EXTRA = ["implement thing", "8", "6"];

const V05: StartWorkOptions = { originProfile: "v05", originKey: "origin-fixed-1" };

function lines(): { log: (line: Record<string, unknown>) => void; all: Array<Record<string, unknown>> } {
  const all: Array<Record<string, unknown>> = [];
  return { log: (line) => all.push(line), all };
}

function workRunBindings(body: SealRequestBody): Array<{ authority_ref: string; namespace: string; object_id: string }> {
  return (body.work_bindings as Array<{ authority_ref: string; namespace: string; object_id: string }>)
    .filter((binding) => binding.namespace === "work-run");
}

function devArgs(kernel: FakeKernel, n: number): Record<string, unknown> {
  return (kernel.args(n) as { development: Record<string, unknown> }).development;
}

function recordPrefix(kernel: FakeKernel, n: number): string {
  return (kernel.args(n) as { record: Record<string, unknown> }).record["resource_prefix"] as string;
}

// ============================================================ PART 2 — the v0.4 path, pinned

test("v0.4 (default): the zero-sentinel tuple, the absent allocation_tuple and the absent work-run binding are exactly today's", async () => {
  const dir = deployment();
  const kernel = fakeKernel();
  const started = await startWork(dir, "development", [...DEV_EXTRA, "proposal-1"], {
    ordinalArg: "42",
    dependencies: dependencies(kernel),
  });

  assert.deepEqual(kernel.tuples, [{
    schema: "cadp.allocation-key.v1",
    work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: 42,
    purpose: "work-start",
  }], "the v0.4 zero-sentinel tuple, field for field");
  const seal = kernel.seals[0]!;
  assert.equal(seal.allocation_tuple, undefined, "v0.4 presents NO allocation_tuple — AP B6(1) transport is a v2 obligation");
  assert.deepEqual(workRunBindings(seal), [], "v0.4 seals no work-run binding at all");
  assert.deepEqual(
    (seal.work_bindings as Array<{ namespace: string }>).map((binding) => binding.namespace),
    ["work-item", "work-proposal"],
    "the v0.4 binding set is unchanged",
  );
  assert.equal(devArgs(kernel, 0)["base_sha"], SHA, "base_sha is resolved fresh on the v0.4 path");
  assert.equal(devArgs(kernel, 0)["repo_id"], MANIFEST.repo_id, "and the repo identity comes straight from the manifest");
  assert.equal(kernel.material(0)["continuation_target"], "temporal:cadp-v04:ns-a");
  assert.deepEqual(
    started,
    { effect_id: "cadp-v04:effect:00000000-0000-7000-8000-000000000001", workflow_id: "cadp-work-cadp-v04:effect:00000000-0000-7000-8000-000000000001" },
    "the v0.4 result shape is unchanged — no origin_key, no run_capability",
  );
  assert.equal(existsSync(join(dir, "origin-keys")), false, "the v0.4 branch neither reads nor writes an origin record");
});

test("v0.4 (default): an omitted ordinal is still the wall clock, and the record vertical's resource_prefix is still the wall clock", async () => {
  const dir = deployment();
  const kernel = fakeKernel();
  const before = Date.now();
  await startWork(dir, "record", ["2", "6", "4"], { dependencies: dependencies(kernel) });
  const after = Date.now();

  const ordinal = kernel.tuples[0]!["step_ordinal"] as number;
  const expected = [Math.floor(before / 1000) % 1000000, Math.floor(after / 1000) % 1000000];
  assert.ok(expected.includes(ordinal), `the clock-derived ordinal stays on the v0.4 branch (${ordinal} not in ${JSON.stringify(expected)})`);
  const prefix = recordPrefix(kernel, 0);
  assert.match(prefix, /^live-\d{1,5}$/u, "the v0.4 record prefix keeps its `live-<clock>` shape");
  const offset = Math.abs((Date.now() % 100000) - Number(prefix.slice("live-".length)));
  assert.ok(Math.min(offset, 100000 - offset) < 5000, `the v0.4 prefix is still Date.now() % 100000 (${prefix})`);
  assert.equal(existsSync(join(dir, "origin-keys")), false, "the v0.4 record vertical writes no origin record either");
});

// ============================================================ PART 3 — the v0.5 run-origin path

test("v0.5: the tuple is exactly {schema, origin_key, purpose} and is re-presented verbatim at the seal", async () => {
  const kernel = fakeKernel();
  const started = await startWork(deployment(), "development", [...DEV_EXTRA, "proposal-1"], {
    ...V05,
    dependencies: dependencies(kernel),
  });

  const tuple = kernel.tuples[0]!;
  assert.deepEqual(Object.keys(tuple).sort(), ["origin_key", "purpose", "schema"], "exactly WP §3.6's three keys — no step_ordinal, no work_run_ref, no vertical field");
  assert.equal(tuple["schema"], "cadp.allocation-key.run-origin.v1");
  assert.equal(tuple["origin_key"], "origin-fixed-1");
  assert.equal(tuple["purpose"], "work-start");
  assert.deepEqual(kernel.seals[0]!.allocation_tuple, tuple, "AP B6(1): the allocated tuple rides the seal verbatim, as transport");
  assert.equal(started?.origin_key, "origin-fixed-1", "the caller gets its origin_key back");
  assert.equal(JSON.stringify(kernel.material(0)).includes("step_ordinal"), false, "no ordinal survives anywhere in the sealed material");
});

test("v0.5: EXACTLY ONE work-run binding, on the declared pair, naming the allocated effect_id itself", async () => {
  const kernel = fakeKernel();
  const started = await startWork(deployment(), "development", [...DEV_EXTRA, "proposal-1"], {
    ...V05,
    dependencies: dependencies(kernel),
  });

  const bound = workRunBindings(kernel.seals[0]!);
  assert.equal(bound.length, 1, "AP B5(9) leg 2: exactly one binding on the declared work-run pair");
  assert.equal(bound[0]!.authority_ref, WORK_RUN_BINDING_AUTHORITY, "on the declared authority — off-authority it is no kernel work-run subject at all");
  assert.equal(bound[0]!.object_id, started?.effect_id, "AP B5(9) leg 3: the binding names this request's OWN allocated effect_id");
  assert.equal(bound[0]!.object_id, kernel.seals[0]!.effect_id);
});

test("v0.5: the same origin_key twice returns the same effect_id, and the second seal is byte-identical", async () => {
  const dir = deployment();
  const kernel = fakeKernel();
  const first = await startWork(dir, "development", [...DEV_EXTRA, "proposal-1"], { ...V05, dependencies: dependencies(kernel) });
  const second = await startWork(dir, "development", [...DEV_EXTRA, "proposal-1"], { ...V05, dependencies: dependencies(kernel) });

  assert.equal(second?.effect_id, first?.effect_id, "one origin_key, one effect_id");
  assert.deepEqual(kernel.tuples[1], kernel.tuples[0], "the re-presented tuple is the allocated one");
  assert.deepEqual(Buffer.from(kernel.argsBytes(1)), Buffer.from(kernel.argsBytes(0)), "the sealed args bytes are identical");
  assert.deepEqual(Buffer.from(kernel.materialBytes(1)), Buffer.from(kernel.materialBytes(0)), "the sealed material bytes are identical");
  assert.equal(kernel.seals[1]!.material_ref, kernel.seals[0]!.material_ref, "one material object, hence one material_digest — an idempotent re-seal, not a K3 conflict");
});

test("v0.5: EVERY environment seam may flip between attempts and the retry still seals the recorded material", async () => {
  const dir = deployment();
  const kernel = fakeKernel();
  await startWork(dir, "development", [...DEV_EXTRA, "proposal-1"], { ...V05, dependencies: dependencies(kernel) });
  // The whole audited environment moves under the origin: the base ref advanced, the worker image
  // was rebuilt (new tag, new digest, new tool versions), the Temporal namespace re-resolved.
  await startWork(dir, "development", [...DEV_EXTRA, "proposal-1"], {
    ...V05,
    dependencies: dependencies(kernel, { resolveBase: () => SHA_B, workerImage: () => IMAGE_B, namespaceId: () => "ns-b" }),
  });

  assert.equal(devArgs(kernel, 1)["base_sha"], SHA, "the retry seals the base_sha resolved at ORIGIN CREATION, never the moved tip");
  assert.deepEqual(kernel.material(1)["surface_image"], IMAGE_A, "and the image identity resolved at origin creation");
  assert.equal(kernel.material(1)["continuation_target"], "temporal:cadp-v04:ns-a", "and the namespace resolved at origin creation");
  assert.deepEqual(Buffer.from(kernel.materialBytes(1)), Buffer.from(kernel.materialBytes(0)), "byte-identical sealed material across the whole environment flip");
  assert.equal(readOriginRecord(dir, "origin-fixed-1")?.material_inputs.base_sha, SHA, "the record is immutable — the first writer's material stands");
});

test("v0.5: a retry consults NO environment seam at all", async () => {
  const dir = deployment();
  const kernel = fakeKernel();
  await startWork(dir, "development", [...DEV_EXTRA], { ...V05, dependencies: dependencies(kernel) });
  const reads = { base: 0, image: 0, namespace: 0 };
  await startWork(dir, "development", [...DEV_EXTRA], {
    ...V05,
    dependencies: dependencies(kernel, {
      resolveBase: () => { reads.base += 1; return SHA_B; },
      workerImage: () => { reads.image += 1; return IMAGE_B; },
      namespaceId: () => { reads.namespace += 1; return "ns-b"; },
    }),
  });
  assert.deepEqual(reads, { base: 0, image: 0, namespace: 0 }, "a retry with an existing record recomputes NOTHING from the environment");
});

test("v0.5 record vertical: resource_prefix is a deterministic function of the origin_key, with no wall clock", async () => {
  const dir = deployment();
  const kernel = fakeKernel();
  const record = (originKey: string) => startWork(dir, "record", ["2", "6", "4"], { originProfile: "v05", originKey, dependencies: dependencies(kernel) });
  await record("origin-rec-1");
  await record("origin-rec-1");
  await record("origin-rec-2");

  assert.equal(recordPrefix(kernel, 0), originResourcePrefix("origin-rec-1"), "the prefix is the published function of the origin_key");
  assert.equal(recordPrefix(kernel, 1), recordPrefix(kernel, 0), "two attempts at ONE origin seal the same prefix — what a wall-clock prefix can never do");
  assert.notEqual(recordPrefix(kernel, 2), recordPrefix(kernel, 0), "two DISTINCT origins still write distinct resources");
  assert.doesNotMatch(recordPrefix(kernel, 0), /^live-\d{1,5}$/u, "the wall-clock prefix is gone from this path");
  assert.deepEqual(Buffer.from(kernel.materialBytes(1)), Buffer.from(kernel.materialBytes(0)), "so the record vertical's sealed material is byte-reproducible too");
  assert.deepEqual(Object.keys(kernel.tuples[0]!).sort(), ["origin_key", "purpose", "schema"], "and the record vertical needs no development-only field (AP B2(5), WP §3.6 vertical generality)");
});

test("v0.5: an operator-supplied step ordinal is refused — the run-origin tuple has nowhere to put it", async () => {
  const kernel = fakeKernel();
  await assert.rejects(
    () => startWork(deployment(), "development", [...DEV_EXTRA], { ...V05, ordinalArg: "42", dependencies: dependencies(kernel) }),
    /carries no step_ordinal/u,
  );
  assert.deepEqual(kernel.tuples, [], "refused before any allocation");
});

test("v0.5: a retry whose ARGUMENTS changed is refused locally, before the kernel is asked to re-seal one effect_id with other bytes", async () => {
  const dir = deployment();
  const kernel = fakeKernel();
  await startWork(dir, "development", [...DEV_EXTRA], { ...V05, dependencies: dependencies(kernel) });
  const allocations = kernel.tuples.length;
  await assert.rejects(
    () => startWork(dir, "development", ["a DIFFERENT work item", "8", "6"], { ...V05, dependencies: dependencies(kernel) }),
    (error: unknown) => {
      assert.ok(error instanceof OriginStartFailure, String(error));
      assert.match(error.message, /one logical origin is one set of arguments/u);
      assert.equal(error.origin_key, "origin-fixed-1", "the refusal still names the origin");
      return true;
    },
  );
  assert.equal(kernel.tuples.length, allocations, "nothing was allocated and nothing was re-sealed");
});

// ============================================================ PART 4 — origin durability

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

test("v0.5 direct start: the minted origin_key survives a failed start in the log, the error AND the state file", async () => {
  const dir = deployment();
  const kernel = fakeKernel({ failAt: "allocate" });
  const log = lines();

  await assert.rejects(
    () => startWork(dir, "development", [...DEV_EXTRA], { originProfile: "v05", log: log.log, dependencies: dependencies(kernel) }),
    (error: unknown) => {
      assert.ok(error instanceof OriginStartFailure, String(error));
      assert.match(error.origin_key, UUID_V4, "a direct start mints with crypto.randomUUID");
      assert.ok(error.message.includes(error.origin_key), "the key is in the message, so a caller that only prints e.message still leaves it recoverable");
      assert.match((error.cause as Error).message, /injected kernel failure at allocate_effect_id/u, "and the cause is never swallowed");
      // (a) the LOG carries it, emitted at mint time — before anything below could fail.
      assert.equal(log.all.find((line) => line["origin"] === "MINTED")?.["origin_key"], error.origin_key);
      // (b) the STATE FILE carries it: a crashed process leaves a recoverable record.
      const record = readOriginRecord(dir, error.origin_key);
      assert.equal(record?.origin_key, error.origin_key, "the record was written BEFORE the first kernel call");
      assert.equal(record?.material_inputs.base_sha, SHA, "with the environment resolved exactly once");
      assert.equal(record?.vertical, "development");
      assert.equal(existsSync(originRecordPath(dir, error.origin_key)), true, "one file per origin, named by sha256(origin_key)");
      return true;
    },
  );
});

test("v0.5 recovery flow: re-invoking with the recorded key derives the same tuple and seals the recorded material", async () => {
  const dir = deployment();
  let minted: string | undefined;
  try {
    await startWork(dir, "development", [...DEV_EXTRA], { originProfile: "v05", dependencies: dependencies(fakeKernel({ failAt: "allocate" })) });
  } catch (error) {
    minted = (error as OriginStartFailure).origin_key;
  }
  assert.ok(minted !== undefined, "the first attempt failed");

  // The documented recovery: read origin-keys/<sha256(origin_key)>.json, re-invoke with that key.
  const recovered = readOriginRecord(dir, minted);
  assert.ok(recovered !== undefined);
  const kernel = fakeKernel();
  const started = await startWork(dir, "development", [...DEV_EXTRA], {
    originProfile: "v05",
    originKey: recovered.origin_key,
    // The environment has moved on since the crash; the recovery must not notice.
    dependencies: dependencies(kernel, { resolveBase: () => SHA_B, workerImage: () => IMAGE_B, namespaceId: () => "ns-b" }),
  });

  assert.deepEqual(kernel.tuples, [{ schema: "cadp.allocation-key.run-origin.v1", origin_key: minted, purpose: "work-start" }], "the recorded key derives the same allocation tuple");
  assert.equal(devArgs(kernel, 0)["base_sha"], SHA, "and the recorded base_sha, not the new tip");
  assert.deepEqual(kernel.material(0)["surface_image"], IMAGE_A, "and the recorded image identity");
  assert.equal(started?.origin_key, minted);
});

test("v0.5: the origin_key is minted EXACTLY once per invocation, and never when the caller passed one", async () => {
  const dir = deployment();
  const kernel = fakeKernel();
  let mints = 0;
  const mintOriginKey = () => { mints += 1; return `minted-${mints}`; };

  const first = await startWork(dir, "development", [...DEV_EXTRA], { originProfile: "v05", dependencies: dependencies(kernel, { mintOriginKey }) });
  assert.equal(mints, 1, "one mint per direct start");
  assert.equal(first?.origin_key, "minted-1");

  const retry = await startWork(dir, "development", [...DEV_EXTRA], { originProfile: "v05", originKey: "minted-1", dependencies: dependencies(kernel, { mintOriginKey }) });
  assert.equal(mints, 1, "a retry carrying the key mints nothing — a SECOND uuid is exactly the run fork this forbids");
  assert.equal(retry?.effect_id, first?.effect_id);
  assert.deepEqual(Buffer.from(kernel.materialBytes(1)), Buffer.from(kernel.materialBytes(0)));
});

test("v0.5: an origin record is never overwritten — a later writer ADOPTS the recorded material", async () => {
  const dir = deployment();
  const kernel = fakeKernel();
  await startWork(dir, "development", [...DEV_EXTRA], { ...V05, dependencies: dependencies(kernel) });
  const bytes = readFileSync(originRecordPath(dir, "origin-fixed-1"), "utf8");
  await startWork(dir, "development", [...DEV_EXTRA], { ...V05, dependencies: dependencies(kernel, { resolveBase: () => SHA_B }) });
  assert.equal(readFileSync(originRecordPath(dir, "origin-fixed-1"), "utf8"), bytes, "first-writer-wins, with no lock, no TTL and no reclamation");
});

test("v0.5: a foreign or corrupted origin record fails closed rather than seeding sealed material", async () => {
  const dir = deployment();
  const kernel = fakeKernel();
  await startWork(dir, "development", [...DEV_EXTRA], { ...V05, dependencies: dependencies(kernel) });
  writeFileSync(originRecordPath(dir, "origin-fixed-1"), JSON.stringify({ schema: "something.else.v1", origin_key: "origin-fixed-1" }));
  await assert.rejects(
    () => startWork(dir, "development", [...DEV_EXTRA], { ...V05, dependencies: dependencies(kernel) }),
    /is not the origin record for origin-fixed-1/u,
  );
});

// ============================================================ PART 5 — workPlan's derived keys

test("workPlanOriginKey is stable per (proposal_evidence_id, item index) and distinct across both axes", () => {
  assert.equal(workPlanOriginKey("ev-1", 0), workPlanOriginKey("ev-1", 0), "re-derived verbatim on a retry — no mint and no record needed for the KEY");
  assert.notEqual(workPlanOriginKey("ev-1", 0), workPlanOriginKey("ev-1", 1), "distinct items are distinct origins");
  assert.notEqual(workPlanOriginKey("ev-1", 0), workPlanOriginKey("ev-2", 0), "the same index of two proposals is two origins");
  assert.notEqual(workPlanOriginKey("ev-1", 3), workPlanOriginKey("ev-13", 0), "no id/index concatenation collision under the canonical encoding");
  assert.match(workPlanOriginKey("ev-1", 0), /^[0-9a-f]{64}$/u, "and a filesystem-safe hex digest");
});

test("workPlan threads the derived origin_key (and the profile) into every item's startWork", async () => {
  const proposal = {
    schema: "cadp.work-proposal.v1",
    items: [
      { work_item: "item A", max_steps: 8, max_effects: 6 },
      { work_item: "item B", max_steps: 8, max_effects: 6 },
    ],
  } as unknown as WorkProposalV1;
  const seen: StartWorkOptions[] = [];
  const planDeps = {
    loadProposal: async () => proposal,
    startWork: (async (_dir: string, _vertical: string, _extra: string[], options: StartWorkOptions) => {
      seen.push(options);
      return { effect_id: `effect-${seen.length}`, workflow_id: `wf-${seen.length}`, ...(options.originKey === undefined ? {} : { origin_key: options.originKey }) };
    }) as unknown as typeof startWork,
    pollRun: async () => ({ status: "COMPLETED" }) as never,
  };

  const results = await workPlan("/nowhere", "ev-1", undefined, undefined, { originProfile: "v05", dependencies: planDeps });
  assert.deepEqual(seen.map((options) => options.originKey), [workPlanOriginKey("ev-1", 0), workPlanOriginKey("ev-1", 1)], "each item's derived key, by index");
  assert.deepEqual(seen.map((options) => options.originProfile), ["v05", "v05"]);
  assert.equal(results[0]?.["origin_key"], workPlanOriginKey("ev-1", 0), "and each result reports the origin it ran");

  // A re-run of the same proposal re-derives the same keys: one logical origin per item, forever.
  seen.length = 0;
  await workPlan("/nowhere", "ev-1", undefined, undefined, { originProfile: "v05", dependencies: planDeps });
  assert.deepEqual(seen.map((options) => options.originKey), [workPlanOriginKey("ev-1", 0), workPlanOriginKey("ev-1", 1)]);

  // And the DEFAULT profile threads nothing: the live v0.4 driver is unchanged.
  seen.length = 0;
  await workPlan("/nowhere", "ev-1", undefined, undefined, { dependencies: planDeps });
  assert.deepEqual(seen.map((options) => options.originKey), [undefined, undefined]);
  assert.deepEqual(seen.map((options) => options.originProfile), ["v04", "v04"]);
});
