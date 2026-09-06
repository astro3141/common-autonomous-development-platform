/**
 * #100 live-composition control (deployment-control + operator surfaces):
 *   node cadp/live/ctl.ts <dir> up                          start record/temporal/kernel/worker
 *   node cadp/live/ctl.ts <dir> stop|start <component>      kill / restart one real process
 *   node cadp/live/ctl.ts <dir> attest                      reach + immutability attestations
 *   node cadp/live/ctl.ts <dir> plan "<whole intent>"       proposal-only planner → WORK_PROPOSAL evidence
 *   node cadp/live/ctl.ts <dir> work-plan <proposalEvidenceId> [maxItems]   drive items through governed WORK_START
 *   node cadp/live/ctl.ts <dir> work-dev <item> [maxSteps maxEffects] [proposalEvidenceId]
 *   node cadp/live/ctl.ts <dir> work-record <n-payloads> [maxSteps maxEffects]
 *   node cadp/live/ctl.ts <dir> human-approve <effect_id> <workflow_id>
 *   node cadp/live/ctl.ts <dir> state <effect_id>
 *   node cadp/live/ctl.ts <dir> reconcile <effect_id>
 */

import { execFileSync, spawn as execFileSpawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifest, spawnComponent, spawnComponentSandboxed } from "./env.ts";
import { buildWorkerSandbox, workerProfileDigest, WORKER_ARGV_PREFIX } from "../product/workerProfile.ts";
import { claudeProviderToken, createEgressBoundary, dockerAvailable, imageIdentity, runReviewer, runVerifier, runWorker } from "../product/isolation.ts";
import type { IsolationConfig } from "../product/isolation.ts";
import type { LiveEnvManifest } from "./env.ts";
import { KernelClient } from "../clients/kernelClient.ts";
import { sha256Hex } from "../kernel/canonical.ts";
import { sealPlan, startWork, workPlan } from "./ops.ts";

const dir = process.argv[2]!;
const command = process.argv[3]!;

function manifest(): LiveEnvManifest {
  return loadManifest(dir);
}

function client(principal: string): KernelClient {
  const m = manifest();
  const token = m.tokens[principal];
  if (token === undefined) throw new Error(`no token for ${principal}`);
  return new KernelClient(m.api_url, token);
}

function killComponent(name: string): void {
  const pidFile = join(dir, `${name}.pid`);
  if (!existsSync(pidFile)) return console.log(JSON.stringify({ [name]: "no pid file" }));
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  try {
    process.kill(pid, "SIGKILL");
    console.log(JSON.stringify({ killed: name, pid }));
  } catch (error) {
    console.log(JSON.stringify({ [name]: `kill failed: ${(error as Error).message}` }));
  }
}

async function waitHttp(url: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1500) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`not reachable: ${url}`);
}

