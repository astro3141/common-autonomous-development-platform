/**
 * FC1 ~ FC6 — the two activation failure transitions (TD §19.3, §24).
 *
 * Three activation failures are deliberately distinct states, and this file pins each to its own
 * owner: a stale selection holds with `SELECTION_STALE`, an incompatible Backend holds with
 * `POLICY_BACKEND_INCOMPATIBLE`, and a contract that cannot be built fails with
 * `CONTRACT_BUILD_ERROR`. None of them may leave an execution artifact behind.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { seedAllocationForProposal } from "./support/coordinator-fixtures.ts";

import { activateSelectedTask } from "../core/admission/activate-task.ts";
import { submitProposal } from "../core/admission/submit-proposal.ts";
import { STATE_TRANSITION_KIND } from "../core/statemachine/transition-commit.ts";
import { TRANSITION_REASON_CODES } from "../core/statemachine/types.ts";
import { MIGRATIONS } from "../core/store/migrations.ts";
import type { ContractSourceInput } from "../core/contract/types.ts";
import type { PlatformStore } from "../core/store/platform-store.ts";
import {
  BATCH_ID,
  discover,
  RUN_ID,
  TASK_KEY,
  withWorld,
  world,
  type DomainWorld,
} from "./support/domain-fixtures.ts";
import { selection, task } from "./support/decision-fixtures.ts";
import {
  authoritiesFor,
  manifestSetInput,
  StubTaskSource,
  type AdmissionWorld,
} from "./support/admission-fixtures.ts";

const OBSERVED_AT = "2026-08-14T09:00:00Z";
const IDS = {
  snapshot_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0G01",
  actor_grant_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0G02",
  auditor_grant_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0G03",
} as const;

const encoder = new TextEncoder();
const sources = (): ContractSourceInput[] => [
  { path: "SPEC.md", bytes: encoder.encode("spec bytes\n") },
];

/** Every durable artifact an activation could create. */
const artifacts = (store: PlatformStore) => ({
  attempts: store.attempts.forTask(TASK_KEY).length,
  contracts: store.contracts.count(),
  grants: store.grants.count(),
  metadata: store.adapterMetadata.count(),
  evidence: store.verificationEvidence.count(),
  audits: store.auditRecords.count(),
  idempotency: store.idempotency.count(),
  pending: store.pendingDecisions.count(),
  outbox: store.outbox.count(),
});

const selected = (
  domain: DomainWorld,
  overrides: Parameters<typeof authoritiesFor>[1] = {},
): AdmissionWorld => {
  discover(domain);
  const authorities = authoritiesFor(domain, overrides);
  seedAllocationForProposal(domain.store, BATCH_ID, selection({ profile: domain.profile }));
  const result = submitProposal(authorities, {
    run_id: RUN_ID,
    batch_id: BATCH_ID,
    proposal: selection({ profile: domain.profile }),
    observed_at: OBSERVED_AT,
  });
  assert.deepEqual(result.result, { kind: "ACCEPTED" });
  return authorities;
};

const activate = (
  authorities: AdmissionWorld,
  contract_sources: readonly ContractSourceInput[] = sources(),
) => activateSelectedTask(authorities, { task_key: TASK_KEY, ...IDS, contract_sources });

/** FC3 — a reason is only real if the journal entry it points at says the same thing. */
const assertReasonBoundToJournal = (
  store: PlatformStore,
  expected: string,
  expectedTo: "FAILED" | "HELD",
): void => {
  const row = store.tasks.require(TASK_KEY);
  assert.equal(row.state_reason?.code, expected);
  assert.equal(typeof row.state_reason?.log_seq, "number");
  assert.equal(TRANSITION_REASON_CODES.includes(expected as never), true, "reason is Core-fixed");

  const entry = store.decisions.read().find((row2) => row2.seq === row.state_reason?.log_seq);
  assert.notEqual(entry, undefined, "state_reason_log_seq resolves to a journal entry");
  assert.equal(entry?.kind, STATE_TRANSITION_KIND);
  const payload = entry?.payload as Record<string, unknown>;
  assert.equal(payload["reason_code"], expected);
  assert.deepEqual(payload["task"], { from: "SELECTED", to: expectedTo });
  assert.equal(payload["primary_entity_key"], TASK_KEY);
};

// --- FC1: contract build failure -------------------------------------------------------

const buildFailures: ReadonlyArray<readonly [string, ContractSourceInput[]]> = [
  ["F1 missing declared source", []],
  ["F2 extra source", [...sources(), { path: "EXTRA.md", bytes: encoder.encode("x") }]],
  ["F3 wrong path", [{ path: "OTHER.md", bytes: encoder.encode("x") }]],
  ["F4 malformed source bytes", [{ path: "SPEC.md", bytes: "not bytes" as never }]],
];

