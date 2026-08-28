/**
 * M1B4-AC4, AC5, AC38 ~ AC46 — the front half stays a callable use-case: the validator remains
 * pure, no Runtime/Workflow/Verification adapter is reachable, and there is no transport, timer
 * or generic fact framework (TD §9.2, §5.6a).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MIGRATIONS, type Migration } from "../core/store/migrations.ts";
import { openDatabase } from "../core/store/database.ts";
import { tempStore } from "./support/temp-store.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ADMISSION = join(ROOT, "core/admission");
const DECISION = join(ROOT, "core/decision");

/** Terms are assembled from fragments so this guard does not contain them itself. */
const fragment = (...parts: readonly string[]): string => parts.join("");

const sourcesIn = (directory: string): string[] =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(directory, name));

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const scan = (files: readonly string[], label: string, patterns: readonly RegExp[]): void => {
  for (const file of files) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const pattern of patterns) {
      const match = pattern.exec(code);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${label}: ${match?.[0] ?? ""}`);
    }
  }
};

const importsOf = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)].map((match) => match[1] as string);

// --- validator purity ---------------------------------------------------------------------

test("M1B4-AC5 / §2: the Decision Validator still imports no adapter and no store", () => {
  const pure = [
    join(DECISION, "validator.ts"),
    join(DECISION, "proposal.ts"),
    join(DECISION, "decision-authority.ts"),
    join(DECISION, "human-gate-revalidation.ts"),
  ];
  for (const file of pure) {
    for (const specifier of importsOf(file)) {
      assert.equal(
        /adapters\/|\/store\/|admission/.test(specifier),
        false,
        `${relative(ROOT, file)} imports ${specifier}`,
      );
    }
  }
  scan(pure, "an authority call", [
    /get_task\(|get_dependencies\(|snapshot_canonical\(|discover_tasks\(/,
    /PlatformStore|withTransaction|node:sqlite/,
    /spawn_session|send_turn|get_turn_result/,
  ]);

  // The whole decision module reaches for no adapter, and only its journal seam knows the store.
  for (const file of sourcesIn(DECISION)) {
    for (const specifier of importsOf(file)) {
      assert.equal(specifier.includes("adapters/"), false, `${relative(ROOT, file)} imports an adapter`);
      if (specifier.includes("/store/")) {
        assert.equal(
          relative(ROOT, file),
          "core/decision/decision-log.ts",
          "only the Batch 7 journal seam may name the store",
        );
      }
    }
  }
});

// --- front-half dependencies ---------------------------------------------------------------

test("M1B4-AC4 / AC32 / AC37: the front half touches no Runtime, Workflow or Verification adapter", () => {
  // MVP1-B5 added activation to this module: it builds the Task Contract and both Grants, which
  // is exactly its job (§12.7). IG-1 added the run-scoped SUPERVISOR grant, which §13.4 settles as
  // a run-admission step. What must stay absent is every *external* adapter.
  const ACTIVATION = "core/admission/activate-task.ts";
  const GRANT_ISSUANCE = "core/admission/supervisor-grant.ts";
  const frontHalf = sourcesIn(ADMISSION).filter(
    (file) => ![ACTIVATION, GRANT_ISSUANCE].includes(relative(ROOT, file)),
  );

  scan(sourcesIn(ADMISSION), "a forbidden adapter", [
    /RuntimeAdapter|WorkflowAdapter|VerificationAdapter|ReportAdapter/,
    /RuntimeTurnResult|structured_output|spawn_session|send_turn|get_turn_result/,
    /audit_decide|acquire_workflow_controller|run_verification|deliver\(/,
    /create_feature_workspace|inspect_candidate|prepare_merge|commit_merge/,
  ]);
  scan(frontHalf, "a forbidden adapter", [
    /RuntimeAdapter|WorkflowAdapter|VerificationAdapter|ReportAdapter/,
    /RuntimeTurnResult|structured_output|spawn_session|send_turn|get_turn_result/,
    /audit_decide|acquire_workflow_controller|run_verification|deliver\(/,
    /buildTaskContract|CapabilityGrant|issueGrant|contract_snapshot/,
  ]);

  // The IG-1 exemption is exactly one grant: the run-scoped SUPERVISOR one. It builds no Task
  // Contract and touches no contract snapshot, so activation stays the only module that does.
  scan([join(ROOT, GRANT_ISSUANCE)], "work that is not the run-scoped grant", [
    /buildTaskContract|issueGrant|contract_snapshot/,
    /"ACTOR"|"AUDITOR"|actor_grant|auditor_grant|attempt_key/,
  ]);

  // Only the RepositoryAdapter interface may be named, and only as an interface.
  for (const file of sourcesIn(ADMISSION)) {
    for (const specifier of importsOf(file)) {
      assert.equal(
        specifier.startsWith("../") || specifier.startsWith("./") || specifier.startsWith("node:"),
        true,
        `${relative(ROOT, file)} imports a package: ${specifier}`,
      );
      if (specifier.includes("adapters")) {
        assert.equal(specifier, "../../adapters/interfaces/repository-adapter.ts");
      }
      assert.equal(
        /local-git|project-document-task-source/.test(specifier),
        false,
        `${relative(ROOT, file)} hardcodes a concrete adapter`,
      );
    }
  }
});

test("M1B4-AC38 / AC39: there is no transport, timer or background loop", () => {
  scan(sourcesIn(ADMISSION), "a transport or a loop", [
    new RegExp(fragment("mo", "del", "context", "protocol"), "i"),
    new RegExp(`\\b${fragment("m", "cp")}\\b`, "i"),
    /node:(net|http|https|dgram|tls|child_process)|\bfetch\(|WebSocket|createServer/,
    /setInterval|setTimeout|setImmediate|queueMicrotask|tick_once|tickOnce/,
    /while\s*\(|retryCount|maxRetries|backoff/,
    /Date\.now|new Date\(|Math\.random|randomUUID/,
  ]);
});

test("M1B4-AC40: no generic authority, fact or registry framework was introduced", () => {
  scan(sourcesIn(ADMISSION), "a generic framework", [
    /AuthorityRegistry|FactRegistry|FactEnvelope|WorldState|DecisionContextRegistry/,
    /AuthoritativeFactBundle|ProfileRegistry|CurrentBatchResolver|BatchScheduler/,
    /mapperFor|MAPPER_TABLE|registry\b/i,
  ]);
  // The assembler's output is the existing validator input, not a new aggregate.
  const assembly = readFileSync(join(ADMISSION, "fact-assembly.ts"), "utf8");
  assert.match(assembly, /DecisionValidationInput/);
});

test("M1B4-AC20 / §20: no observation is mapped onto a lifecycle state", () => {
  const DEPENDENCY_RULE = "core/admission/dependency-admission.ts";
  const others = sourcesIn(ADMISSION).filter(
    (file) => relative(ROOT, file) !== DEPENDENCY_RULE,
  );

  // Everywhere but the M1-5 rule, an external state is not even nameable.
  scan(others, "an observation mapper", [
    /CLOSED|IN_PROGRESS|BLOCKED\b|external_state/,
    /COMPLETED|DEFERRED|INVALIDATED|READY_TO_MERGE/,
  ]);

  // TD §8.4a reads `CLOSED` as an admission precondition fact, which is exactly not a mapping:
  // the rule may compare a Platform state, but it may never assign one or write anything.
  const rule = stripComments(readFileSync(join(ROOT, DEPENDENCY_RULE), "utf8"));
  assert.equal(/CLOSED/.test(rule), true, "the rule does read the external fact");
  assert.equal(
    /platform_state\s*===\s*"COMPLETED"/.test(rule),
    true,
    "and compares the Platform fact rather than deriving it",
  );
  for (const forbidden of [
    /platform_state\s*=[^=]/,
    /tasks\.write|tasks\.observe|tasks\.discover/,
    /external_snapshot/,
    /DEFERRED|INVALIDATED|READY_TO_MERGE|IMPLEMENTING/,
    /withTransaction|INSERT INTO|UPDATE /,
  ]) {
    assert.equal(forbidden.test(rule), false, `the rule mutates state: ${forbidden}`);
  }
});

test("M1B4-AC36: only the state machine writes lifecycle rows", () => {
  // Activation reads `attempts.nextOrdinal`/`attempts.current`, but every *write* still goes
  // through `commitContractActivation` — the state machine remains the only writer.
  const GRANT_ISSUANCE = "core/admission/supervisor-grant.ts";
  const lifecycleWrites = /tasks\.write|attempts\.create|attempts\.write|contracts\.put/;
  const others = sourcesIn(ADMISSION).filter((file) => relative(ROOT, file) !== GRANT_ISSUANCE);

  scan(others, "a direct lifecycle write", [
    new RegExp(`${lifecycleWrites.source}|grants\\.put`),
    /INSERT INTO|UPDATE |outbox\.enqueue|idempotency\./,
  ]);

  // IG-1 (§13.4) settles one grant write in admission — and only that. The run-scoped SUPERVISOR
  // grant is not a lifecycle row: no state, no attempt, no idempotency, no outbox.
  scan([join(ROOT, GRANT_ISSUANCE)], "a direct lifecycle write", [
    lifecycleWrites,
    /INSERT INTO|UPDATE |outbox\.enqueue|idempotency\./,
  ]);
  const issuance = stripComments(readFileSync(join(ROOT, GRANT_ISSUANCE), "utf8"));
  assert.deepEqual(
    [...issuance.matchAll(/grants\.put\([^,]+,\s*\{\s*kind:\s*"(\w+)"/g)].map((match) => match[1]),
    ["RUN"],
    "the one admission grant write is run-scoped",
  );
});

// --- the Coordinator and the schema -----------------------------------------------------------

test("M1B4-AC39: the Coordinator gained no submission behaviour", () => {
  const coordinator = stripComments(
    readFileSync(join(ROOT, "core/coordinator/coordinator.ts"), "utf8"),
  );
  for (const term of ["submitProposal", "admission", "assembleDecisionInput", "bootstrapRun"]) {
    assert.equal(coordinator.includes(term), false, `the Coordinator now references ${term}`);
  }
});

test("M1B4-AC41 ~ AC44: the schema and the B1/B2/B3 surfaces are untouched", () => {
  assert.deepEqual(
    MIGRATIONS.map((migration) => ({ version: migration.version, name: migration.name })),
    [
      { version: 1, name: "foundation" },
      { version: 2, name: "domain" },
      { version: 3, name: "mvp1-artifacts" },
      { version: 4, name: "selection-scope" },
      { version: 5, name: "selection-binding" },
      { version: 6, name: "audit-decision-category" },
    ],
  );
  assert.deepEqual(
    [...((MIGRATIONS[2] as Migration).statements.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g))]
      .map((match) => match[1] as string)
      .sort(),
    ["adapter_metadata", "audit_record", "verification_evidence"],
  );

  const temp = tempStore();
  const store = temp.open();
  assert.equal(store.schemaVersion, MIGRATIONS.length);
  store.close();
  try {
    const database = openDatabase(temp.path);
    try {
      const names = (
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter((name) => !name.startsWith("sqlite_"));
      assert.equal(names.length, 17);
      for (const forbidden of ["current_batch", "decision_event", "fact_cache", "task_dependency"]) {
        assert.equal(names.includes(forbidden), false);
      }
    } finally {
      database.close();
    }
  } finally {
    temp.dispose();
  }
});

test("M1B4-AC45 / AC46: no backend or project vocabulary entered the front half", () => {
  const forbidden: RegExp[] = [
    new RegExp(fragment("open", "claw"), "i"),
    new RegExp(fragment("durable", "[-_ ]?", "jobs"), "i"),
    new RegExp(`\\b${fragment("a", "cp")}\\b`, "i"),
    new RegExp(fragment("session", "[-_]?", "key"), "i"),
    new RegExp(`\\b${fragment("a", "gy")}\\b`, "i"),
    new RegExp(fragment("sl", "ack"), "i"),
    new RegExp(fragment("infra", "[-_ ]?", "scanner"), "i"),
    new RegExp(fragment("READY", "_ITEM")),
    new RegExp(fragment("PROJECT", "_STATUS")),
    new RegExp(fragment("THIN", "_FOUNDATION")),
    /\bU-\d\d\b/,
  ];
  for (const file of sourcesIn(ADMISSION)) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      const match = pattern.exec(content);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${match?.[0] ?? ""}`);
    }
  }
});
