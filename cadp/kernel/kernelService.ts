/**
 * Kernel Service composition root (TD §0, §11): one deployable unit — Ingress, Assembler,
 * Sealer, PEP, Reconciler, constitutional store access, OPA sidecar, in-process target
 * adapters loaded at composition. Restart behaviour per TD §3.3: verify-on-read the active
 * policy, reconcile open admissions, hold scopes with open incidents (enforced per-admission).
 *
 * Run: node cadp/kernel/kernelService.ts <configPath>
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { startKernelApi, startRootListener } from "./api.ts";
import { Cas } from "./cas.ts";
import { Ingress } from "./ingress.ts";
import { OpaEvaluator } from "./evaluator.ts";
import { Pep } from "./pep.ts";
import { Reconciler } from "./reconciler.ts";
import { resolveActivePolicy } from "./policyState.ts";
import { ConstitutionalStore } from "./store.ts";
import { makeAdapterRegistry } from "./adapters/types.ts";
import type { TargetAdapterV1 } from "./adapters/types.ts";
import { FindingSealAdapter } from "./adapters/findingSeal.ts";
import { GitHubAdapter } from "./adapters/github.ts";
import { GitHubIssuesAdapter } from "./adapters/githubIssues.ts";
import { LiveGitHubTransport } from "./adapters/githubLive.ts";
import { RecordServiceAdapter } from "./adapters/record.ts";
import { StorePolicyAdapter } from "./adapters/storePolicy.ts";
import { TemporalAdapter } from "./adapters/temporal.ts";
import { LiveTemporalTransport } from "./adapters/temporalLive.ts";

export interface KernelServiceConfig {
  db_path: string;
  opa_dir: string;
  api_port: number;
  root_port: number;
  /** PEP-owned secret path (single-host harness directory). */
  secret_dir: string;
  pep_ref: string;
  github?: { repo_id: string; repo_full_name: string; token_file: string };
  temporal?: { address: string; namespace: string; horizon_s: number };
  record?: { base_url: string; api_key_file?: string };
}

export interface KernelService {
  store: ConstitutionalStore;
  cas: Cas;
  ingress: Ingress;
  pep: Pep;
  reconciler: Reconciler;
  evaluator: OpaEvaluator;
  adapters: TargetAdapterV1[];
  apiPort: number;
  rootPort: number;
  close(): void;
}

/**
 * The deployable target-adapter list (TD §6.4). Extracted from `startKernelService` so the
 * production composition — not a test-harness stand-in — is what conformance asserts over.
 *
 * Always-on adapters target the deployment's OWN store and so need no external configuration:
 * `StorePolicyAdapter` (constitutional writes) and `FindingSealAdapter` (#117 §5.1 `FINDING_SEAL`,
 * the one governed operation that can produce a clearing or delegating Finding). The remaining
 * rows are gated on the external credentials they carry.
 */
export function composeTargetAdapters(
  config: KernelServiceConfig,
  deps: { store: ConstitutionalStore; cas: Cas; ingress: Ingress },
): TargetAdapterV1[] {
  const { store, cas, ingress } = deps;
  const adapters: TargetAdapterV1[] = [
    new StorePolicyAdapter(store, cas, ingress),
    new FindingSealAdapter(ingress, store),
  ];
  if (config.github !== undefined) {
    const token = readFileSync(config.github.token_file, "utf8").trim();
    const transport = new LiveGitHubTransport(token, config.github.repo_full_name);
    const repoId = config.github.repo_id;
    adapters.push(
      new GitHubAdapter(transport, cas, repoId, () => {
        const attestation = store.latestEvidenceOfKind(
          "TARGET_IMMUTABILITY_ATTESTATION",
          `github.com|GIT_REPOSITORY|${repoId}`,
        );
        if (attestation === undefined) return false;
        try {
          const active = resolveActivePolicy(store, cas);
          const fresh = Date.now() - Date.parse(attestation.produced_at) <= active.config.target_immutability_attestation_max_age_s * 1000;
          return fresh && (attestation.claim as { write_once_enforced?: boolean })?.write_once_enforced === true;
        } catch {
          return false;
        }
      }),
    );
    // FINDING_PROJECT over GitHub Issues (#104 §6): a distinct target_type (GIT_ISSUES), not the
    // PR ops. Shares the transport; holds no governed credential beyond the repo token custody.
    adapters.push(new GitHubIssuesAdapter(transport, cas, repoId));
  }
  if (config.temporal !== undefined) {
    const transport = new LiveTemporalTransport(config.temporal.address, config.temporal.namespace);
    adapters.push(new TemporalAdapter(transport, cas, config.temporal.namespace, config.temporal.horizon_s));
  }
  if (config.record !== undefined) {
    const recordKey = config.record.api_key_file !== undefined ? readFileSync(config.record.api_key_file, "utf8").trim() : undefined;
    adapters.push(new RecordServiceAdapter(config.record.base_url, cas, "cadp-disposable", recordKey));
  }
  return adapters;
}

