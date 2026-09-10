/**
 * The live-composition `ops.ts` conformance file: how a WORK_START's sealed material is FIXED.
 *
 * Part one is the base-ref resolution itself (`resolveBaseSha`). Part two, below it, is AP B5's
 * run-origin migration of the same path: the CONDITIONAL v0.4/v0.5 split, one `origin_key` → one
 * `effect_id` → one byte string of sealed material, the origin record that pins every
 * environment-derived material input at origin creation, and the guards that keep an adopted
 * record from silently becoming another origin's.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { originRecordPath, resolveBaseSha, startWork, workPlan, workPlanOriginKey } from "../live/ops.ts";
import type { StartWorkDependencies } from "../live/ops.ts";
import type { LiveEnvManifest } from "../live/env.ts";
import { jcs, jcsDigest, sha256Hex } from "../kernel/canonical.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA } from "../kernel/policyBundle.ts";

const SHA = "8cbc629d3adf9f29c8e21ecb69a11a7cfbcbe4f1";

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

// ==================================================== AP B5/A4/A5 — the run-origin migration of ops.ts

const MOVED_SHA = "b".repeat(40);

const MANIFEST: LiveEnvManifest = {
  dir: "unused", api_url: "http://kernel.invalid", root_url: "http://root.invalid",
  api_port: 1, root_port: 2, record_port: 3, temporal_port: 4, temporal_ui_port: 5, broker_port: 6,
  repo_full_name: "owner/repo", repo_id: "123", base_sha: "0".repeat(40), tokens: {},
  root_key_id: "root", kernel_config_path: "unused", policy_content_digest: "digest",
};

const IMAGE = { image: "cadp-surface:0.151.0", image_digest: "sha256:aaaa", tool_versions: { "codex-cli": "1.0.0" } };
/** The SAME tag, rebuilt: the seam the base_sha-only pin missed (a re-read here also conflicts). */
const IMAGE_REBUILT = { image: "cadp-surface:0.151.0", image_digest: "sha256:bbbb", tool_versions: { "codex-cli": "2.0.0" } };

const DEV_EXTRA = ["implement median", "8", "6", "", "codex", "", ""];

/**
 * A kernel stand-in that keeps the two rules this file's claims rest on: `allocate_effect_id` is a
 * FUNCTION of the tuple (AP B1(2): one tuple, one effect_id, forever), and `seal_effect_request` is
 * idempotent on identical semantic content and a `REQUEST_DIGEST_CONFLICT` on anything else
 * (TD §3.3). Every call is counted, so "before any kernel call" is an assertion and not a comment.
 */
