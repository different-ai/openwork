import {
  cleanAgentMessage,
  isValidTimeZone,
  parseAgentState,
  zonedDayStart,
  type AgentItem,
  type AgentState,
  type AgentWakeReason,
} from "@openwork/automations/proactive"
import {
  AGENT_ONE_MESSAGE_LIMIT,
  agentBriefForCheck,
  agentCheckPrompt,
  agentMessageRetryPrompt,
  agentOneMessageInstructions,
  agentToldToday,
  asOneMessage,
  checkGateApplies,
  decideBriefDelivery,
  extraChecksLeft,
  isFirstCheckOfDay,
  parseAboutId,
  parseAgentMessages,
  pendingCheckRequests,
  planCheckGate,
  rememberSent,
  sentLead,
  settleCheckRequests,
  withinRhythm,
  nextRhythmOpening,
  type AgentCheckOccasion,
  type AgentCheckRequest,
  type AgentConversationTurn,
  type AgentSentRecord,
} from "@openwork/automations/proactive-brief"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { resolveAgentBrief, type AgentCheckKind, type AgentCheckReason, type AgentDestinationBlock, type WorkbotProactiveSettings } from "@openwork/types/den/workbot-proactive"
import type { AgentMemberCheckMessage, AgentMemberCheckSource } from "@openwork-ee/den-db/schema"
import { agentReadScopes } from "../mcp/agent-read-sources.js"
import { appLogger } from "../observability/logger.js"
import type { MemberCalendarRead } from "../routes/org/google-workspace.js"
import { describeAgentCheck, type AgentCheckRecord } from "./checks.js"
import type { DeliveryResult } from "./deliver.js"
import type { SlackPart } from "../slack-assistant/rich-message.js"
import { agentBriefParts } from "./slack-layout.js"
import { memberBriefLines, memberRhythm, nextScheduledCheck } from "./brief.js"
import { memberAgentOn } from "./policy.js"
import { memberLimits, parseStoredPreferences } from "./preferences.js"
import { AGENT_RHYTHM_COUNTER, type AgentCheckCount, type AgentInstanceRow, type AgentSettle, type DeliveryOutcome } from "./repository.js"
import {
  blockedConnections,
  connectionLinkDomains,
  findSource,
  readAllowlist,
  readableConnections,
  resolveMemberSources,
} from "./sources.js"
import type { AgentReadToolInput } from "@openwork/automations/agent-read-tools"
import { planAgentTools, sourceUsable, unusableWhy } from "./agent-tools.js"
import { peekArrivals, type AgentCheckGate } from "./check-gate.js"
import type { AgentSendCheck } from "./send-check.js"
import type { MemberConnection } from "./sources.js"
import type { AgentRawTurnResult } from "./turn.js"
import type { AgentTemplateVersion } from "./template.js"
import { checkSources, noticeStoppedSources, noticeUnreadableSources, readMemberCalendar, sourcePromptService, type CheckRecordInput } from "./wake-shared.js"

const HOUR_MS = 3_600_000
const CONVERSATION_DAYS = 2

