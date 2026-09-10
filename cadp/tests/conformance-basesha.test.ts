/**
 * The live-composition OPS conformance file (`cadp/live/ops.ts`): the seal-time material contract
 * of the governed `WORK_START` this composition originates.
 *
 * PART 1, `resolveBaseSha`: the base a run DECLARES it builds on is the declared ref's tip AT SEAL
 * TIME, resolved fresh and fail-closed, never the manifest's setup-time snapshot.
 *
 * PART 2, the RUN ORIGIN path (Spec v0.5 §5.3, AP TD A4/A5 and B5(9), WP §3.6): the
 * `cadp.allocation-key.run-origin.v1` allocation that replaces the v1 zero-sentinel tuple, the
 * `origin_key` this composition decides ONCE per logical origin (derived from the proposal item's
 * coordinates on the `workPlan` path, minted with `crypto.randomUUID` on a direct start and
 * retained verbatim across a retry), the ONE self-referential `work-run` binding B5(9) adjudicates,
 * and the replay stability that makes a retry of one origin an IDEMPOTENT re-seal instead of a
 * `REQUEST_DIGEST_CONFLICT`: no field of the sealed material — `resource_prefix` and the departed
 * `step_ordinal` above all — is derived from the wall clock.
 *
 * The assertions here are OPS-side: they read what `startWork` presents to the Kernel. The
 * cross-kernel half — one `origin_key` deriving one `effect_id` through the real Ingress, the
 * idempotent re-seal, the `run_membership(E, E)` witness, and the eight run-profile refusal codes
 * that must NOT fire on this path — is in `conformance-runorigin.test.ts`, where the run profile's
 * governing bundle and the real seal-time adjudication live.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAN_ORIGIN_KEY_SCHEMA, originResourcePrefix, planOriginKey, resolveBaseSha, startWork, workPlan,
} from "../live/ops.ts";
import { jcs, sha256Hex } from "../kernel/canonical.ts";
import { RUN_ORIGIN_ALLOCATION_SCHEMA } from "../kernel/policyBundle.ts";
import type { LiveEnvManifest } from "../live/env.ts";

const SHA = "8cbc629d3adf9f29c8e21ecb69a11a7cfbcbe4f1";

// ================================================================ PART 1 — seal-time base resolution

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

// ================================================================ PART 2 — the run origin path

const MANIFEST: LiveEnvManifest = {
  dir: "unused", api_url: "http://kernel.invalid", root_url: "http://root.invalid",
  api_port: 1, root_port: 2, record_port: 3, temporal_port: 4, temporal_ui_port: 5, broker_port: 6,
  repo_full_name: "owner/repo", repo_id: "123", base_sha: SHA, tokens: {},
  root_key_id: "root", kernel_config_path: "unused", policy_content_digest: "digest",
};

const IMAGE = { image: "cadp-surface:test", image_digest: "sha256:image", tool_versions: { "codex-cli": "1.0.0" } };

interface SealedBody {
  effect_id: string;
  work_bindings: ReadonlyArray<{ authority_ref: string; namespace: string; object_id: string }>;
  allocation_tuple?: unknown;
  material_ref: string;
  [key: string]: unknown;
}

/**
 * A scripted Kernel with the ONE property the origin path is about: allocation is IDEMPOTENT ON THE
 * CANONICAL TUPLE, so the same tuple yields the same `effect_id` and a different tuple yields a
 * different one. Everything else is a recorder. This is deliberately NOT a re-implementation of the
 * Ingress — the real derivation, the real seal adjudication and the real refusal codes are asserted
 * against the real Kernel in `conformance-runorigin.test.ts`; what this stands in for is the
 * transport, so the ops-side claims (what is presented, and whether two attempts present the same
 * bytes) can be read directly.
 */
