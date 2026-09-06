/**
 * #128 surface-lifetime live probe — the bounded surface owner against a REAL docker container.
 *
 *   node cadp/live/surfaceLifetimeProbe.ts [image]
 *
 * This is a live probe, not a unit control, and it is deliberately not part of `npm test`: docker and
 * the pinned surface image are real prerequisites, so a missing one is reported as a FAILURE rather
 * than skipped. A control that silently passes when its prerequisites are absent proves nothing while
 * reading as green — which is why the deterministic half of this proof lives in the always-running T4
 * block of cadp/tests/conformance-timeout.test.ts instead.
 *
 * What it establishes, end to end, on the real docker control plane:
 *   1. an over-budget surface run ends at its DECLARED bound, bounded end to end;
 *   2. the exact container it launched is force-removed and OBSERVED gone (`TERMINATED`), with no
 *      manual intervention and no leftover container;
 *   3. a terminated run is never a success;
 *   4. an ordinary run is untouched: a real container exiting 0 or exiting non-zero keeps its own
 *      status and output and stays `EXITED` — the lifecycle repair must not relabel normal runs;
 *   5. creation is what ESTABLISHES the surface: an acknowledged create publishes the exact name, a
 *      refused one publishes nothing, and an unacknowledged create whose container appears anyway is
 *      reconciled and removed rather than reported as a clean exit (#128 F5);
 *   6. when the attached CLIENT is killed early while the container keeps running, the runner
 *      still stops and observes that container rather than reporting a surface exit (#128 F4);
 *   7. an abandoned control-plane command is CANCELLED, not merely un-awaited: a blocking
 *      `docker wait` settles when cancelled instead of leaving a live CLI child behind (#128 F7);
 *   8. GUARD BITE — the pre-repair shape (SIGKILL the attached client only, with no owner left)
 *      leaves the real container running, which is the #127/#128 defect this bound exists to remove.
 *
 * Exits 0 only when every leg holds; prints one JSON line per leg.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DOCKER_SURFACE_PORT, dockerAvailable, dockerCommand, dockerCreateArgv, dockerStartArgv, runBoundedSurface, runVerifier } from "../product/isolation.ts";
import type { IsolationConfig, SurfaceCommandPort } from "../product/isolation.ts";
import { SURFACE_TERMINATION_MS } from "../product/timeouts.ts";

const IMAGE = process.argv[2] ?? "cadp-surface:0.151.0-2.1.221";
const BITE_CONTAINER = "cadp-surface-lifetime-probe-bite";
const SURFACE_MS = 3_000;

const say = (o: Record<string, unknown>): void => { console.log(JSON.stringify(o)); };

/** A missing prerequisite is a FAILURE here — this probe exists to actually exercise docker. */
async function requirePrerequisites(): Promise<void> {
  assert.ok(await dockerAvailable(), "docker is unavailable — this probe cannot establish anything without it");
  assert.equal(
    spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status,
    0,
    `pinned surface image ${IMAGE} is not present — build it before running this probe`,
  );
}

