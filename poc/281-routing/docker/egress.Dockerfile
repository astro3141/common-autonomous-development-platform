# #281 option B egress proxy (allowlist). Dual-homed on purpose: governed (where the agent is)
# and egressnet (internet). It is the only such member for model traffic; it runs no other service.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tinyproxy \
    && rm -rf /var/lib/apt/lists/*
COPY egress/tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY egress/allow /etc/tinyproxy/allow
EXPOSE 8888
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