function fakeKernel(options: { deny?: boolean; failAllocate?: boolean; observe?: () => void } = {}) {
  const calls: string[] = [];
  const blobs = new Map<string, string>();
  const tuples: Array<Record<string, unknown>> = [];
  const seals: Array<Record<string, unknown>> = [];
  const stored = new Map<string, { semantic: string; row: Record<string, unknown> }>();
  const counters = { reseals: 0 };
  const semanticOf = (body: Record<string, unknown>): string =>
    jcs({
      requester_ref: body["requester_ref"],
      work_bindings: body["work_bindings"],
      target_ref: body["target_ref"],
      operation_kind: body["operation_kind"],
      material_schema: body["material_schema"],
      material_digest: sha256Hex(blobs.get(body["material_ref"] as string) ?? ""),
      material_ref: body["material_ref"],
      prior_effect_refs: body["prior_effect_refs"],
    });
  const client = {
    async allocateEffectId(tuple: Record<string, unknown>) {
      calls.push("allocateEffectId");
      options.observe?.();
      tuples.push(tuple);
      if (options.failAllocate === true) throw new Error("kernel unreachable");
      return { effect_id: `cadp-v04:effect:${jcsDigest(tuple).value.slice(0, 32)}` };
    },
    async putBlob(bytes: Uint8Array) {
      calls.push("putBlob");
      const cas_key = `sha256:${sha256Hex(bytes)}`;
      blobs.set(cas_key, Buffer.from(bytes).toString("utf8"));
      return { cas_key };
    },
    async sealEffectRequest(body: Record<string, unknown>) {
      calls.push("sealEffectRequest");
      seals.push(body);
      const semantic = semanticOf(body);
      const existing = stored.get(body["effect_id"] as string);
      if (existing !== undefined) {
        counters.reseals += 1;
        if (existing.semantic !== semantic) throw new Error("REQUEST_DIGEST_CONFLICT");
        return existing.row;
      }
      const row = { ...body, request_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256Hex(semantic) } };
      stored.set(body["effect_id"] as string, { semantic, row });
      return row;
    },
    async assembleAdmissionInput() {
      calls.push("assembleAdmissionInput");
      return { input_digest: { value: "input-digest" } };
    },
    async evaluate() {
      calls.push("evaluate");
      return options.deny === true
        ? { kind: "DECISION", decision: { decision_id: "d1", outcome: "DENY", reasons: ["TEST_DENY"] } }
        : { kind: "DECISION", decision: { decision_id: "d1", outcome: "ALLOW" } };
    },
    async admitAndDispatch() {
      calls.push("admitAndDispatch");
      return { kind: "ADMITTED", admission: {}, outcome: { result: "COMMITTED" } };
    },
  };
  return { calls, blobs, tuples, seals, counters, client: client as unknown as NonNullable<StartWorkDependencies["client"]> };
}

type Kernel = ReturnType<typeof fakeKernel>;

/** The two CAS objects one start sealed, as the exact strings that went into the store. */
function sealedBytes(k: Kernel, index = 0): { args: string; material: string; bindings: Array<Record<string, string>> } {
  const body = k.seals[index]!;
  const material = k.blobs.get(body["material_ref"] as string)!;
  const args = k.blobs.get((JSON.parse(material) as { args_cas_key: string }).args_cas_key)!;
  return { args, material, bindings: body["work_bindings"] as Array<Record<string, string>> };
}

function deps(k: Kernel, overrides: Partial<StartWorkDependencies> = {}): StartWorkDependencies {
  return {
    manifest: MANIFEST,
    client: k.client,
    namespaceId: () => "namespace-1",
    resolveBase: () => SHA,
    workerImage: () => IMAGE,
    ...overrides,
  };
}

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cadp-origin-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the v0.4 branch, pinned unchanged

test("v0.4 is the DEFAULT and its allocation, material and record prefix are today's, byte for byte", async () => {
  await withDir(async (dir) => {
    const k = fakeKernel();
    const before = Math.floor(Date.now() / 1000) % 1000000;
    const started = await startWork(dir, "development", DEV_EXTRA, {}, deps(k));
    const after = Math.floor(Date.now() / 1000) % 1000000;

    // The zero-sentinel tuple under a CLOCK-derived ordinal: unchanged, and NOT the run-origin one.
    const tuple = k.tuples[0]!;
    assert.deepEqual(Object.keys(tuple).sort(), ["purpose", "schema", "step_ordinal", "work_run_ref"]);
    assert.equal(tuple["schema"], "cadp.allocation-key.v1");
    assert.equal(tuple["work_run_ref"], "cadp-v04:effect:00000000-0000-7000-8000-000000000000");
    assert.equal(tuple["purpose"], "work-start");
    assert.ok((tuple["step_ordinal"] as number) >= before && (tuple["step_ordinal"] as number) <= after, "the clock ordinal stays the clock ordinal here");

    const sealed = sealedBytes(k);
    assert.equal(
      sealed.args,
      '{"vertical":"development","bounds":{"max_steps":8,"max_effects":6},"development":{"repo_id":"123","repo_full_name":"owner/repo",'
        + `"base_ref":"refs/heads/main","base_sha":"${SHA}","work_item":"implement median","worker_product":"codex","review_product":"claude",`
        + '"external_verification":false,"require_human_merge":true}}',
      "the v0.4 args object is byte-identical, key order included",
    );
    const material = JSON.parse(sealed.material) as Record<string, unknown>;
    assert.deepEqual(Object.keys(material), [
      "workflow_id", "workflow_type", "task_queue", "args_cas_key", "args_digest", "bounds", "worker_profile_digest", "surface_image", "continuation_target",
    ]);
    assert.equal(material["workflow_id"], `cadp-work-${started!.effect_id}`);
    assert.equal(material["continuation_target"], "temporal:cadp-v04:namespace-1");
    assert.deepEqual(material["surface_image"], IMAGE);

    // No work-run binding, no allocation tuple transport, no origin_key in the result.
    assert.deepEqual(sealed.bindings, [{ authority_ref: "github.com", namespace: "work-item", object_id: "dev:implement median" }]);
    assert.equal(k.seals[0]!["allocation_tuple"], undefined);
    assert.equal(started!.origin_key, undefined);
    // The v0.4 branch never touches the origin-record store.
    assert.equal(existsSync(join(dir, "origin-keys")), false, "no origin record is written on the v0.4 path");
  });
});

