import type { BotSummary } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { Button, StatusDot } from "@/ui/kit";

export function WorkerRail({
  bots,
  selectedSlug,
  session,
  onSelect,
  onNewWorker,
  onConnect,
  onSignOut,
}: {
  bots: BotSummary[];
  selectedSlug: string;
  session: DenSession | null;
  onSelect: (slug: string) => void;
  onNewWorker: () => void;
  onConnect: () => void;
  onSignOut: () => void;
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
            <span title={bot.workspaceId ? "Workspace ready" : "Workspace not registered yet"}>
              <StatusDot tone={bot.workspaceId ? "mint" : "amber"} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{bot.name}</span>
              {bot.role ? <span className="block truncate text-xs text-mist">{bot.role}</span> : null}
            </span>
          </button>
        ))}
        {bots.length === 0 ? <p className="px-2.5 py-4 text-xs text-mist">No workers yet.</p> : null}
      </nav>
      <footer className="space-y-2 border-t border-line px-4 py-3">
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
        <p className="text-[11px] text-mist">Powered by OpenWork</p>
      </footer>
    </aside>
  );
}
