/**
 * TaskSource — generic contract + ProjectDocumentTaskSource adapter (TD §8, §25).
 */

export { TaskSourceError, type TaskSourceErrorReason } from "./errors.ts";
export { parseTaskDocument, type ParsedTask } from "./markdown-sections-v1.ts";
export {
  MARKDOWN_SECTIONS_V1,
  ProjectDocumentTaskSource,
  validateProjectDocumentConfig,
  type DocumentReader,
  type ProjectDocumentTaskSourceConfig,
} from "./project-document-task-source.ts";
export {
  hashTaskDefinitionBody,
  normalizeTaskDefinition,
  normalizeTaskDefinitionBody,
} from "./task-definition.ts";
export * from "./types.ts";
