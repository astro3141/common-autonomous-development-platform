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
# Exit 1 on any difference. Two files are expected to differ and are listed, not compared (§1):
# docker/compose.poc.yaml and docker/agent.Dockerfile.
set -euo pipefail

repo="${1:-D:/Work/cadp}"
here="$(cd "$(dirname "$0")/.." && pwd)"
sub="poc/281-routing"
known_different="docker/compose.poc.yaml docker/agent.Dockerfile"

[ -d "$repo/$sub" ] || { echo "no $sub in $repo"; exit 2; }

drift=0
missing=0
checked=0

is_known() {
  for k in $known_different; do [ "$1" = "$k" ] && return 0; done
  return 1
}

# Every code and document file of the workspace's published surface.
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
done < <(cd "$here" && find p281 ops hub scripts config docker policy \
           -type f \( -name '*.py' -o -name '*.mjs' -o -name '*.sh' -o -name '*.yaml' \
                      -o -name '*.yml' -o -name '*.md' -o -name '*.html' -o -name '*.js' \
                      -o -name '*.json' -o -name '*.Dockerfile' \) 2>/dev/null | sed 's|^\./||' | sort)

echo
echo "compared $checked file(s); $drift differ, $missing not published yet"
[ "$drift" -eq 0 ] || { echo "MIRROR DRIFT — the published copy is not what was measured"; exit 1; }
echo "MIRROR OK"
