# #281 routing layer — provider execution separated from Conductor, Preloop and MLflow

PoC artifacts for #281, on top of the #278 baseline in `poc/278-composition/`.

The goal: Conductor (workflow), Preloop (policy/approval) and MLflow (records) must not own
providers, so that their coverage intersection no longer limits which providers can be used.
A routing layer built on acpx owns each provider's model path, login and quota view. Claude,
Codex and Grok (subscription logins) run through it, and a router chooses among them from
provider-reported quota. Preloop keeps tool governance only.

- Start with [RUNBOOK.md](RUNBOOK.md); every measurement is in
  [p281/FINDINGS-281.md](p281/FINDINGS-281.md).
- Status: provider-separation PoC succeeded; #281 overall **PARTIAL** (open items in the
  RUNBOOK).
- No credentials, tokens or measured raw output are in this directory.

PoC material, not CADP implementation; the #277 freeze is unaffected (AUTHORITY_EFFECT: NONE).
