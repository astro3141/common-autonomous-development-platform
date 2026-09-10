/**
 * The live composition's WORK_START seal path (`cadp/live/ops.ts`): the seal-time base resolution,
 * and — under AP TD A4/A5/B5 and WP §3.6 — the v0.5 RUN ORIGIN path that replaces the v0.4
 * zero-sentinel allocation with `cadp.allocation-key.run-origin.v1`.
 *
 * The origin migration is CONDITIONAL, and both branches are pinned here:
 *
 *  - `originProfile: "v04"` (the DEFAULT, and what the live v0.4 deployment and every existing
 *    `ctl.ts` / `mcpServer.ts` call site exercises) allocates the `cadp.allocation-key.v1` tuple
 *    with the zero-sentinel `work_run_ref` and the clock-derived `step_ordinal`, seals the same two
 *    work bindings, keeps the clock-derived record `resource_prefix`, re-resolves `base_sha` fresh
 *    at every seal, and never reads or writes `origin-keys.json`. Every one of those is asserted as
 *    a REGRESSION PIN with the wall clock stubbed, so the pinned bytes are exact rather than shaped.
 *  - `originProfile: "v05"` allocates `{schema, origin_key, purpose}`, seals exactly one
 *    self-referential `work-run` binding, derives `resource_prefix` from the `origin_key`, carries
 *    NO ordinal, and fixes every replay-unstable material input in the origin record — so one
 *    logical origin is one `effect_id` over byte-identical material, for the store's lifetime.
 *
 * The kernel here is a SCRIPTED stand-in at the client seam: it converges allocations by tuple and
 * raises `REQUEST_DIGEST_CONFLICT` on a re-seal whose semantic payload drifted, which is exactly the
 * K3 rule this lane exists to keep the origin path clear of. The same claims against the REAL
 * ingress/PEP — the `run_membership(E, E)` witness, the idempotent re-seal, zero incidents — are in
 * `conformance-runorigin.test.ts`, where a real kernel is needed to observe them.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findOriginKeyRecord, originKeysPath, originResourcePrefix, readOriginKeyRecords, resolveBaseSha,
  StartWorkOriginError, startWork, workPlan, workPlanOriginKey,
} from "../live/ops.ts";
import type { StartWorkDependencies, WorkKernelClient } from "../live/ops.ts";
import type { LiveEnvManifest } from "../live/env.ts";
import { jcsDigest, sha256Hex } from "../kernel/canonical.ts";
import type { WorkProposalV1 } from "../product/planner.ts";

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

// ================================================================ the ops origin fixtures

const ZERO_SENTINEL = "cadp-v04:effect:00000000-0000-7000-8000-000000000000";
const MOVED_SHA = "b".repeat(40);

const MANIFEST: LiveEnvManifest = {
  dir: "unused", api_url: "http://kernel.invalid", root_url: "http://root.invalid",
  api_port: 1, root_port: 2, record_port: 3, temporal_port: 4, temporal_ui_port: 5, broker_port: 6,
  repo_full_name: "owner/repo", repo_id: "123", base_sha: "0".repeat(40), tokens: {},
  root_key_id: "root", kernel_config_path: "unused", policy_content_digest: "digest",
};

const IMAGE = { image: "cadp-surface:test", image_digest: "sha256:image", tool_versions: { "codex-cli": "1.2.3" } };

/**
 * A scripted kernel at the `KernelClient` seam. It models the three K3 behaviours the origin
 * contract stands on and nothing else: allocations CONVERGE by tuple (AP B1(2)), a re-seal with an
 * identical semantic payload is an idempotent no-op returning the stored row, and a re-seal whose
 * payload drifted is `REQUEST_DIGEST_CONFLICT` (Spec v0.5 K3) — the incident-and-scope-hold outcome
 * a wall-clock material field would produce on every retry of one origin.
 */
class ScriptedKernel {
  readonly allocations = new Map<string, string>();

  readonly blobs = new Map<string, string>();

  readonly requests = new Map<string, { semantic: string; row: Record<string, unknown> }>();

  readonly tuples: Array<Record<string, unknown>> = [];

  readonly seals: Array<Record<string, unknown>> = [];

  conflicts = 0;

  /** The method this kernel is unreachable at, for the crashed-start legs. */
  failAt: string | undefined;

