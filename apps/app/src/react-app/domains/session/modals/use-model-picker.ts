// "All models" dialog state for the session and settings routes: open and
// search state, the new-providers toast triggers, and "Recently added"
// flagging. The options come from the shared model catalog, so the dialog
// lists exactly what the composer picker and the palette list.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Client, ModelOption } from "@/app/types";
import type { CloudImportedProvider } from "@/app/cloud/import-state";
import { pendingGatewayModelOptions, type GatewayConnectProvider } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { useModelCatalog } from "@/react-app/domains/models/use-model-catalog";
import {
  openModelPickerEvent,
  pendingModelPickerProviderIdsKey,
} from "@/react-app/shell/new-providers-listener";

export type UseModelPickerInput = {
  client: Client | null;
  baseUrl: string;
  workspaceRoot: string;
  /** Called when the picker opens so callers can reconcile remote assignments. */
  onOpen?: () => void;
  /** Optional: surface option-load failures (settings shows a toast; the session route stays silent). */
  onLoadError?: (error: unknown) => void;
  /** Member-scoped models available before a workspace OpenCode client exists. */
  fallbackOptions?: readonly ModelOption[];
  /** Account-scoped providers are hidden immediately after cloud sign-out. */
  cloudProvidersEnabled?: boolean;
  importedProviders?: Record<string, CloudImportedProvider>;
  /** Gateway providers whose models wait on the member's own sign-in. */
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
  // Provider IDs that were just added — shown as "Recently added" even after
  // they've been marked as seen in localStorage.
  const [recentProviderIds, setRecentProviderIds] = useState<Set<string>>(new Set());
  const setOpen = useCallback((nextOpen: boolean) => {
    setOpenState(nextOpen);
    if (nextOpen) onOpen?.();
  }, [onOpen]);

  // Open model picker when the global toast's "Pick a new default?" is clicked
  useEffect(() => {
    const handler = (event: Event) => {
      try {
        window.localStorage.removeItem(pendingModelPickerProviderIdsKey);
      } catch {}
      const ids = (event as CustomEvent<{ newProviderIds?: string[] }>).detail?.newProviderIds;
      if (ids && ids.length > 0) setRecentProviderIds(new Set(ids));
      setOpen(true);
    };
    window.addEventListener(openModelPickerEvent, handler);
    return () => window.removeEventListener(openModelPickerEvent, handler);
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(pendingModelPickerProviderIdsKey);
      if (!raw) return;
      window.localStorage.removeItem(pendingModelPickerProviderIdsKey);
      const parsed = JSON.parse(raw);
      const ids = Array.isArray(parsed) ? parsed : parsed?.newProviderIds;
      if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) setRecentProviderIds(new Set(ids));
      setOpen(true);
    } catch {
      // Ignore malformed pending-picker state.
    }
  }, []);

  // Two sources of "new": providers not yet in the seen-set, and providers named by the toast.
  const isNewProvider = useMemo(() => {
    const seen = readSeenProviderIds();
    return (providerId: string) => !seen.has(providerId) || recentProviderIds.has(providerId);
  }, [recentProviderIds]);
  const pendingOptions = useMemo(() => pendingGatewayModelOptions(input.pendingProviders ?? []), [input.pendingProviders]);
  // The provider query stays subscribed while the picker is open, so a startup
  // cloud import updates an already-open picker instead of a stale snapshot.
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
    /** Selectable models: the shared catalog. */
    options: catalog.options,
    /** Everything the person could have chosen, disabled rows included. */
    knownOptions: catalog.knownOptions,
    /** The palette and shortcuts use these: Auto is disabled while it cannot run. */
    actionOptions: catalog.actionOptions,
    setRecentProviderIds,
  };
}
