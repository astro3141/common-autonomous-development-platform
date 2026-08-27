/**
 * The Backend v1 RuntimeResultChannel. Adapter-owned; Core sees only `RuntimeTurnResult`.
 */

export {
  AUDITOR_VERDICT_PROTOCOL,
  ResultChannelConflict,
  RuntimeResultChannel,
  type CollectedResult,
  type SubmitOutcome,
  type SubmitRejection,
} from "./channel.ts";
export { withCollectedResult } from "./turn-result.ts";
