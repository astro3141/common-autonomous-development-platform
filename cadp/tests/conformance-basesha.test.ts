/**
 * `cadp/live/ops.ts` conformance — the WORK_START ORIGIN PATH and the seal-time base it declares.
 *
 * PART 1, `resolveBaseSha`: the sealed base is the DECLARED ref's tip at seal time, never a cached
 * or manifest-snapshot value, and every resolution problem refuses rather than sealing a stale base.
 *
 * PART 2, the two ORIGIN PROFILES of `startWork` (WP §3.6; AP B1(5), B5(9); controls A4/A5). The
 * v0.5 migration is CONDITIONAL, so both branches are pinned here:
 *
 *   v0.4 (the DEFAULT, and what the live deployment exercises) — the zero-sentinel
 *   `cadp.allocation-key.v1` tuple with its wall-clock `step_ordinal`, a `base_sha` resolved fresh
 *   on every attempt, the record vertical's wall-clock `resource_prefix`, NO work-run binding, NO
 *   allocation tuple on the seal and NO origin record touched. Pinned as a regression: this branch
 *   is the only one a v1 kernel config accepts, and nothing in the v0.5 lane may move it.
 *
 *   v0.5 — allocation under `cadp.allocation-key.run-origin.v1` presenting exactly
 *   `{schema, origin_key, purpose}`, EXACTLY ONE work-run binding whose `object_id` is the allocated
 *   `effect_id` itself, an `origin_key` decided once per logical origin (derived from
 *   `proposal_evidence_id` + item index on the `workPlan` path; minted ONCE by `crypto.randomUUID`
 *   on a direct start and recoverable from the log, from the thrown error and from a per-origin
 *   state file), and sealed material that is BYTE-REPRODUCIBLE for that origin: every
 *   environment-resolved input is pinned in the origin record at creation and adopted verbatim
 *   thereafter, so a moved base ref, a rebuilt worker image or an absent manifest cannot turn a
 *   retry into a `REQUEST_DIGEST_CONFLICT`. Argument-derived fields are VERIFIED against the record
 *   instead (one `origin_key` = one argument set), an incomplete or unknown-version record fails
 *   closed naming its file, and concurrent creators converge first-writer-wins with no lock.
 *
 * The kernel here is a scripted client with the K3 re-seal semantics (identical semantic payload ⇒
 * idempotent no-op, any difference ⇒ `REQUEST_DIGEST_CONFLICT`), which is what lets these cases
 * assert on BYTES and on CALL COUNTS. The same path against the REAL Ingress/PEP — the origin
 * adjudication, the `run_membership(E, E)` witness and the zero-incident retry — is asserted in
 * `conformance-runorigin.test.ts`, where the kernel is the real one.
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  originRecordPath, originResourcePrefix, planItemOriginKey, resolveBaseSha, startWork, workPlan,
} from "../live/ops.ts";
import type { StartWorkDependencies, SurfaceImageIdentity, WorkStartKernelClient } from "../live/ops.ts";
import type { LiveEnvManifest } from "../live/env.ts";
import { sha256Hex } from "../kernel/canonical.ts";

const SHA = "8cbc629d3adf9f29c8e21ecb69a11a7cfbcbe4f1";

// ============================================================================ PART 1 — resolveBaseSha

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

// ============================================================================ PART 2 — the origin path

/** The tip the base ref MOVES to between two attempts at one origin. */
const MOVED_SHA = "1111111111111111111111111111111111111111";

const IMAGE: SurfaceImageIdentity = {
  image: "cadp-surface:0.151.0-2.1.221",
  image_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  tool_versions: { "codex-cli": "1.2.3", claude: "4.5.6", grok: "absent" },
};

/** A REBUILT image: the second environment seam a retry must not read (see the ops.ts audit). */
const REBUILT_IMAGE: SurfaceImageIdentity = {
  image: "cadp-surface:0.152.0-2.1.222",
  image_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  tool_versions: { "codex-cli": "9.9.9", claude: "4.5.6", grok: "absent" },
};

const MANIFEST = { repo_id: "42", repo_full_name: "owner/repo" } as unknown as LiveEnvManifest;

interface SealedSeal {
  effect_id: string;
  body: Record<string, unknown>;
  /** The material blob's exact bytes — what `material_digest` is taken over. */
  materialBytes: string;
  argsBytes: string;
  idempotent: boolean;
}

