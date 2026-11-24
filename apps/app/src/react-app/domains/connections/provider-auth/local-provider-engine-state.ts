import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { EngineV2PreviewStatus, OpenworkServerClient } from "@/app/lib/openwork-server";
import { isCloudManagedProviderKey } from "./cloud-provider-config";

export type LocalProviderEngineState = "ready" | "managed_by_organization" | "not_on_engine";

export type LocalProviderEngineStatus = Pick<EngineV2PreviewStatus, "enabled" | "chatRouting" | "mirroredProviderIds" | "skippedProviders">;

export function localProviderEngineStates(status: LocalProviderEngineStatus | null | undefined): ReadonlyMap<string, LocalProviderEngineState> {
  if (!status?.enabled || !status.chatRouting || !status.skippedProviders) return new Map();
  const states = new Map<string, LocalProviderEngineState>();
  for (const id of status.mirroredProviderIds) {
    if (!isCloudManagedProviderKey(id)) states.set(id, "ready");
  }
  for (const provider of status.skippedProviders) {
    if (!isCloudManagedProviderKey(provider.id)) states.set(provider.id, provider.reason === "policy" ? "managed_by_organization" : "not_on_engine");
  }
  return states;
}

export type DeviceProvider = { id: string; name: string; source?: "env" | "api" | "config" | "custom" };

export function deviceProviders(input: {
  connected: readonly DeviceProvider[];
  engine: ReadonlyMap<string, LocalProviderEngineState>;
  hidden: ReadonlySet<string>;
  nameFor: (id: string) => string;
}): DeviceProvider[] {
  const listed = new Set(input.connected.map((provider) => provider.id));
  return [
    ...input.connected,
    ...[...input.engine.keys()].flatMap((id) =>
      listed.has(id) || input.hidden.has(id.trim().toLowerCase()) ? [] : [{ id, name: input.nameFor(id) }]),
  ];
}

export function useLocalProviderEngineStates(client: OpenworkServerClient | null, refreshKey: string): ReadonlyMap<string, LocalProviderEngineState> {
  const status = useQuery({
    queryKey: ["local-provider-engine-states", client?.baseUrl ?? "", client?.token ?? "", refreshKey],
    queryFn: () => (client ? client.getEngineV2PreviewStatus() : null),
    enabled: Boolean(client),
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
  return useMemo(() => localProviderEngineStates(status.data), [status.data]);
}
