/**
 * Measured provider seams for the CLI agent RuntimeAdapter (#73 Claude Code, #49 AGY/Gemini,
 * #50 Grok). Each entry records exactly what was inspected on the pilot host and maps the
 * provider's own result vocabulary onto Platform facts — availability-honest throughout: an
 * identity or cost the backend does not report is `null` here and `UNKNOWN` upstream, never
 * copied from the request.
 *
 * Measured seams (2026-09-02, pilot host):
 *
 *   claude  2.1.221   `claude -p --output-format json --json-schema <s> --model <m>
 *                      [--effort low|medium|high|xhigh|max] [--resume <session_id>]`
 *                     stdin prompt; JSON: { subtype, is_error, result, session_id, usage,
 *                     modelUsage: { <model-id>: { canonicalModel, provider, ... } },
 *                     total_cost_usd } → actual model/provider REPORTED, cost REPORTED.
 *   agy     1.1.22    `agy --print <prompt> --output-format json --json-schema <s> --model <m>
 *                      [--effort low|medium|high] [--conversation <id>]`
 *                     JSON: { conversation_id, status: "SUCCESS", response, usage }
 *                     → actual model/provider NOT reported (UNKNOWN), cost NOT reported.
 *                     Gemini models are present in the measured catalogue (`agy models`).
 *   grok    1.0.13    `grok -p <prompt> --output-format json --json-schema <s> --model <m>
 *                      [--reasoning-effort <e>] [--resume <sessionId>]`
 *                     JSON: { text, stopReason, sessionId, usage, modelUsage: { <model-id> },
 *                      total_cost_usd } → actual model REPORTED, provider NOT, cost REPORTED.
 */

import type { CanonicalObject } from "../../core/schemas/canonical-json.ts";
import type {
  CliAgentCommandObservation,
  CliAgentProfileBinding,
  CliAgentProvider,
  ParsedCliAgentTurn,
} from "./types.ts";

export interface CliAgentProviderSeam {
  readonly provider_id: CliAgentProvider;
  /** Measured effort vocabulary; `null` means the seam accepts a pass-through non-empty token. */
  readonly effort_vocabulary: readonly string[] | null;
  /** Whether the backend reports the actually executed model identity. */
  readonly reports_actual_model: boolean;
  readonly reports_cost: boolean;
  readonly version_args: readonly string[];
  argv(input: {
    readonly binding: CliAgentProfileBinding;
    readonly prompt: string;
    /** The schema as inline JSON — measured accepted form for claude/grok. */
    readonly schema_json: string;
    /** The schema as a host-owned file — measured accepted form for agy. */
    readonly schema_path: string;
    readonly resume_session_ref: string | undefined;
  }): { readonly args: readonly string[]; readonly stdin?: string };
  parse(observation: CliAgentCommandObservation): ParsedCliAgentTurn;
}

/**
 * I-TD1 — backend names live only inside this adapter directory. Tests and Core reference the
 * providers through these exported constants instead of writing the vocabulary themselves.
 */
export const CLAUDE_CODE_PROVIDER: CliAgentProvider = "claude-code";
export const SECOND_AGENT_PROVIDER: CliAgentProvider = "agy";
export const GROK_PROVIDER: CliAgentProvider = "grok";

