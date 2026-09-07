import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FAILED_SESSION_RETENTION, preserveFailedSession } from "../product/surfaceBroker.ts";
import { runReviewer, runVerifier } from "../product/isolation.ts";
import type { CreationOutcome, IsolationConfig, SurfaceCommand, SurfaceCommandPort } from "../product/isolation.ts";

const RUN = { status: 137, stdout: "worker stdout tail", stderr: "exceeded its declared bound" };

const ISOLATION: IsolationConfig = {
  worker_image: "cadp-surface:conformance",
  egress_network: "cadp-conformance-int",
  egress_proxy: "cadp-conformance-proxy:8888",
};

function done<T>(value: T): SurfaceCommand<T> {
  return { result: Promise.resolve(value), closed: Promise.resolve(), cancel() {} };
}

async function constructedArgs(run: (port: SurfaceCommandPort) => Promise<unknown>): Promise<readonly string[]> {
  let args: readonly string[] | undefined;
  const port: SurfaceCommandPort = {
    create(_container, inputArgs) {
      args = inputArgs;
      return done<CreationOutcome>({ creation: "REJECTED", detail: "fixture" });
    },
    launch: () => { throw new Error("rejected fixture must not launch"); },
    terminate: () => { throw new Error("rejected fixture must not terminate"); },
    observe: () => { throw new Error("rejected fixture must not observe"); },
  };
  await run(port);
  assert.ok(args !== undefined);
  return args;
}

const REVIEWER_BASELINE = [
  "--network", "cadp-conformance-int",
  "-e", "HTTPS_PROXY=http://cadp-conformance-proxy:8888",
  "-e", "HTTP_PROXY=http://cadp-conformance-proxy:8888",
  "-e", "https_proxy=http://cadp-conformance-proxy:8888",
  "-e", "http_proxy=http://cadp-conformance-proxy:8888",
  "-v", "/checkout:/ws:ro",
  "-e", "HOME=/root",
  "-e", "CLAUDE_CODE_OAUTH_TOKEN=token",
  "-w", "/ws",
  "cadp-surface:conformance",
  "claude", "--print", "review",
] as const;

test("runReviewer without sessionsDir preserves the exact docker args", async () => {
  const args = await constructedArgs((port) => runReviewer(ISOLATION, {
    workspace: "/checkout",
    auth: { kind: "oauth_env", env_var: "CLAUDE_CODE_OAUTH_TOKEN", token: "token" },
    argv: ["claude", "--print", "review"],
  }, { port }));
  assert.deepEqual(args, REVIEWER_BASELINE);
});

test("runReviewer adds exactly one writable sessions bind and keeps the workspace read-only", async () => {
  const args = await constructedArgs((port) => runReviewer(ISOLATION, {
    workspace: "/checkout",
    auth: { kind: "oauth_env", env_var: "CLAUDE_CODE_OAUTH_TOKEN", token: "token" },
    sessionsDir: "/host/reviewer-sessions",
    sessionsContainerDir: "projects",
    argv: ["claude", "--print", "review"],
  }, { port }));
  const expected = [...REVIEWER_BASELINE];
  expected.splice(expected.indexOf("-w"), 0, "-v", "/host/reviewer-sessions:/root/.claude/projects");
  assert.deepEqual(args, expected);
  assert.ok(args.includes("/checkout:/ws:ro"));
  assert.equal(args.filter((arg) => arg === "/host/reviewer-sessions:/root/.claude/projects").length, 1);
  assert.ok(!args.includes("/host/reviewer-sessions:/root/.claude/projects:ro"));
});

test("runVerifier constructed args remain unchanged", async () => {
  const args = await constructedArgs((port) => runVerifier(ISOLATION, {
    workspace: "/checkout",
    argv: ["node", "--test"],
  }, { port }));
  assert.deepEqual(args, [
    "--network", "none",
    "-v", "/checkout:/ws",
    "-w", "/ws",
    "cadp-surface:conformance",
    "node", "--test",
  ]);
});

