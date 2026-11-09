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

/**
 * Whether anyone besides the person who added a connector can use it, whoever is looking: an admin
 * opening a teammate's connector must not be told "no one else can use it" because it isn't shared
 * with them. Google Workspace and Microsoft 365 (no access list) are everyone's. Null when the
 * creator isn't known (older servers, someone else's connector): the banner then stays hidden.
 */
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
