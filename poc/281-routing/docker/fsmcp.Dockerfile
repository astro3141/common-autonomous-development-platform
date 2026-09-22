# #281 option B: file tools as MCP, behind Preloop, so Preloop rules (not the agent) decide.
# Official filesystem MCP server (stdio) wrapped as Streamable HTTP, because Preloop only
# proxies URL-addressed MCP servers. Serves /ws only — the workspace volume shared with the
# agent at the same path, so absolute paths mean the same file on both sides.
FROM node:22-slim
RUN mkdir /ws && chown node:node /ws && npm install -g --no-fund --no-audit \
      @modelcontextprotocol/server-filesystem@2026.8.31 \
      supergateway@4.0.0
USER node
EXPOSE 8000
CMD ["supergateway", "--stdio", "mcp-server-filesystem /ws", \
     "--outputTransport", "streamableHttp", "--port", "8000", "--streamableHttpPath", "/mcp"]
