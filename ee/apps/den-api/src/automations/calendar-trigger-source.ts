import {
  CALENDAR_TRIGGER_GRACE_MS,
  CALENDAR_TRIGGER_POLL_MS,
  CALENDAR_TRIGGER_READ_MARGIN_MS,
  calendarMeetingContext,
  calendarTriggerOccurrences,
  type AutomationListItem,
  type CalendarTriggerOccurrence,
} from "@openwork/automations"
import { projectGoogleCalendarEvents, type CalendarEventFacts } from "@openwork/automations/proactive"
import type { AutomationError, AutomationRunTriggerContext } from "@openwork/types/automations"
import type { MemberCalendarRead } from "../routes/org/google-workspace.js"
import { appLogger } from "../observability/logger.js"

const logger = appLogger.child({ component: "automation_calendar_triggers" })

/** Calendar-triggered Automations looked at per cycle. */
const LIST_LIMIT = 200
/** Occurrence decisions this process remembers handling, so it neither asks the database nor logs again every cycle. */
const HANDLED_MEMORY = 5_000

export type CalendarTriggerOwner = { organizationId: string; ownerMemberId: string }

type CalendarTriggerOccurrenceInput = { scheduledFor: number; nonce: string; triggerContext: AutomationRunTriggerContext }

export type CalendarTriggerSourceDeps = {
  list: (limit: number) => Promise<AutomationListItem[]>
  /** `automationCalendarTriggers` for the owner; off means Den does not read their calendar at all. */
  enabled: (owner: CalendarTriggerOwner) => Promise<boolean>
  read: (input: CalendarTriggerOwner & { timeMin: string; timeMax: string }) => Promise<MemberCalendarRead>
  /** Claims one occurrence (idempotent by its nonce) and starts its run; the run id when work started. */
  claim: (item: AutomationListItem, occurrence: CalendarTriggerOccurrenceInput) => Promise<string | null>
  /**
   * Records an occurrence that should have run and can't any more as a skipped
   * run (idempotent by its nonce, so never next to a run for the same
   * meeting); true when this call wrote it.
   */
  skip: (item: AutomationListItem, occurrence: CalendarTriggerOccurrenceInput & { code: AutomationError["code"]; message: string }) => Promise<boolean>
  /** The owner's Google Calendar cannot be read until they act. */
  needsConnection: (item: AutomationListItem, message: string) => Promise<void>
}

const CONNECT_MESSAGE = "Connect Google Calendar with calendar access in OpenWork so this Automation can run around your meetings."
const UNREADABLE_MESSAGE = "Google Calendar couldn't be read when this meeting was due, so it didn't run. Use Run now if you still need it."

/** One owner's calendar as this process last read it. */
type OwnerRead = {
  readAt: number
  events: CalendarEventFacts[]
  /** When reads started failing; null while they work. */
  unreadableSince: number | null
  /** Set on the read that ended an outage: from then, meetings now too old to run were missed. */
  missedSince: number | null
}

/**
 * Reads each owner's primary Google Calendar at most every few minutes, and
 * only for owners with an active calendar-triggered Automation, then decides
 * every due meeting occurrence once. All I/O lives here; which meetings and
 * when is the pure calendarTriggerOccurrences. Each replica keeps its own
 * read cache; claims and receipts are idempotent, so replicas never run or
 * record a meeting twice.
 *
 * Every decision is logged once per occurrence (`calendar trigger decision`).
 * Meetings the rule doesn't want record nothing else. A meeting that should
 * have run but came due while the calendar couldn't be read, and is too old to
 * run once it can, gets a skipped run on its Automation.
 */
export class CalendarTriggerSource {
  private readonly reads = new Map<string, OwnerRead>()
  private readonly handled = new Set<string>()

  constructor(private readonly deps: CalendarTriggerSourceDeps) {}

  async tick(now: number): Promise<string[]> {
    const owners = new Map<string, AutomationListItem[]>()
    for (const item of await this.deps.list(LIST_LIMIT)) {
      if (item.revision.schedule.kind !== "calendar") continue
      const key = `${item.automation.organizationId}\n${item.automation.ownerMemberId}`
      owners.set(key, [...owners.get(key) ?? [], item])
    }
    for (const key of [...this.reads.keys()]) if (!owners.has(key)) this.reads.delete(key)
    const started: string[] = []
    for (const [key, items] of owners) {
      try {
        started.push(...await this.tickOwner(key, items, now))
      } catch (error) {
        logger.warn("calendar trigger cycle failed for one owner", { error, automation_ids: items.map((item) => item.automation.id) })
      }
    }
    return started
  }

