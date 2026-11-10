import {
  cleanAgentMessage,
  isValidTimeZone,
  parseAgentState,
  zonedDayStart,
  type AgentItem,
  type AgentState,
} from "@openwork/automations/proactive"
import {
  AGENT_BRIEF_MESSAGE_LIMIT,
  agentBriefForCheck,
  agentCheckInstructions,
  agentCheckPrompt,
  agentMessageInstructions,
  agentMessagePrompt,
  agentMessageRetryPrompt,
  decideBriefDelivery,
  extraChecksLeft,
  isFirstCheckOfDay,
  parseAboutId,
  parseAgentMessages,
  parseCheckReport,
  pendingCheckRequests,
  rememberSent,
  sentLead,
  settleCheckRequests,
  withinRhythm,
  nextRhythmOpening,
  type AgentCheckOccasion,
  type AgentCheckRequest,
  type AgentConversationTurn,
  type AgentMessagesReply,
  type AgentSentRecord,
} from "@openwork/automations/proactive-brief"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { resolveAgentBrief, type AgentCheckKind, type AgentCheckReason } from "@openwork/types/den/workbot-proactive"
import type { AgentMemberCheckMessage, AgentMemberCheckSource } from "@openwork-ee/den-db/schema"
import { agentReadScopes } from "../mcp/agent-read-sources.js"
import { appLogger } from "../observability/logger.js"
import { describeAgentCheck } from "./checks.js"
import { memberBriefLines, memberRhythm, nextScheduledCheck } from "./brief.js"
import { memberAgentOn } from "./policy.js"
import { memberLimits, parseStoredPreferences } from "./preferences.js"
import { AGENT_RHYTHM_COUNTER, type AgentInstanceRow, type AgentSettle } from "./repository.js"
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
import type { MemberConnection } from "./sources.js"
import type { AgentRawTurnResult } from "./turn.js"
import type { AgentWakeDeps, AgentWakeOutcome } from "./wake.js"
import { checkSources, noticeUnreadableSources, readMemberCalendar, type CheckRecordInput } from "./wake-shared.js"

/**
 * One check of a member's agent under `workbotAgentBrief`: one rhythm, the brief, and two steps.
 *
 *   gates (as today) ─▶ due? the next slot on the rhythm, or an extra check the agent asked for
 *     ─▶ step 1, the check: the agent's own read-only session with its read allowlist; a findings report or NO_FINDINGS
 *     ─▶ step 2, the message, only for P0/P1 findings and while today's limit has room: a fresh tool-less turn with
 *        the member's recent Workbot DM; JSON messages or NO_REPLY, validated, retried once when malformed
 *     ─▶ Den's hard limits (decideBriefDelivery) ─▶ one Workbot DM per message, as today
 *
 * No calendar wakes and no responsibilities: the calendar is read once per check for the member's time zone and to
 * see whether Google still answers. Every dependency is injected (worker.ts wires the real ones).
 */

const HOUR_MS = 3_600_000
const CONVERSATION_DAYS = 2

/** What the brief's check needs on top of today's wake. */
export type AgentBriefWakeDeps = AgentWakeDeps & {
  /** `workbotAgentBrief` for this member. */
  briefOn: (organizationId: DenTypeId<"organization">, userId: DenTypeId<"user">) => Promise<boolean>
  /** The member's first name, as the prompts call them. */
  person: (organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">) => Promise<string | null>
  /** Step 1 on the agent's own session, answered as written. */
  check: (input: { actor: { userId: string; organizationId: string }; sessionId: string; instructions: string; model: string; prompt: string; messageId: string; scopes: readonly string[] }) => Promise<AgentRawTurnResult>
  /** Step 2: one turn in the messenger's fresh session (`turn` 1, or 2 for the retry), with no tools. */
  message: (input: { actor: { userId: string; organizationId: string }; sessionId: string; instructions: string; model: string; prompt: string; messageId: string }) => Promise<AgentRawTurnResult>
  messageSessionId: (organizationId: string, memberId: string, wakeAt: number) => string
  endMessageSession: (sessionId: string) => Promise<void>
  /** The member's recent Workbot DM since `since`, oldest first; null when it can't be read. */
  conversation: (input: { organizationId: DenTypeId<"organization">; userId: DenTypeId<"user">; since: number }) => Promise<AgentConversationTurn[] | null>
  /** The extra checks as stored now (request_check writes them during step 1). */
  requestedChecks: (memberId: DenTypeId<"member">) => Promise<AgentCheckRequest[]>
  /**
   * An MCP connection's tools as the member's account sees them (name, description, annotations), for deciding which
   * the check may call; null when its server didn't answer.
   */
  readTools: (input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; connection: MemberConnection }) => Promise<readonly AgentReadToolInput[] | null>
}