export type AgentBriefWakeDeps = {
  now: () => number
  allowed: (organizationId: DenTypeId<"organization">, userId: DenTypeId<"user">) => Promise<boolean>
  settings: (organizationId: DenTypeId<"organization">) => Promise<WorkbotProactiveSettings>
  template: (organizationId: DenTypeId<"organization">) => Promise<AgentTemplateVersion>
  teamPolicy?: (member: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member"> }) => Promise<{ settings: WorkbotProactiveSettings; template: AgentTemplateVersion } | null>
  user: (organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">) => Promise<DenTypeId<"user"> | null>
  calendar: (input: { organizationId: DenTypeId<"organization">; orgMembershipId: DenTypeId<"member">; connectionId: string; timeMin: string; timeMax: string }) => Promise<MemberCalendarRead>
  model: (actor: { userId: DenTypeId<"user">; organizationId: DenTypeId<"organization"> }) => Promise<string | null>
  connections: (input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member"> }) => Promise<MemberConnection[]>
  connectedMembers?: (organizationId: DenTypeId<"organization">) => Promise<ReadonlyMap<string, number>>
  connectLink: (connectionId: string) => string
  agentLink: () => string
  sessionId: (organizationId: string, memberId: string) => string
  messageId: (memberId: string, wakeAt: number) => string
  told: (memberId: DenTypeId<"member">, items: readonly AgentItem[]) => Promise<Set<string>>
  reserve: (input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; item: AgentItem; outcome?: DeliveryOutcome; kind?: string }) => Promise<string | null>
  finish: (id: string, outcome: DeliveryOutcome) => Promise<void>
  sentSince: (memberId: DenTypeId<"member">, since: Date) => Promise<number>
  holdsLease: (row: AgentInstanceRow) => Promise<boolean>
  settle: (row: AgentInstanceRow, changes: AgentSettle) => Promise<boolean>
  destinationBlock: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user"> }) => Promise<AgentDestinationBlock | null>
  deliver: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; memberId?: string; text: string; parts?: readonly SlackPart[] }) => Promise<DeliveryResult>
  recordChecks: (input: { organizationId: DenTypeId<"organization">; day: string; counts: readonly AgentCheckCount[] }) => Promise<void>
  recordCheck: (record: AgentCheckRecord) => Promise<void>
  person: (organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">) => Promise<string | null>
  check: (input: { actor: { userId: string; organizationId: string }; sessionId: string; instructions: string; model: string; prompt: string; messageId: string; scopes: readonly string[] }) => Promise<AgentRawTurnResult>
  conversation: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; since: number }) => Promise<AgentConversationTurn[] | null>
  requestedChecks: (memberId: DenTypeId<"member">) => Promise<AgentCheckRequest[]>
  readTools: (input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; connection: MemberConnection }) => Promise<readonly AgentReadToolInput[] | null>
  checkGate?: (input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; userId: DenTypeId<"user"> }) => Promise<AgentCheckGate | null>
  sendCheck?: (input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; userId: DenTypeId<"user"> }) => Promise<AgentSendCheck | null>
}

type Skip = "off" | "not_allowed" | "opted_out" | "snoozed" | "outside_hours" | "quiet_hours" | "no_destination" | AgentDestinationBlock | "no_sources" | "nothing_due"
type Delivered = "sent" | "failed" | "nothing_new" | "daily_limit" | "quiet_hours" | "quiet_window" | "snoozed" | null

export type AgentWakeOutcome =
  | { status: "skipped"; reason: Exclude<Skip, "quiet_hours"> }
  | { status: "ran"; reasons: AgentWakeReason["kind"][]; reply: "message" | "quiet" | "unavailable"; delivered: Delivered }

const KIND_OF: Record<AgentCheckOccasion["kind"], AgentCheckKind> = { first: "morning", scheduled: "scheduled", requested: "requested" }

function iso(at: number) {
  return new Date(at).toISOString()
}

function logUsage(memberId: string, turn: AgentRawTurnResult) {
  if (turn.kind !== "answered") return
  appLogger.info("workbot_agent_step_usage", {
    member_id: memberId,
    step: "check",
    input_tokens: turn.usage?.inputTokens ?? -1,
    cached_input_tokens: turn.usage?.cachedInputTokens ?? -1,
    output_tokens: turn.usage?.outputTokens ?? -1,
  })
}

function nextWake(scheduled: number, requests: readonly AgentCheckRequest[] | undefined) {
  const soonest = pendingCheckRequests(requests)[0]?.at
  return new Date(soonest !== undefined ? Math.min(scheduled, soonest) : scheduled)
}

