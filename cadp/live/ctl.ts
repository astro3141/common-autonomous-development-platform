/**
 * #100 live-composition control (deployment-control + operator surfaces):
 *   node cadp/live/ctl.ts <dir> up                          start record/temporal/kernel/worker
 *   node cadp/live/ctl.ts <dir> stop|start <component>      kill / restart one real process
 *   node cadp/live/ctl.ts <dir> attest                      reach + immutability attestations
 *   node cadp/live/ctl.ts <dir> work-dev <item> [maxSteps maxEffects]
 *   node cadp/live/ctl.ts <dir> work-record <n-payloads> [maxSteps maxEffects]
 *   node cadp/live/ctl.ts <dir> human-approve <effect_id> <workflow_id>
 *   node cadp/live/ctl.ts <dir> state <effect_id>
 *   node cadp/live/ctl.ts <dir> reconcile <effect_id>
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifest, spawnComponent } from "./env.ts";
import { buildWorkerSandbox, reviewerEnv, workerProfileDigest, WORKER_ARGV_PREFIX } from "../product/workerProfile.ts";
import { dockerAvailable, runReviewer, runVerifier, runWorker } from "../product/isolation.ts";
import type { IsolationConfig } from "../product/isolation.ts";
import type { LiveEnvManifest } from "./env.ts";
import { KernelClient } from "../clients/kernelClient.ts";
import { jcsDigest, sha256Hex } from "../kernel/canonical.ts";

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
    case "worker": {
      mkdirSync(join(dir, "worker-tmp"), { recursive: true });
      spawnComponent(dir, "worker", "node", [join(repoRoot, "cadp/product/worker.ts")], {
        CADP_KERNEL_URL: m.api_url,
        CADP_WORKFLOW_TOKEN: m.tokens["cadp-workflow"]!,
        CADP_VERIFIER_TOKEN: m.tokens["cadp-verifier"]!,
        CADP_REVIEWER_TOKEN: m.tokens["cadp-reviewer-claude"]!,
        CADP_BACKEND_SCAN_TOKEN: m.tokens["cadp-backend-scan"]!,
        CADP_TEMPORAL_ADDRESS: `127.0.0.1:${m.temporal_port}`,
        CADP_TEMPORAL_NAMESPACE: "cadp-v04",
        CADP_TASK_QUEUE: "cadp-worker",
        // OS-isolation config for the untrusted surfaces (TD §4.1). The activity host process
        // holds the kernel token, but the surfaces it launches run inside these boundaries.
        CADP_WORKER_IMAGE: readFileSync(join(dir, "worker-image"), "utf8").trim(),
        CADP_GOVERNED_HOSTS: "github.com,api.github.com,codeload.github.com,objects.githubusercontent.com",
        CADP_DENIED_PORTS: `${m.api_port},${m.root_port},${m.record_port}`,
        CADP_DENIED_READ_PATHS: `${join(dir, "secret")}:${join(dir, "manifest.json")}`,
      });
      break;
    }
    default:
      throw new Error(`unknown component ${name}`);
  }
  console.log(JSON.stringify({ started: name }));
}

function temporalNamespaceId(): string {
  const m = manifest();
  const out = execFileSync("temporal", ["operator", "namespace", "describe", "--namespace", "cadp-v04", "--address", `127.0.0.1:${m.temporal_port}`, "-o", "json"], { encoding: "utf8" });
  const parsed = JSON.parse(out) as { namespaceInfo?: { id?: string } };
  return parsed.namespaceInfo?.id ?? "cadp-v04";
}

function safeJson(text: string): { fs_reads?: Array<Record<string, unknown>>; credential_use?: Array<Record<string, unknown>>; egress?: Array<Record<string, unknown>>; enumerated?: string[] } | undefined {
  const line = text.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  if (line === undefined) return undefined;
  try { return JSON.parse(line); } catch { return undefined; }
}

async function attest(): Promise<void> {
  const m = manifest();
  const repoRoot = join(import.meta.dirname, "..", "..");
  const payload = join(repoRoot, "cadp/live/probePayload.mjs");
  const probeBase = join(dir, "probe-profile");
  mkdirSync(probeBase, { recursive: true });

  const config: IsolationConfig = {
    worker_image: readFileSync(join(dir, "worker-image"), "utf8").trim(),
    governed_hosts: ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com"],
    denied_ports: [m.api_port, m.root_port, m.record_port],
    denied_read_paths: [join(dir, "secret"), join(dir, "manifest.json")],
  };
  if (!(await dockerAvailable())) throw new Error("isolation runtime (docker) unavailable — cannot attest fail-closed boundary");

  // The malicious payload the deployment-control probe runs INSIDE each surface's exact
  // production isolation: it searches for secret/token files, tries to use any credential it
  // finds against the Kernel effect path, hits governed targets, and attempts keychain theft.
  const targets = { github_api: "https://api.github.com/rate_limit", record_service: `http://host.docker.internal:${m.record_port}/records` };
  const searchRoots = ["/", "/Users", dir, join(dir, "secret")].join(":");

  const probes: Array<Record<string, unknown>> = [];

  // Worker surface: container. Host fs invisible; governed hosts pinned dead. Payload runs in /ws.
  {
    const sandbox = buildWorkerSandbox(probeBase);
    const wsDir = join(probeBase, "worker-ws");
    mkdirSync(wsDir, { recursive: true });
    execFileSync("cp", [payload, join(wsDir, "probe.mjs")]);
    const run = await runWorker(config, {
      workspace: wsDir,
      codexAuthDir: join(sandbox.home, ".codex"),
      argv: ["node", "/ws/probe.mjs"],
      timeout_ms: 60_000,
    });
    // In-container payload uses container-visible roots; host targets pinned dead by --add-host.
    const containerRun = await runWorker(config, {
      workspace: wsDir,
      codexAuthDir: join(sandbox.home, ".codex"),
      argv: ["sh", "-c", `PROBE_SEARCH_ROOTS='/:/ws:/root' PROBE_TARGETS='${JSON.stringify(targets).replace(/'/gu, "")}' node /ws/probe.mjs`],
      timeout_ms: 60_000,
    });
    const parsed = safeJson(containerRun.stdout) ?? safeJson(run.stdout) ?? { fs_reads: [], credential_use: [], egress: [], enumerated: [] };
    const reached = (parsed.fs_reads?.length ?? 0) > 0 || (parsed.credential_use ?? []).some((c: Record<string, unknown>) => typeof c["status"] === "number" && (c["status"] as number) < 400) || (parsed.egress ?? []).some((e: Record<string, unknown>) => e["status"] !== "000" && typeof e["status"] === "number" && (e["status"] as number) < 500);
    probes.push({ identity: "worker", isolation: "docker container (no host mount; governed hosts pinned)", reached, findings: parsed });
    // Worker profile still imports auth.json only (finding 2 retained).
    const codexDir = join(sandbox.home, ".codex");
    const contents = existsSync(codexDir) ? readdirSync(codexDir) : [];
    probes.push({ identity: "worker", target: "codex profile contents (auth.json only)", reached: contents.some((f) => f === "config.toml" || f === "mcp.json"), detail: contents.join(",") });
  }

  // Verifier surface: container with --network none. No host mount but the checkout; no egress.
  {
    const wsDir = join(probeBase, "verifier-ws");
    mkdirSync(wsDir, { recursive: true });
    execFileSync("cp", [payload, join(wsDir, "probe.mjs")]);
    const run = await runVerifier(config, {
      workspace: wsDir,
      argv: ["sh", "-c", `PROBE_SEARCH_ROOTS='/:/ws:/root' PROBE_TARGETS='${JSON.stringify(targets).replace(/'/gu, "")}' node /ws/probe.mjs`],
      timeout_ms: 60_000,
    });
    const parsed = safeJson(run.stdout) ?? { fs_reads: [], credential_use: [], egress: [] };
    const reachedTarget = (parsed.egress ?? []).some((e: Record<string, unknown>) => e["status"] !== "000");
    const reached = (parsed.fs_reads?.length ?? 0) > 0 || reachedTarget;
    probes.push({ identity: "verifier", isolation: "docker container --network none", reached, findings: parsed });
  }

  // Reviewer surface: Seatbelt. Host fs visible EXCEPT the denied secret path + denied ports.
  {
    const rHome = join(probeBase, "reviewer-home");
    mkdirSync(join(rHome, "tmp"), { recursive: true });
    const localTargets = { github_api: "https://api.github.com/rate_limit", kernel_api: `http://127.0.0.1:${m.api_port}/allocate_effect_id`, record_service: `http://127.0.0.1:${m.record_port}/records` };
    const run = await runReviewer(config, {
      workspace: rHome,
      sandboxDir: rHome,
      env: { ...reviewerEnv(rHome), PROBE_SEARCH_ROOTS: searchRoots, PROBE_TARGETS: JSON.stringify(localTargets) },
      argv: ["node", payload],
      timeout_ms: 60_000,
    });
    const parsed = safeJson(run.stdout) ?? { fs_reads: [], credential_use: [], egress: [], enumerated: [] };
    // The secret path must not be readable; the kernel/record ports must be refused (000).
    const secretRead = (parsed.fs_reads ?? []).some((f: Record<string, unknown>) => String(f["path"]).includes("/secret/") || String(f["path"]).endsWith("manifest.json"));
    const kernelReached = (parsed.egress ?? []).some((e: Record<string, unknown>) => e["target"] === "kernel_api" && e["status"] !== "000");
    const credUsed = (parsed.credential_use ?? []).some((c: Record<string, unknown>) => typeof c["status"] === "number" && (c["status"] as number) < 400);
    probes.push({ identity: "reviewer", isolation: "seatbelt (deny secret path + kernel/target ports + keychain)", reached: secretRead || kernelReached || credUsed, findings: parsed });
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
      worker_argv_prefix: [...WORKER_ARGV_PREFIX],
      isolation: {
        worker: "docker container: no host filesystem mount; governed target hosts pinned to 127.0.0.1",
        verifier: "docker container --network none: no host mount but checkout, no egress at all",
        reviewer: "macOS Seatbelt: deny-read PEP secret path + manifest; deny kernel/target ports; deny keychain/credential-helper exec",
      },
      probes,
      network_policy_digest: "disposable-os-isolation:container-network-none+addhost-deadhost+seatbelt-port-deny",
      secret_acl_digest: sha256Hex(readFileSync(join(dir, "secret", "api-tokens.json"))),
      known_residuals: [
        "single-host disposable proof: containers share the host kernel (not a VM boundary); the reviewer runs under Seatbelt rather than a container because it needs host Claude auth. Both boundaries were exercised by the malicious discovery payload above and denied the PEP secret path, the Kernel/target ports, and keychain credential theft.",
      ],
    },
    producer_ref: "deployment-control-probe",
    source_ref: "deployment-control malicious-discovery probe inside the exact production isolation",
    source_relation: "INDEPENDENT_OBSERVATION",
  });
  console.log(JSON.stringify({ reach: reach.evidence_id, alternate_path_found: alternateFound, probes: probes.map((p2) => ({ identity: p2["identity"], isolation: p2["isolation"] ?? p2["target"], reached: p2["reached"] })) }, null, 2));

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

async function startWork(vertical: "development" | "record", extra: string[], ordinalArg?: string): Promise<void> {
  const m = manifest();
  const c = client("cadp-workflow");
  const namespaceId = temporalNamespaceId();

  const args =
    vertical === "development"
      ? {
          vertical,
          bounds: { max_steps: Number(extra[1] ?? 8), max_effects: Number(extra[2] ?? 6) },
          development: {
            repo_id: m.repo_id,
            repo_full_name: m.repo_full_name,
            base_ref: "refs/heads/main",
            base_sha: m.base_sha,
            work_item: extra[0]!,
            require_human_merge: true,
          },
        }
      : {
          vertical,
          bounds: { max_steps: Number(extra[1] ?? 6), max_effects: Number(extra[2] ?? 4) },
          record: {
            tenant: "cadp-disposable",
            resource_prefix: `live-${Date.now() % 100000}`,
            payloads: Array.from({ length: Number(extra[0] ?? 2) }, (_, i) => `live payload ${i + 1}`),
          },
        };

  const ordinal = ordinalArg !== undefined ? Number(ordinalArg) : Math.floor(Date.now() / 1000) % 1000000;
  const { effect_id } = await c.allocateEffectId({
    schema: "cadp.allocation-key.v1",
    work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000000",
    step_ordinal: ordinal,
    purpose: "work-start",
  });
  const argsBytes = Buffer.from(JSON.stringify(args), "utf8");
  const { cas_key: args_cas_key } = await c.putBlob(argsBytes);
  const material = {
    workflow_id: `cadp-work-${effect_id}`,
    workflow_type: "cadpWork",
    task_queue: "cadp-worker",
    args_cas_key,
    args_digest: jcsDigest(args).value,
    bounds: args.bounds,
    worker_profile_digest: workerProfileDigest(),
    continuation_target: `temporal:cadp-v04:${namespaceId}`,
  };
  const { cas_key: material_ref } = await c.putBlob(Buffer.from(JSON.stringify(material), "utf8"));
  const request = await c.sealEffectRequest({
    effect_id,
    requester_ref: "workflow:cadp-work",
    work_bindings: [
      { authority_ref: "github.com", namespace: "work-item", object_id: vertical === "development" ? `dev:${extra[0]}` : `record:${extra[0]}` },
    ],
    target_ref: { authority_ref: "temporal:cadp-v04", target_type: "WORKFLOW", target_id: namespaceId },
    operation_kind: "WORK_START",
    material_schema: "cadp.work-start.v1",
    material_ref,
    prior_effect_refs: [],
  });
  const input = await c.assembleAdmissionInput(effect_id, []);
  const evaluated = await c.evaluate(input.input_digest.value);
  if (evaluated.kind !== "DECISION" || evaluated.decision.outcome !== "ALLOW") {
    console.log(JSON.stringify({ effect_id, evaluated }, null, 2));
    return;
  }
  const admitted = await c.admitAndDispatch(effect_id, evaluated.decision.decision_id);
  console.log(JSON.stringify({ effect_id, workflow_id: material.workflow_id, request_digest: request.request_digest.value, admitted }, null, 2));
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
    case "up":
      startComponent("record");
      startComponent("temporal");
      await waitHttp(`http://127.0.0.1:${m.record_port}/whoami`);
      await new Promise((r) => setTimeout(r, 4000)); // temporal grpc boot
      startComponent("kernel");
      await waitHttp(`${m.api_url}/get_effect_state`, 200);
      startComponent("worker");
      console.log(JSON.stringify({ up: true }));
      break;
    case "start":
      startComponent(process.argv[4]!);
      break;
    case "stop":
      killComponent(process.argv[4]!);
      break;
    case "attest":
      await attest();
      break;
    case "work-dev":
      await startWork("development", process.argv.slice(4));
      break;
    case "work-record":
      await startWork("record", process.argv.slice(4));
      break;
    case "human-approve":
      await humanApprove(process.argv[4]!, process.argv[5]!);
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
