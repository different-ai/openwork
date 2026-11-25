import { getMcpOAuthSocialCallbackUrl } from "./mcp-oauth-route";

export const IN_PLACE_AUTH_PATHS: readonly string[] = ["/connect/mcp", "/device", "/claim", "/join-sandbox"];

function normalizePathname(pathname: string) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export function signsInInPlace(pathname: string) {
  return IN_PLACE_AUTH_PATHS.includes(normalizePathname(pathname));
}

export function getAuthResumeUrl(location: { pathname: string; search: string }, origin: string): string | null {
  const mcpOAuthCallbackUrl = getMcpOAuthSocialCallbackUrl(location.search, origin);
  if (mcpOAuthCallbackUrl) return mcpOAuthCallbackUrl;
  if (!signsInInPlace(location.pathname)) return null;
  const resumeUrl = new URL(normalizePathname(location.pathname), origin);
  resumeUrl.search = location.search.startsWith("?") ? location.search.slice(1) : location.search;
  return resumeUrl.toString();
}
