/**
 * The live-ops START PATH (`cadp/live/ops.ts`), in two parts.
 *
 * PART 1: `resolveBaseSha` — the seal-time base resolution and its fail-closed refusals.
 *
 * PART 2: AP TD A4/A5 and B5's ORIGIN PROFILES of `startWork`/`workPlan`, and the conformance of
 * each. `"v04"` is the DEFAULT and is the live v0.4 deployment's behaviour byte for byte — the
 * `cadp.allocation-key.v1` zero-sentinel tuple with its wall-clock `step_ordinal`, the clock-derived
 * record-vertical `resource_prefix`, no `work-run` binding, no allocation tuple at the seal, and no
 * contact of any kind with `origin-keys.json`; it is pinned here as a REGRESSION so the migration
 * cannot quietly move it. `"v05"` is the run-origin path: allocation under
 * `cadp.allocation-key.run-origin.v1` keyed by a stable `origin_key`, exactly one self-referential
 * `work-run` binding, an origin-derived `resource_prefix`, no clock, and the MATERIAL-PINNING
 * invariant — one logical origin is one `effect_id` sealed over ONE material byte-string, whatever
 * the environment did between attempts.
 *
 * The Kernel is a scripted client here, exactly as `harness.ts` scripts a target: it implements the
 * allocation's converge-on-the-same-tuple rule and the Ingress's re-seal semantics (identical
 * semantic content ⇒ idempotent no-op; any difference ⇒ `REQUEST_DIGEST_CONFLICT`), which is what
 * makes "the retry is a no-op" a real assertion rather than a restatement. The cross-kernel legs —
 * that what this path seals IS an adjudicated run origin, writes `run_membership(E, E)`, mints once
 * at its own dispatch and raises none of the run-profile refusal codes — are in
 * `conformance-runorigin.test.ts`, against the real Ingress and PEP.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OriginStartFailure, originKeysPath, originRecord, originResourcePrefix, planOriginKey,
  readOriginRecords, resolveBaseSha, runOriginTuple, startWork, withOriginLock, workPlan,
} from "../live/ops.ts";
import type { StartWorkDependencies, SurfaceImage } from "../live/ops.ts";
import type { LiveEnvManifest } from "../live/env.ts";
import { jcsDigest, sha256Hex } from "../kernel/canonical.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA } from "../kernel/policyBundle.ts";
import type { WorkProposalV1 } from "../product/planner.ts";
import type { ItemStatus } from "../product/driver.ts";

const SHA = "8cbc629d3adf9f29c8e21ecb69a11a7cfbcbe4f1";

// ================================================================ PART 1 — resolveBaseSha

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

// ================================================================ PART 2 — the origin profiles

const ZERO_SENTINEL = "cadp-v04:effect:00000000-0000-7000-8000-000000000000";
const NAMESPACE = "ns-live-0001";
const IMAGE: SurfaceImage = { image: "cadp-surface:test", image_digest: "sha256:aaaa", tool_versions: { "codex-cli": "1.0.0" } };
const IMAGE_REBUILT: SurfaceImage = { image: "cadp-surface:test", image_digest: "sha256:bbbb", tool_versions: { "codex-cli": "2.0.0" } };
const MOVED_SHA = "1111111111111111111111111111111111111111";

const MANIFEST = {
  dir: "/live",
  api_url: "http://127.0.0.1:1",
  repo_id: "9001",
  repo_full_name: "owner/live-target",
  base_sha: "0".repeat(40),
  tokens: {},
} as unknown as LiveEnvManifest;

/**
 * A scripted Kernel API with the two behaviours this path's identity claims are stated over: one
 * allocation tuple derives one `effect_id` for the store's lifetime, and a re-seal of identical
 * semantic content is an idempotent no-op while ANY difference is `REQUEST_DIGEST_CONFLICT`.
 */
class ScriptedKernel {
  readonly allocations = new Map<string, string>();

  readonly blobs = new Map<string, string>();

  readonly tuples: Array<Record<string, unknown>> = [];

  readonly seals: Array<Record<string, unknown>> = [];

  readonly requests = new Map<string, string>();

  reseals = 0;

