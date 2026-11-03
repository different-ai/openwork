/** A stream that was open and ended (its time limit, the runner moving the chat) comes back this soon. */
export const LIVE_REOPEN_MS = 250;
/** The first wait after a refused or failed stream; each one in a row doubles it, up to `LIVE_RETRY_MAX_MS`. */
export const LIVE_RETRY_BASE_MS = 1_000;
export const LIVE_RETRY_MAX_MS = 60_000;

/**
 * How long the page's live stream waits before its next try, after `failures` refused or failed tries in a row.
 * Each wait lands at a random point in the upper half of its window, so pages that lost the same runner don't all
 * come back at once. A server's Retry-After is the least it waits, within the same cap.
 */
export function liveRetryDelay(failures: number, retryAfterMs: number | null = null, random: () => number = Math.random) {
  if (failures <= 0) return LIVE_REOPEN_MS;
  const window = Math.min(LIVE_RETRY_MAX_MS, LIVE_RETRY_BASE_MS * 2 ** (failures - 1));
  const wait = window / 2 + random() * (window / 2);
  return Math.round(Math.min(LIVE_RETRY_MAX_MS, Math.max(wait, retryAfterMs ?? 0)));
}

/** A Retry-After in seconds, as milliseconds; null when missing or not a number of seconds. */
export function retryAfterMs(value: string | null) {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

/** Whether a refused stream means Workbot isn't on for this organization, which trying again won't change. */
export function liveStreamOff(status: number, payload: unknown) {
  return status === 409 && typeof payload === "object" && payload !== null && "error" in payload && payload.error === "workbot_not_enabled";
}
