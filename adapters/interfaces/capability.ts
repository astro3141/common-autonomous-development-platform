/**
 * The minimum capability types a RuntimeAdapter must be able to carry (TD §12.1, §12.2, §12.6).
 *
 * This is a type boundary only. The Capability Broker, the Manifest loader, the enforcement
 * calculation and the V10 policy check all belong to a later batch — nothing here evaluates or
 * validates a receipt, it only lets one cross the adapter boundary.
 *
 * The capability vocabularies live in `core/schemas/capability-vocabulary.ts` so that Core
 * validation and this adapter boundary share one definition; they are re-exported here.
 */

import type { CapabilityName, EnforcementAssurance } from "../../core/schemas/capability-vocabulary.ts";
import type { RuntimeSessionHandle } from "./handles.ts";

export type {
  CapabilityName,
  EnforcementAssurance,
} from "../../core/schemas/capability-vocabulary.ts";

/**
 * TD §12.6 — receipt of the enforcement a Runtime actually applied at spawn time.
 *
 * Fields are exactly the TD schema. `session_handle` must equal the spawn result's handle; the
 * Coordinator checks `applied` against the grant before any turn starts (later batch).
 */
export interface CapabilityEnforcementReceipt {
  readonly receipt_id: string;
  /** `sha256:<lowercase-hex>` of the effective CapabilityGrant envelope (TD §12.5). */
  readonly grant_hash: string;
  /** `sha256:<lowercase-hex>` of the Backend Capability Manifest used. */
  readonly backend_manifest_hash: string;
  readonly session_handle: RuntimeSessionHandle;
  /** Per-capability level actually applied, in the Manifest vocabulary. */
  readonly applied: Readonly<Partial<Record<CapabilityName, EnforcementAssurance>>>;
  /** The concrete means the adapter used, e.g. tool allowlist removal or workspace confinement. */
  readonly applied_means: readonly string[];
  readonly issued_at: string;
}
