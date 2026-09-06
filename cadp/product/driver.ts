/**
 * Proposal driver classification (#61): pure decision logic for the sequential
 * proposal → governed WORK_START loop (`ctl work-plan`).
 *
 * The driver is deterministic glue, not authority: every item still enters through the ordinary
 * governed WORK_START admission, the workflow owns continuation, and the Human decision stays
 * Human — an item that reaches its merge gate counts as delivered ("AWAITING_HUMAN_MERGE") and
 * the loop moves on; merges happen out-of-band via `ctl human-approve`. Anything that is not a
 * clean delivery halts the loop (fail closed): the driver never blindly continues past a failed,
 * stopped or stalled run.
 */

export interface RunSnapshot {
  /** Temporal execution status as observed (commodity workflow state, not effect authority). */
  readonly workflow_status: "RUNNING" | "COMPLETED" | "FAILED" | "TERMINATED" | "TIMED_OUT" | "CANCELLED" | "UNKNOWN";
  /** The workflow's returned trace when COMPLETED. */
  readonly trace?: Record<string, unknown>;
  /** Effects currently waiting on a Human decision (kernel K5 projection, observationProjection.humanWait). */
  readonly human_wait: readonly string[];
  /** True once the per-item wall-clock deadline has passed. */
  readonly deadline_exceeded: boolean;
}

export type ItemStatus =
  | { status: "RUNNING" }
  | { status: "COMPLETED"; trace: Record<string, unknown> }
  | { status: "AWAITING_HUMAN_MERGE"; effects: readonly string[] }
  | { status: "STOPPED"; detail: string }
  | { status: "FAILED"; detail: string }
  | { status: "STALLED"; detail: string };

export function classifyRun(snapshot: RunSnapshot): ItemStatus {
  if (snapshot.workflow_status === "COMPLETED") {
    const trace = snapshot.trace ?? {};
    if (trace["completed"] === true) return { status: "COMPLETED", trace };
    // A workflow that returned without `completed` reported a bounded stop; honor its own reason.
    return { status: "STOPPED", detail: `${String(trace["stopped"] ?? "UNSPECIFIED")}${trace["detail"] !== undefined ? `: ${String(trace["detail"])}` : ""}` };
  }
  if (snapshot.workflow_status === "FAILED" || snapshot.workflow_status === "TERMINATED" || snapshot.workflow_status === "TIMED_OUT" || snapshot.workflow_status === "CANCELLED") {
    return { status: "FAILED", detail: snapshot.workflow_status };
  }
  // RUNNING / UNKNOWN: a run parked at its Human merge gate is a delivered item — the Human
  // decision is batched out-of-band, never relayed by the driver.
  if (snapshot.human_wait.length > 0) return { status: "AWAITING_HUMAN_MERGE", effects: snapshot.human_wait };
  if (snapshot.deadline_exceeded) {
    return { status: "STALLED", detail: `no terminal state or merge gate before the per-item deadline (workflow ${snapshot.workflow_status})` };
  }
  return { status: "RUNNING" };
}

/** What the loop does with a settled item. Fail closed: only clean deliveries continue. */
export function nextAction(item: ItemStatus): "CONTINUE_POLLING" | "NEXT_ITEM" | "HALT" {
  switch (item.status) {
    case "RUNNING":
      return "CONTINUE_POLLING";
    case "COMPLETED":
    case "AWAITING_HUMAN_MERGE":
      return "NEXT_ITEM";
    case "STOPPED":
    case "FAILED":
    case "STALLED":
      return "HALT";
  }
}