export async function startKernelService(config: KernelServiceConfig): Promise<KernelService> {
  const store = new ConstitutionalStore(config.db_path);
  const cas = new Cas(store);
  const ingress = new Ingress(store, cas, config.pep_ref);
  const evaluator = new OpaEvaluator(config.opa_dir);

  const adapters = composeTargetAdapters(config, { store, cas, ingress });

  const registry = makeAdapterRegistry(adapters);
  const pep = new Pep(store, cas, ingress, registry, config.pep_ref);
  const reconciler = new Reconciler(store, cas, ingress, pep, registry);

  // Restart reads (TD §3.3): verify-on-read active policy + serve it to OPA; reconcile scan.
  const active = resolveActivePolicy(store, cas);
  await evaluator.ensureLoaded(active);
  await reconciler.reconcileOpenAdmissions();

  // Identity probes: refresh now and at half the max age (TD §4.2).
  const refreshIdentities = async () => {
    for (const adapter of adapters) {
      try {
        await pep.refreshTargetIdentity(adapter);
      } catch (error) {
        // Fail closed: a target we cannot self-identify against simply has no fresh
        // PEP_TARGET_IDENTITY evidence, and recheck #9 refuses admissions to it.
        console.error(`identity probe failed for ${adapter.describe().target_type}: ${error instanceof Error ? error.message : error}`);
      }
    }
  };
  await refreshIdentities();
  const probeTimer = setInterval(() => void refreshIdentities(), (active.config.identity_probe_max_age_s * 1000) / 2);
  probeTimer.unref();

  const tokens = new Map<string, string>();
  const tokenFile = join(config.secret_dir, "api-tokens.json");
  for (const [token, principal] of Object.entries(JSON.parse(readFileSync(tokenFile, "utf8")) as Record<string, string>)) {
    tokens.set(token, principal);
  }
  const rootToken = readFileSync(join(config.secret_dir, "root-token"), "utf8").trim();

  const api = await startKernelApi({ store, cas, ingress, pep, reconciler, evaluator, tokens }, config.api_port);

  // TD §12: the root listener is DISABLED by default and enabled only for the duration of a
  // root operation. The window is a root-owned marker file in the PEP secret path; the
  // listener binds while the marker exists and closes when it is removed.
  const windowMarker = join(config.secret_dir, "root-window");
  let root: { port: number; close(): void } | undefined;
  const syncRootWindow = async () => {
    const open = existsSync(windowMarker);
    if (open && root === undefined) {
      root = await startRootListener({ store, cas, ingress, rootToken }, config.root_port);
      console.error(`root listener ENABLED (window marker present) on port ${root.port}`);
    } else if (!open && root !== undefined) {
      root.close();
      root = undefined;
      console.error("root listener DISABLED (window marker removed)");
    }
  };
  await syncRootWindow();
  const rootTimer = setInterval(() => void syncRootWindow(), 1000);
  rootTimer.unref();

  return {
    store, cas, ingress, pep, reconciler, evaluator, adapters,
    apiPort: api.port,
    rootPort: root?.port ?? config.root_port,
    close: () => {
      clearInterval(probeTimer);
      clearInterval(rootTimer);
      api.close();
      root?.close();
      evaluator.stop();
      store.close();
    },
  };
}

if (process.argv[1]?.endsWith("kernelService.ts")) {
  const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as KernelServiceConfig;
  startKernelService(config)
    .then((service) => {
      console.log(JSON.stringify({ api_port: service.apiPort, root_port: service.rootPort, pid: process.pid }));
    })
    .catch((error) => {
      console.error("kernel service failed to start:", error);
      process.exit(1);
    });
}