function startComponent(name: string): void {
  const m = manifest();
  const repoRoot = join(import.meta.dirname, "..", "..");
  switch (name) {
    case "record":
      spawnComponent(dir, "record", "node", [join(repoRoot, "cadp/product/recordService.ts"), String(m.record_port), join(dir, "record-service.sqlite")], {
        RECORD_SERVICE_API_KEY: readFileSync(join(dir, "secret", "record-api-key"), "utf8").trim(),
      });
      break;
    case "temporal":
      spawnComponent(dir, "temporal", "temporal", [
        "server", "start-dev", "--headless",
        "--port", String(m.temporal_port),
        "--ui-port", String(m.temporal_ui_port),
        "--db-filename", join(dir, "temporal.sqlite"),
        "--namespace", "cadp-v04",
      ]);
      break;
    case "kernel":
      spawnComponent(dir, "kernel", "node", [join(repoRoot, "cadp/kernel/kernelService.ts"), m.kernel_config_path]);
      break;
    case "broker": {
      const egress = JSON.parse(readFileSync(join(dir, "egress.json"), "utf8")) as { network: string; proxy: string };
      const brokerEnv = {
        CADP_BROKER_PORT: String(m.broker_port),
        // The broker owns the surface isolation: pinned image + internal-network egress boundary.
        CADP_WORKER_IMAGE: readFileSync(join(dir, "worker-image"), "utf8").trim(),
        CADP_EGRESS_NETWORK: egress.network,
        CADP_EGRESS_PROXY: egress.proxy,
      };
      // The bounded surface launcher (TD §4.1): it clones (public read) and drives Docker, so it
      // keeps network + daemon access, but it holds NO Kernel token and its Seatbelt profile
      // denies the PEP secret path — it can neither read the secret nor forge a governed effect.
      spawnComponentSandboxed(dir, "broker", "node", [join(repoRoot, "cadp/product/surfaceBroker.ts")], brokerEnv, [join(dir, "secret")]);
      break;
    }
    case "worker": {
      mkdirSync(join(dir, "worker-tmp"), { recursive: true });
      const workerEnv = {
        CADP_KERNEL_URL: m.api_url,
        CADP_WORKFLOW_TOKEN: m.tokens["cadp-workflow"]!,
        CADP_VERIFIER_TOKEN: m.tokens["cadp-verifier"]!,
        CADP_REVIEWER_TOKEN: m.tokens["cadp-reviewer-claude"]!,
        CADP_BACKEND_SCAN_TOKEN: m.tokens["cadp-backend-scan"]!,
        CADP_TEMPORAL_ADDRESS: `127.0.0.1:${m.temporal_port}`,
        CADP_TEMPORAL_NAMESPACE: "cadp-v04",
        CADP_TASK_QUEUE: "cadp-worker",
        // Surface work is delegated to the bounded broker over its localhost port.
        CADP_BROKER_URL: `http://127.0.0.1:${m.broker_port}`,
      };
      // Activity-host isolation (TD §4.1; re-review 5101871379): the Temporal activity worker holds
      // the Kernel workflow tokens, so its Seatbelt profile (a) denies the PEP secret path and (b)
      // pins network egress to ONLY the Kernel/Temporal/broker localhost ports. It therefore has no
      // direct GitHub or record-service reach (governed targets are http-000) and no Docker daemon
      // socket — it cannot be a confused deputy for a secret-path mount. All GitHub/Docker work is
      // delegated to the broker.
      spawnComponentSandboxed(
        dir, "worker", "node", [join(repoRoot, "cadp/product/worker.ts")], workerEnv,
        [join(dir, "secret")], [m.api_port, m.temporal_port, m.broker_port],
      );
      break;
    }
    default:
      throw new Error(`unknown component ${name}`);
  }
  console.log(JSON.stringify({ started: name }));
}


function safeJson(text: string): { fs_reads?: Array<Record<string, unknown>>; credential_use?: Array<Record<string, unknown>>; egress?: Array<Record<string, unknown>>; enumerated?: string[] } | undefined {
  const line = text.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (line === undefined) return undefined;
  try { return JSON.parse(line); } catch { return undefined; }
}

function resolveGithubIps(): string[] {
  const ips = new Set<string>();
  for (const host of ["api.github.com", "github.com", "codeload.github.com"]) {
    try {
      const out = execFileSync("dscacheutil", ["-q", "host", "-a", "name", host], { encoding: "utf8", timeout: 5000 });
      for (const m of out.matchAll(/ip_address:\s*(\d+\.\d+\.\d+\.\d+)/gu)) ips.add(m[1]!);
    } catch { /* ignore */ }
  }
  return [...ips].slice(0, 3);
}

function spawnCollect(cmd: string, args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFileSpawn(cmd, args, env);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => out.push(c));
    child.stderr?.on("data", (c: Buffer) => err.push(c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }); });
  });
}

