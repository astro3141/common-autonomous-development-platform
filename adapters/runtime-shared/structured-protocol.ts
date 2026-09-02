/**
 * The Platform structured-response protocol every CLI Runtime backend speaks (#54/#73/#49/#50).
 *
 * One vocabulary, many backends: the Supervisor schema mirrors Core's own Proposal variants —
 * including the §9.1 F decomposition materialisation wrapper — so no backend can re-narrow what
 * Core already accepts, and the parentless START_SUBFLOW stays expressible so Core V1 remains the
 * rejecting authority. Auditor and generic roles keep their sealed shapes. Nothing here validates:
 * these are transport schemas; Core's validators stay the only policy authority.
 */

import type { CanonicalObject } from "../../core/schemas/canonical-json.ts";

export const SUPERVISOR_PROPOSAL_PROTOCOL = "platform-supervisor-proposal-v1";
export const AUDITOR_VERDICT_PROTOCOL = "platform-auditor-verdict-v1";

export function initializationSchema(): CanonicalObject {
  return {
    type: "object",
    properties: { ready: { type: "boolean" } },
    required: ["ready"],
    additionalProperties: false,
  } as unknown as CanonicalObject;
}

export function roleSchema(role: string): CanonicalObject {
  if (role === "AUDITOR") {
    return {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["AUDIT_PASS", "FIX_REQUIRED", "HUMAN_REQUIRED"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              severity: { type: "string" },
              description: { type: "string" },
              evidence_refs: { type: "array", items: { type: "string" } },
            },
            required: ["id", "severity", "description", "evidence_refs"],
            additionalProperties: false,
          },
        },
        required_fix: { type: "array", items: { type: "string" } },
        reviewed: {
          type: "object",
          properties: {
            candidate_commit: { type: "string" },
            task_contract_hash: { type: "string" },
            evidence_ids: { type: "array", items: { type: "string" } },
          },
          required: ["candidate_commit", "task_contract_hash", "evidence_ids"],
          additionalProperties: false,
        },
      },
      required: ["verdict", "findings", "required_fix", "reviewed"],
      additionalProperties: false,
    } as unknown as CanonicalObject;
  }
  const outcome = {
    declared_status: {
      type: "string",
      enum: ["DONE", "BLOCKED", "NEEDS_INPUT", "FAILED"],
    },
    summary: { type: "string" },
    refs: { type: "array", items: { type: "string" } },
  };
  if (role === "SUPERVISOR") {
    return {
      type: "object",
      properties: {
        proposal: supervisorProposalSchema(),
        ...outcome,
      },
      required: ["proposal", "declared_status", "summary", "refs"],
      additionalProperties: false,
    } as unknown as CanonicalObject;
  }
  return {
    type: "object",
    properties: outcome,
    required: ["declared_status", "summary", "refs"],
    additionalProperties: false,
  } as unknown as CanonicalObject;
}

export function supervisorProposalSchema(): CanonicalObject {
  const string = { type: "string" };
  const reason_refs = { type: "array", items: string };
  const expected = (fields: readonly string[]) => ({
    type: "object",
    properties: Object.fromEntries(fields.map((field) => [field, string])),
    required: fields,
    additionalProperties: false,
  });
  const proposal = (
    decisions: readonly string[],
    properties: Readonly<Record<string, unknown>>,
  ) => ({
    type: "object",
    properties: {
      proposal_id: string,
      decision: { type: "string", enum: decisions },
      ...properties,
      reason_refs,
    },
    required: ["proposal_id", "decision", ...Object.keys(properties), "reason_refs"],
    additionalProperties: false,
  });
  const taskFreshness = ["task_version", "task_definition_hash", "compiled_profile_hash"];
  const repositoryFreshness = [...taskFreshness, "base_head"];
  const selection = {
    task_ref: string,
    classification: string,
    pipeline_id: string,
    actor_profile: string,
    verification_profile: string,
    repository_scope_id: string,
  };
  return {
    anyOf: [
      proposal(["START_TASK"], {
        ...selection,
        expected: expected(repositoryFreshness),
      }),
      proposal(["START_SUBFLOW"], {
        ...selection,
        parent: {
          type: "object",
          properties: {
            task_key: string,
            attempt_key: string,
            task_contract_hash: string,
            attempt_state: string,
          },
          required: ["task_key", "attempt_key", "task_contract_hash", "attempt_state"],
          additionalProperties: false,
        },
        expected: expected(repositoryFreshness),
      }),
      // §9.1 F (Spec §17A / TD D24) — bounded child materialisation: the complete child body plus
      // an explicit *tagged* parent basis, and nothing else. No task_ref, pipeline, profile,
      // scope or base_head field exists here for a Harness to fill in (§8.1a); external identity
      // is assigned by the materialisation target's adapter, never by the model.
      proposal(["START_SUBFLOW"], {
        parent: {
          anyOf: [
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["DISCOVERED_TASK"] },
                task_key: string,
                task_ref: string,
                task_version: string,
                task_definition_hash: string,
              },
              required: ["kind", "task_key", "task_ref", "task_version", "task_definition_hash"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["ACTIVE_ATTEMPT"] },
                task_key: string,
                attempt_key: string,
                task_contract_hash: string,
                attempt_state: string,
              },
              required: ["kind", "task_key", "attempt_key", "task_contract_hash", "attempt_state"],
              additionalProperties: false,
            },
          ],
        },
        child: {
          type: "object",
          properties: {
            task_definition_body: {
              type: "object",
              properties: {
                title: string,
                description: string,
                references: { type: "array", items: string },
                acceptance_notes: { type: "array", items: string },
              },
              required: ["title", "description", "references", "acceptance_notes"],
              additionalProperties: false,
            },
          },
          required: ["task_definition_body"],
          additionalProperties: false,
        },
        expected: expected(["compiled_profile_hash"]),
      }),
      // Deliberately expressible but not a Core proposal variant: V1 rejects this parentless
      // START_SUBFLOW. Keeping it in the transport schema preserves Core as the policy authority.
      proposal(["START_SUBFLOW"], {
        ...selection,
        expected: expected(repositoryFreshness),
      }),
      proposal(["REQUEST_REWORK", "PROPOSE_MERGE"], {
        task_ref: string,
        expected: expected(repositoryFreshness),
      }),
      proposal(["HOLD_TASK", "DEFER_TASK", "RESUME_PARENT"], {
        task_ref: string,
        expected: expected(taskFreshness),
      }),
      proposal(["CLOSE_BATCH"], {
        expected: expected(["compiled_profile_hash"]),
      }),
    ],
  } as unknown as CanonicalObject;
}

