import { useCallback, useEffect, useRef, useState } from "react";

import { createDenClient, readDenSettings, type DenExternalMcpConnection } from "@/app/lib/den";
import { openDesktopUrl } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/utils";

// Mirrors the poll-until-connected pattern used for local MCP OAuth
// (mcp-auth-modal.tsx) — the external server's redirect completes on a
// background browser tab/window, so the desktop app finds out by polling
// Den for the connection's `connectedForMe` flag rather than any callback
// into the app itself.
const CONNECT_POLL_INTERVAL_MS = 2_000;
const CONNECT_TIMEOUT_MS = 90_000;

async function openAuthorizationUrl(url: string) {
  if (isDesktopRuntime()) {
    await openDesktopUrl(url);
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export type OrgMcpConnectionCardState = {
  connected: boolean;
  descriptionKey:
    | "mcp.org_connection_desc_shared"
    | "mcp.org_connection_desc_per_member_connected"
    | "mcp.org_connection_desc_per_member";
  actionLabelKey:
    | "mcp.org_connection_managed_label"
    | "mcp.org_connection_connected_label"
    | "mcp.org_connection_connect_action";
};

/**
 * Pure projection from a raw Den connection to what the card should show.
 * A `shared`-credential connection is set up once by an admin — the member
 * never "connects" it themselves, so it's shown as managed, not actionable.
 * A `per_member` connection needs the CALLING member's own OAuth, tracked by
 * `connectedForMe` rather than the connection-wide `connected` flag.
 */
export function resolveOrgMcpConnectionCardState(
  connection: Pick<DenExternalMcpConnection, "credentialMode" | "connected" | "connectedForMe">,
): OrgMcpConnectionCardState {
  if (connection.credentialMode === "shared") {
    return {
      connected: connection.connected,
      descriptionKey: "mcp.org_connection_desc_shared",
      actionLabelKey: "mcp.org_connection_managed_label",
    };
  }

  if (connection.connectedForMe) {
    return {
      connected: true,
      descriptionKey: "mcp.org_connection_desc_per_member_connected",
      actionLabelKey: "mcp.org_connection_connected_label",
    };
  }

  return {
    connected: false,
    descriptionKey: "mcp.org_connection_desc_per_member",
    actionLabelKey: "mcp.org_connection_connect_action",
  };
}

/**
 * Org-level External MCP Connections (Den's `/v1/mcp-connections`) usable by
 * the signed-in member. The settings catalog projects them into Marketplace
 * or My Extensions; they execute through Den's `search_capabilities` /
 * `execute_capability` surface, not local per-workspace `mcpServers` entries.
 */
export function useOrgMcpConnections() {
  const [connections, setConnections] = useState<DenExternalMcpConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!token || !orgId) {
      setConnections([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const client = createDenClient({ baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl, token });
      const result = await client.listMcpConnections(orgId, "usable");
      setConnections(result);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Failed to load organization MCP connections.");
    } finally {
      setLoading(false);
    }
  }, []);

  const connect = useCallback(async (connectionId: string) => {
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!token || !orgId) return;

    setConnectingId(connectionId);
    try {
      const client = createDenClient({ baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl, token });
      const result = await client.startMcpConnectionConnect(orgId, connectionId);
      if (result.status === "connected") {
        await refresh();
        setConnectingId(null);
        return;
      }
      if (!result.authorizeUrl) {
        setConnectingId(null);
        return;
      }

      await openAuthorizationUrl(result.authorizeUrl);

      stopPolling();
      const startedAt = Date.now();
      pollRef.current = window.setInterval(async () => {
        if (Date.now() - startedAt >= CONNECT_TIMEOUT_MS) {
          stopPolling();
          setConnectingId(null);
          return;
        }
        const refreshedSettings = readDenSettings();
        const refreshedToken = refreshedSettings.authToken?.trim() ?? "";
        const refreshedOrgId = refreshedSettings.activeOrgId?.trim() ?? "";
        if (!refreshedToken || !refreshedOrgId) {
          stopPolling();
          setConnectingId(null);
          return;
        }
        try {
          const pollClient = createDenClient({
            baseUrl: refreshedSettings.baseUrl,
            apiBaseUrl: refreshedSettings.apiBaseUrl,
            token: refreshedToken,
          });
          const polled = await pollClient.listMcpConnections(refreshedOrgId, "usable");
          setConnections(polled);
          const match = polled.find((entry) => entry.id === connectionId);
          if (match?.connectedForMe) {
            stopPolling();
            setConnectingId(null);
          }
        } catch {
          // Transient — keep polling until the timeout above gives up.
        }
      }, CONNECT_POLL_INTERVAL_MS);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Failed to start the connection.");
      setConnectingId(null);
    }
  }, [refresh, stopPolling]);

  useEffect(() => {
    void refresh();
    return () => stopPolling();
  }, [refresh, stopPolling]);

  return { connections, loading, error, connectingId, refresh, connect };
}
