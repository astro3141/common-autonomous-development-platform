/**
 * B5-S1 ~ B5-S6, B5-A1 ~ B5-A7, B5-C1 ~ B5-C7, B5-SC1 ~ B5-SC6, B5-G1 ~ B5-G8,
 * B5-V1 ~ B5-V5, B5-I1 ~ B5-I7 — selection binding, the activation equality gate, and the atomic
 * `SELECTED → ACTIVE` + `Attempt READY` transition (TD §12.7, §19.3, §19.3a).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { seedAllocationForProposal } from "./support/coordinator-fixtures.ts";

import { activateSelectedTask, type ActivationOutcome } from "../core/admission/activate-task.ts";
import { submitProposal } from "../core/admission/submit-proposal.ts";
import { materializeDiscoveryPass } from "../core/discovery/materialize.ts";
import { CAPABILITY_NAMES } from "../core/schemas/capability-vocabulary.ts";
import { STATE_TRANSITION_KIND } from "../core/statemachine/transition-commit.ts";
import { hashEnvelope } from "../core/schemas/envelope.ts";
import type { ContractSourceInput } from "../core/contract/types.ts";
import type { PlatformStore } from "../core/store/platform-store.ts";
import {
  BATCH_ID,
  discover,
  PROJECT,
  RUN_ID,
  TASK_KEY,
  withWorld,
  world,
  type DomainWorld,
} from "./support/domain-fixtures.ts";
import { selection, task } from "./support/decision-fixtures.ts";
import { normalizeTaskDefinition } from "../core/tasksource/task-definition.ts";
import {
  authoritiesFor,
  manifestSetInput,
  StubRepository,
  StubTaskSource,
  type AdmissionWorld,
} from "./support/admission-fixtures.ts";

const OBSERVED_AT = "2026-08-13T09:00:00Z";
const SNAPSHOT_ID = "01JQ8ZK5T7RC9V2W4X6Y8Z0E01";
const ACTOR_GRANT = "01JQ8ZK5T7RC9V2W4X6Y8Z0E02";
const AUDITOR_GRANT = "01JQ8ZK5T7RC9V2W4X6Y8Z0E03";

const encoder = new TextEncoder();
/** The Project Profile declares exactly `SPEC.md` (decision fixtures). */
const sources = (text = "spec bytes\n"): ContractSourceInput[] => [
  { path: "SPEC.md", bytes: encoder.encode(text) },
];

const admit = (world: DomainWorld, authorities: AdmissionWorld) => {
  seedAllocationForProposal(world.store, BATCH_ID, selection({ profile: world.profile }));
  return submitProposal(authorities, {
    run_id: RUN_ID,
    batch_id: BATCH_ID,
    proposal: selection({ profile: world.profile }),
    observed_at: OBSERVED_AT,
  });
};

const activate = (
  authorities: AdmissionWorld,
  overrides: Partial<{ contract_sources: readonly ContractSourceInput[]; task_key: string }> = {},
): ActivationOutcome =>
  activateSelectedTask(authorities, {
    task_key: overrides.task_key ?? TASK_KEY,
    snapshot_id: SNAPSHOT_ID,
    actor_grant_id: ACTOR_GRANT,
    auditor_grant_id: AUDITOR_GRANT,
    contract_sources: overrides.contract_sources ?? sources(),
  });

/** Everything a stale or incompatible activation must leave at zero. */
const artifacts = (store: PlatformStore) => ({
  attempts: store.attempts.forTask(TASK_KEY).length,
  contracts: store.contracts.count(),
  grants: store.grants.count(),
  pending: store.pendingDecisions.count(),
  outbox: store.outbox.count(),
  metadata: store.adapterMetadata.count(),
  idempotency: store.idempotency.count(),
});

/** A world with one admitted, SELECTED task ready to activate. */
const selected = (
  world: DomainWorld,
  overrides: Parameters<typeof authoritiesFor>[1] = {},
): AdmissionWorld => {
  discover(world);
  const authorities = authoritiesFor(world, overrides);
  const result = admit(world, authorities);
  assert.deepEqual(result.result, { kind: "ACCEPTED" });
  return authorities;
};