interface ScriptedKernel {
  client: WorkStartKernelClient;
  calls: string[];
  tuples: Array<Record<string, unknown>>;
  seals: SealedSeal[];
  /** effect_id → the seal that created its K3 row (a re-seal never replaces it). */
  rows: Map<string, SealedSeal>;
}

/**
 * A scripted kernel with the two properties the origin contract is graded against: allocation
 * CONVERGES on one `effect_id` per presented tuple (AP B1(2)), and a re-seal of an existing
 * `effect_id` is an idempotent no-op when its semantic payload is identical and a
 * `REQUEST_DIGEST_CONFLICT` otherwise (Spec v0.5 K3). Everything is recorded, so a case can assert
 * on the exact tuple, the exact bindings, the exact bytes and the exact CALL COUNT — the last of
 * which is how "refused before any kernel call" is stated.
 */
function scriptedKernel(hooks: { onAllocate?: (tuple: Record<string, unknown>) => void } = {}): ScriptedKernel {
  const calls: string[] = [];
  const tuples: Array<Record<string, unknown>> = [];
  const seals: SealedSeal[] = [];
  const rows = new Map<string, SealedSeal>();
  const allocations = new Map<string, string>();
  const blobs = new Map<string, string>();
  const semanticOf = (body: Record<string, unknown>): string =>
    JSON.stringify([
      body["requester_ref"], body["work_bindings"], body["target_ref"], body["operation_kind"],
      body["material_schema"], body["material_ref"], body["prior_effect_refs"], body["allocation_tuple"],
    ]);
  const client = {
    async allocateEffectId(tuple: Record<string, unknown>): Promise<{ effect_id: string }> {
      calls.push("allocateEffectId");
      tuples.push(tuple);
      hooks.onAllocate?.(tuple);
      const key = sha256Hex(JSON.stringify(tuple));
      const existing = allocations.get(key);
      if (existing !== undefined) return { effect_id: existing };
      const effect_id = `cadp-v04:effect:00000000-0000-7000-8000-${String(allocations.size + 1).padStart(12, "0")}`;
      allocations.set(key, effect_id);
      return { effect_id };
    },
    async putBlob(bytes: Uint8Array): Promise<{ cas_key: string }> {
      calls.push("putBlob");
      const text = Buffer.from(bytes).toString("utf8");
      const cas_key = `cadp-v04:cas:${sha256Hex(text)}`;
      blobs.set(cas_key, text);
      return { cas_key };
    },
    async sealEffectRequest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      calls.push("sealEffectRequest");
      const effect_id = body["effect_id"] as string;
      const materialBytes = blobs.get(body["material_ref"] as string)!;
      const argsBytes = blobs.get((JSON.parse(materialBytes) as { args_cas_key: string }).args_cas_key)!;
      const sealed: SealedSeal = { effect_id, body, materialBytes, argsBytes, idempotent: false };
      const existing = rows.get(effect_id);
      if (existing !== undefined) {
        if (semanticOf(existing.body) !== semanticOf(body)) {
          throw new Error(`REQUEST_DIGEST_CONFLICT: effect ${effect_id} re-sealed with different material`);
        }
        sealed.idempotent = true;
        seals.push(sealed);
        return { effect_id, request_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256Hex(semanticOf(existing.body)) } };
      }
      rows.set(effect_id, sealed);
      seals.push(sealed);
      return { effect_id, request_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256Hex(semanticOf(body)) } };
    },
    async assembleAdmissionInput(): Promise<Record<string, unknown>> {
      calls.push("assembleAdmissionInput");
      return { input_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: "input" } };
    },
    async evaluate(): Promise<Record<string, unknown>> {
      calls.push("evaluate");
      return { kind: "DECISION", decision: { decision_id: "cadp-v04:decision:1", outcome: "ALLOW" } };
    },
    async admitAndDispatch(): Promise<Record<string, unknown>> {
      calls.push("admitAndDispatch");
      return { kind: "ADMITTED", admission: {}, outcome: { result: "COMMITTED" } };
    },
  };
  return { client: client as unknown as WorkStartKernelClient, calls, tuples, seals, rows };
}

const deployments: string[] = [];
after(() => {
  for (const dir of deployments) rmSync(dir, { recursive: true, force: true });
});

function deployment(): string {
  const dir = mkdtempSync(join(tmpdir(), "cadp-ops-"));
  deployments.push(dir);
  return dir;
}

