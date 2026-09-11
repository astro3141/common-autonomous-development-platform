/**
 * Gate-machinery classification (merge-authority safety). A delegated AGENT_DECISION may auto-merge
 * ordinary changes, but a candidate touching the machinery that FORMS the gate must route to a
 * HUMAN_DECISION. These are the pure rules the merge driver enforces before sealing an agent decision.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { comparedChangedPaths, touchesGateMachinery, GATE_PATH_RULES } from "../../product/gateFiles.ts";
import { parseTestsExecuted, VERIFIER_TEST_ARGV } from "../../product/surfaceBroker.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

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
    // The conformance half of the test corpus: control tests, the traceability manifest and the
    // meta-test that guards the directory. Protected to prevent WEAKENING OF THE TD ASSURANCE
    // BOUNDARY — these tests are the executable assurance projection of TD authority.
    "cadp/tests/conformance/conformance-observability.test.ts",
    "cadp/tests/conformance/manifest.ts",
    "cadp/tests/conformance/conformance-manifest.test.ts",
    // The external verifier's pinned invocation, and the changed-path/merge classification the
    // delegated-merge path consumes.
    ".github/workflows/cadp-verify.yml",
    "cadp/live/ctl.ts",
  ];
  for (const p of gate) {
    assert.deepEqual(touchesGateMachinery([p]), [p], `${p} must be gate-flagged`);
  }
});

test("GF2: ordinary product/doc changes are NOT gate-flagged (delegable)", () => {
  for (const p of ["README.md", "src/stats.mjs", "cadp/product/recordService.ts", "docs/whatever.md", "cadp/clients/kernelClient.ts"]) {
    assert.deepEqual(touchesGateMachinery([p]), [], `${p} must be delegable`);
  }
  // The OPERATIONAL half of the test corpus is deliberately delegable: it asserts operational
  // contracts only (prompt shapes, provider argv snapshots, timeout budgets, effort rendering), and
  // devharness/tests/ is an operational harness suite. Both still RUN in both verifiers — the
  // conformance/ops split changes what a delegated agent may merge, never what gets executed.
  for (const p of ["cadp/tests/ops/conformance-timeout.test.ts", "cadp/tests/ops/conformance-brokerprompt.test.ts", "devharness/tests/lifecycle.test.ts"]) {
    assert.deepEqual(touchesGateMachinery([p]), [], `${p} must stay delegable`);
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
    const constitutional = rule === "Authority order.md" || rule.endsWith("*") || rule.startsWith(".github/");
    assert.ok(rule.startsWith("cadp/") || rule.startsWith("**/") || constitutional, `rule ${rule} should be a cadp path, a reviewer-instruction basename, or a constitutional-doc rule`);
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

test("GF7: a protected→ordinary RENAME trips the gate through its previous_filename (with guard-bite)", () => {
  // The compare payload of the exact dangerous move: a protected conformance control test is
  // RENAMED into the unprotected ops directory. GitHub reports a rename with only the NEW path in
  // `filename`; the old, protected path lives in `previous_filename`.
  const compare = [
    {
      filename: "cadp/tests/ops/conformance-gatefiles.test.ts",
      previous_filename: "cadp/tests/conformance/conformance-gatefiles.test.ts",
      status: "renamed",
    },
    { filename: "README.md", previous_filename: null, status: "modified" },
  ];

  const collected = comparedChangedPaths(compare);
  assert.ok(
    collected.includes("cadp/tests/conformance/conformance-gatefiles.test.ts"),
    "the pre-rename path must be collected — a rename is a change at BOTH names",
  );
  assert.deepEqual(
    touchesGateMachinery(collected),
    ["cadp/tests/conformance/conformance-gatefiles.test.ts"],
    "moving a control test out of the protected directory is GATE-TOUCHING: it must route to a HUMAN_DECISION",
  );

  // GUARD-BITE: with the union collection reverted to `filename` alone — the pre-repair behaviour —
  // the identical payload classifies as ORDINARY, i.e. a delegated AGENT_DECISION could auto-merge
  // a candidate that just removed a conformance control from protection. That is the hole the
  // union closes, so the guard is load-bearing rather than defence-in-depth.
  const filenameOnly = compare.map((f) => f.filename);
  assert.deepEqual(
    touchesGateMachinery(filenameOnly),
    [],
    "guard-bite: filename-only collection must reproduce the prohibited ORDINARY classification",
  );

  // The union is a union, not a replacement: a rename INTO a protected path, and an ordinary
  // rename between two delegable paths, keep their honest classifications, and duplicates collapse.
  assert.deepEqual(
    touchesGateMachinery(comparedChangedPaths([{ filename: "cadp/tests/conformance/x.test.ts", previous_filename: "cadp/tests/ops/x.test.ts" }])),
    ["cadp/tests/conformance/x.test.ts"],
  );
  assert.deepEqual(touchesGateMachinery(comparedChangedPaths([{ filename: "docs/b.md", previous_filename: "docs/a.md" }])), []);
  assert.deepEqual(comparedChangedPaths([{ filename: "README.md", previous_filename: "README.md" }]), ["README.md"]);
});