for (const [label, contract_sources] of buildFailures) {
  test(`FC1 / ${label}: the task fails with CONTRACT_BUILD_ERROR and no artifacts`, () => {
    withWorld((domain) => {
      const authorities = selected(domain);
      const before = artifacts(domain.store);
      const binding = domain.store.tasks.require(TASK_KEY).selection_binding;

      assert.throws(() => activate(authorities, contract_sources), label);

      const row = domain.store.tasks.require(TASK_KEY);
      assert.equal(row.platform_state, "FAILED", label);
      assertReasonBoundToJournal(domain.store, "CONTRACT_BUILD_ERROR", "FAILED");

      // FC4 — the activation transaction rolled back first; only the failure transition remains.
      assert.deepEqual(artifacts(domain.store), before, label);
      // Selection provenance survives as the record of what was attempted.
      assert.deepEqual(row.selection_binding, binding);
      assert.equal(row.repository_scope_id, "collector");
      assert.notEqual(row.admitted_at, null);
    });
  });
}

test("FC1: a failed task is terminal — activation cannot be retried in place", () => {
  withWorld((domain) => {
    const authorities = selected(domain);
    assert.throws(() => activate(authorities, []));
    assert.equal(domain.store.tasks.require(TASK_KEY).platform_state, "FAILED");

    // Even with correct sources, the task is no longer activatable.
    assert.throws(() => activate(authorities));
    assert.equal(domain.store.tasks.require(TASK_KEY).platform_state, "FAILED");
    assert.equal(domain.store.attempts.forTask(TASK_KEY).length, 0);
  });
});

// --- FC2: activation-time backend incompatibility ---------------------------------------

const REQUIRES_ENFORCED = {
  capability_requirements: {
    actor_execution: { "repository.feature_write": { accepted: ["ENFORCED"] } },
    auditor_execution: { "repository.read": { accepted: ["ENFORCED"] } },
  },
};

const weakened = [
  ["F5 actor", { "repository.feature_write": { allow: "NOT_YET_AUDITED" as const } }],
  ["F6 auditor", { "repository.read": { allow: "NOT_YET_AUDITED" as const } }],
] as const;

for (const [label, override] of weakened) {
  test(`FC2 / ${label}: the task is held with POLICY_BACKEND_INCOMPATIBLE`, () => {
    withWorld(
      (domain) => {
        const authorities = selected(domain);
        const before = artifacts(domain.store);
        const binding = domain.store.tasks.require(TASK_KEY).selection_binding;

        const outcome = activateSelectedTask(
          { ...authorities, manifests: manifestSetInput(override) },
          { task_key: TASK_KEY, ...IDS, contract_sources: sources() },
        );

        // FC2 / §11 — the public result kind is unchanged; the durable state is the TD's.
        assert.equal(outcome.kind, "BACKEND_INCOMPATIBLE", label);
        const row = domain.store.tasks.require(TASK_KEY);
        assert.equal(row.platform_state, "HELD", label);
        assertReasonBoundToJournal(domain.store, "POLICY_BACKEND_INCOMPATIBLE", "HELD");

        // FC4
        assert.deepEqual(artifacts(domain.store), before, label);
        assert.deepEqual(row.selection_binding, binding);
        assert.notEqual(row.admitted_at, null);
      },
      REQUIRES_ENFORCED,
    );
  });
}

test("FC2 / §10: the hold is durable — no retry, no decision, no reselection path", () => {
  withWorld(
    (domain) => {
      const authorities = selected(domain);
      activateSelectedTask(
        { ...authorities, manifests: manifestSetInput(weakened[0][1]) },
        { task_key: TASK_KEY, ...IDS, contract_sources: sources() },
      );
      assert.equal(domain.store.tasks.require(TASK_KEY).platform_state, "HELD");

      // No human was asked and nothing was queued (§10).
      assert.equal(domain.store.pendingDecisions.count(), 0);
      assert.equal(domain.store.outbox.count(), 0);

      // §18 — a backend hold is not a SELECTION_STALE hold, so START_TASK does not reselect it.
      assert.throws(() =>
        submitProposal(authorities, {
          run_id: RUN_ID,
          batch_id: BATCH_ID,
          proposal: selection({ profile: domain.profile }),
          observed_at: OBSERVED_AT,
        }),
      );
      const row = domain.store.tasks.require(TASK_KEY);
      assert.equal(row.platform_state, "HELD");
      assert.equal(row.state_reason?.code, "POLICY_BACKEND_INCOMPATIBLE");
    },
    REQUIRES_ENFORCED,
  );
});

