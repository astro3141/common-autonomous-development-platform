# Common Autonomous Development Platform (CADP)

CADP v0.4 is a policy-first control plane for autonomous work. It is not a
workflow framework: mature commodity products own orchestration, agents,
review, CI and repositories, while CADP owns only the thin constitutional
kernel that governs how any of them may cause an external effect.

Authority order: `Common Autonomous Development Platform — Specification v0.4.md`
> `TECHNICAL_DESIGN_cadp_v0_4_generation.md` (TD v2.0) > exact current
implementation / tests / live evidence. See `Authority order.md`.

## Model providers

Every model surface is a replaceable provider adapter selected per run, with unknown selections failing closed.

| Role     | codex | grok | claude |
| -------- | ----- | ---- | ------ |
| worker   | yes   | yes  | yes    |
| reviewer | yes   | yes  | yes    |
| planner  | yes   | yes  | yes    |

## What the kernel guarantees (Spec v0.4 K1–K7)

- A policy decision binds to one exact effect identity, input digest and
  evidence set; policy `ALLOW` is never an effect permit by itself.
- The PEP alone holds governed credentials and admits effects; workers,
  reviewers and workflows have no mutation reach to governed targets.
- Every non-trivial external call has a durable admission record written
  before dispatch, and outcomes are target-authoritative: an ambiguous call
  stays `UNKNOWN` and is never blindly retried.
- Requested values are never copied into observed facts; unavailable facts
  stay `UNKNOWN`; stale, missing or contradictory required evidence fails
  closed.
- Human decisions are scoped, attributable, fresh evidence — not ambient
  authority.

## Layout

```text
cadp/kernel/        K1–K7 records, constitutional store (SQLite), CAS, ingress,
                    OPA evaluator seam, PEP, reconciler, genesis/break-glass,
                    kernel HTTP API, composition root (kernelService.ts)
cadp/kernel/adapters/  target adapters: GitHub, GitHub Issues, Temporal,
                    record service, store policy activation, finding seal
cadp/product/       commodity-backed autonomous-work composition: Temporal
                    cadpWork workflow + activities, surface broker, Docker/
                    Seatbelt isolation, timeout hierarchy, recurring-improvement
                    intake
cadp/deployment/    reference OPA policy (rego + kernel config)
cadp/live/          disposable live composition (env setup, ctl driver, probes)
cadp/tests/         deterministic conformance suites (C*/P*/FC*/WB*/T* controls)
devharness/         standalone bootstrap development supervisor for building
                    CADP itself — NOT a platform component
```

The v0.3 generation (`core/`, `adapters/`, `deployment/`, `testdoubles/`,
`tests/`) is preserved in git history only; Spec v0.3 / TD v1.5 remain in the
tree as historical records.

## Running it

Deterministic validation (requires Node ≥ 22 with `node:sqlite`, and the `opa`
binary on PATH — the conformance suites run a real OPA sidecar):

```bash
npm install
npm test            # cadp + devharness conformance suites
npm run typecheck
```

Live composition (additionally requires `temporal` CLI, `docker`, `gh` with a
GitHub token, and macOS `sandbox-exec` for the confined worker processes):

```bash
node cadp/live/env.ts setup <dir> [--repo owner/name]   # disposable repo, genesis, tokens, image
node cadp/live/ctl.ts <dir> up                          # record service, temporal dev server,
                                                        # kernel, surface broker, worker
node cadp/live/ctl.ts <dir> attest                      # credential-reach + immutability evidence
node cadp/live/ctl.ts <dir> plan "<whole intent>"       # proposal-only planner → WORK_PROPOSAL evidence
node cadp/live/ctl.ts <dir> work-dev "<work item>" [max_steps] [max_effects] [proposal_evidence_id]
node cadp/live/ctl.ts <dir> human-approve <effect_id> <workflow_id>
node cadp/live/ctl.ts <dir> state <effect_id>
node cadp/live/ctl.ts <dir> work-plan <proposal_evidence_id>   # drive proposal items sequentially
node cadp/live/observe.ts <dir> run|effect|attribution <ref>   # read-only observer projection
```

Hands-off supervision (commodity session as the loop — CADP owns no supervisor):

```bash
node cadp/live/mcpServer.ts <dir>    # MCP stdio server: cadp_plan, cadp_work_start,
                                     # cadp_run_status, cadp_human_state
# e.g. with Claude Code as the supervising session:
claude --mcp-config '{"mcpServers":{"cadp":{"command":"node","args":["cadp/live/mcpServer.ts","<dir>"]}}}'
```

The session receives ALLOW/DENY/evidence text back — never a credential. Work
starts are capped per session; Human decisions stay out-of-band
(`ctl human-approve`), and kernel state — not the conversation — is the durable
resume truth (`cadp_run_status`).

Process entry points: `npm run kernel -- <config.json>`, `npm run worker`,
`npm run broker`, `npm run live -- <dir> …`.

## Commodity boundaries

CADP does not build or own: policy language/evaluator (OPA), durable workflow
(Temporal), coding agents (codex-cli / Claude Code), CI, review products,
repositories/PRs (GitHub), sandbox runtimes (Docker/Seatbelt), secret managers,
issue trackers or observability platforms. Each sits behind a small replaceable
seam (`EvaluatorPort`, `TargetAdapterV1`, the surface broker); replacing one
requires re-proving the same conformance evidence, never new kernel authority.

## Status

- Constitutional kernel + development/record verticals: landed, deterministic
  conformance green, live-proven (#100/#102, #105, #126).
- Broker/activity timeout hierarchy and bounded surface lifetime (#127/#128):
  repaired; see `cadp/product/timeouts.ts` and `cadp/tests/conformance-timeout.test.ts`.
- Read-only constitutional observation (TD §12 r8, #96/#106): the `observer`
  caller class, K2 read API with verify-on-read, and the non-authoritative
  trace/attribution projections (`cadp/live/observe.ts`).
- Proposal-only planner (#61): `ctl plan` decomposes a whole intent into
  bounded items sealed as `WORK_PROPOSAL` evidence; starting any item still
  goes through the governed `WORK_START` admission.
- Production deployment: NOT AUTHORIZED. The live composition is a disposable
  reference proof, not a hosted service.
