import { z } from "zod"

/**
 * "Your agent" (behind the `workbotProactive` feature): one persistent background agent per member that reads their
 * sources (calendar, email, team chat and any other connection they turn on) on a schedule and messages them only
 * when something needs them.
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

// ---- Sources: what agents read --------------------------------------------------------------------------------------

/** What every agent reads when the member has it connected: their calendar, email and team chat. */
export const AGENT_CORE_SOURCES = ["calendar", "email", "chat"] as const
export type AgentCoreSource = (typeof AGENT_CORE_SOURCES)[number]
export const agentCoreSourceSchema = z.enum(AGENT_CORE_SOURCES)

export const AGENT_CORE_SOURCE_COPY: Record<AgentCoreSource, { label: string; via: string }> = {
  calendar: { label: "Calendar", via: "Google Calendar or Outlook" },
  email: { label: "Email", via: "Gmail or Outlook" },
  chat: { label: "Team chat", via: "Slack or Teams: DMs, mentions and threads they're in" },
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

/** A core source (`calendar`, `email`, `chat`) or another connection's id. */
const agentSourceIdSchema = z.string().trim().min(1).max(64)
/**
 * Input bounds only, far above any organization's connections: every connection is listed whatever its count
 * (`workbotAgentBrief`); these only stop a request from carrying an unbounded list.
 */
const AGENT_SOURCE_CONNECTIONS_MAX = 2000
const AGENT_CORE_CONNECTIONS_MAX = 2000
/** Tools per connection an admin can decide on; a server lists far fewer. */
const AGENT_TOOL_OVERRIDES_MAX = 2000
const agentToolNameSchema = z.string().trim().min(1).max(255)
/** The connections an admin picked for one core source; empty reads nothing (turning it off is its policy). */
const agentCoreConnectionIdsSchema = z.array(agentSourceIdSchema).max(AGENT_CORE_CONNECTIONS_MAX)
/** The connections an admin added to Other context. */
const agentOtherConnectionIdsSchema = z.array(agentSourceIdSchema).max(AGENT_SOURCE_CONNECTIONS_MAX)
const tooManyConnections = { message: "Too many connections." }
const withinConnectionLimit = (value: Record<string, unknown>) => Object.keys(value).length <= AGENT_SOURCE_CONNECTIONS_MAX
const tooManyTools = { message: "Too many tools." }
const withinToolLimit = (value: Record<string, unknown>) => Object.keys(value).length <= AGENT_TOOL_OVERRIDES_MAX

/**
 * The organization's policy per source. Calendar, email and team chat are on for everyone by default; every other
 * connection is up to members (off for them until they turn it on). Agents only ever read, whatever the policy.
 */
export const agentSourcesPolicySchema = z.object({
  calendar: agentSourcePolicySchema,
  email: agentSourcePolicySchema,
  chat: agentSourcePolicySchema,
  /**
   * Which of the organization's connections serve calendar, email and team chat, by id: Den's own providers for what
   * they serve, or an MCP connection whose read tools we reviewed. A source that isn't listed reads through every
   * connection that can serve it (Google Workspace, Microsoft 365, Slack); an empty list reads nothing.
   */
  coreConnections: z.object({
    calendar: agentCoreConnectionIdsSchema.optional(),
    email: agentCoreConnectionIdsSchema.optional(),
    chat: agentCoreConnectionIdsSchema.optional(),
  }).optional(),
  /**
   * The admin's default connection per core source, by id: what a member's agent reads when the member hasn't picked
   * one of the allowed connections and their account on it is ready. Absent (or no longer allowed): automatic, the
   * allowed connection most members already connected.
   */
  coreDefaults: z.object({
    calendar: agentSourceIdSchema.optional(),
    email: agentSourceIdSchema.optional(),
    chat: agentSourceIdSchema.optional(),
  }).optional(),
  /** The connections in Other context, by id. Absent: every connection whose read tools we reviewed. */
  otherConnections: agentOtherConnectionIdsSchema.optional(),
  /** Other connections by id; one that isn't listed is up to members. */
  connections: z.record(agentSourceIdSchema, agentSourcePolicySchema).refine(withinConnectionLimit, tooManyConnections),
  /**
   * `workbotAgentBrief`: per connection id, an admin's choice per tool name ("Tools agents may use"). A tool that isn't
   * listed is decided by its reviewed list, its provider's annotations, then its name.
   */
  toolOverrides: z.record(agentSourceIdSchema, z.record(agentToolNameSchema, agentToolOverrideSchema).refine(withinToolLimit, tooManyTools))
    .refine(withinConnectionLimit, tooManyConnections)
    .optional(),
})
export type AgentSourcesPolicy = z.infer<typeof agentSourcesPolicySchema>

export const DEFAULT_AGENT_SOURCES_POLICY: AgentSourcesPolicy = { calendar: "everyone", email: "everyone", chat: "everyone", connections: {} }

/**
 * An admin's change: any core source, the connections allowed behind a core source (null goes back to every connection
 * that serves it), its default connection (null goes back to automatic), the connections in Other context (null goes
 * back to every reviewed one), and other connections by id (null goes back to "members choose").
 */
export const agentSourcesPolicyInputSchema = z
  .object({
    calendar: agentSourcePolicySchema.optional(),
    email: agentSourcePolicySchema.optional(),
    chat: agentSourcePolicySchema.optional(),
    coreConnections: z.object({
      calendar: agentCoreConnectionIdsSchema.nullable().optional(),
      email: agentCoreConnectionIdsSchema.nullable().optional(),
      chat: agentCoreConnectionIdsSchema.nullable().optional(),
    }).strict().optional(),
    coreDefaults: z.object({
      calendar: agentSourceIdSchema.nullable().optional(),
      email: agentSourceIdSchema.nullable().optional(),
      chat: agentSourceIdSchema.nullable().optional(),
    }).strict().optional(),
    otherConnections: agentOtherConnectionIdsSchema.nullable().optional(),
    connections: z.record(agentSourceIdSchema, agentSourcePolicySchema.nullable()).refine(withinConnectionLimit, tooManyConnections).optional(),
    /**
     * `workbotAgentBrief`: per connection id, tools to allow or turn off for agents; null on a tool goes back to its
     * automatic decision, null on a connection clears all of its choices.
     */
    toolOverrides: z.record(
      agentSourceIdSchema,
      z.record(agentToolNameSchema, agentToolOverrideSchema.nullable()).refine(withinToolLimit, tooManyTools).nullable(),
    ).refine(withinConnectionLimit, tooManyConnections).optional(),
  })
  .strict()
export type AgentSourcesPolicyInput = z.infer<typeof agentSourcesPolicyInputSchema>

/** The connections an admin picked for a core source, or null for every connection that serves it. */
export function agentCoreConnections(policy: AgentSourcesPolicy, kind: AgentCoreSource): readonly string[] | null {
  return policy.coreConnections?.[kind] ?? null
}

/** The admin's default connection for a core source, or null for automatic. */
export function agentCoreDefault(policy: AgentSourcesPolicy, kind: AgentCoreSource): string | null {
  return policy.coreDefaults?.[kind] ?? null
}

/** The connections an admin put in Other context, or null for every connection whose read tools we reviewed. */
export function agentOtherConnections(policy: AgentSourcesPolicy): readonly string[] | null {
  return policy.otherConnections ?? null
}

/** Where a connection can be added: a core source, or Other context. */
export const AGENT_SOURCE_SLOTS = [...AGENT_CORE_SOURCES, "other"] as const
export type AgentSourceSlot = (typeof AGENT_SOURCE_SLOTS)[number]

/** One of the organization's connections, as a source. */
export const agentSourceConnectionSchema = z.object({ id: z.string(), name: z.string(), url: z.string() })
export type AgentSourceConnection = z.infer<typeof agentSourceConnectionSchema>

/**
 * How many members connected their own account on a connection; null when that isn't known (a connection everyone
 * shares one credential for). Absent from views saved before it existed: unknown.
 */
const connectedMembersSchema = z.number().int().min(0).nullable().default(null)

/** A connection behind calendar, email or team chat, with how many members connected it. */
export const agentCoreSourceConnectionSchema = agentSourceConnectionSchema.extend({ connectedMembers: connectedMembersSchema })
export type AgentCoreSourceConnection = z.infer<typeof agentCoreSourceConnectionSchema>

/**
 * A connection in Other context. `workbotAgentBrief` adds whether it is one of Den's own providers (read there for what
 * isn't calendar, email or chat) and the policy it has now, which can differ from `settings.sources.connections`: a
 * reviewed connection an admin took out of Other context before every connection was listed stays not allowed.
 */
export const agentOtherSourceConnectionSchema = agentSourceConnectionSchema.extend({
  native: z.boolean().optional(),
  policy: agentSourcePolicySchema.optional(),
})
export type AgentOtherSourceConnection = z.infer<typeof agentOtherSourceConnectionSchema>

/** A connection an admin can add as a source, and where. */
export const agentSourceOptionSchema = agentSourceConnectionSchema.extend({
  /** Den's own provider (Google Workspace, Microsoft 365), read through Den; otherwise an MCP with reviewed read tools. */
  native: z.boolean(),
  /** Where it can be added. */
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
  /** The admin's choice for it, if any. */
  override: agentToolOverrideSchema.nullable(),
  /** No admin can allow it (its provider marks it destructive, or one of Den's operations that changes things). */
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
  /** Tools agents may call. */
  readTools: z.number().int().min(0),
  tools: z.array(agentToolDecisionViewSchema),
  /** Den's own providers: calendar, mail and chat are read under those sources, not here. */
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
  const coreConnections: NonNullable<AgentSourcesPolicy["coreConnections"]> = {}
  for (const kind of AGENT_CORE_SOURCES) {
    const requested = change.coreConnections?.[kind]
    const picked = requested === undefined ? current.coreConnections?.[kind] : requested
    if (picked) coreConnections[kind] = [...new Set(picked)]
  }
  const coreDefaults: NonNullable<AgentSourcesPolicy["coreDefaults"]> = {}
  for (const kind of AGENT_CORE_SOURCES) {
    const requested = change.coreDefaults?.[kind]
    const chosen = requested === undefined ? current.coreDefaults?.[kind] : requested
    if (chosen) coreDefaults[kind] = chosen
  }
  const requestedOther = change.otherConnections
  const otherConnections = requestedOther === undefined ? current.otherConnections : requestedOther ?? undefined
  const toolOverrides = mergeToolOverrides(current.toolOverrides, change.toolOverrides)
  return {
    calendar: change.calendar ?? current.calendar,
    email: change.email ?? current.email,
    chat: change.chat ?? current.chat,
    ...(Object.keys(coreConnections).length ? { coreConnections } : {}),
    ...(Object.keys(coreDefaults).length ? { coreDefaults } : {}),
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

// ---- Your agent's brief and check rhythm (`workbotAgentBrief`) -----------------------------------------------------
//
// With `workbotAgentBrief` on, the four responsibilities, their mutes and the meeting lead time give way to one rhythm
// (a check every few hours inside working hours, plus extra checks the agent asks for) and a plain-text brief the
// model reads: the organization's default plus each member's own lines. Den keeps only hard limits (messages per day,
// hours, told-once, the sources an admin allows, read-only tools). Off, everything above works exactly as before; the
// follow-up that retires the responsibilities deletes them and keeps this section.

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
  /** A check every this many hours inside working hours; a member may only check less often. */
  checkEveryHours: agentCheckEveryHoursSchema,
  /** Messages per member per day; a member may only lower it. */
  dailyCap: z.number().int().min(1).max(AGENT_BRIEF_DAILY_CAP_MAX),
  /** Extra checks the agent may ask for per member per day ("check again at 1:45 before the 2 PM"). */
  extraChecksPerDay: z.number().int().min(0).max(AGENT_EXTRA_CHECKS_MAX),
  /** What to tell people, in plain text. */
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
  /** The built-in default brief, for "Reset to default". */
  defaultText: z.string(),
  /** Fields the admin hasn't saved yet, carried over from the earlier settings (responsibilities, instructions, limit). */
  carriedOver: z.array(z.enum(AGENT_BRIEF_FIELDS)),
})
export type AgentBriefView = z.infer<typeof agentBriefViewSchema>

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
  /** What agents may read, per source (Manage › Workbot › What agents read). */
  sources: agentSourcesPolicySchema,
  /**
   * The rhythm, limits and brief an admin saved under `workbotAgentBrief`; absent until they save one. Read field by
   * field: a field not saved is carried over from the settings above and the template (`resolveAgentBrief`).
   */
  brief: storedAgentBriefSchema.optional(),
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
    /** `workbotAgentBrief`: the rhythm, limits and brief (any subset). Refused while the feature is off. */
    brief: agentBriefPolicyInputSchema.optional(),
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
  /**
   * The organization's connections behind each source, for "What agents read"; null for a caller who can't view the
   * organization's connections.
   */
  sourceConnections: z.object({
    calendar: z.array(agentCoreSourceConnectionSchema),
    email: z.array(agentCoreSourceConnectionSchema),
    chat: z.array(agentCoreSourceConnectionSchema),
    /**
     * Every other connection agents can read, each its own source: with `workbotAgentBrief` every connection (Den's
     * own providers for what isn't calendar, email or chat), else a service with reviewed read tools.
     */
    other: z.array(agentOtherSourceConnectionSchema),
    /** Every connection an admin can add as a source, with where it can go. */
    all: z.array(agentSourceOptionSchema),
    /**
     * The default each core source uses now, by connection id: the admin's `coreDefaults` while it is still allowed,
     * else the automatic one (the allowed connection most members connected). Null when nothing is allowed.
     */
    defaults: z.object({ calendar: z.string().nullable(), email: z.string().nullable(), chat: z.string().nullable() })
      .default({ calendar: null, email: null, chat: null }),
  }).nullable(),
  /**
   * `workbotAgentBrief` only: the rhythm, limits and brief agents follow now. Absent while the feature is off, and from
   * servers before it.
   */
  brief: agentBriefViewSchema.optional(),
})
export type WorkbotProactiveView = z.infer<typeof workbotProactiveViewSchema>


