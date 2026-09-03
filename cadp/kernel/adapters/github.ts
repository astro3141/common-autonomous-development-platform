/**
 * GitHub TargetAdapterV1 (TD §6.4 development reference): GIT_PUSH (NATIVE_CAS via
 * expected_old_sha), PR_CREATE (PEP_READ_THEN_ACT behind the candidate-ref immutability
 * attestation), PR_MERGE (NATIVE_CAS via the merge API `sha` field). Candidate refs are
 * write-once `refs/heads/cadp/candidate/<sha>` (§4.6 item 2). Outcome truth follows §6.3:
 * receipts bind through target-native material-derived fields; PR_CREATE declares
 * `no_effect_proof_supported = false` (U5) so post-send ambiguity stays UNKNOWN.
 */

import { Cas } from "../cas.ts";
import type { SubjectBinding, TargetRef } from "../records.ts";
import { MaterialIncomplete } from "./types.ts";
import type {
  AdapterOperation, DispatchResult, ReconcileResult, RevisionRead, TargetAdapterV1, TargetIdentityClaim,
} from "./types.ts";

/** Transport seam: live impl talks to api.github.com + git; tests script it. */
export interface GitHubTransport {
  api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
  /** git push of exactly `new_sha:ref` with force-with-lease semantics, from a verified bundle. */
  push(repo_id: string, ref: string, new_sha: string, expected_old_sha: string, bundleBytes: Uint8Array): Promise<
    | { kind: "ok" }
    | { kind: "rejected"; detail: string } // definitive expected-old-sha mismatch / non-fast-forward
    | { kind: "ambiguous"; detail: string }
  >;
  /** Verify bundle bytes: single tip that IS new_sha (§6.6). Returns undefined when ok, else the defect. */
  verifyBundle(bundleBytes: Uint8Array, new_sha: string): Promise<string | undefined>;
  whoami(): Promise<{ account_id: string; login: string }>;
  repo(repo_id: string): Promise<{ repo_id: string; full_name: string; permissions: Record<string, unknown> } | undefined>;
}

const ZERO_SHA = "0000000000000000000000000000000000000000";

export class GitHubAdapter implements TargetAdapterV1 {
  readonly transport: GitHubTransport;
  readonly cas: Cas;
  readonly repoId: string;
  readonly attestationFresh: () => boolean;

  constructor(transport: GitHubTransport, cas: Cas, repoId: string, attestationFresh: () => boolean) {
    this.transport = transport;
    this.cas = cas;
    this.repoId = repoId;
    this.attestationFresh = attestationFresh;
  }

  describe(): { target_type: string; authority_ref: string; operations: readonly AdapterOperation[] } {
    // §4.6 item 2: PR_CREATE is unavailable without a fresh TARGET_IMMUTABILITY_ATTESTATION.
    const prCreateAvailable = this.attestationFresh();
    return {
      target_type: "GIT_REPOSITORY",
      authority_ref: "github.com",
      operations: [
        {
          operation_kind: "GIT_PUSH", material_schema: "cadp.git-push.v1", available: true,
          idempotency: "NATIVE_PRECONDITION", dispatch_precondition: "NATIVE_CAS",
          reconcile: "BY_QUERY_PREDICATE", no_effect_proof_supported: false,
        },
        {
          operation_kind: "PR_CREATE", material_schema: "cadp.pr-create.v1", available: prCreateAvailable,
          idempotency: "NONE", dispatch_precondition: "PEP_READ_THEN_ACT",
          reconcile: "BY_QUERY_PREDICATE", no_effect_proof_supported: false,
        },
        {
          operation_kind: "PR_MERGE", material_schema: "cadp.pr-merge.v1", available: true,
          idempotency: "NATIVE_PRECONDITION", dispatch_precondition: "NATIVE_CAS",
          reconcile: "BY_OPERATION_REF", no_effect_proof_supported: false,
        },
      ],
    };
  }

  serialization_domain(material: Record<string, unknown>): string {
    return `github:${String(material["repo_id"] ?? this.repoId)}`;
  }

  async prove_identity(): Promise<TargetIdentityClaim> {
    const who = await this.transport.whoami();
    const repo = await this.transport.repo(this.repoId);
    if (repo === undefined) throw new Error(`credential does not reach repo ${this.repoId}`);
    return {
      target_ref: { authority_ref: "github.com", target_type: "GIT_REPOSITORY", target_id: repo.repo_id },
      claim: { account_id: who.account_id, login: who.login, full_name: repo.full_name, permissions: repo.permissions },
    };
  }