function deps(kernel: ScriptedKernel, overrides: Partial<StartWorkDependencies> = {}): StartWorkDependencies {
  return {
    manifest: MANIFEST,
    client: kernel.client,
    namespaceId: "cadp-v04",
    resolveBase: () => SHA,
    surfaceImage: () => IMAGE,
    ...overrides,
  };
}

const DEV_ITEM = ["implement median", "8", "6", "cadp-v04:evidence:p1"];

function bindings(seal: SealedSeal): Array<{ authority_ref: string; namespace: string; object_id: string }> {
  return seal.body["work_bindings"] as Array<{ authority_ref: string; namespace: string; object_id: string }>;
}

function argsOf(seal: SealedSeal): Record<string, Record<string, unknown>> {
  return JSON.parse(seal.argsBytes) as Record<string, Record<string, unknown>>;
}

function recordOf(dir: string, origin_key: string): Record<string, Record<string, unknown> & string> {
  return JSON.parse(readFileSync(originRecordPath(dir, origin_key), "utf8")) as never;
}

// ---------------------------------------------------------------- v0.4: the regression pin

test("v0.4 (the default): the zero-sentinel tuple, the wall-clock ordinal and a fresh base — untouched, and no origin record", async () => {
  const dir = deployment();
  const kernel = scriptedKernel();
  let sha = SHA;
  const started = await startWork(dir, "development", DEV_ITEM, {
    ordinalArg: "77",
    dependencies: deps(kernel, { resolveBase: () => sha }),
  });
  assert.deepEqual(kernel.tuples[0], {
    schema: "cadp.allocation-key.v1",
    work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: 77,
    purpose: "work-start",
  }, "the v0.4 allocation tuple is exactly today's");
  const seal = kernel.seals[0]!;
  assert.equal(seal.body["allocation_tuple"], undefined, "no tuple rides a v0.4 seal");
  assert.deepEqual(bindings(seal).map((b) => b.namespace), ["work-item", "work-proposal"], "no work-run binding on the v0.4 path");
  assert.equal(argsOf(seal)["development"]!["base_sha"], SHA);
  assert.equal(started?.origin_key, undefined, "the v0.4 result carries no origin key");
  assert.equal(existsSync(join(dir, "origin-keys")), false, "the v0.4 branch neither reads nor writes an origin record");

  // The pin's other half: v0.4 re-resolves the base on every attempt, so a moved ref moves the
  // sealed material. That is TODAY's behaviour and this branch keeps it — the v0.5 branch below is
  // where a retry of ONE origin is required to reproduce the first attempt's bytes instead.
  sha = MOVED_SHA;
  await startWork(dir, "development", DEV_ITEM, { ordinalArg: "78", dependencies: deps(kernel, { resolveBase: () => sha }) });
  assert.equal(argsOf(kernel.seals[1]!)["development"]!["base_sha"], MOVED_SHA);
  assert.equal(existsSync(join(dir, "origin-keys")), false);
});

test("v0.4 (the default): the record vertical keeps its wall-clock resource_prefix", async () => {
  const dir = deployment();
  const kernel = scriptedKernel();
  await startWork(dir, "record", ["2", "6", "4"], { ordinalArg: "5", dependencies: deps(kernel) });
  const record = argsOf(kernel.seals[0]!)["record"]!;
  assert.match(record["resource_prefix"] as string, /^live-\d{1,5}$/u, "today's `live-${Date.now() % 100000}` shape");
  assert.deepEqual(record["payloads"], ["live payload 1", "live payload 2"]);
  assert.equal(existsSync(join(dir, "origin-keys")), false);
});

// ---------------------------------------------------------------- v0.5: identity and idempotence

test("v0.5: one origin_key derives one effect_id, and the re-seal is an idempotent no-op over identical bytes", async () => {
  const dir = deployment();
  const kernel = scriptedKernel();
  const originKey = "origin-fixed-1";
  const first = await startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey, dependencies: deps(kernel) });
  const second = await startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey, dependencies: deps(kernel) });

  assert.deepEqual(kernel.tuples[0], { schema: "cadp.allocation-key.run-origin.v1", origin_key: originKey, purpose: "work-start" }, "exactly {schema, origin_key, purpose}");
  assert.deepEqual(Object.keys(kernel.tuples[0]!), ["schema", "origin_key", "purpose"], "no step_ordinal, no work_run_ref, nothing wall-clock");
  assert.deepEqual(kernel.tuples[1], kernel.tuples[0], "the retry presents the identical tuple");
  assert.equal(first?.effect_id, second?.effect_id, "one origin_key → one effect_id");
  assert.equal(first?.origin_key, originKey, "the result carries the key a retry must present");
  assert.equal(second?.workflow_id, first?.workflow_id);

  assert.equal(kernel.seals[1]!.materialBytes, kernel.seals[0]!.materialBytes, "byte-identical sealed material");
  assert.equal(kernel.seals[1]!.argsBytes, kernel.seals[0]!.argsBytes, "byte-identical args");
  assert.equal(kernel.seals[1]!.idempotent, true, "the re-seal is the idempotent no-op, not a REQUEST_DIGEST_CONFLICT");
  assert.equal(kernel.rows.size, 1, "one K3 row for the origin");
  assert.deepEqual(kernel.seals[1]!.body["allocation_tuple"], kernel.tuples[0], "B6(1): the tuple rides the re-seal verbatim");
});

