/**
 * #100 live disposable composition (TD §11, §13): real OPA (kernel sidecar), real Temporal
 * dev server, real disposable GitHub repository with the §4.6 candidate-ref ruleset, real
 * record service in its own process, kernel service in its own process (restartable), real
 * worker process. Everything lands under one disposable directory.
 *
 * Usage: node cadp/live/env.ts setup <dir> [--repo <owner/name>]
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { Cas } from "../kernel/cas.ts";
import { ConstitutionalStore } from "../kernel/store.ts";
import { runGenesis } from "../kernel/genesis.ts";
import { generateRootKey } from "../kernel/sig.ts";
import { buildReferenceBundle } from "../deployment/referencePolicy.ts";
import type { KernelServiceConfig } from "../kernel/kernelService.ts";

export interface LiveEnvManifest {
  dir: string;
  api_url: string;
  root_url: string;
  api_port: number;
  root_port: number;
  record_port: number;
  temporal_port: number;
  temporal_ui_port: number;
  broker_port: number;
  repo_full_name: string;
  repo_id: string;
  base_sha: string;
  tokens: Record<string, string>; // principal → token
  root_key_id: string;
  kernel_config_path: string;
  policy_content_digest: string;
}

const PRINCIPAL_TOKEN_NAMES = [
  "cadp-workflow", "cadp-worker-codex", "cadp-backend-scan", "cadp-reviewer-claude",
  "cadp-verifier", "sso:a.t.laplace@gmail.com", "cadp-depctl-probe", "cadp-depctl-target",
];

function sh(cmd: string, args: string[], options: { cwd?: string; input?: string } = {}): string {
  return execFileSync(cmd, args, { encoding: "utf8", cwd: options.cwd, input: options.input, maxBuffer: 16 * 1024 * 1024 });
}

export async function setupLiveEnv(dir: string, repoFullName: string | undefined): Promise<LiveEnvManifest> {
  mkdirSync(dir, { recursive: true });
  const secretDir = join(dir, "secret");
  mkdirSync(join(secretDir, "root"), { recursive: true });
  mkdirSync(join(dir, "opa"), { recursive: true });

  // ---- ports ----
  const base = 42000 + Math.floor(Math.random() * 800);
  const ports = { api: base, root: base + 1, record: base + 2, temporal: base + 3, temporalUi: base + 4, broker: base + 5 };

  // ---- disposable GitHub repository ----
  let fullName = repoFullName;
  if (fullName === undefined) {
    fullName = `astro3141/cadp-v04-live-${randomBytes(3).toString("hex")}`;
    sh("gh", ["repo", "create", fullName, "--public", "--description", "CADP v0.4 disposable live-proof target (safe to delete)"]);
  }
  // Seed: a real minimal project with a runnable test (the verifier runs `node --test`).
  const seed = join(dir, "seed");
  if (!existsSync(seed)) {
    mkdirSync(seed, { recursive: true });
    writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "cadp-live-target", private: true, type: "module" }, null, 2));
    mkdirSync(join(seed, "src"), { recursive: true });
    writeFileSync(join(seed, "src", "stats.mjs"), "export function mean(xs) {\n  if (xs.length === 0) return 0;\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n");
    mkdirSync(join(seed, "test"), { recursive: true });
    writeFileSync(
      join(seed, "test", "stats.test.mjs"),
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { mean } from "../src/stats.mjs";\n\ntest("mean of empty is 0", () => assert.equal(mean([]), 0));\ntest("mean averages", () => assert.equal(mean([2, 4]), 3));\n',
    );
    writeFileSync(join(seed, "README.md"), "# cadp-v04 live target\n\nDisposable repository governed by the CADP v0.4 reference kernel.\n");
    sh("git", ["init", "--quiet", "-b", "main"], { cwd: seed });
    sh("git", ["add", "-A"], { cwd: seed });
    sh("git", ["-c", "user.name=cadp-root", "-c", "user.email=root@cadp-v04.invalid", "commit", "--quiet", "-m", "seed: minimal governed target"], { cwd: seed });
    const token = sh("gh", ["auth", "token"]).trim();
    sh("git", ["push", "--quiet", `https://x-access-token:${token}@github.com/${fullName}.git`, "main:main"], { cwd: seed });
  }
  const repoInfo = JSON.parse(sh("gh", ["api", `/repos/${fullName}`])) as { id: number; default_branch: string };
  const repoId = String(repoInfo.id);
  const baseSha = sh("gh", ["api", `/repos/${fullName}/git/ref/heads/main`, "--jq", ".object.sha"]).trim();

  // §4.6 item 2: active ruleset making refs/heads/cadp/candidate/** write-once for EVERYONE.
  const rulesets = JSON.parse(sh("gh", ["api", `/repos/${fullName}/rulesets`])) as Array<{ name: string }>;
  if (!rulesets.some((r) => r.name === "cadp-candidate-write-once")) {
    sh("gh", ["api", "-X", "POST", `/repos/${fullName}/rulesets`, "--input", "-"], {
      input: JSON.stringify({
        name: "cadp-candidate-write-once",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["refs/heads/cadp/candidate/**"], exclude: [] } },
        rules: [{ type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }],
        bypass_actors: [],
      }),
    });
  }

  // ---- PEP credentials in the secret path (custody: kernel process only) ----
  const githubTokenFile = join(secretDir, "github-token");
  writeFileSync(githubTokenFile, sh("gh", ["auth", "token"]).trim(), { mode: 0o600 });

  // ---- API tokens (single-host stand-in for workload identity) ----
  const tokens: Record<string, string> = {};
  const tokenMap: Record<string, string> = {};
  for (const principal of PRINCIPAL_TOKEN_NAMES) {
    const token = randomBytes(24).toString("hex");
    tokens[principal] = token;
    tokenMap[token] = principal;
  }
  writeFileSync(join(secretDir, "api-tokens.json"), JSON.stringify(tokenMap, null, 2), { mode: 0o600 });
  const rootToken = randomBytes(24).toString("hex");
  writeFileSync(join(secretDir, "root-token"), rootToken, { mode: 0o600 });
  // Governed record-service credential: held ONLY in the PEP secret path (TD §4.1).
  writeFileSync(join(secretDir, "record-api-key"), randomBytes(24).toString("hex"), { mode: 0o600 });

  // ---- root key + genesis ----
  const root = generateRootKey();
  writeFileSync(join(secretDir, "root", "root-key.pem"), root.privatePem, { mode: 0o600 });
  writeFileSync(join(secretDir, "root", "pubkeys.json"), JSON.stringify([root.public_key_base64]));

  const bundle = buildReferenceBundle({
    policy_id: "cadp-v04:policy:root",
    revision: 1,
    root_public_keys: [{ key_id: root.key_id, alg: "Ed25519", public_key: root.public_key_base64, valid_from: "2026-01-01T00:00:00.000Z" }],
    configOverrides: { temporal_idempotency_horizon_s: 86400 },
  });
  const dbPath = join(dir, "k04.sqlite");
  {
    const store = new ConstitutionalStore(dbPath);
    const cas = new Cas(store);
    if (store.activeActivation() === undefined) {
      runGenesis(store, cas, {
        bundleBytes: bundle,
        policy_id: "cadp-v04:policy:root",
        rootPrivatePem: root.privatePem,
        rootPublicKeysBase64: [root.public_key_base64],
        pep_identity: "spiffe://cadp-v04/cadp/pep",
        secret_path: secretDir,
      });
    }
    store.close();
  }
  const { createHash } = await import("node:crypto");
  const policyDigest = createHash("sha256").update(bundle).digest("hex");

  // ---- kernel service config ----
  const kernelConfig: KernelServiceConfig = {
    db_path: dbPath,
    opa_dir: join(dir, "opa"),
    api_port: ports.api,
    root_port: ports.root,
    secret_dir: secretDir,
    pep_ref: "spiffe://cadp-v04/cadp/pep",
    github: { repo_id: repoId, repo_full_name: fullName, token_file: githubTokenFile },
    temporal: { address: `127.0.0.1:${ports.temporal}`, namespace: "cadp-v04", horizon_s: 86400 },
    record: { base_url: `http://127.0.0.1:${ports.record}`, api_key_file: join(secretDir, "record-api-key") },
  };
  const kernelConfigPath = join(dir, "kernel-config.json");
  writeFileSync(kernelConfigPath, JSON.stringify(kernelConfig, null, 2));

  // Build/record the disposable surface-isolation image (node + git + codex) once.
  const imageTag = "cadp-surface:0.151.0-2.1.221";
  const imageDir = join(repoRootFrom(dir), "cadp/live/image");
  try {
    sh("docker", ["build", "-q", "-t", imageTag, imageDir]);
  } catch (error) {
    console.error(`warning: could not build worker image (${error instanceof Error ? error.message : error}); live surfaces will fail closed`);
  }
  writeFileSync(join(dir, "worker-image"), imageTag);

  const manifest: LiveEnvManifest = {
    dir,
    api_url: `http://127.0.0.1:${ports.api}`,
    root_url: `http://127.0.0.1:${ports.root}`,
    api_port: ports.api,
    root_port: ports.root,
    record_port: ports.record,
    temporal_port: ports.temporal,
    temporal_ui_port: ports.temporalUi,
    broker_port: ports.broker,
    repo_full_name: fullName,
    repo_id: repoId,
    base_sha: baseSha,
    tokens,
    root_key_id: root.key_id,
    kernel_config_path: kernelConfigPath,
    policy_content_digest: policyDigest,
  };
  // The principal→token map is credential material: it lives ONLY in the isolation-denied
  // secret path (workflow-token-map.json), never in the manifest a surface might read.
  writeFileSync(join(secretDir, "workflow-token-map.json"), JSON.stringify(tokens, null, 2), { mode: 0o600 });
  const publicManifest = { ...manifest, tokens: {} };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(publicManifest, null, 2), { mode: 0o644 });
  return manifest;
}

export function loadManifest(dir: string): LiveEnvManifest {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as LiveEnvManifest;
  // Tokens are held in the secret path, not the public manifest; the operator ctl re-hydrates
  // them (it runs as the deployment operator, not as an untrusted surface).
  const tokenPath = join(dir, "secret", "workflow-token-map.json");
  if (existsSync(tokenPath)) manifest.tokens = JSON.parse(readFileSync(tokenPath, "utf8")) as Record<string, string>;
  return manifest;
}

function repoRootFrom(_dir: string): string {
  return join(import.meta.dirname, "..", "..");
}

/** Spawn a component in its own real OS process; pid file for later kill/restart scenarios. */
export function spawnComponent(dir: string, name: string, cmd: string, args: string[], env: Record<string, string> = {}): number {
  const logPath = join(dir, `${name}.log`);
  const out = openSync(logPath, "a");
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, ...env },
  });
  child.unref();
  writeFileSync(join(dir, `${name}.pid`), String(child.pid));
  return child.pid!;
}