function withFailedDir<T>(value: string | undefined, body: () => T): T {
  const old = process.env["CADP_FAILED_SESSIONS_DIR"];
  try {
    if (value === undefined) delete process.env["CADP_FAILED_SESSIONS_DIR"];
    else process.env["CADP_FAILED_SESSIONS_DIR"] = value;
    return body();
  } finally {
    if (old === undefined) delete process.env["CADP_FAILED_SESSIONS_DIR"];
    else process.env["CADP_FAILED_SESSIONS_DIR"] = old;
  }
}

test("failed-session retention is OFF when the deployment does not wire a directory", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-failsess-off-"));
  try {
    const sessions = join(root, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "chat_history.jsonl"), "{}\n");
    withFailedDir(undefined, () => preserveFailedSession(sessions, RUN, "item", "worker-status-137"));
    assert.deepEqual(readdirSync(root), ["sessions"], "no snapshot may appear anywhere without the env wiring");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed run's session tree, bounded output, and reason are preserved", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-failsess-keep-"));
  try {
    const sessions = join(root, "sessions", "%2Fws", "01a07692-0000-7000-8000-000000000000");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "chat_history.jsonl"), '{"model_id":"grok-4.6-build"}\n');
    const failed = join(root, "failed");
    withFailedDir(failed, () => preserveFailedSession(join(root, "sessions"), RUN, "item", "worker-status-137"));
    const [snap] = readdirSync(failed);
    assert.ok(snap !== undefined, "one snapshot directory exists");
    const meta = JSON.parse(readFileSync(join(failed, snap, "run.json"), "utf8")) as Record<string, unknown>;
    assert.equal(meta["status"], 137);
    assert.equal(meta["reason"], "worker-status-137");
    assert.equal(meta["work_item"], "item");
    assert.equal(
      readFileSync(join(failed, snap, "sessions", "%2Fws", "01a07692-0000-7000-8000-000000000000", "chat_history.jsonl"), "utf8"),
      '{"model_id":"grok-4.6-build"}\n',
      "the session tree is copied verbatim",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retention is bounded: oldest snapshots are pruned beyond the limit", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-failsess-prune-"));
  try {
    const sessions = join(root, "sessions");
    mkdirSync(sessions, { recursive: true });
    const failed = join(root, "failed");
    // Pre-seed FAILED_SESSION_RETENTION stale snapshots with lexicographically-older stamps.
    mkdirSync(failed, { recursive: true });
    for (let i = 0; i < FAILED_SESSION_RETENTION; i += 1) {
      mkdirSync(join(failed, `2000-01-01T00-00-00-000Z-stale${String(i).padStart(2, "0")}`));
    }
    withFailedDir(failed, () => preserveFailedSession(sessions, RUN, "item", "no-op-candidate"));
    const entries = readdirSync(failed).sort();
    assert.equal(entries.length, FAILED_SESSION_RETENTION, "count never exceeds the bound");
    assert.ok(!entries.includes("2000-01-01T00-00-00-000Z-stale00"), "the OLDEST snapshot was pruned");
    assert.ok(entries[entries.length - 1]!.startsWith("20"), "the new snapshot (newest stamp) survives");
    assert.ok(entries.includes("2000-01-01T00-00-00-000Z-stale01"), "newer stale snapshots survive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retention never breaks a run: an unwritable directory is swallowed", () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-failsess-safe-"));
  try {
    const sessions = join(root, "sessions");
    mkdirSync(sessions, { recursive: true });
    // A FILE at the failed-dir path makes every mkdir/copy under it fail.
    const failedAsFile = join(root, "failed-is-a-file");
    writeFileSync(failedAsFile, "not a directory");
    withFailedDir(failedAsFile, () => {
      assert.doesNotThrow(() => preserveFailedSession(sessions, RUN, "item", "worker-status-1"));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
