/**
 * `cadp/live/ops.ts` at its FUNCTION SEAM — the shared live-composition operations, driven with the
 * kernel client, the manifest and every environment reader injected, so the assertions are about
 * what ops.ts constructs rather than about a live deployment.
 *
 * PART 1: `resolveBaseSha` — the fresh ref-tip resolution and its fail-closed refusals.
 *
 * PART 2: the v0.5 RUN-ORIGIN path of `startWork` (AP TD A4/A5, B5) and, first and most load-bearing
 * of all, the v0.4 REGRESSION PIN. The run-origin migration is CONDITIONAL: under the default
 * `originProfile: "v04"` the zero-sentinel `cadp.allocation-key.v1` tuple, the wall-clock
 * `step_ordinal`, the wall-clock record-vertical `resource_prefix`, the two work bindings and every
 * sealed material field are exactly what they are today, and no file under `origin-keys/` is read or
 * written. Only `originProfile: "v05"` allocates under `cadp.allocation-key.run-origin.v1`.
 *
 * The v0.5 claims asserted here: one `origin_key` derives one allocation tuple and one
 * byte-identical sealed material across retries; every environment-resolved material input is
 * resolved ONCE at origin creation and adopted from the record afterwards (the retry flips the base
 * resolver AND the worker image and still seals the identical bytes); a minted key is durable and
 * visible before anything can fail; an adopted record is argument-verified and completeness-checked
 * BEFORE the first kernel call. The cross-kernel legs — that the same tuple derives the same
 * `effect_id` through the real Ingress, that the re-seal is the idempotent no-op, and that the
 * self-referential work-run binding is adjudicated as a run origin — are in
 * `conformance-runorigin.test.ts`, where a real kernel is standing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ORIGIN_RECORD_VERSION, WorkStartOriginError, originRecordDir, originRecordPath, originResourcePrefix,
  planItemOriginKey, resolveBaseSha, startWork, workItemDigest,
} from "../live/ops.ts";
import type { StartWorkClient, StartWorkOptions } from "../live/ops.ts";
import type { LiveEnvManifest } from "../live/env.ts";
import { sha256Hex } from "../kernel/canonical.ts";

const SHA = "8cbc629d3adf9f29c8e21ecb69a11a7cfbcbe4f1";

// ================================================================= PART 1 — resolveBaseSha

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

// ================================================================= PART 2 — the run-origin path

const ZERO_SENTINEL = "cadp-v04:effect:00000000-0000-7000-8000-000000000000";
const MOVED_SHA = "1111111111111111111111111111111111111111";
const CREATED_AT = "2026-09-10T00:00:00.000Z";

const MANIFEST: LiveEnvManifest = {
  dir: "/deployment",
  api_url: "http://127.0.0.1:42000",
  root_url: "http://127.0.0.1:42001",
  api_port: 42000,
  root_port: 42001,
  record_port: 42002,
  temporal_port: 42003,
  temporal_ui_port: 42004,
  broker_port: 42005,
  repo_full_name: "owner/repo",
  repo_id: "github.com/owner/repo",
  base_sha: "0000000000000000000000000000000000000000",
  tokens: {},
  root_key_id: "root-1",
  kernel_config_path: "/deployment/kernel-config.json",
  policy_content_digest: "deadbeef",
};

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

/**
 * A stand-in Kernel that reproduces exactly the three behaviours these tests are about: allocation
 * is IDEMPOTENT ON THE TUPLE (one tuple, one effect_id), a re-seal of identical semantic content is
 * a no-op while a differing one CONFLICTS, and a second dispatch of a committed effect is refused
 * `EFFECT_ALREADY_COMMITTED`. Everything else is recorded so the assertions can read what ops.ts
 * actually sent — including the fact that a refused start sent NOTHING AT ALL.
 */
