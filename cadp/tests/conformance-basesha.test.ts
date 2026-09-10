/**
 * The `cadp/live/ops.ts` conformance file.
 *
 * PART 1, the original subject: `resolveBaseSha` — the seal-time resolution of the DECLARED base
 * ref's current tip, and its fail-closed refusals. It is the oldest of the environment seams a
 * WORK_START's sealed material is built from, and Part 2 is what pins it.
 *
 * PART 2: the v0.5 RUN-ORIGIN path of `startWork`/`workPlan` (AP TD A4/A5 and B5's origin and
 * run-binding rules), asserted at the ops layer with an injected kernel client. Two branches are
 * covered and the distinction between them is the point:
 *
 *   - the `"v04"` DEFAULT — the branch the live v0.4 deployment exercises — pinned as a REGRESSION
 *     to exactly today's `cadp.allocation-key.v1` zero-sentinel tuple, today's clock-derived
 *     `step_ordinal` and `resource_prefix`, today's sealed-material shape, no work-run binding, no
 *     `allocation_tuple`, and no origin record read or written;
 *   - the `"v05"` branch — `cadp.allocation-key.run-origin.v1` with a stable `origin_key` and
 *     nothing else in the tuple, exactly one SELF-referential work-run binding, an
 *     `origin_key`-derived `resource_prefix`, no wall clock anywhere, a minted key that is durable
 *     and recoverable BEFORE anything can fail, and the material-fixing invariant: every
 *     environment-resolved field is resolved once at origin creation and adopted verbatim
 *     thereafter, so a retry re-seals byte-identically instead of colliding.
 *
 * The CROSS-KERNEL half of these claims — that the Kernel really does derive one `effect_id` per
 * `origin_key`, that the re-seal really is TD §3.3's idempotent no-op, and that the self-binding
 * really does write `run_membership(E, E)` — is asserted against a real store in
 * `conformance-runorigin.test.ts`, which is where the Kernel-side machinery lives.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ORIGIN_RECORD_SCHEMA, OriginStartError, originRecordPath, originResourcePrefix, planOriginKey,
  resolveBaseSha, startWork, workPlan,
} from "../live/ops.ts";
import type { Log, OpsKernelClient, OriginRecordV1, StartWorkDependencies } from "../live/ops.ts";
import type { LiveEnvManifest } from "../live/env.ts";
import { jcsDigest, sha256Hex } from "../kernel/canonical.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA } from "../kernel/policyBundle.ts";
import type { AllocationTuple, SealRequestBody } from "../kernel/ingress.ts";
import type { AdmissionInputV1, EffectRequestV1, SubjectBinding } from "../kernel/records.ts";
import type { WorkProposalV1 } from "../product/planner.ts";

const SHA = "8cbc629d3adf9f29c8e21ecb69a11a7cfbcbe4f1";

// ============================================================== PART 1 — resolveBaseSha (#149)

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

// ============================================== PART 2 — the origin path of startWork / workPlan

const WORK_ITEM = "implement median in src/stats.mjs";
const IMAGE_TAG = "cadp-surface:0.151.0-2.1.221";

/**
 * A kernel client that RECORDS every call and derives `effect_id` the way the Kernel does — one
 * allocation tuple, one identity, for this client's lifetime (AP B1(2)/A5 leg o-ii). That is the
 * property the ops layer depends on, so modelling it exactly is what makes "the same origin_key
 * twice returns the same effect_id" a claim about ops.ts rather than about the fake.
 */
class OpsClientSpy implements OpsKernelClient {
  readonly calls: Array<{ method: string; arg: unknown }> = [];

  readonly blobs = new Map<string, Buffer>();

  readonly tuples: AllocationTuple[] = [];

  readonly seals: SealRequestBody[] = [];

  /** Injected failure: the named method throws instead of answering. */
  failOn: string | undefined;

