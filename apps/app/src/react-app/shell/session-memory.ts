/**
 * Thin localStorage wrapper for the React shell's "remember what the user had
 * open" behavior. Keys mirror those the Solid app used so users don't lose
 * their spot when switching between shells during the port.
 */

const ACTIVE_WORKSPACE_KEY = "openwork.react.activeWorkspace";
const SESSION_BY_WORKSPACE_KEY = "openwork.react.sessionByWorkspace";

function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null || value === "") {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage errors (quota, privacy modes, etc.)
  }
}

export function readActiveWorkspaceId(): string | null {
  const value = safeGet(ACTIVE_WORKSPACE_KEY);
  return value?.trim() || null;
}

export function writeActiveWorkspaceId(id: string | null): void {
  safeSet(ACTIVE_WORKSPACE_KEY, id?.trim() || null);
}

type SessionByWorkspace = Record<string, string>;

function readSessionByWorkspaceMap(): SessionByWorkspace {
  const raw = safeGet(SESSION_BY_WORKSPACE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result: SessionByWorkspace = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof key === "string" && typeof value === "string") {
          result[key] = value;
        }
      }
      return result;
    }
  } catch {
    // ignore malformed payload
  }
  return {};
}

export function readLastSessionFor(workspaceId: string): string | null {
  const id = workspaceId?.trim();
  if (!id) return null;
  return readSessionByWorkspaceMap()[id] ?? null;
}

export function writeLastSessionFor(workspaceId: string, sessionId: string | null): void {
  const wsId = workspaceId?.trim();
  if (!wsId) return;
  const map = readSessionByWorkspaceMap();
  const normalized = sessionId?.trim() || "";
  if (!normalized) {
    if (!(wsId in map)) return;
    delete map[wsId];
  } else {
    if (map[wsId] === normalized) return;
    map[wsId] = normalized;
  }
  safeSet(SESSION_BY_WORKSPACE_KEY, Object.keys(map).length ? JSON.stringify(map) : null);
}

export function forgetWorkspaceMemory(workspaceId: string): void {
  const wsId = workspaceId?.trim();
  if (!wsId) return;
  const map = readSessionByWorkspaceMap();
  if (wsId in map) {
    delete map[wsId];
    safeSet(SESSION_BY_WORKSPACE_KEY, Object.keys(map).length ? JSON.stringify(map) : null);
  }
  const active = readActiveWorkspaceId();
  if (active === wsId) writeActiveWorkspaceId(null);
}