test("v0.4 keeps the clock-derived record resource_prefix and the explicit ordinal override", async () => {
  await withDir(async (dir) => {
    const k = fakeKernel();
    await startWork(dir, "record", ["2", "6", "4"], { ordinalArg: "77" }, deps(k));
    assert.equal(k.tuples[0]!["step_ordinal"], 77, "an explicit ordinal is still honoured");
    const args = JSON.parse(sealedBytes(k).args) as { record: { resource_prefix: string } };
    assert.match(args.record.resource_prefix, /^live-\d{1,5}$/u, "the record prefix stays `live-${Date.now() % 100000}`");
    assert.equal(existsSync(join(dir, "origin-keys")), false);
  });
});

test("v0.4 ignores an origin_key and never reads an origin record that exists", async () => {
  await withDir(async (dir) => {
    // A complete, valid record for this key, deliberately carrying a DIFFERENT base_sha: if the
    // default branch consulted it at all, the sealed base would be the recorded one.
    const key = "an-origin-key";
    const first = fakeKernel();
    await startWork(dir, "development", DEV_EXTRA, { originProfile: "v05", originKey: key }, deps(first, { resolveBase: () => MOVED_SHA }));
    const recordText = readFileSync(originRecordPath(dir, key), "utf8");

    const k = fakeKernel();
    await startWork(dir, "development", DEV_EXTRA, { originKey: key }, deps(k));
    assert.equal(k.tuples[0]!["schema"], "cadp.allocation-key.v1", "the key is inert under v04");
    const args = JSON.parse(sealedBytes(k).args) as { development: { base_sha: string } };
    assert.equal(args.development.base_sha, SHA, "v0.4 resolves the base fresh; it does not adopt the record");
    assert.equal(readFileSync(originRecordPath(dir, key), "utf8"), recordText, "and it writes nothing back");
  });
});

// ---------------------------------------------------------------- the v0.5 origin path

test("A5 o-ii: the same origin_key twice is one effect_id, one seal, one byte string of material", async () => {
  await withDir(async (dir) => {
    const k = fakeKernel();
    const options = { originProfile: "v05" as const, originKey: "origin-alpha" };
    const first = await startWork(dir, "development", DEV_EXTRA, options, deps(k));
    const second = await startWork(dir, "development", DEV_EXTRA, options, deps(k));

    assert.equal(first!.effect_id, second!.effect_id, "one logical origin, one effect_id");
    assert.equal(first!.origin_key, "origin-alpha");
    assert.equal(second!.origin_key, "origin-alpha");
    assert.deepEqual(k.tuples[0], { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: "origin-alpha", purpose: "work-start" });
    assert.deepEqual(k.tuples[1], k.tuples[0]);
    // Exactly the three keys of WP §3.6 — no run reference and NO step_ordinal, so no wall clock
    // is anywhere in the effect identity.
    assert.deepEqual(Object.keys(k.tuples[0]!).sort(), ["origin_key", "purpose", "schema"]);

    const a = sealedBytes(k, 0);
    const b = sealedBytes(k, 1);
    assert.equal(a.args, b.args, "identical args bytes");
    assert.equal(a.material, b.material, "identical material bytes");
    assert.equal(k.counters.reseals, 1, "the second seal is the idempotent no-op, not a new request");
    // A different origin_key is a different logical origin even with identical arguments (leg o-i).
    const other = await startWork(dir, "development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-beta" }, deps(k));
    assert.notEqual(other!.effect_id, first!.effect_id);
  });
});

