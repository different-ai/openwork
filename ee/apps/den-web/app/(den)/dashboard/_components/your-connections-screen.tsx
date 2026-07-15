"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Check, Loader2, Plug, Wrench } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IntegrationIcon } from "./integration-icon";
import { formatRequiredBy, sortConnectionsForFocus, trustedConnectionFocusId } from "./mcp-connection-display";
import { openMcpAuthorizationWindow, safeMcpAuthorizationUrl } from "./mcp-authorization-url";
import { MICROSOFT_365_DISPLAY_SCOPES } from "./microsoft-365-permissions";
import {
  canDisconnectMyConnectionAccount,
  type ExternalMcpConnection,
  isNativeProviderConnectionId,
  useDisconnectMyProviderAccount,
  useMcpConnections,
  useStartMcpConnectionOAuth,
} from "./mcp-connections-data";
import { McpToolRunner } from "./mcp-tool-runner";

const OAUTH_POLL_INTERVAL_MS = 2000;
const OAUTH_POLL_TIMEOUT_MS = 90_000;

/**
 * The member-facing half of MCP Connections. An admin publishes a
 * connection (mcp-connections-screen.tsx, admin-only); every granted member
 * sees it here. For "per_member" connections this is where each person
 * connects their own account — after which their agent's
 * search_capabilities/execute_capability calls run as them.
 * Admins can also finish a shared-credential connection's OAuth here when
 * the org account was published but never authorized.
 */
export function YourConnectionsScreen() {
  const { data: connections = [], isLoading, error, refetch } = useMcpConnections("usable");
  const { orgContext } = useOrgDashboard();
  const searchParams = useSearchParams();
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles,
  );
  const startOAuth = useStartMcpConnectionOAuth();
  const disconnectProvider = useDisconnectMyProviderAccount();
  const [pollingConnectionId, setPollingConnectionId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ connectionId: string; message: string } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const focusedRowRef = useRef<HTMLDivElement | null>(null);
  const focusConnectionId = trustedConnectionFocusId(connections, searchParams.get("connectionId"));
  const visibleConnections = useMemo(
    () => sortConnectionsForFocus(connections, focusConnectionId),
    [connections, focusConnectionId],
  );

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!focusConnectionId || !focusedRowRef.current) return;
    focusedRowRef.current.scrollIntoView({ block: "center" });
    focusedRowRef.current.focus({ preventScroll: true });
  }, [focusConnectionId, visibleConnections.length]);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    setPollingConnectionId(null);
  }

  function pollUntilConnectedForMe(connectionId: string) {
    setPollingConnectionId(connectionId);
    const startedAt = Date.now();
    pollTimer.current = setInterval(async () => {
      const result = await refetch();
      const connection = result.data?.find((entry) => entry.id === connectionId);
      if ((connection?.connectedForMe && connection.needsReconnect !== true) || Date.now() - startedAt > OAUTH_POLL_TIMEOUT_MS) {
        stopPolling();
      }
    }, OAUTH_POLL_INTERVAL_MS);
  }

  async function handleConnectMyAccount(connectionId: string) {
    setRowError(null);
    let authorizationWindow: Window | null = null;
    try {
      authorizationWindow = openMcpAuthorizationWindow();
      const result = await startOAuth.mutateAsync(connectionId);
      if (result.status === "connected") {
        authorizationWindow.close();
        void refetch();
        return;
      }
      if (!result.authorizeUrl) throw new Error("The MCP provider did not return an authorization URL.");
      authorizationWindow.location.href = safeMcpAuthorizationUrl(result.authorizeUrl);
      pollUntilConnectedForMe(connectionId);
    } catch (connectError) {
      authorizationWindow?.close();
      setRowError({
        connectionId,
        message: connectError instanceof Error ? connectError.message : "Failed to connect account.",
      });
    }
  }

  async function handleDisconnectMyAccount(connectionId: string) {
    setRowError(null);
    try {
      await disconnectProvider.mutateAsync(connectionId);
      void refetch();
    } catch (disconnectError) {
      setRowError({
        connectionId,
        message: disconnectError instanceof Error ? disconnectError.message : "Failed to disconnect account.",
      });
    }
  }

  return (
    <DashboardPageTemplate
      icon={Plug}
      title="Your Connections"
      badgeLabel="Alpha"
      description="Tools your organization has made available to you. Connect your own account where needed; workspace admins can test tools directly, and your AI coworker uses them with your permissions."
      colors={["#DBEAFE", "#1E3A8A", "#2563EB", "#93C5FD"]}
    >
      {error ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
          {error instanceof Error ? error.message : "Failed to load your connections."}
        </div>
      ) : null}

      {isLoading ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading your connections…
        </div>
      ) : connections.length === 0 ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-center text-[14px] text-gray-500">
          Nothing has been shared with you yet. Ask a workspace admin to add an MCP connection.
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-2xl border border-gray-100 bg-white">
          {visibleConnections.map((connection) => (
            <YourConnectionRow
              key={connection.id}
              connection={connection}
              isAdmin={access.isAdmin}
              highlighted={focusConnectionId === connection.id}
              rowRef={focusConnectionId === connection.id ? focusedRowRef : undefined}
              polling={pollingConnectionId === connection.id}
              connecting={startOAuth.isPending && startOAuth.variables === connection.id}
              disconnecting={disconnectProvider.isPending && disconnectProvider.variables === connection.id}
              errorMessage={rowError?.connectionId === connection.id ? rowError.message : null}
              onConnect={() => void handleConnectMyAccount(connection.id)}
              onDisconnect={() => void handleDisconnectMyAccount(connection.id)}
            />
          ))}
        </div>
      )}
    </DashboardPageTemplate>
  );
}

