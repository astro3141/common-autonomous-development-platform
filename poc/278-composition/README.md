# #278 commodity composition PoC — reproducible baseline

Config-only artifacts of the #278 PoC: Conductor (workflow) + Preloop (model gateway, MCP
safety layer, approvals) + MLflow (traces) + a deterministic Gate, run in an egress-isolated
container. Committed for #281 Phase 0 so later work stands on a versioned baseline.

- Start here: [RUNBOOK.md](RUNBOOK.md) — bring-up from a fresh clone, isolation checks, how to
  re-check each CONFIG_ONLY path, STOP.
- Findings, receipt and corrections are on issues #278, #279, #280; not duplicated here.
- No credentials, keys or measured raw logs are in this directory (`evidence/` holds empty
  placeholders only).

This is PoC material, not CADP implementation; the #277 freeze is unaffected
(AUTHORITY_EFFECT: NONE).
