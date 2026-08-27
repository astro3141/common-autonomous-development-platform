/**
 * The adapter's private Git invocation helper.
 *
 * Deliberately not a command framework: one function that runs `git` with an argument vector and
 * returns its output. No shell is involved at any point, so no input can be interpreted as a
 * command — `execFileSync` receives `argv` directly and never a concatenated string.
 */

import { execFileSync } from "node:child_process";

export class GitError extends Error {
  /** What the adapter was doing, e.g. `resolve canonical ref`. */
  readonly operation: string;
  readonly argv: readonly string[];
  readonly stderr: string;

  constructor(operation: string, argv: readonly string[], stderr: string) {
    super(`${operation} failed: git ${argv.join(" ")}${stderr === "" ? "" : `\n${stderr}`}`);
    this.name = "GitError";
    this.operation = operation;
    this.argv = argv;
    this.stderr = stderr;
  }
}

export interface GitRun {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs git in `cwd`. Never throws for a non-zero exit; the caller decides what that means. */
export function runGit(cwd: string, argv: readonly string[]): GitRun {
  try {
    const stdout = execFileSync("git", [...argv], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr: typeof failure.stderr === "string" ? failure.stderr : String(error),
    };
  }
}

/** Runs git and turns a non-zero exit into a `GitError`, for operations that must succeed. */
export function git(cwd: string, operation: string, argv: readonly string[]): string {
  const run = runGit(cwd, argv);
  if (!run.ok) throw new GitError(operation, argv, run.stderr.trim());
  return run.stdout;
}

/** Single-line output with the trailing newline removed. */
export function gitLine(cwd: string, operation: string, argv: readonly string[]): string {
  return git(cwd, operation, argv).trim();
}
