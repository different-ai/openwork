import { randomBytes } from "node:crypto"
import { isValidTimeZone, nextWorkingStart, parseAgentState, zonedDayStart } from "@openwork/automations/proactive"
import {
  AGENT_RESPONSIBILITIES,
  AGENT_RESPONSIBILITY_COPY,
  memberAgentChecksSchema,
  memberAgentInputSchema,
  memberAgentSavedSchema,
  memberAgentViewSchema,
  type MemberAgentCheck,
  type MemberAgentInput,
  type MemberAgentSaved,
  type MemberAgentView,
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
import { readProactiveSettings } from "../../workbot-proactive/access.js"
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
import { resolveMemberSources, type MemberConnection, type ResolvedSource } from "../../workbot-proactive/sources.js"
import { countConnectedMembers, listMemberConnections } from "../../workbot-proactive/sources-repository.js"
import { readAgentTemplate } from "../../workbot-proactive/template.js"
import { workbotOrigin } from "../../workbot/config.js"

/**
 * A member's own agent, as settings: what it will tell them about, and their controls in plain words ("stop telling
 * me about calendar changes", "snooze until tomorrow", "turn it off"). Exposed through Connect, so the member can
 * say it to Workbot; a background agent's read-scoped token can read it but never change it.
 *
 * It also answers "what did it do and why was it quiet?" (the last check,
 * today's checks, the next one) and takes the member's own words, narrower limits and Undo. A change made through
 * Connect is saved as from chat; one from Den's Library page as from the page.
 */

const memberAgentDocumentSchema = memberAgentViewSchema.meta({ ref: "MemberAgent" })
const memberAgentSavedDocumentSchema = memberAgentSavedSchema.meta({ ref: "MemberAgentSaved" })
const memberAgentInputDocumentSchema = memberAgentInputSchema.meta({ ref: "MemberAgentInput" })
const memberAgentChecksDocumentSchema = memberAgentChecksSchema.meta({ ref: "MemberAgentChecks" })
const featureDisabledSchema = z.object({ error: z.literal("feature_disabled"), feature: z.string() }).meta({ ref: "MemberAgentDisabled" })
const changeRefusedSchema = z.object({ error: z.string(), message: z.string() }).meta({ ref: "MemberAgentChangeRefused" })
const checksQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(14).optional() })

type ViewRow = (MemberChoices & Pick<AgentInstanceRow, "nextWakeAt" | "state" | "timeZone" | "preferences">) | null

function rowTimeZone(row: ViewRow) {
  return row && isValidTimeZone(row.timeZone) ? row.timeZone : "UTC"
}

function newChangeId() {
  return `chg_${randomBytes(9).toString("base64url")}`
}

/** When the agent next looks on its schedule: never inside a snooze, never outside the member's hours. */
function nextScheduledCheck(row: NonNullable<ViewRow>, settings: WorkbotProactiveSettings, now: number): string {
  const limits = memberLimits(settings, row.overrides)
  const timeZone = rowTimeZone(row)
  let at = parseAgentState(row.state).nextPassAt ?? row.nextWakeAt.getTime()
  if (row.snoozedUntil && row.snoozedUntil.getTime() > at) at = row.snoozedUntil.getTime()
  return new Date(nextWorkingStart(memberPolicy(limits), Math.max(at, now), timeZone)).toISOString()
}

async function memberAgentView(input: {
  organizationId: DenTypeId<"organization">
  memberId: DenTypeId<"member">
  userId: DenTypeId<"user">
  settings: WorkbotProactiveSettings
  row: ViewRow
}): Promise<MemberAgentView> {
  const { settings, row } = input
  const now = Date.now()
  const template = await readAgentTemplate(input.organizationId)
  const muted = mutedOf(row)
  const on = memberAgentOn(row, settings)
  const destination: MemberAgentView["destination"] = settings.destination === "workbot_dm"
    ? { kind: "workbot_dm", name: "Workbot DM", blocked: await destinationBlock({ organizationId: input.organizationId, userId: input.userId }) }
    : null
  const view: MemberAgentView = {
    available: settings.enabled,
    on,
    snoozedUntil: row?.snoozedUntil && row.snoozedUntil.getTime() > now ? row.snoozedUntil.toISOString() : null,
    responsibilities: AGENT_RESPONSIBILITIES.map((id) => ({ id, ...AGENT_RESPONSIBILITY_COPY[id], enabled: template.responsibilities[id], muted: muted.has(id) })),
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
  const sources = await memberSources({ organizationId: input.organizationId, memberId: input.memberId, settings, row })
  return {
    ...view,
    nextCheckAt: settings.enabled && on && row ? nextScheduledCheck(row, settings, now) : null,
    timeZone,
    lastCheck: last ? memberAgentCheck(last) : null,
    todayChecks: checks,
    sentToday,
    preferences: stored.words,
    limits: memberLimits(settings, row?.overrides),
    changes: memberAgentChanges(stored, settings, new Map(sources.map((source) => [source.id, source.name])), undefined, sourceConnectionNames(sources)),
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
    })),
    link: myAgentLink(),
  }
}