  #minted = 0;

  #fail(method: string): void {
    if (this.failAt === method) throw new Error(`kernel unreachable at ${method}`);
  }

  async allocateEffectId(tuple: Record<string, unknown>): Promise<{ effect_id: string }> {
    this.#fail("allocateEffectId");
    this.tuples.push(tuple);
    const key = jcsDigest(tuple).value;
    const existing = this.allocations.get(key);
    if (existing !== undefined) return { effect_id: existing };
    this.#minted += 1;
    const effect_id = `cadp-v04:effect:00000000-0000-7000-8000-00000000000${this.#minted}`;
    this.allocations.set(key, effect_id);
    return { effect_id };
  }

  async putBlob(bytes: Uint8Array): Promise<{ cas_key: string }> {
    this.#fail("putBlob");
    const text = Buffer.from(bytes).toString("utf8");
    const cas_key = `cas://sha256/${sha256Hex(text)}`;
    this.blobs.set(cas_key, text);
    return { cas_key };
  }

  async sealEffectRequest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.#fail("sealEffectRequest");
    this.seals.push(body);
    const semantic = JSON.stringify({
      requester_ref: body["requester_ref"], work_bindings: body["work_bindings"], target_ref: body["target_ref"],
      operation_kind: body["operation_kind"], material_schema: body["material_schema"],
      material_ref: body["material_ref"], prior_effect_refs: body["prior_effect_refs"],
    });
    const effect_id = String(body["effect_id"]);
    const existing = this.requests.get(effect_id);
    if (existing !== undefined) {
      if (existing.semantic !== semantic) {
        this.conflicts += 1;
        throw new Error(`REQUEST_DIGEST_CONFLICT for ${effect_id}`);
      }
      return existing.row;
    }
    const row = { effect_id, request_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256Hex(semantic) } };
    this.requests.set(effect_id, { semantic, row });
    return row;
  }

  async assembleAdmissionInput(effect_id: string): Promise<Record<string, unknown>> {
    return { input_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: `input-${effect_id}` } };
  }

  async evaluate(input_digest: string): Promise<Record<string, unknown>> {
    return { kind: "DECISION", decision: { decision_id: `decision-${input_digest}`, outcome: "ALLOW" } };
  }

  async admitAndDispatch(effect_id: string): Promise<Record<string, unknown>> {
    return { kind: "ADMITTED", admission: { effect_id }, outcome: { result: "COMMITTED" } };
  }

  /** The exact bytes sealed for the Nth request: material and, through it, args. */
  sealedBytes(index: number): { material: string; args: string } {
    const material = this.blobs.get(String(this.seals[index]!["material_ref"]))!;
    const args = this.blobs.get(String((JSON.parse(material) as { args_cas_key: string }).args_cas_key))!;
    return { material, args };
  }
}

interface Fixture {
  dir: string;
  kernel: ScriptedKernel;
  lines: Array<Record<string, unknown>>;
  resolved: string[];
  minted: string[];
  deps: StartWorkDependencies;
  cleanup: () => void;
}

