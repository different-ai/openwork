import { z } from "zod"

/**
 * "Your agent": one persistent background agent per member, governed by organization and member settings, that reads their
 * sources (their calendar and any connection they turn on, such as Google Workspace, Microsoft 365 or Slack for mail
 * and chat) on a schedule and messages them only when something needs them.
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

/**
 * What admins and members read about each responsibility: "what the agent will tell you about". These are presets the
 * agent always watches for; it also tells people about anything else worth catching in their sources.
 */
export const AGENT_RESPONSIBILITY_COPY: Record<AgentResponsibility, { label: string; tells: string }> = {
  morning_brief: { label: "Morning brief", tells: "Your meetings for the day, what overlaps and what needs prep, at the start of your workday." },
  meeting_prep: { label: "Meeting prep", tells: "Before a meeting with people from outside the company: the last email thread with them and what they're waiting on." },
  calendar_changes: { label: "Calendar changes", tells: "Meetings today or tomorrow that someone else added, moved or cancelled." },
  waiting_on_you: { label: "Waiting on you", tells: "Messages from people outside the company that have waited more than about 4 hours for your reply." },
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

/**
 * What every agent reads when the member has it connected: their calendar, through whichever calendar app the
 * organization connected (no admin picks one). Mail and chat are not sources of their own: an agent reads them through
 * the Google Workspace, Microsoft 365 or Slack connection, under that connection's own policy.
 */
export const AGENT_CORE_SOURCES = ["calendar"] as const
export type AgentCoreSource = (typeof AGENT_CORE_SOURCES)[number]
export const agentCoreSourceSchema = z.enum(AGENT_CORE_SOURCES)

export const AGENT_CORE_SOURCE_COPY: Record<AgentCoreSource, { label: string; via: string }> = {
  calendar: { label: "Calendar", via: "Google Calendar or Outlook" },
}

/**
 * `workbotAgentBrief`: an admin's choice for one tool on one connection, which wins over everything but a provider
 * marking the tool destructive ("Tools agents may use").
 */
export const AGENT_TOOL_OVERRIDES = ["allow", "deny"] as const
export type AgentToolOverride = (typeof AGENT_TOOL_OVERRIDES)[number]
export const agentToolOverrideSchema = z.enum(AGENT_TOOL_OVERRIDES)

/**
 * Why a tool may or may not be called by members' agents (`decideAgentReadTool` in @openwork/automations), in the
 * order they are checked. `destructive` and `native_write` are locked: no admin can allow them.
 */
export const AGENT_TOOL_DECISION_REASONS = [
  "destructive",
  "admin_allowed",
  "admin_denied",
  "reviewed",
  "not_reviewed",
  "marked_read",
  "marked_write",
  "read_name",
  "write_name",
  "unclear",
  "native_read",
  "native_write",
] as const
export type AgentToolDecisionReason = (typeof AGENT_TOOL_DECISION_REASONS)[number]

/** The reason, as an admin reads it next to the tool. */
export const AGENT_TOOL_DECISION_COPY: Record<AgentToolDecisionReason, string> = {
  destructive: "Its provider marks it destructive",
  admin_allowed: "Allowed by an admin",
  admin_denied: "Turned off by an admin",
  reviewed: "Reviewed as a read",
  not_reviewed: "Not on the reviewed list",
  marked_read: "Its provider marks it read-only",
  marked_write: "Its provider says it can change things",
  read_name: "Reads, by its name",
  write_name: "Changes things, by its name",
  unclear: "Not clearly a read",
  native_read: "Reads only",
  native_write: "Changes things",
}

/** How an admin lets agents read a source: on for everyone, members choose, or not allowed. */
export const AGENT_SOURCE_POLICIES = ["everyone", "members", "off"] as const
export type AgentSourcePolicy = (typeof AGENT_SOURCE_POLICIES)[number]
export const agentSourcePolicySchema = z.enum(AGENT_SOURCE_POLICIES)
export const AGENT_SOURCE_POLICY_COPY: Record<AgentSourcePolicy, string> = {
  everyone: "On for everyone",
  members: "Members choose",
  off: "Not allowed",
}

const agentSourceIdSchema = z.string().trim().min(1).max(64)
const AGENT_SOURCE_CONNECTIONS_MAX = 2000
const AGENT_TOOL_OVERRIDES_MAX = 2000
const agentToolNameSchema = z.string().trim().min(1).max(255)
const agentOtherConnectionIdsSchema = z.array(agentSourceIdSchema).max(AGENT_SOURCE_CONNECTIONS_MAX)
const tooManyConnections = { message: "Too many connections." }
const withinConnectionLimit = (value: Record<string, unknown>) => Object.keys(value).length <= AGENT_SOURCE_CONNECTIONS_MAX
const tooManyTools = { message: "Too many tools." }
const withinToolLimit = (value: Record<string, unknown>) => Object.keys(value).length <= AGENT_TOOL_OVERRIDES_MAX

/**
 * The organization's policy per source. The calendar is on for everyone by default; every connection is up to members
 * (off for them until they turn it on). Agents only ever read, whatever the policy. A policy saved before mail and chat
 * became part of their connections may still hold `email`, `chat`, `coreConnections` and `coreDefaults`: they are
 * dropped when it is read.
 */
export const agentSourcesPolicySchema = z.object({
  calendar: agentSourcePolicySchema,
  otherConnections: agentOtherConnectionIdsSchema.optional(),
  connections: z.record(agentSourceIdSchema, agentSourcePolicySchema).refine(withinConnectionLimit, tooManyConnections),
  toolOverrides: z.record(agentSourceIdSchema, z.record(agentToolNameSchema, agentToolOverrideSchema).refine(withinToolLimit, tooManyTools))
    .refine(withinConnectionLimit, tooManyConnections)
    .optional(),
})
export type AgentSourcesPolicy = z.infer<typeof agentSourcesPolicySchema>

export const DEFAULT_AGENT_SOURCES_POLICY: AgentSourcesPolicy = { calendar: "everyone", connections: {} }

/**
 * An admin's change: the calendar, the connections in Other context (null goes back to every reviewed one), and
 * connections by id (null goes back to "members choose").
 */
export const agentSourcesPolicyInputSchema = z
  .object({
    calendar: agentSourcePolicySchema.optional(),
    otherConnections: agentOtherConnectionIdsSchema.nullable().optional(),
    connections: z.record(agentSourceIdSchema, agentSourcePolicySchema.nullable()).refine(withinConnectionLimit, tooManyConnections).optional(),
    toolOverrides: z.record(
      agentSourceIdSchema,
      z.record(agentToolNameSchema, agentToolOverrideSchema.nullable()).refine(withinToolLimit, tooManyTools).nullable(),
    ).refine(withinConnectionLimit, tooManyConnections).optional(),
  })
  .strict()
export type AgentSourcesPolicyInput = z.infer<typeof agentSourcesPolicyInputSchema>

/** The connections an admin put in Other context, or null for every connection whose read tools we reviewed. */
export function agentOtherConnections(policy: AgentSourcesPolicy): readonly string[] | null {
  return policy.otherConnections ?? null
}

/** Where a connection is read: the calendar, or as a connection of its own (Other context). */
export const AGENT_SOURCE_SLOTS = [...AGENT_CORE_SOURCES, "other"] as const
export type AgentSourceSlot = (typeof AGENT_SOURCE_SLOTS)[number]

/** One of the organization's connections, as a source. */
export const agentSourceConnectionSchema = z.object({ id: z.string(), name: z.string(), url: z.string() })
export type AgentSourceConnection = z.infer<typeof agentSourceConnectionSchema>

const connectedMembersSchema = z.number().int().min(0).nullable().default(null)

/** A connection that serves the calendar, with how many members connected it. */
export const agentCoreSourceConnectionSchema = agentSourceConnectionSchema.extend({ connectedMembers: connectedMembersSchema })
export type AgentCoreSourceConnection = z.infer<typeof agentCoreSourceConnectionSchema>

/**
 * A connection in Other context. `workbotAgentBrief` adds whether it is one of Den's own providers (read there for what
 * isn't the calendar: mail, chat, files) and the policy it has now, which can differ from `settings.sources.connections`: a
 * reviewed connection an admin took out of Other context before every connection was listed stays not allowed.
 */
export const agentOtherSourceConnectionSchema = agentSourceConnectionSchema.extend({
  native: z.boolean().optional(),
  policy: agentSourcePolicySchema.optional(),
})
export type AgentOtherSourceConnection = z.infer<typeof agentOtherSourceConnectionSchema>

/** A connection an admin can add as a source, and where. */
export const agentSourceOptionSchema = agentSourceConnectionSchema.extend({
  native: z.boolean(),
  slots: z.array(z.enum(AGENT_SOURCE_SLOTS)),
  connectedMembers: connectedMembersSchema,
})
export type AgentSourceOption = z.infer<typeof agentSourceOptionSchema>

/** `workbotAgentBrief`: one of a connection's tools, and whether members' agents may call it. */
export const agentToolDecisionViewSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  allowed: z.boolean(),
  reason: z.enum(AGENT_TOOL_DECISION_REASONS),
  override: agentToolOverrideSchema.nullable(),
  locked: z.boolean(),
})
export type AgentToolDecisionView = z.infer<typeof agentToolDecisionViewSchema>

