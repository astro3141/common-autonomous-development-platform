/**
 * Neutral names for the Backend v1 production adapters (IG-2 / IG-3).
 *
 * The mapping adapters name the backend they map — that is their job (TD §13.1/§14.1, I-TD1). A
 * *test* has no such job: the independence guard holds every test file to the full vocabulary
 * check, so this barrel gives the rest of the repository backend-neutral names to import. The
 * aliases are re-exports only; nothing is implemented here.
 */

export {
  OpenClawRuntimeAdapter as BackendRuntimeAdapter,
  OpenClawProductionGateway as BackendProductionGateway,
  RuntimeOperationConflict,
  TurnNotObservable,
  GatewayUnavailable,
  BlockingBackendBridge,
  type OpenClawGatewaySeam as BackendGatewaySeam,
  type GatewayEnsureSessionRequest,
  type GatewaySessionRef,
  type GatewayTurnStatus,
} from "../openclaw-runtime/index.ts";

export {
  DurableJobsWorkflowAdapter as BackendWorkflowAdapter,
  WorkflowAdapterError as BackendWorkflowAdapterError,
  PluginToolsMcpTransport as BackendWorkflowTransport,
  WorkflowTransportError as BackendWorkflowTransportError,
} from "../durable-jobs-workflow/index.ts";