function fixture(options: { baseSha?: string; mint?: () => string } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "cadp-ops-origin-"));
  const kernel = new ScriptedKernel();
  const lines: Array<Record<string, unknown>> = [];
  const resolved: string[] = [];
  const minted: string[] = [];
  let mintCounter = 0;
  const deps: StartWorkDependencies = {
    manifest: MANIFEST,
    client: kernel as unknown as WorkKernelClient,
    namespaceId: () => "namespace-1",
    resolveBase: () => {
      const sha = options.baseSha ?? SHA;
      resolved.push(sha);
      return sha;
    },
    workerImage: () => IMAGE,
    mintOriginKey: options.mint ?? (() => {
      mintCounter += 1;
      const key = `minted-uuid-${mintCounter}`;
      minted.push(key);
      return key;
    }),
    now: () => "2026-09-10T00:00:00.000Z",
  };
  return { dir, kernel, lines, resolved, minted, deps, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A wall clock frozen at a chosen instant, so the v0.4 branch's clock-derived fields pin exactly. */
function withClock<T>(nowMs: number, body: () => T): T {
  const original = Date.now;
  Date.now = () => nowMs;
  try {
    return body();
  } finally {
    Date.now = original;
  }
}

// ================================================================ the v0.4 branch — regression pin

test("v0.4 (the default): the zero-sentinel tuple, the clock ordinal and today's sealed material, byte for byte", async () => {
  const f = fixture();
  try {
    const started = await withClock(1_234_567_890_123, () =>
      startWork(f.dir, "development", ["do the thing", "8", "6", "cadp-v04:evidence:p1"], { log: (l) => f.lines.push(l), ordinalArg: "7" }, f.deps));
    assert.deepEqual(f.kernel.tuples[0], {
      schema: "cadp.allocation-key.v1",
      work_run_ref: ZERO_SENTINEL,
      step_ordinal: 7,
      purpose: "work-start",
    }, "the v0.4 allocation key is unchanged");
    const seal = f.kernel.seals[0]!;
    assert.equal(seal["allocation_tuple"], undefined, "v0.4 presents no allocation_tuple, exactly as today");
    assert.deepEqual(seal["work_bindings"], [
      { authority_ref: "github.com", namespace: "work-item", object_id: "dev:do the thing" },
      { authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: "cadp-v04:evidence:p1" },
    ], "no work-run binding is added on the v0.4 path");
    assert.deepEqual(JSON.parse(f.kernel.sealedBytes(0).args), {
      vertical: "development",
      bounds: { max_steps: 8, max_effects: 6 },
      development: {
        repo_id: "123", repo_full_name: "owner/repo", base_ref: "refs/heads/main", base_sha: SHA,
        work_item: "do the thing", worker_product: "codex", review_product: "claude",
        external_verification: false, require_human_merge: true,
      },
    });
    assert.equal(started?.effect_id, "cadp-v04:effect:00000000-0000-7000-8000-000000000001");
    assert.equal(started?.origin_key, undefined, "a v0.4 start has no origin identity to report");
    assert.equal(existsSync(originKeysPath(f.dir)), false, "the v0.4 branch writes no origin record");
    assert.deepEqual(f.resolved, [SHA], "base_sha is resolved fresh at seal time");

    // The clock-derived ordinal, pinned at a frozen instant: floor(1234567890123/1000) % 1e6.
    await withClock(1_234_567_890_123, () => startWork(f.dir, "development", ["do the thing", "8", "6"], {}, f.deps));
    assert.equal(f.kernel.tuples[1]!["step_ordinal"], 567890, "the ordinal fallback stays the wall clock on the v0.4 path");
    assert.deepEqual(f.resolved, [SHA, SHA], "every v0.4 seal re-resolves the base, unchanged");
  } finally {
    f.cleanup();
  }
});

test("v0.4 record vertical: the clock-derived resource_prefix is untouched", async () => {
  const f = fixture();
  try {
    await withClock(1_234_567_890_123, () => startWork(f.dir, "record", ["2", "6", "4"], {}, f.deps));
    const args = JSON.parse(f.kernel.sealedBytes(0).args) as { record: { resource_prefix: string; tenant: string; payloads: string[] } };
    assert.equal(args.record.resource_prefix, "live-90123", "Date.now() % 100000 at the frozen instant");
    assert.deepEqual(args.record.payloads, ["live payload 1", "live payload 2"]);
    assert.equal(args.record.tenant, "cadp-disposable");
    assert.equal(existsSync(originKeysPath(f.dir)), false);
  } finally {
    f.cleanup();
  }
});

test("v0.4 never reads or writes origin-keys.json, and refuses an origin_key it has no contract for", async () => {
  const f = fixture();
  try {
    // A file left by an earlier v0.5 origin under the same deployment dir must be inert here.
    const planted = `${JSON.stringify([{ origin_key: "someone-elses", work_item_digest: "d", created_at: "t", base_sha: MOVED_SHA }], null, 2)}\n`;
    writeFileSync(originKeysPath(f.dir), planted);
    await startWork(f.dir, "development", ["do the thing", "8", "6"], {}, f.deps);
    assert.equal(readFileSync(originKeysPath(f.dir), "utf8"), planted, "untouched");
    assert.deepEqual(f.resolved, [SHA], "the v0.4 path resolves its own base and consults no record");

    await assert.rejects(
      () => startWork(f.dir, "development", ["do the thing", "8", "6"], { originKey: "k" }, f.deps),
      /originKey is a v0.5 run-origin input/u,
      "an origin_key under the v0.4 profile is refused, never silently ignored",
    );
  } finally {
    f.cleanup();
  }
});

// ================================================================ the v0.5 origin branch

test("A5: one origin_key derives ONE effect_id, and its re-seal is byte-identical and idempotent", async () => {
  const f = fixture();
  try {
    const first = await withClock(1_000_000_000_000, () =>
      startWork(f.dir, "development", ["do the thing", "8", "6"], { originProfile: "v05", log: (l) => f.lines.push(l) }, f.deps));
    // A retry at a WHOLLY different instant: if any sealed field were clock-derived, the bytes below
    // would differ and the scripted kernel would raise REQUEST_DIGEST_CONFLICT.
    const second = await withClock(1_999_999_999_999, () =>
      startWork(f.dir, "development", ["do the thing", "8", "6"], { originProfile: "v05", originKey: first!.origin_key! }, f.deps));

    assert.equal(second?.effect_id, first?.effect_id, "one logical origin, one effect_id");
    assert.equal(second?.origin_key, first?.origin_key);
    assert.equal(f.kernel.allocations.size, 1, "exactly one allocation for the origin");
    assert.equal(f.kernel.seals.length, 2, "both attempts sealed");
    assert.equal(f.kernel.requests.size, 1, "the re-seal is the SAME request row, not a second one");
    assert.equal(f.kernel.conflicts, 0, "no REQUEST_DIGEST_CONFLICT");
    assert.deepEqual(f.kernel.sealedBytes(1), f.kernel.sealedBytes(0), "the sealed material bytes are identical");
    assert.deepEqual(f.kernel.seals[1], f.kernel.seals[0], "and so is the whole re-presented seal body, tuple included");
    assert.equal(f.minted.length, 1, "the retry re-presented the key and minted nothing");
  } finally {
    f.cleanup();
  }
});

test("B5(9): the origin allocates the three-key run-origin tuple and seals ONE self-referential work-run binding", async () => {
  const f = fixture();
  try {
    const started = await startWork(
      f.dir, "development", ["do the thing", "8", "6", "cadp-v04:evidence:p1"],
      { originProfile: "v05", originKey: "origin-alpha" }, f.deps,
    );
    assert.deepEqual(f.kernel.tuples[0], {
      schema: "cadp.allocation-key.run-origin.v1",
      origin_key: "origin-alpha",
      purpose: "work-start",
    }, "exactly {schema, origin_key, purpose} — no work_run_ref, no step_ordinal");
    assert.deepEqual(Object.keys(f.kernel.tuples[0]!).sort(), ["origin_key", "purpose", "schema"]);

    const seal = f.kernel.seals[0]!;
    assert.deepEqual(seal["allocation_tuple"], f.kernel.tuples[0], "the allocated tuple is re-presented verbatim as transport (AP B6(1))");
    const bindings = seal["work_bindings"] as Array<{ authority_ref: string; namespace: string; object_id: string }>;
    const workRun = bindings.filter((b) => b.namespace === "work-run");
    assert.equal(workRun.length, 1, "EXACTLY one work-run binding");
    assert.deepEqual(workRun[0], { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: started!.effect_id });
    assert.equal(workRun[0]!.object_id, f.kernel.allocations.values().next().value, "the binding names the ALLOCATED effect_id itself");
    // The provenance bindings the v0.4 path already sealed are preserved alongside it.
    assert.deepEqual(bindings.slice(0, 2), [
      { authority_ref: "github.com", namespace: "work-item", object_id: "dev:do the thing" },
      { authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: "cadp-v04:evidence:p1" },
    ]);
    assert.equal(seal["operation_kind"], "WORK_START");
  } finally {
    f.cleanup();
  }
});

test("WP §3.6: the record vertical's resource_prefix is a function of the origin, with no clock left on the path", async () => {
  const f = fixture();
  try {
    await withClock(1_000_000_000_000, () => startWork(f.dir, "record", ["2", "6", "4"], { originProfile: "v05", originKey: "origin-record" }, f.deps));
    await withClock(1_999_999_999_999, () => startWork(f.dir, "record", ["2", "6", "4"], { originProfile: "v05", originKey: "origin-record" }, f.deps));
    const args = JSON.parse(f.kernel.sealedBytes(0).args) as { record: { resource_prefix: string } };
    assert.equal(args.record.resource_prefix, originResourcePrefix("origin-record"));
    assert.match(args.record.resource_prefix, /^live-[0-9a-f]{10}$/u);
    assert.deepEqual(f.kernel.sealedBytes(1), f.kernel.sealedBytes(0), "two attempts an hour apart seal identical bytes");
    assert.equal(f.kernel.conflicts, 0);
    assert.equal(f.kernel.tuples[0]!["step_ordinal"], undefined, "no wall-clock ordinal on the origin path");

    // A DIFFERENT origin over identical work is a different prefix — the distinctness the tuple owns.
    await startWork(f.dir, "record", ["2", "6", "4"], { originProfile: "v05", originKey: "origin-record-2" }, f.deps);
    const other = JSON.parse(f.kernel.sealedBytes(2).args) as { record: { resource_prefix: string } };
    assert.notEqual(other.record.resource_prefix, args.record.resource_prefix);
    assert.equal(f.kernel.allocations.size, 2, "two origins, two effect identities");

    // The record vertical presents no development-only field anywhere on the path (WP control 15).
    assert.equal(f.kernel.tuples[0]!["repo_id"], undefined);
    assert.equal(findOriginKeyRecord(f.dir, "origin-record")?.base_sha, undefined, "and resolves no base");
    assert.deepEqual(f.resolved, [], "resolveBaseSha is never called on the record vertical");
  } finally {
    f.cleanup();
  }
});

test("v0.5 ordinal input is refused: run-origin.v1 has no step_ordinal to carry one", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => startWork(f.dir, "development", ["x", "8", "6"], { originProfile: "v05", ordinalArg: "7" }, f.deps),
      /step_ordinal is not a field of cadp\.allocation-key\.run-origin\.v1/u,
    );
    assert.equal(f.kernel.tuples.length, 0, "refused at entry, before any allocation");
  } finally {
    f.cleanup();
  }
});

