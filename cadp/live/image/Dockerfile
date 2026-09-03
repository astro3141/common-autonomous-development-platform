# Disposable surface-isolation image for the CADP v0.4 live proof (TD §4.1, §11).
# Untrusted worker (codex), verifier (candidate node --test), and reviewer (claude) run inside
# this container: the host filesystem is never mounted (only a fresh /ws checkout + a read-only
# provider credential), and egress is confined to the provider via an allowlist proxy on an
# internal docker network (governed GitHub/record/Kernel targets have no route).
#
# TD §11 measured reference surfaces are PINNED, so rebuilding this exact Git head reproduces
# the same worker/reviewer products (no mutable `latest`).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@0.151.0 @anthropic-ai/claude-code@2.1.221 \
 && codex --version && claude --version
WORKDIR /ws