/** `GET /v1/org/workbot-settings/proactive/health` (`workbotProactive`): counts only, no members or content. */
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
  /**
   * `workbotAgentBrief`: checks on the one rhythm, the share that stayed quiet and messages sent. Absent while the
   * feature is off; `responsibilities` then counts only checks from before it.
   */
  rhythm: z.object({ checks: z.number().int().min(0), quiet: z.number().int().min(0), sent: z.number().int().min(0) }).optional(),
})
export type WorkbotProactiveHealth = z.infer<typeof workbotProactiveHealthSchema>

// ---- My agent in the Library (`workbotProactive`) ----------------------------------------------------------------

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
 * source whether it is read (`source`), their instruction for it (`sourceInstruction`) and, for calendar, email and
 * team chat, which allowed connection it reads (`sourceConnection`).
 */
export const AGENT_CHANGE_FIELDS = [
  ...AGENT_PREFERENCE_FIELDS, "hours", "dailyCap", "quietWindow", ...AGENT_RESPONSIBILITIES, "source", "sourceInstruction", "sourceConnection",
  // `workbotAgentBrief`: the member's own brief lines, and how often their agent checks.
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
  /** For `source`, `sourceInstruction` and `sourceConnection`: which source (a core source or a connection id). */
  sourceId: z.string().nullable(),
  /** "When: “Between 12 and 2, only urgent things.”", "Stopped calendar changes". */
  summary: z.string(),
  source: z.enum(AGENT_CHANGE_SOURCES),
  at: z.iso.datetime(),
  /** Reverted with Undo. */
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
  // `workbotAgentBrief`: the check found nothing for the messenger, or found something that can wait.
  "no_findings",
  "findings_held",
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
  /** The short form for a row: "Stayed quiet", "Sent you a message about calendar changes". */
  headline: z.string(),
  /** One sentence: "Stayed quiet: nothing new." */
  summary: z.string(),
  /** What it was about (sent or held). */
  responsibilities: z.array(agentResponsibilitySchema),
  /** The sources it was about: what a message drew on, or what couldn't be read. */
  sources: z.array(z.object({ id: z.string(), name: z.string(), connectionId: z.string().nullable() })),
  /** The DM it sent, in Slack. */
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
  /** Inside these hours only messages the agent marks urgent go out. */
  quietWindow: agentHourWindowSchema.nullable(),
  /** The organization's limits (Manage › Workbot); a member can only narrow them. */
  admin: z.object({
    startHour: z.number().int(),
    endHour: z.number().int(),
    dailyCap: z.number().int(),
    /** `workbotAgentBrief`: the organization's rhythm; a member may only check less often. */
    checkEveryHours: z.number().int().optional(),
    extraChecksPerDay: z.number().int().optional(),
  }),
  narrowed: z.object({ hours: z.boolean(), dailyCap: z.boolean(), checkEveryHours: z.boolean().optional() }),
  /**
   * `workbotAgentBrief`: a check every this many hours inside `startHour`–`endHour`, never inside `quietWindow`, which
   * then means quiet hours: nothing is sent, and anything urgent goes first at the next check.
   */
  checkEveryHours: z.number().int().optional(),
  /** `workbotAgentBrief`: extra checks the agent may ask for per day. */
  extraChecksPerDay: z.number().int().optional(),
})
export type MemberAgentLimits = z.infer<typeof memberAgentLimitsSchema>

