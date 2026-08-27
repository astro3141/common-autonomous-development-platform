/**
 * M1B1-AC10 ~ M1B1-AC24 — the three MVP 1 artifact stores (TD §18.1c): a mutable metadata
 * projection, and two immutable artifact tables.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { StoreError } from "../core/store/errors.ts";
import { isSecretBearingKey } from "../core/store/restricted-key-denylist.ts";
import type {
  AuditorVerdictV1,
  VerificationEvidenceV1,
} from "../core/store/mvp1-artifact-stores.ts";
import type { DomainWorld } from "./support/domain-fixtures.ts";
import {
  BINDING,
  RUN_ID,
  SCOPE_ID,
  SELECTION,
  contractBuild,
  discover,
  snapshotId,
  withWorld,
  world,
} from "./support/domain-fixtures.ts";
import { HEAD } from "./support/decision-fixtures.ts";
import {
  commitAdmission,
  commitContractActivation,
} from "../core/statemachine/transition-commit.ts";

const CONTRACT_HASH = `sha256:${"a".repeat(64)}`;
const DIGEST = `sha256:${"b".repeat(64)}`;

const ULIDS = {
  e1: "01JQ8ZK5T7RC9V2W4X6Y8Z0E01",
  e2: "01JQ8ZK5T7RC9V2W4X6Y8Z0E02",
  e3: "01JQ8ZK5T7RC9V2W4X6Y8Z0E03",
  a1: "01JQ8ZK5T7RC9V2W4X6Y8Z0F01",
  a2: "01JQ8ZK5T7RC9V2W4X6Y8Z0F02",
} as const;

const storeError = (code: string) => (error: unknown) =>
  error instanceof StoreError && error.code === code;

/** Admits and activates a task so evidence/audit rows have a real attempt to hang off. */
function attemptOf(world: DomainWorld, ref = "T-101"): string {
  const key = discover(world, ref);
  commitAdmission(world.store, { task_key: key, selection: SELECTION, repository_scope_id: SCOPE_ID, selection_binding: BINDING, admitted_at: "t-admit", hard_dependencies_clear: true, });
  commitContractActivation(world.store, {
    task_key: key,
    attempt_key: `attempt:${key}:1`,
    n: 1,
    build: contractBuild(world, { task_ref: ref, snapshot_id: snapshotId(0) }),
  });
  return `attempt:${key}:1`;
}

const evidence = (overrides: Partial<VerificationEvidenceV1> = {}): VerificationEvidenceV1 => ({
  evidence_id: ULIDS.e1,
  check_id: "unit",
  result: "PASS",
  assurance_level: "REEXECUTED",
  target_commit: "candidate-1",
  task_contract_hash: CONTRACT_HASH,
  executor_identity: "platform-verifier@host",
  timestamp: "2026-08-09T10:00:00Z",
  ...overrides,
});

/** A complete, valid `platform-auditor-verdict-v1` (TD §16.2). */
const verdict = (overrides: Partial<AuditorVerdictV1> = {}): AuditorVerdictV1 => ({
  verdict: "AUDIT_PASS",
  findings: [],
  reviewed: {
    candidate_commit: "candidate-1",
    task_contract_hash: CONTRACT_HASH,
    evidence_ids: [ULIDS.e1],
  },
  ...overrides,
});

// --- adapter_metadata --------------------------------------------------------------------

test("AM1 / AM5 / M1B1-AC10: metadata round-trips through constrained JSON", () => {
  withWorld((world) => {
    const value = { handle: "opaque-handle-1", attempts: 2, active: true, tags: ["a", "b"] };
    world.store.withTransaction(() =>
      world.store.adapterMetadata.put({
        entity_key: RUN_ID,
        adapter_id: "example-runtime",
        key: "supervisor_session",
        value,
      }),
    );

    const stored = world.store.adapterMetadata.get(RUN_ID, "example-runtime", "supervisor_session");
    assert.deepEqual(stored?.value, value);
    assert.deepEqual(Object.keys(stored ?? {}).sort(), ["adapter_id", "entity_key", "key", "value"]);
  });
});