  async current_revision(subject: SubjectBinding): Promise<RevisionRead> {
    // Read-only probe for commit/ref subjects (recheck #3).
    if (subject.namespace === "commit") {
      const res = await this.transport.api("GET", `/repos/${this.repoId}/git/commits/${subject.object_id}`);
      return res.status === 200
        ? { revision_or_version: subject.object_id, availability: "PRESENT" }
        : { availability: "UNKNOWN" };
    }
    if (subject.namespace === "ref") {
      const res = await this.transport.api("GET", `/repos/${this.repoId}/git/ref/${encodeURIComponent(subject.object_id)}`);
      const sha = (res.json as { object?: { sha?: string } })?.object?.sha;
      return res.status === 200 && sha !== undefined
        ? { revision_or_version: sha, availability: "PRESENT" }
        : { availability: "UNKNOWN" };
    }
    return { availability: "UNKNOWN" };
  }

  async verify_material(operation_kind: string, material: Record<string, unknown>): Promise<void> {
    if (operation_kind === "GIT_PUSH") {
      const ref = String(material["ref"]);
      const newSha = String(material["new_sha"]);
      const expectedOld = String(material["expected_old_sha"]);
      // Write-once candidate rule (§4.6 item 2): the ref name IS the sha; no update, no delete.
      if (ref.startsWith("refs/heads/cadp/candidate/")) {
        if (ref !== `refs/heads/cadp/candidate/${newSha}`) {
          throw new MaterialIncomplete(`candidate ref ${ref} does not name its own sha ${newSha}`);
        }
        if (expectedOld !== ZERO_SHA) {
          throw new MaterialIncomplete("candidate refs are write-once: expected_old_sha must be the zero sha");
        }
      }
      const bundleBytes = this.cas.get(String(material["bundle_cas_key"]));
      const defect = await this.transport.verifyBundle(bundleBytes, newSha);
      if (defect !== undefined) throw new MaterialIncomplete(`git bundle: ${defect}`);
    }
    if (operation_kind === "PR_CREATE") {
      const headRef = String(material["head_ref"]);
      const headSha = String(material["head_sha"]);
      if (headRef !== `refs/heads/cadp/candidate/${headSha}`) {
        throw new MaterialIncomplete(`PR_CREATE head_ref must be the write-once candidate ref of head_sha`);
      }
      this.cas.get(String(material["title_cas_key"]));
      this.cas.get(String(material["body_cas_key"]));
    }
  }

  async dispatch_precondition_read(operation_kind: string, material: Record<string, unknown>): Promise<string | undefined> {
    if (operation_kind !== "PR_CREATE") return undefined;
    // Inside lock D, before K6: the candidate ref must sit exactly at head_sha.
    const headRef = String(material["head_ref"]);
    const res = await this.transport.api("GET", `/repos/${this.repoId}/git/ref/${encodeURIComponent(headRef.replace(/^refs\//u, ""))}`);
    const sha = (res.json as { object?: { sha?: string } })?.object?.sha;
    if (res.status !== 200 || sha === undefined) return `head_ref ${headRef} unreadable (status ${res.status})`;
    if (sha !== material["head_sha"]) return `head_ref at ${sha}, admitted binding ${material["head_sha"]}`;
    return undefined;
  }

  async dispatch(
    _effect_id: string,
    _ordinal: number,
    _target: TargetRef,
    operation_kind: string,
    material: Record<string, unknown>,
  ): Promise<DispatchResult> {
    switch (operation_kind) {
      case "GIT_PUSH":
        return this.#dispatchPush(material);
      case "PR_CREATE":
        return this.#dispatchPrCreate(material);
      case "PR_MERGE":
        return this.#dispatchPrMerge(material);
      default:
        return { kind: "AMBIGUOUS", raw_observation: `unknown operation ${operation_kind}` };
    }
  }