function fakeKernel(options: { failOn?: string } = {}) {
  const calls: Call[] = [];
  const blobs = new Map<string, Buffer>();
  const allocations = new Map<string, string>();
  const sealed = new Map<string, string>();
  const committed = new Set<string>();
  const client = {
    async allocateEffectId(tuple: Record<string, unknown>) {
      calls.push({ method: "allocateEffectId", payload: tuple });
      if (options.failOn === "allocateEffectId") throw new Error("kernel unreachable");
      const key = JSON.stringify(tuple);
      const existing = allocations.get(key);
      if (existing !== undefined) return { effect_id: existing };
      const effect_id = `cadp-v04:effect:${sha256Hex(key).slice(0, 24)}`;
      allocations.set(key, effect_id);
      return { effect_id };
    },
    async putBlob(bytes: Uint8Array) {
      const cas_key = `cadp-v04:cas:${sha256Hex(bytes)}`;
      calls.push({ method: "putBlob", payload: { cas_key, bytes: Buffer.from(bytes).toString("utf8") } });
      blobs.set(cas_key, Buffer.from(bytes));
      return { cas_key };
    },
    async sealEffectRequest(body: Record<string, unknown>) {
      calls.push({ method: "sealEffectRequest", payload: body });
      const effect_id = String(body["effect_id"]);
      const semantic = JSON.stringify({ ...body, allocation_tuple: undefined });
      const existing = sealed.get(effect_id);
      if (existing !== undefined && existing !== semantic) throw new Error("REQUEST_DIGEST_CONFLICT");
      sealed.set(effect_id, semantic);
      return { ...body, request_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256Hex(semantic) } };
    },
    async assembleAdmissionInput(effect_id: string, evidence_refs: string[]) {
      calls.push({ method: "assembleAdmissionInput", payload: { effect_id, evidence_refs } });
      return { input_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: `input-${effect_id}` } };
    },
    async evaluate(input_digest: string) {
      calls.push({ method: "evaluate", payload: { input_digest } });
      return { kind: "DECISION", decision: { decision_id: `decision-${input_digest}`, outcome: "ALLOW" } };
    },
    async admitAndDispatch(effect_id: string, decision_id: string) {
      calls.push({ method: "admitAndDispatch", payload: { effect_id, decision_id } });
      if (committed.has(effect_id)) return { kind: "REFUSAL", reason: "EFFECT_ALREADY_COMMITTED" };
      committed.add(effect_id);
      return { kind: "ADMITTED", admission: { effect_id }, outcome: { result: "COMMITTED" } };
    },
  };
  const of = (method: string) => calls.filter((call) => call.method === method);
  return {
    calls,
    client: client as unknown as StartWorkClient,
    of,
    /** The two blobs one start puts, in order: the workflow args, then the WORK_START material. */
    blobBytes: () => of("putBlob").map((call) => String(call.payload["bytes"])),
    sealBody: () => of("sealEffectRequest").at(-1)!.payload,
    tuple: () => of("allocateEffectId").at(-1)!.payload,
  };
}

interface Fixture {
  dir: string;
  kernel: ReturnType<typeof fakeKernel>;
  lines: Array<Record<string, unknown>>;
  /** Flipped by the pinning tests to prove the retry re-reads NOTHING from the environment. */
  env: { base_sha: string; namespace: string; minted: string[] };
  start: (vertical: "development" | "record", extra: string[], options?: Partial<StartWorkOptions>) => ReturnType<typeof startWork>;
}

