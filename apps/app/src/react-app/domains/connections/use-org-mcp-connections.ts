import { useCallback, useEffect, useRef, useState } from "react";

import { createDenClient, readDenSettings, type DenClient, type DenExternalMcpConnection } from "@/app/lib/den";
import { denSettingsChangedEvent } from "@/app/lib/den-session-events";
import { openDesktopUrl } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/utils";
import {
  loadOrgMcpConnections,
  readCachedOrgMcpConnections,
  readCloudInventoryScope,
} from "./cloud-inventory-cache";
import { connectionNeedsReconnect, isNativeProviderConnectionId } from "./native-provider-connections";

// Mirrors the poll-until-connected pattern used for local MCP OAuth
// (mcp-auth-modal.tsx) — the external server's redirect completes on a
// background browser tab/window, so the desktop app finds out by polling
// Den for the connection's `connectedForMe` flag rather than any callback
// into the app itself.
const CONNECT_POLL_INTERVAL_MS = 2_000;
const CONNECT_TIMEOUT_MS = 90_000;

export type OrgMcpConnectFailure =
  | "missing_context"
  | "missing_authorization_url"
  | "timeout";

export function orgMcpConnectFailureMessage(failure: OrgMcpConnectFailure): string {
  switch (failure) {
    case "missing_context":
      return "Sign in to OpenWork Cloud and select an organization before connecting.";
    case "missing_authorization_url":
      return "The connection did not return a sign-in URL. Check its OAuth configuration and try again.";
    case "timeout":
      return "Sign-in did not complete. Check the provider window for an OAuth error, then verify the provider redirect URI and try again.";
  }
}

