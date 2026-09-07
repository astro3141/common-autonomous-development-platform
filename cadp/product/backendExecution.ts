/** Shared BACKEND_EXECUTION attribution and sealing for every surface role. */

import { KernelClient } from "../clients/kernelClient.ts";
import type { SubjectBinding } from "../kernel/records.ts";

export type BackendSurfaceRole = "WORKER" | "REVIEWER" | "PLANNER";

/** Resolve the principal that is allowed to speak for backend-scan:<provider>. */
export function backendScanPrincipal(provider: string): string {
  return provider === "codex" ? "cadp-backend-scan" : `cadp-backend-scan-${provider}`;
}

/** Construct an authenticated scan client without letting a surface producer lend its token. */
export function backendScanClient(
  kernelUrl: string,
  provider: string,
  tokenForPrincipal: (principal: string) => string | undefined,
): KernelClient {
  const principal = backendScanPrincipal(provider);
  const token = tokenForPrincipal(principal);
  if (token === undefined || token.length === 0) throw new Error(`no token for ${principal}`);
  return new KernelClient(kernelUrl, token);
}

export async function submitBackendExecutionEvidence(input: {
  client: Pick<KernelClient, "submitEvidence">;
  provider: string;
  surface_role: BackendSurfaceRole;
  subject_bindings: readonly SubjectBinding[];
  model?: string;
  locator?: string;
  effort?: string;
  effort_locator?: string;
  requested_effort?: string;
}): Promise<string> {
  const observed: Record<string, unknown> = {
    model:
      input.model !== undefined
        ? { availability: "PRESENT", value: input.model, locator: input.locator }
        : { availability: "UNKNOWN" },
    provider: { availability: "PRESENT", value: input.provider, locator: "broker-response#backend_provider" },
    run_id: { availability: "UNKNOWN" },
    version: { availability: "UNKNOWN" },
    effort:
      input.effort !== undefined
        ? { availability: "PRESENT", value: input.effort, locator: input.effort_locator }
        : { availability: "UNKNOWN" },
  };
  const envelope = await input.client.submitEvidence({
    evidence_kind: "BACKEND_EXECUTION",
    subject_bindings: [
      ...input.subject_bindings,
      { authority_ref: "cadp-store:k04", namespace: "surface-role", object_id: input.surface_role },
    ],
    availability: "PRESENT",
    claim_schema: "cadp.backend.v1",
    claim: { requested: { provider: input.provider, model: `${input.provider} default`, ...(input.requested_effort !== undefined ? { effort: input.requested_effort } : {}) }, observed },
    producer_ref: `backend-scan:${input.provider}`,
    source_ref: `${input.provider} session log scan`,
    source_relation: "SELF_REPORT",
  });
  return envelope.evidence_id;
}
