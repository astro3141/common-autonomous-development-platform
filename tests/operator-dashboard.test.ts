/**
 * Operator dashboard — the properties that make it a projection consumer rather than a component.
 *
 * These are not rendering tests. Each one pins a boundary that, if it broke, would turn an observer
 * into an authority or a gap into an invention.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { renderDashboard, type DashboardSnapshot } from "../deployment/dashboard.ts";

const EMPTY: DashboardSnapshot = {
  generated_at: "2026-09-01T00:00:00.000Z",
  run_id: "run:01ARZ3NDEKTSV4RRFFQ69G5FAV",
  run: null,
  monitor: null,
  diagnostics: [],
  measurements: [],
  findings: [],
};

const snapshot = (over: Partial<DashboardSnapshot> = {}): DashboardSnapshot => ({
  ...EMPTY,
  ...over,
});

test("DASH-1: an UNKNOWN measurement is rendered as UNKNOWN, never as a value", () => {
  const page = renderDashboard(
    snapshot({
      measurements: [
        {
          attempt_key: "attempt:task:p:t:1",
          packet: {
            attempt_key: "attempt:task:p:t:1",
            task_contract_hash: { kind: "UNKNOWN" },
            role_bindings: { kind: "UNKNOWN" },
            actual_provider: { kind: "UNKNOWN" },
            actual_model: { kind: "UNKNOWN" },
            actual_binding_ref: { kind: "UNKNOWN" },
            stage_durations_ms: { kind: "UNKNOWN" },
            rework_count: 0,
            audit_rounds: 0,
            human_handoffs: 0,
            human_interventions: 0,
            usage: { kind: "UNKNOWN" },
            cost: { kind: "UNKNOWN" },
            final_outcome: { attempt_state: "IMPLEMENTING", task_state: "ACTIVE", reason: null },
            failure_attribution: null,
          } as unknown as DashboardSnapshot["measurements"][number]["packet"],
        },
      ],
    }),
  );

  // The unknown binding is stated, and no neighbouring field is used to fill it in.
  assert.equal(page.includes("UNKNOWN"), true);
  assert.equal(
    page.includes("gpt-"),
    false,
    "an unknown actual model must not be filled in from anywhere",
  );
  // A null reason stays null rather than becoming an empty string or a guess.
  assert.equal(page.includes("null"), true);
});

test("DASH-2: an UNAVAILABLE diagnostic field keeps its source and does not become a value", () => {
  const page = renderDashboard(
    snapshot({
      diagnostics: [
        {
          subject_ref: "attempt:task:p:t:1",
          state: { availability: "UNAVAILABLE", source: "store", error_ref: "database is locked" },
          next_owner: {
            availability: "AVAILABLE",
            value: { owner: "HUMAN", detail: "MERGE_APPROVAL" },
            source: "store (I-TD8 derivation)",
            freshness: "durable_projection",
          },
          recent_transitions: { availability: "UNAVAILABLE", source: "store:decision_log" },
          operations: { availability: "UNAVAILABLE", source: "store:idempotency" },
          evidence: { availability: "UNAVAILABLE", source: "store:verification_evidence" },
          open_decisions: { availability: "UNAVAILABLE", source: "store:pending_human_decision" },
          repository: { availability: "UNAVAILABLE", source: "repository", error_ref: "no adapter" },
        } as unknown as DashboardSnapshot["diagnostics"][number],
      ],
    }),
  );

  assert.equal(page.includes("UNAVAILABLE"), true);
  assert.equal(page.includes("database is locked"), true, "the error ref is evidence, not noise");
  // An available field must not be presented as a fresh observation when it is a durable projection.
  assert.equal(page.includes("durable projection"), true);
  assert.equal(page.includes("MERGE_APPROVAL"), true);
});

test("DASH-3: a partial snapshot still renders — one missing projection is not a blank page", () => {
  // §5.11 partial-result semantics: the run projection failed and was dropped, the findings stand.
  const page = renderDashboard(
    snapshot({
      run: null,
      findings: [
        {
          finding_id: "finding:x",
          classification: "BUG",
          subject_ref: "source:core/x.ts",
          summary: "a recorded finding",
        },
      ],
    }),
  );

  assert.equal(page.includes("a recorded finding"), true);
  assert.equal(page.includes("— no run —"), true, "the absent run is stated, not hidden");
});

test("DASH-4: the page carries no control that could reach a transition", () => {
  const page = renderDashboard(
    snapshot({
      run: {
        run: { run_id: "run:1", project_id: "p", status: "RUNNING" },
        batches: [
          {
            batch_id: "batch:1",
            status: "RUNNING",
            admission_closed: false,
            tasks: [
              {
                task_key: "task:p:t",
                platform_state: "ACTIVE",
                state_reason: null,
                attempt: {
                  attempt_key: "attempt:task:p:t:1",
                  state: "READY_TO_MERGE",
                  candidate_commit: "abc123",
                  rework_count: 0,
                },
                open_decisions: [
                  { decision_id: "d1", category: "MERGE_APPROVAL", question: "merge?" },
                ],
              },
            ],
          },
        ],
      },
    }),
  );

  // Monitoring is observation, not authority (§22.5). The rendered page is incapable of acting:
  // no form to submit, no script to run, no control to press.
  for (const control of ["<form", "<button", "<input", "<script", "onclick", "fetch("]) {
    assert.equal(page.includes(control), false, `dashboard must not render ${control}`);
  }
  // It still shows the human boundary it reached.
  assert.equal(page.includes("MERGE_APPROVAL"), true);
  assert.equal(page.includes("abc123"), true);
});

test("DASH-5: rendering is pure — the same snapshot yields the same page", () => {
  const input = snapshot({ findings: [{ finding_id: "f", classification: "BUG" }] });
  assert.equal(renderDashboard(input), renderDashboard(input));
});

test("DASH-6: rendered values are escaped, so a recorded string cannot become markup", () => {
  const page = renderDashboard(
    snapshot({
      findings: [
        {
          finding_id: "f",
          classification: "BUG",
          subject_ref: "x",
          summary: "<script>alert(1)</script>",
        },
      ],
    }),
  );
  assert.equal(page.includes("<script>alert(1)</script>"), false);
  assert.equal(page.includes("&lt;script&gt;"), true);
});