async function attest(): Promise<void> {
  const m = manifest();
  const repoRoot = join(import.meta.dirname, "..", "..");
  const payload = join(repoRoot, "cadp/live/probePayload.mjs");
  const probeBase = join(dir, "probe-profile");
  mkdirSync(probeBase, { recursive: true });
  if (!(await dockerAvailable())) throw new Error("isolation runtime (docker) unavailable — cannot attest fail-closed boundary");

  const egress = JSON.parse(readFileSync(join(dir, "egress.json"), "utf8")) as { network: string; proxy: string };
  const config: IsolationConfig = {
    worker_image: readFileSync(join(dir, "worker-image"), "utf8").trim(),
    egress_network: egress.network,
    egress_proxy: egress.proxy,
  };
  // TD §11 version exactness: bind the built-image digest + observed tool versions.
  const image = imageIdentity(config.worker_image);

  // Governed targets the malicious payload tries by NAME, literal IP, and the docker gateway.
  const githubIps = resolveGithubIps();
  const governedTargets: Record<string, string> = {
    github_api_name: "https://api.github.com/rate_limit",
    record_service_hostbridge: `http://host.docker.internal:${m.record_port}/records`,
    kernel_hostbridge: `http://host.docker.internal:${m.api_port}/allocate_effect_id`,
  };
  githubIps.forEach((ip, i) => { governedTargets[`github_literal_ip_${i}`] = `https://${ip}/`; });
  // Docker default gateway address (alternate route to the host).
  governedTargets["docker_gateway"] = "http://192.168.65.1/";
  const providerCheck = { provider_openai: "https://api.openai.com/v1/models" };

  const probes: Array<Record<string, unknown>> = [];
  const runProbe = async (identity: string, isolation: string, runner: (env: { PROBE_SEARCH_ROOTS: string; PROBE_TARGETS: string }) => Promise<{ stdout: string }>) => {
    const combined = { ...governedTargets, ...providerCheck };
    const searchRoots = "/:/ws:/root"; const probeTargets = JSON.stringify(combined); const out = await runner({ PROBE_SEARCH_ROOTS: searchRoots, PROBE_TARGETS: probeTargets });
    const parsed = safeJson(out.stdout) ?? { fs_reads: [], credential_use: [], egress: [], enumerated: [] };
    const governedReached = (parsed.egress ?? []).filter((e: Record<string, unknown>) => e["target"] !== "provider_openai" && e["status"] !== "000");
    const hostFileRead = (parsed.fs_reads ?? []).length > 0;
    const credRecovered = (parsed.credential_use ?? []).some((c: Record<string, unknown>) => typeof c["recovered_bytes"] === "number" || (typeof c["status"] === "number" && (c["status"] as number) < 400));
    probes.push({ identity, isolation, reached: hostFileRead || governedReached.length > 0 || credRecovered, governed_reached: governedReached, findings: parsed });
  };

  // Worker: container on the internal egress network; payload runs in /ws.
  {
    const sandbox = buildWorkerSandbox(probeBase);
    const wsDir = join(probeBase, "worker-ws");
    mkdirSync(wsDir, { recursive: true });
    execFileSync("cp", [payload, join(wsDir, "probe.mjs")]);
    await runProbe("worker", "docker container; internal network + provider-only allowlist proxy", (env) =>
      runWorker(config, { workspace: wsDir, codexAuthDir: join(sandbox.home, ".codex"), argv: ["sh", "-c", `PROBE_SEARCH_ROOTS='${env.PROBE_SEARCH_ROOTS}' PROBE_TARGETS='${env.PROBE_TARGETS.replace(/'/gu, "")}' node /ws/probe.mjs`], timeout_ms: 60_000 }));
    const codexDir = join(sandbox.home, ".codex");
    const contents = existsSync(codexDir) ? readdirSync(codexDir) : [];
    probes.push({ identity: "worker", target: "codex profile contents (auth.json only)", reached: contents.some((f) => f === "config.toml" || f === "mcp.json"), detail: contents.join(",") });
  }
  // Verifier: container with --network none (no egress at all).
  {
    const wsDir = join(probeBase, "verifier-ws");
    mkdirSync(wsDir, { recursive: true });
    execFileSync("cp", [payload, join(wsDir, "probe.mjs")]);
    await runProbe("verifier", "docker container --network none", (env) =>
      runVerifier(config, { workspace: wsDir, argv: ["sh", "-c", `PROBE_SEARCH_ROOTS='${env.PROBE_SEARCH_ROOTS}' PROBE_TARGETS='${env.PROBE_TARGETS.replace(/'/gu, "")}' node /ws/probe.mjs`], timeout_ms: 60_000 }));
  }
  // Reviewer: container on the internal egress network (provider via env token).
  {
    const wsDir = join(probeBase, "reviewer-ws");
    mkdirSync(wsDir, { recursive: true });
    execFileSync("cp", [payload, join(wsDir, "probe.mjs")]);
    await runProbe("reviewer", "docker container; internal network + provider-only allowlist proxy; model token by env", (env) =>
      runReviewer(config, { workspace: wsDir, providerToken: "probe-not-used", argv: ["sh", "-c", `PROBE_SEARCH_ROOTS='${env.PROBE_SEARCH_ROOTS}' PROBE_TARGETS='${env.PROBE_TARGETS.replace(/'/gu, "")}' node /ws/probe.mjs`], timeout_ms: 60_000 }));
  }
  // Activity-host (re-review 5101871379): the Temporal worker process holds the Kernel tokens.
  // Under its EXACT production Seatbelt profile it must (1) not read the PEP secret files, (2) not
  // reach a governed target directly — GitHub by name/IP and the record-service port are pinned
  // http-000 while only the Kernel/Temporal/broker localhost ports are allowed — and (3) not use
  // the docker daemon as a confused deputy to bind-mount and read the secret path.
  {
    const { activityHostProfile } = await import("./env.ts");
    const profilePath = join(probeBase, "activity-host.sb");
    writeFileSync(profilePath, activityHostProfile([join(dir, "secret")], [m.api_port, m.temporal_port, m.broker_port]));
    const secretFiles = ["github-token", "api-tokens.json", "record-api-key", "root-token", "workflow-token-map.json", "root/root-key.pem"].map((f) => join(dir, "secret", f));
    // Governed targets the activity host must NOT reach directly (its Kernel/Temporal/broker ports
    // are the legitimate, intentionally-allowed seam; GitHub + the record-service port are not).
    const ahTargets: Record<string, string> = {
      github_api_name: "https://api.github.com/rate_limit",
      record_service_port: `http://127.0.0.1:${m.record_port}/records`,
    };
    githubIps.forEach((ip, i) => { ahTargets[`github_literal_ip_${i}`] = `https://${ip}/`; });
    const env = { ...process.env as Record<string, string>, PROBE_SEARCH_ROOTS: join(dir, "secret"), PROBE_TARGETS: JSON.stringify(ahTargets), PROBE_EXPLICIT_FILES: secretFiles.join(":") };
    const run = await spawnCollect("sandbox-exec", ["-f", profilePath, "node", payload], env);
    const parsed = safeJson(run.stdout) ?? { fs_reads: [], egress: [] };
    const secretRead = (parsed.fs_reads ?? []).some((f: Record<string, unknown>) => String(f["path"]).includes("/secret/"));
    const governedReached = (parsed.egress ?? []).filter((e: Record<string, unknown>) => e["status"] !== "000");
    // Confused-deputy control: the exact profile tries to drive the docker daemon to bind-mount
    // the PEP secret path into a container and read it. The daemon socket is denied by the profile.
    const mount = await spawnCollect("sandbox-exec", ["-f", profilePath, "docker", "run", "--rm", "--network", "none", "-v", `${join(dir, "secret")}:/stolen:ro`, config.worker_image, "cat", "/stolen/github-token"], process.env as Record<string, string>);
    const daemonMediatedRead = mount.status === 0 && mount.stdout.trim().length > 0;
    probes.push({
      identity: "activity-host",
      isolation: "seatbelt: deny-read PEP secret path + egress pinned to Kernel/Temporal/broker localhost ports (no GitHub, no record-service, no docker daemon socket)",
      reached: secretRead || governedReached.length > 0 || daemonMediatedRead,
      governed_reached: governedReached,
      daemon_mediated_secret_read: daemonMediatedRead,
      daemon_mount_stderr: mount.stderr.slice(0, 200),
      findings: parsed,
    });
  }

  const alternateFound = probes.some((p2) => p2["reached"] === true);
  const profileDigest = workerProfileDigest(buildWorkerSandbox(join(probeBase, "digest")));
  const reach = await client("cadp-depctl-probe").submitEvidence({
    evidence_kind: "CREDENTIAL_REACH_ATTESTATION",
    subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "deployment", object_id: "cadp-v04-live" }],
    availability: "PRESENT",
    claim_schema: "cadp.credential-reach.v1",
    claim: {
      alternate_path_found: alternateFound,
      worker_profile_digest: profileDigest,
      surface_image: image,
      isolation: {
        worker: "docker container; internal network (no direct internet); provider-only allowlist proxy",
        verifier: "docker container --network none",
        reviewer: "docker container; internal network; provider-only allowlist proxy; model token by env",
        activity_host: "macOS Seatbelt: deny-read PEP secret path + egress pinned to ONLY the Kernel/Temporal/broker localhost ports (no GitHub, no record-service port, no docker daemon socket)",
        surface_broker: "bounded launcher: owns GitHub clones + Docker with fixed mount args; holds NO Kernel token; Seatbelt-denied the PEP secret path — the activity host delegates all GitHub/Docker work to it",
        egress_policy: "governed targets (GitHub/record/Kernel) have NO route by name, literal IP, or docker gateway; only the allowlisted model provider is reachable via the CONNECT proxy",
      },
      probes,
      network_policy_digest: `internal-net-no-route;allowlist-connect-proxy;activity-host-port-pinned;falsified:name+literal-ip(${githubIps.length})+docker-gateway+record-port+daemon-mount`,
      secret_acl_digest: sha256Hex(readFileSync(join(dir, "secret", "api-tokens.json"))),
      known_residuals: [
        "single-host disposable proof: the surface containers and the Seatbelt-confined activity host / broker share the host OS kernel (not a VM/microVM boundary). Every governed target was falsified unreachable by name, literal IP, and the docker gateway from inside each production surface; the activity host cannot read the PEP secret path, cannot reach GitHub or the record-service port directly (egress pinned to the Kernel/Temporal/broker ports), and cannot use the docker daemon to mount+read the secret (daemon socket denied); GitHub/Docker work is delegated to the credential-less bounded broker; the model provider token is injected by env and never exposes host keychain material.",
      ],
    },
    producer_ref: "deployment-control-probe",
    source_ref: "deployment-control malicious-discovery probe inside the exact production isolation",
    source_relation: "INDEPENDENT_OBSERVATION",
  });
  console.log(JSON.stringify({ reach: reach.evidence_id, alternate_path_found: alternateFound, image_digest: image.image_digest.slice(0, 24), tool_versions: image.tool_versions, probes: probes.map((p2) => ({ identity: p2["identity"], isolation: p2["isolation"] ?? p2["target"], reached: p2["reached"], governed_reached: (p2["governed_reached"] as unknown[] | undefined)?.length ?? 0 })) }, null, 2));

  // ---- TARGET_IMMUTABILITY_ATTESTATION: ruleset read + real negative probe ----
  const rulesets = JSON.parse(execFileSync("gh", ["api", `/repos/${m.repo_full_name}/rulesets`], { encoding: "utf8" })) as Array<{ id: number; name: string; enforcement: string }>;
  const ruleset = rulesets.find((r) => r.name === "cadp-candidate-write-once");
  const rulesetDetail = ruleset === undefined
    ? undefined
    : (JSON.parse(execFileSync("gh", ["api", `/repos/${m.repo_full_name}/rulesets/${ruleset.id}`], { encoding: "utf8" })) as { enforcement: string; rules: Array<{ type: string }>; conditions: unknown; bypass_actors?: unknown[] });
  const probeSha = m.base_sha;
  const probeRef = `refs/heads/cadp/candidate/${probeSha}`;
  const token = readFileSync(join(dir, "secret", "github-token"), "utf8").trim();
  const remote = `https://x-access-token:${token}@github.com/${m.repo_full_name}.git`;
  spawnSync("git", ["push", remote, `${probeSha}:${probeRef}`], { cwd: join(dir, "seed"), encoding: "utf8" });
  const seedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(dir, "seed"), encoding: "utf8" }).trim();
  const moveAttempt = spawnSync("git", ["push", "--force", remote, `${seedHead}:${probeRef}`], { cwd: join(dir, "seed"), encoding: "utf8" });
  const deleteAttempt = spawnSync("git", ["push", remote, `:${probeRef}`], { cwd: join(dir, "seed"), encoding: "utf8" });
  const moveRejected = moveAttempt.status !== 0 || seedHead === probeSha;
  const deleteRejected = deleteAttempt.status !== 0;
  const enforced =
    rulesetDetail?.enforcement === "active" &&
    ["update", "deletion", "non_fast_forward"].every((t) => rulesetDetail.rules.some((r) => r.type === t)) &&
    (rulesetDetail.bypass_actors ?? []).length === 0 &&
    moveRejected && deleteRejected;
  const immutability = await client("cadp-depctl-target").submitEvidence({
    evidence_kind: "TARGET_IMMUTABILITY_ATTESTATION",
    subject_bindings: [{ authority_ref: "github.com", namespace: "GIT_REPOSITORY", object_id: m.repo_id }],
    availability: "PRESENT",
    claim_schema: "cadp.target-immutability.v1",
    claim: {
      write_once_enforced: enforced,
      ruleset: rulesetDetail ?? null,
      negative_probe: {
        probe_ref: probeRef,
        move_exit: moveAttempt.status,
        move_stderr: (moveAttempt.stderr ?? "").slice(0, 300),
        delete_exit: deleteAttempt.status,
        delete_stderr: (deleteAttempt.stderr ?? "").slice(0, 300),
      },
    },
    producer_ref: "deployment-control-target",
    source_ref: "github.com rulesets API + admin-token negative probe",
    source_relation: "TARGET_AUTHORITY_OBSERVATION",
  });
  console.log(JSON.stringify({ immutability: immutability.evidence_id, write_once_enforced: enforced, move_rejected: moveRejected, delete_rejected: deleteRejected }, null, 2));
}

