/**
 * Operator dashboard — HTML rendering of the existing read-only projections (TD §5.11).
 *
 * This is **not** a component and owns nothing. It is a consumer of the same derivations the JSON
 * surfaces already expose: the run read model, `monitor_once`, `diagnostic_packet`,
 * `measurement_packet` and the recorded findings. It has no store handle, no adapter handle, no
 * clock and no I/O — `renderDashboard` is a pure function from an already-projected snapshot to a
 * string, so the direction of dependency can only ever be:
 *
 *     store / journal / finding / monitor output
 *         -> read-only projection
 *         -> dashboard
 *
 * The reverse — a control in this page reaching a transition — is not something this module
 * declines to do; it is something it has no means to do. There is no request handler here, no
 * mutable input, and nothing rendered is a form.
 *
 * **Availability is rendered, never repaired.** A `DiagnosticField` that is `UNAVAILABLE`, an
 * `Availability` that is `UNKNOWN`, and a `reason` that is `null` are each shown as exactly that.
 * Nothing is estimated, defaulted, or filled in from a neighbouring field: a gap in the platform's
 * own record is information the operator is entitled to see (§5.11, §5.12, §24.1).
 */

import type { DiagnosticPacketV1 } from "../core/operability/diagnostics.ts";
import type { MeasurementPacketV1 } from "../core/operability/measurement.ts";

/** One attempt's measurement packet, paired with the subject it belongs to. */
export interface DashboardMeasurement {
  readonly attempt_key: string;
  readonly packet: MeasurementPacketV1;
}

/** Exactly what the page is allowed to know. Every member is a projection output. */
export interface DashboardSnapshot {
  readonly generated_at: string;
  readonly run_id: string | null;
  /** `runProjection` output, or null when the run key resolved to nothing. */
  readonly run: unknown;
  /** `monitorOnce` output: anomalies plus per-authority coverage. */
  readonly monitor: {
    readonly anomalies: readonly Record<string, unknown>[];
    readonly authority_coverage: Readonly<Record<string, string>>;
  } | null;
  /** `diagnosticPacket` for the run and for each current attempt. */
  readonly diagnostics: readonly DiagnosticPacketV1[];
  /** `measurementPacket` per current attempt. */
  readonly measurements: readonly DashboardMeasurement[];
  /** `listFindings` projection rows. */
  readonly findings: readonly Record<string, unknown>[];
}

const ATTEMPT_FLOW = [
  "READY",
  "IMPLEMENTING",
  "VERIFYING",
  "AUDITING",
  "REWORKING",
  "READY_TO_MERGE",
  "APPROVED_FOR_MANUAL_MERGE",
  "MERGED",
] as const;

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** An absent value is stated, never smoothed over. */
function absent(label: string): string {
  return `<span class="absent">${esc(label)}</span>`;
}

/**
 * Renders a `DiagnosticField`. `UNAVAILABLE` keeps its source and error ref, and an available value
 * keeps its freshness — a durable projection is never painted as a fresh observation.
 */
function field(value: unknown): string {
  const f = value as
    | { availability: "AVAILABLE"; value: unknown; source: string; freshness: string }
    | { availability: "UNAVAILABLE"; source: string; error_ref?: string }
    | undefined;
  if (f === undefined) return absent("— no field —");
  if (f.availability === "UNAVAILABLE") {
    return `${absent("UNAVAILABLE")}<span class="prov">${esc(f.source)}${
      f.error_ref === undefined ? "" : ` · ${esc(f.error_ref)}`
    }</span>`;
  }
  const fresh = f.freshness === "fresh" ? "fresh" : "durable projection";
  return `<pre>${esc(JSON.stringify(f.value, null, 2))}</pre><span class="prov">${esc(
    f.source,
  )} · ${esc(fresh)}</span>`;
}

/** Renders an `Availability<T>`: REPORTED carries a value, UNKNOWN carries nothing at all. */
function availability(value: unknown): string {
  const a = value as { kind?: string; value?: unknown } | undefined;
  if (a === undefined || a.kind !== "REPORTED") return absent("UNKNOWN");
  return `<code>${esc(
    typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value),
  )}</code>`;
}

function flow(state: string | null): string {
  const idx = ATTEMPT_FLOW.indexOf(state as (typeof ATTEMPT_FLOW)[number]);
  const items = ATTEMPT_FLOW.map((s, i) => {
    const cls = s === state ? "now" : idx >= 0 && i < idx ? "done" : "todo";
    return `<li class="${cls}">${esc(s)}</li>`;
  }).join("");
  return `<ul class="flow">${items}</ul>`;
}

function section(title: string, body: string): string {
  return `<section><h2>${esc(title)}</h2>${body}</section>`;
}

