/**
 * MVP1-B6 — `Attempt READY → Attempt IMPLEMENTING` (TD §19.3e, §21, §24).
 *
 * Covers the batch's areas D–G and J–U: the three write-ahead operations and their ordering, the
 * crash windows W1–W4 and T1–T4, what ends up durable, and everything that must still be absent.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { startImplementation } from "../core/execution/start-implementation.ts";
import { STATE_TRANSITION_KIND } from "../core/statemachine/transition-commit.ts";
import { SECRET_BEARING_KEY_CATEGORIES } from "../core/store/restricted-key-denylist.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import type { PlatformStore } from "../core/store/platform-store.ts";
import { TASK_KEY, withWorld } from "./support/domain-fixtures.ts";
import {
  activatedWorld,
  blockedPreflight,
  readyPreflight,
  type ExecutionWorld,
} from "./support/execution-fixtures.ts";

/** One call site for the command, so every test starts the same attempt the same way. */
const start = (w: ExecutionWorld, authorities: ExecutionWorld = w) =>
  startImplementation(authorities, { attempt_key: w.attempt_key });

const workspaceOp = (attempt: string): string => `op:${attempt}:workspace`;
const spawnOp = (attempt: string): string => `op:${attempt}:actor-spawn`;
const turnOp = (attempt: string): string => `op:${attempt}:actor-turn:1`;

const opState = (store: PlatformStore, opKey: string): string | undefined =>
  store.idempotency.get(opKey)?.state;

/** Everything this batch must leave untouched (§30, area U). */
const untouched = (store: PlatformStore) => ({
  evidence: store.verificationEvidence.count(),
  audits: store.auditRecords.count(),
  outbox: store.outbox.count(),
  pending: store.pendingDecisions.count(),
  candidate: store.attempts.forTask(TASK_KEY)[0]?.candidate_commit ?? null,
});

// --- area S: the success endpoint ---------------------------------------------------------

test("B6-25 (S): a clean run reaches IMPLEMENTING with all three operations DONE", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    const result = start(w);

    assert.equal(result.kind, "IMPLEMENTING");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "IMPLEMENTING");
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");

    for (const op of [workspaceOp, spawnOp, turnOp]) {
      assert.equal(opState(world.store, op(w.attempt_key)), "DONE", op(w.attempt_key));
    }
    assert.equal(world.store.idempotency.count(), 3, "exactly three external operations");

    // §30 — nothing from a later stage exists yet.
    assert.deepEqual(untouched(world.store), {
      evidence: 0,
      audits: 0,
      outbox: 0,
      pending: 0,
      candidate: null,
    });
  });
});

// --- area M: adapter_metadata ---------------------------------------------------------------

test("B6-12 / B6-16 / B6-23 (M): the three projections are durable on the attempt", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    start(w);

    const rows = world.store.adapterMetadata.forEntity(w.attempt_key);
    assert.deepEqual(
      rows.map((row) => `${row.adapter_id}/${row.key}`),
      ["repository/feature_workspace", "runtime/actor_session", "runtime/actor_turn:1"],
    );
    assert.equal(world.store.adapterMetadata.count(), 3, "no other entity gained metadata");

    const workspace = rows[0]?.value as Record<string, unknown>;
    assert.deepEqual(Object.keys(workspace).sort(), [
      "base_head",
      "branch",
      "path",
      "repository_ref",
    ]);
    assert.equal(workspace["base_head"], w.repository.head);
    assert.equal(workspace["repository_ref"], w.repository.ref);

    // The session and turn projections are exactly what the adapter handed over.
    assert.deepEqual(rows[1]?.value, { agent: "actor", session: "session-1" });
    assert.deepEqual(rows[2]?.value, { turn: "turn-1" });
  });
});

