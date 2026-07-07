/**
 * Thin localStorage wrapper for the React shell's "remember what the user had
 * open" behavior. Keys mirror those the Solid app used so users don't lose
 * their spot when switching between shells during the port.
 */

const ACTIVE_WORKSPACE_KEY = "openwork.react.activeWorkspace";
const SESSION_BY_WORKSPACE_KEY = "openwork.react.sessionByWorkspace";
const WORKSPACE_ORDER_KEY = "openwork.react.workspaceOrder";
const WORKSPACE_PROJECT_DIMENSION_KEY = "openwork.react.workspaceProjectDimension";

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

export function readWorkspaceOrderIds(): string[] {
  const raw = safeGet(WORKSPACE_ORDER_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      const trimmed = typeof value === "string" ? value.trim() : "";
      return trimmed ? [trimmed] : [];
    });
  } catch {
    return [];
  }
}

export function writeWorkspaceOrderIds(ids: string[]): void {
  const normalized = ids.flatMap((id) => {
    const trimmed = id.trim();
    return trimmed ? [trimmed] : [];
  });
  safeSet(WORKSPACE_ORDER_KEY, normalized.length ? JSON.stringify(normalized) : null);
}

type SessionByWorkspace = Record<string, string>;
export type WorkspaceProjectDimension = {
  label: string;
};

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

function readWorkspaceProjectDimensionMap(): Record<string, WorkspaceProjectDimension> {
  const raw = safeGet(WORKSPACE_PROJECT_DIMENSION_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, WorkspaceProjectDimension> = {};
    for (const [workspaceId, value] of Object.entries(parsed)) {
      if (!workspaceId.trim() || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label.trim() : "";
      if (!label) continue;
      result[workspaceId] = {
        label,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function readWorkspaceProjectDimension(workspaceId: string | null | undefined): WorkspaceProjectDimension | null {
  const wsId = workspaceId?.trim();
  if (!wsId) return null;
  return readWorkspaceProjectDimensionMap()[wsId] ?? null;
}

export function writeWorkspaceProjectDimension(
  workspaceId: string | null | undefined,
  dimension: WorkspaceProjectDimension | null,
): void {
  const wsId = workspaceId?.trim();
  if (!wsId) return;
  const map = readWorkspaceProjectDimensionMap();
  const label = dimension?.label.trim() ?? "";
  if (!label) {
    delete map[wsId];
  } else {
    map[wsId] = {
      label,
    };
  }
  safeSet(WORKSPACE_PROJECT_DIMENSION_KEY, Object.keys(map).length ? JSON.stringify(map) : null);
}

export function forgetWorkspaceMemory(workspaceId: string): void {
  const wsId = workspaceId?.trim();
  if (!wsId) return;
  const map = readSessionByWorkspaceMap();
  if (wsId in map) {
    delete map[wsId];
    safeSet(SESSION_BY_WORKSPACE_KEY, Object.keys(map).length ? JSON.stringify(map) : null);
  }
  const dimensionMap = readWorkspaceProjectDimensionMap();
  if (wsId in dimensionMap) {
    delete dimensionMap[wsId];
    safeSet(WORKSPACE_PROJECT_DIMENSION_KEY, Object.keys(dimensionMap).length ? JSON.stringify(dimensionMap) : null);
  }
  const active = readActiveWorkspaceId();
  if (active === wsId) writeActiveWorkspaceId(null);
  const workspaceOrderIds = readWorkspaceOrderIds();
  if (workspaceOrderIds.includes(wsId)) {
    writeWorkspaceOrderIds(workspaceOrderIds.filter((id) => id !== wsId));
  }
}