function memberConnectionView(connection: MemberConnection) {
  return { id: connection.id, name: connection.name, url: connection.url, state: connection.state }
}

/**
 * The member's sources as their agent sees them: the admin's policy, their choices, their connections, and how many
 * members connected each (for a core source's automatic default).
 */
async function memberSources(input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; settings: WorkbotProactiveSettings; row: ViewRow }): Promise<ResolvedSource[]> {
  const [connections, connectedMembers] = await Promise.all([
    listMemberConnections({ organizationId: input.organizationId, memberId: input.memberId }),
    countConnectedMembers(input.organizationId),
  ])
  return resolveMemberSources({
    connections,
    policy: input.settings.sources,
    choices: parseStoredPreferences(input.row?.preferences).sources,
    lastLook: parseAgentState(input.row?.state).lastLook,
    connectedMembers,
  })
}

/** The answer when agents are off for this member. */
function disabled(feature: string): { error: "feature_disabled"; feature: string } {
  return { error: "feature_disabled", feature }
}

type MemberContext = { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; userId: DenTypeId<"user"> }

export function registerMeAgentRoutes<T extends { Variables: AuthContextVariables & Partial<OrganizationContextVariables> }>(app: Hono<T>) {
  /** The signed-in member, or why the route is off for them. */
  const memberOf = (context: OrganizationContextVariables["organizationContext"] | undefined): MemberContext | { error: "workbot" | "workbotProactive" } => {
    if (!context || workbotOrigin() === null) return { error: "workbot" }
    const userId = context.currentMember.userId
    if (!userId) return { error: "workbotProactive" }
    return { organizationId: context.organization.id, memberId: context.currentMember.id, userId }
  }

  app.get(
    "/v1/me/agent",
    describeRoute({
      tags: ["Users"],
      summary: "Get my agent",
      description:
        "The signed-in member's own agent in the active organization: whether it is on for them, what it will tell them about (each responsibility, whether the organization turned it on and whether they muted it), where its messages go (a DM from the Workbot Slack app) and whether they can arrive yet (the Slack app installed, their Slack account linked), the working hours and daily limit it follows, and when it looks next. It also says what it did: `lastCheck` and `todayChecks` (each with an outcome sent, quiet, waited or failed, and a `summary` sentence that says why, for example \"Stayed quiet: nothing new.\" or \"Couldn't read Gmail: reconnect Google.\"), `sentToday` against `limits.dailyCap`, the member's own words (`preferences`: always, never, when, how), their narrower `limits` inside the admin's, their recent `changes`, and `sources`: what the agent reads (calendar, email, team chat and each other connection), each with the admin's `policy` (`everyone` = on for everyone, `members` = the member chooses, `off` = not allowed), whether it is `on`, the member's `instruction` for it, when it was last read, and whether the member's account on each connection is ready (`connected`, `needs_connection`, `reconnect`). Calendar, email and team chat each read exactly one connection: `connections` holds that one (none when nothing allowed is usable), `options` lists the allowed connections the member can pick from, and `chosenBy` says who picked it (`member`, `admin` = the organization's default, `auto` = the default most members use or the first allowed one the member already connected); other sources have empty `options` and null `chosenBy`. Answer \"why was it quiet?\" from these records, never by guessing. Requires the workbotProactive feature and Workbot on this deployment.",
      responses: {
        200: jsonResponse("The member's agent.", memberAgentDocumentSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Agents are off for this organization.", featureDisabledSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    async (c) => {
      const member = memberOf(c.get("organizationContext"))
      if ("error" in member) return c.json(disabled(member.error), 404)
      c.header("Cache-Control", "no-store")
      const settings = await readProactiveSettings(member.organizationId)
      return c.json(await memberAgentView({ ...member, settings, row: await readAgentInstance(member.memberId) }))
    },
  )

  app.get(
    "/v1/me/agent/checks",
    describeRoute({
      tags: ["Users"],
      summary: "List my agent's checks",
      description:
        "The signed-in member's agent checks over the last `days` (default 7, at most 14), newest first: when it looked, what started it (morning, scheduled, calendar), what came of it (sent, quiet, waited or failed), a reason code and a `summary` sentence (\"Stayed quiet: nothing new.\", \"Waited: outside your hours (8 AM–7 PM).\", \"Stayed quiet: daily limit reached (3 a day).\"), what it was about, a Slack link to the DM it sent, and what the member can do about a failure (`fix`). No email or message content. Use it to explain why the agent was quiet. Requires the workbotProactive feature and Workbot on this deployment.",
      responses: {
        200: jsonResponse("The member's agent checks.", memberAgentChecksDocumentSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Agents are off for this organization.", featureDisabledSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    queryValidator(checksQuerySchema),
    async (c) => {
      const member = memberOf(c.get("organizationContext"))
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
        "Changes the signed-in member's own agent, as they would say it: turn it on or off (`on`), snooze it until the next working morning or resume (`snooze: \"tomorrow\"` or null), stop or restart one kind of message (`mute` / `unmute`: morning_brief, meeting_prep, calendar_changes, waiting_on_you). Also: what they want in their own words (`preferences.always`, `.never`, `.when`, `.how`; plain text, an empty string clears one), narrower working hours (`hours: {startHour, endHour}`, null for the admin's), a lower daily limit (`dailyCap`, null for the admin's), hours inside the day when only urgent messages go out (`quietWindow: {startHour, endHour}`, null removes it), `sources`: what the agent reads, by source id or name, each with `on` and/or an `instruction` in the member's words (for \"also look at my Granola for context, especially action items after meetings, and skip Linear\" send [{source: \"Granola\", on: true, instruction: \"Use for meeting context and action items after meetings.\"}, {source: \"Linear\", on: false}]; for calendar, email or team chat also `connectionId`, one of that source's `options` ids from GET, for \"read my calendar from my Microsoft 365\" send [{source: \"calendar\", connectionId: \"<id>\"}]); and `undo`: \"last\" reverts the member's last save, a change id reverts one change (send undo on its own). A source the admin didn't allow answers 400 source_not_allowed, one that is on for everyone can't be turned off (400 source_locked), a `connectionId` that isn't one of the source's allowed options (or on a source other than calendar, email or team chat) answers 400 connection_not_allowed, each with a message that says who can change it; a source the member hasn't connected is saved and `saved.connect` names where to connect it. For \"between 12 and 2 only urgent stuff, stop telling me about calendar changes\" send preferences.when, quietWindow 12–14 and mute calendar_changes in one call. A member can only narrow the admin's limits: wider hours or a higher limit answer 400 limit_wider_than_admin with a message to relay. The response's `saved.reply` says exactly what was saved, \"Reply \\\"undo\\\" to revert.\" and the link to My agent: reply with it as is, in plain text. Organization settings and limits still apply. Requires the workbotProactive feature and Workbot on this deployment.",
      responses: {
        200: jsonResponse("The member's agent after the change.", memberAgentSavedDocumentSchema),
        400: jsonResponse("The request was invalid, or asked for more than the admin allows.", changeRefusedSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Agents are off for this organization.", featureDisabledSchema),
        409: jsonResponse("There is nothing to undo, or the change was changed again since.", changeRefusedSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    jsonValidator(memberAgentInputDocumentSchema),
    async (c) => {
      const member = memberOf(c.get("organizationContext"))
      if ("error" in member) return c.json(disabled(member.error), 404)
      c.header("Cache-Control", "no-store")
      const input = c.req.valid("json")
      const settings = await readProactiveSettings(member.organizationId)
      const now = Date.now()

      // On, snooze stay as before; everything else (mutes too) is logged with where it came from, so it can be undone.
      const plain: MemberAgentInput = { ...(input.on !== undefined ? { on: input.on } : {}), ...(input.snooze !== undefined ? { snooze: input.snooze } : {}) }
      const source = cameThroughConnect(c.req.raw.headers) ? "chat" : "page"
      // Sources are looked up before the save (they read connections, outside the row's lock).
      const sources = input.sources ? await memberSources({ ...member, settings, row: await readAgentInstance(member.memberId) }) : undefined
      const outcome = await changeMemberAgent<MemberAgentChangeResult>(member.organizationId, member.memberId, (row) => {
        const applied = applyMemberAgentChange({ request: input, overrides: row?.overrides, stored: parseStoredPreferences(row?.preferences), settings, source, now, newId: newChangeId, sources })
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
      const view = await memberAgentView({ ...member, settings, row: await readAgentInstance(member.memberId) })
      const link = myAgentLink()
      const lines = [...choiceLines(plain), ...outcome.lines]
      const connect = outcome.connect.map((entry) => ({ name: entry.name, href: entry.connectionId ? libraryConnectorLink(entry.connectionId) : libraryCatalogLink() }))
      const reply = savedReply({ lines, undid: outcome.undid, undoable: outcome.lines.length > 0, connect }, link)
      const saved: MemberAgentSaved = { ...view, saved: { changes: lines, reply, link, ...(connect.length ? { connect } : {}) } }
      return c.json(saved)
    },
  )
}