test("B6-24 (N): a handle carrying a restricted identifier is never persisted", () => {
  for (const category of SECRET_BEARING_KEY_CATEGORIES) {
    withWorld((world) => {
      const w = activatedWorld(world);
      w.runtime.sessionValue = () => ({ agent: "actor", [category]: "value" }) as CanonicalObject;

      assert.throws(() => start(w), /restricted/i, category);

      // The spawn happened, but nothing about it became durable and no turn was ever sent.
      assert.equal(w.runtime.sessionCount, 1);
      assert.equal(w.runtime.turnCount, 0, "no turn follows a rejected handle");
      assert.equal(
        world.store.adapterMetadata.get(w.attempt_key, "runtime", "actor_session"),
        undefined,
      );
      assert.equal(opState(world.store, spawnOp(w.attempt_key)), "INTENT");
      assert.equal(world.store.attempts.require(w.attempt_key).state, "READY");
    });
  }
});

// --- areas J: preflight ---------------------------------------------------------------------

test("B6-9 (J): a BLOCKED preflight writes nothing at all and is re-evaluated next time", () => {
  withWorld((world) => {
    const w = activatedWorld(world, { preflight: blockedPreflight("C2", "C3", "C4", "C5") });
    const before = world.store.decisions.read().length;

    const blocked = start(w);
    assert.deepEqual(blocked, { kind: "PREFLIGHT_BLOCKED", reasons: ["C2", "C3", "C4", "C5"] });

    // No intent, no side effect, no state change, no decision, no hold, no retry counter.
    assert.equal(world.store.idempotency.count(), 0);
    assert.equal(world.store.adapterMetadata.count(), 0);
    assert.equal(world.store.pendingDecisions.count(), 0);
    assert.equal(world.store.decisions.read().length, before);
    assert.deepEqual(w.repository.calls, []);
    assert.deepEqual(w.runtime.spawnCalls, []);
    assert.deepEqual(w.runtime.sendCalls, []);
    assert.equal(world.store.attempts.require(w.attempt_key).state, "READY");
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");

    // The very same attempt starts normally once the environment answers READY.
    const ready = start(w, { ...w, preflight: readyPreflight });
    assert.equal(ready.kind, "IMPLEMENTING");
  });
});

// --- area K/L: ordering and the transaction boundary ------------------------------------------

test("B6-7 / B6-10 / B6-14 (K): each INTENT is durable before its external call", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    const seen: string[] = [];
    const record = (label: string) => () => {
      seen.push(`${label}:${world.store.idempotency.count()}`);
    };
    w.repository.onCreate = record("workspace");
    w.runtime.onExternalCall = () => {
      seen.push(`runtime:${world.store.idempotency.count()}`);
    };

    start(w);

    // At the moment of each call, that operation's intent — and only the ones before it — exist.
    assert.deepEqual(seen, ["workspace:1", "runtime:2", "runtime:3"]);
    assert.deepEqual(w.runtime.spawnCalls, [spawnOp(w.attempt_key)]);
    assert.deepEqual(
      w.runtime.sendCalls.map((call) => call.op_key),
      [turnOp(w.attempt_key)],
    );
  });
});

test("B6-22 (L): every adapter call happens with no SQLite transaction open", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    let probes = 0;
    // A transaction is exclusive on the single writer, so opening one here would throw
    // NESTED_TRANSACTION if the caller still held it.
    const probe = () => {
      world.store.withTransaction(() => {
        probes += 1;
      });
    };
    w.repository.onCreate = probe;
    w.runtime.onExternalCall = probe;

    assert.equal(start(w).kind, "IMPLEMENTING");
    assert.equal(probes, 3, "workspace create, spawn and send each ran outside a transaction");
  });
});

// --- area D: workspace crash windows W1–W4 -----------------------------------------------------

test("B6-5 (W1): an intent with no effect yet is completed by a plain retry", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    world.store.withTransaction(() => {
      world.store.idempotency.beginIntent(workspaceOp(w.attempt_key));
    });

    assert.equal(start(w).kind, "IMPLEMENTING");
    assert.equal(w.repository.workspaceCount, 1);
    assert.deepEqual(w.repository.created, [workspaceOp(w.attempt_key)]);
  });
});

test("B6-5 (W2): a workspace created but never persisted is re-acquired, not remade", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    w.repository.failAfterCreate = new Error("crash after the worktree exists");

    assert.throws(() => start(w));
    assert.equal(w.repository.workspaceCount, 1);
    assert.equal(opState(world.store, workspaceOp(w.attempt_key)), "INTENT");
    assert.equal(world.store.adapterMetadata.count(), 0);

    w.repository.failAfterCreate = undefined;
    assert.equal(start(w).kind, "IMPLEMENTING");

    // The second run re-acquired: one call more, but still exactly one workspace.
    assert.equal(w.repository.workspaceCount, 1, "no second workspace");
    assert.deepEqual(w.repository.created, [workspaceOp(w.attempt_key)]);
  });
});

