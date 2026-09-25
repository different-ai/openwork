import { useEffect, useId, useMemo, useRef, useState } from "react";
import { coworkerBridge, type CoworkerActivityItem, type CoworkerGroupSummary, type CoworkerSummary } from "@/lib/bridge";
import { calendarItems } from "@/lib/calendar";
import { eventForTarget, eventRunIsLive, groupEventTarget } from "@/lib/events";
import type { CoworkerDocumentSummary } from "@/lib/documents";
import type { CalendarData } from "@/ui/calendar-data";
import type { CalendarEventTarget } from "@/ui/calendar";
import { CalendarIcon } from "@/ui/main-content-switch";
import { describeHeaderStatus } from "@/lib/activity-summary";
import type { CoworkerActivity } from "@/lib/threads";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { Button, ChevronIcon, IconButton, inputClass } from "@/ui/kit";
import { useFeatures } from "@/ui/use-features";

export type ActivityDocumentTarget =
  | { kind: "coworker"; slug: string; createdAt: string; documentId: string; title: string; revision: number }
  | { kind: "group"; groupId: string; createdAt: number; documentId: string; title: string; revision: number };

export type ActivityInboxProps = {
  active: boolean;
  selectedId: string | null;
  items: CoworkerActivityItem[];
  loading: boolean;
  error: string;
  busy: boolean;
  coworkers: CoworkerSummary[];
  groups: CoworkerGroupSummary[];
  activityBySlug: Record<string, CoworkerActivity>;
  onRefresh: () => void;
  onMarkRead: (ids: string[], read?: boolean) => Promise<void>;
  onOpen: (item: CoworkerActivityItem) => Promise<void>;
  onOpenDocument: (target: ActivityDocumentTarget) => Promise<void>;
  calendar: CalendarData;
  onOpenEvent: (target: CalendarEventTarget) => void;
  onOpenCalendar: () => void;
  onNewEvent: () => void;
};

type Filter = "all" | "mentions" | "events" | "chats" | "documents";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mentions", label: "Mentions" },
  { id: "events", label: "Events" },
  { id: "chats", label: "Chats" },
  { id: "documents", label: "Documents" },
];
const FOCUS = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-spark/60";
const RECENT_LIMIT = 120;

type DocumentOwner =
  | { kind: "coworker"; slug: string; createdAt: string; name: string; key: string }
  | { kind: "group"; groupId: string; createdAt: number; name: string; key: string; event: boolean };
type DocumentSnapshot = { scope: object; documents: Record<string, CoworkerDocumentSummary[]>; errors: Record<string, string> };
type HistoryEntry = {
  id: string;
  at: number;
  title: string;
  location: string;
  preview: string;
  label: string;
  coworker?: CoworkerSummary;
  eventTarget?: CalendarEventTarget;
} & (
  // `item` is the newest in its conversation; `thread` holds every item grouped into this row, newest first.
  | { kind: "activity"; item: CoworkerActivityItem; thread: CoworkerActivityItem[]; category: "events" | "chats" }
  | { kind: "document"; target: ActivityDocumentTarget; category: "documents" }
);

