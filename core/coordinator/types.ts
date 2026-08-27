/**
 * Coordinator MVP 0 vocabularies (TD §5.6, §5.6a, §22.4).
 *
 * The MVP 0 Coordinator is an `interface + dummy` layer (§25): its whole logical surface is
 * `tick_once` / `observe` / `recover`, and the only vocabulary it owns is the recovery
 * classification — which is not new, but §22.2's existing three-way outcome promoted to a type.
 */

/**
 * TD §22.4 — exactly the three values §22.2 already uses. There is deliberately no recovery
 * *action* vocabulary (`RETRY`, `HOLD`, `PAUSE`, `RECREATE_SESSION`, …): state mutation belongs to
 * the Batch 8 transition commands, and this seam only classifies.
 */
export type RecoveryClassification = "CONSISTENT" | "EXPLAINABLE" | "UNEXPLAINED";

export const RECOVERY_CLASSIFICATIONS: readonly RecoveryClassification[] = [
  "CONSISTENT",
  "EXPLAINABLE",
  "UNEXPLAINED",
];
