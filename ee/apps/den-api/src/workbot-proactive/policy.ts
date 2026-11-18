import { nextWorkingStart, zonedDayStart, type ProactivePolicy } from "@openwork/automations/proactive"
import type { AgentInstanceOverrides } from "@openwork-ee/den-db/schema"
import {
  AGENT_RESPONSIBILITIES,
  agentResponsibilitySchema,
  type AgentResponsibility,
  type AgentTemplateContent,
  type MemberAgentInput,
  type WorkbotProactiveSettings,
} from "@openwork/types/den/workbot-proactive"
import type { MemberChoiceChange } from "./repository.js"

/**
 * Pure rules shared by the wake, the delivery step and the member's settings: the organization's policy, the
 * template, and a member's own choices. No database, runner or Connect.
 */

/** A member's stored choices, as the agent row keeps them. */
export type MemberChoices = { status: string | null; overrides: AgentInstanceOverrides | null; snoozedUntil: Date | null }

export function proactivePolicy(settings: WorkbotProactiveSettings): ProactivePolicy {
  return { workingDays: settings.workingDays, startHour: settings.startHour, endHour: settings.endHour, dailyCap: settings.dailyCap }
}

/** The member's own choice wins; without one, the organization's starting choice. */
export function memberAgentOn(row: Pick<MemberChoices, "status"> | null | undefined, settings: WorkbotProactiveSettings) {
  if (row?.status === "on") return true
  if (row?.status === "off") return false
  return settings.membersStart === "opted_in"
}

export function mutedOf(row: Pick<MemberChoices, "overrides"> | null | undefined): Set<AgentResponsibility> {
  const muted = new Set<AgentResponsibility>()
  for (const value of row?.overrides?.muted ?? []) {
    const parsed = agentResponsibilitySchema.safeParse(value)
    if (parsed.success) muted.add(parsed.data)
  }
  return muted
}

export function enabledOf(template: AgentTemplateContent): Set<AgentResponsibility> {
  return new Set(AGENT_RESPONSIBILITIES.filter((responsibility) => template.responsibilities[responsibility]))
}

/** What the agent is responsible for this pass: on in the template and not muted by the member. */
export function activeResponsibilities(template: AgentTemplateContent, row: Pick<MemberChoices, "overrides"> | null): AgentResponsibility[] {
  const muted = mutedOf(row)
  return AGENT_RESPONSIBILITIES.filter((responsibility) => template.responsibilities[responsibility] && !muted.has(responsibility))
}

/** What a member's request changes. "Snooze until tomorrow" lasts until the next working morning in their zone. */
export function memberChoiceChange(
  input: MemberAgentInput,
  row: Pick<MemberChoices, "overrides"> | null,
  settings: WorkbotProactiveSettings,
  now: number,
  timeZone: string,
): MemberChoiceChange {
  const change: MemberChoiceChange = {}
  if (input.on !== undefined) change.status = input.on ? "on" : "off"
  if (input.snooze === null) change.snoozedUntil = null
  if (input.snooze === "tomorrow") change.snoozedUntil = new Date(nextWorkingStart(proactivePolicy(settings), zonedDayStart(now, timeZone, 1), timeZone))
  if (input.mute || input.unmute) {
    const muted = mutedOf(row)
    for (const responsibility of input.mute ?? []) muted.add(responsibility)
    for (const responsibility of input.unmute ?? []) muted.delete(responsibility)
    const overrides: AgentInstanceOverrides = { ...row?.overrides, muted: AGENT_RESPONSIBILITIES.filter((responsibility) => muted.has(responsibility)) }
    change.overrides = overrides
  }
  return change
}
