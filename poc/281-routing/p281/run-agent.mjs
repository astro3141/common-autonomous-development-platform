// #281 routing/execution layer — one entry point for every provider.
//
//   node run-agent.mjs <request.json>          prints one normalized result JSON on stdout
//
// request.json: { run_id, provider, model?, cwd, prompt, timeout_ms?, evidence_dir? }
//
// Everything vendor-specific lives in PROVIDERS below. The caller (Conductor), Preloop and
// MLflow see the same request and result shape whichever provider runs.
//
// Permission: every ACP permission request goes to Preloop's native-tool permission check.
// The adapter decides nothing itself — it forwards with no client decision, so Preloop
// escalates to its approval channel, and maps the answer back. Any failure on that path
// (unreachable, bad response, exception) is a rejection. The acpx fallback policy is
// deny-all, so a handler that throws or returns undefined still cannot allow.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, globSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { createAcpRuntime, createRuntimeStore } from "/opt/npm-global/lib/node_modules/acpx/dist/runtime.js";
import { createAgentRegistry } from "/opt/npm-global/lib/node_modules/acpx/dist/agent-registry.js";

// Direct to the api, not through the console proxy: nginx cuts the held-open approval at 300 s
// with a 504 page, just before Preloop answers `timed_out` (~302 s), turning "approval expired"
// into "control unavailable".
// Own variable: the container already sets PRELOOP_URL=http://console for the Preloop CLI.
const PRELOOP_URL = process.env.PRELOOP_API_URL ?? "http://api:8000";

// Option B egress: the routing layer's allowlist proxy. Preloop (tools, approvals), MLflow and
// in-network names stay direct.
const EGRESS = {
  HTTPS_PROXY: "http://egress:8888", HTTP_PROXY: "http://egress:8888",
  https_proxy: "http://egress:8888", http_proxy: "http://egress:8888",
  NO_PROXY: "console,api,gateway,mlflow,localhost,127.0.0.1",
  no_proxy: "console,api,gateway,mlflow,localhost,127.0.0.1",
};

