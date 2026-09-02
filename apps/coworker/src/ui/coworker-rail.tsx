import { useState } from "react";
import type { CoworkerSummary, RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import type { CoworkerActivity } from "@/lib/threads";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { Button, ChevronIcon, IconButton, PlusIcon, SlidersIcon, StatusDot } from "@/ui/kit";
import { CoworkerMark } from "@/ui/brand";
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

type Tone = "spark" | "mint" | "amber" | "rose" | "mist";

function activityTone(activity: CoworkerActivity | undefined): Tone {
  if (activity?.state === "working") return "spark";
  if (activity?.state === "retrying" || activity?.state === "attention") return "amber";
  if (activity?.state === "offline") return "rose";
  if (activity?.state === "recent") return "mint";
  return "mist";
}

function activityTextTone(activity: CoworkerActivity | undefined): string {
  if (activity?.state === "working") return "text-spark";
  if (activity?.state === "retrying" || activity?.state === "attention") return "text-amber";
  if (activity?.state === "offline") return "text-rose";
  if (activity?.state === "recent") return "text-mint";
  return "text-mist";
}

const DOT_BG: Record<Tone, string> = { spark: "bg-spark", mint: "bg-mint", amber: "bg-amber", rose: "bg-rose", mist: "bg-mist" };

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
}) {
  const [query, setQuery] = useState("");
  const [peek, setPeek] = useState<{ slug: string; top: number } | null>(null);
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
          <div className="window-drag flex min-h-[86px] flex-col items-center justify-end gap-1 pb-2 pt-10">
            <CoworkerMark size={30} />
          </div>
          <div className="flex flex-col items-center gap-1 px-2 pb-2">
            <IconButton label="Show team details" data-testid="coworker-rail-expand" onClick={panel.expand}>
              <ChevronIcon direction="right" />
            </IconButton>
            <IconButton label="New coworker" onClick={onNewCoworker}>
              <PlusIcon />
            </IconButton>
          </div>
          <nav aria-label="Coworkers" className="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto px-2 pb-4 pt-1">
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
                  className={`window-no-drag relative flex size-12 shrink-0 items-center justify-center rounded-2xl transition-all duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60 ${
                    active ? "bg-white/8 ring-1 ring-white/10" : "hover:bg-white/5"
                  }`}
                >
                  {active ? <span aria-hidden="true" className="absolute -left-2 top-3 h-6 w-[3px] rounded-full bg-spark" /> : null}
                  <CoworkerAvatar
                    animated
                    color={coworker.avatarColor}
                    glasses={coworker.avatarGlasses}
                    name={coworker.name}
                    size={36}
                    working={activity?.state === "working"}
                  />
                  <span
                    aria-hidden="true"
                    data-testid="coworker-rail-indicator"
                    data-tone={tone}
                    className={`absolute bottom-1 right-1 size-2.5 rounded-full ring-2 ring-[rgb(7_10_15)] ${DOT_BG[tone]} ${activity?.state === "working" ? "animate-pulse" : ""}`}
                  />
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
              {activityBySlug[peeked.slug]?.detail ? (
                <p className="mt-1 line-clamp-3 text-[11px] leading-[1.35] text-mist">{activityBySlug[peeked.slug]?.detail}</p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="window-drag flex min-h-[86px] items-end justify-between gap-2 px-4 pb-3 pt-10">
            <div className="flex min-w-0 items-center gap-2.5">
              <CoworkerMark size={34} />
              <div className="min-w-0">
                <p className="truncate text-[11px] font-semibold tracking-[-0.01em] text-snow">Open Coworker</p>
                <p className="truncate text-[10px] text-mist">Your team</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center">
              <Button variant="ghost" className="window-no-drag size-8 rounded-full px-0 py-0 text-lg" onClick={onNewCoworker} title="New coworker">
                <span aria-hidden="true">+</span>
              </Button>
              <IconButton label="Hide team details" className="window-no-drag" data-testid="coworker-rail-collapse" onClick={panel.collapse}>
                <ChevronIcon direction="left" />
              </IconButton>
            </div>
          </div>
          <div className="px-3 pb-3">
            <input
              aria-label="Search coworkers"
              className="window-no-drag w-full rounded-xl border border-line bg-black/18 px-3 py-2 text-xs text-snow outline-none placeholder:text-mist/70 focus:border-spark/50 focus:bg-black/28"
              placeholder="Search coworkers"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <p className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Coworkers</p>
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
                    <span className={`mt-1 flex items-center gap-1.5 text-[11px] font-medium ${activityTextTone(activity)}`}>
                      <StatusDot tone={activityTone(activity)} />
                      <RailStatusLabel coworker={coworker} activity={activity} />
                    </span>
                    <span
                      className="mt-1 block line-clamp-2 text-[11px] leading-[1.35] text-mist"
                      title={activity?.detail || coworker.role || "Checking activity"}
                    >
                      {activity?.detail || coworker.role || "Checking current activity…"}
                    </span>
                  </span>
                </button>
              );
            })}
            {coworkers.length === 0 ? <p className="px-2.5 py-4 text-xs text-mist">No coworkers yet. Add your first teammate.</p> : null}
            {coworkers.length > 0 && visibleCoworkers.length === 0 ? <p className="px-2.5 py-4 text-xs text-mist">No matching coworkers.</p> : null}
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
        title="Drag to resize · Drag closed to collapse · Double-click to reset"
        data-testid="coworker-rail-resizer"
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-spark/45 group-focus-visible:bg-spark/70" />
      </div>
    </aside>
  );
}
