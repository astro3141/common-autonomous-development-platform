/**
 * Gate-machinery classification (merge-authority safety). A delegated AGENT_DECISION may auto-merge
 * ordinary changes, but a candidate touching the machinery that FORMS the gate must route to a
 * HUMAN_DECISION. These are the pure rules the merge driver enforces before sealing an agent decision.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { touchesGateMachinery, GATE_PATH_RULES } from "../../product/gateFiles.ts";
import { VERIFIER_TEST_ARGV } from "../../product/surfaceBroker.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("GF1: gate machinery is flagged (kernel, policy, verify/review/model surfaces, conformance suite)", () => {
  const gate = [
    "cadp/kernel/api.ts",
    "cadp/kernel/pep.ts",
    "cadp/deployment/referencePolicy.ts",
    "cadp/product/surfaceBroker.ts",
    "cadp/product/isolation.ts",
    "cadp/product/workerProfile.ts",
    "cadp/product/workerProviders.ts",
    "cadp/product/reviewProviders.ts",
    "cadp/product/planProviders.ts",
    "cadp/product/timeouts.ts",
    "cadp/product/mcp.ts",
    "cadp/product/driver.ts",
    "cadp/live/image/Dockerfile",
    // The conformance directory in full — the suites, the traceability manifest, and the meta-test
    // that makes a dropped or moved mapped test fail deterministically.
    "cadp/tests/conformance/conformance-observability.test.ts",
    "cadp/tests/conformance/manifest.ts",
    "cadp/tests/conformance/conformance-manifest.test.ts",
    // The EXTERNAL verifier's invocation — verification machinery, not merely a workflow file.
    ".github/workflows/cadp-verify.yml",
  ];
  for (const p of gate) {
    assert.deepEqual(touchesGateMachinery([p]), [p], `${p} must be gate-flagged`);
  }
});

test("GF2: ordinary product/doc changes are NOT gate-flagged (delegable)", () => {
  for (const p of ["README.md", "src/stats.mjs", "cadp/product/recordService.ts", "docs/whatever.md", "cadp/clients/kernelClient.ts"]) {
    assert.deepEqual(touchesGateMachinery([p]), [], `${p} must be delegable`);
  }
});

test("GF7: the gate protects cadp/tests/conformance/ ONLY — cadp/tests/ops/ stays delegable", () => {
  // The narrowing is deliberate and is the whole point of the split: a conformance test is the
  // EXECUTABLE ASSURANCE PROJECTION of TD authority and is protected to prevent WEAKENING of the TD
  // assurance boundary; an operational-contract test (argv snapshots, prompt shapes, timeout
  // budgets) carries no such boundary and must not cost a human click to change.
  for (const p of [
    "cadp/tests/conformance/conformance-runorigin.test.ts",
    "cadp/tests/conformance/conformance-gatefiles.test.ts",
    "cadp/tests/conformance/manifest.ts",
  ]) {
    assert.deepEqual(touchesGateMachinery([p]), [p], `${p} must be gate-flagged (HUMAN merge)`);
  }
  for (const p of [
    "cadp/tests/ops/conformance-timeout.test.ts",
    "cadp/tests/ops/conformance-brokerprompt.test.ts",
    "cadp/tests/ops/conformance-workproviders.test.ts",
    "cadp/tests/support/harness.ts",
  ]) {
    assert.deepEqual(touchesGateMachinery([p]), [], `${p} must stay delegable`);
  }
  // The blanket rule is gone; the narrow one is present and the ops directory is not named.
  assert.ok(!GATE_PATH_RULES.includes("cadp/tests/"), "the blanket cadp/tests/ rule must be replaced by the narrowed one");
  assert.ok(GATE_PATH_RULES.includes("cadp/tests/conformance/"), "the conformance directory must be gate-protected in full");
  assert.ok(!GATE_PATH_RULES.includes("cadp/tests/ops/"), "the ops directory must not be gate-protected");
});

test("GF8: BOTH verifiers pin the explicit test path — a control cannot be evaded by exclusion", () => {
  // The selection-bypass seam: leaving a control's file untouched (no diff a reviewer would see)
  // while arranging that the verifier never runs it. `npm test` was that seam, because package.json
  // is an ordinary delegable file. Both verifiers now spawn `node --test` with the explicit path,
  // and both invocation sites are gate machinery.
  assert.deepEqual(VERIFIER_TEST_ARGV, ["node", "--test", "cadp/tests/"], "the local verifier's executed set is pinned by a gate-protected file");
  assert.ok(!VERIFIER_TEST_ARGV.includes("npm"), "the local verifier must never route through the npm script indirection");

  const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "cadp-verify.yml"), "utf8");
  // Quotes are stripped before comparing so a quoted spelling can never diverge from the pinned argv.
  const runSteps = workflow
    .split("\n")
    .filter((line) => /^\s*-\s+run:/u.test(line))
    .map((line) => line.replace(/^\s*-\s+run:\s*/u, "").trim().replaceAll(/['"]/gu, ""));
  assert.ok(
    runSteps.includes(VERIFIER_TEST_ARGV.join(" ")),
    `the external verifier must invoke exactly \`${VERIFIER_TEST_ARGV.join(" ")}\`; its run steps are ${JSON.stringify(runSteps)}`,
  );
  assert.ok(!runSteps.includes("npm test"), "the external verifier must not route through the npm script indirection");

  // ...and the pinned path is the tests ROOT itself: the split changed protection, never coverage.
  const path = VERIFIER_TEST_ARGV[2] ?? "";
  assert.equal(path, "cadp/tests/", "the pinned path must be the bare tests directory, not a glob or a subdirectory");
  for (const dir of ["conformance", "ops"]) {
    assert.ok(!path.includes(dir), `${dir}/ must not be singled out — both directories stay in the executed set`);
  }
});