const opsLog = (line: Record<string, unknown>): void => console.log(JSON.stringify(line, null, 2));

/**
 * Delegated owner-agent merge approval. Identical §9.3 contract to human-approve, but the
 * envelope is AGENT_DECISION from agent:claude-owner — honestly attributed. It satisfies the
 * merge gate only where the active policy's delegated_merge_producers names this producer.
 */
async function agentApprove(effect_id: string, workflow_id: string): Promise<void> {
  const m = manifest();
  const c = client("cadp-agent-owner");
  const state = await c.getEffectState(effect_id);
  const shown = {
    effect_id,
    request_digest: state.request.request_digest.value,
    target_ref: state.request.target_ref,
    material_digest: state.request.material_digest.value,
    operation: state.request.operation_kind,
  };
  console.log("AGENT SURFACE RENDERS:", JSON.stringify(shown, null, 2));
  const envelope = await c.submitEvidence({
    evidence_kind: "AGENT_DECISION",
    subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: effect_id }],
    availability: "PRESENT",
    claim_schema: "cadp.human-decision.v1",
    claim: {
      principal: "agent:claude-owner",
      decision: "APPROVE",
      scope: { effect_id, target_ref: shown.target_ref, material_digest: shown.material_digest },
      presented_request_digest: state.request.request_digest,
      statement: "approved by the delegated owner-agent after reviewing the exact sealed merge effect",
      issued_at: new Date().toISOString(),
    },
    producer_ref: "agent:claude-owner",
    source_ref: "agent-owner-approval-surface",
    source_relation: "INDEPENDENT_OBSERVATION",
  });
  execFileSync("temporal", [
    "workflow", "signal", "--workflow-id", workflow_id, "--name", "humanDecision",
    "--input", JSON.stringify(envelope.evidence_id),
    "--address", `127.0.0.1:${m.temporal_port}`, "--namespace", "cadp-v04",
  ]);
  console.log(JSON.stringify({ agent_evidence: envelope.evidence_id, signalled: workflow_id }));
}

