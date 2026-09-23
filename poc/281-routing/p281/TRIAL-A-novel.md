# Capability trial A — a novel-shaped workflow on this stack (2026-09-23)

Question asked: **does a workflow of this shape actually run here?** Nothing is being migrated.
The France Novel project (Notion) keeps its own supervisor; what was borrowed is the *shape* —
roles split across vendors, one immutable draft that every reviewer judges, required reviews plus
an advisory Cold Reader, a deterministic triage owning the graph edge, and a bounded repair loop.
The entry state is a fixture written for this trial (`p281/fixtures/novel/`).

`p281/workflows/novel-a.yaml`, run through the same ops API and screen as everything else.

## What ran

| run | mode | path | result |
|---|---|---|---|
| `20260923-065614-a387e5` | default | route → roles → stage → architect → author → freeze → reviews → triage → record → PASS | draft `d01`, 1045 chars, repairs 0, cold 4/5 |
| `20260923-070057-721304` | strict reviewer (dialogue must change what the narrator must do) | same | PASS at the first draft — the requirement was already met |
| `20260923-070442-7ca4e1` | house rule the first draft cannot satisfy | … → triage → **repair** → freeze → reviews → triage → PASS | draft `d01` → `d02`, **repairs 1** |
| `20260923-070949-73ff2a` | Cold Reader pointed at a login that does not exist | same, without the advisory result | **PASS**, `cold_available: no`, `reviews_failed: review-cold` |

Roles in every run: **architect = Codex, author = Claude, story review = Codex, history review =
Claude, cold reader = Grok** — three vendors inside one run, each on its own login in `/route`.

## What this answers

- **Three vendors, one run, role-split.** Works. Each role names its provider; `steps/roles.py`
  resolves that provider's login and route from the profile and refuses (HOLD) rather than
  substituting another vendor when the profile does not carry it.
- **Grok as a working role.** The novel project has the Cold Reader `COLD_UNAVAILABLE` after a
  tool-restriction regression. Here it ran and returned a reader score in every run where its login
  existed.
- **Immutable draft.** `freeze` fixes `draft_id` + sha256 before any reviewer runs; the repair round
  produced `d02` with a different hash, and the reviewers of that round saw only it.
- **Deterministic routing.** The PASS/REPAIR edge is chosen by `steps/novel_stage.py triage` from
  the files the reviewers wrote — no model picks the next step.
- **Bounded repair.** `max_repairs` is enforced by the triage, not by a model's judgement.
- **Advisory failure is isolated.** A dead Cold Reader neither blocked the chapter nor failed the
  run; a required reviewer failing would have blocked it (`required review unusable`).
- **Concurrency.** The three reviewers do overlap. **The first numbers reported here (1.99–2.90)
  were wrong** and have been withdrawn: the step collected its children with a sequential loop and
  stamped each child's end time when the loop reached it, so a slow child stretched the others.
  Corrected measurement (`steps/fanout.py`, one thread per child, each stamping its own end):
  **overlap 1.91 over a 65 s wall** for the three reviewers, re-run `20260923-080609-01bad2`.
  `p281/fanout_controls.py` holds the check that the number means what it says — a 6 s + 0.4 s +
  0.4 s fan-out must report ~1.0, three equal children ~3.0 (8/8).

## What it exposed — the limits worth knowing

1. **Concurrency works; Conductor's management of it does not apply.** Both `parallel` groups and
   dynamic `for_each` groups **reject script steps** (validator, v0.1.37), and every routed model
   call in this stack *is* a script step, because the model runs through the routing/execution
   layer rather than Conductor's provider clients. Running things at the same time is therefore
   fine — it happens inside a step (`steps/novel_reviews.py`). What is missing is per-member
   management: Conductor sees one step, so **a single reviewer or lane cannot be resumed on its
   own**, and its checkpoints are the group's. That responsibility now sits in this stack's own
   code, and it is not implemented.
2. **One observed collision on a shared login directory.** The first attempt failed with Claude's
   own message — *"another Claude Code process is refreshing it"* — when the quota observer read
   usage from `/route/claude` while the author was starting on the same directory. One retry after
   20 s cleared it and `attempts` is now reported. What this does **not** establish: that two roles
   of the same vendor cannot run at once in general, or that one retry makes concurrent use of one
   login dependable. Both would need their own measurement; neither was done.
3. **Run inputs cannot carry paths.** The workflow input validator allows `[A-Za-z0-9._- ]`, so a
   prompt had to be chosen by name (`review_mode`), not by path. That is the input contract working
   as intended, but it shapes how a workflow is parameterised.
4. **`record.py` expects an execute-shaped record.** Feeding it a hand-made dict lost the run in
   MLflow (`KeyError`); passing the author step's own output fixed it. A second workflow shape
   reuses the recorder only if it speaks the same shape.

## What was not tried here

Scheduling, multiple operators, interrupt/resume of a long step, and per-role tool policies (one
Preloop policy per account still applies — every role in this trial ran under the same one).
