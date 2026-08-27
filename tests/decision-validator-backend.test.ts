/**
 * B7-AC22 ~ B7-AC28 — V8 repository fact, V9 derivation feasibility and the V10 Backend
 * Compatibility Gate (TD §9.2c, §9.2d, §12.2).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { BackendManifestSet } from "../core/capability/types.ts";
import { validateDecision } from "../core/decision/validator.ts";
import {
  CORE_REFERENCED_OPERATION_IDS,
  type DecisionValidationResult,
} from "../core/decision/types.ts";
import {
  batchControl,
  compiled,
  enforcementWith,
  inputFor,
  manifests,
  repositoryControl,
  selection,
  taskControl,
  HEAD,
} from "./support/decision-fixtures.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const profile = compiled();
const ACCEPTED: DecisionValidationResult = { kind: "ACCEPTED" };
const rejected = (reason: string): DecisionValidationResult => ({
  kind: "POLICY_REJECTED",
  reason_code: reason as never,
});

const requirements = (map: Record<string, unknown>): Record<string, unknown> => ({
  capability_requirements: map,
});

/** A manifest set whose runtime declares an incomplete enforcement map. */
function incompleteManifests(): BackendManifestSet {
  const valid = manifests();
  const partial = { ...valid.runtime.body.capability_enforcement } as Record<string, unknown>;
  delete partial["shell.execute"];
  return {
    ...valid,
    runtime: {
      ...valid.runtime,
      body: {
        ...valid.runtime.body,
        capability_enforcement: partial as never,
      },
    },
  };
}

// --- V8 -------------------------------------------------------------------------------

test("B7-AC22: the repository-sensitive variants compare the pre-observed canonical head", () => {
  for (const proposal of [selection({ profile }), repositoryControl({ profile })]) {
    assert.deepEqual(validateDecision(inputFor(proposal, profile)), ACCEPTED);
    assert.deepEqual(
      validateDecision(
        inputFor(proposal, profile, { repository: { canonical_head: `${HEAD}-moved` } }),
      ),
      rejected("REPOSITORY_STATE_MISMATCH"),
    );
  }
});

test("B7-AC22: the control variants need no repository view at all", () => {
  assert.deepEqual(
    validateDecision(inputFor(taskControl({ profile }), profile, { repository: undefined })),
    ACCEPTED,
  );
  assert.deepEqual(
    validateDecision(
      inputFor(batchControl({ profile }), profile, { repository: undefined, task: undefined }),
    ),
    ACCEPTED,
  );
});

// --- V9 -------------------------------------------------------------------------------

test("B7-AC23: a selection requires both the ACTOR and the AUDITOR derivation", () => {
  assert.deepEqual(
    validateDecision(inputFor(selection({ profile }), profile, { manifests: incompleteManifests() })),
    rejected("CAPABILITY_DERIVATION_FAILED"),
  );

  // The roles are fixed in the source, not inferred from the Proposal.
  const source = readFileSync(join(ROOT, "core/decision/validator.ts"), "utf8");
  assert.match(source, /rolesRequiringDerivation[\s\S]*?return \["ACTOR", "AUDITOR"\]/);
});

test("B7-AC23: PROPOSE_MERGE derives only with auto_merge, and other decisions not at all", () => {
  const auto = compiled({
    auto_merge: true,
    ...requirements({ automatic_merge: { "repository.merge": { accepted: ["ENFORCED"] } } }),
  });
  assert.deepEqual(
    validateDecision(
      inputFor(repositoryControl({ profile: auto }), auto, { manifests: incompleteManifests() }),
    ),
    rejected("CAPABILITY_DERIVATION_FAILED"),
  );

  // auto_merge=false: no derivation is attempted, so a broken manifest is irrelevant.
  assert.deepEqual(
    validateDecision(
      inputFor(repositoryControl({ profile }), profile, { manifests: incompleteManifests() }),
    ),
    ACCEPTED,
  );
  assert.deepEqual(
    validateDecision(
      inputFor(taskControl({ profile }), profile, { manifests: incompleteManifests() }),
    ),
    ACCEPTED,
  );
});

// --- V10 operation mapping --------------------------------------------------------------

