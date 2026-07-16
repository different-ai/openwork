import type { ExternalMcpConnection, ExternalMcpPreset } from "./mcp-connections-data";

function normalizeMcpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function marketplaceConnectionNeedsAdminSetup(
  connection: ExternalMcpConnection,
  presets: ExternalMcpPreset[],
): boolean {
  if (connection.identityManagedBy.length === 0) return false;
  const normalizedUrl = normalizeMcpUrl(connection.url);
  const preset = normalizedUrl
    ? presets.find((candidate) => normalizeMcpUrl(candidate.url) === normalizedUrl)
    : null;
  if (preset && preset.authType !== connection.authType) return true;
  if (connection.authType === "oauth" && preset?.requiresOAuthClient === true && !connection.oauthClientId) return true;
  return !connection.connected && (connection.authType === "apikey" || connection.authType === "none");
}
