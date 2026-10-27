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
import type { AgentDestinationBlock, WorkbotProactiveSettings } from "@openwork/types/den/workbot-proactive"
import { appLogger } from "../observability/logger.js"
import type { MemberCalendarRead } from "../routes/org/google-workspace.js"
import type { DeliveryResult } from "./deliver.js"
import { activeResponsibilities, enabledOf, memberAgentOn, mutedOf, proactivePolicy } from "./policy.js"
import type { AgentCheckCount, AgentInstanceRow, AgentSettle, DeliveryOutcome } from "./repository.js"
import type { AgentTemplateVersion } from "./template.js"
import type { AgentTurnResult } from "./turn.js"

/**
 * One wake of one member's agent: gates, the calendar event source, one turn in the agent's own session when the
 * schedule or an event calls for it, then the delivery step in code. Every dependency is injected (worker.ts wires
 * the real ones), so the whole decision is testable without a database, runner, Google or Connect.
 */

const HOUR_MS = 3_600_000

export type AgentWakeDeps = {
  now: () => number
  allowed: (organizationId: DenTypeId<"organization">, userId: DenTypeId<"user">) => Promise<boolean>
  settings: (organizationId: DenTypeId<"organization">) => Promise<WorkbotProactiveSettings>
  template: (organizationId: DenTypeId<"organization">) => Promise<AgentTemplateVersion>
  user: (organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">) => Promise<DenTypeId<"user"> | null>
  calendar: (input: { organizationId: DenTypeId<"organization">; orgMembershipId: DenTypeId<"member">; timeMin: string; timeMax: string }) => Promise<MemberCalendarRead>
  model: (actor: { userId: DenTypeId<"user">; organizationId: DenTypeId<"organization"> }) => Promise<string | null>
  turn: (input: { actor: { userId: string; organizationId: string }; sessionId: string; instructions: string; model: string; prompt: string; messageId: string }) => Promise<AgentTurnResult>
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
}

type SkipReason = "off" | "not_allowed" | "opted_out" | "snoozed" | "outside_hours" | "no_destination" | AgentDestinationBlock | "no_responsibilities" | "no_google" | "nothing_due"
type Delivered = "sent" | "failed" | "nothing_new" | "daily_limit" | "quiet_hours" | "snoozed" | null

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
  if (row.snoozedUntil && row.snoozedUntil.getTime() > now) return skip("snoozed", row.snoozedUntil.getTime())

  const policy = proactivePolicy(settings)
  const storedZone = isValidTimeZone(row.timeZone) ? row.timeZone : null
  if (storedZone && !withinWorkingHours(policy, now, storedZone)) return skip("outside_hours", nextWorkingStart(policy, now, storedZone))
  if (settings.destination !== "workbot_dm") return skip("no_destination", now + HOUR_MS)
  // A message that could not arrive is not worth a turn: no Slack app, or the member's Slack not linked. The
  // member's settings say which, and the agent picks up once it is fixed.
  const blocked = await deps.destinationBlock({ organizationId, userId })
  if (blocked) {
    appLogger.info("workbot_agent_destination_blocked", { member_id: memberId, reason: blocked })
    return skip(blocked, now + HOUR_MS)
  }
  const template = await deps.template(organizationId)
  const responsibilities = activeResponsibilities(template, row)
  if (!responsibilities.length) return skip("no_responsibilities", now + 6 * HOUR_MS, { templateVersionId: template.versionId })

  // The event source: one read-only calendar GET as the member. It also tells us their time zone.
  const state = parseAgentState(row.state)
  const read = await deps.calendar({ organizationId, orgMembershipId: memberId, timeMin: iso(now - 15 * 60_000), timeMax: iso(now + AGENT_TIMING.horizonMs + 2 * HOUR_MS) })
  if (read.kind === "needs_connection" || read.kind === "policy_blocked" || read.kind === "missing_scope") {
    appLogger.info("workbot_agent_google_unavailable", { member_id: memberId, reason: read.kind })
    return skip("no_google", now + Math.min(6, row.failures + 1) * HOUR_MS, { failures: row.failures + 1 })
  }
  const projected = read.kind === "ok" ? projectGoogleCalendarEvents(read.json) : null
  const timeZone = isValidTimeZone(projected?.timeZone) ? projected.timeZone : storedZone ?? "UTC"
  const calendarResponsibilities = responsibilities.includes("meeting_prep") || responsibilities.includes("calendar_changes")
  const detected = projected
    ? detectCalendarWakes({ events: projected.events, previous: state.calendar, now, timeZone, leadMinutes: settings.leadMinutes })
    : null
  const wakes = (detected?.wakes ?? []).filter((wake) => responsibilities.includes(wakeResponsibility(wake)) && !state.woke.includes(wake.ref))
  const nextPoll = projected
    ? nextCalendarPoll({ now, events: projected.events, leadMinutes: settings.leadMinutes, policy, timeZone })
    : now + AGENT_TIMING.calendarPollMs
  const nextWake = (nextPassAt: number | null) => new Date(calendarResponsibilities ? Math.min(nextPoll, nextPassAt ?? nextPoll) : (nextPassAt ?? nextPoll))
  const observed: AgentState = { ...state, calendar: detected?.checkpoint ?? state.calendar }

  // Someone new: the first look learns their zone; outside their hours it only records the calendar.
  if (!withinWorkingHours(policy, now, timeZone)) {
    return skip("outside_hours", nextWorkingStart(policy, now, timeZone), { state: JSON.stringify(observed), timeZone })
  }

  const passDue = state.nextPassAt === null || state.nextPassAt <= now
  const reasons: AgentWakeReason[] = [
    ...(passDue ? [{ kind: "scheduled" as const, morning: isMorningPass(policy, state.lastPassAt, now, timeZone) }] : []),
    ...wakes.map((wake) => ({ kind: "calendar" as const, wake })),
  ]
  if (!reasons.length) return skip("nothing_due", nextWake(state.nextPassAt).getTime(), { state: JSON.stringify(observed), timeZone, failures: 0 })

  // A pass that can't run keeps the calendar where it was, so its events wake the next try too.
  const retry = async (reply: "unavailable", code: string): Promise<AgentWakeOutcome> => {
    appLogger.info("workbot_agent_turn_unavailable", { member_id: memberId, code })
    await deps.settle(row, { timeZone, failures: row.failures + 1, nextWakeAt: new Date(now + AGENT_TIMING.retryMs) })
    return { status: "ran", reasons: reasons.map((reason) => reason.kind), reply, delivered: null }
  }
  const actor = { userId, organizationId }
  const model = await deps.model(actor).catch(() => null)
  if (!model) return retry("unavailable", "model_unavailable")
  const result = await deps.turn({
    actor,
    sessionId: deps.sessionId(organizationId, memberId),
    instructions: AGENT_INSTRUCTIONS,
    model,
    prompt: agentWakePrompt({ reasons, lastLook: state.lastLook, responsibilities, instructions: template.instructions, now, timeZone }),
    messageId: deps.messageId(memberId, row.nextWakeAt.getTime()),
  })
  if (result.kind === "unavailable") return retry("unavailable", result.code)

  const nextState: AgentState = {
    v: 1,
    calendar: observed.calendar,
    lastLook: passDue ? { gmail: now, google_calendar: now } : { ...state.lastLook, google_calendar: now },
    lastPassAt: passDue ? now : state.lastPassAt,
    nextPassAt: passDue ? nextScheduledPass(policy, now, timeZone) : state.nextPassAt,
    woke: rememberWakes(state.woke, wakes.map((wake) => wake.ref)),
  }
  let delivered: Delivered = null
  const deliveredFor = new Set<string>()
  if (result.kind === "invalid") appLogger.info("workbot_agent_reply_unparsed", { member_id: memberId })
  if (result.kind === "message") {
    const decision = decideAgentDelivery({
      items: result.items,
      enabled: enabledOf(template),
      muted: mutedOf(row),
      told: await deps.told(memberId, result.items),
      sentToday: await deps.sentSince(memberId, new Date(zonedDayStart(now, timeZone))),
      policy,
      at: deps.now(),
      timeZone,
      snoozedUntil: row.snoozedUntil?.getTime() ?? null,
    })
    if (decision.kind === "drop") {
      delivered = decision.reason
      if (decision.reason === "daily_limit") for (const item of decision.items) await deps.reserve({ organizationId, memberId, item, outcome: "capped" })
    } else {
      const [first, ...rest] = decision.items
      const id = first ? await deps.reserve({ organizationId, memberId, item: first }) : null
      if (id) {
        // Items carried by the same message are recorded with it, so none is ever repeated on its own.
        for (const item of rest) await deps.reserve({ organizationId, memberId, item, outcome: "folded" })
        // Right before sending: still this instance's agent, and the feature still on (a kill switch wins).
        const sent = (await deps.holdsLease(row)) && (await deps.allowed(organizationId, userId))
          ? await deps.deliver({ organizationId, userId, text: cleanAgentMessage(result.message) })
          : { ok: false as const, code: "lease_or_feature_lost" }
        await deps.finish(id, sent.ok ? "sent" : "failed")
        delivered = sent.ok ? "sent" : "failed"
        if (sent.ok) for (const item of decision.items) deliveredFor.add(item.responsibility)
        if (!sent.ok) appLogger.warn("workbot_agent_delivery_failed", { member_id: memberId, code: sent.code })
      }
    }
  }
  // The admin's health view: every responsibility the pass asked about, and whether it produced a message.
  const morning = reasons.some((reason) => reason.kind === "scheduled" && reason.morning)
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
