/** @jsxImportSource react */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { DashboardConnectionCard } from "./dashboard-connection-card";
import { connectionCardPayloadFromChatToolResult, reconnectActionFromChatToolResult } from "@/components/tools/error-attribution";
import type { ConnectionActionPayload } from "@openwork/types/connection-action-app";
import type { ChatToolReconnectAction } from "@/components/tools/error-attribution";
import { Play } from "lucide-react";

import {
  OpenworkServerError,
  type OpenworkMcpAppResource,
  type OpenworkMcpAppToolResult,
  type OpenworkServerClient,
} from "@/app/lib/openwork-server";
import { McpAppSandboxView, type PreservedMcpAppResult } from "@/components/chat/mcp-app-frame";
import { snapshotMcpAppArguments, type McpAppOrigin } from "@/components/chat/mcp-app-origin";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/react-app/shell/workspace-provider";
import { DashboardTileShell, type DashboardTileActions } from "./dashboard-tile-shell";
import { resolveDashboardMcpApp } from "./dashboard-mcp-app-resolution";
import { scheduleDashboardLaunch } from "./dashboard-launch-scheduler";
import { useDashboardTileGeometry } from "./use-dashboard-tile-geometry";
import {
  DASHBOARD_AUTO_REFRESH_INTERVAL_MS,
  dashboardTileLaunchIsApproved,
  dashboardTileRunsAutomatically,
  readDashboardTileCache,
  removeDashboardTileCache,
  shouldAutoRefreshDashboardTile,
  writeDashboardTileCache,
} from "./dashboard-tile-cache";
import type { DashboardMcpAppEntry } from "./granted-dashboard-store";

/** A workspace MCP runtime a tile may launch through. */
export type DashboardLaunchEndpoint = {
  client: OpenworkServerClient;
  workspaceId: string;
};

/**
 * Tiles launch with the arguments captured when the app was added (empty for
 * zero-config apps). Every launch and refresh reuses that exact stored input.
 */
const EMPTY_ARGUMENTS: Record<string, unknown> = {};

type TileDocument = { id: number; active: boolean; failed: boolean };

type ReadyTileState = {
  phase: "ready";
  app: OpenworkMcpAppResource;
  result: PreservedMcpAppResult;
  endpoint: DashboardLaunchEndpoint;
  origin: McpAppOrigin;
  lifetime: TileDocument;
  argumentsSignature: string;
  cachedAt: number;
  autoLaunchEligible?: boolean;
};

type TileState =
  | { phase: "idle"; revokeAutoLaunch?: boolean }
  | { phase: "loading" }
  | ReadyTileState
  | { phase: "connection"; connection: ConnectionActionPayload; action: ChatToolReconnectAction | null; output: unknown }
  | { phase: "closed" }
  | { phase: "error"; message: string; preservePrevious?: boolean };

type TileAttempt = {
  nonce: number;
  promise: Promise<TileState> | null;
  controller: AbortController;
  candidates: DashboardLaunchEndpoint[];
  admitted: boolean;
  endpoint?: DashboardLaunchEndpoint;
  document?: TileDocument;
};

type RefreshState = "idle" | "refreshing" | "failed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstTextContent(content: Array<Record<string, unknown>>): string | null {
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string" && item.text.trim()) return item.text;
  }
  return null;
}

/** Providers often return machine-shaped JSON errors; surface their message text. */
function launchFailureMessage(content: Array<Record<string, unknown>>): string | null {
  const text = firstTextContent(content);
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
  } catch {
    // Plain-text errors pass through unchanged.
  }
  return text;
}

