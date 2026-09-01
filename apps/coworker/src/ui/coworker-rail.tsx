import type { CoworkerSummary } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { Button, StatusDot } from "@/ui/kit";

export function CoworkerRail({
  coworkers,
  selectedSlug,
  session,
  onSelect,
  onNewCoworker,
  onConnect,
  onSignOut,
}: {
  coworkers: CoworkerSummary[];
  selectedSlug: string;
  session: DenSession | null;
  onSelect: (slug: string) => void;
  onNewCoworker: () => void;
  onConnect: () => void;
  onSignOut: () => void;
}) {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm font-semibold tracking-wide text-snow">Coworkers</span>
        <Button variant="ghost" onClick={onNewCoworker} title="New coworker">
          +
        </Button>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {coworkers.map((coworker) => (
          <button
            key={coworker.slug}
            onClick={() => onSelect(coworker.slug)}
            className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
              coworker.slug === selectedSlug ? "bg-panel-2 text-snow" : "text-mist hover:bg-panel-2/60 hover:text-snow"
            }`}
          >
            <span title={coworker.workspaceId ? "Workspace ready" : "Workspace not registered yet"}>
              <StatusDot tone={coworker.workspaceId ? "mint" : "amber"} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{coworker.name}</span>
              {coworker.role ? <span className="block truncate text-xs text-mist">{coworker.role}</span> : null}
            </span>
          </button>
        ))}
        {coworkers.length === 0 ? <p className="px-2.5 py-4 text-xs text-mist">No coworkers yet.</p> : null}
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
