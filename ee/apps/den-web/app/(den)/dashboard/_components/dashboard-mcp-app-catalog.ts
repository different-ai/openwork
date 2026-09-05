export function connectionCanListMcpApps(connection: {
  connectedForMe: boolean;
  credentialHealth?: "unknown" | "ready" | "reconnect_required";
  needsReconnect?: boolean;
  setupRequired?: boolean;
}): boolean {
  return connection.connectedForMe
    && connection.needsReconnect !== true
    && connection.credentialHealth !== "reconnect_required"
    && connection.setupRequired !== true;
}

export function mcpAppCatalogIsLoading(appCount: number, hasPendingConnection: boolean): boolean {
  return appCount === 0 && hasPendingConnection;
}

/** One MCP App launch tool on one connection, regardless of how it is launched. */
export function dashboardCapabilityKey(element: { serverName: string; toolName: string }): string {
  return `${element.serverName}:${element.toolName}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * One dashboard tile: the capability plus its launch input. The same tool with
 * different launch arguments (two JQL queries) is two tiles; the same tool with
 * the same arguments is one. Matches how Desktop identifies granted tiles.
 */
export function dashboardElementKey(element: {
  serverName: string;
  toolName: string;
  launchArguments?: Record<string, unknown>;
}): string {
  const launchArguments = element.launchArguments && Object.keys(element.launchArguments).length > 0
    ? element.launchArguments
    : null;
  return `${dashboardCapabilityKey(element)}:${canonicalJson(launchArguments)}`;
}
