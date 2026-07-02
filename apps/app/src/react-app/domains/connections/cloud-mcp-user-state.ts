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

export type CloudMcpUserState = "disabled" | "removed";

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
 * Pure marker-freshness check for the cloud MCP sync marker. Extracted so
 * the margin arithmetic is unit-testable: the previous inline check used a
 * refresh margin equal to the minted token's TTL (both 7 days), which made
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
