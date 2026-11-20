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

/**
 * Your agent's brief and rhythm (`workbotAgentBrief`), as Den reads them for a member (the organization's settings are
 * `resolveAgentBrief` in @openwork/types): the member's own lines (written, or carried over from their mutes and words),
 * their rhythm and their next checks. Pure; the routes and the wake share it, so the page,
 * chat and the agent always agree.
 */

function mutedOf(overrides: AgentInstanceOverrides | null | undefined) {
  return (overrides?.muted ?? []).flatMap((value) => {
    const parsed = agentResponsibilitySchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
}

/** What the member's lines would be from their earlier settings: their mutes, then Always / Never / When / How. */
export function carriedMemberLines(stored: StoredAgentPreferences, overrides: AgentInstanceOverrides | null | undefined): string {
  return carriedOverMemberBrief({ muted: mutedOf(overrides), words: stored.words })
}

/** The member's own lines: what they wrote, else carried over (and whether they were). */
export function memberBriefLines(stored: StoredAgentPreferences, overrides: AgentInstanceOverrides | null | undefined): { lines: string; carriedOver: boolean } {
  if (stored.brief !== undefined) return { lines: stored.brief, carriedOver: false }
  const lines = carriedMemberLines(stored, overrides)
  return { lines, carriedOver: lines.length > 0 }
}

/** When the member's agent checks: their hours, how often (never more often than the admin's) and their quiet hours. */
export function memberRhythm(limits: MemberAgentLimits, brief: AgentBriefPolicy): AgentRhythm {
  return {
    policy: { workingDays: limits.workingDays, startHour: limits.startHour, endHour: limits.endHour },
    everyHours: limits.checkEveryHours ?? brief.checkEveryHours,
    quietWindow: limits.quietWindow,
  }
}

/**
 * When the next check on the rhythm is due: the first slot after the last check (now, for an agent that never
 * checked), and never inside a snooze, outside the member's hours or in quiet hours. Derived from the last check and
 * the current rhythm, so a member who changes how often it checks gets the new rhythm at once.
 */
export function nextScheduledCheck(input: { rhythm: AgentRhythm; lastCheckAt: number | null; now: number; timeZone: string; snoozedUntil: number | null }): number {
  const { rhythm, timeZone } = input
  let at = input.lastCheckAt === null ? input.now : nextCheckSlot(rhythm, input.lastCheckAt, timeZone)
  if (input.snoozedUntil !== null && input.snoozedUntil > at) at = input.snoozedUntil
  return nextRhythmOpening(rhythm, at, timeZone)
}

/** The next checks for My bot: the next one on the rhythm, then the extra checks the agent asked for, soonest first. */
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
    .filter((request) => request.at > input.now - 15 * 60_000 && (input.snoozedUntil === null || input.snoozedUntil <= input.now || request.at > input.snoozedUntil))
    .map((request) => ({ at: Math.max(request.at, input.now), kind: "requested" as const, why: request.why || null }))
  return [{ at: scheduled, kind: "scheduled" as const, why: null }, ...requested]
    .sort((left, right) => left.at - right.at)
    .slice(0, 4)
    .map((check) => ({ ...check, at: new Date(check.at).toISOString() }))
}