// --- B5-S: selection binding ------------------------------------------------------------

test("B5-S1 ~ B5-S3 / B5-S5: admission persists the scope id and the exact 3-field binding", () => {
  withWorld((world) => {
    const authorities = selected(world);
    const row = world.store.tasks.require(TASK_KEY);

    assert.equal(row.repository_scope_id, "collector", "B5-S5");
    assert.deepEqual(Object.keys(row.selection_binding ?? {}).sort(), [
      "base_head",
      "task_definition_hash",
      "task_version",
    ]);
    // B5-S2 — the values are the authoritative facts, not a copy of Proposal.expected.
    assert.deepEqual(row.selection_binding, {
      task_version: task().version,
      task_definition_hash: task().definition_hash,
      base_head: authorities.repository.head,
    });

    // B5-S3 — no Proposal artifact of any kind was created.
    const journal = JSON.stringify(world.store.decisions.read());
    assert.equal(journal.includes("reason_refs"), false);
    assert.equal(journal.includes('"expected"'), false);
  });
});

test("B5-S4: a later discovery pass refreshes the snapshot and never the binding", () => {
  withWorld((world) => {
    const authorities = selected(world);
    const before = world.store.tasks.require(TASK_KEY);

    const source = new StubTaskSource();
    materializeDiscoveryPass(world.store, source, {
      run_id: RUN_ID,
      batch_id: BATCH_ID,
      context: { observed_at: "2026-08-13T20:00:00Z" },
    });
    void authorities;

    const after = world.store.tasks.require(TASK_KEY);
    assert.deepEqual(after.selection_binding, before.selection_binding, "B5-S4");
    assert.equal(after.platform_state, "SELECTED");
  });
});

test("B5-S6: a rejected admission writes neither the scope id nor a binding", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world, { taskSource: new StubTaskSource(task({ version: "9" })) });
    const result = admit(world, authorities);

    assert.equal(result.result.kind, "POLICY_REJECTED");
    const row = world.store.tasks.require(TASK_KEY);
    assert.equal(row.repository_scope_id, null);
    assert.equal(row.selection_binding, null);
    assert.equal(row.platform_state, "DISCOVERED");
  });
});

// --- B5-A: the activation equality gate --------------------------------------------------

test("B5-A1 / B5-I3: matching facts activate the task with one READY attempt", () => {
  withWorld((world) => {
    const authorities = selected(world);
    const outcome = activate(authorities);

    assert.equal(outcome.kind, "ACTIVATED");
    const row = world.store.tasks.require(TASK_KEY);
    assert.equal(row.platform_state, "ACTIVE");

    const attempts = world.store.attempts.forTask(TASK_KEY);
    assert.equal(attempts.length, 1);
    const attempt = attempts[0];
    assert.equal(attempt?.state, "READY");
    assert.equal(attempt?.n, 1);
    assert.equal(attempt?.candidate_commit, null);
    assert.equal(attempt?.rework_count, 0);
    assert.equal(attempt?.base_head, row.selection_binding?.base_head);
    assert.equal(attempt?.state_reason, null);
    assert.equal(attempt?.attempt_key, `attempt:${TASK_KEY}:1`);
  });
});

const mismatches: ReadonlyArray<readonly [string, (world: DomainWorld, a: AdmissionWorld) => void, string]> = [
  [
    "B5-A2: version drift",
    (_world, a) => {
      a.taskSource.definition = task({ version: "2" });
    },
    "task_version",
  ],
  [
    "B5-A3: definition hash drift",
    (_world, a) => {
      // Same version, different body — so the recomputed hash moves while `version` does not.
      a.taskSource.definition = normalizeTaskDefinition({
        task_ref: "T-101",
        version: task().version,
        body: { ...task().body, description: "Rewritten scope." },
      });
    },
    "task_definition_hash",
  ],
  [
    "B5-A4: canonical drift",
    (_world, a) => {
      a.repository.head = "head-canonical-later";
    },
    "base_head",
  ],
];

