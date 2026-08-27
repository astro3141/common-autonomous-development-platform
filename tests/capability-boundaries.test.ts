/**
 * B5-AC22 ~ B5-AC24 — the capability module is a pure Core calculation and pulls no later batch
 * forward.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CAPABILITY = join(ROOT, "core/capability");

const sources = (): string[] =>
  readdirSync(CAPABILITY)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(CAPABILITY, name));

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("B5-AC13: no clock, randomness or I/O anywhere in the capability module", () => {
  const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
    ["clock", /Date\.now|new Date\(|performance\.now/],
    ["randomness", /Math\.random|randomUUID|randomBytes/],
    ["filesystem", /from "node:fs"|readFileSync|writeFileSync/],
    ["database", /from "node:sqlite"|PlatformStore/],
    ["process or network", /node:(child_process|net|http|https)|\bfetch\(|execSync|spawnSync/],
  ];
  for (const file of sources()) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const [label, pattern] of forbidden) {
      assert.equal(pattern.test(code), false, `${relative(ROOT, file)} contains ${label}`);
    }
  }
});

test("B5-AC13: the Broker takes grant_id as input and never generates identity", () => {
  const broker = stripComments(readFileSync(join(CAPABILITY, "broker.ts"), "utf8"));
  assert.match(broker, /grant_id: input\.grant_id/);
  assert.equal(/generateUlid|newUlid|createId|nextId/.test(broker), false);
});

test("B5-AC22 / B5-AC23: no Decision Validator, Task Contract or persistence logic", () => {
  const forwardWork: ReadonlyArray<readonly [string, RegExp]> = [
    ["decision validator", /\bV1[01]\b|POLICY_BACKEND_INCOMPATIBLE|validateProposal|decision_log/],
    ["state machine / coordinator", /Coordinator|StateMachine|\bHELD\b|CAPABILITY_BOUNDARY_CHANGED/],
    ["task contract builder", /TaskContractSnapshot|buildTaskContract|backend_requirements/],
    ["persistence", /migration|INSERT INTO|capability_grant\s*\(/i],
    ["manifest loader", /loadManifest|readManifest|manifestRegistry/i],
  ];
  for (const file of sources()) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const [label, pattern] of forwardWork) {
      assert.equal(pattern.test(code), false, `${relative(ROOT, file)} contains ${label}`);
    }
  }
});

test("B5-AC24: no adapter is invoked — only Batch 3 types are imported", () => {
  for (const file of sources()) {
    const source = readFileSync(file, "utf8");
    const specifiers = [...source.matchAll(/ from "([^"]+)";/g)].map((match) => match[1] as string);
    for (const specifier of specifiers) {
      const allowed =
        specifier.startsWith("./") ||
        specifier.startsWith("../schemas/") ||
        specifier.startsWith("../profile/") ||
        // Receipt validation consumes the Batch 3 boundary values, so it imports their types.
        specifier === "../../adapters/interfaces/index.ts";
      assert.ok(allowed, `${relative(ROOT, file)} imports "${specifier}"`);
    }
    // Adapter *types* may be imported; adapter methods may not be called.
    const code = stripComments(source);
    assert.equal(
      /\.(spawn_session|send_turn|status|start|run_verification|deliver|snapshot_canonical)\(/.test(code),
      false,
      `${relative(ROOT, file)} calls an adapter method`,
    );
  }
});

test("B5-AC21: features and applied_means are never read as authority", () => {
  for (const file of sources()) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.equal(
      /features\.[a-z_]+|features\[["']/.test(code),
      false,
      `${relative(ROOT, file)} reads inside features`,
    );
    assert.equal(
      /applied_means\.(includes|some|every|filter|map)|applied_means\[/.test(code),
      false,
      `${relative(ROOT, file)} interprets applied_means`,
    );
  }
});

test("B5-AC28: no prompt-derived enforcement inference exists", () => {
  for (const file of sources()) {
    const code = stripComments(readFileSync(file, "utf8"));
    assert.equal(/instruction|prompt|systemPrompt/i.test(code), false);
  }
});

test("no backend or project vocabulary in the capability module", () => {
  const token = (...parts: readonly string[]): string => parts.join("");
  const forbidden: RegExp[] = [
    new RegExp(token("open", "claw"), "i"),
    new RegExp(token("durable", "[-_ ]?", "jobs"), "i"),
    new RegExp(`\\b${token("ac", "px?")}\\b`, "i"),
    new RegExp(token("infra", "[-_ ]?", "scanner"), "i"),
    new RegExp(token("session", "[-_]?", "key"), "i"),
    new RegExp(`\\b${token("a", "gy")}\\b`, "i"),
    new RegExp(token("READY", "_ITEM")),
    new RegExp(token("THIN", "_FOUNDATION")),
    new RegExp(token("MAJOR", "_FOUNDATION")),
    new RegExp(token("CONTRACT", "_CHANGE")),
    new RegExp(token("PROJECT", "_STATUS")),
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
