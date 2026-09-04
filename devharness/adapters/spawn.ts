import { spawn } from 'node:child_process'
import type { RawInvocation } from '../outcomes.ts'
import type { OutcomeKind } from '../types.ts'

/** Spawn a provider CLI and collect its result. Kills on harness timeout. */
export function runCli(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; killAfterMs?: number },
): Promise<RawInvocation & { harnessKilled: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let harnessKilled = false
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const timer = setTimeout(() => { harnessKilled = true; child.kill('SIGKILL') }, opts.timeoutMs)
    // FAULT_INJECTION support: terminate the real invocation shortly after it
    // actually started, so the injected failure sits at the real boundary.
    const injectTimer = opts.killAfterMs !== undefined
      ? setTimeout(() => { harnessKilled = true; child.kill('SIGKILL') }, opts.killAfterMs)
      : undefined
    child.on('error', (err) => {
      clearTimeout(timer)
      if (injectTimer) clearTimeout(injectTimer)
      resolve({ exitCode: 127, signal: null, stdout, stderr: stderr + String(err), harnessKilled })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (injectTimer) clearTimeout(injectTimer)
      resolve({ exitCode: code, signal: signal ?? null, stdout, stderr, harnessKilled })
    })
  })
}

/**
 * Labeled fault injection (env DEVHARNESS_FAULT_INJECT="role:KIND").
 * This is NOT a real provider event; every produced outcome carries
 * faultInjected=true and receipts label it FAULT_INJECTION.
 */
export function faultInjectionFor(role: 'actor' | 'reviewer'): OutcomeKind | undefined {
  const spec = process.env['DEVHARNESS_FAULT_INJECT']
  if (spec === undefined || spec === '') return undefined
  const [r, kind] = spec.split(':')
  if (r !== role) return undefined
  const valid: OutcomeKind[] = [
    'RESOURCE_EXHAUSTED', 'RATE_LIMITED', 'AUTH_REQUIRED',
    'PROVIDER_UNAVAILABLE', 'PROCESS_CRASHED', 'UNKNOWN',
  ]
  return valid.includes(kind as OutcomeKind) ? (kind as OutcomeKind) : undefined
}
