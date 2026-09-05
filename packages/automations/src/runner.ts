import { AUTOMATION_DESKTOP_RUNNER_PRESENCE_WINDOW_MS } from "@openwork/types/automations"

/** Shortest window an occurrence stays claimable, whatever the deployment tunes. */
export const AUTOMATION_MIN_CLAIM_WINDOW_MS = 60_000

/**
 * How long a desktop occurrence stays claimable. A desktop is a laptop that
 * sleeps, restarts, and changes networks, so this is a recovery window rather
 * than a liveness check: a desktop that comes back inside it still runs the
 * occurrence instead of the operator finding a missed run.
 *
 * It never reaches the next occurrence, because a run that is still queued
 * makes the following one overlap and skip — an unclaimed hourly 10:00 run has
 * to release before 11:00 is due.
 */
export function desktopClaimDeadline(input: {
  now: number
  windowMs: number
  nextDueAt: number | null
}): number {
  const requested = input.now + input.windowMs
  const bounded = input.nextDueAt === null ? requested : Math.min(requested, input.nextDueAt)
  const floor = input.now + Math.min(input.windowMs, AUTOMATION_MIN_CLAIM_WINDOW_MS)
  return Math.max(floor, bounded)
}

/**
 * Presence is durable rather than live: registration refreshes it every few
 * minutes and idle event streams deliberately avoid writing to the database,
 * so a desktop counts as connected for a while after it was last seen.
 */
export function desktopRunnerConnected(input: { lastSeenAt: number | null; now: number }): boolean {
  return input.lastSeenAt !== null
    && input.now - input.lastSeenAt <= AUTOMATION_DESKTOP_RUNNER_PRESENCE_WINDOW_MS
}

/**
 * Why an occurrence was never claimed. One generic outcome hid a real defect
 * for weeks, because an operator could not tell a desktop that was switched
 * off from a runner that could not connect at all. Name the cause the operator
 * can act on: a concurrent run is exact, and presence distinguishes a desktop
 * that was absent from one that was there and stayed silent.
 */
export function missedDesktopRunMessage(input: {
  busy: boolean
  lastSeenAt: number | null
  now: number
}): string {
  if (input.busy) return "Missed — the desktop was busy with another Automation run."
  return desktopRunnerConnected(input)
    ? "Missed — the connected desktop did not pick this up in time."
    : "Missed — no desktop was connected."
}
