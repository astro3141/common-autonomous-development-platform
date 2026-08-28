/**
 * The run-scoped SUPERVISOR CapabilityGrant (TD §12.4, §13.4, §18.1a).
 *
 * §13.4 puts exactly one Core step between opening a run and asking the Supervisor anything: the
 * run's SUPERVISOR grant is issued **after** run initialization and **before** the first
 * `spawn_session`. This is that step, and deliberately nothing more.
 *
 * Three things it does not do, because each is already owned elsewhere:
 *
 *   **It derives nothing.** The requested map, the enforcement map and the grant hash all come out
 *   of the §12.5 Broker, so §12.4's rule — the Supervisor requests all twelve capabilities as
 *   `false` — keeps exactly one implementation. A caller may invoke this use-case; a caller that
 *   computed a grant of its own could widen what the Supervisor is authorized to do, which is why
 *   the derivation is not reachable from anywhere but here and the Task Contract builder.
 *
 *   **It introduces no durable shape.** The row is the existing `capability_grant` one at run
 *   scope (`run_id` non-null, `attempt_key` null), whose partial unique index is what makes "one
 *   SUPERVISOR grant per run" a database fact rather than a convention.
 *
 *   **It enforces nothing.** Enforcement is the Runtime's and is checked against the spawn receipt
 *   (§12.6) by `supervisor-session.ts`, which loads this grant and never re-derives it.
 *
 * It lives in admission because §13.4 places it in run admission — after the run is opened and
 * before any Supervisor external effect — and because admission is where the ownership contract
 * puts issuance and persistence. It is the one grant write admission may make; the attempt-scoped
 * ACTOR/AUDITOR pair still reaches the store only through the state machine (§12.7).
 */

import { issueCapabilityGrant } from "../capability/broker.ts";
import { validateManifestSet, type ManifestSetInput } from "../capability/manifest-set.ts";
import type { CapabilityGrantV1Body, TaskContractCapabilityView } from "../capability/types.ts";
import type { CompiledProfileV1Body } from "../profile/types.ts";
import { StoreError } from "../store/errors.ts";
import type { PlatformStore } from "../store/platform-store.ts";

/** TD §12.5 — the CoreExecutionRole, and the only one anchored to a run rather than an attempt. */
const SUPERVISOR_ROLE = "SUPERVISOR";

/**
 * TD §12.7 — the seam is a required Broker input that v1 derivation reads nothing from. A run has
 * no Task Contract, so the view is empty: that is the absence of a scope, not a scope decision.
 */
const NO_TASK_CONTRACT_VIEW: TaskContractCapabilityView = {
  repository_scope: { allowed_paths: [], forbidden_paths: [] },
};

export interface SupervisorGrantCommand {
  readonly run_id: string;
  /**
   * Caller-allocated ULID (TD §6.1, §12.5). It is used only when the run has no grant yet — on
   * re-entry the identity the run already carries wins, so a fresh allocator cannot fork it.
   */
  readonly grant_id: string;
  /** The four component manifests as observed now. Validated here, never trusted pre-validated. */
  readonly manifests: ManifestSetInput;
}

export interface SupervisorGrantResult {
  readonly grant_id: string;
  readonly grant_hash: string;
  readonly body: CapabilityGrantV1Body;
  /** `false` when the run already held this grant and the call reused it. */
  readonly issued: boolean;
}

/**
 * Issues — or re-reads — the one SUPERVISOR grant of one run.
 *
 * Safe to call again: a run that already holds its grant gets the same logical grant back, and a
 * run whose material inputs have moved since gets a closed failure rather than a second grant.
 * Every failure is a failure the store or the capability module already defines, and none of them
 * leaves a row behind — the write is the last thing that happens, inside one transaction.
 */
export function issueSupervisorGrant(
  store: PlatformStore,
  command: SupervisorGrantCommand,
): SupervisorGrantResult {
  // §13.4's ordering as a precondition rather than a comment: no run, no grant. The store raises
  // its own typed failure, before anything is derived and before anything is written.
  const run = store.runs.require(command.run_id);
  // §18.1a — the run's own frozen Compiled Profile, re-hashed on load. Policy is the Broker's only
  // non-Backend input, and §12.4 leaves it nothing to decide for this role.
  const compiled = store.compiledProfiles.require(run.compiled_profile_hash);
  const manifests = validateManifestSet(command.manifests);

  const existing = store.grants
    .forRun(command.run_id)
    .find((row) => row.role === SUPERVISOR_ROLE);

  const grant = issueCapabilityGrant({
    grant_id: existing?.grant_id ?? command.grant_id,
    role: SUPERVISOR_ROLE,
    effective_policy: (compiled.body as unknown as CompiledProfileV1Body).effective.policy,
    runtime_manifest: manifests.runtime,
    task_contract_capability_view: NO_TASK_CONTRACT_VIEW,
  });

  if (existing !== undefined) {
    // Same material inputs ⇒ same envelope ⇒ same hash. A different hash means an input moved
    // under a run that is already authorized, and no second grant may paper over that.
    if (existing.grant_hash !== grant.grant_hash) {
      // The same identity re-derived to different content: §18.1a's own conflict, raised here
      // because reuse never reaches `put()`.
      throw new StoreError(
        "ARTIFACT_CONFLICT",
        `run ${command.run_id} already holds SUPERVISOR grant ${existing.grant_id}, which the current inputs do not reproduce`,
      );
    }
    // §18.1a — the store re-hashes the envelope on load, so reuse returns the durable grant and a
    // corrupt record never becomes authority.
    const stored = store.grants.get(existing.grant_id);
    if (stored === undefined) {
      throw new StoreError(
        "DOMAIN_ROW_MISSING",
        `SUPERVISOR grant ${existing.grant_id} is indexed for run ${command.run_id} but did not load`,
      );
    }
    return {
      grant_id: existing.grant_id,
      grant_hash: existing.grant_hash,
      body: stored.body as unknown as CapabilityGrantV1Body,
      issued: false,
    };
  }

  store.withTransaction(() => {
    // A second SUPERVISOR row for the same run is refused by §18.1a's partial unique index, and a
    // `grant_id` another run already holds is refused by the store's anchor check — `run_id` is not
    // in the envelope, so without it an identical grant would be swallowed as an idempotent no-op
    // and this run would hold no grant at all. Either way the transaction leaves nothing behind.
    store.grants.put(grant, { kind: "RUN", run_id: command.run_id });
  });
  return {
    grant_id: grant.body.grant_id,
    grant_hash: grant.grant_hash,
    body: grant.body,
    issued: true,
  };
}
