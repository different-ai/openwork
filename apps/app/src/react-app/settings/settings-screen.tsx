import { useEffect, useState } from "react";
import { Check, PlugZap, RefreshCw } from "lucide-react";

import { selectActiveWorkspace, selectServerHostLabel, selectWorkspaceScopeLabel, useOpenworkStore } from "../kernel/store";

export function SettingsScreen() {
  const server = useOpenworkStore((state) => state.server);
  const workspaces = useOpenworkStore((state) => state.workspaces);
  const workspacesStatus = useOpenworkStore((state) => state.workspacesStatus);
  const refreshServer = useOpenworkStore((state) => state.refreshServer);
  const connectToServer = useOpenworkStore((state) => state.connectToServer);
  const activeWorkspace = useOpenworkStore(selectActiveWorkspace);
  const serverHost = useOpenworkStore(selectServerHostLabel);
  const [url, setUrl] = useState(server.url);
  const [token, setToken] = useState(server.token);

  useEffect(() => {
    setUrl(server.url);
    setToken(server.token);
  }, [server.token, server.url]);

  return (
    <section className="space-y-4">
      <div className="ow-card px-5 py-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-[0.24em] text-amber-200/70">Connection control</div>
            <h1 className="text-2xl font-semibold text-slate-50">OpenWork server bridge</h1>
            <p className="max-w-2xl text-sm leading-7 text-slate-300/78">
              The React rewrite stays server-consumption first. Point the app at an OpenWork host, keep the token local, and the workspace/session surfaces stream straight from the OpenCode proxy.
            </p>
          </div>
          <button className="ow-button-secondary" onClick={() => void refreshServer()} type="button">
            <RefreshCw className="h-4 w-4" />
            Re-check
          </button>
        </div>

        <form
          className="mt-6 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void connectToServer({ url, token });
          }}
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="space-y-2 text-sm text-slate-200/88" htmlFor="openwork-server-url">
              <span className="text-xs uppercase tracking-[0.18em] text-slate-400">Server URL</span>
              <input
                className="ow-input"
                id="openwork-server-url"
                name="openworkServerUrl"
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://localhost:8787"
                value={url}
              />
            </label>
            <label className="space-y-2 text-sm text-slate-200/88" htmlFor="openwork-server-token">
              <span className="text-xs uppercase tracking-[0.18em] text-slate-400">Client token</span>
              <input
                className="ow-input"
                id="openwork-server-token"
                name="openworkServerToken"
                onChange={(event) => setToken(event.target.value)}
                placeholder="paste the OpenWork client token"
                value={token}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="ow-button" type="submit">
              <PlugZap className="h-4 w-4" />
              Connect
            </button>
            <div className="ow-pill">{server.status}</div>
            <div className="ow-pill">{server.version ? `v${server.version}` : "version pending"}</div>
          </div>
        </form>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="ow-card px-5 py-5">
          <div className="text-xs uppercase tracking-[0.22em] text-slate-300/55">Runtime snapshot</div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-white/6 px-4 py-4">
              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Server</div>
              <div className="mt-2 text-lg font-semibold text-slate-50">{serverHost}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/6 px-4 py-4">
              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Workspaces</div>
              <div className="mt-2 text-lg font-semibold text-slate-50">{workspaces.length}</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/6 px-4 py-4">
              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Capabilities</div>
              <div className="mt-2 text-lg font-semibold text-slate-50">
                {server.capabilities ? Object.keys(server.capabilities).length : 0}
              </div>
            </div>
          </div>

          <div className="mt-6 space-y-3">
            <div className="text-xs uppercase tracking-[0.22em] text-slate-300/55">Active workspace</div>
            <div className="rounded-[24px] border border-white/10 bg-black/14 px-4 py-4">
              {activeWorkspace ? (
                <>
                  <div className="flex items-center gap-2 text-lg font-semibold text-slate-50">
                    <Check className="h-4 w-4 text-emerald-300" />
                    {activeWorkspace.displayName || activeWorkspace.name}
                  </div>
                  <div className="mt-3 text-sm leading-7 text-slate-300/75">
                    {selectWorkspaceScopeLabel(activeWorkspace)}
                  </div>
                </>
              ) : (
                <p className="text-sm leading-7 text-slate-300/75">
                  No active workspace yet. If you are running the Docker dev stack, refresh this page after `packaging/docker/dev-up.sh` finishes printing the web URL and token file.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="ow-card px-5 py-5">
          <div className="text-xs uppercase tracking-[0.22em] text-slate-300/55">What this rewrite changes</div>
          <ul className="mt-4 space-y-3 text-sm leading-7 text-slate-300/78">
            <li>- React owns the shell and routing.</li>
            <li>- Zustand owns connection, workspace, session, and transcript state.</li>
            <li>- Streamdown renders assistant markdown while tokens are still arriving.</li>
            <li>- The OpenWork server contract stays intact, so Docker + Chrome MCP can validate the real flow.</li>
            <li>- Legacy Solid files are kept out of the active compile path while the new runtime ships.</li>
          </ul>

          <div className="mt-6 rounded-[24px] border border-white/10 bg-black/14 px-4 py-4 text-sm leading-7 text-slate-300/75">
            Workspace status: <span className="text-slate-50">{workspacesStatus}</span>
            <br />
            Capabilities source: <span className="text-slate-50">{server.capabilities?.skills?.source ?? "unknown"}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
