/**
 * Gate-machinery classification (merge-authority safety). A delegated AGENT_DECISION may auto-merge
 * ordinary changes, but a candidate touching the machinery that FORMS the gate must route to a
 * HUMAN_DECISION. These are the pure rules the merge driver enforces before sealing an agent decision.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { touchesGateMachinery, GATE_PATH_RULES } from "../../product/gateFiles.ts";
import { VERIFIER_TEST_ARGV, VERIFIER_TEST_DIRS } from "../../product/surfaceBroker.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

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
    // The conformance half of the test corpus, whole-directory: the tests, the traceability
    // manifest, its meta-test, and the shared fixtures they all run through.
    "cadp/tests/conformance/conformance-observability.test.ts",
    "cadp/tests/conformance/manifest.ts",
    "cadp/tests/conformance/conformance-manifest.test.ts",
    "cadp/tests/conformance/support/harness.ts",
    // The external verifier's invocation: it decides which tests actually run, exactly as the
    // local verifier's argv in surfaceBroker.ts does.
    ".github/workflows/cadp-verify.yml",
  ];
  for (const p of gate) {
    assert.deepEqual(touchesGateMachinery([p]), [p], `${p} must be gate-flagged`);
  }
});

test("GF2: ordinary product/doc changes are NOT gate-flagged (delegable)", () => {
  for (const p of [
    "README.md",
    "src/stats.mjs",
    "cadp/product/recordService.ts",
    "docs/whatever.md",
    "cadp/clients/kernelClient.ts",
    // The operational half of the test corpus. It still RUNS in both verifiers — the split changes
    // protection, never coverage — but prompt shapes, argv snapshots and timeout budgets are
    // ordinary product contracts, not the TD assurance boundary, so they stay delegable.
    "cadp/tests/ops/conformance-timeout.test.ts",
    "cadp/tests/ops/conformance-sessions.test.ts",
  ]) {
    assert.deepEqual(touchesGateMachinery([p]), [], `${p} must be delegable`);
  }
  // The narrowed rule is a real narrowing, asserted as such: the blanket cadp/tests/ prefix is gone.
  assert.equal(GATE_PATH_RULES.includes("cadp/tests/"), false, "the blanket cadp/tests/ rule was replaced by the conformance-only rule");
  assert.ok(GATE_PATH_RULES.includes("cadp/tests/conformance/"), "the conformance directory must be gate machinery");
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
    // The external verifier's invocation is machinery living outside cadp/ — named exactly.
    const externalVerifier = rule === ".github/workflows/cadp-verify.yml";
    assert.ok(rule.startsWith("cadp/") || rule.startsWith("**/") || constitutional || externalVerifier, `rule ${rule} should be a cadp path, a reviewer-instruction basename, the external verifier workflow, or a constitutional-doc rule`);
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

// ------------------------------------------------------------ the protected invocation (GF7/GF8)
//
// The seam these two close: a conformance test must not be evadable by EXCLUSION WITHOUT
// MODIFICATION. Protecting the test files alone leaves the executed SET decided by package.json's
// `test` script — an ordinary, delegable file — so a candidate could narrow the suite while every
// protected test stays byte-identical. Both verifiers therefore enumerate the set by explicit path
// from gate-protected files: cadp/product/surfaceBroker.ts (local) and
// .github/workflows/cadp-verify.yml (external).

/** The pinned five tokens, written out here rather than imported, so drift is a diff and not a tie. */
const PINNED_ARGV = ["node", "--test", "cadp/tests/conformance/", "cadp/tests/ops/", "devharness/tests/"] as const;

test("GF7: both verifier sites pin the SAME explicit invocation, and neither goes through npm test", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github/workflows/cadp-verify.yml"), "utf8");
  const runLines = yml.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- run:")).map((l) => l.slice("- run:".length).trim());

  // The external verifier runs the argv verbatim (modulo the yml's own `- run:` framing).
  const expected = PINNED_ARGV.join(" ");
  assert.ok(runLines.includes(expected), `the workflow must run exactly \`${expected}\`; found ${JSON.stringify(runLines)}`);
  // ...and no longer through the npm script indirection, at either site.
  assert.equal(runLines.some((l) => /\bnpm\s+test\b/u.test(l)), false, "the external verifier must not invoke `npm test` — that indirection is the selection-bypass seam");
  const broker = readFileSync(join(REPO_ROOT, "cadp/product/surfaceBroker.ts"), "utf8");
  assert.equal(/argv:\s*\[\s*"node"\s*,\s*"--test"\s*\]/u.test(broker), false, "the local verifier must not run a bare `node --test` — the executed set must be pinned by explicit path");

  // package.json's script SURVIVES as a developer convenience; it is simply nobody's seam. Both
  // invocation sites say so in a comment — asserted, so the note cannot silently rot away.
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["test"], "node --test", "the developer-convenience script stays (it is not a verifier seam, so it is not pinned)");
  for (const [file, text] of [[".github/workflows/cadp-verify.yml", yml], ["cadp/product/surfaceBroker.ts", broker]] as const) {
    assert.ok(/npm test|`test` script/u.test(text) && /convenience/u.test(text), `${file} must note that package.json's test script is a developer convenience and no verifier's seam`);
  }
});

