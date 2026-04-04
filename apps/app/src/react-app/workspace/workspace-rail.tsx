import { LoaderCircle, RefreshCw, Server } from "lucide-react";

import { selectActiveWorkspace, selectServerHostLabel, selectWorkspaceScopeLabel, useOpenworkStore } from "../kernel/store";

export function WorkspaceRail() {
  const server = useOpenworkStore((state) => state.server);
  const workspaces = useOpenworkStore((state) => state.workspaces);
  const activeWorkspace = useOpenworkStore(selectActiveWorkspace);
  const serverHost = useOpenworkStore(selectServerHostLabel);
  const workspacesStatus = useOpenworkStore((state) => state.workspacesStatus);
  const selectWorkspace = useOpenworkStore((state) => state.selectWorkspace);
  const refreshServer = useOpenworkStore((state) => state.refreshServer);
  const connectedToEvents = useOpenworkStore((state) => state.connectedToEvents);

  return (
    <aside className="ow-card flex h-full flex-col overflow-hidden">
      <div className="border-b border-white/10 px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.22em] text-slate-300/55">Worker graph</div>
            <div className="mt-2 text-lg font-semibold text-slate-50">Connected hosts</div>
          </div>
          <button className="ow-button-secondary px-3 py-2" onClick={() => void refreshServer()} type="button">
            {server.status === "connecting" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
        <div className="mt-4 rounded-[24px] border border-white/10 bg-black/16 px-4 py-4 text-sm text-slate-300/78">
          <div className="flex items-center gap-2 text-slate-50">
            <Server className="h-4 w-4 text-amber-200" />
            {serverHost}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs uppercase tracking-[0.18em] text-slate-400">
            <span className="ow-pill">{server.status}</span>
            <span className="ow-pill">{connectedToEvents ? "events live" : "events pending"}</span>
            <span className="ow-pill">{workspacesStatus}</span>
          </div>
        </div>
      </div>

      <div className="ow-scroller flex-1 space-y-2 px-3 py-3">
        {workspaces.length ? (
          workspaces.map((workspace) => {
            const active = workspace.id === activeWorkspace?.id;
            return (
              <button
                className={[
                  "w-full rounded-[24px] border px-4 py-4 text-left transition duration-200",
                  active
                    ? "border-amber-300/35 bg-amber-300/12 shadow-[0_20px_50px_rgba(245,158,11,0.12)]"
                    : "border-white/8 bg-white/5 hover:border-white/15 hover:bg-white/8",
                ].join(" ")}
                key={workspace.id}
                onClick={() => void selectWorkspace(workspace.id)}
                type="button"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-50">{workspace.displayName || workspace.name}</div>
                    <div className="mt-2 text-xs uppercase tracking-[0.18em] text-slate-400">{workspace.workspaceType}</div>
                  </div>
                  <div className="ow-pill">{active ? "active" : "ready"}</div>
                </div>
                <div className="mt-3 line-clamp-2 text-sm leading-6 text-slate-300/72">{selectWorkspaceScopeLabel(workspace)}</div>
              </button>
            );
          })
        ) : (
          <div className="rounded-[24px] border border-dashed border-white/12 bg-black/12 px-4 py-6 text-sm leading-6 text-slate-300/72">
            No workspaces discovered yet. The Docker dev stack usually seeds one workspace automatically; otherwise connect to a server that exposes `/workspaces`.
          </div>
        )}
      </div>
    </aside>
  );
}