type Skip = "off" | "not_allowed" | "opted_out" | "snoozed" | "outside_hours" | "quiet_hours" | "no_destination" | "slack_app_not_installed" | "member_not_linked" | "no_sources" | "nothing_due"

/** The record kind for each occasion: the first check of the day keeps today's `morning`. */
const KIND_OF: Record<AgentCheckOccasion["kind"], AgentCheckKind> = { first: "morning", scheduled: "scheduled", requested: "requested" }

function iso(at: number) {
  return new Date(at).toISOString()
}

function logUsage(memberId: string, step: "check" | "message", turn: AgentRawTurnResult) {
  if (turn.kind !== "answered") return
  appLogger.info("workbot_agent_step_usage", {
    member_id: memberId,
    step,
    input_tokens: turn.usage?.inputTokens ?? -1,
    cached_input_tokens: turn.usage?.cachedInputTokens ?? -1,
    output_tokens: turn.usage?.outputTokens ?? -1,
  })
}

/** The next wake: the next slot on the rhythm or the soonest extra check, whichever comes first. */
function nextWake(scheduled: number, requests: readonly AgentCheckRequest[] | undefined) {
  const soonest = pendingCheckRequests(requests)[0]?.at
  return new Date(soonest !== undefined ? Math.min(scheduled, soonest) : scheduled)
}

