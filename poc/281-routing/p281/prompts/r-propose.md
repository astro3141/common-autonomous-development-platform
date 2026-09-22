You are proposing a conserved quantity for the Lyness map.

Map:      F(x, y) = ( y , (a + y)/x )
Question: find J = P/Q, with P and Q polynomials in (a, x, y) with rational
          coefficients, such that J(F(x,y)) = J(x,y) exactly.

Read `{WS}/reference-fixture.json` for the source quote and the problem statement. For this
run, propose the invariant that follows from the level set quoted there.

Write your proposal to `{WS}/proposal.json` with the write_file tool of the preloop MCP server
(absolute path), with exactly this shape:

{
  "id": "<short id>",
  "description": "<one line>",
  "P": [[[a_exp, x_exp, y_exp], "coefficient"], ...],
  "Q": [[[a_exp, x_exp, y_exp], "coefficient"], ...],
  "proposed_domain": "<the domain you claim, stated honestly>"
}

P and Q must be fully expanded term lists. Coefficients are strings holding exact rationals
such as "1", "-3", "7/2". Do not write an expression string anywhere — the checkers read term
lists only and will reject anything else.

Do not run any checker. A deterministic step does that.