  /** Injected transport failure: the method name to throw on, as a crashed process would. */
  failAt: string | undefined;

  #next = 0;

  #maybeFail(method: string): void {
    if (this.failAt === method) throw new Error(`injected ${method} failure`);
  }

  async allocateEffectId(tuple: Record<string, unknown>): Promise<{ effect_id: string }> {
    this.#maybeFail("allocateEffectId");
    this.tuples.push(tuple);
    const key = jcsDigest(tuple).value;
    const existing = this.allocations.get(key);
    if (existing !== undefined) return { effect_id: existing };
    const effect_id = `cadp-v04:effect:scripted-${(this.#next += 1)}`;
    this.allocations.set(key, effect_id);
    return { effect_id };
  }

  async putBlob(bytes: Uint8Array): Promise<{ cas_key: string }> {
    this.#maybeFail("putBlob");
    const text = Buffer.from(bytes).toString("utf8");
    const cas_key = `cadp-v04:cas:${sha256Hex(text)}`;
    this.blobs.set(cas_key, text);
    return { cas_key };
  }

  async sealEffectRequest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.#maybeFail("sealEffectRequest");
    this.seals.push(body);
    const semantic = JSON.stringify({
      requester_ref: body["requester_ref"],
      work_bindings: body["work_bindings"],
      target_ref: body["target_ref"],
      operation_kind: body["operation_kind"],
      material_schema: body["material_schema"],
      material: this.blobs.get(body["material_ref"] as string),
      prior_effect_refs: body["prior_effect_refs"],
    });
    const effect_id = body["effect_id"] as string;
    const existing = this.requests.get(effect_id);
    if (existing !== undefined) {
      if (existing !== semantic) throw new Error(`REQUEST_DIGEST_CONFLICT for ${effect_id}`);
      this.reseals += 1;
      return { effect_id, request_digest: { value: sha256Hex(existing) } };
    }
    this.requests.set(effect_id, semantic);
    return { effect_id, request_digest: { value: sha256Hex(semantic) } };
  }

  async assembleAdmissionInput(effect_id: string): Promise<Record<string, unknown>> {
    this.#maybeFail("assembleAdmissionInput");
    return { input_digest: { value: `input-${effect_id}` } };
  }

  async evaluate(input_digest: string): Promise<Record<string, unknown>> {
    this.#maybeFail("evaluate");
    return { kind: "DECISION", decision: { decision_id: `decision-${input_digest}`, outcome: "ALLOW" } };
  }

  async admitAndDispatch(effect_id: string): Promise<Record<string, unknown>> {
    this.#maybeFail("admitAndDispatch");
    return { kind: "ADMITTED", admission: { effect_id }, outcome: { result: "COMMITTED" } };
  }

  sealOf(effect_id: string): Record<string, unknown> {
    const seal = this.seals.find((entry) => entry["effect_id"] === effect_id);
    assert.ok(seal !== undefined, `no seal for ${effect_id}`);
    return seal;
  }

  /** The sealed material BYTES, which is what "byte-reproducible for a given origin" is about. */
  materialBytesOf(effect_id: string): string {
    return this.blobs.get(this.sealOf(effect_id)["material_ref"] as string)!;
  }

  argsBytesOf(effect_id: string): string {
    const material = JSON.parse(this.materialBytesOf(effect_id)) as { args_cas_key: string };
    return this.blobs.get(material.args_cas_key)!;
  }
}

function deployment(): string {
  const dir = mkdtempSync(join(tmpdir(), "cadp-live-ops-"));
  writeFileSync(join(dir, "worker-image"), `${IMAGE.image}\n`);
  return dir;
}

