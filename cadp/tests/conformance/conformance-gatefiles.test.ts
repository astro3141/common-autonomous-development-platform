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
import { VERIFIER_TEST_ARGV, VERIFIER_TEST_DIRS } from "../../product/surfaceBroker.ts";

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

test("GF8: both verifiers run the SAME pinned invocation, and running it really executes all three suites", () => {
  // The selection-bypass seam: a test must not be evadable by EXCLUSION-WITHOUT-MODIFICATION.
  // While `npm test` was the verifier's command, the executed set was whatever package.json — an
  // ordinary delegable file — said it was. The set is pinned in gate-protected files instead.
  assert.deepEqual(
    [...VERIFIER_TEST_ARGV],
    ["node", "--test", "cadp/tests/conformance/*.test.ts", "cadp/tests/ops/*.test.ts", "devharness/tests/*.test.ts"],
    "the local verifier's argv names the three leaf directories explicitly",
  );

  // The EXTERNAL verifier runs the identical command, and no longer `npm test`. The selectors are
  // quoted in the workflow so NODE expands them (as it does locally), never the runner's shell.
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/cadp-verify.yml"), "utf8");
  const pinned = `node --test ${VERIFIER_TEST_ARGV.slice(2).map((s) => `'${s}'`).join(" ")}`;
  assert.ok(workflow.includes(`- run: ${pinned}`), `the external verifier must run the pinned invocation:\n  ${pinned}`);
  assert.equal(/^\s*-\s*run:\s*npm\s+test\s*$/mu.test(workflow), false, "npm test is a developer convenience, never a verifier's seam");

  // SAME RUNTIME, not just the same argv. `node --test <selector>` semantics are major-dependent
  // (bare directories only became a directory search on Node 24), so an argv proven on one major
  // proves nothing about the other. The runtime the LOCAL verifier spawns is the pinned surface
  // image; the external verifier's `setup-node` must name that same major, or the two verifiers
  // are attesting to different discovery semantics.
  const dockerfile = readFileSync(join(REPO_ROOT, "cadp/live/image/Dockerfile"), "utf8");
  const from = /^FROM (node:(\d+)-\S+)$/mu.exec(dockerfile);
  assert.ok(from !== null, "the verifier image must pin a node:<major>-<variant> base");
  const [, IMAGE_TAG, IMAGE_MAJOR] = from as unknown as [string, string, string];
  const setupNode = /^\s*node-version:\s*"(\d+)"\s*$/mu.exec(workflow);
  assert.ok(setupNode !== null, "the external verifier must pin an explicit node-version");
  assert.equal(setupNode[1], IMAGE_MAJOR, `the Actions runner must run the verifier image's Node major (${IMAGE_TAG})`);

  // The invocation contract in the repository as it stands: each named directory really does hold
  // test files DIRECTLY (conformance-manifest.test.ts MF4 asserts the converse — that none live
  // anywhere else).
  for (const dir of VERIFIER_TEST_DIRS) {
    const direct = readdirSync(join(REPO_ROOT, dir)).filter((f) => f.endsWith(".test.ts"));
    assert.ok(direct.length > 0, `${dir}*.test.ts must select real files; the pinned selector found none`);
  }

  // EXECUTE it. An argv that silently discovers nothing is the exact failure this control exists
  // to catch (`node --test <bare dir>` on the verifier image's Node 22 is not a directory search —
  // it dies ERR_MODULE_NOT_FOUND), so snapshotting the argv is not enough: run the real form
  // against a minimal fixture with the same three-leaf layout and read the runner's own counts.
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
    // ON THE VERIFIER IMAGE'S RUNTIME. `process.execPath` is only the right binary when this suite
    // is ITSELF running the image's major (the verifier container, and a developer host that
    // matches it); anywhere else — an Actions runner or a dev host on another major — the leg must
    // execute inside the pinned image, or it measures a runtime the verifier never uses. Neither
    // reachable => FAIL CLOSED: a control that silently proves nothing is the failure mode this
    // whole test exists to catch.
    const onImageRuntime = process.versions.node.split(".")[0] === IMAGE_MAJOR;
    const dockerOk = !onImageRuntime && spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;
    assert.ok(
      onImageRuntime || dockerOk,
      `GF8 must execute the pinned argv on the verifier image's runtime (${IMAGE_TAG}): this process is Node ` +
        `${process.versions.node} and docker is unavailable to run the image. Use Node ${IMAGE_MAJOR} or provide docker.`,
    );
    const runCounts = (args: readonly string[]): { tests: number; pass: number; fail: number } => {
      const r = onImageRuntime
        ? spawnSync(process.execPath, [...args], { cwd: base, encoding: "utf8", env })
        : spawnSync("docker", ["run", "--rm", "-v", `${base}:/gf8`, "-w", "/gf8", IMAGE_TAG, "node", ...args], { encoding: "utf8" });
      const count = (label: string): number => {
        // The runner's own summary counts, under either reporter Node picks by default (`# tests
        // N` from the tap reporter when stdout is not a TTY, `ℹ tests N` from the spec reporter),
        // so the assertion reads the real run rather than a reporter choice.
        const m = new RegExp(`^(?:#|ℹ) ${label} (\\d+)$`, "mu").exec(r.stdout);
        assert.ok(m !== null, `the runner reported no "# ${label}" summary for ${args.join(" ")}:\n${r.stdout}\n${r.stderr}`);
        return Number(m[1]);
      };
      return { tests: count("tests"), pass: count("pass"), fail: count("fail") };
    };

    // Every suite, on its own — each selector taken FROM the pinned argv, so the control follows
    // the argv rather than a restatement of it: a NONZERO number of tests actually ran for each.
    const selectors = VERIFIER_TEST_ARGV.slice(2);
    for (const selector of selectors) {
      const only = runCounts(["--test", selector]);
      assert.ok(only.tests > 0, `${selector} discovered no test at all`);
      assert.equal(only.pass, only.tests, `${selector} must run its tests, not error on them`);
      assert.equal(only.fail, 0);
    }
    // And the whole pinned argv: all three suites in one run, none silently dropped.
    const all = runCounts(VERIFIER_TEST_ARGV.slice(1));
    assert.equal(all.tests, selectors.length, "the pinned invocation must execute every named suite");
    assert.equal(all.pass, selectors.length);
    assert.equal(all.fail, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