  #enter(method: string, arg: unknown): void {
    this.calls.push({ method, arg });
    if (this.failOn === method) throw new Error(`injected ${method} failure`);
  }

  async putBlob(bytes: Uint8Array): Promise<{ cas_key: string }> {
    this.#enter("putBlob", bytes);
    const buffer = Buffer.from(bytes);
    const cas_key = `sha256:${sha256Hex(buffer)}`;
    this.blobs.set(cas_key, buffer);
    return { cas_key };
  }

  async allocateEffectId(tuple: AllocationTuple): Promise<{ effect_id: string }> {
    this.#enter("allocateEffectId", tuple);
    this.tuples.push(JSON.parse(JSON.stringify(tuple)) as AllocationTuple);
    return { effect_id: `cadp-v04:effect:${jcsDigest(tuple).value.slice(0, 32)}` };
  }

  async sealEffectRequest(body: SealRequestBody): Promise<EffectRequestV1> {
    this.#enter("sealEffectRequest", body);
    this.seals.push(JSON.parse(JSON.stringify(body)) as SealRequestBody);
    return { ...body, request_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: jcsDigest(body).value } } as unknown as EffectRequestV1;
  }

  async assembleAdmissionInput(effect_id: string): Promise<AdmissionInputV1> {
    this.#enter("assembleAdmissionInput", effect_id);
    return { input_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256Hex(effect_id) } } as unknown as AdmissionInputV1;
  }

  async evaluate(input_digest: string): ReturnType<OpsKernelClient["evaluate"]> {
    this.#enter("evaluate", input_digest);
    return { kind: "DECISION", decision: { decision_id: `decision:${input_digest.slice(0, 16)}`, outcome: "ALLOW" } } as unknown as Awaited<ReturnType<OpsKernelClient["evaluate"]>>;
  }

  async admitAndDispatch(effect_id: string, decision_id: string): ReturnType<OpsKernelClient["admitAndDispatch"]> {
    this.#enter("admitAndDispatch", { effect_id, decision_id });
    return { kind: "ADMITTED", admission: { effect_id }, outcome: { result: "COMMITTED" } } as unknown as Awaited<ReturnType<OpsKernelClient["admitAndDispatch"]>>;
  }

  /** The material blob of the n-th start this client served (`putBlob` #2 of each start). */
  materialBytes(index = 0): Buffer {
    const puts = this.calls.filter((call) => call.method === "putBlob");
    return Buffer.from(puts[index * 2 + 1]!.arg as Uint8Array);
  }

  argsBytes(index = 0): Buffer {
    const puts = this.calls.filter((call) => call.method === "putBlob");
    return Buffer.from(puts[index * 2]!.arg as Uint8Array);
  }
}

/** Every environment seam the material audit found, as ONE mutable fixture the tests flip. */
interface EnvSeams {
  repo_id: string;
  repo_full_name: string;
  base_sha: string;
  image_tag: string;
  image_digest: string;
  tool_versions: Record<string, string>;
  namespace_id: string;
  created_at: string;
}

function freshSeams(): EnvSeams {
  return {
    repo_id: "1234567",
    repo_full_name: "owner/repo",
    base_sha: SHA,
    image_tag: IMAGE_TAG,
    image_digest: "sha256:aaaa",
    tool_versions: { "codex-cli": "1.0.0", claude: "2.0.0", grok: "absent" },
    namespace_id: "namespace-uuid-1",
    created_at: "2026-09-10T00:00:00.000Z",
  };
}

function manifestOf(dir: string, seams: EnvSeams): LiveEnvManifest {
  return {
    dir,
    api_url: "http://127.0.0.1:42000",
    root_url: "http://127.0.0.1:42001",
    api_port: 42000,
    root_port: 42001,
    record_port: 42002,
    temporal_port: 42003,
    temporal_ui_port: 42004,
    broker_port: 42005,
    repo_full_name: seams.repo_full_name,
    repo_id: seams.repo_id,
    base_sha: "0".repeat(40),
    tokens: {},
    root_key_id: "root-1",
    kernel_config_path: join(dir, "kernel-config.json"),
    policy_content_digest: "0".repeat(64),
  };
}

interface SeamCounts {
  resolveBase: number;
  imageIdentity: number;
  namespaceId: number;
  workerImageTag: number;
}

function seamDeps(
  dir: string,
  seams: EnvSeams,
  client: OpsClientSpy,
  counts: SeamCounts,
  extra: Partial<StartWorkDependencies> = {},
): StartWorkDependencies {
  return {
    manifest: manifestOf(dir, seams),
    client,
    resolveBase: () => {
      counts.resolveBase += 1;
      return seams.base_sha;
    },
    workerImageTag: () => {
      counts.workerImageTag += 1;
      return seams.image_tag;
    },
    imageIdentity: (image: string) => {
      counts.imageIdentity += 1;
      return { image, image_digest: seams.image_digest, tool_versions: seams.tool_versions };
    },
    namespaceId: () => {
      counts.namespaceId += 1;
      return seams.namespace_id;
    },
    now: () => seams.created_at,
    ...extra,
  };
}