function scriptedDeps(kernel: ScriptedKernel, overrides: Partial<StartWorkDependencies> = {}): StartWorkDependencies {
  return {
    manifest: MANIFEST,
    client: kernel as unknown as StartWorkDependencies["client"],
    resolveBase: () => SHA,
    resolveImage: () => IMAGE,
    resolveNamespace: () => NAMESPACE,
    now: () => "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function readOriginKeys(dir: string): unknown[] {
  return JSON.parse(readFileSync(originKeysPath(dir), "utf8")) as unknown[];
}

/** Run `fn` with the wall clock pinned, so a clock-derived field is a DETERMINISTIC expectation. */
async function atClock<T>(nowMs: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => nowMs;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

const DEV_EXTRA = ["implement median", "8", "6", "cadp-v04:evidence:p-1"];
const RECORD_EXTRA = ["2", "6", "4"];

// ---------------------------------------------------------------- the v0.4 regression pin

test("v0.4 profile (the default): the zero-sentinel tuple, the clock ordinal and today's material, byte for byte", async () => {
  const kernel = new ScriptedKernel();
  const dir = deployment();
  const CLOCK = 1_757_462_400_000; // a fixed wall clock, so the clock-derived fields are exact
  const started = await atClock(CLOCK, () => startWork(dir, "development", DEV_EXTRA, { dependencies: scriptedDeps(kernel) }));
  assert.ok(started !== undefined);
  assert.equal(started.origin_key, undefined, "the v0.4 path originates no key at all");

  // The tuple: v1, the zero sentinel, the wall-clock ordinal — exactly what it is today.
  assert.deepEqual(kernel.tuples, [{
    schema: "cadp.allocation-key.v1",
    work_run_ref: ZERO_SENTINEL,
    step_ordinal: Math.floor(CLOCK / 1000) % 1000000,
    purpose: "work-start",
  }]);

  // The sealed args, pinned as the exact byte-string (`args_cas_key` is a digest of these bytes).
  assert.equal(
    kernel.argsBytesOf(started.effect_id),
    `{"vertical":"development","bounds":{"max_steps":8,"max_effects":6},"development":{"repo_id":"9001","repo_full_name":"owner/live-target","base_ref":"refs/heads/main","base_sha":"${SHA}","work_item":"implement median","worker_product":"codex","review_product":"claude","external_verification":false,"require_human_merge":true}}`,
  );
  const material = JSON.parse(kernel.materialBytesOf(started.effect_id)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(material), [
    "workflow_id", "workflow_type", "task_queue", "args_cas_key", "args_digest",
    "bounds", "worker_profile_digest", "surface_image", "continuation_target",
  ], "the material field set and its order are unchanged");
  assert.equal(material["workflow_id"], `cadp-work-${started.effect_id}`);
  assert.equal(material["continuation_target"], `temporal:cadp-v04:${NAMESPACE}`);
  assert.deepEqual(material["surface_image"], IMAGE);

  // The seal: the work-item binding and its proposal provenance, NO work-run binding, and no
  // allocation tuple presented (a v1 deployment's allocation row carries no binding to check).
  const seal = kernel.sealOf(started.effect_id);
  assert.deepEqual(seal["work_bindings"], [
    { authority_ref: "github.com", namespace: "work-item", object_id: "dev:implement median" },
    { authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: "cadp-v04:evidence:p-1" },
  ]);
  assert.equal(Object.hasOwn(seal, "allocation_tuple"), false, "the v0.4 seal presents no tuple");
  assert.deepEqual(seal["target_ref"], { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: NAMESPACE });

  // And the record vertical's clock-derived prefix, likewise unmoved. A DIFFERENT second, because
  // the v1 tuple distinguishes two starts by nothing but that clock reading — the second-granular
  // collision this branch keeps, and the one the origin path replaces with a stable `origin_key`.
  const RECORD_CLOCK = CLOCK + 1000;
  const record = await atClock(RECORD_CLOCK, () => startWork(dir, "record", RECORD_EXTRA, { dependencies: scriptedDeps(kernel) }));
  assert.ok(record !== undefined);
  assert.equal(
    kernel.argsBytesOf(record.effect_id),
    `{"vertical":"record","bounds":{"max_steps":6,"max_effects":4},"record":{"tenant":"cadp-disposable","resource_prefix":"live-${RECORD_CLOCK % 100000}","payloads":["live payload 1","live payload 2"]}}`,
  );
  assert.deepEqual(kernel.sealOf(record.effect_id)["work_bindings"], [
    { authority_ref: "github.com", namespace: "work-item", object_id: "record:2" },
  ]);

  // The v0.4 branch never writes the origin state file.
  assert.equal(existsSync(originKeysPath(dir)), false, "no origin-keys.json on the v0.4 path");
});

test("v0.4 profile: an origin_key is INERT — the file is never read, and the clock still supplies the ordinal", async () => {
  const kernel = new ScriptedKernel();
  const dir = deployment();
  // A pre-existing record whose pinned base_sha is NOT what the resolver returns. If the v0.4
  // branch read this file, the sealed base would be the recorded one.
  const seeded = `${JSON.stringify([{
    origin_key: "seeded",
    work_item_digest: sha256Hex("implement median"),
    material_inputs: { temporal_namespace_id: "ns-other", surface_image: IMAGE_REBUILT, worker_profile_digest: "wp-other", base_sha: MOVED_SHA, repo_id: "1", repo_full_name: "other/repo" },
    created_at: "2026-01-01T00:00:00.000Z",
  }], null, 2)}\n`;
  writeFileSync(originKeysPath(dir), seeded);

  const first = await atClock(1_757_462_400_000, () => startWork(dir, "development", DEV_EXTRA, { originKey: "seeded", dependencies: scriptedDeps(kernel) }));
  const second = await atClock(1_757_462_401_000, () => startWork(dir, "development", DEV_EXTRA, { originKey: "seeded", dependencies: scriptedDeps(kernel) }));
  assert.ok(first !== undefined && second !== undefined);
  assert.notEqual(first.effect_id, second.effect_id, "the v1 tuple's clock ordinal is the identity — one start per call");
  assert.equal(JSON.parse(kernel.argsBytesOf(first.effect_id)).development.base_sha, SHA, "the resolver, not the record");
  assert.equal(readFileSync(originKeysPath(dir), "utf8"), seeded, "the v0.4 branch neither read nor wrote the file");
  assert.equal(kernel.tuples[0]!["schema"], "cadp.allocation-key.v1");
});

// ---------------------------------------------------------------- the v0.5 run-origin path

test("v0.5: one origin_key ⇒ one effect_id, one self-referential work-run binding, and an idempotent re-seal", async () => {
  const kernel = new ScriptedKernel();
  const dir = deployment();
  const originKey = "origin-fixed-1";
  const start = () => startWork(dir, "development", DEV_EXTRA, { originProfile: "v05", originKey, dependencies: scriptedDeps(kernel) });

  const first = await atClock(1_757_462_400_000, start);
  const second = await atClock(1_757_999_999_000, start); // a later wall clock: nothing may depend on it
  assert.ok(first !== undefined && second !== undefined);

  // A5 leg o-ii: the same origin converges on the same effect identity.
  assert.equal(second.effect_id, first.effect_id, "invoking the same origin_key twice returns the same effect_id");
  assert.equal(first.origin_key, originKey, "the result carries the origin key");

  // WP §3.6's wire shape, exactly three members, on BOTH invocations.
  const expectedTuple = { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: originKey, purpose: "work-start" };
  assert.deepEqual(kernel.tuples, [expectedTuple, expectedTuple]);
  assert.deepEqual(Object.keys(kernel.tuples[0]!), ["schema", "origin_key", "purpose"], "no step_ordinal, no work_run_ref");
  assert.deepEqual(runOriginTuple(originKey), expectedTuple);

  // The sealed material is byte-identical, so the re-seal is the idempotent no-op and never the
  // REQUEST_DIGEST_CONFLICT a differing re-seal of one effect_id would be.
  assert.equal(kernel.materialBytesOf(first.effect_id), kernel.materialBytesOf(second.effect_id));
  assert.equal(kernel.seals[0]!["material_ref"], kernel.seals[1]!["material_ref"], "one material, one CAS key");
  assert.deepEqual(kernel.seals[0], kernel.seals[1], "the whole seal body repeats byte for byte");
  assert.equal(kernel.reseals, 1, "the second seal was the idempotent no-op");
  assert.equal(kernel.requests.size, 1, "exactly one sealed request");

  // B5(9) legs 2 and 3: EXACTLY ONE work-run binding, naming the WORK_START's own effect_id.
  const bindings = kernel.sealOf(first.effect_id)["work_bindings"] as Array<Record<string, string>>;
  const workRun = bindings.filter((b) => b.namespace === "work-run");
  assert.equal(workRun.length, 1, "exactly one work-run binding");
  assert.deepEqual(workRun[0], { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: first.effect_id });
  assert.equal(bindings.filter((b) => b.namespace === "work-item").length, 1, "the work-item binding is preserved");
  assert.deepEqual(kernel.sealOf(first.effect_id)["allocation_tuple"], expectedTuple, "B6(1): the tuple rides as transport");
});

test("v0.5: EVERY environment seam re-resolved differently on the retry — the origin still seals byte-identically", async () => {
  const kernel = new ScriptedKernel();
  const dir = deployment();
  const originKey = "origin-pinned-1";

  const first = await startWork(dir, "development", DEV_EXTRA, {
    originProfile: "v05", originKey,
    dependencies: scriptedDeps(kernel),
  });
  assert.ok(first !== undefined);
  const material = kernel.materialBytesOf(first.effect_id);

  // The whole environment moves under the retry: the ref advanced, the image was rebuilt (both the
  // file and the daemon's answer), and the namespace read differs. NONE of them may be consulted.
  writeFileSync(join(dir, "worker-image"), "cadp-surface:rebuilt\n");
  let resolverCalls = 0;
  let imageCalls = 0;
  let namespaceCalls = 0;
  const retry = await startWork(dir, "development", DEV_EXTRA, {
    originProfile: "v05", originKey,
    dependencies: scriptedDeps(kernel, {
      resolveBase: () => { resolverCalls += 1; return MOVED_SHA; },
      resolveImage: () => { imageCalls += 1; return IMAGE_REBUILT; },
      resolveNamespace: () => { namespaceCalls += 1; return "ns-moved"; },
    }),
  });
  assert.ok(retry !== undefined);
  assert.equal(retry.effect_id, first.effect_id, "the same origin, the same effect identity");
  assert.deepEqual([resolverCalls, imageCalls, namespaceCalls], [0, 0, 0], "the retry recomputes NOTHING from the environment");
  assert.equal(kernel.materialBytesOf(retry.effect_id), material, "byte-identical sealed material");
  assert.equal(JSON.parse(kernel.argsBytesOf(retry.effect_id)).development.base_sha, SHA, "the RECORDED base_sha, not the moved tip");
  assert.deepEqual(JSON.parse(material).surface_image, IMAGE, "the RECORDED image identity");
  assert.equal(JSON.parse(material).continuation_target, `temporal:cadp-v04:${NAMESPACE}`, "the RECORDED namespace");
  assert.equal(kernel.reseals, 1, "the re-seal is the idempotent no-op, not a REQUEST_DIGEST_CONFLICT");

  // The record itself: the complete resolved material-input set, resolved once at origin creation.
  const record = originRecord(dir, originKey);
  assert.equal(record?.work_item_digest, sha256Hex("implement median"));
  assert.deepEqual(record?.material_inputs, {
    temporal_namespace_id: NAMESPACE,
    surface_image: IMAGE,
    worker_profile_digest: JSON.parse(material).worker_profile_digest,
    base_sha: SHA,
    repo_id: "9001",
    repo_full_name: "owner/live-target",
  });
  assert.equal(readOriginKeys(dir).length, 1, "one logical origin, one appended record");
});

test("v0.5: a FAILED direct start leaves its minted origin_key recoverable, and the retry reuses it", async () => {
  const kernel = new ScriptedKernel();
  const dir = deployment();
  const lines: Array<Record<string, unknown>> = [];
  kernel.failAt = "allocateEffectId"; // the FIRST Kernel call: everything durable must precede it

  const failure = await startWork(dir, "development", DEV_EXTRA, {
    originProfile: "v05", log: (line) => lines.push(line), dependencies: scriptedDeps(kernel),
  }).then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof OriginStartFailure, `expected an OriginStartFailure, got ${String(failure)}`);
  const minted = failure.origin_key;

  // (a) the error carries it, (b) the log emitted it the moment it was minted, and (c) the state
  // file holds it — with the material inputs already pinned, written BEFORE the failing call.
  assert.ok(failure.message.includes(minted), "the message names the key");
  const mintedLines = lines.filter((line) => line["origin"] === "minted");
  assert.deepEqual(mintedLines.map((line) => line["origin_key"]), [minted], "emitted exactly once, through the log callback");
  assert.equal(kernel.tuples.length, 0, "no allocation happened: the record precedes the first Kernel call");
  const record = originRecord(dir, minted);
  assert.equal(record?.origin_key, minted);
  assert.equal(record?.material_inputs.base_sha, SHA);

  // THE RECOVERY FLOW: read origin-keys.json, re-invoke with the recorded key. It mints nothing.
  kernel.failAt = undefined;
  const recovered = (readOriginKeys(dir)[0] as { origin_key: string }).origin_key;
  assert.equal(recovered, minted);
  const retry = await startWork(dir, "development", DEV_EXTRA, {
    originProfile: "v05", originKey: recovered, log: (line) => lines.push(line), dependencies: scriptedDeps(kernel),
  });
  assert.ok(retry !== undefined);
  assert.equal(retry.origin_key, minted, "the retry converges on the SAME key — no second UUID");
  assert.deepEqual(kernel.tuples, [runOriginTuple(minted)], "the allocation tuple carries the recovered key");
  assert.equal(lines.filter((line) => line["origin"] === "minted").length, 1, "minted exactly once across both invocations");
  assert.equal(readOriginKeys(dir).length, 1, "the retry appends nothing: the first record wins");

  // A start that is NOT a retry mints its own, distinct key — the mint is per logical origin.
  const other = await startWork(dir, "development", DEV_EXTRA, { originProfile: "v05", dependencies: scriptedDeps(kernel) });
  assert.ok(other !== undefined);
  assert.notEqual(other.origin_key, minted);
  assert.notEqual(other.effect_id, retry.effect_id, "a different logical origin is a different effect identity");
});

test("v0.5: the record vertical's resource_prefix is a function of the origin_key, and no wall clock is read", async () => {
  const kernel = new ScriptedKernel();
  const dir = deployment();
  const originKey = "origin-record-1";
  const start = (key: string) => startWork(dir, "record", RECORD_EXTRA, { originProfile: "v05", originKey: key, dependencies: scriptedDeps(kernel) });

  // Two invocations of one origin, at wall clocks twelve days apart.
  const first = await atClock(1_757_462_400_000, () => start(originKey));
  const second = await atClock(1_758_500_000_000, () => start(originKey));
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(second.effect_id, first.effect_id);
  assert.equal(
    kernel.argsBytesOf(first.effect_id),
    `{"vertical":"record","bounds":{"max_steps":6,"max_effects":4},"record":{"tenant":"cadp-disposable","resource_prefix":"${originResourcePrefix(originKey)}","payloads":["live payload 1","live payload 2"]}}`,
  );
  assert.equal(kernel.argsBytesOf(second.effect_id), kernel.argsBytesOf(first.effect_id), "no clock anywhere in the sealed args");
  assert.equal(kernel.reseals, 1);
  assert.doesNotMatch(originResourcePrefix(originKey), /^live-\d{1,5}$/u, "not the clock-shaped prefix");

  // Distinct origins are distinct prefixes, so two runs never collide on the record service.
  const other = await start("origin-record-2");
  assert.ok(other !== undefined);
  assert.notEqual(JSON.parse(kernel.argsBytesOf(other.effect_id)).record.resource_prefix, originResourcePrefix(originKey));
  assert.equal(JSON.parse(kernel.argsBytesOf(other.effect_id)).record.resource_prefix, originResourcePrefix("origin-record-2"));
});

// ---------------------------------------------------------------- workPlan's derived origin keys

test("workPlan derives a stable, distinct origin_key per (proposal, item index)", () => {
  const p1 = "cadp-v04:evidence:proposal-1";
  const p2 = "cadp-v04:evidence:proposal-2";
  assert.equal(planOriginKey(p1, 0), planOriginKey(p1, 0), "the derivation is stable — a re-run needs no file record");
  assert.notEqual(planOriginKey(p1, 0), planOriginKey(p1, 1), "distinct by item index");
  assert.notEqual(planOriginKey(p1, 0), planOriginKey(p2, 0), "distinct by proposal");
});

test("workPlan: each item starts under its own derived origin, and a re-run converges item-for-item", async () => {
  const kernel = new ScriptedKernel();
  const dir = deployment();
  const proposalId = "cadp-v04:evidence:proposal-1";
  const proposal = {
    schema: "cadp.work-proposal.v1",
    items: [
      { work_item: "implement median", max_steps: 8, max_effects: 6 },
      { work_item: "document median", max_steps: 6, max_effects: 4 },
    ],
  } as unknown as WorkProposalV1;
  const settled = { status: "COMPLETED" } as unknown as ItemStatus;

  const first = await workPlan(dir, proposalId, undefined, () => {}, {
    originProfile: "v05",
    dependencies: scriptedDeps(kernel),
    loadProposal: async () => proposal,
    settle: async () => settled,
  });
  assert.deepEqual(first.map((entry) => entry["origin_key"]), [planOriginKey(proposalId, 0), planOriginKey(proposalId, 1)]);
  assert.deepEqual(
    kernel.tuples.map((tuple) => tuple["origin_key"]),
    [planOriginKey(proposalId, 0), planOriginKey(proposalId, 1)],
    "each item allocates under its OWN origin",
  );
  assert.notEqual(first[0]!["work_run_ref"], first[1]!["work_run_ref"], "two items, two runs");

  // A re-run of the same plan: the derived keys converge on the same effect identities, and every
  // re-seal is an idempotent no-op — even though the base ref moved and the image was rebuilt.
  writeFileSync(join(dir, "worker-image"), "cadp-surface:rebuilt\n");
  const second = await workPlan(dir, proposalId, undefined, () => {}, {
    originProfile: "v05",
    dependencies: scriptedDeps(kernel, { resolveBase: () => MOVED_SHA, resolveImage: () => IMAGE_REBUILT }),
    loadProposal: async () => proposal,
    settle: async () => settled,
  });
  assert.deepEqual(second.map((entry) => entry["work_run_ref"]), first.map((entry) => entry["work_run_ref"]));
  assert.equal(kernel.reseals, 2, "both items re-sealed as no-ops");
  assert.equal(kernel.requests.size, 2);
  assert.equal(readOriginKeys(dir).length, 2, "one record per logical origin, appended once");
});

// ---------------------------------------------------------------- the origin file's durability
//
// The pinning invariant is only as durable as the file that carries it: a lost or torn record sends
// the origin it belonged to straight back to the environment on its retry, which is the
// REQUEST_DIGEST_CONFLICT the whole path exists to prevent. So the file's write discipline —
// exclusive lock around the read-modify-write, atomic rename to publish — is a conformance property
// of this path, asserted here against real concurrent processes rather than argued from the code.

/** One child start per key: it pins its origin, then dies at the first Kernel call, as a crash would. */
const CONCURRENT_CHILD = `
const { startWork } = await import(process.argv[2]);
const [dir, label, count] = process.argv.slice(3);
const failing = { async allocateEffectId() { throw new Error("the child dies at the first Kernel call"); } };
const dependencies = {
  manifest: { repo_id: "9001", repo_full_name: "owner/live-target" },
  client: failing,
  resolveImage: () => ({ image: "cadp-surface:test", image_digest: "sha256:aaaa", tool_versions: {} }),
  resolveNamespace: () => "ns-live-0001",
  now: () => "2026-09-10T00:00:00.000Z",
};
for (let i = 0; i < Number(count); i += 1) {
  await startWork(dir, "record", ["2", "6", "4"], {
    originProfile: "v05", originKey: label + "-" + i, dependencies,
  }).catch(() => {});
}
`;

function runChild(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, new URL("../live/ops.ts", import.meta.url).href, ...args], (error) => (error ? reject(error) : resolve()));
  });
}

