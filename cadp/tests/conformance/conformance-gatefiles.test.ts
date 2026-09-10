/**
 * Gate-machinery classification (merge-authority safety). A delegated AGENT_DECISION may auto-merge
 * ordinary changes, but a candidate touching the machinery that FORMS the gate must route to a
 * HUMAN_DECISION. These are the pure rules the merge driver enforces before sealing an agent decision.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { touchesGateMachinery, GATE_PATH_RULES } from "../../product/gateFiles.ts";
import { VERIFIER_TEST_ARGV } from "../../product/surfaceBroker.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WORKFLOW = ".github/workflows/cadp-verify.yml";

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

test("GF7: protection is narrowed to conformance/ + the external verifier; ops/ stays delegable", () => {
  // Conformance tests are NOT authority themselves — they are the EXECUTABLE ASSURANCE PROJECTION
  // of TD authority, protected to prevent WEAKENING OF THE TD ASSURANCE BOUNDARY. That is a claim
  // about the conformance suite, its traceability manifest and its meta-test, and about the
  // external verifier's invocation; it is NOT a claim about operational snapshots.
  for (const p of [
    "cadp/tests/conformance/conformance-gatefiles.test.ts",
    "cadp/tests/conformance/kernel-chain.test.ts",
    "cadp/tests/conformance/manifest.ts",
    "cadp/tests/conformance/conformance-manifest.test.ts",
    WORKFLOW,
    "cadp/product/surfaceBroker.ts", // the LOCAL verifier's invocation — already listed, not duplicated
  ]) {
    assert.deepEqual(touchesGateMachinery([p]), [p], `${p} must be gate-flagged (HUMAN merge)`);
  }
  assert.equal(
    GATE_PATH_RULES.filter((r) => r === "cadp/product/surfaceBroker.ts").length,
    1,
    "surfaceBroker.ts is listed exactly once — confirmed, not duplicated",
  );
  assert.ok(!GATE_PATH_RULES.includes("cadp/tests/"), "the blanket cadp/tests/ rule is replaced by the narrowed conformance/ rule");
  assert.ok(GATE_PATH_RULES.includes("cadp/tests/conformance/"), "the whole conformance dir is protected, manifest and meta-test included");
  assert.ok(GATE_PATH_RULES.includes(WORKFLOW), "the external verifier's invocation is verification machinery");

  // ops/ holds operational contracts only; changing one weakens no assurance predicate.
  for (const p of readdirSync(join(REPO_ROOT, "cadp/tests/ops")).map((f) => `cadp/tests/ops/${f}`)) {
    assert.deepEqual(touchesGateMachinery([p]), [], `${p} must stay delegable — ops/ is not gate-protected`);
  }
});

/**
 * The verifier's environment, not this test's. Node marks a test-runner child with
 * `NODE_TEST_CONTEXT`, and a nested `node --test` that sees it refuses to run any file ("called
 * recursively"). The real verifier runs from a clean environment, so the control must too —
 * otherwise it would measure this harness instead of the pinned invocation.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  return env;
}

/** `# pass N` / `# fail N` from a `node --test` TAP summary, or undefined if the run produced none. */
function summaryCount(output: string, key: "tests" | "pass" | "fail"): number | undefined {
  const line = new RegExp(String.raw`^# ${key} (\d+)$`, "mu").exec(output);
  return line === null ? undefined : Number(line[1]);
}

/** The built surface image the broker runs verifier containers as (cadp/live/image/Dockerfile). */
const SURFACE_IMAGE = "cadp-surface:0.151.0-2.1.221";

/**
 * The surface runtime's Node, read from the image definition itself (`FROM node:<major>-...`) so a
 * rebase of the image moves this control with it instead of leaving a stale literal here.
 */
function surfaceNode(): { major: number; base: string } {
  const from = /^FROM (node:(\d+)\S*)$/mu.exec(readFileSync(join(REPO_ROOT, "cadp/live/image/Dockerfile"), "utf8"));
  assert.ok(from !== null, "the surface image must pin a node:<major> base — the verifier's runtime is defined there");
  return { major: Number(from[2]), base: from[1] as string };
}

