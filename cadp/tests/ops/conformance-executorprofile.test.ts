/**
 * OPERATIONAL mechanics of `executor_profile_payload.v1` — the per-provider preimage snapshot behind
 * `executor_profile_digest` (Execution Plane TD B1(1)). These are PROFILE SNAPSHOTS, so they live in
 * `cadp/tests/ops/`, not in the gate-protected conformance directory: the CONTRACT legs (closed key
 * sets at every level, typed digests, array-order sensitivity, the malformed-request refusals) are
 * asserted by `cadp/tests/conformance/conformance-execution-request.test.ts`.
 *
 *   P1  THE DRIFT GUARD. `EXECUTOR_PROFILE_KEYS` must COVER every key every live registry entry
 *       declares. It is the one failure mode that is silent and total: a profile interface that
 *       gains a key without this table gaining it makes every request of that role MALFORMED, and
 *       the broker then refuses every run of that surface. (This is not hypothetical — the reviewer
 *       interface gained `can_read_workspace` in #259 P0a, after the TD pinned its enumeration.)
 *   P2  the per-provider payload digests, pinned, so a profile edit is visible as a digest move
 *       rather than as a silently different execution identity
 *   P3  determinism: the same entry digests equal on every call, and the payload is a fresh copy
 *   P4  DESCRIPTORS ONLY — no credential material is in any preimage
 */

import assert from "node:assert/strict";
import test from "node:test";

import { EXECUTOR_PROFILE_KEYS, executorProfileDigest, executorProfilePayload } from "../../product/executionContract.ts";
import type { SurfaceRole } from "../../product/executionContract.ts";
import { WORKER_PROVIDERS } from "../../product/workerProviders.ts";
import { REVIEW_PROVIDERS } from "../../product/reviewProviders.ts";
import { PLAN_PROVIDERS } from "../../product/planProviders.ts";

const REGISTRIES: ReadonlyArray<readonly [SurfaceRole, Record<string, Record<string, unknown>>]> = [
  ["WORKER", WORKER_PROVIDERS],
  ["REVIEWER", REVIEW_PROVIDERS],
  ["PLANNER", PLAN_PROVIDERS],
];

test("P1: the declared closed key set COVERS every key every live registry entry carries", () => {
  for (const [role, registry] of REGISTRIES) {
    const declared = new Set([...EXECUTOR_PROFILE_KEYS[role].required, ...EXECUTOR_PROFILE_KEYS[role].optional]);
    for (const [provider, profile] of Object.entries(registry)) {
      for (const key of Object.keys(profile)) {
        assert.ok(
          declared.has(key),
          `${role}/${provider} declares "${key}", which EXECUTOR_PROFILE_KEYS.${role} does not admit — add it in the same edit that adds the profile key, or every ${role} execution request becomes malformed and the broker refuses every ${role} run`,
        );
      }
      for (const key of EXECUTOR_PROFILE_KEYS[role].required) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(profile, key),
          `${role}/${provider} is missing required profile key "${key}"`,
        );
      }
    }
  }
});

