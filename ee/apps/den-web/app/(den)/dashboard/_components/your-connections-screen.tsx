"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Plug } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import {
  type ExternalMcpConnection,
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
 */
export function YourConnectionsScreen() {
  const { data: connections = [], isLoading, error, refetch } = useMcpConnections("usable");
  const startOAuth = useStartMcpConnectionOAuth();
  const [pollingConnectionId, setPollingConnectionId] = useState<string | null>(null);
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
      if (connection?.connectedForMe || Date.now() - startedAt > OAUTH_POLL_TIMEOUT_MS) {
        stopPolling();
      }
    }, OAUTH_POLL_INTERVAL_MS);
  }

  async function handleConnectMyAccount(connectionId: string) {
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

  return (
    <DashboardPageTemplate
      icon={Plug}
      badgeLabel="New"
      title="Your Connections"
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
              polling={pollingConnectionId === connection.id}
              connecting={startOAuth.isPending && startOAuth.variables === connection.id}
              onConnect={() => void handleConnectMyAccount(connection.id)}
            />
          ))}
        </div>
      )}
    </DashboardPageTemplate>
  );
}

function YourConnectionRow({
  connection,
  polling,
  connecting,
  onConnect,
}: {
  connection: ExternalMcpConnection;
  polling: boolean;
  connecting: boolean;
  onConnect: () => void;
}) {
  const isPerMember = connection.credentialMode === "per_member";
  const needsMyConnect = isPerMember && !connection.connectedForMe;

  return (
    <div className="flex items-center justify-between gap-4 px-6 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-[14px] font-semibold text-gray-900">{connection.name}</p>
          {connection.connectedForMe ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              <Check className="h-3 w-3" />
              {isPerMember ? "Connected as you" : "Connected"}
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
          ) : (
            <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
              Not connected yet
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-[12px] text-gray-500">{connection.url}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {needsMyConnect ? (
          <DenButton variant="primary" size="sm" loading={connecting || polling} onClick={onConnect}>
            Connect
          </DenButton>
        ) : null}
      </div>
    </div>
  );
}
