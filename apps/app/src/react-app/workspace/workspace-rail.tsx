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
    <aside className="ow-soft-shell flex h-full flex-col overflow-hidden px-3 py-3">
      <div className="border-b border-slate-100 px-1 pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="ow-kicker">Worker graph</div>
            <div className="mt-2 text-lg font-semibold text-slate-900">Connected hosts</div>
          </div>
          <button className="ow-button-secondary h-11 px-3" onClick={() => void refreshServer()} type="button">
            {server.status === "connecting" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>

        <div className="mt-4 rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600">
          <div className="flex items-center gap-2 font-medium text-slate-900">
            <Server className="h-4 w-4 text-slate-700" />
            {serverHost}
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
            <span className={server.status === "connected" ? "ow-status-pill ow-status-pill-positive" : "ow-status-pill ow-status-pill-neutral"}>{server.status}</span>
            <span className="ow-status-pill ow-status-pill-neutral">{connectedToEvents ? "events live" : "events pending"}</span>
            <span className="ow-status-pill ow-status-pill-neutral">{workspacesStatus}</span>
          </div>
        </div>
      </div>

      <div className="ow-scroller flex-1 space-y-2 px-1 py-3">
        {workspaces.length ? (
          workspaces.map((workspace) => {
            const active = workspace.id === activeWorkspace?.id;
            return (
              <button className={active ? "ow-session-item ow-session-item-active text-left" : "ow-session-item text-left"} key={workspace.id} onClick={() => void selectWorkspace(workspace.id)} type="button">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900">{workspace.displayName || workspace.name}</div>
                    <div className="mt-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{workspace.workspaceType}</div>
                  </div>
                  <span className="ow-status-pill ow-status-pill-neutral">{active ? "active" : "ready"}</span>
                </div>
                <div className="mt-3 line-clamp-2 text-sm leading-6 text-slate-500">{selectWorkspaceScopeLabel(workspace)}</div>
              </button>
            );
          })
        ) : (
          <div className="rounded-[24px] border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm leading-6 text-slate-500">
            No workspaces discovered yet. Connect to a server that exposes `/workspaces` or start the Docker dev stack.
          </div>
        )}
      </div>
    </aside>
  );
}
