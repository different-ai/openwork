import { prepareHistory } from "./history-preparation.js";

export interface EngineAutoUpgradeRetry {
  attempts: number;
  retryAt: number;
}

/** One attempt per boot; checkpointed failures back off from one minute to one day. */
export function engineAutoUpgradeRetry(attempts: number, now = Date.now()): EngineAutoUpgradeRetry {
  const next = Math.min(Math.max(0, attempts) + 1, 32);
  return { attempts: next, retryAt: now + Math.min(60_000 * 2 ** (next - 1), 86_400_000) };
}

/** Hash chat content through SQLite (including the WAL), not file timestamps.
 * Engine probes legitimately update project bookkeeping while no chat changes.
 */
export async function historyRevision(database: string, signal?: AbortSignal): Promise<string> {
  const revision = await prepareHistory(database, "revision", signal);
  if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
    throw new Error("Could not read OpenCode v1 history revision. Keeping v1.");
  }
  return revision;
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

export async function runEngineAutoUpgrade(options: IdleOptions & {
  revision: () => Promise<string>;
  copy: () => Promise<void>;
  switchEngine: () => Promise<void>;
}): Promise<void> {
  await waitForEngineIdle(options);
  const before = await options.revision();
  await options.copy();
  options.signal.throwIfAborted();
  if (!await options.idle() || before !== await options.revision()) {
    throw new Error("OpenCode v1 changed while chats were copied. Keeping v1 until a later boot.");
  }
  await options.switchEngine();
}
