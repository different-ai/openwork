// Engine reload wiring for the session route: UI-triggered engine reload,
// reload-coordinator registration, the post-org-onboarding reload latch,
// server reload-event polling, and desktop engine info. Extracted verbatim
// from session-route.tsx; reload events are now typed (OpenworkReloadEvent)
// instead of `any`.
import { useCallback, useEffect, useRef, useState } from "react";

import { engineInfo } from "@/app/lib/desktop";
import type { EngineInfo } from "@/app/lib/desktop-types";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { t } from "@/i18n";
import { useReloadCoordinator } from "./reload-coordinator";
import { refreshProviderListQueries } from "@/react-app/infra/provider-list-query";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import type { RouteWorkspace } from "./route-workspaces";

const reloadAfterOrgOnboardingKey = "openwork.reloadAfterOrgOnboarding";

export type UseEngineReloadInput = {
  client: OpenworkServerClient | null;
  workspaceId: string;
  workspace: RouteWorkspace | null | undefined;
  endpointForWorkspace: (
    workspace: RouteWorkspace | null | undefined,
  ) => ResolvedWorkspaceEndpoint | null;
  activeReloadBlockingSessions: { id: string; title: string }[];
  onError: (message: string) => void;
  refreshRouteState: () => Promise<void>;
};

export function useEngineReload(input: UseEngineReloadInput) {
  const {
    client,
    workspaceId,
    workspace,
    endpointForWorkspace,
    activeReloadBlockingSessions,
    onError,
    refreshRouteState,
  } = input;
  const reloadCoordinator = useReloadCoordinator();
  const [engineReloadVersion, setEngineReloadVersion] = useState(0);
  const [routeEngineInfo, setRouteEngineInfo] = useState<EngineInfo | null>(null);
  const reloadEventCursorByWorkspaceRef = useRef<Record<string, number | null>>({});

  const reloadWorkspaceEngineFromUi = useCallback(async () => {
    if (!client || !workspaceId) {
      onError(t("app.error_connect_first"));
      return false;
    }
    const endpoint = endpointForWorkspace(workspace);
    if (!endpoint) {
      onError(t("app.error_connect_first"));
      return false;
    }
    await endpoint.client.reloadEngine(endpoint.workspaceId);
    await refreshProviderListQueries(getReactQueryClient());
    setEngineReloadVersion((v) => v + 1);
    try {
      window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
    } catch {
      // ignore browser event dispatch failures
    }
    await refreshRouteState();
    return true;
  }, [client, endpointForWorkspace, onError, refreshRouteState, workspace, workspaceId]);

  useEffect(() => {
    return reloadCoordinator.registerWorkspaceReloadControls({
      canReloadWorkspaceEngine: () => Boolean(client && workspaceId),
      reloadWorkspaceEngine: reloadWorkspaceEngineFromUi,
      activeSessions: () => activeReloadBlockingSessions,
    });
  }, [activeReloadBlockingSessions, client, reloadCoordinator, reloadWorkspaceEngineFromUi, workspaceId]);

  useEffect(() => {
    if (!reloadCoordinator.canReloadWorkspaceEngine) return;
    try {
      if (window.localStorage.getItem(reloadAfterOrgOnboardingKey) !== "1") return;
      window.localStorage.removeItem(reloadAfterOrgOnboardingKey);
    } catch {
      return;
    }
    // Marking is enough: the reload coordinator auto-reloads once idle.
    reloadCoordinator.markReloadRequired("config", {
      type: "config",
      name: "opencode.json",
      action: "updated",
    });
  }, [reloadCoordinator, reloadCoordinator.canReloadWorkspaceEngine]);

  useEffect(() => {
    if (!client || !workspaceId) return;
    const endpoint = endpointForWorkspace(workspace);
    if (!endpoint) return;
    let cancelled = false;

    const pollReloadEvents = async () => {
      const currentCursor = reloadEventCursorByWorkspaceRef.current[workspaceId];
      try {
        const response = await endpoint.client.listReloadEvents(
          endpoint.workspaceId,
          typeof currentCursor === "number" ? { since: currentCursor } : undefined,
        );
        if (cancelled) return;
        reloadEventCursorByWorkspaceRef.current[workspaceId] =
          typeof response.cursor === "number"
            ? response.cursor
            : Math.max(currentCursor ?? 0, ...((response.items ?? []).map((item) => Number(item.seq) || 0)));
        // The first poll establishes the server cursor so historical reload
        // events don't show a stale toast on route entry. Subsequent polls mark
        // new filesystem/server-side mutations, including skills created by an
        // agent while the session page is open.
        if (currentCursor === undefined || currentCursor === null) return;
        for (const event of response.items ?? []) {
          reloadCoordinator.markReloadRequired(event.reason, event.trigger);
        }
      } catch {
        // Reload-event polling is best-effort; normal route health checks still
        // surface connection failures.
      }
    };

    void pollReloadEvents();
    const interval = window.setInterval(() => void pollReloadEvents(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [client, endpointForWorkspace, reloadCoordinator, workspace, workspaceId]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    void engineInfo()
      .then((info) => {
        // Pre-existing cast: the desktop bridge is a dynamic Proxy, so
        // engineInfo() returns unknown until the IPC surface is typed
        // (queued: DesktopCommandMap).
        if (!cancelled) setRouteEngineInfo(info as EngineInfo | null);
      })
      .catch(() => {
        if (!cancelled) setRouteEngineInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { engineReloadVersion, routeEngineInfo, reloadWorkspaceEngineFromUi };
}
