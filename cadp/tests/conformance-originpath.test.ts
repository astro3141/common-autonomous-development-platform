/**
 * WP §3.6 / AP B5(9) — the LIVE COMPOSITION's run-origin path (`cadp/live/ops.ts`): one logical
 * origin, one `origin_key`, one `effect_id`, and sealed `WORK_START` material that is BYTE-
 * REPRODUCIBLE across retries of that origin.
 *
 * These are WP controls 13 (replay convergence and origin distinctness), 14 (origin material replay
 * stability) and 15 (record-vertical generality), run against the exported pieces of the origin path
 * plus the real Ingress. The pieces are exported precisely so the contract is checkable without
 * standing up Temporal, the broker and a live manifest: what WP §3.6 constrains is the DERIVATION
 * and the MATERIAL, and both are pure functions here.
 *
 * The falsification these exist for is the checked-out shape they replace: an origin path deriving
 * any sealed-material field from the wall clock — `resource_prefix: live-${Date.now() % 100000}` —
 * re-seals one converged `effect_id` with a different `args_digest`, which is a
 * `REQUEST_DIGEST_CONFLICT`, an incident and a scope hold, leaving the origin unretryable for the
 * store's lifetime.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { jcsDigest, sha256Hex } from "../kernel/canonical.ts";
import { IngressRejection } from "../kernel/ingress.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA } from "../kernel/policyBundle.ts";
import { ORIGIN_PIN_SCHEMA, pinOriginBaseSha, planOriginKey, recordResourcePrefix, runOriginTuple, workStartArgs } from "../live/ops.ts";
import { PRINCIPALS, stopSharedOpa } from "./support/harness.ts";
import { REQUESTER_A, WORK_RUN_AUTHORITY, count, runProfileHarness } from "./support/runProfile.ts";
import type { RunProfileHarness } from "./support/runProfile.ts";

after(() => stopSharedOpa());

const DEV_EXTRA = ["implement the thing", "8", "6", "cadp-v04:evidence:proposal-1", "codex", "claude", ""];
const RECORD_EXTRA = ["2", "6", "4"];
const RESOLVED = {
  repo_id: "github.com/astro3141/cadp",
  repo_full_name: "astro3141/cadp",
  base_sha: "0".repeat(40),
  worker_product: "codex",
  review_product: "claude",
  external_verification: false,
};

/** Seal a `WORK_START` exactly as `startWork` does: run-origin tuple, self-binding, args as material. */
function sealOrigin(
  rp: RunProfileHarness,
  origin_key: string,
  vertical: "development" | "record",
  extra: string[],
  base_sha?: string,
): { effect_id: string; args: Record<string, unknown> } {
  const { h, target } = rp;
  const tuple = runOriginTuple(origin_key);
  const effect_id = h.ingress.allocateEffectId(tuple, PRINCIPALS.workflow);
  const args = workStartArgs(vertical, extra, origin_key, base_sha === undefined ? RESOLVED : { ...RESOLVED, base_sha });
  const material = {
    workflow_id: `cadp-work-${effect_id}`,
    workflow_type: "cadpWork",
    task_queue: "cadp-worker",
    args_cas_key: h.ingress.putBlob(Buffer.from(JSON.stringify(args), "utf8")),
    args_digest: jcsDigest(args).value,
    bounds: args["bounds"],
  };
  h.ingress.sealEffectRequest(
    {
      effect_id,
      requester_ref: REQUESTER_A,
      work_bindings: [
        { authority_ref: WORK_RUN_AUTHORITY, namespace: "work-run", object_id: effect_id },
        { authority_ref: "github.com", namespace: "work-item", object_id: `dev:${extra[0]}` },
      ],
      target_ref: target.targetRef(),
      operation_kind: "WORK_START",
      material_schema: "cadp.work-start.v1",
      material_ref: h.ingress.putBlob(Buffer.from(JSON.stringify(material), "utf8")),
      prior_effect_refs: [],
      allocation_tuple: tuple,
    },
    PRINCIPALS.workflow,
  );
  return { effect_id, args };
}

// ================================================ the derivation itself

