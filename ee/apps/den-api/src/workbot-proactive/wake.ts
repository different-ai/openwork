import {
  AGENT_INSTRUCTIONS,
  AGENT_TIMING,
  agentWakePrompt,
  cleanAgentMessage,
  decideAgentDelivery,
  detectCalendarWakes,
  isMorningPass,
  isValidTimeZone,
  nextCalendarPoll,
  nextScheduledPass,
  nextWorkingStart,
  parseAgentState,
  projectGoogleCalendarEvents,
  rememberWakes,
  wakeResponsibility,
  withinWorkingHours,
  zonedDayStart,
  type AgentItem,
  type AgentState,
  type AgentWakeReason,
} from "@openwork/automations/proactive"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { AgentCheckKind, AgentCheckReason, AgentDestinationBlock, AgentResponsibility, WorkbotProactiveSettings } from "@openwork/types/den/workbot-proactive"
import type { AgentMemberCheckMessage, AgentMemberCheckSource } from "@openwork-ee/den-db/schema"
import { agentReadScopes } from "../mcp/agent-read-sources.js"
import { appLogger } from "../observability/logger.js"
import type { MemberCalendarRead } from "../routes/org/google-workspace.js"
import { describeAgentCheck, type AgentCheckRecord } from "./checks.js"
import type { DeliveryResult } from "./deliver.js"
import { activeResponsibilities, enabledOf, memberAgentOn, mutedOf, proactivePolicy } from "./policy.js"
import { memberLimits, memberPolicy, parseStoredPreferences } from "./preferences.js"
import {
  blockedConnections,
  connectionLinkDomains,
  findSource,
  readAllowlist,
  readableConnections,
  resolveMemberSources,
  withConnectionState,
  type MemberConnection,
  type ResolvedSource,
} from "./sources.js"
import type { AgentCheckCount, AgentInstanceRow, AgentSettle, DeliveryOutcome } from "./repository.js"
import type { AgentTemplateVersion } from "./template.js"
import type { AgentTurnResult } from "./turn.js"

/**
 * One wake of one member's agent: gates, the calendar event source, the member's sources (what it may read, as an
 * allowlist on the turn's read-only token), one turn in the agent's own session when the schedule or an event calls
 * for it, then the delivery step in code. A source that is on but can't be read gets one message with the action that
 * fixes it, and the agent reads the rest. Every dependency is injected (worker.ts wires the real ones), so the whole
 * decision is testable without a database, runner, Google or Connect.
 */

const HOUR_MS = 3_600_000

export type AgentWakeDeps = {
  now: () => number
  allowed: (organizationId: DenTypeId<"organization">, userId: DenTypeId<"user">) => Promise<boolean>
  settings: (organizationId: DenTypeId<"organization">) => Promise<WorkbotProactiveSettings>
  template: (organizationId: DenTypeId<"organization">) => Promise<AgentTemplateVersion>
  user: (organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">) => Promise<DenTypeId<"user"> | null>
  /** One read-only calendar GET as the member, through exactly this Google Workspace connection. */
  calendar: (input: { organizationId: DenTypeId<"organization">; orgMembershipId: DenTypeId<"member">; connectionId: string; timeMin: string; timeMax: string }) => Promise<MemberCalendarRead>
  model: (actor: { userId: DenTypeId<"user">; organizationId: DenTypeId<"organization"> }) => Promise<string | null>
  /** `scopes`: the read allowlist the turn's token carries (agent-read-sources.ts). */
  turn: (input: { actor: { userId: string; organizationId: string }; sessionId: string; instructions: string; model: string; prompt: string; messageId: string; scopes: readonly string[] }) => Promise<AgentTurnResult>
  /** The member's usable connections and whether their account on each is ready. */
  connections: (input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member"> }) => Promise<MemberConnection[]>
  /**
   * How many members connected their own account on each connection, by id: picks a core source's automatic default.
   * Without it (or when it can't be read) the default is the first allowed connection.
   */
  connectedMembers?: (organizationId: DenTypeId<"organization">) => Promise<ReadonlyMap<string, number>>
  /** Where the member connects or reconnects a connection. */
  connectLink: (connectionId: string) => string
  sessionId: (organizationId: string, memberId: string) => string
  messageId: (memberId: string, wakeAt: number) => string
  told: (memberId: DenTypeId<"member">, items: readonly AgentItem[]) => Promise<Set<string>>
  reserve: (input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; item: AgentItem; outcome?: DeliveryOutcome }) => Promise<string | null>
  finish: (id: string, outcome: DeliveryOutcome) => Promise<void>
  sentSince: (memberId: DenTypeId<"member">, since: Date) => Promise<number>
  holdsLease: (row: AgentInstanceRow) => Promise<boolean>
  settle: (row: AgentInstanceRow, changes: AgentSettle) => Promise<boolean>
  /** Why a Workbot DM couldn't reach the member now (no Slack app, Slack not linked), or null. */
  destinationBlock: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user"> }) => Promise<AgentDestinationBlock | null>
  deliver: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; text: string }) => Promise<DeliveryResult>
  /** Adds a completed pass to the organization's daily counters (the admin's health view). */
  recordChecks: (input: { organizationId: DenTypeId<"organization">; day: string; counts: readonly AgentCheckCount[] }) => Promise<void>
  /** My agent (`workbotAgentLibrary`) is on for this member: their words, narrower limits and check records. */
  library: (organizationId: DenTypeId<"organization">, userId: DenTypeId<"user">) => Promise<boolean>
  /** Keeps one check for the member to read ("Last check at 11:20 AM. Stayed quiet."). */
  recordCheck: (record: AgentCheckRecord) => Promise<void>
}

