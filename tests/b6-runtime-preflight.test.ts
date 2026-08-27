/**
 * MVP1-B6 areas H, I — the RA-4 preflight on a controlled filesystem.
 *
 * Both fixtures are built from the probe constants the adapter exports, so the fixture and the
 * check cannot drift apart and no test has to restate a backend mechanism itself. The live
 * environment is never consulted and never modified (§16, §18).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BACKEND_PERMISSION_MODES,
  BACKEND_RUNTIME_PROBES,
  backendRuntimePreflight,
  inspectBackendRuntime,
  type BackendRuntimePreflightConfig,
} from "../adapters/backend-runtime-preflight/index.ts";

interface Tree {
  readonly root: string;
  readonly core_dist_dir: string;
  readonly agent_extension_dir: string;
}

/** A complete, passing installation. Every `omit` drops exactly one condition's evidence. */
function fixture(omit: readonly string[] = []): Tree {
  const root = mkdtempSync(join(tmpdir(), "platform-preflight-"));
  const core_dist_dir = join(root, "core/dist");
  const agent_extension_dir = join(root, "agent-extension");

  const serve = join(core_dist_dir, BACKEND_RUNTIME_PROBES.serve_entry_relative_path);
  mkdirSync(dirname(serve), { recursive: true });
  writeFileSync(
    serve,
    [
      "// patched plugin-tools serve implementation",
      omit.includes("C1") ? "" : `const a = process.env.${BACKEND_RUNTIME_PROBES.per_agent_identity_env};`,
      omit.includes("C2") ? "" : `const w = process.env.${BACKEND_RUNTIME_PROBES.workspace_dir_env};`,
    ].join("\n"),
    "utf8",
  );

  if (!omit.includes("C3")) {
    mkdirSync(agent_extension_dir, { recursive: true });
    writeFileSync(join(agent_extension_dir, "package.json"), '{"name":"agent-extension"}\n', "utf8");
    writeFileSync(
      join(agent_extension_dir, "index.js"),
      [
        omit.includes("C4") ? "" : `export function ${BACKEND_RUNTIME_PROBES.core_dist_resolver_symbol}() {`,
        omit.includes("C5")
          ? "  return null;"
          : `  return "${BACKEND_RUNTIME_PROBES.serve_entry_relative_path}";`,
        omit.includes("C4") ? "" : "}",
      ].join("\n"),
      "utf8",
    );
  }

  return { root, core_dist_dir, agent_extension_dir };
}

const configFor = (tree: Tree, omit: readonly string[] = []): BackendRuntimePreflightConfig => ({
  core_dist_dir: tree.core_dist_dir,
  agent_extension_dir: omit.includes("C3") ? null : tree.agent_extension_dir,
  permission_mode: omit.includes("C6") ? null : (BACKEND_PERMISSION_MODES[1] as string),
});

const withFixture = (omit: readonly string[], body: (config: BackendRuntimePreflightConfig, tree: Tree) => void): void => {
  const tree = fixture(omit);
  try {
    body(configFor(tree, omit), tree);
  } finally {
    rmSync(tree.root, { recursive: true, force: true });
  }
};

/** Every path under a root with its size and kind — enough to catch any write. */
function snapshot(root: string): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory()
          ? [`d ${path}`, ...walk(path)]
          : [`f ${path} ${statSync(path).size}`];
      });
  return walk(root);
}

// --- area H: READY ---------------------------------------------------------------------------

test("B6-8 (H): a complete installation is READY, and C1–C6 all pass", () => {
  withFixture([], (config) => {
    const report = inspectBackendRuntime(config);
    assert.deepEqual(report.outcome, { status: "READY" });
    assert.deepEqual(report.conditions, {
      C1: true,
      C2: true,
      C3: true,
      C4: true,
      C5: true,
      C6: true,
    });
    assert.deepEqual(backendRuntimePreflight(config)(), { status: "READY" });
  });
});

