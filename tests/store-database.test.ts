/**
 * B2-AC1 (SQLite durability), B2-AC2 (WAL), single-writer boundary — TD D2, §18.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MIGRATIONS } from "../core/store/migrations.ts";
import { tempStore } from "./support/temp-store.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("B2-AC2: the database itself reports WAL journal mode", () => {
  const temp = tempStore();
  const store = temp.open();
  try {
    assert.equal(store.journalMode, "wal");
    // The -wal sidecar is the on-disk evidence that WAL is really in effect.
    assert.ok(existsSync(`${temp.path}-wal`), "expected a -wal file next to the database");
  } finally {
    store.close();
    temp.dispose();
  }
});

test("B2-AC2: WAL survives reopen", () => {
  const temp = tempStore();
  const first = temp.open();
  first.close();
  const second = temp.open();
  try {
    assert.equal(second.journalMode, "wal");
  } finally {
    second.close();
    temp.dispose();
  }
});

test("B2-AC1: foundation data survives close and reopen", () => {
  const temp = tempStore();
  const bytes = new Uint8Array([0x00, 0xff, 0x0d, 0x0a, 0x41]);

  const first = temp.open();
  let contentHash: string;
  try {
    contentHash = first.withTransaction(() => {
      const hash = first.blobs.put(bytes);
      first.decisions.append({ kind: "example", refKey: "ref-1", payload: { n: 1 } });
      first.idempotency.beginIntent("op:example:1");
      return hash;
    });
  } finally {
    first.close();
  }

  const second = temp.open();
  try {
    assert.deepEqual(second.blobs.get(contentHash), bytes);
    assert.equal(second.decisions.count(), 1);
    assert.equal(second.decisions.read()[0]?.refKey, "ref-1");
    assert.equal(second.idempotency.get("op:example:1")?.state, "INTENT");
    assert.equal(second.schemaVersion, MIGRATIONS.length);
  } finally {
    second.close();
    temp.dispose();
  }
});

test("single-writer boundary: the store opens exactly one connection", () => {
  const storeDirectory = join(ROOT, "core/store");
  const sources = readdirSync(storeDirectory).filter((name) => name.endsWith(".ts"));

  const opens = sources.flatMap((name) => {
    const content = readFileSync(join(storeDirectory, name), "utf8");
    return [...content.matchAll(/new DatabaseSync\(/g)].map(() => name);
  });
  assert.deepEqual(opens, ["database.ts"], "only database.ts may construct a connection");

  // No public API hands out a second writable connection or raw SQL execution.
  const publicSurface = readFileSync(join(storeDirectory, "platform-store.ts"), "utf8");
  assert.equal(/\bexec\s*\(/.test(publicSurface), false);
  assert.equal(/get database\(|\.database\b|readonly database/.test(publicSurface), false);
});
