/**
 * Backend v1 execution facts → `VerificationEvidence` (MVP1-B8).
 *
 * Two rules shape everything here:
 *
 *   the OS child's exit is the only thing that decides PASS/FAIL/ERROR — no stdout is parsed, no
 *   model text is read, and the backend's own progression marker is never consulted;
 *
 *   the same terminal record must always produce the same evidence, byte for byte, because the
 *   Platform's evidence store is immutable and a second poll must replay rather than conflict.
 *
 * Nothing in this file is exported as a general-purpose facility. The identifier derivation in
 * particular is a private mapping helper, not an ID framework.
 */

import { createHash } from "node:crypto";

import type {
  AssuranceLevel,
  VerificationEvidence,
  VerificationResult,
} from "../interfaces/verification-adapter.ts";
import type { BackendStageStatus } from "./backend-seam.ts";

/** MVP1-B8 §11 — the producer id. Distinct from any Actor-produced, self-reported evidence. */
export const LOCAL_VERIFICATION_ADAPTER_VERSION = "1";
export const LOCAL_VERIFICATION_EXECUTOR_IDENTITY =
  `platform-verifier@local-verification-adapter:${LOCAL_VERIFICATION_ADAPTER_VERSION}`;

/**
 * §6 — the Platform creates the workspace at the candidate, chooses the frozen argv, owns the
 * invocation and observes the real child process. That is what `REEXECUTED` means, and it is why
 * the backend's similarly-spelled `verification_level` is never consulted.
 */
const LOCAL_ASSURANCE: AssuranceLevel = "REEXECUTED";

/** Provider outcomes that mean the activity did not do its work. Local checks are always `OK`. */
const PROVIDER_FAILURE = new Set([
  "ERROR_UNCLASSIFIED",
  "BLOCKED_QUOTA",
  "RATE_LIMITED",
  "AUTH_FAILED",
  "CONTEXT_LIMIT",
  "INTERNAL_ERROR",
  "TOOL_INTERRUPTED",
]);

/** Process outcomes that mean the check could not be executed to a verdict. */
const EXECUTION_ERROR = new Set(["TIMED_OUT", "INTERRUPTED", "LOST"]);

/** Process outcomes that are not terminal yet. */
const NOT_TERMINAL = new Set(["QUEUED", "RUNNING"]);

export type StageOutcome =
  /** The check has not finished; the run is still going. */
  | { readonly kind: "PENDING" }
  | { readonly kind: "RESULT"; readonly result: VerificationResult }
  /** Terminal, but no trustworthy verification result can be built from it. */
  | { readonly kind: "UNUSABLE" };

/**
 * §4 — the measured mapping. `process_state` is authoritative; a provider failure on an exit-0
 * model activity is the false-success case and becomes `ERROR`, never `PASS`.
 */
export function classifyStage(stage: BackendStageStatus): StageOutcome {
  const process_state = stage.process_state;
  if (process_state === null || NOT_TERMINAL.has(process_state)) return { kind: "PENDING" };
  if (EXECUTION_ERROR.has(process_state)) return { kind: "RESULT", result: "ERROR" };
  if (process_state === "FAILED_COMMAND") return { kind: "RESULT", result: "FAIL" };
  if (process_state === "COMPLETED") {
    return PROVIDER_FAILURE.has(stage.provider_state ?? "")
      ? { kind: "RESULT", result: "ERROR" }
      : { kind: "RESULT", result: "PASS" };
  }
  // CANCELLED, or a state this mapping does not know: fail closed rather than guess a verdict.
  return { kind: "UNUSABLE" };
}

export interface EvidenceInput {
  readonly check_id: string;
  readonly result: VerificationResult;
  readonly target_commit: string;
  readonly task_contract_hash: string;
  readonly run_reference: string;
  /** The backend's terminal timestamp for this check. Never a clock read. */
  readonly finished_at: string;
  readonly attempt: number;
}

/**
 * Builds one evidence item.
 *
 * `artifact_digest` and `log_digest` are absent on purpose: the backend publishes only bounded log
 * *tails* through its public projection, and hashing a tail would be a digest of something that is
 * not the artifact (§14).
 */
export function buildEvidence(input: EvidenceInput): VerificationEvidence {
  return {
    evidence_id: deriveEvidenceId(input),
    check_id: input.check_id,
    result: input.result,
    assurance_level: LOCAL_ASSURANCE,
    target_commit: input.target_commit,
    task_contract_hash: input.task_contract_hash,
    executor_identity: LOCAL_VERIFICATION_EXECUTOR_IDENTITY,
    run_reference: input.run_reference,
    timestamp: input.finished_at,
  };
}

// --- deterministic evidence identity ------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * §13 — a well-formed ULID derived entirely from the terminal record, so a second poll of the same
 * finished check produces the same identity and the immutable evidence store replays instead of
 * conflicting. No clock is read and no randomness is drawn.
 *
 * The layout is the standard one — 48 timestamp bits then 80 entropy bits — with the entropy taken
 * from a domain-separated hash of everything that makes this check's result *this* result. It is
 * deliberately not exported as a reusable identity scheme: §6.1's run/batch/task/attempt/op
 * identifiers are untouched, and nothing else in the Platform derives ids this way.
 */
export function deriveEvidenceId(input: EvidenceInput): string {
  const milliseconds = Date.parse(input.finished_at);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error(`verification evidence needs a terminal timestamp, got ${input.finished_at}`);
  }
  const material = JSON.stringify([
    "platform/verification-evidence-id/v1",
    input.run_reference,
    input.check_id,
    input.attempt,
    input.target_commit,
    input.task_contract_hash,
  ]);
  const digest = createHash("sha256").update(material).digest();
  let entropy = 0n;
  for (const byte of digest.subarray(0, 10)) entropy = (entropy << 8n) | BigInt(byte);

  return encodeCrockford(BigInt(milliseconds), 10) + encodeCrockford(entropy, 16);
}

/** Most-significant-first Crockford base32, five bits per character. */
function encodeCrockford(value: bigint, length: number): string {
  let remaining = value;
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = CROCKFORD[Number(remaining & 31n)] + encoded;
    remaining >>= 5n;
  }
  return encoded;
}