test("AM2 / M1B1-AC11: the same key is a current projection, not an immutable artifact", () => {
  withWorld((world) => {
    const write = (value: unknown): void => {
      world.store.withTransaction(() =>
        world.store.adapterMetadata.put({
          entity_key: RUN_ID,
          adapter_id: "example-runtime",
          key: "supervisor_session",
          value: value as never,
        }),
      );
    };

    write({ handle: "opaque-1" });
    write({ handle: "opaque-2" });

    assert.deepEqual(
      world.store.adapterMetadata.get(RUN_ID, "example-runtime", "supervisor_session")?.value,
      { handle: "opaque-2" },
      "a newer current value simply replaces the older one",
    );
    assert.equal(world.store.adapterMetadata.count(), 1, "no history row is kept");
  });
});

test("AM3 / AM4: entities and adapter namespaces stay isolated", () => {
  withWorld((world) => {
    const attemptKey = attemptOf(world);
    world.store.withTransaction(() => {
      world.store.adapterMetadata.put({
        entity_key: RUN_ID,
        adapter_id: "example-runtime",
        key: "handle",
        value: "run-scoped",
      });
      world.store.adapterMetadata.put({
        entity_key: attemptKey,
        adapter_id: "example-runtime",
        key: "handle",
        value: "attempt-scoped",
      });
      world.store.adapterMetadata.put({
        entity_key: attemptKey,
        adapter_id: "example-workflow",
        key: "handle",
        value: "other-namespace",
      });
    });

    assert.equal(
      world.store.adapterMetadata.get(RUN_ID, "example-runtime", "handle")?.value,
      "run-scoped",
    );
    assert.deepEqual(
      world.store.adapterMetadata.forEntity(attemptKey).map((row) => [row.adapter_id, row.value]),
      [
        ["example-runtime", "attempt-scoped"],
        ["example-workflow", "other-namespace"],
      ],
    );
    assert.equal(world.store.adapterMetadata.forEntity(RUN_ID).length, 1);
  });
});

test("AM6: empty identity components are rejected", () => {
  withWorld((world) => {
    const fails = (patch: Record<string, string>): void =>
      assert.throws(
        () =>
          world.store.withTransaction(() =>
            world.store.adapterMetadata.put({
              entity_key: RUN_ID,
              adapter_id: "example-runtime",
              key: "handle",
              value: "x",
              ...patch,
            }),
          ),
        storeError("DOMAIN_ROW_INVALID"),
      );
    fails({ entity_key: "" });
    fails({ adapter_id: "" });
    fails({ key: "" });
  });
});

test("AM7 / AM8 / M1B1-AC12: I-TD7 rejects restricted key names, at the key and nested", () => {
  withWorld((world) => {
    const write = (key: string, value: unknown): void => {
      world.store.withTransaction(() =>
        world.store.adapterMetadata.put({
          entity_key: RUN_ID,
          adapter_id: "example-runtime",
          key,
          value: value as never,
        }),
      );
    };
    const rejected = (key: string, value: unknown): void =>
      assert.throws(() => write(key, value), storeError("DOMAIN_ROW_INVALID"));

    // Marker names only — no real credential appears anywhere in this fixture.
    const marker = (...parts: readonly string[]): string => parts.join("");
    for (const name of [
      marker("session", "Key"),
      marker("SESSION", "_KEY"),
      marker("to", "ken"),
      marker("Author", "ization"),
      marker("sec", "ret"),
      marker("cre", "dential"),
      marker("refresh_", "to", "ken"),
    ]) {
      rejected(name, "value-placeholder");
      rejected("handle", { [name]: "value-placeholder" });
      rejected("handle", { nested: [{ [name]: "value-placeholder" }] });
      assert.equal(isSecretBearingKey(name), true, name);
    }

    // Non-restricted names carrying opaque, redacted or plain refs are accepted.
    for (const name of ["handle", "workspace_ref", "fingerprint", "workflow_ref"]) {
      assert.equal(isSecretBearingKey(name), false, name);
      write(name, { value: "opaque-ref-1" });
    }
    assert.equal(world.store.adapterMetadata.forEntity(RUN_ID).length, 4);
  });
});

