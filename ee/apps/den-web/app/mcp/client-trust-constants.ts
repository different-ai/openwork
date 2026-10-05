/**
 * Reviewed CIMD identity hosts, not callback hosts or client-supplied names.
 * Exact host matches only, and only for documents under
 * KNOWN_MCP_CIMD_PATH_PREFIX, so other pages on these large product domains
 * cannot be presented as a recognized client identity.
 * Do not add shared/user-content hosting domains or wildcard subdomains.
 * This controls consent copy only, not authorization or software attestation.
 * Only clients that present a CIMD URL can match; dynamically registered
 * clients keep the generic warning because their names are self-asserted.
 *
 * - claude.ai: Claude web, desktop, mobile, and Cowork
 *   (/oauth/mcp-oauth-client-metadata) and Claude Code
 *   (/oauth/claude-code-client-metadata).
 * - chatgpt.com: ChatGPT (/oauth/client.json or /oauth/<callback_id>/client.json)
 *   and Codex (/oauth/codex/<callback_id>/client.json).
 * - vscode.dev: VS Code (/oauth/client-metadata.json).
 */
export const KNOWN_MCP_CIMD_DOMAINS: readonly string[] = ["claude.ai", "chatgpt.com", "vscode.dev"];

/** Every reviewed vendor publishes its CIMD documents under this path. */
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

/**
 * OpenWork's own apps that sign in with Den (registered by Den itself, with fixed return addresses, never by
 * dynamic registration). Their sign-in is a plain workspace choice: no unverified-app warning or permission list,
 * since they are part of OpenWork. Matches Den's WORKBOT_OAUTH_CLIENT_ID.
 */
export const FIRST_PARTY_APP_CLIENT_IDS: ReadonlySet<string> = new Set(["openwork-workbot"]);