  async #dispatchPush(material: Record<string, unknown>): Promise<DispatchResult> {
    const ref = String(material["ref"]);
    const newSha = String(material["new_sha"]);
    const bundleBytes = this.cas.get(String(material["bundle_cas_key"]));
    const pushed = await this.transport.push(this.repoId, ref, newSha, String(material["expected_old_sha"]), bundleBytes);
    if (pushed.kind === "ambiguous") return { kind: "AMBIGUOUS", raw_observation: pushed.detail };
    // Target-authoritative read either way (§6.4): COMMITTED only from the ref read.
    const read = await this.transport.api("GET", `/repos/${this.repoId}/git/ref/${encodeURIComponent(ref.replace(/^refs\//u, ""))}`);
    const sha = (read.json as { object?: { sha?: string } })?.object?.sha;
    if (read.status === 200 && sha === newSha) {
      return { kind: "ACCEPTED", target_operation_ref: `ref:${ref}@${newSha}`, receipt_claim: { ref, ref_sha: sha } };
    }
    if (pushed.kind === "rejected" && read.status === 200 && sha !== newSha) {
      return { kind: "REJECTED_NO_EFFECT", proof_claim: { rejection: pushed.detail, observed_ref_sha: sha ?? null } };
    }
    return { kind: "AMBIGUOUS", raw_observation: `push ${pushed.kind}; ref read status ${read.status} sha ${sha ?? "-"}` };
  }

  async #dispatchPrCreate(material: Record<string, unknown>): Promise<DispatchResult> {
    const title = Buffer.from(this.cas.get(String(material["title_cas_key"]))).toString("utf8");
    const body = Buffer.from(this.cas.get(String(material["body_cas_key"]))).toString("utf8");
    const headRef = String(material["head_ref"]);
    let res: { status: number; json: unknown };
    try {
      res = await this.transport.api("POST", `/repos/${this.repoId}/pulls`, {
        title, body,
        head: headRef.replace(/^refs\/heads\//u, ""),
        base: String(material["base_ref"]).replace(/^refs\/heads\//u, ""),
      });
    } catch (error) {
      return { kind: "AMBIGUOUS", raw_observation: error instanceof Error ? error.message : String(error) };
    }
    if (res.status === 201) {
      const pr = res.json as { number: number; head: { sha: string }; html_url?: string };
      return {
        kind: "ACCEPTED",
        target_operation_ref: `pull:${pr.number}`,
        receipt_claim: { number: pr.number, head_sha: pr.head.sha, html_url: pr.html_url ?? null },
      };
    }
    // U5: no authoritative no-effect proof for a sent create; everything else stays ambiguous.
    return { kind: "AMBIGUOUS", raw_observation: `POST /pulls status ${res.status}: ${JSON.stringify(res.json).slice(0, 200)}` };
  }

  async #dispatchPrMerge(material: Record<string, unknown>): Promise<DispatchResult> {
    const prNumber = Number(material["pr_number"]);
    const expected = String(material["expected_head_sha"]);
    let res: { status: number; json: unknown };
    try {
      res = await this.transport.api("PUT", `/repos/${this.repoId}/pulls/${prNumber}/merge`, {
        sha: expected,
        merge_method: String(material["merge_method"] ?? "merge"),
      });
    } catch (error) {
      return { kind: "AMBIGUOUS", raw_observation: error instanceof Error ? error.message : String(error) };
    }
    if (res.status === 200) {
      const merged = res.json as { sha?: string; merged?: boolean };
      const read = await this.transport.api("GET", `/repos/${this.repoId}/pulls/${prNumber}`);
      const pr = read.json as { merged?: boolean; merge_commit_sha?: string; head?: { sha?: string } };
      if (read.status === 200 && pr.merged === true) {
        return {
          kind: "ACCEPTED",
          target_operation_ref: `merge:${pr.merge_commit_sha ?? merged.sha ?? ""}`,
          receipt_claim: { merged: true, merge_commit_sha: pr.merge_commit_sha ?? merged.sha ?? null, head_sha: pr.head?.sha ?? null },
        };
      }
      return { kind: "AMBIGUOUS", raw_observation: `merge 200 but confirm read status ${read.status}` };
    }
    if (res.status === 409) {
      // NATIVE_CAS: the target's definitive head-mismatch rejection + a confirming read.
      const read = await this.transport.api("GET", `/repos/${this.repoId}/pulls/${prNumber}`);
      const pr = read.json as { merged?: boolean };
      if (read.status === 200 && pr.merged === false) {
        return { kind: "REJECTED_NO_EFFECT", proof_claim: { status: 409, merged: false, detail: JSON.stringify(res.json).slice(0, 200) } };
      }
      return { kind: "AMBIGUOUS", raw_observation: `409 but confirm read ${read.status} merged ${pr.merged}` };
    }
    return { kind: "AMBIGUOUS", raw_observation: `merge status ${res.status}` };
  }

  async reconcile(
    _effect_id: string,
    _ordinal: number,
    _target: TargetRef,
    operation_kind: string,
    material: Record<string, unknown>,
  ): Promise<ReconcileResult> {
    try {
      if (operation_kind === "GIT_PUSH") {
        const ref = String(material["ref"]);
        const read = await this.transport.api("GET", `/repos/${this.repoId}/git/ref/${encodeURIComponent(ref.replace(/^refs\//u, ""))}`);
        const sha = (read.json as { object?: { sha?: string } })?.object?.sha;
        if (read.status === 200 && sha === material["new_sha"]) {
          return { kind: "COMMITTED", target_operation_ref: `ref:${ref}@${sha}`, receipt_claim: { ref, ref_sha: sha } };
        }
        // A ref read alone is UNKNOWN(REF_UNCHANGED_UNPROVEN) (§6.4).
        return { kind: "UNKNOWN", unknown_reason: `REF_UNCHANGED_UNPROVEN: read status ${read.status} sha ${sha ?? "-"}` };
      }
      if (operation_kind === "PR_CREATE") {
        const headSha = String(material["head_sha"]);
        const headRef = String(material["head_ref"]).replace(/^refs\/heads\//u, "");
        const owner = await this.#ownerLogin();
        const matches: Array<{ number: number; head: { sha: string }; html_url?: string }> = [];
        for (let page = 1; page <= 20; page += 1) {
          const res = await this.transport.api("GET", `/repos/${this.repoId}/pulls?state=all&head=${encodeURIComponent(`${owner}:${headRef}`)}&per_page=100&page=${page}`);
          if (res.status !== 200) return { kind: "UNKNOWN", unknown_reason: `pulls list status ${res.status}` };
          const items = res.json as Array<{ number: number; head: { sha: string }; html_url?: string }>;
          matches.push(...items.filter((p) => p.head.sha === headSha));
          if (items.length < 100) break;
        }
        if (matches.length === 1) {
          const pr = matches[0]!;
          return {
            kind: "COMMITTED",
            target_operation_ref: `pull:${pr.number}`,
            receipt_claim: { number: pr.number, head_sha: pr.head.sha, html_url: pr.html_url ?? null },
          };
        }
        // no_effect_proof_supported = false (U5): zero matches stays UNKNOWN after a sent call.
        return { kind: "UNKNOWN", unknown_reason: `pulls list matched ${matches.length} for head ${headSha}` };
      }
      if (operation_kind === "PR_MERGE") {
        const prNumber = Number(material["pr_number"]);
        const read = await this.transport.api("GET", `/repos/${this.repoId}/pulls/${prNumber}`);
        const pr = read.json as { merged?: boolean; merge_commit_sha?: string; head?: { sha?: string } };
        if (read.status === 200 && pr.merged === true) {
          return {
            kind: "COMMITTED",
            target_operation_ref: `merge:${pr.merge_commit_sha ?? ""}`,
            receipt_claim: { merged: true, merge_commit_sha: pr.merge_commit_sha ?? null, head_sha: pr.head?.sha ?? null },
          };
        }
        return { kind: "UNKNOWN", unknown_reason: `merged=${pr.merged} (a bare read is not a no-effect proof)` };
      }
    } catch (error) {
      return { kind: "UNKNOWN", unknown_reason: error instanceof Error ? error.message : String(error) };
    }
    return { kind: "UNKNOWN", unknown_reason: `unknown operation ${operation_kind}` };
  }

  async #ownerLogin(): Promise<string> {
    const repo = await this.transport.repo(this.repoId);
    return repo?.full_name.split("/")[0] ?? "";
  }

  receipt_binds(operation_kind: string, material: Record<string, unknown>, receipt: Record<string, unknown>): boolean {
    // §6.4: at least one target-native receipt field is a function of the material.
    if (operation_kind === "GIT_PUSH") return receipt["ref_sha"] === material["new_sha"];
    if (operation_kind === "PR_CREATE") return receipt["head_sha"] === material["head_sha"];
    if (operation_kind === "PR_MERGE") {
      return receipt["merge_commit_sha"] !== null && receipt["head_sha"] === material["expected_head_sha"];
    }
    return false;
  }
}