test("B5(9): the v0.5 seal carries EXACTLY one work-run binding, naming its own effect_id", async () => {
  await withDir(async (dir) => {
    const k = fakeKernel();
    const started = await startWork(
      dir,
      "development",
      ["implement median", "8", "6", "cadp-v04:evidence:proposal-1", "codex", "", ""],
      { originProfile: "v05", originKey: "origin-binding" },
      deps(k),
    );
    const bindings = sealedBytes(k).bindings;
    const workRun = bindings.filter((b) => b.namespace === "work-run");
    assert.equal(workRun.length, 1, "exactly one work-run binding");
    assert.deepEqual(workRun[0], { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: started!.effect_id });
    // The provenance bindings are unchanged and are not work-run pairs.
    assert.deepEqual(bindings.filter((b) => b.namespace !== "work-run"), [
      { authority_ref: "github.com", namespace: "work-item", object_id: "dev:implement median" },
      { authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: "cadp-v04:evidence:proposal-1" },
    ]);
    // B6(1): the tuple rides back as transport, which a v2 first seal requires.
    assert.deepEqual(k.seals[0]!["allocation_tuple"], k.tuples[0]);
  });
});

test("the record vertical's v0.5 resource_prefix is a function of the origin_key, with no clock in it", async () => {
  await withDir(async (dir) => {
    const k = fakeKernel();
    const prefixOf = async (key: string, index: number): Promise<string> => {
      await startWork(dir, "record", ["2", "6", "4"], { originProfile: "v05", originKey: key }, deps(k));
      return (JSON.parse(sealedBytes(k, index).args) as { record: { resource_prefix: string } }).record.resource_prefix;
    };
    const one = await prefixOf("origin-record-1", 0);
    const again = await prefixOf("origin-record-1", 1);
    const other = await prefixOf("origin-record-2", 2);
    assert.match(one, /^live-[0-9a-f]{8}$/u, "hex of the origin_key, never digits of the clock");
    assert.equal(again, one, "the same origin names the same resources on every retry");
    assert.notEqual(other, one, "a different origin names different resources");
    assert.equal(k.counters.reseals, 1, "and the retry is still the idempotent no-op");
  });
});

test("the v0.5 path refuses an ordinalArg: the run-origin tuple carries no step_ordinal", async () => {
  await withDir(async (dir) => {
    const k = fakeKernel();
    await assert.rejects(
      startWork(dir, "development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-ordinal", ordinalArg: "5" }, deps(k)),
      /ordinalArg has no meaning/u,
    );
    assert.deepEqual(k.calls, [], "refused before any kernel call");
  });
});

// ---------------------------------------------------------------- minting, durability and recovery