/** Names of existing containers matching an exact identity, via the same query the port uses. */
function existing(container: string): string {
  return spawnSync("docker", ["ps", "--all", "--no-trunc", "--filter", `name=^${container}$`, "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.trim();
}

async function boundedRunTerminatesTheRealContainer(config: IsolationConfig): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cadp-surface-lifetime-"));
  try {
    const started = Date.now();
    const run = await runVerifier(config, { workspace: dir, argv: ["sh", "-c", "sleep 600"], timeout_ms: SURFACE_MS });
    const elapsed = Date.now() - started;

    assert.equal(run.timed_out, true, "the declared surface bound bit");
    assert.equal(run.surface_state, "TERMINATED", `termination of ${String(run.container)} must be OBSERVED, not merely requested`);
    assert.notEqual(run.status, 0, "a terminated surface is never a success");
    assert.ok(elapsed < SURFACE_MS + SURFACE_TERMINATION_MS, `bounded end to end (elapsed ${elapsed}ms)`);
    // The post-condition that matters: no such container exists, with no manual intervention.
    assert.equal(existing(run.container!), "", `container ${run.container!} must be gone after its bound`);

    say({ leg: "bounded-run", ok: true, container: run.container, surface_state: run.surface_state, elapsed_ms: elapsed, remaining: "" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** An ordinary real container run must keep its own status and output, and stay EXITED. */
async function ordinaryRunsAreUntouched(config: IsolationConfig): Promise<void> {
  for (const [label, argv, expected] of [
    ["success", ["sh", "-c", "echo hello; exit 0"], 0],
    ["ordinary failure", ["sh", "-c", "echo out; exit 3"], 3],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), "cadp-surface-lifetime-"));
    try {
      const run = await runVerifier(config, { workspace: dir, argv: [...argv], timeout_ms: 60_000 });
      assert.equal(run.surface_state, "EXITED", `${label}: an established container exit stays EXITED`);
      assert.equal(run.timed_out, false, `${label}: no bound was exceeded`);
      assert.equal(run.status, expected, `${label}: the container's own exit code reaches the caller`);
      say({ leg: `ordinary-${label.replace(" ", "-")}`, ok: true, status: run.status, surface_state: run.surface_state });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

/**
 * #128 F4 on the real control plane: kill the attached CLIENT early while the container keeps
 * running. The runner must not report that as a surface exit — it must stop and observe the exact
 * container, well inside the declared surface bound.
 */
async function anEarlyClientDeathStillStopsTheContainer(): Promise<void> {
  let killed: string | undefined;
  const port: SurfaceCommandPort = {
    ...DOCKER_SURFACE_PORT,
    launch(container: string) {
      const command = DOCKER_SURFACE_PORT.launch(container);
      // Once the container is really up, end only the client — the surface must survive that.
      void (async () => {
        for (let i = 0; i < 200 && existing(container) === ""; i += 1) await new Promise((r) => setTimeout(r, 100));
        killed = container;
        command.cancel();
      })();
      return command;
    },
  };
  const started = Date.now();
  const run = await runBoundedSurface(
    { kind: "verifier", args: ["--network", "none", IMAGE, "sh", "-c", "sleep 600"], timeout_ms: 300_000 },
    { port },
  );
  const elapsed = Date.now() - started;

  assert.equal(killed, run.container, "the client of THIS run is the one that was killed");
  assert.notEqual(run.surface_state, "EXITED", "a dead launcher is not an observed surface exit");
  assert.equal(run.surface_state, "TERMINATED", `the orphaned container ${String(run.container)} must be stopped and observed gone`);
  assert.notEqual(run.status, 0, "a surface that outlived its launcher is never a success");
  assert.equal(existing(run.container!), "", `container ${run.container!} must be gone with no manual intervention`);
  assert.ok(elapsed < 300_000, `resolved far inside the declared surface bound (elapsed ${elapsed}ms)`);
  say({ leg: "early-client-death", ok: true, container: run.container, surface_state: run.surface_state, status: run.status, elapsed_ms: elapsed, remaining: "" });
}

/**
 * #128 F5 on the real control plane. The creation phase really is what establishes the identity:
 * `docker create` publishes the exact name before anything is started, a refused create publishes
 * nothing, and an UNACKNOWLEDGED create whose container nonetheless appears is reconciled and
 * removed instead of being reported as a clean exit.
 */
async function creationIsEstablishedBeforeTheRunIsBounded(): Promise<void> {
  // (a) a completed create is an acknowledgement, and the name is visible immediately afterwards.
  const probe = "cadp-surface-lifetime-probe-create";
  spawnSync("docker", ["rm", "--force", "--volumes", probe], { stdio: "ignore" });
  assert.equal((await DOCKER_SURFACE_PORT.create(probe, ["--network", "none", IMAGE, "sh", "-c", "sleep 600"]).result).creation, "CREATED");
  assert.equal(existing(probe), probe, "an acknowledged creation is visible by its exact identity");
  await DOCKER_SURFACE_PORT.terminate(probe).result;
  assert.equal(existing(probe), "", "and can then be removed by that same identity");

  // (b) a create the daemon refuses establishes that NO container of that identity exists.
  const refused = "cadp-surface-lifetime-probe-refused";
  assert.equal((await DOCKER_SURFACE_PORT.create(refused, ["--network", "none", "cadp-surface:definitely-not-a-real-tag", "sh"]).result).creation, "REJECTED");
  assert.equal(existing(refused), "", "a refused creation leaves nothing behind");

  // (c) the F5 window itself: creation is never acknowledged, yet a real container appears anyway.
  // The owner must reconcile and remove it rather than trusting the empty query it saw first.
  const port: SurfaceCommandPort = {
    ...DOCKER_SURFACE_PORT,
    create(container, args) {
      // The daemon accepted it, but we never got the acknowledgement — and it lands late.
      setTimeout(() => { spawnSync("docker", dockerCreateArgv(container, [...args]), { stdio: "ignore" }); }, 400);
      return { result: Promise.resolve({ creation: "UNKNOWN" as const, detail: "" }), closed: Promise.resolve(), cancel: () => {} };
    },
  };
  const run = await runBoundedSurface(
    { kind: "verifier", args: ["--network", "none", IMAGE, "sh", "-c", "sleep 600"], timeout_ms: 300_000 },
    { port: { ...port, launch: () => { throw new Error("nothing may be started from an unacknowledged creation"); } }, termination_ms: 5_000 },
  );
  assert.notEqual(run.surface_state, "EXITED", "an unacknowledged creation may never be reported as a surface exit");
  assert.equal(run.surface_state, "TERMINATED", "the late REAL container was caught and confirmed gone");
  assert.notEqual(run.status, 0);
  assert.equal(existing(run.container!), "", `late container ${run.container!} must not be leaked`);
  say({ leg: "creation-establishment", ok: true, acknowledged: "CREATED", refused: "REJECTED", late_container_state: run.surface_state, remaining: "" });
}

/**
 * #128 F7 on the real control plane: a docker command that is abandoned must actually be STOPPED.
 * `docker wait` blocks until its container exits, so it is a genuinely long-lived CLI child — if
 * cancelling it left the process alive, these clients would accumulate in the broker across retries.
 */
async function abandonedDockerCommandsAreKilled(): Promise<void> {
  const held = "cadp-surface-lifetime-probe-cancel";
  spawnSync("docker", ["rm", "--force", "--volumes", held], { stdio: "ignore" });
  spawnSync("docker", dockerCreateArgv(held, ["--network", "none", IMAGE, "sh", "-c", "sleep 600"]), { stdio: "ignore" });
  const client = spawn("docker", dockerStartArgv(held), { stdio: "ignore" });
  try {
    for (let i = 0; i < 100 && existing(held) === ""; i += 1) await new Promise((r) => setTimeout(r, 100));

    const command = dockerCommand(["wait", held]);
    let settled = false;
    void command.result.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(settled, false, "`docker wait` really is still blocked — otherwise this leg would prove nothing");

    command.cancel();
    await command.closed; // cancellation COMPLETES: the child is reaped, not merely signalled
    await command.result; // and the answer settles too (`closed` fires first, so wait for both)
    assert.equal(settled, true, "a cancelled command settles instead of being abandoned");
    say({ leg: "command-cancellation", ok: true, command: "docker wait", cancelled: true, reaped: true });
  } finally {
    client.kill("SIGKILL");
    spawnSync("docker", ["rm", "--force", "--volumes", held], { stdio: "ignore" });
  }
}

async function clientKillAloneDoesNotStopTheContainer(): Promise<void> {
  spawnSync("docker", ["rm", "--force", "--volumes", BITE_CONTAINER], { stdio: "ignore" });
  spawnSync("docker", dockerCreateArgv(BITE_CONTAINER, ["--network", "none", IMAGE, "sh", "-c", "sleep 600"]), { stdio: "ignore" });
  const client = spawn("docker", dockerStartArgv(BITE_CONTAINER), { stdio: "ignore" });
  try {
    for (let i = 0; i < 100 && existing(BITE_CONTAINER) === ""; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.notEqual(existing(BITE_CONTAINER), "", "the bite container never started — the guard bite would be vacuous");
    client.kill("SIGKILL");
    await new Promise((r) => client.on("close", r));
    await new Promise((r) => setTimeout(r, 500));
    const running = spawnSync("docker", ["container", "inspect", "--format", "{{.State.Running}}", BITE_CONTAINER], { encoding: "utf8" }).stdout.trim();
    assert.equal(running, "true", "bite: killing the client must leave the real container running — that is the defect the bound removes");
    say({ leg: "guard-bite", ok: true, container: BITE_CONTAINER, still_running_after_client_kill: true });
  } finally { spawnSync("docker", ["rm", "--force", "--volumes", BITE_CONTAINER], { stdio: "ignore" }); }
}

await requirePrerequisites();
const config: IsolationConfig = { worker_image: IMAGE, egress_network: "none", egress_proxy: "unused:0" };
await boundedRunTerminatesTheRealContainer(config);
await ordinaryRunsAreUntouched(config);
await creationIsEstablishedBeforeTheRunIsBounded();
await abandonedDockerCommandsAreKilled();
await anEarlyClientDeathStillStopsTheContainer();
await clientKillAloneDoesNotStopTheContainer();
say({ probe: "surface-lifetime", ok: true, image: IMAGE });