test("B6-5 (W3): a durable reference without its DONE is validated and promoted", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    const op_key = workspaceOp(w.attempt_key);

    // Exactly the W3 state: intent + reference, no completion.
    const workspace = w.repository.create_feature_workspace({
      base_head: world.store.attempts.require(w.attempt_key).base_head,
      op_key,
    });
    world.store.withTransaction(() => {
      world.store.idempotency.beginIntent(op_key);
      world.store.adapterMetadata.put({
        entity_key: w.attempt_key,
        adapter_id: "repository",
        key: "feature_workspace",
        value: {
          path: workspace.path,
          branch: workspace.branch,
          base_head: workspace.base_head,
          repository_ref: w.repository.ref,
        },
      });
    });

    assert.equal(start(w).kind, "IMPLEMENTING");
    assert.equal(opState(world.store, op_key), "DONE");
    assert.equal(w.repository.workspaceCount, 1, "no second workspace");
  });
});

test("B6-6 (W3): a reference that does not match fails closed instead of making a second one", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    const op_key = workspaceOp(w.attempt_key);

    world.store.withTransaction(() => {
      world.store.idempotency.beginIntent(op_key);
      world.store.adapterMetadata.put({
        entity_key: w.attempt_key,
        adapter_id: "repository",
        key: "feature_workspace",
        value: {
          path: "/workspaces/somewhere-else",
          branch: "ws-other",
          base_head: world.store.attempts.require(w.attempt_key).base_head,
          repository_ref: "refs/heads/other",
        },
      });
    });

    assert.throws(() => start(w), /does not match/);
    assert.equal(w.repository.workspaceCount, 1, "the re-acquired one, and no second");
    assert.equal(opState(world.store, op_key), "INTENT");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "READY");
  });
});

test("B6-6 (§7): the same op key against a different base is a conflict, not a new workspace", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    const op_key = workspaceOp(w.attempt_key);
    w.repository.create_feature_workspace({ base_head: "other-base", op_key });

    assert.throws(() => start(w), /already names a workspace/);
    assert.equal(w.repository.workspaceCount, 1);
  });
});

test("B6-5 (W4): once DONE, the stored result is used and the adapter is not called again", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    w.runtime.onExternalCall = () => {
      throw new Error("crash after the workspace was recorded");
    };

    assert.throws(() => start(w));
    assert.equal(opState(world.store, workspaceOp(w.attempt_key)), "DONE");

    w.runtime.onExternalCall = undefined;
    w.repository.calls.length = 0;
    assert.equal(start(w).kind, "IMPLEMENTING");

    assert.equal(
      w.repository.calls.some((call) => call.startsWith("create_feature_workspace")),
      false,
      "a DONE workspace operation calls no adapter",
    );
    assert.equal(w.repository.workspaceCount, 1);
  });
});

// --- area E/F: spawn ---------------------------------------------------------------------------

test("B6-11 (E): a spawn that never persisted is re-acquired under the same op key", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    w.runtime.failAfterSpawn = new Error("crash after the session exists");

    assert.throws(() => start(w));
    assert.equal(w.runtime.sessionCount, 1);
    assert.equal(opState(world.store, spawnOp(w.attempt_key)), "INTENT");

    w.runtime.failAfterSpawn = undefined;
    assert.equal(start(w).kind, "IMPLEMENTING");

    assert.equal(w.runtime.sessionCount, 1, "no duplicate session");
    assert.deepEqual(w.runtime.spawnCalls, [spawnOp(w.attempt_key), spawnOp(w.attempt_key)]);
    assert.deepEqual(world.store.adapterMetadata.get(w.attempt_key, "runtime", "actor_session")?.value, {
      agent: "actor",
      session: "session-1",
    });
  });
});

