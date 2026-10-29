import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { EngineV2PreviewStatus, OpenworkServerClient } from "@/app/lib/openwork-server";
import { isCloudManagedProviderKey } from "./cloud-provider-config";

/**
 * How a provider on this device stands on the engine chat runs on.
 * - `ready`: the engine has it; it is in the model picker.
 * - `managed_by_organization`: the organization allows only its own providers.
 * - `not_on_engine`: OpenCode v2 cannot use it yet (a sign-in, or no adapter).
 */
export type LocalProviderEngineState = "ready" | "managed_by_organization" | "not_on_engine";

export type LocalProviderEngineStatus = Pick<EngineV2PreviewStatus, "enabled" | "chatRouting" | "mirroredProviderIds" | "skippedProviders">;

/**
 * What OpenCode v2 reports for the providers on this device: the ones it
 * mirrored are ready, the ones it skipped carry their reason. Only while chat
 * runs on v2 and the server explains its skips; older servers without that
 * field have no engine view and keep their existing behavior.
 * Organization providers keep their own rows and states.
 */
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

/**
 * "On this device" while chat runs on v2: the providers OpenCode v1 lists for
 * this folder, reconciled with what the engine reports. A provider the
 * engine mirrored or skipped is always listed, even when v1's list does not
 * have it yet, so a provider that works in the picker is never missing and a
 * skipped one shows its reason. Hidden (disconnected) providers stay hidden.
 */
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

/**
 * The engine's view for Settings › AI Providers. `refreshKey` changes whenever
 * the provider list is read again; the server finishes mirroring a saved key
 * before the save returns, so that read already explains it. The last answer
 * stays on screen while the next one loads.
 */
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