/**
 * `GET /v1/org/workbot-settings/proactive/sources/{connectionId}/tools`: a connection's tools as members' agents see
 * them. `needs_connection`: the admin's own account isn't connected, so its tools can't be listed; `unavailable`: the
 * service didn't answer.
 */
export const agentConnectionToolsViewSchema = z.object({
  connectionId: z.string(),
  status: z.enum(["ready", "needs_connection", "unavailable"]),
  readTools: z.number().int().min(0),
  tools: z.array(agentToolDecisionViewSchema),
  coreSourcesElsewhere: z.boolean(),
})
export type AgentConnectionToolsView = z.infer<typeof agentConnectionToolsViewSchema>

/** The policy for one source: a core source's own, or a connection's (members choose unless an admin decided). */
export function agentSourcePolicy(policy: AgentSourcesPolicy, sourceId: string): AgentSourcePolicy {
  const core = agentCoreSourceSchema.safeParse(sourceId)
  if (core.success) return policy[core.data]
  return policy.connections[sourceId] ?? "members"
}

export function mergeAgentSourcesPolicy(current: AgentSourcesPolicy, change: AgentSourcesPolicyInput | undefined): AgentSourcesPolicy {
  if (!change) return current
  const connections = { ...current.connections }
  for (const [id, value] of Object.entries(change.connections ?? {})) {
    if (value === null || value === "members") delete connections[id]
    else connections[id] = value
  }
  const requestedOther = change.otherConnections
  const otherConnections = requestedOther === undefined ? current.otherConnections : requestedOther ?? undefined
  const toolOverrides = mergeToolOverrides(current.toolOverrides, change.toolOverrides)
  return {
    calendar: change.calendar ?? current.calendar,
    ...(otherConnections ? { otherConnections: [...new Set(otherConnections)] } : {}),
    connections,
    ...(toolOverrides ? { toolOverrides } : {}),
  }
}