test("WP §3.6: origin_key is decided once per logical origin, derived from no clock and no work content", () => {
  const proposal = "cadp-v04:evidence:01a0-proposal";
  // Reproduced VERBATIM on every retry of the same origin — the whole of caller obligation (1).
  assert.equal(planOriginKey(proposal, 0), planOriginKey(proposal, 0));
  // Two origins over BYTE-IDENTICAL work are distinct origins and carry distinct keys: the
  // discriminator identifies the ORIGIN, never the work's content, which is what makes WP §3.6's
  // identity-vs-content collision unconstructible rather than merely unlikely.
  assert.notEqual(planOriginKey(proposal, 0), planOriginKey(proposal, 1));
  assert.notEqual(planOriginKey(proposal, 0), planOriginKey(`${proposal}-other`, 0));
  // No clock: the same call at two different wall-clock instants is the same value.
  const before = planOriginKey(proposal, 3);
  const spin = Date.now();
  while (Date.now() === spin) { /* cross a millisecond boundary */ }
  assert.equal(planOriginKey(proposal, 3), before);

  // WP §3.6's wire shape: EXACTLY these three keys, `origin_key` the single non-reserved field, and
  // NO `work_run_ref` — a tuple naming the identity would contain the value it derives.
  const tuple = runOriginTuple(before);
  assert.deepEqual(Object.keys(tuple).sort(), ["origin_key", "purpose", "schema"]);
  assert.equal(tuple.schema, RUN_ORIGIN_ALLOCATION_SCHEMA);
  assert.equal(tuple.purpose, "work-start");
  assert.equal((tuple as Record<string, unknown>)["work_run_ref"], undefined);
});

test("WP §3.6 control 14: the sealed WORK_START args are a pure function of the origin's fixed inputs", () => {
  for (const [vertical, extra] of [["development", DEV_EXTRA], ["record", RECORD_EXTRA]] as const) {
    const key = planOriginKey("cadp-v04:evidence:p", 0);
    const first = workStartArgs(vertical, [...extra], key, RESOLVED);
    const spin = Date.now();
    while (Date.now() === spin) { /* cross a millisecond boundary */ }
    const second = workStartArgs(vertical, [...extra], key, RESOLVED);
    assert.equal(JSON.stringify(first), JSON.stringify(second), `${vertical}: byte-identical across the clock`);
    assert.equal(jcsDigest(first).value, jcsDigest(second).value, `${vertical}: one args_digest`);
  }

  // The exact checked-out consequence WP §3.6 names: `resource_prefix` is now a function of the
  // stable `origin_key` and of nothing else, so two attempts at ONE origin seal the same args while
  // two DISTINCT origins still seal distinguishable ones.
  const k1 = planOriginKey("cadp-v04:evidence:p", 0);
  const k2 = planOriginKey("cadp-v04:evidence:p", 1);
  assert.equal(recordResourcePrefix(k1), recordResourcePrefix(k1));
  assert.notEqual(recordResourcePrefix(k1), recordResourcePrefix(k2));
  assert.match(recordResourcePrefix(k1), /^live-[0-9a-f]{8}$/u);
  const record = workStartArgs("record", [...RECORD_EXTRA], k1, RESOLVED) as { record: { resource_prefix: string } };
  assert.equal(record.record.resource_prefix, recordResourcePrefix(k1));
  // WP §3.6 vertical generality: the record path carries none of the development-only fields.
  assert.deepEqual(Object.keys(record.record).sort(), ["payloads", "resource_prefix", "tenant"]);
});

// ================================================ the one live-resolved field: pinned at creation

/** The origin pin's on-disk location, spelled out here rather than imported, so the test pins it too. */
function pinPath(dir: string, origin_key: string): string {
  return join(dir, "run-origins", `${sha256Hex(origin_key)}.json`);
}