test("v0.5: EXACTLY ONE work-run binding, and its object_id is the allocated effect_id itself", async () => {
  const dir = deployment();
  const kernel = scriptedKernel();
  const started = await startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey: "origin-self-bind", dependencies: deps(kernel) });
  const workRun = bindings(kernel.seals[0]!).filter((b) => b.namespace === "work-run");
  assert.equal(workRun.length, 1, "AP B5(9) leg 2: exactly one binding on the declared work-run pair");
  assert.deepEqual(workRun[0], { authority_ref: "cadp-store:k04", namespace: "work-run", object_id: started!.effect_id }, "leg 3: the run is this request's own effect_id");
  assert.deepEqual(bindings(kernel.seals[0]!).map((b) => b.namespace), ["work-item", "work-proposal", "work-run"], "the pre-existing bindings are unchanged and unreordered");
});

test("v0.5: two distinct origins over byte-identical work get distinct effect_ids (identity, never content)", async () => {
  const dir = deployment();
  const kernel = scriptedKernel();
  const a = await startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey: "origin-a", dependencies: deps(kernel) });
  const b = await startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey: "origin-b", dependencies: deps(kernel) });
  assert.notEqual(a!.effect_id, b!.effect_id);
  assert.equal(kernel.rows.size, 2, "two origins, two K3 rows, zero conflicts");
});

// ---------------------------------------------------------------- v0.5: the material-pinning invariant

test("v0.5: a retry reconstructs from the record alone — a moved ref AND a rebuilt image change nothing", async () => {
  const dir = deployment();
  const kernel = scriptedKernel();
  const originKey = "origin-pinned";
  await startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey, dependencies: deps(kernel) });

  // Every environment seam the ops.ts audit found, flipped at once: the resolver now reports a new
  // tip and the worker image was rebuilt. A retry that consulted either would seal different bytes.
  let consulted = 0;
  const retry = await startWork(dir, "development", DEV_ITEM, {
    originProfile: "v05",
    originKey,
    dependencies: deps(kernel, {
      resolveBase: () => { consulted += 1; return MOVED_SHA; },
      surfaceImage: () => { consulted += 1; return REBUILT_IMAGE; },
    }),
  });
  assert.equal(consulted, 0, "the retry recomputes NOTHING from the environment");
  assert.equal(kernel.seals[1]!.materialBytes, kernel.seals[0]!.materialBytes, "byte-identical material despite the drift");
  assert.equal(kernel.seals[1]!.idempotent, true, "the seal is the idempotent no-op");
  assert.equal(argsOf(kernel.seals[1]!)["development"]!["base_sha"], SHA, "the recorded base, not the moved tip");
  assert.equal((JSON.parse(kernel.seals[1]!.materialBytes) as { surface_image: SurfaceImageIdentity }).surface_image.image, IMAGE.image, "the recorded image, not the rebuilt one");
  assert.equal(retry!.effect_id, kernel.seals[0]!.effect_id);
});