function scriptedKernel() {
  const allocations = new Map<string, string>();
  const blobs = new Map<string, string>();
  const seals: SealedBody[] = [];
  const tuples: Array<Record<string, unknown>> = [];
  let issued = 0;
  const client = {
    async allocateEffectId(tuple: never): Promise<{ effect_id: string }> {
      const canonical = jcs(tuple);
      tuples.push(JSON.parse(canonical) as Record<string, unknown>);
      const existing = allocations.get(canonical);
      if (existing !== undefined) return { effect_id: existing };
      const effect_id = `cadp-v04:effect:00000000-0000-7000-8000-${String((issued += 1)).padStart(12, "0")}`;
      allocations.set(canonical, effect_id);
      return { effect_id };
    },
    async putBlob(bytes: Uint8Array): Promise<{ cas_key: string }> {
      const cas_key = `cadp-v04:cas:${sha256Hex(bytes)}`;
      blobs.set(cas_key, Buffer.from(bytes).toString("utf8"));
      return { cas_key };
    },
    async sealEffectRequest(body: never): Promise<never> {
      seals.push(body as SealedBody);
      return { request_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: sha256Hex(jcs(body)) } } as never;
    },
    async assembleAdmissionInput(): Promise<never> {
      return { input_digest: { algorithm: "sha256", canonicalization: "cadp-jcs-1", value: "input" } } as never;
    },
    async evaluate(): Promise<never> {
      return { kind: "DECISION", decision: { decision_id: "cadp-v04:decision:1", outcome: "ALLOW" } } as never;
    },
    async admitAndDispatch(): Promise<never> {
      return { kind: "ADMITTED", admission: {}, outcome: { result: "COMMITTED" } } as never;
    },
  };
  return {
    client,
    seals,
    tuples,
    /** The `args` blob one seal put, as the JSON text that was hashed into its `cas_key`. */
    argsOf(seal: SealedBody): string {
      const material = JSON.parse(blobs.get(seal.material_ref)!) as { args_cas_key: string };
      return blobs.get(material.args_cas_key)!;
    },
    materialOf(seal: SealedBody): string {
      return blobs.get(seal.material_ref)!;
    },
  };
}

type Kernel = ReturnType<typeof scriptedKernel>;

function deps(kernel: Kernel, mintOriginKey?: () => string) {
  return {
    manifest: MANIFEST,
    client: kernel.client as never,
    namespaceId: () => "cadp-v04",
    resolveBase: () => SHA,
    imageIdentity: () => IMAGE,
    ...(mintOriginKey === undefined ? {} : { mintOriginKey }),
  };
}

const DEV_EXTRA = ["make the change", "8", "6"];
const RECORD_EXTRA = ["2", "6", "4"];

function workRunBindings(seal: SealedBody) {
  return seal.work_bindings.filter((b) => b.authority_ref === "cadp-store:k04" && b.namespace === "work-run");
}

// ---------------------------------------------------------------- the allocation tuple

test("A5/B1(5): the WORK_START allocation is run-origin.v1 with EXACTLY {schema, origin_key, purpose}", async () => {
  const kernel = scriptedKernel();
  const started = await startWork("unused", "development", DEV_EXTRA, { originKey: "origin-shape", dependencies: deps(kernel) });
  assert.notEqual(started, undefined, "the origin is admitted");

  assert.equal(kernel.tuples.length, 1, "exactly one allocation per origin");
  const tuple = kernel.tuples[0]!;
  assert.deepEqual(tuple, { origin_key: "origin-shape", purpose: "work-start", schema: RUN_ORIGIN_ALLOCATION_SCHEMA });
  // Stated key-by-key as well as by deep-equality, because the two departed members are the whole
  // point: `work_run_ref` cannot be in a tuple deriving the identity that value IS (AP B1(5)), and
  // the wall-clock `step_ordinal` gave one logical origin a fresh identity every second.
  assert.deepEqual(Object.keys(tuple).sort(), ["origin_key", "purpose", "schema"]);
  assert.equal(tuple["work_run_ref"], undefined, "no zero-sentinel work_run_ref");
  assert.equal(tuple["step_ordinal"], undefined, "no step_ordinal, hence no wall-clock ordinal");

  // B6(1): the allocated tuple is re-presented at the seal as its stripped transport sibling —
  // byte-identical to the allocated one, or the first seal is ALLOCATION_BINDING_MISMATCH.
  assert.equal(kernel.seals.length, 1);
  assert.deepEqual(kernel.seals[0]!.allocation_tuple, tuple, "the seal re-presents the allocated tuple");
});

test("A5/B1(5): the record vertical allocates the SAME three keys — no development-only field", async () => {
  // WP control 15, the vertical-generality leg: the record path has no `repo_id`, `base_sha` or
  // `work_item` anywhere, so a content-derived tuple is not expressible there at all.
  const kernel = scriptedKernel();
  await startWork("unused", "record", RECORD_EXTRA, { originKey: "origin-record", dependencies: deps(kernel) });
  assert.deepEqual(kernel.tuples[0], { origin_key: "origin-record", purpose: "work-start", schema: RUN_ORIGIN_ALLOCATION_SCHEMA });
  const args = JSON.parse(kernel.argsOf(kernel.seals[0]!)) as { record: Record<string, unknown>; vertical: string };
  assert.equal(args.vertical, "record");
  assert.deepEqual(Object.keys(args.record).sort(), ["payloads", "resource_prefix", "tenant"]);
});

