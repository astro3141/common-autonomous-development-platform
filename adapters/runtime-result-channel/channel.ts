/**
 * RuntimeResultChannel — the Backend v1 structured-result transport (TD §13.2, RA-2b).
 *
 * The problem this solves is narrow and specific. A managed agent reaches the host's plugin tools
 * over MCP in a **subprocess that the bridge spawns once per session**, with the session identity
 * injected into its environment. That gives a submitting tool a host-authoritative *session*, and
 * nothing else — the agent talks to that subprocess directly, so there is no per-call hook where
 * the host could add turn identity, and the gateway's own active-turn map lives in another process.
 *
 * So the turn binding is established from the other side. The adapter **arms** a slot for the turn
 * it is about to start; the tool writes into whatever slot is armed for the session it was spawned
 * with; the adapter **collects** only if the slot still carries the turn it armed, then closes it.
 * The model supplies the payload and never an identity: it cannot name a turn, cannot reach another
 * session's slot, and cannot make a write from an earlier turn count for a later one.
 *
 * Everything here is ephemeral and lives outside every repository, so a submitted result can never
 * appear in a candidate diff (I-TD6). Nothing in it is Core: Core sees only `RuntimeTurnResult`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalize, type CanonicalObject } from "../../core/schemas/canonical-json.ts";
import { validateAuditorVerdict } from "../../core/store/mvp1-artifact-stores.ts";

/** TD §16.2 — the one protocol RA-2b must carry. */
export const AUDITOR_VERDICT_PROTOCOL = "platform-auditor-verdict-v1";

/**
 * What the adapter armed. `armed_turn` is host-generated: the submitting side reads it out of the
 * slot rather than presenting one, so a model has nothing it could name, guess or replay.
 */
interface SlotFile {
  readonly armed_turn: string;
  readonly result?: { readonly protocol: string; readonly body: CanonicalObject };
}

export interface CollectedResult {
  readonly protocol: string;
  readonly body: CanonicalObject;
}

export type SubmitOutcome =
  | { readonly accepted: true; readonly replayed: boolean }
  /** Fail-closed. The reason is adapter-local diagnostics; no partial result is ever stored. */
  | { readonly accepted: false; readonly reason: SubmitRejection };

export type SubmitRejection =
  | "NO_ACTIVE_TURN"
  | "UNKNOWN_PROTOCOL"
  | "MALFORMED_BODY"
  | "ALREADY_SUBMITTED";

/** A second turn armed on a session that still holds an uncollected one. Never silently replaced. */
export class ResultChannelConflict extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ResultChannelConflict";
  }
}

export class RuntimeResultChannel {
  readonly #root: string;

  /**
   * @param root a host-owned ephemeral directory. It must not be inside any repository the Actor or
   *   Auditor can see; the caller owns that choice, and the tests hold it to it.
   */
  constructor(root: string) {
    this.#root = root;
  }

  /**
   * Opens the slot for one turn. The turn mark is the adapter's own; the submitting side reads it
   * from the slot rather than being told it, so no identity travels through the model.
   */
  arm(session_ref: string, turn: string): void {
    if (session_ref.length === 0 || turn.length === 0) {
      throw new ResultChannelConflict("a slot needs a session and a turn");
    }
    const existing = this.#read(session_ref);
    if (existing !== undefined && existing.armed_turn !== turn) {
      // §11 — one managed turn at a time. A second concurrent arm is a contradiction, not a
      // replacement: silently dropping the first would make the earlier turn's result collectable
      // by the later one.
      throw new ResultChannelConflict(
        `a slot is already armed for this session and has not been collected`,
      );
    }
    if (existing === undefined) this.#write(session_ref, { armed_turn: turn });
  }

  /**
   * Called from the submitting side, which knows its session because the host put it there. There
   * is deliberately no turn argument: the target is whatever this session currently has armed.
   */
  submit(session_ref: string, protocol: string, body: unknown): SubmitOutcome {
    const slot = this.#read(session_ref);
    // No armed turn — a submission outside a turn, or after its result was collected and the slot
    // closed. Either way there is nothing it could legitimately be the result of.
    if (slot === undefined) return { accepted: false, reason: "NO_ACTIVE_TURN" };

    if (protocol !== AUDITOR_VERDICT_PROTOCOL) {
      return { accepted: false, reason: "UNKNOWN_PROTOCOL" };
    }
    let validated: CanonicalObject;
    try {
      // §31 — protocol identity and envelope structure only. Whether the verdict *agrees with the
      // attempt* is a Coordinator question and is deliberately not asked here.
      validated = validateAuditorVerdict(body) as unknown as CanonicalObject;
    } catch {
      // §19 — nothing "close enough" is kept, and no partial parse becomes authority.
      return { accepted: false, reason: "MALFORMED_BODY" };
    }

    const canonical = canonicalize(validated);
    if (slot.result !== undefined) {
      // §15 — a replay of the identical verdict is harmless; a different one must not overwrite.
      return slot.result.protocol === protocol && canonicalize(slot.result.body) === canonical
        ? { accepted: true, replayed: true }
        : { accepted: false, reason: "ALREADY_SUBMITTED" };
    }

    this.#write(session_ref, { armed_turn: slot.armed_turn, result: { protocol, body: validated } });
    return { accepted: true, replayed: false };
  }

  /**
   * Reads the result for one turn. A slot armed for a *different* turn yields nothing — that is
   * what stops a write from an earlier turn being read as a later turn's result.
   */
  collect(session_ref: string, turn: string): CollectedResult | undefined {
    const slot = this.#read(session_ref);
    if (slot === undefined || slot.armed_turn !== turn) return undefined;
    return slot.result;
  }

  /** Closes the slot. After this, a late submission for that turn has nowhere to land. */
  close(session_ref: string, turn: string): void {
    const slot = this.#read(session_ref);
    if (slot === undefined || slot.armed_turn !== turn) return;
    rmSync(this.#path(session_ref), { force: true });
  }

  // --- storage ------------------------------------------------------------------------------

  /**
   * The file name is a digest of the session key, so the directory listing carries no session
   * identity and nothing privileged is written to disk under its own name (I-TD7).
   */
  #path(session_ref: string): string {
    return join(this.#root, `${createHash("sha256").update(session_ref).digest("hex")}.json`);
  }

  #read(session_ref: string): SlotFile | undefined {
    const path = this.#path(session_ref);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as SlotFile;
    } catch {
      // An unreadable slot is treated as no slot: fail closed rather than guess a turn's result.
      return undefined;
    }
  }

  /** Atomic replace, so a reader never sees a half-written slot. */
  #write(session_ref: string, slot: SlotFile): void {
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    const path = this.#path(session_ref);
    const staging = `${path}.writing`;
    writeFileSync(staging, JSON.stringify(slot), { encoding: "utf8", mode: 0o600 });
    renameSync(staging, path);
  }
}
