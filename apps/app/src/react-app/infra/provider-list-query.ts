import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import type { Client, ModelRef, ProviderListItem } from "../../app/types";
import { unwrap } from "../../app/lib/opencode";
import { dispatchNewProviders, subscribeProviderCatalogChanges } from "../../app/lib/provider-events";
import type { ConfigProvidersResponse, ProviderListResponse } from "@opencode-ai/sdk/v2/client";

export const PROVIDER_LIST_CACHE_MS = 5 * 60 * 1000;
// Connected providers only: what pickers, availability checks and defaults read.
const PROVIDER_LIST_QUERY_ROOT = ["opencode-provider-list"] as const;
// Every provider the engine knows (~6 MB on v1), for connecting a new one.
const PROVIDER_CATALOG_QUERY_ROOT = ["opencode-provider-catalog"] as const;
const SAVED_PROVIDER_LIST_PREFIX = "openwork.providerList.v1:";

export type ConnectedProviderSnapshot = Array<{
  id: string;
  name: string;
  source: ProviderListItem["source"];
  models: Record<string, ProviderListItem["models"][string]>;
}>;

export type ConnectedProviderSnapshotChange = {
  changed: boolean;
  previous: ConnectedProviderSnapshot | null;
  next: ConnectedProviderSnapshot;
};

// Bounded module-scope cache: snapshots are keyed by (baseUrl, directory) and
// would otherwise accumulate for every workspace ever opened in this app run.
// Recording refreshes a key's recency; the oldest keys are evicted past the cap.
const CONNECTED_PROVIDER_SNAPSHOT_LIMIT = 16;
const connectedProviderSnapshots = new Map<string, ConnectedProviderSnapshot>();
const connectedProviderSnapshotChanges = new Map<string, ConnectedProviderSnapshotChange>();

export function providerListQueryKey(input: {
  baseUrl?: string | null;
  directory?: string | null;
}) {
  return [
    ...PROVIDER_LIST_QUERY_ROOT,
    input.baseUrl?.trim() ?? "",
    input.directory?.trim() ?? "",
  ] as const;
}

export function providerCatalogQueryKey(input: {
  baseUrl?: string | null;
  directory?: string | null;
}) {
  return [
    ...PROVIDER_CATALOG_QUERY_ROOT,
    input.baseUrl?.trim() ?? "",
    input.directory?.trim() ?? "",
  ] as const;
}

export async function refreshProviderListQueries(queryClient: QueryClient) {
  await queryClient.invalidateQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT });
  await queryClient.invalidateQueries({ queryKey: PROVIDER_CATALOG_QUERY_ROOT });
  await queryClient.refetchQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT, type: "active" });
}

/** Drop account-sensitive provider snapshots when the Den session ends. */
export function clearProviderListQueries(queryClient: QueryClient) {
  queryClient.removeQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT });
  queryClient.removeQueries({ queryKey: PROVIDER_CATALOG_QUERY_ROOT });
  connectedProviderSnapshots.clear();
  connectedProviderSnapshotChanges.clear();
  clearSavedProviderLists();
}

/** The connected providers as the `{all, connected, default}` shape every reader already uses. */
export function providerListFromConnected(value: ConfigProvidersResponse): ProviderListResponse {
  const all = value.providers ?? [];
  return { all, connected: all.map((provider) => provider.id), default: value.default ?? {} };
}

/**
 * Connected providers only. On v1 `/config/providers` answers in a few
 * milliseconds with ~30 KB, where `/provider` sends the whole ~6 MB catalog.
 */
export async function fetchProviderList(input: {
  client: Client;
  baseUrl?: string | null;
  directory?: string | null;
}): Promise<ProviderListResponse> {
  const value = providerListFromConnected(unwrap(
    await input.client.config.providers({
      directory: input.directory?.trim() || undefined,
    }),
  ));
  recordConnectedProviderSnapshot(input, value);
  saveProviderList(input.directory, value);
  return value;
}

/** Every provider the engine knows, connected or not. Only for connecting a new provider. */
export async function fetchProviderCatalog(input: {
  client: Client;
  directory?: string | null;
}): Promise<ProviderListResponse> {
  return unwrap(
    await input.client.provider.list({
      directory: input.directory?.trim() || undefined,
    }),
  );
}