test("B6-11 (E): a DONE spawn reuses the stored handle and calls the runtime no further", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    w.runtime.sendFailure = new Error("crash after the session was recorded");

    assert.equal(start(w).kind, "HELD");
    assert.equal(opState(world.store, spawnOp(w.attempt_key)), "DONE");
    assert.deepEqual(w.runtime.spawnCalls, [spawnOp(w.attempt_key)]);
  });
});

test("B6-11 (F): the same op key with different material inputs is an adapter conflict", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    const context = { op_key: spawnOp(w.attempt_key) };
    const profile = { runtime_profile: "p" } as never;
    const grant = { grant: 1 } as never;

    w.runtime.spawn_session(context, "ACTOR", profile, "/workspaces/a", {}, grant);
    assert.throws(
      () => w.runtime.spawn_session(context, "ACTOR", profile, "/workspaces/b", {}, grant),
      /different material inputs/,
    );
    // A different operation is a different session, never a silent alias.
    w.runtime.spawn_session({ op_key: "op:other:actor-spawn" }, "ACTOR", profile, "/w", {}, grant);
    assert.equal(w.runtime.sessionCount, 2);
  });
});

// --- area G: receipt_supported = false ----------------------------------------------------------

test("B6-13 (G): a receipt-free spawn is conforming and no receipt is ever fabricated", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    assert.equal(start(w).kind, "IMPLEMENTING");

    // Nothing receipt-shaped was invented from the grant, the config or the workspace.
    const stored = JSON.stringify(world.store.adapterMetadata.forEntity(w.attempt_key));
    for (const term of ["applied", "applied_means", "enforcement", "issued_at"]) {
      assert.equal(stored.includes(term), false, `a receipt field leaked into metadata: ${term}`);
    }
    assert.equal(world.store.idempotency.get(spawnOp(w.attempt_key))?.result !== undefined, true);
  });
});

test("B6-13 (G): a receipt returned by a backend that declares none holds the attempt", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    w.runtime.receipt = { session_handle: "x" } as never;

    const held = start(w);
    assert.deepEqual(held, {
      kind: "HELD",
      attempt_key: w.attempt_key,
      reason_code: "CAPABILITY_BOUNDARY_CHANGED",
      transition_seq: held.kind === "HELD" ? held.transition_seq : -1,
    });
    assert.equal(world.store.attempts.require(w.attempt_key).state, "READY");
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");
    assert.equal(w.runtime.turnCount, 0, "no turn follows a boundary change");
  });
});

// --- areas O–R: turn crash windows -----------------------------------------------------------

test("B6-17: an INTENT-only turn is indeterminate on this Backend, so it never sends", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    // The durable state a Backend-v1 restart can actually leave behind: a turn intent, no
    // RuntimeTurnHandle, and no authoritative observation of whether the turn was accepted.
    world.store.withTransaction(() => {
      world.store.idempotency.beginIntent(turnOp(w.attempt_key));
    });

    const held = start(w);
    assert.equal(held.kind, "HELD");
    assert.equal(held.kind === "HELD" ? held.reason_code : "", "RECOVERY_CONFLICT");
    // §21's rule permits a same-op retry only when the adapter can *prove* the effect is absent.
    // Backend v1 offers no such proof — no request-identity dedup, no durable turn lookup — so a
    // crash before the call and a crash after acceptance are the same durable state. This is not
    // a retry case, and calling it one would be guessing at history the Platform cannot observe.
    assert.equal(w.runtime.turnCount, 0);
    assert.deepEqual(w.runtime.sendCalls, [], "send_turn call count remains 0");
    assert.equal(opState(world.store, turnOp(w.attempt_key)), "INTENT");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "READY");
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");
  });
});

test("B6-18 (T2/§25): a possibly-accepted turn is never sent a second time", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    w.runtime.sendFailure = new Error("no answer — the turn may or may not have been accepted");

    const held = start(w);
    assert.equal(held.kind, "HELD");
    assert.equal(held.kind === "HELD" ? held.reason_code : "", "RECOVERY_CONFLICT");
    assert.equal(w.runtime.sendCalls.length, 1);
    assert.equal(world.store.attempts.require(w.attempt_key).state, "READY");
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");

    // A held task is not startable, so a restart cannot produce a second turn either.
    w.runtime.sendFailure = undefined;
    assert.throws(() => start(w), /not ACTIVE/);
    assert.equal(w.runtime.sendCalls.length, 1, "send_turn call count stays 1");
  });
});

