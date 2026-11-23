import { randomBytes } from "node:crypto"
import { isValidTimeZone, nextWorkingStart, parseAgentState, zonedDayStart } from "@openwork/automations/proactive"
import {
  AGENT_RESPONSIBILITIES,
  AGENT_RESPONSIBILITY_COPY,
  resolveAgentBrief,
  memberAgentChecksSchema,
  memberAgentInputSchema,
  memberAgentSavedSchema,
  memberAgentViewSchema,
  type MemberAgentCheck,
  type MemberAgentInput,
  type MemberAgentSaved,
  type MemberAgentView,
  type AgentBriefPolicy,
  type WorkbotProactiveSettings,
} from "@openwork/types/den/workbot-proactive"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { libraryCatalogLink, libraryConnectorLink, myAgentLink } from "../../agent-links.js"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, queryValidator, type OrganizationContextVariables } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { cameThroughConnect, type AuthContextVariables } from "../../session.js"
import { agentBriefAllowed } from "../../workbot-proactive/access.js"
import { carriedMemberLines, memberBriefLines, memberNextChecks, memberRhythm } from "../../workbot-proactive/brief.js"
import { memberAgentCheck } from "../../workbot-proactive/checks.js"
import { destinationBlock } from "../../workbot-proactive/deliver.js"
import { memberAgentOn, memberChoiceChange, mutedOf, type MemberChoices } from "../../workbot-proactive/policy.js"
import {
  applyMemberAgentChange,
  choiceLines,
  memberAgentChanges,
  type MemberAgentChangeResult,
  memberLimits,
  memberPolicy,
  parseStoredPreferences,
  savedReply,
  sourceConnectionNames,
} from "../../workbot-proactive/preferences.js"
import {
  agentSentSince,
  changeMemberAgent,
  readAgentInstance,
  readLastMemberCheck,
  readMemberChecks,
  type AgentInstanceRow,
} from "../../workbot-proactive/repository.js"
import { resolveMemberSources, type MemberConnection, type ResolvedSource, type SourceMode } from "../../workbot-proactive/sources.js"
import { countConnectedMembers, loadMemberConnectorInventory } from "../../workbot-proactive/sources-repository.js"
import { sourceReadToolCounts } from "../../workbot-proactive/agent-tools.js"
import { getCatalog } from "../../mcp/index.js"
import type { McpToolOperation } from "../../mcp/catalog.js"
import { nativeOperations } from "../../mcp/native-capabilities.js"
import type { AgentTemplateVersion } from "../../workbot-proactive/template.js"
import { workbotOrigin } from "../../workbot/config.js"
import { resolveMemberAgentPolicy, resolveMemberWorkbotSettings, type AgentPolicy, type MemberTeamAgent } from "../../workbot/team-settings.js"

const PAGE_TOOLS_DEADLINE_MS = 4_000

const memberAgentDocumentSchema = memberAgentViewSchema.meta({ ref: "MemberAgent" })
const memberAgentSavedDocumentSchema = memberAgentSavedSchema.meta({ ref: "MemberAgentSaved" })
const memberAgentInputDocumentSchema = memberAgentInputSchema.meta({ ref: "MemberAgentInput" })
const memberAgentChecksDocumentSchema = memberAgentChecksSchema.meta({ ref: "MemberAgentChecks" })
const featureDisabledSchema = z.object({ error: z.literal("feature_disabled"), feature: z.string() }).meta({ ref: "MemberAgentDisabled" })
const changeRefusedSchema = z.object({ error: z.string(), message: z.string() }).meta({ ref: "MemberAgentChangeRefused" })
const agentQuerySchema = z.object({ toolCounts: z.enum(["cached", "discover"]).optional() })
const checksQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(14).optional() })

type ViewRow = (MemberChoices & Pick<AgentInstanceRow, "nextWakeAt" | "state" | "timeZone" | "preferences">) | null

function rowTimeZone(row: ViewRow) {
  return row && isValidTimeZone(row.timeZone) ? row.timeZone : "UTC"
}

function newChangeId() {
  return `chg_${randomBytes(9).toString("base64url")}`
}

function nextScheduledCheck(row: NonNullable<ViewRow>, settings: WorkbotProactiveSettings, now: number): string {
  const limits = memberLimits(settings, row.overrides)
  const timeZone = rowTimeZone(row)
  let at = parseAgentState(row.state).nextPassAt ?? row.nextWakeAt.getTime()
  if (row.snoozedUntil && row.snoozedUntil.getTime() > at) at = row.snoozedUntil.getTime()
  return new Date(nextWorkingStart(memberPolicy(limits), Math.max(at, now), timeZone)).toISOString()
}

