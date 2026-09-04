import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Lane } from './types.ts'

/**
 * Small replaceable local durable store. GitHub remains the canonical handoff
 * medium; this registry only lets the supervisor resume without human relay.
 */
export type StoreState = {
  version: 1
  repo: string
  pointerIssue: number
  lanes: Record<string, Lane>
  /** worktree path -> laneId; a worktree has at most one owning lane. */
  worktreeOwners: Record<string, string>
}

export class Store {
  readonly dir: string
  readonly ephemeral: boolean
  private readonly file: string
  private readonly journal: string
  state: StoreState

  constructor(dir: string, repo: string, pointerIssue: number, opts: { ephemeral?: boolean } = {}) {
    this.dir = dir
    this.ephemeral = opts.ephemeral === true
    this.file = join(dir, 'state.json')
    this.journal = join(dir, 'journal.jsonl')
    mkdirSync(dir, { recursive: true })
    if (existsSync(this.file)) {
      this.state = JSON.parse(readFileSync(this.file, 'utf8')) as StoreState
      if (this.state.repo !== repo) {
        throw new Error(`state dir ${dir} belongs to ${this.state.repo}, not ${repo}`)
      }
    } else {
      this.state = { version: 1, repo, pointerIssue, lanes: {}, worktreeOwners: {} }
    }
  }

  /** Atomic persist: write temp then rename. No-op when ephemeral (dry-run). */
  save(): void {
    if (this.ephemeral) return
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    renameSync(tmp, this.file)
  }

  log(entry: Record<string, unknown>): void {
    if (this.ephemeral) return
    appendFileSync(this.journal, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
  }

  lanes(): Lane[] {
    return Object.values(this.state.lanes)
  }

  getLane(laneId: string): Lane | undefined {
    return this.state.lanes[laneId]
  }

  upsertLane(lane: Lane): void {
    lane.updatedAt = new Date().toISOString()
    this.state.lanes[lane.laneId] = lane
    this.save()
  }

  /**
   * Claim a worktree for a lane. Throws if another active lane owns it.
   * (Safety rule 11: no cross-worktree mutation.)
   */
  claimWorktree(worktree: string, laneId: string): void {
    const owner = this.state.worktreeOwners[worktree]
    if (owner !== undefined && owner !== laneId) {
      throw new Error(`worktree ${worktree} is owned by lane ${owner}; lane ${laneId} may not claim it`)
    }
    this.state.worktreeOwners[worktree] = laneId
    this.save()
  }

  releaseWorktree(worktree: string, laneId: string): void {
    if (this.state.worktreeOwners[worktree] === laneId) {
      delete this.state.worktreeOwners[worktree]
      this.save()
    }
  }
}