export function ensureProviderCatalogQuery(
  queryClient: QueryClient,
  input: {
    client: Client;
    baseUrl?: string | null;
    directory?: string | null;
  },
) {
  return queryClient.ensureQueryData({
    queryKey: providerCatalogQueryKey(input),
    queryFn: () => fetchProviderCatalog(input),
    gcTime: PROVIDER_LIST_CACHE_MS,
    staleTime: PROVIDER_LIST_CACHE_MS,
  });
}

const savedProviderSchema = z.custom<ProviderListItem>(
  (value) => typeof value === "object" && value !== null
    && "id" in value && typeof value.id === "string"
    && "models" in value && typeof value.models === "object" && value.models !== null,
);
const savedProviderListSchema = z.object({
  savedAt: z.number(),
  value: z.object({
    all: z.array(savedProviderSchema),
    connected: z.array(z.string()),
    default: z.record(z.string(), z.string()),
  }),
});

function savedProviderListKey(directory?: string | null) {
  return `${SAVED_PROVIDER_LIST_PREFIX}${directory?.trim() ?? ""}`;
}

function providerListStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Remember the last connected providers per folder, so the next launch can
 * show them while the engine is still starting. Keyed by folder, not engine
 * URL: the engine port changes on every launch.
 */
function saveProviderList(directory: string | null | undefined, value: ProviderListResponse) {
  const storage = providerListStorage();
  if (!storage) return;
  const all = getConnectedProviderItems(value);
  const ids = new Set(all.map((provider) => provider.id));
  const saved = {
    savedAt: Date.now(),
    value: {
      all,
      connected: all.map((provider) => provider.id),
      default: Object.fromEntries(Object.entries(value.default ?? {}).filter(([id]) => ids.has(id))),
    },
  };
  try {
    storage.setItem(savedProviderListKey(directory), JSON.stringify(saved));
  } catch {
    // Storage full or unavailable: the next launch simply waits for the engine.
  }
}

/** The connected providers last seen for this folder, or undefined. Never fresh: always revalidate. */
export function readSavedProviderList(directory?: string | null): ProviderListResponse | undefined {
  const storage = providerListStorage();
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(savedProviderListKey(directory));
    if (!raw) return undefined;
    const parsed = savedProviderListSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.value : undefined;
  } catch {
    return undefined;
  }
}

function clearSavedProviderLists() {
  const storage = providerListStorage();
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(SAVED_PROVIDER_LIST_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // ignore storage failures
  }
}

export function getConnectedProviderItems(value: ProviderListResponse | null | undefined) {
  const connected = new Set(value?.connected ?? []);
  return (value?.all ?? []).filter(
    (provider) =>
      connected.has(provider.id) &&
      (provider.source !== "custom" || provider.id === "opencode" || Object.keys(provider.models ?? {}).length > 0),
  );
}