  private async tickOwner(key: string, items: AutomationListItem[], now: number): Promise<string[]> {
    const first = items[0]
    if (!first) return []
    const owner = { organizationId: first.automation.organizationId, ownerMemberId: first.automation.ownerMemberId }
    if (!await this.deps.enabled(owner)) {
      this.reads.delete(key)
      return []
    }
    const read = await this.events(key, owner, items, now)
    if (!read) return []
    const started: string[] = []
    for (const item of items) {
      const trigger = item.revision.schedule
      if (trigger.kind !== "calendar") continue
      // Never a meeting from before the trigger was saved, and never a moment long past.
      const from = Math.max(now - CALENDAR_TRIGGER_GRACE_MS, item.revision.createdAt)
      // After an outage, also look at what came due while the calendar couldn't be read.
      const missedFrom = read.missedSince === null ? from : Math.max(read.missedSince - CALENDAR_TRIGGER_GRACE_MS, item.revision.createdAt)
      for (const occurrence of calendarTriggerOccurrences({ trigger, events: read.events, from: Math.min(from, missedFrom), to: now + 1 })) {
        const memory = `${item.automation.id}\n${occurrence.key}\n${occurrence.decision.kind === "run" ? "run" : occurrence.decision.reason}`
        if (this.handled.has(memory)) continue
        const runId = await this.handle(item, occurrence, occurrence.at < from)
        if (runId) started.push(runId)
        this.remember(memory)
      }
    }
    return started
  }

  /** Acts on one occurrence's decision and logs it. The run id when work started. */
  private async handle(item: AutomationListItem, occurrence: CalendarTriggerOccurrence, missed: boolean): Promise<string | null> {
    const { decision, event } = occurrence
    let runId: string | null = null
    let recorded = false
    if (decision.kind === "run" && !missed) {
      runId = await this.deps.claim(item, { scheduledFor: occurrence.at, nonce: occurrence.key, triggerContext: calendarMeetingContext(event) })
    } else if (decision.kind === "run") {
      recorded = await this.deps.skip(item, {
        scheduledFor: occurrence.at,
        nonce: occurrence.key,
        // The receipt keeps the meeting's times, never its title.
        triggerContext: { ...calendarMeetingContext(event), title: null },
        code: "connect_access_unavailable",
        message: UNREADABLE_MESSAGE,
      })
    }
    logger.debug("calendar trigger decision", {
      automation_id: item.automation.id,
      revision_id: item.revision.id,
      occurrence_key: occurrence.key,
      due_at: new Date(occurrence.at).toISOString(),
      meeting_start: event.start === null ? null : new Date(event.start).toISOString(),
      meeting_end: event.end === null ? null : new Date(event.end).toISOString(),
      owner_response: event.response,
      decision: decision.kind,
      reason: decision.kind === "skip" ? decision.reason : null,
      // A meeting that should have run but came due while the calendar couldn't be read.
      missed: decision.kind === "run" && missed,
      run_id: runId,
      skipped_run_recorded: recorded,
    })
    return runId
  }

  private remember(memory: string) {
    this.handled.add(memory)
    if (this.handled.size <= HANDLED_MEMORY) return
    const oldest = this.handled.values().next()
    if (!oldest.done) this.handled.delete(oldest.value)
  }

  /** The owner's meetings around now, from the last read when it is fresh enough. Null when they must reconnect. */
  private async events(key: string, owner: CalendarTriggerOwner, items: AutomationListItem[], now: number): Promise<OwnerRead | null> {
    const cached = this.reads.get(key)
    if (cached && now - cached.readAt < CALENDAR_TRIGGER_POLL_MS) return cached
    const read = await this.deps.read({
      ...owner,
      timeMin: new Date(now - CALENDAR_TRIGGER_READ_MARGIN_MS).toISOString(),
      timeMax: new Date(now + CALENDAR_TRIGGER_READ_MARGIN_MS).toISOString(),
    })
    if (read.kind === "ok") {
      const fresh = { readAt: now, events: projectGoogleCalendarEvents(read.json).events, unreadableSince: null, missedSince: cached?.unreadableSince ?? null }
      this.reads.set(key, fresh)
      return fresh
    }
    if (read.kind === "google_api_error") {
      // Back off until the next poll; keep what the last good read saw and when reads started failing.
      const stale = { readAt: now, events: cached?.events ?? [], unreadableSince: cached?.unreadableSince ?? now, missedSince: null }
      this.reads.set(key, stale)
      logger.warn("google calendar read failed; trying again on the next poll", { automation_ids: items.map((item) => item.automation.id) })
      return stale
    }
    for (const item of items) await this.deps.needsConnection(item, CONNECT_MESSAGE)
    this.reads.delete(key)
    return null
  }
}
