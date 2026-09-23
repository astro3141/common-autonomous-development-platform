# What the platform provides, and what a workflow decides

The rule, in one line: **the platform provides capabilities; it does not decide behaviour.** A
capability says *this is possible, with these guarantees*. Behaviour says *do this, now, and here
is what it means*. The first belongs to CADP, the second to the workflow that uses it.

Two tests that settle most arguments:

* Would a different domain — a novel, a trading cycle, a code review — need this **with the same
  meaning**? Then it is a capability.
* Does it encode *what a good result is*, or *what to do when something is not good*? Then it is
  behaviour, and it belongs to the workflow, even if every workflow happens to want the same thing
  today.

One thing crosses the line legitimately: a **guarantee** the platform cannot give up without
becoming untrustworthy — failing closed when it cannot tell whether something is allowed, never
inventing a measurement, never letting one member's failure touch another. Those are properties of
the capability, not decisions about the work, and they stay in the platform.

## The capabilities, and the decision each one leaves to the caller

| capability | guarantee | the caller decides |
|---|---|---|
| **Admission** (`router.py`, `collect_obs.py`, `steps/route.py`) | an answer per provider — eligible or not, with the reason; unknown or stale is *not* eligible | the limits and the candidate order (the profile), and what to do when nothing is eligible |
| **Role binding** (`steps/roles.py`) | for each role: the provider's login and route, or a refusal naming the reason | which roles exist, which vendor each one is bound to, and whether a refusal holds the run |
| **Execution** (`run-agent.mjs`, `steps/agent_task.py`) | one normalized result per routed call, whatever the vendor; every permission request goes to Preloop and a failure on that path is a denial | the prompt, the provider, the artifact expected, the timeout |
| **Tool rights** (Preloop principals, `mcp_principal`) | the call presents exactly the named principal's credential, or fails — never a wider one | which principal a role uses, and what that principal may do |
| **Concurrency** (`steps/fanout.py`, `steps/tasks.py`, `steps/task_chain.py`) | the members run at the same time, each timed on its own; a member may be a *sequence*, whose steps run in order and stop at the first that produces nothing; one member's failure does not touch another; a receipt records what each produced, with hashes | which tasks, what each member's steps are, which of them matter, and what a missing one means |
| **Recording** (`steps/record.py`) | the run's facts reach MLflow, and a recording failure never changes the run's outcome | what counts as a measurement in this domain, and what the run's decision was |
| **Operation** (`scripts/*.sh`, `p281/cleanup.py`) | backup, restore, update, rollback and cleanup of the stack itself, preview before destruction, pending approvals protected | when to run them, and what to keep |
| **Composition** (`scripts/up.sh --composition`, `p281/capabilities.py`) | the stack starts with a named set of services, says which capabilities it therefore has — probed, not declared — and refuses a run that needs one it does not have | which composition to run, and whether an unrecorded run is acceptable (`--allow-unrecorded`) |

## What a workflow owns

The graph and its edges; what each artifact is and when it is fixed; what makes a result valid;
the pass / repair / block judgement; what a failed member means (drop it, repair it, block the
run); how results are compared; and the statistics — including how a missing observation is
treated, which nothing in the platform may decide for it.

## Where this PoC crossed the line, and what was done

The trials were built to answer "does a workflow of this shape run here at all", so the line was
not drawn while they were being written. Audited against the rule above:

| where | the crossing | state |
|---|---|---|
| `steps/novel_reviews.py`, `steps/trade_lanes.py` | each workflow re-implemented the same fan-out — build the job list, run it, read the last stdout line, count what was produced, report the overlap — with its domain rules mixed in. The capability was missing, so the behaviour grew a copy of it | **separated**: `steps/tasks.py` is the capability (any routed tasks, together, with a receipt). What is required, what a failure means, and what the receipt must match are now the workflow's, in the workflow's own steps |
| `steps/novel_reviews.py` | it knew "required" and "advisory" and counted usable required reviews — a judgement about the work | **separated**: the receipt states what each member produced; `novel_stage.py triage` is told which labels are required |
| `steps/trade_lanes.py` | it computed the deterministic baseline — a trading decision — inside the fan-out | **separated**: `trade_stage.py baseline` is a step of the trading workflow |
| `steps/agent_task.py` | one retry after 20 s when the provider calls a failure a login refresh | **kept, narrowed**: this is recovery from an infrastructure fault the caller cannot see, so it is the capability's; it is bounded, reported as `attempts`, and never retries a failure the model produced |
| `steps/record.py` | one execute record per run, so a multi-lane cycle had to flatten itself into it: the lanes' own tokens, durations and providers existed in the evidence directory but could not be compared in MLflow, which is the point of running lanes | **separated**: the recorder takes the executions a run actually made — from the workflow and from any fan-out receipt — and writes a parent run carrying the judgement with a child run per execution. What counts as a measurement is still the workflow's |
| `router.py` | "the first eligible candidate wins" | **kept**: the order is the profile's, so the policy is the caller's; the platform only walks it |

Nothing on that list is open now. The receipt is where the two sides meet without leaking into
each other: the platform writes what each member produced and with which hash, and carries the
caller's `context` string back unchanged; the workflow decides what that context has to be, which
members matter, and what a missing one means.
