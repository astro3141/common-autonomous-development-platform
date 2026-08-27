This project builds the Common Autonomous Development Platform.

It does NOT continue the OpenClaw durable-jobs project.

OpenClaw and durable-jobs are Backend v1 dependencies/reusable assets only.

Do not modify OpenClaw or durable-jobs merely to satisfy the new platform architecture
unless the current TD explicitly identifies a required backend implementation gap.

The long-lived asset is the deterministic Common Platform Core,
not any specific runtime or workflow backend.

Authority order:

1. Common Autonomous Development Platform Specification v0.3
2. TECHNICAL_DESIGN_autonomous_development_platform.md
3. PLATFORM_BACKEND_CAPABILITY.md
4. STATUS_workflow_harness.md

If documents conflict, the higher document wins.

Old OpenClaw/durable-jobs documents are historical evidence only.
They must not redefine Common Platform architecture.
