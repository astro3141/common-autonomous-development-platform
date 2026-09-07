/** TD §20.6 item 7: deployment-control scheduled attestation refresh. */

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { startAttestRefresh, type AttestRefreshTimer } from "../live/attestRefresh.ts";
import { resolveActivePolicy } from "../kernel/policyState.ts";
import { makeHarness, runChain, sealScriptedRequest, stopSharedOpa } from "./support/harness.ts";

after(() => stopSharedOpa());

class FakeTimer implements AttestRefreshTimer<number> {
  callback: (() => void) | undefined;
  delay: number | undefined;
  cleared: number[] = [];
  setInterval(callback: () => void, delayMs: number): number {
    this.callback = callback;
    this.delay = delayMs;
    return 7;
  }
  clearInterval(handle: number): void { this.cleared.push(handle); }
  tick(): void { assert.ok(this.callback); this.callback(); }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("schedule omitted: no refresh occurs and recheck #8 retains its stale-boundary refusal", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    await h.sealTargetIdentity();
    const original = h.store.latestEvidenceOfKind("CREDENTIAL_REACH_ATTESTATION")!;
    const maxAgeMs = resolveActivePolicy(h.store, h.cas).config.reach_attestation_max_age_s * 1000;
    h.clock.now = Date.parse(original.produced_at) + maxAgeMs + 1; // existing #8: older than max_age

    const { request } = sealScriptedRequest(h);
    const result = await runChain(h, request.effect_id);
    assert.equal(result.admitted?.kind, "REFUSAL");
    if (result.admitted?.kind === "REFUSAL") assert.equal(result.admitted.reason, "CREDENTIAL_REACH_STALE");
    assert.equal(h.store.latestEvidenceOfKind("CREDENTIAL_REACH_ATTESTATION")!.evidence_id, original.evidence_id);
  } finally { h.close(); }
});

test("opt-in fake timer invokes the existing attest cycle at half max-age and seals a fresh envelope", async () => {
  const h = await makeHarness();
  try {
    h.sealReach();
    const before = h.store.latestEvidenceOfKind("CREDENTIAL_REACH_ATTESTATION")!;
    const maxAgeS = resolveActivePolicy(h.store, h.cas).config.reach_attestation_max_age_s;
    const timer = new FakeTimer();
    const invocations: string[] = [];
    const schedule = startAttestRefresh(maxAgeS, async () => {
      invocations.push("ctl attest");
      h.sealReach(false); // scripted invocation: no real probe
    }, timer);

    assert.equal(timer.delay, maxAgeS * 1000 / 2);
    h.clock.now = Date.parse(before.produced_at) + timer.delay!;
    timer.tick();
    await flush();
    const fresh = h.store.latestEvidenceOfKind("CREDENTIAL_REACH_ATTESTATION")!;
    assert.deepEqual(invocations, ["ctl attest"]);
    assert.notEqual(fresh.evidence_id, before.evidence_id);
    assert.ok(Date.parse(fresh.produced_at) >= Date.parse(before.produced_at), "the half-window tick appends a newer envelope");
    schedule.stop();
    assert.deepEqual(timer.cleared, [7]);
  } finally { h.close(); }
});

test("one failing scheduled probe is sealed failing once, never retried into a pass", async () => {
  const h = await makeHarness();
  try {
    const timer = new FakeTimer();
    let calls = 0;
    startAttestRefresh(100, async () => {
      calls += 1;
      h.sealReach(true); // the scripted ctl attest honestly observed an alternate path
    }, timer);
    timer.tick();
    await flush();

    const latest = h.store.latestEvidenceOfKind("CREDENTIAL_REACH_ATTESTATION")!;
    assert.equal(calls, 1, "a failing result is not retried");
    assert.equal((latest.claim as { alternate_path_found: boolean }).alternate_path_found, true);
    await h.sealTargetIdentity();
    const { request } = sealScriptedRequest(h);
    const result = await runChain(h, request.effect_id);
    assert.equal(result.admitted?.kind, "REFUSAL");
    if (result.admitted?.kind === "REFUSAL") assert.equal(result.admitted.reason, "ALTERNATE_CREDENTIAL_PATH_FOUND");
  } finally { h.close(); }
});

test("scheduler is ctl/live-only and cannot submit kernel identity probes as reach evidence", async () => {
  const h = await makeHarness();
  try {
    const timer = new FakeTimer();
    let attestCalls = 0;
    startAttestRefresh(100, async () => { attestCalls += 1; h.sealReach(); }, timer);
    await h.sealTargetIdentity(); // exact kernel setInterval body, invoked directly without waiting
    assert.equal(attestCalls, 0);
    assert.equal(h.store.latestEvidenceOfKind("CREDENTIAL_REACH_ATTESTATION"), undefined);
    assert.ok(h.store.latestEvidenceOfKind("PEP_TARGET_IDENTITY") !== undefined);
  } finally { h.close(); }
});