type SkipReason = "off" | "not_allowed" | "opted_out" | "snoozed" | "outside_hours" | "no_destination" | AgentDestinationBlock | "no_responsibilities" | "no_sources" | "nothing_due"
type Delivered = "sent" | "failed" | "nothing_new" | "daily_limit" | "quiet_hours" | "quiet_window" | "snoozed" | null

export type AgentWakeOutcome =
  | { status: "skipped"; reason: SkipReason }
  | { status: "ran"; reasons: AgentWakeReason["kind"][]; reply: AgentTurnResult["kind"]; delivered: Delivered }

function iso(at: number) {
  return new Date(at).toISOString()
}

/** One wake for one claimed agent. Always settles it (next wake, state) before returning. */
export async function wakeAgent(row: AgentInstanceRow, deps: AgentWakeDeps): Promise<AgentWakeOutcome> {
  const now = deps.now()
  const organizationId = row.organizationId
  const memberId = row.memberId
  const skip = async (reason: SkipReason, nextWakeAt: number, changes: Partial<AgentSettle> = {}): Promise<AgentWakeOutcome> => {
    await deps.settle(row, { ...changes, nextWakeAt: new Date(nextWakeAt) })
    return { status: "skipped", reason }
  }

  const settings = await deps.settings(organizationId)
  if (!settings.enabled) return skip("off", now + HOUR_MS)
  const userId = await deps.user(organizationId, memberId)
  if (!userId || !(await deps.allowed(organizationId, userId))) return skip("not_allowed", now + HOUR_MS)
  if (!memberAgentOn(row, settings)) return skip("opted_out", now + 6 * HOUR_MS)

  // My agent: the member's narrower limits, their own words, and a record of each check they can read. Off, the
  // agent runs exactly as before on the organization's policy.
  const library = await deps.library(organizationId, userId).catch(() => false)
  const limits = memberLimits(settings, library ? row.overrides : null)
  const policy = library ? memberPolicy(limits) : proactivePolicy(settings)
  const state = parseAgentState(row.state)
  // Skips repeat until their cause is fixed; keyed by the pass they hold up, they stay one record.
  const slot = String(state.nextPassAt ?? "first")
  const record = async (input: { reason: AgentCheckReason; key: string; kind?: AgentCheckKind; responsibilities?: readonly AgentResponsibility[]; sources?: readonly AgentMemberCheckSource[]; message?: AgentMemberCheckMessage | null }) => {
    if (!library) return
    const described = describeAgentCheck({ reason: input.reason, responsibilities: input.responsibilities, sources: input.sources, limits })
    await deps.recordCheck({
      organizationId,
      memberId,
      key: input.key,
      at: now,
      kind: input.kind ?? "scheduled",
      reason: input.reason,
      outcome: described.outcome,
      summary: described.summary,
      responsibilities: [...new Set(input.responsibilities ?? [])],
      sources: [...new Map((input.sources ?? []).map((source) => [`${source.id}:${source.name}`, source])).values()],
      message: input.message ?? null,
    }).catch(() => appLogger.warn("workbot_agent_check_unrecorded", { member_id: memberId, reason: input.reason }))
  }

  if (row.snoozedUntil && row.snoozedUntil.getTime() > now) {
    await record({ reason: "snoozed", key: `snoozed:${row.snoozedUntil.getTime()}` })
    return skip("snoozed", row.snoozedUntil.getTime())
  }

  const storedZone = isValidTimeZone(row.timeZone) ? row.timeZone : null
  if (storedZone && !withinWorkingHours(policy, now, storedZone)) {
    const opens = nextWorkingStart(policy, now, storedZone)
    await record({ reason: "outside_hours", key: `outside_hours:${opens}` })
    return skip("outside_hours", opens)
  }
  if (settings.destination !== "workbot_dm") {
    await record({ reason: "no_destination", key: `no_destination:${slot}` })
    return skip("no_destination", now + HOUR_MS)
  }
  // A message that could not arrive is not worth a turn: no Slack app, or the member's Slack not linked. The
  // member's settings say which, and the agent picks up once it is fixed.
  const blocked = await deps.destinationBlock({ organizationId, userId })
  if (blocked) {
    appLogger.info("workbot_agent_destination_blocked", { member_id: memberId, reason: blocked })
    await record({ reason: blocked, key: `${blocked}:${slot}` })
    return skip(blocked, now + HOUR_MS)
  }
  const template = await deps.template(organizationId)
  const responsibilities = activeResponsibilities(template, row)
  if (!responsibilities.length) {
    await record({ reason: "nothing_to_check", key: `nothing_to_check:${slot}` })
    return skip("no_responsibilities", now + 6 * HOUR_MS, { templateVersionId: template.versionId })
  }

  // The event source: one read-only calendar GET as the member, unless the calendar isn't theirs to read (the admin or
  // the member turned it off). It also tells us their time zone. A failed read only stops the event source here; the
  // member's sources below decide what the agent reads and what they are told to fix.
  const stored = parseStoredPreferences(row.preferences)
  const choices = library ? stored.sources : {}
  // The member's sources first: the calendar is read through the one connection its source reads for them (their
  // pick among the admin's allowed ones, else the default), never another of their accounts.
  const [listed, connectedMembers] = await Promise.all([
    deps.connections({ organizationId, memberId }).catch(() => null),
    deps.connectedMembers ? deps.connectedMembers(organizationId).catch(() => undefined) : Promise.resolve(undefined),
  ])
  let sources = resolveMemberSources({ connections: listed ?? [], policy: settings.sources, choices, lastLook: state.lastLook, connectedMembers })
  let read: MemberCalendarRead | null = null
  const calendarSource = sources.find((source) => source.id === "calendar")
  const calendarConnections = calendarSource ? readableConnections(calendarSource).filter((connection) => connection.native === "google-workspace") : []
  for (const connection of calendarConnections) {
    read = await deps.calendar({ organizationId, orgMembershipId: memberId, connectionId: connection.id, timeMin: iso(now - 15 * 60_000), timeMax: iso(now + AGENT_TIMING.horizonMs + 2 * HOUR_MS) })
    if (read.kind === "ok") break
    appLogger.info("workbot_agent_google_unavailable", { member_id: memberId, reason: read.kind })
    // Google refused just now, whatever the stored state says: this connection only. A lost sign-in holds up all it
    // serves; a missing calendar permission only the calendar.
    if (read.kind === "needs_connection") sources = withConnectionState(sources, connection.id, "reconnect")
    if (read.kind === "missing_scope") sources = withConnectionState(sources, connection.id, "reconnect", ["calendar"])
  }
  const projected = read?.kind === "ok" ? projectGoogleCalendarEvents(read.json) : null
  const timeZone = isValidTimeZone(projected?.timeZone) ? projected.timeZone : storedZone ?? "UTC"
  const calendarResponsibilities = responsibilities.includes("meeting_prep") || responsibilities.includes("calendar_changes")
  const detected = projected
    ? detectCalendarWakes({ events: projected.events, previous: state.calendar, now, timeZone, leadMinutes: settings.leadMinutes })
    : null
  const wakes = (detected?.wakes ?? []).filter((wake) => responsibilities.includes(wakeResponsibility(wake)) && !state.woke.includes(wake.ref))
  const nextPoll = projected
    ? nextCalendarPoll({ now, events: projected.events, leadMinutes: settings.leadMinutes, policy, timeZone })
    : now + AGENT_TIMING.calendarPollMs
  const nextWake = (nextPassAt: number | null) => new Date(calendarResponsibilities && projected ? Math.min(nextPoll, nextPassAt ?? nextPoll) : (nextPassAt ?? nextPoll))
  const observed: AgentState = { ...state, calendar: detected?.checkpoint ?? state.calendar }

  // Someone new: the first look learns their zone; outside their hours it only records the calendar.
  if (!withinWorkingHours(policy, now, timeZone)) {
    const opens = nextWorkingStart(policy, now, timeZone)
    await record({ reason: "outside_hours", key: `outside_hours:${opens}` })
    return skip("outside_hours", opens, { state: JSON.stringify(observed), timeZone })
  }

  const passDue = state.nextPassAt === null || state.nextPassAt <= now
  const reasons: AgentWakeReason[] = [
    ...(passDue ? [{ kind: "scheduled" as const, morning: isMorningPass(policy, state.lastPassAt, now, timeZone) }] : []),
    ...wakes.map((wake) => ({ kind: "calendar" as const, wake })),
  ]
  if (!reasons.length) return skip("nothing_due", nextWake(state.nextPassAt).getTime(), { state: JSON.stringify(observed), timeZone, failures: 0 })
  const morning = reasons.some((reason) => reason.kind === "scheduled" && reason.morning)
  const kind: AgentCheckKind = morning ? "morning" : passDue ? "scheduled" : "calendar"

  // A pass that can't run keeps the calendar where it was, so its events wake the next try too.
  const retry = async (reply: "unavailable", code: string): Promise<AgentWakeOutcome> => {
    appLogger.info("workbot_agent_turn_unavailable", { member_id: memberId, code })
    await record({ reason: "agent_unavailable", key: `agent_unavailable:${slot}`, kind })
    await deps.settle(row, { timeZone, failures: row.failures + 1, nextWakeAt: new Date(now + AGENT_TIMING.retryMs) })
    return { status: "ran", reasons: reasons.map((reason) => reason.kind), reply, delivered: null }
  }

  // The member's sources (listed above): what the admin allows, what they turned on, and whose account is ready to read.
  if (!listed) return retry("unavailable", "sources_unavailable")
  const readable = sources.filter((source) => readableConnections(source).length > 0)

  // A source that is on but can't be read: one message with the action that fixes it, once until it works again.
  const unreadable = blockedConnections(sources)
  const notices: Record<string, number> = {}
  for (const entry of unreadable) {
    const told = state.notices[entry.connection.id]
    if (told !== undefined) {
      notices[entry.connection.id] = told
      continue
    }
    const action = `${entry.connection.state === "reconnect" ? "Reconnect" : "Connect"} ${entry.connection.native ? connectionName(entry.connection) : entry.connection.name}`
    const what = joinNames(entry.sources.map((source) => source.name))
    const text = readable.length
      ? `Quick check: I can't read your ${what}, so I've paused checking ${entry.sources.length > 1 ? "them" : "it"} and kept reading the rest. <${deps.connectLink(entry.connection.id)}|${action}>`
      : `Quick check: I can't read your ${what}, so I've paused your checks until it's fixed. <${deps.connectLink(entry.connection.id)}|${action}>`
    const sent = (await deps.holdsLease(row)) && (await deps.allowed(organizationId, userId))
      ? await deps.deliver({ organizationId, userId, text })
      : { ok: false as const, code: "lease_or_feature_lost" }
    if (sent.ok) notices[entry.connection.id] = now
    await record({
      reason: "source_disconnected",
      key: `source_disconnected:${entry.connection.id}:${slot}`,
      kind,
      sources: entry.sources.map((source) => ({ id: source.id, name: source.name, connectionId: entry.connection.id })),
      message: sent.ok ? sent.message ?? null : null,
    })
  }
  if (!readable.length) {
    // Nothing to read: no turn. Look again later; the member's fix (or turning a source on) makes it due sooner.
    return skip("no_sources", now + Math.min(6, row.failures + 1) * HOUR_MS, { state: JSON.stringify({ ...observed, notices }), timeZone, failures: row.failures + 1 })
  }

  const actor = { userId, organizationId }
  const model = await deps.model(actor).catch(() => null)
  if (!model) return retry("unavailable", "model_unavailable")
  const allowlist = readAllowlist(sources)
  const result = await deps.turn({
    actor,
    sessionId: deps.sessionId(organizationId, memberId),
    instructions: AGENT_INSTRUCTIONS,
    model,
    prompt: agentWakePrompt({
      reasons: calendarRead(reasons, readable),
      sources: readable.map((source) => ({
        id: source.id,
        name: source.name,
        via: source.kind === "other" ? [] : readableConnections(source).map((connection) => connection.name),
        instruction: library ? source.instruction : "",
        lastReadAt: source.lastReadAt,
      })),
      unavailable: sources
        .filter((source) => source.on && source.connections.length > 0 && !readableConnections(source).length)
        .map((source) => ({ name: source.name, why: source.connections.some((connection) => connection.state === "reconnect") ? "needs reconnecting" : "not connected" })),
      responsibilities,
      instructions: template.instructions,
      now,
      timeZone,
      wishes: library ? { preferences: stored.words, quietWindow: limits.quietWindow } : null,
    }),
    messageId: deps.messageId(memberId, row.nextWakeAt.getTime()),
    scopes: agentReadScopes(allowlist),
  })
  if (result.kind === "unavailable") return retry("unavailable", result.code)

  const readIds = readable.map((source) => source.id)
  const nextState: AgentState = {
    v: 1,
    calendar: observed.calendar,
    lastLook: { ...state.lastLook, ...Object.fromEntries((passDue ? readIds : readIds.filter((id) => id === "calendar")).map((id) => [id, now])) },
    lastPassAt: passDue ? now : state.lastPassAt,
    nextPassAt: passDue ? nextScheduledPass(policy, now, timeZone) : state.nextPassAt,
    woke: rememberWakes(state.woke, wakes.map((wake) => wake.ref)),
    notices,
  }
  let delivered: Delivered = null
  const deliveredFor = new Set<string>()
  // What the member reads about this check: quiet unless the reply says otherwise.
  let outcome: { reason: AgentCheckReason; responsibilities?: AgentResponsibility[]; sources?: AgentMemberCheckSource[]; message?: AgentMemberCheckMessage | null } | null = { reason: "nothing_new" }
  if (result.kind === "invalid") {
    appLogger.info("workbot_agent_reply_unparsed", { member_id: memberId })
    outcome = { reason: "unreadable_reply" }
  }
  if (result.kind === "message") {
    // Items name their source as the wake did; "slack" or a connection's name means the same source.
    const items = result.items.map((item) => ({ ...item, source: findSource(sources, item.source)?.id ?? item.source }))
    const decision = decideAgentDelivery({
      items,
      sources: new Set(readIds),
      enabled: enabledOf(template),
      muted: mutedOf(row),
      told: await deps.told(memberId, items),
      sentToday: await deps.sentSince(memberId, new Date(zonedDayStart(now, timeZone))),
      policy,
      at: deps.now(),
      timeZone,
      snoozedUntil: row.snoozedUntil?.getTime() ?? null,
      quietWindow: library ? limits.quietWindow : null,
      urgent: result.urgent === true,
    })
    outcome = { reason: "already_told" }
    if (decision.kind === "drop") {
      delivered = decision.reason
      if (decision.reason === "daily_limit") for (const item of decision.items) await deps.reserve({ organizationId, memberId, item, outcome: "capped" })
      const held = decision.reason === "daily_limit" || decision.reason === "quiet_window" ? decision.items : []
      const reason: AgentCheckReason = decision.reason === "quiet_hours" ? "outside_hours" : decision.reason === "nothing_new" ? "already_told" : decision.reason
      outcome = { reason, responsibilities: presetsOf(held), sources: checkSources(held, sources) }
    } else {
      const [first, ...rest] = decision.items
      const id = first ? await deps.reserve({ organizationId, memberId, item: first }) : null
      if (id) {
        // Items carried by the same message are recorded with it, so none is ever repeated on its own.
        for (const item of rest) await deps.reserve({ organizationId, memberId, item, outcome: "folded" })
        // Right before sending: still this instance's agent, and the feature still on (a kill switch wins).
        const sent = (await deps.holdsLease(row)) && (await deps.allowed(organizationId, userId))
          ? await deps.deliver({ organizationId, userId, text: cleanAgentMessage(result.message, { linkDomains: readable.flatMap((source) => readableConnections(source).flatMap(connectionLinkDomains)) }) })
          : { ok: false as const, code: "lease_or_feature_lost" }
        await deps.finish(id, sent.ok ? "sent" : "failed")
        delivered = sent.ok ? "sent" : "failed"
        if (sent.ok) for (const preset of presetsOf(decision.items)) deliveredFor.add(preset)
        if (!sent.ok) appLogger.warn("workbot_agent_delivery_failed", { member_id: memberId, code: sent.code })
        const about = { responsibilities: presetsOf(decision.items), sources: checkSources(decision.items, sources) }
        // Lost the lease (another instance has the agent) or the feature: not this member's failure to read about.
        outcome = sent.ok
          ? { reason: "sent", ...about, message: sent.message ?? null }
          : sent.code === "lease_or_feature_lost" ? null : { reason: "send_failed", ...about }
      }
    }
  }
  if (outcome) await record({ ...outcome, key: `ran:${now}`, kind })
  // The admin's health view: every responsibility the pass asked about, and whether it produced a message.
  const asked = responsibilities.filter((responsibility) => responsibility !== "morning_brief" || morning)
  await deps.recordChecks({
    organizationId,
    day: new Date(now).toISOString().slice(0, 10),
    counts: asked.map((responsibility) => ({ responsibility, checks: 1, quiet: deliveredFor.has(responsibility) ? 0 : 1, sent: deliveredFor.has(responsibility) ? 1 : 0 })),
  }).catch(() => appLogger.warn("workbot_agent_checks_unrecorded", { member_id: memberId }))
  appLogger.info("workbot_agent_ran", { member_id: memberId, reasons: reasons.map((reason) => reason.kind).join(","), reply: result.kind, delivered: delivered ?? "none" })
  await deps.settle(row, {
    state: JSON.stringify(nextState),
    timeZone,
    templateVersionId: template.versionId,
    failures: 0,
    nextWakeAt: nextWake(nextState.nextPassAt),
  })
  return { status: "ran", reasons: reasons.map((reason) => reason.kind), reply: result.kind, delivered }
}

