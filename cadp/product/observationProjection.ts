/**
 * Read-only observation projections (#96/#106, TD §12 r8).
 *
 * Everything here is a DERIVED, non-authoritative projection over exact K1–K7 rows read through
 * the constitutional Kernel API with observer reach (get_effect_state, list_effects,
 * get_evidence, list_evidence — nothing else). Honesty rules:
 *
 *  - a query that FAILED is `UNAVAILABLE` with its reason, never rendered as absence;
 *  - a COMPLETE empty read is one store's answer, never proof of universal absence (B3);
 *  - requested and observed backend facts are never merged (#91); UNKNOWN stays UNKNOWN;
 *  - no projection writes anything — the observer class cannot (B2).
 */

import type { EffectState } from "../clients/kernelClient.ts";
import type { EvidenceEnvelopeV1 } from "../kernel/records.ts";

/** The exact observer-reach slice of the Kernel API this module may use. */
export interface ObserverReader {
  getEffectState(effect_id: string): Promise<EffectState>;
  listEffects(work_run_ref: string): Promise<{ effect_ids: string[] }>;
  getEvidence(evidence_id: string): Promise<{ envelope: EvidenceEnvelopeV1 }>;
  listEvidence(work_run_ref: string): Promise<{ evidence: Array<{ evidence_id: string }> }>;
}

export type Query<T> = { query: "COMPLETE"; value: T } | { query: "UNAVAILABLE"; reason: string };