function zeroCounts(): SeamCounts {
  return { resolveBase: 0, imageIdentity: 0, namespaceId: 0, workerImageTag: 0 };
}

const TEMP_DIRS: string[] = [];
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** A disposable stand-in for a live deployment directory (`<dir>/worker-image`, `<dir>/origin-keys/`). */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cadp-ops-"));
  TEMP_DIRS.push(dir);
  return dir;
}

function collector(): { log: Log; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  return { log: (line) => lines.push(line), lines };
}

function workRunBindings(seal: SealRequestBody): SubjectBinding[] {
  return (seal.work_bindings as SubjectBinding[]).filter((b) => b.namespace === "work-run");
}

// -------------------------------------------------------- the v0.4 DEFAULT branch, pinned as-is

test("v0.4 (the default, and what the live deployment runs) allocates today's zero-sentinel tuple and seals today's material", async () => {
  const dir = tempDir();
  const seams = freshSeams();
  const client = new OpsClientSpy();
  const counts = zeroCounts();
  // NOT injected: the worker-image read, so the default `<dir>/worker-image` reader is exercised.
  const deps = seamDeps(dir, seams, client, counts);
  delete deps.workerImageTag;
  writeFileSync(join(dir, "worker-image"), `${IMAGE_TAG}\n`);
  const { log, lines } = collector();

  const before = Math.floor(Date.now() / 1000) % 1000000;
  const started = await startWork(dir, "development", [WORK_ITEM, "8", "6"], { log, dependencies: deps });
  const after = Math.floor(Date.now() / 1000) % 1000000;

  // The tuple: `cadp.allocation-key.v1`, the zero sentinel, the CLOCK-derived ordinal, work-start.
  const tuple = client.tuples[0] as Record<string, unknown>;
  assert.equal(tuple["schema"], "cadp.allocation-key.v1");
  assert.equal(tuple["work_run_ref"], "cadp-v04:effect:00000000-0000-7000-8000-000000000000");
  assert.equal(tuple["purpose"], "work-start");
  assert.ok(
    typeof tuple["step_ordinal"] === "number" && tuple["step_ordinal"] >= before && tuple["step_ordinal"] <= after,
    "the v0.4 ordinal is still the wall clock's — this branch must not change",
  );
  assert.deepEqual(Object.keys(tuple).sort(), ["purpose", "schema", "step_ordinal", "work_run_ref"]);

  // The sealed material: exactly today's field set, and today's dev args.
  const material = JSON.parse(client.materialBytes().toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(material), [
    "workflow_id", "workflow_type", "task_queue", "args_cas_key", "args_digest", "bounds",
    "worker_profile_digest", "surface_image", "continuation_target",
  ]);
  assert.equal(material["workflow_id"], `cadp-work-${started!.effect_id}`);
  assert.equal(material["continuation_target"], `temporal:cadp-v04:${seams.namespace_id}`);
  assert.deepEqual(material["surface_image"], { image: IMAGE_TAG, image_digest: seams.image_digest, tool_versions: seams.tool_versions });
  const args = JSON.parse(client.argsBytes().toString("utf8")) as { development: Record<string, unknown> };
  assert.deepEqual(args.development, {
    repo_id: seams.repo_id,
    repo_full_name: seams.repo_full_name,
    base_ref: "refs/heads/main",
    base_sha: SHA,
    work_item: WORK_ITEM,
    worker_product: "codex",
    review_product: "claude",
    external_verification: false,
    require_human_merge: true,
  });

  // No run binding, no allocation tuple on the seal, no origin key anywhere.
  const seal = client.seals[0]!;
  assert.deepEqual(workRunBindings(seal), [], "the v0.4 branch binds no work run");
  assert.equal(seal.allocation_tuple, undefined, "the v0.4 seal carries no allocation_tuple sibling");
  assert.deepEqual(Object.keys(started!).sort(), ["effect_id", "workflow_id"]);
  assert.equal(lines.some((line) => "origin_key" in line), false, "no origin key is minted, logged or threaded under v0.4");

  // And nothing is recorded on disk: the origin store belongs to the v0.5 branch alone.
  assert.equal(existsSync(join(dir, "origin-keys")), false, "the v0.4 branch never reads or writes an origin record");
  assert.equal(counts.resolveBase, 1, "the base is resolved fresh at seal time, exactly as today");
});