// ---------------------------------------------------------------- the self-referential binding

test("B5(9): exactly ONE work-run binding is sealed, and its object_id is the ALLOCATED effect_id", async () => {
  for (const vertical of ["development", "record"] as const) {
    const kernel = scriptedKernel();
    const started = await startWork(
      "unused", vertical, vertical === "development" ? [...DEV_EXTRA, "proposal-1"] : RECORD_EXTRA,
      { originKey: `origin-self-${vertical}`, dependencies: deps(kernel) },
    );
    const seal = kernel.seals[0]!;
    const bound = workRunBindings(seal);
    assert.equal(bound.length, 1, `${vertical}: exactly one work-run binding (two would be KERNEL_NAMESPACE_AMBIGUOUS)`);
    assert.equal(bound[0]!.object_id, seal.effect_id, `${vertical}: the binding names the request's OWN effect_id`);
    assert.equal(bound[0]!.object_id, started!.effect_id, `${vertical}: which is the id the allocation issued`);
    // The pair is the kernel's DECLARED work-run pair; an off-authority binding is not a kernel
    // work-run subject at all (AP B3(4)(a)) and would be refused RUN_BINDING_REQUIRED.
    assert.equal(bound[0]!.authority_ref, "cadp-store:k04");
    // Exactly one binding in the `work-run` NAMESPACE regardless of authority, which is the
    // ambiguity lock's own scope (AP B3(4)(b)).
    assert.equal(seal.work_bindings.filter((b) => b.namespace === "work-run").length, 1);
    // The unrelated bindings are untouched: work-item always, work-proposal only where given.
    assert.deepEqual(
      seal.work_bindings.filter((b) => b.namespace !== "work-run").map((b) => `${b.namespace}=${b.object_id}`),
      vertical === "development"
        ? ["work-item=dev:make the change", "work-proposal=proposal-1"]
        : ["work-item=record:2"],
    );
  }
});

// ---------------------------------------------------------------- one origin, one identity

test("A5 o-ii: the same origin_key twice presents the same tuple, converges on ONE effect_id, and re-seals byte-identically", async () => {
  for (const vertical of ["development", "record"] as const) {
    const kernel = scriptedKernel();
    const extra = vertical === "development" ? DEV_EXTRA : RECORD_EXTRA;
    const first = await startWork("unused", vertical, extra, { originKey: `origin-retry-${vertical}`, dependencies: deps(kernel) });
    const second = await startWork("unused", vertical, extra, { originKey: `origin-retry-${vertical}`, dependencies: deps(kernel) });

    assert.equal(second!.effect_id, first!.effect_id, `${vertical}: a retry of one origin converges on one identity`);
    assert.deepEqual(kernel.tuples[1], kernel.tuples[0], `${vertical}: and re-presents a byte-identical tuple`);

    // WP control 14, the material half: the RE-SEAL is idempotent because the args and the material
    // are byte-reproducible. A single drifting field here — the wall-clock `resource_prefix` this
    // path used to seal — makes the second seal a different semantic payload under one effect_id,
    // which is REQUEST_DIGEST_CONFLICT, an incident and a scope hold rather than a retry.
    const [a, b] = kernel.seals as [SealedBody, SealedBody];
    assert.equal(kernel.argsOf(b), kernel.argsOf(a), `${vertical}: the args bytes are identical`);
    assert.equal(kernel.materialOf(b), kernel.materialOf(a), `${vertical}: the material bytes are identical`);
    assert.equal(b.material_ref, a.material_ref, `${vertical}: hence ONE material CAS key`);
    assert.deepEqual(b.work_bindings, a.work_bindings, `${vertical}: and the same self-binding`);
  }
});

