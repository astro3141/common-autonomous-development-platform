/**
 * GitHubIssuesChildMaterializer — the production `ChildTaskMaterializationAdapterV1` (#70,
 * Spec §17A / TD §8.1b, §8.4b, §21/§22 CM1–CM5) over the same repository the
 * `GitHubIssuesTaskSource` observes.
 *
 * The only external mutation this adapter can perform is the creation of **one issue** carrying
 * the exact representation-contract body (definition marker) plus the D24 correlation marker
 * (op_key / materialization id / hash). No close/reopen, no labels, milestones, projects,
 * dependency edges, parent-issue mutation, or repository/runtime/workflow reach exists here.
 *
 * Identity is the Platform's: the model never chooses an issue number, and the receipt's
 * `external_task_ref` is the number GitHub assigned. Correlation is by the exact op_key marker in
 * the issue body — never by title/body similarity.
 *
 * Reconciliation truthfulness (§8.1b):
 *
 *   COMMITTED            an issue carrying this exact op_key marker was found by authoritative
 *                        enumeration, and its marker hash matches.
 *   NO_EFFECT_CONFIRMED  a **complete** REST enumeration of every issue in the repository
 *                        (state=all, every page answered) contains no marker for this op_key.
 *                        The issues REST list is the target's authoritative record — this is not
 *                        a search-index answer and is never emitted after a partial read.
 *   UNKNOWN              any transport failure, partial enumeration, malformed page, or an
 *                        op-marked issue whose marker cannot be read coherently.
 */

import {
  MaterializationFailedError,
  type ChildMaterializationReconcileResult,
  type ChildTaskMaterializationAdapterV1,
  type ChildTaskMaterializationReceiptV1,
  type ChildTaskMaterializationRequestV1,
} from "../interfaces/child-materialization-adapter.ts";
import { normalizeTaskDefinitionBody } from "../../core/tasksource/task-definition.ts";
import type { TaskDefinitionBodyV1 } from "../../core/tasksource/types.ts";
import {
  parseMaterializationMarker,
  renderIssueBody,
  type MaterializationMarkerV1,
} from "./representation.ts";
import type { GitHubTransportV1 } from "./transport.ts";

export interface GitHubChildMaterializerConfig {
  readonly owner: string;
  readonly repo: string;
}

const PER_PAGE = 100;

interface MarkedIssue {
  readonly number: number;
  readonly marker: MaterializationMarkerV1;
  readonly html_url: string | null;
}

export class GitHubIssuesChildMaterializer implements ChildTaskMaterializationAdapterV1 {
  readonly #transport: GitHubTransportV1;
  readonly #config: GitHubChildMaterializerConfig;

  constructor(transport: GitHubTransportV1, config: GitHubChildMaterializerConfig) {
    this.#transport = transport;
    this.#config = config;
  }

