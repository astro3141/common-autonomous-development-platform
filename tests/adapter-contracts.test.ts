/**
 * B3-AC1 (five interfaces), B3-AC3 (no production backend), B3-AC5 (Runtime surface),
 * B3-AC6 (Workflow observation placement), B3-AC7 (Repository facts only),
 * B3-AC12 (no raw credential field), B3-AC13 (no external side effect).
 *
 * The interfaces are types, so the surface is checked against the source text and against the
 * fakes that implement them.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INTERFACES = join(ROOT, "adapters/interfaces");
const TESTDOUBLES = join(ROOT, "testdoubles");

const read = (path: string): string => readFileSync(path, "utf8");

/** Judges executable code rather than the prose that explains it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** Method names declared on an `export interface X { ... }` block. */
function interfaceMethods(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  assert.notEqual(start, -1, `interface ${name} not found`);
  const body = source.slice(start, source.indexOf("\n}", start));
  return [...body.matchAll(/^\s{2}([a-z_][a-z0-9_]*)\s*\(/gim)].map((match) => match[1] as string);
}

test("B3-AC1: the five sealed adapter interfaces plus the D24 materialisation contract exist", () => {
  const files = readdirSync(INTERFACES).filter((name) => name.endsWith(".ts")).sort();
  assert.deepEqual(files, [
    "capability.ts",
    // §8.1b (D24, prospective MVP 3) — the one bounded child-creation mutation contract; the
    // five MVP 0 adapter interfaces stay sealed and unchanged.
    "child-materialization-adapter.ts",
    "handles.ts",
    "index.ts",
    "report-adapter.ts",
    "repository-adapter.ts",
    "runtime-adapter.ts",
    "verification-adapter.ts",
    "workflow-adapter.ts",
  ]);

  const declared = files.flatMap((file) =>
    [...read(join(INTERFACES, file)).matchAll(/^export interface (\w*Adapter) \{/gm)].map(
      (match) => match[1] as string,
    ),
  );
  assert.deepEqual(declared.sort(), [
    "ReportAdapter",
    "RepositoryAdapter",
    "RuntimeAdapter",
    "VerificationAdapter",
    "WorkflowAdapter",
  ]);
});

test("B3-AC5: the RuntimeAdapter surface matches Spec §27 plus TD §13.3", () => {
  const methods = interfaceMethods(read(join(INTERFACES, "runtime-adapter.ts")), "RuntimeAdapter");
  assert.deepEqual(methods, [
    "spawn_session",
    "send_turn",
    "get_turn_result",
    "get_session_status",
    "cancel_session",
    "close_session",
    "acquire_workflow_controller",
  ]);
});

test("M0-7: spawn_session returns RuntimeSpawnResult and no receipt query method exists", () => {
  const source = read(join(INTERFACES, "runtime-adapter.ts"));

  // The concrete result of Spec §27's minimum method (TD §12.6/§13.1).
  assert.match(source, /\): RuntimeSpawnResult;/);
  assert.match(source, /export interface RuntimeSpawnResult \{[\s\S]*?readonly session_handle: RuntimeSessionHandle;[\s\S]*?readonly enforcement_receipt\?: CapabilityEnforcementReceipt;[\s\S]*?\n\}/);

  // No second retrieval path, and no second source of truth for support.
  const methods = interfaceMethods(source, "RuntimeAdapter");
  assert.equal(
    methods.some((name) => /receipt/i.test(name)),
    false,
    "receipt must arrive with the spawn result, not through a query",
  );
  for (const file of readdirSync(INTERFACES).filter((name) => name.endsWith(".ts"))) {
    const content = stripComments(read(join(INTERFACES, file)));
    assert.equal(
      /"UNSUPPORTED"|\bUNSUPPORTED\b|receipt_supported/.test(content),
      false,
      `${file} introduces a second authority for receipt support`,
    );
  }
});

test("M0-7: the receipt type is TD §12.6's schema, with no added field", () => {
  const source = read(join(INTERFACES, "capability.ts"));
  const body = source.slice(source.indexOf("export interface CapabilityEnforcementReceipt {"));
  const fields = [...body.matchAll(/^\s{2}readonly (\w+)\??:/gm)].map((match) => match[1] as string);

  assert.deepEqual(fields, [
    "receipt_id",
    "grant_hash",
    "backend_manifest_hash",
    "session_handle",
    "applied",
    "applied_means",
    "issued_at",
  ]);

  // TD §12.1/§12.2 vocabulary is reused, not extended. It lives in core/schemas so that Core
  // validation and this adapter boundary share one definition; capability.ts re-exports it.
  assert.match(source, /from "\.\.\/\.\.\/core\/schemas\/capability-vocabulary\.ts"/);
  const vocabulary = read(join(ROOT, "core/schemas/capability-vocabulary.ts"));
  const capabilities = [...vocabulary.matchAll(/^\s+\| "([a-z_.]+)";?$/gm)].map((match) => match[1]);
  assert.equal(capabilities.length, 12, "the fixed v1 capability vocabulary has 12 entries");
  assert.match(vocabulary, /"ENFORCED"/);
  assert.match(vocabulary, /"AVAILABLE_WITH_REDUCED_ASSURANCE"/);
  assert.match(vocabulary, /"UNENFORCEABLE_CAPABILITY_BOUNDARY"/);
  assert.match(vocabulary, /"NOT_YET_AUDITED"/);

  // No broker, no manifest loader, no policy evaluation was pulled forward.
  assert.equal(/class |function |=>/.test(stripComments(source)), false, "capability.ts is types only");
});

test("M0-8: WorkflowAdapter signatures follow the W-B+ controller rule", () => {
  const source = read(join(INTERFACES, "workflow-adapter.ts"));
  const block = source.slice(source.indexOf("export interface WorkflowAdapter {"));

  const signature = (method: string): string => {
    const start = block.indexOf(`  ${method}(`);
    assert.notEqual(start, -1, `${method} not declared`);
    return block
      .slice(start, block.indexOf(";", start))
      .replace(/\s+/g, " ")
      .replace(/\(\s+/g, "(")
      .replace(/,\s*\)/g, ")")
      .trim();
  };

  // Trusted-context calls carry the controller explicitly (TD §13.3, §14.1, §16.3).
  assert.equal(
    signature("start"),
    "start(controller: WorkflowControllerHandle, workflow_spec: WorkflowSpec): WorkflowHandle",
  );
  assert.equal(
    signature("audit_decide"),
    "audit_decide(controller: WorkflowControllerHandle, handle: WorkflowHandle," +
      " verdict: AuditVerdict, evidence: readonly VerificationEvidence[]): void",
  );

  // The rest resolve ownership through the handle association; no controller argument.
  for (const method of ["status", "resume", "cancel", "recover"]) {
    const text = signature(method);
    assert.equal(
      /WorkflowControllerHandle/.test(text),
      false,
      `${method} must not take a controller handle: ${text}`,
    );
    assert.match(text, /\(handle: WorkflowHandle\)/);
  }
});

test("M0-8: no scoped workflow surface, factory or context abstraction was added", () => {
  for (const directory of [INTERFACES, TESTDOUBLES]) {
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      const content = read(join(directory, file));
      assert.equal(
        /ScopedWorkflow|WorkflowContext|WorkflowFactory|ControllerScope|forController/.test(content),
        false,
        `${relative(ROOT, join(directory, file))} introduces a scoped workflow abstraction`,
      );
    }
  }
});

