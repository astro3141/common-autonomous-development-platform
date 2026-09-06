/**
 * Proposal-only commodity planner (#61 roadmap; Spec v0.4 §8.2).
 *
 * A commodity read-only surface (reference: Claude Code in plan mode over a read-only checkout)
 * decomposes one whole work intent into bounded candidate work items. Its output is a PROPOSAL,
 * sealed as `WORK_PROPOSAL` K2 evidence with exact provenance — never authority:
 *
 *  - starting any proposed item goes through the ordinary governed `WORK_START` admission;
 *  - the planner holds no durable state and owns no workflow — it is not a second state owner;
 *  - a proposal that does not parse into the closed `cadp.work-proposal.v1` schema is a planner
 *    FAILURE, never repaired, defaulted or partially accepted (fail closed);
 *  - proposed bounds obey exactly the #127 well-formedness rules — a proposal cannot smuggle a
 *    malformed bound past the gate it would later face.
 */

import { malformedWorkBounds } from "./workBounds.ts";

export interface WorkProposalItemV1 {
  readonly work_item: string;
  readonly max_steps: number;
  readonly max_effects: number;
  readonly rationale: string;
}

export interface WorkProposalV1 {
  readonly schema: "cadp.work-proposal.v1";
  readonly items: readonly WorkProposalItemV1[];
  readonly notes?: string;
}

export const MAX_PROPOSAL_ITEMS = 20;
export const MAX_WORK_ITEM_CHARS = 2000;

export function buildPlanPrompt(intent: string, repo_full_name: string, base_sha: string): string {
  return [
    `You are planning bounded autonomous work over the repository ${repo_full_name} at commit ${base_sha},`,
    "which is checked out read-only at your working directory. Decompose the following whole intent into",
    "independent, bounded work items an autonomous coding worker can execute one at a time.",
    "",
    `INTENT: ${intent}`,
    "",
    "Reply with EXACTLY one JSON object and nothing else, matching:",
    '{ "schema": "cadp.work-proposal.v1",',
    '  "items": [ { "work_item": "<precise self-contained instruction>",',
    '               "max_steps": <positive integer>, "max_effects": <positive integer>,',
    '               "rationale": "<why this is one bounded item>" } ],',
    '  "notes": "<optional overall notes>" }',
    "",
    `At most ${MAX_PROPOSAL_ITEMS} items. Every bound must be a positive integer. The executing`,
    "development vertical spends one governed effect each for git push, PR creation and PR merge,",
    "plus one more push per revision round — set max_effects to at least 4 (hard minimum 3), and",
    "max_steps to at least 6 (implement/push/verify/review per round, plus PR and merge steps).",
    "Do not include any text outside the JSON object.",
  ].join("\n");
}

export class ProposalParseError extends Error {
  constructor(detail: string) {
    super(`planner output is not a valid cadp.work-proposal.v1: ${detail}`);
    this.name = "ProposalParseError";
  }
}

/**
 * Parse and validate a surface's stdout into a typed proposal. Closed schema, fail closed:
 * unknown keys, malformed bounds, empty/oversized item lists and non-JSON output all throw.
 */
export function parseWorkProposal(stdout: string): WorkProposalV1 {
  const text = stdout.trim();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Tolerate surrounding prose ONLY by locating one outermost JSON object — never by repair.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new ProposalParseError("no JSON object in output");
    try {
      raw = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new ProposalParseError("output contains no parseable JSON object");
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ProposalParseError("not an object");
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["schema", "items", "notes"].includes(key)) throw new ProposalParseError(`unknown key '${key}'`);
  }
  if (record["schema"] !== "cadp.work-proposal.v1") throw new ProposalParseError(`schema is ${String(record["schema"])}`);
  if (record["notes"] !== undefined && typeof record["notes"] !== "string") throw new ProposalParseError("notes is not a string");
  const items = record["items"];
  if (!Array.isArray(items) || items.length < 1) throw new ProposalParseError("items must be a non-empty array");
  if (items.length > MAX_PROPOSAL_ITEMS) throw new ProposalParseError(`${items.length} items exceeds ${MAX_PROPOSAL_ITEMS}`);

  const parsed: WorkProposalItemV1[] = items.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new ProposalParseError(`item ${index} is not an object`);
    const it = item as Record<string, unknown>;
    for (const key of Object.keys(it)) {
      if (!["work_item", "max_steps", "max_effects", "rationale"].includes(key)) {
        throw new ProposalParseError(`item ${index} has unknown key '${key}'`);
      }
    }
    const work_item = it["work_item"];
    if (typeof work_item !== "string" || work_item.trim().length === 0 || work_item.length > MAX_WORK_ITEM_CHARS) {
      throw new ProposalParseError(`item ${index} work_item is empty, missing or over ${MAX_WORK_ITEM_CHARS} chars`);
    }
    const rationale = it["rationale"];
    if (typeof rationale !== "string") throw new ProposalParseError(`item ${index} rationale is not a string`);
    const bounds = { max_steps: it["max_steps"] as number, max_effects: it["max_effects"] as number };
    const malformed = malformedWorkBounds(bounds);
    if (malformed !== undefined) throw new ProposalParseError(`item ${index} bounds malformed: ${malformed}`);
    return { work_item, max_steps: bounds.max_steps, max_effects: bounds.max_effects, rationale };
  });

  return {
    schema: "cadp.work-proposal.v1",
    items: parsed,
    ...(record["notes"] !== undefined ? { notes: record["notes"] as string } : {}),
  };
}