for (const [label, drift, failed] of mismatches) {
  test(`${label} → HELD(SELECTION_STALE) with zero artifacts (B5-A5 ~ B5-A7)`, () => {
    withWorld((world) => {
      const authorities = selected(world);
      const before = artifacts(world.store);
      const binding = world.store.tasks.require(TASK_KEY).selection_binding;
      drift(world, authorities);

      const outcome = activate(authorities);

      assert.equal(outcome.kind, "SELECTION_STALE");
      if (outcome.kind === "SELECTION_STALE") assert.equal(outcome.mismatch.failed, failed);

      const row = world.store.tasks.require(TASK_KEY);
      assert.equal(row.platform_state, "HELD");
      assert.equal(row.state_reason?.code, "SELECTION_STALE");
      // The selection provenance survives — the task is still the same admitted task.
      assert.deepEqual(row.selection_binding, binding);
      assert.equal(row.repository_scope_id, "collector");
      assert.notEqual(row.admitted_at, null);

      // B5-A6 / B5-A7 — nothing was built, and no human was asked.
      assert.deepEqual(artifacts(world.store), before);
      assert.equal(world.store.blobs.get(`sha256:${"0".repeat(64)}`), undefined);

      // B5-A5 — the fresh canonical was not silently adopted as a new base.
      assert.notEqual(row.selection_binding?.base_head, "head-canonical-later");

      // The journal explains the mismatch in generic terms.
      const entry = world.store.decisions
        .read()
        .filter((e) => e.kind === STATE_TRANSITION_KIND)
        .at(-1);
      const payload = entry?.payload as { mismatch?: Record<string, unknown> };
      assert.equal(payload.mismatch?.["failed"], failed);
    });
  });
}

test("B5-A1: activation requires a SELECTED task carrying a binding", () => {
  withWorld((world) => {
    discover(world);
    const authorities = authoritiesFor(world);
    // DISCOVERED: no binding, no scope id.
    assert.throws(() => activate(authorities));
    assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "DISCOVERED");
    assert.deepEqual(artifacts(world.store), {
      attempts: 0,
      contracts: 0,
      grants: 0,
      pending: 0,
      outbox: 0,
      metadata: 0,
      idempotency: 0,
    });
  });
});

// --- B5-SC / B5-C / B5-G: what the contract froze ----------------------------------------

