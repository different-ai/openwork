import { CLOUD_MCP_SYNC_MARKER_STORAGE_KEY } from "../../../app/lib/den";

/** Durable, scoped records for the auto-managed OpenWork Cloud MCP. */

export const CLOUD_MCP_SERVER_NAME = "openwork-cloud";

const CLOUD_MCP_USER_STATE_KEY = "openwork.den.mcp.cloudControlUserState";
const CLOUD_MCP_UNHEALTHY_REMINT_ATTEMPT_KEY = "openwork.den.mcp.unhealthyRemintAttempt";

export type CloudMcpUserState = "disabled" | "removed";
export type CloudMcpScope = {
  denBaseUrl: string;
  serverBaseUrl: string;
  orgId: string;
  workspaceId: string;
};
export type CloudMcpUserStateEntry = CloudMcpScope & {
  state: CloudMcpUserState;
  updatedAt: number;
};
export type CloudMcpUnhealthyRemintAttempt = CloudMcpScope & {
  attemptedAt: number;
};
export type CloudMcpSyncMarker = CloudMcpScope & {
  expiresAt: string;
};
export type CloudMcpSyncMarkerScope = CloudMcpScope;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let storageOverrideForTest: StorageLike | null = null;

/**
 * Bun on Linux exposes a readonly `globalThis.window`, so tests cannot stub
 * the global. Inject a storage instead (pass null to restore the default).
 */
export function __setCloudMcpUserStateStorageForTest(storage: StorageLike | null) {
  storageOverrideForTest = storage;
}

