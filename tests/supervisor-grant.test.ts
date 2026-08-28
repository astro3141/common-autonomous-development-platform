/**
 * IG-1 — the run-scoped SUPERVISOR CapabilityGrant (TD §12.4, §13.4, §18.1a).
 *
 * The use-case is checked where it actually sits in the sequence: a run is opened through
 * `bootstrapRun`, the grant is issued, and only then can a Supervisor be spawned. The two
 * falsification tests are the point of the file — an implementation that let a Supervisor spawn
 * without the grant, or that requested a single capability as `true`, fails here.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { bootstrapRun } from "../core/admission/bootstrap.ts";
import { CapabilityError } from "../core/capability/errors.ts";
import type { ManifestSetInput } from "../core/capability/manifest-set.ts";
import type {
  CapabilityGrantV1Body,
  EnforcementAssurance,
} from "../core/capability/types.ts";
import { CAPABILITY_NAMES } from "../core/schemas/capability-vocabulary.ts";
import { issueSupervisorGrant } from "../core/admission/supervisor-grant.ts";
import { requestSupervisorProposal } from "../core/execution/supervisor-session.ts";
import type { RuntimeProfile } from "../adapters/interfaces/handles.ts";
import { StoreError, type StoreErrorCode } from "../core/store/errors.ts";
import type { PlatformStore } from "../core/store/platform-store.ts";
import { manifestSetInput } from "./support/admission-fixtures.ts";
import { compiled } from "./support/decision-fixtures.ts";
import { readyPreflight, RecordingRuntime } from "./support/execution-fixtures.ts";
import { coordinatorWorld } from "./support/coordinator-fixtures.ts";
import { withWorld } from "./support/domain-fixtures.ts";
import { tempStore } from "./support/temp-store.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const RUN_ID = "run:01JQ8ZK5T7RC9V2W4X6Y8Z0E01";
const BATCH_ID = `${"batch:"}${RUN_ID}:1`;
const PROJECT = "alpha";
const GRANT_ID = "01JQ8ZK5T7RC9V2W4X6Y8Z0E02";
const OTHER_GRANT_ID = "01JQ8ZK5T7RC9V2W4X6Y8Z0E03";

/** A second run in the same store, opened exactly like the first (§18.1a scopes them apart). */
const SECOND_RUN_ID = "run:01JQ8ZK5T7RC9V2W4X6Y8Z0E04";
const SECOND_BATCH_ID = `${"batch:"}${SECOND_RUN_ID}:1`;

const storeError =
  (code: StoreErrorCode) =>
  (error: unknown): boolean =>
    error instanceof StoreError && error.code === code;

/**
 * A manifest set whose `shell.execute` deny direction differs from its allow direction, so the
 * §12.2a direction the grant actually took is visible in the enforcement map.
 */
const manifests = (deny: EnforcementAssurance = "NOT_YET_AUDITED"): ManifestSetInput =>
  manifestSetInput({ "shell.execute": { deny } });

/** A run opened exactly as a composition root would open it — and nothing else. */
function withRun<T>(body: (store: PlatformStore) => T): T {
  const temp = tempStore();
  const store = temp.open();
  try {
    bootstrapRun(store, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      project_id: PROJECT,
      compiled_profile: compiled(),
    });
    return body(store);
  } finally {
    store.close();
    temp.dispose();
  }
}

const supervisorRow = (store: PlatformStore) =>
  store.grants.forRun(RUN_ID).find((row) => row.role === "SUPERVISOR");

// --- issuance ---------------------------------------------------------------------------------

test("IG-1: the run-scoped grant is issued after run initialization, at run scope", () => {
  withRun((store) => {
    const result = issueSupervisorGrant(store, {
      run_id: RUN_ID,
      grant_id: GRANT_ID,
      manifests: manifests(),
    });

    assert.equal(result.issued, true);
    assert.equal(result.grant_id, GRANT_ID);

    // §18.1a — one row, run-anchored, with no attempt behind it.
    const rows = store.grants.forRun(RUN_ID);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { role: rows[0]?.role, run: rows[0]?.run_id, attempt: rows[0]?.attempt_key },
      { role: "SUPERVISOR", run: RUN_ID, attempt: null },
    );
    assert.equal(rows[0]?.grant_hash, result.grant_hash);
    assert.equal(store.grants.count(), 1, "no ACTOR/AUDITOR grant was issued alongside it");

    // The persisted envelope is the authority, not the returned object.
    const stored = store.grants.get(GRANT_ID)?.body as unknown as CapabilityGrantV1Body;
    assert.equal(stored.role, "SUPERVISOR");
    assert.deepEqual(stored.requested, result.body.requested);
  });
});