function useActivityDocuments(active: boolean, coworkers: CoworkerSummary[], groups: CoworkerGroupSummary[]) {
  const bySlug = new Map(coworkers.map((member) => [member.slug, member]));
  const liveGroups = groups.filter((group) => !group.archivedAt && group.participantSlugs.length > 0 && group.participantSlugs.every((slug) => bySlug.has(slug)));
  const teamKey = JSON.stringify([
    [...coworkers].sort((a, b) => a.slug.localeCompare(b.slug)).map((member) => [member.slug, member.createdAt, member.workspaceId, member.path]),
    [...liveGroups].sort((a, b) => a.id.localeCompare(b.id)).map((group) => [group.id, group.createdAt, [...group.participantSlugs].sort(), Object.entries(group.participantThreadIds).sort(([a], [b]) => a.localeCompare(b))]),
  ]);
  const scope = useMemo(() => ({ teamKey }), [teamKey]);
  const owners: DocumentOwner[] = [
    ...coworkers.map((member): DocumentOwner => ({ kind: "coworker", slug: member.slug, createdAt: member.createdAt, name: member.name, key: `coworker:${member.slug}:${member.createdAt}` })),
    ...liveGroups.map((group): DocumentOwner => ({ kind: "group", groupId: group.id, createdAt: group.createdAt, name: group.name, key: `group:${group.id}:${group.createdAt}`, event: Boolean(group.eventId) })),
  ];
  const current = useRef({ active, scope, owners });
  current.current = { active, scope, owners };
  const previous = useRef<DocumentSnapshot>({ scope, documents: {}, errors: {} });
  const [snapshot, setSnapshot] = useState<DocumentSnapshot>(previous.current);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);
  const queued = useRef<(() => void) | null>(null);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    if (previous.current.scope !== scope) {
      previous.current = { scope, documents: {}, errors: {} };
      setSnapshot(previous.current);
    }
    const valid = () => !cancelled && current.current.active && current.current.scope === scope;
    const load = () => {
      if (!valid()) return;
      if (inFlight.current) {
        queued.current = load;
        return;
      }
      inFlight.current = true;
      setRefreshing(true);
      const sources = current.current.owners;
      const next: DocumentSnapshot = { scope, documents: {}, errors: {} };
      void (async () => {
        try {
          for (let offset = 0; offset < sources.length && valid(); offset += 4) {
            await Promise.all(sources.slice(offset, offset + 4).map(async (owner) => {
              try {
                const documents = owner.kind === "coworker"
                  ? await coworkerBridge.documents.list(owner.slug)
                  : await coworkerBridge.groups.documents.list(owner.groupId);
                if (!valid()) return;
                next.documents[owner.key] = documents.filter((document) => document.status !== "archived");
              } catch {
                if (!valid()) return;
                const known = previous.current.scope === scope ? previous.current.documents[owner.key] ?? [] : [];
                next.documents[owner.key] = known;
                next.errors[owner.key] = `Documents for ${owner.name} could not be refreshed. ${known.length ? "Last loaded metadata is still shown." : "No metadata is available yet."}`;
              }
            }));
          }
          if (!valid()) return;
          previous.current = next;
          setSnapshot(next);
        } finally {
          inFlight.current = false;
          if (valid()) setRefreshing(false);
          const pending = queued.current;
          queued.current = null;
          pending?.();
        }
      })();
    };
    refresh.current = load;
    if (!active) {
      setRefreshing(false);
      return () => { cancelled = true; };
    }
    load();
    const timer = window.setInterval(() => { if (!inFlight.current) load(); }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (refresh.current === load) refresh.current = () => {};
    };
  }, [active, scope]);

  const entries: HistoryEntry[] = [];
  if (snapshot.scope === scope) {
    for (const owner of owners) {
      for (const document of snapshot.documents[owner.key] ?? []) {
        const target: ActivityDocumentTarget = owner.kind === "coworker"
          ? { kind: "coworker", slug: owner.slug, createdAt: owner.createdAt, documentId: document.id, title: document.title, revision: document.revision }
          : { kind: "group", groupId: owner.groupId, createdAt: owner.createdAt, documentId: document.id, title: document.title, revision: document.revision };
        entries.push({
          kind: "document", category: "documents", target,
          id: owner.kind === "coworker" ? `document:coworker:${owner.slug}:${owner.createdAt}:${document.id}` : `document:group:${owner.groupId}:${owner.createdAt}:${document.id}`,
          at: document.updatedAt || document.createdAt,
          title: document.title,
          location: `${owner.name} · ${owner.kind === "coworker" ? "Documents" : owner.event ? "Event documents" : "Group documents"}`,
          label: document.updatedAt > document.createdAt ? "Document updated" : "Document created",
          preview: document.summary,
        });
      }
    }
  }
  return { entries, errors: snapshot.scope === scope ? snapshot.errors : {}, refreshing, refresh: () => refresh.current() };
}

function ReadIcon({ read }: { read: boolean }) {
  return (
    <svg className="size-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {read ? <path d="m4 10 4 4 8-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /> : (
        <>
          <rect x="2.5" y="4.5" width="15" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
          <path d="m3 5.5 7 5 7-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg className="size-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M16 8a6.25 6.25 0 1 0 .15 3.5M16 3.5V8h-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Which conversation an activity item belongs to, so its replies share one row. */
function conversationKey(item: Exclude<CoworkerActivityItem, { kind: "event-reminder" }>): string {
  return item.target.kind === "private" ? `private:${item.slug}:${item.coworkerCreatedAt}:${item.target.threadId}` : `group:${item.target.groupId}`;
}

/** A one-line plain reading of a reply's Markdown for the preview line. */
function plainPreview(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_~>#]+/g, "").replace(/^\s*[-+]\s+/gm, "").replace(/\s+/g, " ").trim();
}

function dateBucket(at: number, now: Date): { key: string; label: string } {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return { key: "unknown", label: "Date unavailable" };
  const key = date.toDateString();
  if (key === now.toDateString()) return { key, label: "Today" };
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === yesterday.toDateString()) return { key, label: "Yesterday" };
  return { key, label: date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }) };
}

