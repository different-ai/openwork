import { createDenClient, readDenSettings, type DenExternalMcpConnection } from "@/app/lib/den";
import { markStartupStep, trackStartupOrgTools } from "@/app/lib/startup-diagnostics";
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

export type CloudInventoryScope = {
  baseUrl: string;
  organizationId: string;
};

const DEFAULT_MAX_AGE_MS = 60_000;

export function cloudInventoryScopeKey(scope: CloudInventoryScope) {
  return `${scope.baseUrl}\n${scope.organizationId}`;
}

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
  seed: (scope: CloudInventoryScope, value: T) => void;
  clear: () => void;
};

function createScopedCache<T, C>(
  fetcher: (input: { client: C; scope: CloudInventoryScope }) => Promise<T>,
  options?: { isFresh?: (value: T) => boolean },
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
      const cached = current?.value;
      const cacheable = cached != null && (options?.isFresh?.(cached) ?? true);
      if (cacheable && current && Date.now() - current.fetchedAt < maxAgeMs) return cached;
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
        if (slot === pending) slot = { ...pending, inflight: null };
        throw error;
      }
    },
    seed(scope, value) {
      const key = cloudInventoryScopeKey(scope);
      if (slot && slot.key === key && slot.inflight) return;
      slot = { key, value, fetchedAt: Date.now(), inflight: null };
    },
    clear() {
      slot = null;
    },
  };
}

const connectCapabilitiesCache = createScopedCache<ConnectCapabilityInventory, ConnectCapabilityClient>(
  ({ client, scope }) => listAssignedConnectCapabilities({ client, organizationId: scope.organizationId }),
  {
    isFresh: (inventory) => (
      inventory.plugins.length > 0
      || inventory.skills.length > 0
      || inventory.mcpServers.length > 0
    ),
  },
);

const orgMcpConnectionsCache = createScopedCache<DenExternalMcpConnection[], OrgMcpConnectionClient>(
  ({ client, scope }) => client.listMcpConnections(scope.organizationId, "usable"),
);

export function readCachedConnectCapabilities(scope: CloudInventoryScope) {
  return connectCapabilitiesCache.read(scope);
}

export function loadConnectCapabilities(input: {
  client: ConnectCapabilityClient;
  scope: CloudInventoryScope;
  maxAgeMs?: number;
}) {
  const loading = connectCapabilitiesCache.load(input);
  trackStartupOrgTools(loading);
  return loading;
}

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

export const CLOUD_INVENTORY_CHANGED_EVENT = "openwork-cloud-inventory-changed";

function notifyCloudInventoryChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CLOUD_INVENTORY_CHANGED_EVENT));
  }
}

export function clearCloudInventoryCache() {
  connectCapabilitiesCache.clear();
  orgMcpConnectionsCache.clear();
  notifyCloudInventoryChanged();
}

export function storeCloudInventory(
  scope: CloudInventoryScope,
  loaded: { capabilities: ConnectCapabilityInventory; connections: DenExternalMcpConnection[] },
  options: { changed: boolean },
) {
  connectCapabilitiesCache.seed(scope, loaded.capabilities);
  orgMcpConnectionsCache.seed(scope, loaded.connections);
  markStartupStep("org_tools");
  if (options.changed) notifyCloudInventoryChanged();
}

function denClientForCurrentSession() {
  const settings = readDenSettings();
  return createDenClient({
    baseUrl: settings.baseUrl,
    token: settings.authToken?.trim() ?? "",
  });
}

export async function loadSessionConnectCapabilities(): Promise<ConnectCapabilityInventory> {
  const scope = readCloudInventoryScope();
  if (!scope) return EMPTY_CONNECT_CAPABILITY_INVENTORY;
  try {
    return await loadConnectCapabilities({ client: denClientForCurrentSession(), scope });
  } catch {
    return EMPTY_CONNECT_CAPABILITY_INVENTORY;
  }
}

export function prefetchCloudInventory() {
  const scope = readCloudInventoryScope();
  if (!scope) return;
  const client = denClientForCurrentSession();
  void loadConnectCapabilities({ client, scope }).catch(() => {});
  void loadOrgMcpConnections({ client, scope }).catch(() => {});
}