function YourConnectionRow({
  connection,
  isAdmin,
  polling,
  connecting,
  disconnecting,
  errorMessage,
  highlighted,
  rowRef,
  onConnect,
  onDisconnect,
}: {
  connection: ExternalMcpConnection;
  isAdmin: boolean;
  highlighted: boolean;
  rowRef?: React.Ref<HTMLDivElement>;
  polling: boolean;
  connecting: boolean;
  disconnecting: boolean;
  errorMessage: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const isPerMember = connection.credentialMode === "per_member";
  const needsReconnect = connection.connectedForMe && connection.needsReconnect === true;
  const needsMyConnect = isPerMember && !connection.connectedForMe;
  const needsAdminConnect = isAdmin && !isPerMember && connection.authType === "oauth" && !connection.connectedForMe;
  const canDisconnect = canDisconnectMyConnectionAccount(connection);
  const canTestTools = isAdmin && !isNativeProviderConnectionId(connection.id) && connection.connectedForMe && !needsReconnect;
  const [toolRunnerOpen, setToolRunnerOpen] = useState(false);
  const microsoftScopes = connection.id === "microsoft-365"
    ? (connection.grantedScopes ?? []).filter((scope) => MICROSOFT_365_DISPLAY_SCOPES.has(scope))
    : [];
  const requiredByLabel = formatRequiredBy(connection.requiredBy);

  return (
    <div
      ref={rowRef}
      tabIndex={highlighted ? -1 : undefined}
      className={`outline-none transition ${highlighted ? "bg-blue-50/70 ring-2 ring-inset ring-blue-200" : ""}`}
    >
      <div className="flex flex-col gap-4 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <IntegrationIcon name={connection.name} serviceUrl={connection.url} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-[14px] font-semibold text-gray-900">{connection.name}</p>
              {needsReconnect ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                  <AlertTriangle className="h-3 w-3" />
                  Reconnect to grant new permissions
                </span>
              ) : connection.connectedForMe ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                  <Check className="h-3 w-3" />
                  {isPerMember ? "Connected as you" : "Org account connected"}
                </span>
              ) : polling ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Waiting for authorization…
                </span>
              ) : needsMyConnect ? (
                <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                  Connect your account
                </span>
              ) : needsAdminConnect ? (
                <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                  Connect the org account
                </span>
              ) : (
                <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                  Waiting for an admin to connect
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[12px] text-gray-500">{connection.url}</p>
            {requiredByLabel ? (
              <p className="mt-1 text-[12px] font-medium text-gray-700">{requiredByLabel}</p>
            ) : null}
            {connection.id === "microsoft-365" && connection.tenantId ? (
              <p className="mt-1 text-[11px] text-gray-500">
                Tenant <span className="font-mono text-gray-700">{connection.tenantId}</span>
                {connection.externalAccountId ? <> · {connection.externalAccountId}</> : null}
              </p>
            ) : null}
            {microsoftScopes.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Approved Microsoft 365 capabilities">
                {microsoftScopes.map((scope) => (
                  <span key={scope} className="rounded-full bg-blue-50 px-2 py-0.5 font-mono text-[10px] text-blue-700">{scope}</span>
                ))}
              </div>
            ) : null}
            {errorMessage ? <p className="mt-1 text-[12px] text-red-600">{errorMessage}</p> : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canTestTools ? (
            <DenButton
              variant="secondary"
              size="sm"
              icon={Wrench}
              onClick={() => setToolRunnerOpen((open) => !open)}
              aria-expanded={toolRunnerOpen}
              aria-label={`Test tools for ${connection.name}`}
              title={`Test tools for ${connection.name}`}
              className="h-8 w-8 !px-0"
              data-testid={`toggle-mcp-tool-runner-${connection.id}`}
            />
          ) : null}
          {canDisconnect ? (
            <DenButton variant="destructive" size="sm" loading={disconnecting} onClick={onDisconnect} data-testid={`disconnect-my-mcp-account-${connection.id}`}>
              Disconnect
            </DenButton>
          ) : null}
          {needsReconnect || needsMyConnect || needsAdminConnect ? (
            <DenButton variant="primary" size="sm" loading={connecting || polling} onClick={onConnect}>
              {needsReconnect ? "Reconnect" : "Connect"}
            </DenButton>
          ) : null}
        </div>
      </div>
      {toolRunnerOpen && canTestTools ? <McpToolRunner connection={connection} /> : null}
    </div>
  );
}
