#!/bin/sh
# Diagnostic only: run Grok's ACP server and record the JSON-RPC traffic in both directions.
D=${GROK_TAP_DIR:-/tmp/p281/grok-tap}; mkdir -p "$D"
tee -a "$D/client-to-grok.jsonl" | grok agent --no-leader stdio | tee -a "$D/grok-to-client.jsonl"
