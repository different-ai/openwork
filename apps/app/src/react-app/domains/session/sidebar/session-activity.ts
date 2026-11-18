// When a session was last active, for the Feed's "last interacted with" order.
// OpenCode v2 does not move a session's `time.updated` when a message is sent,
// so the sidebar also records work starting and finishing on this device.
import { useSyncExternalStore } from "react";

const ACTIVITY_CLOCK_MS = 5 * 60 * 1000;

type SessionTimes = {
  id: string;
  time?: { created?: number | null; updated?: number | null; archived?: number | null };
};

// Engines report session times in seconds or milliseconds.
const toMs = (raw: number) => raw > 0 && raw < 1_000_000_000_000 ? raw * 1000 : raw;

/** Last activity the engine reports, in milliseconds. */
export function sessionActivityAt(session: SessionTimes): number {
  return toMs(session.time?.updated ?? session.time?.created ?? 0);
}

/** Last activity including work started or finished on this device (`workedAt`). */
export function sessionLastActivityAt(session: SessionTimes, workedAt: number | undefined): number {
  return Math.max(sessionActivityAt(session), workedAt ?? 0);
}

/** When the session was created, in milliseconds. */
export function sessionCreatedAt(session: SessionTimes): number {
  return toMs(session.time?.created ?? session.time?.updated ?? 0);
}

// One shared, slow clock for Today / Yesterday sections: no per-row timers.
let activityNow = Date.now();
const activityClockListeners = new Set<() => void>();
let activityClockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeActivityClock(listener: () => void) {
  activityClockListeners.add(listener);
  if (!activityClockTimer) {
    activityNow = Date.now();
    activityClockTimer = setInterval(() => {
      activityNow = Date.now();
      for (const notify of activityClockListeners) notify();
    }, ACTIVITY_CLOCK_MS);
  }
  return () => {
    activityClockListeners.delete(listener);
    if (activityClockListeners.size === 0 && activityClockTimer) {
      clearInterval(activityClockTimer);
      activityClockTimer = null;
    }
  };
}

export function useActivityNow(): number {
  return useSyncExternalStore(subscribeActivityClock, () => activityNow, () => activityNow);
}