export async function attempt<T>(work: () => Promise<T>): Promise<Query<T>> {
  try {
    return { query: "COMPLETE", value: await work() };
  } catch (error) {
    return { query: "UNAVAILABLE", reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface EffectProjection {
  effect_id: string;
  operation_kind?: string;
  latest_decision?: { outcome: string; reason_codes: string[] };
  admissions: number;
  conclusive?: string;
  open_unknown: boolean;
  state: Query<EffectState>;
}

export function projectEffect(effect_id: string, state: Query<EffectState>): EffectProjection {
  if (state.query === "UNAVAILABLE") return { effect_id, admissions: 0, open_unknown: false, state };
  const s = state.value;
  const latest = s.decisions[s.decisions.length - 1];
  const conclusive = s.outcomes.find((o) => o.result === "COMMITTED" || o.result === "NO_EFFECT_CONFIRMED");
  const open_unknown = conclusive === undefined && s.outcomes.some((o) => o.result === "UNKNOWN");
  return {
    effect_id,
    operation_kind: s.request.operation_kind,
    ...(latest !== undefined ? { latest_decision: { outcome: latest.outcome, reason_codes: [...latest.reason_codes] } } : {}),
    admissions: s.admissions.length,
    ...(conclusive !== undefined ? { conclusive: conclusive.result } : {}),
    open_unknown,
    state,
  };
}

/** HUMAN_POLICY_WAIT is a projection over exact K5 rows: latest decision REQUIRE_EVIDENCE naming HUMAN_DECISION. */
export function humanWait(effects: EffectProjection[]): string[] {
  return effects
    .filter((e) => e.latest_decision?.outcome === "REQUIRE_EVIDENCE" && e.latest_decision.reason_codes.includes("HUMAN_DECISION"))
    .map((e) => e.effect_id);
}

export interface RunObservation {
  summaries: Query<{ evidence: Array<{ evidence_id: string }> }>;
  effectIds: Query<{ effect_ids: string[] }>;
  envelopes: Record<string, Query<EvidenceEnvelopeV1>>;
  byKind(kind: string): EvidenceEnvelopeV1[];
  effects: EffectProjection[];
}

/** Collect one work run entirely through observer reach; per-row failures stay per-row honest. */
export async function collectRun(reader: ObserverReader, work_run_ref: string): Promise<RunObservation> {
  const summaries = await attempt(() => reader.listEvidence(work_run_ref));
  const effectIds = await attempt(() => reader.listEffects(work_run_ref));

  const envelopes: Record<string, Query<EvidenceEnvelopeV1>> = {};
  if (summaries.query === "COMPLETE") {
    for (const s of summaries.value.evidence) {
      const fetched = await attempt(() => reader.getEvidence(s.evidence_id));
      envelopes[s.evidence_id] = fetched.query === "COMPLETE" ? { query: "COMPLETE", value: fetched.value.envelope } : fetched;
    }
  }
  const effects: EffectProjection[] = [];
  if (effectIds.query === "COMPLETE") {
    for (const id of effectIds.value.effect_ids) {
      effects.push(projectEffect(id, await attempt(() => reader.getEffectState(id))));
    }
  }
  // Evidence cited by the run's admission inputs (VERIFICATION/REVIEW/HUMAN_DECISION bind to
  // repo+sha or effect subjects, not to the work-run subject, so the subject listing alone
  // misses them — measured in the first live pilot of this projection).
  for (const effect of effects) {
    if (effect.state.query !== "COMPLETE") continue;
    for (const input of effect.state.value.inputs) {
      for (const ref of (input as { evidence_refs?: ReadonlyArray<{ readonly evidence_id: string }> }).evidence_refs ?? []) {
        if (envelopes[ref.evidence_id] !== undefined) continue;
        const fetched = await attempt(() => reader.getEvidence(ref.evidence_id));
        envelopes[ref.evidence_id] = fetched.query === "COMPLETE" ? { query: "COMPLETE", value: fetched.value.envelope } : fetched;
      }
    }
  }
  return {
    summaries,
    effectIds,
    envelopes,
    byKind: (kind: string) =>
      Object.values(envelopes).flatMap((q) => (q.query === "COMPLETE" && q.value.evidence_kind === kind ? [q.value] : [])),
    effects,
  };
}

/** Causal WORK_STEP chain continuity: every ordinal after the first must name its predecessor's digest. */
export function chainProjection(steps: EvidenceEnvelopeV1[]): { ordinals: number[]; breaks: string[] } {
  const sorted = [...steps].sort(
    (a, b) => (a.claim as { step_ordinal: number }).step_ordinal - (b.claim as { step_ordinal: number }).step_ordinal,
  );
  const breaks: string[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const claim = sorted[i]!.claim as { step_ordinal: number; prior_step_envelope_digest?: string };
    const prior = sorted[i - 1]!;
    if (claim.prior_step_envelope_digest !== prior.envelope_digest.value) {
      breaks.push(`step ${claim.step_ordinal} does not name step ${(prior.claim as { step_ordinal: number }).step_ordinal}'s envelope digest`);
    }
  }
  return { ordinals: sorted.map((s) => (s.claim as { step_ordinal: number }).step_ordinal), breaks };
}

/** #97 minimal failure-attribution projection: per-surface facts + one derived, non-authoritative domain. */
export function attribution(run: RunObservation): Record<string, unknown> {
  const backend = run.byKind("BACKEND_EXECUTION").map((e) => {
    if (e.availability !== "PRESENT") return { evidence_id: e.evidence_id, observed: "UNKNOWN", unknown_reason: e.unknown_reason };
    const claim = e.claim as { requested?: unknown; observed?: unknown };
    // requested and observed are NEVER merged; a PRESENT observed fact carries its locator.
    return { evidence_id: e.evidence_id, requested: claim.requested, observed: claim.observed };
  });
  // #259 P0b: the review body pair rides along so a reader of this projection can fetch the FULL
  // reviewer text (kernel CAS get by body_cas_key) and re-digest it against body_digest. The text
  // itself is not inlined here — a projection reports where the bytes are, it does not restate them.
  const verdicts = run.byKind("REVIEW").map((e) => {
    const claim = e.claim as { verdict?: string; body_digest?: string; body_cas_key?: string } | undefined;
    return {
      evidence_id: e.evidence_id,
      subject: e.subject_bindings.map((b) => `${b.namespace}:${b.object_id}`),
      verdict: claim?.verdict,
      body_digest: claim?.body_digest,
      body_cas_key: claim?.body_cas_key,
    };
  });
  const verification = run.byKind("VERIFICATION").map((e) => ({
    evidence_id: e.evidence_id,
    availability: e.availability,
    conclusion: e.availability === "PRESENT" ? (e.claim as { conclusion?: string }).conclusion : undefined,
    unknown_reason: e.unknown_reason,
  }));
  const stops = run.byKind("WORK_BOUND_STOP").map((e) => (e.claim as { bound: string }).bound);
  const denied = run.effects.filter((e) => e.latest_decision?.outcome === "DENY");
  const unknowns = run.effects.filter((e) => e.open_unknown);

  let domain = "COMPLETED_OR_IN_PROGRESS";
  if (unknowns.length > 0) domain = "TARGET_AMBIGUOUS";
  else if (humanWait(run.effects).length > 0) domain = "HUMAN_POLICY_WAIT";
  else if (denied.length > 0) domain = "POLICY_DENIED";
  else if (stops.some((b) => b.startsWith("MALFORMED_BOUNDS"))) domain = "MALFORMED_BOUNDS";
  else if (stops.length > 0) domain = "BOUNDED_STOP";
  else if (verification.some((v) => v.conclusion === "failure")) domain = "VERIFICATION_FAILURE";
  else if (verdicts.some((v) => v.verdict === "REQUEST_CHANGES")) domain = "REVIEW_REQUEST_CHANGES";

  return {
    projection: "cadp.failure-attribution.v1 (non-authoritative, derived from K1-K7 rows)",
    derived_domain: domain,
    backend_execution: backend,
    verification,
    review: verdicts,
    bound_stops: stops,
    denied_effects: denied.map((e) => ({ effect_id: e.effect_id, reasons: e.latest_decision?.reason_codes })),
    open_unknown_effects: unknowns.map((e) => e.effect_id),
  };
}
