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
      sessions.map((session) => {
        const lastUpdated = session.time?.updated ?? session.time?.created ?? null;
        return {
          id: session.id,
          title: session.title?.trim() || `Task ${session.id.slice(0, 8)}`,
          lastUpdated,
          status: sessionStatusById[session.id] ?? "idle",
        };
      }),
    [sessionStatusById, sessions],
  );

  const handleCreateSession = async () => {
    const next = await createSession();
    if (next) {
      navigate(`/session/${next}`);
    }
  };

  return (
    <aside className="ow-card flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-4">
        <div>
          <div className="text-xs uppercase tracking-[0.22em] text-slate-300/55">Sessions</div>
          <div className="mt-2 text-lg font-semibold text-slate-50">Task history</div>
        </div>
        <div className="flex gap-2">
          <button className="ow-button-secondary px-3 py-2" onClick={() => void refreshSessions(activeWorkspaceId)} type="button">
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          <button className="ow-button-secondary px-3 py-2" disabled={!activeWorkspaceId} onClick={() => void handleCreateSession()} type="button">
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="px-4 py-3 text-sm text-slate-300/72">
        {activeWorkspaceId ? "Scoped to the active workspace. New tasks open here and stream directly into the transcript." : "Select a workspace to load sessions."}
      </div>

      <div className="ow-scroller flex-1 space-y-2 px-3 pb-3">
        {items.length ? (
          items.map((item) => {
            const active = item.id === selectedSessionId && !isSettingsRoute;
            return (
              <div
                className={[
                  "group flex items-start gap-3 rounded-[24px] border px-3 py-3 transition duration-200",
                  active
                    ? "border-amber-300/35 bg-amber-300/12 shadow-[0_20px_50px_rgba(245,158,11,0.12)]"
                    : "border-white/8 bg-white/5 hover:border-white/15 hover:bg-white/8",
                ].join(" ")}
                key={item.id}
              >
                <Link className="min-w-0 flex-1" to={`/session/${item.id}`}>
                  <div className="truncate text-sm font-medium text-slate-50">{item.title}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-400">
                    <span>{item.status}</span>
                    {item.lastUpdated ? <span>{formatRelativeTime(item.lastUpdated)}</span> : null}
                  </div>
                </Link>
                <button
                  className="rounded-full p-2 text-slate-400 opacity-0 transition hover:bg-white/8 hover:text-rose-200 group-hover:opacity-100"
                  onClick={() => void deleteSession(item.id)}
                  type="button"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            );
          })
        ) : (
          <div className="rounded-[24px] border border-dashed border-white/12 bg-black/12 px-4 py-6 text-sm leading-6 text-slate-300/72">
            No sessions yet. Create one from the plus button to start testing the new React transcript surface.
          </div>
        )}
      </div>
    </aside>
  );
}
