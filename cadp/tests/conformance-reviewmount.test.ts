import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { REVIEW_MOUNT_INSTRUCTION, brokerReview } from "../product/surfaceBroker.ts";

/**
 * #259 P0a. The Primary Reviewer used to be handed a fresh EMPTY directory as its mounted
 * workspace, so "read the governing TD section" was an impossible instruction and every verdict
 * rested on the supplied patch alone. These controls drive the REAL `brokerReview` — its real
 * clone, its real checkout, its real diff, its real docker argv construction — against a scripted
 * `docker` on PATH and a local origin, and read back the mount the broker actually asked for.
 *
 * What the scripted daemon records is what a container would have received: the create argv, plus
 * what the mounted host path CONTAINED at create time (its HEAD, its entries, a file that exists
 * only in the checkout and not in the patch). That is the difference between asserting a string
 * and establishing that the reviewer can open the repo.
 */

/** U+0000, constructed rather than written literally so this file holds no raw NUL byte. */
const NUL = String.fromCharCode(0);

const TD_TEXT = "# Governing TD\n\n§4.1 The reviewer measures the candidate against THIS text.\n";

interface DockerCreateRecord {
  readonly argv: readonly string[];
  readonly mount_source: string | null;
  readonly head: string | null;
  readonly entries: readonly string[];
  readonly td: string | null;
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@cadp.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@cadp.invalid" },
  }).trim();
}

/**
 * A local stand-in for the public GitHub origin: main carries the base commit (TD + impl), and the
 * candidate sits on the exact `refs/heads/cadp/candidate/<sha>` ref the broker fetches.
 */
function makeOrigin(root: string, candidateFiles: Record<string, string>): { origin_base: string; repo_full_name: string; candidate_sha: string } {
  const origin = join(root, "origin", "acme", "repo.git");
  mkdirSync(origin, { recursive: true });
  git(["init", "--quiet", "--initial-branch=main", "."], origin);
  writeFileSync(join(origin, "TECHNICAL_DESIGN.md"), TD_TEXT);
  writeFileSync(join(origin, "impl.ts"), "export const answer = 41;\n");
  git(["add", "-A"], origin);
  git(["commit", "--quiet", "-m", "base"], origin);

  for (const [name, content] of Object.entries(candidateFiles)) writeFileSync(join(origin, name), content);
  git(["add", "-A"], origin);
  git(["commit", "--quiet", "-m", "candidate"], origin);
  const candidate_sha = git(["rev-parse", "HEAD"], origin);
  // The candidate lives ONLY on the candidate ref, exactly as production does: main stays at base,
  // so the broker's merge-base diff has a real fork point to compute.
  git(["branch", `cadp/candidate/${candidate_sha}`, candidate_sha], origin);
  git(["reset", "--hard", "--quiet", "HEAD~1"], origin);
  return { origin_base: join(root, "origin"), repo_full_name: "acme/repo", candidate_sha };
}

/**
 * A scripted `docker` first on PATH. `info` succeeds (the broker's availability probe), `create`
 * records the argv AND observes the host path the broker asked to bind at /ws, then fails — a
 * REJECTED creation, which ends the run without a container ever starting.
 */
