/**
 * Allowlist CONNECT proxy for the surface egress boundary (TD §4.1 network policy).
 *
 * Surface containers run on an --internal docker network (no route to the internet, so every
 * governed target — GitHub, the record service, the Kernel — is unreachable by name, literal
 * IP, or the docker gateway). This dual-homed proxy is the ONLY hole: it forwards HTTPS CONNECT
 * tunnels to the model provider hosts in ALLOW_HOSTS and refuses everything else. Plain HTTP is
 * denied outright.
 *
 * Run: ALLOW_HOSTS=api.openai.com,api.anthropic.com node egressProxy.mjs
 */

import net from "node:net";
import http from "node:http";

const ALLOW = (process.env.ALLOW_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
const PORT = Number(process.env.PROXY_PORT ?? 8888);

function allowed(host) {
  return ALLOW.some((a) => host === a || host.endsWith("." + a));
}

const server = http.createServer((_req, res) => {
  res.writeHead(403, { "content-type": "text/plain" });
  res.end("egress proxy: plain HTTP denied (CONNECT to an allowlisted provider host only)");
});

server.on("connect", (req, clientSocket, head) => {
  const [host, portStr] = String(req.url).split(":");
  const port = Number(portStr) || 443;
  if (!allowed(host)) {
    clientSocket.write("HTTP/1.1 403 Forbidden\r\nx-egress: denied\r\n\r\n");
    clientSocket.destroy();
    return;
  }
  const upstream = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ egress_proxy: "up", port: PORT, allow: ALLOW }));
});
