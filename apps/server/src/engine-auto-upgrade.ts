export interface EngineAutoUpgradeRetry {
  attempts: number;
  retryAt: number;
}

/** One attempt per boot; checkpointed failures back off from one minute to one day. */
export function engineAutoUpgradeRetry(attempts: number, now = Date.now()): EngineAutoUpgradeRetry {
  const next = Math.min(Math.max(0, attempts) + 1, 32);
  return { attempts: next, retryAt: now + Math.min(60_000 * 2 ** (next - 1), 86_400_000) };
}

interface IdleOptions {
  signal: AbortSignal;
  idle: () => Promise<boolean>;
  wait?: (signal: AbortSignal) => Promise<void>;
  idleChecks?: number;
}

export async function waitForEngineIdle(options: IdleOptions): Promise<void> {
  const wait = options.wait ?? ((signal) => new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(done, 5_000);
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }));
  // Waiting for idle is not a second migration attempt. Unknown activity fails closed.
  for (let check = 0; check < (options.idleChecks ?? 60); check++) {
    options.signal.throwIfAborted();
    if (await options.idle()) return;
    await wait(options.signal);
  }
  throw new Error("The selected engine is not idle. Keeping it until a later boot.");
}