// ---- vendor-specific: the only place a provider is named -------------------------------
const PROVIDERS = {
  claude: {
    agent: "claude",
    preloopSource: "claude_code",
    // acpx does not load user settings, so the gateway route is passed explicitly. The
    // values are read from the container's own settings at run time and never persisted
    // (agentProcessEnv is child-only).
    env() {
      const s = JSON.parse(readFileSync(join(homedir(), ".claude/settings.json"), "utf8")).env ?? {};
      const keep = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"];
      return Object.fromEntries(keep.filter((k) => s[k]).map((k) => [k, s[k]]));
    },
    // Option B: the routing layer's own Claude login (CLAUDE_CONFIG_DIR=/route/claude, a lineage
    // separate from the one Preloop custodies) through the allowlist proxy. The gateway variables
    // from env() are NOT passed on this route (directReplacesEnv), so nothing points at Preloop's
    // gateway. CLAUDE_CONFIG_DIR also moves Claude's user tier (settings, .claude.json) away from
    // ~/.claude, where onboarding installed the Preloop hook and MCP entry.
    directEnv() { return { CLAUDE_CONFIG_DIR: "/route/claude", ...EGRESS }; },
    directReplacesEnv: true,
    // This principal's Preloop MCP bearer (onboarding wrote it into ~/.claude.json).
    mcpAuth() {
      return JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")).mcpServers.preloop.headers.Authorization;
    },
    // Native write/shell removed through the workspace's project settings — acpx loads that
    // tier, and a deny rule cannot be lifted by another tier. The Preloop policy forbids MCP
    // writes under .claude/, so the agent cannot rewrite this file.
    disableNative(cwd) {
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      writeFileSync(join(cwd, ".claude/settings.json"), JSON.stringify(
        { permissions: { deny: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"] } }) + "\n");
      return {};
    },
    // A call to the Preloop MCP server that the adapter itself attached. Its decision is made
    // by Preloop's rules at the MCP proxy, so it is not sent to human approval as well.
    // (Measured: an `allow: ["mcp__preloop"]` rule in project settings did not stop Claude
    // from asking for this ACP-attached, `source: "dynamic"` server.)
    governedDownstream(raw) {
      const s = raw.toolCall?._meta?.claudeCode?.mcpServer;
      return s?.name === "preloop" && s?.source === "dynamic";
    },
  },
  codex: {
    agent: "codex",
    preloopSource: "codex_cli",
    // Gateway route comes from ~/.codex/config.toml (Preloop onboarding), which codex-acp
    // reads — unlike acpx's Claude profile. The default ACP mode "agent" hands approvals to
    // Codex's own Guardian reviewer model; "read-only" hands them to the ACP client.
    env() { return { INITIAL_AGENT_MODE: "read-only" }; },
    // Option B: the routing layer owns the provider connection. Its own login lineage lives in
    // /route/codex (not the Preloop-custodied one in ~/.codex); traffic leaves only through the
    // allowlist proxy. The Preloop gateway is not on this path.
    directEnv() {
      return { CODEX_HOME: "/route/codex", ...EGRESS };
    },
    // Rollouts record no account. The adapter therefore writes a ledger entry per run binding
    // Codex's session id to the login it ran as, so the quota collector can refuse a rollout
    // written under another login (A→B re-login in the same CODEX_HOME).
    accountFingerprint(direct) {
      const home = direct ? "/route/codex" : join(homedir(), ".codex");
      const tok = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")).tokens?.id_token ?? "";
      const claims = JSON.parse(Buffer.from((tok.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") || "{}");
      return claims.email ? "email:" + createHash("sha256").update(claims.email.toLowerCase()).digest("hex").slice(0, 16) : null;
    },
    sessionLedger: "/route/codex-session-ledger.jsonl",
    mcpAuth() {
      const t = readFileSync(join(homedir(), ".codex/config.toml"), "utf8");
      const m = t.match(/\[mcp_servers\.preloop\.http_headers\][^[]*?Authorization\s*=\s*'([^']+)'/);
      if (!m) throw new Error("no Preloop MCP bearer in ~/.codex/config.toml");
      return m[1];
    },
    // Shell removed by feature flags. apply_patch has no off switch in this Codex; it stays
    // and, in read-only mode, every use escalates to Preloop approval.
    disableNative() {
      // default_tools_approval_mode=approve on the Preloop MCP server: those calls are decided
      // by Preloop rules downstream. Without it Codex asks the client, and its request names
      // neither the server nor the tool (`_meta.is_mcp_tool_approval` only).
      // The server is defined here in full (url, bearer) rather than relying on the entry
      // Preloop onboarding wrote into ~/.codex/config.toml: with CODEX_HOME=/route/codex that
      // file is not read, and a bare `default_tools_approval_mode` then attaches to nothing
      // (measured: the MCP call went back to human approval). Env only — never written to disk.
      return { CODEX_CONFIG: JSON.stringify({
        features: { shell_tool: false, unified_exec: false },
        mcp_servers: { preloop: {
          url: `${process.env.PRELOOP_URL ?? "http://console"}/mcp/v1`,
          http_headers: { Authorization: this.mcpAuth() },
          default_tools_approval_mode: "approve",
        } },
      }) };
    },
    // Codex gets the Preloop MCP server from CODEX_CONFIG above; attaching it over ACP as well
    // would define it twice.
    mcpViaConfig: true,
  },
  grok: {
    agent: "grok-build",
    // xAI's own ACP mode. --no-leader: a fresh backend per run; the shared "leader" process
    // would let runs (and potentially logins) share one agent backend.
    argv: process.env.GROK_TAP ? ["sh", "/work/p281/grok-tap.sh"] : ["grok", "agent", "--no-leader", "stdio"],
    preloopSource: "grok_build",
    // Direct only: there is no Preloop gateway route for Grok. The routing layer's own login
    // (GROK_HOME=/route/grok) and the allowlist proxy.
    env() { return {}; },
    // HOME is separate too: Grok imports Claude Code's user settings from $HOME (~/.claude,
    // ~/.claude.json) for compatibility. Measured: it ran the Preloop PreToolUse hook that
    // onboarding installed for Claude on every Grok tool call — each became a human approval
    // request labelled `claude_code`, and each stalled the run for the hook's 300 s timeout.
    directEnv() { return { GROK_HOME: "/route/grok", HOME: "/route/grok/home", ...EGRESS }; },
    directOnly: true,
    // Grok is not onboarded to Preloop, so it has no principal of its own yet; see FINDINGS.
    mcpAuth() {
      return JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")).mcpServers.preloop.headers.Authorization;
    },
    disableNative() { return {}; },
    // Grok did not connect an MCP server handed over ACP (no connection attempt in its log;
    // its tool search waited ~5 min per call for a server "still connecting"). The same server
    // registered in its own config (/route/grok/config.toml, `grok mcp add preloop …`) is healthy.
    mcpViaConfig: true,
    // A call to a tool of the Preloop MCP server (registered as "preloop" in Grok's own config):
    // decided by Preloop's rules at the MCP proxy, so not sent to human approval as well.
    // Normally unreachable: /route/grok/config.toml carries `[permission] allow =
    // ["MCPTool(preloop__*)"]` and denies Bash/Edit/Write/WebFetch/WebSearch, so Grok neither
    // asks about Preloop MCP calls nor runs native write/shell tools. Kept as a fallback.
    governedDownstream(raw) {
      const tc = raw.toolCall ?? {};
      return tc._meta?.["x.ai/tool"]?.name === "use_tool" && tc.rawInput?.variant === "UseTool"
        && typeof tc.rawInput?.tool_name === "string" && tc.rawInput.tool_name.startsWith("preloop__");
    },
  },
};
// -----------------------------------------------------------------------------------------

function preloopToken() {
  const [p] = globSync(join(homedir(), ".preloop/agents/*/permission_hook.json"));
  return JSON.parse(readFileSync(p, "utf8")).token;
}

function postJson(url, obj, signal) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(obj);
    const rq = http.request(url, {
      method: "POST", signal,
      headers: { Authorization: `Bearer ${preloopToken()}`, "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let b = "";
      res.setEncoding("utf8").on("data", (c) => (b += c)).on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    rq.on("error", reject);
    rq.end(data);
  });
}

async function askPreloop(req, { provider, runId, cwd, signal, log, mcpOnly }) {
  const tc = req.raw.toolCall ?? {};
  if (mcpOnly && PROVIDERS[provider].governedDownstream?.(req.raw)) {
    log({ at: new Date().toISOString(), acp_kind: tc.kind ?? null, title: tc.title ?? null,
      raw: req.raw, outcome: "allow_once", denial: null, preloop: null, error: null,
      routed: "preloop_mcp_rules" });
    return { outcome: "allow_once" };
  }
  const body = {
    tool_name: tc.title?.split(" ")[0] || tc.kind || "unknown",
    // What the approver sees. Claude puts the target in rawInput; Codex sends rawInput null
    // and carries the edit as ACP diff content + locations. Forward both, so an approver is
    // never asked to approve "Edit files" with no file named.
    tool_input: {
      ...(tc.rawInput ?? {}),
      _acp_kind: tc.kind ?? req.inferredKind, _acp_title: tc.title,
      _acp_locations: (tc.locations ?? []).map((l) => l.path),
      _acp_diffs: (tc.content ?? []).filter((c) => c.type === "diff")
        .map((c) => ({ path: c.path, new_text: (c.newText ?? "").slice(0, 4000), is_new: c.oldText == null })),
    },
    source: PROVIDERS[provider].preloopSource,
    session_id: runId,
    cwd,
    agent_reasoning: `run ${runId} via acpx/${provider}`,
    // client_decision deliberately omitted: the adapter holds no policy of its own.
  };
  const started = Date.now();
  let ans, err;
  try {
    // node:http, not fetch: undici's default headersTimeout is 300 s, which cuts the held-open
    // approval just before Preloop answers `timed_out` (~302 s). The run deadline (signal)
    // is the only bound here.
    const r = await postJson(`${PRELOOP_URL}/api/v1/agents/permission-check`, body, signal);
    if (r.status !== 200) throw new Error(`permission-check http ${r.status}`);
    ans = JSON.parse(r.body);
    if (ans.decision !== "allow" && ans.decision !== "deny") throw new Error(`unexpected decision ${ans.decision}`);
  } catch (e) { err = String(e?.message ?? e); }
  const ev = {
    at: new Date().toISOString(), ms: Date.now() - started,
    acp_kind: tc.kind ?? req.inferredKind ?? null, title: tc.title ?? null, input: body.tool_input,
    raw: req.raw,   // local evidence only; never sent anywhere
    preloop: ans ?? null, error: err ?? null,
    outcome: ans?.decision === "allow" ? "allow_once" : "reject_once",
    denial: ans?.decision === "allow" ? null
      : signal?.aborted ? "run_ended_awaiting_approval"
      : err ? "control_unavailable" : ans.timed_out ? "approval_expired" : "denied",
  };
  log(ev);
  return { outcome: ev.outcome };
}

async function main() {
  const req = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const prof = PROVIDERS[req.provider];
  if (!prof) throw new Error(`unknown provider ${req.provider}`);
  const evDir = req.evidence_dir ?? `/tmp/p281/runs/${req.run_id}`;
  mkdirSync(evDir, { recursive: true });
  const permissions = [];
  const log = (ev) => { permissions.push(ev); appendFileSync(join(evDir, "permissions.jsonl"), JSON.stringify(ev) + "\n"); };

  // native_tools: false → option B. File work goes through Preloop's MCP endpoint, where
  // Preloop rules decide; the vendor's native write/shell tools are removed where the vendor
  // allows it, and whatever remains still escalates to Preloop approval.
  const mcpOnly = req.native_tools === false;
  const extraEnv = mcpOnly ? prof.disableNative(req.cwd) : {};
  // model_route: "direct" → the routing layer's own login + allowlist proxy; otherwise the
  // Preloop model gateway (the #278 path). Refused if the provider has no direct profile.
  const direct = req.model_route === "direct" || !!prof.directOnly;
  if (direct && !prof.directEnv) throw new Error(`no direct route for ${req.provider}`);
  const routeEnv = direct ? prof.directEnv() : {};
  const mcpServers = mcpOnly && !prof.mcpViaConfig ? [{
    type: "http", name: "preloop", url: `${process.env.PRELOOP_URL ?? "http://console"}/mcp/v1`,
    headers: [{ name: "Authorization", value: prof.mcpAuth() }],
  }] : undefined;

  const runtime = createAcpRuntime({
    cwd: req.cwd,
    mcpServers,
    agentProcessEnv: { ...(direct && prof.directReplacesEnv ? {} : prof.env()), ...extraEnv, ...routeEnv },
    sessionStore: createRuntimeStore({ stateDir: join(evDir, "acpx-state") }),
    agentRegistry: createAgentRegistry(prof.argv ? { overrides: { [prof.agent]: prof.argv } } : undefined),
    permissionMode: "deny-all",                 // fallback if the handler throws / returns undefined
    nonInteractivePermissions: "deny",
    timeoutMs: req.timeout_ms ?? 600000,
  });

  let accountAtStart = null;
  try { accountAtStart = prof.accountFingerprint?.(direct) ?? null; } catch { accountAtStart = null; }
  const t0 = Date.now();
  const text = [], usage = [], mcpDenials = [];
  let result, handle, failure;
  try {
    // A fresh session key per run: acpx keys sessions on (agent, cwd, name) with no account
    // or policy, so reuse across runs could carry one account's session into another's.
    handle = await runtime.ensureSession({
      sessionKey: `p281-${req.run_id}`, agent: prof.agent, mode: "oneshot", cwd: req.cwd,
      sessionOptions: req.model ? { model: req.model } : undefined,
    });
    const turn = runtime.startTurn({
      handle, text: req.prompt, mode: "prompt", requestId: `${req.run_id}-1`,
      onPermissionRequest: (r, { signal }) => askPreloop(r, { provider: req.provider, runId: req.run_id, cwd: req.cwd, signal, log, mcpOnly }),
    });
    for await (const ev of turn.events) {
      if (ev.type === "text_delta" && ev.stream !== "thought") text.push(ev.text);
      if (ev.type === "status" && ev.tag === "usage_update") usage.push(ev);
      // Preloop's MCP proxy returns a rule denial as an ordinary result (isError: false)
      // whose text starts "Access denied:". Matching that text is the only signal available;
      // it is fragile and would break silently if Preloop rewords it.
      if (ev.type === "tool_call" && /Access denied:/.test(JSON.stringify(ev.rawOutput ?? ev.content ?? ev.text ?? "")))
        mcpDenials.push({ title: ev.title ?? null, toolCallId: ev.toolCallId ?? null,
          text: JSON.stringify(ev.rawOutput ?? ev.content ?? ev.text).match(/Access denied:[^"\\]*/)?.[0] ?? null });
      appendFileSync(join(evDir, "events.jsonl"), JSON.stringify(ev) + "\n");
    }
    result = await turn.result;
  } catch (e) {
    failure = { message: String(e?.message ?? e), code: e?.code };
  }
  let status = null;
  try { if (handle) status = await runtime.getStatus({ handle }); } catch { /* best effort */ }
  try { await runtime.shutdown(); } catch { /* best effort */ }
  if (prof.sessionLedger && status?.backendSessionId) {
    let accountAtEnd = null;
    try { accountAtEnd = prof.accountFingerprint(direct); } catch { accountAtEnd = null; }
    appendFileSync(prof.sessionLedger, JSON.stringify({
      session_id: status.backendSessionId, run_id: req.run_id, at: new Date().toISOString(),
      // a login that changed during the run binds the session to no account
      account: accountAtStart && accountAtStart === accountAtEnd ? accountAtStart : null,
      account_at_start: accountAtStart, account_at_end: accountAtEnd }) + "\n");
  }

  // Normalized status. TIMED_OUT = the run deadline passed while an approval was still open;
  // the run deadline must exceed the approval window or every unanswered approval ends here.
  // A denial is never a generic failure: it must not be retried on
  // another provider, because that would turn "not approved" into "try someone else".
  const denials = permissions.filter((p) => p.outcome !== "allow_once");
  const norm =
    denials.some((d) => d.denial === "run_ended_awaiting_approval") ? "TIMED_OUT"
    : denials.some((d) => d.denial === "control_unavailable") ? "CONTROL_UNAVAILABLE"
    : denials.length || mcpDenials.length ? "DENIED"
    : failure || result?.status === "failed" ? "FAILED"
    : result?.status === "cancelled" ? "CANCELLED"
    : "COMPLETED";

  const out = {
    run_id: req.run_id,
    status: norm,
    retryable_elsewhere: norm === "FAILED" && (result?.error?.retryable ?? false),
    provider: req.provider,
    model: {
      requested: req.model ?? null,
      session_reported: status?.models?.currentModelId ?? status?.model ?? null,
      served: "unknown",   // nothing on this path reports the served model; do not infer it
    },
    permissions: permissions.map(({ acp_kind, title, outcome, denial, preloop, error, routed }) =>
      ({ acp_kind, title, outcome, denial, request_id: preloop?.request_id ?? null, error, routed: routed ?? "preloop_approval" })),
    mcp_denials: mcpDenials,
    native_tools: !mcpOnly,
    model_route: direct ? "direct" : "preloop_gateway",
    turn: result ?? null,
    failure: failure ?? null,
    text: text.join(""),
    wall_ms: Date.now() - t0,
    evidence_dir: evDir,
  };
  writeFileSync(join(evDir, "result.json"), JSON.stringify({ ...out, status_raw: status, usage_events: usage }, null, 1));
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exitCode = norm === "COMPLETED" ? 0 : norm === "DENIED" ? 3 : 1;
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ status: "FAILED", failure: { message: String(e?.message ?? e) } }) + "\n");
  process.exitCode = 1;
});
