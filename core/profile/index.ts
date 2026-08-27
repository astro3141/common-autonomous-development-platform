/**
 * Profile Registry / Compiler — schema + compilation (TD §7).
 *
 * Registry persistence, YAML loading and file access are not part of this module.
 */

export { compileProfile, type CompileInput, type CompileResult } from "./compiler.ts";
export { ProfileCompileError, type CompileErrorReason } from "./errors.ts";
export {
  isOverridePath,
  OVERRIDE_WHITELIST,
  privilegeDirection,
  type OverridePath,
  type PrivilegeDirection,
} from "./override-policy.ts";
export { validateApprovedOverrides } from "./validate-overrides.ts";
export { validateExecutionPolicy } from "./validate-execution-policy.ts";
export { validateProjectProfile } from "./validate-project-profile.ts";
export * from "./types.ts";