function scriptDocker(root: string): { stub_dir: string; record_path: string } {
  const stubDir = join(root, "bin");
  mkdirSync(stubDir, { recursive: true });
  const recordPath = join(root, "docker-create.json");
  const recorder = join(root, "recorder.mjs");
  writeFileSync(recorder, `
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "info") process.exit(0);
if (args[0] !== "create") process.exit(0);

const mount = args.find((a) => a.endsWith(":/ws:ro"));
const source = mount === undefined ? null : mount.slice(0, -":/ws:ro".length);
let head = null;
let entries = [];
let td = null;
if (source !== null) {
  try { head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { head = null; }
  try { entries = readdirSync(source); } catch { entries = []; }
  try { td = readFileSync(join(source, "TECHNICAL_DESIGN.md"), "utf8"); } catch { td = null; }
}
writeFileSync(process.env["CADP_TEST_DOCKER_RECORD"], JSON.stringify({ argv: args, mount_source: source, head, entries, td }));
process.exit(125);
`);
  const stub = join(stubDir, "docker");
  writeFileSync(stub, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} "$@"\n`);
  chmodSync(stub, 0o755);
  return { stub_dir: stubDir, record_path: recordPath };
}

/**
 * Run the real `brokerReview` against the local origin and the scripted daemon, and return what
 * the daemon was asked to create. The run always ends in a rejected creation — the reviewer
 * surface never starts — which is exactly the point at which the mount is fully determined.
 */
async function recordedReview(root: string, repo: { origin_base: string; repo_full_name: string; candidate_sha: string }, work_item: string): Promise<DockerCreateRecord> {
  const { stub_dir, record_path } = scriptDocker(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), '{"fixture":"auth"}');
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });

  const saved = { ...process.env };
  Object.assign(process.env, {
    PATH: `${stub_dir}:${process.env["PATH"] ?? ""}`,
    HOME: home,
    TMPDIR: tmp,
    CADP_TEST_DOCKER_RECORD: record_path,
    CADP_WORKER_IMAGE: "cadp-surface:conformance",
    CADP_EGRESS_NETWORK: "cadp-conformance-int",
    CADP_EGRESS_PROXY: "cadp-conformance-proxy:8888",
    // Redirect the broker's fixed https://github.com/<repo>.git clone URL at the local origin,
    // without touching the production path that builds it.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${repo.origin_base}/.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
  });
  try {
    await assert.rejects(
      brokerReview({ repo_full_name: repo.repo_full_name, candidate_sha: repo.candidate_sha, work_item, review_product: "codex" }),
      /reviewer surface failed/u,
      "the scripted daemon rejects creation, so the run ends after the mount is constructed",
    );
    return JSON.parse(readFileSync(record_path, "utf8")) as DockerCreateRecord;
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

/** The one `-v <host>:/ws...` bind the reviewer container receives. */
function workspaceMount(argv: readonly string[]): string {
  const mounts = argv.filter((a) => /:\/ws(:|$)/u.test(a));
  assert.equal(mounts.length, 1, `exactly one workspace bind expected, got ${JSON.stringify(mounts)}`);
  return mounts[0]!;
}

test("§4.1 the reviewer's mounted workspace IS the candidate checkout at the reviewed sha, read-only", async () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-reviewmount-"));
  try {
    const repo = makeOrigin(root, { "impl.ts": "export const answer = 42;\n" });
    const record = await recordedReview(root, repo, "fix the answer");

    // The defect: this used to be a fresh empty `review-ws`, so the reviewer's working directory
    // held nothing at all. It is now the clone the diff was built from.
    assert.ok(record.mount_source !== null, "a /ws bind must be present");
    assert.equal(record.head, repo.candidate_sha, "the mounted tree is checked out at the reviewed sha");
    assert.equal(basename(record.mount_source!), "ws");
    assert.ok(!record.mount_source!.includes("review-ws"), "the empty scratch dir is never the mount");
    assert.ok(record.mount_source!.includes("cadp-review-"), "the mount is the run's own ephemeral clone");

    // Beyond the patch: the TD the reviewer is asked to measure against is not in the diff at all,
    // and is readable from the mount. This is the property that was impossible before.
    assert.equal(record.td, TD_TEXT);
    assert.ok(record.entries.includes(".git"), "the full checkout, not a copy of the changed files");
    assert.ok(record.entries.includes("impl.ts"));

    // Nothing but the public repo's own content is inside the mount: the run's auth dir and session
    // tree are siblings of the checkout, never entries of it.
    assert.deepEqual([...record.entries].sort(), [".git", "TECHNICAL_DESIGN.md", "impl.ts"]);

    // Read-only is unchanged: runReviewer's own `:ro` bind, and codex's read-only sandbox flags.
    assert.equal(workspaceMount(record.argv), `${record.mount_source!}:/ws:ro`);
    assert.ok(record.argv.includes("--sandbox"));
    assert.ok(record.argv.includes("read-only"));
    assert.equal(record.argv[record.argv.indexOf("-w") + 1], "/ws");

    // The reviewer's WRITABLE state stays separate: its sessions bind is outside the mounted tree,
    // and so is the provider auth it is given (which is itself still read-only).
    const sessions = record.argv.filter((a) => a.endsWith(":/root/.codex/sessions"));
    assert.equal(sessions.length, 1, `exactly one sessions bind expected, got ${JSON.stringify(sessions)}`);
    const sessionsHost = sessions[0]!.slice(0, sessions[0]!.lastIndexOf(":/root/.codex/sessions"));
    assert.ok(!sessionsHost.startsWith(`${record.mount_source!}/`), "sessions are not written into the read-only checkout");
    const authBind = record.argv.find((a) => a.includes(":/root/.codex/auth.json"));
    assert.ok(authBind !== undefined && authBind.endsWith(":ro"), "provider auth stays read-only");
    assert.ok(!authBind.startsWith(`${record.mount_source!}/`), "provider auth is never inside the reviewer's checkout");
    assert.ok(!record.argv.some((a) => a === `${record.mount_source!}:/ws`), "the checkout is never bound writable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("§4.1 the review prompt tells the reviewer the checkout is mounted and not to stop at the diff", async () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-reviewprompt-"));
  try {
    const repo = makeOrigin(root, { "impl.ts": "export const answer = 42;\n" });
    const record = await recordedReview(root, repo, "fix the answer");

    const prompt = record.argv.find((a) => a.startsWith("You are reviewing the exact committed change below"));
    assert.ok(prompt !== undefined, "the prompt is passed to the surface argv");
    const header = `You are reviewing the exact committed change below (commit ${repo.candidate_sha}) implementing: "fix the answer". Reply with exactly APPROVE or REQUEST_CHANGES on the first line, then one short reason line.`;
    // Exactly the instructed sentence, immediately after the existing first paragraph.
    assert.equal(
      REVIEW_MOUNT_INSTRUCTION,
      "The full candidate checkout is mounted read-only at your working directory. Read the governing Spec/TD sections and the changed implementation directly from the mounted checkout. Do not rely only on the supplied diff or work-item claims.",
    );
    assert.ok(prompt!.startsWith(`${header}\n\n${REVIEW_MOUNT_INSTRUCTION}\n\n`));
    // The diff still follows, unchanged in content and position.
    const diff = prompt!.slice(`${header}\n\n${REVIEW_MOUNT_INSTRUCTION}\n\n`.length);
    assert.ok(diff.startsWith(" impl.ts |"), `the --stat/--patch diff still leads the body: ${diff.slice(0, 80)}`);
    assert.ok(diff.includes("+export const answer = 42;"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("§4.1 the 60 000-char diff cap and the NUL escape are unchanged by the mount", async () => {
  const root = mkdtempSync(join(tmpdir(), "cadp-reviewcap-"));
  try {
    // Oversized on purpose, with a NUL past git's 8 KiB binary-detection window so the patch is
    // produced as TEXT carrying raw NULs — the case that used to kill the whole run.
    const big = `${"x".repeat(20_000)}${NUL}${"y".repeat(60_000)}\n`;
    const repo = makeOrigin(root, { "impl.ts": "export const answer = 42;\n", "big.txt": big });
    const record = await recordedReview(root, repo, "add a large file");

    const prompt = record.argv.find((a) => a.startsWith("You are reviewing the exact committed change below"));
    assert.ok(prompt !== undefined);
    const header = `You are reviewing the exact committed change below (commit ${repo.candidate_sha}) implementing: "add a large file". Reply with exactly APPROVE or REQUEST_CHANGES on the first line, then one short reason line.\n\n${REVIEW_MOUNT_INSTRUCTION}\n\n`;
    assert.ok(prompt!.startsWith(header));
    // The cap still bounds exactly the embedded diff text — it is now a context hint (the whole
    // change is readable from the mount), but the bound itself is untouched.
    assert.equal(prompt!.length - header.length, 60_000);
    // Spawn-safe in fact: the argv element that reached the daemon holds no NUL, and the run got
    // as far as constructing it.
    assert.ok(!prompt!.includes(NUL));
    assert.ok(!record.argv.some((a) => a.includes(NUL)));
    // The oversized diff did not cost the reviewer the file itself: it is in the mount.
    assert.ok(record.entries.includes("big.txt"));
    assert.equal(record.head, repo.candidate_sha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