test("v0.5: a record exists ⇒ recovery needs no manifest at all (the manifest is environment, not material)", async () => {
  const dir = deployment();
  const kernel = scriptedKernel();
  const originKey = "origin-no-manifest";
  await startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey, dependencies: deps(kernel) });

  // A deliberately CORRUPT manifest, and no injected one: `loadManifest` throws on it.
  writeFileSync(join(dir, "manifest.json"), "{not json");
  let touched = 0;
  const withoutManifest: StartWorkDependencies = {
    client: kernel.client,
    resolveBase: () => { touched += 1; return MOVED_SHA; },
    surfaceImage: () => { touched += 1; return REBUILT_IMAGE; },
  };
  const retry = await startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey, dependencies: withoutManifest });
  assert.equal(touched, 0, "no environment read at all on the record path");
  assert.equal(kernel.seals[1]!.materialBytes, kernel.seals[0]!.materialBytes, "material reconstructed byte-identically with no manifest read");
  assert.equal(kernel.seals[1]!.idempotent, true);
  assert.equal(retry!.effect_id, kernel.seals[0]!.effect_id);

  // The complement, so the case is not vacuous: with NO record the same invocation DOES need the
  // manifest — it is where a FIRST-TIME origin resolves `repo_id`/`repo_full_name` — and the corrupt
  // file fails there, before any kernel call and before any other environment read. Freeing
  // material RECONSTRUCTION from the environment is the invariant; first-time RESOLUTION is not.
  const before = kernel.calls.length;
  await assert.rejects(
    () => startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey: "origin-fresh", dependencies: withoutManifest }),
    /origin_key=origin-fresh/u,
  );
  assert.equal(touched, 0, "the manifest failure preceded every other resolution");
  assert.equal(kernel.calls.length, before, "and preceded any kernel call");
  assert.equal(existsSync(originRecordPath(dir, "origin-fresh")), false, "a failed resolution writes no record");
});

// ---------------------------------------------------------------- v0.5: the minted key's durability

test("v0.5: a direct start mints exactly once, exposes the key on every surface, and a retry reuses it", async () => {
  const dir = deployment();
  const failing = scriptedKernel({ onAllocate: () => { throw new Error("kernel unreachable"); } });
  const minted: string[] = [];
  const lines: Array<Record<string, unknown>> = [];

  let thrown: unknown;
  await startWork(dir, "development", DEV_ITEM, {
    originProfile: "v05",
    log: (line) => lines.push(line),
    dependencies: deps(failing, { newOriginKey: () => { const key = `minted-${minted.length + 1}`; minted.push(key); return key; } }),
  }).catch((error: unknown) => { thrown = error; });

  assert.deepEqual(minted, ["minted-1"], "exactly one mint");
  const key = minted[0]!;
  // (a) the log — emitted BEFORE anything could fail;
  assert.equal(lines[0]?.["origin_key"], key, "the minted key is emitted through the log callback");
  assert.equal(lines[0]?.["minted"], true);
  // (b) the thrown error's context;
  assert.ok((thrown as Error).message.includes(`origin_key=${key}`), "the failure names the key a retry must present");
  assert.equal((thrown as { origin_key?: string }).origin_key, key, "and carries it as structured context");
  assert.match((thrown as Error).message, /kernel unreachable/u, "the original cause survives the decoration");
  // (c) the state file a CRASHED process leaves behind, readable with nothing but the deployment dir.
  const path = originRecordPath(dir, key);
  assert.equal(existsSync(path), true, "the origin record was written BEFORE the first kernel call");
  const record = recordOf(dir, key);
  assert.equal(record["origin_key"], key, "the record names its own key, so the file alone recovers it");
  assert.equal(record["material_inputs"]!["base_sha"], SHA, "and the material it pinned");

  // The recovery flow: read the key (log, error or file) and re-invoke with it. It mints NOTHING
  // and converges on the same tuple and the same pinned material — the fork a fresh UUID causes.
  const kernel = scriptedKernel();
  const retry = await startWork(dir, "development", DEV_ITEM, {
    originProfile: "v05",
    originKey: key,
    dependencies: deps(kernel, {
      newOriginKey: () => assert.fail("a retry that carries a key must never mint"),
      resolveBase: () => MOVED_SHA,
    }),
  });
  assert.deepEqual(kernel.tuples[0], { schema: "cadp.allocation-key.run-origin.v1", origin_key: key, purpose: "work-start" });
  assert.equal(retry?.origin_key, key);
  assert.equal(argsOf(kernel.seals[0]!)["development"]!["base_sha"], SHA, "the retry seals the RECORDED base, not the moved tip");
  assert.deepEqual(minted, ["minted-1"], "still exactly one mint across the whole logical origin");
});