function mergeToolOverrides(current: AgentSourcesPolicy["toolOverrides"], change: AgentSourcesPolicyInput["toolOverrides"]): AgentSourcesPolicy["toolOverrides"] {
  const next: NonNullable<AgentSourcesPolicy["toolOverrides"]> = {}
  for (const [id, tools] of Object.entries(current ?? {})) next[id] = { ...tools }
  for (const [id, tools] of Object.entries(change ?? {})) {
    if (tools === null) {
      delete next[id]
      continue
    }
    const merged = { ...next[id] }
    for (const [name, value] of Object.entries(tools)) {
      if (value === null) delete merged[name]
      else merged[name] = value
    }
    if (Object.keys(merged).length) next[id] = merged
    else delete next[id]
  }
  return Object.keys(next).length ? next : undefined
}

/** An admin's choices for one connection's tools, by tool name; empty when they made none. */
export function agentToolOverrides(policy: AgentSourcesPolicy, connectionId: string): Readonly<Record<string, AgentToolOverride>> {
  return policy.toolOverrides?.[connectionId] ?? {}
}

/** How often an agent checks, in hours, inside working hours. */
export const AGENT_CHECK_EVERY_HOURS = [1, 2, 3, 4] as const
export type AgentCheckEveryHours = (typeof AGENT_CHECK_EVERY_HOURS)[number]
export const agentCheckEveryHoursSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
/** The organization's brief, in characters. */
export const AGENT_BRIEF_MAX = 2_000
/** A member's own lines, in characters. */
export const AGENT_MEMBER_BRIEF_MAX = 1_000
/** One line a member adds from chat ("Also watch our Render bill."). */
export const AGENT_BRIEF_LINE_MAX = 300
export const AGENT_BRIEF_DAILY_CAP_MAX = 10
export const AGENT_EXTRA_CHECKS_MAX = 6
/**
 * `workbotAgentCheckGate`: a scheduled check is skipped only when the evaluation model puts the chance that something
 * new could matter at or below this. The choices are what Manage › Workbot offers; the API takes any value in range.
 */
export const AGENT_CHECK_GATE_SKIP_AT_DEFAULT = 0.2
export const AGENT_CHECK_GATE_SKIP_AT_CHOICES = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5] as const
/**
 * `workbotAgentSendCheck`: a message is held only when the evaluation model is at least this sure it should not be
 * sent. The choices are what Manage › Workbot offers; the API takes any value in range.
 */
export const AGENT_SEND_CHECK_HOLD_AT_DEFAULT = 0.8
export const AGENT_SEND_CHECK_HOLD_AT_CHOICES = [0.6, 0.7, 0.8, 0.9, 0.95] as const
/** A threshold on the evaluation model's probability: never 0 or 1, which would turn a check into always or never. */
export const agentEvaluationThresholdSchema = z.number().min(0.01).max(0.99)
/** Why the agent asked for an extra check, as My bot shows it ("before your 2 PM with Northwind"). */
export const AGENT_CHECK_REQUEST_WHY_MAX = 120

