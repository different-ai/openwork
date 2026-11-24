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
import { activeResponsibilities, enabledOf, memberAgentOn, mutedOf } from "./policy.js"
import { memberLimits, memberPolicy, parseStoredPreferences } from "./preferences.js"
import {
  blockedConnections,
  connectionLinkDomains,
  findSource,
  readAllowlist,
  readableConnections,
  resolveMemberSources,
  type MemberConnection,
  type ResolvedSource,
} from "./sources.js"
import { checkSources, noticeStoppedSources, noticeUnreadableSources, readMemberCalendar, sourcePromptService } from "./wake-shared.js"
import type { AgentCheckCount, AgentInstanceRow, AgentSettle, DeliveryOutcome } from "./repository.js"
import type { AgentTemplateVersion } from "./template.js"
import type { AgentTurnResult } from "./turn.js"

const HOUR_MS = 3_600_000

export type AgentWakeDeps = {
  now: () => number
  allowed: (organizationId: DenTypeId<"organization">, userId: DenTypeId<"user">) => Promise<boolean>
  settings: (organizationId: DenTypeId<"organization">) => Promise<WorkbotProactiveSettings>
  template: (organizationId: DenTypeId<"organization">) => Promise<AgentTemplateVersion>
  teamPolicy?: (member: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member"> }) => Promise<{ settings: WorkbotProactiveSettings; template: AgentTemplateVersion } | null>
  user: (organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">) => Promise<DenTypeId<"user"> | null>
  calendar: (input: { organizationId: DenTypeId<"organization">; orgMembershipId: DenTypeId<"member">; connectionId: string; timeMin: string; timeMax: string }) => Promise<MemberCalendarRead>
  model: (actor: { userId: DenTypeId<"user">; organizationId: DenTypeId<"organization"> }) => Promise<string | null>
  turn: (input: { actor: { userId: string; organizationId: string }; sessionId: string; instructions: string; model: string; prompt: string; messageId: string; scopes: readonly string[] }) => Promise<AgentTurnResult>
  connections: (input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member"> }) => Promise<MemberConnection[]>
  connectedMembers?: (organizationId: DenTypeId<"organization">) => Promise<ReadonlyMap<string, number>>
  connectLink: (connectionId: string) => string
  stoppedSources?: (input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; userId: DenTypeId<"user"> }) => Promise<{ link: string } | null>
  sessionId: (organizationId: string, memberId: string) => string
  messageId: (memberId: string, wakeAt: number) => string
  told: (memberId: DenTypeId<"member">, items: readonly AgentItem[]) => Promise<Set<string>>
  reserve: (input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; item: AgentItem; outcome?: DeliveryOutcome; kind?: string }) => Promise<string | null>
  finish: (id: string, outcome: DeliveryOutcome) => Promise<void>
  sentSince: (memberId: DenTypeId<"member">, since: Date) => Promise<number>
  holdsLease: (row: AgentInstanceRow) => Promise<boolean>
  settle: (row: AgentInstanceRow, changes: AgentSettle) => Promise<boolean>
  destinationBlock: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user"> }) => Promise<AgentDestinationBlock | null>
  deliver: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; text: string }) => Promise<DeliveryResult>
  recordChecks: (input: { organizationId: DenTypeId<"organization">; day: string; counts: readonly AgentCheckCount[] }) => Promise<void>
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

