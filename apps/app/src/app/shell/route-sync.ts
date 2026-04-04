import { createEffect } from "solid-js";
import type { Accessor } from "solid-js";

import { shouldRedirectMissingSessionAfterScopedLoad } from "../lib/session-scope";
import { isTauriRuntime, normalizeDirectoryPath } from "../utils";
import type { SettingsTab } from "../types";

type RouteSyncArgs = {
  pathname: Accessor<string>;
  navigate: (href: string, options?: { replace?: boolean }) => void;
  settingsTab: Accessor<SettingsTab>;
  setSettingsTabState: (tab: SettingsTab) => void;
  setSelectedSessionId: (value: string | null) => void;
  selectedSessionId: Accessor<string | null>;
  selectSession: (sessionId: string) => Promise<void> | void;
  pendingInitialSessionSelection: Accessor<unknown>;
  sessions: Accessor<Array<{ id: string; directory?: string | null }>>;
  sessionsLoaded: Accessor<boolean>;
  loadedSessionScopeRoot: Accessor<string>;
  selectedWorkspaceRoot: Accessor<string>;
  clearSelectedSessionSurface: () => void;
  activeSessionId: Accessor<string | null>;
  goToSettings: (tab: SettingsTab, options?: { replace?: boolean }) => void;
  goToSession: (sessionId: string, options?: { replace?: boolean }) => void;
};

const settingsTabs = new Set<SettingsTab>([
  "general",
  "den",
  "model",
  "automations",
  "skills",
  "extensions",
  "messaging",
  "advanced",
  "appearance",
  "updates",
  "recovery",
  "debug",
]);

const mapLegacySurfaceToSettingsTab = (surface: string): SettingsTab => {
  switch (surface) {
    case "scheduled":
      return "automations";
    case "skills":
      return "skills";
    case "plugins":
    case "mcp":
      return "extensions";
    case "identities":
      return "messaging";
    case "config":
      return "advanced";
    case "settings":
    default:
      return "general";
  }
};

const resolveSettingsTab = (value?: string | null) => {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (settingsTabs.has(normalized as SettingsTab)) {
    return normalized as SettingsTab;
  }
  return "general";
};

const initialRoute = () => "/session";

export function syncShellRoute(args: RouteSyncArgs) {
  createEffect(() => {
    const rawPath = args.pathname().trim();
    const path = rawPath.toLowerCase();

    if (path === "" || path === "/") {
      args.navigate(initialRoute(), { replace: true });
      return;
    }

    if (path.startsWith("/dashboard")) {
      const [, , tabSegment] = path.split("/");
      args.goToSettings(mapLegacySurfaceToSettingsTab(tabSegment ?? "settings"), {
        replace: true,
      });
      return;
    }

    if (path.startsWith("/settings")) {
      const [, , tabSegment] = path.split("/");
      const resolvedTab = resolveSettingsTab(tabSegment);

      if (resolvedTab !== args.settingsTab()) {
        args.setSettingsTabState(resolvedTab);
      }
      if (!tabSegment || tabSegment !== resolvedTab) {
        args.goToSettings(resolvedTab, { replace: true });
      }
      return;
    }

    if (path.startsWith("/session")) {
      const [, , sessionSegment] = rawPath.split("/");
      const id = (sessionSegment ?? "").trim();

      if (!id) {
        if (args.selectedSessionId()) {
          args.clearSelectedSessionSurface();
        }
        return;
      }

      const pendingInitialSelection = args.pendingInitialSessionSelection();
      const selectedWorkspaceRoot = normalizeDirectoryPath(args.selectedWorkspaceRoot().trim());
      const matchingSession = args.sessions().find((session) => session.id === id) ?? null;
      const hasMatchingSessionInScope = matchingSession
        ? !selectedWorkspaceRoot ||
          normalizeDirectoryPath(matchingSession.directory ?? "") === selectedWorkspaceRoot
        : false;
      if (
        args.sessionsLoaded() &&
        !pendingInitialSelection &&
        shouldRedirectMissingSessionAfterScopedLoad({
          loadedScopeRoot: args.loadedSessionScopeRoot(),
          workspaceRoot: args.selectedWorkspaceRoot().trim(),
          hasMatchingSession: hasMatchingSessionInScope,
        })
      ) {
        if (args.selectedSessionId() === id) {
          args.setSelectedSessionId(null);
        }
        args.navigate("/session", { replace: true });
        return;
      }

      if (args.selectedSessionId() !== id) {
        args.setSelectedSessionId(id);
        void args.selectSession(id);
      }
      return;
    }

    if (path.startsWith("/proto-v1-ux") || path.startsWith("/proto")) {
      if (isTauriRuntime()) {
        args.navigate("/settings/automations", { replace: true });
        return;
      }

      args.navigate("/settings/automations", { replace: true });
      return;
    }

    const fallback = args.activeSessionId();
    if (fallback) {
      args.goToSession(fallback, { replace: true });
      return;
    }
    args.navigate("/session", { replace: true });
  });
}
