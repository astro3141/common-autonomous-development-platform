/**
 * B8-AC35, B8-AC38, B8-AC39 — the Batch 8 modules stay inside their boundary: no adapter, no
 * backend vocabulary, no deferred table, no generic framework.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MIGRATIONS, type Migration } from "../core/store/migrations.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Forbidden terms are assembled from fragments so this guard does not contain them itself. */
const fragment = (...parts: readonly string[]): string => parts.join("");

const STATE_MACHINE = join(ROOT, "core/statemachine");
const HUMAN_DECISION = join(ROOT, "core/humandecision");
const DOMAIN_STORE_FILES = [
  "artifact-stores.ts",
  "approval-binding.ts",
  "domain-types.ts",
  "immutable-artifact.ts",
  "lifecycle-stores.ts",
  "migrations.ts",
  "pending-decision-store.ts",
  "read-models.ts",
  "report-outbox-store.ts",
].map((name) => join(ROOT, "core/store", name));

const sourcesIn = (directory: string): string[] =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(directory, name));

const BATCH8_SOURCES = [
  ...sourcesIn(STATE_MACHINE),
  ...sourcesIn(HUMAN_DECISION),
  ...DOMAIN_STORE_FILES,
  join(ROOT, "core/decision/human-gate-revalidation.ts"),
];

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

test("B8-AC35: the state machine never reaches an adapter or the outside world", () => {
  scan(sourcesIn(STATE_MACHINE), "an external seam", [
    /RuntimeAdapter|WorkflowAdapter|RepositoryAdapter|VerificationAdapter|ReportAdapter/,
    /ProjectDocumentTaskSource|TaskSourceV1|discover_tasks/,
    /from "node:fs"|readFileSync|writeFileSync/,
    /node:(child_process|net|http|https)|\bfetch\(/,
    /Date\.now|new Date\(/,
    /Math\.random|randomUUID|randomBytes/,
    /generateUlid|newUlid|nextId|createId/,
    /adapters\//,
  ]);
});

test("B8-AC35: no Batch 8 module pulls in an adapter or a backend integration", () => {
  scan(BATCH8_SOURCES, "an adapter import", [
    /from "\.\.\/\.\.\/adapters/,
    /RuntimeAdapter|WorkflowAdapter|RepositoryAdapter|VerificationAdapter|ReportAdapter/,
  ]);
});

test("B8-AC38: Batch 8 created none of the tables it deferred", () => {
  // They exist from migration v3 on (TD §18.1c); neither Batch 8's sources nor v2 mention them.
  const forbidden = [
    new RegExp(fragment("verification", "_evidence")),
    new RegExp(fragment("audit", "_record")),
    new RegExp(fragment("adapter", "_metadata")),
  ];
  // migrations.ts is shared across batches and carries v3 too, so it is checked precisely below.
  const batch8Only = BATCH8_SOURCES.filter((file) => !file.endsWith("migrations.ts"));
  scan(batch8Only, "a deferred table", forbidden);

  const v2 = (MIGRATIONS[1] as Migration).statements;
  for (const pattern of forbidden) {
    assert.equal(pattern.test(v2), false, `migration v2 mentions ${pattern}`);
  }
});

test("B8-AC39: no backend or project vocabulary, and no MVP 3 state", () => {
  const forbidden: RegExp[] = [
    new RegExp(fragment("open", "claw"), "i"),
    new RegExp(fragment("durable", "[-_ ]?", "jobs"), "i"),
    new RegExp(fragment("infra", "[-_ ]?", "scanner"), "i"),
    new RegExp(fragment("session", "[-_]?", "key"), "i"),
    new RegExp(fragment("agent", "Id")),
    new RegExp(`\\b${fragment("a", "gy")}\\b`, "i"),
    new RegExp(fragment("PROJECT", "_STATUS")),
    new RegExp(fragment("READY", "_ITEM")),
    new RegExp(fragment("THIN", "_FOUNDATION")),
    new RegExp(fragment("permission", "Mode")),
    new RegExp(fragment("tool_", "allowlist")),
  ];
  for (const file of BATCH8_SOURCES) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      const match = pattern.exec(content);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${match?.[0] ?? ""}`);
    }
  }

  // MVP 3 lifecycle is absent from the code; explaining its absence in a comment is fine.
  scan(BATCH8_SOURCES, "an MVP 3 state", [
    new RegExp(fragment("SUS", "PENDED")),
    new RegExp(fragment("sub", "flow"), "i"),
    new RegExp(fragment("parent", "_relation")),
  ]);
});

test("B8-AC39: no credential-bearing identifier reaches the domain schema", () => {
  scan(BATCH8_SOURCES, "a restricted identifier", [
    new RegExp(`\\b${fragment("token", "s?")}\\b`, "i"),
    new RegExp(fragment("cre", "dential"), "i"),
    new RegExp("[\"'`]" + fragment("Author", "ization") + "[\"'`:]", "i"),
    new RegExp(`\\b${fragment("sec", "ret", "s?")}\\b`, "i"),
    new RegExp(fragment("api", "[_-]?", "key"), "i"),
    new RegExp(fragment("bea", "rer"), "i"),
  ]);
});

test("no generic framework is introduced", () => {
  scan(BATCH8_SOURCES, "a generic framework", [
    /DomainRepository|UnitOfWork/,
    /EventBus|CommandBus/,
    /AggregateRoot|EventSourc/,
    /Statechart|StateChart/,
    /WorkflowEngine|ApprovalEngine|PolicyEngine/,
    /GenericImmutableArtifactStore|ArtifactFramework/,
    /RepositoryPattern|ApprovalRepository|AuthorizationService/,
    /TransitionRegistry|RuleRegistry/,
  ]);
});

test("B8-AC24: no gate bypass concept exists anywhere in Core", () => {
  const coreFiles = ["core/decision", "core/humandecision", "core/statemachine"].flatMap((dir) =>
    sourcesIn(join(ROOT, dir)),
  );
  scan(coreFiles, "a gate bypass", [
    /skipHumanGate|bypassV7|skipValidation/,
    /humanOverrideToken|approvalToken|HumanGateApprovalToken/,
    /approved\s*[:=]\s*true/,
    /ResolvedHumanGateView/,
  ]);
});

test("B8-AC38: migration v2 declares exactly the ten domain tables", () => {
  const v2 = (MIGRATIONS[1] as Migration).statements;
  const created = [...v2.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map(
    (match) => match[1] as string,
  );
  assert.deepEqual(created.sort(), [
    "batch",
    "capability_grant",
    "compiled_profile_snapshot",
    "operator_action",
    "pending_human_decision",
    "platform_run",
    "report_outbox",
    "task",
    "task_attempt",
    "task_contract_snapshot",
  ]);
});
