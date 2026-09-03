/**
 * GitHub Issues TargetAdapterV1 for cadp.improvement-intake.v1 FINDING_PROJECT (#104 §6, R5).
 *
 * FINDING_PROJECT is a NEW deployment-declared operation kind on its OWN target type (GIT_ISSUES),
 * NOT GIT_PUSH / PR_CREATE / PR_MERGE — this adapter does not claim the PR adapter can create
 * issues. It projects an immutable Finding tip to a tracker INDEX item (a GitHub issue + comments)
 * and returns a target-native, material-derived receipt through the ordinary K3–K7 path. Index
 * projection is not implementation of the Finding subject (Option A).
 *
 * Idempotency + reconciliation are by a deterministic marker embedded in the issue body /
 * comment (`projection_key`, `rendered_content_digest`) and a full issue/comment enumeration —
 * NOT the eventually-consistent search index. Post-send lookup miss / partial pagination is
 * UNKNOWN, never NO_EFFECT_CONFIRMED by absence (§6.4).
 */

import { createHash } from "node:crypto";

import { Cas } from "../cas.ts";
import type { SubjectBinding, TargetRef } from "../records.ts";
import { MaterialIncomplete } from "./types.ts";
import type {
  AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
} from "./types.ts";
import type { GitHubTransport } from "./github.ts";
import { validateProjectionMaterial } from "../../product/improvement/contracts.ts";
import type { FindingProjectionMaterialV1 } from "../../product/improvement/contracts.ts";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const KEY_MARKER = (projection_key: string): string => `<!-- cadp-projection-key: ${projection_key} -->`;
const CONTENT_MARKER = (digest: string): string => `<!-- cadp-projection-content: ${digest} -->`;

interface IssueLite { number: number; body?: string | null; html_url?: string }
interface CommentLite { id: number; body?: string | null }

export class GitHubIssuesAdapter implements TargetAdapterV1 {
  readonly transport: GitHubTransport;
  readonly cas: Cas;
  readonly repoId: string;
  readonly idempotencyProven: boolean;

  /**
   * @param idempotencyProven declares the §13.3-proven issue-create idempotency + reconcile
   *   behavior. When false, FINDING_PROJECT is unavailable (control 15): a deployment that has not
   *   proven the behavior must not let policy ALLOW the operation.
   */
  constructor(transport: GitHubTransport, cas: Cas, repoId: string, idempotencyProven = true) {
    this.transport = transport;
    this.cas = cas;
    this.repoId = repoId;
    this.idempotencyProven = idempotencyProven;
  }

  describe(): { target_type: string; authority_ref: string; operations: readonly AdapterOperation[] } {
    return {
      target_type: "GIT_ISSUES",
      authority_ref: "github.com",
      operations: [
        {
          operation_kind: "FINDING_PROJECT",
          material_schema: "cadp.finding-projection.v1",
          available: this.idempotencyProven,
          idempotency: "NATIVE_PRECONDITION", // deterministic projection_key / content marker
          dispatch_precondition: "PEP_READ_THEN_ACT",
          reconcile: "BY_QUERY_PREDICATE",
          no_effect_proof_supported: false, // a post-send miss is UNKNOWN, never no-effect (§6.4)
        },
      ],
    };
  }

  serialization_domain(material: Record<string, unknown>): string {
    // Same index item serializes (idempotent create); distinct findings do not block each other.
    return `github-issues:${this.repoId}:${String(material["projection_key"])}`;
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    const who = await this.transport.whoami();
    return {
      target_ref: { authority_ref: "github.com", target_type: "GIT_ISSUES", target_id: this.repoId },
      claim: { account_id: who.account_id, login: who.login, repo_id: this.repoId },
    };
  }

  async current_revision(_subject: SubjectBinding): Promise<RevisionRead> {
    return { availability: "UNKNOWN" };
  }

