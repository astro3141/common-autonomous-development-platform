/**
 * Gate-machinery classification (merge-authority safety). A delegated AGENT_DECISION may auto-merge
 * ordinary changes, but a candidate touching the machinery that FORMS the gate must route to a
 * HUMAN_DECISION. These are the pure rules the merge driver enforces before sealing an agent decision.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { touchesGateMachinery, GATE_PATH_RULES } from "../../product/gateFiles.ts";
import { VERIFIER_TEST_ARGV, testsExecuted } from "../../product/surfaceBroker.ts";

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
    "cadp/tests/conformance/conformance-observability.test.ts",
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
    // The external verifier's workflow file is named exactly, as verification machinery in its own
    // right — it is not covered by this shape family, so it is admitted by name.
    const constitutional = rule === "Authority order.md" || rule.endsWith("*") || rule === ".github/";
    const verifierMachinery = rule === ".github/workflows/cadp-verify.yml";
    assert.ok(rule.startsWith("cadp/") || rule.startsWith("**/") || constitutional || verifierMachinery, `rule ${rule} should be a cadp path, a reviewer-instruction basename, the external verifier workflow, or a constitutional-doc rule`);
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

test("GF7: the test-protection boundary is the CONFORMANCE half — ops runs, but does not force a Human merge", () => {
  // Conformance tests are not authority; they are the executable assurance projection of TD
  // authority, and they are protected so that projection cannot be WEAKENED. Everything inside the
  // directory carries that protection: the suites, the traceability manifest, the meta-test that
  // makes the manifest self-falsifying, and the shared kernel harness they all run against.
  for (const p of [
    "cadp/tests/conformance/conformance-runorigin.test.ts",
    "cadp/tests/conformance/conformance-gatefiles.test.ts",
    "cadp/tests/conformance/kernel-chain.test.ts",
    "cadp/tests/conformance/manifest.ts",
    "cadp/tests/conformance/conformance-manifest.test.ts",
    "cadp/tests/conformance/support/harness.ts",
  ]) {
    assert.deepEqual(touchesGateMachinery([p]), [p], `${p} must be gate-flagged (HUMAN merge)`);
  }
  // The operational half is deliberately delegable: an argv snapshot, a prompt shape or a retention
  // convenience may change on an ordinary merge. It still RUNS in both verifiers — the split
  // changes protection, never execution coverage (see conformance-manifest.test.ts MT4).
  for (const p of [
    "cadp/tests/ops/conformance-workproviders.test.ts",
    "cadp/tests/ops/conformance-timeout.test.ts",
    "cadp/tests/ops/conformance-sessions.test.ts",
    "devharness/tests/lifecycle.test.ts",
  ]) {
    assert.deepEqual(touchesGateMachinery([p]), [], `${p} must stay delegable`);
  }
  // The narrowing is real: the old blanket rule is gone, and the two new rules are present by name.
  assert.equal(GATE_PATH_RULES.includes("cadp/tests/"), false, "the blanket cadp/tests/ rule must be replaced, not kept alongside the narrowed one");
  assert.ok(GATE_PATH_RULES.includes("cadp/tests/conformance/"), "the conformance directory must be gate machinery");
  assert.ok(GATE_PATH_RULES.includes(".github/workflows/cadp-verify.yml"), "the external verifier's invocation must be gate machinery by name");
  assert.equal(GATE_PATH_RULES.filter((r) => r === "cadp/product/surfaceBroker.ts").length, 1, "the local verifier's file was already listed — confirm, never duplicate");
});

/**
 * GF8: the PROTECTED INVOCATION, at both verifier sites.
 *
 * The selection-bypass seam this closes: a test that is never SELECTED is as absent as a test that
 * was deleted, and de-selecting one changes no test file at all. So the invocation itself is pinned
 * in protected files — the broker's argv here, the workflow's run line in the gate-flagged yml — and
 * neither goes through the npm-script indirection (package.json is not gate machinery).
 *
 * The pinned form is BARE `node --test`: on the container's Node 22, directory positionals were
 * MEASURED to discover nothing for .ts files (they resolve as a module entry point and report a
 * failing pseudo-test), while recursive default discovery runs every suite. What pins the discovered
 * SET is therefore not a selector but conformance-manifest.test.ts MT4 (no *.test.ts outside the
 * three enumerated directories) plus the broker's zero-test guard, whose parser is unit-tested here
 * against REAL captured summaries — no nested execution of the suite inside the suite.
 */
const WORKFLOW_YML = fileURLToPath(new URL("../../../.github/workflows/cadp-verify.yml", import.meta.url));

test("GF8-1: both verifier sites invoke node DIRECTLY with the identical bare argv — no npm script, no selector", () => {
  assert.deepEqual([...VERIFIER_TEST_ARGV], ["node", "--test"], "the local verifier argv is pinned verbatim");

  const yml = readFileSync(WORKFLOW_YML, "utf8");
  const invocation = yml.split("\n").map((l) => l.trim()).filter((l) => !l.startsWith("#")).find((l) => l.startsWith("node "));
  assert.ok(invocation !== undefined, "the workflow must invoke node itself");
  // Tokens before any shell plumbing (the tee that lets the zero-discovery guard read the summary).
  const tokens = invocation.split("|")[0]?.trim().split(/\s+/u) ?? [];
  assert.deepEqual(tokens, [...VERIFIER_TEST_ARGV], "the external verifier argv must be byte-identical to the local one");
  for (const token of tokens) {
    assert.equal(/[*?[\]]/u.test(token), false, `selector token ${token} must contain no glob characters`);
    assert.equal(token.startsWith("--test-"), false, `${token} must not be a --test-* pattern flag`);
  }
  assert.equal(/^\s*-\s*run:\s*npm test\s*$/mu.test(yml), false, "the external verifier must not run through the npm script indirection");
  assert.ok(yml.includes("tests [1-9][0-9]*"), "the external verifier must assert a NONZERO test count from the run summary");
});

test("GF8-2: the zero-test guard reads real node --test summaries — zero and unparseable can never be success", () => {
  // Captured verbatim from Node v22.23.2. A zero-discovery run EXITS 0, so only the summary betrays it.
  const zeroTap = "TAP version 13\n1..0\n# tests 0\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 6.917125\n";
  const greenTap = "TAP version 13\n# Subtest: GF1\nok 1 - GF1\n1..6\n# tests 6\n# suites 0\n# pass 6\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 74.151833\n";
  const zeroSpec = "ℹ tests 0\nℹ suites 0\nℹ pass 0\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 9.464542\n";
  const greenSpec = "✔ a (0.4ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 101.385917\n";

  assert.equal(testsExecuted(zeroTap), 0, "a zero-discovery tap run reports zero executed tests");
  assert.equal(testsExecuted(zeroSpec), 0, "a zero-discovery spec run reports zero executed tests");
  assert.equal(testsExecuted(greenTap), 6, "a real tap run reports its executed count");
  assert.equal(testsExecuted(greenSpec), 1, "a real spec run reports its executed count");
  // No summary at all (container died, image missing, output truncated) is not a verdict either.
  for (const nothing of ["", "docker: command not found\n", "TAP version 13\n"]) {
    assert.equal(testsExecuted(nothing), undefined, "a summary-less run is unparseable, never a count");
  }
  // The candidate's own echoed output must not be able to spoof the count: the LAST summary wins.
  assert.equal(testsExecuted(`# tests 999\n${zeroTap}`), 0, "an earlier embedded summary never overrides the run's own");
});