export const PROVIDER_SEAMS: Readonly<Record<CliAgentProvider, CliAgentProviderSeam>> = {
  "claude-code": {
    provider_id: "claude-code",
    effort_vocabulary: ["low", "medium", "high", "xhigh", "max"],
    reports_actual_model: true,
    reports_cost: true,
    version_args: ["--version"],
    argv({ binding, prompt, schema_json, resume_session_ref }) {
      return {
        args: [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          schema_json,
          "--model",
          binding.model,
          ...(binding.effort === undefined ? [] : ["--effort", binding.effort]),
          ...(resume_session_ref === undefined ? [] : ["--resume", resume_session_ref]),
        ],
        stdin: prompt,
      };
    },
    parse(observation) {
      return parseEnvelope(observation, (body) => ({
        session_ref: stringOrNull(body["session_id"]),
        completed: body["is_error"] === false && body["subtype"] === "success",
        reason: stringOrNull(body["terminal_reason"]) ?? stringOrNull(body["subtype"]) ?? "no subtype",
        final_text: stringOrNull(body["result"]),
        usage: numericRecord(body["usage"]),
        ...modelUsageIdentity(body["modelUsage"]),
        cost_usd: numberOrNull(body["total_cost_usd"]),
      }));
    },
  },
  agy: {
    provider_id: "agy",
    effort_vocabulary: ["low", "medium", "high"],
    reports_actual_model: false,
    reports_cost: false,
    version_args: ["--version"],
    argv({ binding, prompt, schema_path, resume_session_ref }) {
      return {
        args: [
          "--print",
          prompt,
          "--output-format",
          "json",
          "--json-schema",
          schema_path,
          "--model",
          binding.model,
          ...(binding.effort === undefined ? [] : ["--effort", binding.effort]),
          ...(resume_session_ref === undefined ? [] : ["--conversation", resume_session_ref]),
        ],
      };
    },
    parse(observation) {
      return parseEnvelope(observation, (body) => ({
        session_ref: stringOrNull(body["conversation_id"]),
        completed: body["status"] === "SUCCESS",
        reason: stringOrNull(body["status"]) ?? "no status",
        final_text: stringOrNull(body["response"]),
        usage: numericRecord(body["usage"]),
        actual_model: null,
        actual_provider: null,
        cost_usd: null,
      }));
    },
  },
  grok: {
    provider_id: "grok",
    // Only the flag's existence was measured, not a value catalogue: the seam passes a non-empty
    // token through and the CLI's own rejection fails the turn closed.
    effort_vocabulary: null,
    reports_actual_model: true,
    reports_cost: true,
    version_args: ["--version"],
    argv({ binding, prompt, schema_json, resume_session_ref }) {
      return {
        args: [
          "-p",
          prompt,
          "--output-format",
          "json",
          "--json-schema",
          schema_json,
          "--model",
          binding.model,
          ...(binding.effort === undefined ? [] : ["--reasoning-effort", binding.effort]),
          ...(resume_session_ref === undefined ? [] : ["--resume", resume_session_ref]),
        ],
      };
    },
    parse(observation) {
      return parseEnvelope(observation, (body) => ({
        session_ref: stringOrNull(body["sessionId"]),
        completed: body["stopReason"] === "end_turn",
        reason: stringOrNull(body["stopReason"]) ?? "no stopReason",
        final_text: stringOrNull(body["text"]),
        usage: numericRecord(body["usage"]),
        ...modelUsageIdentity(body["modelUsage"], /* providerReported */ false),
        cost_usd: numberOrNull(body["total_cost_usd"]),
      }));
    },
  },
};

// --- shared parsing helpers -----------------------------------------------------------------------

interface EnvelopeFacts {
  readonly session_ref: string | null;
  readonly completed: boolean;
  readonly reason: string;
  readonly final_text: string | null;
  readonly usage: Readonly<Record<string, number>> | null;
  readonly actual_model: string | null;
  readonly actual_provider: string | null;
  readonly cost_usd: number | null;
}

function parseEnvelope(
  observation: CliAgentCommandObservation,
  read: (body: CanonicalObject) => EnvelopeFacts,
): ParsedCliAgentTurn {
  let body: CanonicalObject;
  try {
    const value = JSON.parse(observation.stdout) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("stdout is not a JSON object");
    }
    body = value as CanonicalObject;
  } catch (error) {
    return {
      session_ref: null,
      terminal: "MISSING",
      terminal_reason: `invalid print-mode JSON: ${error instanceof Error ? error.message : String(error)}`,
      final_text: null,
      usage: null,
      actual_model: null,
      actual_provider: null,
      cost_usd: null,
      parse_error: error instanceof Error ? error.message : String(error),
    };
  }
  const facts = read(body);
  return {
    session_ref: facts.session_ref,
    terminal: facts.completed ? "COMPLETED" : "FAILED",
    terminal_reason: facts.reason,
    final_text: facts.final_text,
    usage: facts.usage,
    actual_model: facts.actual_model,
    actual_provider: facts.actual_provider,
    cost_usd: facts.cost_usd,
    parse_error: null,
  };
}

/**
 * The `modelUsage` map's key set is the backend's own record of which models actually ran. It is
 * identity evidence only when it is unambiguous: exactly one entry. Zero or several is honest
 * UNKNOWN, never a guess.
 */
function modelUsageIdentity(
  raw: unknown,
  providerReported = true,
): { readonly actual_model: string | null; readonly actual_provider: string | null } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { actual_model: null, actual_provider: null };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length !== 1) return { actual_model: null, actual_provider: null };
  const [model, detail] = entries[0]!;
  const record =
    typeof detail === "object" && detail !== null && !Array.isArray(detail)
      ? (detail as Record<string, unknown>)
      : {};
  return {
    actual_model: stringOrNull(record["canonicalModel"]) ?? model,
    actual_provider: providerReported ? stringOrNull(record["provider"]) : null,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numericRecord(value: unknown): Readonly<Record<string, number>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const quantities: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) quantities[key] = raw;
  }
  return Object.keys(quantities).length === 0 ? null : quantities;
}
