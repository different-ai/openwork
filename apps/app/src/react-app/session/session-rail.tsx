import { useMemo } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";

import { formatRelativeTime } from "../../app/utils";
import { useOpenworkStore } from "../kernel/store";

export function SessionRail() {
  const navigate = useNavigate();
  const location = useLocation();
  const sessions = useOpenworkStore((state) => state.sessions);
  const activeWorkspaceId = useOpenworkStore((state) => state.activeWorkspaceId);
  const selectedSessionId = useOpenworkStore((state) => state.selectedSessionId);
  const sessionsStatus = useOpenworkStore((state) => state.sessionsStatus);
  const sessionStatusById = useOpenworkStore((state) => state.sessionStatusById);
  const createSession = useOpenworkStore((state) => state.createSession);
  const refreshSessions = useOpenworkStore((state) => state.refreshSessions);
  const deleteSession = useOpenworkStore((state) => state.deleteSession);

  const busy = sessionsStatus === "loading";
  const isSettingsRoute = location.pathname.startsWith("/settings");

  const items = useMemo(
    () =>
      sessions.map((session) => ({
        id: session.id,
        title: session.title?.trim() || `Task ${session.id.slice(0, 8)}`,
        lastUpdated: session.time?.updated ?? session.time?.created ?? null,
        status: sessionStatusById[session.id] ?? "idle",
      })),
    [sessionStatusById, sessions],
  );

  const handleCreateSession = async () => {
    const next = await createSession();
    if (next) {
      navigate(`/session/${next}`);
    }
  };

  return (
    <aside className="ow-soft-shell flex h-full flex-col overflow-hidden px-3 py-3">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-1 pb-3">
        <div>
          <div className="ow-kicker">Sessions</div>
          <div className="mt-2 text-lg font-semibold text-slate-900">Task history</div>
        </div>
        <div className="flex gap-2">
          <button className="ow-button-secondary h-11 px-3" onClick={() => void refreshSessions(activeWorkspaceId)} type="button">
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          <button className="ow-button-secondary h-11 px-3" disabled={!activeWorkspaceId} onClick={() => void handleCreateSession()} type="button">
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="px-1 py-3 text-sm leading-6 text-slate-500">
        {activeWorkspaceId ? "Scoped to the active workspace. Create and revisit tasks here." : "Select a workspace to load its task history."}
      </div>

      <div className="ow-scroller flex-1 space-y-2 px-1 pb-1">
        {items.length ? (
          items.map((item) => {
            const active = item.id === selectedSessionId && !isSettingsRoute;
            return (
              <div className={active ? "ow-session-item ow-session-item-active" : "ow-session-item"} key={item.id}>
                <Link className="min-w-0 flex-1" to={`/session/${item.id}`}>
                  <div className="truncate text-sm font-medium text-slate-900">{item.title}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    <span>{item.status}</span>
                    {item.lastUpdated ? <span>{formatRelativeTime(item.lastUpdated)}</span> : null}
                  </div>
                </Link>
                <button className="rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-rose-600" onClick={() => void deleteSession(item.id)} type="button">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })
        ) : (
          <div className="rounded-[24px] border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm leading-6 text-slate-500">
            No sessions yet. Create one once a workspace is connected.
          </div>
        )}
      </div>
    </aside>
  );
}
