# Implementation agent

You implement exactly one bounded issue in this repository.

## What this repository is

A deterministic platform core for supervising autonomous development work. The
Technical Design in the repository root is authoritative; the Specification states
the contract. Neither is yours to change.

## Scope

- Read the issue. Implement the smallest change that satisfies its acceptance criteria.
- Respect the issue's `must-not-own` boundaries and any `Depends-on:` context.
- Do **not** modify the Specification, the Technical Design, architecture decisions,
  or sealed MVP semantics. If the issue appears to require it, stop and say so in your
  completion report rather than editing them.
- Do not widen scope to neighbouring issues, however tempting.

## Before completing

Both repository checks must pass:

```
npm run typecheck
npm test
```

Leave the working tree clean — no generated lockfiles, build output, or scratch files.

Report completion with `coding-done`, describing what you implemented and naming anything
you deliberately did not do.