test("v0.4 keeps its explicit ordinal seam and its clock-derived record-vertical resource_prefix", async () => {
  const dir = tempDir();
  const seams = freshSeams();
  const client = new OpsClientSpy();
  const deps = seamDeps(dir, seams, client, zeroCounts());

  await startWork(dir, "record", ["2", "6", "4"], { ordinalArg: "77", dependencies: deps });
  assert.equal((client.tuples[0] as Record<string, unknown>)["step_ordinal"], 77, "an explicit ordinal still overrides the clock");
  const args = JSON.parse(client.argsBytes().toString("utf8")) as { record: Record<string, unknown> };
  assert.match(String(args.record["resource_prefix"]), /^live-\d{1,5}$/u, "the v0.4 record prefix is still `live-${Date.now() % 100000}`");
  assert.equal(existsSync(join(dir, "origin-keys")), false, "still no origin record");
});

// ------------------------------------------------------------------- the v0.5 run-origin branch

test("v0.5 allocates EXACTLY {schema, origin_key, purpose} — no step_ordinal, no wall clock", async () => {
  const dir = tempDir();
  const seams = freshSeams();
  const client = new OpsClientSpy();
  const deps = seamDeps(dir, seams, client, zeroCounts());

  const started = await startWork(dir, "development", [WORK_ITEM, "8", "6"], {
    originProfile: "v05",
    originKey: "origin-alpha",
    dependencies: deps,
  });

  assert.deepEqual(client.tuples[0], {
    schema: RUN_ORIGIN_ALLOCATION_SCHEMA,
    origin_key: "origin-alpha",
    purpose: "work-start",
  }, "WP §3.6's three keys and nothing else");
  assert.equal(Object.keys(client.tuples[0]!).length, 3);
  assert.equal("step_ordinal" in client.tuples[0]!, false, "the clock ordinal is GONE on this path");
  assert.equal(started?.origin_key, "origin-alpha", "the result carries the key the run originated under");

  // The seal carries the tuple as B6(1)'s top-level sibling, and EXACTLY ONE work-run binding,
  // naming this request's OWN effect_id — the self-reference that makes it a run ORIGIN.
  const seal = client.seals[0]!;
  assert.deepEqual(seal.allocation_tuple, client.tuples[0]);
  assert.deepEqual(workRunBindings(seal), [{ authority_ref: "cadp-store:k04", namespace: "work-run", object_id: started!.effect_id }]);
  assert.equal(workRunBindings(seal).length, 1, "exactly one work-run binding");
  // The unrelated bindings are untouched: the run binding is added, never substituted.
  assert.ok((seal.work_bindings as SubjectBinding[]).some((b) => b.namespace === "work-item" && b.object_id === `dev:${WORK_ITEM}`));
});

test("v0.5 refuses an ordinalArg rather than dropping it, and refuses nothing on the valid origin path", async () => {
  const dir = tempDir();
  const client = new OpsClientSpy();
  await assert.rejects(
    () => startWork(dir, "development", [WORK_ITEM, "8", "6"], {
      originProfile: "v05",
      ordinalArg: "5",
      dependencies: seamDeps(dir, freshSeams(), client, zeroCounts()),
    }),
    /the v0.5 run-origin tuple carries no step_ordinal/u,
  );
  assert.equal(client.calls.length, 0, "refused before any kernel call");
});

