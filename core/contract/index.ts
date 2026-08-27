/**
 * Task Contract builder + Contract Source capture (TD §10, §25).
 *
 * Contract Source raw-byte hashing lives in `source-hash.ts` (Batch 1) and is re-exported there.
 */

export {
  buildTaskContract,
  type TaskContractBuildInput,
  type TaskContractBuildResult,
} from "./builder.ts";
export { captureContractSources } from "./contract-source.ts";
export { ContractError, type ContractErrorReason } from "./errors.ts";
export { hashContractSourceBytes } from "./source-hash.ts";
export {
  sealTaskContract,
  validateTaskContractBody,
  type TaskContractResult,
} from "./task-contract.ts";
export * from "./types.ts";