test("WP §3.6 control 14: the origin's live-resolved base_sha is pinned at first creation and reproduced verbatim on retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "cadp-origin-pin-"));
  try {
    const key = planOriginKey("cadp-v04:evidence:01a0-proposal", 0);
    // The base branch MOVES between the two attempts at this one origin — the whole point of the
    // control: `base_sha` is not clock-derived, it is derived from a mutable remote ref, and a retry
    // that re-resolved it would re-present the converged `effect_id` with drifted args.
    const tips = ["a".repeat(40), "b".repeat(40)];
    let resolutions = 0;
    const resolve = (): string => tips[Math.min(resolutions++, tips.length - 1)]!;

    const first = pinOriginBaseSha(dir, key, resolve);
    assert.equal(first, tips[0]);
    assert.equal(resolutions, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(pinPath(dir, key), "utf8")) as Record<string, unknown>,
      { schema: ORIGIN_PIN_SCHEMA, origin_key: key, base_sha: tips[0] },
      "the durable first-creation record this origin is pinned to",
    );

    const retry = pinOriginBaseSha(dir, key, resolve);
    assert.equal(retry, tips[0], "the FIRST-CREATION value, never today's tip");
    assert.equal(resolutions, 1, "a pinned origin never consults the mutable ref again");
    // Which is what makes the retry's whole sealed payload byte-identical: same args, hence the same
    // `args_digest` and `material_ref`, hence an IDEMPOTENT re-seal rather than REQUEST_DIGEST_CONFLICT.
    assert.equal(
      JSON.stringify(workStartArgs("development", [...DEV_EXTRA], key, { ...RESOLVED, base_sha: retry })),
      JSON.stringify(workStartArgs("development", [...DEV_EXTRA], key, { ...RESOLVED, base_sha: first })),
      "byte-identical args across a moved base",
    );

    // A DISTINCT origin is a distinct pin: it resolves the tip current at ITS first creation, and
    // neither origin's pin disturbs the other's.
    const other = planOriginKey("cadp-v04:evidence:01a0-proposal", 1);
    assert.equal(pinOriginBaseSha(dir, other, resolve), tips[1]);
    assert.equal(resolutions, 2);
    assert.equal(pinOriginBaseSha(dir, key, resolve), tips[0]);
    assert.equal(resolutions, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WP §3.6: a damaged or foreign origin pin fails closed instead of sealing an unpinned base", () => {
  const dir = mkdtempSync(join(tmpdir(), "cadp-origin-pin-"));
  try {
    const key = planOriginKey("cadp-v04:evidence:damaged", 0);
    const path = pinPath(dir, key);
    mkdirSync(join(dir, "run-origins"), { recursive: true });
    let resolutions = 0;
    const resolve = (): string => { resolutions++; return "e".repeat(40); };

    for (const [label, contents] of [
      ["unparseable", "{ not json"],
      ["foreign schema", JSON.stringify({ schema: "cadp.something-else.v1", origin_key: key, base_sha: "f".repeat(40) })],
      ["another origin's pin", JSON.stringify({ schema: ORIGIN_PIN_SCHEMA, origin_key: `${key}-other`, base_sha: "f".repeat(40) })],
      ["a base that is not a resolved sha", JSON.stringify({ schema: ORIGIN_PIN_SCHEMA, origin_key: key, base_sha: "refs/heads/main" })],
    ] as const) {
      writeFileSync(path, contents);
      assert.throws(
        () => pinOriginBaseSha(dir, key, resolve),
        /run-origin pin/u,
        `${label}: refuses rather than re-resolving`,
      );
    }
    assert.equal(resolutions, 0, "a damaged pin never falls back to a fresh resolution");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WP §3.6: a concurrent first attempt at one origin ADOPTS the pin already on disk, never overwrites it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cadp-origin-pin-"));
  try {
    const key = planOriginKey("cadp-v04:evidence:raced", 0);
    const winner = "c".repeat(40);
    const loser = "d".repeat(40);
    const value = pinOriginBaseSha(dir, key, () => {
      // Another attempt at THIS origin pinned between our read and our write. Two attempts sealing
      // two bases is the drift, whichever wrote last, so the value already on disk wins.
      mkdirSync(join(dir, "run-origins"), { recursive: true });
      writeFileSync(pinPath(dir, key), JSON.stringify({ schema: ORIGIN_PIN_SCHEMA, origin_key: key, base_sha: winner }));
      return loser;
    });
    assert.equal(value, winner);
    assert.equal((JSON.parse(readFileSync(pinPath(dir, key), "utf8")) as { base_sha: string }).base_sha, winner, "the pin is not rewritten");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ================================================ end to end, against the real Ingress

test("WP §3.6 controls 13/14: one origin_key → one effect_id, and the retry re-seal is IDEMPOTENT", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    const key = planOriginKey("cadp-v04:evidence:01a0-proposal", 0);

    const first = sealOrigin(rp, key, "development", DEV_EXTRA);
    const sealed = h.store.effectRequest(first.effect_id)!;
    // AP B5(9): the self-binding was adjudicated and its witness written on this path.
    assert.equal(h.store.runMembership(first.effect_id)?.work_run_ref, first.effect_id);

    // THE RETRY of that same logical origin: same `origin_key`, so the same `effect_id`, and — this
    // is what control 14 asserts and what the wall-clock shape falsified — the same MATERIAL.
    const incidentsBefore = h.store.openIncidents().length;
    const retry = sealOrigin(rp, key, "development", DEV_EXTRA);
    assert.equal(retry.effect_id, first.effect_id, "one origin_key identifies one effect_id");
    assert.equal(JSON.stringify(retry.args), JSON.stringify(first.args), "byte-identical args");
    const reSealed = h.store.effectRequest(first.effect_id)!;
    assert.equal(reSealed.request_digest.value, sealed.request_digest.value, "unchanged request_digest");
    assert.equal(count(h, "effect_request"), 1, "one effect_request row");
    assert.equal(count(h, "run_membership"), 1, "and one membership row: the re-seal wrote no second");
    assert.equal(h.store.openIncidents().length, incidentsBefore, "ZERO KERNEL_INCIDENT rows");
    assert.equal(h.ingress.scopeHeld(reSealed), undefined, "ZERO scope holds");

    // Control 13's distinctness leg: a DIFFERENT origin over the same work content is a different
    // logical origin, gets its own `effect_id`, first-seals its own material, and raises no conflict.
    const second = sealOrigin(rp, planOriginKey("cadp-v04:evidence:01a0-proposal", 1), "development", DEV_EXTRA);
    assert.notEqual(second.effect_id, first.effect_id, "distinct origins, distinct identities");
    assert.equal(count(h, "effect_request"), 2);
    assert.equal(count(h, "run_membership"), 2, "each origin writes its OWN witness");
    assert.equal(h.store.openIncidents().length, incidentsBefore, "still zero incidents");
  } finally {
    rp.h.close();
  }
});

test("WP §3.6 control 14: an UNPINNED base drifts one origin's material into REQUEST_DIGEST_CONFLICT; the pin keeps the re-seal idempotent", async () => {
  const rp = await runProfileHarness();
  const dir = mkdtempSync(join(tmpdir(), "cadp-origin-pin-"));
  try {
    const { h } = rp;
    const moved = ["a".repeat(40), "b".repeat(40)];
    let resolutions = 0;
    const liveTip = (): string => moved[Math.min(resolutions++, moved.length - 1)]!;

    // The PINNED origin: the retry re-resolves nothing, so the converged effect_id is re-presented
    // with the same material and the store returns the stored row.
    const pinned = planOriginKey("cadp-v04:evidence:pinned", 0);
    const first = sealOrigin(rp, pinned, "development", DEV_EXTRA, pinOriginBaseSha(dir, pinned, liveTip));
    const sealed = h.store.effectRequest(first.effect_id)!;
    const retry = sealOrigin(rp, pinned, "development", DEV_EXTRA, pinOriginBaseSha(dir, pinned, liveTip));
    assert.equal(retry.effect_id, first.effect_id);
    assert.equal(h.store.effectRequest(first.effect_id)!.request_digest.value, sealed.request_digest.value);
    assert.equal(count(h, "effect_request"), 1, "one effect_request row for the pinned origin");
    assert.equal(h.store.openIncidents().length, 0, "zero incidents");
    assert.equal(h.ingress.scopeHeld(sealed), undefined, "zero scope holds");
    assert.equal(resolutions, 1, "the mutable ref was read once, at first creation");

    // The PROHIBITED observable, run against the same Ingress: an origin whose base is resolved
    // afresh per attempt re-presents its converged effect_id with drifted args after `main` moves.
    const unpinned = planOriginKey("cadp-v04:evidence:unpinned", 0);
    sealOrigin(rp, unpinned, "development", DEV_EXTRA, "c".repeat(40));
    assert.throws(
      () => sealOrigin(rp, unpinned, "development", DEV_EXTRA, "d".repeat(40)), // `main` moved
      (error: unknown) => (error as IngressRejection).reason === "REQUEST_DIGEST_CONFLICT",
      "an unpinned retry is an incident and a scope hold, not a retry",
    );
    assert.equal(h.store.openIncidents().length, 1, "exactly the drifted origin's incident");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rp.h.close();
  }
});

test("WP §3.6 control 15: the RECORD vertical allocates and seals as an origin with no development-only field", async () => {
  const rp = await runProfileHarness();
  try {
    const { h } = rp;
    const key = planOriginKey("cadp-v04:evidence:record-proposal", 0);
    const origin = sealOrigin(rp, key, "record", RECORD_EXTRA);
    assert.equal(h.store.runMembership(origin.effect_id)?.work_run_ref, origin.effect_id, "the record origin is an origin");

    // The retry is idempotent on this vertical too — the leg the wall-clock `resource_prefix` broke.
    const retry = sealOrigin(rp, key, "record", RECORD_EXTRA);
    assert.equal(retry.effect_id, origin.effect_id);
    assert.equal(count(h, "effect_request"), 1);
    assert.equal(h.store.openIncidents().length, 0, "zero incidents, zero scope holds");

    // And presenting a development-only field is a key outside the descriptor's set (AP B2(5)).
    const allocations = count(h, "effect_allocation");
    assert.throws(
      () => h.ingress.allocateEffectId(
        { ...runOriginTuple(key), repo_id: RESOLVED.repo_id } as never,
        PRINCIPALS.workflow,
      ),
      (error: unknown) => (error as IngressRejection).reason === "ALLOCATION_TUPLE_INVALID",
    );
    assert.equal(count(h, "effect_allocation"), allocations, "zero effect_allocation rows for the refusal");
  } finally {
    rp.h.close();
  }
});