/** Whether the member's own account on a connection is ready for their agent to read. */
export const AGENT_SOURCE_CONNECTION_STATES = ["connected", "needs_connection", "reconnect"] as const

/** One connection behind a member's source, and whether their own account on it is ready. */
export const memberAgentSourceConnectionSchema = agentSourceConnectionSchema.extend({ state: z.enum(AGENT_SOURCE_CONNECTION_STATES) })
export type MemberAgentSourceConnection = z.infer<typeof memberAgentSourceConnectionSchema>

/**
 * Who picked the connection a core source reads: the member, the admin's default, or automatically (the default most
 * members use, or the first allowed one the member already connected).
 */
export const AGENT_SOURCE_CHOSEN_BY = ["member", "admin", "auto"] as const
export type AgentSourceChosenBy = (typeof AGENT_SOURCE_CHOSEN_BY)[number]

/** One source as the member sees it: whether their agent reads it, why it can't, and what they told it. */
export const memberAgentSourceSchema = z.object({
  /** `calendar`, `email`, `chat`, or a connection id. */
  id: z.string(),
  kind: z.enum([...AGENT_CORE_SOURCES, "other"]),
  /** "Calendar", "Team chat", "Granola". */
  name: z.string(),
  /**
   * The connection it reads and whether the member's account is ready. Calendar, email and team chat read exactly one
   * (none when the admin allowed none the member can use); another source reads its own connection.
   */
  connections: z.array(memberAgentSourceConnectionSchema),
  /** Calendar, email and team chat: the allowed connections the member can pick from. Empty for other sources. */
  options: z.array(memberAgentSourceConnectionSchema).default([]),
  /** Calendar, email and team chat: who picked the connection it reads. Null for other sources. */
  chosenBy: z.enum(AGENT_SOURCE_CHOSEN_BY).nullable().default(null),
  /** The admin's choice: on for everyone and not allowed are locked; members choose is the member's switch. */
  policy: agentSourcePolicySchema,
  /** The agent reads it (once a connection is ready). */
  on: z.boolean(),
  /** The member's instruction for it, in their own words. */
  instruction: z.string(),
  lastReadAt: z.iso.datetime().nullable(),
  /**
   * `workbotAgentBrief`, other sources: how many of its tools the agent may call (0: none read only, so an admin should
   * review its tools). Null when they couldn't be listed (the member's account isn't ready, or the service didn't
   * answer); absent with the feature off.
   */
  readTools: z.number().int().min(0).nullable().optional(),
})
export type MemberAgentSource = z.infer<typeof memberAgentSourceSchema>

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
  // Optional for responses from released servers predating the consolidated member view.
  /** The member's calendar time zone, from the agent's last look. */
  timeZone: z.string().optional(),
  /** The most recent check, or null before the first. */
  lastCheck: memberAgentCheckSchema.nullable().optional(),
  /** Today's checks (the member's day), newest first. */
  todayChecks: z.array(memberAgentCheckSchema).optional(),
  /** Messages sent today; the limit is `limits.dailyCap`. */
  sentToday: z.number().int().min(0).optional(),
  preferences: agentPreferencesSchema.optional(),
  limits: memberAgentLimitsSchema.optional(),
  /** The member's recent changes, newest first: where each came from, and whether it was undone. */
  changes: z.array(memberAgentChangeSchema).optional(),
  /** What the agent reads: calendar, email, team chat and every other connection it may read. */
  sources: z.array(memberAgentSourceSchema).optional(),
  /** The member's agent in the Library. */
  link: z.string().optional(),
  /**
   * `workbotAgentBrief`: what the agent follows, as text. `lines` are the member's own (an empty string for none);
   * `organization` is the admin's brief, read only. `carriedOver`: the lines came from the member's earlier settings
   * (muted messages, Always / Never / When / How) and they haven't edited them since.
   */
  brief: z.object({ lines: z.string(), organization: z.string(), carriedOver: z.boolean() }).optional(),
  /**
   * `workbotAgentBrief`: the next checks, soonest first: the next one on the rhythm and any extra checks the agent
   * asked for, each with why ("before your 2 PM with Northwind").
   */
  nextChecks: z.array(z.object({ at: z.iso.datetime(), kind: z.enum(["scheduled", "requested"]), why: z.string().nullable() })).optional(),
})
export type MemberAgentView = z.infer<typeof memberAgentViewSchema>

