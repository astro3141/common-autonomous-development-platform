#!/bin/sh
# Call Preloop's native-tool permission check directly. Token read from the container's own
# agent permission_hook.json; never printed.
# usage: pcheck.sh <tool_name> <client_decision|-> <tool_input_json> [max_time]
TOK=$(python3 -c "import json,glob;print(json.load(open(glob.glob(\"/home/agent/.preloop/agents/*/permission_hook.json\")[0]))[\"token\"])")
CD=$2; [ "$CD" = "-" ] && CD=null || CD="\"$CD\""
curl -s --max-time "${4:-15}" -w '\nhttp=%{http_code} t=%{time_total}\n' \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "{\"tool_name\":\"$1\",\"tool_input\":$3,\"source\":\"acpx_probe\",\"session_id\":\"p281-probe\",\"cwd\":\"/tmp/p281\",\"client_decision\":$CD}" \
  http://console/api/v1/agents/permission-check
