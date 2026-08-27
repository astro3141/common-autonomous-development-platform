/**
 * Platform Coordinator.
 *
 * Two objects, deliberately: `Coordinator` is the MVP 0 shell (TD §25 `interface + dummy`) whose
 * `observe`/`recover` surface is still the one MVP 0 acceptance uses, and `ProductionCoordinator`
 * is the MVP 1 integration (MVP1-B13) that actually drives the run. Both are caller-driven and
 * stateless; neither owns a timer, a cursor or a queue.
 */

export {
  ProductionCoordinator,
  type CoordinatorIdentities,
  type ProductionCoordinatorDependencies,
  type TickStep,
} from "./production-coordinator.ts";
export {
  deliverOneReport,
  type ReportDeliveryDependencies,
  type ReportDeliveryOutcome,
} from "./report-delivery.ts";
export { Coordinator, type CoordinatorDependencies } from "./coordinator.ts";
export { RECOVERY_CLASSIFICATIONS, type RecoveryClassification } from "./types.ts";