test("A4: a direct start mints its origin_key ONCE, and a failed start leaves it recoverable", async () => {
  await withDir(async (dir) => {
    let mints = 0;
    const mint = () => {
      mints += 1;
      return "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    };
    const failing = fakeKernel({ failAllocate: true });
    const lines: Array<Record<string, unknown>> = [];
    const thrown = await startWork(
      dir,
      "development",
      DEV_EXTRA,
      { originProfile: "v05", log: (line) => lines.push(line) },
      deps(failing, { newOriginKey: mint }),
    ).then(() => undefined, (error: unknown) => error as Error & { origin_key?: string });

    assert.equal(mints, 1, "minted exactly once");
    const key = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    // Three independent recovery surfaces, all populated before the failure could happen.
    assert.equal(thrown?.origin_key, key, "the thrown error carries the key");
    assert.match(String(thrown?.message), /kernel unreachable/u, "and the original cause");
    assert.match(String(thrown?.message), new RegExp(key, "u"), "and names the key in its message");
    assert.equal(lines[0]!["origin_key"], key, "the log emitted the key before anything ran");
    assert.equal(lines[0]!["origin_key_source"], "MINTED");
    const record = JSON.parse(readFileSync(originRecordPath(dir, key), "utf8")) as Record<string, unknown>;
    assert.equal(record["origin_key"], key, "the state file survived the crash");
    assert.equal((record["material_inputs"] as { base_sha: string }).base_sha, SHA);

    // The documented recovery: re-invoke with the recorded key. It converges — the SAME allocation
    // tuple, hence the same effect_id, rather than a fresh UUID forking the run.
    const k = fakeKernel();
    const recovered = await startWork(dir, "development", DEV_EXTRA, { originProfile: "v05", originKey: key }, deps(k, { newOriginKey: mint }));
    assert.equal(mints, 1, "the retry mints nothing");
    assert.deepEqual(k.tuples[0], failing.tuples[0], "the same allocation tuple as the failed attempt");
    assert.equal(recovered!.origin_key, key);
  });
});

test("the origin record is written BEFORE the first kernel call, and the mint is a UUID", async () => {
  await withDir(async (dir) => {
    let keyAtAllocation: string | undefined;
    let recordedAtAllocation = false;
    const k = fakeKernel({ observe: () => { recordedAtAllocation = keyAtAllocation !== undefined && existsSync(originRecordPath(dir, keyAtAllocation)); } });
    const lines: Array<Record<string, unknown>> = [];
    const started = await startWork(
      dir,
      "development",
      DEV_EXTRA,
      { originProfile: "v05", log: (line) => { lines.push(line); keyAtAllocation ??= line["origin_key"] as string; } },
      deps(k),
    );
    assert.match(started!.origin_key!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, "crypto.randomUUID");
    assert.equal(recordedAtAllocation, true, "the record already existed when the first kernel call was made");
  });
});

// ---------------------------------------------------------------- the material-pinning invariant

test("a retry rebuilds the material from the RECORD: every environment seam flipped, same bytes", async () => {
  await withDir(async (dir) => {
    const k = fakeKernel();
    const options = { originProfile: "v05" as const, originKey: "origin-pinned" };
    await startWork(dir, "development", DEV_EXTRA, options, deps(k));
    const first = sealedBytes(k, 0);

    // EVERY seam the audit found, moved underneath the retry at once: main advanced, the worker
    // image was rebuilt under the same tag, the Temporal namespace was re-created, and the
    // manifest now names another repository.
    let reresolved = 0;
    const retry = await startWork(dir, "development", DEV_EXTRA, options, deps(k, {
      manifest: { ...MANIFEST, repo_id: "999", repo_full_name: "someone/else" },
      resolveBase: () => { reresolved += 1; return MOVED_SHA; },
      workerImage: () => { reresolved += 1; return IMAGE_REBUILT; },
      namespaceId: () => { reresolved += 1; return "namespace-2"; },
    }));

    assert.equal(reresolved, 0, "the retry recomputed NOTHING from the environment");
    const second = sealedBytes(k, 1);
    assert.equal(second.args, first.args, "args bytes identical");
    assert.equal(second.material, first.material, "material bytes identical");
    assert.match(first.args, new RegExp(SHA, "u"), "and they still carry the recorded base_sha");
    assert.equal(k.counters.reseals, 1, "the re-seal is the idempotent no-op, never REQUEST_DIGEST_CONFLICT");
    assert.deepEqual(k.tuples[1], k.tuples[0]);
    assert.equal(retry!.effect_id, JSON.parse(first.material).workflow_id.replace("cadp-work-", ""));
  });
});

test("a first-time origin resolves each environment field exactly once and records all of them", async () => {
  await withDir(async (dir) => {
    const k = fakeKernel();
    const counts = { base: 0, image: 0, namespace: 0 };
    await startWork(dir, "development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-once" }, deps(k, {
      resolveBase: () => { counts.base += 1; return SHA; },
      workerImage: () => { counts.image += 1; return IMAGE; },
      namespaceId: () => { counts.namespace += 1; return "namespace-1"; },
    }));
    assert.deepEqual(counts, { base: 1, image: 1, namespace: 1 });
    const record = JSON.parse(readFileSync(originRecordPath(dir, "origin-once"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), ["created_at", "material_inputs", "origin_key", "record_version", "vertical", "work_item_digest"]);
    assert.equal(record["record_version"], 1);
    assert.deepEqual(record["material_inputs"], {
      repo_id: "123", repo_full_name: "owner/repo", base_sha: SHA, worker_image: IMAGE, temporal_namespace_id: "namespace-1",
    }, "the COMPLETE audited set, not just base_sha");
  });
});

test("the record vertical records base_sha as null — it declares no base, and none is resolved", async () => {
  await withDir(async (dir) => {
    const k = fakeKernel();
    let resolved = 0;
    await startWork(dir, "record", ["2", "6", "4"], { originProfile: "v05", originKey: "origin-rec" }, deps(k, {
      resolveBase: () => { resolved += 1; return SHA; },
    }));
    assert.equal(resolved, 0);
    const record = JSON.parse(readFileSync(originRecordPath(dir, "origin-rec"), "utf8")) as { material_inputs: { base_sha: null } };
    assert.equal(record.material_inputs.base_sha, null);
  });
});

// ---------------------------------------------------------------- adoption guards

test("the same origin_key with DIFFERENT arguments is refused before any kernel call", async () => {
  await withDir(async (dir) => {
    const k = fakeKernel();
    await startWork(dir, "development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-guard" }, deps(k));
    const callsAfterFirst = k.calls.length;

    for (const [note, extra] of [
      ["another work item", ["implement mode", "8", "6", "", "codex", "", ""]],
      ["another bound", ["implement median", "9", "6", "", "codex", "", ""]],
      ["another worker product", ["implement median", "8", "6", "", "grok", "", ""]],
    ] as const) {
      await assert.rejects(
        startWork(dir, "development", [...extra], { originProfile: "v05", originKey: "origin-guard" }, deps(k)),
        (error: unknown) => {
          const message = (error as Error).message;
          assert.match(message, /origin-guard/u, `${note}: names the origin_key`);
          assert.match(message, /recorded work_item_digest [0-9a-f]{64}, presented [0-9a-f]{64}/u, `${note}: names both digests`);
          return true;
        },
        note,
      );
    }
    assert.equal(k.calls.length, callsAfterFirst, "the injected client saw ZERO further calls");

    // The complementary leg: the same key with the same arguments still adopts and converges.
    const same = await startWork(dir, "development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-guard" }, deps(k));
    assert.deepEqual(k.tuples[1], k.tuples[0]);
    assert.equal(same!.origin_key, "origin-guard");
  });
});