test("v0.5: the same origin_key twice derives the same effect_id and re-seals byte-identically", async () => {
  const dir = tempDir();
  const seams = freshSeams();
  const counts = zeroCounts();
  const first = new OpsClientSpy();
  const startedA = await startWork(dir, "development", [WORK_ITEM, "8", "6"], {
    originProfile: "v05", originKey: "origin-stable", dependencies: seamDeps(dir, seams, first, counts),
  });

  // EVERY environment seam the audit named now MOVES — the ref advanced, the image was rebuilt,
  // the namespace was re-read, the manifest changed. A retry must notice none of it.
  seams.base_sha = "1".repeat(40);
  seams.image_tag = "cadp-surface:9.9.9";
  seams.image_digest = "sha256:bbbb";
  seams.tool_versions = { "codex-cli": "9.9.9", claude: "9.9.9", grok: "9.9.9" };
  seams.namespace_id = "namespace-uuid-2";
  seams.repo_id = "7654321";
  seams.created_at = "2027-01-01T00:00:00.000Z";

  const second = new OpsClientSpy();
  const startedB = await startWork(dir, "development", [WORK_ITEM, "8", "6"], {
    originProfile: "v05", originKey: "origin-stable", dependencies: seamDeps(dir, seams, second, counts),
  });

  assert.equal(startedB!.effect_id, startedA!.effect_id, "one logical origin, one effect_id");
  assert.deepEqual(second.tuples[0], first.tuples[0], "one logical origin, one allocation tuple");
  assert.equal(second.materialBytes().equals(first.materialBytes()), true, "the sealed material is BYTE-identical across the retry");
  assert.equal(second.argsBytes().equals(first.argsBytes()), true, "and so are the args it digests");
  assert.equal(
    (JSON.parse(second.argsBytes().toString("utf8")) as { development: { base_sha: string } }).development.base_sha,
    SHA,
    "the retry carries the RECORDED base_sha, not the moved tip",
  );

  // The invariant, mechanically: not one environment seam was touched on the retry.
  assert.deepEqual(counts, { resolveBase: 1, imageIdentity: 1, namespaceId: 1, workerImageTag: 1 },
    "every environment seam is resolved exactly once, at origin creation");
});

test("v0.5 records the origin BEFORE the first kernel call, and the record holds the whole audited input set", async () => {
  const dir = tempDir();
  const seams = freshSeams();
  const client = new OpsClientSpy();
  await startWork(dir, "development", [WORK_ITEM, "8", "6"], {
    originProfile: "v05", originKey: "origin-recorded", dependencies: seamDeps(dir, seams, client, zeroCounts()),
  });

  const path = originRecordPath(dir, "origin-recorded");
  assert.equal(existsSync(path), true, "one file per origin, named by the key");
  const record = JSON.parse(readFileSync(path, "utf8")) as OriginRecordV1;
  assert.equal(record.schema, ORIGIN_RECORD_SCHEMA);
  assert.equal(record.origin_key, "origin-recorded");
  assert.equal(record.work_item_digest, sha256Hex(WORK_ITEM));
  assert.deepEqual(record.material_inputs, {
    repo_id: seams.repo_id,
    repo_full_name: seams.repo_full_name,
    base_sha: SHA,
    surface_image: { image: IMAGE_TAG, image_digest: seams.image_digest, tool_versions: seams.tool_versions },
    namespace_id: seams.namespace_id,
  }, "every environment-resolved material input is persisted — a field added without joining this set would drift");
  assert.equal(record.created_at, seams.created_at);
});

test("v0.5 adopts a record another writer won, material and all — first-writer-wins, no lock", async () => {
  const dir = tempDir();
  const seams = freshSeams();
  const client = new OpsClientSpy();
  const counts = zeroCounts();
  // A racer got there first and resolved a DIFFERENT tip. The record is immutable and NOT
  // content-deterministic, so the loser must adopt the winner's material rather than overwrite it.
  // The winner's record is produced by a REAL start in a scratch dir, so its argument identity is
  // whatever ops.ts actually computes rather than a formula restated here.
  const scratch = tempDir();
  await startWork(scratch, "development", [WORK_ITEM, "8", "6"], {
    originProfile: "v05", originKey: "origin-raced", dependencies: seamDeps(scratch, freshSeams(), new OpsClientSpy(), zeroCounts()),
  });
  const winner: OriginRecordV1 = {
    ...(JSON.parse(readFileSync(originRecordPath(scratch, "origin-raced"), "utf8")) as OriginRecordV1),
    material_inputs: {
      repo_id: "9999", repo_full_name: "owner/repo", base_sha: "c".repeat(40),
      surface_image: { image: "cadp-surface:winner", image_digest: "sha256:cccc", tool_versions: { "codex-cli": "0.0.1" } },
      namespace_id: "namespace-winner",
    },
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const path = originRecordPath(dir, "origin-raced");
  mkdirSync(join(dir, "origin-keys"), { recursive: true });
  writeFileSync(path, JSON.stringify(winner));

  await startWork(dir, "development", [WORK_ITEM, "8", "6"], {
    originProfile: "v05", originKey: "origin-raced", dependencies: seamDeps(dir, seams, client, counts),
  });

  const args = JSON.parse(client.argsBytes().toString("utf8")) as { development: Record<string, unknown> };
  assert.equal(args.development["base_sha"], "c".repeat(40), "the winner's base_sha is adopted verbatim");
  assert.equal(args.development["repo_id"], "9999");
  const material = JSON.parse(client.materialBytes().toString("utf8")) as Record<string, unknown>;
  assert.equal(material["continuation_target"], "temporal:cadp-v04:namespace-winner");
  assert.deepEqual(counts, { resolveBase: 0, imageIdentity: 0, namespaceId: 0, workerImageTag: 0 },
    "an adopting invocation resolves NOTHING from the environment");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).created_at, winner.created_at, "the winner's record is not overwritten");
});