test("v0.5: the record is written BEFORE the first kernel call, and a failed resolution writes nothing", async () => {
  const dir = deployment();
  const seen: boolean[] = [];
  const kernel = scriptedKernel({ onAllocate: () => seen.push(existsSync(originRecordPath(dir, "origin-order"))) });
  await startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey: "origin-order", dependencies: deps(kernel) });
  assert.deepEqual(seen, [true], "the pin already existed when the allocation was made");

  // RECORD-EXISTS ⇒ RESOLUTION-COMPLETED ⇒ MATERIAL FULLY PINNED. A failed resolution leaves no
  // half-record, and no kernel call happened either, so the clean retry re-resolves from scratch.
  const before = kernel.calls.length;
  await assert.rejects(
    () => startWork(dir, "development", DEV_ITEM, {
      originProfile: "v05",
      originKey: "origin-unresolved",
      dependencies: deps(kernel, { resolveBase: () => { throw new Error("network unreachable"); } }),
    }),
    /network unreachable.*origin_key=origin-unresolved/su,
  );
  assert.equal(existsSync(originRecordPath(dir, "origin-unresolved")), false, "a resolution failure writes NOTHING");
  assert.equal(kernel.calls.length, before, "and reaches no kernel call");
});

// ---------------------------------------------------------------- v0.5: adoption guards

test("v0.5: the same origin_key with DIFFERENT arguments throws before the kernel client is invoked", async () => {
  const dir = deployment();
  const kernel = scriptedKernel();
  const originKey = "origin-guard";
  await startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey, dependencies: deps(kernel) });
  const before = kernel.calls.length;
  await assert.rejects(
    () => startWork(dir, "development", ["a DIFFERENT work item", "8", "6", "cadp-v04:evidence:p1"], { originProfile: "v05", originKey, dependencies: deps(kernel) }),
    (error: Error) => {
      assert.match(error.message, /was created for a DIFFERENT work item/u);
      assert.ok(error.message.includes(`origin_key ${originKey}`), "the message names the key");
      assert.match(error.message, /recorded development\/[0-9a-f]{64}, presented development\/[0-9a-f]{64}/u, "and both digests");
      return true;
    },
  );
  assert.equal(kernel.calls.length, before, "zero kernel calls: the guard is pre-seal");

  // A retry spelling the SAME start with explicit defaults for its optional arguments is the same
  // origin, not a violation: the digest is over the semantic argument set, never the raw argv.
  const same = await startWork(dir, "development", [...DEV_ITEM, "codex", "", ""], { originProfile: "v05", originKey, dependencies: deps(kernel) });
  assert.equal(same!.effect_id, kernel.seals[0]!.effect_id);
  assert.equal(kernel.seals.at(-1)!.idempotent, true);
});

test("v0.5: an incomplete, extra-keyed or unknown-version record fails closed, naming the file, with zero kernel calls", async () => {
  const dir = deployment();
  const kernel = scriptedKernel();
  const originKey = "origin-damaged";
  await startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey, dependencies: deps(kernel) });
  const path = originRecordPath(dir, originKey);
  const pristine = readFileSync(path, "utf8");

  const damaged: Array<{ note: string; text: () => string; detail: RegExp }> = [
    { note: "a deleted top-level field", detail: /missing work_item_digest/u, text: () => {
      const record = JSON.parse(pristine) as Record<string, unknown>;
      delete record["work_item_digest"];
      return JSON.stringify(record);
    } },
    { note: "a deleted material input", detail: /material_inputs\.base_sha is missing/u, text: () => {
      const record = JSON.parse(pristine) as { material_inputs: Record<string, unknown> };
      delete record.material_inputs["base_sha"];
      return JSON.stringify(record);
    } },
    { note: "an unknown version", detail: /unknown record_version 2/u, text: () => {
      const record = JSON.parse(pristine) as Record<string, unknown>;
      record["record_version"] = 2;
      return JSON.stringify(record);
    } },
    { note: "an unparseable file", detail: /unparseable/u, text: () => "{ truncated" },
    // A future lane that adds an environment-derived field must make it join the record
    // CONSCIOUSLY; an unknown one is not silently ignored, in either direction.
    { note: "an undeclared material input", detail: /material_inputs has no field registry_host/u, text: () => {
      const record = JSON.parse(pristine) as { material_inputs: Record<string, unknown> };
      record.material_inputs["registry_host"] = "ghcr.io";
      return JSON.stringify(record);
    } },
  ];
  for (const { note, text, detail } of damaged) {
    writeFileSync(path, text());
    const before = kernel.calls.length;
    await assert.rejects(
      () => startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey, dependencies: deps(kernel) }),
      (error: Error) => {
        assert.ok(error.message.includes(`origin record ${path} is unusable`), `${note}: the error names the file`);
        assert.match(error.message, detail, `${note}: and what is wrong with it`);
        assert.match(error.message, /refusing to guess/u, `${note}: never a per-field environment fallback`);
        return true;
      },
    );
    assert.equal(kernel.calls.length, before, `${note}: zero kernel calls`);
  }

  // Restored, the same start proceeds: the operator repairs or deletes the file deliberately.
  writeFileSync(path, pristine);
  const restored = await startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey, dependencies: deps(kernel) });
  assert.equal(restored!.effect_id, kernel.seals[0]!.effect_id);
});