// ================================================================ minted-key durability

test("A4: a crashed direct start leaves its minted origin_key recoverable, and the retry converges on it", async () => {
  const f = fixture();
  try {
    // The kernel is unreachable at the FIRST call the start makes, so the attempt dies after the
    // key was minted and before any effect identity exists — the exact crash that used to fork.
    f.kernel.failAt = "allocateEffectId";
    let thrown: unknown;
    try {
      await startWork(f.dir, "development", ["do the thing", "8", "6"], { originProfile: "v05", log: (l) => f.lines.push(l) }, f.deps);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof StartWorkOriginError, `expected a StartWorkOriginError, got ${String(thrown)}`);
    const key = thrown.origin_key;
    assert.equal(key, "minted-uuid-1");
    assert.match(thrown.message, /kernel unreachable at allocateEffectId/u, "the cause survives");
    assert.match(thrown.message, /retry with THIS origin_key/u);
    assert.equal(thrown.origin_keys_path, originKeysPath(f.dir));

    // (1) the LOG carried it, emitted the moment it was minted;
    assert.deepEqual(
      f.lines.filter((l) => l["origin_start"] === "ORIGIN_KEY_MINTED").map((l) => l["origin_key"]),
      [key],
      "minted exactly once, and emitted",
    );
    assert.equal(f.lines.filter((l) => l["origin_start"] === "FAILED").at(0)?.["origin_key"], key);
    // (2) the STATE FILE carried it, written before the first kernel call — with the base pinned;
    const records = readOriginKeyRecords(f.dir);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      origin_key: key, work_item_digest: sha256Hex("dev:do the thing"),
      created_at: "2026-09-10T00:00:00.000Z", base_sha: SHA,
    });

    // The recovery flow: re-invoke with the RECORDED key. Same tuple, one allocation, no re-mint.
    f.kernel.failAt = undefined;
    const retried = await startWork(f.dir, "development", ["do the thing", "8", "6"], { originProfile: "v05", originKey: records[0]!.origin_key }, f.deps);
    assert.equal(retried?.origin_key, key);
    assert.deepEqual(f.kernel.tuples.at(-1), { schema: "cadp.allocation-key.run-origin.v1", origin_key: key, purpose: "work-start" });
    assert.equal(f.minted.length, 1, "the retry minted nothing — one logical origin, one UUID");
    assert.equal(f.kernel.allocations.size, 1);
    assert.equal(readOriginKeyRecords(f.dir).length, 1, "and recorded no second origin");
  } finally {
    f.cleanup();
  }
});