test("origin-keys.json: concurrent starts in separate processes lose no pinned origin", async () => {
  const dir = deployment();
  const script = join(dir, "concurrent-start.mjs");
  writeFileSync(script, CONCURRENT_CHILD);
  const CHILDREN = 4;
  const PER_CHILD = 8;

  // Real processes, genuinely interleaved: an unlocked read-modify-write publishes one writer's
  // array over another's and drops the difference on the floor.
  await Promise.all(Array.from({ length: CHILDREN }, (_, i) => runChild(script, [dir, `child${i}`, String(PER_CHILD)])));

  const records = readOriginRecords(dir);
  const keys = new Set(records.map((entry) => entry.origin_key));
  const expected = Array.from({ length: CHILDREN }, (_, c) => Array.from({ length: PER_CHILD }, (_, i) => `child${c}-${i}`)).flat();
  assert.equal(records.length, expected.length, "every concurrently pinned origin survived");
  for (const key of expected) assert.ok(keys.has(key), `origin ${key} was lost by a concurrent writer`);
  for (const record of records) {
    assert.equal(record.material_inputs.temporal_namespace_id, "ns-live-0001", "and survived whole, not half-written");
  }

  // Nothing is left behind for the next start to trip over.
  const leftovers = readdirSync(dir).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no lock or temp file outlives the writes");
});

