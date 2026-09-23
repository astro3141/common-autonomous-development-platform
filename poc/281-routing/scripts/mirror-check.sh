#!/usr/bin/env bash
# Compare this workspace with the repository copy it is published as.
#
#   scripts/mirror-check.sh [<repo-checkout>]      default: D:/Work/cadp
#
# Why: the two trees are not the same tree (OPERATIONS.md §1) — the workspace is the ancestor and
# carries notes that were never mirrored — but every file that exists on both sides must be
# identical, because the workspace is where things are run and measured and the repository is what
# is reviewed. A review found `novel_reviews.py` published calling `fanout.run_all(..., ledger=)`
# against a `run_all(jobs)` that had already been published without it: the workspace ran, the
# published pair could not start, and every "measured on the running stack" line in that PR was
# about code nobody could read. This check exists so that cannot be reported again.
#
# What is compared: code, documents, workflows, **policies** (`policy/`) and the JSON a run reads
# — fixtures and routing policies. A review found the first version searching neither `policy/`
# nor `.json`, so a changed `p281/fixtures/trading/packet.json` (what every lane decides from) and
# a changed `policy/b-fsmcp.yaml` (what the tools are allowed to do) both passed as MIRROR OK.
# Inputs and policy decide what a run produces, so they are part of "the published copy is what
# was measured".
#
# What is not compared: generated configuration (`config/generated/`, written by cfg.py from
# config/environment.yaml and this host's values) and anything holding credentials — neither is
# published, and both are per-host by design.
#
# Exit 1 on any difference, in either direction — a file changed here and not published, and a
# file still published that no longer exists here. The documented exceptions are listed, not
# compared (OPERATIONS.md §1).
set -euo pipefail

repo="${1:-D:/Work/cadp}"
here="$(cd "$(dirname "$0")/.." && pwd)"
sub="poc/281-routing"
# Documented in OPERATIONS.md §1: the repository pins what this host installs unpinned, and it
# carries the CA directory's note while this host's certificate is unversioned.
# README.md and RUNBOOK.md are different documents that happen to share a name: the repository's
# are written for #281 and its readers, this workspace's RUNBOOK.md is the #278 stack's own and
# predates them. Checked, not assumed — the first version of this script never looked at the root
# documents, which is how they were noticed.
#
# docker/compose.poc.yaml was on this list and is not any more: the two copies were identical (the
# defaults are the repository's relative ones on both sides — what differs per host is docker/.env,
# which is not published). Leaving it excused would have let a change to the services themselves,
# like the profiles a composition selects, stay unpublished.
known_different="docker/agent.Dockerfile docker/ca/README.md README.md RUNBOOK.md"

[ -d "$repo/$sub" ] || { echo "no $sub in $repo"; exit 2; }

drift=0
missing=0
checked=0

is_known() {
  for k in $known_different; do [ "$1" = "$k" ] && return 0; done
  return 1
}

# Every code and document file of the workspace's published surface — including the documents at
# its root (OPERATIONS.md, CONTRACT.md, RUNBOOK.md …), which the first version did not look at.
list_tree() {                                # $1: a tree's root
  ( cd "$1" && ls *.md 2>/dev/null
    find p281 ops hub scripts config docker policy \
      -type f \( -name '*.py' -o -name '*.mjs' -o -name '*.sh' -o -name '*.yaml' \
                 -o -name '*.yml' -o -name '*.md' -o -name '*.html' -o -name '*.js' \
                 -o -name '*.json' -o -name '*.Dockerfile' \) 2>/dev/null ) | sed 's|^\./||' | sort
}

while IFS= read -r rel; do
  case "$rel" in
    */.*|.*) continue ;;                      # workspace scratch (.pol.py, .show.py …)
    p281/comment-*|p281/pr-*|comment-*|issue-*) continue ;;   # drafts, never published as files
    config/generated/*) continue ;;           # written by cfg.py per host, not published
  esac
  if is_known "$rel"; then
    echo "  skip (documented difference)  $rel"
    continue
  fi
  if [ ! -f "$repo/$sub/$rel" ]; then
    echo "  only in the workspace          $rel"
    missing=$((missing + 1))
    continue
  fi
  checked=$((checked + 1))
  if ! diff -q "$here/$rel" "$repo/$sub/$rel" >/dev/null 2>&1; then
    echo "  DIFFERS                        $rel"
    drift=$((drift + 1))
  fi
done < <(list_tree "$here")

# The other direction: a file that is still published but no longer exists here. A step deleted in
# the workspace (steps/novel_reviews.py, steps/trade_lanes.py when their work moved into the
# platform capability) stays in the repository unless it is removed there too, and a reader would
# run code that nothing here produces any more.
while IFS= read -r rel; do
  case "$rel" in
    */.*|.*) continue ;;
    p281/comment-*|p281/pr-*|comment-*|issue-*) continue ;;
    config/generated/*) continue ;;
  esac
  is_known "$rel" && continue
  if [ ! -f "$here/$rel" ]; then
    echo "  PUBLISHED, NOT HERE            $rel"
    drift=$((drift + 1))
  fi
done < <(list_tree "$repo/$sub")

echo
echo "compared $checked file(s); $drift differ, $missing not published yet"
[ "$drift" -eq 0 ] || { echo "MIRROR DRIFT — the published copy is not what was measured"; exit 1; }
echo "MIRROR OK"