test("B3-AC6: the WorkflowAdapter surface is Spec §30 and has no public observe()", () => {
  const source = read(join(INTERFACES, "workflow-adapter.ts"));
  const methods = interfaceMethods(source, "WorkflowAdapter");

  assert.deepEqual(methods, ["start", "status", "resume", "cancel", "audit_decide", "recover"]);
  assert.equal(methods.includes("observe"), false);
  assert.match(source, /status\(handle: WorkflowHandle\): WorkflowObservation/);

  // No fake or interface may expose observe() either.
  for (const directory of [INTERFACES, TESTDOUBLES]) {
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      const content = read(join(directory, file));
      assert.equal(
        /^\s*(observe)\s*\(/m.test(content),
        false,
        `${relative(ROOT, join(directory, file))} declares observe()`,
      );
    }
  }
});

test("B3-AC7: RepositoryAdapter declares Spec §42 facts and primitives only", () => {
  const source = read(join(INTERFACES, "repository-adapter.ts"));
  const methods = interfaceMethods(source, "RepositoryAdapter");

  assert.deepEqual(methods, [
    "snapshot_canonical",
    "create_feature_workspace",
    "inspect_candidate",
    "get_diff",
    "verify_tracked_clean",
    "verify_expected_files",
    "verify_lineage",
    "verify_canonical_head",
    "prepare_merge",
    "commit_merge",
  ]);

  // No gate policy vocabulary and no git invocation in executable code (comments explaining the
  // boundary are stripped first, so prose about policy is not mistaken for policy).
  for (const path of [
    join(INTERFACES, "repository-adapter.ts"),
    join(TESTDOUBLES, "fake-repository-adapter.ts"),
  ]) {
    const code = stripComments(read(path));
    assert.equal(
      /auto_merge|accepted_assurance|\bpolicy\b|ff-only|REPOSITORY_CONFLICT/i.test(code),
      false,
      `${relative(ROOT, path)} carries gate policy`,
    );
    assert.equal(/"git"|execFile|spawnSync|execSync/.test(code), false);
  }
});