  async verify_material(operation_kind: string, material: Record<string, unknown>): Promise<void> {
    if (operation_kind !== "FINDING_PROJECT") return;
    // Closed material shape: no smuggled non-index mutation semantics (control 20).
    const result = validateProjectionMaterial(material as unknown as FindingProjectionMaterialV1);
    if (!result.ok) throw new MaterialIncomplete(`finding-projection material invalid: ${result.errors.join("; ")}`);
    // rendered content bytes must re-digest to rendered_content_digest (§6: rendered bytes bound).
    const key = material["rendered_cas_key"];
    if (typeof key !== "string") throw new MaterialIncomplete("finding-projection material requires rendered_cas_key");
    const bytes = this.cas.get(key); // CasMissing/CasCorruption → pre-K6 refusal
    if (material["rendered_content_digest"] !== sha256(bytes)) {
      throw new MaterialIncomplete("rendered bytes do not re-digest to rendered_content_digest");
    }
  }

  async dispatch_precondition_read(operation_kind: string, material: Record<string, unknown>): Promise<string | undefined> {
    if (operation_kind !== "FINDING_PROJECT") return undefined;
    const purpose = String(material["purpose"]);
    if (purpose === "CREATE_INDEX") return undefined; // idempotent create handles existence
    // APPEND_* must target an existing index item; absence is a deterministic refusal.
    const issue = await this.#findIssue(String(material["projection_key"]));
    if (issue === undefined) return `no index issue exists for projection_key ${String(material["projection_key"])}`;
    return undefined;
  }

  async dispatch(
    _effect_id: string,
    _ordinal: number,
    _target: TargetRef,
    operation_kind: string,
    material: Record<string, unknown>,
  ): Promise<DispatchResult> {
    if (operation_kind !== "FINDING_PROJECT") return { kind: "AMBIGUOUS", raw_observation: `unknown operation ${operation_kind}` };
    const projection_key = String(material["projection_key"]);
    const purpose = String(material["purpose"]);
    const rendered = Buffer.from(this.cas.get(String(material["rendered_cas_key"]))).toString("utf8");
    const contentDigest = String(material["rendered_content_digest"]);
    try {
      if (purpose === "CREATE_INDEX") return await this.#createIndex(projection_key, rendered);
      return await this.#appendComment(projection_key, contentDigest, rendered);
    } catch (error) {
      return { kind: "AMBIGUOUS", raw_observation: error instanceof Error ? error.message : String(error) };
    }
  }

