/**
 * ImprovementFindingV1 — evidence-derived semantic record (TD §5.13, D20/D21).
 *
 * A Finding is a classified diagnosis bound to authoritative evidence. It is **not** a Task or
 * Attempt lifecycle fact, not an Execution Policy, not a contract-change approval and not a
 * repository mutation authority: recording one changes no lifecycle state, and a projected item
 * re-enters execution only through the ordinary
 * `TaskSource → Supervisor Proposal → Decision Validation → Immutable Task Contract` path.
 *
 * Persistence is exactly what §5.13 allows: the content-addressed blob store plus an append-only
 * `decision_log(kind = "finding_recorded")` entry — no Finding table, no event bus, no second
 * authority DB. An immutable envelope is idempotent only for the same identity **and** the same
 * hash; a correction is a *new* record carrying `supersedes_finding_ref`.
 *
 * Every evidence reference must resolve against its authoritative owner before anything is
 * recorded — a Finding whose evidence the Platform cannot verify fails closed, and no
 * classification confidence number is ever invented.
 */

import { canonicalBytes, canonicalize, type CanonicalObject } from "../schemas/canonical-json.ts";
import { hashEnvelope, makeEnvelope, type SchemaEnvelope } from "../schemas/envelope.ts";
import type { PlatformStore } from "../store/platform-store.ts";

export const FINDING_SCHEMA = "platform/improvement-finding";
export const FINDING_RECORDED_KIND = "finding_recorded";

export const FINDING_CLASSIFICATIONS = [
  "BUG",
  "IMPLEMENTATION_GAP",
  "BACKEND_GAP",
  "OPERABILITY_GAP",
  "CONTRACT_GAP",
  "CONTRACT_AMBIGUITY",
  "CONTRACT_CONTRADICTION",
  "NON_BLOCKING_NIT",
] as const;
export type FindingClassification = (typeof FINDING_CLASSIFICATIONS)[number];

export const FINDING_CLASSIFIERS = [
  "DETERMINISTIC_RULE",
  "AUDITOR",
  "HUMAN",
  "MODEL_PROPOSAL",
] as const;
export type FindingClassifier = (typeof FINDING_CLASSIFIERS)[number];

export interface ImprovementFindingV1Body {
  readonly finding_id: string;
  readonly subject_ref: string;
  readonly classification: FindingClassification;
  readonly summary: string;
  readonly evidence_refs: readonly string[];
  readonly observation_refs: readonly string[];
  readonly discovered_at: string;
  readonly classifier: FindingClassifier;
  readonly classifier_ref: string;
  readonly escaped_from: { readonly attempt_key: string; readonly audit_id?: string } | null;
  readonly supersedes_finding_ref: string | null;
}

export class FindingError extends Error {
  readonly code: "FINDING_INVALID" | "FINDING_EVIDENCE_UNRESOLVED" | "FINDING_CONFLICT";
  constructor(code: FindingError["code"], detail: string) {
    super(`${code}: ${detail}`);
    this.name = "FindingError";
    this.code = code;
  }
}

export interface RecordFindingResult {
  readonly finding_id: string;
  readonly finding_hash: string;
  readonly content_hash: string;
  /** True when an identical record already existed — one logical Finding, not two. */
  readonly replayed: boolean;
}

/** Records one Finding, fail-closed on unverifiable evidence, idempotent on identical replay. */
export function recordFinding(
  store: PlatformStore,
  input: ImprovementFindingV1Body,
): RecordFindingResult {
  const body = validateFinding(store, input);
  const envelope = makeEnvelope(FINDING_SCHEMA, 1, body as unknown as CanonicalObject);
  const finding_hash = hashEnvelope(envelope);

  const previous = store.decisions.byKindAndRef(FINDING_RECORDED_KIND, body.finding_id);
  if (previous.length > 0) {
    const recorded = previous[0]?.payload as { finding_hash?: string; content_hash?: string };
    if (recorded.finding_hash !== finding_hash) {
      throw new FindingError(
        "FINDING_CONFLICT",
        `${body.finding_id} was already recorded with a different content — corrections are new records with supersedes_finding_ref`,
      );
    }
    return {
      finding_id: body.finding_id,
      finding_hash,
      content_hash: recorded.content_hash ?? "",
      replayed: true,
    };
  }

  return store.withTransaction(() => {
    const content_hash = store.blobs.put(canonicalBytes(envelope as unknown as CanonicalObject));
    store.decisions.append({
      kind: FINDING_RECORDED_KIND,
      refKey: body.finding_id,
      payload: {
        finding_hash,
        content_hash,
        subject_ref: body.subject_ref,
        classification: body.classification,
        supersedes_finding_ref: body.supersedes_finding_ref,
      } as never,
    });
    return { finding_id: body.finding_id, finding_hash, content_hash, replayed: false };
  });
}

