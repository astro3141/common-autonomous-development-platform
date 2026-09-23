# Capability trial B — a trading-shaped cycle on this stack (2026-09-23)

Same question as trial A: **does a cycle of this shape run here?** Nothing is migrated, and the
paper-trading harness keeps its own runner, its own ledgers and its own schedule. What was borrowed
is the shape: several lanes decide from one frozen packet in the same cycle, a deterministic lane
runs beside the model lanes, every proposal is validated identically, a failing lane is isolated,
and the cycle ends in a comparison.

The packet is a fixture with invented numbers (`p281/fixtures/trading/packet.json`). No market data
and no external API: this stack's egress reaches model providers only, so KIS/DART-style sources
are out of scope by construction.

`p281/workflows/trading-b.yaml`.

## What ran

| run | condition | result |
|---|---|---|
| `20260923-071751-46c12d` | three lanes: deterministic + Codex + Claude | **3/3 valid**, best `ai` (+0.275%), packet hash reproducible, 2 model calls |
| `20260923-071923-75a5fb` | the second model lane pointed at a login that does not exist | **lane `ai2` failed, the cycle carried on**: 2/2 remaining lanes valid, best `base`, `failed_lanes: ai2` |

Per-lane results of the first run (scored against returns the lanes never saw):

| lane | kind | gross | next-session return | vs benchmark | cited |
|---|---|---|---|---|---|
| ai (Codex) | model | 0.60 | +0.275% | +0.095% | EV-001, EV-003 |
| ai2 (Claude) | model | 0.60 | +0.170% | −0.010% | EV-001, EV-003 |
| base | deterministic, 0 model calls | 0.75 | +0.250% | +0.025% | — |

## What this answers

- **Several lanes, one cycle, started together.** **The first overlap numbers (1.78–2.00) were
  wrong** — same defect as trial A, the children were timed by a sequential collection loop.
  Corrected: **overlap 1.99 for the two model lanes**, re-run `20260923-080614-05e512`, which also
  ran *at the same time as* a novel-shaped run — two workflows at once, each with its own process,
  workspace and record.
- **A deterministic lane beside model lanes.** `base` makes no model call and is scored by exactly
  the same code — a cycle keeps a baseline even if every model lane dies.
- **Identical validation for everyone.** Universe membership, per-symbol weight bounds, gross
  exposure, duplicate symbols, and grounding (a citation must exist in the packet) — all in
  `steps/trade_stage.py`, not in a prompt.
- **A frozen, reproducible packet.** Built twice per run and compared; the scoring returns are held
  out of the packet the lanes read and only used by the scorer afterwards.
- **Lane isolation.** A lane whose login does not exist failed alone; the others finished and the
  cycle still produced a comparison and an MLflow record.
- **Quota routing still applies.** The cycle is admitted by the same router as everything else.

## What it exposed

1. **Run input keys could not contain digits.** `lane2_login` was rejected by the input contract
   (`[a-z_]{1,30}`), and the run never started — the same class of limit as trial A's "inputs may
   not contain paths". Widened to `[a-z][a-z0-9_]{0,29}`; the value rules are unchanged.
2. **Lanes run at the same time, but cannot be managed one by one.** Conductor's parallel groups
   refuse script steps, so the fan-out is inside the step, exactly as in trial A. For a lane
   experiment the cost is precise: **a lane that dies halfway cannot be resumed while the others'
   results are kept** — Conductor's unit is the group. Nothing here implements per-lane resume.
3. **The recorder wants one shape.** `record.py` is built around a single "execute" record; a
   multi-lane cycle had to flatten itself into that shape (valid-lane count and model calls as
   measurements). A real lane experiment would want one record per lane.
4. **Not tried:** a schedule, market-data egress, per-lane tool policies (one Preloop policy per
   account), and interrupt/resume of a long lane.
