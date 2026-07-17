"use client";

import { useEffect, useRef, useState } from "react";
import { openMcpAuthorizationWindow, safeMcpAuthorizationUrl } from "./mcp-authorization-url";
import { useMcpConnections, useStartMcpConnectionOAuth } from "./mcp-connections-data";

const OAUTH_POLL_INTERVAL_MS = 2000;
const OAUTH_POLL_TIMEOUT_MS = 90_000;

export function useMcpAccountAuthorization(onConnected?: () => void) {
  const { refetch } = useMcpConnections("usable");
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

  function pollUntilConnected(connectionId: string) {
    stopPolling();
    setPollingConnectionId(connectionId);
    const startedAt = Date.now();
    pollTimer.current = setInterval(async () => {
      const result = await refetch();
      const connection = result.data?.find((entry) => entry.id === connectionId);
      if (connection?.connectedForMe && connection.needsReconnect !== true) {
        finishConnected();
        return;
      }
      if (Date.now() - startedAt > OAUTH_POLL_TIMEOUT_MS) {
        stopPolling();
      }
    }, OAUTH_POLL_INTERVAL_MS);
  }

  async function connect(connectionId: string) {
    setError(null);
    let authorizationWindow: Window | null = null;
    try {
      authorizationWindow = openMcpAuthorizationWindow();
      const result = await startOAuth.mutateAsync(connectionId);
      if (result.status === "connected") {
        authorizationWindow.close();
        void refetch();
        finishConnected();
        return;
      }
      if (!result.authorizeUrl) {
        throw new Error("The MCP provider did not return an authorization URL.");
      }
      authorizationWindow.location.href = safeMcpAuthorizationUrl(result.authorizeUrl);
      pollUntilConnected(connectionId);
    } catch (connectError) {
      authorizationWindow?.close();
      setError({
        connectionId,
        message: connectError instanceof Error ? connectError.message : "Failed to connect account.",
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
