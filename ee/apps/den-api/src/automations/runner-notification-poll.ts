export const RUNNER_NOTIFICATION_POLL_MIN_MS = 1_000
export const RUNNER_NOTIFICATION_POLL_MAX_MS = 15_000
export const RUNNER_KEEPALIVE_INTERVAL_MS = 15_000

export function nextRunnerNotificationPollDelay(
  currentDelayMs: number,
  receivedNotifications: boolean,
): number {
  if (receivedNotifications) return RUNNER_NOTIFICATION_POLL_MIN_MS
  return Math.min(
    RUNNER_NOTIFICATION_POLL_MAX_MS,
    Math.max(RUNNER_NOTIFICATION_POLL_MIN_MS, currentDelayMs) * 2,
  )
}

export function capRunnerNotificationPollDelayForKeepalive(
  pollDelayMs: number,
  elapsedSinceKeepaliveMs: number,
): number {
  const untilKeepaliveMs = RUNNER_KEEPALIVE_INTERVAL_MS - elapsedSinceKeepaliveMs
  return Math.min(pollDelayMs, Math.max(RUNNER_NOTIFICATION_POLL_MIN_MS, untilKeepaliveMs))
}
