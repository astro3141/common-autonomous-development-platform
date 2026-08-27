/**
 * Minimal deterministic test doubles for the five Backend boundaries (Spec §63, TD §25).
 */

export { FakeRuntimeAdapter } from "./fake-runtime-adapter.ts";
export { FakeWorkflowAdapter } from "./fake-workflow-adapter.ts";
export { FakeRepositoryAdapter } from "./fake-repository-adapter.ts";
export { FakeVerificationAdapter } from "./fake-verification-adapter.ts";
export { FakeReportAdapter } from "./fake-report-adapter.ts";
export { ScriptedResponses, TestDoubleError, type FakeCall } from "./scripted.ts";