test("the same origin_key under another vertical is refused too", async () => {
  await withDir(async (dir) => {
    const k = fakeKernel();
    await startWork(dir, "development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-vertical" }, deps(k));
    const calls = k.calls.length;
    await assert.rejects(
      startWork(dir, "record", ["2", "6", "4"], { originProfile: "v05", originKey: "origin-vertical" }, deps(k)),
      /was created for the development vertical, presented as record/u,
    );
    assert.equal(k.calls.length, calls, "zero kernel calls");
  });
});

test("an INCOMPLETE or unknown-version record fails closed, naming the file, with zero kernel calls", async () => {
  await withDir(async (dir) => {
    const k = fakeKernel();
    await startWork(dir, "development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-broken" }, deps(k));
    const path = originRecordPath(dir, "origin-broken");
    const good = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const calls = k.calls.length;

    const damaged: Array<[string, unknown]> = [
      ["a deleted top-level field", (() => { const c = { ...good }; delete c["created_at"]; return c; })()],
      ["a deleted material input", (() => {
        const c = JSON.parse(JSON.stringify(good)) as { material_inputs: Record<string, unknown> };
        delete c.material_inputs["temporal_namespace_id"];
        return c;
      })()],
      ["a deleted worker-image member", (() => {
        const c = JSON.parse(JSON.stringify(good)) as { material_inputs: { worker_image: Record<string, unknown> } };
        delete c.material_inputs.worker_image["image_digest"];
        return c;
      })()],
      ["an unknown version", { ...good, record_version: 2 }],
      ["an extra field", { ...good, extra: "surprise" }],
    ];
    for (const [note, content] of damaged) {
      writeFileSync(path, JSON.stringify(content));
      await assert.rejects(
        startWork(dir, "development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-broken" }, deps(k)),
        (error: unknown) => {
          assert.match((error as Error).message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), `${note}: names the file`);
          return true;
        },
        note,
      );
    }
    writeFileSync(path, "{not json");
    await assert.rejects(
      startWork(dir, "development", DEV_EXTRA, { originProfile: "v05", originKey: "origin-broken" }, deps(k)),
      /is unparseable/u,
    );
    assert.equal(k.calls.length, calls, "no environment fallback and no kernel call — the operator repairs the file");
  });
});