function fixture(options: { failOn?: string; mint?: () => string } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "cadp-ops-"));
  writeFileSync(join(dir, "worker-image"), "cadp-worker:v1\n");
  const kernel = fakeKernel(options.failOn === undefined ? {} : { failOn: options.failOn });
  const lines: Array<Record<string, unknown>> = [];
  const env = { base_sha: SHA, namespace: "namespace-1", minted: [] as string[] };
  let mintCounter = 0;
  const fx: Fixture = {
    dir, kernel, lines, env,
    start: (vertical, extra, extraOptions = {}) =>
      startWork(dir, vertical, extra, {
        log: (line) => lines.push(line),
        ...extraOptions,
        dependencies: {
          manifest: MANIFEST,
          client: kernel.client,
          namespaceId: () => env.namespace,
          resolveBase: () => env.base_sha,
          // A stand-in for `imageIdentity`, reading the SAME `<dir>/worker-image` file the real one
          // reads, so "the worker image changed" is a genuine environment flip in these tests.
          workerImage: () => {
            const image = readFileSync(join(dir, "worker-image"), "utf8").trim();
            return { image, image_digest: `sha256:${sha256Hex(image)}`, tool_versions: { "codex-cli": image } };
          },
          mintOriginKey: options.mint ?? (() => {
            const key = `minted-key-${(mintCounter += 1)}`;
            env.minted.push(key);
            return key;
          }),
          now: () => CREATED_AT,
        },
      }),
  };
  return fx;
}

const DEV_EXTRA = ["make the thing", "8", "6", "cadp-v04:evidence:proposal-1"];

// ---------------------------------------------------------------- the v0.4 branch, pinned

test("v0.4 (the DEFAULT) allocates the zero-sentinel tuple, seals today's material, and touches no origin record", async () => {
  const fx = fixture();
  const started = await fx.start("development", DEV_EXTRA, { ordinalArg: "4242" });

  assert.deepEqual(fx.kernel.tuple(), {
    schema: "cadp.allocation-key.v1",
    work_run_ref: ZERO_SENTINEL,
    step_ordinal: 4242,
    purpose: "work-start",
  }, "the v1 zero-sentinel tuple, unchanged");

  const body = fx.kernel.sealBody();
  assert.deepEqual(body["work_bindings"], [
    { authority_ref: "github.com", namespace: "work-item", object_id: "dev:make the thing" },
    { authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: "cadp-v04:evidence:proposal-1" },
  ], "exactly the two bindings of today — NO work-run binding is added on this branch");
  assert.equal("allocation_tuple" in body, false, "no allocation tuple rides along under v1");
  assert.equal((body["target_ref"] as { target_id: string }).target_id, "namespace-1");

  const [argsBytes, materialBytes] = fx.kernel.blobBytes();
  assert.deepEqual(JSON.parse(argsBytes!), {
    vertical: "development",
    bounds: { max_steps: 8, max_effects: 6 },
    development: {
      repo_id: "github.com/owner/repo",
      repo_full_name: "owner/repo",
      base_ref: "refs/heads/main",
      base_sha: SHA,
      work_item: "make the thing",
      worker_product: "codex",
      review_product: "claude",
      external_verification: false,
      require_human_merge: true,
    },
  }, "the workflow args are byte-for-byte today's");
  assert.deepEqual(Object.keys(JSON.parse(materialBytes!) as object), [
    "workflow_id", "workflow_type", "task_queue", "args_cas_key", "args_digest", "bounds",
    "worker_profile_digest", "surface_image", "continuation_target",
  ], "the material carries exactly today's fields, in today's order");

  assert.deepEqual(Object.keys(started!), ["effect_id", "workflow_id"], "no origin_key in a v0.4 result");
  assert.equal(existsSync(originRecordDir(fx.dir)), false, "the v0.4 branch never reads or writes an origin record");
  rmSync(fx.dir, { recursive: true, force: true });
});