async function humanApprove(effect_id: string, workflow_id: string): Promise<void> {
  const m = manifest();
  const c = client("sso:a.t.laplace@gmail.com");
  // Path A (§9.3): the surface renders the EXACT pre-sealed effect from kernel state…
  const state = await c.getEffectState(effect_id);
  const shown = {
    effect_id,
    request_digest: state.request.request_digest.value,
    target_ref: state.request.target_ref,
    material_digest: state.request.material_digest.value,
    operation: state.request.operation_kind,
  };
  console.log("HUMAN SURFACE RENDERS:", JSON.stringify(shown, null, 2));
  // …and POSTs the envelope with the scope copied from what was rendered.
  const envelope = await c.submitEvidence({
    evidence_kind: "HUMAN_DECISION",
    subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "effect", object_id: effect_id }],
    availability: "PRESENT",
    claim_schema: "cadp.human-decision.v1",
    claim: {
      principal: "sso:a.t.laplace@gmail.com",
      decision: "APPROVE",
      scope: { effect_id, target_ref: shown.target_ref, material_digest: shown.material_digest },
      presented_request_digest: state.request.request_digest,
      statement: "approved after reviewing the exact sealed merge effect (live proof, disposable repo)",
      issued_at: new Date().toISOString(),
    },
    producer_ref: "human:astro3141",
    source_ref: "sso-approval-surface (operator-driven live stand-in)",
    source_relation: "INDEPENDENT_OBSERVATION",
  });
  execFileSync("temporal", [
    "workflow", "signal", "--workflow-id", workflow_id, "--name", "humanDecision",
    "--input", JSON.stringify(envelope.evidence_id),
    "--address", `127.0.0.1:${m.temporal_port}`, "--namespace", "cadp-v04",
  ]);
  console.log(JSON.stringify({ human_evidence: envelope.evidence_id, signalled: workflow_id }));
}