test("A4: a failure of the ORIGIN PHASE ITSELF still carries the minted key out", async () => {
  // The three ways fixing an origin's material can fail before any kernel call — an unreadable
  // record file, an unreachable base ref, a record that cannot be written. Each happens with the
  // key already minted, so each must report it: a durability record the operator cannot read is
  // the same fork as no record at all.
  const legs: Array<{ note: string; arrange: (f: Fixture) => StartWorkDependencies; expect: RegExp }> = [
    {
      note: "the record read",
      arrange: (f) => {
        writeFileSync(originKeysPath(f.dir), `${JSON.stringify({ not: "an array" })}\n`);
        return f.deps;
      },
      expect: /is not a JSON array/u,
    },
    {
      note: "the base resolution",
      arrange: (f) => ({ ...f.deps, resolveBase: () => { throw new Error("ls-remote unreachable"); } }),
      expect: /ls-remote unreachable/u,
    },
    {
      note: "the record write",
      arrange: (f) => {
        // The append writes `<path>.tmp` then renames; a DIRECTORY in its place fails the write.
        mkdirSync(`${originKeysPath(f.dir)}.tmp`);
        return f.deps;
      },
      expect: /EISDIR|illegal operation on a directory/u,
    },
  ];

  for (const leg of legs) {
    const f = fixture();
    try {
      const deps = leg.arrange(f);
      let thrown: unknown;
      try {
        await startWork(f.dir, "development", ["do the thing", "8", "6"], { originProfile: "v05", log: (l) => f.lines.push(l) }, deps);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof StartWorkOriginError, `${leg.note}: expected a StartWorkOriginError, got ${String(thrown)}`);
      assert.equal(thrown.origin_key, "minted-uuid-1", `${leg.note}: the thrown error names the key that was minted`);
      assert.match(thrown.message, leg.expect, `${leg.note}: the cause survives`);
      assert.match(thrown.message, /retry with THIS origin_key/u);
      assert.equal(thrown.origin_keys_path, originKeysPath(f.dir));
      assert.deepEqual(
        f.lines.filter((l) => l["origin_start"] === "ORIGIN_KEY_MINTED").map((l) => l["origin_key"]),
        ["minted-uuid-1"],
        `${leg.note}: and so does the log, from the moment of the mint`,
      );
      assert.equal(f.lines.filter((l) => l["origin_start"] === "FAILED").at(0)?.["origin_key"], "minted-uuid-1", `${leg.note}: the failure line too`);
      assert.equal(f.kernel.tuples.length, 0, `${leg.note}: it died before any kernel call — no effect identity exists yet`);
      assert.equal(f.minted.length, 1, `${leg.note}: exactly one key was minted`);
    } finally {
      f.cleanup();
    }
  }

  // And the recovered key is the whole point: re-invoking with it converges on ONE origin identity,
  // even though the failed attempt (an unreachable base ref) left no record behind to replay.
  const f = fixture();
  try {
    let thrown: unknown;
    try {
      await startWork(
        f.dir, "development", ["do the thing", "8", "6"], { originProfile: "v05" },
        { ...f.deps, resolveBase: () => { throw new Error("ls-remote unreachable"); } },
      );
    } catch (error) {
      thrown = error;
    }
    const key = (thrown as StartWorkOriginError).origin_key;
    assert.equal(readOriginKeyRecords(f.dir).length, 0, "nothing was recorded — the key survived only in the error and the log");

    const retried = await startWork(f.dir, "development", ["do the thing", "8", "6"], { originProfile: "v05", originKey: key }, f.deps);
    assert.equal(retried?.origin_key, key, "the retry re-presented the recovered key");
    assert.deepEqual(f.kernel.tuples[0], { schema: "cadp.allocation-key.run-origin.v1", origin_key: key, purpose: "work-start" });
    assert.equal(f.minted.length, 1, "and minted no second identity for the same logical origin");
    assert.deepEqual(findOriginKeyRecord(f.dir, key), {
      origin_key: key, work_item_digest: sha256Hex("dev:do the thing"),
      created_at: "2026-09-10T00:00:00.000Z", base_sha: SHA,
    }, "the recovering attempt is the one that pins the material");
  } finally {
    f.cleanup();
  }
});