async function agentSetup(member: MemberContext, policy: AgentPolicy): Promise<{ template: AgentTemplateVersion; brief: AgentBriefPolicy | null }> {
  const briefOn = await agentBriefAllowed(member.organizationId, member.userId)
  return { template: policy.template, brief: briefOn ? resolveAgentBrief(policy.settings, policy.template) : null }
}

async function memberAgentView(input: {
  organizationId: DenTypeId<"organization">
  memberId: DenTypeId<"member">
  userId: DenTypeId<"user">
  settings: WorkbotProactiveSettings
  row: ViewRow
  template: AgentTemplateVersion
  brief: AgentBriefPolicy | null
  toolCounts: "cached" | "discover"
  inventory?: Awaited<ReturnType<typeof loadSourceInventory>>
  catalog: () => Promise<readonly McpToolOperation[]>
}): Promise<MemberAgentView> {
  const { settings, row, template, brief } = input
  const now = Date.now()
  const muted = mutedOf(row)
  const on = memberAgentOn(row, settings)
  const destination: MemberAgentView["destination"] = settings.destination === "workbot_dm"
    ? { kind: "workbot_dm", name: "Workbot DM", blocked: await destinationBlock({ organizationId: input.organizationId, userId: input.userId }) }
    : null
  const view: MemberAgentView = {
    available: settings.enabled,
    on,
    snoozedUntil: row?.snoozedUntil && row.snoozedUntil.getTime() > now ? row.snoozedUntil.toISOString() : null,
    responsibilities: brief ? [] : AGENT_RESPONSIBILITIES.map((id) => ({ id, ...AGENT_RESPONSIBILITY_COPY[id], enabled: template.responsibilities[id], muted: muted.has(id) })),
    destination,
    workingHours: { workingDays: settings.workingDays, startHour: settings.startHour, endHour: settings.endHour, dailyCap: settings.dailyCap },
    nextCheckAt: settings.enabled && on && row?.nextWakeAt ? row.nextWakeAt.toISOString() : null,
  }
  const timeZone = rowTimeZone(row)
  const dayStart = new Date(zonedDayStart(now, timeZone))
  const stored = parseStoredPreferences(row?.preferences)
  const [today, last, sentToday] = await Promise.all([
    readMemberChecks(input.memberId, dayStart),
    readLastMemberCheck(input.memberId),
    agentSentSince(input.memberId, dayStart),
  ])
  const checks = today.flatMap((entry) => memberAgentCheck(entry) ?? [])
  const inventory = input.inventory ?? await loadSourceInventory(input)
  const sources = memberSources(inventory, settings, row, brief ? "any" : "reviewed")
  const readTools = brief
    ? await sourceReadToolCounts({
      sources,
      overrides: settings.sources.toolOverrides ?? {},
      listTools: (connection) => inventory.listTools(connection.id, PAGE_TOOLS_DEADLINE_MS, input.toolCounts === "cached"),
      nativeOperations: async (providerKey) => nativeOperations(await input.catalog(), providerKey).map((operation) => ({ name: operation.name, method: operation.method, path: operation.path, summary: operation.operation.summary ?? null })),
    })
    : null
  const limits = memberLimits(settings, row?.overrides, brief)
  const state = parseAgentState(row?.state)
  const nextChecks = brief && settings.enabled && on
    ? memberNextChecks({ rhythm: memberRhythm(limits, brief), lastCheckAt: state.lastPassAt, requests: state.requests, now, timeZone, snoozedUntil: row?.snoozedUntil?.getTime() ?? null })
    : null
  return {
    ...view,
    nextCheckAt: nextChecks ? nextChecks[0]?.at ?? null : settings.enabled && on && row ? nextScheduledCheck(row, settings, now) : null,
    timeZone,
    lastCheck: last ? memberAgentCheck(last) : null,
    todayChecks: checks,
    sentToday,
    preferences: stored.words,
    limits,
    changes: memberAgentChanges(stored, settings, new Map(sources.map((source) => [source.id, source.name])), undefined, sourceConnectionNames(sources), brief),
    sources: sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      name: source.name,
      connections: source.connections.map(memberConnectionView),
      options: source.options.map(memberConnectionView),
      chosenBy: source.chosenBy,
      policy: source.policy,
      on: source.on,
      instruction: source.instruction,
      lastReadAt: source.lastReadAt === null ? null : new Date(source.lastReadAt).toISOString(),
      ...(readTools && source.kind === "other" ? { readTools: readTools.get(source.id) ?? null } : {}),
    })),
    link: myAgentLink(),
    ...(brief ? { brief: { ...memberBriefLines(stored, row?.overrides), organization: brief.text }, nextChecks: nextChecks ?? [] } : {}),
  }
}

