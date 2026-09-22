You are the mathematical reviewer. Read these files (use the preloop MCP server's
read_text_file tool) and write a review:

  candidate    {WS}/candidate.json
  primary      {WS}/verification.primary.json
  independent  {WS}/verification.independent.json

Check, and report on, only what those files support:
  - does the stated claim match the formal input that was actually checked
  - are the denominator restrictions carried into the claimed domain
  - is the candidate a trivial or transformed version of a known invariant
  - is anything claimed that the certificate does not support

Write `{WS}/review.json` with the write_file tool of the preloop MCP server (absolute path),
with this shape:

{
  "candidate_sha256": "<copy the candidate_sha256 field from the verification files>",
  "verdict": "PASS" | "FAIL",
  "blocking_findings": ["..."],
  "notes": "..."
}

A verdict of PASS means you found nothing blocking. It is a review opinion, not evidence —
the exact verification is what establishes the mathematics.
