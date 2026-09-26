export function getMcpOAuthSelectOrganizationRoute(search: string) {
  const normalizedSearch = search.startsWith("?") ? search.slice(1) : search;
  if (!normalizedSearch) return null;

  const params = new URLSearchParams(normalizedSearch);
  const scopes = new Set((params.get("scope") ?? "").split(/\s+/).filter(Boolean));
  if (params.get("response_type") !== "code" || !params.get("client_id") || (!scopes.has("mcp:read") && !scopes.has("mcp:write"))) {
    return null;
  }

  return `/mcp/select-organization?${normalizedSearch}`;
}

export const MCP_OAUTH_RESTART_MESSAGE =
  "This sign-in link expired. Start sign-in again from your agent.";

/**
 * better-auth signs the authorize query with an `exp` (seconds). Once it has
 * passed, consent fails with `invalid_signature`; say so before the person
 * fills anything in.
 */
export function isMcpOAuthQueryExpired(search: string, nowMs = Date.now()) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = params.get("exp");
  if (!raw || !/^\d+$/.test(raw)) return false;
  return Number(raw) * 1000 < nowMs;
}

function readStringField(payload: unknown, key: string) {
  if (typeof payload !== "object" || payload === null || !(key in payload)) return null;
  const value: unknown = Reflect.get(payload, key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function describeMcpOAuthError(payload: unknown, fallback: string) {
  const error = readStringField(payload, "error");
  const message = readStringField(payload, "message");
  if (error === "invalid_signature" || message === "invalid_signature") {
    return MCP_OAUTH_RESTART_MESSAGE;
  }
  return message ?? error ?? fallback;
}

/**
 * Social sign-in leaves den-web for the provider and comes back to
 * `callbackURL`. While an agent's MCP authorization is in progress, the
 * callback must carry the exact signed authorize query (any extra parameter
 * breaks the signature), so the landing page can resume at workspace
 * selection instead of the dashboard.
 */
export function getMcpOAuthSocialCallbackUrl(search: string, origin: string) {
  if (!getMcpOAuthSelectOrganizationRoute(search)) return null;
  const normalizedSearch = search.startsWith("?") ? search.slice(1) : search;
  const callbackUrl = new URL("/", origin);
  callbackUrl.search = normalizedSearch;
  return callbackUrl.toString();
}
