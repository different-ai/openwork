import { z } from "zod"

/**
 * "Your agent" (behind the `workbotProactive` feature): one persistent background agent per member that reads their
 * Gmail and Google Calendar on a schedule and messages them only when something needs them.
 *
 * Three kinds of settings, kept apart on purpose:
 * - Organization policy (Den › Manage › Workbot), in the organization's metadata under `workbot.proactive`: on/off,
 *   working hours, the daily limit, whether members start opted in, and the default destination (a Workbot DM). Den
 *   enforces these in code after every turn.
 * - The template: what the agent is responsible for and short organization instructions. A versioned agent config
 *   object; each admin save is a new version.
 * - Each member's own choices: on/off, snooze and muted responsibilities.
 */

export const AGENT_RESPONSIBILITIES = ["morning_brief", "meeting_prep", "calendar_changes", "waiting_on_you"] as const
export type AgentResponsibility = (typeof AGENT_RESPONSIBILITIES)[number]
export const agentResponsibilitySchema = z.enum(AGENT_RESPONSIBILITIES)

/** What admins and members read about each responsibility: "what the agent will tell you about". */
export const AGENT_RESPONSIBILITY_COPY: Record<AgentResponsibility, { label: string; tells: string }> = {
  morning_brief: { label: "Morning brief", tells: "Your meetings for the day, what overlaps and what needs prep, at the start of your workday." },
  meeting_prep: { label: "Meeting prep", tells: "Before a meeting with people from outside the company: the last email thread with them and what they're waiting on." },
  calendar_changes: { label: "Calendar changes", tells: "Meetings today or tomorrow that someone else added, moved or cancelled." },
  waiting_on_you: { label: "Waiting on you", tells: "Email from people outside the company that has waited more than about 4 hours for your reply, with an offer to draft one." },
}

export const WORKBOT_PROACTIVE_LEAD_MINUTES = [5, 10, 15, 30, 60] as const
export const WORKBOT_PROACTIVE_DAILY_CAPS = [1, 2, 3, 5, 10] as const
export const AGENT_INSTRUCTIONS_MAX = 600

const leadMinutesSchema = z.number().int().refine((value) => WORKBOT_PROACTIVE_LEAD_MINUTES.some((allowed) => allowed === value), {
  message: "Choose 5, 10, 15, 30 or 60 minutes.",
})

/** Why a Workbot DM can't reach a member yet. */
export const AGENT_DESTINATION_BLOCKS = ["slack_app_not_installed", "member_not_linked"] as const
export type AgentDestinationBlock = (typeof AGENT_DESTINATION_BLOCKS)[number]

const workbotProactiveFieldsSchema = z.object({
  /** Your agent, for the whole organization. */
  enabled: z.boolean(),
  /** How early a meeting with people from outside the company wakes the agent. */
  leadMinutes: leadMinutesSchema,
  workingDays: z.enum(["weekdays", "everyday"]),
  /** Whole hours in each member's calendar time zone; the day runs from startHour to endHour. */
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  /** Messages per member per day. */
  dailyCap: z.number().int().min(1).max(10),
  /** `opted_in`: members get messages and can turn them off. `opted_out`: members turn them on. */
  membersStart: z.enum(["opted_in", "opted_out"]),
  /**
   * Where members' messages go: a DM from the Workbot Slack app's own bot (which notifies them), or nowhere yet.
   * Never a channel: the agent reads private email, and a channel is not the member's own.
   */
  destination: z.enum(["workbot_dm"]).nullable(),
})

const hoursInOrder = (value: { startHour: number; endHour: number }) => value.endHour > value.startHour
const hoursMessage = { message: "The workday must end after it starts.", path: ["endHour"] }

export const workbotProactiveSettingsSchema = workbotProactiveFieldsSchema.refine(hoursInOrder, hoursMessage)
export type WorkbotProactiveSettings = z.infer<typeof workbotProactiveSettingsSchema>