test("v0.5 REFUSES to adopt a record whose arguments differ — before any kernel call", async () => {
  const dir = tempDir();
  const seams = freshSeams();
  const first = new OpsClientSpy();
  await startWork(dir, "development", [WORK_ITEM, "8", "6"], {
    originProfile: "v05", originKey: "origin-guarded", dependencies: seamDeps(dir, seams, first, zeroCounts()),
  });

  const second = new OpsClientSpy();
  const counts = zeroCounts();
  await assert.rejects(
    () => startWork(dir, "development", ["a different work item", "8", "6"], {
      originProfile: "v05", originKey: "origin-guarded", dependencies: seamDeps(dir, seams, second, counts),
    }),
    (error: unknown) => {
      assert.ok(error instanceof OriginStartError, String(error));
      assert.equal(error.origin_key, "origin-guarded");
      assert.match(error.message, /origin_key origin-guarded is already bound to a different logical origin/u);
      assert.match(error.message, new RegExp(`recorded work_item_digest=${sha256Hex(WORK_ITEM)}`, "u"));
      assert.match(error.message, new RegExp(`presented work_item_digest=${sha256Hex("a different work item")}`, "u"));
      return true;
    },
  );
  assert.equal(second.calls.length, 0, "the injected client saw ZERO calls: the guard is pre-kernel");
  assert.equal(counts.resolveBase, 0, "and nothing was re-resolved either");

  // The same key with the SAME arguments still converges, so the guard is about conflict alone.
  const third = new OpsClientSpy();
  const again = await startWork(dir, "development", [WORK_ITEM, "8", "6"], {
    originProfile: "v05", originKey: "origin-guarded", dependencies: seamDeps(dir, seams, third, zeroCounts()),
  });
  assert.deepEqual(third.tuples[0], first.tuples[0]);
  assert.equal(third.materialBytes().equals(first.materialBytes()), true);
  assert.equal(typeof again?.effect_id, "string");

  // A bound-only difference is an argument difference too: it changes what would be sealed.
  const fourth = new OpsClientSpy();
  await assert.rejects(
    () => startWork(dir, "development", [WORK_ITEM, "9", "6"], {
      originProfile: "v05", originKey: "origin-guarded", dependencies: seamDeps(dir, seams, fourth, zeroCounts()),
    }),
    (error: unknown) => error instanceof OriginStartError,
  );
  assert.equal(fourth.calls.length, 0);

  // But a different SPELLING of the same argument set is not: the identity is over the EFFECTIVE
  // arguments, so omitting a bound whose default is what the record was created with converges. A
  // recovery retry must never be refused for restating the same work differently.
  const fifth = new OpsClientSpy();
  await startWork(dir, "development", [WORK_ITEM], {
    originProfile: "v05", originKey: "origin-guarded", dependencies: seamDeps(dir, seams, fifth, zeroCounts()),
  });
  assert.equal(fifth.materialBytes().equals(first.materialBytes()), true, "the omitted defaults are the recorded arguments");
});

// ------------------------------------------------------------------ minting once, and durability

