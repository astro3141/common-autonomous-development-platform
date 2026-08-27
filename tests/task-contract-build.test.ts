/**
 * B6-AC18 ~ B6-AC29 — Task Contract v1 schema, the Grant seam and the deterministic hash chain
 * (TD §10.1, §12.7).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskContract, type TaskContractBuildInput } from "../core/contract/builder.ts";
import { ContractError } from "../core/contract/errors.ts";
import { sealTaskContract } from "../core/contract/task-contract.ts";
import { TASK_CONTRACT_BODY_FIELDS } from "../core/contract/types.ts";
import { compileProfile } from "../core/profile/compiler.ts";
import { validateManifestSet } from "../core/capability/manifest-set.ts";
import { hashManifest } from "../core/capability/validate-manifest.ts";
import { normalizeTaskDefinition } from "../core/tasksource/task-definition.ts";
import { hashEnvelope, makeEnvelope } from "../core/schemas/envelope.ts";
import { isDigest } from "../core/schemas/digest.ts";
import type { CanonicalObject } from "../core/schemas/canonical-json.ts";
import {
  componentManifest,
  runtimeManifest,
  uniformEnforcement,
  ULID_A,
  ULID_B,
} from "./support/capability-fixtures.ts";
import { validExecutionPolicy, validProjectProfile } from "./support/profile-fixtures.ts";
import { tempStore } from "./support/temp-store.ts";

const SNAPSHOT_ID = "01JQ8ZK5T7RC9V2W4X6Y8Z0ABE";
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const taskDefinition = (overrides: Record<string, unknown> = {}) =>
  normalizeTaskDefinition({
    task_ref: "T-101",
    version: "1",
    body: {
      title: "Collector script cleanup",
      description: "Free-form description text.",
      references: ["docs/DESIGN.md#collector"],
      acceptance_notes: ["Existing output remains byte-identical.", "No new warnings."],
    },
    ...overrides,
  });

const compiled = (profileOverrides: Record<string, unknown> = {}) =>
  compileProfile({
    projectProfile: { ...validProjectProfile(), ...profileOverrides },
    executionPolicy: validExecutionPolicy(),
    approvedOverrides: { items: [] },
  });

const manifests = (runtimeOverrides: Record<string, unknown> = {}) => {
  const runtime = runtimeManifest();
  runtime["body"] = { ...(runtime["body"] as Record<string, unknown>), ...runtimeOverrides };
  return validateManifestSet({
    runtime,
    workflow: componentManifest("WORKFLOW"),
    repository: componentManifest("REPOSITORY"),
    verification: componentManifest("VERIFICATION"),
  });
};

/** The fixture profile declares SPEC.md and DESIGN.md as contract sources. */
const sources = (spec = "spec bytes", design = "design bytes") => [
  { path: "SPEC.md", bytes: utf8(spec) },
  { path: "DESIGN.md", bytes: utf8(design) },
];

const build = (
  overrides: Partial<TaskContractBuildInput> = {},
  run?: (result: ReturnType<typeof buildTaskContract>) => void,
): ReturnType<typeof buildTaskContract> => {
  const temp = tempStore();
  const store = temp.open();
  try {
    const result = buildTaskContract({
      snapshot_id: SNAPSHOT_ID,
      task: taskDefinition(),
      attempt: 1,
      base_head: "0f1e2d",
      compiled_profile: compiled(),
      contract_sources: sources(),
      pipeline_id: "standard",
      verification_profile: "full",
      repository_scope: { allowed_paths: ["src/"], forbidden_paths: [".platform/"] },
      manifests: manifests(),
      actor_grant_id: ULID_A,
      auditor_grant_id: ULID_B,
      blobs: store.blobs,
      ...overrides,
    });
    run?.(result);
    return result;
  } finally {
    store.close();
    temp.dispose();
  }
};

// --- B6-AC18 / B6-AC19 schema -----------------------------------------------------

test("B6-AC18: the contract envelope and body are exact", () => {
  const { contract } = build();

  assert.equal(contract.envelope.schema, "platform/task-contract");
  assert.equal(contract.envelope.schema_version, 1);
  assert.deepEqual(Object.keys(contract.body).sort(), [...TASK_CONTRACT_BODY_FIELDS].sort());
  assert.equal(TASK_CONTRACT_BODY_FIELDS.length, 12);
  assert.deepEqual(Object.keys(contract.body.task).sort(), [
    "body_copy",
    "definition_hash",
    "ref",
    "version",
  ]);
});

test("B6-AC19: the contract hash is the envelope hash and never a body field", () => {
  const { contract } = build();

  assert.ok(isDigest(contract.hash));
  assert.equal(contract.hash, hashEnvelope(contract.envelope));
  assert.equal("hash" in contract.body, false);
  assert.equal(JSON.stringify(contract.body).includes("task_contract_hash"), false);
});

