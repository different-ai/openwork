// The session route's data + navigation core: workspace/session loading
// (refreshRouteState + background session fetch), endpoint and opencode
// client resolution, URL-derived selection, redirects (fallback workspace,
// last-session restore, welcome), desktop local-server reconnect, remote
// connection checks, and the route inspector slice. Extracted verbatim from
// session-route.tsx as the final step of its decomposition; the route keeps
// composition, handlers, and JSX.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { publishInspectorSlice, recordInspectorEvent } from "@/app/lib/app-inspector";
import {
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  type OpenworkServerInfo,
  type WorkspaceList,
} from "@/app/lib/desktop";
import { createClient } from "@/app/lib/opencode";
import { createOpenworkServerClient, type OpenworkServerClient } from "@/app/lib/openwork-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import {
  resolveWorkspaceEndpoint,
  type ResolvedWorkspaceEndpoint,
} from "@/app/lib/workspace-endpoint";
import type { WorkspaceConnectionState } from "@/app/types";
import { normalizeDirectoryPath } from "@/app/utils";
import { t } from "@/i18n";
import {
  diagnoseRemoteWorkspaceTaskLoadFailure,
  getRemoteWorkspaceConnectionKey,
  testRemoteWorkspaceConnection,
} from "@/react-app/domains/workspace/remote-workspace-diagnostics";
import { useLocal } from "@/react-app/kernel/local-provider";
import { useBootState } from "./boot-state";
import { ensureDesktopLocalOpenworkConnection } from "./desktop-local-openwork";
import { resolveOpenworkConnection } from "./openwork-connection";
import {
  describeRouteError,
  isTransientStartupError,
  mapDesktopWorkspace,
  mergeRouteWorkspaces,
  orderRouteWorkspaces,
  type RouteSession,
  type RouteWorkspace,
} from "./route-workspaces";
import {
  readActiveWorkspaceId,
  readLastSessionFor,
  readWorkspaceOrderIds,
  writeActiveWorkspaceId,
} from "./session-memory";
import { legacySessionRoute, workspaceSessionRoute } from "./workspace-routes";

export type UseWorkspaceRouteStateInput = {
  /** Invoked when the openwork-server settings-changed event fires (the route bumps its settings version). */
  onServerSettingsChanged: () => void;
  /** Receives the local openwork-server host info discovered during refresh. */
  onHostInfo: (info: OpenworkServerInfo | null) => void;
};

