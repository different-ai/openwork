import { useEffect, useRef } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Orbit, Settings2, Workflow } from "lucide-react";

import { deepLinkBridgeEvent } from "../app/lib/deep-link-bridge";
import { readOpenworkConnectInviteFromSearch } from "../app/lib/openwork-server";
import { selectServerHostLabel, useOpenworkStore } from "./kernel/store";
import { SettingsScreen } from "./settings/settings-screen";
import { ChatPanel } from "./session/chat-panel";
import { SessionRail } from "./session/session-rail";
import { WorkspaceRail } from "./workspace/workspace-rail";

function HeaderNavLink({ href, label }: { href: string; label: string }) {
  const location = useLocation();
  const active = href === "/session" ? location.pathname.startsWith("/session") || location.pathname === "/" : location.pathname.startsWith(href);
  return (
    <Link className={active ? "ow-nav-link ow-nav-link-active" : "ow-nav-link"} to={href}>
      {label}
    </Link>
  );
}

function Shell() {
  const bootstrappedRef = useRef(false);
  const bootstrapping = useOpenworkStore((state) => state.bootstrapping);
  const server = useOpenworkStore((state) => state.server);
  const workspaces = useOpenworkStore((state) => state.workspaces);
  const connectToServer = useOpenworkStore((state) => state.connectToServer);
  const bootstrap = useOpenworkStore((state) => state.bootstrap);
  const serverHost = useOpenworkStore(selectServerHostLabel);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleDeepLink = (event: Event) => {
      const custom = event as CustomEvent<{ urls?: string[] }>;
      const candidate = custom.detail?.urls?.[0];
      if (!candidate) return;

      try {
        const invite = readOpenworkConnectInviteFromSearch(new URL(candidate).searchParams);
        if (!invite?.url) return;
        void connectToServer({ url: invite.url, token: invite.token });
      } catch {
        // ignore
      }
    };

    window.addEventListener(deepLinkBridgeEvent, handleDeepLink as EventListener);
    return () => window.removeEventListener(deepLinkBridgeEvent, handleDeepLink as EventListener);
  }, [connectToServer]);

  if (bootstrapping && !server.url) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6 py-16">
        <div className="ow-card max-w-xl px-8 py-10 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-white/6 text-amber-100">
            <Orbit className="h-7 w-7 animate-[spin_12s_linear_infinite]" />
          </div>
          <h1 className="text-2xl font-semibold text-slate-50">Preparing the React shell</h1>
          <p className="mt-3 text-sm leading-7 text-slate-300/76">
            OpenWork is hydrating the server URL, token, workspace registry, and event stream bridge.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 pb-6 pt-4 lg:px-6 lg:pb-8 lg:pt-6">
      <header className="ow-card mb-4 px-5 py-4 lg:mb-5 lg:px-6 lg:py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-3 text-xs uppercase tracking-[0.24em] text-amber-200/70">
              <Workflow className="h-4 w-4" />
              OpenWork app rewrite
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-slate-50">React orchestration surface</h1>
              <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-300/78">
                React drives the shell, Zustand owns the live connection model, and Streamdown handles token-by-token markdown as the remote worker responds.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-start gap-3 lg:items-end">
            <div className="flex flex-wrap gap-2">
              <HeaderNavLink href="/session" label="Session" />
              <HeaderNavLink href="/settings" label="Settings" />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-400">
              <span className="ow-pill">{server.status}</span>
              <span className="ow-pill">{serverHost}</span>
              <span className="ow-pill">{workspaces.length} workspaces</span>
            </div>
          </div>
        </div>
      </header>

      <div className="ow-shell-grid">
        <WorkspaceRail />
        <SessionRail />
        <main className="min-w-0">
          <Routes>
            <Route path="/session" element={<ChatPanel />} />
            <Route path="/session/:sessionId" element={<ChatPanel />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate replace to={server.url ? "/session" : "/settings"} />} />
          </Routes>
        </main>
      </div>

      <footer className="mt-5 flex flex-wrap items-center justify-between gap-3 px-2 text-xs uppercase tracking-[0.18em] text-slate-400">
        <span>OpenWork runtime: React + Zustand + Streamdown</span>
        <Link className="ow-nav-link" to="/settings">
          <Settings2 className="h-3.5 w-3.5" />
          Connection settings
        </Link>
      </footer>
    </div>
  );
}

export function AppRoot() {
  return <Shell />;
}
