import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CoworkerGroupSummary, CoworkerSummary, RuntimeInfo } from "@/lib/bridge";
import { describeRailLine } from "@/lib/rail-status";
import type { DenSession } from "@/lib/den";
import type { CoworkerActivity } from "@/lib/threads";
import { CoworkerMark } from "@/ui/brand";
import { CoworkerAvatar, GroupAvatars } from "@/ui/coworker-avatar";
import { Button, IconButton, PlusIcon, SearchIcon, SlidersIcon, StatusDot, Tooltip } from "@/ui/kit";
import type { ResizablePanel } from "@/ui/use-resizable-panel";
import { CalendarIcon, MainContentSwitch, type MainContent } from "@/ui/main-content-switch";
import { CalendarSidebar } from "@/ui/calendar-sidebar";
import type { CalendarData } from "@/ui/calendar-data";
import type { CalendarPreferences, CalendarPreferencesChange } from "@/ui/calendar-preferences";

/** Identity keeps its personality; execution status only describes observed work. */
function RailStatusLabel({ activity }: { coworker: CoworkerSummary; activity: CoworkerActivity | undefined }) {
  return <span>{activity?.label ?? "Checking status"}</span>;
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return "";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

type Tone = "spark" | "ready" | "amber" | "rose" | "mist";

function activityTone(activity: CoworkerActivity | undefined): Tone {
  if (activity?.state === "working") return "spark";
  if (activity?.state === "retrying" || activity?.state === "attention") return "amber";
  if (activity?.state === "offline") return "rose";
  if (activity?.label === "Ready") return "ready";
  return "mist";
}

function activityTextTone(activity: CoworkerActivity | undefined): string {
  if (activity?.state === "working") return "text-spark";
  if (activity?.state === "retrying" || activity?.state === "attention") return "text-amber";
  if (activity?.state === "offline") return "text-rose";
  if (activity?.label === "Ready") return "text-ready";
  return "text-mist";
}

const DOT_BG: Record<Tone, string> = { spark: "bg-spark", ready: "bg-ready", amber: "bg-amber", rose: "bg-rose", mist: "bg-mist" };

export function CoworkerRail({
  coworkers,
  runtime,
  session,
  activityBySlug,
  selectedSlug,
  panel,
  onSelect,
  onNewCoworker,
  onOpenOpenWork,
  groups = [],
  groupLines = {},
  groupActiveSlugs = {},
  selectedGroupId = "",
  onSelectGroup,
  onNewGroup,
  onOpenCalendar,
  eventGroupIds,
  mainContent,
  onMainContentChange,
  chatAvailable,
  calendarData,
  calendarPreferences,
  onCalendarPreferencesChange,
}: {
  calendarData: CalendarData;
  calendarPreferences: CalendarPreferences;
  onCalendarPreferencesChange: CalendarPreferencesChange;
  mainContent: MainContent;
  onMainContentChange: (value: MainContent) => void;
  chatAvailable: boolean;
  onOpenCalendar: (slug: string) => void;
  eventGroupIds: ReadonlySet<string>;
  coworkers: CoworkerSummary[];
  runtime: RuntimeInfo;
  session: DenSession | null;
  activityBySlug: Record<string, CoworkerActivity>;
  selectedSlug: string;
  /** Width, collapse state, and the separator for this edge; owned by the shell. */
  panel: ResizablePanel;
  onSelect: (slug: string) => void;
  onNewCoworker: () => void;
  onOpenOpenWork: () => void;
  /** Group chats (several coworkers in one conversation), newest first, archived ones excluded. */
  groups?: CoworkerGroupSummary[];
  /** One plain line per group: the latest activity, when known. */
  groupLines?: Record<string, string>;
  groupActiveSlugs?: Record<string, string[]>;
  selectedGroupId?: string;
  onSelectGroup?: (id: string) => void;
  onNewGroup?: () => void;
}) {
  const bySlug = new Map(coworkers.map((coworker) => [coworker.slug, coworker]));
  const membersOf = (group: CoworkerGroupSummary) => group.participantSlugs.map((slug) => bySlug.get(slug)).filter((member): member is CoworkerSummary => Boolean(member));
  const [query, setQuery] = useState("");
  const [calendarQuery, setCalendarQuery] = useState("");
  const [showGroupFilters, setShowGroupFilters] = useState(false);
  const filterMenuId = useId();
  const filterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const [filterPosition, setFilterPosition] = useState<{ left: number; top: number } | null>(null);
  const [groupTypes, setGroupTypes] = useState(() => {
    try {
      const value: unknown = JSON.parse(window.localStorage.getItem("coworker.rail.group-types.v1") ?? "null");
      if (value && typeof value === "object" && "groups" in value && "events" in value && typeof value.groups === "boolean" && typeof value.events === "boolean") return { groups: value.groups, events: value.events };
    } catch { /* An unavailable preference store keeps both kinds visible. */ }
    return { groups: true, events: true };
  });
  useEffect(() => { try { window.localStorage.setItem("coworker.rail.group-types.v1", JSON.stringify(groupTypes)); } catch { /* Filtering still works without storage. */ } }, [groupTypes]);
  const visibleGroups = groups.filter((group) => !group.archivedAt && (group.eventId || eventGroupIds.has(group.id) ? groupTypes.events : groupTypes.groups) && (!query.trim() || group.name.toLowerCase().includes(query.trim().toLowerCase())));
  const [peek, setPeek] = useState<{ slug: string; top: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [focusSearchOnExpand, setFocusSearchOnExpand] = useState(false);
  // The folded rail's search icon unfolds the rail and lands the cursor in the search box.
  useEffect(() => {
    if (panel.collapsed || !focusSearchOnExpand) return;
    searchRef.current?.focus();
    setFocusSearchOnExpand(false);
  }, [focusSearchOnExpand, panel.collapsed]);
  const visibleCoworkers = coworkers.filter((coworker) =>
    `${coworker.name} ${coworker.role}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const collapsed = panel.collapsed;
  const calendarMode = mainContent === "calendar";

  function closeGroupFilters(restoreFocus = false) {
    setShowGroupFilters(false);
    setFilterPosition(null);
    if (restoreFocus && filterTriggerRef.current?.isConnected) filterTriggerRef.current.focus({ preventScroll: true });
  }

  function openGroupFilters(trigger: HTMLButtonElement) {
    if (calendarMode) return;
    filterTriggerRef.current = trigger;
    if (showGroupFilters) {
      filterMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')?.focus({ preventScroll: true });
      return;
    }
    setFilterPosition(null);
    setShowGroupFilters(true);
  }

  useLayoutEffect(() => {
    if (!calendarMode) return;
    closeGroupFilters();
    setPeek(null);
  }, [calendarMode]);

  useLayoutEffect(() => {
    if (!showGroupFilters || calendarMode) return;
    const trigger = filterTriggerRef.current;
    const menu = filterMenuRef.current;
    if (!trigger?.isConnected || !menu) { closeGroupFilters(); return; }
    const anchor = trigger.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const left = collapsed ? anchor.right + 6 : anchor.right - size.width;
    const top = anchor.bottom + 6 + size.height <= window.innerHeight - 8 ? anchor.bottom + 6 : anchor.top - size.height - 6;
    setFilterPosition({ left: Math.max(8, Math.min(left, window.innerWidth - size.width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - size.height - 8)) });
  }, [showGroupFilters, collapsed, panel.width, calendarMode]);

  const filtersPositioned = filterPosition !== null;
  useLayoutEffect(() => {
    if (showGroupFilters && filtersPositioned && !calendarMode) filterMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')?.focus({ preventScroll: true });
  }, [showGroupFilters, filtersPositioned, calendarMode]);

  useEffect(() => {
    if (!showGroupFilters || calendarMode) return;
    const outside = (event: PointerEvent | FocusEvent) => {
      if (!(event.target instanceof Node) || filterMenuRef.current?.contains(event.target) || filterTriggerRef.current?.contains(event.target)) return;
      closeGroupFilters(event.type === "pointerdown" && Boolean(filterMenuRef.current?.contains(document.activeElement)));
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeGroupFilters(true);
    };
    const moved = (event: Event) => {
      if (event.target instanceof Node && filterMenuRef.current?.contains(event.target)) return;
      closeGroupFilters(Boolean(filterMenuRef.current?.contains(document.activeElement)));
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("focusin", outside);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("focusin", outside);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [showGroupFilters, calendarMode]);
  const peeked = peek ? coworkers.find((coworker) => coworker.slug === peek.slug) : undefined;
  const accountName = session ? session.userName.trim() || session.userEmail.trim() || "Your account" : "Open Coworker";
  const accountLabel = session
    ? session.orgName.trim() || "OpenWork account"
    : coworkers.length === 0 ? "Setup in progress" : runtime.engineManaged ? "Local mode" : "AI unavailable";
  const accountInitials = (session?.userName.trim() || session?.userEmail.trim() || "OpenWork")
    .split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join("").toLocaleUpperCase();
  const accountDescription = `${accountName} · ${accountLabel} · Account and settings`;
  const filterControl = <IconButton label="Filter group chats and events" tooltipSide="right" aria-haspopup="menu" aria-expanded={showGroupFilters} aria-controls={showGroupFilters ? filterMenuId : undefined} data-testid="group-filter-trigger" className={!groupTypes.groups || !groupTypes.events ? "text-spark" : ""} onClick={(event) => showGroupFilters ? closeGroupFilters(true) : openGroupFilters(event.currentTarget)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); openGroupFilters(event.currentTarget); } }}>
    <svg className="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" aria-hidden="true"><path d="M2 3h12L9.5 8v4.25l-3 1V8L2 3Z" /></svg>
  </IconButton>;

  return (
    <aside
      className={`glass-rail relative z-20 flex h-full shrink-0 flex-col border-r border-line ${panel.resizing ? "" : "transition-[width] duration-200"}`}
      style={{ width: panel.width }}
      data-testid="coworker-rail"
      data-collapsed={collapsed ? "true" : "false"}
    >
      {/* Keep both navigation rows below the native window controls, including when folded. */}
      <div className={`glass-header window-drag flex shrink-0 flex-col gap-2 border-b border-line pb-2 pt-10 ${collapsed ? "px-2" : "px-3"}`}>
        <MainContentSwitch value={mainContent} onChange={onMainContentChange} chatAvailable={chatAvailable} compact={collapsed} />
        {!calendarMode || !collapsed || coworkers.length === 0 ? <div className={`flex items-center ${collapsed ? "justify-center gap-1" : "gap-2"}`}>
          {collapsed ? <>
            {!calendarMode ? <IconButton label="Search coworkers" className="window-no-drag" data-testid="coworker-rail-search" onClick={() => { setFocusSearchOnExpand(true); panel.expand(); }}><SearchIcon /></IconButton> : null}
            <IconButton label="New coworker" className="window-no-drag" onClick={onNewCoworker}><PlusIcon /></IconButton>
          </> : <>
            <input ref={searchRef} aria-label={calendarMode ? "Search calendars" : "Search coworkers"} className="window-no-drag h-8 min-w-0 flex-1 rounded-lg border border-line bg-black/18 px-2.5 text-xs text-snow outline-none placeholder:text-mist/70 focus:border-spark/50 focus:bg-black/28" placeholder={calendarMode ? "Search calendars" : "Search coworkers"} value={calendarMode ? calendarQuery : query} onChange={(event) => calendarMode ? setCalendarQuery(event.target.value) : setQuery(event.target.value)} />
            {!calendarMode || coworkers.length === 0 ? <Button variant="ghost" className="window-no-drag size-8 shrink-0 rounded-lg px-0 py-0 text-lg" onClick={onNewCoworker} title="New coworker" aria-label="New coworker"><span aria-hidden="true">+</span></Button> : null}
          </>}
        </div> : null}
      </div>
      <div className={calendarMode ? "hidden" : "flex min-h-0 flex-1 flex-col"} data-testid="chat-rail-content">
      {collapsed ? (
        <>
          <nav aria-label="Coworkers" className="flex flex-1 flex-col items-center gap-1 overflow-y-auto px-1 pb-4 pt-3">
            {coworkers.map((coworker) => {
              const activity = activityBySlug[coworker.slug];
              const active = coworker.slug === selectedSlug;
              const tone = activityTone(activity);
              const show = (target: HTMLElement) => setPeek({ slug: coworker.slug, top: target.getBoundingClientRect().top });
              return (
                <div key={coworker.slug} className="group/rail-person relative flex size-14 shrink-0 items-center justify-center">
                <button
                  type="button"
                  aria-label={coworker.name}
                  aria-current={active ? "true" : undefined}
                  data-testid="coworker-rail-avatar"
                  data-slug={coworker.slug}
                  data-active={active ? "true" : "false"}
                  onClick={() => onSelect(coworker.slug)}
                  onPointerEnter={(event) => show(event.currentTarget)}
                  onPointerLeave={() => setPeek(null)}
                  onFocus={(event) => show(event.currentTarget)}
                  onBlur={() => setPeek(null)}
                  className={`coworker-rail-person window-no-drag relative flex size-14 shrink-0 items-center justify-center rounded-xl transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${
                    active ? "bg-white/8 ring-1 ring-white/10" : "hover:bg-white/5 group-hover/rail-person:bg-white/5"
                  }`}
                >
                  {active ? <span aria-hidden="true" className="absolute -left-3 top-4 h-6 w-[3px] rounded-full bg-spark" /> : null}
                  <CoworkerAvatar
                    identity={coworker.slug}
                    motion="navigation"
                    color={coworker.avatarColor}
                    glasses={coworker.avatarGlasses}
                    name={coworker.name}
                    size={44}
                    working={activity?.state === "working"}
                  />
                  <span
                    aria-hidden="true"
                    data-testid="coworker-rail-indicator"
                    data-tone={tone}
                    className={`absolute bottom-1.5 right-1.5 size-2.5 rounded-full ring-2 ring-[rgb(7_10_15)] ${DOT_BG[tone]} ${activity?.state === "working" ? "animate-pulse" : ""}`}
                  />
                </button>
                <Tooltip content={`Open ${coworker.name}'s calendar`} side="right">
                  <button type="button" aria-label={`Open ${coworker.name}'s calendar`} className="window-no-drag absolute bottom-1 left-0 inline-flex size-4 items-center justify-center rounded bg-ink/80 text-mist hover:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 [&>svg]:size-[14px]" onClick={(event) => { event.stopPropagation(); onOpenCalendar(coworker.slug); }} data-testid="coworker-calendar-shortcut"><CalendarIcon /></button>
                </Tooltip>
                </div>
              );
            })}
            {filterControl}
            {visibleGroups.map((group) => {
              const active = group.id === selectedGroupId;
              return (
                <button
                  key={group.id}
                  type="button"
                  aria-label={group.name}
                  aria-description={groupLines[group.id]}
                  title={group.name}
                  aria-current={active ? "true" : undefined}
                  data-testid="group-rail-avatar"
                  data-group-id={group.id}
                  data-active={active ? "true" : "false"}
                  onClick={() => onSelectGroup?.(group.id)}
                  className={`window-no-drag relative flex h-14 w-20 shrink-0 items-center justify-center rounded-xl transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${
                    active ? "bg-white/8 ring-1 ring-white/10" : "hover:bg-white/5"
                  }`}
                >
                  {active ? <span aria-hidden="true" className="absolute left-0 top-4 h-6 w-[3px] rounded-full bg-spark" /> : null}
                  <GroupAvatars members={membersOf(group)} size={18} motion="navigation" activeSlugs={groupActiveSlugs[group.id]} />
                </button>
              );
            })}
          </nav>
          {peek && peeked ? (
            <div
              role="tooltip"
              data-testid="coworker-rail-peek"
              className="pointer-events-none fixed z-50 w-56 rounded-lg border border-line bg-ink p-2.5 shadow-[0_12px_40px_rgb(0_0_0/0.55)]"
              style={{ left: panel.width + 8, top: peek.top }}
            >
              <p className="truncate text-sm font-semibold text-snow">{peeked.name}</p>
              {peeked.role ? <p className="truncate text-[11px] text-mist">{peeked.role}</p> : null}
              <p className={`mt-1.5 flex items-center gap-1.5 text-[11px] font-medium ${activityTextTone(activityBySlug[peeked.slug])}`}>
                <StatusDot tone={activityTone(activityBySlug[peeked.slug])} />
                <RailStatusLabel coworker={peeked} activity={activityBySlug[peeked.slug]} />
                {relativeTime(activityBySlug[peeked.slug]?.updatedAt ?? 0) ? (
                  <span className="ml-auto font-normal text-mist">{relativeTime(activityBySlug[peeked.slug]?.updatedAt ?? 0)}</span>
                ) : null}
              </p>
              <p className="mt-1 line-clamp-3 text-[11px] leading-[1.35] text-mist">
                {describeRailLine({ activity: activityBySlug[peeked.slug], personality: peeked.personality, seed: peeked.slug })}
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Coworkers</p>
          <nav aria-label="Coworkers" className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-5">
            {visibleCoworkers.map((coworker) => {
              const activity = activityBySlug[coworker.slug];
              const active = coworker.slug === selectedSlug;
              return (
                <div key={coworker.slug} className="coworker-rail-person group/rail-person relative">
                <button
                  type="button"
                  aria-label={coworker.name}
                  aria-description={activity?.label ?? "Checking status"}
                  title={activity?.detail || coworker.role || undefined}
                  aria-current={active ? "true" : undefined}
                  data-testid="coworker-rail-row"
                  data-slug={coworker.slug}
                  data-active={active ? "true" : "false"}
                  onClick={() => onSelect(coworker.slug)}
                  className={`window-no-drag absolute inset-0 size-full rounded-xl text-left transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${
                    active ? "bg-white/8 ring-1 ring-white/10" : "hover:bg-white/5 group-hover/rail-person:bg-white/5"
                  }`}
                >
                  <span className="sr-only">{coworker.name}</span>
                </button>
                {/* Content passes ordinary clicks to the full-row button; the calendar is a separate control. */}
                <div className="pointer-events-none relative flex w-full min-w-0 items-start gap-2.5 px-2 py-2">
                  <span className="mt-0.5 flex size-11 shrink-0 items-start justify-center">
                    <CoworkerAvatar
                      identity={coworker.slug}
                      motion="navigation"
                      color={coworker.avatarColor}
                      glasses={coworker.avatarGlasses}
                      name={coworker.name}
                      size={44}
                      working={activity?.state === "working"}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-snow">{coworker.name}</span>
                      <span className="shrink-0 text-[10px] text-mist">{relativeTime(activity?.updatedAt ?? 0)}</span>
                    </span>
                    <span data-testid="coworker-rail-status" className={`mt-0.5 flex items-center gap-1.5 text-[11px] font-medium ${activityTextTone(activity)}`}>
                      <Tooltip content={`Open ${coworker.name}'s calendar`} side="right">
                        <button type="button" aria-label={`Open ${coworker.name}'s calendar`} className="window-no-drag pointer-events-auto inline-flex size-4 shrink-0 items-center justify-center rounded text-mist hover:bg-white/6 hover:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 [&>svg]:size-[14px]" onClick={(event) => { event.stopPropagation(); onOpenCalendar(coworker.slug); }} data-testid="coworker-calendar-shortcut"><CalendarIcon /></button>
                      </Tooltip>
                      <StatusDot tone={activityTone(activity)} />
                      <RailStatusLabel coworker={coworker} activity={activity} />
                    </span>
                    <span
                      className="mt-0.5 block line-clamp-2 text-[11px] leading-[1.35] text-mist"
                      data-testid="coworker-rail-line"
                    >
                      {describeRailLine({ activity, personality: coworker.personality, seed: coworker.slug })}
                    </span>
                  </span>
                </div>
                </div>
              );
            })}
            {coworkers.length === 0 ? <p className="px-2.5 py-4 text-xs text-mist">No coworkers yet. Add your first teammate.</p> : null}
            {coworkers.length > 0 && visibleCoworkers.length === 0 ? <p className="px-2.5 py-4 text-xs text-mist">No matching coworkers.</p> : null}
            {coworkers.length > 0 || groups.length > 0 ? (
              <>
                <div className="flex items-center justify-between gap-2 px-2 pt-3">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Group chats</p>
                  {filterControl}
                </div>
                {visibleGroups.map((group) => {
                  const members = membersOf(group);
                  const active = group.id === selectedGroupId;
                  return (
                    <button
                      key={group.id}
                      aria-label={group.name}
                      aria-description={groupLines[group.id]}
                      title={group.name}
                      aria-current={active ? "true" : undefined}
                      data-testid="group-rail-row"
                      data-group-id={group.id}
                      data-active={active ? "true" : "false"}
                      onClick={() => onSelectGroup?.(group.id)}
                      className={`window-no-drag flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${
                        active ? "bg-white/8 text-snow ring-1 ring-white/10" : "text-mist hover:bg-white/5 hover:text-snow"
                      }`}
                    >
                      <span className="mt-0.5 flex h-11 min-w-11 shrink-0 items-center justify-center">
                        <GroupAvatars members={members} size={22} motion="navigation" activeSlugs={groupActiveSlugs[group.id]} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2"><span className="min-w-0 truncate text-sm font-semibold text-snow">{group.name}</span>{group.eventId || eventGroupIds.has(group.id) ? <span className="shrink-0 text-[9px] font-medium text-spark">Event</span> : null}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-mist" title={groupLines[group.id] || members.map((member) => member.name).join(", ")} data-testid="group-rail-line">{groupLines[group.id] || members.map((member) => member.name).join(", ")}</span>
                      </span>
                    </button>
                  );
                })}
                {coworkers.length >= 2 && onNewGroup ? (
                  <button
                    type="button"
                    data-testid="new-group-chat"
                    onClick={onNewGroup}
                    className="window-no-drag flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-xs text-mist transition-colors hover:bg-white/5 hover:text-snow"
                  >
                    <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center text-base">+</span>
                    New group chat
                  </button>
                ) : null}
              </>
            ) : null}
          </nav>
        </>
      )}
      </div>
      <div className={calendarMode ? "flex min-h-0 flex-1 flex-col" : "hidden"} data-testid="calendar-rail-content">
        {collapsed ? <div className="flex flex-1 flex-col items-center gap-2 px-1 pt-3">
          <IconButton label="Expand calendars" tooltipSide="right" onClick={() => { setFocusSearchOnExpand(true); panel.expand(); }} data-testid="calendar-rail-expand"><CalendarIcon /></IconButton>
          <p className="text-center text-[10px] leading-snug text-mist">Your team's calendar</p>
        </div> : <CalendarSidebar coworkers={coworkers} data={calendarData} preferences={calendarPreferences} onPreferencesChange={onCalendarPreferencesChange} query={calendarQuery} />}
      </div>
      <div className="window-no-drag shrink-0 border-t border-line/60 p-2">
        <Tooltip content={collapsed ? accountDescription : ""} side="right">
          <button
            type="button"
            data-testid="coworker-profile-button"
            aria-label={`OpenWork account and settings · ${accountName} · ${accountLabel}`}
            title={collapsed ? undefined : "OpenWork account and settings"}
            onClick={onOpenOpenWork}
            className={`group flex min-h-14 items-center gap-3 rounded-xl border border-transparent bg-white/[0.025] p-2 text-left transition-colors hover:border-white/8 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${collapsed ? "mx-auto w-14 justify-center" : "w-full"}`}
          >
            <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-spark/25 to-spark/5 text-xs font-semibold text-snow ring-1 ring-inset ring-spark/20">
              {session ? accountInitials : <CoworkerMark size={27} tile={false} />}
            </span>
            {!collapsed ? (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold leading-4 text-snow">{accountName}</span>
                  <span className="mt-0.5 block truncate text-[11px] leading-4 text-mist">{accountLabel}</span>
                </span>
                <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-lg text-mist transition-colors group-hover:bg-white/5 group-hover:text-snow group-focus-visible:text-snow">
                  <SlidersIcon className="size-4" />
                </span>
              </>
            ) : null}
          </button>
        </Tooltip>
      </div>
      <div
        {...panel.separatorProps}
        aria-label="Resize team rail"
        className="window-no-drag group absolute inset-y-0 -right-[5px] z-30 w-[10px] cursor-col-resize outline-none"
        title={collapsed ? "Click to show the team · Drag to resize" : "Drag to resize · Click or drag closed to fold"}
        data-testid="coworker-rail-resizer"
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-spark/45 group-focus-visible:bg-spark/70" />
      </div>
      {showGroupFilters && !calendarMode ? createPortal(<div ref={filterMenuRef} id={filterMenuId} role="menu" aria-label="Conversation types" data-testid="group-filter-menu" className="window-no-drag fixed z-50 max-h-[calc(100vh-16px)] w-44 max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-line bg-ink p-1 shadow-[0_8px_24px_rgb(0_0_0/0.45)]" style={filterPosition ?? { top: 0, left: 0, visibility: "hidden" }} onKeyDown={(event) => {
        if (event.key === "Tab") { closeGroupFilters(true); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')];
        const index = items.findIndex((item) => item === document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus({ preventScroll: true });
      }}>
        <button type="button" role="menuitemcheckbox" aria-checked={groupTypes.groups} tabIndex={-1} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-snow hover:bg-white/6 focus-visible:bg-white/6 focus-visible:outline-none" onClick={() => setGroupTypes((value) => ({ ...value, groups: !value.groups }))}>
          <span aria-hidden="true" className={`flex size-4 shrink-0 items-center justify-center rounded border ${groupTypes.groups ? "border-spark/60 bg-spark/10 text-spark" : "border-line"}`}>{groupTypes.groups ? <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="m3 8 3 3 7-7" /></svg> : null}</span>Group chats
        </button>
        <button type="button" role="menuitemcheckbox" aria-checked={groupTypes.events} tabIndex={-1} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-snow hover:bg-white/6 focus-visible:bg-white/6 focus-visible:outline-none" onClick={() => setGroupTypes((value) => ({ ...value, events: !value.events }))}>
          <span aria-hidden="true" className={`flex size-4 shrink-0 items-center justify-center rounded border ${groupTypes.events ? "border-spark/60 bg-spark/10 text-spark" : "border-line"}`}>{groupTypes.events ? <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.75"><path d="m3 8 3 3 7-7" /></svg> : null}</span>Events
        </button>
      </div>, document.body) : null}
    </aside>
  );
}