test("GF3: a mixed candidate is gate-flagged if ANY path is gate machinery", () => {
  const hits = touchesGateMachinery(["README.md", "cadp/kernel/api.ts", "src/x.mjs"]);
  assert.deepEqual(hits, ["cadp/kernel/api.ts"]);
});

test("GF4: the rule file guards itself and every rule is a real repo path shape", () => {
  assert.ok(GATE_PATH_RULES.includes("cadp/product/gateFiles.ts"), "the gate rule must protect itself from delegated edits");
  for (const rule of GATE_PATH_RULES) {
    // Machinery rules live under cadp/; constitutional documents live at the repo root and are
    // named by exact file or a trailing-`*` filename prefix; reviewer-instruction files are named
    // by a leading-`**/` basename rule, since the discovery walk is per-directory.
    const constitutional = rule === "Authority order.md" || rule.endsWith("*") || rule === ".github/";
    // Verification machinery may also live under .github/ — the external verifier's invocation.
    const externalVerifier = rule === ".github/workflows/cadp-verify.yml";
    assert.ok(
      rule.startsWith("cadp/") || rule.startsWith("**/") || constitutional || externalVerifier,
      `rule ${rule} should be a cadp path, a reviewer-instruction basename, the external-verifier workflow, or a constitutional-doc rule`,
    );
  }
});

test("GF6: reviewer-instruction files are gate machinery at any depth — a candidate cannot instruct its reviewer", () => {
  // #259 P0a. A provider CLI loads these automatically from its working directory and its
  // ancestors, so a candidate-authored change to one is a change to the REVIEWER, not to the
  // product: it opens a path to influence merge eligibility, which is the gate test itself.
  for (const p of ["AGENTS.md", "AGENTS.override.md", "cadp/AGENTS.md", "cadp/product/AGENTS.override.md"]) {
    assert.deepEqual(touchesGateMachinery([p]), [p], `${p} must be gate-flagged (HUMAN merge)`);
  }
  // The basename rule matches the FILE, not a prefix of some other name.
  for (const p of ["docs/MYAGENTS.md", "AGENTS.md.bak", "agents.md", "AGENTS.override.md.txt"]) {
    assert.deepEqual(touchesGateMachinery([p]), [], `${p} must stay delegable`);
  }
});

test("GF5: constitutional/design documents route to HUMAN — the design lane cannot self-approve", () => {
  // The Spec, every TD generation, the authority order, and standalone design notes DEFINE the
  // authority boundaries; a delegated agent must never auto-merge an edit to them.
  for (const p of [
    ".github/workflows/cadp-verify.yml",
    "Authority order.md",
    "Common Autonomous Development Platform — Specification v0.4.md",
    "Common Autonomous Development Platform — Specification v0.3.md",
    "Common Autonomous Development Platform — Specification v0.5.md", // future revision, no list edit needed
    "TECHNICAL_DESIGN_cadp_v0_4_generation.md",
    "TECHNICAL_DESIGN_autonomous_development_platform.md",
    "DESIGN_cadp_reclassification_transition_authority.md",
  ]) {
    assert.deepEqual(touchesGateMachinery([p]), [p], `${p} must be gate-flagged (HUMAN merge)`);
  }
  // Ordinary root docs stay delegable — the prefix rules must not swallow them.
  for (const p of ["README.md", "STATUS_common_platform_mvp0.md", "HANDOFF_common_platform_mvp1_live_pilot.md", "PLATFORM_BACKEND_CAPABILITY.md"]) {
    assert.deepEqual(touchesGateMachinery([p]), [], `${p} must stay delegable`);
  }
});
