/**
 * Opaque Core-facing handles and boundary types.
 *
 * TD I-TD5/§13.3/§6.1: Core owns opaque handles only. A backend-native representation
 * (runtime session identity, workflow id, …) never appears in a generic type — those live in
 * adapter-owned metadata. Each handle below is therefore a *nominal boundary with no members*:
 * the brand exists only at type level and has no runtime representation, so no field shape is
 * invented for a type whose shape the documents have not fixed.
 */

declare const OpaqueTag: unique symbol;

/** A distinct type with no readable structure. Adapters produce them; Core only passes them on. */
export interface Opaque<Tag extends string> {
  readonly [OpaqueTag]: Tag;
}

/** Spec §27 — handle for a Runtime session. */
export type RuntimeSessionHandle = Opaque<"RuntimeSessionHandle">;

/** Spec §27 — handle for one turn within a Runtime session. */
export type RuntimeTurnHandle = Opaque<"RuntimeTurnHandle">;

/**
 * Spec §27 — result of `get_session_status`.
 *
 * The concrete field vocabulary is **not defined by Spec or TD** and no MVP 0 acceptance
 * consumes it. It stays a return-type boundary here: no lifecycle enum is invented, and Core
 * must not treat any content as authoritative until a TD close-out defines it (first consumer:
 * MVP 1 recovery, TD §22.2/§22.3).
 */
export type RuntimeSessionStatus = Opaque<"RuntimeSessionStatus">;

/** TD §13.3 — opaque handle for host-managed trusted workflow control. Core issues no identity. */
export type WorkflowControllerHandle = Opaque<"WorkflowControllerHandle">;

/** Spec §30 — handle for a started workflow. */
export type WorkflowHandle = Opaque<"WorkflowHandle">;

/**
 * The Spec §42 repository facts live in `repository-adapter.ts`, not here: MVP 1's first consumer
 * reads them, so TD §14.3's "동등한 typed request/result 형태" applies and they are no longer
 * structureless brands. Everything still branded below has no consumer that reads it.
 */

/** TD §10 — immutable Task Contract Snapshot; built by a later batch, a boundary type here. */
export type TaskContractSnapshot = Opaque<"TaskContractSnapshot">;

/** TD §12 — capability grant handed to a spawned session; compiled by a later batch. */
export type CapabilityGrant = Opaque<"CapabilityGrant">;

/** Spec §38 — verification profile; owned by the Project Profile, a boundary type here. */
export type VerificationProfile = Opaque<"VerificationProfile">;

/**
 * TD §15.1a (M1-9) — one verification run, owned by the VerificationAdapter.
 *
 * It exists only because that adapter's lifecycle spans the `VERIFYING` state: Core starts a run in
 * one transition and observes it in another, so the run needs an identity Core can hold. It is a
 * *distinct* boundary type from `WorkflowHandle` even when a backend's underlying value is the same
 * plain id — the type is what stops Core from calling a workflow with it. Deliberately not a
 * shared `JobHandle`: Runtime turns, workflows and CI jobs are not unified here. Like every
 * handle in this module it is admissible under I-TD7 — it carries no privileged value.
 */
export type VerificationRunHandle = Opaque<"VerificationRunHandle">;

/** Spec §29 — runtime profile selecting how a session is run; boundary type here. */
export type RuntimeProfile = Opaque<"RuntimeProfile">;

/** Spec §30 — workflow specification passed to `start`; boundary type here. */
export type WorkflowSpec = Opaque<"WorkflowSpec">;
