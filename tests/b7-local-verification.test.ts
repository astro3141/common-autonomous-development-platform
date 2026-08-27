/**
 * LV-1 ~ LV-8 — the Backend v1 layering (TD §15.1, M1-9).
 *
 * These are the only tests that know verification runs as a workflow. They prove what the adapter
 * does *below* the boundary, and that none of it is visible above it.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type {
  TaskContractSnapshot,
  VerificationProfile,
} from "../adapters/interfaces/handles.ts";
import type { RepositoryCanonicalSnapshot } from "../adapters/interfaces/repository-adapter.ts";
import { SECRET_BEARING_KEY_CATEGORIES } from "../core/store/restricted-key-denylist.ts";
import { blockedPreflight, localVerification } from "./support/execution-fixtures.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const OP_KEY = "op:attempt:task:alpha:T-101:1:verify:9a8b7c";
const CANDIDATE = "9a8b7c6d5e4f30211203344556677889900aabbc";

const request = (
  overrides: Partial<{ op_key: string; candidate: string; profile: string }> = {},
) =>
  [
    { op_key: overrides.op_key ?? OP_KEY },
    (overrides.profile ?? "full") as unknown as VerificationProfile,
    { ref: "refs/heads/trunk", head: "head-canonical-1" } satisfies RepositoryCanonicalSnapshot,
    {
      schema: "platform/task-contract",
      schema_version: 1,
      body: { snapshot_id: "s-1" },
    } as unknown as TaskContractSnapshot,
    overrides.candidate ?? CANDIDATE,
  ] as const;

// --- LV-1: BLOCKED means nothing happened -------------------------------------------------------

test("LV-1: a blocked readiness check starts nothing and acquires no controller", () => {
  const backend = localVerification({ preflight: blockedPreflight("C2", "C3") });

  assert.deepEqual(backend.adapter.start_verification(...request()), { kind: "BLOCKED" });

  assert.equal(backend.runtime.controllerAcquisitions, 0);
  assert.equal(backend.workflow.starts.length, 0);
  assert.equal(backend.workflow.workflowCount, 0);
  assert.equal(backend.repository.workspaceCount, 0, "not even a workspace");
});

// --- LV-2 / LV-3: the ready path ------------------------------------------------------------------

test("LV-2 / LV-3: a ready backend acquires a controller and starts one workflow with op_key", () => {
  const backend = localVerification();
  const result = backend.adapter.start_verification(...request());

  assert.equal(result.kind, "STARTED");
  assert.equal(backend.runtime.controllerAcquisitions, 1, "LV-2");
  assert.equal(backend.workflow.starts.length, 1);
  assert.equal(backend.workflow.workflowCount, 1);

  // LV-3 — the Platform operation key is what the backend receives as its request identity.
  const spec = (backend.workflow.starts[0]?.spec ?? {}) as Record<string, unknown>;
  assert.equal(spec["request_id"], OP_KEY);
  assert.equal(spec["candidate_commit"], CANDIDATE);
  assert.equal(typeof spec["worktree"], "string", "the checks need somewhere to run");
  assert.deepEqual(backend.workflow.starts[0]?.controller, { controller: "platform-controller-1" });
});

// --- LV-4 / LV-5: same-op semantics ----------------------------------------------------------------

test("LV-4: the same op key with the same material returns the same run and one workflow", () => {
  const backend = localVerification();
  const first = backend.adapter.start_verification(...request());
  const again = backend.adapter.start_verification(...request());

  assert.equal(first.kind, "STARTED");
  assert.equal(again.kind, "STARTED");
  assert.deepEqual(
    again.kind === "STARTED" ? again.run_handle : null,
    first.kind === "STARTED" ? first.run_handle : undefined,
  );
  assert.equal(backend.workflow.workflowCount, 1, "one logical workflow");
  assert.equal(backend.repository.workspaceCount, 1, "one execution worktree");
});

test("LV-5: the same op key with different material is a deterministic conflict", () => {
  for (const changed of [{ candidate: "0".repeat(40) }, { profile: "docs_only" }]) {
    const backend = localVerification();
    assert.equal(backend.adapter.start_verification(...request()).kind, "STARTED");
    assert.throws(
      () => backend.adapter.start_verification(...request(changed)),
      /already names a workspace|different payload/,
      JSON.stringify(changed),
    );
    assert.equal(backend.workflow.workflowCount, 1, "no second workflow under a changed request");
  }
});

// --- LV-6 / LV-7: what crosses the boundary --------------------------------------------------------

test("LV-6 / LV-7: the run handle carries no trusted identity and no workflow type", () => {
  const backend = localVerification();
  const result = backend.adapter.start_verification(...request());
  assert.equal(result.kind, "STARTED");

  const serialized = JSON.stringify(result.kind === "STARTED" ? result.run_handle : null);
  for (const category of SECRET_BEARING_KEY_CATEGORIES) {
    assert.equal(serialized.toLowerCase().includes(category), false, category);
  }
  for (const forbidden of ["ownerKey", "controller", "agentId", "parent"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  // LV-6 — the *type* is the boundary. Core holds a VerificationRunHandle; only this adapter is
  // allowed to know it can be read as the backend's workflow id.
  const core = readdirSync(join(ROOT, "core/execution"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join(ROOT, "core/execution", name), "utf8"))
    .join("\n");
  assert.equal(/WorkflowHandle/.test(core), false, "no Core module names WorkflowHandle");
});
