import { setTimeout as delay } from "node:timers/promises";

export interface SnapshotRetryOptions {
  /** Includes provider call time. No new attempt starts after this deadline. */
  timeoutMs?: number;
  maxAttempts?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  random?: () => number;
  diagnostic?: (message: string) => void;
}

/** Retry only a definite quota rejection, never an ambiguous transport failure. */
export async function retrySnapshotQuota<T>(operation: () => Promise<T>, isQuota: (error: unknown) => boolean,
  options: SnapshotRetryOptions = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const diagnostic = options.diagnostic ?? console.warn;
  const timeoutMs = options.timeoutMs ?? 16 * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid snapshot retry timeout");
  const deadline = now() + timeoutMs;
  const maxAttempts = options.maxAttempts ?? 17;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("Invalid snapshot retry attempt limit");
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!isQuota(error)) throw error;
      const remaining = deadline - now();
      if (attempt >= maxAttempts || remaining <= 0) {
        throw new Error(`Daytona snapshot quota remained exhausted after ${attempt} attempts. Inspect account usage and the evidence cleanup job; unrelated snapshots were not deleted.`, { cause: error });
      }
      // Different CI jobs must not all re-submit on the same clock tick.
      const wait = Math.min(remaining, 60_000 + Math.floor((options.random ?? Math.random)() * 15_000));
      diagnostic(`Daytona snapshot quota exceeded; attempt ${attempt}/${maxAttempts}, waiting ${Math.ceil(wait / 1000)}s for account capacity (no destructive recovery).`);
      await sleep(wait);
      if (now() >= deadline) throw new Error(`Daytona snapshot quota recovery deadline reached after ${attempt} attempts. Inspect account usage and the evidence cleanup job.`, { cause: error });
    }
  }
}