// ---------------------------------------------------------------- workPlan's derived origin keys

test("workPlan origin keys are stable per (proposal, index) and distinct across both", () => {
  const p1 = "cadp-v04:evidence:proposal-1";
  const p2 = "cadp-v04:evidence:proposal-2";
  assert.equal(workPlanOriginKey(p1, 0), workPlanOriginKey(p1, 0), "re-running the same plan re-derives the same key");
  assert.notEqual(workPlanOriginKey(p1, 0), workPlanOriginKey(p1, 1), "two items are two logical origins");
  assert.notEqual(workPlanOriginKey(p1, 0), workPlanOriginKey(p2, 0), "two proposals are two logical origins");
  assert.match(workPlanOriginKey(p1, 0), /^[0-9a-f]{64}$/u, "filesystem-safe by construction");
  // Derived, not minted: no file, no clock and no process state is consulted to produce it.
  assert.equal(workPlanOriginKey(p1, 3), jcsDigest({ schema: "cadp.live.work-plan-origin.v1", proposal_evidence_id: p1, item_index: 3 }).value);
});

test("workPlan threads the derived key into startWork's allocation under v05, and nothing under v04", async () => {
  const proposal = {
    schema: "cadp.work-proposal.v1" as const,
    items: [{ work_item: "item one", max_steps: 4, max_effects: 3, rationale: "bounded" }],
  };
  const proposalId = "cadp-v04:evidence:proposal-1";
  // The gate DENIES, so the driver halts on item 0 without ever reaching a run poll — which is
  // enough to observe what the item's start allocated under.
  await withDir(async (dir) => {
    const k = fakeKernel({ deny: true });
    const results = await workPlan(dir, proposalId, undefined, () => {}, { originProfile: "v05" }, { ...deps(k), proposal });
    assert.deepEqual(results, [{ index: 0, work_item: "item one", status: "NOT_ADMITTED" }]);
    assert.deepEqual(k.tuples[0], { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: workPlanOriginKey(proposalId, 0), purpose: "work-start" });
    // The derived key needs no recovery file to be re-derivable, but its MATERIAL is pinned like
    // any other origin's: the record is there, and a re-run adopts it.
    assert.equal(existsSync(originRecordPath(dir, workPlanOriginKey(proposalId, 0))), true);
  });
  await withDir(async (dir) => {
    const k = fakeKernel({ deny: true });
    await workPlan(dir, proposalId, undefined, () => {}, {}, { ...deps(k), proposal });
    assert.equal(k.tuples[0]!["schema"], "cadp.allocation-key.v1", "the default driver path is still v0.4");
    assert.equal(existsSync(join(dir, "origin-keys")), false, "and writes no origin record");
  });
});