/**
 * WHERE the pinned invocation gets measured — the surface container's Node, never whatever `node`
 * happens to sit on the ambient PATH. Discovery semantics differ BY MAJOR: on the surface image's
 * Node 22 a bare directory argument to `node --test` is resolved as a module specifier and runs no
 * suite at all, while Node 24 recurses into it. So a run on a host Node measures the host, and a
 * green result there says nothing about what the verifier actually executes. This resolves a runner
 * that IS the surface Node:
 *   • the ambient node, ONLY when its major already IS the image's pin — which is the case inside
 *     the verifier container itself (where this suite really runs: `--network none`, no docker
 *     daemon reachable) and on a matching developer host;
 *   • otherwise a real container on the surface image — the built tag when present, else the base
 *     tag the Dockerfile pins, which is the same Node layer.
 * Neither reachable ⇒ the control FAILS. A control that can only skip when it cannot reach the
 * right runtime reports a pass while proving nothing (the stance conformance-osisolation.test.ts
 * takes for the surface-lifetime probe).
 */
function surfaceRunner(fixture: string): { where: string; run: (argv: readonly string[]) => { status: number | null; output: string } } {
  const surface = surfaceNode();
  if (Number(process.versions.node.split(".")[0]) === surface.major) {
    return {
      where: `ambient node v${process.versions.node} — IS the surface pin (${surface.base})`,
      run: (argv) => {
        const r = spawnSync(argv[0] as string, [...argv.slice(1)], { cwd: fixture, encoding: "utf8", env: cleanEnv(), timeout: 180_000 });
        return { status: r.status, output: `${r.stdout}${r.stderr}` };
      },
    };
  }
  const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 60_000 }).status === 0;
  const image = !hasDocker ? undefined : [SURFACE_IMAGE, surface.base].find((candidate) =>
    spawnSync("docker", ["image", "inspect", candidate], { stdio: "ignore", timeout: 60_000 }).status === 0
    || spawnSync("docker", ["pull", "--quiet", candidate], { stdio: "ignore", timeout: 300_000 }).status === 0);
  assert.ok(
    image !== undefined,
    `cannot measure the SURFACE runtime: ambient node is v${process.versions.node}, the surface image pins ${surface.base}, and no container runtime is available to stand in. Refusing to measure the host's discovery semantics and report them as the verifier's.`,
  );
  return {
    where: `container ${image} — the surface runtime (${surface.base})`,
    run: (argv) => {
      const r = spawnSync("docker", ["run", "--rm", "--network", "none", "-v", `${fixture}:/ws`, "-w", "/ws", image, ...argv], { encoding: "utf8", timeout: 300_000 });
      return { status: r.status, output: `${r.stdout}${r.stderr}` };
    },
  };
}

