# Disposable surface-isolation image for the CADP v0.4 live proof (TD §4.1).
# Untrusted worker (codex) and verifier (candidate `node --test`) run inside this container:
# the host filesystem is never mounted (only a fresh /ws checkout + a read-only auth.json),
# and governed target egress is controlled by the container's network settings.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex \
 && codex --version
WORKDIR /ws
