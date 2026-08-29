// The session route's data + navigation core: workspace/session loading
// (refreshRouteState + background session fetch), endpoint and opencode
// client resolution, URL-derived selection, redirects (fallback workspace,
// welcome), desktop local-server reconnect, remote
// connection checks, and the route inspector slice. Extracted verbatim from
// session-route.tsx as the final step of its decomposition; the route keeps
// composition, handlers, and JSX.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import type { Session } from "@opencode-ai/sdk/v2/client";

import {
  publishInspectorOpencodeClient,
  publishInspectorSlice,
  recordInspectorEvent,
} from "@/app/lib/app-inspector";
import {
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  type OpenworkServerInfo,
  type WorkspaceList,
} from "@/app/lib/desktop";
import { createClient } from "@/app/lib/opencode";
import { getNativeSession } from "@/app/lib/opencode-session-native";
import { createOpenworkServerClient, type OpenworkServerClient } from "@/app/lib/openwork-server";
import { readDenBootstrapConfig } from "@/app/lib/den";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { WorkspaceConnectionState } from "@/app/types";
import { normalizeDirectoryPath } from "@/app/utils";
import { t } from "@/i18n";
import {
  createWorkspaceServerClientResolver,
  useWorkspaceServerClient,
} from "@/react-app/infra/workspace-server-client";
import {
  diagnoseRemoteWorkspaceTaskLoadFailure,
  getRemoteWorkspaceConnectionKey,
  testRemoteWorkspaceConnection,
} from "@/react-app/domains/workspace/remote-workspace-diagnostics";
import { useLocal } from "@/react-app/kernel/local-provider";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { useBootState } from "./boot-state";
import {
  ensureDesktopLocalOpenworkConnection,
  shouldAttemptDesktopLocalReconnect,
} from "./desktop-local-openwork";
import { resolveOpenworkConnection } from "./openwork-connection";
import {
  commitRouteWorkspaceSelection,
  createRouteRefreshLifecycle,
  createRouteWorkspaceLoadCoalescer,
  mapRouteWorkspaceLoads,
  planRouteConnectionGap,
  planRouteWorkspaceLoads,
  routeWorkspaceSelectionCommitter,
} from "./route-refresh-control";
import {
  classifyRouteSessionReadError,
  describeRouteError,
  listRouteSessions,
  mapDesktopWorkspace,
  refreshRouteWorkspaceListState,
  stabilizeRouteWorkspaceOrder,
  type RouteSession,
  type RouteWorkspace,
} from "./route-workspaces";
import {
  readActiveWorkspaceId,
  readWorkspaceOrderIds,
  writeActiveWorkspaceId,
  writeWorkspaceOrderIds,
} from "./session-memory";
import {
  legacySessionRoute,
  mergeWorkspaceRouteSession,
  preserveWorkspaceRouteSession,
  removeWorkspaceRouteSession,
  sessionIdForLegacyWorkspaceInference,
  automationsRoute,
  dashboardRoute,
  workspaceExtensionsRoute,
  workspaceSessionRoute,
} from "./workspace-routes";

export type UseWorkspaceRouteStateInput = {
  developerMode: boolean;
  workspaceRoute?: "session" | "automations" | "dashboard";
  /** Invoked when the openwork-server settings-changed event fires (the route bumps its settings version). */
  onServerSettingsChanged: () => void;
  /** Receives the local openwork-server host info discovered during refresh. */
  onHostInfo: (info: OpenworkServerInfo | null) => void;
};

type ModernRouteSessionResolution =
  | { key: string; status: "loading" }
  | { key: string; status: "not-found" | "error"; message: string };

/** Hard ceiling for each blocking await of a route refresh. A hung desktop
 * bridge or unresponsive server otherwise leaves `loading` true forever,
 * which the session pane renders as an indefinite loading state. */
const ROUTE_REFRESH_STEP_TIMEOUT_MS = 15_000;
const ROUTE_WORKSPACE_ACTIVATION_SETTLE_MS = 750;

function withRouteRefreshTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${label} did not respond within ${ROUTE_REFRESH_STEP_TIMEOUT_MS / 1000}s`)),
      ROUTE_REFRESH_STEP_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function useWorkspaceRouteState(input: UseWorkspaceRouteStateInput) {
  const { developerMode, onServerSettingsChanged, onHostInfo, workspaceRoute = "session" } = input;
  const navigate = useNavigate();
  const location = useLocation();
  const local = useLocal();
  const denAuth = useDenAuth();
  const params = useParams<{ workspaceId?: string; sessionId?: string }>();
  const routeWorkspaceId = params.workspaceId?.trim() || "";
  const selectedSessionId = params.sessionId?.trim() || null;
  const extensionsRouteActive = /^\/(?:workspace\/[^/]+\/)?extensions(?:\/|$)/.test(location.pathname);
  const extensionsRoutePath = extensionsRouteActive
    ? location.pathname
      .replace(/^\/workspace\/[^/]+\/extensions\/?/, "")
      .replace(/^\/extensions\/?/, "")
      .replace(/^\/+|\/+$/g, "")
    : "";
  const workspaceInferenceSessionId = sessionIdForLegacyWorkspaceInference(routeWorkspaceId, selectedSessionId);
  const legacyWorkspaceInferenceKey = routeWorkspaceId ? "" : workspaceInferenceSessionId;
  const routeWorkspaceIdRef = useRef(routeWorkspaceId);
  routeWorkspaceIdRef.current = routeWorkspaceId;
  const workspaceInferenceSessionIdRef = useRef(workspaceInferenceSessionId);
  workspaceInferenceSessionIdRef.current = workspaceInferenceSessionId;
  const navigateToWorkspaceSession = useCallback((workspaceId: string, sessionId?: string | null, options?: { replace?: boolean }) => {
    const id = workspaceId.trim();
    if (!id) {
      navigate(legacySessionRoute(sessionId), options);
      return;
    }
    navigate(workspaceSessionRoute(id, sessionId), options);
  }, [navigate]);
  const normalizeWorkspaceRoute = useCallback((workspaceId: string, sessionId?: string | null, options?: { replace?: boolean }) => {
    if (extensionsRouteActive) {
      navigate(workspaceExtensionsRoute(workspaceId, extensionsRoutePath), options);
      return;
    }
    if (workspaceRoute === "automations") {
      if (/^\/automations(?:\/|$)/.test(location.pathname)) return;
      navigate(automationsRoute(), options);
      return;
    }
    if (workspaceRoute === "dashboard") {
      if (/^\/dashboard(?:\/|$)/.test(location.pathname)) return;
      navigate(dashboardRoute(), options);
      return;
    }
    navigateToWorkspaceSession(workspaceId, sessionId, options);
  }, [extensionsRouteActive, extensionsRoutePath, location.pathname, navigate, navigateToWorkspaceSession, workspaceRoute]);

  const {
    markRouteReady: markBootRouteReady,
    phase: bootPhase,
    routeReady: bootRouteReady,
  } = useBootState();
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
  // True while the desktop local server has not (re)published a usable base
  // URL/token — a restart or boot gap. The route retains its last usable
  // connection state during this window instead of clearing it.
  const [connectionPending, setConnectionPending] = useState(false);
  const [modernRouteSessionResolution, setModernRouteSessionResolution] = useState<ModernRouteSessionResolution | null>(null);
  const [routeRefreshVersion, setRouteRefreshVersion] = useState(0);
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
  // We refresh the memoized endpoint resolver behind a ref so the
  // `endpointForWorkspace` callback stays permanently stable. Otherwise it
  // would change on every `setBaseUrl`/`setToken`, which used to cascade up
  // through `loadWorkspaceSessionsInBackground` and `refreshRouteState` and
  // produce a tight render-refresh-setWorkspaces loop.
  const currentWorkspaceServerClientResolver = useMemo(
    () => createWorkspaceServerClientResolver({ baseUrl, token }),
    [baseUrl, token],
  );
  const workspaceServerClientResolverRef = useRef(currentWorkspaceServerClientResolver);
  workspaceServerClientResolverRef.current = currentWorkspaceServerClientResolver;
  const updateLocalServer = useCallback((next: { baseUrl: string; token: string }) => {
    const resolver = createWorkspaceServerClientResolver(next);
    workspaceServerClientResolverRef.current = resolver;
    return resolver;
  }, []);
  const endpointForWorkspace = useCallback(
    (workspace: RouteWorkspace | null | undefined): ResolvedWorkspaceEndpoint | null =>
      workspaceServerClientResolverRef.current(workspace),
    [],
  );
  const refreshLifecycleRef = useRef(createRouteRefreshLifecycle());
  const workspacesRef = useRef<RouteWorkspace[]>([]);
  const workspaceOrderIdsRef = useRef(workspaceOrderIds);
  const remoteWorkspaceCheckRunRef = useRef<Record<string, string>>({});
  const remoteWorkspaceCheckRunCounterRef = useRef(0);
  const sessionsByWorkspaceIdRef = useRef<Record<string, RouteSession[]>>({});
  const pendingCreatedSessionIdsRef = useRef<Record<string, Record<string, number>>>({});
  const hydratedRouteSessionIdsRef = useRef<Record<string, string>>({});
  const startupRetryTimerRef = useRef<number | null>(null);
  const [retryingWorkspaceIds, setRetryingWorkspaceIds] = useState<string[]>([]);
  const reconnectAttemptedWorkspaceIdRef = useRef("");
  const backgroundSessionLoadCoalescerRef = useRef(createRouteWorkspaceLoadCoalescer());
  const loadedWorkspaceIdsRef = useRef(new Set<string>());
  const serverActiveWorkspaceIdRef = useRef("");
  const workspaceSelectionCommitTimerRef = useRef<number | null>(null);
  const commitStableWorkspaceOrder = useCallback((nextWorkspaces: RouteWorkspace[]) => {
    const currentOrderIds = workspaceOrderIdsRef.current;
    const stable = stabilizeRouteWorkspaceOrder(nextWorkspaces, currentOrderIds);
    const orderChanged = stable.orderIds.length !== currentOrderIds.length
      || stable.orderIds.some((id, index) => id !== currentOrderIds[index]);

    if (orderChanged) {
      workspaceOrderIdsRef.current = stable.orderIds;
      setWorkspaceOrderIds(stable.orderIds);
      writeWorkspaceOrderIds(stable.orderIds);
    }

    return stable.workspaces;
  }, []);
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
    let merged = fetched;
    if (pending) {
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

      if (preserved.length > 0) merged = [...preserved, ...fetched];
    }

    const hydratedSessionId = hydratedRouteSessionIdsRef.current[workspaceId];
    if (hydratedSessionId && fetched.some((session) => session.id === hydratedSessionId)) {
      delete hydratedRouteSessionIdsRef.current[workspaceId];
      return merged;
    }
    return preserveWorkspaceRouteSession(
      merged,
      current,
      hydratedSessionId,
    );
  }, []);
  const loadWorkspaceSessionsInBackground = useCallback(
    async (workspaces: RouteWorkspace[]) => {
      const MAX_ATTEMPTS = 6;
      const backoffMs = (attempt: number) => Math.min(500 * Math.pow(2, attempt), 4_000);

      const fetchWithRetries = async (workspace: RouteWorkspace, attempt: number): Promise<void> => {
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
          const fetchedItems = await listRouteSessions(endpoint);
          const workspaceRoot = normalizeDirectoryPath(workspace.path ?? "");
          const items = workspaceRoot && !isRemoteOpenworkWorkspace
            ? fetchedItems.filter((session) =>
                normalizeDirectoryPath(session?.directory ?? "") === workspaceRoot,
              )
            : fetchedItems;
          const current = sessionsByWorkspaceIdRef.current;
          const nextItems = mergeFetchedSessionsWithPending(workspace.id, items, current[workspace.id] ?? []);
          const next = { ...current, [workspace.id]: nextItems };
          sessionsByWorkspaceIdRef.current = next;
          setSessionsByWorkspaceId(next);
          loadedWorkspaceIdsRef.current.add(workspace.id);
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
              if (backgroundSessionLoadCoalescerRef.current.isInFlight(workspace.id)) return;
              void backgroundSessionLoadCoalescerRef.current.run(
                workspace.id,
                () => fetchWithRetries(workspace, 1),
              );
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
          if (attempt + 1 < MAX_ATTEMPTS && classifyRouteSessionReadError(error) === "retryable") {
            await new Promise((r) => window.setTimeout(r, backoffMs(attempt)));
            await fetchWithRetries(workspace, attempt + 1);
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
        }
      };

      await mapRouteWorkspaceLoads(workspaces, (workspace) =>
        backgroundSessionLoadCoalescerRef.current.run(
          workspace.id,
          () => fetchWithRetries(workspace, 0),
        ),
      );
    },
    [endpointForWorkspace, mergeFetchedSessionsWithPending],
  );
  const reloadWorkspaceSessions = useCallback(async (workspaceId: string): Promise<void> => {
    const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
    if (!workspace) return;
    loadedWorkspaceIdsRef.current.delete(workspaceId);
    await loadWorkspaceSessionsInBackground([workspace]);
  }, [loadWorkspaceSessionsInBackground]);
  const workspaceSelectionCommitRef = useRef<(workspaceId: string) => Promise<void>>(async () => undefined);
  workspaceSelectionCommitRef.current = async (workspaceId) => {
    await commitRouteWorkspaceSelection({
      workspaceId,
      desktopRuntime: isDesktopRuntime(),
      setDesktopSelected: workspaceSetSelected,
      setDesktopRuntimeActive: workspaceSetRuntimeActive,
      activateWorkspace: async (selectedId) => {
        const workspace = workspacesRef.current.find((item) => item.id === selectedId) ?? null;
        const endpoint = endpointForWorkspace(workspace);
        if (!endpoint) throw new Error(`Workspace endpoint unavailable for ${selectedId}.`);
        if (workspace?.workspaceType === "local" && serverActiveWorkspaceIdRef.current === selectedId) return;
        await endpoint.client.activateWorkspace(endpoint.workspaceId, { persist: true });
        if (workspace?.workspaceType === "local") serverActiveWorkspaceIdRef.current = selectedId;
      },
    });
  };

  const refreshRouteState = useCallback(async (options?: { supersede?: boolean }) => {
    // Dedupe: if a refresh is already running, skip this call. Fast workspace
    // switches used to fire 5-6 overlapping refreshRouteState() calls which
    // each fetched workspaces + sessions for every workspace. That workload
    // multiplied quickly on the event loop and caused the UI to freeze.
    // Callers reacting to changed connection info pass `supersede` instead of
    // resetting the in-flight guard: the running attempt goes stale (its
    // remaining writes are discarded) rather than racing the new one.
    const attempt = refreshLifecycleRef.current.begin(options);
    if (!attempt) return;
    setLoading(true);
    setRouteError(null);
    let desktopList: WorkspaceList | null = null;
    let desktopWorkspaces = workspacesRef.current;
    let routeReadyAfterRefresh = true;
    try {
      if (isDesktopRuntime()) {
        try {
          desktopList = await withRouteRefreshTimeout(workspaceBootstrap(), "Desktop workspace bootstrap") as WorkspaceList;
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
      if (!attempt.isCurrent()) return;

      const { normalizedBaseUrl, resolvedToken, resolvedHostToken, hostInfo } = await withRouteRefreshTimeout(
        resolveOpenworkConnection(),
        "OpenWork server connection",
      );
      if (!attempt.isCurrent()) return;
      if (!normalizedBaseUrl || !resolvedToken) {
        const gapPlan = planRouteConnectionGap({ desktopRuntime: isDesktopRuntime() });
        routeReadyAfterRefresh = gapPlan.markRouteReady;
        if (gapPlan.retainExistingState) {
          // Transient desktop gap: the local server is booting or restarting
          // (app update, remote-access toggle, slow cold start) and has not
          // republished its ephemeral base URL/tokens yet. Retain the
          // workspaces, session lists, and host info as display state, but
          // quarantine the live connection: the previous loopback port is no
          // longer owned by our server, and a request there would hand the
          // stale bearer token to whatever process binds the freed port.
          // Boot or the reconnect effect publishes fresh info and supersedes
          // this refresh. Only seed workspaces when the route has none so a
          // fresh renderer still shows the sidebar under the boot overlay.
          setConnectionPending(true);
          updateLocalServer({ baseUrl: "", token: "" });
          setClient(null);
          setBaseUrl("");
          setToken("");
          if (workspacesRef.current.length === 0 && desktopWorkspaces.length > 0) {
            const orderedDesktopWorkspaces = commitStableWorkspaceOrder(desktopWorkspaces);
            setWorkspaces(orderedDesktopWorkspaces);
            setLegacySelectedWorkspaceId(
              (current) => current || resolveWorkspaceListSelectedId(desktopList) || orderedDesktopWorkspaces[0]?.id || "",
            );
          }
          return;
        }
        onHostInfo(hostInfo);
        // Keep the workspace endpoint resolver in lockstep with the disconnected state.
        // Otherwise a previously-cached baseUrl/token would still resolve a
        // (now invalid) endpoint for any callback that consults the resolver ref.
        updateLocalServer({ baseUrl: "", token: "" });
        setClient(null);
        setBaseUrl("");
        setToken("");
        const orderedDesktopWorkspaces = commitStableWorkspaceOrder(desktopWorkspaces);
        setWorkspaces(orderedDesktopWorkspaces);
        sessionsByWorkspaceIdRef.current = {};
        setSessionsByWorkspaceId({});
        setErrorsByWorkspaceId({});
        setLegacySelectedWorkspaceId(resolveWorkspaceListSelectedId(desktopList) || orderedDesktopWorkspaces[0]?.id || "");
        return;
      }
      onHostInfo(hostInfo);

      // Update the local-server resolver synchronously, BEFORE we kick off any
      // workspace-scoped requests below. `endpointForWorkspace` reads from
      // this resolver synchronously; the render that mirrors `[baseUrl,
      // token]` into the resolver doesn't run until after the next React commit,
      // which is too late for the `loadWorkspaceSessionsInBackground` call
      // later in this function. Stale ref => `resolveWorkspaceEndpoint` returns null for
      // local workspaces => sidebar gets stuck in "loading" forever.
      updateLocalServer({ baseUrl: normalizedBaseUrl, token: resolvedToken });

      const openworkClient = createOpenworkServerClient({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken,
        hostToken: resolvedHostToken || undefined,
      });
      const workspaceListState = await refreshRouteWorkspaceListState({
        load: () => withRouteRefreshTimeout(openworkClient.listWorkspaces(), "Workspace list"),
        desktopWorkspaces,
        previousWorkspaces: workspacesRef.current,
        orderIds: workspaceOrderIdsRef.current,
        retryDelaysMs: [250, 750, 1_500],
      });
      if (!attempt.isCurrent()) return;
      if (!workspaceListState.usable || workspaceListState.error) {
        const message = workspaceListState.error
          ? describeRouteError(workspaceListState.error)
          : "Workspace list response did not include items.";
        console.warn("[session-route] workspace list degraded", workspaceListState.error ?? message);
        recordInspectorEvent("route.workspace_list.degraded", {
          route: "session",
          message,
          preservedWorkspaceCount: workspacesRef.current.length,
        });
        setRouteError(message);
      }
      const nextWorkspaces = commitStableWorkspaceOrder(workspaceListState.workspaces);
      serverActiveWorkspaceIdRef.current = workspaceListState.activeId ?? "";

      // Preserve any sessions we already have cached so switching routes
      // doesn't erase the sidebar while we refetch.
      const alreadyLoadedWorkspaceIds = new Set(loadedWorkspaceIdsRef.current);
      const cachedEntries = nextWorkspaces.map((workspace) => ({
        workspaceId: workspace.id,
        sessions: sessionsByWorkspaceIdRef.current[workspace.id] ?? [],
      }));
      // Prefer, in order: the URL-selected workspace (if it owns the session),
      // the user's last-active workspace from localStorage, the desktop's
      // activeId, the server's activeId, then the first known workspace.
      const persistedActiveId = readActiveWorkspaceId();
      let nextWorkspaceId =
        (routeWorkspaceIdRef.current && nextWorkspaces.some((w) => w.id === routeWorkspaceIdRef.current)
          ? routeWorkspaceIdRef.current
          : "") ||
        (persistedActiveId && nextWorkspaces.some((w) => w.id === persistedActiveId)
          ? persistedActiveId
          : "") ||
        resolveWorkspaceListSelectedId(desktopList) ||
        workspaceListState.activeId ||
        nextWorkspaces[0]?.id ||
        "";
      if (workspaceInferenceSessionIdRef.current) {
        const match = cachedEntries.find((entry) =>
          entry.sessions.some((session) => session?.id === workspaceInferenceSessionIdRef.current),
        );
        if (match?.workspaceId) nextWorkspaceId = match.workspaceId;
      }
      const backgroundWorkspaceIds = planRouteWorkspaceLoads(
        nextWorkspaces.map((workspace) => workspace.id),
        nextWorkspaceId,
        alreadyLoadedWorkspaceIds,
      );

      updateLocalServer({ baseUrl: normalizedBaseUrl, token: resolvedToken });

      setConnectionPending(false);
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
      setRetryingWorkspaceIds(backgroundWorkspaceIds);
      setLegacySelectedWorkspaceId(nextWorkspaceId);
      writeActiveWorkspaceId(nextWorkspaceId || null);
      recordInspectorEvent("route.refresh.complete", {
        workspaces: nextWorkspaces.length,
        selectedWorkspaceId: nextWorkspaceId,
        errors: {},
      });

      // Session list comes from OpenCode's index and can be slow on cold
      // boot. Kick it off in the background instead of blocking the route
      // so the UI is interactive immediately; the sidebar shows a
      // loading state per-workspace until the list arrives.
      const backgroundWorkspaces = nextWorkspaces.filter((workspace) => backgroundWorkspaceIds.includes(workspace.id));
      if (backgroundWorkspaces.length > 0) {
        void loadWorkspaceSessionsInBackground(backgroundWorkspaces);
      }
    } catch (error) {
      if (!attempt.isCurrent()) return;
      const message = describeRouteError(error);
      console.error("[session-route] refreshRouteState failed", error);
      recordInspectorEvent("route.refresh.error", {
        route: "session",
        message,
        preservedWorkspaceCount: desktopWorkspaces.length,
      });
      setRouteError(message);
      if (desktopWorkspaces.length > 0) {
        const orderedDesktopWorkspaces = commitStableWorkspaceOrder(desktopWorkspaces);
        setWorkspaces(orderedDesktopWorkspaces);
        setLegacySelectedWorkspaceId((current) =>
          current || resolveWorkspaceListSelectedId(desktopList) || orderedDesktopWorkspaces[0]?.id || "",
        );
      }
    } finally {
      attempt.finish();
      // A superseded attempt changes nothing here: the newer attempt owns
      // loading, the refresh version, and boot-overlay readiness.
      if (attempt.isCurrent()) {
        setLoading(false);
        setRouteRefreshVersion((current) => current + 1);
        // Tell the boot overlay the first route data load has completed so
        // the overlay dismisses after BOTH the desktop boot and the workspace
        // list/sessions are ready. A transient desktop connection gap does
        // not count: the overlay must outlast the restart recovery.
        if (routeReadyAfterRefresh) {
          markBootRouteReady();
        }
      }
    }
  }, [commitStableWorkspaceOrder, legacyWorkspaceInferenceKey, loadWorkspaceSessionsInBackground, markBootRouteReady, updateLocalServer]);

  const routeWorkspaceKnown = Boolean(
    routeWorkspaceId && workspaces.some((workspace) => workspace.id === routeWorkspaceId),
  );
  useEffect(() => {
    if (workspaceSelectionCommitTimerRef.current !== null) {
      window.clearTimeout(workspaceSelectionCommitTimerRef.current);
      workspaceSelectionCommitTimerRef.current = null;
    }
    if (!routeWorkspaceId) return;

    // The URL is the user's newest selection. Persist it synchronously so a
    // slow refresh or activation can never leave storage on an older route.
    setLegacySelectedWorkspaceId(routeWorkspaceId);
    writeActiveWorkspaceId(routeWorkspaceId);
    if (!routeWorkspaceKnown) return;

    workspaceSelectionCommitTimerRef.current = window.setTimeout(() => {
      workspaceSelectionCommitTimerRef.current = null;
      routeWorkspaceSelectionCommitter.request(
        routeWorkspaceId,
        (workspaceId) => workspaceSelectionCommitRef.current(workspaceId),
      );
    }, ROUTE_WORKSPACE_ACTIVATION_SETTLE_MS);
    // On navigation only the routed workspace needs a load: boot already
    // scheduled background loads for every other unloaded workspace.
    const workspaceIdsToLoad = planRouteWorkspaceLoads(
      workspacesRef.current.map((workspace) => workspace.id),
      routeWorkspaceId,
      loadedWorkspaceIdsRef.current,
    );
    const workspace = workspaceIdsToLoad.includes(routeWorkspaceId)
      ? workspacesRef.current.find((item) => item.id === routeWorkspaceId)
      : undefined;
    if (workspace) {
      setRetryingWorkspaceIds((current) => Array.from(new Set([...current, workspace.id])));
      void loadWorkspaceSessionsInBackground([workspace]);
    }
    return () => {
      if (workspaceSelectionCommitTimerRef.current === null) return;
      window.clearTimeout(workspaceSelectionCommitTimerRef.current);
      workspaceSelectionCommitTimerRef.current = null;
    };
  }, [loadWorkspaceSessionsInBackground, routeWorkspaceId, routeWorkspaceKnown]);
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
  const handleRuntimeSessionCreated = useCallback((session: Session) => {
    if (!selectedWorkspaceId) return;
    rememberPendingCreatedSession(selectedWorkspaceId, session.id);
    setSessionsByWorkspaceId((current) => {
      const list = current[selectedWorkspaceId] ?? [];
      const nextList = mergeWorkspaceRouteSession(list, session);
      if (nextList === list) return current;
      const next = { ...current, [selectedWorkspaceId]: nextList };
      sessionsByWorkspaceIdRef.current = next;
      return next;
    });
  }, [rememberPendingCreatedSession, selectedWorkspaceId]);
  const handleRuntimeSessionDeleted = useCallback((sessionId: string) => {
    if (!selectedWorkspaceId) return;
    setSessionsByWorkspaceId((current) => {
      const list = current[selectedWorkspaceId] ?? [];
      const nextList = removeWorkspaceRouteSession(list, sessionId);
      if (nextList === list) return current;
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
      // Fresh connection info was published (boot, restart, or reconnect).
      // Supersede any in-flight refresh — including one stuck mid-flight
      // (e.g. macOS backgrounded the webview and never let a fetch resolve) —
      // so its stale resolution cannot overwrite the new connection state.
      void refreshRouteState({ supersede: true });
    };
    window.addEventListener("openwork-server-settings-changed", handleSettingsChange);

    // Also retry on visibility flip independently — even when nobody else
    // dispatches the settings event.
    const handleVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      void refreshRouteState({ supersede: true });
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
      connectionPending,
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
    connectionPending,
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

  // Once workspaces are loaded, normalize the URL onto the active workspace.
  // Deliberately no last-session restore here: a fresh app load with no
  // session in the URL lands on the empty "new task" state instead of
  // jumping back into the previously opened session.
  useEffect(() => {
    if (loading) return;
    if (routeWorkspaceId && workspaces.length > 0 && !workspaces.some((workspace) => workspace.id === routeWorkspaceId)) {
      const fallbackWorkspaceId = workspaces.some((workspace) => workspace.id === legacySelectedWorkspaceId)
        ? legacySelectedWorkspaceId
        : workspaces[0]?.id || "";
      if (fallbackWorkspaceId) {
        normalizeWorkspaceRoute(fallbackWorkspaceId, selectedSessionId, { replace: true });
      }
      return;
    }
    if (!routeWorkspaceId && selectedWorkspaceId) {
      normalizeWorkspaceRoute(selectedWorkspaceId, selectedSessionId, { replace: true });
    }
  }, [
    extensionsRouteActive,
    extensionsRoutePath,
    loading,
    legacySelectedWorkspaceId,
    normalizeWorkspaceRoute,
    routeWorkspaceId,
    selectedSessionId,
    selectedWorkspaceId,
    workspaces,
  ]);

  // Redirect to /welcome when no workspaces exist and the user hasn't
  // completed onboarding. Desktop only does this for the default hosted
  // bootstrap; org-bound desktops should keep their sign-in gate instead.
  useEffect(() => {
    if (loading) return;
    if (workspaces.length > 0) return;
    if (local.prefs.hasCompletedOnboarding) return;
    if (denAuth.status === "checking") return;
    if (denAuth.isSignedIn) return;
    if (isDesktopRuntime()) {
      if (readDenBootstrapConfig().source !== "default") return;
    }
    navigate("/welcome", { replace: true });
  }, [denAuth.isSignedIn, denAuth.status, loading, local.prefs.hasCompletedOnboarding, navigate, workspaces.length]);

  // NOTE: Blueprint seeding was removed from the route.
  // It was firing `materializeBlueprintSessions` + a session re-fetch on every
  // workspace change, which cascaded setState updates and froze the UI after
  // a few rapid switches. Empty workspaces now simply show "No tasks yet." and
  // the user creates their first session explicitly via "New task". Seeding
  // can be reintroduced later as a one-shot triggered from a button or from
  // the onboarding flow, not from the route effect loop.
  useEffect(() => {
    if (client && !connectionPending) {
      reconnectAttemptedWorkspaceIdRef.current = "";
    }
    if (
      !shouldAttemptDesktopLocalReconnect({
        desktopRuntime: isDesktopRuntime(),
        bootPhase,
        bootRouteReady,
        routeLoading: loading,
        hasClient: Boolean(client),
        connectionPending,
        workspaceType: selectedWorkspace?.workspaceType ?? null,
      })
    ) {
      return;
    }
    if (!selectedWorkspace) return;
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
      // Recovery definitively failed. Release the boot overlay so the
      // retained route (with this error surfaced) is visible instead of the
      // overlay wedging forever.
      markBootRouteReady();
    });
  }, [bootPhase, bootRouteReady, client, connectionPending, loading, markBootRouteReady, selectedWorkspace, workspaces]);

  const selectedWorkspaceRoot = selectedWorkspace?.path?.trim() || "";
  // Single source of truth for the selected workspace's server URL/token/id.
  // For remote workspaces this is the worker that owns the workspace; for
  // local workspaces it's the user's local OpenWork server.
  const selectedWorkspaceEndpoint = useWorkspaceServerClient(selectedWorkspace, { baseUrl, token });
  const selectedWorkspaceServerToken = selectedWorkspaceEndpoint?.token ?? "";
  const opencodeBaseUrl = selectedWorkspaceEndpoint?.opencodeBaseUrl ?? "";
  const selectedWorkspaceError = errorsByWorkspaceId[selectedWorkspaceId] ?? null;
  const selectedSessionKnown = Boolean(
    selectedSessionId &&
      (sessionsByWorkspaceId[selectedWorkspaceId] ?? []).some((session) => session?.id === selectedSessionId),
  );
  const modernRouteSessionLoadKey = routeWorkspaceId && selectedSessionId && selectedWorkspace && selectedWorkspaceEndpoint
    ? JSON.stringify([
        routeWorkspaceId,
        selectedSessionId,
        selectedWorkspaceEndpoint.baseUrl,
        selectedWorkspaceEndpoint.workspaceId,
        selectedWorkspaceEndpoint.token,
        routeRefreshVersion,
      ])
    : "";
  const modernRouteSessionLoadPending = Boolean(
    modernRouteSessionLoadKey &&
      !selectedSessionKnown &&
      (modernRouteSessionResolution?.key !== modernRouteSessionLoadKey || modernRouteSessionResolution.status === "loading"),
  );
  const activeModernRouteSessionResolution = modernRouteSessionResolution?.key === modernRouteSessionLoadKey
    ? modernRouteSessionResolution
    : null;
  const selectedWorkspaceIsLoading = retryingWorkspaceIds.includes(selectedWorkspaceId) || modernRouteSessionLoadPending;
  useEffect(() => {
    const stale = Object.entries(hydratedRouteSessionIdsRef.current).filter(
      ([workspaceId, sessionId]) => workspaceId !== selectedWorkspaceId || sessionId !== selectedSessionId,
    );
    if (stale.length === 0) return;
    for (const [workspaceId] of stale) delete hydratedRouteSessionIdsRef.current[workspaceId];
    setSessionsByWorkspaceId((current) => {
      let next = current;
      for (const [workspaceId, sessionId] of stale) {
        const items = current[workspaceId] ?? [];
        const filtered = removeWorkspaceRouteSession(items, sessionId);
        if (filtered === items) continue;
        if (next === current) next = { ...current };
        next[workspaceId] = filtered;
      }
      if (next !== current) sessionsByWorkspaceIdRef.current = next;
      return next;
    });
  }, [selectedSessionId, selectedWorkspaceId]);
  useEffect(() => {
    if (!modernRouteSessionLoadKey || !selectedWorkspaceEndpoint || !selectedSessionId) {
      setModernRouteSessionResolution(null);
      return;
    }
    if (selectedSessionKnown) {
      setModernRouteSessionResolution(null);
      return;
    }
    let cancelled = false;
    setModernRouteSessionResolution({ key: modernRouteSessionLoadKey, status: "loading" });

    const hydrateSelectedSession = async () => {
      const maxAttempts = 6;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (cancelled) return;
        try {
          const session = await getNativeSession(selectedWorkspaceEndpoint, selectedSessionId);
          if (cancelled) return;
          if (session.id !== selectedSessionId) {
            setModernRouteSessionResolution({
              key: modernRouteSessionLoadKey,
              status: "error",
              message: "The server returned a different session.",
            });
            return;
          }
          setSessionsByWorkspaceId((current) => {
            const currentItems = current[selectedWorkspaceId] ?? [];
            if (currentItems.some((session) => session.id === selectedSessionId)) {
              delete hydratedRouteSessionIdsRef.current[selectedWorkspaceId];
              return current;
            }
            hydratedRouteSessionIdsRef.current[selectedWorkspaceId] = selectedSessionId;
            const nextItems = mergeWorkspaceRouteSession(currentItems, session);
            const next = { ...current, [selectedWorkspaceId]: nextItems };
            sessionsByWorkspaceIdRef.current = next;
            return next;
          });
          setErrorsByWorkspaceId((current) => ({ ...current, [selectedWorkspaceId]: null }));
          setModernRouteSessionResolution(null);
          return;
        } catch (error) {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : describeRouteError(error);
          const kind = classifyRouteSessionReadError(error);
          if (kind !== "retryable" || attempt + 1 >= maxAttempts) {
            setModernRouteSessionResolution({
              key: modernRouteSessionLoadKey,
              status: kind === "not-found" ? "not-found" : "error",
              message,
            });
            return;
          }
          await new Promise((resolve) => window.setTimeout(resolve, Math.min(500 * Math.pow(2, attempt), 4_000)));
          if (cancelled) return;
        }
      }
    };

    void hydrateSelectedSession();

    return () => {
      cancelled = true;
    };
  }, [modernRouteSessionLoadKey, selectedSessionId, selectedSessionKnown, selectedWorkspaceId]);
  const routeNotFoundMessage = (() => {
    if (loading) return null;
    if (routeWorkspaceId && !selectedWorkspace) {
      return "Workspace was not found. Select a new workspace from the sidebar.";
    }
    if (selectedSessionId && !selectedSessionKnown && activeModernRouteSessionResolution?.status === "not-found") {
      return "Session was not found. Select a new session from the sidebar.";
    }
    if (selectedSessionId && !selectedSessionKnown && activeModernRouteSessionResolution?.status === "error") {
      return `Session could not be loaded. ${activeModernRouteSessionResolution.message}`;
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
  useEffect(() => {
    if (!developerMode || !opencodeClient) return;
    return publishInspectorOpencodeClient(opencodeClient);
  }, [developerMode, opencodeClient]);
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
    reloadWorkspaceSessions,
    loadWorkspaceSessionsInBackground,
    rememberPendingCreatedSession,
    handleRuntimeSessionCreated,
    handleRuntimeSessionUpdated,
    handleRuntimeSessionDeleted,
    handleRemoteWorkspaceConnectionSaved,
    runRemoteWorkspaceConnectionCheck,
  };
}
