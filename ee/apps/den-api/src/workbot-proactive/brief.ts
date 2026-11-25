import {
  nextCheckSlot,
  nextRhythmOpening,
  pendingCheckRequests,
  type AgentCheckRequest,
  type AgentRhythm,
} from "@openwork/automations/proactive-brief"
import type { AgentInstanceOverrides } from "@openwork-ee/den-db/schema"
import {
  agentResponsibilitySchema,
  carriedOverMemberBrief,
  type AgentBriefPolicy,
  type MemberAgentLimits,
  type MemberAgentView,
} from "@openwork/types/den/workbot-proactive"
import type { StoredAgentPreferences } from "./preferences.js"

function mutedOf(overrides: AgentInstanceOverrides | null | undefined) {
  return (overrides?.muted ?? []).flatMap((value) => {
    const parsed = agentResponsibilitySchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
}

export function carriedMemberLines(stored: StoredAgentPreferences, overrides: AgentInstanceOverrides | null | undefined): string {
  return carriedOverMemberBrief({ muted: mutedOf(overrides), words: stored.words })
}

export function memberBriefLines(stored: StoredAgentPreferences, overrides: AgentInstanceOverrides | null | undefined): { lines: string; carriedOver: boolean } {
  if (stored.brief !== undefined) return { lines: stored.brief, carriedOver: false }
  const lines = carriedMemberLines(stored, overrides)
  return { lines, carriedOver: lines.length > 0 }
}

export function memberRhythm(limits: MemberAgentLimits, brief: AgentBriefPolicy): AgentRhythm {
  return {
    policy: { workingDays: limits.workingDays, startHour: limits.startHour, endHour: limits.endHour },
    everyHours: limits.checkEveryHours ?? brief.checkEveryHours,
    quietWindow: limits.quietWindow,
  }
}

export function nextScheduledCheck(input: { rhythm: AgentRhythm; lastCheckAt: number | null; now: number; timeZone: string; snoozedUntil: number | null }): number {
  const { rhythm, timeZone } = input
  let at = input.lastCheckAt === null ? input.now : nextCheckSlot(rhythm, input.lastCheckAt, timeZone)
  if (input.snoozedUntil !== null && input.snoozedUntil > at) at = input.snoozedUntil
  return nextRhythmOpening(rhythm, at, timeZone)
}

export function memberNextChecks(input: {
  rhythm: AgentRhythm
  lastCheckAt: number | null
  requests: readonly AgentCheckRequest[] | undefined
  now: number
  timeZone: string
  snoozedUntil: number | null
}): NonNullable<MemberAgentView["nextChecks"]> {
  const scheduled = Math.max(nextScheduledCheck(input), input.now)
  const requested = pendingCheckRequests(input.requests)
    .filter((request) => request.at > input.now - 15 * 60_000 && (input.snoozedUntil === null || request.at > input.snoozedUntil))
    .map((request) => ({ at: Math.max(request.at, input.now), kind: "requested" as const, why: request.why || null }))
  return [{ at: scheduled, kind: "scheduled" as const, why: null }, ...requested]
    .sort((left, right) => left.at - right.at)
    .slice(0, 4)
    .map((check) => ({ ...check, at: new Date(check.at).toISOString() }))
}
