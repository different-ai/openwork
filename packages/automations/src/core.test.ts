import { describe, expect, test } from "bun:test"
import { automationScheduleSchema } from "@openwork/types/automations"
import { automationOccurrenceIdentity, automationRevisionDigest } from "./contracts.js"
import { nextAutomationOccurrence, recoverableAutomationOccurrence } from "./schedule.js"
import { assertAutomationTransition, canTransitionAutomation, isTerminalAutomationRunStatus } from "./state.js"
import { selectDueAutomations } from "./tick.js"

describe("portable Automations core", () => {
  test("calculates once, daily, and weekly occurrences", () => {
    expect(nextAutomationOccurrence({ kind: "once", timezone: "UTC", at: 10 }, 9)).toBe(10)
    expect(nextAutomationOccurrence({ kind: "once", timezone: "UTC", at: 10 }, 10)).toBeNull()
    expect(new Date(nextAutomationOccurrence({ kind: "daily", timezone: "UTC", hour: 9, minute: 30 }, Date.UTC(2026, 0, 1)) ?? 0).toISOString())
      .toBe("2026-01-01T09:30:00.000Z")
    expect(new Date(nextAutomationOccurrence({ kind: "weekly", timezone: "UTC", daysOfWeek: [1], hour: 9, minute: 30 }, Date.UTC(2026, 0, 1)) ?? 0).toISOString())
      .toBe("2026-01-05T09:30:00.000Z")
  })

  test("keeps deterministic DST behavior without process timezone state", () => {
    const fallBack = nextAutomationOccurrence(
      { kind: "daily", timezone: "America/New_York", hour: 1, minute: 30 },
      Date.UTC(2026, 9, 31, 12),
    )
    expect(new Date(fallBack ?? 0).toISOString()).toBe("2026-11-01T05:30:00.000Z")
    const springForward = nextAutomationOccurrence(
      { kind: "daily", timezone: "America/New_York", hour: 2, minute: 30 },
      Date.UTC(2026, 2, 7, 12),
    )
    expect(new Date(springForward ?? 0).toISOString()).toBe("2026-03-08T07:00:00.000Z")
  })

  test("bounds missed recovery to one latest occurrence", () => {
    const recovered = recoverableAutomationOccurrence(
      { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
      { after: Date.UTC(2026, 0, 1), now: Date.UTC(2026, 0, 5, 12) },
    )
    expect(recovered).toBe(Date.UTC(2026, 0, 5, 9))
  })

  test("normalizes weekly weekdays and rejects invalid timezones", () => {
    const weekly = automationScheduleSchema.parse({
      kind: "weekly", timezone: "Europe/Madrid", daysOfWeek: [5, 1, 5], hour: 8, minute: 0,
    })
    expect(weekly.kind === "weekly" ? weekly.daysOfWeek : []).toEqual([1, 5])
    expect(automationScheduleSchema.safeParse({
      kind: "daily", timezone: "Mars/Olympus", hour: 8, minute: 0,
    }).success).toBe(false)
  })

  test("defines lifecycle and terminal states", () => {
    expect(canTransitionAutomation("active", "inactive")).toBe(true)
    expect(canTransitionAutomation("archived", "active")).toBe(false)
    expect(() => assertAutomationTransition("archived", "active")).toThrow()
    expect(isTerminalAutomationRunStatus("succeeded")).toBe(true)
    expect(isTerminalAutomationRunStatus("running")).toBe(false)
  })

  test("creates stable revision and occurrence identities", () => {
    const revision = {
      instructions: "Say hello",
      schedule: { kind: "daily" as const, timezone: "UTC", hour: 9, minute: 0 },
      model: { providerId: "provider", modelId: "model" },
      maximumRuntimeMs: 60_000,
    }
    expect(automationRevisionDigest(revision)).toBe(automationRevisionDigest({ ...revision }))
    const scheduled = automationOccurrenceIdentity({
      automationId: "automation_a", scheduledFor: 10,
    })
    expect(scheduled).toEqual({
      occurrenceId: "automation-occurrence:automation_a:10",
      idempotencyKey: "automation:automation_a:10",
    })
  })

  test("deduplicates scheduled and recovery claims for one occurrence", () => {
    const runs = new Map<string, { id: string; revisionId: string; trigger: "scheduled" | "recovery" }>()
    const claim = (revisionId: string, trigger: "scheduled" | "recovery") => {
      const identity = automationOccurrenceIdentity({ automationId: "automation_a", scheduledFor: 10 })
      const existing = runs.get(identity.idempotencyKey)
      if (existing) return existing
      const run = { id: `run_${runs.size + 1}`, revisionId, trigger }
      runs.set(identity.idempotencyKey, run)
      return run
    }

    const scheduledRun = claim("revision_a", "scheduled")
    const recoveredRunAfterRevisionChange = claim("revision_b", "recovery")
    expect(recoveredRunAfterRevisionChange).toBe(scheduledRun)
    expect(runs.size).toBe(1)
    expect(scheduledRun).toEqual({ id: "run_1", revisionId: "revision_a", trigger: "scheduled" })
  })

  test("selects due active Automations deterministically", () => {
    const revision = {
      id: "revision_a", automationId: "automation_a", version: 1, instructions: "Run",
      schedule: { kind: "daily" as const, timezone: "UTC", hour: 9, minute: 0 },
      model: { providerId: "provider", modelId: "model" }, maximumRuntimeMs: 60_000,
      digest: "0123456789abcdef", createdAt: 1,
    }
    const automation = {
      id: "automation_a", organizationId: "org", ownerMemberId: "member", name: "A",
      state: "active" as const, currentRevisionId: revision.id, nextDueAt: 10, latestRunAt: null,
      needsAttentionReason: null, createdAt: 1, updatedAt: 1, archivedAt: null,
    }
    expect(selectDueAutomations([
      { automation: { ...automation, id: "automation_b", nextDueAt: 20 }, revision: { ...revision, id: "revision_b", automationId: "automation_b" }, latestRun: null },
      { automation, revision, latestRun: null },
    ], { now: 20, limit: 1 }).map((item) => item.automation.id)).toEqual(["automation_a"])
  })
})