  async #createIndex(projection_key: string, rendered: string): Promise<DispatchResult> {
    const existing = await this.#findIssue(projection_key);
    if (existing !== undefined) {
      // Idempotent: the index item already exists; no second issue.
      return { kind: "ACCEPTED", target_operation_ref: `issue:${existing.number}`, receipt_claim: { number: existing.number, projection_key, created: false, html_url: existing.html_url ?? null } };
    }
    const title = rendered.split("\n")[0]?.slice(0, 240) ?? `CADP finding ${projection_key.slice(0, 12)}`;
    const body = `${KEY_MARKER(projection_key)}\n\n${rendered}`;
    const res = await this.transport.api("POST", `/repos/${this.repoId}/issues`, { title, body });
    if (res.status === 201) {
      const issue = res.json as IssueLite;
      return { kind: "ACCEPTED", target_operation_ref: `issue:${issue.number}`, receipt_claim: { number: issue.number, projection_key, created: true, html_url: issue.html_url ?? null } };
    }
    // U5 for issue create: a sent POST with a non-201 stays ambiguous (no no-effect proof).
    return { kind: "AMBIGUOUS", raw_observation: `POST /issues status ${res.status}` };
  }

  async #appendComment(projection_key: string, contentDigest: string, rendered: string): Promise<DispatchResult> {
    const issue = await this.#findIssue(projection_key);
    if (issue === undefined) return { kind: "AMBIGUOUS", raw_observation: `index issue vanished for ${projection_key}` };
    const existing = await this.#findComment(issue.number, contentDigest);
    if (existing !== undefined) {
      return { kind: "ACCEPTED", target_operation_ref: `comment:${existing.id}`, receipt_claim: { number: issue.number, comment_id: existing.id, projection_key, content_digest: contentDigest, created: false } };
    }
    const body = `${CONTENT_MARKER(contentDigest)}\n\n${rendered}`;
    const res = await this.transport.api("POST", `/repos/${this.repoId}/issues/${issue.number}/comments`, { body });
    if (res.status === 201) {
      const comment = res.json as CommentLite;
      return { kind: "ACCEPTED", target_operation_ref: `comment:${comment.id}`, receipt_claim: { number: issue.number, comment_id: comment.id, projection_key, content_digest: contentDigest, created: true } };
    }
    return { kind: "AMBIGUOUS", raw_observation: `POST comment status ${res.status}` };
  }

  async reconcile(
    _effect_id: string,
    _ordinal: number,
    _target: TargetRef,
    operation_kind: string,
    material: Record<string, unknown>,
  ): Promise<ReconcileResult> {
    if (operation_kind !== "FINDING_PROJECT") return { kind: "UNKNOWN", unknown_reason: `unknown operation ${operation_kind}` };
    const projection_key = String(material["projection_key"]);
    const purpose = String(material["purpose"]);
    try {
      const issue = await this.#findIssue(projection_key);
      if (issue === undefined) {
        // Absence via enumeration is still UNKNOWN, never no-effect — an issue create may have
        // landed but not yet be visible (§6.4). No blind retry follows.
        return { kind: "UNKNOWN", unknown_reason: `no issue enumerated for projection_key ${projection_key}` };
      }
      if (purpose === "CREATE_INDEX") {
        return { kind: "COMMITTED", target_operation_ref: `issue:${issue.number}`, receipt_claim: { number: issue.number, projection_key, created: false, html_url: issue.html_url ?? null } };
      }
      const contentDigest = String(material["rendered_content_digest"]);
      const comment = await this.#findComment(issue.number, contentDigest);
      if (comment === undefined) return { kind: "UNKNOWN", unknown_reason: `no comment enumerated for content ${contentDigest}` };
      return { kind: "COMMITTED", target_operation_ref: `comment:${comment.id}`, receipt_claim: { number: issue.number, comment_id: comment.id, projection_key, content_digest: contentDigest, created: false } };
    } catch (error) {
      return { kind: "UNKNOWN", unknown_reason: error instanceof Error ? error.message : String(error) };
    }
  }

  receipt_binds(operation_kind: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    if (operation_kind !== "FINDING_PROJECT") return false;
    // Target-native, material-derived: the receipt echoes the exact projection_key it wrote under,
    // and (for APPEND) the exact rendered_content_digest.
    if (receipt["projection_key"] !== material["projection_key"]) return false;
    if (String(material["purpose"]) === "CREATE_INDEX") return typeof receipt["number"] === "number";
    return receipt["content_digest"] === material["rendered_content_digest"];
  }

  // ---- deterministic enumeration (not the eventually-consistent search index) ----

  async #findIssue(projection_key: string): Promise<IssueLite | undefined> {
    const marker = KEY_MARKER(projection_key);
    for (let page = 1; page <= 20; page += 1) {
      const res = await this.transport.api("GET", `/repos/${this.repoId}/issues?state=all&per_page=100&page=${page}`);
      if (res.status !== 200) throw new Error(`issues list status ${res.status}`);
      const items = res.json as IssueLite[];
      const found = items.find((i) => typeof i.body === "string" && i.body.includes(marker));
      if (found !== undefined) return found;
      if (items.length < 100) return undefined;
    }
    return undefined;
  }

  async #findComment(issueNumber: number, contentDigest: string): Promise<CommentLite | undefined> {
    const marker = CONTENT_MARKER(contentDigest);
    for (let page = 1; page <= 20; page += 1) {
      const res = await this.transport.api("GET", `/repos/${this.repoId}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
      if (res.status !== 200) throw new Error(`comments list status ${res.status}`);
      const items = res.json as CommentLite[];
      const found = items.find((c) => typeof c.body === "string" && c.body.includes(marker));
      if (found !== undefined) return found;
      if (items.length < 100) return undefined;
    }
    return undefined;
  }
}