test("B5-SC1 ~ B5-SC6 / B5-C1 / B5-C5 ~ B5-C7 / B5-G1 ~ B5-G8: the frozen contract is exact", () => {
  withWorld((world) => {
    const authorities = selected(world);
    activate(authorities);

    const attempt = world.store.attempts.require(`attempt:${TASK_KEY}:1`);
    const snapshot = world.store.contracts.get(attempt.contract_snapshot_id);
    const body = snapshot?.body as Record<string, unknown>;

    // Exact v1 top-level body — M1-6/M1-7 added no Contract field.
    assert.deepEqual(Object.keys(body).sort(), [
      "attempt",
      "backend_requirements",
      "base_head",
      "capability_grants",
      "compiled_profile_hash",
      "completion_conditions",
      "contract_sources",
      "pipeline_id",
      "repository_scope",
      "snapshot_id",
      "task",
      "verification_profile",
    ]);
    assert.equal("repository_scope_id" in body, false, "B5-SC6");

    // B5-SC1 / B5-SC2 / B5-SC5 — the resolved body of the declared scope, from the batch profile.
    assert.deepEqual(body["repository_scope"], {
      allowed_paths: ["src", "docs"],
      forbidden_paths: ["src/vendor"],
    });
    assert.equal(body["compiled_profile_hash"], world.profile.compiled_hash);

    // Task identity and completion conditions come from the one fresh observation.
    assert.deepEqual(body["task"], {
      ref: "T-101",
      version: task().version,
      definition_hash: task().definition_hash,
      body_copy: task().body,
    });
    assert.deepEqual(body["completion_conditions"], [...task().body.acceptance_notes]);
    assert.equal(body["base_head"], world.store.tasks.require(TASK_KEY).selection_binding?.base_head);
    assert.equal(body["attempt"], 1);
    assert.equal(body["pipeline_id"], "standard");
    assert.equal(body["verification_profile"], "full");

    // B5-C1 / B5-C5 — declared sources, in Project Profile order, addressed by raw hash.
    const contractSources = body["contract_sources"] as { path: string; content_hash: string }[];
    assert.deepEqual(
      contractSources.map((entry) => entry.path),
      ["SPEC.md"],
    );
    // B5-C7 — the blob reloads byte-identical.
    assert.deepEqual(
      world.store.blobs.get(contractSources[0]?.content_hash as string),
      encoder.encode("spec bytes\n"),
    );

    // B5-G1 ~ B5-G8 — exactly two attempt grants, both complete, neither a Supervisor grant.
    const grantRefs = body["capability_grants"] as Record<string, { grant_id: string }>;
    const grants = ["actor", "auditor"].map((role) => {
      const id = grantRefs[role]?.grant_id as string;
      return { meta: world.store.grants.meta(id), envelope: world.store.grants.get(id) };
    });
    assert.equal(grants.length, 2, "B5-G1");
    assert.deepEqual(grants.map((grant) => grant.meta?.role).sort(), ["ACTOR", "AUDITOR"], "B5-G2");
    const runtimeHash = hashEnvelope(authorities.manifests.runtime as never);
    for (const grant of grants) {
      const grantBody = grant.envelope?.body as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(grantBody["requested"] as object).sort(),
        [...CAPABILITY_NAMES].sort(),
        "B5-G3",
      );
      assert.deepEqual(
        Object.keys(grantBody["enforcement"] as object).sort(),
        [...CAPABILITY_NAMES].sort(),
        "B5-G4",
      );
      assert.equal(grantBody["source_runtime_manifest_hash"], runtimeHash, "B5-G5");
      assert.equal("backend_application" in grantBody, false, "B5-G8");
      assert.match(grant.meta?.grant_hash ?? "", /^sha256:[0-9a-f]{64}$/, "B5-G6");
    }

    // B5-G7 — the two roles do not request the same capabilities.
    const requested = grants.map((grant) =>
      JSON.stringify((grant.envelope?.body as Record<string, unknown>)["requested"]),
    );
    assert.notEqual(requested[0], requested[1]);

    // The contract body names both grants, and nothing else.
    assert.deepEqual(Object.keys(body["capability_grants"] as object).sort(), ["actor", "auditor"]);
  });
});

test("B5-C2 ~ B5-C4 / B5-C6: contract sources must match the declaration exactly", () => {
  const cases: ReadonlyArray<readonly [string, ContractSourceInput[]]> = [
    ["B5-C2 missing", []],
    ["B5-C3 extra", [...sources(), { path: "EXTRA.md", bytes: encoder.encode("x") }]],
    ["B5-C4 wrong path", [{ path: "OTHER.md", bytes: encoder.encode("x") }]],
  ];
  for (const [label, contract_sources] of cases) {
    withWorld((world) => {
      const authorities = selected(world);
      const before = artifacts(world.store);
      assert.throws(() => activate(authorities, { contract_sources }), label);

      // TD §19.3/§24 — the inputs were authoritative; the contract could not be built, so the
      // task is terminal with a journal-bound reason, and nothing partial survived.
      assert.deepEqual(artifacts(world.store), before, `${label}: nothing partial survived`);
      const row = world.store.tasks.require(TASK_KEY);
      assert.equal(row.platform_state, "FAILED", label);
      assert.equal(row.state_reason?.code, "CONTRACT_BUILD_ERROR", label);
      assert.equal(typeof row.state_reason?.log_seq, "number");
      // Selection provenance is kept as the record of what was attempted.
      assert.notEqual(row.selection_binding, null);
      assert.equal(row.repository_scope_id, "collector");
    });
  }

  // B5-C6 — a newline change is a different content hash; bytes are never normalized.
  const hashes: string[] = [];
  for (const text of ["spec bytes\n", "spec bytes\r\n", "spec bytes"]) {
    withWorld((world) => {
      const authorities = selected(world);
      activate(authorities, { contract_sources: sources(text) });
      const attempt = world.store.attempts.require(`attempt:${TASK_KEY}:1`);
      const snapshot = world.store.contracts.get(attempt.contract_snapshot_id);
      const body = snapshot?.body as Record<string, unknown>;
      hashes.push((body["contract_sources"] as { content_hash: string }[])[0]?.content_hash ?? "");
    });
  }
  assert.equal(new Set(hashes).size, 3, "B5-C6");
});

