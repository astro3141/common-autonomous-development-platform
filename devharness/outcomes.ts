import type { Outcome } from './types.ts'

/**
 * Conservative classification of a raw provider CLI result into a normalized
 * Outcome. Anything not positively identified is UNKNOWN — never assume success.
 */
export type RawInvocation = {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
}

const trim = (s: string, n = 800): string => (s.length > n ? s.slice(0, n) + '…' : s)

/** Parse "retry after 30s" / "retry-after: 30" / "try again in 12 seconds" style hints. */
export function parseRetryAfterSeconds(text: string): number | undefined {
  const m =
    text.match(/retry[-_ ]after[:\s]+(\d+)/i) ??
    text.match(/try again in\s+(\d+)\s*s(?:ec(?:ond)?s?)?\b/i) ??
    text.match(/"retry_after"\s*:\s*(\d+)/)
  if (!m?.[1]) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const RESOURCE_EXHAUSTED_RE =
  /usage limit reached|hit your usage limit|out of (?:free )?credits|credit balance is too low|quota exceeded|exceeded your current quota|5-hour limit|weekly limit/i
const RATE_LIMITED_RE = /\b429\b|rate[- ]?limit/i
const AUTH_RE =
  /not logged in|please (?:run\s+)?(?:\/?login|codex login)|invalid api key|authentication[_ ]error|unauthorized|\b401\b|token expired|OAuth token has expired/i
const UNAVAILABLE_RE =
  /\b5[023]\d\b|overloaded|service unavailable|internal server error|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|network error|connection error/i

/** Classify combined provider output text; used for both actor and reviewer CLIs. */
export function classifyProviderText(text: string): Outcome | undefined {
  if (RESOURCE_EXHAUSTED_RE.test(text)) {
    return { kind: 'RESOURCE_EXHAUSTED', detail: trim(text) }
  }
  if (RATE_LIMITED_RE.test(text)) {
    return { kind: 'RATE_LIMITED', detail: trim(text), retryAfterSeconds: parseRetryAfterSeconds(text) }
  }
  if (AUTH_RE.test(text)) {
    return { kind: 'AUTH_REQUIRED', detail: trim(text) }
  }
  if (UNAVAILABLE_RE.test(text)) {
    return { kind: 'PROVIDER_UNAVAILABLE', detail: trim(text) }
  }
  return undefined
}

/**
 * Classify a failed (or unparseable) invocation. `parsedOk` must be true only
 * when the adapter positively parsed a typed structured output from the worker.
 */
export function classifyFailure(raw: RawInvocation): Outcome {
  if (raw.signal !== null) {
    return { kind: 'PROCESS_CRASHED', detail: `terminated by signal ${raw.signal}: ${trim(raw.stderr || raw.stdout)}` }
  }
  const combined = `${raw.stdout}\n${raw.stderr}`
  const byText = classifyProviderText(combined)
  if (byText) return byText
  if (raw.exitCode === null) {
    return { kind: 'PROCESS_CRASHED', detail: trim(combined) }
  }
  return { kind: 'UNKNOWN', detail: `exit=${raw.exitCode}: ${trim(combined)}` }
}
