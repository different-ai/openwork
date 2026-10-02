import { getMcpOAuthSocialCallbackUrl } from "./mcp-oauth-route";

/**
 * Pages that let a person sign in right where they are (P11). Their own URL
 * carries what they were doing (a connection link, a device code, a claim
 * code), so after email or social sign-in they land back on the same page and
 * step instead of the dashboard.
 */
export const IN_PLACE_AUTH_PATHS: readonly string[] = ["/connect/mcp", "/device", "/claim"];

function normalizePathname(pathname: string) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export function signsInInPlace(pathname: string) {
  return IN_PLACE_AUTH_PATHS.includes(normalizePathname(pathname));
}

/**
 * Where social sign-in should come back to, or null for the default landing.
 * An agent's MCP authorization keeps its exact signed query; in-place pages
 * come back to themselves with their query intact.
 */
export function getAuthResumeUrl(location: { pathname: string; search: string }, origin: string): string | null {
  const mcpOAuthCallbackUrl = getMcpOAuthSocialCallbackUrl(location.search, origin);
  if (mcpOAuthCallbackUrl) return mcpOAuthCallbackUrl;
  if (!signsInInPlace(location.pathname)) return null;
  const resumeUrl = new URL(normalizePathname(location.pathname), origin);
  resumeUrl.search = location.search.startsWith("?") ? location.search.slice(1) : location.search;
  return resumeUrl.toString();
}