function eventTime(at: number): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Time unavailable";
}

function eventKey(target: CalendarEventTarget): string {
  return `event:${target.eventId}:${target.at ?? ""}:${target.runId ?? ""}`;
}

function HistoryRow({ entry, selected, disabled, activity, onOpen, onMarkRead, onOpenEvent }: {
  entry: HistoryEntry;
  selected: boolean;
  disabled: boolean;
  activity?: CoworkerActivity;
  onOpen: () => void;
  onMarkRead: () => void;
  onOpenEvent: (target: CalendarEventTarget) => void;
}) {
  const unreadCount = entry.kind === "activity" ? entry.thread.filter((item) => item.readAt === null).length : 0;
  const unread = unreadCount > 0;
  const reminder = entry.kind === "activity" && entry.item.kind === "event-reminder";
  const date = new Date(entry.at);
  const validDate = Number.isFinite(date.getTime());
  const currentConversation = entry.kind === "activity" && entry.item.target.kind === "private" && activity?.threadId === entry.item.target.threadId;
  const status = currentConversation && activity && activity.state !== "ready" && activity.state !== "recent" ? describeHeaderStatus(activity, true).word : "";
  const coworker = entry.coworker;
  const preview = plainPreview(entry.preview) || (entry.kind === "document" ? "Open the saved document." : "Open the conversation to read the message.");
  // "Builder replied" reads as "replied" beside the name already shown above it.
  const action = coworker && entry.label.startsWith(`${coworker.name} `) ? entry.label.slice(coworker.name.length + 1) : entry.label;
  const where = [entry.location, status ? `Now: ${status}` : action].filter(Boolean).join(" · ");
  return (
    <li data-testid={reminder ? "event-reminder" : entry.kind === "document" ? "activity-document" : "coworker-activity-row"} data-activity-id={entry.id} data-thread-count={entry.kind === "activity" ? entry.thread.length : undefined} className={`group/row relative flex min-w-0 items-center rounded-lg ${selected ? "bg-spark/15 ring-1 ring-inset ring-spark/30" : unread ? "bg-spark/5" : ""}`}>
      <button type="button" disabled={disabled} onClick={onOpen} aria-current={selected ? "page" : undefined} title={`${entry.title} · ${entry.location}${unread ? " · Unread" : ""}`} className={`flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/4 disabled:cursor-wait ${FOCUS}`}>
        <span className="sr-only">{entry.kind === "document" ? "Open document. " : reminder ? "Open event. " : "Open conversation. "}</span>
        {coworker ? <span aria-hidden="true" className="mt-0.5 shrink-0"><CoworkerAvatar identity={coworker.slug} name={coworker.name} color={coworker.avatarColor} glasses={coworker.avatarGlasses} size={22} animated={false} gaze={false} /></span> : null}
        <span className="block min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className={`min-w-0 truncate text-xs leading-5 text-snow ${unread ? "font-semibold" : "font-medium"}`}>{entry.title}</span>
            {unreadCount > 1 ? <span className="shrink-0 rounded-full bg-spark/20 px-1.5 text-[10px] font-semibold leading-4 text-spark" data-testid="activity-thread-count">{unreadCount} new</span> : unread ? <span aria-hidden="true" className="size-1.5 shrink-0 self-center rounded-full bg-spark" /> : null}
            <time dateTime={validDate ? date.toISOString() : undefined} title={validDate ? date.toLocaleString() : undefined} className="ml-auto shrink-0 text-[10px] tabular-nums text-mist">{validDate ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "—"}</time>
          </span>
          <span className="block truncate text-[10.5px] leading-4 text-mist" data-testid={status ? "coworker-activity-chip" : undefined}>{where}{unread ? <span className="sr-only"> · Unread</span> : null}</span>
          <span className={`block truncate text-[11px] leading-4 ${unread ? "text-snow/85" : "text-mist"}`}>{preview}</span>
        </span>
      </button>
      {entry.kind === "activity" ? <div className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
        <IconButton label={`${unread ? "Mark as read" : "Mark as unread"}: ${entry.title}, ${entry.location}`} tooltip={unread ? "Mark as read" : "Mark as unread"} disabled={disabled} onClick={onMarkRead} className={`min-h-7 min-w-7 ${FOCUS} ${unread ? "text-spark" : "text-mist"}`}><ReadIcon read={unread} /></IconButton>
        {entry.eventTarget ? <IconButton label={`${entry.eventTarget.runId ? "View session" : "View event"}: ${entry.title}`} tooltip={entry.eventTarget.runId ? "View this Event session" : "View event in Calendar"} disabled={disabled} onClick={() => { if (entry.eventTarget) onOpenEvent(entry.eventTarget); }} className={`min-h-7 min-w-7 ${FOCUS}`}><CalendarIcon /></IconButton> : null}
      </div> : null}
    </li>
  );
}

