/**
 * Deployment-control's opt-in attestation schedule (TD §20.5 / §20.6 item 7).
 *
 * This deliberately knows nothing about the kernel service.  Each timer tick invokes the
 * existing ctl attest cycle once; that cycle owns both producer principals and both probes.
 */

export interface AttestRefreshTimer<Handle = unknown> {
  setInterval(callback: () => void, delayMs: number): Handle;
  clearInterval(handle: Handle): void;
}

export interface AttestRefreshSchedule {
  readonly period_ms: number;
  stop(): void;
}

const nodeTimer: AttestRefreshTimer<ReturnType<typeof setInterval>> = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle),
};

/** Start only when called: omission creates no timer and changes no admission behaviour. */
export function startAttestRefresh<Handle = ReturnType<typeof setInterval>>(
  reachAttestationMaxAgeS: number,
  invokeCtlAttest: () => Promise<void>,
  timer: AttestRefreshTimer<Handle> = nodeTimer as AttestRefreshTimer<Handle>,
  onError: (error: unknown) => void = (error) => console.error(
    `scheduled ctl attest failed: ${error instanceof Error ? error.message : String(error)}`,
  ),
): AttestRefreshSchedule {
  if (!Number.isFinite(reachAttestationMaxAgeS) || reachAttestationMaxAgeS <= 0) {
    throw new Error("reach_attestation_max_age_s must be a positive finite number");
  }
  const period_ms = reachAttestationMaxAgeS * 1000 / 2;
  let running = false;
  const handle = timer.setInterval(() => {
    // A slow probe owns its tick. Do not overlap it and never retry it into a different result.
    if (running) return;
    running = true;
    void invokeCtlAttest().catch(onError).finally(() => { running = false; });
  }, period_ms);
  return { period_ms, stop: () => timer.clearInterval(handle) };
}
