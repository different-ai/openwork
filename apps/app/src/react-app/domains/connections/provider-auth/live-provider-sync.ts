import { isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";

export function liveProviderSyncStatusQueryKey(baseUrl: string) {
  return ["live-provider-sync-status", baseUrl] as const;
}

export type LiveProviderSyncStatus = {
  enabled: boolean;
  chatRouting: boolean;
  liveProviderSync?: boolean;
};

export function usesLiveProviderSync(input: {
  baseUrl: string;
  status?: LiveProviderSyncStatus | null;
}) {
  if (!isOpencodeV2BaseUrl(input.baseUrl)) return false;
  if (typeof input.status?.liveProviderSync === "boolean") {
    return input.status.enabled && input.status.chatRouting && input.status.liveProviderSync;
  }
  return false;
}

export function shouldRefreshProvidersForReloadEvent(liveProviderSync: boolean) {
  return !liveProviderSync;
}

export function skipsLegacyProviderRefresh(reason: string, liveProviderSync: boolean) {
  return liveProviderSync && (reason === "model_picker_open" || reason === "new_chat" || reason === "manual");
}

export function pickerFallbackModels<T>(input: { liveProviderSync: boolean; engineListLoaded: boolean; assigned: readonly T[] }): readonly T[] {
  return input.liveProviderSync && input.engineListLoaded ? [] : input.assigned;
}
