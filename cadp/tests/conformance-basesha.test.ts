/**
 * `cadp/live/ops.ts` conformance — the live composition's own seal-time glue, exercised through the
 * ONE seam the module exposes for it (the `dependencies` object) so that nothing here reaches the
 * `temporal` CLI, `git ls-remote`, `docker` or a Kernel API, and every non-deterministic source is
 * supplied by the test.
 *
 * TWO SUBJECTS, in this order:
 *
 * (1) `resolveBaseSha` — the base a `WORK_START` DECLARES it builds on is the declared ref's tip AT
 *     SEAL TIME, resolved fresh and never the manifest's setup-time snapshot, and any resolution
 *     problem REFUSES rather than falling back.
 *
 * (2) WP §3.6's RUN-ORIGIN PATH, and its conditional nature above all. The migration is a SECOND
 *     branch, not a replacement: `originProfile` defaults to `"v04"`, which is the path the live
 *     v0.4 deployment and every checked-out caller (`ctl.ts`, `mcpServer.ts`) take, and the first
 *     two tests of that section are REGRESSION PINS on it — the zero-sentinel
 *     `cadp.allocation-key.v1` tuple, its wall-clock `step_ordinal`, the wall-clock record
 *     `resource_prefix`, today's exact `work_bindings` and a seal body carrying no
 *     `allocation_tuple`. Only `"v05"` allocates under `cadp.allocation-key.run-origin.v1`, binds
 *     the self-referential work run, derives the record prefix from the origin key and reads no
 *     clock at all. The v0.5 assertions are stated as REPLAY assertions wherever they can be —
 *     the same logical origin invoked twice under two DIFFERENT wall clocks — because that, and not
 *     an inspection of the code, is what "byte-reproducible for a given origin" means.
 *
 * Cross-kernel legs (that this tuple and this self-binding actually seal as an adjudicated origin
 * through the REAL Ingress, write the `run_membership(E, E)` witness, converge on one `effect_id`
 * and re-seal idempotently with zero incidents and none of the run-profile refusal codes) belong to
 * `conformance-runorigin.test.ts`, which has the harness; they are asserted there and not here.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ORIGIN_KEY_RECORD_FILE, OriginStartFailure, originResourcePrefix, planOriginKey, readOriginKeyRecords,
  resolveBaseSha, startWork, workPlan,
} from "../live/ops.ts";
import type { Log, StartWorkDependencies } from "../live/ops.ts";
import { jcs, jcsDigest, sha256Hex } from "../kernel/canonical.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA } from "../kernel/policyBundle.ts";
import type { LiveEnvManifest } from "../live/env.ts";
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

// ============================================================ WP §3.6 — the origin path, both branches

/** The v0.4 origin allocation's placeholder run ref, spelled here so the pin is independent of the module. */
const ZERO_SENTINEL = "cadp-v04:effect:00000000-0000-7000-8000-000000000000";

const WORKER_IMAGE = "cadp-surface:test";
const IMAGE_IDENTITY = { image: WORKER_IMAGE, image_digest: "sha256:feed", tool_versions: { "codex-cli": "1.2.3" } };
const NAMESPACE_ID = "ns-0000";

/** Two wall clocks a whole epoch apart: what a replay assertion is stated ACROSS. */
const CLOCK_A = 1_700_000_000_000;
const CLOCK_B = 1_900_000_555_000;

const MANIFEST = {
  repo_id: "42",
  repo_full_name: "owner/repo",
  api_url: "http://127.0.0.1:1/unused",
  tokens: {},
} as unknown as LiveEnvManifest;

/**
 * The Kernel API as a recording double. `allocate_effect_id` models the ONE property the origin
 * path rests on (AP B1(2)): the effect identity is a function of the presented tuple, so the same
 * tuple converges and a different tuple does not. `seal_effect_request` models K3's first-seal /
 * identical-re-seal / conflict trichotomy over the same semantic payload the Ingress compares.
 */
class RecordingKernel {
  readonly allocations: Array<Record<string, unknown>> = [];

  readonly blobs: Buffer[] = [];

  readonly seals: Array<Record<string, unknown>> = [];

  /** Re-seals that were an idempotent no-op — K3's "identical semantic content" arm. */
  readonly idempotentReseals: string[] = [];

  /** Re-seals that would be `REQUEST_DIGEST_CONFLICT`: same effect_id, different payload. */
  readonly conflicts: string[] = [];

