/**
 * RC-1 ~ RC-24 — the Backend v1 RuntimeResultChannel (RA-2b).
 *
 * The channel is exercised the way the two sides really use it: the adapter arms and collects, and
 * a "tool" submits knowing only the session the host spawned it with. No live backend, no gateway,
 * no network — the point is the binding semantics, and those are pure.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AUDITOR_VERDICT_PROTOCOL,
  ResultChannelConflict,
  RuntimeResultChannel,
  withCollectedResult,
} from "../adapters/runtime-result-channel/index.ts";
import type { RuntimeTurnResult } from "../adapters/interfaces/runtime-adapter.ts";
import type {
  RuntimeSessionHandle,
  RuntimeTurnHandle,
} from "../adapters/interfaces/handles.ts";
import { SECRET_BEARING_KEY_CATEGORIES } from "../core/store/restricted-key-denylist.ts";
import { withGitRepo } from "./support/temp-git-repo.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Host-injected session identities. The submitting side never chooses these. */
const SESSION_A = "agent:alpha:managed:1";
const SESSION_B = "agent:alpha:managed:2";
const AGENT_B_SESSION = "agent:beta:managed:1";

const verdict = (summary = "reviewed") => ({
  verdict: "AUDIT_PASS",
  findings: [{ id: "f1", severity: "info", description: summary, evidence_refs: [] }],
  reviewed: {
    candidate_commit: "9a8b7c",
    task_contract_hash: `sha256:${"0".repeat(64)}`,
    evidence_ids: ["01JQ8ZK5T7RC9V2W4X6Y8Z0ABC"],
  },
});

function withChannel<T>(body: (channel: RuntimeResultChannel, root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "platform-result-channel-"));
  try {
    return body(new RuntimeResultChannel(root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const terminal = (): RuntimeTurnResult => ({
  session_handle: { session: "s1" } as unknown as RuntimeSessionHandle,
  turn_handle: { turn: "t1" } as unknown as RuntimeTurnHandle,
  backend_status: "COMPLETED",
  termination_reason: "end_turn",
  started_at: "t1",
  completed_at: "t2",
  provenance: {
    runtime_backend: "backend-v1",
    identity_authority: "BACKEND",
    result_channel: "TURN_TEXT",
  },
});

// --- RC-1 ~ RC-5: the Auditor path ---------------------------------------------------------------

test("RC-1 / RC-3: a read-only Auditor submits a verdict and the adapter collects it", () => {
  withChannel((channel) => {
    channel.arm(SESSION_A, "turn-1");

    // The submitting side has no repository capability at all — it writes nothing but this call.
    assert.deepEqual(channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict()), {
      accepted: true,
      replayed: false,
    });

    const collected = channel.collect(SESSION_A, "turn-1");
    assert.equal(collected?.protocol, AUDITOR_VERDICT_PROTOCOL);
    assert.deepEqual(collected?.body, verdict());
  });
});

test("RC-4 / RC-5: the artifact sets the channel provenance and never the terminal status", () => {
  withChannel((channel) => {
    channel.arm(SESSION_A, "turn-1");
    channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict());
    const collected = channel.collect(SESSION_A, "turn-1");

    const withResult = withCollectedResult(terminal(), collected);
    assert.equal(withResult.provenance.result_channel, "RUNTIME_RESULT_CHANNEL", "RC-4");
    assert.equal(withResult.structured_output?.protocol, AUDITOR_VERDICT_PROTOCOL);
    // RC-5 — the backend's own terminal primitive still decides this, and the channel cannot move it.
    assert.equal(withResult.backend_status, "COMPLETED");
    for (const status of ["CANCELLED", "TIMEOUT", "RUNTIME_ERROR", "SESSION_LOST"] as const) {
      const other = withCollectedResult({ ...terminal(), backend_status: status }, collected);
      assert.equal(other.backend_status, status);
    }
  });
});

// --- RC-2 / RC-21: the repository is untouched ------------------------------------------------------

test("RC-2 / RC-21: submitting writes nothing into any repository", () => {
  withGitRepo((repo) => {
    repo.commit({ path: "a.txt", content: "a\n", message: "A" });
    const before = repo.git(["status", "--porcelain"]);

    withChannel((channel, root) => {
      // The channel root is somewhere else entirely.
      assert.equal(root.startsWith(repo.root), false);
      channel.arm(SESSION_A, "turn-1");
      channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict());
      assert.notEqual(channel.collect(SESSION_A, "turn-1"), undefined);
    });

    assert.equal(repo.git(["status", "--porcelain"]), before, "no tracked or untracked change");
    assert.equal(repo.git(["diff"]), "", "RC-21: repository diff is empty");
  });
});

// --- RC-6 / RC-7: nothing is fabricated ---------------------------------------------------------------

test("RC-6: a turn with no submission yields no structured output", () => {
  withChannel((channel) => {
    channel.arm(SESSION_A, "turn-1");
    assert.equal(channel.collect(SESSION_A, "turn-1"), undefined);

    const result = withCollectedResult(terminal(), undefined);
    assert.equal(result.structured_output, undefined);
    assert.equal(result.provenance.result_channel, "TURN_TEXT");
  });
});

