import {
  CALENDAR_TRIGGER_GRACE_MS,
  CALENDAR_TRIGGER_POLL_MS,
  CALENDAR_TRIGGER_READ_MARGIN_MS,
  calendarMeetingContext,
  calendarTriggerOccurrences,
  type AutomationListItem,
} from "@openwork/automations"
import { projectGoogleCalendarEvents, type CalendarEventFacts } from "@openwork/automations/proactive"
import type { AutomationRunTriggerContext } from "@openwork/types/automations"
import type { MemberCalendarRead } from "../routes/org/google-workspace.js"
import { appLogger } from "../observability/logger.js"

const logger = appLogger.child({ component: "automation_calendar_triggers" })

/** Calendar-triggered Automations looked at per cycle. */
const LIST_LIMIT = 200
/** Occurrences this process remembers claiming, so it does not ask the database again every cycle. */
const CLAIMED_MEMORY = 5_000

export type CalendarTriggerOwner = { organizationId: string; ownerMemberId: string }

export type CalendarTriggerSourceDeps = {
  list: (limit: number) => Promise<AutomationListItem[]>
  read: (input: CalendarTriggerOwner & { timeMin: string; timeMax: string }) => Promise<MemberCalendarRead>
  /** Claims one occurrence (idempotent by its nonce) and starts its run; the run id when work started. */
  claim: (item: AutomationListItem, occurrence: { scheduledFor: number; nonce: string; triggerContext: AutomationRunTriggerContext }) => Promise<string | null>
  /** The owner's Google Calendar cannot be read until they act. */
  needsConnection: (item: AutomationListItem, message: string) => Promise<void>
}

const CONNECT_MESSAGE = "Connect Google Calendar with calendar access in OpenWork so this Automation can run around your meetings."

/**
 * Reads each owner's primary Google Calendar at most every few minutes, and
 * only for owners with an active calendar-triggered Automation, then claims
 * every due meeting occurrence once. All I/O lives here; which meetings and
 * when is the pure calendarTriggerOccurrences. Each replica keeps its own
 * read cache; claims are idempotent, so replicas never run a meeting twice.
 */
export class CalendarTriggerSource {
  private readonly reads = new Map<string, { readAt: number; events: CalendarEventFacts[] }>()
  private readonly claimed = new Set<string>()

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
    const events = await this.events(key, owner, items, now)
    if (!events) return []
    const started: string[] = []
    for (const item of items) {
      const trigger = item.revision.schedule
      if (trigger.kind !== "calendar") continue
      // Never a meeting from before the trigger was saved, and never a moment long past.
      const from = Math.max(now - CALENDAR_TRIGGER_GRACE_MS, item.revision.createdAt)
      for (const occurrence of calendarTriggerOccurrences({ trigger, events, from, to: now + 1 })) {
        const memory = `${item.automation.id}\n${occurrence.key}`
        if (this.claimed.has(memory)) continue
        const runId = await this.deps.claim(item, {
          scheduledFor: occurrence.at,
          nonce: occurrence.key,
          triggerContext: calendarMeetingContext(occurrence.event),
        })
        if (runId) started.push(runId)
        this.remember(memory)
      }
    }
    return started
  }

  private remember(memory: string) {
    this.claimed.add(memory)
    if (this.claimed.size <= CLAIMED_MEMORY) return
    const oldest = this.claimed.values().next()
    if (!oldest.done) this.claimed.delete(oldest.value)
  }

  /** The owner's meetings around now, from the last read when it is fresh enough. Null when unreadable. */
  private async events(key: string, owner: CalendarTriggerOwner, items: AutomationListItem[], now: number): Promise<CalendarEventFacts[] | null> {
    const cached = this.reads.get(key)
    if (cached && now - cached.readAt < CALENDAR_TRIGGER_POLL_MS) return cached.events
    const read = await this.deps.read({
      ...owner,
      timeMin: new Date(now - CALENDAR_TRIGGER_READ_MARGIN_MS).toISOString(),
      timeMax: new Date(now + CALENDAR_TRIGGER_READ_MARGIN_MS).toISOString(),
    })
    if (read.kind === "ok") {
      const events = projectGoogleCalendarEvents(read.json).events
      this.reads.set(key, { readAt: now, events })
      return events
    }
    // Back off until the next poll either way; keep what the last good read saw.
    this.reads.set(key, { readAt: now, events: cached?.events ?? [] })
    if (read.kind === "google_api_error") {
      logger.warn("google calendar read failed; trying again on the next poll", { automation_ids: items.map((item) => item.automation.id) })
      return cached?.events ?? null
    }
    for (const item of items) await this.deps.needsConnection(item, CONNECT_MESSAGE)
    this.reads.delete(key)
    return null
  }
}