test("origin-keys.json: the lock is exclusive, released on throw, and reclaimed only when stale", () => {
  const dir = deployment();
  const lock = `${originKeysPath(dir)}.lock`;

  // A live holder: the waiter refuses rather than writing the file unlocked.
  writeFileSync(lock, `${JSON.stringify({ pid: 999_999 })}\n`);
  let entered = 0;
  assert.throws(
    () => withOriginLock(dir, () => { entered += 1; }, { waitMs: 50 }),
    /is held by another start.*refusing to write origin records unlocked/su,
  );
  assert.equal(entered, 0, "the critical section was never entered");

  // The same lock, now provably older than any live critical section: it is a dead holder's, and is
  // reclaimed — otherwise one crashed start would wedge the deployment's origins forever.
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lock, old, old);
  withOriginLock(dir, () => { entered += 1; }, { waitMs: 50 });
  assert.equal(entered, 1, "a stale lock is broken and the section runs");
  assert.equal(existsSync(lock), false, "and the lock is released afterwards");

  // A critical section that throws still releases: the next caller must not inherit a wedged lock.
  assert.throws(() => withOriginLock(dir, () => { throw new Error("boom"); }), /boom/u);
  assert.equal(existsSync(lock), false, "released on the failure path too");
  withOriginLock(dir, () => { entered += 1; }, { waitMs: 50 });
  assert.equal(entered, 2);
});

