import { useEffect, useRef, useState } from "react";
import type { CoworkerGroupSummary, CoworkerSummary, RuntimeInfo } from "@/lib/bridge";
import { describeRailLine } from "@/lib/rail-status";
import type { DenSession } from "@/lib/den";
import type { CoworkerActivity } from "@/lib/threads";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { Button, IconButton, PlusIcon, SearchIcon, SlidersIcon, StatusDot } from "@/ui/kit";
import type { ResizablePanel } from "@/ui/use-resizable-panel";
import { useWorkingSaying } from "@/ui/use-working-saying";

/**
 * The status word for a rail row. While a coworker is working, a personality
 * speaks here ("Measuring twice…"); every other state keeps its truthful label.
 */
function RailStatusLabel({ coworker, activity }: { coworker: CoworkerSummary; activity: CoworkerActivity | undefined }) {
  const saying = useWorkingSaying(
    coworker.personality,
    `${coworker.slug}:${activity?.threadId ?? "work"}`,
    activity?.state === "working",
  );
  return <span>{saying ? `${saying}…` : (activity?.label ?? "Checking status")}</span>;
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

/** Up to three member avatars overlapped into one mark; a fourth and beyond become a count. */
export function GroupAvatars({ members, size = 26 }: { members: readonly CoworkerSummary[]; size?: number }) {
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  const step = Math.round(size * 0.62);
  const width = shown.length ? size + step * (shown.length - 1) + (extra > 0 ? step : 0) : size;
  return (
    <span className="relative block shrink-0" style={{ width, height: size }} data-testid="group-avatars" data-count={members.length} aria-hidden="true">
      {shown.map((member, index) => (
        <span key={member.slug} className="absolute top-0 rounded-full ring-2 ring-[rgb(7_10_15)]" style={{ left: index * step, zIndex: index + 1 }}>
          <CoworkerAvatar color={member.avatarColor} glasses={member.avatarGlasses} name={member.name} size={size} />
        </span>
      ))}
      {extra > 0 ? (
        <span className="absolute top-0 flex items-center justify-center rounded-full bg-panel text-[10px] font-semibold text-mist ring-2 ring-[rgb(7_10_15)]" style={{ left: shown.length * step, width: size, height: size, zIndex: shown.length + 1 }}>
          +{extra}
        </span>
      ) : null}
    </span>
  );
}

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
  selectedGroupId = "",
  onSelectGroup,
  onNewGroup,
}: {
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
  selectedGroupId?: string;
  onSelectGroup?: (id: string) => void;
  onNewGroup?: () => void;
}) {
  const bySlug = new Map(coworkers.map((coworker) => [coworker.slug, coworker]));
  const membersOf = (group: CoworkerGroupSummary) => group.participantSlugs.map((slug) => bySlug.get(slug)).filter((member): member is CoworkerSummary => Boolean(member));
  const [query, setQuery] = useState("");
  const visibleGroups = groups.filter((group) => !group.archivedAt && (!query.trim() || group.name.toLowerCase().includes(query.trim().toLowerCase())));
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
  const peeked = peek ? coworkers.find((coworker) => coworker.slug === peek.slug) : undefined;
  const accountLabel = session?.orgName || session?.userEmail
    || (coworkers.length === 0 ? "Setup in progress" : runtime.engineManaged ? "Local mode" : "AI unavailable");
  const accountDot = coworkers.length === 0 ? "bg-mist" : runtime.engineManaged ? "bg-mint" : "bg-rose";

  return (
    <aside
      className={`glass-rail relative z-20 flex h-full shrink-0 flex-col border-r border-line ${panel.resizing ? "" : "transition-[width] duration-200"}`}
      style={{ width: panel.width }}
      data-testid="coworker-rail"
      data-collapsed={collapsed ? "true" : "false"}
    >
      {collapsed ? (
        <>
          {/* The window's traffic lights own this corner; the controls start below them. */}
          {/* The same 78px header band as the other columns; its two controls sit below the window controls. */}
          <div className="glass-header window-drag flex h-[78px] shrink-0 items-end justify-center gap-1 border-b border-line pb-2">
            <IconButton
              label="Search coworkers"
              className="window-no-drag"
              data-testid="coworker-rail-search"
              onClick={() => {
                setFocusSearchOnExpand(true);
                panel.expand();
              }}
            >
              <SearchIcon />
            </IconButton>
            <IconButton label="New coworker" className="window-no-drag" onClick={onNewCoworker}>
              <PlusIcon />
            </IconButton>
          </div>
          <nav aria-label="Coworkers" className="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto px-3 pb-4 pt-3">
            {coworkers.map((coworker) => {
              const activity = activityBySlug[coworker.slug];
              const active = coworker.slug === selectedSlug;
              const tone = activityTone(activity);
              const show = (target: HTMLElement) => setPeek({ slug: coworker.slug, top: target.getBoundingClientRect().top });
              return (
                <button
                  key={coworker.slug}
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
                  className={`window-no-drag relative flex size-14 shrink-0 items-center justify-center rounded-2xl transition-all duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${
                    active ? "bg-white/8 ring-1 ring-white/10" : "hover:bg-white/5"
                  }`}
                >
                  {active ? <span aria-hidden="true" className="absolute -left-3 top-4 h-6 w-[3px] rounded-full bg-spark" /> : null}
                  <CoworkerAvatar
                    animated
                    color={coworker.avatarColor}
                    glasses={coworker.avatarGlasses}
                    name={coworker.name}
                    size={40}
                    working={activity?.state === "working"}
                  />
                  <span
                    aria-hidden="true"
                    data-testid="coworker-rail-indicator"
                    data-tone={tone}
                    className={`absolute bottom-1.5 right-1.5 size-2.5 rounded-full ring-2 ring-[rgb(7_10_15)] ${DOT_BG[tone]} ${activity?.state === "working" ? "animate-pulse" : ""}`}
                  />
                </button>
              );
            })}
            {visibleGroups.map((group) => {
              const active = group.id === selectedGroupId;
              return (
                <button
                  key={group.id}
                  type="button"
                  aria-label={group.name}
                  aria-current={active ? "true" : undefined}
                  data-testid="group-rail-avatar"
                  data-group-id={group.id}
                  data-active={active ? "true" : "false"}
                  onClick={() => onSelectGroup?.(group.id)}
                  className={`window-no-drag relative flex size-14 shrink-0 items-center justify-center rounded-2xl transition-all duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${
                    active ? "bg-white/8 ring-1 ring-white/10" : "hover:bg-white/5"
                  }`}
                >
                  {active ? <span aria-hidden="true" className="absolute -left-3 top-4 h-6 w-[3px] rounded-full bg-spark" /> : null}
                  <GroupAvatars members={membersOf(group)} size={26} />
                </button>
              );
            })}
          </nav>
          <div className="window-no-drag flex flex-col items-center border-t border-line px-2 py-2">
            <IconButton label={`OpenWork · ${accountLabel}`} className="relative" onClick={onOpenOpenWork}>
              <SlidersIcon className="size-3.5" />
              <span aria-hidden="true" className={`absolute right-1 top-1 size-1.5 rounded-full ${accountDot}`} />
            </IconButton>
          </div>
          {peek && peeked ? (
            <div
              role="tooltip"
              data-testid="coworker-rail-peek"
              className="pointer-events-none fixed z-50 w-56 rounded-xl border border-line bg-ink p-3 shadow-[0_12px_40px_rgb(0_0_0/0.55)]"
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
          {/*
            The window controls own the top of this corner and the app already announces itself
            on the welcome screen. The rail shares the 78px header band of the other columns and
            uses its bottom row for search and New coworker, so the border runs straight across.
          */}
          <div className="glass-header window-drag flex h-[78px] shrink-0 items-end gap-2 border-b border-line px-3 pb-2">
            <input
              ref={searchRef}
              aria-label="Search coworkers"
              className="window-no-drag h-8 min-w-0 flex-1 rounded-xl border border-line bg-black/18 px-3 text-xs text-snow outline-none placeholder:text-mist/70 focus:border-spark/50 focus:bg-black/28"
              placeholder="Search coworkers"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button variant="ghost" className="window-no-drag size-8 shrink-0 rounded-lg px-0 py-0 text-lg" onClick={onNewCoworker} title="New coworker">
              <span aria-hidden="true">+</span>
            </Button>
          </div>
          <p className="px-4 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Coworkers</p>
          <nav aria-label="Coworkers" className="flex-1 space-y-1 overflow-y-auto px-2 pb-5">
            {visibleCoworkers.map((coworker) => {
              const activity = activityBySlug[coworker.slug];
              const active = coworker.slug === selectedSlug;
              return (
                <button
                  key={coworker.slug}
                  aria-current={active ? "true" : undefined}
                  data-testid="coworker-rail-row"
                  data-slug={coworker.slug}
                  data-active={active ? "true" : "false"}
                  onClick={() => onSelect(coworker.slug)}
                  className={`window-no-drag group flex w-full items-start gap-3 rounded-2xl px-2.5 py-3 text-left transition-all duration-200 ${
                    active ? "bg-white/8 text-snow ring-1 ring-white/10" : "text-mist hover:bg-white/5 hover:text-snow"
                  }`}
                >
                  <span className="mt-0.5 flex size-11 shrink-0 items-start justify-center">
                    <CoworkerAvatar
                      animated
                      color={coworker.avatarColor}
                      glasses={coworker.avatarGlasses}
                      name={coworker.name}
                      size={40}
                      working={activity?.state === "working"}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-snow">{coworker.name}</span>
                      <span className="shrink-0 text-[10px] text-mist">{relativeTime(activity?.updatedAt ?? 0)}</span>
                    </span>
                    <span data-testid="coworker-rail-status" className={`mt-1 flex items-center gap-1.5 text-[11px] font-medium ${activityTextTone(activity)}`}>
                      <StatusDot tone={activityTone(activity)} />
                      <RailStatusLabel coworker={coworker} activity={activity} />
                    </span>
                    <span
                      className="mt-1 block line-clamp-2 text-[11px] leading-[1.35] text-mist"
                      data-testid="coworker-rail-line"
                      title={activity?.detail || coworker.role || undefined}
                    >
                      {describeRailLine({ activity, personality: coworker.personality, seed: coworker.slug })}
                    </span>
                  </span>
                </button>
              );
            })}
            {coworkers.length === 0 ? <p className="px-2.5 py-4 text-xs text-mist">No coworkers yet. Add your first teammate.</p> : null}
            {coworkers.length > 0 && visibleCoworkers.length === 0 ? <p className="px-2.5 py-4 text-xs text-mist">No matching coworkers.</p> : null}
            {coworkers.length >= 2 || visibleGroups.length > 0 ? (
              <>
                <p className="px-2 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Group chats</p>
                {visibleGroups.map((group) => {
                  const members = membersOf(group);
                  const active = group.id === selectedGroupId;
                  return (
                    <button
                      key={group.id}
                      aria-current={active ? "true" : undefined}
                      data-testid="group-rail-row"
                      data-group-id={group.id}
                      data-active={active ? "true" : "false"}
                      onClick={() => onSelectGroup?.(group.id)}
                      className={`window-no-drag flex w-full items-start gap-3 rounded-2xl px-2.5 py-3 text-left transition-all duration-200 ${
                        active ? "bg-white/8 text-snow ring-1 ring-white/10" : "text-mist hover:bg-white/5 hover:text-snow"
                      }`}
                    >
                      <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center">
                        <GroupAvatars members={members} size={26} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-snow">{group.name}</span>
                        <span className="mt-1 block truncate text-[11px] text-mist" data-testid="group-rail-line">{groupLines[group.id] || members.map((member) => member.name).join(", ")}</span>
                      </span>
                    </button>
                  );
                })}
                {coworkers.length >= 2 && onNewGroup ? (
                  <button
                    type="button"
                    data-testid="new-group-chat"
                    onClick={onNewGroup}
                    className="window-no-drag flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left text-xs text-mist transition-colors hover:bg-white/5 hover:text-snow"
                  >
                    <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center text-base">+</span>
                    New group chat
                  </button>
                ) : null}
              </>
            ) : null}
          </nav>
          <div className="window-no-drag border-t border-line px-2 py-2">
            <button
              type="button"
              className="group flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/5"
              onClick={onOpenOpenWork}
              title="OpenWork account and settings"
            >
              <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-ink">
                <span className={`size-1.5 rounded-full ${accountDot}`} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-semibold text-snow">OpenWork</span>
                <span className="block truncate text-[10px] text-mist">{accountLabel}</span>
              </span>
              <SlidersIcon className="size-3.5 shrink-0 text-mist transition-colors group-hover:text-snow" />
            </button>
          </div>
        </>
      )}
      <div
        {...panel.separatorProps}
        aria-label="Resize team rail"
        className="window-no-drag group absolute inset-y-0 -right-[5px] z-30 w-[10px] cursor-col-resize outline-none"
        title={collapsed ? "Click to show the team · Drag to resize" : "Drag to resize · Click or drag closed to fold"}
        data-testid="coworker-rail-resizer"
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-spark/45 group-focus-visible:bg-spark/70" />
      </div>
    </aside>
  );
}
