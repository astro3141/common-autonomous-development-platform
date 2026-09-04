import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitHubPort, IssueInfo, PrInfo } from './types.ts'

const run = promisify(execFile)

async function gh(args: string[]): Promise<string> {
  const { stdout } = await run('gh', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  return stdout
}

function toPr(raw: {
  number: number; headRefName: string; headRefOid: string; baseRefName: string
  mergedAt: string | null; state: string; mergeCommit: { oid: string } | null
}): PrInfo {
  const merged = raw.mergedAt !== null || raw.state === 'MERGED'
  return {
    number: raw.number,
    headRefName: raw.headRefName,
    headSha: raw.headRefOid,
    baseRefName: raw.baseRefName,
    merged,
    mergeCommitSha: raw.mergeCommit?.oid,
    state: merged ? 'merged' : raw.state === 'OPEN' ? 'open' : 'closed',
  }
}

const PR_FIELDS = 'number,headRefName,headRefOid,baseRefName,mergedAt,state,mergeCommit'

/**
 * gh-CLI-backed GitHub adapter. Exposes NO merge operation: merging is the
 * human boundary. With readOnly=true every write method throws — the dry-run
 * proof relies on this.
 */
export function createGitHubAdapter(readOnly: boolean): GitHubPort {
  const assertWritable = (op: string): void => {
    if (readOnly) throw new Error(`dry-run: GitHub write refused (${op})`)
  }
  return {
    readOnly,

    async getIssue(repo, num): Promise<IssueInfo> {
      const out = await gh(['issue', 'view', String(num), '--repo', repo, '--json', 'number,title,body,state,labels'])
      const j = JSON.parse(out) as { number: number; title: string; body: string; state: string; labels: { name: string }[] }
      return {
        number: j.number, title: j.title, body: j.body ?? '',
        state: j.state.toLowerCase() === 'open' ? 'open' : 'closed',
        labels: j.labels.map((l) => l.name),
      }
    },

    async listWorkIssues(repo, label): Promise<IssueInfo[]> {
      const out = await gh(['issue', 'list', '--repo', repo, '--label', label, '--state', 'open',
        '--json', 'number,title,body,state,labels', '--limit', '50'])
      const arr = JSON.parse(out) as { number: number; title: string; body: string; state: string; labels: { name: string }[] }[]
      return arr
        .map((j) => ({
          number: j.number, title: j.title, body: j.body ?? '',
          state: 'open' as const, labels: j.labels.map((l) => l.name),
        }))
        .sort((a, b) => a.number - b.number)
    },

    async findPrForBranch(repo, branch): Promise<PrInfo | undefined> {
      const out = await gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all',
        '--json', PR_FIELDS, '--limit', '5'])
      const arr = JSON.parse(out) as Parameters<typeof toPr>[0][]
      const first = arr[0]
      return first === undefined ? undefined : toPr(first)
    },

    async getPr(repo, num): Promise<PrInfo> {
      const out = await gh(['pr', 'view', String(num), '--repo', repo, '--json', PR_FIELDS])
      return toPr(JSON.parse(out) as Parameters<typeof toPr>[0])
    },

    async getBranchHead(repo, branch): Promise<string> {
      const out = await gh(['api', `repos/${repo}/branches/${branch}`, '--jq', '.commit.sha'])
      return out.trim()
    },

    async comment(repo, issueOrPr, body): Promise<void> {
      assertWritable('comment')
      // Works for both issues and PRs (PR is an issue for comments).
      await gh(['api', `repos/${repo}/issues/${issueOrPr}/comments`, '-f', `body=${body}`])
    },

    async createPr(repo, args): Promise<number> {
      assertWritable('createPr')
      const out = await gh(['pr', 'create', '--repo', repo, '--head', args.head, '--base', args.base,
        '--title', args.title, '--body', args.body])
      const m = out.match(/\/pull\/(\d+)/)
      if (!m?.[1]) throw new Error(`could not parse PR number from: ${out}`)
      return Number(m[1])
    },
  }
}
