/**
 * PendingHumanDecision v1 validation, dedup identity and record hash (TD §17.1 – §17.1f).
 *
 * The record hash is the hash of the *final* `platform/pending-decision` envelope, so it binds
 * everything the record carries — including the `gate_proposal` copy. There is still no
 * standalone Proposal artifact: the copy exists only as a member of this envelope.
 */

import { validateProposal } from "../decision/proposal.ts";
import type { ProposalV1 } from "../decision/types.ts";
import { canonicalize, type CanonicalObject, type CanonicalValue } from "../schemas/canonical-json.ts";
import { isDigest } from "../schemas/digest.ts";
import {
  canonicalizeEnvelope,
  hashEnvelope,
  makeEnvelope,
  type SchemaEnvelope,
} from "../schemas/envelope.ts";
import { isUlid } from "../schemas/identifiers.ts";
import { decisionInvalid, HumanDecisionError } from "./errors.ts";
import {
  BLOCKING_SCOPES,
  PENDING_DECISION_CATEGORIES,
  PENDING_DECISION_CONTEXT_SCHEMA,
  PENDING_DECISION_FIELDS,
  PENDING_DECISION_SCHEMA,
  PENDING_DECISION_STATUSES,
  RESOLUTION_FIELDS,
  SCOPE_SUBJECTS,
  TERMINAL_PENDING_STATUSES,
  type BlockingScope,
  type PendingDecisionCategory,
  type PendingDecisionResolution,
  type PendingDecisionStatus,
  type PendingDecisionSubject,
  type PendingDecisionV1,
} from "./types.ts";

// --- identity -------------------------------------------------------------------------

/** TD §17.1c — the subject-generic dedup component. Each form has a distinct leading token. */
export function subjectKey(subject: PendingDecisionSubject): string {
  switch (subject.kind) {
    case "TASK":
      return subject.task_key;
    case "BATCH":
      return subject.batch_id;
    case "PROJECT":
      return `project:${subject.project_id}`;
  }
}

/** `platform/pending-decision-context` v1 envelope over exactly three normalized fields. */
export function dedupContextEnvelope(
  subject: PendingDecisionSubject,
  category: PendingDecisionCategory,
  createdFrom: string,
): SchemaEnvelope<CanonicalObject> {
  return makeEnvelope(PENDING_DECISION_CONTEXT_SCHEMA, 1, {
    subject: subjectObject(subject),
    category,
    created_from: createdFrom,
  } as unknown as CanonicalObject);
}

export function computeDedupKey(
  subject: PendingDecisionSubject,
  category: PendingDecisionCategory,
  createdFrom: string,
): string {
  const contextHash = hashEnvelope(dedupContextEnvelope(subject, category, createdFrom));
  return `pd:${subjectKey(subject)}:${category}:${contextHash}`;
}

// --- envelope / hash ---------------------------------------------------------------------

export function pendingDecisionEnvelope(body: PendingDecisionV1): SchemaEnvelope<CanonicalObject> {
  return makeEnvelope(PENDING_DECISION_SCHEMA, 1, decisionObject(body));
}

/** TD §17.1f — recorded only once the record is terminal. */
export function hashPendingDecision(body: PendingDecisionV1): string {
  return hashEnvelope(pendingDecisionEnvelope(body));
}

/**
 * Canonical text of the whole envelope — what a durable row stores, so the record can be
 * re-hashed on load. Two records differ here exactly when their bodies differ.
 */
export function canonicalPendingDecision(body: PendingDecisionV1): string {
  return canonicalizeEnvelope(pendingDecisionEnvelope(body));
}

// --- validation ----------------------------------------------------------------------------