test("AM9: metadata survives close and reopen", () => {
  const owner = world();
  owner.store.withTransaction(() =>
    owner.store.adapterMetadata.put({
      entity_key: RUN_ID,
      adapter_id: "example-runtime",
      key: "handle",
      value: { ref: "opaque-1" },
    }),
  );
  owner.store.close();

  const reopened = owner.temp.open();
  try {
    assert.deepEqual(reopened.adapterMetadata.get(RUN_ID, "example-runtime", "handle")?.value, {
      ref: "opaque-1",
    });
  } finally {
    reopened.close();
    owner.temp.dispose();
  }
});

// --- verification_evidence -------------------------------------------------------------------

test("VE1 / VE3 / M1B1-AC14: evidence stores its projection and envelope", () => {
  withWorld((world) => {
    const attemptKey = attemptOf(world);
    const row = world.store.withTransaction(() =>
      world.store.verificationEvidence.put({
        attempt_key: attemptKey,
        evidence: evidence(),
        binding_valid: true,
      }),
    );

    assert.equal(row.binding_valid, true);
    assert.deepEqual(
      { run: row.run_reference, artifact: row.artifact_digest, log: row.log_digest },
      { run: null, artifact: null, log: null },
      "absent optionals are NULL",
    );
    assert.deepEqual(world.store.verificationEvidence.get(ULIDS.e1), row);
    assert.deepEqual(world.store.verificationEvidence.envelope(ULIDS.e1), evidence());
  });
});

test("VE2 / VE12 / M1B1-AC18: forAttempt returns every evidence row of one attempt", () => {
  withWorld((world) => {
    const attemptKey = attemptOf(world);
    world.store.withTransaction(() => {
      world.store.verificationEvidence.put({
        attempt_key: attemptKey,
        evidence: evidence(),
        binding_valid: true,
      });
      world.store.verificationEvidence.put({
        attempt_key: attemptKey,
        evidence: evidence({ evidence_id: ULIDS.e2, check_id: "lint" }),
        binding_valid: true,
      });
    });

    assert.deepEqual(
      world.store.verificationEvidence.forAttempt(attemptKey).map((row) => row.check_id),
      ["unit", "lint"],
    );
  });
});

test("VE4 / VE5 / M1B1-AC16: an unbound evidence row is stored, never silently promoted", () => {
  withWorld((world) => {
    const attemptKey = attemptOf(world);
    const row = world.store.withTransaction(() =>
      world.store.verificationEvidence.put({
        attempt_key: attemptKey,
        evidence: evidence(),
        binding_valid: false,
      }),
    );

    assert.equal(row.binding_valid, false);
    assert.equal(world.store.verificationEvidence.get(ULIDS.e1)?.binding_valid, false);
    // Nothing in the store re-derives or upgrades it.
    assert.throws(
      () =>
        world.store.withTransaction(() =>
          world.store.verificationEvidence.put({
            attempt_key: attemptKey,
            evidence: evidence(),
            binding_valid: 1 as never,
          }),
        ),
      storeError("DOMAIN_ROW_INVALID"),
    );
  });
});

