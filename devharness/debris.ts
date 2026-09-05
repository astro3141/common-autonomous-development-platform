/**
 * Deterministic tracked-debris detection (issue #119 / H3).
 *
 * Automatic detection is restricted to naming conventions that are
 * unambiguous on their own — a real, permanently-committed product/config
 * file could not plausibly carry them. Round-2 review finding 3: a generic
 * "any new tsconfig.*.json" or bare "repro"/"commit-msg" substring match also
 * catches legitimate payload (`tsconfig.build.json`, a permanent regression
 * test with "repro" in its name, the real `.githooks/commit-msg` git hook —
 * which must be exactly lowercase `commit-msg` to function, never a variant).
 * Never inferred from Actor prose — a candidate must not carry these
 * regardless of what produced them.
 */
const AUTOMATIC_DEBRIS_PATTERNS: RegExp[] = [
  /^\.write-probe-/, // permission/write probe files, e.g. .write-probe-design-i106
  /^tsconfig\.(?:i?\d+|.*scratch.*)\.json$/i, // issue-scoped (tsconfig.i109.json) or literally-named-scratch tsconfig variants — never a plain named config like tsconfig.build.json
  /^COMMIT_MSG[_-]/, // upper-case scratch commit-message files, e.g. COMMIT_MSG_I109.txt — the real git hook is always exactly lowercase `commit-msg`, never this shape
]

export function isTrackedDebris(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return AUTOMATIC_DEBRIS_PATTERNS.some((re) => re.test(base))
}

/**
 * Ambiguous scratch naming (e.g. a bare "repro" substring) is never detected
 * by pattern alone: it is too common in legitimate, permanently-committed
 * regression-test names. A path in this category is only ever debris when
 * the Reviewer's own REQUEST_CHANGES findings name its literal basename —
 * the Reviewer, not a guess from filename shape, identified it for removal.
 */
export function isReviewerFlaggedDebris(path: string, reviewerFindings: string[] | undefined): boolean {
  if (reviewerFindings === undefined || reviewerFindings.length === 0) return false
  const base = path.split('/').pop() ?? path
  return reviewerFindings.some((finding) => finding.includes(base))
}

/**
 * H3 carve-out: a path a debris check matches is still real payload, never
 * removed, if the governing issue's own body explicitly names it. Matched on
 * the literal basename in the issue text — never inferred from Actor prose,
 * only from the issue the Harness already trusts as the governing contract.
 */
export function isExplicitlyRequiredByIssue(path: string, issueBody: string): boolean {
  const base = path.split('/').pop() ?? path
  return issueBody.includes(base)
}
