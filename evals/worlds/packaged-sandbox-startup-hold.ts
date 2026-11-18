import { setTimeout as delay } from "node:timers/promises";
import { ownedMicrosandboxProcesses } from "./packaged-sandbox-fixtures.ts";

type Target = ReturnType<typeof ownedMicrosandboxProcesses>[number];
export type StartupHoldReceipt = {
  kind: "controlled-startup-slowdown";
  ownerPid: number;
  target?: Target;
  state: "watching" | "held" | "resumed" | "cancelled" | "blocked";
  stopVerified: boolean;
  resumeVerified: boolean;
  readyVerified: boolean;
  detail?: string;
};
type ProcessAccess = {
  snapshot(): Promise<string>;
  state(pid: number): Promise<string | null>;
  signal(pid: number, signal: "SIGSTOP" | "SIGCONT"): void;
};

/** A bounded resource fault in a fresh proof-owned process tree, never a product hook. */
export async function holdNewOwnedRuntime(ownerPid: number, access: ProcessAccess, options: { watchMs?: number; maxHoldMs?: number } = {}) {
  const initial = ownedMicrosandboxProcesses(await access.snapshot(), ownerPid);
  if (initial.length) throw new Error("A startup slowdown requires a fresh app with no existing owned guest; no process was signalled");
  const receipt: StartupHoldReceipt = { kind: "controlled-startup-slowdown", ownerPid, state: "watching", stopVerified: false, resumeVerified: false, readyVerified: false };
  const deadline = Date.now() + (options.watchMs ?? 60_000);
  let cancelled = false;
  let stopped: Target | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let resuming: Promise<StartupHoldReceipt> | undefined;

  async function resume() {
    if (resuming) return resuming;
    const target = stopped;
    if (!target) return receipt;
    resuming = (async () => {
      if (watchdog) clearTimeout(watchdog);
      const owned = ownedMicrosandboxProcesses(await access.snapshot(), ownerPid);
      const current = owned.find(row => row.pid === target.pid && row.command === target.command);
      if (!current) throw new Error(`The held guest ${target.pid} is no longer in its owned process tree; refusing to signal a reused PID`);
      access.signal(target.pid, "SIGCONT");
      const until = Date.now() + 5_000;
      while (Date.now() < until) {
        const state = await access.state(target.pid);
        if (!state || !state.includes("T")) {
          stopped = undefined;
          receipt.resumeVerified = true;
          receipt.state = "resumed";
          return receipt;
        }
        await delay(10);
      }
      throw new Error(`Owned guest ${target.pid} remains stopped after SIGCONT`);
    })().catch(error => {
      receipt.state = "blocked";
      receipt.detail = String(error);
      resuming = undefined;
      throw error;
    });
    return resuming;
  }

  // Resolve blocked outcomes instead of rejecting an unattended watcher; waitHeld
  // and dispose both surface the same receipt and error to the test report.
  const watching = (async () => {
    try {
      while (!cancelled && Date.now() < deadline) {
        const owned = ownedMicrosandboxProcesses(await access.snapshot(), ownerPid);
        if (owned.length > 1) throw new Error(`Expected one new owned guest, found ${owned.length}; no process was signalled`);
        const candidate = owned[0];
        if (candidate) {
          const verified = ownedMicrosandboxProcesses(await access.snapshot(), ownerPid);
          if (verified.length !== 1 || verified[0]?.pid !== candidate.pid || verified[0].command !== candidate.command) throw new Error("The new guest's ownership changed before SIGSTOP; no process was signalled");
          if (cancelled) break;
          access.signal(candidate.pid, "SIGSTOP");
          stopped = candidate;
          receipt.target = candidate;
          const until = Date.now() + 5_000;
          while (Date.now() < until) {
            const state = await access.state(candidate.pid);
            if (state?.includes("T")) {
              receipt.stopVerified = true;
              receipt.state = "held";
              watchdog = setTimeout(() => {
                receipt.detail = "The bounded startup slowdown reached its safety deadline and was released automatically";
                void resume().catch(error => { receipt.detail = String(error); });
              }, options.maxHoldMs ?? 60_000);
              watchdog.unref();
              return;
            }
            if (!state) throw new Error("The owned guest exited before its startup slowdown could be verified");
            await delay(10);
          }
          throw new Error("The owned guest did not enter a stopped OS state after SIGSTOP");
        }
        await delay(10);
      }
      if (cancelled) receipt.state = "cancelled";
      else throw new Error("No new owned guest appeared before the bounded startup-watch deadline");
    } catch (error) {
      receipt.state = "blocked";
      receipt.detail = String(error);
      if (stopped) {
        try { await resume(); }
        catch (cleanupError) { receipt.detail += `; release blocked: ${String(cleanupError)}`; }
        receipt.state = "blocked";
      }
    }
  })();

  return {
    receipt,
    async waitHeld() {
      await watching;
      if (!receipt.stopVerified || receipt.state !== "held") throw new Error(`Startup slowdown was not held: ${JSON.stringify(receipt)}`);
      return receipt;
    },
    resume,
    async dispose() {
      cancelled = true;
      await watching;
      if (stopped) await resume();
      if (receipt.state === "blocked") throw new Error(`Startup slowdown cleanup was blocked: ${JSON.stringify(receipt)}`);
      return receipt;
    },
  };
}