test("RC-7: a malformed or unknown-protocol submission is rejected and stores nothing", () => {
  withChannel((channel) => {
    channel.arm(SESSION_A, "turn-1");

    for (const [reason, protocol, body] of [
      ["UNKNOWN_PROTOCOL", "platform-actor-result-v1", verdict()],
      ["MALFORMED_BODY", AUDITOR_VERDICT_PROTOCOL, { verdict: "AUDIT_PASS" }],
      ["MALFORMED_BODY", AUDITOR_VERDICT_PROTOCOL, { ...verdict(), extra: 1 }],
      ["MALFORMED_BODY", AUDITOR_VERDICT_PROTOCOL, "AUDIT_PASS"],
      ["MALFORMED_BODY", AUDITOR_VERDICT_PROTOCOL, { ...verdict(), verdict: "LOOKS_FINE" }],
    ] as const) {
      assert.deepEqual(channel.submit(SESSION_A, protocol, body), { accepted: false, reason });
      assert.equal(channel.collect(SESSION_A, "turn-1"), undefined, `${reason} stored something`);
    }
  });
});

// --- RC-8 / RC-9 / RC-15: one verdict per turn --------------------------------------------------------

test("RC-8 / RC-9: an identical replay is idempotent, a different verdict is refused", () => {
  withChannel((channel) => {
    channel.arm(SESSION_A, "turn-1");
    assert.equal(channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict()).accepted, true);

    assert.deepEqual(channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict()), {
      accepted: true,
      replayed: true,
    });
    assert.deepEqual(channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict("changed mind")), {
      accepted: false,
      reason: "ALREADY_SUBMITTED",
    });
    // The first verdict stands; the model cannot overwrite it.
    assert.deepEqual(channel.collect(SESSION_A, "turn-1")?.body, verdict());
  });
});

test("RC-15: the submitting side names no turn, so it can redirect nothing", () => {
  const source = readFileSync(join(ROOT, "adapters/runtime-result-channel/channel.ts"), "utf8");
  const submit = source.slice(source.indexOf("  submit("), source.indexOf("  collect("));
  // The signature carries a session (host-injected), a protocol and a payload — no turn, no
  // request id, no operation key.
  assert.match(submit, /submit\(session_ref: string, protocol: string, body: unknown\)/);
  const parameters = submit.slice(submit.indexOf("("), submit.indexOf(")"));
  for (const forbidden of [/turn/, /requestId/, /op_key/, /handle/]) {
    assert.equal(forbidden.test(parameters), false, `submit accepts ${forbidden}`);
  }

  withChannel((channel) => {
    channel.arm(SESSION_A, "turn-1");
    channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict());
    // Even knowing another token exists, nothing can be aimed at it.
    assert.equal(channel.collect(SESSION_A, "turn-2"), undefined);
  });
});

// --- RC-10 ~ RC-14 / RC-16: isolation ------------------------------------------------------------------

test("RC-10: one session cannot submit into another session's turn", () => {
  withChannel((channel) => {
    channel.arm(SESSION_A, "turn-1");
    assert.deepEqual(channel.submit(SESSION_B, AUDITOR_VERDICT_PROTOCOL, verdict()), {
      accepted: false,
      reason: "NO_ACTIVE_TURN",
    });
    assert.equal(channel.collect(SESSION_A, "turn-1"), undefined, "A's slot is untouched");
  });
});

test("RC-11: one agent cannot submit into another agent's session", () => {
  withChannel((channel) => {
    channel.arm(SESSION_A, "turn-1");
    assert.deepEqual(channel.submit(AGENT_B_SESSION, AUDITOR_VERDICT_PROTOCOL, verdict()), {
      accepted: false,
      reason: "NO_ACTIVE_TURN",
    });

    // Each session gets its own slot, and both may be armed independently.
    channel.arm(AGENT_B_SESSION, "turn-b");
    channel.submit(AGENT_B_SESSION, AUDITOR_VERDICT_PROTOCOL, verdict("beta"));
    assert.equal(channel.collect(SESSION_A, "turn-1"), undefined);
    assert.deepEqual(channel.collect(AGENT_B_SESSION, "turn-b")?.body, verdict("beta"));
  });
});

test("RC-12: a submission outside any turn is rejected", () => {
  withChannel((channel) => {
    assert.deepEqual(channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict()), {
      accepted: false,
      reason: "NO_ACTIVE_TURN",
    });
  });
});

test("RC-13 / RC-14 / RC-18: a result belongs to its own turn and cannot outlive it", () => {
  withChannel((channel) => {
    channel.arm(SESSION_A, "turn-1");
    channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict("first turn"));

    // RC-13 — collected by turn 1 and by nothing else.
    assert.deepEqual(channel.collect(SESSION_A, "turn-1")?.body, verdict("first turn"));
    assert.equal(channel.collect(SESSION_A, "turn-2"), undefined);

    // RC-18 — closing the slot makes the turn uncollectable and unsubmittable.
    channel.close(SESSION_A, "turn-1");
    assert.equal(channel.collect(SESSION_A, "turn-1"), undefined);
    assert.deepEqual(channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict("late")), {
      accepted: false,
      reason: "NO_ACTIVE_TURN",
    });

    // RC-14 — turn 2 starts clean; the earlier verdict is not visible to it.
    channel.arm(SESSION_A, "turn-2");
    assert.equal(channel.collect(SESSION_A, "turn-2"), undefined);
  });
});

