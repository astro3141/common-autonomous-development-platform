# Disposable surface-isolation image for the CADP v0.4 live proof (TD §4.1, §11).
# Untrusted worker (codex), verifier (candidate node --test), and reviewer (claude) run inside
# this container: the host filesystem is never mounted (only a fresh /ws checkout + a read-only
# provider credential), and egress is confined to the provider via an allowlist proxy on an
# internal docker network (governed GitHub/record/Kernel targets have no route).
#
# TD §11 measured reference surfaces are PINNED, so rebuilding this exact Git head reproduces
# the same worker/reviewer products (no mutable `latest`).
FROM node:22-bookworm-slim
# `opa` is pinned so the verifier can run CADP's OWN conformance suite (which spawns an OPA
# sidecar) when the governed target is CADP itself — self-hosting verification needs the same
# toolchain `npm test` needs on a developer host. TARGETARCH picks the matching static binary.
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@0.151.0 @anthropic-ai/claude-code@2.1.221 \
 && curl -fsSL -o /usr/local/bin/opa "https://openpolicyagent.org/downloads/v1.20.1/opa_linux_${TARGETARCH:-arm64}_static" \
 && chmod +x /usr/local/bin/opa \
 && codex --version && claude --version && opa version
WORKDIR /ws
