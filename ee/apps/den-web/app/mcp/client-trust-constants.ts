export const KNOWN_MCP_CIMD_DOMAINS: readonly string[] = ["claude.ai", "chatgpt.com", "vscode.dev"];

export const KNOWN_MCP_CIMD_PATH_PREFIX = "/oauth/";

function parseCimdClientId(clientId: string | null): URL | null {
  if (!clientId) return null;
  try {
    const url = new URL(clientId);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.pathname === "/") return null;
    return url;
  } catch {
    return null;
  }
}

export function mcpCimdDomain(clientId: string | null): string | null {
  return parseCimdClientId(clientId)?.host ?? null;
}

export function knownMcpCimdDomain(clientId: string | null): string | null {
  const url = parseCimdClientId(clientId);
  if (!url || !KNOWN_MCP_CIMD_DOMAINS.includes(url.host) || !url.pathname.startsWith(KNOWN_MCP_CIMD_PATH_PREFIX)) return null;
  return url.host;
}

export const FIRST_PARTY_APP_CLIENT_IDS: ReadonlySet<string> = new Set(["openwork-workbot"]);