const preferenceInputText = z.string().trim().max(AGENT_PREFERENCE_MAX)

/** `PUT /v1/me/agent`: "stop telling me about calendar changes", "snooze until tomorrow", "turn it off". */
export const memberAgentInputSchema = z
  .object({
    on: z.boolean().optional(),
    /** `tomorrow`: until the next working morning. Null resumes. */
    snooze: z.enum(["tomorrow"]).nullable().optional(),
    mute: z.array(agentResponsibilitySchema).max(AGENT_RESPONSIBILITIES.length).optional(),
    unmute: z.array(agentResponsibilitySchema).max(AGENT_RESPONSIBILITIES.length).optional(),
    /** The member's own words; an empty string clears one. */
    preferences: z.object({ always: preferenceInputText, never: preferenceInputText, when: preferenceInputText, how: preferenceInputText }).partial().strict().optional(),
    /** Narrower working hours inside the organization's; null goes back to the organization's. */
    hours: agentHourWindowSchema.nullable().optional(),
    /** A lower daily limit than the organization's; null goes back to the organization's. */
    dailyCap: z.number().int().min(1).max(10).nullable().optional(),
    /** Hours inside the working day when only urgent messages go out; null removes it. */
    quietWindow: agentHourWindowSchema.nullable().optional(),
    /**
     * What the agent reads, by source id or name ("Granola", "Linear", "Team chat"): on or off, an instruction in the
     * member's own words (an empty string clears it), and for calendar, email or team chat which allowed connection to
     * read (`connectionId`: "read my calendar from this connection"). The admin's policy decides which sources a member
     * may change and which connections they may pick.
     */
    sources: z.array(z.object({
      source: z.string().trim().min(1).max(120),
      on: z.boolean().optional(),
      instruction: preferenceInputText.optional(),
      connectionId: z.string().trim().min(1).max(64).optional(),
    }).strict()).min(1).max(20).optional(),
    /** `last` reverts the member's last save (every field it changed); a change id reverts that one change. */
    undo: z.string().trim().min(1).max(64).optional(),
    /**
     * `workbotAgentBrief`: check less often than the organization does (1, 2, 3 or 4 hours, never more often than the
     * admin's); null goes back to the organization's. One flat union: `.nullable()` on the literal union nests an
     * `anyOf` inside an `anyOf`, which crashes the Spectral `…At` rules in `pnpm api:lint`.
     */
    checkEveryHours: z.union([...agentCheckEveryHoursSchema.options, z.null()]).optional(),
    /**
     * `workbotAgentBrief`: the member's own brief lines. `add`: lines in their words ("Also watch our Render bill.",
     * "Never tell me about newsletters."); `remove`: lines to drop, matched without case; `set`: the whole text (the
     * page sends this). An empty `set` clears them.
     */
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

/** `PUT /v1/me/agent` with `workbotProactive` on: the agent after the change, and exactly what was saved. */
export const memberAgentSavedSchema = memberAgentViewSchema.extend({
  saved: z.object({
    /** Sources it can't read until the member connects them: "Connect Granola" and where. */
    connect: z.array(z.object({ name: z.string(), href: z.string() })).optional(),
    /** One line per field changed, in plain words. Empty when nothing changed. */
    changes: z.array(z.string()),
    /** The reply to give in chat, as is: what was saved, "Reply \"undo\" to revert." and the link. */
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

/** The brief settings an admin saved, field by field: an unreadable field is simply not saved. Null for none. */
function readStoredAgentBrief(value: unknown): StoredAgentBrief | null {
  if (!isRecord(value)) return null
  const brief: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(agentBriefPolicySchema.shape)) {
    if (key in value && schema.safeParse(value[key]).success) brief[key] = value[key]
  }
  const parsed = storedAgentBriefSchema.safeParse(brief)
  return parsed.success && Object.keys(parsed.data).length ? parsed.data : null
}

// ---- Carrying the earlier settings over to the brief (`workbotAgentBrief`) -------------------------------------------

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

/** A member's earlier words, as lines of their brief. */
const AGENT_BRIEF_WORD_PREFIX: Record<AgentPreferenceField, string> = {
  always: "Always tell me about",
  never: "Never tell me about",
  when: "When",
  how: "How",
}

/** The old daily limit's default; an organization still on it gets the brief's default instead. */
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
