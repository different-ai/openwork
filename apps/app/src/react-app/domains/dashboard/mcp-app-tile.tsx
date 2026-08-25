/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
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
import type { DashboardMcpAppEntry } from "./dashboard-store";

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
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; app: OpenworkMcpAppResource; result: PreservedMcpAppResult; endpoint: DashboardLaunchEndpoint }
  | { phase: "closed" }
  | { phase: "error"; message: string };

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

export function McpAppTile({ entry, onRemove, onApprovedLaunch, onFirstRunCompleted, fallbackEndpoints }: {
  entry: DashboardMcpAppEntry;
  onRemove: () => void;
  /** Persists the user's one-time launch approval on the stored entry. */
  onApprovedLaunch?: () => void;
  /** Persists that the user has run this tile once, unlocking automatic launches. */
  onFirstRunCompleted?: () => void;
  /** Other workspace runtimes to try when the primary one cannot resolve the app. */
  fallbackEndpoints?: DashboardLaunchEndpoint[];
}) {
  const workspace = useWorkspace();
  const { openworkServerClient, workspaceId } = workspace;
  // Automatic launches are earned, not granted: a tile runs on dashboard open
  // only after the user has run it manually once and seen what it does.
  // Write-tools stay run-on-request forever, so a dashboard visit can never
  // repeat a data-modifying call.
  const manualLaunch = entry.requiresApproval === true || entry.autoLaunch !== true;
  const [started, setStarted] = useState(!manualLaunch);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<TileState>({ phase: manualLaunch ? "idle" : "loading" });
  const launchArguments = entry.launchArguments ?? EMPTY_ARGUMENTS;
  // Read consent through refs so persisting it after the first approval does
  // not re-run the launch effect and duplicate a write-tool call.
  const launchApprovedRef = useRef(entry.launchApproved === true);
  launchApprovedRef.current = entry.launchApproved === true;
  const onApprovedLaunchRef = useRef(onApprovedLaunch);
  onApprovedLaunchRef.current = onApprovedLaunch;
  const onFirstRunCompletedRef = useRef(onFirstRunCompleted);
  onFirstRunCompletedRef.current = onFirstRunCompleted;
  // A write-tool launch must map 1:1 to a Run/refresh press. The effect also
  // re-runs when the client or workspace identity changes; this ref keeps such
  // re-runs from repeating an already-executed data-modifying call.
  const executedRunRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!started) {
      setState({ phase: "idle" });
      return;
    }
    if (manualLaunch && executedRunRef.current === nonce) return;
    executedRunRef.current = nonce;
    setState({ phase: "loading" });
    // Tiles are user-scoped while MCP servers are workspace-scoped: prefer the
    // selected workspace's runtime, then any other available one that can
    // still resolve this app.
    const candidates: DashboardLaunchEndpoint[] = [
      ...(openworkServerClient && workspaceId ? [{ client: openworkServerClient, workspaceId }] : []),
      ...(fallbackEndpoints ?? []),
    ].filter((endpoint, index, all) => all.findIndex((other) => other.workspaceId === endpoint.workspaceId) === index);
    if (candidates.length === 0) {
      setState({ phase: "error", message: "No connected workspace is available to launch this app." });
      return;
    }
    const userInitiated = nonce > 0;
    void (async (): Promise<TileState> => {
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
        ...(launchApprovedRef.current ? { approved: true } : {}),
      };
      let result;
      try {
        result = await endpoint.client.callMcpAppTool(endpoint.workspaceId, request);
      } catch (cause) {
        if (!(cause instanceof OpenworkServerError) || cause.code !== "tool_requires_approval") throw cause;
        // A stored entry can go stale: a tool that was read-only at add time
        // may need approval now. Never pop a consent prompt from an automatic
        // mount launch — fall back to the idle Run card and ask on request.
        if (!userInitiated) return { phase: "idle" };
        const approved = window.confirm(
          `Allow this MCP App to call ${app.toolName} on ${app.serverName}? `
          + "OpenWork remembers your choice for this tile until you remove it.",
        );
        if (!approved) return { phase: "error", message: "The app launch was declined." };
        result = await endpoint.client.callMcpAppTool(endpoint.workspaceId, { ...request, approved: true });
        launchApprovedRef.current = true;
        onApprovedLaunchRef.current?.();
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
      if (userInitiated && entry.requiresApproval !== true && entry.autoLaunch !== true) {
        onFirstRunCompletedRef.current?.();
      }
      return {
        phase: "ready",
        app,
        endpoint,
        result: {
          content: result.content,
          ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
          ...(result._meta ? { _meta: result._meta } : {}),
        },
      };
    })()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          phase: "error",
          message: cause instanceof Error && cause.message ? cause.message : "The app could not be launched.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [entry.connectionId, entry.projectedToolName, entry.resourceUri, entry.toolName, fallbackEndpoints, launchArguments, manualLaunch, nonce, openworkServerClient, started, workspaceId]);

  const run = () => {
    setStarted(true);
    setNonce((value) => value + 1);
  };

  return (
    <DashboardTileShell
      title={entry.title}
      subtitle={entry.serverName}
      onRefresh={run}
      onRemove={onRemove}
    >
      {state.phase === "idle" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
          <Play className="size-6 text-muted-foreground" aria-hidden />
          <p className="max-w-xs text-xs text-muted-foreground">
            {entry.requiresApproval === true
              ? "This app modifies data when it runs, so it only runs when you ask."
              : "Run this app once; after that it launches automatically when the dashboard opens."}
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
        // view must run under the endpoint that actually resolved the app.
        <WorkspaceProvider
          client={workspace.client}
          opencodeBaseUrl={workspace.opencodeBaseUrl}
          openworkServerClient={state.endpoint.client}
          workspaceId={state.endpoint.workspaceId}
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
        </WorkspaceProvider>
      ) : null}
    </DashboardTileShell>
  );
}