/** Validates the exact thirteen-field body. Unknown fields are rejected, nothing is coerced. */
export function normalizePendingDecision(input: unknown): PendingDecisionV1 {
  const raw = asObject(input, "");
  exactKeys(raw, PENDING_DECISION_FIELDS as readonly string[], "");

  const decision_id = raw["decision_id"];
  if (typeof decision_id !== "string" || !isUlid(decision_id)) {
    throw decisionInvalid("/decision_id", "expected a ULID");
  }

  const subject = normalizeSubject(raw["subject"]);
  const status = oneOf(raw["status"], PENDING_DECISION_STATUSES, "/status") as PendingDecisionStatus;
  const category = oneOf(
    raw["category"],
    PENDING_DECISION_CATEGORIES,
    "/category",
  ) as PendingDecisionCategory;
  const blocking_scope = oneOf(
    raw["blocking_scope"],
    BLOCKING_SCOPES,
    "/blocking_scope",
  ) as BlockingScope;

  if (!SCOPE_SUBJECTS[blocking_scope].includes(subject.kind)) {
    throw decisionInvalid(
      "/blocking_scope",
      `${blocking_scope} may not be declared on a ${subject.kind} subject`,
    );
  }

  const created_from = nonEmptyString(raw["created_from"], "/created_from");
  const dedup_key = nonEmptyString(raw["dedup_key"], "/dedup_key");
  const expected = computeDedupKey(subject, category, created_from);
  if (dedup_key !== expected) {
    throw decisionInvalid("/dedup_key", "does not match the subject/category/created_from context");
  }

  const gate_proposal = normalizeGateProposalField(raw["gate_proposal"], category);
  const resolution = normalizeResolutionField(raw["resolution"], status, raw["options"]);

  return {
    decision_id,
    subject,
    status,
    category,
    question: nonEmptyString(raw["question"], "/question"),
    options: normalizeOptions(raw["options"]),
    recommendation: nullableString(raw["recommendation"], "/recommendation"),
    blocking_scope,
    evidence_refs: stringList(raw["evidence_refs"], "/evidence_refs"),
    dedup_key,
    created_from,
    gate_proposal,
    resolution,
  };
}

/**
 * Re-validates a stored `gate_proposal`. The normalized copy carries the derived `variant`, which
 * is not an input field, so it is stripped before running the Batch 7 parser and then required to
 * match — the copy is provably a Proposal the ordinary validator would accept.
 */
