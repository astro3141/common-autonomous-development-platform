/**
 * FakeVerificationAdapter — scripted results + call recording only (Spec §63, TD §25).
 * No command execution, no CI, no process, no scheduler, no worker, no timer.
 *
 * It does implement the one behaviour TD §15.1a makes a *contract* rather than a backend detail:
 * the same `op_key` with the same material input resolves to the same run, and the same `op_key`
 * with different material is a conflict. That is a small map, not a workflow engine.
 */

import type {
  AuditSettlementOperationContextV1,
  AuditSettlementResult,
  PlatformAuditVerdict,
  VerificationAdapter,
  VerificationEvidence,
  VerificationOperationContextV1,
  VerificationRunObservation,
  VerificationStartResult,
} from "../adapters/interfaces/verification-adapter.ts";
import type {
  TaskContractSnapshot,
  VerificationProfile,
  VerificationRunHandle,
} from "../adapters/interfaces/handles.ts";
import type { RepositoryCanonicalSnapshot } from "../adapters/interfaces/repository-adapter.ts";
import type { FakeCall } from "./scripted.ts";

export class FakeVerificationAdapter implements VerificationAdapter {
  readonly calls: FakeCall[] = [];
  readonly #runs = new Map<string, { handle: VerificationRunHandle; material: string }>();

  /** When true, every start answers `BLOCKED` and records no run. */
  blocked = false;
  /** What the next observation reports. Default: the run is still going. */
  observation: VerificationRunObservation = { state: "RUNNING" };
  /** Runs at the start of `start_verification`, so a test can observe the ambient state. */
  onStart: (() => void) | undefined;
  /** Thrown *after* the run exists — the "effect happened, response lost" window. */
  failAfterStart: Error | undefined;
  /** Handle content the start returns; a test can make it unstorable. */
  runValue: ((index: number) => unknown) | undefined;

  /** How many logical verification runs this adapter actually established. */
  get runCount(): number {
    return this.#runs.size;
  }

  start_verification(
    operation_context: VerificationOperationContextV1,
    verification_profile: VerificationProfile,
    repository_snapshot: RepositoryCanonicalSnapshot,
    task_contract_snapshot: TaskContractSnapshot,
    candidate_commit: string,
  ): VerificationStartResult {
    this.calls.push({
      method: "start_verification",
      args: [
        operation_context,
        verification_profile,
        repository_snapshot,
        task_contract_snapshot,
        candidate_commit,
      ],
    });
    this.onStart?.();
    if (this.blocked) return { kind: "BLOCKED" };

    const material = JSON.stringify([
      verification_profile,
      repository_snapshot,
      task_contract_snapshot,
      candidate_commit,
    ]);
    const existing = this.#runs.get(operation_context.op_key);
    if (existing !== undefined) {
      if (existing.material !== material) {
        throw new Error(
          `${operation_context.op_key} was started with different material input`,
        );
      }
      return { kind: "STARTED", run_handle: existing.handle };
    }

    const index = this.#runs.size + 1;
    const handle = (this.runValue?.(index) ?? {
      verification_run: `run-${index}`,
    }) as unknown as VerificationRunHandle;
    this.#runs.set(operation_context.op_key, { handle, material });
    if (this.failAfterStart !== undefined) throw this.failAfterStart;
    return { kind: "STARTED", run_handle: handle };
  }

  get_verification_result(run_handle: VerificationRunHandle): VerificationRunObservation {
    this.calls.push({ method: "get_verification_result", args: [run_handle] });
    return this.observation;
  }

  /**
   * TD §16.3 (M1-13) — what the next settlement resolves to. A double may script the *result*
   * because it has no backend to observe; a production adapter may not, which is what
   * `LocalVerificationAdapter` proves separately.
   */
  settlement: AuditSettlementResult = { kind: "UNAVAILABLE" };

  settle_audit(
    operation_context: AuditSettlementOperationContextV1,
    run_handle: VerificationRunHandle,
    auditor_verdict: PlatformAuditVerdict,
    evidence: readonly VerificationEvidence[],
  ): AuditSettlementResult {
    this.calls.push({
      method: "settle_audit",
      args: [operation_context.op_key, run_handle, auditor_verdict, evidence.length],
    });
    return this.settlement;
  }

  /** Scripts a terminal observation without pretending any evidence was produced by a backend. */
  completeWith(evidence: readonly VerificationEvidence[]): void {
    this.observation = { state: "COMPLETED", evidence };
  }

  /** Drops the in-memory runs without touching what the Platform stored. */
  forgetRuns(): void {
    this.#runs.clear();
  }
}