/**
 * The default brief every organization starts from (docs/features/workbot-agent-brief, "Default brief"). Admins edit
 * it in Manage › Workbot; members add their own lines. The model reads it as text: nothing in code depends on its words.
 */
export const DEFAULT_AGENT_BRIEF = [
  "Tell me about things that need me soon:",
  "- someone waiting on an answer or a decision from me",
  "- a meeting I should prepare for, or a change to my day",
  "- a deadline, a commitment someone made to me, or one I made",
  "- a cost, security or reliability risk I'd want to know about",
  "- something you told me about earlier that changed, or is still unresolved",
  "",
  "On the first check of the day, the three things today needs most.",
  "Skip newsletters, routine automated notifications and anything routine, unless one carries a real cost, security or deadline risk.",
].join("\n")

/** The organization's rhythm, limits and brief under `workbotAgentBrief`. */
export const agentBriefPolicySchema = z.object({
  checkEveryHours: agentCheckEveryHoursSchema,
  dailyCap: z.number().int().min(1).max(AGENT_BRIEF_DAILY_CAP_MAX),
  extraChecksPerDay: z.number().int().min(0).max(AGENT_EXTRA_CHECKS_MAX),
  text: z.string().max(AGENT_BRIEF_MAX),
})
export type AgentBriefPolicy = z.infer<typeof agentBriefPolicySchema>

export const DEFAULT_AGENT_BRIEF_POLICY: AgentBriefPolicy = { checkEveryHours: 2, dailyCap: 4, extraChecksPerDay: 3, text: DEFAULT_AGENT_BRIEF }

/** What an admin saved under `workbot.proactive.brief`; a field not saved yet is carried over (`resolveAgentBrief`). */
export const storedAgentBriefSchema = agentBriefPolicySchema.partial()
export type StoredAgentBrief = z.infer<typeof storedAgentBriefSchema>

/** An admin's change to the brief settings: any subset. */
export const agentBriefPolicyInputSchema = z
  .object({
    checkEveryHours: agentCheckEveryHoursSchema,
    dailyCap: z.number().int().min(1).max(AGENT_BRIEF_DAILY_CAP_MAX),
    extraChecksPerDay: z.number().int().min(0).max(AGENT_EXTRA_CHECKS_MAX),
    text: z.string().trim().max(AGENT_BRIEF_MAX),
  })
  .partial()
  .strict()
export type AgentBriefPolicyInput = z.infer<typeof agentBriefPolicyInputSchema>

/** The fields of the brief settings, for `carriedOver`. */
export const AGENT_BRIEF_FIELDS = ["checkEveryHours", "dailyCap", "extraChecksPerDay", "text"] as const
export type AgentBriefField = (typeof AGENT_BRIEF_FIELDS)[number]

/** The brief settings as Manage › Workbot shows them. */
export const agentBriefViewSchema = agentBriefPolicySchema.extend({
  defaultText: z.string(),
  carriedOver: z.array(z.enum(AGENT_BRIEF_FIELDS)),
})
export type AgentBriefView = z.infer<typeof agentBriefViewSchema>

const workbotProactiveFieldsSchema = z.object({
  enabled: z.boolean(),
  leadMinutes: leadMinutesSchema,
  workingDays: z.enum(["weekdays", "everyday"]),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  dailyCap: z.number().int().min(1).max(10),
  membersStart: z.enum(["opted_in", "opted_out"]),
  destination: z.enum(["workbot_dm"]).nullable(),
  sources: agentSourcesPolicySchema,
  brief: storedAgentBriefSchema.optional(),
  checkGate: z.boolean().optional(),
  checkGateThreshold: agentEvaluationThresholdSchema.optional(),
  sendCheck: z.boolean().optional(),
  sendCheckThreshold: agentEvaluationThresholdSchema.optional(),
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
  sources: DEFAULT_AGENT_SOURCES_POLICY,
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
    sources: agentSourcesPolicyInputSchema.optional(),
    brief: agentBriefPolicyInputSchema.optional(),
  })
  .strict()
export type WorkbotProactiveSettingsInput = z.infer<typeof workbotProactiveSettingsInputSchema>

/** What Manage › Workbot shows: policy, the current template version, and where messages can go. */
export const workbotProactiveViewSchema = z.object({
  settings: workbotProactiveSettingsSchema,
  template: agentTemplateContentSchema.extend({
    versionId: z.string().nullable(),
    version: z.number().int().min(1),
  }),
  slackReady: z.boolean(),
  runnerReady: z.boolean(),
  sourceConnections: z.object({
    calendar: z.array(agentCoreSourceConnectionSchema),
    other: z.array(agentOtherSourceConnectionSchema),
    all: z.array(agentSourceOptionSchema),
  }).nullable(),
  brief: agentBriefViewSchema.optional(),
  checkGate: z.object({ model: z.boolean() }).optional(),
  sendCheck: z.object({ ready: z.boolean() }).optional(),
})
export type WorkbotProactiveView = z.infer<typeof workbotProactiveViewSchema>


