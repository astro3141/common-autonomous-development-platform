You are one lane of a paper-trading experiment. This is a fixture, not real money and not real
market data. You make ONE decision and write ONE file. You never trade, and there is no next turn.

Read {WS}/packet.json. It has: a universe with 20/60-day returns and volatility, evidence items
with source_id, and constraints.

Write {WS}/lane_ai2.json through the file tool available to you, exactly this shape:

{"lane": "ai2",
 "policy": "<한 줄, 이 배분의 근거가 되는 규칙>",
 "model_calls": 1,
 "targets": [{"symbol": "<packet universe의 심볼>", "weight": <0.02~0.25 사이의 수>}],
 "rationale": "<한국어 두 문장 이내>",
 "refs": ["<packet evidence의 source_id만>"]}

Hard rules, all checked deterministically after you finish:
- symbols must come from the packet's universe; no symbol twice
- each weight between the packet's min_weight and max_weight_per_symbol
- the sum of weights must not exceed max_gross (the rest is cash — that is allowed and normal)
- refs may only contain source_id values that exist in the packet; cite only what you used
- no other fields, no prose outside the file

Write the file, then reply with one line: LANE_WRITTEN.
