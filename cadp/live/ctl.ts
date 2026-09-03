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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifest, spawnComponent } from "./env.ts";
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
      spawnComponent(dir, "record", "node", [join(repoRoot, "cadp/product/recordService.ts"), String(m.record_port), join(dir, "record-service.sqlite")]);
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

async function attest(): Promise<void> {
  const m = manifest();
  const probeHome = join(dir, "probe-home");
  mkdirSync(join(probeHome, "empty-gh"), { recursive: true });

  // ---- CREDENTIAL_REACH_ATTESTATION: real negative probes under the worker sandbox env ----
  const sandboxEnv = { PATH: process.env["PATH"] ?? "", HOME: probeHome, GH_CONFIG_DIR: join(probeHome, "empty-gh"), NO_COLOR: "1" };
  const probes: Array<Record<string, unknown>> = [];
  const ghProbe = spawnSync("gh", ["api", "/user"], { env: sandboxEnv, encoding: "utf8", timeout: 30_000 });
  probes.push({
    target: "github.com (authenticated API as worker identity)",
    method: "gh api /user under sandbox env (fresh HOME, empty GH_CONFIG_DIR, no token env)",
    exit_code: ghProbe.status,
    reached: ghProbe.status === 0,
    detail: (ghProbe.stderr || ghProbe.stdout).slice(0, 200).trim(),
  });
  const pushProbe = spawnSync(
    "git",
    ["push", `https://github.com/${m.repo_full_name}.git`, `HEAD:refs/heads/cadp/probe-${Date.now()}`],
    { env: { ...sandboxEnv, GIT_TERMINAL_PROMPT: "0" }, cwd: join(dir, "seed"), encoding: "utf8", timeout: 30_000 },
  );
  probes.push({
    target: `github.com/${m.repo_full_name} (governed repo push as worker identity)`,
    method: "git push without credentials (GIT_TERMINAL_PROMPT=0)",
    exit_code: pushProbe.status,
    reached: pushProbe.status === 0,
    detail: (pushProbe.stderr || "").slice(0, 200).trim(),
  });
  const tokenEnvLeak = ["GH_TOKEN", "GITHUB_TOKEN"].filter((k) => process.env[k] !== undefined);
  const alternateFound = probes.some((p) => p["reached"] === true);
  const reachDraft = {
    evidence_kind: "CREDENTIAL_REACH_ATTESTATION" as const,
    subject_bindings: [{ authority_ref: "cadp-store:k04", namespace: "deployment", object_id: "cadp-v04-live" }],
    availability: "PRESENT" as const,
    claim_schema: "cadp.credential-reach.v1",
    claim: {
      alternate_path_found: alternateFound,
      probes,
      token_env_leak: tokenEnvLeak,
      network_policy_digest: "single-host-harness:sandbox-env",
      secret_acl_digest: sha256Hex(readFileSync(join(dir, "secret", "api-tokens.json"))),
      known_residuals: [
        "single-host macOS: OS keychain items of the operating user remain readable by any same-user process; the worker identity boundary here is env/config isolation, not OS-level network policy (reported per TD §4.1 — deployment mechanism approximation)",
      ],
    },
    producer_ref: "deployment-control-probe",
    source_ref: "deployment-control live probe",
    source_relation: "INDEPENDENT_OBSERVATION" as const,
  };
  const reach = await client("cadp-depctl-probe").submitEvidence(reachDraft);
  console.log(JSON.stringify({ reach: reach.evidence_id, alternate_path_found: alternateFound, probes }, null, 2));

  // ---- TARGET_IMMUTABILITY_ATTESTATION: ruleset read + real negative probe ----
  const rulesets = JSON.parse(execFileSync("gh", ["api", `/repos/${m.repo_full_name}/rulesets`], { encoding: "utf8" })) as Array<{ id: number; name: string; enforcement: string }>;
  const ruleset = rulesets.find((r) => r.name === "cadp-candidate-write-once");
  const rulesetDetail = ruleset === undefined
    ? undefined
    : (JSON.parse(execFileSync("gh", ["api", `/repos/${m.repo_full_name}/rulesets/${ruleset.id}`], { encoding: "utf8" })) as { enforcement: string; rules: Array<{ type: string }>; conditions: unknown; bypass_actors?: unknown[] });
  // Negative probe: create a probe candidate ref, then attempt update + delete with an
  // ADMIN-scoped token (expected: rejected by the active ruleset).
  const probeSha = m.base_sha;
  const probeRef = `refs/heads/cadp/candidate/${probeSha}`;
  const token = readFileSync(join(dir, "secret", "github-token"), "utf8").trim();
  const remote = `https://x-access-token:${token}@github.com/${m.repo_full_name}.git`;
  spawnSync("git", ["push", remote, `${probeSha}:${probeRef}`], { cwd: join(dir, "seed"), encoding: "utf8" }); // creation allowed
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
    worker_profile_digest: jcsDigest({ argv: ["codex", "exec", "--sandbox", "workspace-write", "--skip-git-repo-check"] }).value,
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
    default:
      throw new Error(`unknown command ${command}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