test("A4: the minted key is generated exactly once per invocation, whatever the start goes on to do", async () => {
  const f = fixture();
  try {
    const started = await startWork(f.dir, "development", ["do the thing", "8", "6"], { originProfile: "v05" }, f.deps);
    assert.deepEqual(f.minted, ["minted-uuid-1"], "one invocation mints one key");
    assert.equal(started?.origin_key, "minted-uuid-1", "and the result reports it, so a caller need not read the file");
    // A SECOND direct start is a SECOND logical origin: a fresh key, a fresh record, a fresh identity.
    const other = await startWork(f.dir, "development", ["do the thing", "8", "6"], { originProfile: "v05" }, f.deps);
    assert.equal(other?.origin_key, "minted-uuid-2");
    assert.notEqual(other?.effect_id, started?.effect_id, "identical work, distinct origins, distinct effect_ids");
    assert.equal(f.kernel.conflicts, 0, "and no conflict between them");
    assert.equal(readOriginKeyRecords(f.dir).length, 2);
  } finally {
    f.cleanup();
  }
});

// ================================================================ material fixing through the record

test("A5: a retry replays the RECORDED base_sha even when the ref has moved since", async () => {
  const f = fixture();
  try {
    const first = await startWork(f.dir, "development", ["do the thing", "8", "6"], { originProfile: "v05" }, f.deps);
    assert.equal((JSON.parse(f.kernel.sealedBytes(0).args) as { development: { base_sha: string } }).development.base_sha, SHA);
    assert.equal(findOriginKeyRecord(f.dir, first!.origin_key!)?.base_sha, SHA);

    // The base branch MOVES between the two attempts. A resolver called again would now return a
    // different tip, which under one converged effect_id is REQUEST_DIGEST_CONFLICT — so it must
    // not be called at all.
    let reResolved = 0;
    const moved: StartWorkDependencies = {
      ...f.deps,
      resolveBase: () => {
        reResolved += 1;
        return MOVED_SHA;
      },
    };
    const retried = await startWork(f.dir, "development", ["do the thing", "8", "6"], { originProfile: "v05", originKey: first!.origin_key! }, moved);
    assert.equal(reResolved, 0, "the recorded origin never re-resolves its base");
    assert.equal(retried?.effect_id, first?.effect_id);
    assert.equal((JSON.parse(f.kernel.sealedBytes(1).args) as { development: { base_sha: string } }).development.base_sha, SHA, "the RECORDED sha is sealed");
    assert.deepEqual(f.kernel.sealedBytes(1), f.kernel.sealedBytes(0));
    assert.equal(f.kernel.requests.size, 1, "the re-seal is the idempotent no-op");
    assert.equal(f.kernel.conflicts, 0);

    // A ref that moved between two DIFFERENT logical origins is unaffected: a fresh key gets a
    // fresh record, and therefore the NEW tip.
    const fresh = await startWork(f.dir, "development", ["do the thing", "8", "6"], { originProfile: "v05" }, moved);
    assert.equal(reResolved, 1);
    assert.equal((JSON.parse(f.kernel.sealedBytes(2).args) as { development: { base_sha: string } }).development.base_sha, MOVED_SHA);
    assert.equal(findOriginKeyRecord(f.dir, fresh!.origin_key!)?.base_sha, MOVED_SHA);
    assert.notEqual(fresh?.effect_id, first?.effect_id);
  } finally {
    f.cleanup();
  }
});