test("B6-8 (H): C7 provenance is recorded and never participates in the verdict", () => {
  withFixture([], (config) => {
    const withVersions = inspectBackendRuntime({
      ...config,
      core_version: "0.0.0-test",
      agent_extension_version: "0.0.0-test",
    });
    assert.deepEqual(withVersions.provenance, {
      core_version: "0.0.0-test",
      agent_extension_version: "0.0.0-test",
    });
    // The verdict is identical with and without it, and provenance is not a condition.
    assert.deepEqual(withVersions.outcome, inspectBackendRuntime(config).outcome);
    assert.equal("C7" in withVersions.conditions, false);
  });
});

// --- area I: BLOCKED --------------------------------------------------------------------------

test("B6-8 (I): each missing condition blocks, and names itself as the reason", () => {
  for (const condition of ["C1", "C2", "C3", "C4", "C6"]) {
    withFixture([condition], (config) => {
      const report = inspectBackendRuntime(config);
      assert.equal(report.outcome.status, "BLOCKED", condition);
      assert.equal(
        report.outcome.status === "BLOCKED" && report.outcome.reasons.includes(condition),
        true,
        `${condition} is not reported`,
      );
      assert.equal(report.conditions[condition], false);
    });
  }
});

test("B6-8 (I): a resolver that names no served entry blocks on C5 alone", () => {
  withFixture(["C5"], (config) => {
    const report = inspectBackendRuntime(config);
    assert.deepEqual(report.outcome, { status: "BLOCKED", reasons: ["C5"] });
  });
});

test("B6-8 (I): a missing agent extension blocks C3, C4 and C5 together", () => {
  withFixture(["C3"], (config) => {
    const report = inspectBackendRuntime(config);
    assert.deepEqual(report.outcome, { status: "BLOCKED", reasons: ["C3", "C4", "C5"] });
  });
});

test("B6-8 (I): an unset or unlisted permission mode is not treated as a default", () => {
  withFixture([], (config) => {
    for (const mode of [null, "", "default", "bypassPermissions"]) {
      const report = inspectBackendRuntime({ ...config, permission_mode: mode });
      assert.deepEqual(report.outcome, { status: "BLOCKED", reasons: ["C6"] }, String(mode));
    }
    for (const mode of BACKEND_PERMISSION_MODES) {
      assert.deepEqual(inspectBackendRuntime({ ...config, permission_mode: mode }).outcome, {
        status: "READY",
      });
    }
  });
});

test("B6-8 (I): a core distribution that is not there at all blocks rather than throwing", () => {
  const report = inspectBackendRuntime({
    core_dist_dir: join(tmpdir(), "platform-preflight-absent", "dist"),
    agent_extension_dir: null,
    permission_mode: null,
  });
  assert.deepEqual(report.outcome, {
    status: "BLOCKED",
    reasons: ["C1", "C2", "C3", "C4", "C5", "C6"],
  });
});

// --- §16: read-only ------------------------------------------------------------------------------

test("B6-32 (§16): the preflight changes nothing, on a passing or a failing installation", () => {
  for (const omit of [[], ["C2"], ["C3"]]) {
    withFixture(omit, (config, tree) => {
      const before = snapshot(tree.root);
      inspectBackendRuntime(config);
      inspectBackendRuntime(config);
      assert.deepEqual(snapshot(tree.root), before, `the tree changed for ${omit.join(",")}`);
    });
  }
});

test("B6-32 (§16): the module reaches no installer, package manager or process", () => {
  const source = readFileSyncStripped("adapters/backend-runtime-preflight/preflight.ts");
  for (const forbidden of [
    /child_process|execSync|execFileSync|spawnSync/,
    /writeFile|mkdir|rm\(|rmSync|unlink|symlink|chmod|rename/,
    /npm |pnpm |brew |install|upgrade/i,
    /fetch\(|node:https?|node:net/,
  ]) {
    assert.equal(forbidden.test(source), false, `the preflight can ${forbidden}`);
  }
});

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function readFileSyncStripped(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}
