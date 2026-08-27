/**
 * Discovery materialization — the seam between a generic TaskSource and the durable projection.
 *
 * A callable primitive only: nothing here is wired into a scheduler, a tick or a background loop.
 */

export {
  materializeDiscoveryPass,
  TASK_OBSERVATION_KIND,
  type DiscoveryPassCommand,
  type DiscoveryPassResult,
  type ObservationOutcome,
  type TaskObservationResult,
} from "./materialize.ts";
