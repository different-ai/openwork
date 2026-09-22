import { SETTINGS_TAB_VALUES, type SettingsTab } from "../../app/types";

/**
 * Search params that ask the session route to get the member a workspace on
 * arrival. Used by surfaces that need one but live outside the session route,
 * such as Settings › AI providers with no workspace yet. On desktop the route
 * creates the default chat workspace, exactly as a first message does; off
 * desktop it opens the create-workspace dialog. `returnTo` names the settings
 * tab to reopen inside the new workspace once it exists.
 */
export const CREATE_WORKSPACE_SEARCH_PARAM = "createWorkspace";
export const CREATE_WORKSPACE_RETURN_PARAM = "createWorkspaceReturn";

/** Folder under the user's home that holds the default chat workspace. */
export const DEFAULT_CHAT_WORKSPACE_FOLDER = "OpenWork Chat";

export function createWorkspaceRoute(returnTo?: SettingsTab) {
  const params = new URLSearchParams({ [CREATE_WORKSPACE_SEARCH_PARAM]: "1" });
  if (returnTo) params.set(CREATE_WORKSPACE_RETURN_PARAM, returnTo);
  return `/session?${params.toString()}`;
}

export type CreateWorkspaceRequest = { returnTo: SettingsTab | null };

function isSettingsTab(value: string | null): value is SettingsTab {
  return value !== null && (SETTINGS_TAB_VALUES as readonly string[]).includes(value);
}

/** The create-workspace request carried by a session route URL, if any. */
export function readCreateWorkspaceRequest(search: string): CreateWorkspaceRequest | null {
  const params = new URLSearchParams(search);
  if (!params.has(CREATE_WORKSPACE_SEARCH_PARAM)) return null;
  const returnTo = params.get(CREATE_WORKSPACE_RETURN_PARAM);
  return { returnTo: isSettingsTab(returnTo) ? returnTo : null };
}

/** The same URL with the create-workspace request removed. */
export function withoutCreateWorkspaceRequest(pathname: string, search: string) {
  const params = new URLSearchParams(search);
  params.delete(CREATE_WORKSPACE_SEARCH_PARAM);
  params.delete(CREATE_WORKSPACE_RETURN_PARAM);
  const next = params.toString();
  return `${pathname}${next ? `?${next}` : ""}`;
}

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