function EventSections({ calendar, coworkers, selectedId, onOpenEvent, onOpenCalendar, onNewEvent }: Pick<ActivityInboxProps, "calendar" | "coworkers" | "selectedId" | "onOpenEvent" | "onOpenCalendar" | "onNewEvent">) {
  const [upcomingExpanded, setUpcomingExpanded] = useState(false);
  const [liveExpanded, setLiveExpanded] = useState(true);
  const upcomingId = useId();
  const liveId = useId();
  const now = Date.now();
  const live = [...new Map(calendar.eventRuns.filter(eventRunIsLive).map((run) => [run.id, run])).values()].sort((a, b) => b.scheduledFor - a.scheduledFor);
  const liveOccurrences = new Set(live.map((run) => `${run.eventId}:${run.scheduledFor}`));
  const upcoming = calendarItems({ events: calendar.events, eventRuns: calendar.eventRuns, responsibilities: [], start: now - 86400000, end: now + 7 * 86400000, now })
    .filter((item) => item.planned && !liveOccurrences.has(`${item.eventId}:${item.startsAt}`)).slice(0, 3);
  const bySlug = new Map(coworkers.map((member) => [member.slug, member]));
  const rowClass = (target: CalendarEventTarget) => `block min-h-11 w-full min-w-0 rounded-lg px-2 py-2 text-left hover:bg-white/5 ${FOCUS} ${selectedId === eventKey(target) ? "bg-spark/15 ring-1 ring-inset ring-spark/30" : ""}`;
  return (
    <div className="border-b border-line/60 px-2 py-1">
      {calendar.errors.length ? <p role="status" className="px-1 py-2 text-[11px] leading-4 text-amber">Calendar updates are incomplete. Events may be a previous snapshot. <button type="button" className={`min-h-8 rounded px-1 underline ${FOCUS}`} onClick={() => void calendar.refresh()}>Refresh Calendar</button></p> : null}
      {live.length ? <section aria-label="Live Events" data-testid="activity-live-events">
        <button type="button" aria-expanded={liveExpanded} aria-controls={liveId} onClick={() => setLiveExpanded(!liveExpanded)} className={`flex min-h-8 w-full items-center gap-1.5 rounded px-1 text-xs font-medium text-snow ${FOCUS}`}><ChevronIcon direction="right" className={`size-3 ${liveExpanded ? "rotate-90" : ""}`} />Live Events <span className="text-[10px] text-mist">{live.length}</span></button>
        <div id={liveId} hidden={!liveExpanded} className="max-h-40 overflow-y-auto overscroll-contain">
          <ul>{live.map((run) => {
            const target = { eventId: run.eventId, runId: run.id, at: run.scheduledFor };
            const state = run.stopping ? "Stopping · awaiting confirmation" : run.status === "queued" ? "Queued" : run.status === "waiting" ? "Waiting on work or input" : run.phase === "conclusion" ? "Preparing the session recap" : "In progress";
            return <li key={run.id}><button type="button" onClick={() => onOpenEvent(target)} aria-current={selectedId === eventKey(target) ? "page" : undefined} className={rowClass(target)}>
              <span className="sr-only">View Event session. </span><span className="block truncate text-xs font-medium text-snow">{run.event.title}</span>
              <span className={`block text-[11px] ${run.status === "waiting" ? "text-amber" : "text-spark"}`}>{calendar.errors.length ? "Last known: " : ""}{state}</span>
              <span className="block truncate text-[11px] text-mist">Owner: {bySlug.get(run.event.leadSlug)?.name ?? run.event.leadSlug}</span>
              <span className="block text-[10px] text-mist">{eventTime(run.scheduledFor)}</span>
            </button></li>;
          })}</ul>
        </div>
      </section> : null}
      <section aria-label="Upcoming Events" data-testid="activity-upcoming-events">
        <div className="flex items-center justify-between gap-1">
          <button type="button" aria-expanded={upcomingExpanded} aria-controls={upcomingId} onClick={() => setUpcomingExpanded(!upcomingExpanded)} className={`flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-xs font-medium text-snow ${FOCUS}`}><ChevronIcon direction="right" className={`size-3 ${upcomingExpanded ? "rotate-90" : ""}`} />Up next<span className="text-[10px] font-normal text-mist">Next 7 days</span></button>
          <Button variant="ghost" className={`min-h-8 px-1.5 text-[11px] ${FOCUS}`} onClick={onOpenCalendar}>Calendar</Button>
        </div>
        <div id={upcomingId} hidden={!upcomingExpanded} className="max-h-48 overflow-y-auto overscroll-contain">
          {calendar.loading && !upcoming.length ? <p role="status" className="px-2 py-2 text-xs text-mist">Loading upcoming Events…</p> : upcoming.length ? <ul>
            {upcoming.map((item) => {
              if (!item.eventId) return null;
              const target = { eventId: item.eventId, at: item.startsAt };
              return <li key={item.id}><button type="button" onClick={() => onOpenEvent(target)} aria-current={selectedId === eventKey(target) ? "page" : undefined} className={rowClass(target)}>
                <span className="sr-only">View event in Calendar. </span><span className="block truncate text-xs font-medium text-snow">{item.title}</span>
                <time dateTime={new Date(item.startsAt).toISOString()} className="block text-[10px] leading-4 text-mist">{eventTime(item.startsAt)}</time>
                {item.status === "due" ? <span className="block text-[11px] text-amber">Due · waiting to start</span> : null}
                <span className="block truncate text-[11px] leading-4 text-mist">Owner: {bySlug.get(item.ownerSlug ?? "")?.name ?? item.ownerSlug}</span>
              </button></li>;
            })}
          </ul> : <p className="px-2 py-2 text-xs text-mist">No Events scheduled in the next week.</p>}
          <Button variant="ghost" className={`mb-1 min-h-8 text-[11px] ${FOCUS}`} onClick={onNewEvent}>New event</Button>
        </div>
      </section>
    </div>
  );
}