export function getConnectedProviderSnapshot(value: ProviderListResponse | null | undefined): ConnectedProviderSnapshot {
  return getConnectedProviderItems(value)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      source: provider.source,
      models: Object.fromEntries(
        Object.entries(provider.models ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function isModelAvailableInConnectedProviders(
  value: ProviderListResponse | null | undefined,
  model: ModelRef | null | undefined,
) {
  if (!model?.providerID || !model.modelID) return true;
  return getConnectedProviderItems(value).some(
    (provider) => provider.id === model.providerID && Boolean(provider.models?.[model.modelID]),
  );
}

export function getConnectedProviderSnapshotChange(input: {
  baseUrl?: string | null;
  directory?: string | null;
}) {
  return connectedProviderSnapshotChanges.get(connectedProviderSnapshotKey(input)) ?? null;
}

function recordConnectedProviderSnapshot(
  input: {
    baseUrl?: string | null;
    directory?: string | null;
  },
  value: ProviderListResponse,
) {
  const key = connectedProviderSnapshotKey(input);
  const previous = connectedProviderSnapshots.get(key) ?? null;
  const next = getConnectedProviderSnapshot(value);
  const changed = previous !== null && JSON.stringify(previous) !== JSON.stringify(next);
  // Delete before set so a refreshed key moves to the newest insertion slot.
  connectedProviderSnapshots.delete(key);
  connectedProviderSnapshotChanges.delete(key);
  connectedProviderSnapshots.set(key, next);
  connectedProviderSnapshotChanges.set(key, { changed, previous, next });
  while (connectedProviderSnapshots.size > CONNECTED_PROVIDER_SNAPSHOT_LIMIT) {
    const oldest = connectedProviderSnapshots.keys().next().value;
    if (oldest === undefined) break;
    connectedProviderSnapshots.delete(oldest);
    connectedProviderSnapshotChanges.delete(oldest);
  }
  if (changed) {
    dispatchConnectedProviderChanges(previous, next);
  }
}

function connectedProviderSnapshotKey(input: {
  baseUrl?: string | null;
  directory?: string | null;
}) {
  return JSON.stringify(providerListQueryKey(input));
}

function dispatchConnectedProviderChanges(
  previous: ConnectedProviderSnapshot | null,
  next: ConnectedProviderSnapshot,
) {
  if (!previous) return;
  const previousById = new Map(previous.map((provider) => [provider.id, provider]));
  const newProviders = next.filter((provider) => !previousById.has(provider.id));
  const changedProviders = new Map<string, ConnectedProviderSnapshot[number]>();
  let newModelCount = 0;

  for (const provider of next) {
    const before = previousById.get(provider.id);
    if (!before) {
      newModelCount += Object.keys(provider.models).length;
      changedProviders.set(provider.id, provider);
      continue;
    }
    for (const [id, model] of Object.entries(provider.models)) {
      if (JSON.stringify(before.models[id]) !== JSON.stringify(model)) {
        newModelCount += 1;
        changedProviders.set(provider.id, provider);
      }
    }
  }

  if (newProviders.length === 0 && newModelCount === 0) return;

  dispatchNewProviders({
    providers: [...changedProviders.values()].map((provider) => {
      const firstModelId = Object.keys(provider.models)[0];
      return {
        id: provider.id,
        name: provider.name,
        providerId: provider.id,
        firstModelId,
        firstModelName: firstModelId ? provider.models[firstModelId]?.name ?? firstModelId : undefined,
      };
    }),
    newProviderCount: newProviders.length,
    newModelCount,
    source: "models_refresh",
  });
}

export function ensureProviderListQuery(
  queryClient: QueryClient,
  input: {
    client: Client;
    baseUrl?: string | null;
    directory?: string | null;
    force?: boolean;
  },
) {
  const options = {
    queryKey: providerListQueryKey(input),
    queryFn: () => fetchProviderList(input),
    gcTime: PROVIDER_LIST_CACHE_MS,
  };
  const state = queryClient.getQueryState(options.queryKey);
  if (input.force || state?.status === "error" || state?.isInvalidated || state?.fetchStatus === "fetching") {
    return queryClient.fetchQuery({
      ...options,
      staleTime: 0,
    });
  }
  return queryClient.ensureQueryData({
    ...options,
    staleTime: PROVIDER_LIST_CACHE_MS,
  });
}

export function useProviderListQuery(input: {
  client: Client | null;
  baseUrl?: string | null;
  directory?: string | null;
  enabled?: boolean;
  /**
   * Show the providers last seen for this folder until the engine answers.
   * Only for pickers: `isPlaceholderData` is true meanwhile, and nothing that
   * changes a selection automatically should act on it.
   */
  showSavedWhileLoading?: boolean;
}) {
  const queryClient = useQueryClient();
  useEffect(() => subscribeProviderCatalogChanges((scope) => {
    if (scope.baseUrl !== input.baseUrl || (scope.directory ?? "") !== (input.directory ?? "")) return;
    void queryClient.invalidateQueries({ queryKey: providerListQueryKey(scope) });
  }), [input.baseUrl, input.directory, queryClient]);
  return useQuery({
    queryKey: providerListQueryKey(input),
    enabled: Boolean(input.client) && (input.enabled ?? true),
    staleTime: PROVIDER_LIST_CACHE_MS,
    gcTime: PROVIDER_LIST_CACHE_MS,
    placeholderData: input.showSavedWhileLoading ? () => readSavedProviderList(input.directory) : undefined,
    queryFn: () => {
      if (!input.client) {
        return {
          all: [] as ProviderListItem[],
          connected: [],
          default: {},
        } satisfies ProviderListResponse;
      }
      return fetchProviderList({
        client: input.client,
        baseUrl: input.baseUrl,
        directory: input.directory,
      });
    },
  });
}