// --- FC3 boundary: the three failures stay distinct ---------------------------------------

test("FC3 / §5: stale, incompatible and unbuildable are three different durable states", () => {
  const reasons: string[] = [];

  withWorld((domain) => {
    const authorities = selected(domain);
    authorities.taskSource.definition = task({ version: "2" });
    assert.equal(activate(authorities).kind, "SELECTION_STALE");
    reasons.push(domain.store.tasks.require(TASK_KEY).state_reason?.code as string);
    assert.equal(domain.store.tasks.require(TASK_KEY).platform_state, "HELD");
  });

  withWorld(
    (domain) => {
      const authorities = selected(domain);
      activateSelectedTask(
        { ...authorities, manifests: manifestSetInput(weakened[0][1]) },
        { task_key: TASK_KEY, ...IDS, contract_sources: sources() },
      );
      reasons.push(domain.store.tasks.require(TASK_KEY).state_reason?.code as string);
    },
    REQUIRES_ENFORCED,
  );

  withWorld((domain) => {
    const authorities = selected(domain);
    assert.throws(() => activate(authorities, []));
    reasons.push(domain.store.tasks.require(TASK_KEY).state_reason?.code as string);
  });

  assert.deepEqual(reasons, [
    "SELECTION_STALE",
    "POLICY_BACKEND_INCOMPATIBLE",
    "CONTRACT_BUILD_ERROR",
  ]);
});

test("§6: a TaskSource read failure stays operational and never becomes CONTRACT_BUILD_ERROR", () => {
  withWorld((domain) => {
    const authorities = selected(domain);
    const failure = new Error("the source process died");
    authorities.taskSource.failure = failure;

    assert.throws(() => activate(authorities), (error: unknown) => error === failure);

    // The comparison never ran, so the task is untouched — not failed, not held.
    const row = domain.store.tasks.require(TASK_KEY);
    assert.equal(row.platform_state, "SELECTED");
    assert.equal(row.state_reason, null);
  });
});

// --- FC5 / FC6: schema and the success path ------------------------------------------------

test("FC5 / FC6: the schema and the success path are unchanged by this patch", () => {
  withWorld((domain) => {
    assert.equal(domain.store.schemaVersion, 9, "FC5");
    assert.equal(MIGRATIONS.length, 9);

    const authorities = selected(domain);
    const outcome = activate(authorities);

    assert.equal(outcome.kind, "ACTIVATED", "FC6");
    const row = domain.store.tasks.require(TASK_KEY);
    assert.equal(row.platform_state, "ACTIVE");
    assert.equal(row.state_reason, null, "a successful activation carries no reason");
    assert.equal(domain.store.attempts.require(`attempt:${TASK_KEY}:1`).state, "READY");
    assert.equal(domain.store.contracts.count(), 1);
    assert.equal(domain.store.grants.count(), 2);
  });
});

// --- restart ---------------------------------------------------------------------------------

test("§22: both failure states survive a reopen and stay unactivatable", () => {
  for (const [label, drive] of [
    [
      "FAILED",
      (authorities: AdmissionWorld) => {
        assert.throws(() => activate(authorities, []));
      },
    ],
    [
      "HELD",
      (authorities: AdmissionWorld) => {
        activateSelectedTask(
          { ...authorities, manifests: manifestSetInput(weakened[0][1]) },
          { task_key: TASK_KEY, ...IDS, contract_sources: sources() },
        );
      },
    ],
  ] as const) {
    const owner = world(label === "HELD" ? REQUIRES_ENFORCED : {});
    try {
      const authorities = selected(owner);
      drive(authorities);
      const before = owner.store.tasks.require(TASK_KEY);
      owner.store.close();

      const reopened = owner.temp.open();
      try {
        const row = reopened.tasks.require(TASK_KEY);
        assert.equal(row.platform_state, before.platform_state, label);
        assert.deepEqual(row.state_reason, before.state_reason, label);
        assert.equal(reopened.attempts.forTask(TASK_KEY).length, 0);

        // A second activation attempt cannot bypass the durable state.
        assert.throws(() =>
          activateSelectedTask(
            { ...authorities, store: reopened },
            { task_key: TASK_KEY, ...IDS, contract_sources: sources() },
          ),
        );
        assert.equal(reopened.tasks.require(TASK_KEY).platform_state, before.platform_state);
        assert.equal(reopened.contracts.count(), 0);
        assert.equal(reopened.grants.count(), 0);
      } finally {
        reopened.close();
      }
    } finally {
      owner.temp.dispose();
    }
  }
});
