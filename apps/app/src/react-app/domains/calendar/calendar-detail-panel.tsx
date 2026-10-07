/** @jsxImportSource react */
import { useState } from "react"
import { ExternalLink, Lock, MapPin, Pause, Pencil, Play, Video, X } from "lucide-react"
import type { AutomationList, AutomationRun, AutomationSchedule } from "@openwork/types/automations"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { AutomationScheduleFields, AutomationTimezoneField } from "@/react-app/domains/automations/automation-schedule-fields"
import { describeRunOutcome, runPlacement, type AutomationCalendarItem } from "./automation-calendar"
import { CALENDAR_PROVIDER_LABEL, type CalendarEvent } from "./calendar-event"
import { describeSchedule, formatDate, formatInstant, formatTime } from "./calendar-format"
import { AutomationStatusIcon } from "./calendar-grid"
import { addDays, compareDates } from "./calendar-time"

type AutomationListItem = AutomationList["items"][number]

const PAST_RUN_LIMIT = 5

function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 break-words">{props.children}</dd>
    </div>
  )
}

function nextRunLine(item: AutomationListItem, timeZone: string): string {
  const { automation } = item
  if (automation.state === "needs_attention") return "Not scheduled until fixed"
  if (automation.state === "inactive") return "Paused"
  return automation.nextDueAt ? formatInstant(automation.nextDueAt, timeZone) : "No future run"
}

function runsOnLine(item: AutomationListItem): string {
  return (item.revision.executionTarget ?? "desktop") === "cloud"
    ? "OpenWork Cloud. Your computer can be closed."
    : "Your desktop. Keep OpenWork open and connected at the scheduled time."
}

export type AutomationPanelActions = {
  busyAction: string | null
  onPause: () => void
  onResume: () => void
  onRunNow: () => void
  onSaveSchedule: (schedule: AutomationSchedule) => Promise<boolean>
  onOpenRun: (run: AutomationRun) => void
}

