import { spawnSync } from "node:child_process";

import type {
  CodexCliCommandObservation,
  CodexCliInvocation,
  CodexCliProcessRunner,
} from "./types.ts";

const isoNow = (): string => new Date().toISOString();

/** Direct argv execution only: no shell, PTY, issue scheduler, or continuation controller. */
export class LocalCodexCliProcessRunner implements CodexCliProcessRunner {
  run(invocation: CodexCliInvocation): CodexCliCommandObservation {
    const started_at = isoNow();
    const completed = spawnSync(invocation.executable, [...invocation.args], {
      cwd: invocation.cwd,
      encoding: "utf8",
      input: invocation.stdin,
      maxBuffer: 32 * 1024 * 1024,
      timeout: invocation.timeout_ms,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const error = completed.error as NodeJS.ErrnoException | undefined;
    return {
      started_at,
      completed_at: isoNow(),
      exit_code: completed.status,
      signal: completed.signal,
      stdout: completed.stdout ?? "",
      stderr: completed.stderr ?? "",
      timed_out: error?.code === "ETIMEDOUT",
      error_code: error?.code ?? null,
    };
  }
}
