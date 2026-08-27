/**
 * Folding a collected artifact into `RuntimeTurnResult` (TD §13.2, RA-2a/RA-2b).
 *
 * The terminal fact and the structured result come from two different places and stay that way:
 * `backend_status` is whatever the backend's own terminal primitive said, and this only decides
 * whether a structured artifact accompanies it. A turn that produced no valid artifact keeps the
 * `TURN_TEXT` reading — which is the correct, non-failing answer for an Actor, and the input to
 * `AUDIT_UNUSABLE` for an Auditor.
 */

import type { RuntimeTurnResult } from "../interfaces/runtime-adapter.ts";
import type { CollectedResult } from "./channel.ts";

/** Returns the result the adapter should hand Core. Never changes `backend_status`. */
export function withCollectedResult(
  base: RuntimeTurnResult,
  collected: CollectedResult | undefined,
): RuntimeTurnResult {
  if (collected === undefined) {
    return {
      ...base,
      provenance: { ...base.provenance, result_channel: "TURN_TEXT" },
    };
  }
  return {
    ...base,
    provenance: { ...base.provenance, result_channel: "RUNTIME_RESULT_CHANNEL" },
    structured_output: { protocol: collected.protocol, body: collected.body },
  };
}
