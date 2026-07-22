import type { ExternalMcpConnection, ExternalMcpRequiredBy } from "./mcp-connections-data";

export function formatRequiredBy(requiredBy: ExternalMcpRequiredBy[]): string | null {
  const names = [...new Set(requiredBy.map((entry) => entry.name.trim()).filter(Boolean))];
  if (names.length === 0) return null;
  if (names.length === 1) return `Required by ${names[0]}`;
  if (names.length === 2) return `Required by ${names[0]} and ${names[1]}`;
  return `Required by ${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function formatConnectionCreatorAttribution(createdByName: string | null | undefined): string | null {
  const name = createdByName?.trim();
  return name ? `Added by ${name}` : null;
}

export function trustedConnectionFocusId(connections: ExternalMcpConnection[], requestedConnectionId: string | null): string | null {
  if (!requestedConnectionId) return null;
  return connections.some((connection) => connection.id === requestedConnectionId) ? requestedConnectionId : null;
}

export function sortConnectionsForFocus(connections: ExternalMcpConnection[], focusConnectionId: string | null): ExternalMcpConnection[] {
  if (!focusConnectionId) return connections;
  return [...connections].sort((left, right) => {
    if (left.id === focusConnectionId) return -1;
    if (right.id === focusConnectionId) return 1;
    return 0;
  });
}
