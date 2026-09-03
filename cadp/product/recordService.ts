/**
 * Disposable non-development target (TD §6.4 record-service contract, #89 Vertical B shape):
 * a real, separate HTTP service with its own durable store, key-based dedup, and an
 * authoritative primary read (`X-Read-Authority: primary`). Fault injection is target-side
 * (admin endpoint), so ambiguity scenarios are real timeouts after real commits.
 *
 * Run: node cadp/product/recordService.ts <port> <dbPath>
 */

import * as http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export interface RecordServiceHandle {
  readonly port: number;
  close(): void;
}

export function startRecordService(port: number, dbPath: string, apiKey?: string): Promise<RecordServiceHandle> {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (
      record_id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      body BLOB NOT NULL,
      body_digest TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS write_log (
      idempotency_key TEXT NOT NULL,
      at TEXT NOT NULL
    );
  `);

  // Target-side fault injection: "timeout_after_commit" commits the write, then never responds.
  let faultMode: "none" | "timeout_after_commit" | "unavailable" | "replica" = "none";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://record-service");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/whoami") {
      return send(200, { tenant: "cadp-disposable", principal: "record-service-key-1" });
    }

    // Governed credential seam (TD §4.1: record-service API key custody): every mutating or
    // authoritative call requires the key only the PEP holds.
    if (apiKey !== undefined && req.headers["x-api-key"] !== apiKey) {
      return send(401, { error: "unauthenticated", detail: "X-Api-Key required" });
    }

    if (req.method === "POST" && url.pathname === "/admin/fault") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        faultMode = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { mode: typeof faultMode }).mode;
        send(200, { mode: faultMode });
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/records") {
      const key = url.searchParams.get("idempotency_key");
      if (faultMode === "unavailable") {
        res.destroy();
        return;
      }
      const rows = (key === null
        ? db.prepare("SELECT record_id, tenant, resource_id, idempotency_key, body_digest, created_at FROM records ORDER BY record_id").all()
        : db.prepare("SELECT record_id, tenant, resource_id, idempotency_key, body_digest, created_at FROM records WHERE idempotency_key = ?").all(key)) as Array<Record<string, unknown>>;
      const log = key === null ? [] : (db.prepare("SELECT at FROM write_log WHERE idempotency_key = ?").all(key) as Array<Record<string, unknown>>);
      if (faultMode === "replica") {
        // Eventual-consistency replica: possibly stale, and it says so by NOT claiming primary.
        return send(200, { records: [], write_log: [] });
      }
      return send(200, { records: rows, write_log: log }, { "X-Read-Authority": "primary" });
    }

    if (req.method === "PUT" && url.pathname === "/records") {
      if (faultMode === "unavailable") {
        // Hard outage: the connection dies before the request is processed — nothing lands.
        res.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          tenant: string; resource_id: string; idempotency_key: string; body_base64: string;
        };
        if (typeof body.idempotency_key !== "string" || body.idempotency_key.length === 0 || typeof body.tenant !== "string") {
          return send(422, { error: "validation_failed", detail: "idempotency_key and tenant are required" });
        }
        const bytes = Buffer.from(body.body_base64, "base64");
        const digest = createHash("sha256").update(bytes).digest("hex");
        const existing = db.prepare("SELECT record_id, body_digest FROM records WHERE idempotency_key = ?").get(body.idempotency_key) as
          | { record_id: number; body_digest: string }
          | undefined;
        let recordId: number;
        if (existing !== undefined) {
          recordId = existing.record_id; // NATIVE_KEY dedup: same key never writes twice
        } else {
          db.prepare("INSERT INTO write_log (idempotency_key, at) VALUES (?, ?)").run(body.idempotency_key, new Date().toISOString());
          const r = db
            .prepare("INSERT INTO records (tenant, resource_id, idempotency_key, body, body_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(body.tenant, body.resource_id, body.idempotency_key, bytes, digest, new Date().toISOString());
          recordId = Number(r.lastInsertRowid);
        }
        if (faultMode === "timeout_after_commit") {
          faultMode = "none"; // one-shot: the write happened, the response never arrives
          return; // leave the socket hanging
        }
        return send(existing !== undefined ? 200 : 201, {
          record_id: recordId,
          idempotency_key: body.idempotency_key,
          body_digest: digest,
          deduplicated: existing !== undefined,
        });
      });
      return;
    }

    send(404, { error: "not_found" });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: boundPort,
        close: () => {
          server.close();
          db.close();
        },
      });
    });
  });
}

if (process.argv[1]?.endsWith("recordService.ts")) {
  const port = Number(process.argv[2] ?? 0);
  const dbPath = process.argv[3] ?? "record-service.sqlite";
  const apiKey = process.env["RECORD_SERVICE_API_KEY"];
  startRecordService(port, dbPath, apiKey).then((h) => {
    console.log(JSON.stringify({ listening: h.port }));
  });
}
