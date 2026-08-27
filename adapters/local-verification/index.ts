/**
 * Backend v1 VerificationAdapter. The only place that knows verification runs as a workflow.
 *
 * `createLocalVerification` is the production composition: an adapter wired to the concrete
 * workflow-tool seam, so nothing outside this directory has to supply a backend status object.
 */

import { LocalVerificationAdapter } from "./local-verification-adapter.ts";
import type { LocalVerificationDependencies } from "./local-verification-adapter.ts";
import { WorkflowToolVerificationSeam } from "./workflow-tool-seam.ts";
import type { WorkflowToolTransport } from "./workflow-tool-seam.ts";

export {
  LocalVerificationAdapter,
  type DeclaredCheck,
  type LocalVerificationDependencies,
  type VerificationProfileChecks,
} from "./local-verification-adapter.ts";
export {
  BackendSeamError,
  WorkflowToolVerificationSeam,
  type WorkflowToolTransport,
} from "./workflow-tool-seam.ts";
export {
  LOCAL_VERIFICATION_ADAPTER_VERSION,
  LOCAL_VERIFICATION_EXECUTOR_IDENTITY,
} from "./evidence.ts";
export type {
  BackendAuditGateStatus,
  BackendStageStatus,
  BackendVerificationStatus,
  VerificationBackendSeam,
  VerificationRunRefV1,
} from "./backend-seam.ts";

/** The production Backend v1 verification stack. The `backend` seam is not a caller's concern. */
export function createLocalVerification(
  dependencies: Omit<LocalVerificationDependencies, "backend"> & {
    readonly transport: WorkflowToolTransport;
  },
): LocalVerificationAdapter {
  const { transport, ...rest } = dependencies;
  return new LocalVerificationAdapter({
    ...rest,
    backend: new WorkflowToolVerificationSeam(transport),
  });
}