test("IG-1 / §12.4: the Supervisor requests all twelve capabilities as false", () => {
  withRun((store) => {
    const { body } = issueSupervisorGrant(store, {
      run_id: RUN_ID,
      grant_id: GRANT_ID,
      manifests: manifests(),
    });

    assert.deepEqual(Object.keys(body.requested).sort(), [...CAPABILITY_NAMES].sort());
    assert.equal(Object.keys(body.requested).length, 12);
    for (const capability of CAPABILITY_NAMES) {
      assert.equal(body.requested[capability], false, `${capability} was requested`);
    }

    // §12.2a — a false request takes the *deny* direction. The manifest declares `ENFORCED` for
    // allow and `NOT_YET_AUDITED` for deny, so this value could not come from a granted request.
    assert.equal(body.enforcement["shell.execute"], "NOT_YET_AUDITED");
    assert.equal(body.enforcement["repository.read"], "ENFORCED", "deny is enforced there");
  });
});

// --- re-entry ---------------------------------------------------------------------------------

test("IG-1: re-entry reuses the same logical grant and never opens a second one", () => {
  withRun((store) => {
    const first = issueSupervisorGrant(store, {
      run_id: RUN_ID,
      grant_id: GRANT_ID,
      manifests: manifests(),
    });

    // A restart brings a fresh identity allocator with it. The run's own grant still wins.
    const again = issueSupervisorGrant(store, {
      run_id: RUN_ID,
      grant_id: OTHER_GRANT_ID,
      manifests: manifests(),
    });

    assert.equal(again.issued, false);
    assert.equal(again.grant_id, first.grant_id);
    assert.equal(again.grant_hash, first.grant_hash);
    assert.deepEqual(again.body, first.body);
    assert.equal(store.grants.count(), 1);
    assert.equal(store.grants.get(OTHER_GRANT_ID), undefined, "the second ULID was never used");
  });
});

test("IG-1: a moved material input fails closed rather than issuing a second grant", () => {
  withRun((store) => {
    issueSupervisorGrant(store, { run_id: RUN_ID, grant_id: GRANT_ID, manifests: manifests() });

    // The Backend's declared enforcement moved after the run was authorized.
    assert.throws(
      () =>
        issueSupervisorGrant(store, {
          run_id: RUN_ID,
          grant_id: GRANT_ID,
          manifests: manifests("UNENFORCEABLE_CAPABILITY_BOUNDARY"),
        }),
      storeError("ARTIFACT_CONFLICT"),
    );
    assert.equal(store.grants.count(), 1, "the run still holds exactly one grant");
    assert.equal(supervisorRow(store)?.grant_id, GRANT_ID);
  });
});

// --- deterministic failure direction ----------------------------------------------------------

test("IG-1: a missing run is refused before anything is derived or written", () => {
  withRun((store) => {
    assert.throws(
      () =>
        issueSupervisorGrant(store, {
          run_id: "run:01JQ8ZK5T7RC9V2W4X6Y8Z0E09",
          grant_id: GRANT_ID,
          manifests: manifests(),
        }),
      storeError("DOMAIN_ROW_MISSING"),
    );
    assert.equal(store.grants.count(), 0);
  });
});

test("IG-1: a grant identity another run already holds is refused, not silently reused", () => {
  withRun((store) => {
    bootstrapRun(store, {
      run_id: SECOND_RUN_ID,
      batch_id: SECOND_BATCH_ID,
      project_id: PROJECT,
      compiled_profile: compiled(),
    });
    issueSupervisorGrant(store, { run_id: RUN_ID, grant_id: GRANT_ID, manifests: manifests() });

    // `run_id` is not part of the grant envelope, so a second run reusing one caller-allocated
    // ULID over the same profile and manifests derives byte-identical content. That must not read
    // as "already stored, nothing to do": the second run would then hold no grant at all.
    assert.throws(
      () =>
        issueSupervisorGrant(store, {
          run_id: SECOND_RUN_ID,
          grant_id: GRANT_ID,
          manifests: manifests(),
        }),
      storeError("DOMAIN_ROW_INVALID"),
    );

    assert.equal(store.grants.count(), 1, "no row was written for the second run");
    assert.deepEqual(store.grants.forRun(SECOND_RUN_ID), []);
    assert.equal(store.grants.meta(GRANT_ID)?.run_id, RUN_ID, "the first run keeps its grant");

    // And the second run cannot reach the Runtime on the strength of the first run's grant.
    const runtime = new RecordingRuntime();
    assert.throws(
      () =>
        requestSupervisorProposal(
          { store, runtime, manifests: manifests(), preflight: readyPreflight },
          {
            run_id: SECOND_RUN_ID,
            batch_id: SECOND_BATCH_ID,
            decision_context: {} as never,
            runtime_profile: "supervisor" as unknown as RuntimeProfile,
          },
        ),
      /no run-scoped SUPERVISOR grant/,
    );
    assert.equal(runtime.spawnCalls.length, 0);
    assert.equal(runtime.sessionCount, 0);
  });
});

