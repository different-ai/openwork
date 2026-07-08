"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Plug } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IntegrationIcon } from "./integration-icon";
import {
  canDisconnectNativeProviderAccount,
  type ExternalMcpConnection,
  useDisconnectMyProviderAccount,
  useMcpConnections,
  useStartMcpConnectionOAuth,
} from "./mcp-connections-data";

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

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

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
    const result = await startOAuth.mutateAsync(connectionId);
    if (result.status === "connected") {
      void refetch();
      return;
    }
    if (result.authorizeUrl) {
      window.open(result.authorizeUrl, "_blank", "noopener,noreferrer");
      pollUntilConnectedForMe(connectionId);
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
      description="Tools your organization has made available to you. Connect your own account where needed — your AI coworker then acts as you, with your permissions."
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
          {connections.map((connection) => (
            <YourConnectionRow
              key={connection.id}
              connection={connection}
              isAdmin={access.isAdmin}
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
  onConnect,
  onDisconnect,
}: {
  connection: ExternalMcpConnection;
  isAdmin: boolean;
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
  const canDisconnect = canDisconnectNativeProviderAccount(connection);

  return (
    <div className="flex items-center justify-between gap-4 px-6 py-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <IntegrationIcon name={connection.name} serviceUrl={connection.url} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-[14px] font-semibold text-gray-900">{connection.name}</p>
            {needsReconnect ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
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
          {errorMessage ? <p className="mt-1 text-[12px] text-red-600">{errorMessage}</p> : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {canDisconnect ? (
          <DenButton variant="destructive" size="sm" loading={disconnecting} onClick={onDisconnect}>
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
  );
}
