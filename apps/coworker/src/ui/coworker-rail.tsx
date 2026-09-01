import { useState } from "react";
import type { CoworkerSummary } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import type { CoworkerActivity } from "@/lib/threads";
import { Button, StatusDot } from "@/ui/kit";

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

export function CoworkerRail({
  coworkers,
  activityBySlug,
  selectedSlug,
  session,
  onSelect,
  onNewCoworker,
  onConnect,
  onSignOut,
}: {
  coworkers: CoworkerSummary[];
  activityBySlug: Record<string, CoworkerActivity>;
  selectedSlug: string;
  session: DenSession | null;
  onSelect: (slug: string) => void;
  onNewCoworker: () => void;
  onConnect: () => void;
  onSignOut: () => void;
}) {
  const [query, setQuery] = useState("");
  const visibleCoworkers = coworkers.filter((coworker) =>
    `${coworker.name} ${coworker.role}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <aside className="glass-rail flex h-full w-[272px] shrink-0 flex-col border-r border-line">
      <div className="window-drag flex min-h-[86px] items-end justify-between px-4 pb-3 pt-10">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-mist">Open Coworker</p>
          <p className="text-sm font-semibold text-snow">Your team</p>
        </div>
        <Button variant="ghost" className="window-no-drag size-8 rounded-full px-0 py-0 text-lg" onClick={onNewCoworker} title="New coworker">
          <span aria-hidden="true">+</span>
        </Button>
      </div>
      <div className="px-3 pb-3">
        <input
          aria-label="Search coworkers"
          className="window-no-drag w-full rounded-xl border border-line bg-ink/55 px-3 py-2 text-xs text-snow shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] outline-none placeholder:text-mist/70 focus:border-spark/50 focus:bg-ink/75"
          placeholder="Search coworkers"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Coworkers</p>
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-4">
        {visibleCoworkers.map((coworker) => {
          const activity = activityBySlug[coworker.slug];
          return (
            <button
              key={coworker.slug}
              onClick={() => onSelect(coworker.slug)}
              className={`window-no-drag group flex w-full items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left transition-all duration-200 ${
                coworker.slug === selectedSlug
                  ? "bg-white/58 text-snow shadow-[0_8px_24px_rgba(45,48,43,0.08),inset_0_1px_0_rgba(255,255,255,0.78)] ring-1 ring-white/65"
                  : "text-mist hover:bg-white/38 hover:text-snow"
              }`}
            >
              <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-ink/72 text-sm font-semibold text-snow shadow-[0_6px_18px_rgba(45,48,43,0.08)] ring-1 ring-white/65">
                {coworker.name.trim().slice(0, 1).toUpperCase() || "C"}
                <span className="absolute -bottom-1 -right-1 rounded-full border-2 border-panel bg-panel leading-none">
                  <StatusDot tone={activityTone(activity)} />
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-snow">{coworker.name}</span>
                  <span className="shrink-0 text-[10px] text-mist">{relativeTime(activity?.updatedAt ?? 0)}</span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-mist">
                  {activity ? `${activity.label} · ${activity.detail}` : coworker.role || "Checking activity…"}
                </span>
              </span>
            </button>
          );
        })}
        {coworkers.length === 0 ? <p className="px-2.5 py-4 text-xs text-mist">No coworkers yet. Add your first teammate.</p> : null}
        {coworkers.length > 0 && visibleCoworkers.length === 0 ? <p className="px-2.5 py-4 text-xs text-mist">No matching coworkers.</p> : null}
      </nav>
      <footer className="window-no-drag space-y-2 border-t border-line bg-white/12 px-4 py-3 backdrop-blur-xl">
        {session ? (
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5 text-mist" title={session.userEmail || session.orgName}>
              <StatusDot tone="mint" />
              <span className="truncate">{session.orgName || session.userEmail || "Connected"}</span>
            </span>
            <button className="shrink-0 text-mist hover:text-snow" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        ) : (
          <Button variant="primary" className="w-full text-xs" onClick={onConnect}>
            Connect OpenWork account
          </Button>
        )}
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-mist">Powered by OpenWork</p>
      </footer>
    </aside>
  );
}
