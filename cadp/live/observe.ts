/**
 * Read-only constitutional observation CLI (#96/#106, TD §12 r8).
 *
 *   node cadp/live/observe.ts <dir> run <work_run_ref>
 *   node cadp/live/observe.ts <dir> effect <effect_id>
 *   node cadp/live/observe.ts <dir> attribution <work_run_ref>
 *
 * Authenticates ONLY as `cadp-observer`, whose Kernel reach is the four read methods — it cannot
 * seal, submit, assemble, evaluate, admit or reconcile, so nothing it prints can be a fact it
 * manufactured. All derivations live in cadp/product/observationProjection.ts and are labelled
 * projections; there is no direct database path.
 */

import { loadManifest } from "./env.ts";
import { KernelClient } from "../clients/kernelClient.ts";
import { attempt, attribution, chainProjection, collectRun, humanWait, projectEffect } from "../product/observationProjection.ts";

const [, , dir, command, subject] = process.argv;
if (dir === undefined || command === undefined || subject === undefined) {
  console.error("usage: node cadp/live/observe.ts <dir> run|effect|attribution <ref>");
  process.exit(2);
}
const m = loadManifest(dir);
const token = m.tokens["cadp-observer"];
if (token === undefined) throw new Error("no cadp-observer token in the live manifest — re-run env setup");
const observer = new KernelClient(m.api_url, token);

if (command === "effect") {
  const state = await attempt(() => observer.getEffectState(subject));
  console.log(JSON.stringify({ projection: "read-only", effect: projectEffect(subject, state) }, null, 2));
} else if (command === "run" || command === "attribution") {
  const run = await collectRun(observer, subject);
  if (command === "attribution") {
    console.log(JSON.stringify({ work_run_ref: subject, ...attribution(run) }, null, 2));
  } else {
    console.log(
      JSON.stringify(
        {
          projection: "read-only (observer reach: get_effect_state, list_effects, get_evidence, list_evidence)",
          work_run_ref: subject,
          evidence_query: run.summaries.query === "COMPLETE" ? { query: "COMPLETE", rows: run.summaries.value.evidence.length } : run.summaries,
          effects_query: run.effectIds.query === "COMPLETE" ? { query: "COMPLETE", rows: run.effectIds.value.effect_ids.length } : run.effectIds,
          steps: chainProjection(run.byKind("WORK_STEP")),
          bound_stops: run.byKind("WORK_BOUND_STOP").map((e) => e.claim),
          incidents: run.byKind("KERNEL_INCIDENT").map((e) => ({ evidence_id: e.evidence_id, claim: e.claim })),
          human_policy_wait: humanWait(run.effects),
          effects: run.effects.map(({ state: _state, ...rest }) => rest),
        },
        null,
        2,
      ),
    );
  }
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