test("IG-1: an unusable Backend manifest set is refused before anything is written", () => {
  withRun((store) => {
    const swapped = manifests();
    assert.throws(
      () =>
        issueSupervisorGrant(store, {
          run_id: RUN_ID,
          grant_id: GRANT_ID,
          // The RUNTIME slot holds a WORKFLOW manifest: §12.2a's own typed failure.
          manifests: { ...swapped, runtime: swapped.workflow },
        }),
      (error: unknown) =>
        error instanceof CapabilityError && error.reason === "MANIFEST_SET_INVALID",
    );
    assert.equal(store.grants.count(), 0);
  });
});

test("IG-1: an identity that is not a ULID is refused by the Broker, not silently accepted", () => {
  withRun((store) => {
    assert.throws(
      () =>
        issueSupervisorGrant(store, {
          run_id: RUN_ID,
          grant_id: "supervisor-grant",
          manifests: manifests(),
        }),
      (error: unknown) => error instanceof CapabilityError && error.reason === "GRANT_INVALID",
    );
    assert.equal(store.grants.count(), 0);
  });
});

// --- falsification ------------------------------------------------------------------------------

test("IG-1: no Supervisor can be spawned before the grant exists, and nothing external happens", () => {
  withRun((store) => {
    const runtime = new RecordingRuntime();
    const authorities = {
      store,
      runtime,
      manifests: manifests(),
      preflight: readyPreflight,
    };
    const command = {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      decision_context: {} as never,
      runtime_profile: "supervisor" as unknown as RuntimeProfile,
    };

    assert.throws(
      () => requestSupervisorProposal(authorities, command),
      /no run-scoped SUPERVISOR grant/,
    );
    // The whole point: the Runtime was never reached.
    assert.equal(runtime.spawnCalls.length, 0);
    assert.equal(runtime.sendCalls.length, 0);
    assert.equal(runtime.sessionCount, 0);
  });
});

test("IG-1: the grant the Runtime is spawned with requests nothing at all", () => {
  withWorld((world) => {
    const w = coordinatorWorld(world);
    assert.equal(w.tick(), "SUPERVISOR_REQUESTED");

    const spawn = w.runtime.spawns.find((call) => call.role === "SUPERVISOR");
    assert.notEqual(spawn, undefined, "the Supervisor was spawned");
    const grant = spawn?.capability_grant as CapabilityGrantV1Body;
    assert.equal(grant.role, "SUPERVISOR");
    for (const capability of CAPABILITY_NAMES) {
      assert.equal(grant.requested[capability], false, `${capability} reached the Runtime as true`);
    }

    // And it is the durable run-scoped grant, not something assembled for the spawn.
    const row = world.store.grants.meta(grant.grant_id);
    assert.deepEqual(
      { role: row?.role, attempt: row?.attempt_key },
      { role: "SUPERVISOR", attempt: null },
    );
  });
});

// --- ownership boundary ---------------------------------------------------------------------------

test("IG-1: grant issuance stays in Core, and deployment derives nothing", () => {
  const sourcesUnder = (directory: string): string[] =>
    readdirSync(directory, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(directory, name));

  const issuers: string[] = [];
  for (const root of ["core", "adapters", "deployment"]) {
    const directory = join(ROOT, root);
    if (!existsSync(directory)) continue;

    for (const file of sourcesUnder(directory)) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      if (/issueCapabilityGrant/.test(code)) issuers.push(relative(ROOT, file));
      if (root !== "deployment") continue;

      // A composition root may call the use-case. It may not do any of its work.
      for (const forbidden of [
        /issueCapabilityGrant|deriveRequestedCapabilities|deriveEnforcement/,
        /grants\.put|capability_grant/,
        /validateEnforcementReceipt/,
      ]) {
        assert.equal(
          forbidden.test(code),
          false,
          `${relative(ROOT, file)} owns grant work that belongs to Core: ${forbidden}`,
        );
      }
    }
  }

  // The Broker, its barrel, and the only two use-cases that may reach it (§12.7, §13.4).
  assert.deepEqual(issuers.sort(), [
    "core/admission/supervisor-grant.ts",
    "core/capability/broker.ts",
    "core/capability/index.ts",
    "core/contract/builder.ts",
  ]);
});
