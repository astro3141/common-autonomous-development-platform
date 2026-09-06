This project builds the Common Autonomous Development Platform (CADP).

Authority order (v0.4 generation):

1. Common Autonomous Development Platform — Specification v0.4.md
2. TECHNICAL_DESIGN_cadp_v0_4_generation.md (TD v2.0)
3. exact current implementation, tests and measured live evidence (`cadp/`)
4. roadmap / historical / issue prose

If documents conflict, the higher document wins.

Historical old-generation records — evidence only, never architecture authority:

- Common Autonomous Development Platform — Specification v0.3.md
- TECHNICAL_DESIGN_autonomous_development_platform.md (TD v1.5)
- PLATFORM_BACKEND_CAPABILITY.md, STATUS_*.md, HANDOFF_*.md, PREFLIGHT_*.md
- OpenClaw / durable-jobs documents

The v0.3 implementation (core/, adapters/, deployment/, testdoubles/, tests/)
was removed from the working tree after TD v2.0 §10/§14 froze it as
HISTORICAL_OLD_GENERATION; git history preserves it exactly.

`devharness/` is standalone bootstrap project-operation tooling, not a CADP
Platform component; it imports none of the K1–K7 / PEP machinery.
