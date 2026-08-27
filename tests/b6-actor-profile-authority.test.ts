/**
 * MVP1-B6 close-out correction A — the Actor profile is a decision, not a parameter.
 *
 * Three layers stay separate throughout (TD §9.2, §12.7):
 *
 *   CoreExecutionRole   ACTOR — what the grant is for
 *   role_profile_id     task.actor_profile — what the Supervisor selected and V6 validated
 *   runtime_profile     effective.project.roles[actor_profile].runtime_profile
 *
 * so nothing at execution time may re-choose the middle layer.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startImplementation } from "../core/execution/start-implementation.ts";
import { TASK_KEY, withWorld } from "./support/domain-fixtures.ts";
import { activatedWorld, SELECTED_ACTOR_PROFILE } from "./support/execution-fixtures.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXECUTION = join(ROOT, "core/execution/start-implementation.ts");

const start = (attempt_key: string) => ({ attempt_key });

// --- the command carries no role -------------------------------------------------------------

test("B6 seal 1/5: the production command is exactly one field, so no role can be injected", () => {
  const source = readFileSync(EXECUTION, "utf8");
  const start = source.indexOf("export interface StartImplementationCommand {");
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.deepEqual(
    [...body.matchAll(/^\s+readonly\s+([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]),
    ["attempt_key"],
  );

  // Nor by any other route: the module never names a caller-supplied role or profile input.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const forbidden of [/actor_role_id/, /role_profile_id/, /command\.(role|profile)/]) {
    assert.equal(forbidden.test(code), false, `start-implementation accepts ${forbidden}`);
  }
});

// --- the authority is the durable selection ----------------------------------------------------

test("B6 seal 2/5: the runtime profile is resolved from task.actor_profile, not chosen", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    const task = world.store.tasks.require(TASK_KEY);
    assert.equal(task.actor_profile, SELECTED_ACTOR_PROFILE, "the selection is durable");

    assert.equal(startImplementation(w, start(w.attempt_key)).kind, "IMPLEMENTING");

    const compiled = world.store.batchView.compiledProfileFor(task.batch_id);
    const declared = compiled.effective.project.roles[SELECTED_ACTOR_PROFILE];
    assert.equal(w.runtime.spawns.length, 1);
    assert.equal(w.runtime.spawns[0]?.runtime_profile, declared?.runtime_profile);
    // §3 — the CoreExecutionRole is the role, and it is not the profile key.
    assert.equal(w.runtime.spawns[0]?.role, "ACTOR");
    assert.notEqual(w.runtime.spawns[0]?.role, SELECTED_ACTOR_PROFILE);
  });
});

test("B6 seal 2/5: a different durable selection produces a different runtime profile", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    const task = world.store.tasks.require(TASK_KEY);
    const compiled = world.store.batchView.compiledProfileFor(task.batch_id);

    // The two declared roles name different runtime profiles, so the resolution is observable.
    const other = Object.keys(compiled.effective.project.roles).find(
      (id) => id !== SELECTED_ACTOR_PROFILE,
    ) as string;
    assert.notEqual(
      compiled.effective.project.roles[other]?.runtime_profile,
      compiled.effective.project.roles[SELECTED_ACTOR_PROFILE]?.runtime_profile,
    );

    // Moving the *durable* selection is the only thing that moves the spawn input.
    world.store.withTransaction(() => {
      world.store.tasks.write(TASK_KEY, {
        platform_state: "ACTIVE",
        selection: {
          selection: {
            classification: task.classification as string,
            pipeline_id: task.pipeline_id as string,
            actor_profile: other,
            verification_profile: task.verification_profile as string,
          },
          repository_scope_id: task.repository_scope_id as string,
          selection_binding: task.selection_binding!,
        },
        replace_selection: true,
      });
    });

    assert.equal(startImplementation(w, start(w.attempt_key)).kind, "IMPLEMENTING");
    assert.equal(
      w.runtime.spawns[0]?.runtime_profile,
      compiled.effective.project.roles[other]?.runtime_profile,
    );
  });
});

// --- fail-closed on an undeclared selection -----------------------------------------------------

test("B6 seal 5/5: an actor_profile the Compiled Profile does not declare fails closed", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    const task = world.store.tasks.require(TASK_KEY);

    world.store.withTransaction(() => {
      world.store.tasks.write(TASK_KEY, {
        platform_state: "ACTIVE",
        selection: {
          selection: {
            classification: task.classification as string,
            pipeline_id: task.pipeline_id as string,
            actor_profile: "not-declared",
            verification_profile: task.verification_profile as string,
          },
          repository_scope_id: task.repository_scope_id as string,
          selection_binding: task.selection_binding!,
        },
        replace_selection: true,
      });
    });

    assert.throws(
      () => startImplementation(w, start(w.attempt_key)),
      /not declared by the compiled profile/,
    );

    // No fallback role was chosen, and the failure is before the first intent.
    assert.equal(world.store.idempotency.count(), 0);
    assert.equal(world.store.adapterMetadata.count(), 0);
    assert.equal(w.repository.workspaceCount, 0);
    assert.equal(w.runtime.sessionCount, 0);
    assert.equal(w.runtime.turnCount, 0);
    assert.equal(world.store.attempts.require(w.attempt_key).state, "READY");
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");
  });
});

// --- the grant is reused, never recomputed --------------------------------------------------------

test("B6 seal 4/5: the immutable Actor grant issued at activation is the one handed over", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    const before = world.store.grants.count();
    const attempt = world.store.attempts.require(w.attempt_key);
    const contract = world.store.contracts.get(attempt.contract_snapshot_id);
    const grants = (contract?.body as unknown as {
      capability_grants: { actor: { grant_id: string }; auditor: { grant_id: string } };
    }).capability_grants;

    assert.equal(startImplementation(w, start(w.attempt_key)).kind, "IMPLEMENTING");

    assert.equal(world.store.grants.count(), before, "no grant was issued or recomputed");
    assert.deepEqual(
      w.runtime.spawns[0]?.capability_grant,
      world.store.grants.get(grants.actor.grant_id)?.body,
    );
    // The Auditor's grant is not handed to the Actor.
    assert.notDeepEqual(
      w.runtime.spawns[0]?.capability_grant,
      world.store.grants.get(grants.auditor.grant_id)?.body,
    );
  });
});

test("B6 seal 3/5: the execution module never derives a role from the pipeline", () => {
  const code = readFileSync(EXECUTION, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const forbidden of [/pipeline/i, /PIPELINE_STEPS/, /\.steps\b/, /Object\.keys\(.*roles/]) {
    assert.equal(forbidden.test(code), false, `the module reads ${forbidden}`);
  }
  // `ACTOR` appears as the CoreExecutionRole constant only.
  assert.equal((code.match(/"ACTOR"/g) ?? []).length, 1);
});
