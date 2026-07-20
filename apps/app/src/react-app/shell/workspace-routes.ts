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

export function globalSettingsRoute(tab: SettingsTab) {
  return `/settings/${tab}`;
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