/** `GET /v1/org/workbot-settings/proactive/health`: counts only, no members or content. */
export const workbotProactiveHealthSchema = z.object({
  days: z.number().int().min(1),
  members: z.number().int().min(0),
  responsibilities: z.array(z.object({
    id: agentResponsibilitySchema,
    checks: z.number().int().min(0),
    quiet: z.number().int().min(0),
    sent: z.number().int().min(0),
    muted: z.number().int().min(0),
  })),
  rhythm: z.object({ checks: z.number().int().min(0), quiet: z.number().int().min(0), sent: z.number().int().min(0) }).optional(),
})
export type WorkbotProactiveHealth = z.infer<typeof workbotProactiveHealthSchema>

/** What a member tells their agent in their own words. Plain text the agent reads as the person's wishes. */
export const AGENT_PREFERENCE_FIELDS = ["always", "never", "when", "how"] as const
export type AgentPreferenceField = (typeof AGENT_PREFERENCE_FIELDS)[number]
export const AGENT_PREFERENCE_MAX = 400

export const AGENT_PREFERENCE_COPY: Record<AgentPreferenceField, { label: string; placeholder: string }> = {
  always: { label: "Always tell me about", placeholder: "Anything from the finance team" },
  never: { label: "Never tell me about", placeholder: "Newsletters and automated alerts" },
  when: { label: "When", placeholder: "Between 12 and 2, only urgent things" },
  how: { label: "How", placeholder: "One line per item, most urgent first" },
}

const preferenceText = z.string().max(AGENT_PREFERENCE_MAX)
export const agentPreferencesSchema = z.object({ always: preferenceText, never: preferenceText, when: preferenceText, how: preferenceText })
export type AgentPreferences = z.infer<typeof agentPreferencesSchema>
export const EMPTY_AGENT_PREFERENCES: AgentPreferences = { always: "", never: "", when: "", how: "" }

/** Whole hours in the member's calendar time zone: from `startHour` until `endHour`. */
export const agentHourWindowSchema = z
  .object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(1).max(24) })
  .refine(hoursInOrder, hoursMessage)
export type AgentHourWindow = z.infer<typeof agentHourWindowSchema>

/**
 * Everything a member's change can touch: their words, their narrower limits, each responsibility's mute, and per
 * source whether it is read (`source`), their instruction for it (`sourceInstruction`) and, for the calendar, which
 * calendar app it reads (`sourceConnection`).
 */
export const AGENT_CHANGE_FIELDS = [
  ...AGENT_PREFERENCE_FIELDS, "hours", "dailyCap", "quietWindow", ...AGENT_RESPONSIBILITIES, "source", "sourceInstruction", "sourceConnection",
  "brief", "checkEveryHours",
] as const
export type AgentChangeField = (typeof AGENT_CHANGE_FIELDS)[number]
export const agentChangeFieldSchema = z.enum(AGENT_CHANGE_FIELDS)
/** Where a change came from: something the member said in chat (through Connect), or the Library page. */
export const AGENT_CHANGE_SOURCES = ["chat", "page"] as const
export type AgentChangeSource = (typeof AGENT_CHANGE_SOURCES)[number]

/** One change, as the member sees it: what, in a few words, where from and when. */
export const memberAgentChangeSchema = z.object({
  id: z.string(),
  field: agentChangeFieldSchema,
  sourceId: z.string().nullable(),
  summary: z.string(),
  source: z.enum(AGENT_CHANGE_SOURCES),
  at: z.iso.datetime(),
  undone: z.boolean(),
})
export type MemberAgentChange = z.infer<typeof memberAgentChangeSchema>

/** What came of one check. */
export const AGENT_CHECK_OUTCOMES = ["sent", "quiet", "waited", "failed"] as const
export type AgentCheckOutcome = (typeof AGENT_CHECK_OUTCOMES)[number]
/** Why, as a code; each check also carries the sentence the member reads. */
export const AGENT_CHECK_REASONS = [
  "sent",
  "nothing_new",
  "already_told",
  "unreadable_reply",
  "daily_limit",
  "nothing_to_check",
  "outside_hours",
  "quiet_window",
  "snoozed",
  "google_disconnected",
  "source_disconnected",
  "slack_app_not_installed",
  "member_not_linked",
  "no_destination",
  "send_failed",
  "agent_unavailable",
  "no_findings",
  "findings_held",
  "source_stopped",
] as const
export type AgentCheckReason = (typeof AGENT_CHECK_REASONS)[number]
/** What started the check: `morning` is the first check of the day; `requested` an extra check the agent asked for. */
export const AGENT_CHECK_KINDS = ["morning", "scheduled", "calendar", "requested"] as const
export type AgentCheckKind = (typeof AGENT_CHECK_KINDS)[number]
/** What the member can do about a check that failed. */
export const AGENT_CHECK_FIXES = ["reconnect_google", "reconnect", "link_slack", "ask_admin"] as const
export type AgentCheckFix = (typeof AGENT_CHECK_FIXES)[number]