test("P2: the per-provider payload digests are pinned — a profile edit must MOVE one visibly", () => {
  const PINNED: ReadonlyArray<{ readonly role: SurfaceRole; readonly provider: string; readonly value: string }> = [
    { role: "WORKER", provider: "codex", value: "60dc0c968477dddbeb1209aba93215022a4341de4c59c53b64c57bda57409bd0" },
    { role: "WORKER", provider: "grok", value: "3abaaba9fcca0586ac9cf91bd6225b135b9a05ea8099acfa623018c9ff57f455" },
    { role: "WORKER", provider: "claude", value: "fad8c10a77a8bc34cf319b3bda8969a2943122cf094fc51c45a4e275cffdb81b" },
    { role: "REVIEWER", provider: "claude", value: "0126b3d185490bc6b76f92cecacdda8abad6d861de5ff82c346ed74f9ef078f1" },
    { role: "REVIEWER", provider: "grok", value: "0656382117a0690f0e9ed62bb2ffcdf9eff89743a816b50c2d94e87a60dabae7" },
    { role: "REVIEWER", provider: "codex", value: "76c7e295ba4d78b25890206f9555d5aec44e0d0f7b857650f7d97d93619b7dde" },
    { role: "PLANNER", provider: "claude", value: "e757ca5688b5e8dec404091ae46c5275b80b06776e9158492a62fc973f234592" },
    { role: "PLANNER", provider: "grok", value: "1a6fe4047d118580af84ad7e1c368565839f0a7f148668f774dc0a20cc64c01f" },
    { role: "PLANNER", provider: "codex", value: "49d86c52648a8edceec42b38c52d7c07d4aa59f69db6974f67dabcaab0df3db1" },
  ];
  // Every live entry is pinned; a NEW provider must arrive with its own pin.
  const covered = new Set(PINNED.map((p) => `${p.role}/${p.provider}`));
  for (const [role, registry] of REGISTRIES) {
    for (const provider of Object.keys(registry)) {
      assert.ok(covered.has(`${role}/${provider}`), `${role}/${provider} has no pinned payload digest — add one`);
    }
  }
  for (const { role, provider, value } of PINNED) {
    const registry = REGISTRIES.find(([r]) => r === role)![1];
    assert.equal(
      executorProfileDigest(role, registry[provider]!).value,
      value,
      `${role}/${provider} profile digest moved — if the profile change is intended, re-pin this value in the same edit`,
    );
  }
  // The three roles' preimages are genuinely distinct objects even for one provider name: a codex
  // worker and a codex reviewer are different executor profiles.
  assert.notEqual(executorProfileDigest("WORKER", WORKER_PROVIDERS.codex).value, executorProfileDigest("REVIEWER", REVIEW_PROVIDERS.codex).value);
  assert.notEqual(executorProfileDigest("REVIEWER", REVIEW_PROVIDERS.codex).value, executorProfileDigest("PLANNER", PLAN_PROVIDERS.codex).value);
});

test("P3: the payload is deterministic and is a fresh copy, never the live registry object", () => {
  for (const [role, registry] of REGISTRIES) {
    for (const profile of Object.values(registry)) {
      assert.equal(executorProfileDigest(role, profile).value, executorProfileDigest(role, profile).value);
      const payload = executorProfilePayload(role, profile);
      assert.notEqual(payload, profile, "the payload must not alias the registry entry");
      assert.notEqual(payload["argv_template"], profile["argv_template"], "arrays are copied, so a mutation cannot reach the registry");
      // Mutating the payload cannot move the registry's own digest.
      const before = executorProfileDigest(role, profile).value;
      (payload["argv_template"] as string[]).push("--injected");
      assert.equal(executorProfileDigest(role, profile).value, before);
    }
  }
});

test("P4: the preimage names WHERE auth comes from and carries no credential", () => {
  const forbidden = ["token", "secret", "credential", "password", "api_key", "oauth_token"];
  for (const [role, registry] of REGISTRIES) {
    for (const [provider, profile] of Object.entries(registry)) {
      const serialized = JSON.stringify(executorProfilePayload(role, profile));
      for (const needle of forbidden) {
        assert.ok(!serialized.toLowerCase().includes(`"${needle}"`), `${role}/${provider} payload carries a "${needle}" key`);
      }
      // The descriptors themselves ARE in the preimage — that is the point: they name the source.
      const payload = executorProfilePayload(role, profile);
      const describesAuth =
        Object.prototype.hasOwnProperty.call(payload, "auth_method") ||
        Object.prototype.hasOwnProperty.call(payload, "auth_subdir") ||
        Object.prototype.hasOwnProperty.call(payload, "auth_env");
      assert.ok(describesAuth, `${role}/${provider} payload must carry its auth DESCRIPTOR`);
    }
  }
});