test("v0.4 keeps the wall-clock ordinal and the wall-clock record-vertical resource_prefix", async () => {
  const fx = fixture();
  await fx.start("record", ["2", "6", "4"]);
  const ordinal = fx.kernel.tuple()["step_ordinal"];
  assert.equal(Number.isInteger(ordinal), true);
  assert.equal((ordinal as number) >= 0 && (ordinal as number) < 1_000_000, true, "the clock-derived ordinal, unchanged");
  const args = JSON.parse(fx.kernel.blobBytes()[0]!) as { record: { resource_prefix: string } };
  assert.match(args.record.resource_prefix, /^live-\d{1,5}$/u, "the wall-clock prefix stays on the v0.4 branch");
  assert.equal(existsSync(originRecordDir(fx.dir)), false);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("v0.4 refuses an originKey rather than ignoring it, before any kernel call", async () => {
  const fx = fixture();
  await assert.rejects(
    () => fx.start("development", DEV_EXTRA, { originKey: "k-1" }),
    /originKey is a v0.5 run-origin input/u,
    "a key with no branch to mean anything on is a caller error, never a silent no-op",
  );
  assert.equal(fx.kernel.calls.length, 0, "zero kernel calls");
  assert.equal(existsSync(originRecordDir(fx.dir)), false);
  rmSync(fx.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the v0.5 origin tuple and material

test("v0.5 allocates {schema, origin_key, purpose} and binds ONE self-referential work run", async () => {
  const fx = fixture();
  const started = await fx.start("development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-alpha" });

  assert.deepEqual(fx.kernel.tuple(), {
    schema: "cadp.allocation-key.run-origin.v1",
    origin_key: "origin-alpha",
    purpose: "work-start",
  }, "exactly the three keys of WP §3.6 — no ordinal, no work_run_ref");

  const body = fx.kernel.sealBody();
  const bindings = body["work_bindings"] as Array<{ authority_ref: string; namespace: string; object_id: string }>;
  const workRun = bindings.filter((b) => b.authority_ref === "cadp-store:k04" && b.namespace === "work-run");
  assert.equal(workRun.length, 1, "EXACTLY one binding on the declared work-run pair");
  assert.equal(workRun[0]!.object_id, started!.effect_id, "and it names the allocated WORK_START's OWN effect_id");
  assert.deepEqual(body["allocation_tuple"], fx.kernel.tuple(), "the allocated tuple rides as transport (B6(1))");
  assert.equal(started!.origin_key, "origin-alpha", "the result carries the origin it converged on");
  rmSync(fx.dir, { recursive: true, force: true });
});

test("v0.5 record vertical derives resource_prefix from the origin key — no wall clock anywhere", async () => {
  const fx = fixture();
  await fx.start("record", ["2", "6", "4"], { originProfile: "v05", originKey: "origin-record" });
  const args = JSON.parse(fx.kernel.blobBytes()[0]!) as { record: { resource_prefix: string } };
  assert.equal(args.record.resource_prefix, originResourcePrefix("origin-record"));
  assert.doesNotMatch(args.record.resource_prefix, /^live-\d{1,5}$/u, "not a clock reading");
  assert.equal("step_ordinal" in fx.kernel.tuple(), false, "and no clock ordinal in the tuple");

  // The same origin re-derives the same prefix; a different origin derives a different one.
  const again = fixture();
  await again.start("record", ["2", "6", "4"], { originProfile: "v05", originKey: "origin-record" });
  assert.equal(again.kernel.blobBytes()[0], fx.kernel.blobBytes()[0], "byte-identical args for one origin");
  assert.notEqual(originResourcePrefix("origin-record-2"), originResourcePrefix("origin-record"));
  rmSync(fx.dir, { recursive: true, force: true });
  rmSync(again.dir, { recursive: true, force: true });
});

test("v0.5 refuses an ordinalArg: a clock reading in a run-origin tuple would fork the run", async () => {
  const fx = fixture();
  await assert.rejects(
    () => fx.start("development", DEV_EXTRA, { originProfile: "v05", ordinalArg: "7" }),
    /ordinalArg is a v0.4 allocation input/u,
  );
  assert.equal(fx.kernel.calls.length, 0, "zero kernel calls");
  rmSync(fx.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- material pinning across a retry

test("a retry of one origin re-seals BYTE-IDENTICAL material even though the base ref moved AND the worker image changed", async () => {
  const fx = fixture();
  const first = await fx.start("development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-pinned" });
  const firstBlobs = fx.kernel.blobBytes();
  const firstTuple = fx.kernel.tuple();

  // Flip EVERY environment seam the audit found: the resolver now reports a new tip, the
  // worker-image file names a new image, and the Temporal namespace was recreated.
  fx.env.base_sha = MOVED_SHA;
  fx.env.namespace = "namespace-2";
  writeFileSync(join(fx.dir, "worker-image"), "cadp-worker:v2\n");

  const retry = await fx.start("development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-pinned" });
  assert.deepEqual(fx.kernel.tuple(), firstTuple, "the same origin allocates the same tuple");
  assert.equal(retry!.effect_id, first!.effect_id, "…and therefore the same effect_id");
  assert.deepEqual(fx.kernel.blobBytes().slice(2), firstBlobs, "args AND material bytes are identical — nothing re-read");

  const material = JSON.parse(firstBlobs[1]!) as Record<string, unknown>;
  assert.equal((JSON.parse(firstBlobs[0]!) as { development: { base_sha: string } }).development.base_sha, SHA, "the RECORDED tip, not the moved one");
  assert.equal(material["continuation_target"], "temporal:cadp-v04:namespace-1", "the recorded namespace");
  assert.deepEqual(material["surface_image"], { image: "cadp-worker:v1", image_digest: `sha256:${sha256Hex("cadp-worker:v1")}`, tool_versions: { "codex-cli": "cadp-worker:v1" } });

  // The seal is therefore the IDEMPOTENT NO-OP: a differing material would have conflicted, and
  // the second dispatch converges on the run that already started rather than starting a second.
  const seals = fx.kernel.of("sealEffectRequest");
  assert.deepEqual(seals[1]!.payload, seals[0]!.payload, "the re-seal presents identical bytes");
  assert.deepEqual(retry, first, "the retry returns the same handle");
  rmSync(fx.dir, { recursive: true, force: true });
});

test("the origin record is written BEFORE the first kernel call, and a resolution failure writes nothing", async () => {
  const fx = fixture();
  const path = originRecordPath(fx.dir, "origin-ordering");
  const seen: boolean[] = [];
  const client = fx.kernel.client as unknown as { allocateEffectId: (tuple: unknown) => Promise<{ effect_id: string }> };
  const inner = client.allocateEffectId.bind(client);
  client.allocateEffectId = async (tuple: unknown) => {
    seen.push(existsSync(path));
    return inner(tuple);
  };
  await fx.start("development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-ordering" });
  assert.deepEqual(seen, [true], "the record already existed when the allocation was requested");

  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ["created_at", "material_inputs", "origin_key", "record_version", "vertical", "work_item_digest"]);
  assert.equal(record["record_version"], ORIGIN_RECORD_VERSION);
  assert.equal(record["origin_key"], "origin-ordering");
  assert.equal(record["work_item_digest"], workItemDigest("development", DEV_EXTRA));
  assert.deepEqual(Object.keys(record["material_inputs"] as object).sort(), [
    "base_sha", "namespace_id", "repo_full_name", "repo_id", "surface_image", "worker_profile_digest",
  ], "the COMPLETE audited environment set, persisted as one object");

  // A resolution failure writes NOTHING: no record, and no kernel call happened either, so the
  // clean retry re-resolves from scratch rather than adopting a half-pinned origin.
  const failing = fixture();
  await assert.rejects(
    () => startWork(failing.dir, "development", DEV_EXTRA, {
      originProfile: "v05",
      originKey: "origin-unresolvable",
      log: (line) => failing.lines.push(line),
      dependencies: {
        manifest: MANIFEST, client: failing.kernel.client, namespaceId: () => "namespace-1",
        resolveBase: () => { throw new Error("network unreachable"); }, now: () => CREATED_AT,
        workerImage: () => ({ image: "i", image_digest: "d", tool_versions: {} }),
      },
    }),
    /network unreachable/u,
  );
  assert.equal(existsSync(originRecordPath(failing.dir, "origin-unresolvable")), false, "no partial record");
  assert.equal(failing.kernel.calls.length, 0, "and no kernel call to be idempotent about");
  rmSync(fx.dir, { recursive: true, force: true });
  rmSync(failing.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- minted-key durability

test("a MINTED origin_key is minted once and stays recoverable through a failed start — log, error and record", async () => {
  const fx = fixture({ failOn: "allocateEffectId" });
  const failure = await fx.start("development", DEV_EXTRA, { originProfile: "v05" }).then(
    () => assert.fail("the injected kernel failure must surface"),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof WorkStartOriginError, String(failure));
  const origin_key = failure.origin_key;
  assert.deepEqual(fx.env.minted, [origin_key], "minted exactly once");
  assert.match(failure.message, new RegExp(origin_key, "u"), "the thrown error names the key a retry must reuse");

  const minted = fx.lines.find((line) => line["origin"] === "minted");
  assert.equal(minted?.["origin_key"], origin_key, "the log callback carried the key the moment it was minted");
  const path = originRecordPath(fx.dir, origin_key);
  assert.equal(minted?.["origin_record"], path);
  assert.equal(existsSync(path), true, "a crashed process leaves a recoverable record");
  assert.equal((JSON.parse(readFileSync(path, "utf8")) as { origin_key: string }).origin_key, origin_key);

  // The documented recovery flow: read the record, re-invoke with the recorded key. It derives the
  // SAME allocation tuple — the retry converges on one origin instead of forking the run.
  const failedTuple = fx.kernel.tuple();
  const recovered = fixture();
  await recovered.start("development", DEV_EXTRA, { originProfile: "v05", originKey: origin_key });
  assert.deepEqual(recovered.kernel.tuple(), failedTuple, "the recorded key derives the identical tuple");
  assert.deepEqual(recovered.env.minted, [], "and mints nothing of its own");
  rmSync(fx.dir, { recursive: true, force: true });
  rmSync(recovered.dir, { recursive: true, force: true });
});

test("a manifest/client load that FAILS still leaves the minted key recoverable (the mint precedes every environment read)", async () => {
  // The environment loads ops.ts performs for itself — `loadManifest(dir)` and `liveClient(dir, …)`
  // — are fallible, and a direct v0.5 start that ran them BEFORE minting would lose the logical
  // origin: no key logged, no key thrown, and an operator's retry minting a fresh one forks the run.
  // Driven here with a real deployment dir that has no manifest file at all, so `loadManifest` is
  // the thing that throws, exactly as it would in the live composition.
  for (const note of ["manifest", "client"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "cadp-ops-noenv-"));
    writeFileSync(join(dir, "worker-image"), "cadp-worker:v1\n");
    const lines: Array<Record<string, unknown>> = [];
    const minted: string[] = [];
    const failure = await startWork(dir, "development", DEV_EXTRA, {
      originProfile: "v05",
      log: (line) => lines.push(line),
      dependencies: {
        // `manifest` omitted ⇒ ops.ts calls `loadManifest` on a dir with no manifest; in the second
        // pass the manifest is supplied and `liveClient` is the loader left to fail.
        ...(note === "client" ? { manifest: MANIFEST } : {}),
        namespaceId: () => "namespace-1",
        resolveBase: () => SHA,
        workerImage: () => ({ image: "i", image_digest: "d", tool_versions: {} }),
        mintOriginKey: () => {
          const key = `minted-before-env-${note}`;
          minted.push(key);
          return key;
        },
        now: () => CREATED_AT,
      },
    }).then(() => assert.fail(`${note}: the environment load must fail in this fixture`), (error: unknown) => error);

    assert.ok(failure instanceof WorkStartOriginError, `${note}: ${String(failure)}`);
    assert.deepEqual(minted, [`minted-before-env-${note}`], `${note}: the key was minted before the environment was touched`);
    assert.equal(failure.origin_key, `minted-before-env-${note}`, `${note}: the throw carries the key a retry must reuse`);
    assert.match(failure.message, new RegExp(`minted-before-env-${note}`, "u"));
    const emitted = lines.find((line) => line["origin"] === "minted");
    assert.equal(emitted?.["origin_key"], `minted-before-env-${note}`, `${note}: and the log carried it too`);
    assert.equal(emitted?.["origin_record"], originRecordPath(dir, `minted-before-env-${note}`));
    // Nothing was resolved, so nothing was recorded — and nothing had to be: the recovered key
    // re-enters a clean origin below and resolves the whole audited set for the first time.
    assert.equal(existsSync(originRecordPath(dir, `minted-before-env-${note}`)), false, `${note}: a failed resolution records nothing`);

    // Recovery: the SAME key, now with the environment healthy, opens the origin it was minted for.
    const kernel = fakeKernel();
    const recovered = await startWork(dir, "development", DEV_EXTRA, {
      originProfile: "v05",
      originKey: failure.origin_key,
      dependencies: {
        manifest: MANIFEST, client: kernel.client, namespaceId: () => "namespace-1",
        resolveBase: () => SHA, workerImage: () => ({ image: "i", image_digest: "d", tool_versions: {} }),
        mintOriginKey: () => assert.fail(`${note}: a passed key must never be re-minted`),
        now: () => CREATED_AT,
      },
    });
    assert.equal(recovered?.origin_key, `minted-before-env-${note}`);
    assert.deepEqual(kernel.tuple(), {
      schema: "cadp.allocation-key.run-origin.v1",
      origin_key: `minted-before-env-${note}`,
      purpose: "work-start",
    }, `${note}: the recovered key derives the run-origin tuple of the start that failed`);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v0.4 loads the manifest and client exactly where it always has", async () => {
  // The regression pin for the deferral above: on the DEFAULT branch the environment load still
  // precedes the argument checks, so a start with both a broken environment and a bad argument
  // fails the way it does today rather than reporting the argument first.
  const dir = mkdtempSync(join(tmpdir(), "cadp-ops-v04env-"));
  await assert.rejects(
    () => startWork(dir, "development", ["item", "8", "1"], { ordinalArg: "1" }),
    (error: unknown) => {
      assert.ok(!(error instanceof WorkStartOriginError), "the v0.4 branch never wraps a failure in the origin error");
      assert.doesNotMatch(String((error as Error).message), /max_effects|floor/u, "the manifest load fails first, as today");
      return true;
    },
  );
  rmSync(dir, { recursive: true, force: true });
});

test("two direct starts that mint their own keys are two logical origins", async () => {
  const fx = fixture();
  const first = await fx.start("development", DEV_EXTRA, { originProfile: "v05" });
  const second = await fx.start("development", ["another item", "8", "6", ""], { originProfile: "v05" });
  assert.equal(fx.env.minted.length, 2, "one mint per logical origin");
  assert.notEqual(second!.effect_id, first!.effect_id);
  assert.notEqual(second!.origin_key, first!.origin_key);
  rmSync(fx.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- adoption guard and completeness

test("the same origin_key with DIFFERENT arguments throws before the kernel client is invoked", async () => {
  const fx = fixture();
  await fx.start("development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-shared" });
  const before = fx.kernel.calls.length;

  await assert.rejects(
    () => fx.start("development", ["a DIFFERENT work item", "8", "6", "cadp-v04:evidence:proposal-1"], { originProfile: "v05", originKey: "origin-shared" }),
    (error: unknown) => {
      assert.ok(error instanceof WorkStartOriginError, String(error));
      assert.match(error.message, /origin-shared/u, "names the origin_key");
      assert.match(error.message, new RegExp(workItemDigest("development", DEV_EXTRA), "u"), "names the RECORDED digest");
      assert.match(error.message, new RegExp(workItemDigest("development", ["a DIFFERENT work item", "8", "6", "cadp-v04:evidence:proposal-1"]), "u"), "names the PRESENTED digest");
      return true;
    },
  );
  assert.equal(fx.kernel.calls.length, before, "zero further kernel calls: the guard is pre-kernel");

  // A cross-VERTICAL reuse of one key is the same violation.
  await assert.rejects(
    () => fx.start("record", ["2", "6", "4"], { originProfile: "v05", originKey: "origin-shared" }),
    /already identifies a different logical origin/u,
  );
  assert.equal(fx.kernel.calls.length, before);
  rmSync(fx.dir, { recursive: true, force: true });
});

test("an INCOMPLETE or unknown-version record refuses, naming the file, with zero kernel calls", async () => {
  for (const [note, mutate] of [
    ["a deleted field", (record: Record<string, unknown>) => { delete record["created_at"]; }],
    ["a deleted material input", (record: Record<string, unknown>) => { delete (record["material_inputs"] as Record<string, unknown>)["base_sha"]; }],
    ["an extra material input", (record: Record<string, unknown>) => { (record["material_inputs"] as Record<string, unknown>)["invented"] = "x"; }],
    ["an unknown version", (record: Record<string, unknown>) => { record["record_version"] = 2; }],
    ["a null base_sha", (record: Record<string, unknown>) => { (record["material_inputs"] as Record<string, unknown>)["base_sha"] = null; }],
  ] as const) {
    const fx = fixture();
    await fx.start("development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-damaged" });
    const path = originRecordPath(fx.dir, "origin-damaged");
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    mutate(record);
    writeFileSync(path, JSON.stringify(record));
    const before = fx.kernel.calls.length;

    await assert.rejects(
      () => fx.start("development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-damaged" }),
      (error: unknown) => {
        assert.ok(error instanceof WorkStartOriginError, `${note}: ${String(error)}`);
        assert.match(error.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), `${note}: the refusal names the file`);
        return true;
      },
      `${note}: an incomplete record must never fall back to the environment`,
    );
    assert.equal(fx.kernel.calls.length, before, `${note}: zero kernel calls`);
    rmSync(fx.dir, { recursive: true, force: true });
  }

  const unparseable = fixture();
  await unparseable.start("development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-damaged" });
  writeFileSync(originRecordPath(unparseable.dir, "origin-damaged"), "{ not json");
  await assert.rejects(
    () => unparseable.start("development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-damaged" }),
    /is unparseable/u,
  );
  rmSync(unparseable.dir, { recursive: true, force: true });
});

test("a caller-passed origin_key never becomes a path component", () => {
  assert.equal(originRecordPath("/deployment", "../../etc/passwd"), join("/deployment", "origin-keys", `${sha256Hex("../../etc/passwd")}.json`));
});

// ---------------------------------------------------------------- the driver's derived keys

test("plan-item origin keys are stable and distinct by proposal_evidence_id and item index", () => {
  const a = planItemOriginKey("cadp-v04:evidence:p1", 0);
  assert.equal(a, planItemOriginKey("cadp-v04:evidence:p1", 0), "re-deriving is the same key — no state, no file");
  assert.notEqual(a, planItemOriginKey("cadp-v04:evidence:p1", 1), "a different item index is a different origin");
  assert.notEqual(a, planItemOriginKey("cadp-v04:evidence:p2", 0), "a different proposal is a different origin");
  const keys = new Set([0, 1, 2, 3].map((index) => planItemOriginKey("cadp-v04:evidence:p1", index)));
  assert.equal(keys.size, 4, "four items, four origins");
});

test("a derived plan-item key starts the same origin a direct start with that key would", async () => {
  const derived = planItemOriginKey("cadp-v04:evidence:proposal-1", 2);
  const fx = fixture();
  const started = await fx.start("development", DEV_EXTRA, { originProfile: "v05", originKey: derived });
  assert.deepEqual(fx.kernel.tuple(), {
    schema: "cadp.allocation-key.run-origin.v1",
    origin_key: derived,
    purpose: "work-start",
  });
  assert.equal(started!.origin_key, derived);
  rmSync(fx.dir, { recursive: true, force: true });
});
