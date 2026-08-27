/**
 * B5-AC16 ~ B5-AC21 — CapabilityEnforcementReceipt pure validation (TD §12.6 R1–R8, M0-19).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { issueCapabilityGrant } from "../core/capability/broker.ts";
import { validateEnforcementReceipt } from "../core/capability/receipt.ts";
import { validateManifest } from "../core/capability/validate-manifest.ts";
import { validateExecutionPolicy } from "../core/profile/validate-execution-policy.ts";
import type {
  CapabilityRequirementMap,
  RuntimeManifestBody,
  ValidatedManifest,
} from "../core/capability/types.ts";
import type {
  CapabilityEnforcementReceipt,
  RuntimeSessionHandle,
  RuntimeSpawnResult,
} from "../adapters/interfaces/index.ts";
import { validExecutionPolicy } from "./support/profile-fixtures.ts";
import {
  ULID_A,
  runtimeManifest,
  uniformApplied,
  uniformEnforcement,
} from "./support/capability-fixtures.ts";

const opaque = <T>(label: string): T => ({ label }) as unknown as T;
const SESSION = opaque<RuntimeSessionHandle>("session");
const OTHER_SESSION = opaque<RuntimeSessionHandle>("other");

const runtime = (overrides: Record<string, unknown> = {}): ValidatedManifest<RuntimeManifestBody> => {
  const manifest = runtimeManifest();
  manifest["body"] = { ...(manifest["body"] as Record<string, unknown>), ...overrides };
  return validateManifest(manifest) as ValidatedManifest<RuntimeManifestBody>;
};

const policy = validateExecutionPolicy(validExecutionPolicy());

const setup = (manifestOverrides: Record<string, unknown> = {}) => {
  const manifest = runtime(manifestOverrides);
  const issued = issueCapabilityGrant({
    grant_id: ULID_A,
    role: "ACTOR",
    effective_policy: policy,
    runtime_manifest: manifest,
    task_contract_capability_view: {
      repository_scope: { allowed_paths: ["src/"], forbidden_paths: [] },
    },
  });
  return { manifest, issued };
};

const receiptFor = (
  issued: ReturnType<typeof issueCapabilityGrant>,
  manifest: ValidatedManifest<RuntimeManifestBody>,
  overrides: Partial<CapabilityEnforcementReceipt> = {},
): CapabilityEnforcementReceipt => ({
  receipt_id: "01JQ8ZK5T7RC9V2W4X6Y8Z0ABE",
  grant_hash: issued.grant_hash,
  backend_manifest_hash: manifest.hash,
  session_handle: SESSION,
  applied: issued.body.enforcement,
  applied_means: ["boundary-a", "boundary-b"],
  issued_at: "t1",
  ...overrides,
});

const spawn = (receipt?: CapabilityEnforcementReceipt): RuntimeSpawnResult =>
  receipt === undefined
    ? { session_handle: SESSION }
    : { session_handle: SESSION, enforcement_receipt: receipt };

const validate = (
  manifest: ValidatedManifest<RuntimeManifestBody>,
  issued: ReturnType<typeof issueCapabilityGrant>,
  spawn_result: RuntimeSpawnResult,
  extra: { expected?: string; requirements?: CapabilityRequirementMap } = {},
) =>
  validateEnforcementReceipt({
    runtime_manifest: manifest.body,
    spawn_result,
    grant: issued.body,
    grant_hash: issued.grant_hash,
    expected_runtime_manifest_hash: extra.expected ?? manifest.hash,
    ...(extra.requirements ? { requirements: extra.requirements } : {}),
  });

const failsWith = (result: ReturnType<typeof validate>, reason: string): void => {
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, reason);
};

// --- B5-AC16 presence --------------------------------------------------------------

test("B5-AC16: receipt_supported=true with a valid receipt passes", () => {
  const { manifest, issued } = setup();
  assert.deepEqual(validate(manifest, issued, spawn(receiptFor(issued, manifest))), { valid: true });
});

test("B5-AC16: receipt_supported=true with no receipt fails", () => {
  const { manifest, issued } = setup();
  failsWith(validate(manifest, issued, spawn()), "RECEIPT_MISSING");
});

test("B5-AC16: receipt_supported=false with no receipt is a conforming result", () => {
  const { manifest, issued } = setup({ receipt_supported: false });
  assert.deepEqual(validate(manifest, issued, spawn()), { valid: true });
});

test("B5-AC16: receipt_supported=false with a receipt present fails", () => {
  const { manifest, issued } = setup({ receipt_supported: false });
  failsWith(validate(manifest, issued, spawn(receiptFor(issued, manifest))), "RECEIPT_UNEXPECTED");
});

// --- B5-AC17 chain -----------------------------------------------------------------

test("B5-AC17: session handle, grant hash and manifest hash must all bind", () => {
  const { manifest, issued } = setup();

  failsWith(
    validate(manifest, issued, spawn(receiptFor(issued, manifest, { session_handle: OTHER_SESSION }))),
    "SESSION_HANDLE_MISMATCH",
  );
  failsWith(
    validate(
      manifest,
      issued,
      spawn(receiptFor(issued, manifest, { grant_hash: `sha256:${"1".repeat(64)}` })),
    ),
    "GRANT_HASH_MISMATCH",
  );
  failsWith(
    validate(
      manifest,
      issued,
      spawn(receiptFor(issued, manifest, { backend_manifest_hash: `sha256:${"2".repeat(64)}` })),
    ),
    "MANIFEST_HASH_MISMATCH",
  );
});

test("B5-AC17: the expected task runtime manifest hash is part of the chain", () => {
  const { manifest, issued } = setup();
  failsWith(
    validate(manifest, issued, spawn(receiptFor(issued, manifest)), {
      expected: `sha256:${"3".repeat(64)}`,
    }),
    "MANIFEST_HASH_MISMATCH",
  );
});

// --- B5-AC18 / B5-AC19 applied -----------------------------------------------------

test("B5-AC18: applied must be the complete twelve-capability map", () => {
  const { manifest, issued } = setup();

  const missing = { ...issued.body.enforcement } as Record<string, unknown>;
  delete missing["shell.execute"];
  failsWith(
    validate(manifest, issued, spawn(receiptFor(issued, manifest, { applied: missing as never }))),
    "APPLIED_INCOMPLETE",
  );

  const unknown = { ...issued.body.enforcement, "repository.deploy": "ENFORCED" };
  failsWith(
    validate(manifest, issued, spawn(receiptFor(issued, manifest, { applied: unknown as never }))),
    "APPLIED_INVALID",
  );

  const badValue = { ...issued.body.enforcement, "shell.execute": "TOTALLY_SAFE" };
  failsWith(
    validate(manifest, issued, spawn(receiptFor(issued, manifest, { applied: badValue as never }))),
    "APPLIED_INVALID",
  );
});

test("B5-AC19: applied must equal the granted enforcement exactly", () => {
  const { manifest, issued } = setup();
  const downgraded = { ...issued.body.enforcement, "repository.feature_write": "NOT_YET_AUDITED" };

  const result = validate(
    manifest,
    issued,
    spawn(receiptFor(issued, manifest, { applied: downgraded as never })),
  );
  failsWith(result, "ENFORCEMENT_MISMATCH");
  if (!result.valid) assert.equal(result.capability, "repository.feature_write");
});

test("B5-AC19: a 'stronger' applied value is still a mismatch — no ranking exists", () => {
  const { manifest, issued } = setup({
    capability_enforcement: uniformEnforcement(
      "AVAILABLE_WITH_REDUCED_ASSURANCE",
      "AVAILABLE_WITH_REDUCED_ASSURANCE",
    ),
  });

  failsWith(
    validate(
      manifest,
      issued,
      spawn(receiptFor(issued, manifest, { applied: uniformApplied("ENFORCED") as never })),
    ),
    "ENFORCEMENT_MISMATCH",
  );
});

// --- B5-AC20 optional requirements --------------------------------------------------

test("B5-AC20: selected operation requirements are checked when supplied", () => {
  const { manifest, issued } = setup();
  const receipt = receiptFor(issued, manifest);

  assert.deepEqual(
    validate(manifest, issued, spawn(receipt), {
      requirements: { "repository.read": { accepted: ["ENFORCED"] } },
    }),
    { valid: true },
  );

  failsWith(
    validate(manifest, issued, spawn(receipt), {
      requirements: { "repository.read": { accepted: ["NOT_YET_AUDITED"] } },
    }),
    "REQUIREMENT_NOT_MET",
  );

  // Omitting requirements skips R8 entirely.
  assert.deepEqual(validate(manifest, issued, spawn(receipt)), { valid: true });
});

// --- M0-19 / B5-AC21 -----------------------------------------------------------------

test("M0-19: receipt_supported=false runs no compatibility logic", () => {
  const { manifest, issued } = setup({ receipt_supported: false });

  // Even with requirements supplied, an absent receipt is simply conforming.
  assert.deepEqual(
    validate(manifest, issued, spawn(), {
      requirements: { "repository.read": { accepted: ["NOT_YET_AUDITED"] } },
    }),
    { valid: true },
  );
});

test("M0-19: accepted=[ENFORCED] does not implicitly require a receipt", () => {
  const { manifest, issued } = setup({ receipt_supported: false });
  assert.deepEqual(
    validate(manifest, issued, spawn(), {
      requirements: { "repository.read": { accepted: ["ENFORCED"] } },
    }),
    { valid: true },
  );
});

test("B5-AC21: applied_means is carried but never interpreted", () => {
  const { manifest, issued } = setup();
  const withMeans = receiptFor(issued, manifest, { applied_means: ["anything", "at", "all"] });
  const withoutMeans = receiptFor(issued, manifest, { applied_means: [] });

  assert.deepEqual(validate(manifest, issued, spawn(withMeans)), { valid: true });
  assert.deepEqual(validate(manifest, issued, spawn(withoutMeans)), { valid: true });
});