function rows(data: readonly Record<string, unknown>[], columns: readonly string[]): string {
  if (data.length === 0) return absent("— none —");
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = data
    .map((row) => {
      const cells = columns
        .map((c) => {
          const v = row[c];
          const text = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
          return `<td>${text === "" ? absent("null") : esc(text)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

interface ProjectedTask {
  readonly task_key?: string;
  readonly platform_state?: string;
  readonly state_reason?: unknown;
  readonly attempt?: {
    readonly attempt_key?: string;
    readonly state?: string;
    readonly candidate_commit?: string | null;
    readonly rework_count?: number;
  } | null;
  readonly open_decisions?: readonly Record<string, unknown>[];
}

interface ProjectedRun {
  readonly run?: { run_id?: string; status?: string; project_id?: string } | null;
  readonly batches?: readonly {
    readonly batch_id?: string;
    readonly status?: string;
    readonly admission_closed?: boolean;
    readonly tasks?: readonly ProjectedTask[];
  }[];
}

/** Pure: a snapshot in, a page out. No I/O, no clock, no authority. */
export function renderDashboard(snapshot: DashboardSnapshot): string {
  const projected = (snapshot.run ?? {}) as ProjectedRun;
  const batches = projected.batches ?? [];
  const tasks = batches.flatMap((b) => b.tasks ?? []);
  const attempts = tasks.map((t) => t.attempt).filter((a): a is NonNullable<typeof a> => !!a);
  const decisions = tasks.flatMap((t) => t.open_decisions ?? []);
  const state = attempts.at(-1)?.state ?? null;
  const candidate = attempts.map((a) => a.candidate_commit).filter(Boolean).at(-1) ?? null;

  const mergeOpen = decisions.some((d) => d["category"] === "MERGE_APPROVAL");

  const coverage = snapshot.monitor?.authority_coverage ?? {};
  const coverageRow = Object.keys(coverage).length
    ? `<div class="scroll"><table><thead><tr>${Object.keys(coverage)
        .map((k) => `<th>${esc(k)}</th>`)
        .join("")}</tr></thead><tbody><tr>${Object.values(coverage)
        .map(
          (v) =>
            `<td class="${v === "AVAILABLE" ? "" : "absent"}">${esc(v)}</td>`,
        )
        .join("")}</tr></tbody></table></div>`
    : absent("— monitor not consulted —");

  const measurementBlocks = snapshot.measurements
    .map(
      (m) => `<h3>${esc(m.attempt_key)}</h3>
<div class="scroll"><table><tbody>
<tr><th>actual provider</th><td>${availability(m.packet.actual_provider)}</td></tr>
<tr><th>actual model</th><td>${availability(m.packet.actual_model)}</td></tr>
<tr><th>actual binding ref</th><td>${availability(m.packet.actual_binding_ref)}</td></tr>
<tr><th>usage</th><td>${availability(m.packet.usage)}</td></tr>
<tr><th>cost</th><td>${availability(m.packet.cost)}</td></tr>
<tr><th>role bindings</th><td>${availability(m.packet.role_bindings)}</td></tr>
<tr><th>stage durations</th><td>${availability(m.packet.stage_durations_ms)}</td></tr>
<tr><th>rework / audit rounds</th><td><code>${esc(m.packet.rework_count)}</code> / <code>${esc(
        m.packet.audit_rounds,
      )}</code></td></tr>
<tr><th>human handoffs / interventions</th><td><code>${esc(
        m.packet.human_handoffs,
      )}</code> / <code>${esc(m.packet.human_interventions)}</code></td></tr>
<tr><th>final outcome</th><td><code>${esc(m.packet.final_outcome.attempt_state)}</code> · <code>${esc(
        m.packet.final_outcome.task_state,
      )}</code> · reason ${
        m.packet.final_outcome.reason === null
          ? absent("null")
          : `<code>${esc(m.packet.final_outcome.reason)}</code>`
      }</td></tr>
<tr><th>failure attribution</th><td>${
        m.packet.failure_attribution === null
          ? absent("none recorded")
          : `<code>${esc(JSON.stringify(m.packet.failure_attribution))}</code>`
      }</td></tr>
</tbody></table></div>`,
    )
    .join("");

  const diagnosticBlocks = snapshot.diagnostics
    .map(
      (p) => `<h3>${esc(p.subject_ref)}</h3>
<div class="scroll"><table><tbody>
<tr><th>state</th><td>${field(p.state)}</td></tr>
<tr><th>next owner</th><td>${field(p.next_owner)}</td></tr>
<tr><th>recent transitions</th><td>${field(p.recent_transitions)}</td></tr>
<tr><th>operations</th><td>${field(p.operations)}</td></tr>
<tr><th>evidence</th><td>${field(p.evidence)}</td></tr>
<tr><th>open decisions</th><td>${field(p.open_decisions)}</td></tr>
<tr><th>repository</th><td>${field(p.repository)}</td></tr>
</tbody></table></div>`,
    )
    .join("");

  const body = `
<h1>ADP operator dashboard</h1>
<p class="sub">read-only projection consumer · no authority, no write path · generated ${esc(
    snapshot.generated_at,
  )}</p>
${
  mergeOpen
    ? '<div class="banner">MERGE_APPROVAL is open — the Platform reached the human boundary. The merge decision is not taken here.</div>'
    : ""
}
<div class="grid2">
  <div>${section("Attempt state", flow(state))}</div>
  <div>${section(
    "Candidate",
    candidate === null
      ? absent("— no candidate produced —")
      : `<p class="big"><code>${esc(candidate)}</code></p>`,
  )}</div>
</div>
${section(
  "Run",
  projected.run == null
    ? absent("— no run —")
    : rows([projected.run as Record<string, unknown>], ["run_id", "project_id", "status"]),
)}
${section(
  "Batches",
  rows(batches as unknown as Record<string, unknown>[], ["batch_id", "status", "admission_closed"]),
)}
${section(
  "Tasks",
  rows(tasks as unknown as Record<string, unknown>[], ["task_key", "platform_state", "state_reason"]),
)}
${section(
  "Attempts",
  rows(attempts as unknown as Record<string, unknown>[], [
    "attempt_key",
    "state",
    "candidate_commit",
    "rework_count",
  ]),
)}
${section(
  "Pending human decisions",
  rows(decisions, ["decision_id", "category", "question"]),
)}
${section("Monitor — authority coverage (§22.5)", coverageRow)}
${section(
  "Monitor — anomalies",
  rows(snapshot.monitor?.anomalies ?? [], [
    "anomaly_kind",
    "subject_ref",
    "coverage",
    "observed_at",
    "recommended_reobservation_scope",
  ]),
)}
${section(
  "Findings (§5.13)",
  rows(snapshot.findings, ["finding_id", "classification", "subject_ref", "summary"]),
)}
${section(
  "Measurement (§5.12) — observed execution binding",
  measurementBlocks === "" ? absent("— no attempt to measure —") : measurementBlocks,
)}
${section(
  "Diagnostics (§5.11) — per-field provenance",
  diagnosticBlocks === "" ? absent("— no subject —") : diagnosticBlocks,
)}
`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>ADP operator dashboard</title>
<meta http-equiv="refresh" content="5">
<style>
:root{color-scheme:light dark}
body{font:13.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:24px;
     background:Canvas;color:CanvasText;max-width:1180px;margin-inline:auto}
h1{font-size:19px;margin:0 0 2px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;opacity:.6;margin:22px 0 6px}
h3{font-size:12.5px;margin:14px 0 4px;opacity:.8;word-break:break-all}
.sub{opacity:.6;margin:0 0 16px}
section{border-top:1px solid color-mix(in srgb,CanvasText 18%,transparent);padding-top:4px}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th{text-align:left;font-weight:600;opacity:.6;padding:4px 12px 4px 0;white-space:nowrap;vertical-align:top}
td{padding:3px 12px 3px 0;vertical-align:top}
tbody tr:nth-child(odd){background:color-mix(in srgb,CanvasText 4%,transparent)}
.scroll{overflow-x:auto}
.absent{opacity:.5;font-style:italic}
.prov{display:block;font-size:11px;opacity:.5;margin-top:2px}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font-size:12px;max-height:220px;overflow:auto}
.big{font-size:14px;word-break:break-all}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media(max-width:760px){.grid2{grid-template-columns:1fr}}
ul.flow{list-style:none;padding:0;margin:6px 0;display:flex;flex-wrap:wrap;gap:6px}
ul.flow li{padding:3px 9px;border-radius:999px;font-size:11.5px;opacity:.38;
  border:1px solid color-mix(in srgb,CanvasText 22%,transparent)}
ul.flow li.done{opacity:.72}
ul.flow li.now{opacity:1;font-weight:700;
  border-color:color-mix(in srgb,CanvasText 70%,transparent);
  background:color-mix(in srgb,CanvasText 12%,transparent)}
.banner{padding:10px 14px;border-radius:8px;margin:14px 0;font-weight:600;
  border:1px solid color-mix(in srgb,CanvasText 30%,transparent);
  background:color-mix(in srgb,CanvasText 8%,transparent)}
</style></head><body>${body}</body></html>`;
}
