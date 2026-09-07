/**
 * PR-title derivation (cadp/product/activities.ts): `prTitleFromWorkItem` replaces the bare
 * `work_item.slice(0, 80)` that cut long work items mid-word with no marker. Proven here:
 *
 *   PT1  a short single-line item passes through unchanged;
 *   PT2  a long item is truncated at a word boundary within 80 chars with a trailing ellipsis;
 *   PT3  a multi-line item contributes only its first line.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { prTitleFromWorkItem } from "../product/activities.ts";

test("PT1: short work item is unchanged", () => {
  const item = "Fix the login redirect loop";
  assert.equal(prTitleFromWorkItem(item), item);
});

test("PT2: long work item truncates at a word boundary with a trailing ellipsis", () => {
  const item =
    "Refactor the governed effect driver so that every admission request converges through durable kernel state before dispatch";
  const title = prTitleFromWorkItem(item);
  assert.ok(title.length <= 80, `title too long: ${title.length}`);
  assert.ok(title.endsWith("…"), `missing ellipsis: ${title}`);
  // No mid-word cut: the text before the ellipsis is a whole-word prefix of the item.
  const head = title.slice(0, -1);
  assert.ok(item.startsWith(head), `not a prefix: ${head}`);
  assert.equal(item[head.length], " ", "truncation landed mid-word");
});

test("PT3: multi-line work item uses only the first line", () => {
  const item = "Tighten broker RPC timeouts\n\nDetails: undici's implicit timeout is shorter than the declared budget.";
  assert.equal(prTitleFromWorkItem(item), "Tighten broker RPC timeouts");
});
