/**
 * GitHub Actions as an external verification backend (#57).
 *
 * GitHub is the AUTHORITY for its own check runs, so the projection is a
 * TARGET_AUTHORITY_OBSERVATION: we read the check-run result for the exact candidate sha and
 * project it honestly — a queued/in-progress/absent run is UNKNOWN (never a failure, never a
 * pass), and only a completed run carries a conclusion. No credential is involved: the repo is
 * public and the read is unauthenticated (issue #57 boundary: actors never receive GitHub
 * credentials merely to run CI).
 */

/** The check name the repository-owned workflow (.github/workflows/cadp-verify.yml) declares. */
export const EXTERNAL_CHECK_NAME = "cadp-verify";

export type ExternalVerification =
  | { status: "UNKNOWN"; unknown_reason: string }
  | {
      status: "PRESENT";
      conclusion: string;
      check_run_id: number;
      html_url: string;
      started_at: string;
      completed_at: string;
    };

/**
 * Pure projection of the GitHub check-runs API response for one commit. Fail-closed: anything
 * that is not exactly one completed `cadp-verify` run with a conclusion projects to UNKNOWN with
 * an honest reason. Two completed runs for one sha is ambiguity, not evidence.
 */
export function projectCheckRuns(payload: unknown): ExternalVerification {
  if (typeof payload !== "object" || payload === null) return { status: "UNKNOWN", unknown_reason: "check-runs response is not an object" };
  const runs = (payload as { check_runs?: unknown }).check_runs;
  if (!Array.isArray(runs)) return { status: "UNKNOWN", unknown_reason: "check-runs response carries no check_runs array" };
  const named = runs.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && (r as { name?: unknown }).name === EXTERNAL_CHECK_NAME);
  if (named.length === 0) return { status: "UNKNOWN", unknown_reason: `no ${EXTERNAL_CHECK_NAME} check run exists for this sha (workflow absent or not yet triggered)` };
  const completed = named.filter((r) => r["status"] === "completed");
  if (completed.length === 0) return { status: "UNKNOWN", unknown_reason: `${EXTERNAL_CHECK_NAME} run is ${String(named[0]!["status"])} — not completed` };
  if (completed.length > 1) return { status: "UNKNOWN", unknown_reason: `${String(completed.length)} completed ${EXTERNAL_CHECK_NAME} runs for one sha — ambiguous, refusing to pick` };
  const run = completed[0]!;
  const conclusion = run["conclusion"];
  const id = run["id"];
  const html_url = run["html_url"];
  const started_at = run["started_at"];
  const completed_at = run["completed_at"];
  if (typeof conclusion !== "string" || typeof id !== "number" || typeof html_url !== "string" || typeof started_at !== "string" || typeof completed_at !== "string") {
    return { status: "UNKNOWN", unknown_reason: "completed run is missing conclusion/id/url/timestamps" };
  }
  return { status: "PRESENT", conclusion, check_run_id: id, html_url, started_at, completed_at };
}

/** One authoritative read of the check-runs for a sha (the broker host has GitHub reachability). */
export async function fetchExternalVerification(repo_full_name: string, sha: string): Promise<ExternalVerification> {
  let payload: unknown;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo_full_name}/commits/${sha}/check-runs?check_name=${EXTERNAL_CHECK_NAME}`, {
      headers: { "user-agent": "cadp-broker", accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { status: "UNKNOWN", unknown_reason: `check-runs read failed: HTTP ${String(res.status)}` };
    payload = await res.json();
  } catch (e) {
    return { status: "UNKNOWN", unknown_reason: `check-runs read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return projectCheckRuns(payload);
}