export function normalizeGateProposal(value: unknown): ProposalV1 {
  const object = asObject(value, "/gate_proposal");
  const input: Record<string, unknown> = { ...object };
  delete input["variant"];

  let proposal: ProposalV1;
  try {
    proposal = validateProposal(input);
  } catch (error) {
    throw decisionInvalid(
      "/gate_proposal",
      `not a valid Proposal: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Object.hasOwn(object, "variant") && object["variant"] !== proposal.variant) {
    throw decisionInvalid("/gate_proposal/variant", "does not match the decision's variant");
  }
  return proposal;
}

/** Structural equality of two normalized Proposals (TD §17.3 step 5). */
export function sameProposal(left: ProposalV1, right: ProposalV1): boolean {
  return (
    canonicalize(left as unknown as CanonicalValue) ===
    canonicalize(right as unknown as CanonicalValue)
  );
}

// --- terminal transitions -------------------------------------------------------------------

export interface TerminalDecision {
  readonly body: PendingDecisionV1;
  readonly record_hash: string;
}

/**
 * `OPEN → RESOLVED`. The resolution is the human's answer; it is not an execution authorization
 * (TD §17.3), and terminal records never change again.
 */
export function resolvePendingDecision(
  body: PendingDecisionV1,
  resolution: PendingDecisionResolution,
): TerminalDecision {
  return closeDecision(body, "RESOLVED", resolution);
}

/** `OPEN → CANCELLED` / `OPEN → STALE`. Neither carries a human answer. */
export function closePendingDecision(
  body: PendingDecisionV1,
  status: "CANCELLED" | "STALE",
): TerminalDecision {
  return closeDecision(body, status, null);
}

function closeDecision(
  body: PendingDecisionV1,
  status: PendingDecisionStatus,
  resolution: PendingDecisionResolution | null,
): TerminalDecision {
  if (body.status !== "OPEN") {
    throw new HumanDecisionError(
      "DECISION_STATUS_CONFLICT",
      "/status",
      `${body.status} is terminal; ${body.status} → ${status} is not a defined transition`,
    );
  }
  const next = normalizePendingDecision({ ...body, status, resolution } as unknown);
  return { body: next, record_hash: hashPendingDecision(next) };
}

/** Records the transition this resolution caused, once it has actually committed (§17.1e). */
export function withAppliedTransition(
  body: PendingDecisionV1,
  seq: number,
): TerminalDecision {
  if (body.status !== "RESOLVED" || body.resolution === null) {
    throw new HumanDecisionError(
      "DECISION_STATUS_CONFLICT",
      "/resolution",
      "only a RESOLVED decision can reference an applied transition",
    );
  }
  const next = normalizePendingDecision({
    ...body,
    resolution: { ...body.resolution, applied_transition_ref: `transition:${seq}` },
  } as unknown);
  return { body: next, record_hash: hashPendingDecision(next) };
}

// --- local predicates -------------------------------------------------------------------------

function normalizeSubject(value: unknown): PendingDecisionSubject {
  const raw = asObject(value, "/subject");
  const kind = raw["kind"];
  switch (kind) {
    case "TASK":
      exactKeys(raw, ["kind", "task_key"], "/subject");
      return { kind: "TASK", task_key: nonEmptyString(raw["task_key"], "/subject/task_key") };
    case "BATCH":
      exactKeys(raw, ["kind", "batch_id"], "/subject");
      return { kind: "BATCH", batch_id: nonEmptyString(raw["batch_id"], "/subject/batch_id") };
    case "PROJECT": {
      exactKeys(raw, ["kind", "project_id"], "/subject");
      const project_id = nonEmptyString(raw["project_id"], "/subject/project_id");
      // §6.1: project_id owns the first structural separator, so it may not contain ':'.
      if (project_id.includes(":")) {
        throw decisionInvalid("/subject/project_id", "must not contain ':'");
      }
      return { kind: "PROJECT", project_id };
    }
    default:
      throw decisionInvalid("/subject/kind", "expected TASK, BATCH or PROJECT");
  }
}

function normalizeOptions(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw decisionInvalid("/options", "expected an array");
  if (value.length === 0) throw decisionInvalid("/options", "must not be empty");
  const options = value.map((item, index) => nonEmptyString(item, `/options/${index}`));
  if (new Set(options).size !== options.length) {
    throw decisionInvalid("/options", "duplicate option");
  }
  return options;
}

function normalizeGateProposalField(
  value: unknown,
  category: PendingDecisionCategory,
): ProposalV1 | null {
  if (category === "HUMAN_GATE_APPROVAL") {
    if (value === null) {
      throw decisionInvalid("/gate_proposal", "HUMAN_GATE_APPROVAL requires the approved Proposal");
    }
    return normalizeGateProposal(value);
  }
  if (value !== null) {
    throw decisionInvalid("/gate_proposal", `${category} must not carry a Proposal copy`);
  }
  return null;
}

function normalizeResolutionField(
  value: unknown,
  status: PendingDecisionStatus,
  options: unknown,
): PendingDecisionResolution | null {
  if (status !== "RESOLVED") {
    if (value !== null) {
      throw decisionInvalid("/resolution", `${status} must not carry a resolution`);
    }
    return null;
  }
  if (value === null) throw decisionInvalid("/resolution", "RESOLVED requires a resolution");

  const raw = asObject(value, "/resolution");
  exactKeys(raw, RESOLUTION_FIELDS, "/resolution");

  const kind = raw["kind"];
  if (kind !== "OPTION" && kind !== "FREE_FORM") {
    throw decisionInvalid("/resolution/kind", "expected OPTION or FREE_FORM");
  }

  let chosen_option: string | null = null;
  let free_form: string | null = null;
  if (kind === "OPTION") {
    chosen_option = nonEmptyString(raw["chosen_option"], "/resolution/chosen_option");
    if (raw["free_form"] !== null) {
      throw decisionInvalid("/resolution/free_form", "must be null for an OPTION resolution");
    }
    const declared = normalizeOptions(options);
    if (!declared.includes(chosen_option)) {
      throw decisionInvalid("/resolution/chosen_option", "is not one of the offered options");
    }
  } else {
    free_form = nonEmptyString(raw["free_form"], "/resolution/free_form");
    if (raw["chosen_option"] !== null) {
      throw decisionInvalid("/resolution/chosen_option", "must be null for a FREE_FORM resolution");
    }
  }

  return {
    kind,
    chosen_option,
    free_form,
    resolved_by: nonEmptyString(raw["resolved_by"], "/resolution/resolved_by"),
    resolved_at: nonEmptyString(raw["resolved_at"], "/resolution/resolved_at"),
    approval_binding: normalizeApprovalBinding(raw["approval_binding"]),
    applied_transition_ref: normalizeTransitionRef(raw["applied_transition_ref"]),
  };
}

function normalizeApprovalBinding(
  value: unknown,
): PendingDecisionResolution["approval_binding"] {
  if (value === null) return null;
  const raw = asObject(value, "/resolution/approval_binding");
  exactKeys(raw, ["field_path", "approved_value"], "/resolution/approval_binding");
  const approved_value = raw["approved_value"];
  try {
    canonicalize(approved_value as CanonicalValue);
  } catch (error) {
    throw decisionInvalid(
      "/resolution/approval_binding/approved_value",
      `not expressible in the §6 data model: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    field_path: nonEmptyString(raw["field_path"], "/resolution/approval_binding/field_path"),
    approved_value: approved_value as CanonicalValue,
  };
}

/** Only a transition-log reference, never a human choice word (§17.1e). */
function normalizeTransitionRef(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^transition:[1-9][0-9]*$/.test(value)) {
    throw decisionInvalid(
      "/resolution/applied_transition_ref",
      "expected transition:<decision_log.seq>",
    );
  }
  return value;
}