test("a MINTED origin_key is generated exactly once and survives a failed start — log, error and record", async () => {
  const dir = tempDir();
  const seams = freshSeams();
  const client = new OpsClientSpy();
  client.failOn = "allocateEffectId"; // the FIRST kernel call: everything before it must be durable
  const { log, lines } = collector();
  let minted = 0;
  const deps = seamDeps(dir, seams, client, zeroCounts(), {
    mintOriginKey: () => {
      minted += 1;
      return `11111111-1111-7111-8111-00000000000${minted}`;
    },
  });

  const failure = await startWork(dir, "development", [WORK_ITEM, "8", "6"], {
    originProfile: "v05", log, dependencies: deps,
  }).then(() => undefined, (error: unknown) => error);

  assert.equal(minted, 1, "exactly one mint");
  const key = "11111111-1111-7111-8111-000000000001";
  assert.ok(failure instanceof OriginStartError, String(failure));
  assert.equal(failure.origin_key, key, "the thrown error carries the key");
  assert.match(failure.message, /injected allocateEffectId failure/u, "and the cause it failed for");
  assert.match(failure.message, new RegExp(`\\[origin_key=${key}\\]`, "u"));
  const emitted = lines.find((line) => line["origin_key_minted"] === true);
  assert.equal(emitted?.["origin_key"], key, "the key was emitted through the log before anything could fail");
  const record = JSON.parse(readFileSync(originRecordPath(dir, key), "utf8")) as OriginRecordV1;
  assert.equal(record.origin_key, key, "a crashed process leaves a recoverable record on disk");
  assert.equal(record.material_inputs.base_sha, SHA);

  // RECOVERY: read the record, re-invoke with its key. A moved ref changes nothing.
  seams.base_sha = "2".repeat(40);
  const retryCounts = zeroCounts();
  const retryClient = new OpsClientSpy();
  const started = await startWork(dir, "development", [WORK_ITEM, "8", "6"], {
    originProfile: "v05", originKey: record.origin_key, dependencies: seamDeps(dir, seams, retryClient, retryCounts),
  });
  assert.deepEqual(retryClient.tuples[0], { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: key, purpose: "work-start" });
  assert.equal(started?.origin_key, key);
  assert.equal(
    (JSON.parse(retryClient.argsBytes().toString("utf8")) as { development: { base_sha: string } }).development.base_sha,
    SHA,
    "the recovered origin re-derives the SAME allocation tuple over the SAME recorded material",
  );
  assert.deepEqual(retryCounts, zeroCounts(), "and re-resolves nothing");
  assert.equal(minted, 1, "the retry mints nothing: the key was passed, not regenerated");
});

test("a minted origin_key is reused across a retry rather than regenerated, so the run never forks", async () => {
  const dir = tempDir();
  const seams = freshSeams();
  const keys: string[] = [];
  const mint = (): string => {
    keys.push(`22222222-2222-7222-8222-00000000000${keys.length + 1}`);
    return keys.at(-1)!;
  };
  const firstClient = new OpsClientSpy();
  const a = await startWork(dir, "development", [WORK_ITEM, "8", "6"], {
    originProfile: "v05", dependencies: seamDeps(dir, seams, firstClient, zeroCounts(), { mintOriginKey: mint }),
  });
  const secondClient = new OpsClientSpy();
  const b = await startWork(dir, "development", [WORK_ITEM, "8", "6"], {
    originProfile: "v05", originKey: a!.origin_key!, dependencies: seamDeps(dir, seams, secondClient, zeroCounts(), { mintOriginKey: mint }),
  });
  assert.equal(keys.length, 1, "the retry passed the recorded key, so nothing was minted");
  assert.equal(b!.effect_id, a!.effect_id);
  assert.equal(secondClient.materialBytes().equals(firstClient.materialBytes()), true);

  // The contrast that makes the claim mean something: a start with NO key mints a NEW origin.
  const thirdClient = new OpsClientSpy();
  const c = await startWork(dir, "development", [WORK_ITEM, "8", "6"], {
    originProfile: "v05", dependencies: seamDeps(dir, seams, thirdClient, zeroCounts(), { mintOriginKey: mint }),
  });
  assert.equal(keys.length, 2);
  assert.notEqual(c!.effect_id, a!.effect_id, "a different logical origin is a different identity");
});

// -------------------------------------------------- the record vertical's deterministic prefix

test("v0.5 derives the record-vertical resource_prefix from the origin_key alone", async () => {
  const seams = freshSeams();
  const counts = zeroCounts();
  const run = async (key: string): Promise<Record<string, unknown>> => {
    const dir = tempDir();
    const client = new OpsClientSpy();
    await startWork(dir, "record", ["2", "6", "4"], {
      originProfile: "v05", originKey: key, dependencies: seamDeps(dir, seams, client, counts),
    });
    return (JSON.parse(client.argsBytes().toString("utf8")) as { record: Record<string, unknown> }).record;
  };

  const one = await run("origin-record-1");
  // The record vertical's material has no base at all, so a record origin resolves none: the v0.5
  // branch must not add a `git ls-remote` (and its failure mode) where v0.4 had none.
  assert.equal(counts.resolveBase, 0, "a record-vertical origin never resolves a base_sha");
  assert.equal(one["resource_prefix"], originResourcePrefix("origin-record-1"));
  assert.match(String(one["resource_prefix"]), /^live-[0-9a-f]{12}$/u, "no clock digits: a pure function of the key");
  assert.deepEqual(await run("origin-record-1"), one, "stable for one origin, in a fresh deployment dir");
  assert.notEqual((await run("origin-record-2"))["resource_prefix"], one["resource_prefix"], "distinct origins stay distinct");
});

