/**
 * Admission — fact assembly, Proposal submission and task admission (TD §5.6, §26 step 5–7).
 *
 * Callable use-cases only: nothing here runs on a timer, polls, or drives a loop.
 */

export { AdmissionError, type AdmissionErrorReason } from "./errors.ts";
export {
  evaluateHardDependencies,
  isDirectHardDependencySatisfied,
  type DependencyAdmissionView,
  type HardDependencyEvaluation,
} from "./dependency-admission.ts";
export {
  activateSelectedTask,
  type ActivateTaskCommand,
  type ActivationOutcome,
  type SelectionMismatch,
} from "./activate-task.ts";
export { bootstrapRun, type RunBootstrapCommand, type RunBootstrapResult } from "./bootstrap.ts";
export {
  assembleDecisionInput,
  type AssembledDecision,
  type DecisionAuthorities,
  type SubmissionContext,
} from "./fact-assembly.ts";
export {
  resolveHumanGateAndAdmit,
  submitProposal,
  type ProposalSubmissionResult,
  type SubmitProposalCommand,
} from "./submit-proposal.ts";