function subjectObject(subject: PendingDecisionSubject): CanonicalObject {
  return subject as unknown as CanonicalObject;
}

function decisionObject(body: PendingDecisionV1): CanonicalObject {
  const object: Record<string, unknown> = {};
  for (const field of PENDING_DECISION_FIELDS) object[field] = body[field];
  return object as CanonicalObject;
}

export function isTerminalStatus(status: PendingDecisionStatus): boolean {
  return TERMINAL_PENDING_STATUSES.includes(status);
}

export function isRecordHash(value: string): boolean {
  return isDigest(value);
}

function asObject(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw decisionInvalid(location, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw decisionInvalid(location, "expected a plain object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  object: Record<string, unknown>,
  fields: readonly string[],
  location: string,
): void {
  for (const field of fields) {
    if (!Object.hasOwn(object, field)) {
      throw decisionInvalid(location, `missing required field "${field}"`);
    }
  }
  for (const key of Object.keys(object)) {
    if (!fields.includes(key)) throw decisionInvalid(location, `unknown field "${key}"`);
  }
}

function oneOf(value: unknown, allowed: readonly string[], location: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw decisionInvalid(location, `expected one of ${allowed.join(", ")}`);
  }
  return value;
}

function nonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string") throw decisionInvalid(location, "expected a string");
  if (value.length === 0) throw decisionInvalid(location, "must not be empty");
  return value;
}

function nullableString(value: unknown, location: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, location);
}

function stringList(value: unknown, location: string): readonly string[] {
  if (!Array.isArray(value)) throw decisionInvalid(location, "expected an array");
  return value.map((item, index) => nonEmptyString(item, `${location}/${index}`));
}