// --- B5-V: activation-time V10 recheck ----------------------------------------------------

const REQUIRES_ENFORCED = {
  capability_requirements: {
    actor_execution: { "repository.feature_write": { accepted: ["ENFORCED"] } },
    auditor_execution: { "repository.read": { accepted: ["ENFORCED"] } },
  },
};

test("B5-V1: adequate manifests activate under the same requirements", () => {
  withWorld(
    (world) => {
      const authorities = selected(world);
      assert.equal(activate(authorities).kind, "ACTIVATED");
      assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "ACTIVE");
    },
    REQUIRES_ENFORCED,
  );
});

test("B5-V2 ~ B5-V5: a Backend that weakened after selection holds the task", () => {
  for (const [label, weakened] of [
    ["B5-V2 actor", { "repository.feature_write": { allow: "NOT_YET_AUDITED" as const } }],
    ["B5-V3 auditor", { "repository.read": { allow: "NOT_YET_AUDITED" as const } }],
  ] as const) {
    withWorld(
      (world) => {
        // B5-V5 — selection passed V10 against adequate manifests …
        const authorities = selected(world);
        const before = artifacts(world.store);

        // … and the Backend weakens before activation.
        const outcome = activateSelectedTask(
          { ...authorities, manifests: manifestSetInput(weakened) },
          {
            task_key: TASK_KEY,
            snapshot_id: SNAPSHOT_ID,
            actor_grant_id: ACTOR_GRANT,
            auditor_grant_id: AUDITOR_GRANT,
            contract_sources: sources(),
          },
        );

        assert.equal(outcome.kind, "BACKEND_INCOMPATIBLE", label);
        // B5-V4 — nothing was built …
        assert.deepEqual(artifacts(world.store), before);
        // … and TD §19.3 holds the task rather than failing it: a Backend condition can change
        // back, so the task stays resumable, but it is no longer activatable as-is.
        const row = world.store.tasks.require(TASK_KEY);
        assert.equal(row.platform_state, "HELD");
        assert.equal(row.state_reason?.code, "POLICY_BACKEND_INCOMPATIBLE");
        assert.equal(typeof row.state_reason?.log_seq, "number");
        assert.notEqual(row.selection_binding, null);
        assert.notEqual(row.admitted_at, null);

        // Restoring the manifests does not silently re-open activation — the hold is durable.
        assert.throws(() => activate(authorities));
        assert.equal(world.store.tasks.require(TASK_KEY).platform_state, "HELD");
      },
      REQUIRES_ENFORCED,
    );
  }
});

// --- B5-I: restart and duplicate activation -----------------------------------------------

test("B5-I1 / B5-I2 / B5-I3: SELECTED and ACTIVE both survive a reopen", () => {
  const owner = world();
  try {
    const authorities = selected(owner);
    const binding = owner.store.tasks.require(TASK_KEY).selection_binding;
    owner.store.close();

    // B5-I1 — the binding is durable, with no Proposal anywhere in memory.
    const reopened = owner.temp.open();
    assert.equal(reopened.schemaVersion, 8);
    assert.deepEqual(reopened.tasks.require(TASK_KEY).selection_binding, binding);

    // B5-I2 — activation resumes from durable state alone.
    const outcome = activateSelectedTask(
      { ...authorities, store: reopened },
      {
        task_key: TASK_KEY,
        snapshot_id: SNAPSHOT_ID,
        actor_grant_id: ACTOR_GRANT,
        auditor_grant_id: AUDITOR_GRANT,
        contract_sources: sources(),
      },
    );
    assert.equal(outcome.kind, "ACTIVATED");
    reopened.close();

    // B5-I3 — the activated graph survives another reopen.
    const again = owner.temp.open();
    try {
      assert.equal(again.tasks.require(TASK_KEY).platform_state, "ACTIVE");
      assert.equal(again.attempts.require(`attempt:${TASK_KEY}:1`).state, "READY");
      assert.equal(again.contracts.count(), 1);
      assert.equal(again.grants.count(), 2);
    } finally {
      again.close();
    }
  } finally {
    owner.temp.dispose();
  }
});

