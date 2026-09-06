/**
 * CADP MCP tool surface (#61 direction pilot, recommendation B):
 *
 *   node cadp/live/mcpServer.ts <live-dir>
 *
 * A commodity single-model agent session (e.g. Claude Code with this server configured) owns the
 * whole-intent supervision loop by calling four tools. CADP owns no supervisor component:
 *
 *   cadp_plan         proposal-only decomposition → sealed WORK_PROPOSAL evidence
 *   cadp_work_start   ONE governed WORK_START through the ordinary admission (policy gates it)
 *   cadp_run_status   read-only run observation (Temporal status + kernel projections)
 *   cadp_human_state  which effects await a HUMAN decision, and how the Human (not the session)
 *                     provides it — deliberately NOT a tool that can approve anything
 *
 * stdout carries protocol bytes only; logs go to stderr. The session gets ALLOW/DENY/evidence
 * text back — never a credential, never admission authority. Work starts are capped per session
 * (direction-pilot risk 2); resumability rests on kernel state via cadp_run_status (risk 1).
 */

import { createInterface } from "node:readline";

import { handleMcpMessage, makeMcpSession, guardedWorkStart } from "../product/mcp.ts";
import type { McpTool } from "../product/mcp.ts";
import { runSnapshot, sealPlan, startWork } from "./ops.ts";
import { liveClient } from "./ops.ts";
import { collectRun, humanWait } from "../product/observationProjection.ts";

const dir = process.argv[2];
if (dir === undefined) {
  console.error("usage: node cadp/live/mcpServer.ts <live-dir>");
  process.exit(2);
}

const session = makeMcpSession(20);

const TOOLS: McpTool[] = [
  {
    name: "cadp_plan",
    description:
      "Decompose one whole work intent into bounded work items using the proposal-only planner surface. Returns a sealed WORK_PROPOSAL evidence id plus the items. The proposal confers NO authority: each item must still be started individually through cadp_work_start, and policy evaluates every start.",
    inputSchema: {
      type: "object",
      properties: { intent: { type: "string", description: "the whole work intent to decompose" } },
      required: ["intent"],
    },
    call: async (args) => sealPlan(dir, String(args["intent"] ?? "")),
  },
  {
    name: "cadp_work_start",
    description:
      "Start ONE bounded autonomous work item through the ordinary governed WORK_START admission. Policy may DENY (the refusal text is returned verbatim — read it instead of retrying). Returns { work_run_ref, workflow_id } on admission. Pass proposal_evidence_id for exact provenance when the item came from cadp_plan. Session-capped.",
    inputSchema: {
      type: "object",
      properties: {
        work_item: { type: "string" },
        max_steps: { type: "integer", minimum: 1 },
        max_effects: { type: "integer", minimum: 1 },
        proposal_evidence_id: { type: "string" },
      },
      required: ["work_item"],
    },
    call: (args) =>
      guardedWorkStart(session, async () => {
        const refusals: Array<Record<string, unknown>> = [];
        const started = await startWork(
          dir,
          "development",
          [
            String(args["work_item"]),
            args["max_steps"] !== undefined ? String(args["max_steps"]) : "8",
            args["max_effects"] !== undefined ? String(args["max_effects"]) : "6",
            ...(args["proposal_evidence_id"] !== undefined ? [String(args["proposal_evidence_id"])] : []),
          ],
          { log: (line) => refusals.push(line) },
        );
        if (started === undefined) return { admitted: false, detail: refusals };
        return { admitted: true, work_run_ref: started.effect_id, workflow_id: started.workflow_id, session_starts_used: `${session.work_starts}/${session.max_work_starts}` };
      }),
  },
  {
    name: "cadp_run_status",
    description:
      "Read-only observation of one work run: workflow status (commodity Temporal read), item classification (RUNNING / AWAITING_HUMAN_MERGE / COMPLETED / STOPPED / FAILED), effects awaiting a Human decision, and the non-authoritative failure-attribution projection derived from durable K1-K7 rows. Use this to resume supervision after any interruption — kernel state, not this conversation, is the durable truth.",
    inputSchema: {
      type: "object",
      properties: { work_run_ref: { type: "string" }, workflow_id: { type: "string" } },
      required: ["work_run_ref"],
    },
    call: (args) => runSnapshot(dir, String(args["work_run_ref"]), args["workflow_id"] !== undefined ? String(args["workflow_id"]) : undefined),
  },
  {
    name: "cadp_human_state",
    description:
      "Which effects of a work run are waiting on a HUMAN decision. This tool cannot approve anything and no tool can: a Human runs `node cadp/live/ctl.ts <dir> human-approve <effect_id> <workflow_id>` out-of-band. Report the pending list to the human and continue with other items.",
    inputSchema: {
      type: "object",
      properties: { work_run_ref: { type: "string" } },
      required: ["work_run_ref"],
    },
    call: async (args) => {
      const run = await collectRun(liveClient(dir, "cadp-observer"), String(args["work_run_ref"]));
      const waiting = humanWait(run.effects);
      return {
        human_wait: waiting,
        instruction:
          waiting.length === 0
            ? "no effect of this run awaits a Human decision"
            : `a HUMAN must run: node cadp/live/ctl.ts ${dir} human-approve <effect_id> <workflow_id> — this session must not and cannot do it`,
      };
    },
  },
];

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rl.on("line", (line) => {
  const text = line.trim();
  if (text.length === 0) return;
  void (async () => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      return;
    }
    const response = await handleMcpMessage(message, TOOLS);
    if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
  })().catch((error: unknown) => {
    console.error(`mcpServer: ${error instanceof Error ? error.message : String(error)}`);
  });
});
console.error(`cadp mcp server ready (dir=${dir}, work-start cap=${session.max_work_starts})`);