async function openAuthorizationUrl(url: string) {
  if (isDesktopRuntime()) {
    await openDesktopUrl(url);
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

async function disconnectMemberAccount(
  client: DenClient,
  orgId: string,
  connection: Pick<DenExternalMcpConnection, "id" | "nativeProviderKey">,
): Promise<void> {
  if (isNativeProviderConnectionId(connection.id, connection.nativeProviderKey)) {
    await client.disconnectOauthProviderAccount(orgId, connection.id);
    return;
  }
  await client.disconnectMyMcpConnectionAccount(orgId, connection.id);
}

export type OrgMcpConnectionCardState = {
  connected: boolean;
  descriptionKey:
    | "mcp.org_connection_desc_shared"
    | "mcp.org_connection_desc_per_member_connected"
    | "mcp.org_connection_desc_per_member_reconnect"
    | "mcp.org_connection_desc_per_member";
  actionLabelKey:
    | "mcp.org_connection_managed_label"
    | "mcp.org_connection_connected_label"
    | "mcp.org_connection_reconnect_action"
    | "mcp.org_connection_connect_action";
};

export type OrgMcpPollScope = {
  generation: number;
  organizationId: string;
};

export function isOrgMcpPollScopeCurrent(
  scope: OrgMcpPollScope,
  currentGeneration: number,
  activeOrganizationId: string,
): boolean {
  return scope.generation === currentGeneration && scope.organizationId === activeOrganizationId;
}

/**
 * Pure projection from a raw Den connection to what the card should show.
 * A `shared`-credential connection is set up once by an admin — the member
 * never "connects" it themselves, so it's shown as managed, not actionable.
 * A `per_member` connection needs the CALLING member's own OAuth, tracked by
 * `connectedForMe` rather than the connection-wide `connected` flag.
 */
export function resolveOrgMcpConnectionCardState(
  connection: Pick<DenExternalMcpConnection, "credentialMode" | "connected" | "connectedForMe" | "needsReconnect" | "missingFeatures">,
): OrgMcpConnectionCardState {
  if (connection.credentialMode === "shared") {
    return {
      connected: connection.connected,
      descriptionKey: "mcp.org_connection_desc_shared",
      actionLabelKey: "mcp.org_connection_managed_label",
    };
  }

  if (connection.connectedForMe && connectionNeedsReconnect(connection)) {
    return {
      connected: false,
      descriptionKey: "mcp.org_connection_desc_per_member_reconnect",
      actionLabelKey: "mcp.org_connection_reconnect_action",
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
  // Settings remounts every time the extensions panel opens, so start from
  // whatever the app already fetched instead of an empty list.
  const prefetched = readCloudInventoryScope();
  const [connections, setConnectionsState] = useState<DenExternalMcpConnection[]>(
    () => (prefetched ? readCachedOrgMcpConnections(prefetched) ?? [] : []),
  );
  const connectionsRef = useRef(connections);
  const setConnections = useCallback((nextConnections: DenExternalMcpConnection[]) => {
    connectionsRef.current = nextConnections;
    setConnectionsState(nextConnections);
  }, []);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(connections.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const pollGenerationRef = useRef(0);
  const refreshRunRef = useRef(0);

  const stopPolling = useCallback(() => {
    pollGenerationRef.current += 1;
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const isActionScopeCurrent = useCallback((scope: OrgMcpPollScope) => {
    const activeOrganizationId = readDenSettings().activeOrgId?.trim() ?? "";
    return isOrgMcpPollScopeCurrent(
      scope,
      pollGenerationRef.current,
      activeOrganizationId,
    );
  }, []);

  const refresh = useCallback(async (expectedScope?: OrgMcpPollScope) => {
    const run = refreshRunRef.current + 1;
    refreshRunRef.current = run;
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!token || !orgId) {
      setConnections([]);
      setError(null);
      setLoading(false);
      setLoaded(true);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const client = createDenClient({ baseUrl: settings.baseUrl, token });
      const result = await loadOrgMcpConnections({
        client,
        scope: { baseUrl: settings.baseUrl, organizationId: orgId },
        maxAgeMs: 0,
      });
      if (
        refreshRunRef.current !== run
        || (expectedScope && !isActionScopeCurrent(expectedScope))
      ) return;
      setConnections(result);
    } catch (fetchError) {
      if (
        refreshRunRef.current !== run
        || (expectedScope && !isActionScopeCurrent(expectedScope))
      ) return;
      setError(fetchError instanceof Error ? fetchError.message : "Failed to load organization MCP connections.");
    } finally {
      if (
        refreshRunRef.current === run
        && (!expectedScope || isActionScopeCurrent(expectedScope))
      ) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, [isActionScopeCurrent, setConnections]);

  const connect = useCallback(async (connectionId: string, options?: { forceFreshAuthorization?: boolean }) => {
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!token || !orgId) {
      setError(orgMcpConnectFailureMessage("missing_context"));
      return;
    }

    const previous = connectionsRef.current.find((entry) => entry.id === connectionId);
    const previousConnectedAt = previous?.connectedAt ?? null;

    stopPolling();
    const pollScope: OrgMcpPollScope = {
      generation: pollGenerationRef.current,
      organizationId: orgId,
    };
    setDisconnectingId(null);
    setConnectingId(connectionId);
    setError(null);
    try {
      const client = createDenClient({ baseUrl: settings.baseUrl, token });
      if (options?.forceFreshAuthorization === true && previous?.connectedForMe) {
        await disconnectMemberAccount(client, orgId, previous);
        if (!isActionScopeCurrent(pollScope)) return;
      }
      const result = await client.startMcpConnectionConnect(orgId, connectionId);
      if (!isActionScopeCurrent(pollScope)) return;
      if (result.status === "connected") {
        await refresh(pollScope);
        if (!isActionScopeCurrent(pollScope)) return;
        setConnectingId(null);
        return;
      }
      if (!result.authorizeUrl) {
        setError(orgMcpConnectFailureMessage("missing_authorization_url"));
        setConnectingId(null);
        return;
      }

      await openAuthorizationUrl(result.authorizeUrl);

      if (!isActionScopeCurrent(pollScope)) return;
      const startedAt = Date.now();
      pollRef.current = window.setInterval(async () => {
        if (!isActionScopeCurrent(pollScope)) return;
        if (Date.now() - startedAt >= CONNECT_TIMEOUT_MS) {
          stopPolling();
          setError(orgMcpConnectFailureMessage("timeout"));
          setConnectingId(null);
          return;
        }
        const refreshedSettings = readDenSettings();
        const refreshedToken = refreshedSettings.authToken?.trim() ?? "";
        const refreshedOrgId = refreshedSettings.activeOrgId?.trim() ?? "";
        if (!refreshedToken || !isOrgMcpPollScopeCurrent(
          pollScope,
          pollGenerationRef.current,
          refreshedOrgId,
        )) {
          stopPolling();
          setConnectingId(null);
          return;
        }
        try {
          const pollClient = createDenClient({
            baseUrl: refreshedSettings.baseUrl,
            token: refreshedToken,
          });
          const polled = await pollClient.listMcpConnections(pollScope.organizationId, "usable");
          if (!isActionScopeCurrent(pollScope)) return;
          setConnections(polled);
          const match = polled.find((entry) => entry.id === connectionId);
          const fresh = Boolean(match && match.connectedForMe && !connectionNeedsReconnect(match)
            && typeof match.connectedAt === "string" && match.connectedAt.length > 0
            && match.connectedAt !== previousConnectedAt);
          if (fresh) {
            stopPolling();
            setConnectingId(null);
          }
        } catch {
          // Transient — keep polling until the timeout above gives up.
        }
      }, CONNECT_POLL_INTERVAL_MS);
    } catch (connectError) {
      if (!isActionScopeCurrent(pollScope)) return;
      setError(connectError instanceof Error ? connectError.message : "Failed to start the connection.");
      setConnectingId(null);
    }
  }, [isActionScopeCurrent, refresh, setConnections, stopPolling]);

  const disconnect = useCallback(async (connectionId: string) => {
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!token || !orgId) return;

    stopPolling();
    const actionScope: OrgMcpPollScope = {
      generation: pollGenerationRef.current,
      organizationId: orgId,
    };
    setConnectingId(null);
    setDisconnectingId(connectionId);
    setError(null);
    try {
      const client = createDenClient({ baseUrl: settings.baseUrl, token });
      const connection = connectionsRef.current.find((entry) => entry.id === connectionId);
      await disconnectMemberAccount(client, orgId, connection ?? { id: connectionId });
      if (!isActionScopeCurrent(actionScope)) return;
      await refresh(actionScope);
      if (!isActionScopeCurrent(actionScope)) return;
    } catch (disconnectError) {
      if (!isActionScopeCurrent(actionScope)) return;
      setError(disconnectError instanceof Error ? disconnectError.message : "Failed to disconnect the account.");
    } finally {
      if (isActionScopeCurrent(actionScope)) setDisconnectingId(null);
    }
  }, [isActionScopeCurrent, refresh, stopPolling]);

  useEffect(() => {
    void refresh();
    const handleSettingsChanged = () => {
      stopPolling();
      setConnections([]);
      setError(null);
      setLoaded(false);
      setConnectingId(null);
      setDisconnectingId(null);
      void refresh();
    };
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);
    return () => {
      refreshRunRef.current += 1;
      stopPolling();
      window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
    };
  }, [refresh, setConnections, stopPolling]);

  return { connections, loading, loaded, error, connectingId, disconnectingId, refresh, connect, disconnect };
}
