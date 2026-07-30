import type * as React from "react"
import {
  BellRing,
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  GraduationCap,
  LayoutDashboard,
  Mail,
  MapPin,
  MessageSquareText,
  PanelsTopLeft,
  ShieldAlert,
  Target,
  TrendingUp,
  XCircle,
} from "lucide-react"
import type {
  UiArtifactAction,
  UiArtifactPayload,
  UiArtifactRenderResult,
  UiArtifactWidget,
} from "@openwork/types/ui-artifact"

import { openDesktopUrl } from "@/app/lib/desktop"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const INLINE_ROW_LIMIT = 5

function safeDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatTime(value: string, timezone?: string) {
  const date = safeDate(value)
  if (!date) return value

  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(date)
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date)
  }
}

function formatShortDateTime(value: string) {
  const date = safeDate(value)
  if (!date) return value
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)
}

function initials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase())
    .join("")
}

function isSafeWebUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password
  } catch {
    return false
  }
}

function SourceBadge({ artifact }: { artifact: UiArtifactPayload }) {
  const source = artifact.source
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {source.type === "mock" ? (
        <Badge variant="outline" className="border-amber-6/50 bg-amber-3/40 text-amber-11">
          Demo data
        </Badge>
      ) : (
        <Badge variant="outline" className="border-amber-6/50 bg-amber-3/40 text-amber-11">
          Unverified source
        </Badge>
      )}
      <span className="truncate text-[11px] text-muted-foreground">
        {source.provider ?? source.label}
        {source.account ? ` · ${source.account}` : ""}
      </span>
    </div>
  )
}

function ArtifactActionButton({ action }: { action: UiArtifactAction }) {
  if (action.type !== "open_url" || !isSafeWebUrl(action.url)) return null

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      onClick={() => void openDesktopUrl(action.url)}
      aria-label={action.description ?? action.label}
    >
      {action.label}
      <ExternalLink className="size-3" />
    </Button>
  )
}

function artifactIcon(artifactId: UiArtifactPayload["artifactId"]) {
  switch (artifactId) {
    case "calendar.view":
      return CalendarDays
    case "widgets.collection":
      return TrendingUp
    case "workspace.brief":
      return LayoutDashboard
    case "communication.thread":
      return MessageSquareText
    case "mail.inbox":
      return Mail
    case "work.attention":
      return BellRing
    case "work.approvals":
      return PanelsTopLeft
  }
}

function artifactIconClass(artifactId: UiArtifactPayload["artifactId"]) {
  switch (artifactId) {
    case "calendar.view":
      return "bg-blue-3 text-blue-11"
    case "widgets.collection":
      return "bg-purple-3 text-purple-11"
    case "workspace.brief":
      return "bg-indigo-3 text-indigo-11"
    case "communication.thread":
      return "bg-violet-3 text-violet-11"
    case "mail.inbox":
      return "bg-orange-3 text-orange-11"
    case "work.attention":
      return "bg-red-3 text-red-11"
    case "work.approvals":
      return "bg-green-3 text-green-11"
  }
}

function ArtifactFrame(props: {
  artifact: UiArtifactPayload
  children: React.ReactNode
  action?: Extract<UiArtifactAction, { type: "open_url" }>
}) {
  const Icon = artifactIcon(props.artifact.artifactId)
  const observedAt = props.artifact.source.observedAt

  return (
    <article
      data-ui-artifact=""
      data-ui-artifact-id={props.artifact.artifactId}
      data-ui-artifact-instance={props.artifact.instanceId}
      aria-label={props.artifact.title}
      className="not-prose w-full overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-xs"
    >
      <header className="flex items-start gap-3 border-b border-border/70 px-4 py-3">
        <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", artifactIconClass(props.artifact.artifactId))}>
          <Icon className="size-4.5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{props.artifact.title}</h3>
          {props.artifact.subtitle ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{props.artifact.subtitle}</p>
          ) : null}
        </div>
        <Badge variant="secondary" className="capitalize">
          {props.artifact.presentation.size}
        </Badge>
      </header>

      <div className="px-4 py-3">{props.children}</div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 bg-muted/20 px-4 py-2.5">
        <SourceBadge artifact={props.artifact} />
        <div className="flex items-center gap-2">
          {observedAt ? (
            <time dateTime={observedAt} className="text-[11px] text-muted-foreground">
              Updated {formatTime(observedAt)}
            </time>
          ) : null}
          {props.action ? <ArtifactActionButton action={props.action} /> : null}
        </div>
      </footer>
    </article>
  )
}

