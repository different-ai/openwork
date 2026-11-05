"use client";

import type { ConnectorsFacts } from "../_features/feature-intros/intros/connectors";
import { displayedConnectorConnections } from "./connector-detail";
import { type ExternalMcpConnection, useMcpConnections } from "./mcp-connections-data";

/** Who added the organization's connectors, when that was one other person and none was the viewer. */
export function connectorsSetUpBy(connections: readonly ExternalMcpConnection[]): string | null {
  if (connections.some((connection) => connection.createdByYou)) return null;
  const names = new Set(connections.flatMap((connection) => {
    const name = connection.createdByName?.trim();
    return name ? [name] : [];
  }));
  return names.size === 1 ? [...names][0] : null;
}

/** Whether anyone besides the viewer can use a connector. Google Workspace and Microsoft 365 (no access list) are everyone's. */
export function connectorSharedBeyondViewer(connection: Pick<ExternalMcpConnection, "access">, viewerId: string | null): boolean {
  const access = connection.access;
  if (!access) return true;
  return access.orgWide || access.teamIds.length > 0 || access.memberIds.some((id) => id !== viewerId);
}

/**
 * Section facts for the Connectors intro (DESIGN.md I2), from the same
 * connector lists the Connectors pages load. The queries run only while
 * `enabled` (the `featureIntros` flag), so pages that don't already load them
 * make no extra requests with the flag off. Null until both lists are known.
 */
export function useConnectorsIntroFacts(enabled: boolean): ConnectorsFacts | null {
  const manageable = useMcpConnections("manageable", { enabled });
  const usable = useMcpConnections("usable", { enabled });
  if (!enabled || !manageable.data || !usable.data) return null;
  const all = displayedConnectorConnections(manageable.data, usable.data);
  return { connectors: all.length, setUpBy: connectorsSetUpBy(all) };
}