/**
 * §5.13 — the optional external projection, through the existing Report Outbox and nothing else.
 * `op_key` is the idempotency identity of the external create/update; the route/channel is
 * deployment configuration, never guessed by Core. A Finding without a route stays durable with
 * no external projection — that is a valid state, not a failure.
 */
export function projectFindingToOutbox(
  store: PlatformStore,
  finding_id: string,
  channel: string,
): { readonly op_key: string; readonly enqueued: boolean } {
  const recorded = store.decisions.byKindAndRef(FINDING_RECORDED_KIND, finding_id);
  const payload = recorded[0]?.payload as
    | { finding_hash?: string; subject_ref?: string; classification?: string }
    | undefined;
  if (payload === undefined) {
    throw new FindingError("FINDING_EVIDENCE_UNRESOLVED", `${finding_id} is not recorded`);
  }
  const op_key = `op:${payload.subject_ref}:report-finding:${finding_id}`;
  if (store.outbox.get?.(op_key) !== undefined) return { op_key, enqueued: false };
  store.withTransaction(() => {
    store.outbox.enqueue({
      op_key,
      channel,
      payload: {
        event: "IMPROVEMENT_FINDING",
        finding_id,
        finding_hash: payload.finding_hash ?? "",
        subject_ref: payload.subject_ref ?? "",
        classification: payload.classification ?? "",
      } as never,
    });
  });
  return { op_key, enqueued: true };
}

export interface StoredFinding {
  readonly seq: number;
  readonly finding_hash: string;
  readonly envelope: SchemaEnvelope<CanonicalObject>;
  readonly body: ImprovementFindingV1Body;
}

/** Every recorded Finding, oldest first, re-read from the blob store and re-hash-verified. */
export function listFindings(store: PlatformStore): readonly StoredFinding[] {
  const findings: StoredFinding[] = [];
  for (const entry of store.decisions.read()) {
    if (entry.kind !== FINDING_RECORDED_KIND) continue;
    const payload = entry.payload as { finding_hash?: string; content_hash?: string };
    if (typeof payload.content_hash !== "string") continue;
    const bytes = store.blobs.get(payload.content_hash);
    if (bytes === undefined) continue;
    const envelope = JSON.parse(new TextDecoder().decode(bytes)) as SchemaEnvelope<CanonicalObject>;
    if (hashEnvelope(envelope) !== payload.finding_hash) continue; // corrupt — never surfaced as valid
    findings.push({
      seq: entry.seq,
      finding_hash: payload.finding_hash ?? "",
      envelope,
      body: envelope.body as unknown as ImprovementFindingV1Body,
    });
  }
  return findings;
}

/**
 * §5.13 presentation collapse — the unsuperseded Finding for one subject+classification, derived
 * from the immutable chain. Presentation-layer deduplication only: raw observations, diagnostics
 * and the lifecycle are untouched by it.
 */
export function unsupersededFindingFor(
  store: PlatformStore,
  subject_ref: string,
  classification: FindingClassification,
): StoredFinding | undefined {
  const all = listFindings(store);
  const superseded = new Set(
    all
      .map((finding) => finding.body.supersedes_finding_ref)
      .filter((ref): ref is string => ref !== null),
  );
  return all
    .filter(
      (finding) =>
        finding.body.subject_ref === subject_ref &&
        finding.body.classification === classification &&
        !superseded.has(finding.body.finding_id),
    )
    .at(-1);
}

