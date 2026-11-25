"use client";

import type { ConnectorsFacts } from "../_features/feature-intros/intros/connectors";
import { displayedConnectorConnections } from "./connector-detail";
import { type ExternalMcpConnection, useMcpConnections } from "./mcp-connections-data";

export function connectorsSetUpBy(connections: readonly ExternalMcpConnection[]): string | null {
  if (connections.some((connection) => connection.createdByYou)) return null;
  const names = new Set(connections.flatMap((connection) => {
    const name = connection.createdByName?.trim();
    return name ? [name] : [];
  }));
  return names.size === 1 ? [...names][0] : null;
}

export function connectorSharedBeyondCreator(
  connection: Pick<ExternalMcpConnection, "access" | "createdByYou" | "createdByOrgMembershipId">,
  viewerId: string | null,
): boolean | null {
  const access = connection.access;
  if (!access) return true;
  if (access.orgWide || access.teamIds.length > 0) return true;
  const creatorId = connection.createdByOrgMembershipId ?? (connection.createdByYou ? viewerId : null);
  if (!creatorId) return access.memberIds.length > 1 ? true : null;
  return access.memberIds.some((id) => id !== creatorId);
}

export function useConnectorsIntroFacts(enabled: boolean): ConnectorsFacts | null {
  const manageable = useMcpConnections("manageable", { enabled });
  const usable = useMcpConnections("usable", { enabled });
  if (!enabled || !manageable.data || !usable.data) return null;
  const all = displayedConnectorConnections(manageable.data, usable.data);
  return { connectors: all.length, setUpBy: connectorsSetUpBy(all) };
}
