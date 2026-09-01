/**
 * B7-AC32 / MVP 0 Acceptance A5 — a backend whose enforcement does not satisfy the Execution
 * Policy is blocked deterministically, before any canonical execution side effect (TD §9.2d).
 *
 * The whole scenario runs on invented vocabulary and pure values: no runtime session is spawned,
 * no workflow is started and no repository is touched.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { validateDecision, type DecisionValidationInput } from "../core/decision/validator.ts";
import type { BackendManifestSet } from "../core/capability/types.ts";
import {
  compiled,
  enforcementWith,
  inputFor,
  manifests,
  selection,
} from "./support/decision-fixtures.ts";

/** classification `IMPLEMENTABLE`, pipeline `standard` — neutral names owned by the tests. */
const policy = compiled({
  capability_requirements: {
    actor_execution: {
      "shell.execute": { accepted: ["ENFORCED"] },
      "repository.canonical_write": { accepted: ["ENFORCED"] },
    },
  },
});

const proposal = selection({ profile: policy, classification: "IMPLEMENTABLE", pipeline_id: "standard" });

const scenario = (backend: BackendManifestSet): DecisionValidationInput =>
  inputFor(proposal, policy, { manifests: backend });

/** Manifest A — every required assurance satisfied in the direction that applies. */
const backendA = (): BackendManifestSet => manifests(enforcementWith({}));

test("B7-AC32: an adequate backend is accepted", () => {
  assert.deepEqual(validateDecision(scenario(backendA())), { kind: "ACCEPTED" });
});

test("B7-AC32: weakening one required allow assurance blocks the same decision", () => {
  // The Actor requests shell.execute, so the allow direction is the one that must hold.
  const backendB = manifests(enforcementWith({ "shell.execute": { allow: "NOT_YET_AUDITED" } }));
  const result = validateDecision(scenario(backendB)) as {
    kind: string;
    detail: { operation_id: string; role: string; failure: { capability: string; requested: boolean } };
  };

  assert.equal(result.kind, "BACKEND_INCOMPATIBLE");
  assert.deepEqual(
    {
      operation_id: result.detail.operation_id,
      role: result.detail.role,
      capability: result.detail.failure.capability,
      requested: result.detail.failure.requested,
    },
    {
      operation_id: "actor_execution",
      role: "ACTOR",
      capability: "shell.execute",
      requested: true,
    },
  );
});

test("B7-AC32: weakening one required deny assurance blocks it just as deterministically", () => {
  // The Actor never requests canonical_write, so the deny direction is the one that must hold.
  const backendB = manifests(
    enforcementWith({ "repository.canonical_write": { deny: "AVAILABLE_WITH_REDUCED_ASSURANCE" } }),
  );
  const result = validateDecision(scenario(backendB)) as {
    kind: string;
    detail: { failure: { capability: string; requested: boolean; actual: string } };
  };

  assert.equal(result.kind, "BACKEND_INCOMPATIBLE");
  assert.deepEqual(result.detail.failure, {
    capability: "repository.canonical_write",
    requested: false,
    actual: "AVAILABLE_WITH_REDUCED_ASSURANCE",
    accepted: ["ENFORCED"],
    passed: false,
  } as never);
});

test("B7-AC32: the verdict is reproducible and reached without any execution seam", () => {
  const accepted = scenario(backendA());
  assert.deepEqual(validateDecision(accepted), validateDecision(accepted), "deterministic");

  // The input carries authority projections only — no adapter, no session, no store handle.
  // D23 adds exactly the active-turn proposal identity projection.
  assert.deepEqual(Object.keys(accepted).sort(), [
    "batch",
    "compiled_profile",
    "compiled_profile_hash",
    "manifests",
    "proposal",
    "proposal_identity",
    "repository",
    "task",
  ]);
});
