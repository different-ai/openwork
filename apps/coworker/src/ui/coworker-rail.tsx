import { useState } from "react";
import type { CoworkerSummary, RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import type { CoworkerActivity } from "@/lib/threads";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { Button, StatusDot } from "@/ui/kit";
import { CoworkerMark } from "@/ui/brand";
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

function activityTone(activity: CoworkerActivity | undefined): "spark" | "mint" | "amber" | "rose" | "mist" {
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

export function CoworkerRail({
  coworkers,
  runtime,
  session,
  activityBySlug,
  selectedSlug,
  onSelect,
  onNewCoworker,
  onOpenOpenWork,
}: {
  coworkers: CoworkerSummary[];
  runtime: RuntimeInfo;
  session: DenSession | null;
  activityBySlug: Record<string, CoworkerActivity>;
  selectedSlug: string;
  onSelect: (slug: string) => void;
  onNewCoworker: () => void;
  onOpenOpenWork: () => void;
}) {
  const [query, setQuery] = useState("");
  const visibleCoworkers = coworkers.filter((coworker) =>
    `${coworker.name} ${coworker.role}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <aside className="glass-rail flex h-full w-[272px] shrink-0 flex-col border-r border-line">
      <div className="window-drag flex min-h-[86px] items-end justify-between px-4 pb-3 pt-10">
        <div className="flex items-center gap-2.5">
          <CoworkerMark size={34} />
          <div>
            <p className="text-[11px] font-semibold tracking-[-0.01em] text-snow">Open Coworker</p>
            <p className="text-[10px] text-mist">Your team</p>
          </div>
        </div>
        <Button variant="ghost" className="window-no-drag size-8 rounded-full px-0 py-0 text-lg" onClick={onNewCoworker} title="New coworker">
          <span aria-hidden="true">+</span>
        </Button>
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
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-5">
        {visibleCoworkers.map((coworker) => {
          const activity = activityBySlug[coworker.slug];
          return (
            <button
              key={coworker.slug}
              onClick={() => onSelect(coworker.slug)}
              className={`window-no-drag group flex w-full items-start gap-3 rounded-2xl px-2.5 py-3 text-left transition-all duration-200 ${
                coworker.slug === selectedSlug
                  ? "bg-white/8 text-snow ring-1 ring-white/10"
                  : "text-mist hover:bg-white/5 hover:text-snow"
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
            <span className={`size-1.5 rounded-full ${coworkers.length === 0 ? "bg-mist" : runtime.engineManaged ? "bg-mint" : "bg-rose"}`} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-semibold text-snow">OpenWork</span>
            <span className="block truncate text-[10px] text-mist">
              {session?.orgName || session?.userEmail || (coworkers.length === 0 ? "Setup in progress" : runtime.engineManaged ? "Local · connect account" : "Engine unavailable")}
            </span>
          </span>
          <svg className="size-3.5 shrink-0 text-mist transition-colors group-hover:text-snow" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 4.25h10M5.5 8h5M4.5 11.75h7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
            <circle cx="6" cy="4.25" r="1.25" fill="currentColor" />
            <circle cx="9" cy="8" r="1.25" fill="currentColor" />
            <circle cx="7" cy="11.75" r="1.25" fill="currentColor" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
