/**
 * B5-AC12 ~ B5-AC14, B5-AC19 (grant half) — CapabilityGrant v1 body, hashing, the supplied
 * `grant_id` boundary and Runtime Manifest binding (TD §12.5).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { issueCapabilityGrant } from "../core/capability/broker.ts";
import { CapabilityError } from "../core/capability/errors.ts";
import { validateManifest } from "../core/capability/validate-manifest.ts";
import { hashEnvelope, makeEnvelope } from "../core/schemas/envelope.ts";
import { isDigest } from "../core/schemas/digest.ts";
import { CAPABILITY_NAMES } from "../core/schemas/capability-vocabulary.ts";
import { GRANT_BODY_FIELDS } from "../core/capability/types.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import type {
  RuntimeManifestBody,
  TaskContractCapabilityView,
  ValidatedManifest,
} from "../core/capability/types.ts";
import { validateExecutionPolicy } from "../core/profile/validate-execution-policy.ts";
import type { ExecutionPolicyV1Body, RemotePushMode } from "../core/profile/types.ts";
import { validExecutionPolicy } from "./support/profile-fixtures.ts";
import { ULID_A, ULID_B, runtimeManifest, uniformEnforcement } from "./support/capability-fixtures.ts";

const runtime = (overrides: Record<string, unknown> = {}): ValidatedManifest<RuntimeManifestBody> => {
  const manifest = runtimeManifest();
  manifest["body"] = { ...(manifest["body"] as Record<string, unknown>), ...overrides };
  return validateManifest(manifest) as ValidatedManifest<RuntimeManifestBody>;
};

const policy = (mode: RemotePushMode = "FEATURE_BRANCH_ONLY"): ExecutionPolicyV1Body => {
  const raw = validExecutionPolicy();
  raw["repository_policy"] = {
    ...(raw["repository_policy"] as Record<string, unknown>),
    remote_push: mode,
  };
  return validateExecutionPolicy(raw);
};

/** The view is a required Broker input (TD §12.7); its contents never affect the grant. */
const defaultView: TaskContractCapabilityView = {
  repository_scope: { allowed_paths: ["src/"], forbidden_paths: [".platform/"] },
};

const grant = (overrides: Partial<Parameters<typeof issueCapabilityGrant>[0]> = {}) =>
  issueCapabilityGrant({
    grant_id: ULID_A,
    role: "ACTOR",
    effective_policy: policy(),
    runtime_manifest: runtime(),
    task_contract_capability_view: defaultView,
    ...overrides,
  });

test("B5-AC12: grants for all three roles have the exact five-field body", () => {
  for (const role of ["SUPERVISOR", "ACTOR", "AUDITOR"] as const) {
    const result = grant({ role });

    assert.deepEqual(Object.keys(result.body).sort(), [...GRANT_BODY_FIELDS].sort());
    assert.equal(result.body.role, role);
    assert.equal(Object.keys(result.body.requested).length, 12);
    assert.equal(Object.keys(result.body.enforcement).length, 12);
    assert.equal(result.envelope.schema, "platform/capability-grant");
    assert.equal(result.envelope.schema_version, 1);
  }
});

test("B5-AC12: grant_hash is the envelope hash and never a body field", () => {
  const result = grant();

  assert.ok(isDigest(result.grant_hash));
  assert.equal(result.grant_hash, hashEnvelope(result.envelope));
  assert.equal("grant_hash" in result.body, false);
  assert.equal(JSON.stringify(result.body).includes("grant_hash"), false);
});

test("B5-AC12: no backend_application and no non-runtime manifest hash appear in the grant", () => {
  const serialized = JSON.stringify(grant().body);

  assert.equal(serialized.includes("backend_application"), false);
  assert.equal(serialized.includes("workflow_manifest_hash"), false);
  assert.equal(serialized.includes("repository_manifest_hash"), false);
  assert.equal(serialized.includes("verification_manifest_hash"), false);
  assert.deepEqual(Object.keys(grant().body).sort(), [
    "enforcement",
    "grant_id",
    "requested",
    "role",
    "source_runtime_manifest_hash",
  ]);
});

test("B5-AC12: invalid grant_id and role are rejected", () => {
  const rejects = (input: Partial<Parameters<typeof issueCapabilityGrant>[0]>): void => {
    assert.throws(
      () => grant(input),
      (error: unknown) => error instanceof CapabilityError && error.reason === "GRANT_INVALID",
    );
  };
  rejects({ grant_id: "not-a-ulid" });
  rejects({ grant_id: "" });
  rejects({ grant_id: ULID_A.toLowerCase() });
  rejects({ role: "OPERATOR" as never });
});