test("VE6 / VE7 / VE15: invalid vocabularies, hashes and ids are rejected", () => {
  withWorld((world) => {
    const attemptKey = attemptOf(world);
    const fails = (patch: Partial<VerificationEvidenceV1>): void =>
      assert.throws(
        () =>
          world.store.withTransaction(() =>
            world.store.verificationEvidence.put({
              attempt_key: attemptKey,
              evidence: evidence(patch),
              binding_valid: true,
            }),
          ),
        storeError("DOMAIN_ROW_INVALID"),
      );

    fails({ evidence_id: "not-a-ulid" });
    fails({ result: "OK" as never });
    fails({ assurance_level: "TRUSTED" as never });
    fails({ task_contract_hash: "sha256:short" });
    fails({ artifact_digest: "not-a-digest" });
    fails({ check_id: "" });
    fails({ target_commit: "" });
    fails({ executor_identity: "" });
    fails({ timestamp: "" });
  });
});

test("VE8 / M1B1-AC9: evidence for an unknown attempt is refused", () => {
  withWorld((world) => {
    assert.throws(() =>
      world.store.withTransaction(() =>
        world.store.verificationEvidence.put({
          attempt_key: "attempt:task:alpha:missing:1",
          evidence: evidence(),
          binding_valid: true,
        }),
      ),
    );
  });
});

test("VE9 / VE10 / VE11 / M1B1-AC15 / AC17: evidence is immutable", () => {
  withWorld((world) => {
    const attemptKey = attemptOf(world);
    const put = (input: Parameters<typeof world.store.verificationEvidence.put>[0]): void => {
      world.store.withTransaction(() => world.store.verificationEvidence.put(input));
    };

    put({ attempt_key: attemptKey, evidence: evidence(), binding_valid: true });
    put({ attempt_key: attemptKey, evidence: evidence(), binding_valid: true });
    assert.equal(world.store.verificationEvidence.count(), 1, "identical replay is idempotent");

    for (const conflicting of [
      { attempt_key: attemptKey, evidence: evidence({ result: "FAIL" as const }), binding_valid: true },
      { attempt_key: attemptKey, evidence: evidence(), binding_valid: false },
      {
        attempt_key: attemptKey,
        evidence: evidence({ target_commit: "candidate-2" }),
        binding_valid: true,
      },
    ]) {
      assert.throws(() => put(conflicting), storeError("ARTIFACT_CONFLICT"));
    }

    // There is no update or delete surface at all.
    const api = world.store.verificationEvidence as unknown as Record<string, unknown>;
    for (const forbidden of ["update", "delete", "remove", "setBindingValid"]) {
      assert.equal(typeof api[forbidden], "undefined", forbidden);
    }
  });
});

test("VE13 / M1B1-AC19: rework needs no generation column — a new id is the whole mechanism", () => {
  withWorld((world) => {
    const attemptKey = attemptOf(world);
    world.store.withTransaction(() => {
      world.store.verificationEvidence.put({
        attempt_key: attemptKey,
        evidence: evidence({ target_commit: "candidate-1" }),
        binding_valid: true,
      });
      world.store.verificationEvidence.put({
        attempt_key: attemptKey,
        evidence: evidence({ evidence_id: ULIDS.e3, target_commit: "candidate-2" }),
        binding_valid: true,
      });
    });

    const rows = world.store.verificationEvidence.forAttempt(attemptKey);
    assert.deepEqual(rows.map((row) => row.target_commit), ["candidate-1", "candidate-2"]);
    // Both coexist; nothing marks one superseded.
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).includes("generation"), false);
      assert.deepEqual(Object.keys(row).includes("superseded_by"), false);
    }
  });
});

test("VE14: evidence survives close and reopen", () => {
  const owner = world();
  const attemptKey = attemptOf(owner);
  owner.store.withTransaction(() =>
    owner.store.verificationEvidence.put({
      attempt_key: attemptKey,
      evidence: evidence({ run_reference: "wf-ref-1", log_digest: DIGEST }),
      binding_valid: true,
    }),
  );
  owner.store.close();

  const reopened = owner.temp.open();
  try {
    const row = reopened.verificationEvidence.get(ULIDS.e1);
    assert.equal(row?.run_reference, "wf-ref-1");
    assert.equal(row?.log_digest, DIGEST);
    assert.equal(reopened.verificationEvidence.forAttempt(attemptKey).length, 1);
  } finally {
    reopened.close();
    owner.temp.dispose();
  }
});