test("B3-AC3 / B3-AC13: no production backend and no external side effect", () => {
  const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
    ["process execution", /child_process|execSync|execFileSync|spawnSync|\bexeca\b/],
    ["filesystem access", /from "node:fs"|require\("fs"\)/],
    ["network access", /from "node:(net|http|https|dgram|tls)"|\bfetch\(|WebSocket|XMLHttpRequest/],
    ["database access", /from "node:sqlite"/],
    ["nondeterminism", /Math\.random|Date\.now|new Date\(/],
  ];

  for (const directory of [INTERFACES, TESTDOUBLES]) {
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      const content = read(join(directory, file));
      for (const [label, pattern] of forbidden) {
        assert.equal(
          pattern.test(content),
          false,
          `${relative(ROOT, join(directory, file))} contains ${label}`,
        );
      }
    }
  }
});

test("B3-AC3: interfaces and fakes import nothing outside the repository's own type modules", () => {
  for (const directory of [INTERFACES, TESTDOUBLES]) {
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      const content = read(join(directory, file));
      const specifiers = [...content.matchAll(/ from "([^"]+)";/g)].map((match) => match[1] as string);
      for (const specifier of specifiers) {
        assert.ok(
          specifier.startsWith("./") || specifier.startsWith("../"),
          `${relative(ROOT, join(directory, file))} imports external module "${specifier}"`,
        );
      }
    }
  }
});

test("B3-AC12: no raw credential-bearing field in the generic types", () => {
  // Handles are nominal boundaries with no members, so no backend identity can leak through them.
  const handles = read(join(INTERFACES, "handles.ts"));
  assert.match(handles, /declare const OpaqueTag: unique symbol/);
  assert.equal(/interface \w+ \{\s*readonly (?!\[OpaqueTag\])/.test(handles), false);

  for (const directory of [INTERFACES, TESTDOUBLES]) {
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      const content = read(join(directory, file));
      assert.equal(
        /\b(token|credential|bearer|api_key|apiKey)\b/i.test(content),
        false,
        `${relative(ROOT, join(directory, file))} names a credential field`,
      );
    }
  }
});

test("RuntimeSessionStatus stays a boundary type with no invented vocabulary", () => {
  const handles = read(join(INTERFACES, "handles.ts"));
  assert.match(handles, /export type RuntimeSessionStatus = Opaque<"RuntimeSessionStatus">;/);
  // No lifecycle enum was introduced anywhere in the boundary.
  for (const file of readdirSync(INTERFACES).filter((name) => name.endsWith(".ts"))) {
    assert.equal(/\b(ALIVE|DEAD|IDLE|RUNNING_SESSION)\b/.test(read(join(INTERFACES, file))), false);
  }
});