/**
 * Seatbelt profile denying a set of read paths (TD §4.1): the Temporal activity worker hosts
 * activities and holds only its Kernel workflow token — it must NOT be able to read the PEP
 * secret directory (governed credentials, root key). It never needs those files.
 */
export function denyReadProfile(denyReadPaths: readonly string[]): string {
  const lines = ["(version 1)", "(allow default)"];
  for (const path of denyReadPaths) {
    let canonical = path;
    try { canonical = realpathSync(path); } catch { /* not created yet */ }
    lines.push(`(deny file-read* (subpath ${JSON.stringify(canonical)}))`);
    lines.push(`(deny file-write* (subpath ${JSON.stringify(canonical)}))`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Activity-host Seatbelt profile (TD §4.1; PR #102 re-review 5101871379). Denies the PEP secret
 * path AND pins network egress to only the localhost ports the Temporal activity host legitimately
 * needs (Kernel / Temporal / broker). Every other remote is denied — governed targets (GitHub by
 * name/IP, the record-service port) are http-000, and the docker daemon's unix socket is denied
 * too, so the host cannot use the daemon as a confused deputy to bind-mount the secret path.
 */
export function activityHostProfile(denyReadPaths: readonly string[], allowLocalhostPorts: readonly number[]): string {
  const lines = ["(version 1)", "(allow default)"];
  for (const path of denyReadPaths) {
    let canonical = path;
    try { canonical = realpathSync(path); } catch { /* not created yet */ }
    lines.push(`(deny file-read* (subpath ${JSON.stringify(canonical)}))`);
    lines.push(`(deny file-write* (subpath ${JSON.stringify(canonical)}))`);
  }
  lines.push("(deny network*)");
  for (const port of allowLocalhostPorts) {
    lines.push(`(allow network-outbound (remote ip ${JSON.stringify(`localhost:${port}`)}))`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Spawn a component under a macOS Seatbelt boundary denying `denyReadPaths` (fail closed if
 * `sandbox-exec` is unavailable). Used for the surface broker (denies only the secret path — it
 * legitimately needs GitHub + Docker). When `allowLocalhostPorts` is given the profile ALSO pins
 * network egress to just those localhost ports (the activity host: no GitHub, no Docker, no
 * governed record-service port).
 */
export function spawnComponentSandboxed(
  dir: string,
  name: string,
  cmd: string,
  args: string[],
  env: Record<string, string>,
  denyReadPaths: readonly string[],
  allowLocalhostPorts?: readonly number[],
): number {
  if (spawnSync("which", ["sandbox-exec"], { stdio: "ignore" }).status !== 0) {
    throw new Error(`activity-worker isolation (sandbox-exec) unavailable — refusing to run ${name} unconfined`);
  }
  const profilePath = join(dir, `${name}.sb`);
  const profile = allowLocalhostPorts !== undefined ? activityHostProfile(denyReadPaths, allowLocalhostPorts) : denyReadProfile(denyReadPaths);
  writeFileSync(profilePath, profile);
  return spawnComponent(dir, name, "sandbox-exec", ["-f", profilePath, cmd, ...args], env);
}

if (process.argv[2] === "setup") {
  const dir = process.argv[3]!;
  const repoFlag = process.argv.indexOf("--repo");
  setupLiveEnv(dir, repoFlag > 0 ? process.argv[repoFlag + 1] : undefined)
    .then((m) => console.log(JSON.stringify({ ok: true, dir: m.dir, repo: m.repo_full_name, api_port: m.api_port })))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