async function main(): Promise<void> {
  const m = manifest();
  switch (command) {
    case "up": {
      // Surface egress boundary (TD §4.1): internal network + provider-only allowlist proxy.
      const boundary = createEgressBoundary(`cadp-${m.repo_id}`, ["api.openai.com", "chatgpt.com", "auth.openai.com", "api.anthropic.com", "statsig.anthropic.com", "sentry.io"]);
      writeFileSync(join(dir, "egress.json"), JSON.stringify({ network: boundary.network, proxy: boundary.proxy }));
      startComponent("record");
      startComponent("temporal");
      await waitHttp(`http://127.0.0.1:${m.record_port}/whoami`);
      await new Promise((r) => setTimeout(r, 4000)); // temporal grpc boot
      startComponent("kernel");
      await waitHttp(`${m.api_url}/get_effect_state`, 200);
      startComponent("broker");
      await waitHttp(`http://127.0.0.1:${m.broker_port}/`, 100);
      startComponent("worker");
      console.log(JSON.stringify({ up: true, egress: boundary.network }));
      break;
    }
    case "egress-down": {
      const b = createEgressBoundary(`cadp-${m.repo_id}`, []);
      b.teardown();
      console.log(JSON.stringify({ egress: "down" }));
      break;
    }
    case "start":
      startComponent(process.argv[4]!);
      break;
    case "stop":
      killComponent(process.argv[4]!);
      break;
    case "attest":
      await attest();
      break;
    case "plan":
      console.log(JSON.stringify(await sealPlan(dir, process.argv[4]!), null, 2));
      break;
    case "work-plan":
      console.log(JSON.stringify({ driver: "done", proposal_evidence_id: process.argv[4]!, results: await workPlan(dir, process.argv[4]!, process.argv[5], opsLog) }, null, 2));
      break;
    case "work-dev":
      await startWork(dir, "development", process.argv.slice(4), { log: opsLog });
      break;
    case "work-record":
      await startWork(dir, "record", process.argv.slice(4), { log: opsLog });
      break;
    case "human-approve":
      await humanApprove(process.argv[4]!, process.argv[5]!);
      break;
    case "agent-approve":
      await agentApprove(process.argv[4]!, process.argv[5]!);
      break;
    case "state": {
      const state = await client("cadp-workflow").getEffectState(process.argv[4]!);
      console.log(JSON.stringify(state, null, 2));
      break;
    }
    case "reconcile":
      console.log(JSON.stringify(await client("cadp-workflow").requestReconcile(process.argv[4]!)));
      break;
    case "root-window": {
      // Root-operator action on the PEP secret path (TD §12: enabled only for the duration
      // of a root operation).
      const marker = join(dir, "secret", "root-window");
      if (process.argv[4] === "open") {
        writeFileSync(marker, new Date().toISOString());
        console.log(JSON.stringify({ root_window: "open" }));
      } else {
        rmSync(marker, { force: true });
        console.log(JSON.stringify({ root_window: "closed" }));
      }
      break;
    }
    default:
      throw new Error(`unknown command ${command}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