test("A5: the origin record is written BEFORE the first kernel call, so nothing seals ahead of its own material pin", async () => {
  const f = fixture();
  try {
    f.kernel.failAt = "allocateEffectId";
    await assert.rejects(() => startWork(f.dir, "development", ["do the thing", "8", "6"], { originProfile: "v05", originKey: "origin-early" }, f.deps));
    assert.deepEqual(findOriginKeyRecord(f.dir, "origin-early"), {
      origin_key: "origin-early", work_item_digest: sha256Hex("dev:do the thing"),
      created_at: "2026-09-10T00:00:00.000Z", base_sha: SHA,
    }, "the record exists although not one kernel call succeeded");
    assert.equal(f.kernel.allocations.size, 0);
  } finally {
    f.cleanup();
  }
});

test("a damaged origin record file fails closed rather than silently re-resolving fresh material", async () => {
  const f = fixture();
  try {
    writeFileSync(originKeysPath(f.dir), "{\"not\": \"an array\"}");
    await assert.rejects(
      () => startWork(f.dir, "development", ["x", "8", "6"], { originProfile: "v05", originKey: "k" }, f.deps),
      /is not a JSON array/u,
    );
    assert.equal(f.kernel.tuples.length, 0);
  } finally {
    f.cleanup();
  }
});