test("A5 o-i: two DISTINCT origins over byte-identical work get distinct keys, ids and material", async () => {
  // The identity-vs-content falsification (WP §3.6): same repository, same base, same work item,
  // same requester — two logical origins, so two `origin_key`s and two `effect_id`s. A tuple keyed
  // on the work's CONTENT would collide these on one identity and land the second first seal in
  // REQUEST_DIGEST_CONFLICT.
  const kernel = scriptedKernel();
  const one = await startWork("unused", "development", DEV_EXTRA, { originKey: "origin-a", dependencies: deps(kernel) });
  const two = await startWork("unused", "development", DEV_EXTRA, { originKey: "origin-b", dependencies: deps(kernel) });
  assert.notEqual(two!.effect_id, one!.effect_id, "distinct origins, distinct identities");
  assert.notDeepEqual(kernel.tuples[1], kernel.tuples[0]);
  // The dev args are content only, so they DO match — which is exactly why the discriminator has to
  // be the origin and not the content. The self-bindings differ, the two effect_ids differing.
  assert.equal(kernel.argsOf(kernel.seals[1]!), kernel.argsOf(kernel.seals[0]!), "byte-identical work");
  assert.notEqual(workRunBindings(kernel.seals[1]!)[0]!.object_id, workRunBindings(kernel.seals[0]!)[0]!.object_id);

  // On the RECORD path the distinctness reaches the sealed material too, `resource_prefix` being a
  // function of the origin: two disposable runs never write each other's resources.
  const records = scriptedKernel();
  await startWork("unused", "record", RECORD_EXTRA, { originKey: "origin-a", dependencies: deps(records) });
  await startWork("unused", "record", RECORD_EXTRA, { originKey: "origin-b", dependencies: deps(records) });
  assert.notEqual(records.argsOf(records.seals[1]!), records.argsOf(records.seals[0]!), "distinct origins seal distinct record material");
});

// ---------------------------------------------------------------- no wall clock in sealed material

test("WP §3.6: the sealed record material carries a DETERMINISTIC resource_prefix and no wall-clock field", async () => {
  const prefix = originResourcePrefix("origin-prefix");
  assert.equal(prefix, `live-${sha256Hex("origin-prefix").slice(0, 16)}`, "a pure function of the origin key");
  assert.equal(originResourcePrefix("origin-prefix"), prefix, "and a stable one");
  assert.notEqual(originResourcePrefix("origin-prefix-2"), prefix, "distinct origins, distinct prefixes");

  const kernel = scriptedKernel();
  await startWork("unused", "record", RECORD_EXTRA, { originKey: "origin-prefix", dependencies: deps(kernel) });
  const args = JSON.parse(kernel.argsOf(kernel.seals[0]!)) as { record: { resource_prefix: string } };
  assert.equal(args.record.resource_prefix, prefix, "the sealed prefix IS that function's value");
  // The departed shape, asserted as an absence so a reintroduction fails here: `live-<ms % 100000>`
  // is at most five digits, and nothing sealed matches a bare wall-clock rendering.
  assert.doesNotMatch(args.record.resource_prefix, /^live-\d{1,5}$/u, "not the wall-clock prefix this replaces");
});

