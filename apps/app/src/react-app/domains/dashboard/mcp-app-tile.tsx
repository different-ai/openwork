/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { Play } from "lucide-react";

import {
  OpenworkServerError,
  type OpenworkMcpAppResource,
  type OpenworkServerClient,
} from "@/app/lib/openwork-server";
import { McpAppSandboxView, type PreservedMcpAppResult } from "@/components/chat/mcp-app-frame";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace, WorkspaceProvider } from "@/react-app/shell/workspace-provider";
import { DashboardTileShell } from "./dashboard-tile-shell";
import {
  DASHBOARD_AUTO_REFRESH_INTERVAL_MS,
  dashboardTileLaunchIsApproved,
  dashboardTileRunsAutomatically,
  readDashboardTileCache,
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

type TileState =
  | { phase: "idle"; revokeAutoLaunch?: boolean }
  | { phase: "loading" }
  | {
      phase: "ready";
      app: OpenworkMcpAppResource;
      result: PreservedMcpAppResult;
      endpoint: DashboardLaunchEndpoint;
      cachedAt: number;
      /** True only when the successful call did not need an approval override. */
      autoLaunchEligible?: boolean;
    }
  | { phase: "closed" }
  | { phase: "error"; message: string };

type RefreshState = "idle" | "refreshing" | "failed" | "approval-required";

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

function freshnessLabel(cachedAt: number): string {
  const ageMinutes = Math.max(0, Math.floor((Date.now() - cachedAt) / 60_000));
  if (ageMinutes < 1) return "Updated just now";
  if (ageMinutes === 1) return "Updated 1 minute ago";
  if (ageMinutes < 60) return `Updated ${ageMinutes} minutes ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  return ageHours === 1 ? "Updated 1 hour ago" : `Updated ${ageHours} hours ago`;
}

export function McpAppTile({
  entry,
  cacheScopeKey,
  onApprovedLaunch,
  onAutoLaunchEnabled,
  onAutoLaunchDisabled,
  fallbackEndpoints,
}: {
  entry: DashboardMcpAppEntry;
  /** Per-user and per-organization scope for workspace-bound last-known-good dashboard data. */
  cacheScopeKey: string;
  /** Persists the user's one-time launch approval on the stored entry. */
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
    all.findIndex((other) => other.workspaceId === endpoint.workspaceId) === index
  )), [fallbackEndpoints, openworkServerClient, workspaceId]);
  // Cached app HTML is interactive, so it follows the same per-user launch
  // consent as a live call and never mounts on a first visit.
  const cached = runsAutomatically ? readDashboardTileCache(cacheScopeKey, entry.id) : null;
  const cachedEndpoint = cached
    ? launchEndpoints.find((endpoint) => endpoint.workspaceId === cached.workspaceId) ?? null
    : null;
  const [started, setStarted] = useState(!manualLaunch);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<TileState>(() => cached && cachedEndpoint
    ? { phase: "ready", app: cached.app, result: cached.result, endpoint: cachedEndpoint, cachedAt: cached.cachedAt }
    : { phase: manualLaunch ? "idle" : "loading" });
  const [refreshState, setRefreshState] = useState<RefreshState>(manualLaunch ? "idle" : "refreshing");
  const refreshStateRef = useRef(refreshState);
  refreshStateRef.current = refreshState;
  const launchArguments = entry.launchArguments ?? EMPTY_ARGUMENTS;
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastRefreshAtRef = useRef(cachedEndpoint ? cached?.cachedAt ?? 0 : 0);
  const userInitiatedNonceRef = useRef<number | null>(null);
  // Read consent through refs so persisting it after the first approval does
  // not re-run the launch effect and duplicate a write-tool call.
  const launchApprovedRef = useRef(entry.launchApproved === true);
  launchApprovedRef.current = entry.launchApproved === true;
  const onApprovedLaunchRef = useRef(onApprovedLaunch);
  onApprovedLaunchRef.current = onApprovedLaunch;
  const onAutoLaunchEnabledRef = useRef(onAutoLaunchEnabled);
  onAutoLaunchEnabledRef.current = onAutoLaunchEnabled;
  const onAutoLaunchDisabledRef = useRef(onAutoLaunchDisabled);
  onAutoLaunchDisabledRef.current = onAutoLaunchDisabled;
  // A write-tool launch must map 1:1 to a Run/refresh press. Dependency churn
  // reuses the same in-flight promise; a null promise marks a settled nonce so
  // later re-renders cannot repeat an already-executed data-modifying call.
  const launchRef = useRef<{ nonce: number; promise: Promise<TileState> | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!started) {
      if (stateRef.current.phase !== "ready") setState({ phase: "idle" });
      return;
    }
    const currentLaunch = launchRef.current?.nonce === nonce ? launchRef.current : null;
    if (currentLaunch?.promise === null) return;
    setRefreshState("refreshing");
    if (stateRef.current.phase !== "ready") setState({ phase: "loading" });
    // Tiles are user-scoped while MCP servers are workspace-scoped: prefer the
    // selected workspace's runtime, then any other available one that can
    // still resolve this app.
    const candidates = launchEndpoints;
    if (candidates.length === 0) {
      launchRef.current = { nonce, promise: null };
      if (stateRef.current.phase === "ready") setRefreshState("failed");
      else {
        setState({ phase: "error", message: "No connected workspace is available to launch this app." });
        setRefreshState("failed");
      }
      return;
    }
    const userInitiated = userInitiatedNonceRef.current === nonce;
    const promise = currentLaunch?.promise ?? (async (): Promise<TileState> => {
      // Connect app-host apps resolve through their connection reference; the
      // host revalidates the live UI binding before returning the resource.
      const launch = entry.connectionId
        ? {
            connectionId: entry.connectionId,
            toolName: entry.toolName,
            resourceUri: entry.resourceUri,
            arguments: launchArguments,
          }
        : undefined;
      let resolved: { endpoint: DashboardLaunchEndpoint; app: OpenworkMcpAppResource } | null = null;
      let resolveFailure: unknown = null;
      for (const endpoint of candidates) {
        try {
          const { app } = await endpoint.client.resolveMcpApp(endpoint.workspaceId, entry.projectedToolName, launch);
          if (app) {
            resolved = { endpoint, app };
            break;
          }
        } catch (cause) {
          resolveFailure ??= cause;
        }
      }
      if (!resolved) {
        if (resolveFailure) throw resolveFailure;
        return { phase: "error", message: "This tool no longer advertises an interactive app." };
      }
      const { endpoint, app } = resolved;
      const request = {
        serverName: app.serverName,
        name: app.toolName,
        resourceUri: app.resourceUri,
        arguments: launchArguments,
        ...(dashboardTileLaunchIsApproved(
          entry.organizationAutoLaunch === true,
          launchApprovedRef.current,
        ) ? { approved: true } : {}),
      };
      let result;
      let approvalWasRequired = false;
      try {
        result = await endpoint.client.callMcpAppTool(endpoint.workspaceId, request);
      } catch (cause) {
        if (!(cause instanceof OpenworkServerError) || cause.code !== "tool_requires_approval") throw cause;
        approvalWasRequired = true;
        // A stored entry can go stale: a tool that was read-only at add time
        // may need approval now. Never pop a consent prompt from an automatic
        // mount launch — fall back to the idle Run card and ask on request.
        if (!userInitiated) return { phase: "idle", revokeAutoLaunch: true };
        const approved = window.confirm(
          `Allow this MCP App to call ${app.toolName} on ${app.serverName}? `
          + "OpenWork remembers your choice for this tile until you remove it.",
        );
        if (!approved) return { phase: "error", message: "The app launch was declined." };
        result = await endpoint.client.callMcpAppTool(endpoint.workspaceId, { ...request, approved: true });
        launchApprovedRef.current = true;
        onApprovedLaunchRef.current?.();
        onAutoLaunchDisabledRef.current?.();
      }
      if (result.isError) {
        return {
          phase: "error",
          message: launchFailureMessage(result.content)
            ?? (entry.launchArguments
              ? "This app could not start with the saved launch input. Remove the tile and add it again with corrected input."
              : "This app could not start without input, which this tile does not provide."),
        };
      }
      return {
        phase: "ready",
        app,
        endpoint,
        cachedAt: Date.now(),
        result: {
          content: result.content,
          ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
          ...(result._meta ? { _meta: result._meta } : {}),
        },
        // A tile that has ever required an approval override remains manual.
        // This also covers later runs where stored approval makes the call
        // succeed without another tool_requires_approval response.
        autoLaunchEligible: !approvalWasRequired && !launchApprovedRef.current,
      };
    })();
    if (!currentLaunch) {
      launchRef.current = { nonce, promise };
      const markSettled = () => {
        if (launchRef.current?.nonce === nonce && launchRef.current.promise === promise) {
          launchRef.current = { nonce, promise: null };
        }
      };
      void promise.then(markSettled, markSettled);
    }
    void promise
      .then((next) => {
        if (cancelled) return;
        if (next.phase === "ready") {
          writeDashboardTileCache(cacheScopeKey, entry.id, {
            cachedAt: next.cachedAt,
            workspaceId: next.endpoint.workspaceId,
            app: next.app,
            result: next.result,
          });
          lastRefreshAtRef.current = next.cachedAt;
          setState(next);
          setRefreshState("idle");
          if (userInitiated && next.autoLaunchEligible && entry.autoLaunch !== true) {
            onAutoLaunchEnabledRef.current?.();
          }
          return;
        }
        if (next.phase === "idle" && next.revokeAutoLaunch) {
          setStarted(false);
          setState({ phase: "idle" });
          setRefreshState("idle");
          onAutoLaunchDisabledRef.current?.();
          return;
        }
        if (stateRef.current.phase === "ready") {
          setRefreshState(next.phase === "idle" ? "approval-required" : "failed");
          return;
        }
        setState(next);
        setRefreshState(next.phase === "error" ? "failed" : "idle");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (stateRef.current.phase === "ready") {
          setRefreshState("failed");
          return;
        }
        setState({
          phase: "error",
          message: cause instanceof Error && cause.message ? cause.message : "The app could not be launched.",
        });
        setRefreshState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [cacheScopeKey, entry.connectionId, entry.id, entry.projectedToolName, entry.resourceUri, entry.toolName, launchArguments, launchEndpoints, manualLaunch, nonce, started]);

  useEffect(() => {
    if (manualLaunch) return;
    const refreshIfStale = () => {
      if (!shouldAutoRefreshDashboardTile({
        visible: !document.hidden,
        refreshing: refreshStateRef.current === "refreshing",
        lastRefreshAt: lastRefreshAtRef.current,
      })) return;
      setNonce((value) => value + 1);
    };
    const interval = window.setInterval(refreshIfStale, DASHBOARD_AUTO_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, [manualLaunch]);

  const run = () => {
    setStarted(true);
    setNonce((value) => {
      const next = value + 1;
      userInitiatedNonceRef.current = next;
      return next;
    });
  };

  const interactiveEndpoint = state.phase === "ready"
    ? launchEndpoints.find((endpoint) => endpoint.workspaceId === state.endpoint.workspaceId) ?? null
    : null;
  const badge = (() => {
    if (state.phase === "ready" && !interactiveEndpoint) return "Saved locally · workspace unavailable";
    if (state.phase === "ready" && refreshState === "refreshing") return "Saved locally · refreshing";
    if (state.phase === "ready" && refreshState === "failed") return "Saved locally · refresh failed";
    if (state.phase === "ready" && refreshState === "approval-required") return "Saved locally · run required";
    if (state.phase === "ready" && entry.organizationAutoLaunch === true) {
      return `Organization auto-run · ${freshnessLabel(state.cachedAt)}`;
    }
    if (state.phase === "ready" && entry.requiresApproval === true) return "Saved locally · run on request";
    if (state.phase === "ready") return freshnessLabel(state.cachedAt);
    if (state.phase === "loading") return "Loading";
    if (state.phase === "error") return "Refresh failed";
    if (entry.organizationAutoLaunch === true) return "Organization auto-run";
    if (entry.requiresApproval === true) return "Run on request";
    if (manualLaunch) return "Run once to enable";
    return null;
  })();

  return (
    <DashboardTileShell
      title={entry.title}
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
            className={`size-1.5 rounded-full ${state.phase === "error" || refreshState === "failed" || refreshState === "approval-required" || (state.phase === "ready" && !interactiveEndpoint) ? "bg-amber-500" : "bg-emerald-500"}`}
            aria-hidden
          />
          {badge}
        </span>
      ) : undefined}
      onRefresh={run}
      refreshing={refreshState === "refreshing"}
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
      {state.phase === "loading" ? (
        <div className="space-y-2 pt-3" role="status" aria-label={`Loading ${entry.title}`}>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}
      {state.phase === "error" ? (
        <p className="pt-3 text-xs text-muted-foreground" role="status">{state.message}</p>
      ) : null}
      {state.phase === "closed" ? (
        <p className="pt-3 text-xs text-muted-foreground" role="status">
          This app closed its view. Use refresh to launch it again.
        </p>
      ) : null}
      {state.phase === "ready" ? (
        // The sandbox bridge calls tools through the workspace context, so the
        // view only runs while that exact workspace endpoint is connected.
        interactiveEndpoint ? <WorkspaceProvider
          client={workspace.client}
          opencodeBaseUrl={workspace.opencodeBaseUrl}
          openworkServerClient={interactiveEndpoint.client}
          workspaceId={interactiveEndpoint.workspaceId}
          selectedWorkspaceRoot={workspace.selectedWorkspaceRoot}
        >
          <McpAppSandboxView
            key={nonce}
            app={state.app}
            toolName={entry.projectedToolName}
            inputArguments={launchArguments}
            result={state.result}
            unavailableNotice="This app view is unavailable."
            onRequestTeardown={() => setState({ phase: "closed" })}
          />
        </WorkspaceProvider> : (
          <p className="pt-3 text-xs text-muted-foreground" role="status">
            This saved app view is unavailable until its workspace reconnects.
          </p>
        )
      ) : null}
      {state.phase === "ready" && refreshState === "approval-required" ? (
        <div className="border-t border-border py-2 text-center">
          <Button variant="outline" size="sm" onClick={run} aria-label={`Run ${entry.title}`}>
            <Play className="size-4" /> Run
          </Button>
        </div>
      ) : null}
    </DashboardTileShell>
  );
}