// ================================================================ workPlan's derived origins

test("workPlan derives a stable, distinct origin_key per (proposal, item index) and threads it into startWork", async () => {
  const proposal: WorkProposalV1 = {
    schema: "cadp.work-proposal.v1",
    items: [
      { work_item: "item one", max_steps: 4, max_effects: 2, rationale: "bounded" },
      // Byte-identical work in a second position: distinct origins by construction, never by content.
      { work_item: "item one", max_steps: 4, max_effects: 2, rationale: "bounded" },
    ],
  };
  const runs: Array<{ index: number; originKey?: string; originProfile?: string; extra: string[] }> = [];
  const deps = {
    loadProposal: async () => proposal,
    startWork: async (_dir: string, _v: "development" | "record", extra: string[], options: { originKey?: string; originProfile?: string } = {}) => {
      runs.push({ index: runs.length, originKey: options.originKey, originProfile: options.originProfile, extra });
      return { effect_id: `effect-${runs.length}`, workflow_id: `wf-${runs.length}` };
    },
    pollRun: async () => ({ status: "COMPLETED" as const, trace: { completed: true } }),
  } as never;

  const first = await workPlan("dir", "cadp-v04:evidence:p1", undefined, () => {}, { originProfile: "v05" }, deps);
  assert.equal(first.length, 2);
  assert.deepEqual(runs.map((r) => r.originKey), [
    "cadp-work-plan:cadp-v04:evidence:p1#0",
    "cadp-work-plan:cadp-v04:evidence:p1#1",
  ], "one key per item position, distinct across identical work");
  assert.deepEqual(runs.map((r) => r.originProfile), ["v05", "v05"]);
  assert.equal(runs[0]!.extra[3], "cadp-v04:evidence:p1", "the proposal binding is still threaded as provenance");

  // REPLAY: the same plan, run again, derives the IDENTICAL keys — no file consulted, nothing minted.
  runs.length = 0;
  await workPlan("dir", "cadp-v04:evidence:p1", undefined, () => {}, { originProfile: "v05" }, deps);
  assert.deepEqual(runs.map((r) => r.originKey), [
    "cadp-work-plan:cadp-v04:evidence:p1#0",
    "cadp-work-plan:cadp-v04:evidence:p1#1",
  ]);

  // A DIFFERENT proposal at the same index is a different origin.
  runs.length = 0;
  await workPlan("dir", "cadp-v04:evidence:p2", "1", () => {}, { originProfile: "v05" }, deps);
  assert.deepEqual(runs.map((r) => r.originKey), ["cadp-work-plan:cadp-v04:evidence:p2#0"]);

  // And the DEFAULT profile threads no origin at all — the v0.4 driver is unchanged.
  runs.length = 0;
  await workPlan("dir", "cadp-v04:evidence:p1", undefined, () => {}, {}, deps);
  assert.deepEqual(runs.map((r) => r.originKey), [undefined, undefined]);
  assert.deepEqual(runs.map((r) => r.originProfile), ["v04", "v04"]);
});

test("workPlanOriginKey is injective over (proposal_evidence_id, index)", () => {
  assert.equal(workPlanOriginKey("cadp-v04:evidence:p1", 0), "cadp-work-plan:cadp-v04:evidence:p1#0");
  assert.notEqual(workPlanOriginKey("p", 10), workPlanOriginKey("p", 1));
  assert.notEqual(workPlanOriginKey("p1", 0), workPlanOriginKey("p10", 0));
  // The separator is what the injectivity argument rests on, so a value carrying it is refused.
  assert.throws(() => workPlanOriginKey("p#1", 0), /carries the origin-key separator/u);
  assert.throws(() => workPlanOriginKey("p", -1), /not a plan position/u);
});