  readonly #ids = new Map<string, string>();

  readonly #rows = new Map<string, string>();

  failAllocate: Error | undefined;

  async allocateEffectId(tuple: Record<string, unknown>): Promise<{ effect_id: string }> {
    this.allocations.push(tuple);
    if (this.failAllocate !== undefined) throw this.failAllocate;
    const key = jcs(tuple);
    const existing = this.#ids.get(key);
    if (existing !== undefined) return { effect_id: existing };
    const effect_id = `cadp-v04:effect:${sha256Hex(key).slice(0, 8)}-0000-7000-8000-000000000000`;
    this.#ids.set(key, effect_id);
    return { effect_id };
  }

  async putBlob(bytes: Uint8Array): Promise<{ cas_key: string }> {
    const buffer = Buffer.from(bytes);
    this.blobs.push(buffer);
    return { cas_key: `sha256:${sha256Hex(buffer)}` };
  }

  async sealEffectRequest(body: Record<string, unknown>): Promise<{ request_digest: { value: string } }> {
    this.seals.push(body);
    const { allocation_tuple: _tuple, effect_id, ...semantic } = body as { allocation_tuple?: unknown; effect_id: string };
    const payload = jcs(semantic);
    const stored = this.#rows.get(effect_id);
    if (stored !== undefined) {
      if (stored === payload) this.idempotentReseals.push(effect_id);
      else this.conflicts.push(effect_id);
    } else {
      this.#rows.set(effect_id, payload);
    }
    return { request_digest: { value: sha256Hex(this.#rows.get(effect_id)!) } };
  }

  /** One `effect_request` row per effect identity, whatever the number of seals. */
  get rowCount(): number {
    return this.#rows.size;
  }

  async assembleAdmissionInput(): Promise<{ input_digest: { value: string } }> {
    return { input_digest: { value: "input-digest" } };
  }

  async evaluate(): Promise<unknown> {
    return { kind: "DECISION", decision: { decision_id: "decision-1", outcome: "ALLOW" } };
  }

  async admitAndDispatch(): Promise<unknown> {
    return { kind: "ADMITTED", admission: {}, outcome: { result: "COMMITTED" } };
  }
}

interface Rig {
  dir: string;
  kernel: RecordingKernel;
  lines: Array<Record<string, unknown>>;
  minted: string[];
  dependencies: StartWorkDependencies;
  log: Log;
  cleanup: () => void;
}

function rig(options: { uuids?: string[] } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "cadp-ops-"));
  writeFileSync(join(dir, "worker-image"), `${WORKER_IMAGE}\n`);
  const kernel = new RecordingKernel();
  const lines: Array<Record<string, unknown>> = [];
  const minted: string[] = [];
  const uuids = [...(options.uuids ?? ["11111111-1111-4111-8111-111111111111"])];
  return {
    dir,
    kernel,
    lines,
    minted,
    log: (line) => lines.push(line),
    dependencies: {
      manifest: MANIFEST,
      client: kernel as unknown as StartWorkDependencies["client"],
      namespaceId: NAMESPACE_ID,
      resolveBase: () => SHA,
      identifyImage: () => IMAGE_IDENTITY,
      randomUUID: () => {
        const next = uuids.shift();
        assert.ok(next !== undefined, "the origin key was minted more times than the test allows");
        minted.push(next);
        return next;
      },
      now: () => "2026-01-01T00:00:00.000Z",
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Run one `startWork` with `Date.now` pinned, so "does this path read the clock" is observable. */
async function atClock<T>(millis: number, body: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => millis;
  try {
    return await body();
  } finally {
    Date.now = real;
  }
}

const DEV_EXTRA = ["implement median", "8", "6", "cadp-v04:evidence:proposal-1"];

// ------------------------------------------------------------------ the v0.4 branch, pinned

test("v0.4 pin: the default development start allocates the zero-sentinel v1 tuple and binds no work run", async () => {
  const r = rig();
  try {
    // No `originProfile` at all — exactly what `ctl.ts`, `mcpServer.ts` and the live v0.4
    // deployment pass. Everything below is today's shape, asserted so the migration cannot move it.
    const started = await atClock(CLOCK_A, () => startWork(r.dir, "development", DEV_EXTRA, { log: r.log }, r.dependencies));

    assert.deepEqual(r.kernel.allocations, [{
      schema: "cadp.allocation-key.v1",
      work_run_ref: ZERO_SENTINEL,
      step_ordinal: Math.floor(CLOCK_A / 1000) % 1000000,
      purpose: "work-start",
    }], "the v0.4 tuple, wall-clock ordinal included");

    const seal = r.kernel.seals[0]!;
    assert.equal("allocation_tuple" in seal, false, "no allocation_tuple rides on a v1 seal");
    assert.deepEqual(seal["work_bindings"], [
      { authority_ref: "github.com", namespace: "work-item", object_id: "dev:implement median" },
      { authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: "cadp-v04:evidence:proposal-1" },
    ], "today's exact bindings — and NO work-run binding, which is what keeps this path un-adjudicated");
    assert.equal(seal["requester_ref"], "workflow:cadp-work");
    assert.equal(seal["operation_kind"], "WORK_START");
    assert.equal(seal["material_schema"], "cadp.work-start.v1");

    assert.deepEqual(JSON.parse(r.kernel.blobs[0]!.toString("utf8")), {
      vertical: "development",
      bounds: { max_steps: 8, max_effects: 6 },
      development: {
        repo_id: "42",
        repo_full_name: "owner/repo",
        base_ref: "refs/heads/main",
        base_sha: SHA,
        work_item: "implement median",
        worker_product: "codex",
        review_product: "claude",
        external_verification: false,
        require_human_merge: true,
      },
    }, "the v0.4 args, unchanged");

    const material = JSON.parse(r.kernel.blobs[1]!.toString("utf8")) as Record<string, unknown>;
    assert.equal(material["workflow_id"], `cadp-work-${started!.effect_id}`);
    assert.equal(material["continuation_target"], `temporal:cadp-v04:${NAMESPACE_ID}`);
    assert.deepEqual(material["surface_image"], IMAGE_IDENTITY);

    assert.equal(started?.origin_key, undefined, "a v0.4 start has no origin key to report");
    assert.deepEqual(readOriginKeyRecords(r.dir), [], "and writes no origin-key record");
    assert.deepEqual(r.minted, [], "and mints nothing");
  } finally {
    r.cleanup();
  }
});

test("v0.4 pin: the record vertical keeps its wall-clock resource_prefix", async () => {
  const r = rig();
  try {
    const prefixOf = async (clock: number): Promise<string> => {
      await atClock(clock, () => startWork(r.dir, "record", ["2", "6", "4"], { log: r.log }, r.dependencies));
      const args = JSON.parse(r.kernel.blobs.at(-2)!.toString("utf8")) as { record: { resource_prefix: string } };
      return args.record.resource_prefix;
    };
    const first = await prefixOf(CLOCK_A);
    const second = await prefixOf(CLOCK_B);
    assert.equal(first, `live-${CLOCK_A % 100000}`, "the checked-out computation, to the byte");
    assert.notEqual(first, second, "and it still moves with the clock — the v0.4 branch is untouched");
    assert.match(first, /^live-\d{1,5}$/u);
    // The v1 tuple on the record path too: same zero sentinel, same clock ordinal, no origin key.
    assert.deepEqual(Object.keys(r.kernel.allocations[0]!).sort(), ["purpose", "schema", "step_ordinal", "work_run_ref"]);
  } finally {
    r.cleanup();
  }
});

test("v0.4 refuses a v0.5-only input rather than silently ignoring it", async () => {
  const r = rig();
  try {
    await assert.rejects(
      () => startWork(r.dir, "development", DEV_EXTRA, { originKey: "k" }, r.dependencies),
      /v0\.5 origin-path inputs/u,
      "an originKey the v1 tuple cannot express must refuse, never be dropped",
    );
    assert.deepEqual(r.kernel.allocations, [], "and nothing is allocated");
  } finally {
    r.cleanup();
  }
});

// ------------------------------------------------------------------ the v0.5 origin branch

test("v0.5: the origin allocates run-origin.v1 with exactly {schema, origin_key, purpose} and self-binds its own effect_id", async () => {
  const r = rig();
  try {
    const started = await atClock(CLOCK_A, () =>
      startWork(r.dir, "development", DEV_EXTRA, { log: r.log, originProfile: "v05", originKey: "origin-alpha" }, r.dependencies));

    assert.deepEqual(r.kernel.allocations, [{
      schema: RUN_ORIGIN_ALLOCATION_SCHEMA,
      origin_key: "origin-alpha",
      purpose: "work-start",
    }], "exactly the three keys of WP §3.6 — no work_run_ref, no step_ordinal");

    const seal = r.kernel.seals[0]!;
    const bindings = seal["work_bindings"] as Array<{ authority_ref: string; namespace: string; object_id: string }>;
    const workRun = bindings.filter((b) => b.namespace === "work-run");
    assert.equal(workRun.length, 1, "EXACTLY one work-run binding (AP B5(9) leg 2)");
    assert.deepEqual(workRun[0], {
      authority_ref: "cadp-store:k04",
      namespace: "work-run",
      object_id: started!.effect_id,
    }, "and its object_id is the allocated WORK_START's OWN effect_id (leg 3)");
    // The provenance bindings survive: the migration adds a binding, it does not replace the set.
    assert.deepEqual(bindings.slice(1), [
      { authority_ref: "github.com", namespace: "work-item", object_id: "dev:implement median" },
      { authority_ref: "cadp-store:k04", namespace: "work-proposal", object_id: "cadp-v04:evidence:proposal-1" },
    ]);
    assert.deepEqual(seal["allocation_tuple"], r.kernel.allocations[0], "AP B6(1): the tuple rides as transport on the v2 first seal");
    assert.equal(started?.origin_key, "origin-alpha", "the result reports the origin it converged on");
    assert.deepEqual(r.minted, [], "a provided key is never re-minted");
    assert.deepEqual(readOriginKeyRecords(r.dir), [], "and a provided key needs no recovery record");
  } finally {
    r.cleanup();
  }
});

test("v0.5: one origin_key invoked twice returns one effect_id, re-seals idempotently, and seals byte-identical material", async () => {
  const r = rig();
  try {
    const invoke = (clock: number) =>
      atClock(clock, () => startWork(r.dir, "development", DEV_EXTRA, { log: r.log, originProfile: "v05", originKey: "origin-replay" }, r.dependencies));
    // The two attempts are separated by an EPOCH of wall clock. Anything the origin path derived
    // from the clock would diverge here; nothing does.
    const first = await invoke(CLOCK_A);
    const second = await invoke(CLOCK_B);

    assert.equal(second!.effect_id, first!.effect_id, "one logical origin, one effect identity");
    assert.deepEqual(r.kernel.allocations[1], r.kernel.allocations[0], "the retry re-presents the identical tuple");
    assert.equal(r.kernel.blobs[2]!.toString("hex"), r.kernel.blobs[0]!.toString("hex"), "the args bytes are identical");
    assert.equal(r.kernel.blobs[3]!.toString("hex"), r.kernel.blobs[1]!.toString("hex"), "the material bytes are identical");
    assert.deepEqual(r.kernel.seals[1], r.kernel.seals[0], "and so is the whole seal body");

    assert.deepEqual(r.kernel.conflicts, [], "zero REQUEST_DIGEST_CONFLICT: the retry is a no-op, not an incident");
    assert.deepEqual(r.kernel.idempotentReseals, [first!.effect_id], "the re-seal is K3's identical-content arm");
    assert.equal(r.kernel.rowCount, 1, "exactly one effect_request row for the origin");
    assert.equal(second!.workflow_id, first!.workflow_id);
  } finally {
    r.cleanup();
  }
});

test("v0.5 record vertical: resource_prefix is a function of the origin key alone, and the tuple stays vertical-general", async () => {
  const r = rig();
  try {
    const prefixOf = async (clock: number): Promise<string> => {
      await atClock(clock, () => startWork(r.dir, "record", ["2", "6", "4"], { log: r.log, originProfile: "v05", originKey: "origin-record" }, r.dependencies));
      const args = JSON.parse(r.kernel.blobs.at(-2)!.toString("utf8")) as { record: { resource_prefix: string } };
      return args.record.resource_prefix;
    };
    const first = await prefixOf(CLOCK_A);
    const second = await prefixOf(CLOCK_B);
    assert.equal(first, originResourcePrefix("origin-record"), "derived from the origin, by the exported function");
    assert.equal(second, first, "so an epoch of wall clock changes nothing — no fallback survives on this path");
    assert.doesNotMatch(first, /^live-\d{1,5}$/u, "and it is no longer the clock-derived shape");
    assert.notEqual(first, originResourcePrefix("origin-other"), "distinct origins still get distinct prefixes");

    // WP §3.6's vertical-generality leg: the record path forms the tuple with no development-only
    // field, and with none of the v1 fields the clock used to supply.
    assert.deepEqual(Object.keys(r.kernel.allocations[0]!).sort(), ["origin_key", "purpose", "schema"]);
    for (const absent of ["step_ordinal", "work_run_ref", "repo_id", "base_sha", "work_item"]) {
      assert.equal(absent in r.kernel.allocations[0]!, false, `${absent} must not enter the run-origin tuple`);
    }
  } finally {
    r.cleanup();
  }
});

test("v0.5: the baseSha pin is what keeps DEVELOPMENT material byte-identical when the base ref moves", async () => {
  const r = rig();
  const MOVED = "1111111111111111111111111111111111111111";
  try {
    // The development branch's second replay-stability hazard, stated as the PROHIBITED observable
    // before the pin is applied: `base_sha` is the declared ref's tip AT SEAL TIME, so a retry after
    // main moves re-presents the converged effect_id with drifted args.
    const invoke = (base: string, pin?: string) =>
      startWork(r.dir, "development", DEV_EXTRA, { log: r.log, originProfile: "v05", originKey: "origin-base", ...(pin === undefined ? {} : { baseSha: pin }) }, { ...r.dependencies, resolveBase: () => base });

    const first = await invoke(SHA);
    const drifted = await invoke(MOVED);
    assert.equal(drifted!.effect_id, first!.effect_id, "the IDENTITY converges either way — the tuple reads no base");
    assert.notEqual(r.kernel.blobs[2]!.toString("hex"), r.kernel.blobs[0]!.toString("hex"), "unpinned, the material drifts with the ref");
    assert.deepEqual(r.kernel.conflicts, [drifted!.effect_id], "which is exactly the K3 conflict WP §3.6 forbids on this path");

    // Pinned to the first creation's value, the retry re-seals the identical bytes.
    await invoke(MOVED, SHA);
    assert.equal(r.kernel.blobs[4]!.toString("hex"), r.kernel.blobs[0]!.toString("hex"), "pinned, the args bytes are identical");
    assert.deepEqual(r.kernel.idempotentReseals, [first!.effect_id], "and the re-seal is K3's identical-content arm");
  } finally {
    r.cleanup();
  }
});

// ------------------------------------------------------------------ workPlan's derived keys

test("planOriginKey is stable per (proposal_evidence_id, item index) and distinct across both", () => {
  const proposal = "cadp-v04:evidence:proposal-1";
  assert.equal(planOriginKey(proposal, 0), planOriginKey(proposal, 0), "the same origin re-derives the same key");
  assert.notEqual(planOriginKey(proposal, 0), planOriginKey(proposal, 1), "two items of one proposal are two origins");
  assert.notEqual(planOriginKey(proposal, 0), planOriginKey("cadp-v04:evidence:proposal-2", 0), "two proposals are two origins");
  assert.equal(
    planOriginKey(proposal, 0),
    jcsDigest({ scheme: "cadp.origin-key.work-plan.v1", proposal_evidence_id: proposal, item_index: 0 }).value,
    "a canonical digest of the pair, never a concatenation of it",
  );
  // Fail closed rather than collapse distinct origins onto one key.
  assert.throws(() => planOriginKey("", 0), /empty proposal_evidence_id/u);
  assert.throws(() => planOriginKey("p", -1), /malformed proposal item index/u);
});

test("workPlan threads one derived origin_key per item under v05, and passes none under v04", async () => {
  const proposalEvidenceId = "cadp-v04:evidence:proposal-7";
  const proposal = {
    schema: "cadp.work-proposal.v1",
    items: [
      { work_item: "first", max_steps: 8, max_effects: 6 },
      { work_item: "second", max_steps: 8, max_effects: 6 },
    ],
  } as unknown as WorkProposalV1;

  const run = async (originProfile: "v04" | "v05") => {
    const seen: Array<{ originKey?: string; originProfile?: string }> = [];
    await workPlan("unused", proposalEvidenceId, undefined, () => {}, { originProfile }, {
      loadProposal: async () => proposal,
      startWork: (async (_dir: string, _v: string, _extra: string[], opts: { originKey?: string; originProfile?: string }) => {
        seen.push({ originKey: opts.originKey, originProfile: opts.originProfile });
        return { effect_id: `e-${seen.length}`, workflow_id: `w-${seen.length}` };
      }) as never,
      pollRun: async () => ({ status: "COMPLETED" }) as never,
    });
    return seen;
  };

  const v05 = await run("v05");
  assert.deepEqual(v05.map((s) => s.originProfile), ["v05", "v05"]);
  assert.deepEqual(
    v05.map((s) => s.originKey),
    [planOriginKey(proposalEvidenceId, 0), planOriginKey(proposalEvidenceId, 1)],
    "each item's key is the derived function of the proposal id and its OWN index",
  );
  // Re-running the same driver over the same proposal re-derives the same two keys, which is the
  // whole reason this path stores nothing: convergence needs no record to recover.
  assert.deepEqual((await run("v05")).map((s) => s.originKey), v05.map((s) => s.originKey));

  const v04 = await run("v04");
  assert.deepEqual(v04.map((s) => s.originProfile), ["v04", "v04"]);
  assert.deepEqual(v04.map((s) => s.originKey), [undefined, undefined], "the v0.4 driver passes no origin key");
});

// ------------------------------------------------------------------ minting once, and surviving a crash

test("v0.5 direct start: the origin_key is minted ONCE, and a failure leaves it recoverable in the error, the log and the state file", async () => {
  const MINTED = "abcdef01-2345-4678-8abc-def012345678";
  // Exactly one UUID is available: a second mint would fail the rig's own assertion, which is how
  // "minted once and retained across the retry" is enforced rather than merely observed.
  const r = rig({ uuids: [MINTED] });
  try {
    r.kernel.failAllocate = new Error("kernel unreachable");
    const failure = await startWork(r.dir, "development", DEV_EXTRA, { log: r.log, originProfile: "v05" }, r.dependencies)
      .then(() => undefined, (error: unknown) => error);

    // (a) the thrown error carries the key, both as a property and in the message a caller that only
    // reads `.message` (ctl.ts's autoDev) will print.
    assert.ok(failure instanceof OriginStartFailure, `expected OriginStartFailure, got ${String(failure)}`);
    assert.equal(failure.origin_key, MINTED);
    assert.match(failure.message, new RegExp(MINTED, "u"));
    assert.match(failure.message, /kernel unreachable/u, "the original cause is not swallowed");
    assert.equal((failure.cause as Error).message, "kernel unreachable");

    // (b) the log emitted it BEFORE the first kernel call.
    const emitted = r.lines.find((line) => line["origin_source"] === "minted");
    assert.equal(emitted?.["origin_key"], MINTED);
    assert.equal(emitted?.["origin_profile"], "v05");
    const confirmed = r.lines.find((line) => line["origin_key_record"] !== undefined);
    assert.equal(confirmed?.["origin_key"], MINTED, "and a second line confirms the record landed, naming the file to recover it from");
    assert.equal(confirmed?.["origin_key_record"], join(r.dir, ORIGIN_KEY_RECORD_FILE));

    // (c) the state file holds it, so a process that DIED here still leaves a recoverable record.
    const records = readOriginKeyRecords(r.dir);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      origin_key: MINTED,
      work_item_digest: jcsDigest({ scheme: "cadp.origin-intent.v1", vertical: "development", extra: DEV_EXTRA }).value,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(readFileSync(join(r.dir, ORIGIN_KEY_RECORD_FILE), "utf8").endsWith("\n"), true);

    // THE RECOVERY FLOW, executed: read the record, re-invoke with the recorded key. The rig has no
    // second UUID, so this converges only because the key was preserved verbatim — a re-mint throws.
    r.kernel.failAllocate = undefined;
    const recovered = readOriginKeyRecords(r.dir)[0]!.origin_key;
    const started = await startWork(r.dir, "development", DEV_EXTRA, { log: r.log, originProfile: "v05", originKey: recovered }, r.dependencies);

    assert.equal(started?.origin_key, MINTED);
    assert.deepEqual(r.kernel.allocations, [
      { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: MINTED, purpose: "work-start" },
      { schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: MINTED, purpose: "work-start" },
    ], "the retry derives the SAME allocation tuple as the attempt that failed");
    assert.deepEqual(r.minted, [MINTED], "exactly one mint across the whole logical origin");
    assert.equal(readOriginKeyRecords(r.dir).length, 1, "and the retry appends no second record");
  } finally {
    r.cleanup();
  }
});

test("v0.5 direct start: a refused admission still reports the origin_key through the log", async () => {
  const MINTED = "beefbeef-2345-4678-8abc-def012345678";
  const r = rig({ uuids: [MINTED] });
  try {
    r.kernel.evaluate = (async () => ({ kind: "DECISION", decision: { decision_id: "d", outcome: "DENY" } })) as never;
    const started = await startWork(r.dir, "record", ["2", "6", "4"], { log: r.log, originProfile: "v05" }, r.dependencies);
    assert.equal(started, undefined, "a refusal is still an honest undefined");
    const refusal = r.lines.find((line) => line["evaluated"] !== undefined);
    assert.equal(refusal?.["origin_key"], MINTED, "the refusal line names the origin the retry must re-present");
    assert.equal(readOriginKeyRecords(r.dir)[0]?.origin_key, MINTED);
  } finally {
    r.cleanup();
  }
});

test("v0.5 direct start: a SETUP failure before the first kernel call still surfaces the minted origin_key", async () => {
  const MINTED = "0f0f0f0f-2345-4678-8abc-def012345678";
  const r = rig({ uuids: [MINTED] });
  try {
    // The `manifest` seam withdrawn, so `loadManifest` runs for real against a deployment dir that
    // has no `manifest.json`: the start dies in the SETUP that precedes the argument legs and every
    // kernel call. WP §3.6's obligation is that no such call can be the thing that loses the key,
    // so the mint has to be strictly earlier than all of them — this is the leg that pins that.
    const failure = await startWork(r.dir, "development", DEV_EXTRA, { log: r.log, originProfile: "v05" }, { ...r.dependencies, manifest: undefined })
      .then(() => undefined, (error: unknown) => error);

    assert.ok(failure instanceof OriginStartFailure, `expected OriginStartFailure, got ${String(failure)}`);
    assert.equal(failure.origin_key, MINTED);
    assert.match(failure.message, new RegExp(MINTED, "u"), "the key rides out in the message a caller reading only `.message` prints");
    assert.equal(r.lines.find((line) => line["origin_source"] === "minted")?.["origin_key"], MINTED);
    assert.equal(readOriginKeyRecords(r.dir)[0]?.origin_key, MINTED, "and the crash-recoverable record was already written");
    assert.deepEqual(r.kernel.allocations, [], "nothing was allocated — the key is durable strictly EARLIER than any allocation");

    // The recovery flow over a setup failure converges exactly as it does over a kernel failure: the
    // rig holds one UUID, so this can only pass because the recorded key was re-presented verbatim.
    const started = await startWork(
      r.dir, "development", DEV_EXTRA,
      { log: r.log, originProfile: "v05", originKey: readOriginKeyRecords(r.dir)[0]!.origin_key },
      r.dependencies,
    );
    assert.equal(started?.origin_key, MINTED);
    assert.deepEqual(r.kernel.allocations, [{ schema: RUN_ORIGIN_ALLOCATION_SCHEMA, origin_key: MINTED, purpose: "work-start" }]);
    assert.deepEqual(r.minted, [MINTED], "one mint across the whole logical origin");
  } finally {
    r.cleanup();
  }
});

test("v0.5 direct start: a failing origin-key RECORD WRITE surfaces the key instead of swallowing it", async () => {
  const MINTED = "cafecafe-2345-4678-8abc-def012345678";
  const r = rig({ uuids: [MINTED] });
  try {
    // A deployment dir that does not exist: `appendOriginKeyRecord` itself throws. The persistence
    // step is the one place a naive ordering loses the key entirely — minted, never published,
    // never recorded. Publishing through `log` first and persisting INSIDE the try makes even this
    // failure a recoverable origin.
    const failure = await startWork(join(r.dir, "no-such-deployment-dir"), "development", DEV_EXTRA, { log: r.log, originProfile: "v05" }, r.dependencies)
      .then(() => undefined, (error: unknown) => error);

    assert.ok(failure instanceof OriginStartFailure, `expected OriginStartFailure, got ${String(failure)}`);
    assert.equal(failure.origin_key, MINTED);
    assert.match(failure.message, new RegExp(MINTED, "u"));
    assert.equal(r.lines.find((line) => line["origin_source"] === "minted")?.["origin_key"], MINTED, "published BEFORE the write that failed");
    assert.equal(
      r.lines.some((line) => line["origin_key_record"] !== undefined), false,
      "and the record-landed confirmation is emitted only once the record actually landed",
    );
    assert.deepEqual(r.kernel.allocations, [], "a start that could not record its origin allocates nothing");
    assert.deepEqual(r.minted, [MINTED]);
  } finally {
    r.cleanup();
  }
});
