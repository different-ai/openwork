import { describe, expect, test } from "bun:test"
import { AUTOMATION_DESKTOP_RUNNER_PRESENCE_WINDOW_MS } from "@openwork/types/automations"
import { desktopClaimDeadline, desktopRunnerConnected, missedDesktopRunMessage } from "./runner.js"

const MINUTE = 60_000

describe("desktop runner recovery", () => {
  test("keeps an occurrence claimable long enough to survive a sleeping desktop", () => {
    const now = Date.UTC(2026, 0, 5, 9)
    // A daily 09:00 occurrence on a laptop that wakes at 09:07 still runs.
    expect(desktopClaimDeadline({ now, windowMs: 15 * MINUTE, nextDueAt: Date.UTC(2026, 0, 6, 9) }))
      .toBe(now + 15 * MINUTE)
    expect(desktopClaimDeadline({ now, windowMs: 15 * MINUTE, nextDueAt: null }))
      .toBe(now + 15 * MINUTE)
  })

  test("releases an occurrence before its own next one is due", () => {
    const now = Date.UTC(2026, 0, 5, 10)
    // A queued run makes the following occurrence overlap and skip, so an
    // unclaimed hourly 10:00 run must not still hold the slot at 11:00.
    expect(desktopClaimDeadline({ now, windowMs: 15 * MINUTE, nextDueAt: now + 5 * MINUTE }))
      .toBe(now + 5 * MINUTE)
  })

  test("never shortens the window a deployment asked for", () => {
    const now = Date.UTC(2026, 0, 5, 10)
    expect(desktopClaimDeadline({ now, windowMs: 15 * MINUTE, nextDueAt: now + 10_000 }))
      .toBe(now + MINUTE)
    expect(desktopClaimDeadline({ now, windowMs: 30_000, nextDueAt: now + 10_000 }))
      .toBe(now + 30_000)
  })

  test("treats a recently seen desktop as connected", () => {
    const now = Date.UTC(2026, 0, 5, 10)
    expect(desktopRunnerConnected({ lastSeenAt: null, now })).toBe(false)
    expect(desktopRunnerConnected({ lastSeenAt: now - MINUTE, now })).toBe(true)
    expect(desktopRunnerConnected({
      lastSeenAt: now - AUTOMATION_DESKTOP_RUNNER_PRESENCE_WINDOW_MS - 1,
      now,
    })).toBe(false)
  })

  test("names the cause an operator can act on", () => {
    const now = Date.UTC(2026, 0, 5, 10)
    expect(missedDesktopRunMessage({ busy: true, lastSeenAt: now, now }))
      .toBe("Missed — the desktop was busy with another Automation run.")
    expect(missedDesktopRunMessage({ busy: false, lastSeenAt: null, now }))
      .toBe("Missed — no desktop was connected.")
    expect(missedDesktopRunMessage({ busy: false, lastSeenAt: now - MINUTE, now }))
      .toBe("Missed — the connected desktop did not pick this up in time.")
  })
})