test("GF8: both verifier sites pin the SAME test invocation, and `npm test` is no longer a verifier seam", () => {
  // (a) The LOCAL verifier's argv, pinned in the gate-protected broker. Bare `node --test`: no
  // positional selectors, no glob characters, no --test-* pattern flag. Directory positionals were
  // MEASURED BROKEN for .ts discovery on the container's Node 22 (they run the directory as one
  // failing pseudo-test), so discovery is recursive-from-cwd and the SET is pinned by the
  // conformance meta-test (MT2/MT4) plus gate protection, not by a selector.
  assert.deepEqual([...VERIFIER_TEST_ARGV], ["node", "--test"], "the local verifier argv is the pinned bare invocation");
  for (const token of VERIFIER_TEST_ARGV) {
    assert.ok(!/[*?[\]]/u.test(token), `verifier argv token ${token} must contain no glob character`);
    assert.ok(!token.startsWith("--test-"), `verifier argv token ${token} must not be a --test-* pattern flag`);
  }

  // (b) The EXTERNAL verifier runs the byte-identical invocation (modulo the yml's own quoting).
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/cadp-verify.yml"), "utf8");
  const lines = workflow.split("\n").map((l) => l.trim()).filter((l) => !l.startsWith("#"));
  const invocations = lines.filter((l) => /(?:^|\s)node --test(?:\s|$)/u.test(l));
  assert.equal(invocations.length, 1, "the workflow must carry exactly one test invocation");
  const tokens = invocations[0]!.split("|")[0]!.trim().split(/\s+/u).filter((t) => t !== "2>&1");
  assert.deepEqual(tokens, [...VERIFIER_TEST_ARGV], "the external verifier argv must equal the local verifier argv token for token");

  // (c) Neither verifier reaches the test set through the npm-script indirection any more. The
  // script stays as a developer convenience — package.json is an ordinary, delegable file, which is
  // exactly why no verifier may depend on it.
  assert.ok(!lines.some((l) => /^-?\s*run:\s*npm test\s*$/u.test(l)), "the workflow must not run `npm test`");
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["test"], "node --test", "the developer-convenience script stays, and is not what either verifier runs");

  // (d) The external site carries the zero-test guard too (its verifier-side twin is asserted
  // below): node's own exit code does NOT fail a zero-discovery run.
  assert.ok(workflow.includes("# tests [1-9][0-9]*"), "the workflow must assert a NONZERO test count from the run summary");
});

test("GF8b: the zero-test guard's summary parser reads real `node --test` output — zero is never success", () => {
  // Real captured output, Node 22 (the container runtime), non-TTY: a run that discovered NO test
  // files prints this and EXITS 0. Exit status alone cannot distinguish it from a passing suite,
  // which is why the /verify path parses the count and answers UNKNOWN(NO_TESTS_EXECUTED).
  const zero = [
    "TAP version 13",
    "1..0",
    "# tests 0",
    "# suites 0",
    "# pass 0",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 6.756166",
    "",
  ].join("\n");
  assert.equal(parseTestsExecuted(zero), 0, "a zero-discovery run reports 0 executed tests");

  // Real captured output of an ordinary run of this very file.
  const nonzero = [
    "1..6",
    "# tests 6",
    "# suites 0",
    "# pass 4",
    "# fail 2",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 82.449709",
    "",
  ].join("\n");
  assert.equal(parseTestsExecuted(nonzero), 6, "a real run reports its executed count");

  // The spec reporter's rendering of the same line (an interactive/TTY run) parses identically.
  assert.equal(parseTestsExecuted("ℹ tests 12\nℹ pass 12\n"), 12);

  // A crashed runner that printed no summary is UNPARSEABLE — the caller must not read it as a
  // pass either, and `# tests` must not be confused with the other summary rows.
  assert.equal(parseTestsExecuted("node: bad option --test\n"), undefined);
  assert.equal(parseTestsExecuted(""), undefined);
  assert.equal(parseTestsExecuted("# pass 7\n# fail 0\n"), undefined);
});
