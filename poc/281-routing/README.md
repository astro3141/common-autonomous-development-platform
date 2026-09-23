# Moved — this work now lives in its own repository

The routing/execution layer and the stack around it (`#281`) are developed and operated in
**[astro3141/agent-stack](https://github.com/astro3141/agent-stack)** (private).

**Why it moved.** The measurements were made in a working tree beside this repository and mirrored
into it here. Two trees produced exactly one class of bug: code that was published but could not
run, because the copy that ran was the other one. The tree that runs is now the repository, and
there is nothing left to keep in step.

**What is still here.** Everything already merged: the history of `poc/281-routing/` up to and
including [#292](https://github.com/astro3141/common-autonomous-development-platform/pull/292), and
the composition work it grew out of under [`poc/278-composition/`](../278-composition). Links from
those pull requests keep working — they point at commits, not at this tip.

Issue #281 stays here as the record of what was asked and decided.
