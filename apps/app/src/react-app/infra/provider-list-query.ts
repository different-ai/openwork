import { useQuery, type QueryClient } from "@tanstack/react-query";

import type { Client, ModelRef, ProviderListItem } from "../../app/types";
import { desktopFetch } from "../../app/lib/desktop";
import { unwrap } from "../../app/lib/opencode";
import { dispatchNewProviders } from "../../app/lib/provider-events";
import { isDesktopRuntime } from "../../app/utils";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

export const PROVIDER_LIST_CACHE_MS = 5 * 60 * 1000;
const PROVIDER_LIST_QUERY_ROOT = ["opencode-provider-list"] as const;

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

type ConfiguredProviderListResponse = {
  all?: ProviderListItem[];
  providers?: ProviderListItem[] | Record<string, ProviderListItem>;
  connected?: string[];
  default?: ProviderListResponse["default"];
};

const connectedProviderSnapshots = new Map<string, ConnectedProviderSnapshot>();
const connectedProviderSnapshotChanges = new Map<string, ConnectedProviderSnapshotChange>();

export function providerListQueryKey(input: {
  baseUrl?: string | null;
  openworkToken?: string | null;
  directory?: string | null;
}) {
  return [
    ...PROVIDER_LIST_QUERY_ROOT,
    input.baseUrl?.trim() ?? "",
    input.openworkToken?.trim() ? "openwork-token" : "",
    input.directory?.trim() ?? "",
  ] as const;
}

export async function refreshProviderListQueries(queryClient: QueryClient) {
  await queryClient.invalidateQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT });
  await queryClient.refetchQueries({ queryKey: PROVIDER_LIST_QUERY_ROOT, type: "active" });
}

export async function fetchProviderList(input: {
  client: Client;
  baseUrl?: string | null;
  openworkToken?: string | null;
  directory?: string | null;
}): Promise<ProviderListResponse> {
  const directConfiguredProviders = await fetchOpenworkConfiguredProviders(input);
  if (directConfiguredProviders) {
    recordConnectedProviderSnapshot(input, directConfiguredProviders);
    return directConfiguredProviders;
  }

  const parameters = {
    directory: input.directory?.trim() || undefined,
  };
  const configuredProviders = await input.client.config.providers(parameters);
  const value = normalizeProviderListResponse(unwrap(configuredProviders));
  recordConnectedProviderSnapshot(input, value);
  return value;
}

async function fetchOpenworkConfiguredProviders(input: {
  baseUrl?: string | null;
  openworkToken?: string | null;
}): Promise<ProviderListResponse | null> {
  const token = input.openworkToken?.trim();
  const baseUrl = input.baseUrl?.trim().replace(/\/+$/, "");
  if (!token || !baseUrl || !/\/workspace\/[^/]+\/opencode$/.test(baseUrl)) return null;

  const fetchImpl = isDesktopRuntime() ? desktopFetch : globalThis.fetch;
  const response = await fetchImpl(`${baseUrl}/config/providers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch configured providers (${response.status})`);
  }
  return normalizeProviderListResponse(await response.json(), { defaultConnectedToAll: false });
}

export function normalizeProviderListResponse(
  value: ProviderListResponse | ConfiguredProviderListResponse,
  options: { defaultConnectedToAll?: boolean } = {},
): ProviderListResponse {
  const providers = "providers" in value ? value.providers : undefined;
  const all = Array.isArray(providers)
    ? providers
    : providers && typeof providers === "object"
      ? Object.values(providers)
      : Array.isArray(value.all)
        ? value.all
        : [];
  return {
    ...value,
    all,
    connected: value.connected ?? (options.defaultConnectedToAll === false ? [] : all.map((provider) => provider.id)),
    default: value.default ?? {},
  };
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
  openworkToken?: string | null;
  directory?: string | null;
}) {
  return connectedProviderSnapshotChanges.get(connectedProviderSnapshotKey(input)) ?? null;
}

function recordConnectedProviderSnapshot(
  input: {
    baseUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
  },
  value: ProviderListResponse,
) {
  const key = connectedProviderSnapshotKey(input);
  const previous = connectedProviderSnapshots.get(key) ?? null;
  const next = getConnectedProviderSnapshot(value);
  const changed = previous !== null && JSON.stringify(previous) !== JSON.stringify(next);
  connectedProviderSnapshots.set(key, next);
  connectedProviderSnapshotChanges.set(key, { changed, previous, next });
  if (changed) {
    dispatchConnectedProviderChanges(previous, next);
  }
}

function connectedProviderSnapshotKey(input: {
  baseUrl?: string | null;
  openworkToken?: string | null;
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
    openworkToken?: string | null;
    directory?: string | null;
    force?: boolean;
  },
) {
  const options = {
    queryKey: providerListQueryKey(input),
    queryFn: () => fetchProviderList(input),
    gcTime: PROVIDER_LIST_CACHE_MS,
  };
  if (input.force) {
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
  openworkToken?: string | null;
  directory?: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: providerListQueryKey(input),
    enabled: Boolean(input.client) && (input.enabled ?? true),
    staleTime: PROVIDER_LIST_CACHE_MS,
    gcTime: PROVIDER_LIST_CACHE_MS,
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
        openworkToken: input.openworkToken,
        directory: input.directory,
      });
    },
  });
}