function memberConnectionView(connection: MemberConnection) {
  return { id: connection.id, name: connection.name, url: connection.url, state: connection.state }
}

async function loadSourceInventory(member: Pick<MemberContext, "organizationId" | "memberId">) {
  const [inventory, connectedMembers] = await Promise.all([
    loadMemberConnectorInventory(member),
    countConnectedMembers(member.organizationId),
  ])
  return { ...inventory, connectedMembers }
}

function memberSources(inventory: Awaited<ReturnType<typeof loadSourceInventory>>, settings: WorkbotProactiveSettings, row: ViewRow, mode: SourceMode): ResolvedSource[] {
  return resolveMemberSources({
    connections: inventory.connections,
    connectedMembers: inventory.connectedMembers,
    policy: settings.sources,
    choices: parseStoredPreferences(row?.preferences).sources,
    lastLook: parseAgentState(row?.state).lastLook,
    mode,
  })
}

function disabled(feature: string): { error: "feature_disabled"; feature: string } {
  return { error: "feature_disabled", feature }
}

type MemberContext = { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; userId: DenTypeId<"user"> }
type AgentMember = MemberContext & { workbot: MemberTeamAgent }

export function registerMeAgentRoutes<T extends { Variables: AuthContextVariables & Partial<OrganizationContextVariables> }>(app: Hono<T>) {
  const memberOf = async (context: OrganizationContextVariables["organizationContext"] | undefined): Promise<AgentMember | { error: "workbot" | "workbotProactive" }> => {
    if (!context || workbotOrigin() === null) return { error: "workbot" }
    const userId = context.currentMember.userId
    if (!userId) return { error: "workbotProactive" }
    const member = { organizationId: context.organization.id, memberId: context.currentMember.id, userId }
    const workbot = await resolveMemberWorkbotSettings({ ...member, organization: context.organization })
    return workbot.enabled ? { ...member, workbot: { agent: workbot.agent, agentFrom: workbot.agentFrom } } : { error: "workbot" }
  }

  app.get(
    "/v1/me/agent",
    describeRoute({
      tags: ["Users"],
      summary: "Get my agent",
      description:
        "The signed-in member's own agent in the active organization: whether it is on for them, what it will tell them about (each responsibility, whether the organization turned it on and whether they muted it), where its messages go (a DM from the Workbot Slack app) and whether they can arrive yet (the Slack app installed, their Slack account linked), the working hours and daily limit it follows, and when it looks next. It also says what it did: `lastCheck` and `todayChecks` (each with an outcome sent, quiet, waited or failed, and a `summary` sentence that says why, for example \"Stayed quiet: nothing new.\" or \"Couldn't read Gmail: reconnect Google.\"), `sentToday` against `limits.dailyCap`, the member's own words (`preferences`: always, never, when, how), their narrower `limits` inside the admin's, their recent `changes`, and `sources`: what the agent reads (the calendar and each connection, such as Google Workspace or Slack for mail and chat), each with the admin's `policy` (`everyone` = on for everyone, `members` = the member chooses, `off` = not allowed), whether it is `on`, the member's `instruction` for it, when it was last read, and whether the member's account on each connection is ready (`connected`, `needs_connection`, `reconnect`). The calendar reads exactly one connection: `connections` holds that one (none when no calendar app is usable), `options` lists the calendar apps the member can pick from, and `chosenBy` says who picked it (`member`, or `auto` = the one most members use or the first one the member already connected); other sources have empty `options` and null `chosenBy`. With Your agent's brief on (workbotAgentBrief), what it tells them about is text, not four switches: `brief.lines` are the member's own lines, `brief.organization` the organization's brief (read only), `brief.carriedOver` says the lines came from their earlier settings; `nextChecks` lists the next check on its rhythm and any extra checks the agent asked for, soonest first, each with why (\"before your 2 PM with Northwind\"); `limits.checkEveryHours` is how often it checks (`limits.admin.checkEveryHours` the most often allowed), `limits.quietWindow` is quiet hours (nothing sent), `responsibilities` is empty, and `sources` lists every connection the member can use (MCP and Den's own, which there reads what isn't the calendar: mail, chat, files), each other source with `readTools`: how many of its tools the agent may call (0: none read only, so an admin should review its tools; null while unknown). Set `toolCounts=cached` to return available counts without waiting for external tool discovery. Answer \"why was it quiet?\" from these records, never by guessing. Requires Workbot on this deployment.",
      responses: {
        200: jsonResponse("The member's agent.", memberAgentDocumentSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Agents are off for this organization, or Workbot is off for the member.", featureDisabledSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(agentQuerySchema),
    async (c) => {
      const member = await memberOf(c.get("organizationContext"))
      if ("error" in member) return c.json(disabled(member.error), 404)
      c.header("Cache-Control", "no-store")
      const policy = await resolveMemberAgentPolicy(member)
      return c.json(await memberAgentView({ ...member, toolCounts: c.req.valid("query").toolCounts ?? "discover", settings: policy.settings, row: await readAgentInstance(member.memberId), ...(await agentSetup(member, policy)), catalog: () => getCatalog(app, c.env) }))
    },
  )

  app.get(
    "/v1/me/agent/checks",
    describeRoute({
      tags: ["Users"],
      summary: "List my agent's checks",
      description:
        "The signed-in member's agent checks over the last `days` (default 7, at most 14), newest first: when it looked, what started it (morning, scheduled, calendar), what came of it (sent, quiet, waited or failed), a reason code and a `summary` sentence (\"Stayed quiet: nothing new.\", \"Waited: outside your hours (8 AM–7 PM).\", \"Stayed quiet: daily limit reached (3 a day).\"), what it was about, a Slack link to the DM it sent, and what the member can do about a failure (`fix`). No email or message content. Use it to explain why the agent was quiet. Requires Workbot on this deployment.",
      responses: {
        200: jsonResponse("The member's agent checks.", memberAgentChecksDocumentSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Agents are off for this organization, or Workbot is off for the member.", featureDisabledSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(checksQuerySchema),
    async (c) => {
      const member = await memberOf(c.get("organizationContext"))
      if ("error" in member) return c.json(disabled(member.error), 404)
      c.header("Cache-Control", "no-store")
      const days = c.req.valid("query").days ?? 7
      const rows = await readMemberChecks(member.memberId, new Date(Date.now() - days * 86_400_000))
      const checks: MemberAgentCheck[] = rows.flatMap((entry) => memberAgentCheck(entry) ?? [])
      return c.json({ days, checks })
    },
  )

  app.put(
    "/v1/me/agent",
    describeRoute({
      tags: ["Users"],
      summary: "Change my agent",
      description:
        "Changes the signed-in member's own agent, as they would say it: turn it on or off (`on`), snooze it until the next working morning or resume (`snooze: \"tomorrow\"` or null), stop or restart one kind of message (`mute` / `unmute`: morning_brief, meeting_prep, calendar_changes, waiting_on_you). Also: what they want in their own words (`preferences.always`, `.never`, `.when`, `.how`; plain text, an empty string clears one), narrower working hours (`hours: {startHour, endHour}`, null for the admin's), a lower daily limit (`dailyCap`, null for the admin's), hours inside the day when only urgent messages go out (`quietWindow: {startHour, endHour}`, null removes it), `sources`: what the agent reads, by source id or name, each with `on` and/or an `instruction` in the member's words (for \"also look at my Granola for context, especially action items after meetings, and skip Linear\" send [{source: \"Granola\", on: true, instruction: \"Use for meeting context and action items after meetings.\"}, {source: \"Linear\", on: false}]; for the calendar also `connectionId`, one of its `options` ids from GET, for \"read my calendar from my Microsoft 365\" send [{source: \"calendar\", connectionId: \"<id>\"}]); and `undo`: \"last\" reverts the member's last save, a change id reverts one change (send undo on its own). A source the admin didn't allow answers 400 source_not_allowed, one that is on for everyone can't be turned off (400 source_locked), a `connectionId` that isn't one of the calendar's options (or on a source other than the calendar) answers 400 connection_not_allowed, each with a message that says who can change it; a source the member hasn't connected is saved and `saved.connect` names where to connect it. For \"between 12 and 2 only urgent stuff, stop telling me about calendar changes\" send preferences.when, quietWindow 12–14 and mute calendar_changes in one call. A member can only narrow the admin's limits: wider hours or a higher limit answer 400 limit_wider_than_admin with a message to relay. The response's `saved.reply` says exactly what was saved, \"Reply \\\"undo\\\" to revert.\" and the link to My agent: reply with it as is, in plain text. With Your agent's brief on (workbotAgentBrief), change what it tells them with `brief` in their words: for \"also watch our Render bill\" send brief: {add: [\"Also watch our Render bill.\"]}, for \"never tell me about newsletters\" brief: {add: [\"Never tell me about newsletters.\"]}, for \"stop watching Render\" brief: {remove: [\"Render bill\"]} (matched without case; 400 brief_line_not_found lists their lines), and `set` for the whole text; and how often it checks with `checkEveryHours` (1, 2, 3 or 4; \"check every 3 hours\" is 3; never more often than the admin's, else 400 limit_wider_than_admin; null for the admin's). With the brief, any connector the member can use is a source, MCP or Den's own (for \"also use Linear\" send [{source: \"Linear\", on: true}], for \"use my Granola for meeting context\" [{source: \"Granola\", on: true, instruction: \"Use for meeting context.\"}]); its agent only calls the tools that read. `mute`/`unmute` and `preferences` are for the agent before the brief. Without the brief these answer 400 brief_unavailable. Organization settings and limits still apply. Requires Workbot on this deployment.",
      responses: {
        200: jsonResponse("The member's agent after the change.", memberAgentSavedDocumentSchema),
        400: jsonResponse("The request was invalid, or asked for more than the admin allows.", changeRefusedSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Agents are off for this organization, or Workbot is off for the member.", featureDisabledSchema),
        409: jsonResponse("There is nothing to undo, or the change was changed again since.", changeRefusedSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(memberAgentInputDocumentSchema),
    async (c) => {
      const member = await memberOf(c.get("organizationContext"))
      if ("error" in member) return c.json(disabled(member.error), 404)
      c.header("Cache-Control", "no-store")
      const input = c.req.valid("json")
      const policy = await resolveMemberAgentPolicy(member)
      const settings = policy.settings
      const setup = await agentSetup(member, policy)
      const now = Date.now()

      const plain: MemberAgentInput = { ...(input.on !== undefined ? { on: input.on } : {}), ...(input.snooze !== undefined ? { snooze: input.snooze } : {}) }
      const source = cameThroughConnect(c.req.raw.headers) ? "chat" : "page"
      const inventory = await loadSourceInventory(member)
      const outcome = await changeMemberAgent<MemberAgentChangeResult>(member.organizationId, member.memberId, (row) => {
        const sources = input.sources ? memberSources(inventory, settings, row, setup.brief ? "any" : "reviewed") : undefined
        const stored = parseStoredPreferences(row?.preferences)
        const brief = setup.brief ? { policy: setup.brief, carried: carriedMemberLines(stored, row?.overrides) } : null
        const applied = applyMemberAgentChange({ request: input, overrides: row?.overrides, stored, settings, source, now, newId: newChangeId, sources, brief })
        if (!applied.ok) return { change: null, wake: false, result: applied }
        const choice = memberChoiceChange(plain, row, settings, now, rowTimeZone(row))
        const changed = applied.lines.length > 0
        return {
          change: changed || Object.keys(choice).length ? { ...choice, ...(changed ? { overrides: applied.overrides, preferences: JSON.stringify(applied.stored) } : {}) } : null,
          wake: applied.wake,
          result: applied,
        }
      }, new Date(now))
      if (!outcome.ok) return c.json({ error: outcome.error, message: outcome.message }, outcome.status)
      const view = await memberAgentView({ ...member, settings, inventory, toolCounts: "cached", row: await readAgentInstance(member.memberId), ...setup, catalog: () => getCatalog(app, c.env) })
      const link = myAgentLink()
      const lines = [...choiceLines(plain), ...outcome.lines]
      const connect = outcome.connect.map((entry) => ({ name: entry.name, href: entry.connectionId ? libraryConnectorLink(entry.connectionId) : libraryCatalogLink() }))
      const reply = savedReply({ lines, undid: outcome.undid, undoable: outcome.lines.length > 0, connect }, link)
      const saved: MemberAgentSaved = { ...view, saved: { changes: lines, reply, link, ...(connect.length ? { connect } : {}) } }
      return c.json(saved)
    },
  )
}