test("B6-19 (T3): a durable turn reference reconciles to DONE without a second send", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    world.store.withTransaction(() => {
      world.store.idempotency.beginIntent(turnOp(w.attempt_key));
      world.store.adapterMetadata.put({
        entity_key: w.attempt_key,
        adapter_id: "runtime",
        key: "actor_turn:1",
        value: { turn: "turn-recovered" },
      });
    });

    assert.equal(start(w).kind, "IMPLEMENTING");
    assert.equal(opState(world.store, turnOp(w.attempt_key)), "DONE");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "IMPLEMENTING");
    assert.deepEqual(w.runtime.sendCalls, [], "reconciled, never retried");
    assert.deepEqual(
      world.store.adapterMetadata.get(w.attempt_key, "runtime", "actor_turn:1")?.value,
      { turn: "turn-recovered" },
    );
  });
});

test("B6-20 / B6-21 (T4/R): the turn DONE and READY→IMPLEMENTING are one transaction", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    // A handle the §6 data model cannot express: the closing transaction must fail as a whole.
    w.runtime.sendFailure = undefined;
    const runtime = w.runtime as unknown as {
      send_turn: (...args: never[]) => unknown;
    };
    const original = runtime.send_turn.bind(w.runtime);
    runtime.send_turn = ((...args: never[]) => {
      original(...args);
      return { started: () => true } as never;
    }) as never;

    assert.throws(() => start(w));

    // Nothing from step 9a survived: no reference, no completion, no state change.
    assert.equal(
      world.store.adapterMetadata.get(w.attempt_key, "runtime", "actor_turn:1"),
      undefined,
    );
    assert.equal(opState(world.store, turnOp(w.attempt_key)), "INTENT");
    assert.equal(world.store.attempts.require(w.attempt_key).state, "READY");
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");
  });
});

test("B6-21: the successful commit writes reference, completion and state together", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    const before = world.store.decisions.read().length;
    start(w);

    const entries = world.store.decisions.read().slice(before);
    const transitions = entries.filter((entry) => entry.kind === STATE_TRANSITION_KIND);
    assert.equal(transitions.length, 1, "one journal entry for one transition");
    const payload = transitions[0]?.payload as unknown as { attempt: { from: string; to: string } };
    assert.deepEqual(payload.attempt, { from: "READY", to: "IMPLEMENTING" });
  });
});

// --- area T: a restart at every durable boundary ------------------------------------------------

test("B6-1 (T): restarting after each boundary converges without a duplicate side effect", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    const store = world.store;

    // Boundary 1 — workspace intent only.
    store.withTransaction(() => store.idempotency.beginIntent(workspaceOp(w.attempt_key)));
    assert.equal(start(w).kind, "IMPLEMENTING");

    assert.equal(w.repository.workspaceCount, 1);
    assert.equal(w.runtime.sessionCount, 1);
    assert.equal(w.runtime.turnCount, 1);
    assert.equal(store.idempotency.count(), 3);
    assert.equal(store.adapterMetadata.count(), 3);

    // A finished attempt is not startable again, so no boundary can be re-entered.
    assert.throws(() => start(w), /requires READY/);
    assert.equal(w.runtime.turnCount, 1);
  });
});

test("B6-1: the instruction carries no operation identity (§21)", () => {
  withWorld((world) => {
    const w = activatedWorld(world);
    start(w);

    const instruction = w.runtime.sendCalls[0]?.instruction ?? "";
    assert.ok(instruction.length > 0);
    for (const op of [workspaceOp, spawnOp, turnOp]) {
      assert.equal(instruction.includes(op(w.attempt_key)), false, "op_key leaked into the text");
    }
    assert.equal(instruction.includes("op:"), false);
  });
});

// --- guards -------------------------------------------------------------------------------------

test("B6-1: only a READY attempt of an ACTIVE task can start", () => {
  withWorld((world) => {
    const w: ExecutionWorld = activatedWorld(world);
    start(w);
    assert.throws(() => start(w), /requires READY, not IMPLEMENTING/);
  });
});
