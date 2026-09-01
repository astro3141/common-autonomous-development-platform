/**
 * The GitHub Issues task representation contract (TD §8.1a over a GitHub backend).
 *
 * One issue represents one task. The authoritative `TaskDefinitionBodyV1` travels as canonical
 * JSON inside an HTML-comment marker, base64-encoded so arbitrary Supervisor-authored text can
 * never break the comment framing; the human-readable markdown above it is a *rendering*, never
 * parsed back. That is what makes the D24 round-trip exact: the TaskSource re-reads the identical
 * canonical bytes the materializer published, and GitHub's markdown pipeline cannot perturb them.
 *
 * A plain hand-written issue with no marker still normalizes — title/body become the §8.1a body
 * with empty arrays — so the ordinary #52 intake path needs no special authoring format.
 *
 * The materialisation marker exists solely for D24 idempotency/reconciliation correlation
 * (op_key ↔ external representation). It is provenance, not child identity: binding authority
 * stays the Platform's durable rows (§18.1g), and nothing here deduplicates by title/body
 * similarity.
 */

import { canonicalize, type CanonicalObject } from "../../core/schemas/canonical-json.ts";
import {
  normalizeTaskDefinitionBody,
} from "../../core/tasksource/task-definition.ts";
import type { TaskDefinitionBodyV1 } from "../../core/tasksource/types.ts";

const DEFINITION_MARKER = "adp:task-definition:v1";
const MATERIALIZATION_MARKER = "adp:materialization:v1";

export interface MaterializationMarkerV1 {
  readonly op_key: string;
  readonly materialization_id: string;
  readonly materialization_hash: string;
}

/** Renders the canonical issue body: human-readable markdown + the exact machine block(s). */
export function renderIssueBody(
  body: TaskDefinitionBodyV1,
  materialization?: MaterializationMarkerV1,
): string {
  const sections: string[] = [body.description];
  if (body.references.length > 0) {
    sections.push("## References", body.references.map((ref) => `- ${ref}`).join("\n"));
  }
  if (body.acceptance_notes.length > 0) {
    sections.push("## Acceptance", body.acceptance_notes.map((note) => `- ${note}`).join("\n"));
  }
  sections.push(marker(DEFINITION_MARKER, body as unknown as CanonicalObject));
  if (materialization !== undefined) {
    sections.push(marker(MATERIALIZATION_MARKER, materialization as unknown as CanonicalObject));
  }
  return sections.join("\n\n");
}

/**
 * The exact published body, when one is present. A marker that exists but cannot be decoded to a
 * valid §8.1a body throws — a mangled representation must fail closed, never degrade to the
 * derived-body path and admit different semantics.
 */
export function parseDefinitionMarker(issueBody: string): TaskDefinitionBodyV1 | null {
  const payload = readMarker(issueBody, DEFINITION_MARKER);
  if (payload === null) return null;
  return normalizeTaskDefinitionBody(payload, "/github-issue/definition-marker") as TaskDefinitionBodyV1;
}

/**
 * The three-state D24 correlation-marker observation (review finding: BLOCKING_EXTERNAL_EFFECT).
 *
 * `ABSENT` and `MALFORMED` are different external-effect facts and must never collapse: a body
 * with no materialisation frame at all is ordinary non-correlation, while a body that *carries*
 * the `adp:materialization:v1` frame but cannot be decoded to a trustworthy
 * {op_key, materialization_id, materialization_hash} is **inconclusive external-effect
 * evidence** — such an issue may be exactly the child a D24 op created. Callers proving absence
 * must therefore treat `MALFORMED` as fail-closed (UNKNOWN), and no fuzzy recovery of op
 * identity from titles, bodies or damaged payloads is ever attempted.
 */
export type MaterializationMarkerObservation =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "VALID"; readonly marker: MaterializationMarkerV1 }
  | { readonly kind: "MALFORMED"; readonly detail: string };

export function inspectMaterializationMarker(issueBody: string): MaterializationMarkerObservation {
  // Frame detection is deliberately broader than the strict parse: any occurrence of the marker
  // name means a correlation marker was written here, however damaged its framing now is.
  if (!issueBody.includes(MATERIALIZATION_MARKER)) return { kind: "ABSENT" };
  let payload: unknown;
  try {
    payload = readMarker(issueBody, MATERIALIZATION_MARKER);
  } catch (error) {
    return {
      kind: "MALFORMED",
      detail: `marker payload cannot be decoded: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (payload === null) {
    return { kind: "MALFORMED", detail: "marker frame is present but not readable" };
  }
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return { kind: "MALFORMED", detail: "marker payload is not an object" };
  }
  const record = payload as Record<string, unknown>;
  const op_key = record["op_key"];
  const materialization_id = record["materialization_id"];
  const materialization_hash = record["materialization_hash"];
  if (
    typeof op_key !== "string" ||
    op_key.length === 0 ||
    typeof materialization_id !== "string" ||
    materialization_id.length === 0 ||
    typeof materialization_hash !== "string" ||
    materialization_hash.length === 0
  ) {
    return { kind: "MALFORMED", detail: "marker payload misses a required identity field" };
  }
  return { kind: "VALID", marker: { op_key, materialization_id, materialization_hash } };
}

/** The valid D24 correlation marker, or `null`. Never used to prove absence — see the tri-state. */
export function parseMaterializationMarker(issueBody: string): MaterializationMarkerV1 | null {
  const observed = inspectMaterializationMarker(issueBody);
  return observed.kind === "VALID" ? observed.marker : null;
}

/** §8.1a derivation for a plain hand-written issue: title/body verbatim, empty arrays. */
export function deriveBodyFromIssue(title: string, issueBody: string): TaskDefinitionBodyV1 {
  return {
    title,
    description: issueBody,
    references: [],
    acceptance_notes: [],
  };
}

function marker(name: string, payload: CanonicalObject): string {
  const encoded = Buffer.from(canonicalize(payload), "utf8").toString("base64");
  return `<!-- ${name} b64:${encoded} -->`;
}

function readMarker(issueBody: string, name: string): unknown {
  const pattern = new RegExp(`<!-- ${escapeRegExp(name)} b64:([A-Za-z0-9+/=]+) -->`, "u");
  const match = pattern.exec(issueBody);
  if (match === null) return null;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  return JSON.parse(decoded) as unknown;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
