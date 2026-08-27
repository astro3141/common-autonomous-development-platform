/**
 * Neutral task-document and contract fixtures.
 *
 * Invented refs (`T-100`, `T-101`) and fictitious backends only — no project or backend name.
 */

import type { DocumentReader } from "../../core/tasksource/project-document-task-source.ts";

export const taskBlock = (options: {
  ref?: string;
  version?: string;
  state?: string;
  title?: string;
  description?: string;
  dependencies?: readonly string[];
  references?: readonly string[];
  acceptance?: readonly string[];
} = {}): string => {
  const lines = [
    "## Task",
    `task-ref: ${options.ref ?? "T-101"}`,
    `version: ${options.version ?? "1"}`,
    `state: ${options.state ?? "READY"}`,
    `title: ${options.title ?? "Collector script cleanup"}`,
    "",
    "### Description",
    options.description ?? "Free-form description text.",
    "",
    "### Dependencies",
    ...(options.dependencies ?? ["- HARD: T-100"]),
    "",
    "### References",
    ...(options.references ?? ["- docs/DESIGN.md#collector"]),
    "",
    "### Acceptance",
    ...(options.acceptance ?? ["- Existing output remains byte-identical.", "- No new warnings."]),
    "",
  ];
  return lines.join("\n");
};

/** A reader backed by an in-memory document map; unknown paths throw like a missing file. */
export const readerFor = (documents: Readonly<Record<string, string>>): DocumentReader => (path) => {
  const text = documents[path];
  if (text === undefined) throw new Error(`no such document: ${path}`);
  return text;
};

export const singleDocumentConfig = (): { paths: string[]; parser: string } => ({
  paths: ["plan.md"],
  parser: "markdown-sections-v1",
});

export const singleDocumentReader = (): DocumentReader => readerFor({ "plan.md": taskBlock() });