export function useWorkspaceRouteState(input: UseWorkspaceRouteStateInput) {
  const { onServerSettingsChanged, onHostInfo } = input;
  const navigate = useNavigate();
  const local = useLocal();
  const params = useParams<{ workspaceId?: string; sessionId?: string }>();
  const routeWorkspaceId = params.workspaceId?.trim() || "";
  const selectedSessionId = params.sessionId?.trim() || null;
  const navigateToWorkspaceSession = useCallback((workspaceId: string, sessionId?: string | null, options?: { replace?: boolean }) => {
    const id = workspaceId.trim();
    if (!id) {
      navigate(legacySessionRoute(sessionId), options);
      return;
    }
    navigate(workspaceSessionRoute(id, sessionId), options);
  }, [navigate]);

  const { markRouteReady: markBootRouteReady } = useBootState();
  const [loading, setLoading] = useState(true);
  const [client, setClient] = useState<OpenworkServerClient | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [workspaces, setWorkspaces] = useState<RouteWorkspace[]>([]);
  const [workspaceOrderIds, setWorkspaceOrderIds] = useState<string[]>(() => readWorkspaceOrderIds());
  const [sessionsByWorkspaceId, setSessionsByWorkspaceId] = useState<Record<string, RouteSession[]>>({});
  const [errorsByWorkspaceId, setErrorsByWorkspaceId] = useState<Record<string, string | null>>({});
  const [workspaceConnectionOverrides, setWorkspaceConnectionOverrides] = useState<Record<string, WorkspaceConnectionState>>({});
  const [routeError, setRouteError] = useState<string | null>(null);
  const [legacySelectedWorkspaceId, setLegacySelectedWorkspaceId] = useState<string>(() => readActiveWorkspaceId() ?? "");
  const selectedWorkspaceId = routeWorkspaceId || legacySelectedWorkspaceId;
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? (selectedWorkspaceId ? null : workspaces[0] ?? null),
    [selectedWorkspaceId, workspaces],
  );
  // Workspace-scoped API calls (sessions, events, activate, opencode/*) must
  // hit the worker that owns the workspace, not the user's local server. The
  // single source of truth for that routing is `resolveWorkspaceEndpoint`.
  //
  // We read the latest local server's baseUrl/token through a ref so the
  // `endpointForWorkspace` callback stays permanently stable. Otherwise it
  // would change on every `setBaseUrl`/`setToken`, which used to cascade up
  // through `loadWorkspaceSessionsInBackground` and `refreshRouteState` and
  // produce a tight render-refresh-setWorkspaces loop.
  const localServerRef = useRef<{ baseUrl: string; token: string }>({ baseUrl: "", token: "" });
  useEffect(() => {
    localServerRef.current = { baseUrl, token };
  }, [baseUrl, token]);
  const endpointForWorkspace = useCallback(
    (workspace: RouteWorkspace | null | undefined): ResolvedWorkspaceEndpoint | null =>
      resolveWorkspaceEndpoint(workspace, localServerRef.current),
    [],
  );
  const refreshInFlightRef = useRef(false);
  const workspacesRef = useRef<RouteWorkspace[]>([]);
  const workspaceOrderIdsRef = useRef(workspaceOrderIds);
  const remoteWorkspaceCheckRunRef = useRef<Record<string, string>>({});
  const remoteWorkspaceCheckRunCounterRef = useRef(0);
  const sessionsByWorkspaceIdRef = useRef<Record<string, RouteSession[]>>({});
  const pendingCreatedSessionIdsRef = useRef<Record<string, Record<string, number>>>({});
  const startupRetryTimerRef = useRef<number | null>(null);
  const [retryingWorkspaceIds, setRetryingWorkspaceIds] = useState<string[]>([]);
  const launchActivatedWorkspaceIdsRef = useRef(new Set<string>());
  const reconnectAttemptedWorkspaceIdRef = useRef("");
  const backgroundSessionLoadInFlight = useRef<Map<string, number>>(new Map());
  const rememberPendingCreatedSession = useCallback((workspaceId: string, sessionId: string) => {
    const id = sessionId.trim();
    if (!workspaceId || !id) return;
    pendingCreatedSessionIdsRef.current[workspaceId] = {
      ...(pendingCreatedSessionIdsRef.current[workspaceId] ?? {}),
      [id]: Date.now(),
    };
  }, []);
  const mergeFetchedSessionsWithPending = useCallback((workspaceId: string, fetched: RouteSession[], current: RouteSession[]) => {
    const pending = pendingCreatedSessionIdsRef.current[workspaceId];
    if (!pending) return fetched;

    const now = Date.now();
    const fetchedIds = new Set(fetched.flatMap((session) => session?.id ? [String(session.id)] : []));
    const pendingIds = Object.keys(pending);

    for (const id of pendingIds) {
      if (fetchedIds.has(id)) {
        delete pending[id];
      }
    }

    const preserved = current.filter((session) => {
      const id = String(session?.id ?? "");
      if (!id || fetchedIds.has(id)) return false;
      const createdAt = pending[id];
      if (typeof createdAt !== "number") return false;
      if (now - createdAt > 30_000) {
        delete pending[id];
        return false;
      }
      return true;
    });

    if (Object.keys(pending).length === 0) {
      delete pendingCreatedSessionIdsRef.current[workspaceId];
    }

    return preserved.length > 0 ? [...preserved, ...fetched] : fetched;
  }, []);
  const loadWorkspaceSessionsInBackground = useCallback(
    async (workspaces: RouteWorkspace[]) => {
      const MAX_ATTEMPTS = 6;
      const backoffMs = (attempt: number) => Math.min(500 * Math.pow(2, attempt), 4_000);

      const fetchOnce = async (workspace: RouteWorkspace, attempt: number): Promise<void> => {
        const isRemoteOpenworkWorkspace = workspace.workspaceType === "remote" && workspace.remoteType !== "opencode";
        const endpoint = endpointForWorkspace(workspace);
        if (!endpoint) {
          if (workspace.workspaceType === "remote") {
            const message = "Remote worker URL is missing. Edit connection and add a server URL.";
            setErrorsByWorkspaceId((current) => ({ ...current, [workspace.id]: message }));
            setWorkspaceConnectionOverrides((current) => ({
              ...current,
              [workspace.id]: {
                status: "error",
                message,
                checkedAt: Date.now(),
              },
            }));
            setRetryingWorkspaceIds((current) =>
              current.includes(workspace.id) ? current.filter((id) => id !== workspace.id) : current,
            );
          }
          return;
        }
        const startedAt = backgroundSessionLoadInFlight.current.get(workspace.id) ?? 0;
        if (startedAt && Date.now() - startedAt < 5_000) return;
        const requestStartedAt = Date.now();
        backgroundSessionLoadInFlight.current.set(workspace.id, requestStartedAt);
        if (isRemoteOpenworkWorkspace) {
          setWorkspaceConnectionOverrides((current) => ({
            ...current,
            [workspace.id]: {
              status: "connecting",
              message: t("workspace_list.loading_remote_tasks"),
              checkedAt: null,
            },
          }));
        }
        try {
          const response = await endpoint.client.listSessions(endpoint.workspaceId, { limit: 200 });
          const fetchedItems = response.items ?? [];
          const workspaceRoot = normalizeDirectoryPath(workspace.path ?? "");
          const items = workspaceRoot && !isRemoteOpenworkWorkspace
            ? fetchedItems.filter((session) =>
                normalizeDirectoryPath(session?.directory ?? "") === workspaceRoot,
              )
            : fetchedItems;
          setSessionsByWorkspaceId((current) => {
            const nextItems = mergeFetchedSessionsWithPending(workspace.id, items, current[workspace.id] ?? []);
            const next = { ...current, [workspace.id]: nextItems };
            sessionsByWorkspaceIdRef.current = next;
            return next;
          });
          setErrorsByWorkspaceId((current) => ({ ...current, [workspace.id]: null }));
          setWorkspaceConnectionOverrides((current) => {
            if (isRemoteOpenworkWorkspace) {
              return {
                ...current,
                [workspace.id]: {
                  status: "connected",
                  message: items.length > 0
                    ? t("workspace_list.connected_loaded_tasks", { count: items.length })
                    : t("workspace.connected_no_tasks"),
                  checkedAt: Date.now(),
                },
              };
            }
            if (current[workspace.id]?.status !== "error") return current;
            const next = { ...current };
            delete next[workspace.id];
            return next;
          });
          setRetryingWorkspaceIds((current) =>
            current.includes(workspace.id) ? current.filter((id) => id !== workspace.id) : current,
          );
          // When a workspace returns zero sessions during the initial batch
          // load, OpenCode may still be warming up its index.  Schedule a
          // single delayed retry so the sidebar doesn't stay permanently
          // empty while the managed engine finishes starting.
          if (items.length === 0 && attempt === 0) {
            window.setTimeout(() => {
              if (backgroundSessionLoadInFlight.current.get(workspace.id)) return;
              backgroundSessionLoadInFlight.current.delete(workspace.id);
              void fetchOnce(workspace, 1);
            }, 3_000);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : t("app.unknown_error");
          // The first cold call to OpenCode's /session endpoint often hits
          // the 12s server timeout while the daemon finishes warming up
          // its index. Retry silently with backoff until we get a response
          // or run out of attempts — the sidebar keeps its "loading" state
          // in the meantime instead of flashing "error" next to the
          // workspace name.
          if (attempt + 1 < MAX_ATTEMPTS && isTransientStartupError(message)) {
            if (backgroundSessionLoadInFlight.current.get(workspace.id) === requestStartedAt) {
              backgroundSessionLoadInFlight.current.delete(workspace.id);
            }
            await new Promise((r) => window.setTimeout(r, backoffMs(attempt)));
            await fetchOnce(workspace, attempt + 1);
            return;
          }
          // Final failure: keep local workspace startup quiet, but give
          // remote workers a precise endpoint/token/workspace diagnostic.
          if (workspace.workspaceType === "remote") {
            const connectionState = await diagnoseRemoteWorkspaceTaskLoadFailure(workspace, message);
            setErrorsByWorkspaceId((current) => ({
              ...current,
              [workspace.id]: connectionState.message ?? "Remote worker connection failed.",
            }));
            setWorkspaceConnectionOverrides((current) => {
              return {
                ...current,
                [workspace.id]: connectionState,
              };
            });
          }
          setRetryingWorkspaceIds((current) =>
            current.includes(workspace.id) ? current.filter((id) => id !== workspace.id) : current,
          );
        } finally {
          if (backgroundSessionLoadInFlight.current.get(workspace.id) === requestStartedAt) {
            backgroundSessionLoadInFlight.current.delete(workspace.id);
          }
        }
      };

      await Promise.all(workspaces.map((workspace) => fetchOnce(workspace, 0)));
    },
    [endpointForWorkspace, mergeFetchedSessionsWithPending],
  );

  const refreshRouteState = useCallback(async () => {
    // Dedupe: if a refresh is already running, skip this call. Fast workspace
    // switches used to fire 5-6 overlapping refreshRouteState() calls which
    // each fetched workspaces + sessions for every workspace. That workload
    // multiplied quickly on the event loop and caused the UI to freeze.
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setLoading(true);
    setRouteError(null);
    let desktopList: WorkspaceList | null = null;
    let desktopWorkspaces = workspacesRef.current;
    let routeReadyAfterRefresh = true;
    try {
      if (isDesktopRuntime()) {
        try {
          desktopList = await workspaceBootstrap() as WorkspaceList;
          desktopWorkspaces = (desktopList.workspaces ?? []).map(mapDesktopWorkspace);
        } catch (error) {
          const message = describeRouteError(error);
          console.error("[session-route] workspaceBootstrap failed", error);
          recordInspectorEvent("route.workspace_bootstrap.error", {
            route: "session",
            message,
            preservedWorkspaceCount: workspacesRef.current.length,
          });
          desktopWorkspaces = workspacesRef.current;
        }
      }

      const { normalizedBaseUrl, resolvedToken, resolvedHostToken, hostInfo } = await resolveOpenworkConnection();
      onHostInfo(hostInfo);
      if (!normalizedBaseUrl || !resolvedToken) {
        // Keep `localServerRef` in lockstep with the disconnected state.
        // Otherwise a previously-cached baseUrl/token would still resolve a
        // (now invalid) endpoint for any callback that consults the ref.
        localServerRef.current = { baseUrl: "", token: "" };
        setClient(null);
        setBaseUrl("");
        setToken("");
        const orderedDesktopWorkspaces = orderRouteWorkspaces(desktopWorkspaces, workspaceOrderIdsRef.current);
        setWorkspaces(orderedDesktopWorkspaces);
        sessionsByWorkspaceIdRef.current = {};
        setSessionsByWorkspaceId({});
        setErrorsByWorkspaceId({});
        setLegacySelectedWorkspaceId(resolveWorkspaceListSelectedId(desktopList) || orderedDesktopWorkspaces[0]?.id || "");
        return;
      }

      // Update the local-server ref synchronously, BEFORE we kick off any
      // workspace-scoped requests below. `endpointForWorkspace` reads from
      // this ref synchronously; the `useEffect` that mirrors `[baseUrl,
      // token]` into the ref doesn't run until after the next React commit,
      // which is too late for the `activateWorkspace` and
      // `loadWorkspaceSessionsInBackground` calls that fire later in this
      // function. Stale ref => `resolveWorkspaceEndpoint` returns null for
      // local workspaces => sidebar gets stuck in "loading" forever.
      localServerRef.current = { baseUrl: normalizedBaseUrl, token: resolvedToken };

      const openworkClient = createOpenworkServerClient({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken,
        hostToken: resolvedHostToken || undefined,
      });
      const list = await openworkClient.listWorkspaces();
      const nextWorkspaces = orderRouteWorkspaces(
        mergeRouteWorkspaces(list.items, desktopWorkspaces),
        workspaceOrderIdsRef.current,
      );

      // Preserve any sessions we already have cached so switching routes
      // doesn't erase the sidebar while we refetch.
      const alreadyLoadedWorkspaceIds = new Set(Object.keys(sessionsByWorkspaceIdRef.current));
      const cachedEntries = nextWorkspaces.map((workspace) => ({
        workspaceId: workspace.id,
        sessions: sessionsByWorkspaceIdRef.current[workspace.id] ?? [],
      }));
      // Prefer, in order: the URL-selected workspace (if it owns the session),
      // the user's last-active workspace from localStorage, the desktop's
      // activeId, the server's activeId, then the first known workspace.
      const persistedActiveId = readActiveWorkspaceId();
      let nextWorkspaceId =
        (routeWorkspaceId && nextWorkspaces.some((w) => w.id === routeWorkspaceId)
          ? routeWorkspaceId
          : "") ||
        (persistedActiveId && nextWorkspaces.some((w) => w.id === persistedActiveId)
          ? persistedActiveId
          : "") ||
        resolveWorkspaceListSelectedId(desktopList) ||
        list.activeId?.trim() ||
        nextWorkspaces[0]?.id ||
        "";
      if (selectedSessionId) {
        const match = cachedEntries.find((entry) =>
          entry.sessions.some((session) => session?.id === selectedSessionId),
        );
        if (match?.workspaceId) nextWorkspaceId = match.workspaceId;
      }

      setClient(openworkClient);
      setBaseUrl(normalizedBaseUrl);
      setToken(resolvedToken);
      setWorkspaces(nextWorkspaces);
      const nextSessionsByWorkspaceId = Object.fromEntries(cachedEntries.map((entry) => [entry.workspaceId, entry.sessions]));
      sessionsByWorkspaceIdRef.current = nextSessionsByWorkspaceId;
      setSessionsByWorkspaceId(nextSessionsByWorkspaceId);
      setErrorsByWorkspaceId((previous) => {
        const next: Record<string, string | null> = {};
        for (const workspace of nextWorkspaces) {
          next[workspace.id] = previous[workspace.id] ?? null;
        }
        return next;
      });
      setRetryingWorkspaceIds(
        cachedEntries.flatMap((entry) =>
          entry.sessions.length === 0 &&
          (entry.workspaceId === nextWorkspaceId || !alreadyLoadedWorkspaceIds.has(entry.workspaceId))
            ? [entry.workspaceId]
            : [],
        ),
      );
      setLegacySelectedWorkspaceId(nextWorkspaceId);
      writeActiveWorkspaceId(nextWorkspaceId || null);
      // Mark the chosen workspace as active on the server so that the
      // OpenCode engine bound to it re-reads opencode.jsonc and applies
      // permissions. Fire-and-forget; the route is idempotent and any
      // transport failure is non-fatal. See issue #870.
      if (nextWorkspaceId && list.activeId !== nextWorkspaceId && !launchActivatedWorkspaceIdsRef.current.has(nextWorkspaceId)) {
        launchActivatedWorkspaceIdsRef.current.add(nextWorkspaceId);
        const nextWorkspace = nextWorkspaces.find((workspace) => workspace.id === nextWorkspaceId) ?? null;
        const nextEndpoint = endpointForWorkspace(nextWorkspace);
        if (nextEndpoint) {
          void nextEndpoint.client.activateWorkspace(nextEndpoint.workspaceId).catch(() => undefined);
        }
      }
      recordInspectorEvent("route.refresh.complete", {
        workspaces: nextWorkspaces.length,
        selectedWorkspaceId: nextWorkspaceId,
        errors: {},
      });

      // Session list comes from OpenCode's index and can be slow on cold
      // boot. Kick it off in the background instead of blocking the route
      // so the UI is interactive immediately; the sidebar shows a
      // loading state per-workspace until the list arrives.
      const selectedWorkspace = nextWorkspaces.find((workspace) => workspace.id === nextWorkspaceId);
      const backgroundWorkspaces = nextWorkspaces.filter(
        (workspace) => workspace.id === nextWorkspaceId || !alreadyLoadedWorkspaceIds.has(workspace.id),
      );
      if (backgroundWorkspaces.length > 0) {
        const orderedWorkspaces = selectedWorkspace
          ? [selectedWorkspace, ...backgroundWorkspaces.filter((workspace) => workspace.id !== selectedWorkspace.id)]
          : backgroundWorkspaces;
        void loadWorkspaceSessionsInBackground(orderedWorkspaces);
      }
    } catch (error) {
      const message = describeRouteError(error);
      console.error("[session-route] refreshRouteState failed", error);
      recordInspectorEvent("route.refresh.error", {
        route: "session",
        message,
        preservedWorkspaceCount: desktopWorkspaces.length,
      });
      setRouteError(message);
      if (desktopWorkspaces.length > 0) {
        const orderedDesktopWorkspaces = orderRouteWorkspaces(desktopWorkspaces, workspaceOrderIdsRef.current);
        setWorkspaces(orderedDesktopWorkspaces);
        setLegacySelectedWorkspaceId((current) =>
          current || resolveWorkspaceListSelectedId(desktopList) || orderedDesktopWorkspaces[0]?.id || "",
        );
      }
    } finally {
      setLoading(false);
      refreshInFlightRef.current = false;
      // Tell the boot overlay the first route data load has completed so
      // the overlay dismisses after BOTH the desktop boot and the workspace
      // list/sessions are ready.
      if (routeReadyAfterRefresh) {
        markBootRouteReady();
      }
    }
  }, [loadWorkspaceSessionsInBackground, markBootRouteReady, routeWorkspaceId, selectedSessionId]);
  const handleRuntimeSessionUpdated = useCallback((update: { sessionId: string; info: Record<string, unknown> }) => {
    if (!selectedWorkspaceId) return;
    setSessionsByWorkspaceId((current) => {
      const list = current[selectedWorkspaceId] ?? [];
      const index = list.findIndex((session) => session?.id === update.sessionId);
      if (index < 0) return current;
      const nextSession = { ...list[index], ...update.info, id: update.sessionId };
      if (JSON.stringify(nextSession) === JSON.stringify(list[index])) return current;
      const nextList = [...list];
      nextList[index] = nextSession;
      const next = { ...current, [selectedWorkspaceId]: nextList };
      sessionsByWorkspaceIdRef.current = next;
      return next;
    });
  }, [selectedWorkspaceId]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    workspaceOrderIdsRef.current = workspaceOrderIds;
  }, [workspaceOrderIds]);

  useEffect(() => {
    const activeWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    setWorkspaceConnectionOverrides((current) => {
      let changed = false;
      const next: Record<string, WorkspaceConnectionState> = {};
      for (const [workspaceId, state] of Object.entries(current)) {
        if (activeWorkspaceIds.has(workspaceId)) {
          next[workspaceId] = state;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [workspaces]);

  useEffect(() => {
    sessionsByWorkspaceIdRef.current = sessionsByWorkspaceId;
  }, [sessionsByWorkspaceId]);

  const handleRemoteWorkspaceConnectionSaved = useCallback(
    async (workspaceId: string) => {
      delete remoteWorkspaceCheckRunRef.current[workspaceId];
      setWorkspaceConnectionOverrides((current) => {
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      setRetryingWorkspaceIds((current) => current.filter((id) => id !== workspaceId));
      await refreshRouteState();
    },
    [refreshRouteState],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (cancelled) return;
        await refreshRouteState();
      } finally {
        if (cancelled) return;
      }
    })();

    const handleSettingsChange = () => {
      onServerSettingsChanged();
      // Self-heal: if the previous refresh got stuck mid-flight (e.g. macOS
      // backgrounded the webview and never let a fetch resolve), clear the
      // guard so a re-entry after resume actually goes through.
      refreshInFlightRef.current = false;
      void refreshRouteState();
    };
    window.addEventListener("openwork-server-settings-changed", handleSettingsChange);

    // Also retry on visibility flip independently — even when nobody else
    // dispatches the settings event.
    const handleVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      refreshInFlightRef.current = false;
      void refreshRouteState();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      cancelled = true;
      if (startupRetryTimerRef.current !== null) {
        window.clearTimeout(startupRetryTimerRef.current);
        startupRetryTimerRef.current = null;
      }
      window.removeEventListener("openwork-server-settings-changed", handleSettingsChange);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, [refreshRouteState]);

  // Inspector wiring: publish the route's current state so an external
  // operator (or an AI driver using browser tools) can call
  // `window.__openwork.snapshot()` or `window.__openwork.slice("route")` and
  // see workspaces / sessions / connection info without walking the DOM.
  useEffect(() => {
    const dispose = publishInspectorSlice("route", () => ({
      loading,
      retryingWorkspaceIds,
      baseUrl,
      tokenPresent: token.length > 0,
      connected: Boolean(client),
      routeError,
      selectedSessionId,
      selectedWorkspaceId,
      persistedActiveWorkspaceId: readActiveWorkspaceId(),
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        displayNameResolved: workspace.displayNameResolved,
        workspaceType: workspace.workspaceType,
        path: workspace.path,
        sessionCount: (sessionsByWorkspaceId[workspace.id] ?? []).length,
        loading: retryingWorkspaceIds.includes(workspace.id),
        error: errorsByWorkspaceId[workspace.id] ?? null,
      })),
      sessionsByWorkspaceId: Object.fromEntries(
        Object.entries(sessionsByWorkspaceId).map(([wsId, items]) => [
          wsId,
          (items ?? []).map((session) => ({
            id: session?.id ?? null,
            title: session?.title ?? null,
            directory: session?.directory ?? null,
          })),
        ]),
      ),
    }));
    return dispose;
  }, [
    baseUrl,
    client,
    errorsByWorkspaceId,
    loading,
    retryingWorkspaceIds,
    selectedSessionId,
    selectedWorkspaceId,
    routeError,
    sessionsByWorkspaceId,
    token,
    workspaces,
  ]);

  // Once workspaces + sessions are loaded and the URL has no sessionId, try to
  // restore the last session the user opened in the active workspace.
  useEffect(() => {
    if (loading) return;
    if (routeWorkspaceId && workspaces.length > 0 && !workspaces.some((workspace) => workspace.id === routeWorkspaceId)) {
      const fallbackWorkspaceId = workspaces.some((workspace) => workspace.id === legacySelectedWorkspaceId)
        ? legacySelectedWorkspaceId
        : workspaces[0]?.id || "";
      if (fallbackWorkspaceId) {
        navigateToWorkspaceSession(fallbackWorkspaceId, selectedSessionId, { replace: true });
      }
      return;
    }
    if (!routeWorkspaceId && selectedWorkspaceId) {
      navigateToWorkspaceSession(selectedWorkspaceId, selectedSessionId, { replace: true });
      return;
    }
    if (selectedSessionId) return;
    if (!selectedWorkspaceId) return;
    const remembered = readLastSessionFor(selectedWorkspaceId);
    if (!remembered) return;
    const sessions = sessionsByWorkspaceId[selectedWorkspaceId] ?? [];
    if (!sessions.some((session) => session?.id === remembered)) return;
    navigateToWorkspaceSession(selectedWorkspaceId, remembered, { replace: true });
  }, [
    loading,
    legacySelectedWorkspaceId,
    navigateToWorkspaceSession,
    routeWorkspaceId,
    selectedSessionId,
    selectedWorkspaceId,
    sessionsByWorkspaceId,
    workspaces,
  ]);

  // Redirect to /welcome when no workspaces exist and the user hasn't
  // completed onboarding. This fires after the initial route refresh so
  // `loading` is false and we know for sure there are zero workspaces.
  useEffect(() => {
    if (loading) return;
    if (workspaces.length > 0) return;
    if (local.prefs.hasCompletedOnboarding) return;
    navigate("/welcome", { replace: true });
  }, [loading, local.prefs.hasCompletedOnboarding, navigate, workspaces.length]);

  // NOTE: Blueprint seeding was removed from the route.
  // It was firing `materializeBlueprintSessions` + a session re-fetch on every
  // workspace change, which cascaded setState updates and froze the UI after
  // a few rapid switches. Empty workspaces now simply show "No tasks yet." and
  // the user creates their first session explicitly via "New task". Seeding
  // can be reintroduced later as a one-shot triggered from a button or from
  // the onboarding flow, not from the route effect loop.
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    if (loading) return;
    if (client) {
      reconnectAttemptedWorkspaceIdRef.current = "";
      return;
    }
    if (!selectedWorkspace || selectedWorkspace.workspaceType !== "local") return;
    const workspaceId = selectedWorkspace.id?.trim() ?? "";
    if (!workspaceId || reconnectAttemptedWorkspaceIdRef.current === workspaceId) return;
    reconnectAttemptedWorkspaceIdRef.current = workspaceId;

    void ensureDesktopLocalOpenworkConnection({
      route: "session",
      workspace: selectedWorkspace,
      allWorkspaces: workspaces,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : describeRouteError(error);
      setRouteError(message);
    });
  }, [client, loading, selectedWorkspace, workspaces]);

  const selectedWorkspaceRoot = selectedWorkspace?.path?.trim() || "";
  // Single source of truth for the selected workspace's server URL/token/id.
  // For remote workspaces this is the worker that owns the workspace; for
  // local workspaces it's the user's local OpenWork server.
  const selectedWorkspaceEndpoint = useMemo(
    () => resolveWorkspaceEndpoint(selectedWorkspace, { baseUrl, token }),
    [baseUrl, selectedWorkspace, token],
  );
  const selectedWorkspaceServerToken = selectedWorkspaceEndpoint?.token ?? "";
  const opencodeBaseUrl = selectedWorkspaceEndpoint?.opencodeBaseUrl ?? "";
  const selectedWorkspaceIsLoading = retryingWorkspaceIds.includes(selectedWorkspaceId);
  const selectedWorkspaceError = errorsByWorkspaceId[selectedWorkspaceId] ?? null;
  const selectedSessionKnown = Boolean(
    selectedSessionId &&
      (sessionsByWorkspaceId[selectedWorkspaceId] ?? []).some((session) => session?.id === selectedSessionId),
  );
  const routeNotFoundMessage = (() => {
    if (loading) return null;
    if (routeWorkspaceId && !selectedWorkspace) {
      return "Workspace was not found. Select a new workspace from the sidebar.";
    }
    if (selectedSessionId && !selectedWorkspaceIsLoading && !selectedSessionKnown) {
      return "Session was not found. Select a new session from the sidebar.";
    }
    return null;
  })();
  // Boot-level loading blocks the whole UI. Session-list retries only fill the
  // sidebar; they must not gate the composer/New task.
  const effectiveLoading = loading;

  const opencodeClient = useMemo(
    () =>
      opencodeBaseUrl && selectedWorkspaceServerToken && !selectedWorkspaceError
        ? createClient(opencodeBaseUrl, selectedWorkspaceRoot || undefined, {
            token: selectedWorkspaceServerToken,
            mode: "openwork",
          })
        : null,
    [opencodeBaseUrl, selectedWorkspaceError, selectedWorkspaceRoot, selectedWorkspaceServerToken],
  );
  const runRemoteWorkspaceConnectionCheck = useCallback(
    async (workspaceId: string, mode: "test" | "recover") => {
      const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
      if (!workspace || workspace.workspaceType !== "remote") return false;
      const connectionKey = getRemoteWorkspaceConnectionKey(workspace);
      remoteWorkspaceCheckRunCounterRef.current += 1;
      const runId = String(remoteWorkspaceCheckRunCounterRef.current);
      remoteWorkspaceCheckRunRef.current[workspaceId] = runId;

      setWorkspaceConnectionOverrides((current) => ({
        ...current,
        [workspaceId]: {
          status: "connecting",
          message: t("config.testing_connection"),
          checkedAt: null,
        },
      }));

      const result = await testRemoteWorkspaceConnection(workspace);
      const currentWorkspace = workspacesRef.current.find((item) => item.id === workspaceId);
      if (
        remoteWorkspaceCheckRunRef.current[workspaceId] !== runId ||
        !currentWorkspace ||
        getRemoteWorkspaceConnectionKey(currentWorkspace) !== connectionKey
      ) {
        if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
          delete remoteWorkspaceCheckRunRef.current[workspaceId];
        }
        return false;
      }
      setWorkspaceConnectionOverrides((current) => ({
        ...current,
        [workspaceId]: result.state,
      }));

      if (!result.ok) {
        setErrorsByWorkspaceId((current) => ({
          ...current,
          [workspaceId]: result.state.message ?? "Remote worker connection failed.",
        }));
        if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
          delete remoteWorkspaceCheckRunRef.current[workspaceId];
        }
        return false;
      }

      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      setRetryingWorkspaceIds((current) => current.filter((id) => id !== workspaceId));
      if (mode === "recover") {
        await refreshRouteState();
      }
      if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
        delete remoteWorkspaceCheckRunRef.current[workspaceId];
      }
      return true;
    },
    [refreshRouteState],
  );

  return {
    navigateToWorkspaceSession,
    routeWorkspaceId,
    selectedSessionId,
    loading,
    effectiveLoading,
    client,
    baseUrl,
    token,
    workspaces,
    setWorkspaces,
    workspacesRef,
    workspaceOrderIds,
    setWorkspaceOrderIds,
    workspaceOrderIdsRef,
    sessionsByWorkspaceId,
    setSessionsByWorkspaceId,
    sessionsByWorkspaceIdRef,
    errorsByWorkspaceId,
    setErrorsByWorkspaceId,
    workspaceConnectionOverrides,
    routeError,
    setRouteError,
    legacySelectedWorkspaceId,
    setLegacySelectedWorkspaceId,
    retryingWorkspaceIds,
    setRetryingWorkspaceIds,
    refreshInFlightRef,
    startupRetryTimerRef,
    selectedWorkspaceId,
    selectedWorkspace,
    selectedWorkspaceRoot,
    selectedWorkspaceEndpoint,
    selectedWorkspaceServerToken,
    opencodeBaseUrl,
    opencodeClient,
    selectedWorkspaceIsLoading,
    selectedWorkspaceError,
    routeNotFoundMessage,
    endpointForWorkspace,
    refreshRouteState,
    loadWorkspaceSessionsInBackground,
    rememberPendingCreatedSession,
    handleRuntimeSessionUpdated,
    handleRemoteWorkspaceConnectionSaved,
    runRemoteWorkspaceConnectionCheck,
  };
}
