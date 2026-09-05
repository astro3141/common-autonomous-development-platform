/**
 * Deterministic tracked-debris detection (issue #119 / H3).
 *
 * Fixed, closed set of filename patterns for permission/write probes and
 * temporary repair/checkpoint scratch files a worker (or the harness's own
 * mechanical checkpoint commit) may leave tracked. Never inferred from
 * Reviewer or Actor prose — a candidate must not carry these regardless of
 * what produced them.
 */
const DEBRIS_PATTERNS: RegExp[] = [
  /^\.write-probe-/, // permission/write probe files, e.g. .write-probe-design-i106
  /^tsconfig\..+\.json$/, // per-issue/scratch tsconfig variants, e.g. tsconfig.i109.json
  /(^|[._-])repro([._-]|$)/i, // reproduction scratch scripts, e.g. s2_prerepair_repro.ts
  /^commit[_-]?msg/i, // commit-message scratch files, e.g. COMMIT_MSG_I109.txt
]

export function isTrackedDebris(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return DEBRIS_PATTERNS.some((re) => re.test(base))
}

/**
 * H3 carve-out: a path a debris pattern matches is still real payload, never
 * removed, if the governing issue's own body explicitly names it. Matched on
 * the literal basename in the issue text — never inferred from Actor prose,
 * only from the issue the Harness already trusts as the governing contract.
 */
export function isExplicitlyRequiredByIssue(path: string, issueBody: string): boolean {
  const base = path.split('/').pop() ?? path
  return issueBody.includes(base)
}