function RemainingRows({ count }: { count: number }) {
  if (count <= 0) return null
  return <p className="pt-2 text-xs font-medium text-muted-foreground">+ {count} more</p>
}

type CalendarArtifactPayload = Extract<UiArtifactPayload, { artifactId: "calendar.view" }>
type CalendarEvent = CalendarArtifactPayload["data"]["events"][number]

function formatDateLabel(value: string, timezone: string, weekday: "short" | "long" = "short") {
  const date = safeDate(value)
  if (!date) return value

  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday,
      month: "short",
      day: "numeric",
      timeZone: timezone,
    }).format(date)
  } catch {
    return value.slice(0, 10)
  }
}

function CalendarEventDetails(props: {
  event: CalendarEvent
  timezone: string
  compact?: boolean
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn(
            "truncate font-medium",
            props.compact ? "text-xs" : "text-sm",
            props.event.status === "cancelled" && "line-through text-muted-foreground",
          )}>
            {props.event.title}
          </span>
          {props.event.status === "tentative" ? <Badge variant="outline">Tentative</Badge> : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span>
            {props.event.allDay
              ? "All day"
              : `${formatTime(props.event.start, props.timezone)}–${formatTime(props.event.end, props.timezone)}`}
          </span>
          {props.event.location ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <MapPin className="size-3" aria-hidden="true" />
              <span className="truncate">{props.event.location}</span>
            </span>
          ) : null}
        </div>
      </div>
      {props.event.action ? <ArtifactActionButton action={props.event.action} /> : null}
    </div>
  )
}