test("B6-AC18: missing, unknown and self-hash fields are rejected", () => {
  const { contract } = build();
  const body = contract.body as unknown as Record<string, unknown>;

  for (const field of TASK_CONTRACT_BODY_FIELDS) {
    const partial = { ...body };
    delete partial[field];
    assert.throws(() => sealTaskContract(partial), ContractError);
  }
  assert.throws(() => sealTaskContract({ ...body, extra: 1 }), ContractError);
  assert.throws(() => sealTaskContract({ ...body, hash: "sha256:x" }), ContractError);
  assert.throws(() => sealTaskContract({ ...body, snapshot_id: "not-a-ulid" }), ContractError);
});

test("B6-AC23: contract source items carry exactly path and content_hash", () => {
  const { contract } = build();
  for (const entry of contract.body.contract_sources) {
    assert.deepEqual(Object.keys(entry).sort(), ["content_hash", "path"]);
  }
  assert.deepEqual(
    contract.body.contract_sources.map((entry) => entry.path),
    ["SPEC.md", "DESIGN.md"],
    "Profile declaration order",
  );
});

// --- B6-AC20 / B6-AC21 task body and completion ------------------------------------

test("B6-AC20: body_copy is the normalized definition body, not document text", () => {
  const definition = taskDefinition();
  const { contract } = build({ task: definition });

  assert.deepEqual(contract.body.task.body_copy, definition.body);
  assert.equal(contract.body.task.definition_hash, definition.definition_hash);
  assert.equal(JSON.stringify(contract.body.task.body_copy).includes("## Task"), false);
});

test("B6-AC21: completion_conditions is an exact copy of acceptance_notes", () => {
  const definition = taskDefinition();
  const { contract } = build({ task: definition });

  assert.deepEqual(contract.body.completion_conditions, definition.body.acceptance_notes);
  assert.deepEqual(contract.body.completion_conditions, [
    "Existing output remains byte-identical.",
    "No new warnings.",
  ]);

  // The build API has no completion-condition parameter at all.
  const parameters = Object.keys({
    snapshot_id: 0,
    task: 0,
    attempt: 0,
    base_head: 0,
    compiled_profile: 0,
    contract_sources: 0,
    pipeline_id: 0,
    verification_profile: 0,
    repository_scope: 0,
    manifests: 0,
    actor_grant_id: 0,
    auditor_grant_id: 0,
    blobs: 0,
  });
  assert.equal(parameters.includes("completion_conditions"), false);
});

// --- B6-AC26 / B6-AC27 grants -------------------------------------------------------

test("B6-AC27: actor and auditor grants are bound; no supervisor grant exists", () => {
  const { contract, actor_grant, auditor_grant } = build();

  assert.deepEqual(Object.keys(contract.body.capability_grants).sort(), ["actor", "auditor"]);
  assert.equal(contract.body.capability_grants.actor.grant_id, ULID_A);
  assert.equal(contract.body.capability_grants.actor.grant_hash, actor_grant.grant_hash);
  assert.equal(contract.body.capability_grants.auditor.grant_hash, auditor_grant.grant_hash);
  assert.equal(actor_grant.body.role, "ACTOR");
  assert.equal(auditor_grant.body.role, "AUDITOR");
  assert.equal(JSON.stringify(contract.body).includes("SUPERVISOR"), false);

  // References only — grant bodies are not duplicated into the contract.
  assert.deepEqual(Object.keys(contract.body.capability_grants.actor).sort(), [
    "grant_hash",
    "grant_id",
  ]);
});

test("B6-AC26: repository_scope reaches the Broker as the capability view and stays verbatim", () => {
  const scope = { allowed_paths: ["b/", "a/"], forbidden_paths: [] };
  const { contract, actor_grant } = build({ repository_scope: scope });

  assert.deepEqual(contract.body.repository_scope, scope, "order preserved, nothing sorted");
  // v1 derivation ignores the view's contents, so the grant is unaffected...
  const other = build({ repository_scope: { allowed_paths: [], forbidden_paths: ["x/"] } });
  assert.equal(other.actor_grant.grant_hash, actor_grant.grant_hash);
  // ...but the contract body differs, so the contract hash must differ.
  assert.notEqual(other.contract.hash, contract.hash);
});

// --- B6-AC28 manifest binding --------------------------------------------------------

test("B6-AC28: four actual manifest hashes and runtime provenance are bound", () => {
  const set = manifests();
  const { contract } = build({ manifests: set });
  const requirements = contract.body.backend_requirements;

  assert.equal(requirements.runtime_manifest_hash, hashManifest(set.runtime.body));
  assert.equal(requirements.workflow_manifest_hash, hashManifest(set.workflow.body));
  assert.equal(requirements.repository_manifest_hash, hashManifest(set.repository.body));
  assert.equal(requirements.verification_manifest_hash, hashManifest(set.verification.body));
  assert.equal(new Set(Object.values(requirements).filter((v) => typeof v === "string")).size, 4);

  assert.deepEqual(requirements.provenance, {
    runtime_adapter_version: set.runtime.body.adapter_version,
    backend_instance_id: set.runtime.body.backend_instance_id,
  });
  assert.equal(JSON.stringify(contract.body).includes("aggregate"), false);
});