export const memberAgentCheckSchema = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  kind: z.enum(AGENT_CHECK_KINDS),
  outcome: z.enum(AGENT_CHECK_OUTCOMES),
  reason: z.enum(AGENT_CHECK_REASONS),
  headline: z.string(),
  summary: z.string(),
  responsibilities: z.array(agentResponsibilitySchema),
  sources: z.array(z.object({ id: z.string(), name: z.string(), connectionId: z.string().nullable() })),
  slackUrl: z.string().nullable(),
  fix: z.enum(AGENT_CHECK_FIXES).nullable(),
})
export type MemberAgentCheck = z.infer<typeof memberAgentCheckSchema>

/** `GET /v1/me/agent/checks`: the member's checks, newest first. */
export const memberAgentChecksSchema = z.object({ days: z.number().int().min(1), checks: z.array(memberAgentCheckSchema) })
export type MemberAgentChecks = z.infer<typeof memberAgentChecksSchema>

/** The limits the agent follows for this member: the member's narrower choices inside the organization's. */
export const memberAgentLimitsSchema = z.object({
  workingDays: z.enum(["weekdays", "everyday"]),
  startHour: z.number().int(),
  endHour: z.number().int(),
  dailyCap: z.number().int(),
  quietWindow: agentHourWindowSchema.nullable(),
  admin: z.object({
    startHour: z.number().int(),
    endHour: z.number().int(),
    dailyCap: z.number().int(),
    checkEveryHours: z.number().int().optional(),
    extraChecksPerDay: z.number().int().optional(),
  }),
  narrowed: z.object({ hours: z.boolean(), dailyCap: z.boolean(), checkEveryHours: z.boolean().optional() }),
  checkEveryHours: z.number().int().optional(),
  extraChecksPerDay: z.number().int().optional(),
})
export type MemberAgentLimits = z.infer<typeof memberAgentLimitsSchema>

/** Whether the member's own account on a connection is ready for their agent to read. */
export const AGENT_SOURCE_CONNECTION_STATES = ["connected", "needs_connection", "reconnect"] as const

/** One connection behind a member's source, and whether their own account on it is ready. */
export const memberAgentSourceConnectionSchema = agentSourceConnectionSchema.extend({ state: z.enum(AGENT_SOURCE_CONNECTION_STATES) })
export type MemberAgentSourceConnection = z.infer<typeof memberAgentSourceConnectionSchema>

/**
 * Who picked the connection the calendar reads: the member, or automatically (the calendar app most members use, or
 * the first one the member already connected).
 */
export const AGENT_SOURCE_CHOSEN_BY = ["member", "auto"] as const
export type AgentSourceChosenBy = (typeof AGENT_SOURCE_CHOSEN_BY)[number]

/** One source as the member sees it: whether their agent reads it, why it can't, and what they told it. */
export const memberAgentSourceSchema = z.object({
  id: z.string(),
  kind: z.enum([...AGENT_CORE_SOURCES, "other"]),
  name: z.string(),
  connections: z.array(memberAgentSourceConnectionSchema),
  options: z.array(memberAgentSourceConnectionSchema).default([]),
  chosenBy: z.enum(AGENT_SOURCE_CHOSEN_BY).nullable().default(null),
  policy: agentSourcePolicySchema,
  on: z.boolean(),
  instruction: z.string(),
  lastReadAt: z.iso.datetime().nullable(),
  readTools: z.number().int().min(0).nullable().optional(),
})
export type MemberAgentSource = z.infer<typeof memberAgentSourceSchema>