test("GF8: the pinned argv is exactly five glob-free tokens, and EXECUTING it runs tests in all three suites", () => {
  // Half one — the argv verbatim. Directory paths with trailing slashes; no glob characters, no
  // --test-* pattern flag, no shell. Any other selector form is wrong even if it selects the same
  // files: a matched set can be changed by moving a file, an enumerated set cannot.
  assert.deepEqual([...VERIFIER_TEST_ARGV], [...PINNED_ARGV]);
  assert.deepEqual([...VERIFIER_TEST_DIRS], PINNED_ARGV.slice(2));
  for (const token of VERIFIER_TEST_ARGV) {
    assert.equal(/[*?[\]]/u.test(token), false, `token ${token} carries a glob character — the executed set must be enumerated, not matched`);
    assert.equal(token.startsWith("--test-"), false, `token ${token} is a --test-* pattern flag — those select by match, not by enumeration`);
  }

  // Half two — the argv must actually DISCOVER something. A snapshot of the tokens proves only that
  // the string is stable; it cannot tell a working invocation from one that silently runs nothing.
  // So run it, on this Node, against a minimal three-leaf fixture, and demand a nonzero count from
  // EACH suite. An invocation that discovers nothing fails here deterministically.
  const root = mkdtempSync(join(tmpdir(), "cadp-gf8-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "gf8-fixture", private: true, type: "module" }));
    const legs = VERIFIER_TEST_DIRS.map((dir, i) => {
      const name = `GF8 fixture leg ${i} in ${dir}`;
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "fixture.test.ts"), `import test from "node:test";\ntest(${JSON.stringify(name)}, () => {});\n`);
      return name;
    });

    // The child must be an ORDINARY verifier invocation, not a nested one: `NODE_TEST_CONTEXT` is
    // inherited by anything this suite spawns, and a runner that sees it refuses to discover files
    // at all ("run() is being called recursively"). Stripping it is what makes the child's discovery
    // behaviour the verifier's discovery behaviour.
    const env = { ...process.env };
    delete env["NODE_TEST_CONTEXT"];
    /** Run one selector form against the fixture and report what it actually discovered. */
    const runForm = (label: string, argv: readonly string[]) => {
      const run = spawnSync(process.execPath, [...argv], { cwd: root, encoding: "utf8", timeout: 120_000, env });
      const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      const count = (field: string): number => Number(new RegExp(`^# ${field} (\\d+)$`, "mu").exec(out)?.[1] ?? "-1");
      const found = legs.filter((name) => out.includes(`ok 1 - ${name}`) || out.includes(`- ${name}`));
      return { label, argv, out, found, status: run.status, tests: count("tests"), pass: count("pass"), fail: count("fail") };
    };

    const pinned = runForm("PINNED — the contracted five tokens", VERIFIER_TEST_ARGV.slice(1));
    const healthy = pinned.found.length === legs.length && pinned.tests >= legs.length && pinned.pass === legs.length && pinned.fail === 0 && pinned.status === 0;
    if (!healthy) {
      // The pinned form did not run all three suites on this Node. Per the team lead's routing note,
      // THIS OUTPUT IS THE EVIDENCE: probe the alternatives so the re-route decision is informed
      // (does this Node lack directory discovery entirely, or only recursion?), report, and STOP.
      // Nothing here substitutes a different selector — VERIFIER_TEST_ARGV is not touched.
      const probes = [
        runForm("probe A — bare `node --test` (cwd-recursive discovery, the pre-pin form)", ["--test"]),
        runForm("probe B — glob selectors (NOT the contract; probed only to locate the failure)", ["--test", ...VERIFIER_TEST_DIRS.map((d) => `${d}*.test.ts`)]),
      ];
      const summarise = (r: typeof pinned): string => `${r.label}\n  argv: ${JSON.stringify(["node", ...r.argv])}\n  exit ${r.status} · tests ${r.tests} · pass ${r.pass} · fail ${r.fail} · legs discovered ${r.found.length}/${legs.length}`;
      const report = [
        `local verifier Node: ${process.version} (the surface image — OUT OF SCOPE to change).`,
        `external verifier Node: node-version in .github/workflows/cadp-verify.yml (a different runtime; this leg measures THIS one).`,
        `fixture: ${legs.length} leaf directories, one passing *.test.ts sitting DIRECTLY in each — no nesting, so no recursion is required.`,
        "",
        [pinned, ...probes].map(summarise).join("\n"),
        "",
        `--- pinned invocation output ---\n${pinned.out.slice(0, 4000)}`,
        "",
        "ROUTING: if the pinned form discovers nothing while a probe does, the exact five-token contract is not executable on this Node. Do NOT work around it here — the team lead re-routes.",
      ].join("\n");

      for (const name of legs) {
        assert.ok(pinned.found.includes(name), `the pinned invocation discovered NO test in the suite carrying "${name}".\n${report}`);
      }
      assert.ok(pinned.tests >= legs.length, `expected at least ${legs.length} tests to RUN (one per enumerated directory), got ${pinned.tests}.\n${report}`);
      assert.equal(pinned.pass, legs.length, `expected exactly ${legs.length} passing fixture tests, one discovered per enumerated directory.\n${report}`);
      assert.equal(pinned.fail, 0, `the pinned invocation failed on this Node.\n${report}`);
      assert.equal(pinned.status, 0, `the pinned invocation exited ${pinned.status}.\n${report}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
