import { CLOUD_MCP_SYNC_MARKER_STORAGE_KEY } from "../../../app/lib/den";

/**
 * Durable record of the user's intent for the auto-configured OpenWork
 * Cloud Control MCP ("openwork-cloud").
 *
 * A background reconciler (`syncCloudControlMcp`) keeps that entry
 * configured with a fresh first-party token while the user is signed in to
 * OpenWork Cloud. Its writes hardcode `enabled: true` and recreate removed
 * entries, so without a durable record of "the user turned this off" the
 * reconciler resurrected the MCP on every sync tick — making it impossible
 * to disable. These helpers persist that intent; the reconciler consults it
 * before touching the entry, and any explicit user reconnect clears it.
 */

export const CLOUD_MCP_SERVER_NAME = "openwork-cloud";

const CLOUD_MCP_USER_STATE_KEY = "openwork.den.mcp.cloudControlUserState";
const CLOUD_MCP_UNHEALTHY_REMINT_ATTEMPT_KEY = "openwork.den.mcp.unhealthyRemintAttempt";

export type CloudMcpUserState = "disabled" | "removed";
export type CloudMcpUnhealthyRemintAttempt = { orgId: string };
export type CloudMcpSyncMarker = {
  denBaseUrl: string;
  serverBaseUrl: string;
  orgId: string;
  workspaceId: string;
  expiresAt: string;
};
export type CloudMcpSyncMarkerScope = Pick<
  CloudMcpSyncMarker,
  "denBaseUrl" | "serverBaseUrl" | "orgId" | "workspaceId"
>;

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

export function readCloudMcpUserState(): CloudMcpUserState | null {
  try {
    const raw = getStorage()?.getItem(CLOUD_MCP_USER_STATE_KEY);
    if (raw === "disabled" || raw === "removed") return raw;
  } catch {
    // Storage unavailable — treat as no recorded intent.
  }
  return null;
}

export function writeCloudMcpUserState(state: CloudMcpUserState) {
  try {
    getStorage()?.setItem(CLOUD_MCP_USER_STATE_KEY, state);
  } catch {
    // Storage unavailable — the reconciler may resurrect the entry; the
    // enabled-flag guard in syncCloudControlMcp still applies.
  }
}

export function clearCloudMcpUserState() {
  try {
    getStorage()?.removeItem(CLOUD_MCP_USER_STATE_KEY);
  } catch {
    // ignore
  }
}

/**
 * One re-mint attempt per unhealthy Cloud Control MCP episode must survive
 * store remounts: the settings route recreates the connections store per
 * mount, which re-armed the re-mint and reloaded the engine on every settings
 * open. The episode ends when the entry reports connected, or when the user
 * forces a refresh.
 */
export function readCloudMcpUnhealthyRemintAttempt(): CloudMcpUnhealthyRemintAttempt | null {
  try {
    const raw = getStorage()?.getItem(CLOUD_MCP_UNHEALTHY_REMINT_ATTEMPT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "orgId" in parsed &&
      typeof parsed.orgId === "string"
    ) {
      return { orgId: parsed.orgId };
    }
  } catch {
    // Corrupt marker or storage unavailable — treat as no recorded attempt.
  }
  return null;
}

export function writeCloudMcpUnhealthyRemintAttempt(marker: CloudMcpUnhealthyRemintAttempt) {
  try {
    getStorage()?.setItem(CLOUD_MCP_UNHEALTHY_REMINT_ATTEMPT_KEY, JSON.stringify(marker));
  } catch {
    // Storage unavailable — the in-memory guard still suppresses same-store retries.
  }
}

export function clearCloudMcpUnhealthyRemintAttempt() {
  try {
    getStorage()?.removeItem(CLOUD_MCP_UNHEALTHY_REMINT_ATTEMPT_KEY);
  } catch {
    // ignore
  }
}

function normalizeMarkerBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function parseCloudMcpSyncMarker(value: unknown): CloudMcpSyncMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    !("denBaseUrl" in value) ||
    typeof value.denBaseUrl !== "string" ||
    !("serverBaseUrl" in value) ||
    typeof value.serverBaseUrl !== "string" ||
    !("orgId" in value) ||
    typeof value.orgId !== "string" ||
    !("workspaceId" in value) ||
    typeof value.workspaceId !== "string" ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "string"
  ) {
    return null;
  }
  const denBaseUrl = normalizeMarkerBaseUrl(value.denBaseUrl);
  const serverBaseUrl = normalizeMarkerBaseUrl(value.serverBaseUrl);
  if (!denBaseUrl || !serverBaseUrl) return null;
  return {
    denBaseUrl,
    serverBaseUrl,
    orgId: value.orgId,
    workspaceId: value.workspaceId,
    expiresAt: value.expiresAt,
  };
}

function readCloudMcpSyncMarkers(): CloudMcpSyncMarker[] {
  try {
    const raw = getStorage()?.getItem(CLOUD_MCP_SYNC_MARKER_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const candidates = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          "markers" in parsed &&
          Array.isArray(parsed.markers)
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

export function readCloudMcpSyncMarker(
  scope: CloudMcpSyncMarkerScope,
): CloudMcpSyncMarker | null {
  const denBaseUrl = normalizeMarkerBaseUrl(scope.denBaseUrl);
  const serverBaseUrl = normalizeMarkerBaseUrl(scope.serverBaseUrl);
  return readCloudMcpSyncMarkers().find(
    (marker) =>
      marker.denBaseUrl === denBaseUrl &&
      marker.serverBaseUrl === serverBaseUrl &&
      marker.orgId === scope.orgId &&
      marker.workspaceId === scope.workspaceId,
  ) ?? null;
}

export function writeCloudMcpSyncMarker(marker: CloudMcpSyncMarker) {
  try {
    const denBaseUrl = normalizeMarkerBaseUrl(marker.denBaseUrl);
    const serverBaseUrl = normalizeMarkerBaseUrl(marker.serverBaseUrl);
    if (!denBaseUrl || !serverBaseUrl) return;
    const normalizedMarker = { ...marker, denBaseUrl, serverBaseUrl };
    const markers = readCloudMcpSyncMarkers().filter(
      (entry) =>
        entry.denBaseUrl !== denBaseUrl ||
        entry.serverBaseUrl !== serverBaseUrl ||
        entry.orgId !== marker.orgId ||
        entry.workspaceId !== marker.workspaceId,
    );
    getStorage()?.setItem(
      CLOUD_MCP_SYNC_MARKER_STORAGE_KEY,
      JSON.stringify({ version: 1, markers: [...markers, normalizedMarker] }),
    );
  } catch {
    // Storage unavailable — reconciliation will simply run again later.
  }
}

/**
 * Pure marker-freshness check for the cloud MCP sync marker. Extracted so
 * the margin arithmetic is unit-testable: the previous inline check used a
 * refresh margin equal to the minted token's TTL, which made
 * the marker stale the moment it was written and turned the reconciler into
 * an every-tick config rewrite.
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