/** `GET /v1/me/agent`: a member's own agent, in their words. */
export const memberAgentViewSchema = z.object({
  available: z.boolean(),
  on: z.boolean(),
  snoozedUntil: z.iso.datetime().nullable(),
  responsibilities: z.array(z.object({
    id: agentResponsibilitySchema,
    label: z.string(),
    tells: z.string(),
    enabled: z.boolean(),
    muted: z.boolean(),
  })),
  destination: z.object({
    kind: z.literal("workbot_dm"),
    name: z.string(),
    blocked: z.enum(AGENT_DESTINATION_BLOCKS).nullable(),
  }).nullable(),
  workingHours: z.object({ workingDays: z.enum(["weekdays", "everyday"]), startHour: z.number(), endHour: z.number(), dailyCap: z.number() }),
  nextCheckAt: z.iso.datetime().nullable(),
  timeZone: z.string().optional(),
  lastCheck: memberAgentCheckSchema.nullable().optional(),
  todayChecks: z.array(memberAgentCheckSchema).optional(),
  sentToday: z.number().int().min(0).optional(),
  preferences: agentPreferencesSchema.optional(),
  limits: memberAgentLimitsSchema.optional(),
  changes: z.array(memberAgentChangeSchema).optional(),
  sources: z.array(memberAgentSourceSchema).optional(),
  link: z.string().optional(),
  brief: z.object({ lines: z.string(), organization: z.string(), carriedOver: z.boolean() }).optional(),
  nextChecks: z.array(z.object({ at: z.iso.datetime(), kind: z.enum(["scheduled", "requested"]), why: z.string().nullable() })).optional(),
})
export type MemberAgentView = z.infer<typeof memberAgentViewSchema>

const preferenceInputText = z.string().trim().max(AGENT_PREFERENCE_MAX)

export const AGENT_SOURCE_CHANGES_MAX = 20

