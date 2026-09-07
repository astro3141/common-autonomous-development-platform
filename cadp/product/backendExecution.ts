import { KernelClient } from "../clients/kernelClient.ts";
import type { EvidenceEnvelopeV1, SubjectBinding } from "../kernel/records.ts";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`activity environment missing ${name}`);
  return value;
}

export function backendScanPrincipal(provider: string): string {
  return provider === "codex" ? "cadp-backend-scan" : `cadp-backend-scan-${provider}`;
}

/** Shared provider-specific scan identity selection for activity and live composition callers. */
export function backendScanClient(
  provider: string,
  live?: { api_url: string; tokens: Record<string, string> },
): KernelClient {
  if (live !== undefined) {
    const principal = backendScanPrincipal(provider);
    const token = live.tokens[principal];
    if (token === undefined) throw new Error(`no token for ${principal}`);
    return new KernelClient(live.api_url, token);
  }
  const providerTokenVar = `CADP_BACKEND_SCAN_TOKEN_${provider.toUpperCase()}`;
  const scanToken = process.env[providerTokenVar] ?? requiredEnv("CADP_BACKEND_SCAN_TOKEN");
  return new KernelClient(requiredEnv("CADP_KERNEL_URL"), scanToken);
}

export async function submitBackendExecutionEvidence(input: {
  provider: string;
  surface_role: "WORKER" | "REVIEWER" | "PLANNER";
  subject_bindings: SubjectBinding[];
  model?: string;
  locator?: string;
  source_ref?: string;
  client?: KernelClient;
}): Promise<EvidenceEnvelopeV1> {
  const observed: Record<string, unknown> = {
    model: input.model !== undefined
      ? { availability: "PRESENT", value: input.model, locator: input.locator }
      : { availability: "UNKNOWN" },
    provider: { availability: "PRESENT", value: input.provider, locator: "broker-response#backend_provider" },
    run_id: { availability: "UNKNOWN" },
    version: { availability: "UNKNOWN" },
    effort: { availability: "UNKNOWN" },
  };
  return (input.client ?? backendScanClient(input.provider)).submitEvidence({
    evidence_kind: "BACKEND_EXECUTION",
    subject_bindings: [
      ...input.subject_bindings,
      { authority_ref: "cadp-store:k04", namespace: "surface-role", object_id: input.surface_role },
    ],
    availability: "PRESENT",
    claim_schema: "cadp.backend.v1",
    claim: { requested: { provider: input.provider, model: `${input.provider} default` }, observed },
    producer_ref: `backend-scan:${input.provider}`,
    source_ref: input.source_ref ?? `${input.provider} session log scan`,
    source_relation: "SELF_REPORT",
  });
}
