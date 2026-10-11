/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react"
import { AlertCircle, CalendarDays, ChevronLeft, ChevronRight, Lock, Plus, RefreshCw } from "lucide-react"
import { useNavigate, useSearchParams } from "react-router"
import type { AutomationRun } from "@openwork/types/automations"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { CloudSignInBanner, CloudSignInBannerIcon } from "@/react-app/domains/cloud/cloud-sign-in-banner"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { automationExecutionThreadRoute } from "@/react-app/domains/automations/automation-cloud-thread"
import {
  describeAutomationError,
  useAutomationActions,
  useAutomationListQuery,
  useAutomationRunsQuery,
  useAutomationsDenContext,
} from "@/react-app/domains/automations/use-automations"
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src"
import { useOrgMcpConnections } from "@/react-app/domains/connections/use-org-mcp-connections"
import { usePlatform } from "@/react-app/kernel/platform"
import {
  buildAutomationCalendarItems,
  CALENDAR_PROVIDER_LABEL,
  type CalendarConnectionError,
  type CalendarEvent,
  type CalendarProviderId,
  calendarRange,
  type CalendarView,
  dateKey,
  formatRangeLabel,
  formatTime,
  type LocalDate,
  localDateOf,
  nextOpenSlot,
  parseDateKey,
  shiftAnchor,
} from "@openwork/calendar"
import { AutomationDetailPanel, MeetingDetailPanel } from "./calendar-detail-panel"
import { CreateAutomationCard, type CreateAnchor } from "./calendar-create"
import { CalendarEditDialog } from "./calendar-edit"
import type { AutomationProviderCatalog } from "@/react-app/domains/automations/automation-model-options"
import { useAutomationEditorSetup } from "@/react-app/domains/automations/use-automation-editor-setup"
import { globalSettingsRoute, workspaceSettingsRoute } from "@/react-app/shell/workspace-routes"
import { toast } from "@/components/ui/sonner"
import { CalendarMonthGrid, CalendarTimeGrid, type CalendarSelection } from "./calendar-grid"
import {
  calendarProviderPresence,
  useAutomationRunsInRange,
  useCalendarFeature,
  useCalendarDefaultModelName,
  useCalendarMeetings,
  useCalendarTransport,
} from "./use-calendar-data"

const PROVIDERS: readonly CalendarProviderId[] = ["google", "microsoft"]
const LAYERS_STORAGE_KEY = "openwork.calendar.layers.v1"
const NOW_TICK_MS = 60_000
const WEEK_STARTS_ON = 1

type Layers = { automations: boolean; meetings: boolean }

function readLayers(): Layers {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(LAYERS_STORAGE_KEY) ?? "null")
    if (typeof parsed === "object" && parsed !== null && "automations" in parsed && "meetings" in parsed) {
      return { automations: parsed.automations !== false, meetings: parsed.meetings !== false }
    }
  } catch {
    // Fall through to the default.
  }
  return { automations: true, meetings: true }
}

function displayTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

function ProviderLogo({ provider }: { provider: CalendarProviderId }) {
  const src = resolveExtensionIconSrc(provider === "google" ? "/ext-google-workspace.svg" : "/ext-microsoft-365.svg")
  return <img src={src} alt="" aria-hidden="true" className="size-3.5 shrink-0" />
}

function blockedCopy(error: CalendarConnectionError): { label: string; reason: string; canConnect: boolean } {
  const name = CALENDAR_PROVIDER_LABEL[error.provider]
  switch (error.kind) {
    case "not_connected": return { label: `Connect ${name}`, reason: error.message, canConnect: true }
    case "auth_expired": return { label: `Reconnect ${name}`, reason: error.message, canConnect: true }
    case "permission_missing": return { label: `${name} needs calendar access`, reason: error.message, canConnect: true }
    case "policy_blocked": return { label: `${name} is blocked by your organization`, reason: error.message, canConnect: false }
    case "unsupported": return { label: `${name} unavailable`, reason: error.message, canConnect: false }
    default: return { label: name, reason: error.message, canConnect: false }
  }
}

function isBlocked(error: CalendarConnectionError) {
  return !error.retryable
}

function CalendarSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4" role="status" aria-label="Loading calendar">
      <Skeleton className="h-8 w-80 rounded-lg" />
      <div className="grid flex-1 grid-cols-7 gap-px">
        {Array.from({ length: 7 }, (_, index) => <Skeleton key={index} className="h-full min-h-96 rounded-md" />)}
      </div>
    </div>
  )
}

