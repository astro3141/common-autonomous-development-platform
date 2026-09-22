#!/bin/sh
# Runs inside cadp278-quota (egress, own logins). Every INTERVAL seconds, writes the raw
# CodexBar observation plus the observer's own clock to /obs, atomically. Emails never leave
# the stack: the agent reads this volume read-only and fingerprints them.
INTERVAL=${INTERVAL:-300}
while true; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if codexbar usage --provider codex --json > /obs/.codex.raw.tmp 2>/obs/codex.err; then
    printf '{"collected_at":"%s","exit":0,"payload":' "$ts" > /obs/.codex.tmp
    cat /obs/.codex.raw.tmp >> /obs/.codex.tmp; printf '}\n' >> /obs/.codex.tmp
  else
    printf '{"collected_at":"%s","exit":%s,"payload":null}\n' "$ts" "$?" > /obs/.codex.tmp
  fi
  mv /obs/.codex.tmp /obs/codex.raw.json
  sleep "$INTERVAL"
done