  materialize_child(request: ChildTaskMaterializationRequestV1): {
    readonly status: "COMMITTED";
    readonly receipt: ChildTaskMaterializationReceiptV1;
  } {
    // The body is the Supervisor's validated §8.1a semantics, re-normalized defensively; this
    // adapter authors nothing and fills nothing in (Spec §17A). A body that cannot normalize is
    // deterministically unpublishable — a definitive no-effect failure, not a retryable INTENT.
    let body: TaskDefinitionBodyV1;
    try {
      body = normalizeTaskDefinitionBody(
        request.task_definition_body,
        "/materialize-child",
      ) as TaskDefinitionBodyV1;
    } catch (error) {
      throw new MaterializationFailedError(
        `child body cannot normalize: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Convergence before effect: if this exact op already committed, return the same receipt;
    // same op with different content is a definitive conflict. An enumeration that cannot
    // complete proves nothing — throw an ordinary error so the INTENT stays reconcilable and no
    // create is attempted over an unprovable state.
    const existing = this.#findByOpKey(request.op_key);
    if (existing !== null) {
      if (existing.marker.materialization_hash !== request.materialization_hash) {
        throw new MaterializationFailedError(
          `${request.op_key} was already committed with different materialisation content`,
        );
      }
      return { status: "COMMITTED", receipt: this.#receipt(request, existing) };
    }

    const created = this.#transport.api({
      method: "POST",
      path: `repos/${this.#config.owner}/${this.#config.repo}/issues`,
      body: {
        title: body.title,
        body: renderIssueBody(body, {
          op_key: request.op_key,
          materialization_id: request.materialization_id,
          materialization_hash: request.materialization_hash,
        }),
      },
    });
    const issue = asCreatedIssue(created);
    return {
      status: "COMMITTED",
      receipt: this.#receipt(request, {
        number: issue.number,
        html_url: issue.html_url,
        marker: {
          op_key: request.op_key,
          materialization_id: request.materialization_id,
          materialization_hash: request.materialization_hash,
        },
      }),
    };
  }

  reconcile_child_materialization(op_key: string): ChildMaterializationReconcileResult {
    let found: MarkedIssue | null;
    try {
      found = this.#findByOpKey(op_key);
    } catch {
      return { status: "UNKNOWN" };
    }
    if (found === null) return { status: "NO_EFFECT_CONFIRMED" };
    return {
      status: "COMMITTED",
      receipt: {
        materialization_id: found.marker.materialization_id,
        materialization_hash: found.marker.materialization_hash,
        external_task_ref: String(found.number),
        ...(found.html_url === null ? {} : { backend_ref: found.html_url }),
      },
    };
  }

  /**
   * Authoritative enumeration for the exact op marker. Complete or nothing: any failed or
   * malformed page throws, because "could not enumerate" must never read as "not there".
   * Two issues carrying the same op marker is an ambiguous correlation and throws too.
   */
  #findByOpKey(op_key: string): MarkedIssue | null {
    const matches: MarkedIssue[] = [];
    for (let page = 1; ; page += 1) {
      const raw = this.#transport.api({
        method: "GET",
        path: `repos/${this.#config.owner}/${this.#config.repo}/issues?state=all&per_page=${PER_PAGE}&page=${page}`,
      });
      if (!Array.isArray(raw)) {
        throw new Error(`issue enumeration page ${page} is not an array`);
      }
      for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) {
          throw new Error(`issue enumeration page ${page} carries a non-object entry`);
        }
        const record = entry as Record<string, unknown>;
        if (record["pull_request"] !== undefined) continue;
        const bodyText = typeof record["body"] === "string" ? record["body"] : "";
        const marker = parseMaterializationMarker(bodyText);
        if (marker === null || marker.op_key !== op_key) continue;
        if (typeof record["number"] !== "number") {
          throw new Error(`op-marked issue on page ${page} has no number`);
        }
        matches.push({
          number: record["number"],
          marker,
          html_url: typeof record["html_url"] === "string" ? record["html_url"] : null,
        });
      }
      if (raw.length < PER_PAGE) break;
    }
    if (matches.length > 1) {
      throw new Error(`op ${op_key} correlates to ${matches.length} issues; ambiguous`);
    }
    return matches[0] ?? null;
  }

  #receipt(
    request: ChildTaskMaterializationRequestV1,
    issue: MarkedIssue,
  ): ChildTaskMaterializationReceiptV1 {
    return {
      materialization_id: request.materialization_id,
      materialization_hash: request.materialization_hash,
      external_task_ref: String(issue.number),
      ...(issue.html_url === null ? {} : { backend_ref: issue.html_url }),
    };
  }
}

function asCreatedIssue(raw: unknown): { number: number; html_url: string | null } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("issue creation returned a non-object response");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record["number"] !== "number") {
    throw new Error("issue creation response carries no issue number");
  }
  return {
    number: record["number"],
    html_url: typeof record["html_url"] === "string" ? record["html_url"] : null,
  };
}
