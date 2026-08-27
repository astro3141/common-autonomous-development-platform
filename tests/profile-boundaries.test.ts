/**
 * B4-AC15 / B4-AC16 — the Profile module's boundaries: no YAML or filesystem dependency, and no
 * later batch pulled forward (TD §7.1 input boundary; Batch scope).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROFILE = join(ROOT, "core/profile");

const sources = (): string[] =>
  readdirSync(PROFILE)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(PROFILE, name));

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("B4-AC15: the compiler has no YAML, filesystem or other external dependency", () => {
  const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
    ["filesystem access", /from "node:fs"|readFileSync|writeFileSync/],
    ["YAML parsing", /yaml|YAML/],
    ["process or network access", /node:(child_process|net|http|https|sqlite)|\bfetch\(/],
    ["nondeterminism", /Math\.random|Date\.now|new Date\(/],
  ];
  for (const file of sources()) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const [label, pattern] of forbidden) {
      assert.equal(pattern.test(code), false, `${file} contains ${label}`);
    }
  }
});

test("B4-AC15: the compiler imports only Core schema primitives", () => {
  for (const file of sources()) {
    const specifiers = [...readFileSync(file, "utf8").matchAll(/ from "([^"]+)";/g)].map(
      (match) => match[1] as string,
    );
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith("./") || specifier.startsWith("../schemas/"),
        `${file} imports "${specifier}" from outside core`,
      );
    }
  }
});

test("B4-AC16: no Capability, Decision Validator or TaskSource logic was pulled forward", () => {
  const forwardWork: ReadonlyArray<readonly [string, RegExp]> = [
    ["capability broker / manifest evaluation", /Broker|Manifest|declared_enforcement|dry-?run/i],
    ["backend compatibility gate", /\bV10\b|BACKEND_INCOMPATIBLE|compatib/i],
    ["decision validator", /\bV[1-9]\b|proposal|validateProposal/i],
    // The Profile *declares* task_sources/contract_sources; adapter and builder logic is what
    // must not appear.
    ["task source adapter / contract builder", /discover_tasks|get_task\(|TaskDefinition|TaskContractSnapshot/],
    ["store or persistence", /sqlite|PlatformStore|migration|operator_action|pending_human/i],
    ["state machine / coordinator", /StateMachine|Coordinator|transition\(/],
  ];
  for (const file of sources()) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const [label, pattern] of forwardWork) {
      assert.equal(pattern.test(code), false, `${file} contains ${label}`);
    }
  }
});

test("B4-AC16: capability_requirements is validated for shape only", () => {
  // The compiler reads the merge operation's presence, never an assurance comparison.
  const compiler = stripComments(readFileSync(join(PROFILE, "compiler.ts"), "utf8"));
  assert.equal(/accepted\.(includes|some|every)/.test(compiler), false);
  assert.equal(/ENFORCED/.test(compiler), false, "no enforcement comparison belongs in Batch 4");
});