function CalendarArtifact({ artifact }: { artifact: CalendarArtifactPayload }) {
  const visibleEventLimit = artifact.data.variant === "day" ? INLINE_ROW_LIMIT : 8
  const events = artifact.data.events.slice(0, visibleEventLimit)
  const groupedDates = [...new Set(events.map((event) => event.start.slice(0, 10)))]

  return (
    <ArtifactFrame artifact={artifact} action={artifact.data.action}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Badge variant="outline" className="capitalize">{artifact.data.variant} view</Badge>
        <span className="text-[11px] text-muted-foreground">
          {artifact.data.startDate === artifact.data.endDate
            ? artifact.data.startDate
            : `${artifact.data.startDate}–${artifact.data.endDate}`}
        </span>
      </div>

      {events.length === 0 ? (
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-green-10" />
          No events scheduled.
        </div>
      ) : artifact.data.variant === "day" ? (
        <ol className="relative space-y-0" aria-label={`Events in ${artifact.data.timezone}`}>
          {events.map((event, index) => (
            <li key={event.id} className="relative grid grid-cols-[4.75rem_1rem_minmax(0,1fr)] gap-2 pb-3 last:pb-0">
              <time dateTime={event.start} className="pt-0.5 text-xs font-medium tabular-nums text-foreground">
                {event.allDay ? "All day" : formatTime(event.start, artifact.data.timezone)}
              </time>
              <div className="relative flex justify-center">
                {index < events.length - 1 ? <span className="absolute top-3 bottom-[-12px] w-px bg-border" /> : null}
                <span className={cn(
                  "relative mt-1.5 size-2 rounded-full ring-2 ring-background",
                  event.status === "tentative" ? "bg-amber-9" : event.status === "cancelled" ? "bg-red-9" : "bg-blue-9",
                )} />
              </div>
              <CalendarEventDetails event={event} timezone={artifact.data.timezone} />
            </li>
          ))}
        </ol>
      ) : artifact.data.variant === "agenda" ? (
        <div className="space-y-3" aria-label={`Agenda in ${artifact.data.timezone}`}>
          {groupedDates.map((date) => (
            <section key={date}>
              <h4 className="mb-1.5 text-xs font-semibold text-foreground">
                {formatDateLabel(`${date}T12:00:00Z`, artifact.data.timezone, "long")}
              </h4>
              <ol className="divide-y divide-border/70 rounded-xl border border-border/70 px-3">
                {events.filter((event) => event.start.startsWith(date)).map((event) => (
                  <li key={event.id} className="py-2.5">
                    <CalendarEventDetails event={event} timezone={artifact.data.timezone} />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 @md/message-list:grid-cols-2" aria-label={`Week in ${artifact.data.timezone}`}>
          {groupedDates.map((date) => (
            <section key={date} className="rounded-xl border border-border/70 bg-muted/20 p-2.5">
              <h4 className="mb-2 text-xs font-semibold text-foreground">
                {formatDateLabel(`${date}T12:00:00Z`, artifact.data.timezone)}
              </h4>
              <ol className="space-y-2">
                {events.filter((event) => event.start.startsWith(date)).map((event) => (
                  <li key={event.id}>
                    <CalendarEventDetails event={event} timezone={artifact.data.timezone} compact />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}

      <RemainingRows count={artifact.data.events.length - events.length} />

      {artifact.data.variant === "day" && artifact.data.focusWindow ? (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-teal-6/30 bg-teal-3/30 px-3 py-2">
          <Target className="size-4 shrink-0 text-teal-11" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">{artifact.data.focusWindow.label}</p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {formatTime(artifact.data.focusWindow.start, artifact.data.timezone)}–{formatTime(artifact.data.focusWindow.end, artifact.data.timezone)}
            </p>
          </div>
        </div>
      ) : null}
    </ArtifactFrame>
  )
}

function CommunicationThreadArtifact({ artifact }: { artifact: Extract<UiArtifactPayload, { artifactId: "communication.thread" }> }) {
  const messages = artifact.data.messages.slice(0, 4)

  return (
    <ArtifactFrame artifact={artifact} action={artifact.data.action}>
      {artifact.data.topic ? <p className="mb-3 text-xs text-muted-foreground">{artifact.data.topic}</p> : null}
      <ol className="space-y-3" aria-label={`Messages in ${artifact.data.channel}`}>
        {messages.map((message) => (
          <li key={message.id} className="flex gap-2.5">
            <Avatar size="sm" aria-hidden="true">
              <AvatarFallback className="bg-violet-3 text-violet-11">{initials(message.author)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-xs font-semibold text-foreground">{message.author}</span>
                <time dateTime={message.timestamp} className="text-[11px] tabular-nums text-muted-foreground">
                  {formatTime(message.timestamp)}
                </time>
              </div>
              <p className="mt-0.5 line-clamp-3 text-sm leading-5 text-foreground/90">{message.body}</p>
              {message.reactions?.length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {message.reactions.map((reaction) => (
                    <span key={reaction.emoji} className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[11px]">
                      {reaction.emoji} {reaction.count}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <RemainingRows count={artifact.data.messages.length - messages.length} />
    </ArtifactFrame>
  )
}

function MailInboxArtifact({ artifact }: { artifact: Extract<UiArtifactPayload, { artifactId: "mail.inbox" }> }) {
  const messages = artifact.data.messages.slice(0, INLINE_ROW_LIMIT)

  return (
    <ArtifactFrame artifact={artifact} action={artifact.data.action}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{artifact.data.folder}</span>
        <Badge variant="outline">{artifact.data.unreadCount} unread</Badge>
      </div>
      <ol className="divide-y divide-border/70" aria-label={`${artifact.data.folder} messages`}>
        {messages.map((message) => (
          <li key={message.id} className="flex gap-2.5 py-2.5 first:pt-1 last:pb-1">
            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", message.unread ? "bg-orange-9" : "bg-muted")} aria-label={message.unread ? "Unread" : "Read"} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn("truncate text-xs", message.unread ? "font-semibold text-foreground" : "font-medium text-muted-foreground")}>
                  {message.sender}
                </span>
                <time dateTime={message.receivedAt} className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {formatShortDateTime(message.receivedAt)}
                </time>
              </div>
              <p className="mt-0.5 truncate text-sm font-medium text-foreground">{message.subject}</p>
              <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">{message.snippet}</p>
              {message.labels?.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {message.labels.map((label) => <Badge key={label} variant="secondary">{label}</Badge>)}
                </div>
              ) : null}
            </div>
            {message.action ? <ArtifactActionButton action={message.action} /> : null}
          </li>
        ))}
      </ol>
      <RemainingRows count={artifact.data.messages.length - messages.length} />
    </ArtifactFrame>
  )
}

function attentionIcon(kind: Extract<UiArtifactPayload, { artifactId: "work.attention" }>["data"]["items"][number]["kind"]) {
  switch (kind) {
    case "incident":
      return ShieldAlert
    case "approval":
      return CheckCircle2
    case "task":
      return Clock3
    case "goal":
      return Target
    case "learning":
      return GraduationCap
  }
}

function priorityClass(priority: Extract<UiArtifactPayload, { artifactId: "work.attention" }>["data"]["items"][number]["priority"]) {
  switch (priority) {
    case "critical":
      return "bg-red-3 text-red-11"
    case "high":
      return "bg-orange-3 text-orange-11"
    case "normal":
      return "bg-blue-3 text-blue-11"
    case "low":
      return "bg-muted text-muted-foreground"
  }
}

function AttentionArtifact({ artifact }: { artifact: Extract<UiArtifactPayload, { artifactId: "work.attention" }> }) {
  const items = artifact.data.items.slice(0, INLINE_ROW_LIMIT)

  return (
    <ArtifactFrame artifact={artifact}>
      <ol className="divide-y divide-border/70" aria-label="Items needing attention">
        {items.map((item) => {
          const Icon = attentionIcon(item.kind)
          return (
            <li key={item.id} className="flex items-start gap-3 py-2.5 first:pt-1 last:pb-1">
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", priorityClass(item.priority))}>
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-foreground">{item.title}</span>
                  {item.priority === "critical" ? <Badge variant="destructive">Critical</Badge> : null}
                </div>
                {item.description ? <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.description}</p> : null}
                <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                  {item.source ? <span>{item.source}</span> : null}
                  {item.dueAt ? <time dateTime={item.dueAt}>Due {formatShortDateTime(item.dueAt)}</time> : null}
                </div>
              </div>
              {item.action ? <ArtifactActionButton action={item.action} /> : null}
            </li>
          )
        })}
      </ol>
      <RemainingRows count={artifact.data.items.length - items.length} />
    </ArtifactFrame>
  )
}

function WidgetsArtifact({ artifact }: { artifact: Extract<UiArtifactPayload, { artifactId: "widgets.collection" }> }) {
  const layoutClass = artifact.data.layout === "stack"
    ? "grid-cols-1"
    : artifact.data.layout === "strip"
      ? "grid-cols-2 @lg/message-list:grid-cols-4"
      : "grid-cols-1 @md/message-list:grid-cols-2"

  return (
    <ArtifactFrame artifact={artifact}>
      <div className={cn("grid gap-2", layoutClass)}>
        {artifact.data.widgets.map((widget) => (
          <div key={widget.id} className={cn("rounded-xl border px-3 py-2.5", metricToneClass(widget.tone))}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-xs font-medium text-muted-foreground">{widget.label}</p>
                  <Badge variant="secondary" className="capitalize">{widget.kind}</Badge>
                </div>
                <p className="mt-0.5 truncate text-lg font-semibold text-foreground">
                  {widget.value}
                  {widget.kind === "balance" && widget.unit ? (
                    <span className="ml-1 text-xs font-medium text-muted-foreground">{widget.unit}</span>
                  ) : null}
                </p>
              </div>
              {widget.action ? <ArtifactActionButton action={widget.action} /> : null}
            </div>
            {widget.detail ? <p className="mt-0.5 text-[11px] text-muted-foreground">{widget.detail}</p> : null}
            {widget.kind === "progress" ? (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background/80" aria-label={`${widget.progress}%`}>
                <div className="h-full rounded-full bg-current opacity-60" style={{ width: `${widget.progress}%` }} />
              </div>
            ) : null}
            {widget.kind === "metric" && widget.trend ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {widget.trend.direction === "up" ? "↗" : widget.trend.direction === "down" ? "↘" : "→"} {widget.trend.label}
              </p>
            ) : null}
            {widget.kind === "status" ? (
              <Badge
                variant={widget.status === "blocked" || widget.status === "offline" ? "destructive" : "outline"}
                className="mt-2 capitalize"
              >
                {widget.status}
              </Badge>
            ) : null}
            {widget.kind === "date" && widget.timestamp ? (
              <time dateTime={widget.timestamp} className="mt-1 block text-[11px] text-muted-foreground">
                {formatShortDateTime(widget.timestamp)}
              </time>
            ) : null}
          </div>
        ))}
      </div>
    </ArtifactFrame>
  )
}

function ApprovalArtifact(props: {
  artifact: Extract<UiArtifactPayload, { artifactId: "work.approvals" }>
  onRequestDecision?: (action: Extract<UiArtifactAction, { type: "request_decision" }>) => void
}) {
  return (
    <ArtifactFrame artifact={props.artifact}>
      <ol className="divide-y divide-border/70" aria-label="Mock approvals">
        {props.artifact.data.items.map((item) => (
          <li key={item.id} className="py-3 first:pt-1 last:pb-1">
            <div className="flex items-start gap-3">
              <span className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                item.status === "approved"
                  ? "bg-green-3 text-green-11"
                  : item.status === "rejected"
                    ? "bg-red-3 text-red-11"
                    : "bg-blue-3 text-blue-11",
              )}>
                {item.status === "rejected" ? <XCircle className="size-4" /> : <CheckCircle2 className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-foreground">{item.title}</span>
                  <Badge variant={item.status === "rejected" ? "destructive" : item.status === "approved" ? "secondary" : "outline"}>
                    {item.status}
                  </Badge>
                  {item.amount ? <Badge variant="outline">{item.amount}</Badge> : null}
                </div>
                {item.description ? <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{item.description}</p> : null}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {item.requestor} · {item.source} · submitted {formatShortDateTime(item.submittedAt)}
                </p>
                {item.decisionNote ? <p className="mt-1 text-xs italic text-muted-foreground">“{item.decisionNote}”</p> : null}
              </div>
            </div>
            {item.status === "pending" && item.actions?.length && props.onRequestDecision ? (
              <div className="mt-2 flex justify-end gap-2">
                {item.actions.map((action) => (
                  <Button
                    key={action.id}
                    type="button"
                    variant={action.decision === "reject" ? "outline" : "default"}
                    size="xs"
                    onClick={() => props.onRequestDecision?.(action)}
                    aria-label={action.description ?? action.label}
                  >
                    {action.decision === "reject" ? <XCircle className="size-3" /> : <CheckCircle2 className="size-3" />}
                    {action.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {props.artifact.operation === "replace" ? "Updated mock state" : "Mock state"} · revision {props.artifact.revision}
      </p>
    </ArtifactFrame>
  )
}

function WorkspaceBriefArtifact({ artifact }: { artifact: Extract<UiArtifactPayload, { artifactId: "workspace.brief" }> }) {
  const schedule = artifact.data.schedule.slice(0, 4)
  const attention = artifact.data.attention.slice(0, 4)

  return (
    <ArtifactFrame artifact={artifact}>
      <p className="mb-3 text-sm leading-5 text-muted-foreground">{artifact.data.summary}</p>

      <dl className="grid grid-cols-2 gap-2 @md/message-list:grid-cols-4">
        {artifact.data.metrics.slice(0, 4).map((metric) => (
          <div key={metric.id} className={cn("rounded-xl border px-3 py-2", metricToneClass(metric.tone))}>
            <dd className="text-lg font-semibold tabular-nums text-foreground">{metric.value}</dd>
            <dt className="text-[11px] font-medium text-muted-foreground">{metric.label}</dt>
          </div>
        ))}
      </dl>

      <div className="mt-4 grid gap-4 @lg/message-list:grid-cols-2">
        <section aria-label="Today's schedule">
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <CalendarDays className="size-3.5 text-blue-10" />
            Today at a glance
          </h4>
          <ol className="space-y-2">
            {schedule.map((event) => (
              <li key={event.id} className="flex gap-2 rounded-lg bg-muted/30 px-2.5 py-2">
                <time dateTime={event.start} className="w-14 shrink-0 text-[11px] font-medium tabular-nums">
                  {formatTime(event.start)}
                </time>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-foreground">{event.title}</p>
                  {event.location ? <p className="truncate text-[11px] text-muted-foreground">{event.location}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-label="Needs your attention">
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <BellRing className="size-3.5 text-red-10" />
            Needs your attention
          </h4>
          <ol className="space-y-2">
            {attention.map((item) => (
              <li key={item.id} className="flex items-start gap-2 rounded-lg bg-muted/30 px-2.5 py-2">
                <span className={cn("mt-1 size-2 shrink-0 rounded-full", item.priority === "critical" ? "bg-red-9" : item.priority === "high" ? "bg-orange-9" : "bg-blue-9")} />
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-foreground">{item.title}</p>
                  <p className="truncate text-[11px] text-muted-foreground">{item.source ?? item.kind}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="mt-4" aria-label="Your widgets">
        <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <TrendingUp className="size-3.5 text-purple-10" />
          Your widgets
        </h4>
        <div className="grid grid-cols-2 gap-2 @md/message-list:grid-cols-4">
          {artifact.data.progress.slice(0, 4).map((item) => (
            <div key={item.id} className="rounded-lg border border-border/70 px-2.5 py-2">
              <p className="truncate text-[11px] text-muted-foreground">{item.label}</p>
              <p className="mt-0.5 truncate text-sm font-semibold text-foreground">{item.value}</p>
              {item.progress !== undefined ? (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-purple-9" style={{ width: `${item.progress}%` }} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {artifact.data.quickActions.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-border/70 pt-3">
          {artifact.data.quickActions.map((action) => <ArtifactActionButton key={action.id} action={action} />)}
        </div>
      ) : null}
    </ArtifactFrame>
  )
}

function metricToneClass(tone: UiArtifactWidget["tone"]) {
  switch (tone) {
    case "info":
      return "border-blue-6/30 bg-blue-3/30"
    case "success":
      return "border-green-6/30 bg-green-3/30"
    case "warning":
      return "border-orange-6/30 bg-orange-3/30"
    case "critical":
      return "border-red-6/30 bg-red-3/30"
    case "neutral":
      return "border-border bg-muted/30"
  }
}

export function UiArtifactCard({
  result,
  onRequestDecision,
}: {
  result: UiArtifactRenderResult
  onRequestDecision?: (action: Extract<UiArtifactAction, { type: "request_decision" }>) => void
}) {
  const artifact = result.artifact

  switch (artifact.artifactId) {
    case "workspace.brief":
      return <WorkspaceBriefArtifact artifact={artifact} />
    case "calendar.view":
      return <CalendarArtifact artifact={artifact} />
    case "widgets.collection":
      return <WidgetsArtifact artifact={artifact} />
    case "communication.thread":
      return <CommunicationThreadArtifact artifact={artifact} />
    case "mail.inbox":
      return <MailInboxArtifact artifact={artifact} />
    case "work.attention":
      return <AttentionArtifact artifact={artifact} />
    case "work.approvals":
      return <ApprovalArtifact artifact={artifact} onRequestDecision={onRequestDecision} />
    default:
      return (
        <div className="flex items-center gap-2 rounded-xl border border-border p-3 text-sm text-muted-foreground">
          <CircleAlert className="size-4" />
          UI artifact renderer unavailable.
        </div>
      )
  }
}