export const DEFAULT_WORKBOT_PROACTIVE_SETTINGS: WorkbotProactiveSettings = {
  enabled: false,
  leadMinutes: 15,
  workingDays: "weekdays",
  startHour: 8,
  endHour: 19,
  dailyCap: 3,
  membersStart: "opted_in",
  destination: "workbot_dm",
}

/** The template's editable content: what the agent is responsible for, and short organization instructions. */
export const agentTemplateContentSchema = z.object({
  responsibilities: z.object({
    morning_brief: z.boolean(),
    meeting_prep: z.boolean(),
    calendar_changes: z.boolean(),
    waiting_on_you: z.boolean(),
  }),
  instructions: z.string().max(AGENT_INSTRUCTIONS_MAX),
})
export type AgentTemplateContent = z.infer<typeof agentTemplateContentSchema>

export const DEFAULT_AGENT_TEMPLATE: AgentTemplateContent = {
  responsibilities: { morning_brief: true, meeting_prep: true, calendar_changes: true, waiting_on_you: true },
  instructions: "",
}

export function enabledResponsibilities(template: AgentTemplateContent): AgentResponsibility[] {
  return AGENT_RESPONSIBILITIES.filter((responsibility) => template.responsibilities[responsibility])
}

/** `PUT /v1/org/workbot-settings/proactive`: any subset of policy fields and template content. */
export const workbotProactiveSettingsInputSchema = workbotProactiveFieldsSchema
  .partial()
  .extend({
    responsibilities: agentTemplateContentSchema.shape.responsibilities.partial().optional(),
    instructions: z.string().trim().max(AGENT_INSTRUCTIONS_MAX).optional(),
  })
  .strict()
export type WorkbotProactiveSettingsInput = z.infer<typeof workbotProactiveSettingsInputSchema>

/** What Manage › Workbot shows: policy, the current template version, and where messages can go. */
export const workbotProactiveViewSchema = z.object({
  settings: workbotProactiveSettingsSchema,
  template: agentTemplateContentSchema.extend({
    /** The saved version (a config object version id), or null for the built-in default. */
    versionId: z.string().nullable(),
    /** 1 for the built-in default; each admin save adds one. */
    version: z.number().int().min(1),
  }),
  /** The Workbot Slack app is installed and on, so Workbot can DM members. */
  slackReady: z.boolean(),
  /** The deployment's headless runner is configured; the agent runs on it. */
  runnerReady: z.boolean(),
})
export type WorkbotProactiveView = z.infer<typeof workbotProactiveViewSchema>

/** `GET /v1/org/workbot-settings/proactive/health` (`workbotAgentHealthView`): counts only, no members or content. */
export const workbotProactiveHealthSchema = z.object({
  /** The window, in days, ending today (UTC). */
  days: z.number().int().min(1),
  /** Members with an agent. */
  members: z.number().int().min(0),
  responsibilities: z.array(z.object({
    id: agentResponsibilitySchema,
    /** Passes that asked the agent about it. */
    checks: z.number().int().min(0),
    /** Of those, passes that sent nothing for it. */
    quiet: z.number().int().min(0),
    /** Messages it produced. */
    sent: z.number().int().min(0),
    /** Members who muted it. */
    muted: z.number().int().min(0),
  })),
})
export type WorkbotProactiveHealth = z.infer<typeof workbotProactiveHealthSchema>