test("v0.5: a concurrent creator that won the write is ADOPTED, never overwritten (first-writer-wins, no lock)", async () => {
  const dir = deployment();
  const kernel = scriptedKernel();
  // This argument set's digest, taken from a record this same start already wrote.
  await startWork(dir, "development", DEV_ITEM, { originProfile: "v05", originKey: "origin-probe", dependencies: deps(kernel) });
  const digest = recordOf(dir, "origin-probe")["work_item_digest"] as unknown as string;

  const racerRecord = (origin_key: string, work_item_digest: string): string => JSON.stringify({
    record_version: 1,
    origin_key,
    vertical: "development",
    work_item_digest,
    material_inputs: { repo_id: "42", repo_full_name: "owner/repo", base_sha: MOVED_SHA, surface_image: REBUILT_IMAGE, temporal_namespace_id: "cadp-v04" },
    created_at: "2026-09-10T00:00:00.000Z",
  }, null, 2);
  /** The racer lands its COMPLETE record while this start is between its read and its own write. */
  const racer = (origin_key: string, work_item_digest: string) => () => {
    const path = originRecordPath(dir, origin_key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, racerRecord(origin_key, work_item_digest));
    return SHA;
  };

  const raced = "origin-raced";
  const started = await startWork(dir, "development", DEV_ITEM, {
    originProfile: "v05",
    originKey: raced,
    dependencies: deps(kernel, { resolveBase: racer(raced, digest) }),
  });
  assert.equal(readFileSync(originRecordPath(dir, raced), "utf8"), racerRecord(raced, digest), "the winner's record is intact — the loser never overwrote it");
  const seal = kernel.seals.at(-1)!;
  assert.equal(argsOf(seal)["development"]!["base_sha"], MOVED_SHA, "the loser adopted the winner's base");
  assert.equal((JSON.parse(seal.materialBytes) as { surface_image: SurfaceImageIdentity }).surface_image.image, REBUILT_IMAGE.image, "and the winner's image");
  assert.equal(started!.effect_id, seal.effect_id, "one origin, one effect_id — the two racers converge");

  // The write-race path is guarded exactly like the read path: a winner recording DIFFERENT
  // arguments is a caller contract violation, refused before any kernel call rather than adopted.
  const conflicted = "origin-raced-conflict";
  const before = kernel.calls.length;
  await assert.rejects(
    () => startWork(dir, "development", DEV_ITEM, {
      originProfile: "v05",
      originKey: conflicted,
      dependencies: deps(kernel, { resolveBase: racer(conflicted, sha256Hex("some other argument set")) }),
    }),
    /was created for a DIFFERENT work item/u,
  );
  assert.equal(kernel.calls.length, before, "zero kernel calls on the write-race guard too");
});

// ---------------------------------------------------------------- v0.5: the derived (workPlan) keys

