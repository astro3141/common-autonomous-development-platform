/** Multi-provider CLI agent RuntimeAdapter (#73 Claude Code, #49 AGY/Gemini, #50 Grok). */

export {
  CLI_AGENT_ACTOR_RESULT_PROTOCOL,
  CLI_AGENT_RUNTIME_BACKEND,
  CliAgentBackendCapabilityGap,
  CliAgentRuntimeAdapter,
  CliAgentRuntimeOperationConflict,
  cliAgentRuntimePreflight,
} from "./cli-agent-runtime-adapter.ts";
export { CLI_AGENT_RUNTIME_ADAPTER_VERSION, cliAgentPilotManifests } from "./manifest.ts";
export {
  CLAUDE_CODE_PROVIDER,
  GROK_PROVIDER,
  PROVIDER_SEAMS,
  SECOND_AGENT_PROVIDER,
  type CliAgentProviderSeam,
} from "./providers.ts";
export type {
  CliAgentInvocation,
  CliAgentCommandObservation,
  CliAgentProcessRunner,
  CliAgentProfileBinding,
  CliAgentProvider,
  CliAgentRuntimeAdapterConfig,
  ParsedCliAgentTurn,
} from "./types.ts";