/** Right-hand panel for one Automation: when it runs, where, its recent runs, and Pause / Edit schedule / Run now. */
export function AutomationDetailPanel(props: {
  item: AutomationListItem
  selectedBlock: AutomationCalendarItem | null
  runs: readonly AutomationRun[] | undefined
  runsLoading: boolean
  timeZone: string
  actions: AutomationPanelActions
  onClose: () => void
}) {
  const { automation, revision } = props.item
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<AutomationSchedule>(revision.schedule)
  const blocked = automation.state === "needs_attention"
  const busy = props.actions.busyAction !== null
  const pastRuns = (props.runs ?? []).slice(0, PAST_RUN_LIMIT)

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-background" aria-label={automation.name} data-calendar-detail={automation.id}>
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.2px]">{automation.name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground" data-calendar-next-run>{nextRunLine(props.item, props.timeZone)}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close details" onClick={props.onClose}><X /></Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {blocked && automation.needsAttentionReason ? (
          <Alert className="my-2" data-calendar-blocked>
            <Lock aria-hidden="true" />
            <AlertTitle>Needs attention</AlertTitle>
            <AlertDescription>{automation.needsAttentionReason.message}</AlertDescription>
          </Alert>
        ) : null}

        {props.selectedBlock?.run ? (
          <div className="my-2 flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-xs" data-calendar-selected-run={props.selectedBlock.run.id}>
            <AutomationStatusIcon item={props.selectedBlock} />
            <span className="min-w-0 flex-1 truncate">{formatInstant(runPlacement(props.selectedBlock.run), props.timeZone)} · {describeRunOutcome(props.selectedBlock.run)}</span>
            <Button variant="link" size="xs" onClick={() => props.selectedBlock?.run && props.actions.onOpenRun(props.selectedBlock.run)}>Open</Button>
          </div>
        ) : props.selectedBlock?.status === "blocked" ? (
          <p className="my-2 text-xs text-muted-foreground">The {formatTime(props.selectedBlock.at, props.timeZone)} slot will not run until this is fixed.</p>
        ) : null}

        <dl className="divide-y divide-border">
          <Row label="Repeats">{describeSchedule(revision.schedule, props.timeZone)}</Row>
          <Row label="Runs on">{runsOnLine(props.item)}</Row>
        </dl>

        <div className="mt-3">
          <h3 className="text-xs font-medium text-muted-foreground">Past runs</h3>
          {props.runsLoading ? (
            <div className="mt-2 space-y-2"><Skeleton className="h-8 rounded-md" /><Skeleton className="h-8 rounded-md" /></div>
          ) : pastRuns.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="mt-1 divide-y divide-border" data-calendar-past-runs>
              {pastRuns.map((run) => (
                <li key={run.id} className="flex items-center gap-2 py-2 text-sm">
                  <AutomationStatusIcon item={{ status: run.status === "succeeded" ? "succeeded" : run.status === "failed" ? "failed" : run.status === "skipped" || run.status === "cancelled" ? "skipped" : "running", executionTarget: run.executionTarget }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{formatInstant(runPlacement(run), props.timeZone)}</span>
                    <span className="block truncate text-xs text-muted-foreground">{describeRunOutcome(run)}</span>
                  </span>
                  <Button variant="ghost" size="xs" onClick={() => props.actions.onOpenRun(run)}>Open</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
        {automation.state === "active" ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={props.actions.onPause}><Pause />Pause</Button>
        ) : automation.state === "inactive" ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={props.actions.onResume}><Play />Resume</Button>
        ) : null}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { setDraft(revision.schedule); setEditing(true) }}><Pencil />Edit schedule</Button>
        <Button size="sm" disabled={busy || blocked || automation.state === "archived"} onClick={props.actions.onRunNow}><Play />Run now</Button>
      </div>

      <Dialog open={editing} onOpenChange={(open) => { if (!open) setEditing(false) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit schedule</DialogTitle></DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void props.actions.onSaveSchedule(draft).then((saved) => { if (saved) setEditing(false) })
            }}
          >
            <AutomationScheduleFields idPrefix="calendar-schedule" schedule={draft} onChange={setDraft} />
            <AutomationTimezoneField idPrefix="calendar-schedule" timezone={draft.timezone} onChange={(timezone) => setDraft((current) => ({ ...current, timezone }))} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
              <Button type="submit" disabled={busy}>{props.actions.busyAction === "schedule" ? "Saving…" : "Save schedule"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  )
}

/** A meeting from a connected calendar: read-only, with a link back to its source. */
export function MeetingDetailPanel(props: { event: CalendarEvent; timeZone: string; onOpenLink: (url: string) => void; onClose: () => void }) {
  const { event } = props
  const source = CALENDAR_PROVIDER_LABEL[event.provider]
  const when = event.timing.kind === "timed"
    ? `${formatInstant(event.timing.start, props.timeZone)} – ${formatTime(event.timing.end, props.timeZone)}`
    : compareDates(event.timing.endDate, addDays(event.timing.startDate, 1)) <= 0
      ? `${formatDate(event.timing.startDate)} · All day`
      : `${formatDate(event.timing.startDate)} – ${formatDate(addDays(event.timing.endDate, -1))} · All day`
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-background" aria-label={event.title} data-calendar-meeting-detail={event.key}>
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.2px]">{event.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{when}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close details" onClick={props.onClose}><X /></Button>
      </div>
      <dl className="divide-y divide-border px-4 py-2">
        <Row label="From">{source}</Row>
        {event.location ? <Row label="Where"><span className="inline-flex items-center gap-1"><MapPin className="size-3.5" aria-hidden="true" />{event.location}</span></Row> : null}
        {event.attendeeCount > 0 ? <Row label="Guests">{event.attendeeCount}</Row> : null}
      </dl>
      <div className="mt-auto flex flex-wrap gap-2 border-t border-border px-4 py-3">
        {event.meetingUrl ? <Button variant="outline" size="sm" onClick={() => props.onOpenLink(event.meetingUrl!)}><Video />Join</Button> : null}
        {event.sourceUrl ? <Button variant="outline" size="sm" onClick={() => props.onOpenLink(event.sourceUrl!)}><ExternalLink />Open in {source}</Button> : null}
      </div>
    </aside>
  )
}