test("v0.5: workPlan derives one stable, distinct key per (proposal, index) and threads it verbatim", async () => {
  const dir = deployment();
  assert.equal(planItemOriginKey("cadp-v04:evidence:p1", 0), planItemOriginKey("cadp-v04:evidence:p1", 0), "stable");
  assert.notEqual(planItemOriginKey("cadp-v04:evidence:p1", 0), planItemOriginKey("cadp-v04:evidence:p1", 1), "distinct by index");
  assert.notEqual(planItemOriginKey("cadp-v04:evidence:p1", 0), planItemOriginKey("cadp-v04:evidence:p2", 0), "distinct by proposal");

  const proposal = {
    schema: "cadp.work-proposal.v1" as const,
    items: [
      { work_item: "implement median", max_steps: 8, max_effects: 6 },
      { work_item: "document median", max_steps: 4, max_effects: 3 },
    ],
  };
  const observed: Array<Record<string, unknown>> = [];
  const capture = async (_dir: string, _vertical: unknown, extra: string[], options: Record<string, unknown>) => {
    observed.push({ extra, originKey: options["originKey"], originProfile: options["originProfile"] });
    return undefined; // NOT_ADMITTED halts the loop after one item — the existing fail-closed contract
  };
  const dependencies = { loadProposal: async () => proposal, startWork: capture as unknown as typeof startWork };

  await workPlan(dir, "cadp-v04:evidence:p1", "2", () => {}, { originProfile: "v05", dependencies });
  assert.deepEqual(observed.map((o) => o["originKey"]), [planItemOriginKey("cadp-v04:evidence:p1", 0)], "item 0's key is the derivation of its own coordinates");
  assert.deepEqual(observed[0]!["extra"], ["implement median", "8", "6", "cadp-v04:evidence:p1"], "the item's arguments are unchanged");

  // Re-running the plan re-derives the identical key with no state anywhere: a derived origin needs
  // no file record to be preserved verbatim across retries.
  observed.length = 0;
  await workPlan(dir, "cadp-v04:evidence:p1", "2", () => {}, { originProfile: "v05", dependencies });
  assert.deepEqual(observed.map((o) => o["originKey"]), [planItemOriginKey("cadp-v04:evidence:p1", 0)]);

  // And the default profile threads no key at all — the live v0.4 driver is untouched.
  observed.length = 0;
  await workPlan(dir, "cadp-v04:evidence:p1", "2", () => {}, { dependencies });
  assert.deepEqual(observed.map((o) => [o["originProfile"], o["originKey"]]), [["v04", undefined]]);
});

test("v0.5: a derived (workPlan) key pins its material through the same record as a minted one", async () => {
  const dir = deployment();
  const kernel = scriptedKernel();
  const originKey = planItemOriginKey("cadp-v04:evidence:p1", 0);
  const options = { originProfile: "v05" as const, originKey };
  await startWork(dir, "development", DEV_ITEM, { ...options, dependencies: deps(kernel) });
  const retry = await startWork(dir, "development", DEV_ITEM, { ...options, dependencies: deps(kernel, { resolveBase: () => MOVED_SHA, surfaceImage: () => REBUILT_IMAGE }) });
  assert.equal(kernel.seals[1]!.materialBytes, kernel.seals[0]!.materialBytes, "a moved ref does not fork a DERIVED origin either");
  assert.equal(kernel.seals[1]!.idempotent, true);
  assert.equal(retry!.effect_id, kernel.seals[0]!.effect_id);
});

// ---------------------------------------------------------------- v0.5: the record vertical

test("v0.5: the record vertical's resource_prefix is a function of the origin key, with no wall clock left", async () => {
  const dir = deployment();
  const kernel = scriptedKernel();
  const originKey = "origin-record-vertical";
  await startWork(dir, "record", ["2", "6", "4"], { originProfile: "v05", originKey, dependencies: deps(kernel) });
  await startWork(dir, "record", ["2", "6", "4"], { originProfile: "v05", originKey, dependencies: deps(kernel) });
  const prefix = argsOf(kernel.seals[0]!)["record"]!["resource_prefix"] as string;
  assert.equal(prefix, originResourcePrefix(originKey), "deterministic in the origin's stable key");
  assert.doesNotMatch(prefix, /^live-\d{1,5}$/u, "and no longer the wall-clock shape");
  assert.notEqual(prefix, originResourcePrefix("another-origin"), "distinct origins get distinct prefixes");
  assert.equal(kernel.seals[1]!.materialBytes, kernel.seals[0]!.materialBytes, "so a retry seals byte-identical material");
  assert.equal(kernel.seals[1]!.idempotent, true);
  assert.deepEqual(Object.keys(kernel.tuples[0]!), ["schema", "origin_key", "purpose"], "no step_ordinal on the origin path, on either vertical");
  // …and the ordinal seam is REFUSED here rather than ignored: silently dropping it would read as
  // "the ordinal still discriminates" while two starts collided on one origin.
  await assert.rejects(
    () => startWork(dir, "record", ["2", "6", "4"], { originProfile: "v05", originKey, ordinalArg: "7", dependencies: deps(kernel) }),
    /step_ordinal \(7\) has no meaning on the v0\.5 run-origin path/u,
  );
  // The record vertical resolves no repo and no base: its record carries exactly what its material
  // needs, and a development-only field is not even expressible on this path (WP §3.6, control 15).
  assert.deepEqual(Object.keys(recordOf(dir, originKey)["material_inputs"]!), ["surface_image", "temporal_namespace_id"]);
});