test("WP §3.6/control 14: TWO invocations of one origin at DIFFERENT wall-clock instants seal identical bytes", async () => {
  // The falsification run directly: the only thing that differs between the two invocations is the
  // clock. Under the wall-clock `resource_prefix` and the wall-clock `step_ordinal` this path used
  // to carry, the tuple AND the material both drifted; here neither does.
  const realNow = Date.now;
  const kernel = scriptedKernel();
  try {
    Date.now = () => 1_000_000_000_000;
    await startWork("unused", "record", RECORD_EXTRA, { originKey: "origin-clock", dependencies: deps(kernel) });
    Date.now = () => 1_000_000_777_777;
    await startWork("unused", "record", RECORD_EXTRA, { originKey: "origin-clock", dependencies: deps(kernel) });
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(kernel.tuples[1], kernel.tuples[0], "the allocation tuple does not move with the clock");
  assert.equal(kernel.argsOf(kernel.seals[1]!), kernel.argsOf(kernel.seals[0]!), "nor do the args");
  assert.equal(kernel.materialOf(kernel.seals[1]!), kernel.materialOf(kernel.seals[0]!), "nor the material");
});

// ---------------------------------------------------------------- the two ways an origin is decided

test("WP §3.6: workPlan DERIVES a stable, distinct origin_key per (proposal_evidence_id, item index)", () => {
  const proposal = "cadp-v04:evidence:11111111-1111-7000-8000-111111111111";
  const other = "cadp-v04:evidence:22222222-2222-7000-8000-222222222222";
  assert.equal(planOriginKey(proposal, 0), `${PLAN_ORIGIN_KEY_SCHEMA}:0:${proposal}`);
  assert.equal(planOriginKey(proposal, 0), planOriginKey(proposal, 0), "stable: the same pair, the same key");
  assert.notEqual(planOriginKey(proposal, 1), planOriginKey(proposal, 0), "distinct by ITEM INDEX");
  assert.notEqual(planOriginKey(other, 0), planOriginKey(proposal, 0), "distinct by PROPOSAL");

  // Injectivity where a naive concatenation would collide: the index is decimal digits and comes
  // FIRST, so no (proposal, index) pair can spell another pair's key however many colons the
  // evidence id carries. Two origins sharing a key would be two runs on one `effect_id`.
  const keys = new Set<string>();
  const ids = [proposal, other, "a", "a:1", "1:a", `${PLAN_ORIGIN_KEY_SCHEMA}:0:a`];
  for (const id of ids) for (const index of [0, 1, 10, 100]) keys.add(planOriginKey(id, index));
  assert.equal(keys.size, ids.length * 4, "every distinct pair encodes to a distinct key");

  // Fail closed rather than derive an origin from nothing, or from a malformed index.
  assert.throws(() => planOriginKey("", 0), /needs a proposal evidence id/u);
  assert.throws(() => planOriginKey(proposal, -1), /malformed proposal item index/u);
  assert.throws(() => planOriginKey(proposal, 1.5), /malformed proposal item index/u);
});

test("WP §3.6: workPlan THREADS that derived key into each item's startWork, and mints nothing", async () => {
  const items = [
    { work_item: "item one", max_steps: 4, max_effects: 2, rationale: "bounded" },
    { work_item: "item two", max_steps: 5, max_effects: 3, rationale: "bounded" },
  ];
  const proposal = "cadp-v04:evidence:33333333-3333-7000-8000-333333333333";
  const threaded: Array<string | undefined> = [];
  const run = async () => workPlan("unused", proposal, undefined, undefined, {
    loadProposal: async () => ({ schema: "cadp.work-proposal.v1", items }) as never,
    startWork: async (_dir, _vertical, _extra, options) => {
      threaded.push(options?.originKey);
      return { effect_id: `effect-${threaded.length}`, workflow_id: "wf", origin_key: options!.originKey! };
    },
    pollRun: async () => ({ status: "COMPLETED" }) as never,
  });

  await run();
  assert.deepEqual(threaded, [planOriginKey(proposal, 0), planOriginKey(proposal, 1)], "one derived key per item index");

  // A SECOND run of the driver over the same proposal is a retry of the same two origins, not the
  // creation of two more: the keys repeat verbatim, so each item converges on its own `effect_id`.
  await run();
  assert.deepEqual(threaded.slice(2), threaded.slice(0, 2), "re-running the driver retries the same origins");
});

test("A4/A5: a DIRECT start mints its origin_key ONCE with randomUUID and retains it across a retry", async () => {
  const kernel = scriptedKernel();
  let mints = 0;
  const mint = () => {
    mints += 1;
    return `minted-${mints}`;
  };

  // ONE mint per invocation, however many places consume the key: the record path reads it for the
  // allocation tuple AND for `resource_prefix`, and a second call would be a second identity.
  const first = await startWork("unused", "record", RECORD_EXTRA, { dependencies: deps(kernel, mint) });
  assert.equal(mints, 1, "exactly one mint");
  assert.equal(first!.origin_key, "minted-1", "and the invocation reports the key it minted");
  assert.equal((kernel.tuples[0]! as { origin_key: string }).origin_key, "minted-1");
  assert.equal(
    (JSON.parse(kernel.argsOf(kernel.seals[0]!)) as { record: { resource_prefix: string } }).record.resource_prefix,
    originResourcePrefix("minted-1"),
    "the same one key, in both consumers",
  );

  // THE RETRY: the caller passes the reported key back, so nothing is minted and the origin
  // converges. Minting again here is exactly the fork the discriminator exists to prevent.
  const retry = await startWork("unused", "record", RECORD_EXTRA, { originKey: first!.origin_key, dependencies: deps(kernel, mint) });
  assert.equal(mints, 1, "a retry mints NOTHING");
  assert.equal(retry!.effect_id, first!.effect_id, "and lands on the same identity");
  assert.equal(kernel.materialOf(kernel.seals[1]!), kernel.materialOf(kernel.seals[0]!), "with the same material bytes");
});

test("A4: the default direct-start mint is crypto.randomUUID — never the wall clock", async () => {
  const kernel = scriptedKernel();
  const one = await startWork("unused", "development", DEV_EXTRA, { dependencies: deps(kernel) });
  const two = await startWork("unused", "development", DEV_EXTRA, { dependencies: deps(kernel) });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  assert.match(one!.origin_key, uuid);
  assert.match(two!.origin_key, uuid);
  // Two direct starts are two logical origins even over byte-identical work, so they must not
  // share an identity — which a wall-clock-seconds discriminator would have given them.
  assert.notEqual(two!.origin_key, one!.origin_key);
  assert.notEqual(two!.effect_id, one!.effect_id);
});
