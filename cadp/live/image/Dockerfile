# Disposable surface-isolation image for the CADP v0.4 live proof (TD §4.1, §11).
# Untrusted worker (codex), verifier (candidate node --test), and reviewer (claude) run inside
# this container: the host filesystem is never mounted (only a fresh /ws checkout + a read-only
# provider credential), and egress is confined to the provider via an allowlist proxy on an
# internal docker network (governed GitHub/record/Kernel targets have no route).
#
# TD §11 measured reference surfaces are PINNED, so rebuilding this exact Git head reproduces
# the same worker/reviewer products (no mutable `latest`).
#
# NODE MAJOR = THE LOCAL VERIFIER'S RUNTIME. `runVerifier` runs the pinned invocation
# (`VERIFIER_TEST_ARGV` in cadp/product/surfaceBroker.ts) inside THIS image, so the base tag is
# what decides whether that invocation selects anything at all. Measured on node:22 (22.23.2, the
# tag this line used to carry): the test runner glob-matches each positional, and a directory
# pattern matches the DIRECTORY ITSELF, which is then loaded as a test file — `Cannot find module
# /ws/cadp/tests/conformance` — so all three suites were discovered EMPTY and `/verify` returned a
# verdict about tests it never ran. The major is therefore pinned to the one the external verifier
# already runs (`node-version: "24"` in .github/workflows/cadp-verify.yml): both verifiers execute
# the same argv on the same Node major, and conformance-gatefiles.test.ts GF8 asserts this tag,
# that workflow's version and `VERIFIER_NODE_MAJOR` are the same number. The 24 half of that
# measurement cannot be taken from inside a candidate surface (one runtime, no docker), so GF8
# takes it ON THE VERIFIER: at or above the pinned major the pinned argv MUST select all three
# suites, so a 24 that also failed to expand directories turns both verifiers red — never quiet.
# The major moves for the worker and reviewer surfaces too — they share this image — which is a
# TD §11 pin change, deliberate and human-merged with the rest of this gate machinery.
FROM node:24-bookworm-slim
# `opa` is pinned so the verifier can run CADP's OWN conformance suite (which spawns an OPA
# sidecar) when the governed target is CADP itself — self-hosting verification needs the same
# toolchain `npm test` needs on a developer host. TARGETARCH picks the matching static binary.
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
# grok (x.ai Grok Build): official linux installer `x.ai/cli/install.sh` installs to
# /root/.grok/bin/grok and symlinks /usr/local/bin/grok (on PATH). It tracks latest, so the EXACT
# version is not pinnable here — it is captured as observed tool_versions bound into WORK_START
# evidence (imageIdentity), not asserted as a requested pin. Runs headless from an injected
# ~/.grok/auth.json (subscription OAuth) — verified in a container 2026-09-06.
# NOTE: keep this one RUN free of inline `#` comments — Docker joins `\`-continued lines, so a mid-RUN
# comment would swallow the rest of the command chain.
RUN npm install -g @openai/codex@0.151.0 @anthropic-ai/claude-code@2.1.221 \
 && curl -fsSL -o /usr/local/bin/opa "https://openpolicyagent.org/downloads/v1.20.1/opa_linux_${TARGETARCH:-arm64}_static" \
 && chmod +x /usr/local/bin/opa \
 && curl -fsSL https://x.ai/cli/install.sh | bash \
 && codex --version && claude --version && opa version && grok --version
WORKDIR /ws
