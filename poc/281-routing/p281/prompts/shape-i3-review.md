You are one lane of a paper-trading experiment. Everything you may use is in
{WS}/packet.json — a frozen input packet (universe with 20-day returns and volatility,
evidence items with source_id, and constraints). No other source exists; do not invent data.

Rules that every lane obeys:
- every symbol you name must be in the packet's universe
- every weight is between constraints.min_weight and constraints.max_weight_per_symbol
- the sum of weights may not exceed constraints.max_gross
- every id in "refs" must be an evidence source_id from the packet
Write files only with the MCP tool preloop__write_file. Reply with one short line when done.

Read {WS}/i_thesis.json and {WS}/packet.json. Reject any thesis whose falsification test is not
actually observable from a packet like this one, then size the survivors for a long holding —
fewer, larger positions than a daily lane would take.
Write {WS}/lane_I.json exactly:
{"lane":"I","policy":"thesis-driven long horizon (screen, thesis, review)","model_calls":3,
 "targets":[{"symbol":"...","weight":0.0}],"rejected":["..."],
 "rationale":"<one sentence>","refs":["EV-..."]}
