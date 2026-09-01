import type { BotSummary } from "@/lib/bridge";
import { Button, StatusDot } from "@/ui/kit";

export function WorkerRail({
  bots,
  selectedSlug,
  onSelect,
  onNewWorker,
}: {
  bots: BotSummary[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
  onNewWorker: () => void;
}) {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm font-semibold tracking-wide text-snow">Workers</span>
        <Button variant="ghost" onClick={onNewWorker} title="New worker">
          +
        </Button>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {bots.map((bot) => (
          <button
            key={bot.slug}
            onClick={() => onSelect(bot.slug)}
            className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
              bot.slug === selectedSlug ? "bg-panel-2 text-snow" : "text-mist hover:bg-panel-2/60 hover:text-snow"
            }`}
          >
            <StatusDot tone={bot.workspaceId ? "mint" : "amber"} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{bot.name}</span>
              {bot.role ? <span className="block truncate text-xs text-mist">{bot.role}</span> : null}
            </span>
          </button>
        ))}
        {bots.length === 0 ? <p className="px-2.5 py-4 text-xs text-mist">No workers yet.</p> : null}
      </nav>
      <footer className="border-t border-line px-4 py-2.5 text-[11px] text-mist">Powered by OpenWork</footer>
    </aside>
  );
}
