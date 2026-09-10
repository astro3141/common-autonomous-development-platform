/**
 * Gate-machinery classification (merge-authority safety). A delegated AGENT_DECISION may auto-merge
 * ordinary changes, but a candidate touching the machinery that FORMS the gate must route to a
 * HUMAN_DECISION. These are the pure rules the merge driver enforces before sealing an agent decision.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { touchesGateMachinery, GATE_PATH_RULES } from "../../product/gateFiles.ts";
import { VERIFIER_NODE_MAJOR, VERIFIER_TEST_ARGV, VERIFIER_TEST_DIRS } from "../../product/surfaceBroker.ts";

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
    "cadp/tests/conformance/conformance-observability.test.ts",
    "cadp/tests/conformance/manifest.ts",
    "cadp/tests/conformance/conformance-manifest.test.ts",
    "cadp/tests/conformance/support/harness.ts",
    ".github/workflows/cadp-verify.yml",
  ];
  for (const p of gate) {
    assert.deepEqual(touchesGateMachinery([p]), [p], `${p} must be gate-flagged`);
  }
});

test("GF2: ordinary product/doc changes are NOT gate-flagged (delegable)", () => {
  for (const p of [
    "README.md", "src/stats.mjs", "cadp/product/recordService.ts", "docs/whatever.md", "cadp/clients/kernelClient.ts",
    // The narrowing: operational-contract tests and the standalone bootstrap harness stay
    // delegable. Weakening one loses a regression, not an assurance boundary — and both still RUN
    // in both verifiers (GF8), so the split changed protection, not execution coverage.
    "cadp/tests/ops/conformance-timeout.test.ts",
    "cadp/tests/ops/conformance-workproviders.test.ts",
    "devharness/tests/lifecycle.test.ts",
  ]) {
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
    const constitutional = rule === "Authority order.md" || rule.endsWith("*") || rule === ".github/" || rule === ".github/workflows/cadp-verify.yml";
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

test("GF7: the narrowing is exact — conformance/ protected, ops/ delegable, the external verifier's workflow named once", () => {
  // Conformance tests are not authority themselves: they are the EXECUTABLE ASSURANCE PROJECTION
  // of TD authority, protected to PREVENT WEAKENING OF THE TD ASSURANCE BOUNDARY. That is a claim
  // about the conformance directory, so the blanket rule that also swept the operational suites
  // is gone and the narrower one is present.
  assert.ok(!GATE_PATH_RULES.includes("cadp/tests/"), "the blanket cadp/tests/ rule is replaced by the conformance-directory rule");
  assert.ok(GATE_PATH_RULES.includes("cadp/tests/conformance/"), "the conformance directory is gate machinery");
  // The external verifier's invocation is verification machinery in its own right.
  assert.ok(GATE_PATH_RULES.includes(".github/workflows/cadp-verify.yml"), "the external verifier's workflow is named");
  // Named once, never twice: `touchesGateMachinery` reports each PATH once, so a duplicated rule
  // would be invisible here — assert over the rule list itself.
  for (const rule of ["cadp/product/surfaceBroker.ts", "cadp/tests/conformance/", ".github/workflows/cadp-verify.yml"]) {
    assert.equal(GATE_PATH_RULES.filter((r) => r === rule).length, 1, `${rule} must appear exactly once in GATE_PATH_RULES`);
  }
  // The whole conformance directory, its manifest, its meta-test and the harness they run on.
  for (const p of [
    "cadp/tests/conformance/conformance-runorigin.test.ts",
    "cadp/tests/conformance/manifest.ts",
    "cadp/tests/conformance/conformance-manifest.test.ts",
    "cadp/tests/conformance/support/scriptedGitHub.ts",
  ]) {
    assert.deepEqual(touchesGateMachinery([p]), [p], `${p} must be gate-flagged (HUMAN merge)`);
  }
});

test("GF8: both verifiers run the SAME pinned invocation on the SAME pinned runtime, and running it really executes all three suites", (t) => {
  // The selection-bypass seam: a test must not be evadable by EXCLUSION-WITHOUT-MODIFICATION.
  // While `npm test` was the verifier's command, the executed set was whatever package.json — an
  // ordinary delegable file — said it was. The set is pinned in gate-protected files instead.
  assert.deepEqual(
    [...VERIFIER_TEST_ARGV],
    ["node", "--test", "cadp/tests/conformance/", "cadp/tests/ops/", "devharness/tests/"],
    "the local verifier's argv is `--test` plus the three leaf directory paths, verbatim",
  );
  // The EXACT selector form, not merely an equivalent selection: directory paths with trailing
  // slashes, no glob character for anything to expand, and no `--test-*` pattern flag standing in
  // for a path. A form that happens to select the same files today is a different contract.
  for (const token of VERIFIER_TEST_ARGV.slice(2)) {
    assert.ok(token.endsWith("/"), `${token} must be a directory path with a trailing slash`);
    assert.equal(/[*?[\]]/u.test(token), false, `${token} must contain no glob character`);
  }
  assert.deepEqual(VERIFIER_TEST_ARGV.filter((token) => token.startsWith("--")), ["--test"], "the only flag is --test");
  assert.deepEqual([...VERIFIER_TEST_ARGV.slice(2)], [...VERIFIER_TEST_DIRS], "the selectors ARE the three leaf directories");

  // The EXTERNAL verifier runs the identical command, and no longer `npm test`. Byte-identical to
  // the local argv: the yml `run` line's tokens are the pinned tokens, nothing quoted, nothing
  // left for the runner's shell to expand.
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/cadp-verify.yml"), "utf8");
  const pinned = VERIFIER_TEST_ARGV.join(" ");
  assert.ok(workflow.includes(`- run: ${pinned}\n`), `the external verifier must run the pinned invocation:\n  ${pinned}`);
  assert.equal(/^\s*-\s*run:\s*npm\s+test\s*$/mu.test(workflow), false, "npm test is a developer convenience, never a verifier's seam");
  const runLine = /^\s*-\s*run:\s*(node\s+--test.*)$/mu.exec(workflow);
  assert.ok(runLine !== null, "the external verifier must run a node --test invocation");
  assert.deepEqual(runLine[1]!.split(/\s+/u), [...VERIFIER_TEST_ARGV], "the workflow's tokens are the local verifier's tokens");

  // THE RUNTIME HALF OF THE PIN. A selector that names directories selects nothing on a Node whose
  // test runner does not expand a directory positional, so pinning the argv without pinning the
  // runtime leaves `/verify` able to report a verdict about suites it never ran. Both verifier
  // sites therefore DECLARE the runtime, and the two declarations are read here — from the LOCAL
  // verifier's container image (the image `runVerifier` runs) and from the EXTERNAL verifier's
  // `actions/setup-node` step — and required to be the one `VERIFIER_NODE_MAJOR` pins. This is the
  // assertion the argv snapshot cannot make: it is about the runtimes the VERIFIERS use, not about
  // whichever runtime happens to be hosting this suite.
  const dockerfile = readFileSync(join(REPO_ROOT, "cadp/live/image/Dockerfile"), "utf8");
  const baseTag = /^FROM node:(\d+)-/mu.exec(dockerfile);
  assert.ok(baseTag !== null, "the local verifier's image must pin an explicit node:<major> base tag");
  assert.equal(
    Number(baseTag[1]),
    VERIFIER_NODE_MAJOR,
    `cadp/live/image/Dockerfile is the LOCAL verifier's runtime; it must be node:${VERIFIER_NODE_MAJOR} (measured: Node 22 selects none of the pinned directories)`,
  );
  const setupNode = /^\s*node-version:\s*"(\d+)"\s*$/mu.exec(workflow);
  assert.ok(setupNode !== null, "the external verifier must pin an explicit setup-node major");
  assert.equal(Number(setupNode[1]), VERIFIER_NODE_MAJOR, `the EXTERNAL verifier must run the pinned runtime (Node ${VERIFIER_NODE_MAJOR})`);

  // The invocation contract in the repository as it stands: each named directory really does hold
  // test files DIRECTLY (conformance-manifest.test.ts MF4 asserts the converse — that none live
  // anywhere else, so no recursion is needed to reach one).
  for (const dir of VERIFIER_TEST_DIRS) {
    const direct = readdirSync(join(REPO_ROOT, dir)).filter((f) => f.endsWith(".test.ts"));
    assert.ok(direct.length > 0, `${dir} must hold test files directly; the pinned selector found none`);
  }

  // EXECUTE it. An invocation that discovers nothing is the exact failure this control exists to
  // catch — it would let `/verify` report a verdict about a suite it never ran — so snapshotting
  // the argv is not enough. Run the REAL form against a minimal fixture with the same three-leaf
  // layout, on the runtime hosting this suite, and read the runner's own summary counts. When the
  // suite runs where it MATTERS — inside the verifier container during a self-hosted `/verify`, or
  // in the external verifier's job — the hosting runtime IS the pinned one and this measurement is
  // taken on the verifier itself.
  const base = mkdtempSync(join(tmpdir(), "cadp-gf8-"));
  try {
    for (const dir of VERIFIER_TEST_DIRS) {
      mkdirSync(join(base, dir), { recursive: true });
      writeFileSync(join(base, dir, "probe.test.ts"), `import test from "node:test";\ntest(${JSON.stringify(`probe:${dir}`)}, () => {});\n`);
    }
    // argv[0] is the node binary the verifier container resolves from PATH; everything after it is
    // the pinned argv verbatim.
    assert.equal(VERIFIER_TEST_ARGV[0], "node");
    // The verifier runs this argv in a fresh container, not inside a test run. `NODE_TEST_CONTEXT`
    // is how the runner tells a child process it is already a test worker ("run() is being called
    // recursively ... skipping running files"), so it is dropped here to reproduce the verifier's
    // own environment; everything else is inherited.
    const env = { ...process.env };
    delete env["NODE_TEST_CONTEXT"];
    const runCounts = (args: readonly string[]): { tests: number; pass: number; fail: number; output: string } => {
      const r = spawnSync(process.execPath, [...args], { cwd: base, encoding: "utf8", env });
      const output = `${r.stdout}${r.stderr}`;
      const count = (label: string): number => {
        // The runner's own summary counts, under either reporter Node picks by default (`# tests
        // N` from the tap reporter when stdout is not a TTY, `ℹ tests N` from the spec reporter),
        // so the assertion reads the real run rather than a reporter choice.
        const m = new RegExp(`^(?:#|ℹ) ${label} (\\d+)$`, "mu").exec(r.stdout);
        assert.ok(m !== null, `the runner reported no "# ${label}" summary for ${args.join(" ")}:\n${output}`);
        return Number(m[1]);
      };
      return { tests: count("tests"), pass: count("pass"), fail: count("fail"), output };
    };
    // A directory positional is only expanded into the test files it holds by a runtime whose test
    // runner SEARCHES directory arguments; one that does not treats the token as a module to load
    // and runs nothing. Name that in the failure, because the difference is invisible in the argv.
    const ranHere = (selector: string, r: { tests: number; pass: number; fail: number; output: string }): string =>
      `${selector} did not run its tests on the PINNED verifier runtime (Node ${process.versions.node}, major ` +
      `${VERIFIER_NODE_MAJOR} pinned): tests ${r.tests}, pass ${r.pass}, fail ${r.fail}. The pinned form needs a Node ` +
      `whose test runner searches directory arguments; this one does not expand the directory at all, so both ` +
      `verifiers would return verdicts about suites they never ran.\n${r.output}`;

    // Every suite, on its own — each selector taken FROM the pinned argv, so the control follows
    // the argv rather than a restatement of it — and then the whole pinned argv in one run, with
    // all three suites present and none silently dropped.
    const selectors = VERIFIER_TEST_ARGV.slice(2);
    const selected = selectors.map((selector) => runCounts(["--test", selector]));
    const all = runCounts(VERIFIER_TEST_ARGV.slice(1));
    const ran = (r: { tests: number; pass: number; fail: number }): boolean => r.tests > 0 && r.fail === 0 && r.pass === r.tests;

    // The measurement is REPORTED on every runtime this suite is hosted on, and REQUIRED on the
    // pinned one. A host below the pinned major is not a verifier — the two declarations asserted
    // above say what the verifiers run — and it is measured here rather than assumed: Node 22 is
    // where the directory positional was measured to select nothing, which is why the runtime is
    // pinned at all. At or above the pin, selecting nothing is a hard failure.
    const hostMajor = Number(process.versions.node.split(".")[0]);
    t.diagnostic(
      `pinned argv measured on Node ${process.versions.node} (verifiers pin major ${VERIFIER_NODE_MAJOR}): ` +
        `${selectors.map((s, i) => `${s} → ${selected[i]!.pass}/${selected[i]!.tests}`).join(", ")}; all three in one run → ${all.pass}/${all.tests}`,
    );
    // Two claims hold on EVERY runtime, so neither branch below is vacuous. (i) The combined argv
    // selects exactly the suites the individual selectors select: a suite that runs on its own but
    // vanishes from the three-directory run would be a silent drop — the seam this control closes.
    // (ii) All-or-nothing: a runtime that selects a PROPER SUBSET is the worst case of all, since
    // the verifier would then pass on a partial suite and call it a verdict.
    const selectedCount = selected.filter(ran).length;
    assert.equal(all.pass, selectedCount, `the combined pinned argv ran ${all.pass} suites but the selectors run individually ran ${selectedCount} — a suite is dropped by the combined form\n${all.output}`);
    assert.ok(
      selectedCount === 0 || selectedCount === selectors.length,
      `the pinned argv selected ${selectedCount} of ${selectors.length} suites on Node ${process.versions.node} — a partial selection would let a verifier pass on part of the suite and call it a verdict\n${all.output}`,
    );
    if (hostMajor >= VERIFIER_NODE_MAJOR) {
      for (const [i, only] of selected.entries()) assert.ok(ran(only), ranHere(selectors[i]!, only));
      assert.ok(all.tests === selectors.length && all.pass === selectors.length && all.fail === 0, ranHere(pinned, all));
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