function freshnessLabel(cachedAt: number, now = Date.now()): string {
  const ageMinutes = Math.max(0, Math.floor((now - cachedAt) / 60_000));
  if (ageMinutes < 1) return "Updated just now";
  if (ageMinutes === 1) return "Updated 1 minute ago";
  if (ageMinutes < 60) return `Updated ${ageMinutes} minutes ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  return ageHours === 1 ? "Updated 1 hour ago" : `Updated ${ageHours} hours ago`;
}

function launchArgumentsSignature(argumentsValue: Record<string, unknown>) {
  return JSON.stringify(argumentsValue, (_key, value: unknown) => isRecord(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : value);
}

function dashboardEntryIdentity(entry: DashboardMcpAppEntry, signature: string) {
  return JSON.stringify([entry.id, entry.connectionId, entry.serverName, entry.toolName, entry.resourceUri, entry.projectedToolName, signature]);
}

/** The same workspace on the same server keeps its live view when the route rebuilds its client object. */
function sameLaunchEndpoint(left: DashboardLaunchEndpoint, right: DashboardLaunchEndpoint) {
  return left.workspaceId === right.workspaceId && (left.client === right.client || left.client.baseUrl === right.client.baseUrl);
}

function appMatchesEntry(app: OpenworkMcpAppResource, entry: DashboardMcpAppEntry) {
  return app.serverName === entry.serverName && app.toolName === entry.toolName && app.resourceUri === entry.resourceUri;
}

function tileConnectionState(entry: DashboardMcpAppEntry, value: unknown, args: Record<string, unknown>): Extract<TileState, { phase: "connection" }> | null {
  const outputs: unknown[] = [value];
  if (isRecord(value)) {
    outputs.push(value.structuredContent, value._meta);
    if (Array.isArray(value.content)) outputs.push(...value.content.filter(isRecord).filter(item => item.type === "text").map(item => item.text));
  }
  const matches = new Map<string, Extract<TileState, { phase: "connection" }>>();
  for (const output of outputs) {
    const connection = connectionCardPayloadFromChatToolResult(entry.projectedToolName, output, args);
    if (connection) matches.set(connection.connectionId, {
      phase: "connection", connection, output,
      action: reconnectActionFromChatToolResult(entry.projectedToolName, output, args),
    });
  }
  return matches.size === 1 ? matches.values().next().value ?? null : null;
}

function invalidatesTileDocument(cause: unknown) {
  return cause instanceof OpenworkServerError && (
    [401, 403, 404, 410].includes(cause.status)
    || cause.code.startsWith("invalid_resource")
    || ["tool_denied", "tool_not_visible", "tool_not_found", "tool_resource_mismatch", "tool_requires_approval",
      "missing_launch_context", "stale_launch_context", "inactive_session", "unsupported_resource_permissions", "resource_read_failed", "resource_too_large",
      "mcp_app_resource_changed", "mcp_app_refresh_denied", "resource_read_failed", "unsafe_server_url",
      "connection_required", "needs_connection", "connection_not_connected", "reauth_required", "needs_signin",
      "connect_catalog_missing_app_host_auth", "connect_catalog_untrusted_origin", "connect_catalog_invalid_catalog",
      "connect_catalog_invalid_proxy_descriptor"].includes(cause.code)
  );
}

export function McpAppTile(props: ComponentProps<typeof McpAppTileContent>) {
  const input = props.entry.launchArguments ?? EMPTY_ARGUMENTS;
  const signature = useMemo(() => launchArgumentsSignature(input), [input]);
  return <McpAppTileContent key={JSON.stringify([props.cacheScopeKey, dashboardEntryIdentity(props.entry, signature)])} {...props} />;
}

function McpAppTileContent({
  entry,
  cacheScopeKey,
  onAutoLaunchEnabled,
  onAutoLaunchDisabled,
  fallbackEndpoints,
  renderActions,
}: {
  renderActions?: DashboardTileActions;
  entry: DashboardMcpAppEntry;
  /** Per-user and per-organization scope for workspace-bound last-known-good dashboard data. */
  cacheScopeKey: string;
  onApprovedLaunch?: () => void;
  /** Enables later on-load launches after this user successfully runs a safe tile. */
  onAutoLaunchEnabled?: () => void;
  /** Revokes automatic launch when the live server requires approval. */
  onAutoLaunchDisabled?: () => void;
  /** Other workspace runtimes to try when the primary one cannot resolve the app. */
  fallbackEndpoints?: DashboardLaunchEndpoint[];
}) {
  const workspace = useWorkspace();
  const { openworkServerClient, workspaceId } = workspace;
  // Provider annotations are not an authorization boundary. A safe-looking
  // tile runs on load only after this user has successfully run this exact
  // element once; approval-gated tools stay run-on-request forever.
  const runsAutomatically = dashboardTileRunsAutomatically(
    entry.requiresApproval === true,
    entry.autoLaunch === true,
    entry.launchApproved === true,
    entry.organizationAutoLaunch === true,
  );
  const manualLaunch = !runsAutomatically;
  const launchEndpoints = useMemo(() => [
    ...(openworkServerClient && workspaceId ? [{ client: openworkServerClient, workspaceId }] : []),
    ...(fallbackEndpoints ?? []),
  ].filter((endpoint, index, all) => (
    all.findIndex((other) => sameLaunchEndpoint(other, endpoint)) === index
  )), [fallbackEndpoints, openworkServerClient, workspaceId]);
  // Cached app HTML is interactive, so it follows the same per-user launch
  // consent as a live call and never mounts on a first visit.
  const [nonce, setNonce] = useState(0);
  const nextLaunchArguments = entry.launchArguments ?? EMPTY_ARGUMENTS;
  const nextArguments = useMemo(() => ({
    signature: launchArgumentsSignature(nextLaunchArguments),
    value: snapshotMcpAppArguments(nextLaunchArguments) ?? EMPTY_ARGUMENTS,
  }), [nextLaunchArguments, nonce]);
  const argumentsRef = useRef(nextArguments);
  if (argumentsRef.current.signature !== nextArguments.signature) argumentsRef.current = nextArguments;
  const launchArguments = argumentsRef.current.value;
  const argumentsSignature = argumentsRef.current.signature;
  const savedCache = runsAutomatically ? readDashboardTileCache(cacheScopeKey, entry.id) : null;
  const cached = savedCache && savedCache.argumentsSignature === argumentsSignature && appMatchesEntry(savedCache.app, entry) ? savedCache : null;
  const cachedEndpoint = cached
    ? launchEndpoints.find((endpoint) => endpoint.workspaceId === cached.workspaceId) ?? null
    : null;
  const [started, setStarted] = useState(!manualLaunch);
  const documentSequence = useRef(0);
  const [readyDocument, setReadyDocument] = useState<TileDocument | null>(null);
  const lastHeight = useRef<number | undefined>(undefined);
  const [state, setState] = useState<TileState>(() => cached && cachedEndpoint
    ? {
        phase: "ready", app: cached.app, result: cached.result, endpoint: cachedEndpoint, cachedAt: cached.cachedAt,
        origin: { ...cachedEndpoint, sessionId: null, readOnly: true }, argumentsSignature,
        lifetime: { id: ++documentSequence.current, active: true, failed: false },
      }
    : { phase: manualLaunch ? "idle" : "loading" });
  const [refreshState, setRefreshState] = useState<RefreshState>(manualLaunch ? "idle" : "refreshing");
  const refreshStateRef = useRef(refreshState);
  refreshStateRef.current = refreshState;
  const stateRef = useRef(state);
  stateRef.current = state;
  const initialWorkspaceId = useRef(cachedEndpoint?.workspaceId ?? launchEndpoints[0]?.workspaceId ?? workspaceId ?? "");
  const geometryWorkspaceId = state.phase === "ready" ? state.endpoint.workspaceId : initialWorkspaceId.current || launchEndpoints[0]?.workspaceId || workspaceId || "";
  const geometryEntryId = dashboardEntryIdentity(entry, argumentsSignature);
  const geometry = useDashboardTileGeometry(cacheScopeKey, geometryEntryId, geometryWorkspaceId);
  const geometryIdentity = JSON.stringify([cacheScopeKey, geometryEntryId, geometryWorkspaceId]);
  const [measuredGeometryIdentity, setMeasuredGeometryIdentity] = useState<string | null>(null);
  // Measure the reserved slot before a child frame consumes its initial height.
  useLayoutEffect(() => { setMeasuredGeometryIdentity(geometryIdentity); }, [geometryIdentity]);
  const lastRefreshAtRef = useRef(cachedEndpoint ? cached?.cachedAt ?? 0 : 0);
  const nonceRef = useRef(nonce);
  const retiredNonceRef = useRef<number | null>(null);
  const userInitiatedNonceRef = useRef<number | null>(null);
  const launchApprovedRef = useRef(entry.launchApproved === true);
  launchApprovedRef.current = entry.launchApproved === true;
  const onAutoLaunchEnabledRef = useRef(onAutoLaunchEnabled);
  onAutoLaunchEnabledRef.current = onAutoLaunchEnabled;
  const onAutoLaunchDisabledRef = useRef(onAutoLaunchDisabled);
  onAutoLaunchDisabledRef.current = onAutoLaunchDisabled;
  const launchRef = useRef<TileAttempt | null>(null);
  const lifetime = useRef({ active: true });
  const endpointsRef = useRef(launchEndpoints);
  endpointsRef.current = launchEndpoints;
  const ownedLaunches = useRef(new Map<string, DashboardLaunchEndpoint>());
  const updateState = useCallback((next: TileState) => { stateRef.current = next; setState(next); }, []);
  const updateRefresh = useCallback((next: RefreshState) => { refreshStateRef.current = next; setRefreshState(next); }, []);
  const releaseLaunch = useCallback((id: string | undefined) => {
    const endpoint = id ? ownedLaunches.current.get(id) : undefined;
    if (!id || !endpoint) return;
    ownedLaunches.current.delete(id);
    void endpoint.client.releaseMcpApp(endpoint.workspaceId, id).catch(() => undefined);
  }, []);
  const releaseLaunches = useCallback(() => {
    for (const id of ownedLaunches.current.keys()) releaseLaunch(id);
  }, [releaseLaunch]);
  const clearDocument = useCallback((next: TileState) => {
    const current = stateRef.current;
    if (current.phase === "ready") {
      current.lifetime.active = false;
      releaseLaunch(current.app.launchId);
    }
    removeDashboardTileCache(cacheScopeKey, entry.id);
    updateState(next);
  }, [cacheScopeKey, entry.id, releaseLaunch, updateState]);
  const requestRefresh = useCallback((userInitiated: boolean) => {
    if (!lifetime.current.active || refreshStateRef.current === "refreshing") return;
    updateRefresh("refreshing");
    lastRefreshAtRef.current = Date.now();
    const next = ++nonceRef.current;
    userInitiatedNonceRef.current = userInitiated ? next : null;
    setStarted(true);
    setNonce(next);
  }, [updateRefresh]);
  useLayoutEffect(() => {
    lifetime.current.active = true;
    if (launchRef.current?.controller.signal.aborted && !launchRef.current.admitted) launchRef.current = null;
    if (stateRef.current.phase === "ready" && stateRef.current.origin.readOnly) stateRef.current.lifetime.active = true;
    return () => {
      lifetime.current.active = false;
      launchRef.current?.controller.abort();
      if (stateRef.current.phase === "ready") stateRef.current.lifetime.active = false;
      releaseLaunches();
    };
  }, [releaseLaunches]);
  useLayoutEffect(() => {
    if (savedCache && (!cached || !cachedEndpoint)) removeDashboardTileCache(cacheScopeKey, entry.id);
    const current = stateRef.current;
    if (current.phase === "ready" && current.argumentsSignature !== argumentsSignature) {
      lastHeight.current = undefined;
      clearDocument({ phase: "loading" });
    }
  }, [savedCache, cached, cachedEndpoint, cacheScopeKey, entry.id, argumentsSignature, clearDocument]);
  const policySignature = JSON.stringify([entry.requiresApproval === true, entry.launchApproved === true, entry.organizationAutoLaunch === true]);
  const policyRef = useRef(policySignature);
  useLayoutEffect(() => {
    if (policyRef.current === policySignature) return;
    policyRef.current = policySignature;
    retiredNonceRef.current = nonceRef.current;
    launchRef.current?.controller.abort();
    clearDocument({ phase: "idle" });
    releaseLaunches();
    setStarted(false);
    updateRefresh("idle");
  }, [policySignature, clearDocument, releaseLaunches, updateRefresh]);
  useLayoutEffect(() => {
    const contains = (owner: DashboardLaunchEndpoint) => launchEndpoints.some(endpoint => sameLaunchEndpoint(endpoint, owner));
    const current = stateRef.current;
    const attempt = launchRef.current;
    const ownerRemoved = current.phase === "ready" && !contains(current.endpoint);
    const pendingOwnerRemoved = attempt?.promise && (attempt.endpoint ? !contains(attempt.endpoint) : attempt.candidates.some(endpoint => !contains(endpoint)));
    if (!ownerRemoved && !pendingOwnerRemoved) return;
    retiredNonceRef.current = nonceRef.current;
    attempt?.controller.abort();
    clearDocument({ phase: "error", message: "This app view is unavailable until its workspace reconnects. Use refresh to launch it again." });
    releaseLaunches();
    updateRefresh("failed");
  }, [launchEndpoints, clearDocument, releaseLaunches, updateRefresh]);

  useEffect(() => {
    if (!started || retiredNonceRef.current === nonce || launchRef.current?.nonce === nonce) return;
    launchRef.current?.controller.abort();
    const attempt: TileAttempt = { nonce, promise: null, controller: new AbortController(), candidates: endpointsRef.current, admitted: false };
    launchRef.current = attempt;
    lastRefreshAtRef.current = Date.now();
    updateRefresh("refreshing");
    if (stateRef.current.phase !== "ready") updateState({ phase: "loading" });
    const userInitiated = userInitiatedNonceRef.current === nonce;
    const memberApproved = launchApprovedRef.current;
    const requiresApproval = entry.requiresApproval === true;
    const launchIsApproved = dashboardTileLaunchIsApproved(entry.organizationAutoLaunch === true, memberApproved);
    const isCurrent = () => lifetime.current.active && !attempt.controller.signal.aborted && launchRef.current === attempt && retiredNonceRef.current !== nonce;
    const assertActive = () => {
      if (!isCurrent()) throw new Error("This App launch has closed or changed. Run the tile again.");
    };
    const endpointIsActive = (endpoint: DashboardLaunchEndpoint) => isCurrent()
      && endpointsRef.current.some(current => sameLaunchEndpoint(current, endpoint));
    const discardInvalidDocument = () => {
      const current = stateRef.current;
      if (current.phase === "ready" && (!current.lifetime.active || current.lifetime.failed || current.argumentsSignature !== argumentsSignature || !appMatchesEntry(current.app, entry)
        || (current.app.refresh && (!Number.isFinite(current.app.refresh.expiresAt) || current.app.refresh.expiresAt <= Date.now())))) {
        clearDocument({ phase: "loading" });
      }
    };
    discardInvalidDocument();
    const promise = scheduleDashboardLaunch<TileState>(async () => {
      await Promise.resolve();
      assertActive();
      attempt.admitted = true;
      discardInvalidDocument();
      if (attempt.candidates.length === 0) throw new Error("No connected workspace is available to launch this app.");
      const argumentsSnapshot = snapshotMcpAppArguments(launchArguments);
      const launch = entry.connectionId
        ? { connectionId: entry.connectionId, toolName: entry.toolName, resourceUri: entry.resourceUri, arguments: {} }
        : undefined;
      let target: { endpoint: DashboardLaunchEndpoint; app: OpenworkMcpAppResource } | null = null;
      let reused: ReadyTileState | null = null;
      let fallbackEndpoint: DashboardLaunchEndpoint | null = null;
      let result: OpenworkMcpAppToolResult | undefined;
      let approvalWasRequired = false;
      let acquiredLaunchId: string | undefined;
      let keepLaunch = false;
      try {
        const current = stateRef.current;
        if (current.phase === "ready" && current.lifetime.active && !current.lifetime.failed && !current.origin.readOnly
          && current.argumentsSignature === argumentsSignature && current.autoLaunchEligible && !manualLaunch
          && !requiresApproval && !memberApproved && current.app.launchId && current.app.refresh
          && current.app.refresh.resourceDigest.length === 64 && /^[a-f0-9]{64}$/i.test(current.app.refresh.resourceDigest)
          && current.app.refresh.expiresAt > Date.now() && endpointIsActive(current.endpoint)
          && ownedLaunches.current.get(current.app.launchId) === current.endpoint) {
          attempt.endpoint = current.endpoint;
          attempt.document = current.lifetime;
          try {
            result = await current.endpoint.client.callMcpAppTool(current.endpoint.workspaceId, {
              launchId: current.app.launchId, sessionId: null, serverName: current.app.serverName,
              name: current.app.toolName, resourceUri: current.app.resourceUri, arguments: argumentsSnapshot,
              expectedResourceDigest: current.app.refresh.resourceDigest,
            });
            assertActive();
            if (!current.lifetime.active || current.lifetime.failed) throw new Error("This App view has closed or changed. Run the tile again.");
            target = { endpoint: current.endpoint, app: current.app };
            reused = current;
          } catch (cause) {
            assertActive();
            if (!(cause instanceof OpenworkServerError) || cause.status !== 422 || !["mcp_app_resource_changed", "mcp_app_refresh_denied"].includes(cause.code)) throw cause;
            fallbackEndpoint = current.endpoint;
            clearDocument({ phase: "loading" });
            attempt.document = undefined;
          }
        }
        if (!target) {
          if (fallbackEndpoint) {
            const { app } = await fallbackEndpoint.client.resolveMcpApp(fallbackEndpoint.workspaceId, entry.projectedToolName, launch, { sessionId: null, readOnly: false });
            if (app && endpointIsActive(fallbackEndpoint) && appMatchesEntry(app, entry)) target = { endpoint: fallbackEndpoint, app };
            else if (app?.launchId) void fallbackEndpoint.client.releaseMcpApp(fallbackEndpoint.workspaceId, app.launchId).catch(() => undefined);
          } else {
            target = await resolveDashboardMcpApp({
              endpoints: attempt.candidates, projectedToolName: entry.projectedToolName,
              expected: { serverName: entry.serverName, toolName: entry.toolName, resourceUri: entry.resourceUri },
              launch, isActive: endpointIsActive,
            });
          }
          if (target && !endpointIsActive(target.endpoint)) {
            if (target.app.launchId) void target.endpoint.client.releaseMcpApp(target.endpoint.workspaceId, target.app.launchId).catch(() => undefined);
            target = null;
          }
          assertActive();
          if (!target) return { phase: "error", message: "This tool no longer advertises an interactive app." };
          const { endpoint, app } = target;
          attempt.endpoint = endpoint;
          if (!app.launchId) throw new OpenworkServerError(422, "missing_launch_context", "This App has no live launch context. Update OpenWork and run the tile again.");
          acquiredLaunchId = app.launchId;
          ownedLaunches.current.set(app.launchId, endpoint);
          const request = {
            launchId: app.launchId, sessionId: null, serverName: app.serverName,
            name: app.toolName, resourceUri: app.resourceUri, arguments: argumentsSnapshot,
            ...(!fallbackEndpoint && launchIsApproved ? { approved: true } : {}),
          };
          try {
            result = await endpoint.client.callMcpAppTool(endpoint.workspaceId, request);
          } catch (cause) {
            assertActive();
            if (!(cause instanceof OpenworkServerError) || cause.code !== "tool_requires_approval") throw cause;
            approvalWasRequired = true;
            if (!userInitiated || fallbackEndpoint) return { phase: "idle", revokeAutoLaunch: true };
            if (!endpointIsActive(endpoint)) throw new Error("This App launch has closed or changed. Run the tile again.");
            onAutoLaunchDisabledRef.current?.();
            result = await endpoint.client.callMcpAppTool(endpoint.workspaceId, { ...request, approved: true });
          }
        }
        assertActive();
        if (!result || !endpointIsActive(target.endpoint)) throw new Error("This App launch has closed or changed. Run the tile again.");
        const connection = tileConnectionState(entry, result, launchArguments);
        if (connection) return connection;
        if (result.isError) return {
          phase: "error", preservePrevious: true, message: launchFailureMessage(result.content)
            ?? (entry.launchArguments
              ? "This app could not start with the saved launch input. Remove the tile and add it again with corrected input."
              : "This app could not start without input, which this tile does not provide."),
        };
        const preserved = {
          content: result.content,
          ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
          ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
          ...(result._meta ? { _meta: result._meta } : {}),
        };
        keepLaunch = true;
        if (reused) return { ...reused, result: preserved, cachedAt: Date.now() };
        return {
          phase: "ready", ...target, result: preserved, cachedAt: Date.now(), argumentsSignature,
          origin: { ...target.endpoint, sessionId: null, readOnly: false },
          lifetime: { id: ++documentSequence.current, active: true, failed: false },
          autoLaunchEligible: !approvalWasRequired && !memberApproved && !requiresApproval,
        };
      } finally {
        if (!keepLaunch) releaseLaunch(acquiredLaunchId);
      }
    }, {
      signal: attempt.controller.signal,
      priority: () => {
        if (userInitiated) return 2;
        const bounds = geometry.ref.current?.getBoundingClientRect();
        return !document.hidden && bounds && bounds.bottom > 0 && bounds.top < window.innerHeight
          && bounds.right > 0 && bounds.left < window.innerWidth ? 1 : 0;
      },
    });
    attempt.promise = promise;
    const markSettled = () => { if (launchRef.current === attempt) attempt.promise = null; };
    void promise.then(markSettled, markSettled);
    void promise.then(next => {
      if (!isCurrent()) return;
      if (next.phase === "ready") {
        if (!next.lifetime.active || !endpointIsActive(next.endpoint)) {
          next.lifetime.active = false;
          clearDocument({ phase: "error", message: "This app view is unavailable until its workspace reconnects. Use refresh to launch it again." });
          releaseLaunches();
          updateRefresh("failed");
          return;
        }
        const previous = stateRef.current;
        if (previous.phase === "ready" && previous.lifetime !== next.lifetime) previous.lifetime.active = false;
        for (const id of ownedLaunches.current.keys()) if (id !== next.app.launchId) releaseLaunch(id);
        writeDashboardTileCache(cacheScopeKey, entry.id, {
          argumentsSignature, cachedAt: next.cachedAt, workspaceId: next.endpoint.workspaceId, app: next.app, result: next.result,
        });
        lastRefreshAtRef.current = next.cachedAt;
        updateState(next);
        updateRefresh("idle");
        if (userInitiated && next.autoLaunchEligible && entry.autoLaunch !== true) onAutoLaunchEnabledRef.current?.();
        return;
      }
      const previous = stateRef.current;
      if (next.phase === "error" && next.preservePrevious && previous.phase === "ready"
        && previous.lifetime.active && !previous.lifetime.failed && previous.argumentsSignature === argumentsSignature
        && appMatchesEntry(previous.app, entry) && endpointIsActive(previous.endpoint)
        && (previous.origin.readOnly || (previous.app.launchId && ownedLaunches.current.get(previous.app.launchId) === previous.endpoint))
        && (!previous.app.refresh || (Number.isFinite(previous.app.refresh.expiresAt) && previous.app.refresh.expiresAt > Date.now()))) {
        updateRefresh("failed");
        return;
      }
      clearDocument(next);
      releaseLaunches();
      updateRefresh(next.phase === "error" ? "failed" : "idle");
      if (next.phase === "idle" && next.revokeAutoLaunch) {
        setStarted(false);
        onAutoLaunchDisabledRef.current?.();
      }
    }).catch((cause: unknown) => {
      if (!isCurrent()) return;
      const connection = tileConnectionState(entry, cause instanceof OpenworkServerError ? cause.details : undefined, launchArguments);
      if (connection) {
        clearDocument(connection);
        releaseLaunches();
        updateRefresh("idle");
        return;
      }
      const current = stateRef.current;
      // A saved, still-valid view survives a transient failure; only an
      // authority, policy or resource problem removes it.
      if (invalidatesTileDocument(cause) || current.phase !== "ready" || !current.lifetime.active || current.lifetime.failed
        || current.argumentsSignature !== argumentsSignature || !appMatchesEntry(current.app, entry)) {
        clearDocument({ phase: "error", message: cause instanceof Error && cause.message ? cause.message : "The app could not be launched." });
        releaseLaunches();
      }
      updateRefresh("failed");
    });
  }, [cacheScopeKey, entry, launchArguments, argumentsSignature, manualLaunch, nonce, started, geometry.ref, clearDocument, releaseLaunch, releaseLaunches, updateState, updateRefresh]);

  useEffect(() => {
    if (manualLaunch) return;
    const refreshIfStale = () => {
      if (stateRef.current.phase === "idle" || stateRef.current.phase === "closed" || !shouldAutoRefreshDashboardTile({
        visible: !document.hidden,
        refreshing: refreshStateRef.current === "refreshing",
        lastRefreshAt: lastRefreshAtRef.current,
      })) return;
      requestRefresh(false);
    };
    const interval = window.setInterval(refreshIfStale, DASHBOARD_AUTO_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [manualLaunch, requestRefresh]);

  // The relative freshness label must age even when nothing else re-renders.
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.phase !== "ready") return;
    const tick = () => setFreshnessNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 60_000);
    return () => window.clearInterval(interval);
  }, [state.phase, state.phase === "ready" ? state.cachedAt : 0]);
  const run = () => requestRefresh(true);
  const interactiveEndpoint = state.phase === "ready" && state.argumentsSignature === argumentsSignature && appMatchesEntry(state.app, entry)
    && launchEndpoints.some((endpoint) => sameLaunchEndpoint(endpoint, state.endpoint))
    ? state.endpoint
    : null;
  const origin = state.phase === "ready" && interactiveEndpoint ? state.origin : null;
  const awaitingReady = state.phase === "ready" && !state.lifetime.failed && readyDocument !== state.lifetime;
  const loadingDocument = state.phase === "loading" || awaitingReady || (state.phase === "ready" && state.argumentsSignature !== argumentsSignature);
  const reservedHeight = geometry.reservedHeight ?? lastHeight.current ?? geometry.initialHeight ?? 320;
  const currentDocument = (document: TileDocument) => lifetime.current.active && document.active
    && stateRef.current.phase === "ready" && stateRef.current.lifetime === document
    && stateRef.current.argumentsSignature === argumentsRef.current.signature && appMatchesEntry(stateRef.current.app, entry);
  const badge = (() => {
    if (state.phase === "ready" && !interactiveEndpoint) return "Saved locally · workspace unavailable";
    if (state.phase === "ready" && origin?.readOnly && refreshState !== "refreshing") return "Saved locally · run required";
    if (state.phase === "ready" && refreshState === "refreshing") return "Saved locally · refreshing";
    if (state.phase === "ready" && refreshState === "failed") return "Saved locally · refresh failed";
    if (state.phase === "ready" && entry.organizationAutoLaunch === true) {
      return `Organization auto-run · ${freshnessLabel(state.cachedAt, freshnessNow)}`;
    }
    if (state.phase === "ready" && entry.requiresApproval === true) return "Saved locally · run on request";
    if (state.phase === "ready") return freshnessLabel(state.cachedAt, freshnessNow);
    if (state.phase === "loading") return "Loading";
    if (state.phase === "error") return "Refresh failed";
    if (entry.organizationAutoLaunch === true) return "Organization auto-run";
    if (entry.requiresApproval === true) return "Run on request";
    if (manualLaunch) return "Run once to enable";
    return null;
  })();

  return (
    <div ref={geometry.ref} className="relative min-w-0" data-dashboard-tile={entry.id}
      aria-busy={refreshState === "refreshing" || loadingDocument} style={{ minHeight: loadingDocument ? reservedHeight : undefined }}>
      <DashboardTileShell
        title={entry.title}
        renderActions={renderActions}
        entryId={entry.id}
        subtitle={entry.serverName}
        badge={badge ? (
          <span
            className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground"
            role="status"
            aria-live="polite"
            data-dashboard-cache-state={refreshState}
          >
            <span
              className={`size-1.5 rounded-full ${state.phase === "error" || refreshState === "failed" || (state.phase === "ready" && !interactiveEndpoint) ? "bg-amber-500" : "bg-emerald-500"}`}
              aria-hidden
            />
            {badge}
          </span>
        ) : undefined}
        onRefresh={run}
        refreshing={refreshState === "refreshing" || loadingDocument}
        compact={state.phase === "ready" && Boolean(interactiveEndpoint) && !state.lifetime.failed}
      >
        {state.phase === "idle" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
            <Play className="size-6 text-muted-foreground" aria-hidden />
            <p className="max-w-xs text-xs text-muted-foreground">
              {entry.requiresApproval === true
                ? "This app modifies data when it runs, so it only runs when you ask."
                : "Run once to enable automatic loading and refresh for this tile."}
            </p>
            <Button variant="outline" size="sm" onClick={run} aria-label={`Run ${entry.title}`}>
              <Play className="size-4" /> Run
            </Button>
          </div>
        ) : null}
        {state.phase === "connection" ? <DashboardConnectionCard key={JSON.stringify([cacheScopeKey, state.connection.connectionId, nonce])}
          toolName={entry.projectedToolName} toolCallId={`${entry.id}:${nonce}`} output={state.output}
          connection={state.connection} action={state.action} onConnected={run} /> : null}
        {state.phase === "error" ? (
          <p className="pt-3 text-xs text-muted-foreground" role="status">{state.message}</p>
        ) : null}
        {state.phase === "closed" ? (
          <p className="pt-3 text-xs text-muted-foreground" role="status">
            This app closed its view. Use refresh to launch it again.
          </p>
        ) : null}
        {state.phase === "ready" && measuredGeometryIdentity === geometryIdentity ? (
          origin ?
            <div inert={awaitingReady || undefined} aria-hidden={awaitingReady || undefined}>
              <McpAppSandboxView
                origin={origin}
                key={state.lifetime.id}
                app={state.app}
                toolName={entry.projectedToolName}
                inputArguments={launchArguments}
                result={state.result}
                updateMode="notify"
                unavailableNotice="This app view is unavailable."
                presentation="dashboard"
                initialHeight={geometry.initialHeight ?? lastHeight.current}
                onReady={() => { if (currentDocument(state.lifetime) && !state.lifetime.failed) setReadyDocument(state.lifetime); }}
                onHeightChange={(height) => {
                  if (!currentDocument(state.lifetime) || state.lifetime.failed) return;
                  lastHeight.current = height;
                  geometry.recordHeight(height);
                }}
                onError={() => {
                  if (!currentDocument(state.lifetime)) return;
                  state.lifetime.failed = true;
                  state.lifetime.active = false;
                  releaseLaunch(state.app.launchId);
                  removeDashboardTileCache(cacheScopeKey, entry.id);
                  if (launchRef.current?.document === state.lifetime) launchRef.current.controller.abort();
                  if (!launchRef.current?.promise || launchRef.current.controller.signal.aborted) updateRefresh("failed");
                  updateState({ ...stateRef.current });
                }}
                onRequestTeardown={() => {
                  if (!currentDocument(state.lifetime)) return;
                  retiredNonceRef.current = nonceRef.current;
                  launchRef.current?.controller.abort();
                  clearDocument({ phase: "closed" });
                  releaseLaunches();
                  setStarted(false);
                  updateRefresh("idle");
                }}
              />
            </div>
          : (
            <p className="pt-3 text-xs text-muted-foreground" role="status">
              This saved app view is unavailable until its workspace reconnects.
            </p>
          )
        ) : null}
      </DashboardTileShell>
      {loadingDocument ? (
        <div className="absolute inset-0 z-10 flex flex-col gap-3 rounded-xl bg-background p-3" role="status" aria-label={`Loading ${entry.title}`} data-dashboard-loading>
          <span className="text-xs text-muted-foreground">Loading {entry.title}</span>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="min-h-24 w-full flex-1" />
        </div>
      ) : null}
      {state.phase === "ready" && !loadingDocument && !state.lifetime.failed && refreshState !== "idle" ? (
        <div className="pointer-events-none absolute right-10 top-1 z-10 rounded bg-background/90 px-2 py-1 text-[11px] text-muted-foreground"
          role="status" aria-live="polite" data-dashboard-cache-state={refreshState}>
          {refreshState === "refreshing" ? "Updating…" : "Refresh failed · showing last good data"}
        </div>
      ) : null}
    </div>
  );
}
