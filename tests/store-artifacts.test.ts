/**
 * B8-AC3, B8-AC14 ~ B8-AC16, B8-AC21 — immutable artifact persistence: whole envelopes, re-hashed
 * on load, idempotent on identical content and fail-closed on anything else.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { issueCapabilityGrant } from "../core/capability/broker.ts";
import { StoreError } from "../core/store/errors.ts";
import { openDatabase } from "../core/store/database.ts";
import { compiled, manifests } from "./support/decision-fixtures.ts";
import {
  ATTEMPT_KEY,
  RUN_ID,
  SELECTION,
  SELECTION_WRITE,
  ULID,
  contractBuild,
  discover,
  withWorld,
  world,
} from "./support/domain-fixtures.ts";
import { HEAD } from "./support/decision-fixtures.ts";

const storeError = (code: string) => (error: unknown) =>
  error instanceof StoreError && error.code === code;

// --- compiled_profile_snapshot ----------------------------------------------------------

test("B8-AC3: the Compiled Profile is stored as a whole envelope and re-hashes on load", () => {
  withWorld((world) => {
    const loaded = world.store.compiledProfiles.get(world.profile.compiled_hash);
    assert.ok(loaded !== undefined);
    assert.deepEqual(Object.keys(loaded).sort(), ["body", "schema", "schema_version"]);
    assert.equal(loaded.schema, "platform/compiled-profile");
    // Body-only storage would make this impossible.
    assert.deepEqual(loaded.body, world.profile.envelope.body);

    // Re-putting the identical envelope is a no-op.
    world.store.withTransaction(() => world.store.compiledProfiles.put(world.profile));
    assert.equal(world.store.compiledProfiles.count(), 1);
  });
});

test("B8-AC3: a different envelope under the same hash is refused, and corruption fails closed", () => {
  withWorld((world) => {
    const other = compiled({ batch_policy: { max_tasks: 9, max_rework: 2, concurrency: 2 } });
    const forged = { ...other, compiled_hash: world.profile.compiled_hash };
    assert.throws(
      () => world.store.withTransaction(() => world.store.compiledProfiles.put(forged)),
      storeError("ARTIFACT_CONFLICT"),
    );

  });
});

test("B8-AC3: a tampered stored envelope fails closed on load", () => {
  const created = world();
  const hash = created.profile.compiled_hash;
  const path = created.temp.path;
  created.store.close();

  // Rewrite the stored bytes behind the store's back.
  const database = openDatabase(path);
  try {
    database
      .prepare("UPDATE compiled_profile_snapshot SET envelope_json = ? WHERE compiled_hash = ?")
      .run('{"schema":"platform/compiled-profile","schema_version":1,"body":{}}', hash);
  } finally {
    database.close();
  }

  const reopened = created.temp.open();
  try {
    assert.throws(() => reopened.compiledProfiles.get(hash), storeError("ARTIFACT_CORRUPT"));
  } finally {
    reopened.close();
    created.temp.dispose();
  }
});

// --- task_contract_snapshot ---------------------------------------------------------------

test("B8-AC14: the Task Contract envelope is persisted whole and verified on load", () => {
  withWorld((world) => {
    const built = contractBuild(world)();
    world.store.withTransaction(() => world.store.contracts.put(built.contract));

    const loaded = world.store.contracts.get(built.contract.body.snapshot_id);
    assert.ok(loaded !== undefined);
    assert.equal(loaded.schema, "platform/task-contract");
    assert.deepEqual(loaded.body, built.contract.envelope.body);
    assert.equal(world.store.contracts.hashOf(ULID.snapshot), built.contract.hash);

    // Idempotent replay, and a conflicting body under the same id fails closed.
    world.store.withTransaction(() => world.store.contracts.put(built.contract));
    assert.equal(world.store.contracts.count(), 1);

    const different = contractBuild(world, { attempt: 2 })();
    const forged = {
      ...different,
      contract: { ...different.contract, body: { ...different.contract.body } },
    };
    assert.throws(
      () =>
        world.store.withTransaction(() =>
          world.store.contracts.put({
            ...forged.contract,
            body: { ...forged.contract.body, snapshot_id: ULID.snapshot },
          }),
        ),
      storeError("ARTIFACT_CONFLICT"),
    );
  });
});

// --- capability_grant ----------------------------------------------------------------------

test("B8-AC15 / B8-AC16: grants persist with their hash, and scope is enforced per role", () => {
  withWorld((world) => {
    const key = discover(world);
    const built = contractBuild(world)();
    world.store.withTransaction(() => {
      world.store.tasks.write(key, {
        platform_state: "ACTIVE",
        selection: SELECTION_WRITE,
        admitted_at: "t",
      });
      world.store.contracts.put(built.contract);
      world.store.attempts.create({
        attempt_key: ATTEMPT_KEY,
        task_key: key,
        n: 1,
        contract_snapshot_id: built.contract.body.snapshot_id,
        base_head: HEAD,
      });
      world.store.grants.put(built.actor_grant, { kind: "ATTEMPT", attempt_key: ATTEMPT_KEY });
      world.store.grants.put(built.auditor_grant, { kind: "ATTEMPT", attempt_key: ATTEMPT_KEY });
    });

    const roles = world.store.grants.forAttempt(ATTEMPT_KEY);
    assert.deepEqual(roles.map((row) => row.role), ["ACTOR", "AUDITOR"]);
    assert.equal(roles[0]?.run_id, null);
    assert.equal(world.store.grants.meta(ULID.actorGrant)?.grant_hash, built.actor_grant.grant_hash);
    assert.ok(world.store.grants.get(ULID.actorGrant) !== undefined);

    // A second ACTOR grant on the same attempt is refused by the partial unique index.
    assert.throws(() =>
      world.store.withTransaction(() =>
        world.store.grants.put(
          issueCapabilityGrant({
            grant_id: ULID.supervisorGrant,
            role: "ACTOR",
            effective_policy: world.profile.body.effective.policy,
            runtime_manifest: manifests().runtime,
            task_contract_capability_view: {
              repository_scope: { allowed_paths: [], forbidden_paths: [] },
            },
          }),
          { kind: "ATTEMPT", attempt_key: ATTEMPT_KEY },
        ),
      ),
    );
  });
});

test("B8-AC16: a SUPERVISOR grant is run-scoped and Batch 8 never issues one itself", () => {
  withWorld((world) => {
    const supervisor = issueCapabilityGrant({
      grant_id: ULID.supervisorGrant,
      role: "SUPERVISOR",
      effective_policy: world.profile.body.effective.policy,
      runtime_manifest: manifests().runtime,
      task_contract_capability_view: {
        repository_scope: { allowed_paths: [], forbidden_paths: [] },
      },
    });

    world.store.withTransaction(() =>
      world.store.grants.put(supervisor, { kind: "RUN", run_id: RUN_ID }),
    );
    const meta = world.store.grants.meta(ULID.supervisorGrant);
    assert.deepEqual({ role: meta?.role, run: meta?.run_id, attempt: meta?.attempt_key }, {
      role: "SUPERVISOR",
      run: RUN_ID,
      attempt: null,
    });

    // Anchoring it to an attempt instead is a contract violation.
    assert.throws(
      () =>
        world.store.withTransaction(() =>
          world.store.grants.put(supervisor, { kind: "ATTEMPT", attempt_key: ATTEMPT_KEY }),
        ),
      storeError("DOMAIN_ROW_INVALID"),
    );
  });
});

test("B8-AC16: the Task Contract still binds only the actor and auditor grants", () => {
  withWorld((world) => {
    const built = contractBuild(world)();
    assert.deepEqual(Object.keys(built.contract.body.capability_grants).sort(), ["actor", "auditor"]);
  });
});

// --- operator_action ------------------------------------------------------------------------

test("B8-AC21: an operator action is immutable, RESOLVED-only and hash-verified", () => {
  withWorld((world) => {
    const record = world.store.withTransaction(() =>
      world.store.operatorActions.put({
        action_id: ULID.action,
        field_path: "auto_merge",
        approved_value: true,
        recorded_by: "operator-reference-1",
        recorded_at: "rec-1",
      }),
    );

    assert.equal(record.status, "RESOLVED");
    assert.match(record.record_hash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(world.store.operatorActions.get(ULID.action), record);

    // Replay is idempotent; different content under the same id is refused.
    world.store.withTransaction(() =>
      world.store.operatorActions.put({
        action_id: ULID.action,
        field_path: "auto_merge",
        approved_value: true,
        recorded_by: "operator-reference-1",
        recorded_at: "rec-1",
      }),
    );
    assert.equal(world.store.operatorActions.count(), 1);

    assert.throws(
      () =>
        world.store.withTransaction(() =>
          world.store.operatorActions.put({
            action_id: ULID.action,
            field_path: "auto_merge",
            approved_value: false,
            recorded_by: "operator-reference-1",
            recorded_at: "rec-1",
          }),
        ),
      storeError("ARTIFACT_CONFLICT"),
    );
  });
});

test("B8-AC21: there is no REVOKED status and no revocation path", () => {
  withWorld((world) => {
    const source = world.store.operatorActions as unknown as Record<string, unknown>;
    for (const forbidden of ["revoke", "update", "delete"]) {
      assert.equal(typeof source[forbidden], "undefined", `${forbidden} must not exist`);
    }
    // The CHECK constraint refuses anything but RESOLVED.
    assert.throws(() =>
      world.store.withTransaction(() => {
        const database = openDatabase(world.temp.path);
        try {
          database
            .prepare(
              `INSERT INTO operator_action
                 (action_id, status, field_path, approved_value_json, recorded_by, recorded_at,
                  record_hash, envelope_json)
               VALUES ('x', 'REVOKED', 'p', 'true', 'who', 'when', 'h', '{}')`,
            )
            .run();
        } finally {
          database.close();
        }
      }),
    );
  });
});
