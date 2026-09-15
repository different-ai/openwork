/**
 * A request that is streaming when the machine sleeps can come back with a
 * dead socket: the engine still reports the session as busy, but no bytes will
 * ever arrive again. Nothing on the engine side notices for minutes, so the
 * Working row would tick indefinitely. These helpers decide, from state the
 * renderer already tracks, when that run should be stopped so the existing
 * "Task interrupted · Resume" row can take over. They never resend anything.
 */

/** How often the renderer checks whether it was paused. */
export const WAKE_TICK_MS = 5_000;

/**
 * A timer that fires this late was not merely throttled: the machine slept or
 * the renderer was frozen. Background throttling alone stays around one second.
 */
export const WAKE_GAP_MS = 30_000;

/**
 * After a wake, a live socket resumes streaming within seconds. A run that has
 * produced nothing this long after waking is treated as stalled.
 */
export const STALLED_AFTER_WAKE_GRACE_MS = 30_000;

export function detectWake(input: { lastTickAt: number; now: number; gapMs?: number }): boolean {
  return input.now - input.lastTickAt >= (input.gapMs ?? WAKE_GAP_MS);
}

export function shouldStopStalledRunAfterWake(input: {
  wakeAt: number | null;
  now: number;
  /** The engine reports the run as busy. */
  runActive: boolean;
  /** An unanswered permission or question is the legitimate reason for silence. */
  waiting: boolean;
  /** The engine is already retrying; do not compete with it. */
  retrying: boolean;
  /** Status cannot be validated; that is the "Connection lost" case, not a stall. */
  disconnected: boolean;
  /** A running tool finishes locally regardless of the socket; leave it alone. */
  toolInFlight: boolean;
  /** Newest transcript progress, including delegated tasks. */
  lastProgressAt: number;
  graceMs?: number;
}): boolean {
  if (input.wakeAt === null) return false;
  if (!input.runActive || input.waiting || input.retrying || input.disconnected || input.toolInFlight) return false;
  // Anything that arrived after waking proves the socket survived.
  if (input.lastProgressAt >= input.wakeAt) return false;
  return input.now - input.wakeAt >= (input.graceMs ?? STALLED_AFTER_WAKE_GRACE_MS);
}
