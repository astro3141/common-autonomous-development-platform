/**
 * B7-AC3, B7-AC9, B7-AC31 boundaries — `core/decision` stays a pure Core module: no adapter, no
 * filesystem, no Proposal artifact, no state machine and no Batch 8 persistence.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MIGRATIONS, type Migration } from "../core/store/migrations.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DECISION = join(ROOT, "core/decision");

const sources = (): string[] =>
  readdirSync(DECISION)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(DECISION, name));

/** Forbidden terms are assembled from fragments so this guard does not contain them itself. */
const fragment = (...parts: readonly string[]): string => parts.join("");

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const scan = (label: string, patterns: readonly RegExp[]): void => {
  for (const file of sources()) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const pattern of patterns) {
      const match = pattern.exec(code);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${label}: ${match?.[0] ?? ""}`);
    }
  }
};

// --- B7-AC3 the Proposal is not an artifact -------------------------------------------

test("B7-AC3: no Proposal envelope, hash, snapshot or store exists", () => {
  scan("a Proposal artifact", [
    /platform\/supervisor-proposal/,
    /proposal_hash/,
    /hashProposal/,
    /ProposalEnvelope/,
    /ProposalSnapshot/,
    /ProposalStore/,
  ]);

  // The module never reaches for the envelope or digest machinery at all.
  scan("envelope machinery", [/makeEnvelope|hashEnvelope|sha256Digest|canonicalEnvelopeBytes/]);

  // And it declares no schema name of its own.
  for (const file of sources()) {
    assert.equal(/"platform\/[a-z-]+"/.test(readFileSync(file, "utf8")), false);
  }
});

test("B7-AC3: nothing parses model prose into a Proposal", () => {
  scan("a natural-language parser", [
    /markdown-sections-v1/,
    /##\s*Task/,
    /parseText|fromMarkdown|extractProposal/,
  ]);
});

// --- B7-AC9 pure validator ---------------------------------------------------------------

test("B7-AC9: no adapter, store, filesystem, clock or randomness is reachable", () => {
  const validatorOnly = [
    join(DECISION, "types.ts"),
    join(DECISION, "errors.ts"),
    join(DECISION, "proposal.ts"),
    join(DECISION, "decision-authority.ts"),
    join(DECISION, "validator.ts"),
  ];
  for (const file of validatorOnly) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const [label, pattern] of [
      ["an adapter", /RuntimeAdapter|WorkflowAdapter|RepositoryAdapter|VerificationAdapter|ReportAdapter/],
      ["a task source", /ProjectDocumentTaskSource|TaskSourceV1|discover_tasks|get_task\(/],
      ["a store", /PlatformStore|DecisionLog|BlobStore|IdempotencyStore|CREATE TABLE|INSERT INTO/],
      ["the filesystem", /from "node:fs"|readFileSync|writeFileSync|from "node:path"/],
      ["network or process", /node:(child_process|net|http|https)|\bfetch\(/],
      ["a clock", /Date\.now|new Date\(/],
      ["randomness", /Math\.random|randomUUID|randomBytes/],
      ["id allocation", /generateUlid|newUlid|nextId|createId/],
    ] as const) {
      assert.equal(pattern.test(code), false, `${relative(ROOT, file)} contains ${label}`);
    }
  }
});

test("B7-AC9: only the thin seam knows about the Batch 2 journal", () => {
  const seam = stripComments(readFileSync(join(DECISION, "decision-log.ts"), "utf8"));
  assert.match(seam, /from "\.\.\/store\/decision-log\.ts"/);
  // Even the seam introduces no second persistence abstraction.
  for (const pattern of [/DecisionRepository/, /EventBus/, /AuditEvent/, /Outbox/, /CREATE TABLE/]) {
    assert.equal(pattern.test(seam), false, `${pattern} is a forbidden abstraction`);
  }
});

test("B7-AC23: no capability grant is issued anywhere in the module", () => {
  scan("grant issuance", [/issueCapabilityGrant/, /grant_id/, /CapabilityGrant/, /TaskContract/]);
});

// --- B7-AC31 / state-machine boundary -------------------------------------------------------

test("no state machine, coordinator or Batch 8 persistence is pulled forward", () => {
  scan("Batch 8 territory", [
    /\bCoordinator\b/,
    /StateMachine/,
    /transition_table|applyTransition/,
    /PendingHumanDecision/,
    /BatchState|AttemptState|TaskState/,
    /CREATE TABLE|INSERT INTO|task_attempt|pending_human_decision/,
  ]);
});

test("no human-gate bypass or token machinery exists", () => {
  // TD §17.3 now defines the revalidation entry point, so re-validating is required, not banned.
  // What stays forbidden is anything that lets an approval skip deterministic validation.
  scan("a gate bypass", [
    /HumanGateApprovalToken/,
    /ResolvedHumanGateView/,
    /approval_bypass|approvalBypass/,
    /skip_token|skipToken/,
    /resume_cursor|resumeCursor/,
    /skipHumanGate|bypassV7|skipValidation/,
    /humanOverrideToken|approvalToken/,
    /approved\s*[:=]\s*true/,
  ]);
});

test("no generic framework is introduced", () => {
  scan("a generic framework", [
    /PolicyEngine/,
    /DecisionEngine/,
    /RuleRegistry/,
    /ValidationPipeline/,
    /OperationRegistry/,
    new RegExp(fragment("Author", "izationFramework")),
    /ReadModelRepository/,
    /schema_registry|SchemaRegistry/,
    /\bResult<[A-Z]/,
  ]);
});

test("B7-AC31: the Batch 2 migration is unchanged", () => {
  // Batch 7 owns no migration: the foundation migration is still v1 and still only its 3 tables.
  const foundation = MIGRATIONS[0] as Migration;
  const tables = [...foundation.statements.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map(
    (match) => match[1] as string,
  );
  assert.deepEqual(tables.sort(), ["blob", "decision_log", "idempotency"]);
  assert.deepEqual(
    { version: foundation.version, name: foundation.name },
    { version: 1, name: "foundation" },
  );

  // And `core/decision` itself contains no DDL at all.
  scan("a migration", [/CREATE TABLE/, /schema_migrations/]);
});

// --- independence ---------------------------------------------------------------------------

test("no backend or project vocabulary in the Batch 7 module", () => {
  const token = (...parts: readonly string[]): string => parts.join("");
  const forbidden: RegExp[] = [
    new RegExp(token("open", "claw"), "i"),
    new RegExp(token("durable", "[-_ ]?", "jobs"), "i"),
    new RegExp(token("infra", "[-_ ]?", "scanner"), "i"),
    new RegExp(token("session", "[-_]?", "key"), "i"),
    new RegExp(`\\b${token("a", "gy")}\\b`, "i"),
    new RegExp(token("PROJECT", "_STATUS")),
    new RegExp(token("READY", "_ITEM")),
    new RegExp(token("THIN", "_FOUNDATION")),
    new RegExp(token("MAJOR", "_FOUNDATION")),
    new RegExp(token("CONTRACT", "_CHANGE")),
    new RegExp(token("U-", "54")),
    new RegExp(token("permission", "Mode")),
    new RegExp(token("tool_", "allowlist")),
  ];
  for (const file of sources()) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      const match = pattern.exec(content);
      assert.equal(match, null, `${relative(ROOT, file)} contains ${match?.[0] ?? ""}`);
    }
  }
});

test("no raw runtime credential-bearing identifier is handled (I-TD7)", () => {
  scan("a restricted identifier", [
    new RegExp(`\\b${fragment("token", "s?")}\\b`, "i"),
    new RegExp(fragment("cre", "dential"), "i"),
    new RegExp(`["']${fragment("Author", "ization")}["']`),
    new RegExp(`\\b${fragment("sec", "ret", "s?")}\\b`, "i"),
    new RegExp(fragment("api", "[_-]?", "key"), "i"),
    new RegExp(fragment("bea", "rer"), "i"),
  ]);
});