/** `GET /v1/me/agent`: a member's own agent, in their words. */
export const memberAgentViewSchema = z.object({
  /** Turned on for the organization (and the feature is on for this member). */
  available: z.boolean(),
  /** The member gets messages: their own choice, else the organization's starting choice. */
  on: z.boolean(),
  snoozedUntil: z.iso.datetime().nullable(),
  responsibilities: z.array(z.object({
    id: agentResponsibilitySchema,
    label: z.string(),
    tells: z.string(),
    /** Turned on by the organization. */
    enabled: z.boolean(),
    /** Turned off by the member. */
    muted: z.boolean(),
  })),
  /** Where messages go (a DM from Workbot), or null when the organization set nowhere. `blocked` says why they can't arrive yet. */
  destination: z.object({
    kind: z.literal("workbot_dm"),
    name: z.string(),
    blocked: z.enum(AGENT_DESTINATION_BLOCKS).nullable(),
  }).nullable(),
  workingHours: z.object({ workingDays: z.enum(["weekdays", "everyday"]), startHour: z.number(), endHour: z.number(), dailyCap: z.number() }),
  nextCheckAt: z.iso.datetime().nullable(),
})
export type MemberAgentView = z.infer<typeof memberAgentViewSchema>

/** `PUT /v1/me/agent`: "stop telling me about calendar changes", "snooze until tomorrow", "turn it off". */
export const memberAgentInputSchema = z
  .object({
    on: z.boolean().optional(),
    /** `tomorrow`: until the next working morning. Null resumes. */
    snooze: z.enum(["tomorrow"]).nullable().optional(),
    mute: z.array(agentResponsibilitySchema).max(AGENT_RESPONSIBILITIES.length).optional(),
    unmute: z.array(agentResponsibilitySchema).max(AGENT_RESPONSIBILITIES.length).optional(),
  })
  .strict()
export type MemberAgentInput = z.infer<typeof memberAgentInputSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function metadataRecord(metadata: unknown): Record<string, unknown> {
  if (isRecord(metadata)) return metadata
  if (typeof metadata !== "string") return {}
  try {
    const parsed: unknown = JSON.parse(metadata)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** The saved policy, field by field: an unreadable field falls back to its default, never the whole set. */
export function readWorkbotProactiveSettings(metadata: unknown): WorkbotProactiveSettings {
  const workbot = metadataRecord(metadata).workbot
  const stored = isRecord(workbot) && isRecord(workbot.proactive) ? workbot.proactive : {}
  const merged: Record<string, unknown> = { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS }
  for (const [key, schema] of Object.entries(workbotProactiveFieldsSchema.shape)) {
    if (key in stored && schema.safeParse(stored[key]).success) merged[key] = stored[key]
  }
  const fields = workbotProactiveFieldsSchema.safeParse(merged)
  if (!fields.success) return { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS }
  if (hoursInOrder(fields.data)) return fields.data
  const { startHour, endHour } = DEFAULT_WORKBOT_PROACTIVE_SETTINGS
  return { ...fields.data, startHour, endHour }
}

/** Applies a policy change; null when the result is invalid (for example a workday that ends before it starts). */
export function mergeWorkbotProactiveSettings(current: WorkbotProactiveSettings, change: WorkbotProactiveSettingsInput): WorkbotProactiveSettings | null {
  const { responsibilities: _responsibilities, instructions: _instructions, ...policy } = change
  const parsed = workbotProactiveSettingsSchema.safeParse({ ...current, ...policy })
  return parsed.success ? parsed.data : null
}

/** Applies a template change; null when nothing in it changes, so no empty version is saved. */
export function mergeAgentTemplate(current: AgentTemplateContent, change: WorkbotProactiveSettingsInput): AgentTemplateContent | null {
  const next: AgentTemplateContent = {
    responsibilities: { ...current.responsibilities, ...change.responsibilities },
    instructions: change.instructions ?? current.instructions,
  }
  const same = next.instructions === current.instructions
    && AGENT_RESPONSIBILITIES.every((responsibility) => next.responsibilities[responsibility] === current.responsibilities[responsibility])
  return same ? null : next
}

/** Metadata with the policy saved; everything else, including `workbot.model`, is kept. */
export function withWorkbotProactiveSettings(metadata: Record<string, unknown>, settings: WorkbotProactiveSettings): Record<string, unknown> {
  const current = metadata.workbot
  return { ...metadata, workbot: { ...(isRecord(current) ? current : {}), proactive: settings } }
}