test("RC-16: a second concurrent turn on one session fails closed", () => {
  withChannel((channel) => {
    channel.arm(SESSION_A, "turn-1");
    // Re-arming the same turn is harmless (a retry of the same start).
    channel.arm(SESSION_A, "turn-1");
    // A different turn while the first is uncollected is a contradiction, never a replacement.
    assert.throws(() => channel.arm(SESSION_A, "turn-2"), ResultChannelConflict);

    channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict());
    assert.notEqual(channel.collect(SESSION_A, "turn-1"), undefined, "turn 1 kept its slot");
  });
});

// --- RC-17 / RC-19: ordering and cleanup -----------------------------------------------------------------

test("RC-17: a write that lands before collection is never lost", () => {
  withChannel((channel) => {
    // The tool call must be answered before the agent can finish its turn, so the write happens
    // before the terminal read. The collection boundary is the armed token, not a timer, so there
    // is no window in which a committed write is read as absent.
    channel.arm(SESSION_A, "turn-1");
    channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict());
    assert.notEqual(channel.collect(SESSION_A, "turn-1"), undefined);
    assert.notEqual(channel.collect(SESSION_A, "turn-1"), undefined, "collection is not destructive");
  });
});

test("RC-19: a slot left behind by a failed cleanup cannot contaminate the next turn", () => {
  withChannel((channel) => {
    channel.arm(SESSION_A, "turn-1");
    channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict("stale"));
    // Cleanup never ran — the slot is still on disk with turn 1's verdict in it.
    assert.throws(() => channel.arm(SESSION_A, "turn-2"), ResultChannelConflict);
    assert.equal(channel.collect(SESSION_A, "turn-2"), undefined, "turn 2 collects nothing");
  });
});

test("RC-19: an unreadable slot is treated as no slot", () => {
  withChannel((channel, root) => {
    channel.arm(SESSION_A, "turn-1");
    const [file] = readdirSync(root);
    writeFileSync(join(root, file as string), "{ not json", "utf8");
    assert.equal(channel.collect(SESSION_A, "turn-1"), undefined);
    assert.deepEqual(channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict()), {
      accepted: false,
      reason: "NO_ACTIVE_TURN",
    });
  });
});

// --- RC-20 / RC-22 / boundary guards ------------------------------------------------------------------------

test("RC-20: nothing privileged is written to the channel's storage", () => {
  withChannel((channel, root) => {
    channel.arm(SESSION_A, "turn-1");
    channel.submit(SESSION_A, AUDITOR_VERDICT_PROTOCOL, verdict());

    const names = readdirSync(root);
    const contents = names.map((name) => readFileSync(join(root, name), "utf8")).join("\n");
    const everything = `${names.join("\n")}\n${contents}`.toLowerCase();
    assert.equal(everything.includes(SESSION_A.toLowerCase()), false, "the session key is not stored");
    for (const category of SECRET_BEARING_KEY_CATEGORIES) {
      assert.equal(everything.includes(category), false, category);
    }
  });
});

test("RC-22: an Actor turn with no structured protocol keeps the TURN_TEXT reading", () => {
  const result = withCollectedResult(terminal(), undefined);
  assert.equal(result.provenance.result_channel, "TURN_TEXT");
  assert.equal(result.structured_output, undefined);
  assert.equal(result.backend_status, "COMPLETED", "still a successful turn");
});

test("§34: no Core production code gains result-channel or backend vocabulary", () => {
  const term = (...parts: readonly string[]): RegExp => new RegExp(parts.join(""), "i");
  const core = readdirSync(join(ROOT, "core"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(ROOT, "core", entry.name))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(ROOT, "core", entry.name, name)),
    );

  for (const file of core) {
    // The one module whose job is to name the I-TD7 categories keeps its existing exemption.
    if (relative(ROOT, file) === "core/store/restricted-key-denylist.ts") continue;
    const content = readFileSync(file, "utf8");
    for (const pattern of [
      /RuntimeResultChannel/,
      /runtime-result-channel/,
      term("plugin", "[-_]?", "tools"),
      term("OPEN", "CLAW", "_TOOLS_MCP"),
      term("session", "[-_]?", "key"),
      /result_slot|resultSlot|submit_result/,
    ]) {
      assert.equal(pattern.test(content), false, `${relative(ROOT, file)} matches ${pattern}`);
    }
  }
});

test("§3: the channel module reaches no repository primitive", () => {
  const code = readFileSync(join(ROOT, "adapters/runtime-result-channel/channel.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const forbidden of [/RepositoryAdapter/, /create_feature_workspace/, /git/i, /worktree/]) {
    assert.equal(forbidden.test(code), false, `the channel reaches ${forbidden}`);
  }
});
