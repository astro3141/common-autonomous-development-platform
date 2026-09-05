import type { ActorRequest, ReviewRequest } from './adapters/types.ts'

/**
 * Role prompts. Design and Execution use the same worker product (Fable) but
 * are separate bounded invocations with separate role prompts and ownership.
 * The supervisor never authors design or implementation content itself.
 */

const COMMON_ACTOR_RULES = `
Hard rules:
- Work ONLY inside the current working directory (an isolated git worktree). Never touch other checkouts.
- Commit all of your changes to the current branch before finishing. Do not push. Do not create PRs. Do not merge.
- Do not modify CADP Spec or Technical Design documents unless the issue explicitly is a design task.
- If the task genuinely cannot be done without a new product-direction/design decision that is not in the landed contract, do NOT invent the missing contract: finish with signal STOP_DESIGN_REQUIRED and explain exactly what decision is missing.
- Ordinary implementation or test failures are YOUR work to fix; they are not design problems.
- Finish with the structured output signal: COMPLETE only if the work is committed and, to your knowledge, done.`

export function actorPrompt(req: ActorRequest): string {
  const role = req.lane.laneKind === 'DESIGN'
    ? `You are the Design worker for this repository. Produce the MINIMUM design artifact the issue asks for, as one or more committed markdown/document files. Inspect the existing repository contract first. Do not implement product code in this design lane.`
    : `You are the Execution Actor for this repository. Implement exactly what the issue asks for, with tests where the issue or repository conventions require them.`

  const validation = req.validationCommand
    ? `\nBefore finishing, run the validation command and make it pass: ${req.validationCommand}`
    : ''

  let taskContext = ''
  if (req.taskKind === 'repair') {
    taskContext = `
This is a bounded REPAIR round in the same lane. An independent reviewer reviewed your previous committed candidate and returned REQUEST_CHANGES with these findings:
${(req.reviewerFindings ?? []).map((f, i) => `${i + 1}. ${f}`).join('\n')}
Address every finding (or state precisely why a finding is wrong in your summary). Commit the fixes on the current branch.`
  } else if (req.taskKind === 'interrupted-resume') {
    taskContext = `
NOTE: a previous invocation for this task may have been interrupted mid-work. Inspect the worktree state (git status, git log) first, keep any good committed/uncommitted progress, and complete the task.`
  }

  return `${role}

GitHub issue #${req.issue.number}: ${req.issue.title}

Issue body:
---
${req.issue.body}
---
${taskContext}
${COMMON_ACTOR_RULES}${validation}`
}

export const ACTOR_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    signal: { type: 'string', enum: ['COMPLETE', 'STOP_DESIGN_REQUIRED'] },
    summary: { type: 'string' },
  },
  required: ['signal', 'summary'],
} as const

export function reviewerPrompt(req: ReviewRequest): string {
  const kind = req.lane.laneKind === 'DESIGN' ? 'design artifact' : 'implementation'
  return `You are an INDEPENDENT reviewer. You did not author this candidate. Review it strictly.

Candidate identity (review exactly this, nothing else):
- repository: ${req.lane.repo}
- base SHA: ${req.candidate.baseSha}
- head SHA: ${req.candidate.headSha}
- tree SHA: ${req.candidate.treeSha}
- changed files: ${req.candidate.changedFiles.join(', ') || '(none)'}

The working directory is a checkout at the head SHA. Inspect the diff with:
  git diff ${req.candidate.baseSha}...${req.candidate.headSha}
and read any files you need. You are in a read-only sandbox; do not attempt writes.

The candidate is a ${kind} for GitHub issue #${req.issue.number}: ${req.issue.title}

Issue body:
---
${req.issue.body}
---

Verdict rules:
- GO only if the candidate correctly and completely satisfies the issue with no defects worth blocking on.
- Otherwise REQUEST_CHANGES with a concrete, actionable finding list (each finding self-contained: file, problem, why it matters).
- Judge only the candidate against the issue and repository conventions; do not demand out-of-scope work.

Debris designation (separate from findings): if, and only if, a tracked file in the diff is disposable scratch/debris that must be DELETED rather than fixed (e.g. a permission/write-probe file, a temporary scratch config, a leftover pre-repair reproduction file, a commit-message draft) — not a real product file that merely needs a code change — list its exact repository-relative path in \`debrisPaths\`. Do not put a path in \`debrisPaths\` for a file you want edited; that belongs in \`findings\` instead. Leave \`debrisPaths\` empty (\`[]\`) if nothing needs deleting.`
}

export const REVIEWER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['GO', 'REQUEST_CHANGES'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    debrisPaths: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'summary', 'findings', 'debrisPaths'],
  additionalProperties: false,
} as const