function getStorage(): StorageLike | null {
  if (storageOverrideForTest) return storageOverrideForTest;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function normalizeMarkerBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function normalizeCloudMcpScope(scope: CloudMcpScope): CloudMcpScope | null {
  const denBaseUrl = normalizeMarkerBaseUrl(scope.denBaseUrl);
  const serverBaseUrl = normalizeMarkerBaseUrl(scope.serverBaseUrl);
  const orgId = scope.orgId.trim();
  const workspaceId = scope.workspaceId.trim();
  if (!denBaseUrl || !serverBaseUrl || !orgId || !workspaceId) return null;
  return { denBaseUrl, serverBaseUrl, orgId, workspaceId };
}

export function cloudMcpScopeEquals(left: CloudMcpScope, right: CloudMcpScope): boolean {
  const normalizedLeft = normalizeCloudMcpScope(left);
  const normalizedRight = normalizeCloudMcpScope(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft.denBaseUrl === normalizedRight.denBaseUrl &&
    normalizedLeft.serverBaseUrl === normalizedRight.serverBaseUrl &&
    normalizedLeft.orgId === normalizedRight.orgId &&
    normalizedLeft.workspaceId === normalizedRight.workspaceId;
}

export function getCloudMcpScopeKey(scope: CloudMcpScope): string | null {
  const normalized = normalizeCloudMcpScope(scope);
  if (!normalized) return null;
  return JSON.stringify([
    normalized.denBaseUrl,
    normalized.serverBaseUrl,
    normalized.workspaceId,
    normalized.orgId,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUserStateEntry(value: unknown): CloudMcpUserStateEntry | null {
  if (!isRecord(value)) return null;
  if (value.state !== "disabled" && value.state !== "removed") return null;
  const denBaseUrl = typeof value.denBaseUrl === "string" ? value.denBaseUrl : "";
  const serverBaseUrl = typeof value.serverBaseUrl === "string" ? value.serverBaseUrl : "";
  const orgId = typeof value.orgId === "string" ? value.orgId : "";
  const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId : "";
  const scope = normalizeCloudMcpScope({ denBaseUrl, serverBaseUrl, orgId, workspaceId });
  if (!scope) return null;
  return {
    ...scope,
    state: value.state,
    updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  };
}

function readCloudMcpUserStateEntries(): { entries: CloudMcpUserStateEntry[]; legacyState: CloudMcpUserState | null } {
  try {
    const raw = getStorage()?.getItem(CLOUD_MCP_USER_STATE_KEY);
    if (raw === "disabled" || raw === "removed") return { entries: [], legacyState: raw };
    if (!raw) return { entries: [], legacyState: null };
    const parsed: unknown = JSON.parse(raw);
    const candidates = isRecord(parsed) && Array.isArray(parsed.entries) ? parsed.entries : [];
    return {
      entries: candidates.flatMap((entry) => {
        const parsedEntry = parseUserStateEntry(entry);
        return parsedEntry ? [parsedEntry] : [];
      }),
      legacyState: null,
    };
  } catch {
    // Storage unavailable or corrupt — treat as no recorded intent.
  }
  return { entries: [], legacyState: null };
}

function writeCloudMcpUserStateEntries(entries: CloudMcpUserStateEntry[]) {
  getStorage()?.setItem(
    CLOUD_MCP_USER_STATE_KEY,
    JSON.stringify({ version: 1, entries }),
  );
}

export function readCloudMcpUserState(scope: CloudMcpScope): CloudMcpUserState | null {
  const normalized = normalizeCloudMcpScope(scope);
  if (!normalized) return null;
  const { entries, legacyState } = readCloudMcpUserStateEntries();
  const entry = entries.find((candidate) => cloudMcpScopeEquals(candidate, normalized));
  if (entry) return entry.state;

  if (legacyState) {
    // One-time compatibility: old builds stored a single global intent. Move it
    // to the currently active scope so it does not suppress other workspaces.
    writeCloudMcpUserState(legacyState, normalized);
    return legacyState;
  }

  return null;
}

export function writeCloudMcpUserState(state: CloudMcpUserState, scope: CloudMcpScope) {
  try {
    const normalized = normalizeCloudMcpScope(scope);
    if (!normalized) return;
    const entries = readCloudMcpUserStateEntries().entries.filter(
      (entry) => !cloudMcpScopeEquals(entry, normalized),
    );
    writeCloudMcpUserStateEntries([...entries, { ...normalized, state, updatedAt: Date.now() }]);
  } catch {
    // Storage unavailable — the enabled-flag guard in reconciliation still applies.
  }
}

export function clearCloudMcpUserState(scope: CloudMcpScope) {
  try {
    const normalized = normalizeCloudMcpScope(scope);
    if (!normalized) return;
    const entries = readCloudMcpUserStateEntries().entries.filter(
      (entry) => !cloudMcpScopeEquals(entry, normalized),
    );
    if (entries.length) writeCloudMcpUserStateEntries(entries);
    else getStorage()?.removeItem(CLOUD_MCP_USER_STATE_KEY);
  } catch {
    // ignore
  }
}

function parseUnhealthyAttempt(value: unknown): CloudMcpUnhealthyRemintAttempt | null {
  if (!isRecord(value)) return null;
  const denBaseUrl = typeof value.denBaseUrl === "string" ? value.denBaseUrl : "";
  const serverBaseUrl = typeof value.serverBaseUrl === "string" ? value.serverBaseUrl : "";
  const orgId = typeof value.orgId === "string" ? value.orgId : "";
  const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId : "";
  const scope = normalizeCloudMcpScope({ denBaseUrl, serverBaseUrl, orgId, workspaceId });
  if (!scope) return null;
  return {
    ...scope,
    attemptedAt: typeof value.attemptedAt === "number" && Number.isFinite(value.attemptedAt) ? value.attemptedAt : 0,
  };
}

function readCloudMcpUnhealthyRemintAttempts(): { entries: CloudMcpUnhealthyRemintAttempt[]; legacyOrgId: string | null } {
  try {
    const raw = getStorage()?.getItem(CLOUD_MCP_UNHEALTHY_REMINT_ATTEMPT_KEY);
    if (!raw) return { entries: [], legacyOrgId: null };
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.orgId === "string" && !("entries" in parsed)) {
      return { entries: [], legacyOrgId: parsed.orgId.trim() || null };
    }
    const candidates = isRecord(parsed) && Array.isArray(parsed.entries) ? parsed.entries : [];
    return {
      entries: candidates.flatMap((entry) => {
        const parsedEntry = parseUnhealthyAttempt(entry);
        return parsedEntry ? [parsedEntry] : [];
      }),
      legacyOrgId: null,
    };
  } catch {
    // Corrupt marker or storage unavailable — treat as no recorded attempt.
  }
  return { entries: [], legacyOrgId: null };
}

function writeCloudMcpUnhealthyRemintAttempts(entries: CloudMcpUnhealthyRemintAttempt[]) {
  getStorage()?.setItem(
    CLOUD_MCP_UNHEALTHY_REMINT_ATTEMPT_KEY,
    JSON.stringify({ version: 1, entries }),
  );
}

/** One re-mint attempt per unhealthy Cloud MCP episode, scoped to this exact workspace/org/server/deployment. */
export function readCloudMcpUnhealthyRemintAttempt(scope: CloudMcpScope): CloudMcpUnhealthyRemintAttempt | null {
  const normalized = normalizeCloudMcpScope(scope);
  if (!normalized) return null;
  const { entries, legacyOrgId } = readCloudMcpUnhealthyRemintAttempts();
  const entry = entries.find((candidate) => cloudMcpScopeEquals(candidate, normalized)) ?? null;
  if (entry) return entry;
  if (legacyOrgId === normalized.orgId) {
    const migrated = { ...normalized, attemptedAt: Date.now() };
    writeCloudMcpUnhealthyRemintAttempt(migrated);
    return migrated;
  }
  return null;
}

export function writeCloudMcpUnhealthyRemintAttempt(marker: CloudMcpUnhealthyRemintAttempt) {
  try {
    const normalized = normalizeCloudMcpScope(marker);
    if (!normalized) return;
    const entries = readCloudMcpUnhealthyRemintAttempts().entries.filter(
      (entry) => !cloudMcpScopeEquals(entry, normalized),
    );
    writeCloudMcpUnhealthyRemintAttempts([...entries, { ...normalized, attemptedAt: marker.attemptedAt }]);
  } catch {
    // Storage unavailable — in-memory guards still suppress same-operation retries.
  }
}

export function clearCloudMcpUnhealthyRemintAttempt(scope: CloudMcpScope) {
  try {
    const normalized = normalizeCloudMcpScope(scope);
    if (!normalized) return;
    const entries = readCloudMcpUnhealthyRemintAttempts().entries.filter(
      (entry) => !cloudMcpScopeEquals(entry, normalized),
    );
    if (entries.length) writeCloudMcpUnhealthyRemintAttempts(entries);
    else getStorage()?.removeItem(CLOUD_MCP_UNHEALTHY_REMINT_ATTEMPT_KEY);
  } catch {
    // ignore
  }
}

function parseCloudMcpSyncMarker(value: unknown): CloudMcpSyncMarker | null {
  if (!isRecord(value)) return null;
  const denBaseUrl = typeof value.denBaseUrl === "string" ? value.denBaseUrl : "";
  const serverBaseUrl = typeof value.serverBaseUrl === "string" ? value.serverBaseUrl : "";
  const orgId = typeof value.orgId === "string" ? value.orgId : "";
  const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId : "";
  const expiresAt = typeof value.expiresAt === "string" ? value.expiresAt : "";
  const scope = normalizeCloudMcpScope({ denBaseUrl, serverBaseUrl, orgId, workspaceId });
  if (!scope || !expiresAt) return null;
  return { ...scope, expiresAt };
}

function readCloudMcpSyncMarkers(): CloudMcpSyncMarker[] {
  try {
    const raw = getStorage()?.getItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const candidates = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.markers)
        ? parsed.markers
        : [parsed];
    return candidates.flatMap((value) => {
      const marker = parseCloudMcpSyncMarker(value);
      return marker ? [marker] : [];
    });
  } catch {
    // Corrupt or legacy marker — force one safe re-sync.
  }
  return [];
}

export function readCloudMcpSyncMarker(scope: CloudMcpSyncMarkerScope): CloudMcpSyncMarker | null {
  const normalized = normalizeCloudMcpScope(scope);
  if (!normalized) return null;
  return readCloudMcpSyncMarkers().find((marker) => cloudMcpScopeEquals(marker, normalized)) ?? null;
}

export function writeCloudMcpSyncMarker(marker: CloudMcpSyncMarker) {
  try {
    const normalized = normalizeCloudMcpScope(marker);
    if (!normalized) return;
    const normalizedMarker = { ...normalized, expiresAt: marker.expiresAt };
    const markers = readCloudMcpSyncMarkers().filter(
      (entry) => !cloudMcpScopeEquals(entry, normalized),
    );
    getStorage()?.setItem(
      CLOUD_MCP_SYNC_MARKER_STORAGE_KEY,
      JSON.stringify({ version: 1, markers: [...markers, normalizedMarker] }),
    );
  } catch {
    // Storage unavailable — reconciliation will simply run again later.
  }
}

export function clearCloudMcpSyncMarker(scope: CloudMcpSyncMarkerScope) {
  try {
    const normalized = normalizeCloudMcpScope(scope);
    if (!normalized) return;
    const markers = readCloudMcpSyncMarkers().filter((entry) => !cloudMcpScopeEquals(entry, normalized));
    if (markers.length) {
      getStorage()?.setItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY, JSON.stringify({ version: 1, markers }));
    } else {
      getStorage()?.removeItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

export function clearCloudMcpScopedMetadata(scope: CloudMcpScope) {
  clearCloudMcpSyncMarker(scope);
  clearCloudMcpUnhealthyRemintAttempt(scope);
}

/**
 * Pure marker-freshness check for the cloud MCP sync marker. Extracted so
 * the margin arithmetic is unit-testable.
 */
export function isCloudMcpSyncMarkerFresh(input: {
  expiresAt: string;
  now: number;
  refreshMarginMs: number;
}): boolean {
  const expiresAt = new Date(input.expiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - input.now > input.refreshMarginMs;
}
