"use client";

import { useEffect, useRef, useState } from "react";
import { openMcpAuthorizationTab, safeMcpAuthorizationUrl, showMcpAuthorizationFailure } from "./mcp-authorization-url";
import {
  MCP_AUTHORIZATION_TIMEOUT_MESSAGE,
  MCP_AUTHORIZATION_UNCONFIRMED_CONNECTED_MESSAGE,
  MCP_AUTHORIZATION_WINDOW_CLOSED_MESSAGE,
  resolveMcpAuthorizationPollOutcome,
} from "./mcp-account-authorization-state";
import {
  McpOAuthStartError,
  useMcpConnections,
  useStartMcpConnectionOAuth,
} from "./mcp-connections-data";

const OAUTH_POLL_INTERVAL_MS = 2000;
const OAUTH_POLL_TIMEOUT_MS = 90_000;

export function useMcpAccountAuthorization(onConnected?: () => void) {
  const { data: connections = [], refetch } = useMcpConnections("usable");
  const startOAuth = useStartMcpConnectionOAuth();
  const [pollingConnectionId, setPollingConnectionId] = useState<string | null>(null);
  const [error, setError] = useState<{ connectionId: string; message: string } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onConnectedRef = useRef(onConnected);

  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

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

  function finishConnected() {
    stopPolling();
    onConnectedRef.current?.();
  }

  function finishFailed(
    connectionId: string,
    connectionName: string,
    authorizationTab: Window,
    message: string,
  ) {
    stopPolling();
    showMcpAuthorizationFailure(authorizationTab, { connectionId, connectionName, message });
    setError({ connectionId, message });
  }

  function pollUntilConnected(connectionId: string, connectionName: string, authorizationTab: Window) {
    stopPolling();
    setPollingConnectionId(connectionId);
    const startedAt = Date.now();
    pollTimer.current = setInterval(async () => {
      const result = await refetch();
      const connection = result.data?.find((entry) => entry.id === connectionId);
      const outcome = resolveMcpAuthorizationPollOutcome({
        connected: Boolean(connection?.connectedForMe && connection.needsReconnect !== true),
        authorizationWindowClosed: authorizationTab.closed,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: OAUTH_POLL_TIMEOUT_MS,
      });
      if (outcome === "connected") {
        finishConnected();
      } else if (outcome === "window_closed") {
        finishFailed(connectionId, connectionName, authorizationTab, MCP_AUTHORIZATION_WINDOW_CLOSED_MESSAGE);
      } else if (outcome === "timeout") {
        finishFailed(connectionId, connectionName, authorizationTab, MCP_AUTHORIZATION_TIMEOUT_MESSAGE);
      }
    }, OAUTH_POLL_INTERVAL_MS);
  }

  async function connect(connectionId: string) {
    setError(null);
    const connectionName = connections.find((connection) => connection.id === connectionId)?.name ?? "this provider";
    let authorizationTab: Window | null = null;
    try {
      authorizationTab = openMcpAuthorizationTab({ connectionId, connectionName });
      const result = await startOAuth.mutateAsync(connectionId);
      if (result.status === "connected") {
        const refreshed = await refetch();
        const connection = refreshed.data?.find((entry) => entry.id === connectionId);
        if (connection?.connectedForMe && connection.needsReconnect !== true) {
          authorizationTab.close();
          finishConnected();
        } else {
          finishFailed(
            connectionId,
            connectionName,
            authorizationTab,
            MCP_AUTHORIZATION_UNCONFIRMED_CONNECTED_MESSAGE,
          );
        }
        return;
      }
      if (!result.authorizeUrl) {
        throw new Error("The MCP provider did not return an authorization URL.");
      }
      authorizationTab.location.href = safeMcpAuthorizationUrl(result.authorizeUrl);
      pollUntilConnected(connectionId, connectionName, authorizationTab);
    } catch (connectError) {
      const message = connectError instanceof Error ? connectError.message : "Failed to connect account.";
      showMcpAuthorizationFailure(authorizationTab, {
        connectionId,
        connectionName,
        message,
        ...(connectError instanceof McpOAuthStartError
          ? { details: connectError.details }
          : {}),
      });
      setError({
        connectionId,
        message,
      });
    }
  }

  return {
    connect,
    connectingConnectionId: startOAuth.isPending ? startOAuth.variables ?? null : null,
    error,
    pollingConnectionId,
  };
}
