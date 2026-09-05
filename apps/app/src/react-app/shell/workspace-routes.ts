import type { SettingsTab } from "../../app/types";

export function workspaceSessionRoute(workspaceId: string, sessionId?: string | null) {
  const workspace = encodeURIComponent(workspaceId.trim());
  const session = sessionId?.trim();
  return session
    ? `/workspace/${workspace}/session/${encodeURIComponent(session)}`
    : `/workspace/${workspace}/session`;
}

export function workspaceSettingsRoute(
  workspaceId: string,
  tab: SettingsTab | "extensions/mcp" | "extensions/plugins" | string = "general",
) {
  return `/workspace/${encodeURIComponent(workspaceId.trim())}/settings/${tab}`;
}

/**
 * Where closing Settings lands. The originating session is restored only when
 * Settings is still on the workspace it was opened from.
 */
export function settingsReturnRoute(
  selectedWorkspaceId: string,
  navigationWorkspaceId: string | null,
  navigationSessionId: string | null,
) {
  if (!selectedWorkspaceId) return "/session";
  const returnSessionId = navigationWorkspaceId === selectedWorkspaceId
    ? navigationSessionId
    : null;
  return workspaceSessionRoute(selectedWorkspaceId, returnSessionId);
}

/**
 * Settings entry from anywhere that only knows the current URL (native menu,
 * agent control actions). Keeps the workspace in the route and remembers the
 * open session in navigation state so closing Settings returns to exactly
 * where the user was, matching the in-app settings button.
 */
export function settingsNavigationFromPathname(pathname: string, tab: SettingsTab | string) {
  const match = /^\/workspace\/([^/]+)(?:\/session\/([^/]+))?/.exec(pathname);
  const workspaceId = match?.[1] ? decodeURIComponent(match[1]) : "";
  const sessionId = match?.[2] ? decodeURIComponent(match[2]) : null;
  return {
    to: workspaceId ? workspaceSettingsRoute(workspaceId, tab) : `/settings/${tab}`,
    state: { workspaceId, sessionId },
  };
}

export function automationsRoute() {
  return "/automations";
}

export function dashboardRoute() {
  return "/dashboard";
}

export function globalSettingsRoute(tab: SettingsTab) {
  return `/settings/${tab}`;
}

function extensionsRouteSuffix(path?: string | null) {
  const suffix = path?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  return suffix ? `/${suffix}` : "";
}

export function workspaceExtensionsRoute(workspaceId: string, path?: string | null) {
  return `/workspace/${encodeURIComponent(workspaceId.trim())}/extensions${extensionsRouteSuffix(path)}`;
}

export function globalExtensionsRoute(path?: string | null) {
  return `/extensions${extensionsRouteSuffix(path)}`;
}

export function sessionIdForLegacyWorkspaceInference(
  routeWorkspaceId?: string | null,
  routeSessionId?: string | null,
): string | null {
  if (routeWorkspaceId?.trim()) return null;
  const sessionId = routeSessionId?.trim();
  return sessionId || null;
}

export function mergeWorkspaceRouteSession<T extends { id: string }>(sessions: T[], session: T): T[] {
  const index = sessions.findIndex((item) => item.id === session.id);
  if (index < 0) return [session, ...sessions];
  if (sessions[index] === session) return sessions;
  const next = [...sessions];
  next[index] = session;
  return next;
}

export function preserveWorkspaceRouteSession<T extends { id: string }>(
  fetched: T[],
  current: T[],
  sessionId?: string | null,
): T[] {
  const id = sessionId?.trim();
  if (!id || fetched.some((session) => session.id === id)) return fetched;
  const session = current.find((item) => item.id === id);
  return session ? mergeWorkspaceRouteSession(fetched, session) : fetched;
}

export function removeWorkspaceRouteSession<T extends { id: string }>(sessions: T[], sessionId: string): T[] {
  const next = sessions.filter((session) => session.id !== sessionId);
  return next.length === sessions.length ? sessions : next;
}

export function legacySessionRoute(sessionId?: string | null) {
  const session = sessionId?.trim();
  return session ? `/session/${encodeURIComponent(session)}` : "/session";
}