test("B5-AC14: source_runtime_manifest_hash is the actual Runtime Manifest hash", () => {
  const manifest = runtime();
  const result = grant({ runtime_manifest: manifest });

  assert.equal(result.body.source_runtime_manifest_hash, manifest.hash);
  // A caller cannot bind an arbitrary hash: the Broker recomputes it from the validated body.
  const forged = { body: manifest.body, hash: `sha256:${"0".repeat(64)}` };
  assert.equal(
    grant({ runtime_manifest: forged as ValidatedManifest<RuntimeManifestBody> }).body
      .source_runtime_manifest_hash,
    manifest.hash,
  );
});

test("B5-AC13: the same supplied grant_id and inputs produce the same hash", () => {
  assert.equal(grant().grant_hash, grant().grant_hash);
  assert.notEqual(grant().grant_hash, grant({ grant_id: ULID_B }).grant_hash);
});

test("B5-AC12: role, policy and manifest changes each change the grant hash", () => {
  const base = grant();

  assert.notEqual(base.grant_hash, grant({ role: "AUDITOR" }).grant_hash);
  // remote_push affects the Actor's requested map.
  assert.notEqual(base.grant_hash, grant({ effective_policy: policy("DENY") }).grant_hash);
  // A different assurance changes enforcement.
  assert.notEqual(
    base.grant_hash,
    grant({
      runtime_manifest: runtime({
        capability_enforcement: uniformEnforcement("AVAILABLE_WITH_REDUCED_ASSURANCE", "ENFORCED"),
      }),
    }).grant_hash,
  );
  // A features-only change alters the manifest hash and therefore the grant hash.
  assert.notEqual(
    base.grant_hash,
    grant({ runtime_manifest: runtime({ features: { persistent_session: false } }) }).grant_hash,
  );
});

test("B5-AC13: the grant envelope hashes with the Batch 1 primitive", () => {
  const result = grant();
  assert.equal(
    result.grant_hash,
    hashEnvelope(makeEnvelope("platform/capability-grant", 1, result.body as unknown as CanonicalObject)),
  );
});

test("B5-AC19: enforcement copies the manifest value and is never promoted by policy", () => {
  const reduced = runtime({
    capability_enforcement: uniformEnforcement("AVAILABLE_WITH_REDUCED_ASSURANCE", "NOT_YET_AUDITED"),
  });
  const result = grant({ runtime_manifest: reduced });

  assert.equal(result.body.enforcement["repository.feature_write"], "AVAILABLE_WITH_REDUCED_ASSURANCE");
  assert.equal(result.body.enforcement["repository.canonical_write"], "NOT_YET_AUDITED");
  for (const capability of CAPABILITY_NAMES) {
    const expected = result.body.requested[capability]
      ? reduced.body.capability_enforcement[capability].allow
      : reduced.body.capability_enforcement[capability].deny;
    assert.equal(result.body.enforcement[capability], expected);
  }
});

test("B5-AC8: the view is a required input whose contents do not change the grant", () => {
  const wide = grant({
    task_contract_capability_view: {
      repository_scope: { allowed_paths: ["src/", "docs/"], forbidden_paths: [] },
    },
  });
  const narrow = grant({
    task_contract_capability_view: {
      repository_scope: { allowed_paths: [], forbidden_paths: ["src/"] },
    },
  });

  assert.equal(wide.grant_hash, narrow.grant_hash);
  assert.deepEqual(wide.body, narrow.body);
  assert.equal(wide.grant_hash, grant().grant_hash);
});

test("B5-AC8: the Broker input type requires the capability view", () => {
  // A call without the view does not type-check; the runtime shape stays a plain required field.
  const complete: Parameters<typeof issueCapabilityGrant>[0] = {
    grant_id: ULID_A,
    role: "ACTOR",
    effective_policy: policy(),
    runtime_manifest: runtime(),
    task_contract_capability_view: defaultView,
  };
  assert.deepEqual(Object.keys(complete).sort(), [
    "effective_policy",
    "grant_id",
    "role",
    "runtime_manifest",
    "task_contract_capability_view",
  ]);

  const source = readFileSync(
    join(dirname(dirname(fileURLToPath(import.meta.url))), "core/capability/broker.ts"),
    "utf8",
  );
  assert.match(source, /readonly task_contract_capability_view: TaskContractCapabilityView;/);
  assert.equal(/task_contract_capability_view\?:/.test(source), false);
});
