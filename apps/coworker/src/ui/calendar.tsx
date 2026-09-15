import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CoworkerSummary } from "@/lib/bridge";
import { calendarItems, type CalendarItem } from "@/lib/calendar";
import type { EventArtifact, WorkplaceEvent } from "@/lib/events";
import { describeScheduleForPeople } from "@/lib/responsibility-copy";
import {
  Button,
  ChevronIcon,
  ErrorNote,
  IconButton,
  inputClass,
} from "@/ui/kit";
import type { CalendarData } from "@/ui/calendar-data";
import type {
  CalendarPreferences,
  CalendarPreferencesChange,
} from "@/ui/calendar-preferences";
import { EventEditor } from "@/ui/event-editor";
import { EventDetails, type EventSelection } from "@/ui/event-detail";
import { EventSheet } from "@/ui/event-sheet";
import {
  CalendarGrid,
  calendarDate,
  calendarRange,
  plusDays,
  type CalendarMode,
} from "@/ui/calendar-grid";

export type CalendarEventTarget = import("@/lib/events").EventTarget;

export type CalendarRequest = {
  id: number;
  intent?: "open" | "create";
  coworkerSlug?: string;
  eventId?: string;
  runId?: string;
  at?: number;
  fromActivity?: boolean;
  reminderId?: string;
  notice?: string;
};
const modes: { value: CalendarMode; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

export function CalendarView({
  active,
  coworkers,
  data,
  preferences,
  onPreferencesChange: setPreferences,
  request,
  onOpenConversation,
  onOpenArtifact,
  onOpenResponsibility,
  onEventSelectionChange,
  onExitActivity,
  activityReminder,
}: {
  active: boolean;
  coworkers: CoworkerSummary[];
  data: CalendarData;
  preferences: CalendarPreferences;
  onPreferencesChange: CalendarPreferencesChange;
  request: CalendarRequest | null;
  onOpenConversation: (groupId: string, target: CalendarEventTarget) => Promise<void>;
  onOpenArtifact: (artifact: EventArtifact) => Promise<void>;
  onOpenResponsibility: (slug: string, threadId?: string) => void;
  onEventSelectionChange?: (eventId: string | null) => void;
  onExitActivity?: () => void;
  activityReminder?: { id: string; read: boolean; busy: boolean; onMarkRead: () => Promise<void> };
}) {
  const [date, setDate] = useState(Date.now);
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query.trim().toLowerCase());
  const [selection, setSelection] = useState<EventSelection | null>(null);
  const [responsibility, setResponsibility] = useState<CalendarItem | null>(
    null,
  );
  const [editor, setEditor] = useState<{
    event: WorkplaceEvent | null;
    initialStartsAt?: number;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [pendingRequest, setPendingRequest] = useState<CalendarRequest | null>(null);
  const [openedRequest, setOpenedRequest] = useState<CalendarRequest | null>(null);
  const [reminderError, setReminderError] = useState("");
  const markingReminder = useRef(false);
  const openedRequestRef = useRef(openedRequest);
  openedRequestRef.current = openedRequest;
  const handledRequest = useRef<number | null>(null);
  const dock = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const focusRequested = useRef(false);
  const panelOpen = Boolean(selection || responsibility || editor);
  useEffect(() => {
    if (!active || !focusRequested.current) return;
    dock.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    dock.current
      ?.querySelector<HTMLElement>("[data-event-panel-content]")
      ?.focus({ preventScroll: true });
    focusRequested.current = false;
  }, [active, selection, responsibility, editor]);
  useEffect(() => () => onEventSelectionChange?.(null), [onEventSelectionChange]);

  function selectEvent(next: EventSelection | null) {
    onEventSelectionChange?.(next?.eventId ?? null);
    setSelection(next);
  }

  function applyRequest(next: CalendarRequest) {
    if (next.coworkerSlug) {
      setPreferences((value) => ({
        ...value,
        coworkerSlugs: [next.coworkerSlug ?? ""],
      }));
    }
    if (editor) {
      if (next.eventId || next.intent === "create") setPendingRequest(next);
      setNotice(
        next.coworkerSlug
          ? "Calendar visibility updated. Your event draft is kept."
          : "Your event draft is still open. Save or cancel it before opening the requested event.",
      );
      return;
    }
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && !dock.current?.contains(focused))
      opener.current = focused;
    focusRequested.current = Boolean(next.eventId || next.intent === "create");
    setPendingRequest(null);
    setOpenedRequest(next);
    setReminderError("");
    setNotice(next.notice ?? "");
    const run = next.runId ? data.eventRuns.find((entry) => entry.id === next.runId && entry.eventId === next.eventId) : undefined;
    const event = data.events.find((entry) => entry.id === next.eventId);
    const at = next.at ?? (next.runId ? run?.scheduledFor : event?.nextDueAt ?? event?.startsAt);
    if (next.intent === "create") {
      selectEvent(null);
      setResponsibility(null);
      setEditor({ event: null, initialStartsAt: at });
    } else if (next.eventId) {
      selectEvent({
        eventId: next.eventId,
        runId: next.runId,
        at,
        requestId: next.id,
      });
      setResponsibility(null);
    } else if (next.coworkerSlug) {
      selectEvent(null);
      setResponsibility(null);
    }
    if (at !== undefined) setDate(at);
  }

  useEffect(() => {
    if (!active || !request || handledRequest.current === request.id) return;
    handledRequest.current = request.id;
    applyRequest(request);
  }, [active, request]);

  async function markReminderRead() {
    if (!activityReminder || activityReminder.busy || markingReminder.current || openedRequest?.reminderId !== activityReminder.id) return;
    const origin = openedRequest;
    markingReminder.current = true;
    setReminderError("");
    try { await activityReminder.onMarkRead(); }
    catch (cause) {
      if (openedRequestRef.current === origin) setReminderError(cause instanceof Error ? cause.message : "Read status could not be saved. Try again.");
    } finally { markingReminder.current = false; }
  }
  const { start, end, days } = useMemo(
    () => calendarRange(date, preferences.view),
    [date, preferences.view],
  );
  const startAt = start.getTime();
  const endAt = end.getTime();
  // Poll results and date navigation advance the projection clock, not typing or disclosures.
  const now = useMemo(
    () => Date.now(),
    [data.events, data.eventRuns, data.responsibilities, date],
  );
  const projectedItems = useMemo(
    () =>
      calendarItems({
        events: data.events,
        eventRuns: data.eventRuns,
        responsibilities: data.responsibilities,
        start: startAt,
        end: endAt,
        now,
      }),
    [data.events, data.eventRuns, data.responsibilities, startAt, endAt, now],
  );
  const items = useMemo(
    () =>
      projectedItems.filter(
        (item) =>
          (item.kind === "event"
            ? preferences.events
            : preferences.responsibilities) &&
          (preferences.coworkerSlugs === null ||
            item.coworkerSlugs.some((slug) =>
              preferences.coworkerSlugs?.includes(slug),
            )) &&
          (!search ||
            `${item.title} ${item.summary ?? ""}`
              .toLowerCase()
              .includes(search)),
      ),
    [projectedItems, preferences, search],
  );
  const name = (slug: string) =>
    coworkers.find((member) => member.slug === slug)?.name ??
    `${slug} (historical)`;
  const library = preferences.events
    ? data.events.filter(
        (event) =>
          (!search ||
            `${event.title} ${event.objective}`
              .toLowerCase()
              .includes(search)) &&
          (preferences.coworkerSlugs === null ||
            event.participantSlugs.some((slug) =>
              preferences.coworkerSlugs?.includes(slug),
            ) ||
            data.eventRuns.some(
              (run) =>
                run.eventId === event.id &&
                run.event.participantSlugs.some((slug) =>
                  preferences.coworkerSlugs?.includes(slug),
                ),
            )),
      )
    : [];
  const source = responsibility
    ? data.responsibilities.find(
        (item) =>
          item.id === responsibility.responsibilityId &&
          item.placement === responsibility.placement &&
          (!responsibility.ownerSlug ||
            item.ownerSlugs.includes(responsibility.ownerSlug)),
      )
    : undefined;
  const selectedItemId =
    responsibility?.id ??
    projectedItems.find((item) =>
      selection?.runId
        ? item.eventRunId === selection.runId
        : item.eventId === selection?.eventId &&
          item.startsAt === selection?.at,
    )?.id;
  const selectedEntry = projectedItems.find((item) => item.id === selectedItemId);
  const selectedEvent = selection?.runId
    ? data.eventRuns.find((run) => run.id === selection.runId && run.eventId === selection.eventId)?.event
    : data.events.find((event) => event.id === selection?.eventId);
  const selectedSlugs = selectedEntry?.coworkerSlugs ?? selectedEvent?.participantSlugs;
  const hiddenBy = selection && !editor ? [
    ...(!preferences.events ? ["the Events source filter"] : []),
    ...(selectedSlugs && preferences.coworkerSlugs !== null && !selectedSlugs.some((slug) => preferences.coworkerSlugs?.includes(slug)) ? ["coworker filters"] : []),
    ...(selectedEvent && search && !`${selectedEntry?.title ?? selectedEvent.title} ${selectedEntry?.summary ?? selectedEvent.objective}`.toLowerCase().includes(search) ? ["Calendar search"] : []),
  ] : [];
  const rangeTitle =
    preferences.view === "month"
      ? new Date(date).toLocaleDateString(undefined, {
          month: "long",
          year: "numeric",
        })
      : preferences.view === "day"
        ? start.toLocaleDateString(undefined, {
            weekday: "long",
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${plusDays(end, -1).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  function moveDate(direction: number) {
    const next = new Date(date);
    if (preferences.view === "month") {
      const day = next.getDate();
      next.setDate(1);
      next.setMonth(next.getMonth() + direction);
      next.setDate(
        Math.min(
          day,
          new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate(),
        ),
      );
    } else
      next.setDate(
        next.getDate() + direction * (preferences.view === "week" ? 7 : 1),
      );
    setDate(next.getTime());
  }
  function closePanel() {
    const panel = dock.current;
    const restore = panel?.contains(document.activeElement);
    const target = opener.current;
    focusRequested.current = false;
    selectEvent(null);
    setResponsibility(null);
    setEditor(null);
    setOpenedRequest(null);
    setReminderError("");
    setNotice("");
    if (restore)
      window.requestAnimationFrame(() => {
        if (
          target?.isConnected &&
          target.getClientRects().length &&
          (document.activeElement === document.body ||
            panel?.contains(document.activeElement))
        )
          target.focus({ preventScroll: true });
      });
  }
  function create(initialStartsAt: number | undefined, target: HTMLElement) {
    if (editor) {
      setPendingRequest({ id: Date.now(), intent: "create", at: initialStartsAt });
      setNotice(
        "Your event draft is still open. Save or cancel it before choosing another time.",
      );
      return;
    }
    opener.current = target;
    focusRequested.current = true;
    setPendingRequest(null);
    setOpenedRequest(null);
    setReminderError("");
    setNotice("");
    selectEvent(null);
    setResponsibility(null);
    setEditor({ event: null, initialStartsAt });
  }
  function open(item: CalendarItem, target: HTMLElement) {
    if (editor) {
      if (item.kind === "event" && item.eventId) setPendingRequest({ id: Date.now(), eventId: item.eventId, runId: item.eventRunId, at: item.startsAt });
      setNotice(
        "Your event draft is still open. Save or cancel it before opening another entry.",
      );
      return;
    }
    opener.current = target;
    focusRequested.current = true;
    setPendingRequest(null);
    setOpenedRequest(null);
    setReminderError("");
    setNotice("");
    if (item.kind === "event" && item.eventId) {
      selectEvent({
        eventId: item.eventId,
        runId: item.eventRunId,
        at: item.startsAt,
        requestId: Date.now(),
      });
      setResponsibility(null);
    } else {
      setResponsibility(item);
      selectEvent(null);
    }
  }

  return (
    <section
      className="glass-main @container relative flex h-full min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="coworker-calendar"
      data-active={active}
    >
      <header className="glass-header window-drag flex h-[78px] shrink-0 items-center gap-3 border-b border-line px-4 py-3">
        {onExitActivity ? (
          <Button variant="ghost" className="window-no-drag shrink-0 text-xs" onClick={onExitActivity}>
            Go to calendar
          </Button>
        ) : null}
        <div className="min-w-0 flex-1">
          <h1
            className="truncate text-sm font-semibold text-snow"
            aria-live="polite"
            title={rangeTitle}
          >
            {rangeTitle}
          </h1>
          <p className="mt-1 text-[10px] text-mist">Your team's calendar</p>
        </div>
        <div
          role="group"
          aria-label="Calendar layout"
          className="window-no-drag flex shrink-0 rounded-lg border border-line bg-panel/60 p-0.5"
        >
          {modes.map((mode) => (
            <Button
              key={mode.value}
              variant="ghost"
              className={`rounded-md px-2.5 text-xs ${preferences.view === mode.value ? "bg-white/8 text-snow" : ""}`}
              aria-pressed={preferences.view === mode.value}
              onClick={() =>
                setPreferences((value) => ({ ...value, view: mode.value }))
              }
            >
              {mode.label}
            </Button>
          ))}
        </div>
        <Button
          variant="primary"
          className="window-no-drag shrink-0 text-xs"
          disabled={coworkers.length === 0 || Boolean(editor)}
          title={
            coworkers.length === 0
              ? "Add a coworker before creating an event"
              : undefined
          }
          onClick={(event) => create(undefined, event.currentTarget)}
          data-testid="new-event"
        >
          New event
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 overflow-x-auto">
        <div className="flex min-h-0 min-w-[360px] flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-3">
            <div className="flex shrink-0 items-center">
              <IconButton
                label={`Previous ${preferences.view}`}
                onClick={() => moveDate(-1)}
              >
                <ChevronIcon direction="left" />
              </IconButton>
              <Button
                variant="ghost"
                className="px-2 text-xs"
                onClick={() => setDate(Date.now())}
              >
                Today
              </Button>
              <IconButton
                label={`Next ${preferences.view}`}
                onClick={() => moveDate(1)}
              >
                <ChevronIcon direction="right" />
              </IconButton>
            </div>
            <input
              type="date"
              aria-label="Go to date"
              className="h-8 w-[124px] shrink-0 rounded-md border border-line bg-panel px-2 text-[11px] text-mist outline-none focus:border-spark/60 [color-scheme:dark]"
              value={calendarDate(new Date(date))}
              onChange={(event) => {
                if (!event.target.value) return;
                const next = new Date(`${event.target.value}T12:00:00`);
                if (
                  Number.isFinite(next.getTime()) &&
                  calendarDate(next) === event.target.value
                )
                  setDate(next.getTime());
              }}
            />
            <input
              className={`${inputClass} h-8 min-w-20 max-w-[220px] flex-1 py-1 text-xs`}
              aria-label="Search calendar"
              placeholder="Search calendar"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <IconButton
              label={
                data.refreshing ? "Refreshing calendar" : "Refresh calendar"
              }
              disabled={data.refreshing}
              onClick={() => void data.refresh()}
            >
              <svg
                className={`size-4 ${data.refreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M13 5.5A5.3 5.3 0 1 0 13.2 10M13 2.5v3.5H9.5" />
              </svg>
            </IconButton>
          </div>
          {data.errors.length || data.loading || notice || pendingRequest || openedRequest?.fromActivity || hiddenBy.length || reminderError ? (
            <div className="shrink-0 space-y-1 border-b border-line px-3 py-2">
              {openedRequest?.fromActivity ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-mist">
                  <p role="status">Opened from Activity</p>
                  {activityReminder && openedRequest.reminderId === activityReminder.id ? (
                    activityReminder.read ? <span>Reminder marked as read.</span> : (
                      <Button variant="ghost" className="text-xs" disabled={activityReminder.busy} onClick={() => void markReminderRead()}>Mark reminder as read</Button>
                    )
                  ) : null}
                </div>
              ) : null}
              {reminderError ? <p role="alert" className="text-xs text-amber">{reminderError}</p> : null}
              {hiddenBy.length ? <p role="status" className="text-xs text-mist">This event is hidden by {hiddenBy.join(" and ")}. Your filters are unchanged.</p> : null}
              {pendingRequest ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-mist">
                  <p>{editor ? "Your requested destination is kept until you save or cancel this draft." : "Your requested destination is ready to open."}</p>
                  <Button variant="ghost" className="text-xs" disabled={Boolean(editor)} onClick={() => applyRequest(pendingRequest)}>{pendingRequest.intent === "create" ? "Create requested event" : "Open requested event"}</Button>
                  <Button variant="ghost" className="text-xs" onClick={() => { setPendingRequest(null); setNotice(""); }}>Dismiss request</Button>
                </div>
              ) : null}
              {data.errors.length ? (
                <div
                  role="status"
                  className="max-h-24 overflow-y-auto text-xs text-amber"
                >
                  <p className="font-medium">Calendar is partially available</p>
                  {data.errors.map((error) => (
                    <p key={error}>{error}</p>
                  ))}
                </div>
              ) : null}
              {data.loading ? (
                <p role="status" className="text-xs text-mist">
                  Reading events and responsibilities...
                </p>
              ) : null}
              {notice ? (
                <p role="status" className="text-xs text-amber">
                  {notice}
                </p>
              ) : null}
            </div>
          ) : null}
          {!data.loading && items.length === 0 ? (
            <p data-testid="calendar-empty" className="sr-only">
              No matching entries. Choose a time or change the filters.
            </p>
          ) : null}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <CalendarGrid
              mode={preferences.view}
              days={days}
              date={date}
              items={items}
              active={active}
              canCreate={coworkers.length > 0}
              selectedId={selectedItemId}
              name={name}
              onOpen={open}
              onCreate={create}
              onDay={(day) => {
                setDate(day.getTime());
                setPreferences((value) => ({ ...value, view: "day" }));
              }}
            />
            <p
              className="shrink-0 truncate border-t border-line px-3 py-1 text-[9px] leading-3 text-mist/70"
              title={`Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Dashed entries are scheduled; solid entries are actual runs. Select an empty time to plan.${days.some((day) => plusDays(day, 1).getTime() - day.getTime() !== 86400000) ? " Clocks change in this range; repeated-hour slots choose the first occurrence." : ""}`}
            >
              {Intl.DateTimeFormat().resolvedOptions().timeZone} / Dashed:
              scheduled / Solid: actual
            </p>
            {preferences.events ? (
              <details className="max-h-44 shrink-0 overflow-y-auto border-t border-line px-3 py-2">
                <summary
                  className="cursor-pointer text-[10px] font-medium leading-3 text-mist"
                  title="Includes paused, archived and historical events"
                >
                  Event library ({library.length})
                </summary>
                <div className="mt-3 space-y-1">
                  {library.map((event) => (
                    <button
                      type="button"
                      key={event.id}
                      className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-xs hover:bg-white/5"
                      onClick={(click) => {
                        if (editor) {
                          setPendingRequest({ id: Date.now(), eventId: event.id });
                          setNotice(
                            "Save or cancel your open draft before opening another event.",
                          );
                          return;
                        }
                        opener.current = click.currentTarget;
                        focusRequested.current = true;
                        setPendingRequest(null);
                        setOpenedRequest(null);
                        setReminderError("");
                        setNotice("");
                        setResponsibility(null);
                        selectEvent({
                          eventId: event.id,
                          requestId: Date.now(),
                        });
                      }}
                    >
                      <span className="min-w-0 break-words text-snow">
                        {event.title}
                      </span>
                      <span className="shrink-0 text-mist">
                        {event.state} / history
                      </span>
                    </button>
                  ))}
                  {!data.loading && library.length === 0 ? (
                    <p className="text-xs text-mist">
                      No matching events. No history has been removed.
                    </p>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        </div>
        {panelOpen ? (
          <aside
            ref={dock}
            aria-label="Event panel"
            data-testid="calendar-event-panel"
            className="glass-context flex h-full w-[380px] min-w-[360px] shrink-0 flex-col border-l border-line @min-[1280px]:w-[420px]"
          >
            {selection && !editor ? (
              <EventDetails
                key={selection.eventId}
                active={active}
                selection={selection}
                coworkers={coworkers}
                onClose={closePanel}
                onEdit={(event) => {
                  focusRequested.current = true;
                  setEditor({ event });
                }}
                onOpenConversation={(groupId) => onOpenConversation(groupId, { eventId: selection.eventId, runId: selection.runId, at: selection.at })}
                onOpenArtifact={onOpenArtifact}
                onChanged={data.refresh}
              />
            ) : null}
            {editor ? (
              <EventEditor
                key={
                  editor.event?.id ??
                  `new-${editor.initialStartsAt ?? "default"}`
                }
                active={active}
                event={editor.event}
                coworkers={coworkers}
                initialStartsAt={editor.initialStartsAt}
                initialSlug={
                  preferences.coworkerSlugs?.length === 1
                    ? preferences.coworkerSlugs[0]
                    : undefined
                }
                onClose={() => {
                  setNotice("");
                  if (selection) {
                    focusRequested.current = true;
                    setEditor(null);
                  } else closePanel();
                }}
                onSaved={(event) => {
                  focusRequested.current =
                    dock.current?.contains(document.activeElement) ?? false;
                  setEditor(null);
                  setNotice("");
                  setResponsibility(null);
                  setDate(event.nextDueAt ?? event.startsAt);
                  selectEvent({
                    eventId: event.id,
                    at: event.nextDueAt ?? event.startsAt,
                    requestId: Date.now(),
                  });
                  void data.refresh();
                }}
              />
            ) : null}
            {responsibility && !selection && !editor ? (
              <EventSheet
                title="Scheduled responsibility"
                active={active}
                onClose={closePanel}
              >
                <div
                  className="space-y-4"
                  data-testid="calendar-responsibility-detail"
                >
                  <h3 className="text-lg font-semibold">
                    {responsibility.title}
                  </h3>
                  <p className="text-xs text-mist">
                    {responsibility.planned
                      ? "Scheduled, not yet an execution receipt"
                      : `Actual run / ${responsibility.status}`}{" "}
                    /{" "}
                    {responsibility.placement === "local"
                      ? "This computer"
                      : responsibility.placement === "cloud"
                        ? "OpenWork Cloud"
                        : "Desktop"}
                  </p>
                  {source ? (
                    <>
                      <p className="text-sm text-mist">
                        {describeScheduleForPeople(source.schedule)}
                      </p>
                      <p className="whitespace-pre-wrap text-sm">
                        {source.instructions}
                      </p>
                      <h4 className="text-xs font-semibold text-mist">
                        Recent history
                      </h4>
                      {source.runs.map((run) => (
                        <div
                          key={run.id}
                          className="border-t border-line py-2 text-xs"
                        >
                          <p>
                            {new Date(run.at).toLocaleString()} / {run.status}
                          </p>
                          {run.summary ? (
                            <p className="mt-1 whitespace-pre-wrap text-mist">
                              {run.summary}
                            </p>
                          ) : null}
                          {run.threadId && responsibility.ownerSlug ? (
                            <Button
                              variant="ghost"
                              className="mt-1 text-xs"
                              onClick={() =>
                                onOpenResponsibility(
                                  responsibility.ownerSlug ?? "",
                                  run.threadId,
                                )
                              }
                            >
                              Open run conversation
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </>
                  ) : (
                    <ErrorNote>
                      The responsibility definition is unavailable. Its selected
                      calendar entry is kept.
                    </ErrorNote>
                  )}
                  {responsibility.summary ? (
                    <p className="whitespace-pre-wrap text-sm">
                      {responsibility.summary}
                    </p>
                  ) : null}
                  {responsibility.ownerSlug &&
                  coworkers.some(
                    (member) => member.slug === responsibility.ownerSlug,
                  ) ? (
                    <Button
                      onClick={() =>
                        onOpenResponsibility(
                          responsibility.ownerSlug ?? "",
                          responsibility.threadId,
                        )
                      }
                    >
                      Open in coworker's assignments
                    </Button>
                  ) : (
                    <p className="text-xs text-mist">
                      No current coworker owns a local view for this entry.
                    </p>
                  )}
                  <p className="text-[11px] text-mist">
                    Manage execution in the existing assignments panel. Cloud
                    history has no local conversation unless a native thread is
                    provided.
                  </p>
                </div>
              </EventSheet>
            ) : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
