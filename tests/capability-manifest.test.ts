/**
 * B5-AC1 ~ B5-AC5 — BackendCapabilityManifestV1 schema, Runtime specialization, the four-component
 * set and per-component hashing (TD §12.2a).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CapabilityError } from "../core/capability/errors.ts";
import { validateManifestSet } from "../core/capability/manifest-set.ts";
import { hashManifest, validateManifest } from "../core/capability/validate-manifest.ts";
import { hashEnvelope, makeEnvelope } from "../core/schemas/envelope.ts";
import { isDigest } from "../core/schemas/digest.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import {
  componentManifest,
  manifestSet,
  runtimeManifest,
  strongEnforcement,
} from "./support/capability-fixtures.ts";

const rejects = (input: unknown, reason = "MANIFEST_INVALID"): void => {
  assert.throws(
    () => validateManifest(input),
    (error: unknown) => error instanceof CapabilityError && error.reason === reason,
  );
};

const withBody = (overrides: Record<string, unknown>): Record<string, unknown> => {
  const manifest = runtimeManifest();
  manifest["body"] = { ...(manifest["body"] as Record<string, unknown>), ...overrides };
  return manifest;
};

// --- valid manifests ---------------------------------------------------------------

test("B5-AC1: a valid RUNTIME manifest validates and hashes", () => {
  const manifest = validateManifest(runtimeManifest());

  assert.equal(manifest.body.backend_kind, "RUNTIME");
  assert.equal(manifest.body.adapter_id, "example-runtime");
  assert.ok(isDigest(manifest.hash));
});

test("B5-AC1: WORKFLOW / REPOSITORY / VERIFICATION manifests validate", () => {
  for (const kind of ["WORKFLOW", "REPOSITORY", "VERIFICATION"] as const) {
    const manifest = validateManifest(componentManifest(kind));
    assert.equal(manifest.body.backend_kind, kind);
    assert.deepEqual(Object.keys(manifest.body).sort(), [
      "adapter_id",
      "adapter_version",
      "backend_instance_id",
      "backend_kind",
      "features",
    ]);
  }
});

// --- envelope and common body ------------------------------------------------------

test("B5-AC1: envelope schema and version are exact", () => {
  rejects({ ...runtimeManifest(), schema: "platform/other" });
  rejects({ ...runtimeManifest(), schema_version: 2 });
  rejects({ ...runtimeManifest(), extra: 1 });
});

test("B5-AC1: each common field is required and unknown fields are rejected", () => {
  for (const field of [
    "backend_kind",
    "adapter_id",
    "adapter_version",
    "backend_instance_id",
    "features",
  ]) {
    const manifest = runtimeManifest();
    const body = { ...(manifest["body"] as Record<string, unknown>) };
    delete body[field];
    manifest["body"] = body;
    rejects(manifest);
  }
  rejects(withBody({ vendor_notes: "x" }));
  rejects(withBody({ backend_kind: "DATABASE" }));
});

test("B5-AC1: empty identity strings are rejected", () => {
  rejects(withBody({ adapter_id: "" }));
  rejects(withBody({ adapter_version: "" }));
  rejects(withBody({ backend_instance_id: "" }));
  rejects(withBody({ adapter_id: 1 }));
});

test("B5-AC1: features stay opaque but must fit the restricted JSON model", () => {
  const features = { nested: { list: [3, 1, 2], flag: true }, note: null, unknown_key: "kept" };
  const manifest = validateManifest(withBody({ features }));

  assert.deepEqual(manifest.body.features, features);
  rejects(withBody({ features: { ratio: 0.5 } }));
  rejects(withBody({ features: [] }));
});

// --- Runtime specialization ---------------------------------------------------------

test("B5-AC2: Runtime-only fields are required on RUNTIME", () => {
  const noReceipt = runtimeManifest();
  const body = { ...(noReceipt["body"] as Record<string, unknown>) };
  delete body["receipt_supported"];
  noReceipt["body"] = body;
  rejects(noReceipt);

  const noEnforcement = runtimeManifest();
  const body2 = { ...(noEnforcement["body"] as Record<string, unknown>) };
  delete body2["capability_enforcement"];
  noEnforcement["body"] = body2;
  rejects(noEnforcement);

  rejects(withBody({ receipt_supported: "true" }));
});

test("B5-AC2: the directional map must cover exactly the twelve capabilities", () => {
  const missing = strongEnforcement();
  delete missing["shell.execute"];
  rejects(withBody({ capability_enforcement: missing }));

  const unknown = { ...strongEnforcement(), "repository.deploy": { allow: "ENFORCED", deny: "ENFORCED" } };
  rejects(withBody({ capability_enforcement: unknown }));

  const noAllow = strongEnforcement();
  noAllow["shell.execute"] = { deny: "ENFORCED" } as never;
  rejects(withBody({ capability_enforcement: noAllow }));

  const noDeny = strongEnforcement();
  noDeny["shell.execute"] = { allow: "ENFORCED" } as never;
  rejects(withBody({ capability_enforcement: noDeny }));

  const extraField = strongEnforcement();
  extraField["shell.execute"] = { allow: "ENFORCED", deny: "ENFORCED", note: "x" } as never;
  rejects(withBody({ capability_enforcement: extraField }));

  const badAssurance = strongEnforcement();
  badAssurance["shell.execute"] = { allow: "TOTALLY_SAFE", deny: "ENFORCED" } as never;
  rejects(withBody({ capability_enforcement: badAssurance }));
});

test("B5-AC3: non-Runtime manifests may not carry Runtime-only fields", () => {
  rejects(componentManifest("WORKFLOW", { receipt_supported: true }));
  rejects(componentManifest("REPOSITORY", { capability_enforcement: strongEnforcement() }));
  rejects(componentManifest("VERIFICATION", { receipt_supported: false }));
});

// --- hashing -------------------------------------------------------------------------

test("B5-AC5: hashing reuses the Batch 1 envelope primitive and is stable", () => {
  const first = validateManifest(runtimeManifest());
  const second = validateManifest(runtimeManifest());

  assert.equal(first.hash, second.hash);
  assert.equal(
    first.hash,
    hashEnvelope(
      makeEnvelope("platform/backend-capability-manifest", 1, first.body as unknown as CanonicalObject),
    ),
  );
  assert.equal(hashManifest(first.body), first.hash);
});

test("B5-AC5: input key order does not change the hash, but feature array order does", () => {
  const forward = runtimeManifest();
  const reversed = runtimeManifest();
  reversed["body"] = Object.fromEntries(
    Object.entries(reversed["body"] as Record<string, unknown>).reverse(),
  );
  assert.equal(validateManifest(forward).hash, validateManifest(reversed).hash);

  const listA = validateManifest(withBody({ features: { ordered: ["a", "b"] } }));
  const listB = validateManifest(withBody({ features: { ordered: ["b", "a"] } }));
  assert.notEqual(listA.hash, listB.hash, "opaque arrays stay order-sensitive");
  assert.deepEqual(listA.body.features, { ordered: ["a", "b"] });
});

// --- manifest set --------------------------------------------------------------------

test("B5-AC4: a valid four-kind set is accepted and each component keeps its own hash", () => {
  const set = validateManifestSet(manifestSet());

  assert.equal(set.runtime.body.backend_kind, "RUNTIME");
  assert.equal(set.workflow.body.backend_kind, "WORKFLOW");
  assert.equal(set.repository.body.backend_kind, "REPOSITORY");
  assert.equal(set.verification.body.backend_kind, "VERIFICATION");

  const hashes = [set.runtime.hash, set.workflow.hash, set.repository.hash, set.verification.hash];
  assert.equal(new Set(hashes).size, 4);
  for (const hash of hashes) assert.ok(isDigest(hash));

  // No aggregate hash or envelope exists on the set itself.
  assert.deepEqual(Object.keys(set).sort(), ["repository", "runtime", "verification", "workflow"]);
});

test("B5-AC4: a wrong kind in any slot is rejected", () => {
  const cases = [
    { ...manifestSet(), runtime: componentManifest("WORKFLOW") },
    { ...manifestSet(), workflow: runtimeManifest() },
    { ...manifestSet(), repository: componentManifest("VERIFICATION") },
    { ...manifestSet(), verification: componentManifest("REPOSITORY") },
  ];
  for (const input of cases) {
    assert.throws(
      () => validateManifestSet(input),
      (error: unknown) =>
        error instanceof CapabilityError && error.reason === "MANIFEST_SET_INVALID",
    );
  }
});

test("B5-AC4: a duplicated kind cannot form a valid set", () => {
  assert.throws(
    () => validateManifestSet({ ...manifestSet(), workflow: componentManifest("REPOSITORY") }),
    (error: unknown) => error instanceof CapabilityError && error.reason === "MANIFEST_SET_INVALID",
  );
});
