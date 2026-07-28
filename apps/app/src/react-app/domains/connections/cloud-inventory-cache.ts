import { createDenClient, readDenSettings, type DenExternalMcpConnection } from "@/app/lib/den";
import {
  EMPTY_CONNECT_CAPABILITY_INVENTORY,
  listAssignedConnectCapabilities,
  type ConnectCapabilityClient,
  type ConnectCapabilityInventory,
} from "@/react-app/domains/session/surface/connect-capability-inventory";

export type OrgMcpConnectionClient = {
  listMcpConnections: (
    organizationId: string,
    scope: "usable" | "manageable",
  ) => Promise<DenExternalMcpConnection[]>;
};

/**
 * What the organization gives this member — Connect capabilities and external
 * MCP connections — is the slowest part of the Extensions inventory: each one
 * is a Den round-trip (marketplaces, then every resolved marketplace, then
 * every resolved plugin). The composer and Settings both need it, and Settings
 * remounts every time the extensions side panel opens, so without a cache the
 * "Ready to use" group waits on the same fan-out again and again.
 *
 * These caches are module-scoped on purpose: they outlive the components that
 * read them, so a view can paint the last known inventory on its first frame
 * and revalidate behind it.
 */

export type CloudInventoryScope = {
  baseUrl: string;
  organizationId: string;
};

/** How long a cached answer is served without going back to Den. */
const DEFAULT_MAX_AGE_MS = 60_000;

export function cloudInventoryScopeKey(scope: CloudInventoryScope) {
  return `${scope.baseUrl}\n${scope.organizationId}`;
}

/** The scope of the signed-in member, or null when there is nothing to fetch. */
export function readCloudInventoryScope(): CloudInventoryScope | null {
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  const organizationId = settings.activeOrgId?.trim() ?? "";
  if (!token || !organizationId) return null;
  return { baseUrl: settings.baseUrl, organizationId };
}

type CacheSlot<T> = {
  key: string;
  value: T | null;
  fetchedAt: number;
  inflight: Promise<T> | null;
};

type ScopedCache<T, C> = {
  read: (scope: CloudInventoryScope) => T | null;
  load: (input: { client: C; scope: CloudInventoryScope; maxAgeMs?: number }) => Promise<T>;
  clear: () => void;
};

function createScopedCache<T, C>(
  fetcher: (input: { client: C; scope: CloudInventoryScope }) => Promise<T>,
): ScopedCache<T, C> {
  let slot: CacheSlot<T> | null = null;

  return {
    read(scope) {
      const key = cloudInventoryScopeKey(scope);
      return slot && slot.key === key ? slot.value : null;
    },
    async load({ client, scope, maxAgeMs = DEFAULT_MAX_AGE_MS }) {
      const key = cloudInventoryScopeKey(scope);
      const current = slot && slot.key === key ? slot : null;
      if (current?.value && Date.now() - current.fetchedAt < maxAgeMs) return current.value;
      if (current?.inflight) return current.inflight;

      const inflight = fetcher({ client, scope });
      const pending: CacheSlot<T> = {
        key,
        value: current?.value ?? null,
        fetchedAt: current?.fetchedAt ?? 0,
        inflight,
      };
      slot = pending;
      try {
        const value = await inflight;
        if (slot === pending) slot = { key, value, fetchedAt: Date.now(), inflight: null };
        return value;
      } catch (error) {
        // Keep the last good answer so a flaky refresh does not blank the list.
        if (slot === pending) slot = { ...pending, inflight: null };
        throw error;
      }
    },
    clear() {
      slot = null;
    },
  };
}

const connectCapabilitiesCache = createScopedCache<ConnectCapabilityInventory, ConnectCapabilityClient>(
  ({ client, scope }) => listAssignedConnectCapabilities({ client, organizationId: scope.organizationId }),
);

const orgMcpConnectionsCache = createScopedCache<DenExternalMcpConnection[], OrgMcpConnectionClient>(
  ({ client, scope }) => client.listMcpConnections(scope.organizationId, "usable"),
);

/** Last known Connect inventory for this scope, without fetching. */
export function readCachedConnectCapabilities(scope: CloudInventoryScope) {
  return connectCapabilitiesCache.read(scope);
}

export function loadConnectCapabilities(input: {
  client: ConnectCapabilityClient;
  scope: CloudInventoryScope;
  maxAgeMs?: number;
}) {
  return connectCapabilitiesCache.load(input);
}

/** Last known organization MCP connections for this scope, without fetching. */
export function readCachedOrgMcpConnections(scope: CloudInventoryScope) {
  return orgMcpConnectionsCache.read(scope);
}

export function loadOrgMcpConnections(input: {
  client: OrgMcpConnectionClient;
  scope: CloudInventoryScope;
  maxAgeMs?: number;
}) {
  return orgMcpConnectionsCache.load(input);
}

export function clearCloudInventoryCache() {
  connectCapabilitiesCache.clear();
  orgMcpConnectionsCache.clear();
}

function denClientForCurrentSession() {
  const settings = readDenSettings();
  return createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken?.trim() ?? "" });
}

/**
 * Connect inventory for the signed-in member, empty when signed out. Callers
 * that only need the capabilities (composer tool lists) use this instead of
 * building a scope and client themselves.
 */
export async function loadSessionConnectCapabilities(): Promise<ConnectCapabilityInventory> {
  const scope = readCloudInventoryScope();
  if (!scope) return EMPTY_CONNECT_CAPABILITY_INVENTORY;
  try {
    return await loadConnectCapabilities({ client: denClientForCurrentSession(), scope });
  } catch {
    return EMPTY_CONNECT_CAPABILITY_INVENTORY;
  }
}

/**
 * Warm both caches for the signed-in member. Called at app start and whenever
 * the Den session changes, so the Extensions inventory has its organization
 * rows ready before the user ever opens Settings.
 */
export function prefetchCloudInventory() {
  const scope = readCloudInventoryScope();
  if (!scope) return;
  const client = denClientForCurrentSession();
  void loadConnectCapabilities({ client, scope }).catch(() => {});
  void loadOrgMcpConnections({ client, scope }).catch(() => {});
}
