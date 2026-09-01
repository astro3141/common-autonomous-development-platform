/**
 * GitHub development surface (#52/#57/#70) — one repository as task intake, child-materialisation
 * target, CI verification backend, and candidate-PR delivery, behind four independent adapters
 * that share only the process transport. None of them holds Platform lifecycle authority.
 */

export { GhCliTransport, GitHubTransportError, type GitHubApiRequest, type GitHubTransportV1 } from "./transport.ts";
export {
  deriveBodyFromIssue,
  parseDefinitionMarker,
  parseMaterializationMarker,
  renderIssueBody,
  type MaterializationMarkerV1,
} from "./representation.ts";
export { GitHubIssuesTaskSource, type GitHubIssuesTaskSourceConfig } from "./github-task-source.ts";
export {
  GitHubIssuesChildMaterializer,
  type GitHubChildMaterializerConfig,
} from "./github-child-materializer.ts";
export {
  GitHubPullRequestProjection,
  type GitHubPrProjectionConfig,
} from "./github-pr-projection.ts";
export {
  AUDIT_STATUS_CONTEXT,
  GITHUB_ACTIONS_EXECUTOR_IDENTITY,
  GitHubActionsVerificationAdapter,
  type GitHubActionsVerificationConfig,
} from "./github-actions-verification.ts";
