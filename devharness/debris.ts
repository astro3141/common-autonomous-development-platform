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
  // Round-3 review finding 2: a bare "repro" substring is too ambiguous
  // (matches permanent regression tests like bug123-repro-regression.test.ts)
  // and stays reviewer-flagged-only. The compound "prerepair_repro" /
  // "postrepair_repro" token, though, is a Harness-specific pre/post-repair
  // snapshot naming convention no legitimate permanent file would ever carry
  // — it must be caught automatically, before the first freeze, not only
  // after a Reviewer names it.
  /(?:^|[_-])(?:pre|post)repair[_-]?repro\.[^./]+$/i,
]

export function isTrackedDebris(path: string): boolean {
  const base = path.split('/').pop() ?? path
  return AUTOMATIC_DEBRIS_PATTERNS.some((re) => re.test(base))
}

/**
 * Ambiguous scratch naming (e.g. a bare "repro" substring, or any freeform
 * file name not covered by an unambiguous naming convention) is never
 * detected by pattern alone. Round-3 review finding 1: matching any Reviewer
 * finding prose that merely *mentions* a basename is unsound — an ordinary
 * finding like "src/widget.ts: add a null check" would then cause the
 * Harness to `git rm` the legitimate new `src/widget.ts`. A path in this
 * category is therefore only ever debris when the Reviewer used the
 * dedicated, typed `debrisPaths` output field (see prompts.ts /
 * REVIEWER_OUTPUT_SCHEMA) to explicitly designate it for deletion — never
 * inferred from occurrence inside free-text findings.
 */
export function isReviewerFlaggedDebris(path: string, reviewerDebrisPaths: string[] | undefined): boolean {
  if (reviewerDebrisPaths === undefined || reviewerDebrisPaths.length === 0) return false
  const base = path.split('/').pop() ?? path
  return reviewerDebrisPaths.some((dp) => (dp.split('/').pop() ?? dp) === base)
}

// An affirmative instruction to include/keep the file — never mere mention.
const AFFIRMATIVE_INCLUDE_VERBS = /\b(?:add|adds|adding|added|create|creates|creating|created|include|includes|including|included|require|requires|requiring|required|keep|keeps|keeping|kept|retain|retains|retaining|retained|preserve|preserves|preserving|preserved|introduce|introduces|introducing|introduced)\b/i
// A negating instruction (the opposite of a keep requirement) in the same sentence overrides any affirmative match.
const NEGATING_REMOVE_VERBS = /\b(?:remove|removes|removing|removed|delete|deletes|deleting|deleted|drop|drops|dropping|dropped|strip|strips|stripping|stripped|discard|discards|discarding|discarded)\b/i

/**
 * H3 carve-out: a path a debris check matches is still real payload, never
 * removed, if the governing issue's own body *affirmatively requires* it —
 * e.g. "add tsconfig.i124.json as permanent project config". Round-3 review
 * finding 3: a mere textual mention is not enough — an issue instructing
 * "remove COMMIT_MSG_I109.txt" must NOT be read as a requirement to keep
 * that file, so the sentence containing the basename must carry an
 * affirmative include/keep verb and no negating remove/delete verb.
 * Never inferred from Actor prose — only from the issue body the Harness
 * already trusts as the governing contract.
 */
export function isExplicitlyRequiredByIssue(path: string, issueBody: string): boolean {
  const base = path.split('/').pop() ?? path
  if (!issueBody.includes(base)) return false
  // Split on lines only, never on '.' — a basename like "tsconfig.i123.json"
  // contains periods that a naive sentence split would wrongly treat as
  // sentence boundaries, severing the verb from the filename it governs.
  const lines = issueBody.split(/\r?\n/)
  return lines.some(
    (line) => line.includes(base) && AFFIRMATIVE_INCLUDE_VERBS.test(line) && !NEGATING_REMOVE_VERBS.test(line),
  )
}