export function ActivityInbox({ active, selectedId, items, loading, error, busy, coworkers, groups, activityBySlug, onRefresh, onMarkRead, onOpen, onOpenDocument, calendar, onOpenEvent, onOpenCalendar, onNewEvent }: ActivityInboxProps) {
  // Without Calendar, Activity has no event sections, reminders or Events filter.
  const { calendar: calendarEnabled } = useFeatures();
  const filters = calendarEnabled ? FILTERS : FILTERS.filter(({ id }) => id !== "events");
  const [chosenFilter, setFilter] = useState<Filter>("all");
  const filter: Filter = !calendarEnabled && chosenFilter === "events" ? "all" : chosenFilter;
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState(false);
  const actionInFlight = useRef(false);
  const titleId = useId();
  const feedId = useId();
  const documents = useActivityDocuments(active, coworkers, groups);
  const bySlug = new Map(coworkers.map((coworker) => [coworker.slug, coworker]));
  const byGroup = new Map(groups.filter((group) => !group.archivedAt).map((group) => [group.id, group]));
  const unreadIds = items.filter((item) => item.readAt === null && (calendarEnabled || item.kind !== "event-reminder")).map((item) => item.id);
  const histories: HistoryEntry[] = [...documents.entries];
  for (const item of items) {
    if (item.kind === "event-reminder") {
      if (!calendarEnabled) continue;
      histories.push({ kind: "activity", category: "events", item, thread: [item], id: item.id, at: item.at, title: item.title, location: `Event · ${eventTime(item.target.scheduledFor)}`, label: "Event reminder", preview: item.preview });
      continue;
    }
    const coworker = bySlug.get(item.slug);
    if (!coworker || coworker.createdAt !== item.coworkerCreatedAt || coworker.workspaceId !== item.workspaceId) continue;
    const group = item.target.kind === "group" ? byGroup.get(item.target.groupId) : undefined;
    if (item.target.kind === "group" && (!group || !group.participantSlugs.includes(item.slug))) continue;
    const eventTarget = group && item.target.kind === "group" ? groupEventTarget(group, calendar.events, item.target.workplaceEventId ? {
      groupId: group.id, eventId: item.target.workplaceEventId, runId: item.target.runId, at: item.target.scheduledFor,
    } : undefined) : undefined;
    const event = eventTarget ? eventForTarget(calendar.events, calendar.eventRuns, eventTarget) : undefined;
    const workplaceEventId = eventTarget?.eventId;
    histories.push({
      kind: "activity", category: workplaceEventId ? "events" : "chats", item, thread: [item], id: item.id, at: item.at,
      title: workplaceEventId ? event?.title || group?.name || coworker.name : coworker.name,
      location: item.target.kind === "private" ? "Private chat" : `${workplaceEventId ? "Event" : "Group"} · ${group?.name || "Group chat"}`,
      label: `${coworker.name} ${item.kind === "mention" ? "mentioned you" : "replied"}`,
      preview: item.preview.trim(), coworker, eventTarget,
    });
  }
  // New replies in one conversation fold into its one row, newest on top.
  const threads = new Map<string, HistoryEntry>();
  const entries: HistoryEntry[] = [];
  for (const entry of histories.sort((a, b) => b.at - a.at)) {
    const key = entry.kind === "activity" && entry.item.kind !== "event-reminder" ? conversationKey(entry.item) : "";
    const existing = key ? threads.get(key) : undefined;
    if (existing?.kind === "activity" && entry.kind === "activity") { existing.thread.push(entry.item); continue; }
    if (key) threads.set(key, entry);
    entries.push(entry);
  }
  const search = query.trim().toLocaleLowerCase();
  const matching = entries.filter((entry) => {
    if (unreadOnly && (entry.kind !== "activity" || !entry.thread.some((item) => item.readAt === null))) return false;
    if (filter === "mentions" ? entry.kind !== "activity" || !entry.thread.some((item) => item.kind === "mention") : filter !== "all" && entry.category !== filter) return false;
    return !search || `${entry.title} ${entry.location} ${entry.label} ${entry.preview}`.toLocaleLowerCase().includes(search);
  }).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const visible = filter === "all" || filter === "documents" ? matching.slice(0, RECENT_LIMIT) : matching;
  const sections = new Map<string, { label: string; entries: HistoryEntry[] }>();
  const now = new Date();
  for (const entry of visible) {
    const bucket = dateBucket(entry.at, now);
    const section = sections.get(bucket.key);
    if (section) section.entries.push(entry);
    else sections.set(bucket.key, { label: bucket.label, entries: [entry] });
  }
  const disabled = busy || pending;
  async function act(action: () => Promise<void>, fallback: string) {
    if (actionInFlight.current || busy) return;
    actionInFlight.current = true;
    setPending(true);
    setActionError("");
    try { await action(); }
    catch (cause) { setActionError(cause instanceof Error && cause.message ? `${fallback} ${cause.message}` : fallback); }
    finally { actionInFlight.current = false; setPending(false); }
  }
  const refresh = () => {
    setActionError("");
    onRefresh();
    documents.refresh();
    if (calendarEnabled) void calendar.refresh();
  };

  return (
    <aside aria-labelledby={titleId} hidden={!active} className={`glass-main h-full min-h-0 w-full min-w-0 max-w-[380px] flex-1 flex-col text-snow ${active ? "flex" : "hidden"}`} data-testid="activity-inbox">
      <header className="shrink-0 border-b border-line/70 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <h1 id={titleId} className="text-sm font-semibold">Activity</h1>
          <div className="flex items-center gap-1">
            <button type="button" data-testid="activity-unread-filter" aria-pressed={unreadOnly} aria-controls={feedId} onClick={() => setUnreadOnly(!unreadOnly)} title="Show only unread notifications. Documents have no unread state." className={`min-h-8 rounded-lg px-2 text-[11px] ${FOCUS} ${unreadOnly ? "bg-spark/15 text-spark" : "text-mist hover:bg-white/5"}`}>Unread <span className="tabular-nums">{unreadIds.length}</span></button>
            <IconButton label={loading || documents.refreshing ? "Refreshing activity" : "Refresh activity"} disabled={loading || documents.refreshing || disabled} onClick={refresh} aria-busy={loading || documents.refreshing} className={`min-h-8 min-w-8 ${FOCUS}`}><RefreshIcon /></IconButton>
          </div>
        </div>
        <input type="search" aria-label="Search activity" placeholder="Search activity" value={query} onChange={(event) => setQuery(event.target.value)} className={`${inputClass} mt-2 min-h-8 rounded-lg px-2 py-1.5 text-xs`} />
        <div role="group" aria-label="Filter activity" className="mt-1.5 flex flex-wrap gap-0.5">
          {filters.map(({ id, label }) => <button key={id} type="button" aria-pressed={filter === id} aria-controls={feedId} onClick={() => setFilter(id)} className={`min-h-8 rounded-md px-1.5 text-[11px] ${FOCUS} ${filter === id ? "bg-white/8 font-semibold text-snow" : "text-mist hover:bg-white/4 hover:text-snow"}`}>{label}</button>)}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {calendarEnabled ? <EventSections calendar={calendar} coworkers={coworkers} selectedId={selectedId} onOpenEvent={onOpenEvent} onOpenCalendar={onOpenCalendar} onNewEvent={onNewEvent} /> : null}
        <div id={feedId} className="px-2 pb-3">
          <div className="flex items-center justify-between gap-1 py-1">
            <h2 className="px-1 text-[11px] font-medium text-mist">Recent activity</h2>
            <Button type="button" variant="ghost" className={`min-h-8 px-1.5 text-[11px] ${FOCUS}`} title="Mark all native notifications as read, across every filter" disabled={!unreadIds.length || disabled} aria-busy={busy} onClick={() => void act(() => onMarkRead([...unreadIds], true), "Could not mark all as read.")}>Mark all read</Button>
          </div>
          <p role="status" aria-live="polite" className="sr-only">{loading && !items.length ? "Loading activity." : `${visible.length} entries in this view. ${unreadIds.length} unread notifications in total.`}</p>
          {actionError || error ? <p role="alert" className="mb-2 rounded-lg border border-amber/25 bg-amber/5 px-2 py-2 text-[11px] leading-4 text-amber [overflow-wrap:anywhere]">{actionError || error}{error && items.length ? " Last loaded activity is still shown." : ""}</p> : null}
          {Object.entries(documents.errors).map(([key, warning]) => <p key={key} role="status" data-document-scope={key} className="mb-2 rounded-lg border border-amber/20 px-2 py-2 text-[11px] leading-4 text-amber">{warning}</p>)}
          {(loading || documents.refreshing) && !visible.length ? <p role="status" className="px-2 py-4 text-xs text-mist">Loading activity…</p> : !visible.length ? <p className="px-2 py-4 text-xs leading-5 text-mist">{unreadOnly && filter === "documents" ? "Documents have no unread state. Turn off Unread to browse saved documents." : search ? "No activity matches your search." : unreadOnly ? "No unread notifications in this view." : filter === "documents" ? "No saved documents to show." : "No activity in this view yet."}</p> : null}
          {[...sections.entries()].map(([key, section], index) => <section key={key} aria-labelledby={`${feedId}-${index}`}>
            <h3 id={`${feedId}-${index}`} className="px-2 pb-1 pt-2 text-[10px] font-medium text-mist">{section.label}</h3>
            <ul className="space-y-0.5">{section.entries.map((entry) => <HistoryRow key={entry.id} entry={entry} selected={selectedId === entry.id} disabled={disabled} activity={entry.coworker ? activityBySlug[entry.coworker.slug] : undefined}
              onOpen={() => void act(() => entry.kind === "document" ? onOpenDocument(entry.target) : onOpen(entry.item), entry.kind === "document" ? "Could not open this document." : "Could not open this conversation.")}
              onMarkRead={() => {
                if (entry.kind !== "activity") return;
                const unreadInThread = entry.thread.filter((item) => item.readAt === null).map((item) => item.id);
                void act(() => unreadInThread.length ? onMarkRead(unreadInThread, true) : onMarkRead([entry.item.id], false), "Could not update read status.");
              }} onOpenEvent={onOpenEvent} />)}</ul>
          </section>)}
          {matching.length > visible.length ? <p className="px-2 pt-3 text-[11px] text-mist">Showing the most recent {RECENT_LIMIT} matches. Search to narrow the history.</p> : null}
        </div>
      </div>
    </aside>
  );
}