/** One check for one claimed agent under `workbotAgentBrief`. Always settles it before returning. */
export async function wakeAgentBrief(row: AgentInstanceRow, deps: AgentBriefWakeDeps): Promise<AgentWakeOutcome> {
  const now = deps.now()
  const organizationId = row.organizationId
  const memberId = row.memberId
  const skip = async (reason: Skip, nextWakeAt: number, changes: Partial<AgentSettle> = {}): Promise<AgentWakeOutcome> => {
    await deps.settle(row, { ...changes, nextWakeAt: new Date(nextWakeAt) })
    return { status: "skipped", reason: reason === "quiet_hours" ? "outside_hours" : reason }
  }

  // The member's policy, brief and template: their team's own when it has one, else the organization's.
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

  // The member's sources, then one calendar read through the connection their calendar reads: their time zone, and
  // whether Google still answers. No events are diffed and nothing wakes the agent early.
  const stored = parseStoredPreferences(row.preferences)
  const [listed, connectedMembers] = await Promise.all([
    deps.connections({ organizationId, memberId }).catch(() => null),
    deps.connectedMembers ? deps.connectedMembers(organizationId).catch(() => undefined) : Promise.resolve(undefined),
  ])
  const looked = await readMemberCalendar({
    // Any connected connector, each under its own policy (`any`): no reviewed list decides what can be a source.
    sources: resolveMemberSources({ connections: listed ?? [], policy: settings.sources, choices: stored.sources, lastLook: state.lastLook, connectedMembers, mode: "any" }),
    read: (connectionId) => deps.calendar({ organizationId, orgMembershipId: memberId, connectionId, timeMin: iso(now), timeMax: iso(now + HOUR_MS) }),
    memberId,
  })
  const sources = looked.sources
  const calendarZone = looked.read?.kind === "ok" && typeof looked.read.json === "object" && looked.read.json !== null && "timeZone" in looked.read.json ? looked.read.json.timeZone : null
  const timeZone = typeof calendarZone === "string" && isValidTimeZone(calendarZone) ? calendarZone : storedZone ?? "UTC"
  if (!withinRhythm(rhythm, now, timeZone)) return closed(timeZone, { timeZone })

  // Due: the next slot on the rhythm after the last check (now, for a new agent), or an extra check the agent asked for.
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
  const notices = await noticeUnreadableSources({
    row, organizationId, userId, unreadable: blockedConnections(sources), othersReadable: ready.length > 0, told: state.notices, now, slot, kind, deps, record,
  })
  // Which tools the check may call on each connection, decided now: an admin's choice, a reviewed list, the provider's
  // annotations, then the tool's name. Only these ride in its token; a source left with none sits this check out.
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
  const actor = { userId, organizationId }
  const model = await deps.model(actor).catch(() => null)
  if (!model) return retry("model_unavailable")

  // Step 1: the check. The brief is text people in OpenWork wrote; the sources are data from other people.
  const name = (await deps.person(organizationId, memberId).catch(() => null))?.trim() || "the member"
  const nextAfter = nextScheduledCheck({ rhythm, lastCheckAt: now, now, timeZone, snoozedUntil: null })
  const check = await deps.check({
    actor,
    sessionId: deps.sessionId(organizationId, memberId),
    instructions: agentCheckInstructions({ name, brief: agentBriefForCheck({ name, organization: brief.text, member: memberBriefLines(stored, row.overrides).lines }) }),
    model,
    prompt: agentCheckPrompt({
      occasion,
      now,
      timeZone,
      nextCheckAt: nextAfter,
      extraChecksLeft: extraChecksLeft(state.requests, brief.extraChecksPerDay, now, timeZone),
      sent: state.sent,
      lastReport: state.lastReport ?? null,
      sources: readable.map((source) => ({
        id: source.id,
        name: source.name,
        via: source.kind === "other" ? [] : readableConnections(source).map((connection) => connection.name),
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
  })
  if (check.kind === "unavailable") return retry(check.code)
  logUsage(memberId, "check", check)
  const report = parseCheckReport(check.text)

  // The extra checks request_check saved during the turn, with the ones due by now done.
  const requests = settleCheckRequests(await deps.requestedChecks(memberId).catch(() => state.requests ?? []), now)
  const readIds = readable.map((source) => source.id)
  const nextState: AgentState = {
    ...state,
    lastLook: { ...state.lastLook, ...Object.fromEntries(readIds.map((id) => [id, now])) },
    lastPassAt: now,
    nextPassAt: nextAfter,
    notices,
    requests,
  }

  // Step 2 and Den's limits, only with something worth a message.
  let outcome: { reason: AgentCheckReason; sources?: AgentMemberCheckSource[]; message?: AgentMemberCheckMessage | null; messages?: number } | null = { reason: "no_findings" }
  let sent = 0
  const sentRecords: AgentSentRecord[] = []
  let delivered: "sent" | "failed" | "nothing_new" | "daily_limit" | "quiet_hours" | "quiet_window" | "snoozed" | null = null
  if (report.kind === "findings") {
    const sentToday = await deps.sentSince(memberId, new Date(zonedDayStart(now, timeZone)))
    if (sentToday >= limits.dailyCap) {
      // The limit is a hard limit: no message turn at all. The findings stay in the agent's notes for tomorrow.
      outcome = { reason: "daily_limit" }
      delivered = "daily_limit"
    } else {
      const conversation = await deps.conversation({ organizationId, userId, since: now - CONVERSATION_DAYS * 24 * HOUR_MS }).catch(() => null)
      if (conversation === null) appLogger.info("workbot_agent_conversation_unavailable", { member_id: memberId })
      const reply = await writeMessages({
        deps, actor, model, name, memberId, organizationId, wakeAt: row.nextWakeAt.getTime(),
        prompt: agentMessagePrompt({ name, sentToday, cap: limits.dailyCap, now, timeZone, nextCheckAt: nextAfter, firstCheck: occasion.kind === "first", report: report.report, conversation: conversation ?? [] }),
      })
      if (reply.kind === "unavailable") {
        appLogger.info("workbot_agent_message_unavailable", { member_id: memberId, code: reply.code })
        outcome = { reason: "agent_unavailable" }
      } else if (reply.kind === "invalid") {
        appLogger.warn("workbot_agent_message_unparsed", { member_id: memberId, reason: reply.reason })
        outcome = { reason: "unreadable_reply" }
      } else if (reply.kind === "quiet") {
        outcome = { reason: "findings_held" }
      } else {
        const resolveSource = (source: string) => findSource(sources, source)?.id ?? null
        const about = reply.messages.flatMap((message) => message.about.flatMap((entry) => parseAboutId(entry, resolveSource) ?? []))
        const decision = decideBriefDelivery({
          messages: reply.messages,
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
          const drew: AgentItem[] = []
          let first: AgentMemberCheckMessage | null = null
          let failed = false
          let lost = false
          for (const message of decision.deliver) {
            const [lead, ...folded] = message.ledger
            const id = lead ? await deps.reserve({ organizationId, memberId, item: lead.item, outcome: "pending", kind: "brief" }) : null
            if (!id) continue
            for (const entry of folded) await deps.reserve({ organizationId, memberId, item: entry.item, outcome: "folded", kind: "brief" })
            // Right before each send: still this instance's agent, and both features still on (a kill switch wins).
            const allowedNow = (await deps.holdsLease(row)) && (await deps.allowed(organizationId, userId)) && (await deps.briefOn(organizationId, userId))
            const result = allowedNow
              ? await deps.deliver({ organizationId, userId, text: cleanAgentMessage(message.text, { limit: AGENT_BRIEF_MESSAGE_LIMIT, linkDomains }) })
              : { ok: false as const, code: "lease_or_feature_lost" }
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
          // Every message named only sources it didn't read: nothing it could send, not something already told.
          const unreadable = decision.skipped.length > 0 && decision.skipped.every((entry) => entry.reason === "unknown_source")
          if (unreadable) appLogger.warn("workbot_agent_message_unknown_sources", { member_id: memberId })
          delivered = sent ? "sent" : failed ? "failed" : capped ? "daily_limit" : "nothing_new"
          outcome = sent
            ? { reason: "sent", sources: checkSources(drew, sources), message: first, messages: sent }
            : lost ? null : failed ? { reason: "send_failed" } : capped ? { reason: "daily_limit" } : unreadable ? { reason: "unreadable_reply" } : { reason: "already_told" }
        }
      }
    }
  }
  if (outcome) await record({ ...outcome, key: `ran:${now}`, kind })
  await deps.recordChecks({
    organizationId,
    day: new Date(now).toISOString().slice(0, 10),
    counts: [{ responsibility: AGENT_RHYTHM_COUNTER, checks: 1, quiet: sent ? 0 : 1, sent }],
  }).catch(() => appLogger.warn("workbot_agent_checks_unrecorded", { member_id: memberId }))
  appLogger.info("workbot_agent_ran", { member_id: memberId, path: "brief", occasion: occasion.kind, report: report.kind, delivered: delivered ?? "none", sent })
  const settled: AgentState = {
    ...nextState,
    sent: rememberSent(state.sent, sentRecords, now),
    // The report the messenger saw, for the next check; a check with nothing to report keeps the last one.
    lastReport: report.kind === "findings" ? { at: now, text: report.report.slice(0, 4_000) } : state.lastReport ?? null,
  }
  await deps.settle(row, { state: JSON.stringify(settled), timeZone, templateVersionId: template.versionId, failures: 0, nextWakeAt: nextWake(nextAfter, requests) })
  return { status: "ran", reasons: ["scheduled"], reply: report.kind === "findings" ? "message" : "quiet", delivered }
}

/**
 * Step 2 in the messenger's fresh session: one turn, and one more when the answer isn't the JSON or NO_REPLY. The
 * session is deleted afterwards. A second malformed answer is dropped (the caller logs it).
 */
async function writeMessages(input: {
  deps: AgentBriefWakeDeps
  actor: { userId: string; organizationId: string }
  model: string
  name: string
  memberId: string
  organizationId: string
  wakeAt: number
  prompt: string
}): Promise<AgentMessagesReply | { kind: "unavailable"; code: string }> {
  const { deps } = input
  const sessionId = deps.messageSessionId(input.organizationId, input.memberId, input.wakeAt)
  const turn = (prompt: string, attempt: number) => deps.message({
    actor: input.actor,
    sessionId,
    instructions: agentMessageInstructions(input.name),
    model: input.model,
    prompt,
    messageId: deps.messageId(`${input.memberId}:message:${attempt}`, input.wakeAt),
  })
  try {
    const first = await turn(input.prompt, 1)
    if (first.kind === "unavailable") return first
    logUsage(input.memberId, "message", first)
    const parsed = parseAgentMessages(first.text)
    if (parsed.kind !== "invalid") return parsed
    appLogger.info("workbot_agent_message_retry", { member_id: input.memberId, reason: parsed.reason })
    const second = await turn(agentMessageRetryPrompt(parsed.reason), 2)
    if (second.kind === "unavailable") return second
    logUsage(input.memberId, "message", second)
    return parseAgentMessages(second.text)
  } finally {
    await deps.endMessageSession(sessionId).catch(() => undefined)
  }
}

/** The messenger's token: an agent token that may read no source at all. */
export const AGENT_MESSAGE_SCOPES = agentReadScopes({ kinds: [], connectionIds: [] })