test("B5-I4 ~ B5-I6: a second activation cannot duplicate the attempt, contract or grants", () => {
  withWorld((world) => {
    const authorities = selected(world);
    assert.equal(activate(authorities).kind, "ACTIVATED");
    const after = artifacts(world.store);

    assert.throws(() => activate(authorities), /ACTIVE|attempt/);
    assert.deepEqual(artifacts(world.store), after);
    assert.equal(world.store.attempts.forTask(TASK_KEY).length, 1);
    assert.equal(world.store.contracts.count(), 1);
    assert.equal(world.store.grants.count(), 2);
  });
});

test("B5-I7: a drift discovered only after a reopen still lands on SELECTION_STALE", () => {
  const owner = world();
  try {
    const authorities = selected(owner);
    owner.store.close();

    const reopened = owner.temp.open();
    const source = new StubTaskSource(task({ version: "7" }));
    const outcome = activateSelectedTask(
      { ...authorities, store: reopened, taskSource: source },
      {
        task_key: TASK_KEY,
        snapshot_id: SNAPSHOT_ID,
        actor_grant_id: ACTOR_GRANT,
        auditor_grant_id: AUDITOR_GRANT,
        contract_sources: sources(),
      },
    );
    assert.equal(outcome.kind, "SELECTION_STALE");
    assert.equal(reopened.tasks.require(TASK_KEY).state_reason?.code, "SELECTION_STALE");
    assert.equal(reopened.attempts.forTask(TASK_KEY).length, 0);
    reopened.close();
  } finally {
    owner.temp.dispose();
  }
});

// --- what activation must not touch ---------------------------------------------------------

test("B5-AC46 ~ B5-AC51: activation performs no workspace, Runtime, Workflow or metadata work", () => {
  withWorld((world) => {
    const repository = new StubRepository();
    const authorities = selected(world, { repository });
    activate(authorities);

    // The only repository primitive activation may use is the canonical fact read.
    assert.deepEqual(repository.calls, ["snapshot_canonical", "snapshot_canonical"]);
    assert.equal(world.store.adapterMetadata.count(), 0);
    assert.equal(world.store.idempotency.count(), 0);
    assert.equal(world.store.verificationEvidence.count(), 0);
    assert.equal(world.store.auditRecords.count(), 0);
    assert.equal(world.store.pendingDecisions.count(), 0);
    assert.equal(world.store.outbox.count(), 0);
  });
});

test("B5-AC43: the activation transition is one journal entry and one atomic graph", () => {
  withWorld((world) => {
    const authorities = selected(world);
    const before = world.store.decisions.count();
    const outcome = activate(authorities);

    assert.equal(world.store.decisions.count(), before + 1, "one transition entry");
    const entry = world.store.decisions.read().at(-1);
    assert.equal(entry?.kind, STATE_TRANSITION_KIND);
    const payload = entry?.payload as Record<string, unknown>;
    assert.deepEqual(payload["task"], { from: "SELECTED", to: "ACTIVE" });
    assert.deepEqual(payload["attempt"], { from: "-", to: "READY" });
    if (outcome.kind === "ACTIVATED") assert.equal(entry?.seq, outcome.transition_seq);

    // Every reference in the committed graph resolves.
    const attempt = world.store.attempts.require(`attempt:${TASK_KEY}:1`);
    const snapshot = world.store.contracts.get(attempt.contract_snapshot_id);
    const body = snapshot?.body as Record<string, unknown>;
    const refs = body["capability_grants"] as Record<string, { grant_id: string }>;
    for (const role of ["actor", "auditor"] as const) {
      assert.notEqual(world.store.grants.get(refs[role]?.grant_id as string), undefined);
    }
    assert.equal(world.store.tasks.require(TASK_KEY).project_id, PROJECT);
  });
});