// --- validation ---------------------------------------------------------------------------------

function validateFinding(
  store: PlatformStore,
  input: ImprovementFindingV1Body,
): ImprovementFindingV1Body {
  const nonEmpty = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.length === 0) {
      throw new FindingError("FINDING_INVALID", `${field} must be a non-empty string`);
    }
    return value;
  };

  nonEmpty(input.finding_id, "finding_id");
  nonEmpty(input.subject_ref, "subject_ref");
  nonEmpty(input.summary, "summary");
  nonEmpty(input.discovered_at, "discovered_at");
  nonEmpty(input.classifier_ref, "classifier_ref");
  if (!FINDING_CLASSIFICATIONS.includes(input.classification)) {
    throw new FindingError("FINDING_INVALID", `unknown classification ${String(input.classification)}`);
  }
  if (!FINDING_CLASSIFIERS.includes(input.classifier)) {
    throw new FindingError("FINDING_INVALID", `unknown classifier ${String(input.classifier)}`);
  }
  if (!Array.isArray(input.evidence_refs) || input.evidence_refs.length === 0) {
    throw new FindingError("FINDING_INVALID", "evidence_refs must be non-empty (§5.13)");
  }

  // Fail-closed evidence resolution: every ref must be verifiable against its authoritative owner.
  for (const ref of input.evidence_refs) {
    if (!evidenceResolves(store, nonEmpty(ref, "evidence_refs[]"))) {
      throw new FindingError("FINDING_EVIDENCE_UNRESOLVED", `${ref} does not resolve`);
    }
  }
  for (const ref of input.observation_refs) nonEmpty(ref, "observation_refs[]");

  if (input.supersedes_finding_ref !== null) {
    const target = store.decisions.byKindAndRef(
      FINDING_RECORDED_KIND,
      nonEmpty(input.supersedes_finding_ref, "supersedes_finding_ref"),
    );
    if (target.length === 0) {
      throw new FindingError(
        "FINDING_EVIDENCE_UNRESOLVED",
        `supersedes_finding_ref ${input.supersedes_finding_ref} names no recorded finding`,
      );
    }
  }
  if (input.escaped_from !== null) {
    const attempt = store.attempts.get(nonEmpty(input.escaped_from.attempt_key, "escaped_from.attempt_key"));
    if (attempt === undefined) {
      throw new FindingError("FINDING_EVIDENCE_UNRESOLVED", "escaped_from.attempt_key does not resolve");
    }
  }

  // Canonicalizability is part of validity: a body the envelope cannot carry is invalid.
  canonicalize(input as unknown as CanonicalObject);
  return input;
}

/** `<kind>:<id>` refs over the owners the Store actually holds. Unknown kinds never resolve. */
function evidenceResolves(store: PlatformStore, ref: string): boolean {
  const separator = ref.indexOf(":");
  if (separator <= 0) return false;
  const kind = ref.slice(0, separator);
  const id = ref.slice(separator + 1);
  switch (kind) {
    case "evidence":
      return store.verificationEvidence.get(id) !== undefined;
    case "audit":
      return store.auditRecords.get(id) !== undefined;
    case "decision":
      return store.pendingDecisions.get(id) !== undefined;
    case "op":
      return store.idempotency.get(`op:${id}`) !== undefined || store.idempotency.get(ref) !== undefined;
    case "task":
      return store.tasks.get(ref) !== undefined;
    case "attempt":
      return store.attempts.get(ref) !== undefined;
    case "run":
      return store.runs.get(ref) !== undefined;
    case "transition": {
      // The exact journal entry, and it must actually be a state transition (finding 18): an
      // arbitrary journal kind at that seq is not transition evidence, whatever its number.
      const seq = Number(id);
      if (!Number.isInteger(seq) || seq < 1) return false;
      const entry = store.decisions.read().find((row) => row.seq === seq);
      return entry !== undefined && entry.kind === "state_transition";
    }
    default:
      return false;
  }
}