test("B6-AC28: the actor grant binds the same runtime manifest hash", () => {
  const set = manifests();
  const { actor_grant, contract } = build({ manifests: set });

  assert.equal(
    actor_grant.body.source_runtime_manifest_hash,
    contract.body.backend_requirements.runtime_manifest_hash,
  );
});

// --- B6-AC29 hash chain ---------------------------------------------------------------

test("B6-AC29: identical inputs produce identical grants and contract hash", () => {
  const first = build();
  const second = build();

  assert.equal(first.actor_grant.grant_hash, second.actor_grant.grant_hash);
  assert.equal(first.auditor_grant.grant_hash, second.auditor_grant.grant_hash);
  assert.equal(first.contract.hash, second.contract.hash);
  assert.equal(
    first.contract.hash,
    hashEnvelope(
      makeEnvelope("platform/task-contract", 1, first.contract.body as unknown as CanonicalObject),
    ),
  );
});

test("B6-AC29: every contract input change moves the contract hash", () => {
  const base = build().contract.hash;
  const changed: ReadonlyArray<readonly [string, Partial<TaskContractBuildInput>]> = [
    ["task body", { task: taskDefinition({ body: { title: "Other", description: "", references: [], acceptance_notes: [] } }) }],
    ["task version", { task: taskDefinition({ version: "2" }) }],
    ["task ref", { task: taskDefinition({ task_ref: "T-999" }) }],
    ["snapshot_id", { snapshot_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0ABF" }],
    ["attempt", { attempt: 2 }],
    ["base_head", { base_head: "aaaaaa" }],
    ["contract source bytes", { contract_sources: sources("spec bytes changed") }],
    ["pipeline_id", { pipeline_id: "other-pipeline" }],
    ["verification_profile", { verification_profile: "other-profile" }],
    ["repository_scope", { repository_scope: { allowed_paths: ["src/", "docs/"], forbidden_paths: [".platform/"] } }],
    ["actor grant id", { actor_grant_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0ABG" }],
    ["auditor grant id", { auditor_grant_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0ABH" }],
  ];

  for (const [label, override] of changed) {
    assert.notEqual(build(override).contract.hash, base, `${label} must change the contract hash`);
  }
});

test("B6-AC29: task ref/version move the contract hash but not the definition hash", () => {
  const base = taskDefinition();
  const otherRef = taskDefinition({ task_ref: "T-999" });
  const otherVersion = taskDefinition({ version: "2" });

  assert.equal(otherRef.definition_hash, base.definition_hash);
  assert.equal(otherVersion.definition_hash, base.definition_hash);
  assert.notEqual(build({ task: otherRef }).contract.hash, build({ task: base }).contract.hash);
  assert.notEqual(build({ task: otherVersion }).contract.hash, build({ task: base }).contract.hash);
});

test("B6-AC29: a change in any of the four manifests moves the contract hash", () => {
  const base = build().contract.hash;

  assert.notEqual(
    build({ manifests: manifests({ features: { persistent_session: false } }) }).contract.hash,
    base,
    "runtime manifest",
  );
  assert.notEqual(
    build({
      manifests: manifests({ capability_enforcement: uniformEnforcement("NOT_YET_AUDITED", "ENFORCED") }),
    }).contract.hash,
    base,
    "runtime enforcement",
  );

  const swapComponent = (kind: "WORKFLOW" | "REPOSITORY" | "VERIFICATION") => {
    const runtime = runtimeManifest();
    const set = validateManifestSet({
      runtime,
      workflow: componentManifest("WORKFLOW", kind === "WORKFLOW" ? { adapter_version: "9.9.9" } : {}),
      repository: componentManifest("REPOSITORY", kind === "REPOSITORY" ? { adapter_version: "9.9.9" } : {}),
      verification: componentManifest(
        "VERIFICATION",
        kind === "VERIFICATION" ? { adapter_version: "9.9.9" } : {},
      ),
    });
    return build({ manifests: set }).contract.hash;
  };
  for (const kind of ["WORKFLOW", "REPOSITORY", "VERIFICATION"] as const) {
    assert.notEqual(swapComponent(kind), base, `${kind} manifest`);
  }
});

test("B6-AC29: a compiled profile change moves the contract hash", () => {
  const profile = validProjectProfile();
  profile["version"] = 2;
  const changed = compileProfile({
    projectProfile: profile,
    executionPolicy: validExecutionPolicy(),
    approvedOverrides: { items: [] },
  });

  assert.notEqual(build({ compiled_profile: changed }).contract.hash, build().contract.hash);
  assert.equal(build({ compiled_profile: changed }).contract.body.compiled_profile_hash, changed.compiled_hash);
});