test("no wall clock reaches the v0.5 tuple or material: two origin creations under different clocks agree", async () => {
  const realNow = Date.now;
  const bytes: Buffer[] = [];
  const tuples: AllocationTuple[] = [];
  try {
    for (const [stamp, created] of [[1_000_000_000_000, "2001-09-09T01:46:40.000Z"], [2_000_000_000_000, "2033-05-18T03:33:20.000Z"]] as const) {
      Date.now = () => stamp;
      const dir = tempDir(); // a FRESH deployment dir, so each takes the origin-CREATION path
      const seams = { ...freshSeams(), created_at: created };
      const client = new OpsClientSpy();
      await startWork(dir, "development", [WORK_ITEM, "8", "6"], {
        originProfile: "v05", originKey: "origin-clockless", dependencies: seamDeps(dir, seams, client, zeroCounts()),
      });
      bytes.push(client.materialBytes());
      tuples.push(client.tuples[0]!);
    }
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(tuples[1], tuples[0], "the allocation tuple is clock-free");
  assert.equal(bytes[1]!.equals(bytes[0]!), true, "and so is every byte of the sealed material");
});

// ------------------------------------------------------------------------ workPlan's derived keys

test("planOriginKey is stable and distinct by proposal_evidence_id and item index", () => {
  const proposal = "cadp-v04:evidence:aaaa";
  const other = "cadp-v04:evidence:bbbb";
  assert.equal(planOriginKey(proposal, 0), planOriginKey(proposal, 0), "stable: re-running a plan re-derives the same key");
  assert.notEqual(planOriginKey(proposal, 0), planOriginKey(proposal, 1), "distinct by item index");
  assert.notEqual(planOriginKey(proposal, 0), planOriginKey(other, 0), "distinct by proposal");
  assert.match(planOriginKey(proposal, 0), /^[0-9a-f]{64}$/u, "filesystem-safe by construction");
  const keys = new Set([0, 1, 2, 3].flatMap((i) => [planOriginKey(proposal, i), planOriginKey(other, i)]));
  assert.equal(keys.size, 8, "no collisions across the (proposal, index) grid");
});

test("workPlan threads one derived origin_key per item into startWork, and re-running a plan re-derives them", async () => {
  const proposal = "cadp-v04:evidence:plan-1";
  const items: WorkProposalV1["items"] = [
    { work_item: "item one", max_steps: 8, max_effects: 6 },
    { work_item: "item two", max_steps: 8, max_effects: 6 },
  ] as WorkProposalV1["items"];
  const seen: Array<{ extra: string[]; originKey: string | undefined; profile: string | undefined }> = [];
  const options = {
    originProfile: "v05" as const,
    dependencies: {
      loadProposal: async () => ({ schema: "cadp.work-proposal.v1", items }) as unknown as WorkProposalV1,
      startWork: (async (_dir: string, _vertical: string, extra: string[], opts: Record<string, unknown>) => {
        seen.push({ extra, originKey: opts["originKey"] as string | undefined, profile: opts["originProfile"] as string | undefined });
        return { effect_id: `effect-${seen.length}`, workflow_id: `wf-${seen.length}`, origin_key: opts["originKey"] as string };
      }) as never,
      pollRun: (async () => ({ state: "DELIVERED" })) as never,
    },
  };

  const first = await workPlan("/nonexistent", proposal, undefined, undefined, options);
  assert.equal(first.length, 2);
  assert.deepEqual(seen.map((s) => s.originKey), [planOriginKey(proposal, 0), planOriginKey(proposal, 1)]);
  assert.deepEqual(seen.map((s) => s.profile), ["v05", "v05"]);
  assert.equal(seen[0]!.extra[3], proposal, "the proposal id is still bound as exact provenance");

  seen.length = 0;
  await workPlan("/nonexistent", proposal, undefined, undefined, options);
  assert.deepEqual(seen.map((s) => s.originKey), [planOriginKey(proposal, 0), planOriginKey(proposal, 1)],
    "a re-run of the same plan re-derives the same origins — no record needed, the keys are pure");
});