/** The presets a message's items fell under. */
function presetsOf(items: readonly AgentItem[]): AgentResponsibility[] {
  return [...new Set(items.flatMap((item) => (item.preset ? [item.preset] : [])))]
}

/** The sources a message's items came from, named as the member knows them ("Slack", "Gmail"). */
function checkSources(items: readonly AgentItem[], sources: readonly ResolvedSource[]): AgentMemberCheckSource[] {
  return items.flatMap((item) => {
    const source = sources.find((entry) => entry.id === item.source)
    if (!source) return []
    const connection = readableConnections(source)[0] ?? null
    return [{ id: source.id, name: source.kind === "other" ? source.name : connection?.name ?? source.name, connectionId: connection?.id ?? null }]
  })
}

/** Calendar events only wake the agent when it may read the calendar. */
function calendarRead(reasons: readonly AgentWakeReason[], readable: readonly ResolvedSource[]): AgentWakeReason[] {
  const calendar = readable.some((source) => source.id === "calendar")
  return reasons.filter((reason) => reason.kind !== "calendar" || calendar)
}

/** "Gmail and Google Calendar". */
function joinNames(names: readonly string[]) {
  const unique = [...new Set(names)]
  if (unique.length <= 1) return unique[0] ?? "source"
  return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`
}

/** A Den provider's connection as the member knows it in the Library ("Google Workspace"). */
function connectionName(connection: MemberConnection) {
  if (connection.native === "google-workspace") return "Google Workspace"
  if (connection.native === "microsoft-365") return "Microsoft 365"
  return connection.name
}