export async function wakeAgentBrief(row: AgentInstanceRow, deps: AgentBriefWakeDeps): Promise<AgentWakeOutcome> {
  const now = deps.now()
  const organizationId = row.organizationId
  const memberId = row.memberId
  const skip = async (reason: Skip, nextWakeAt: number, changes: Partial<AgentSettle> = {}): Promise<AgentWakeOutcome> => {
    await deps.settle(row, { ...changes, nextWakeAt: new Date(nextWakeAt) })
    return { status: "skipped", reason: reason === "quiet_hours" ? "outside_hours" : reason }
  }

  const own = deps.teamPolicy ? await deps.teamPolicy({ organizationId, memberId }) : null
  const settings = own?.settings ?? await deps.settings(organizationId)
  if (!settings.enabled) return skip("off", now + HOUR_MS)
  const userId = await deps.user(organizationId, memberId)
  if (!userId || !(await deps.allowed(organizationId, userId))) return skip("not_allowed", now + HOUR_MS)
  if (!memberAgentOn(row, settings)) return skip("opted_out", now + 6 * HOUR_MS)

  const template = own?.template ?? await deps.template(organizationId)
  const brief = resolveAgentBrief(settings, template)
  const limits = memberLimits(settings, row.overrides, brief)
  const rhythm = memberRhythm(limits, brief)
  const state = parseAgentState(row.state)
  const slot = String(state.lastPassAt ?? "first")
  const snoozedUntil = row.snoozedUntil && row.snoozedUntil.getTime() > now ? row.snoozedUntil.getTime() : null
  const record = async (input: CheckRecordInput & { messages?: number }) => {
    const described = describeAgentCheck({ reason: input.reason, sources: input.sources, limits, messages: input.messages })
    await deps.recordCheck({
      organizationId,
      memberId,
      key: input.key,
      at: now,
      kind: input.kind ?? "scheduled",
      reason: input.reason,
      outcome: described.outcome,
      summary: described.summary,
      responsibilities: [],
      sources: [...new Map((input.sources ?? []).map((source) => [`${source.id}:${source.name}`, source])).values()],
      message: input.message ?? null,
    }).catch(() => appLogger.warn("workbot_agent_check_unrecorded", { member_id: memberId, reason: input.reason }))
  }

  if (snoozedUntil !== null) {
    await record({ reason: "snoozed", key: `snoozed:${snoozedUntil}` })
    return skip("snoozed", snoozedUntil)
  }
  const storedZone = isValidTimeZone(row.timeZone) ? row.timeZone : null
  const closed = async (timeZone: string, changes: Partial<AgentSettle> = {}) => {
    const opens = nextRhythmOpening(rhythm, now, timeZone)
    const quiet = rhythm.quietWindow !== null && withinRhythm({ ...rhythm, quietWindow: null }, now, timeZone)
    await record({ reason: quiet ? "quiet_window" : "outside_hours", key: `${quiet ? "quiet_window" : "outside_hours"}:${opens}` })
    return skip(quiet ? "quiet_hours" : "outside_hours", opens, changes)
  }
  if (storedZone && !withinRhythm(rhythm, now, storedZone)) return closed(storedZone)
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

  const stored = parseStoredPreferences(row.preferences)
  const [listed, connectedMembers] = await Promise.all([
    deps.connections({ organizationId, memberId }).catch(() => null),
    deps.connectedMembers ? deps.connectedMembers(organizationId).catch(() => undefined) : Promise.resolve(undefined),
  ])
  const looked = await readMemberCalendar({
    sources: resolveMemberSources({ connections: listed ?? [], policy: settings.sources, choices: stored.sources, lastLook: state.lastLook, connectedMembers }),
    read: (connectionId) => deps.calendar({ organizationId, orgMembershipId: memberId, connectionId, timeMin: iso(now), timeMax: iso(now + HOUR_MS) }),
    memberId,
  })
  const sources = looked.sources
  const calendarZone = looked.read?.kind === "ok" && typeof looked.read.json === "object" && looked.read.json !== null && "timeZone" in looked.read.json ? looked.read.json.timeZone : null
  const timeZone = typeof calendarZone === "string" && isValidTimeZone(calendarZone) ? calendarZone : storedZone ?? "UTC"
  if (!withinRhythm(rhythm, now, timeZone)) return closed(timeZone, { timeZone })

  const scheduledAt = nextScheduledCheck({ rhythm, lastCheckAt: state.lastPassAt, now, timeZone, snoozedUntil: null })
  const requested = pendingCheckRequests(state.requests).find((request) => request.at <= now)
  if (scheduledAt > now && !requested) return skip("nothing_due", nextWake(scheduledAt, state.requests).getTime(), { timeZone, failures: 0 })
  const occasion: AgentCheckOccasion = isFirstCheckOfDay(rhythm, state.lastPassAt, now, timeZone)
    ? { kind: "first" }
    : scheduledAt <= now || !requested ? { kind: "scheduled" } : { kind: "requested", at: requested.at, why: requested.why }
  const kind = KIND_OF[occasion.kind]

  const retry = async (code: string): Promise<AgentWakeOutcome> => {
    appLogger.info("workbot_agent_turn_unavailable", { member_id: memberId, code })
    await record({ reason: "agent_unavailable", key: `agent_unavailable:${slot}`, kind })
    await deps.settle(row, { timeZone, failures: row.failures + 1, nextWakeAt: new Date(now + 15 * 60_000) })
    return { status: "ran", reasons: ["scheduled"], reply: "unavailable", delivered: null }
  }
  if (!listed) return retry("sources_unavailable")
  const ready = sources.filter((source) => readableConnections(source).length > 0)
  const notices = {
    ...await noticeUnreadableSources({
      row, organizationId, userId, unreadable: blockedConnections(sources), othersReadable: ready.length > 0, told: state.notices, now, slot, kind, deps, record, combined: true,
    }),
    ...await noticeStoppedSources({ row, organizationId, userId, sources, choices: stored.sources, othersReadable: ready.length > 0, told: state.notices, now, slot, kind, deps, record }),
  }
  const toolPlan = await planAgentTools({
    sources: ready,
    overrides: settings.sources.toolOverrides ?? {},
    listTools: (connection) => deps.readTools({ organizationId, memberId, connection }),
  })
  for (const entry of toolPlan.connections) {
    appLogger.info("workbot_agent_read_tools", {
      member_id: memberId,
      connection_id: entry.connection.id,
      status: entry.status,
      allowed: entry.allowed.join(","),
      allowed_count: entry.allowed.length,
      denied_count: entry.denied,
    })
  }
  const readable = ready.filter((source) => sourceUsable(source, toolPlan))
  const withoutTools = ready.filter((source) => !sourceUsable(source, toolPlan))
  if (!readable.length) {
    return skip("no_sources", now + Math.min(6, row.failures + 1) * HOUR_MS, { state: JSON.stringify({ ...state, notices }), timeZone, failures: row.failures + 1 })
  }
  const name = (await deps.person(organizationId, memberId).catch(() => null))?.trim() || "the member"
  const briefText = agentBriefForCheck({ name, organization: brief.text, member: memberBriefLines(stored, row.overrides).lines })
  const nextAfter = nextScheduledCheck({ rhythm, lastCheckAt: now, now, timeZone, snoozedUntil: null })

  const skips = state.skips ?? 0
  const gate = settings.checkGate === true && deps.checkGate && checkGateApplies({ occasion: occasion.kind, skips }).applies
    ? await deps.checkGate({ organizationId, memberId, userId }).catch(() => null)
    : null
  if (gate) {
    const peek = await peekArrivals({
      sources: readable,
      lastLook: state.lastLook,
      now,
      timeZone,
      restricted: new Set(toolPlan.nativeReads.filter((entry) => entry.denied.length > 0).map((entry) => entry.connectionId)),
      mail: gate.mail,
      calendar: (read) => deps.calendar({ organizationId, orgMembershipId: memberId, connectionId: read.connectionId, timeMin: iso(read.timeMin), timeMax: iso(read.timeMax) }),
    })
    const plan = planCheckGate({ occasion: occasion.kind, skips, peek, brief: briefText })
    const answer = plan.kind === "ask" && gate.model ? await gate.model(plan.request, settings.checkGateThreshold) : null
    const skip = plan.kind === "skip" ? plan.why : answer?.verdict.kind === "skip" ? answer.verdict.why : null
    appLogger.info("workbot_agent_check_gate", {
      member_id: memberId,
      outcome: skip ? `skip:${skip}` : plan.kind === "run" ? `run:${plan.why}` : answer ? `run:${answer.verdict.why}` : "run:no_model",
      arrivals: peek.kind === "arrivals" ? peek.items.length : -1,
      unknown: peek.kind === "unknown" ? peek.why : "",
      skips,
      duration_ms: answer?.durationMs ?? 0,
      input_tokens: answer?.inputTokens ?? 0,
    })
    if (skip) {
      const requests = settleCheckRequests(state.requests ?? [], now)
      await record({ reason: "nothing_new", key: `ran:${now}`, kind })
      await deps.recordChecks({
        organizationId,
        day: new Date(now).toISOString().slice(0, 10),
        counts: [{ responsibility: AGENT_RHYTHM_COUNTER, checks: 1, quiet: 1, sent: 0 }],
      }).catch(() => appLogger.warn("workbot_agent_checks_unrecorded", { member_id: memberId }))
      const skipped: AgentState = { ...state, lastPassAt: now, nextPassAt: nextAfter, notices, requests, skips: skips + 1 }
      await deps.settle(row, { state: JSON.stringify(skipped), timeZone, templateVersionId: template.versionId, failures: 0, nextWakeAt: nextWake(nextAfter, requests) })
      return { status: "ran", reasons: ["scheduled"], reply: "quiet", delivered: null }
    }
  }

  const actor = { userId, organizationId }
  const model = await deps.model(actor).catch(() => null)
  if (!model) return retry("model_unavailable")

  const dayStart = zonedDayStart(now, timeZone)
  const sentToday = await deps.sentSince(memberId, new Date(dayStart))
  const recent = await deps.conversation({ organizationId, userId, since: now - CONVERSATION_DAYS * 24 * HOUR_MS }).catch(() => null)
  if (recent === null) appLogger.info("workbot_agent_conversation_unavailable", { member_id: memberId })
  const conversation = recent ?? []
  const checkTurn = {
    actor,
    sessionId: deps.sessionId(organizationId, memberId),
    instructions: agentOneMessageInstructions({ name, brief: briefText }),
    model,
    prompt: agentCheckPrompt({
      occasion,
      now,
      timeZone,
      nextCheckAt: nextAfter,
      extraChecksLeft: extraChecksLeft(state.requests, brief.extraChecksPerDay, now, timeZone),
      sent: state.sent,
      oneMessage: { name, sentToday, cap: limits.dailyCap, conversation },
      sources: readable.map((source) => ({
        id: source.id,
        name: source.name,
        via: source.kind === "other" ? [] : readableConnections(source).map((connection) => connection.name),
        ...sourcePromptService(source),
        instruction: source.instruction,
        lastReadAt: source.lastReadAt,
      })),
      unavailable: [
        ...sources
          .filter((source) => source.on && source.connections.length > 0 && !readableConnections(source).length)
          .map((source) => ({ name: source.name, why: source.connections.some((connection) => connection.state === "reconnect") ? "needs reconnecting" : "not connected" })),
        ...withoutTools.map((source) => ({ name: source.name, why: unusableWhy(source, toolPlan) })),
      ],
    }),
    messageId: deps.messageId(memberId, row.nextWakeAt.getTime()),
    scopes: agentReadScopes({ ...readAllowlist(readable), tools: toolPlan.tools, nativeReads: toolPlan.nativeReads }),
  }
  const check = await deps.check(checkTurn)
  if (check.kind === "unavailable") return retry(check.code)
  logUsage(memberId, check)
  let reply = parseAgentMessages(check.text, true)
  if (reply.kind === "invalid") {
    appLogger.info("workbot_agent_message_retry", { member_id: memberId, reason: reply.reason })
    const again = await deps.check({ ...checkTurn, prompt: agentMessageRetryPrompt(reply.reason), messageId: deps.messageId(`${memberId}:check:2`, row.nextWakeAt.getTime()) })
    if (again.kind === "unavailable") return retry(again.code)
    logUsage(memberId, again)
    reply = parseAgentMessages(again.text, true)
  }

  const requests = settleCheckRequests(await deps.requestedChecks(memberId).catch(() => state.requests ?? []), now)
  const readIds = readable.map((source) => source.id)
  const nextState: AgentState = {
    ...state,
    lastLook: { ...state.lastLook, ...Object.fromEntries(readIds.map((id) => [id, now])) },
    lastPassAt: now,
    nextPassAt: nextAfter,
    notices,
    requests,
    skips: 0,
  }

  let outcome: { reason: AgentCheckReason; sources?: AgentMemberCheckSource[]; message?: AgentMemberCheckMessage | null; messages?: number } | null = { reason: "no_findings" }
  let sent = 0
  const sentRecords: AgentSentRecord[] = []
  let delivered: Delivered = null
  if (reply.kind !== "quiet" && sentToday >= limits.dailyCap) {
    outcome = { reason: "daily_limit" }
    delivered = "daily_limit"
  } else if (reply.kind === "invalid") {
    appLogger.warn("workbot_agent_message_unparsed", { member_id: memberId, reason: reply.reason })
    outcome = { reason: "unreadable_reply" }
  } else if (reply.kind === "messages") {
    const sendCheck = settings.sendCheck === true && deps.sendCheck ? await deps.sendCheck({ organizationId, memberId, userId }).catch(() => null) : null
    const merged = asOneMessage(reply.messages)
    const candidates = merged ? [merged] : []
    let messages = candidates
    let heldForBrief = 0
    if (sendCheck) {
      const toldToday = agentToldToday({ conversation, sent: state.sent, since: dayStart })
      const checked = await Promise.all(candidates.map((message) => sendCheck({ brief: briefText, message: message.text, update: message.update, toldToday, holdAt: settings.sendCheckThreshold })))
      messages = candidates.filter((_, index) => checked[index]?.verdict.kind !== "hold")
      heldForBrief = checked.filter((result) => result.verdict.kind === "hold" && result.verdict.reason === "brief").length
      appLogger.info("workbot_agent_send_check", {
        member_id: memberId,
        messages: candidates.length,
        held_brief: heldForBrief,
        held_repeat: candidates.length - messages.length - heldForBrief,
        unavailable: checked.filter((result) => result.status === "unavailable").length,
        duration_ms: Math.max(0, ...checked.map((result) => result.durationMs)),
        input_tokens: checked.reduce((sum, result) => sum + (result.inputTokens ?? 0), 0),
      })
    }
    const resolveSource = (source: string) => findSource(sources, source)?.id ?? null
    const about = messages.flatMap((message) => message.about.flatMap((entry) => parseAboutId(entry, resolveSource) ?? []))
    const decision = decideBriefDelivery({
      messages,
      sources: new Set(readIds),
      resolveSource,
      told: await deps.told(memberId, about),
      sentToday,
      dailyCap: limits.dailyCap,
      rhythm,
      snoozedUntil: row.snoozedUntil?.getTime() ?? null,
      at: deps.now(),
      timeZone,
    })
    if (decision.kind === "held") {
      delivered = decision.reason === "outside_hours" ? "quiet_hours" : decision.reason === "quiet_hours" ? "quiet_window" : "snoozed"
      outcome = { reason: decision.reason === "outside_hours" ? "outside_hours" : decision.reason === "quiet_hours" ? "quiet_window" : "snoozed" }
    } else {
      const linkDomains = readable.flatMap((source) => readableConnections(source).flatMap(connectionLinkDomains))
      const deliverBrief = (text: string) =>
        deps.deliver({ organizationId, userId, memberId, text, parts: agentBriefParts({ text, sources: readable.map((source) => source.name), at: now, timeZone, first: occasion.kind === "first" }) })
      const drew: AgentItem[] = []
      let first: AgentMemberCheckMessage | null = null
      let failed = false
      let lost = false
      for (const message of decision.deliver) {
        const [lead, ...folded] = message.ledger
        const id = lead ? await deps.reserve({ organizationId, memberId, item: lead.item, outcome: "pending", kind: "brief" }) : null
        if (!id) continue
        for (const entry of folded) await deps.reserve({ organizationId, memberId, item: entry.item, outcome: "folded", kind: "brief" })
        const allowedNow = (await deps.holdsLease(row)) && (await deps.allowed(organizationId, userId))
        const result: DeliveryResult | { ok: false; code: "lease_or_feature_lost" } = allowedNow
          ? await deliverBrief(cleanAgentMessage(message.text, { limit: AGENT_ONE_MESSAGE_LIMIT, linkDomains }))
          : { ok: false, code: "lease_or_feature_lost" }
        await deps.finish(id, result.ok ? "sent" : "failed")
        if (result.ok) {
          sent += 1
          sentRecords.push({ at: now, about: message.about.map((item) => `${item.source}:${item.id}`), lead: sentLead(message.text) })
          drew.push(...message.about)
          first ??= result.message ?? null
        } else {
          appLogger.warn("workbot_agent_delivery_failed", { member_id: memberId, code: result.code })
          if (result.code === "lease_or_feature_lost") lost = true
          else failed = true
          break
        }
      }
      const capped = decision.skipped.some((entry) => entry.reason === "daily_limit")
      const unreadable = decision.skipped.length > 0 && decision.skipped.every((entry) => entry.reason === "unknown_source")
      if (unreadable) appLogger.warn("workbot_agent_message_unknown_sources", { member_id: memberId })
      delivered = sent ? "sent" : failed ? "failed" : capped ? "daily_limit" : "nothing_new"
      outcome = sent
        ? { reason: "sent", sources: checkSources(drew, sources), message: first, messages: sent }
        : lost ? null : failed ? { reason: "send_failed" } : capped ? { reason: "daily_limit" } : unreadable ? { reason: "unreadable_reply" }
          : !messages.length && heldForBrief ? { reason: "findings_held" } : { reason: "already_told" }
    }
  }
  if (outcome) await record({ ...outcome, key: `ran:${now}`, kind })
  await deps.recordChecks({
    organizationId,
    day: new Date(now).toISOString().slice(0, 10),
    counts: [{ responsibility: AGENT_RHYTHM_COUNTER, checks: 1, quiet: sent ? 0 : 1, sent }],
  }).catch(() => appLogger.warn("workbot_agent_checks_unrecorded", { member_id: memberId }))
  appLogger.info("workbot_agent_ran", { member_id: memberId, path: "one_message", occasion: occasion.kind, report: reply.kind, delivered: delivered ?? "none", sent })
  const settled: AgentState = {
    ...nextState,
    sent: rememberSent(state.sent, sentRecords, now),
  }
  await deps.settle(row, { state: JSON.stringify(settled), timeZone, templateVersionId: template.versionId, failures: 0, nextWakeAt: nextWake(nextAfter, requests) })
  return { status: "ran", reasons: ["scheduled"], reply: reply.kind === "messages" ? "message" : "quiet", delivered }
}