test("GF8: BOTH verifiers pin the same explicit invocation, and running it actually EXECUTES tests in EVERY named suite", () => {
  // The seam this closes is selection-BYPASS: a test must not be evadable by exclusion without
  // modification. Snapshotting the argv is not enough — an argv that discovers NOTHING passes a
  // snapshot and verifies nothing. (Measured: on the surface image's Node 22, `node --test <dir>`
  // resolves the directory as a module specifier and runs no suite at all.) So this control also
  // EXECUTES the pinned invocation and reads the runner's own summary counts.

  // (1) The two verifier sites carry the same argv, byte for byte.
  const yml = readFileSync(join(REPO_ROOT, WORKFLOW), "utf8");
  const runLine = /^ *- run: (node --test .*)$/mu.exec(yml);
  assert.ok(runLine !== null, "the external verifier must invoke node --test directly");
  const external = (runLine[1] as string).match(/'[^']*'|\S+/gu)?.map((t) => t.replace(/^'|'$/gu, "")) ?? [];
  assert.deepEqual(external, [...VERIFIER_TEST_ARGV], "external and local verifier invocations must be identical");
  // Comments may still DISCUSS npm test (they explain why it was dropped); no executed step may run it.
  const steps = [...yml.matchAll(/^ *- run: (.*)$/gmu)].map((m) => m[1] as string);
  assert.ok(!steps.some((s) => /\bnpm\s+(run\s+)?test\b/u.test(s)), "npm test is no longer the external verifier's seam");

  // (2) Every leaf directory is named EXPLICITLY — the split changes protection, never execution
  // coverage, and neither does the pin: `devharness/tests/` is here purely for parity with what the
  // bare `node --test` behind `npm test` used to recurse into. This asserts the CONTRACT (one
  // selector per named leaf dir, no recursion relied on), deliberately not the exact selector
  // spelling: how a working selector is spelled is Node's business, and pinning the spelling here
  // would let a non-discovering form fail this leg and never reach the execution leg below, which
  // is the one that actually proves tests ran.
  const DIRS = ["cadp/tests/conformance/", "cadp/tests/ops/", "devharness/tests/"];
  const patterns = VERIFIER_TEST_ARGV.slice(2);
  assert.equal(patterns.length, DIRS.length, "one selector per named leaf directory");
  for (const [i, dir] of DIRS.entries()) {
    assert.ok((patterns[i] as string).startsWith(dir), `selector ${i} must name ${dir}, got ${patterns[i]}`);
    assert.ok(!(patterns[i] as string).slice(dir.length).includes("/"), `selector ${i} must stay inside its leaf dir (no recursion), got ${patterns[i]}`);
  }

  // (3) The real repo satisfies the invocation contract: every named directory holds test files
  // DIRECTLY, so neither pattern can expand to nothing. (MF4 in conformance-manifest.test.ts
  // refuses a *.test.ts nested deeper than one level, which neither verifier would run.)
  for (const pattern of patterns) {
    const dir = join(REPO_ROOT, pattern.slice(0, pattern.lastIndexOf("/")));
    assert.ok(readdirSync(dir).some((f) => f.endsWith(".test.ts")), `${pattern} expands to nothing — that suite would silently not run`);
  }

  // (4) EXECUTE the pinned invocation ON THE SURFACE RUNTIME. Running the repo's own suites here
  // would recurse, so the run is against a minimal fixture that MIRRORS the real layout, driven by
  // the verifier's exact argv strings. Each pattern is run alone so the summary counts are
  // attributable per suite: a pattern that discovers nothing is a deterministic failure, not a
  // silently green run. The runtime is the surface image's Node (see `surfaceRunner`) — measuring
  // `node --test` discovery on an ambient host Node would prove nothing about the verifier, whose
  // container Node is a different major with different discovery semantics.
  const base = mkdtempSync(join(tmpdir(), "cadp-gf8-"));
  try {
    const runner = surfaceRunner(base);
    console.log(`  GF8 invocation measured on: ${runner.where}`);
    writeFileSync(join(base, "package.json"), JSON.stringify({ type: "module" }));
    for (const [i, pattern] of patterns.entries()) {
      const dir = join(base, pattern.slice(0, pattern.lastIndexOf("/")));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `fixture-${i}.test.ts`), `import test from "node:test";\ntest("gf8 fixture ${i}", () => {});\n`);
      // A decoy one level deeper: the invocation must NOT reach it, which is why MF4 forbids one.
      mkdirSync(join(dir, "nested"), { recursive: true });
      writeFileSync(join(dir, "nested", "decoy.test.ts"), `import test from "node:test";\ntest("gf8 decoy ${i}", () => {});\n`);
    }
    for (const pattern of patterns) {
      const { output } = runner.run([...VERIFIER_TEST_ARGV.slice(0, 2), pattern]);
      assert.equal(summaryCount(output, "fail"), 0, `${pattern} did not run clean on ${runner.where}:\n${output}`);
      const ran = summaryCount(output, "pass");
      assert.ok(ran !== undefined && ran > 0, `${pattern} executed ZERO tests on ${runner.where} — an invocation that discovers nothing verifies nothing:\n${output}`);
      assert.equal(ran, 1, `${pattern} must discover exactly the file directly in its named directory, never the nested decoy:\n${output}`);
    }
    // The whole argv together runs every named suite in one process, as the verifiers run it.
    const both = runner.run(VERIFIER_TEST_ARGV);
    assert.equal(both.status, 0, `the pinned invocation must succeed on a clean tree on ${runner.where}:\n${both.output}`);
    assert.equal(summaryCount(both.output, "pass"), patterns.length, `the pinned invocation must execute every named suite on ${runner.where}:\n${both.output}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("GF3: a mixed candidate is gate-flagged if ANY path is gate machinery", () => {
  const hits = touchesGateMachinery(["README.md", "cadp/kernel/api.ts", "src/x.mjs"]);
  assert.deepEqual(hits, ["cadp/kernel/api.ts"]);
});

test("GF4: the rule file guards itself and every rule is a real repo path shape", () => {
  assert.ok(GATE_PATH_RULES.includes("cadp/product/gateFiles.ts"), "the gate rule must protect itself from delegated edits");
  for (const rule of GATE_PATH_RULES) {
    // Machinery rules live under cadp/ or are the external verifier's own invocation file;
    // constitutional documents live at the repo root and are named by exact file or a trailing-`*`
    // filename prefix; reviewer-instruction files are named by a leading-`**/` basename rule, since
    // the discovery walk is per-directory.
    const constitutional = rule === "Authority order.md" || rule.endsWith("*") || rule === ".github/";
    const verifierMachinery = rule === WORKFLOW;
    assert.ok(rule.startsWith("cadp/") || rule.startsWith("**/") || constitutional || verifierMachinery, `rule ${rule} should be a cadp path, a reviewer-instruction basename, the external-verifier workflow, or a constitutional-doc rule`);
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