test("origin-keys.json: the publish is atomic — a torn temp file never becomes the record file", async () => {
  const kernel = new ScriptedKernel();
  const dir = deployment();
  const first = await startWork(dir, "record", RECORD_EXTRA, { originProfile: "v05", originKey: "origin-atomic-1", dependencies: scriptedDeps(kernel) });
  assert.ok(first !== undefined);
  const pinned = readFileSync(originKeysPath(dir), "utf8");

  // A previous process died between its write and its rename, leaving half a JSON array behind.
  // It is a temp file, not the record file, so it is invisible to every reader.
  writeFileSync(`${originKeysPath(dir)}.99999.tmp`, '[{"origin_key":"half-writ');
  assert.equal(readFileSync(originKeysPath(dir), "utf8"), pinned, "the published file is untouched by the debris");
  assert.equal(readOriginRecords(dir).length, 1);

  // And the next start publishes over it by rename, leaving a whole file and a whole record set.
  const second = await startWork(dir, "record", RECORD_EXTRA, { originProfile: "v05", originKey: "origin-atomic-2", dependencies: scriptedDeps(kernel) });
  assert.ok(second !== undefined);
  assert.notEqual(second.effect_id, first.effect_id);
  assert.deepEqual(readOriginRecords(dir).map((entry) => entry.origin_key), ["origin-atomic-1", "origin-atomic-2"]);
  assert.equal(existsSync(`${originKeysPath(dir)}.${process.pid}.tmp`), false, "this process's temp file is renamed away, never left");

  // The v0.4 branch still touches none of this machinery.
  const v04dir = deployment();
  await atClock(1_757_462_400_000, () => startWork(v04dir, "record", RECORD_EXTRA, { dependencies: scriptedDeps(kernel) }));
  assert.deepEqual(readdirSync(v04dir), ["worker-image"], "no origin file, no lock, no temp file on the v0.4 path");
});