export async function wakeAgent(row: AgentInstanceRow, deps: AgentWakeDeps): Promise<AgentWakeOutcome> {
  const now = deps.now()
  const organizationId = row.organizationId
  const memberId = row.memberId
  const skip = async (reason: SkipReason, nextWakeAt: number, changes: Partial<AgentSettle> = {}): Promise<AgentWakeOutcome> => {
    await deps.settle(row, { ...changes, nextWakeAt: new Date(nextWakeAt) })
    return { status: "skipped", reason }
  }

  const own = deps.teamPolicy ? await deps.teamPolicy({ organizationId, memberId }) : null
  const settings = own?.settings ?? await deps.settings(organizationId)
  if (!settings.enabled) return skip("off", now + HOUR_MS)
  const userId = await deps.user(organizationId, memberId)
  if (!userId || !(await deps.allowed(organizationId, userId))) return skip("not_allowed", now + HOUR_MS)
  if (!memberAgentOn(row, settings)) return skip("opted_out", now + 6 * HOUR_MS)

  const limits = memberLimits(settings, row.overrides)
  const policy = memberPolicy(limits)
  const state = parseAgentState(row.state)
  const slot = String(state.nextPassAt ?? "first")
  const record = async (input: { reason: AgentCheckReason; key: string; kind?: AgentCheckKind; responsibilities?: readonly AgentResponsibility[]; sources?: readonly AgentMemberCheckSource[]; message?: AgentMemberCheckMessage | null }) => {
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
  const blocked = await deps.destinationBlock({ organizationId, userId })
  if (blocked) {
    appLogger.info("workbot_agent_destination_blocked", { member_id: memberId, reason: blocked })
    await record({ reason: blocked, key: `${blocked}:${slot}` })
    return skip(blocked, now + HOUR_MS)
  }
  const template = own?.template ?? await deps.template(organizationId)
  const responsibilities = activeResponsibilities(template, row)
  if (!responsibilities.length) {
    await record({ reason: "nothing_to_check", key: `nothing_to_check:${slot}` })
    return skip("no_responsibilities", now + 6 * HOUR_MS, { templateVersionId: template.versionId })
  }

  const stored = parseStoredPreferences(row.preferences)
  const choices = stored.sources
  const [listed, connectedMembers] = await Promise.all([
    deps.connections({ organizationId, memberId }).catch(() => null),
    deps.connectedMembers ? deps.connectedMembers(organizationId).catch(() => undefined) : Promise.resolve(undefined),
  ])
  const looked = await readMemberCalendar({
    sources: resolveMemberSources({ connections: listed ?? [], policy: settings.sources, choices, lastLook: state.lastLook, connectedMembers }),
    read: (connectionId) => deps.calendar({ organizationId, orgMembershipId: memberId, connectionId, timeMin: iso(now - 15 * 60_000), timeMax: iso(now + AGENT_TIMING.horizonMs + 2 * HOUR_MS) }),
    memberId,
  })
  const sources = looked.sources
  const read: MemberCalendarRead | null = looked.read
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

  const retry = async (reply: "unavailable", code: string): Promise<AgentWakeOutcome> => {
    appLogger.info("workbot_agent_turn_unavailable", { member_id: memberId, code })
    await record({ reason: "agent_unavailable", key: `agent_unavailable:${slot}`, kind })
    await deps.settle(row, { timeZone, failures: row.failures + 1, nextWakeAt: new Date(now + AGENT_TIMING.retryMs) })
    return { status: "ran", reasons: reasons.map((reason) => reason.kind), reply, delivered: null }
  }

  if (!listed) return retry("unavailable", "sources_unavailable")
  const readable = sources.filter((source) => readableConnections(source).length > 0)

  const notices = {
    ...await noticeUnreadableSources({
      row, organizationId, userId, unreadable: blockedConnections(sources), othersReadable: readable.length > 0, told: state.notices, now, slot, kind, deps, record,
    }),
    ...await noticeStoppedSources({ row, organizationId, userId, sources, choices, othersReadable: readable.length > 0, told: state.notices, now, slot, kind, deps, record }),
  }
  if (!readable.length) {
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
        ...sourcePromptService(source),
        instruction: source.instruction,
        lastReadAt: source.lastReadAt,
      })),
      unavailable: sources
        .filter((source) => source.on && source.connections.length > 0 && !readableConnections(source).length)
        .map((source) => ({ name: source.name, why: source.connections.some((connection) => connection.state === "reconnect") ? "needs reconnecting" : "not connected" })),
      responsibilities,
      instructions: template.instructions,
      now,
      timeZone,
      wishes: { preferences: stored.words, quietWindow: limits.quietWindow },
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
  let outcome: { reason: AgentCheckReason; responsibilities?: AgentResponsibility[]; sources?: AgentMemberCheckSource[]; message?: AgentMemberCheckMessage | null } | null = { reason: "nothing_new" }
  if (result.kind === "invalid") {
    appLogger.info("workbot_agent_reply_unparsed", { member_id: memberId })
    outcome = { reason: "unreadable_reply" }
  }
  if (result.kind === "message") {
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
      quietWindow: limits.quietWindow,
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
        for (const item of rest) await deps.reserve({ organizationId, memberId, item, outcome: "folded" })
        const sent = (await deps.holdsLease(row)) && (await deps.allowed(organizationId, userId))
          ? await deps.deliver({ organizationId, userId, text: cleanAgentMessage(result.message, { linkDomains: readable.flatMap((source) => readableConnections(source).flatMap(connectionLinkDomains)) }) })
          : { ok: false as const, code: "lease_or_feature_lost" }
        await deps.finish(id, sent.ok ? "sent" : "failed")
        delivered = sent.ok ? "sent" : "failed"
        if (sent.ok) for (const preset of presetsOf(decision.items)) deliveredFor.add(preset)
        if (!sent.ok) appLogger.warn("workbot_agent_delivery_failed", { member_id: memberId, code: sent.code })
        const about = { responsibilities: presetsOf(decision.items), sources: checkSources(decision.items, sources) }
        outcome = sent.ok
          ? { reason: "sent", ...about, message: sent.message ?? null }
          : sent.code === "lease_or_feature_lost" ? null : { reason: "send_failed", ...about }
      }
    }
  }
  if (outcome) await record({ ...outcome, key: `ran:${now}`, kind })
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

function presetsOf(items: readonly AgentItem[]): AgentResponsibility[] {
  return [...new Set(items.flatMap((item) => (item.preset ? [item.preset] : [])))]
}

function calendarRead(reasons: readonly AgentWakeReason[], readable: readonly ResolvedSource[]): AgentWakeReason[] {
  const calendar = readable.some((source) => source.id === "calendar")
  return reasons.filter((reason) => reason.kind !== "calendar" || calendar)
}