// --- audit_record ---------------------------------------------------------------------------------

test("AR1 / AR3 / M1B1-AC20: an audit record stores its projection and envelope", () => {
  withWorld((world) => {
    const attemptKey = attemptOf(world);
    const row = world.store.withTransaction(() =>
      world.store.auditRecords.put({
        audit_id: ULIDS.a1,
        attempt_key: attemptKey,
        candidate_commit: "candidate-1",
        task_contract_hash: CONTRACT_HASH,
        envelope: verdict(),
        committed_via: "platform-audit-gate",
        recorded_at: "2026-08-09T10:00:00Z",
      }),
    );

    assert.equal(row.verdict, "AUDIT_PASS");
    assert.equal(row.workflow_ref, null, "the optional ref stays NULL");
    assert.deepEqual(world.store.auditRecords.get(ULIDS.a1), row);
    assert.deepEqual(world.store.auditRecords.envelope(ULIDS.a1), verdict());
  });
});

test("AR2 / M1B1-AC22: one attempt may carry several audit cycles", () => {
  withWorld((world) => {
    const attemptKey = attemptOf(world);
    world.store.withTransaction(() => {
      world.store.auditRecords.put({
        audit_id: ULIDS.a1,
        attempt_key: attemptKey,
        candidate_commit: "candidate-1",
        task_contract_hash: CONTRACT_HASH,
        envelope: verdict({ verdict: "FIX_REQUIRED", required_fix: ["rework the parser"] }),
        committed_via: "platform-audit-gate",
        recorded_at: "t1",
      });
      world.store.auditRecords.put({
        audit_id: ULIDS.a2,
        attempt_key: attemptKey,
        candidate_commit: "candidate-2",
        task_contract_hash: CONTRACT_HASH,
        envelope: verdict({
          reviewed: {
            candidate_commit: "candidate-2",
            task_contract_hash: CONTRACT_HASH,
            evidence_ids: [ULIDS.e1],
          },
        }),
        workflow_ref: "wf-ref-1",
        committed_via: "platform-audit-gate",
        recorded_at: "t2",
      });
    });

    assert.deepEqual(
      world.store.auditRecords.forAttempt(attemptKey).map((row) => row.verdict),
      ["FIX_REQUIRED", "AUDIT_PASS"],
    );
  });
});

test("AR4 / AR9 / AR10 / AR11 / M1B1-AC23 / AC24: an unusable verdict never becomes a record", () => {
  withWorld((world) => {
    const attemptKey = attemptOf(world);
    const base = {
      audit_id: ULIDS.a1,
      attempt_key: attemptKey,
      candidate_commit: "candidate-1",
      task_contract_hash: CONTRACT_HASH,
      committed_via: "platform-audit-gate",
      recorded_at: "t1",
    };
    const fails = (patch: Record<string, unknown>): void =>
      assert.throws(
        () =>
          world.store.withTransaction(() =>
            world.store.auditRecords.put({ ...base, envelope: verdict(), ...patch } as never),
          ),
        storeError("DOMAIN_ROW_INVALID"),
      );

    fails({ envelope: verdict({ verdict: "MAYBE" as never }) });
    fails({ audit_id: "not-a-ulid" });
    fails({ committed_via: "" });
    fails({ task_contract_hash: "sha256:short" });
    // §16.2 — `reviewed.*` must match the attempt's authoritative values exactly.
    // A6 / A7 — §16.2: `reviewed.*` must match the attempt's authoritative values exactly.
    fails({
      envelope: verdict({
        reviewed: {
          candidate_commit: "candidate-9",
          task_contract_hash: CONTRACT_HASH,
          evidence_ids: [ULIDS.e1],
        },
      }),
    });
    fails({
      envelope: verdict({
        reviewed: {
          candidate_commit: "candidate-1",
          task_contract_hash: `sha256:${"c".repeat(64)}`,
          evidence_ids: [ULIDS.e1],
        },
      }),
    });
    fails({ envelope: { verdict: "AUDIT_PASS" } });
    fails({ envelope: "AUDIT_PASS" });

    assert.equal(world.store.auditRecords.count(), 0, "nothing invalid was stored");
  });
});