/**
 * The Calendar: the member's Automations as time blocks next to meetings
 * from their connected Google or Outlook calendar. Automations come from Den;
 * meetings are read-only overlays (nothing is written to the member's calendar).
 */
export function CalendarPage(props: {
  onSignIn?: () => void
  onOpenConnections?: () => void
  onOpenProviderSettings?: () => void
  workspaceId?: string | null
  providerCatalog?: AutomationProviderCatalog
}) {
  const denAuth = useDenAuth()
  const navigate = useNavigate()
  const platform = usePlatform()
  const denContext = useAutomationsDenContext()
  const { client, organizationId } = denContext
  const timeZone = displayTimeZone()
  const [now, setNow] = useState(() => Date.now())
  // View, date and selection live in the URL so a reload or a shell remount keeps them.
  const [searchParams, setSearchParams] = useSearchParams()
  const viewParam = searchParams.get("view")
  const view: CalendarView = viewParam === "day" || viewParam === "month" ? viewParam : "week"
  const anchor: LocalDate = parseDateKey(searchParams.get("date") ?? "") ?? localDateOf(now, timeZone)
  const selection: CalendarSelection = searchParams.get("automation")
    ? { kind: "automation", automationId: searchParams.get("automation") ?? "", itemKey: searchParams.get("block") }
    : searchParams.get("meeting") ? { kind: "meeting", key: searchParams.get("meeting") ?? "" } : null
  const updateParams = (change: (next: URLSearchParams) => void) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      change(next)
      return next
    }, { replace: true })
  }
  const setView = (next: CalendarView) => updateParams((params) => { params.set("view", next) })
  const setAnchor = (next: LocalDate | ((current: LocalDate) => LocalDate)) => updateParams((params) => {
    params.set("date", dateKey(typeof next === "function" ? next(anchor) : next))
  })
  const setSelection = (next: CalendarSelection) => updateParams((params) => {
    for (const key of ["automation", "block", "meeting"]) params.delete(key)
    if (next?.kind === "automation") {
      params.set("automation", next.automationId)
      if (next.itemKey) params.set("block", next.itemKey)
    } else if (next?.kind === "meeting") {
      params.set("meeting", next.key)
    }
  })
  const [layers, setLayers] = useState<Layers>(readLayers)
  const [creating, setCreating] = useState<CreateAnchor | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const editorSetup = useAutomationEditorSetup(denContext, props.providerCatalog, props.workspaceId)
  const openProviderSettings = props.onOpenProviderSettings
    ?? (() => navigate(props.workspaceId?.trim() ? workspaceSettingsRoute(props.workspaceId.trim(), "ai") : globalSettingsRoute("ai")))
  const [hiddenProviders, setHiddenProviders] = useState<ReadonlySet<CalendarProviderId>>(new Set())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYERS_STORAGE_KEY, JSON.stringify(layers))
    } catch {
      // Layer choice is a convenience; ignore storage failures.
    }
  }, [layers])

  const { year, month, day } = anchor
  const range = useMemo(() => calendarRange(view, { year, month, day }, timeZone, WEEK_STARTS_ON), [day, month, timeZone, view, year])
  const feature = useCalendarFeature(denContext)
  const polish = useCalendarFeature(denContext, "calendarPolish").data === true
  const enabled = feature.data === true
  const organizationDefaultName = useCalendarDefaultModelName(denContext, polish && enabled).data
  const listQuery = useAutomationListQuery(denContext)
  const automationItems = listQuery.data?.items
  const runsQuery = useAutomationRunsInRange(denContext, range, automationItems, enabled && layers.automations)
  const { busyAction, act } = useAutomationActions(denContext)
  const transport = useCalendarTransport(denContext)
  const orgConnections = useOrgMcpConnections()
  const presence = Object.fromEntries(PROVIDERS.map((provider) => [provider, calendarProviderPresence(provider, orgConnections.connections, orgConnections.loaded, transport)]))
  const googleMeetings = useCalendarMeetings({ provider: "google", transport, organizationId, range, enabled: enabled && layers.meetings && presence.google?.presence === "available" })
  const microsoftMeetings = useCalendarMeetings({ provider: "microsoft", transport, organizationId, range, enabled: enabled && layers.meetings && presence.microsoft?.presence === "available" })
  const meetingQueries = { google: googleMeetings, microsoft: microsoftMeetings }

  const calendarItems = useMemo(() => layers.automations && automationItems && runsQuery.data
    ? buildAutomationCalendarItems({ automations: automationItems, runs: runsQuery.data.runs, range, now })
    : [], [automationItems, layers.automations, now, range, runsQuery.data])
  const meetings = useMemo((): CalendarEvent[] => layers.meetings
    ? PROVIDERS.filter((provider) => !hiddenProviders.has(provider)).flatMap((provider) => meetingQueries[provider].data?.events ?? [])
    : [], [googleMeetings.data, hiddenProviders, layers.meetings, microsoftMeetings.data])

  const selectedAutomationId = selection?.kind === "automation" ? selection.automationId : null
  const selectedAutomation = automationItems?.find((item) => item.automation.id === selectedAutomationId) ?? null
  const selectedBlock = selection?.kind === "automation" ? calendarItems.find((item) => item.key === selection.itemKey) ?? null : null
  const selectedRuns = useAutomationRunsQuery(denContext, selectedAutomationId)
  const selectedMeeting = selection?.kind === "meeting" ? meetings.find((event) => event.key === selection.key) ?? null : null

  const openRun = (run: AutomationRun) => {
    navigate(run.executionThread
      ? automationExecutionThreadRoute(run.executionThread)
      : `/automations?${new URLSearchParams({ automation: run.automationId, run: run.id }).toString()}`)
  }

  if (denAuth.status === "checking") return <CalendarSkeleton />
  if (!denAuth.isSignedIn) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-5 px-6 py-8 sm:px-8" data-calendar-signed-out>
        <CloudSignInBanner
          testId="calendar-sign-in-banner"
          media={<CloudSignInBannerIcon><CalendarDays /></CloudSignInBannerIcon>}
          message="Sign in to OpenWork Cloud to see your Automations next to your meetings."
          onSignIn={props.onSignIn}
        />
      </div>
    )
  }
  if (!organizationId || !client) {
    return (
      <Empty className="pt-16" data-calendar-no-organization>
        <EmptyHeader>
          <EmptyMedia variant="icon"><CalendarDays /></EmptyMedia>
          <EmptyTitle>Select an organization</EmptyTitle>
        </EmptyHeader>
        <Button variant="outline" onClick={() => navigate(globalSettingsRoute("cloud-account"))}>Open account settings</Button>
      </Empty>
    )
  }
  if (feature.isLoading || (enabled && listQuery.isLoading)) return <CalendarSkeleton />
  if (!enabled) {
    return (
      <Empty className="pt-16" data-calendar-locked>
        <EmptyHeader>
          <EmptyMedia variant="icon"><Lock /></EmptyMedia>
          <EmptyTitle>Calendar is not on for your organization</EmptyTitle>
          <EmptyDescription>OpenWork turns the Calendar on per organization. Your Automations are still on the Automations page.</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" onClick={() => navigate("/automations")}>Open Automations</Button>
      </Empty>
    )
  }
  if (listQuery.error) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 p-6 pt-16 text-center" role="alert">
        <AlertCircle className="size-8 text-destructive" aria-hidden="true" />
        <div>
          <h2 className="font-medium">Automations could not be loaded</h2>
          <p className="mt-2 text-sm text-muted-foreground">{describeAutomationError(listQuery.error)}</p>
        </div>
        <Button variant="outline" onClick={() => void listQuery.refetch()}><RefreshCw />Retry</Button>
      </div>
    )
  }

  const goToday = () => updateParams((params) => { params.delete("date") })
  const noAutomations = (automationItems ?? []).every((item) => item.automation.state === "archived")
  const providersOffered = PROVIDERS.filter((provider) => presence[provider]?.presence !== "absent")

  return (
    <div className="flex h-full min-h-0 flex-col" data-calendar-page>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5" data-calendar-toolbar>
        <Button variant="outline" size="sm" onClick={goToday}>Today</Button>
        <div className="flex items-center">
          <Button variant="ghost" size="icon-sm" aria-label="Previous" onClick={() => setAnchor((current) => shiftAnchor(view, current, -1))}><ChevronLeft /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next" onClick={() => setAnchor((current) => shiftAnchor(view, current, 1))}><ChevronRight /></Button>
        </div>
        <h2 className="text-[15px] font-semibold tracking-[-0.2px]" data-calendar-range-label>{formatRangeLabel(range, anchor)}</h2>
        <Button
          variant="outline"
          size="sm"
          data-calendar-new
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            setCreating({ slot: nextOpenSlot(Date.now(), timeZone), x: box.left, y: box.bottom + 8 })
          }}
        >
          <Plus />New automation
        </Button>
        <ToggleGroup
          className="ml-auto"
          aria-label="Calendar view"
          variant="segmented"
          spacing={0.5}
          size="xs"
          value={[view]}
          onValueChange={(values) => {
            const next = values[0]
            if (next === "day" || next === "week" || next === "month") setView(next)
          }}
        >
          <ToggleGroupItem value="day">Day</ToggleGroupItem>
          <ToggleGroupItem value="week">Week</ToggleGroupItem>
          <ToggleGroupItem value="month">Month</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border px-4 py-2 text-sm">
        <label className="flex items-center gap-2" data-calendar-layer="automations">
          <Checkbox checked={layers.automations} onCheckedChange={(checked) => setLayers((current) => ({ ...current, automations: checked === true }))} />
          <span>Your Automations</span>
          {runsQuery.isFetching && !runsQuery.data ? <Skeleton className="h-3 w-10 rounded" /> : null}
          {runsQuery.data && !runsQuery.data.complete ? (
            <Tooltip>
              <TooltipTrigger render={<span className="text-xs text-muted-foreground" data-calendar-runs-incomplete />}>Some runs not shown</TooltipTrigger>
              <TooltipContent>This range has more runs than one view loads. Open Automations for full history.</TooltipContent>
            </Tooltip>
          ) : null}
          {runsQuery.error ? <span className="text-xs text-muted-foreground">Run history unavailable</span> : null}
        </label>
        <label className="flex items-center gap-2" data-calendar-layer="meetings">
          <Checkbox checked={layers.meetings} onCheckedChange={(checked) => setLayers((current) => ({ ...current, meetings: checked === true }))} />
          <span>Your meetings</span>
        </label>
        {layers.meetings ? providersOffered.map((provider) => {
          const query = meetingQueries[provider]
          const info = presence[provider]
          const hidden = hiddenProviders.has(provider)
          if (info?.presence === "not_connected") {
            return (
              <span key={provider} className="flex items-center gap-1.5 text-xs text-muted-foreground" data-calendar-provider-status={provider} data-state="not_connected">
                <ProviderLogo provider={provider} />
                <Button variant="link" size="xs" className="h-auto p-0" onClick={() => info.connectionId ? void orgConnections.connect(info.connectionId) : props.onOpenConnections?.()}>
                  Connect {CALENDAR_PROVIDER_LABEL[provider]}
                </Button>
              </span>
            )
          }
          if (query.error && (isBlocked(query.error) || !query.data)) {
            const copy = isBlocked(query.error) ? blockedCopy(query.error) : null
            return (
              <Tooltip key={provider}>
                <TooltipTrigger
                  render={<span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-calendar-provider-status={provider} data-state={query.error.kind} />}
                >
                  {query.error.kind === "policy_blocked" ? <Lock className="size-3" aria-hidden="true" /> : <ProviderLogo provider={provider} />}
                  {copy ? (
                    copy.canConnect && (info?.connectionId || props.onOpenConnections) ? (
                      <Button variant="link" size="xs" className="h-auto p-0" onClick={() => info?.connectionId ? void orgConnections.connect(info.connectionId, { forceFreshAuthorization: true }) : props.onOpenConnections?.()}>{copy.label}</Button>
                    ) : <span>{copy.label}</span>
                  ) : (
                    <>
                      <span>Couldn't load {CALENDAR_PROVIDER_LABEL[provider]}</span>
                      <Button variant="link" size="xs" className="h-auto p-0" onClick={() => void query.refetch()}>Retry</Button>
                    </>
                  )}
                </TooltipTrigger>
                <TooltipContent>{copy?.reason ?? query.error.message}</TooltipContent>
              </Tooltip>
            )
          }
          return (
            <label key={provider} className="flex items-center gap-1.5 text-xs" data-calendar-provider-status={provider} data-state={query.data ? "ready" : "loading"}>
              <Checkbox
                checked={!hidden}
                onCheckedChange={(checked) => setHiddenProviders((current) => {
                  const next = new Set(current)
                  if (checked === true) next.delete(provider)
                  else next.add(provider)
                  return next
                })}
              />
              <ProviderLogo provider={provider} />
              <span>{CALENDAR_PROVIDER_LABEL[provider]}</span>
              {query.isFetching && !query.data ? <Skeleton className="h-3 w-8 rounded" /> : null}
              {query.data && !query.data.complete ? <span className="text-muted-foreground">· Some meetings may be missing</span> : null}
              {query.error && query.data ? (
                <span className="text-muted-foreground" data-calendar-provider-stale>· Showing meetings from {formatTime(query.dataUpdatedAt, timeZone)}</span>
              ) : null}
            </label>
          )
        }) : null}
        {transport?.kind === "mock" ? <span className="ml-auto rounded bg-amber-3 px-1.5 py-0.5 text-[11px] text-amber-11" data-calendar-mock>Mock calendar</span> : null}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <div className="relative flex h-[max(24rem,calc(100dvh-10rem))] min-w-0 shrink-0 flex-col lg:h-auto lg:min-h-0 lg:flex-1">
          {view === "month" ? (
            <CalendarMonthGrid
              polish={polish}
              range={range}
              timeZone={timeZone}
              now={now}
              automations={calendarItems}
              meetings={meetings}
              selection={selection}
              onSelect={setSelection}
              anchorMonth={anchor.month}
              onOpenDay={(day) => updateParams((params) => { params.set("date", dateKey(day)); params.set("view", "day") })}
            />
          ) : (
            <CalendarTimeGrid
              polish={polish}
              range={range}
              timeZone={timeZone}
              now={now}
              automations={calendarItems}
              meetings={meetings}
              selection={selection}
              onSelect={setSelection}
              onCreateAt={setCreating}
            />
          )}
          {noAutomations && layers.automations ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
              <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-2.5 text-sm shadow-[var(--dls-card-shadow)]" data-calendar-empty>
                <span>No automations yet.</span>
                <Button size="sm" onClick={() => navigate("/automations?create=1")}>New automation</Button>
              </div>
            </div>
          ) : null}
        </div>
        {creating ? (
          <CreateAutomationCard
            polish={polish}
            organizationDefaultName={organizationDefaultName}
            key={creating.slot.at}
            anchor={creating}
            context={denContext}
            setup={editorSetup}
            providerCatalog={props.providerCatalog}
            workspaceId={props.workspaceId ?? null}
            onOpenProviderSettings={openProviderSettings}
            onClose={() => setCreating(null)}
            onCreated={(detail) => {
              setCreating(null)
              setSelection({ kind: "automation", automationId: detail.automation.id, itemKey: null })
              toast.success("Automation created")
            }}
          />
        ) : null}
        {selectedAutomation && editingId === selectedAutomation.automation.id ? (
          <CalendarEditDialog
            item={selectedAutomation}
            context={denContext}
            setup={editorSetup}
            providerCatalog={props.providerCatalog}
            workspaceId={props.workspaceId ?? null}
            onOpenProviderSettings={openProviderSettings}
            onClose={() => setEditingId(null)}
          />
        ) : null}
        {selectedAutomation ? (
          <AutomationDetailPanel
            polish={polish}
            organizationDefaultName={organizationDefaultName}
            key={selectedAutomation.automation.id}
            item={selectedAutomation}
            selectedBlock={selectedBlock}
            runs={selectedRuns.data?.items}
            runsLoading={selectedRuns.isLoading}
            timeZone={timeZone}
            modelOptions={editorSetup.modelsFor(selectedAutomation.revision.executionTarget ?? "desktop", selectedAutomation.revision.workspaceId)}
            onClose={() => setSelection(null)}
            actions={{
              onEdit: () => setEditingId(selectedAutomation.automation.id),
              busyAction,
              onOpenRun: openRun,
              onPause: () => void act("deactivate", async () => {
                await client.deactivateAutomation(organizationId, selectedAutomation.automation.id)
              }, "Automation paused. A run already in progress will continue."),
              onResume: () => void act("activate", async () => {
                await client.activateAutomation(organizationId, selectedAutomation.automation.id)
              }, "Automation resumed"),
              onRunNow: () => void act("run", async () => {
                await client.runAutomationNow(organizationId, selectedAutomation.automation.id)
              }, "Run queued"),
              onSaveSchedule: (schedule) => act("schedule", async () => {
                await client.updateAutomation(organizationId, selectedAutomation.automation.id, { schedule })
              }, "Schedule saved"),
            }}
          />
        ) : selectedMeeting ? (
          <MeetingDetailPanel event={selectedMeeting} timeZone={timeZone} onOpenLink={(url) => platform.openLink(url)} onClose={() => setSelection(null)} />
        ) : null}
      </div>
    </div>
  )
}
