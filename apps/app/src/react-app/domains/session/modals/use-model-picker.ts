import { useCallback, useEffect, useMemo, useState } from "react";
import type { Client, ModelOption } from "@/app/types";
import type { CloudImportedProvider } from "@/app/cloud/import-state";
import { pendingGatewayModelOptions, type GatewayConnectProvider } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { useModelCatalog } from "@/react-app/domains/models/use-model-catalog";
import { openModelPickerEvent } from "@/react-app/shell/new-providers-listener";

export type UseModelPickerInput = {
  client: Client | null;
  baseUrl: string;
  workspaceRoot: string;
  onOpen?: () => void;
  onLoadError?: (error: unknown) => void;
  fallbackOptions?: readonly ModelOption[];
  cloudProvidersEnabled?: boolean;
  importedProviders?: Record<string, CloudImportedProvider>;
  pendingProviders?: readonly GatewayConnectProvider[];
  disabledProviders?: readonly string[];
  gatewayProviderIds?: ReadonlySet<string>;
};

function readSeenProviderIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem("openwork.seenProviderIds");
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

export function useModelPicker(input: UseModelPickerInput) {
  const { onOpen, onLoadError } = input;
  const [open, setOpenState] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recentProviderIds, setRecentProviderIds] = useState<Set<string>>(new Set());
  const setOpen = useCallback((nextOpen: boolean) => {
    setOpenState(nextOpen);
    if (nextOpen) onOpen?.();
  }, [onOpen]);

  useEffect(() => {
    const handler = (event: Event) => {
      const ids = (event as CustomEvent<{ newProviderIds?: string[] }>).detail?.newProviderIds;
      if (ids && ids.length > 0) setRecentProviderIds(new Set(ids));
      setOpen(true);
    };
    window.addEventListener(openModelPickerEvent, handler);
    return () => window.removeEventListener(openModelPickerEvent, handler);
  }, []);

  const isNewProvider = useMemo(() => {
    const seen = readSeenProviderIds();
    return (providerId: string) => !seen.has(providerId) || recentProviderIds.has(providerId);
  }, [recentProviderIds]);
  const pendingOptions = useMemo(() => pendingGatewayModelOptions(input.pendingProviders ?? []), [input.pendingProviders]);
  const catalog = useModelCatalog({
    client: input.client, baseUrl: input.baseUrl, directory: input.workspaceRoot, enabled: open,
    fallbackOptions: input.fallbackOptions, cloudProvidersEnabled: input.cloudProvidersEnabled, importedProviders: input.importedProviders, pendingOptions,
    disabledProviders: input.disabledProviders, gatewayProviderIds: input.gatewayProviderIds, isNewProvider,
  });
  const { catalogState } = catalog;
  useEffect(() => {
    if (catalog.error) onLoadError?.(catalog.error);
  }, [onLoadError, catalog.error]);

  return {
    catalogState,
    open,
    setOpen,
    compactOpen,
    setCompactOpen,
    query,
    setQuery,
    options: catalog.options,
    knownOptions: catalog.knownOptions,
    actionOptions: catalog.actionOptions,
    setRecentProviderIds,
  };
}