test("AR13 / AV1 ~ AV11: only a fully validated §16.2 verdict is promoted to audit_record", () => {
  withWorld((world) => {
    const attemptKey = attemptOf(world);
    const base = {
      audit_id: ULIDS.a1,
      attempt_key: attemptKey,
      candidate_commit: "candidate-1",
      task_contract_hash: CONTRACT_HASH,
      committed_via: "platform-audit-gate",
      recorded_at: "t1",
    };
    const rejects = (envelope: unknown, why: string): void => {
      assert.throws(
        () =>
          world.store.withTransaction(() =>
            world.store.auditRecords.put({ ...base, envelope } as never),
          ),
        storeError("DOMAIN_ROW_INVALID"),
        why,
      );
      // The store never calls the §16.2 validator against durable state, so nothing may land.
      assert.equal(world.store.auditRecords.count(), 0, `${why} left a row behind`);
    };

    const full = verdict();
    const without = (field: string): Record<string, unknown> => {
      const copy = { ...(full as unknown as Record<string, unknown>) };
      delete copy[field];
      return copy;
    };
    const reviewedWithout = (field: string): Record<string, unknown> => {
      const copy = { ...full.reviewed } as Record<string, unknown>;
      delete copy[field];
      return { ...(full as unknown as Record<string, unknown>), reviewed: copy };
    };

    // A1 — findings is a required member of the schema.
    rejects(without("findings"), "A1 missing findings");
    // A2 — findings must be an array of well-formed finding objects.
    rejects({ ...full, findings: "none" }, "A2 findings not an array");
    rejects({ ...full, findings: ["just a string"] }, "A2 finding not an object");
    rejects({ ...full, findings: [{ id: "f1", severity: "high" }] }, "A2 finding missing fields");
    rejects(
      {
        ...full,
        findings: [{ id: "", severity: "high", description: "d", evidence_refs: [] }],
      },
      "A2 finding with an empty id",
    );
    rejects(
      {
        ...full,
        findings: [{ id: "f1", severity: "high", description: "d", evidence_refs: "e1" }],
      },
      "A2 evidence_refs not an array",
    );
    rejects(
      {
        ...full,
        findings: [
          { id: "f1", severity: "high", description: "d", evidence_refs: [], extra: 1 },
        ],
      },
      "A2 finding with an unknown field",
    );

    // A3 — reviewed carries exactly the three §16.2 members.
    rejects(reviewedWithout("evidence_ids"), "A3 missing reviewed.evidence_ids");
    rejects(reviewedWithout("candidate_commit"), "A3 missing reviewed.candidate_commit");
    rejects(
      { ...full, reviewed: { ...full.reviewed, extra: 1 } },
      "A3 reviewed with an unknown field",
    );
    rejects(
      { ...full, reviewed: { ...full.reviewed, evidence_ids: "e1" } },
      "A3 evidence_ids not an array",
    );
    rejects(
      { ...full, reviewed: { ...full.reviewed, evidence_ids: ["not-a-ulid"] } },
      "A3 evidence_ids member is not an evidence identity",
    );

    // A4 — reviewed.task_contract_hash must be a digest, not merely equal to the row's value.
    rejects(
      { ...full, reviewed: { ...full.reviewed, task_contract_hash: "contract-1" } },
      "A4 invalid reviewed.task_contract_hash",
    );

    // A5 — the row's verdict is taken from the envelope, so a malformed verdict cannot project.
    rejects(without("verdict"), "A5 missing verdict");
    rejects({ ...full, verdict: "audit_pass" }, "A5 verdict outside the vocabulary");

    // §16.2 — required_fix accompanies FIX_REQUIRED, and must be an array when present.
    rejects({ ...full, verdict: "FIX_REQUIRED" }, "FIX_REQUIRED without required_fix");
    rejects({ ...full, required_fix: "rework" }, "required_fix not an array");

    // The envelope's field set is exact: §16.2 declares merge eligibility absent, not ignorable.
    rejects({ ...full, merge_eligible: true }, "an unknown top-level field");

    // The same envelope, complete, is accepted — and stored as the validated copy.
    world.store.withTransaction(() => world.store.auditRecords.put({ ...base, envelope: full }));
    assert.equal(world.store.auditRecords.count(), 1);
    assert.deepEqual(world.store.auditRecords.envelope(ULIDS.a1), full as never);
    assert.equal(world.store.auditRecords.get(ULIDS.a1)?.verdict, full.verdict);
  });
});