/** `PUT /v1/me/agent`: "stop telling me about calendar changes", "snooze until tomorrow", "turn it off". */
export const memberAgentInputSchema = z
  .object({
    on: z.boolean().optional(),
    snooze: z.enum(["tomorrow"]).nullable().optional(),
    mute: z.array(agentResponsibilitySchema).max(AGENT_RESPONSIBILITIES.length).optional(),
    unmute: z.array(agentResponsibilitySchema).max(AGENT_RESPONSIBILITIES.length).optional(),
    preferences: z.object({ always: preferenceInputText, never: preferenceInputText, when: preferenceInputText, how: preferenceInputText }).partial().strict().optional(),
    hours: agentHourWindowSchema.nullable().optional(),
    dailyCap: z.number().int().min(1).max(10).nullable().optional(),
    quietWindow: agentHourWindowSchema.nullable().optional(),
    sources: z.array(z.object({
      source: z.string().trim().min(1).max(120),
      on: z.boolean().optional(),
      instruction: preferenceInputText.optional(),
      connectionId: z.string().trim().min(1).max(64).optional(),
    }).strict()).min(1).max(AGENT_SOURCE_CHANGES_MAX).optional(),
    undo: z.string().trim().min(1).max(64).optional(),
    checkEveryHours: z.union([...agentCheckEveryHoursSchema.options, z.null()]).optional(),
    brief: z
      .object({
        add: z.array(z.string().trim().min(1).max(AGENT_BRIEF_LINE_MAX)).min(1).max(10).optional(),
        remove: z.array(z.string().trim().min(1).max(AGENT_BRIEF_LINE_MAX)).min(1).max(10).optional(),
        set: z.string().trim().max(AGENT_MEMBER_BRIEF_MAX).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
export type MemberAgentInput = z.infer<typeof memberAgentInputSchema>

/** `PUT /v1/me/agent`: the agent after the change, and exactly what was saved. */
export const memberAgentSavedSchema = memberAgentViewSchema.extend({
  saved: z.object({
    connect: z.array(z.object({ name: z.string(), href: z.string() })).optional(),
    changes: z.array(z.string()),
    reply: z.string(),
    link: z.string(),
  }).optional(),
})
export type MemberAgentSaved = z.infer<typeof memberAgentSavedSchema>

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
  return readStoredWorkbotProactiveSettings(isRecord(workbot) ? workbot.proactive : undefined)
}

/** A policy as it is stored (the organization's under `workbot.proactive`, or a team's own), read the same way. */
export function readStoredWorkbotProactiveSettings(value: unknown): WorkbotProactiveSettings {
  const stored = isRecord(value) ? value : {}
  const merged: Record<string, unknown> = { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS }
  for (const [key, schema] of Object.entries(workbotProactiveFieldsSchema.shape)) {
    if (key === "brief") continue
    if (key in stored && schema.safeParse(stored[key]).success) merged[key] = stored[key]
  }
  const brief = readStoredAgentBrief(stored.brief)
  if (brief) merged.brief = brief
  const fields = workbotProactiveFieldsSchema.safeParse(merged)
  if (!fields.success) return { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS }
  if (hoursInOrder(fields.data)) return fields.data
  const { startHour, endHour } = DEFAULT_WORKBOT_PROACTIVE_SETTINGS
  return { ...fields.data, startHour, endHour }
}

/** Applies a policy change; null when the result is invalid (for example a workday that ends before it starts). */
export function mergeWorkbotProactiveSettings(current: WorkbotProactiveSettings, change: WorkbotProactiveSettingsInput): WorkbotProactiveSettings | null {
  const { responsibilities: _responsibilities, instructions: _instructions, sources, brief, ...policy } = change
  const savedBrief = brief ? { ...current.brief, ...brief } : current.brief
  const parsed = workbotProactiveSettingsSchema.safeParse({
    ...current,
    ...policy,
    sources: mergeAgentSourcesPolicy(current.sources, sources),
    ...(savedBrief ? { brief: savedBrief } : {}),
  })
  return parsed.success ? parsed.data : null
}

function readStoredAgentBrief(value: unknown): StoredAgentBrief | null {
  if (!isRecord(value)) return null
  const brief: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(agentBriefPolicySchema.shape)) {
    if (key in value && schema.safeParse(value[key]).success) brief[key] = value[key]
  }
  const parsed = storedAgentBriefSchema.safeParse(brief)
  return parsed.success && Object.keys(parsed.data).length ? parsed.data : null
}

/**
 * A responsibility an admin turned off, or a member muted, as a line of the brief. The default brief already covers
 * all four; these say what not to send.
 */
export const AGENT_BRIEF_OFF_LINES: Record<AgentResponsibility, string> = {
  morning_brief: "Don't send a summary of the day on the first check.",
  meeting_prep: "Don't send meeting prep.",
  calendar_changes: "Don't tell me about calendar changes.",
  waiting_on_you: "Don't tell me who is waiting on a reply from me.",
}

const AGENT_BRIEF_WORD_PREFIX: Record<AgentPreferenceField, string> = {
  always: "Always tell me about",
  never: "Never tell me about",
  when: "When",
  how: "How",
}

const LEGACY_DEFAULT_DAILY_CAP = 3

/**
 * The organization's brief before an admin saves one: the default brief, a line for each responsibility the template
 * turned off ("Don't send meeting prep."), then the organization's instructions as written. The meeting lead time is
 * not carried over: the agent asks for an extra check before a meeting instead.
 */
export function carriedOverAgentBrief(template: AgentTemplateContent): string {
  const off = AGENT_RESPONSIBILITIES.filter((responsibility) => !template.responsibilities[responsibility]).map((responsibility) => AGENT_BRIEF_OFF_LINES[responsibility])
  const instructions = template.instructions.trim()
  return [DEFAULT_AGENT_BRIEF, off.join("\n"), instructions].filter(Boolean).join("\n\n").slice(0, AGENT_BRIEF_MAX)
}

/**
 * What agents follow under `workbotAgentBrief`: each field the admin saved, else carried over. The brief from the
 * template (above); the daily limit an admin chose, or the new default 4 when they never moved it from the old default
 * 3; a check every 2 hours and 3 extra checks a day, which had no earlier setting.
 */
export function resolveAgentBrief(settings: Pick<WorkbotProactiveSettings, "brief" | "dailyCap">, template: AgentTemplateContent): AgentBriefPolicy & { carriedOver: AgentBriefField[] } {
  const saved = settings.brief ?? {}
  const carried: AgentBriefPolicy = {
    checkEveryHours: DEFAULT_AGENT_BRIEF_POLICY.checkEveryHours,
    dailyCap: settings.dailyCap === LEGACY_DEFAULT_DAILY_CAP ? DEFAULT_AGENT_BRIEF_POLICY.dailyCap : settings.dailyCap,
    extraChecksPerDay: DEFAULT_AGENT_BRIEF_POLICY.extraChecksPerDay,
    text: carriedOverAgentBrief(template),
  }
  return {
    checkEveryHours: saved.checkEveryHours ?? carried.checkEveryHours,
    dailyCap: saved.dailyCap ?? carried.dailyCap,
    extraChecksPerDay: saved.extraChecksPerDay ?? carried.extraChecksPerDay,
    text: saved.text ?? carried.text,
    carriedOver: AGENT_BRIEF_FIELDS.filter((field) => saved[field] === undefined),
  }
}

/**
 * A member's own lines before they write any: a line per message type they muted, then their earlier words (Always /
 * Never / When / How), labeled as they wrote them. Their quiet window becomes quiet hours, enforced by Den, not a line.
 */
export function carriedOverMemberBrief(input: { muted: readonly AgentResponsibility[]; words: AgentPreferences }): string {
  const muted = AGENT_RESPONSIBILITIES.filter((responsibility) => input.muted.includes(responsibility)).map((responsibility) => AGENT_BRIEF_OFF_LINES[responsibility])
  const words = AGENT_PREFERENCE_FIELDS.flatMap((field) => {
    const text = input.words[field].trim()
    return text ? [`${AGENT_BRIEF_WORD_PREFIX[field]}: ${text}`] : []
  })
  return [...muted, ...words].join("\n").slice(0, AGENT_MEMBER_BRIEF_MAX)
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