test("B7-AC24: exactly three operation ids are referenced by Core", () => {
  assert.deepEqual(
    [...CORE_REFERENCED_OPERATION_IDS],
    ["actor_execution", "auditor_execution", "automatic_merge"],
  );

  const source = readFileSync(join(ROOT, "core/decision/validator.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // No Proposal-supplied operation id, and no registry of policy-declared operations.
  assert.equal(/proposal\.operation_id|Object\.keys\(policy\.capability_requirements\)/.test(code), false);
});

test("B7-AC25: START_TASK and START_SUBFLOW check actor_execution then auditor_execution", () => {
  const weak = manifests(
    enforcementWith({
      "repository.feature_write": { allow: "NOT_YET_AUDITED", deny: "NOT_YET_AUDITED" },
    }),
  );

  const actorOnly = compiled(
    requirements({ actor_execution: { "repository.feature_write": { accepted: ["ENFORCED"] } } }),
  );
  const auditorOnly = compiled(
    requirements({ auditor_execution: { "repository.feature_write": { accepted: ["ENFORCED"] } } }),
  );
  const both = compiled(
    requirements({
      actor_execution: { "repository.feature_write": { accepted: ["ENFORCED"] } },
      auditor_execution: { "repository.feature_write": { accepted: ["ENFORCED"] } },
    }),
  );

  for (const decision of ["START_TASK", "START_SUBFLOW"]) {
    const classification = decision === "START_TASK" ? "IMPLEMENTABLE" : "SPLIT_NEEDED";
    const run = (used: ReturnType<typeof compiled>): DecisionValidationResult =>
      validateDecision(
        inputFor(selection({ profile: used, decision, classification }), used, { manifests: weak }),
      );

    assert.equal(
      (run(actorOnly) as { detail: { operation_id: string; role: string } }).detail.operation_id,
      "actor_execution",
    );
    assert.equal(
      (run(auditorOnly) as { detail: { operation_id: string; role: string } }).detail.operation_id,
      "auditor_execution",
    );
    // Both fail; the actor operation is evaluated first.
    const first = run(both) as { detail: { operation_id: string; role: string } };
    assert.equal(first.detail.operation_id, "actor_execution");
    assert.equal(first.detail.role, "ACTOR");
  }
});

test("B7-AC25: PROPOSE_MERGE maps to automatic_merge only, and only with auto_merge=true", () => {
  const weak = manifests(
    enforcementWith({
      "repository.merge": { deny: "NOT_YET_AUDITED" },
      "repository.feature_write": { allow: "NOT_YET_AUDITED" },
    }),
  );
  const declared = {
    actor_execution: { "repository.feature_write": { accepted: ["ENFORCED"] } },
    automatic_merge: { "repository.merge": { accepted: ["ENFORCED"] } },
  };

  const auto = compiled({ auto_merge: true, ...requirements(declared) });
  const result = validateDecision(
    inputFor(repositoryControl({ profile: auto }), auto, { manifests: weak }),
  ) as { kind: string; detail: { operation_id: string; role: string } };
  assert.equal(result.kind, "BACKEND_INCOMPATIBLE");
  assert.equal(result.detail.operation_id, "automatic_merge", "actor_execution is not consulted");
  assert.equal(result.detail.role, "ACTOR");

  // Human merge stays available: the automatic-merge requirement does not gate the proposal.
  const manual = compiled(requirements(declared));
  assert.deepEqual(
    validateDecision(inputFor(repositoryControl({ profile: manual }), manual, { manifests: weak })),
    ACCEPTED,
  );
});

test("B7-AC25: the remaining decisions map to no operation", () => {
  const weak = manifests(enforcementWith({ "repository.read": { allow: "NOT_YET_AUDITED", deny: "NOT_YET_AUDITED" } }));
  const strict = compiled(
    requirements({
      actor_execution: { "repository.read": { accepted: ["ENFORCED"] } },
      auditor_execution: { "repository.read": { accepted: ["ENFORCED"] } },
      automatic_merge: { "repository.read": { accepted: ["ENFORCED"] } },
    }),
  );

  for (const proposal of [
    repositoryControl({ profile: strict, decision: "REQUEST_REWORK" }),
    taskControl({ profile: strict, decision: "HOLD_TASK" }),
    taskControl({ profile: strict, decision: "DEFER_TASK" }),
    taskControl({ profile: strict, decision: "RESUME_PARENT" }),
    batchControl({ profile: strict }),
  ]) {
    assert.deepEqual(validateDecision(inputFor(proposal, strict, { manifests: weak })), ACCEPTED);
  }
});

// --- V10 compatibility semantics ---------------------------------------------------------

test("B7-AC26: an operation the policy never declared is compatible", () => {
  const weak = manifests(enforcementWith({}));
  // The default fixture declares no capability requirements at all.
  assert.deepEqual(validateDecision(inputFor(selection({ profile }), profile, { manifests: weak })), ACCEPTED);

  const partial = compiled(
    requirements({ actor_execution: { "repository.read": { accepted: ["ENFORCED"] } } }),
  );
  assert.deepEqual(
    validateDecision(inputFor(selection({ profile: partial }), partial)),
    ACCEPTED,
    "the undeclared auditor_execution requirement is an empty set, not an incompatibility",
  );
});

test("B7-AC27: the directional accepted-set rule decides, in both directions", () => {
  // requested=true selects the allow assurance.
  const allowWeak = compiled(
    requirements({ actor_execution: { "repository.feature_write": { accepted: ["ENFORCED"] } } }),
  );
  const allowResult = validateDecision(
    inputFor(selection({ profile: allowWeak }), allowWeak, {
      manifests: manifests(enforcementWith({ "repository.feature_write": { allow: "NOT_YET_AUDITED" } })),
    }),
  ) as { kind: string; detail: { failure: { requested: boolean; actual: string } } };
  assert.equal(allowResult.kind, "BACKEND_INCOMPATIBLE");
  assert.deepEqual(
    { requested: allowResult.detail.failure.requested, actual: allowResult.detail.failure.actual },
    { requested: true, actual: "NOT_YET_AUDITED" },
  );

  // requested=false selects the deny assurance — ACTOR never requests canonical_write.
  const denyWeak = compiled(
    requirements({ actor_execution: { "repository.canonical_write": { accepted: ["ENFORCED"] } } }),
  );
  const denyResult = validateDecision(
    inputFor(selection({ profile: denyWeak }), denyWeak, {
      manifests: manifests(enforcementWith({ "repository.canonical_write": { deny: "NOT_YET_AUDITED" } })),
    }),
  ) as { kind: string; detail: { failure: { requested: boolean; actual: string } } };
  assert.equal(denyResult.kind, "BACKEND_INCOMPATIBLE");
  assert.deepEqual(
    { requested: denyResult.detail.failure.requested, actual: denyResult.detail.failure.actual },
    { requested: false, actual: "NOT_YET_AUDITED" },
  );
});

test("B7-AC27: an AUDITOR deny direction is checked under auditor_execution", () => {
  // The Auditor requests only repository.read, so feature_write resolves through deny.
  const policy = compiled(
    requirements({ auditor_execution: { "repository.feature_write": { accepted: ["ENFORCED"] } } }),
  );
  const result = validateDecision(
    inputFor(selection({ profile: policy }), policy, {
      manifests: manifests(enforcementWith({ "repository.feature_write": { deny: "NOT_YET_AUDITED" } })),
    }),
  ) as { kind: string; detail: { operation_id: string; role: string; failure: { requested: boolean } } };

  assert.equal(result.kind, "BACKEND_INCOMPATIBLE");
  assert.deepEqual(
    { operation_id: result.detail.operation_id, role: result.detail.role, requested: result.detail.failure.requested },
    { operation_id: "auditor_execution", role: "AUDITOR", requested: false },
  );
});

test("B7-AC27: NOT_YET_AUDITED passes only when the policy lists it explicitly", () => {
  const enforcedOnly = compiled(
    requirements({ actor_execution: { "shell.execute": { accepted: ["ENFORCED"] } } }),
  );
  const listed = compiled(
    requirements({ actor_execution: { "shell.execute": { accepted: ["ENFORCED", "NOT_YET_AUDITED"] } } }),
  );
  const weak = manifests(enforcementWith({ "shell.execute": { allow: "NOT_YET_AUDITED" } }));

  assert.equal(
    (validateDecision(inputFor(selection({ profile: enforcedOnly }), enforcedOnly, { manifests: weak })) as {
      kind: string;
    }).kind,
    "BACKEND_INCOMPATIBLE",
  );
  assert.deepEqual(
    validateDecision(inputFor(selection({ profile: listed }), listed, { manifests: weak })),
    ACCEPTED,
  );
});

test("B7-AC28: receipt_supported and features cannot influence V10", () => {
  const policy = compiled(
    requirements({ actor_execution: { "shell.execute": { accepted: ["ENFORCED"] } } }),
  );
  const enforcement = enforcementWith({ "shell.execute": { allow: "NOT_YET_AUDITED" } });

  const run = (runtimeOverrides: Record<string, unknown>): DecisionValidationResult =>
    validateDecision(
      inputFor(selection({ profile: policy }), policy, {
        manifests: manifests(enforcement, runtimeOverrides),
      }),
    );

  const baseline = run({});
  assert.deepEqual(run({ receipt_supported: false }), baseline);
  assert.deepEqual(run({ features: { persistent_session: false, extra: "value" } }), baseline);

  // And the same independence holds for a passing case.
  const compatible = compiled(
    requirements({ actor_execution: { "shell.execute": { accepted: ["ENFORCED"] } } }),
  );
  const strongRun = (runtimeOverrides: Record<string, unknown>): DecisionValidationResult =>
    validateDecision(
      inputFor(selection({ profile: compatible }), compatible, {
        manifests: manifests(enforcementWith({}), runtimeOverrides),
      }),
    );
  assert.deepEqual(strongRun({}), ACCEPTED);
  assert.deepEqual(strongRun({ receipt_supported: false }), ACCEPTED);
  assert.deepEqual(strongRun({ features: {} }), ACCEPTED);
});

test("B7-AC27: the failure detail reuses the Batch 5 compatibility check verbatim", () => {
  const policy = compiled(
    requirements({ actor_execution: { "shell.execute": { accepted: ["ENFORCED"] } } }),
  );
  const result = validateDecision(
    inputFor(selection({ profile: policy }), policy, {
      manifests: manifests(enforcementWith({ "shell.execute": { allow: "NOT_YET_AUDITED" } })),
    }),
  ) as { kind: string; detail: { failure: Record<string, unknown> } };

  assert.equal(result.kind, "BACKEND_INCOMPATIBLE");
  assert.deepEqual(Object.keys(result.detail.failure).sort(), [
    "accepted",
    "actual",
    "capability",
    "passed",
    "requested",
  ]);
  assert.deepEqual(result.detail.failure["accepted"], ["ENFORCED"]);
  assert.equal(result.detail.failure["passed"], false);
});