test("AR5: an audit record for an unknown attempt is refused", () => {
  withWorld((world) => {
    assert.throws(() =>
      world.store.withTransaction(() =>
        world.store.auditRecords.put({
          audit_id: ULIDS.a1,
          attempt_key: "attempt:task:alpha:missing:1",
          candidate_commit: "candidate-1",
          task_contract_hash: CONTRACT_HASH,
          envelope: verdict(),
          committed_via: "platform-audit-gate",
          recorded_at: "t1",
        }),
      ),
    );
  });
});

test("AR6 / AR7 / AR8 / M1B1-AC21: audit records are immutable", () => {
  withWorld((world) => {
    const attemptKey = attemptOf(world);
    const input = {
      audit_id: ULIDS.a1,
      attempt_key: attemptKey,
      candidate_commit: "candidate-1",
      task_contract_hash: CONTRACT_HASH,
      envelope: verdict(),
      committed_via: "platform-audit-gate",
      recorded_at: "t1",
    };

    world.store.withTransaction(() => world.store.auditRecords.put(input));
    world.store.withTransaction(() => world.store.auditRecords.put(input));
    assert.equal(world.store.auditRecords.count(), 1, "identical replay is idempotent");

    for (const conflicting of [
      { ...input, committed_via: "something-else" },
      { ...input, recorded_at: "t2" },
      { ...input, envelope: verdict({ verdict: "HUMAN_REQUIRED" }) },
    ]) {
      assert.throws(
        () => world.store.withTransaction(() => world.store.auditRecords.put(conflicting)),
        storeError("ARTIFACT_CONFLICT"),
      );
    }

    const api = world.store.auditRecords as unknown as Record<string, unknown>;
    for (const forbidden of ["update", "delete", "remove"]) {
      assert.equal(typeof api[forbidden], "undefined", forbidden);
    }
  });
});

test("AR12: audit records survive close and reopen", () => {
  const owner = world();
  {
    const attemptKey = attemptOf(owner);
    owner.store.withTransaction(() =>
      owner.store.auditRecords.put({
        audit_id: ULIDS.a1,
        attempt_key: attemptKey,
        candidate_commit: "candidate-1",
        task_contract_hash: CONTRACT_HASH,
        envelope: verdict(),
        workflow_ref: "wf-ref-1",
        committed_via: "platform-audit-gate",
        recorded_at: "t1",
      }),
    );
    owner.store.close();

    const reopened = owner.temp.open();
    try {
      assert.equal(reopened.auditRecords.get(ULIDS.a1)?.workflow_ref, "wf-ref-1");
      assert.equal(reopened.auditRecords.forAttempt(attemptKey).length, 1);
    } finally {
      reopened.close();
      owner.temp.dispose();
    }
  }
});
