// Model picker modal state: lazy option loading (with "Recently added"
// provider flagging), open-event/localStorage triggers from the new-providers
// toast, and org-restriction filtering. Extracted verbatim from
// session-route.tsx; settings-route carries a sibling copy that should adopt
// this hook next.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Client, ModelOption } from "@/app/types";
import { getModelBehaviorSummary } from "@/app/lib/model-behavior";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { isCloudManagedProviderKey } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { filterEntitledModelOptions } from "@/react-app/domains/connections/provider-auth/provider-policy";
import {
  filterCloudManagedModelOptions,
  mergeModelOptions,
} from "@/react-app/domains/connections/provider-auth/assigned-model-options";
import {
  getConnectedProviderItems,
  useProviderListQuery,
} from "@/react-app/infra/provider-list-query";
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
};

export function useModelPicker(input: UseModelPickerInput) {
  const {
    client,
    baseUrl,
    workspaceRoot,
    onOpen,
    onLoadError,
    fallbackOptions = [],
    cloudProvidersEnabled = true,
  } = input;
  const checkDesktopRestriction = useCheckDesktopRestriction();

  const [open, setOpenState] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Provider IDs that were just added — used to highlight them as
  // "Recently added" in the model picker even after they've been
  // marked as seen in localStorage.
  const [recentProviderIds, setRecentProviderIds] = useState<Set<string>>(new Set());
  const providerListQuery = useProviderListQuery({
    client,
    baseUrl,
    directory: workspaceRoot || undefined,
    enabled: open,
  });
  const setOpen = useCallback((nextOpen: boolean) => {
    setOpenState(nextOpen);
    if (nextOpen) {
      onOpen?.();
    }
  }, [onOpen]);

  // Open model picker when the global toast's "Pick a new default?" is clicked
  useEffect(() => {
    const handler = (event: Event) => {
      try {
        window.localStorage.removeItem(pendingModelPickerProviderIdsKey);
      } catch {}
      const detail = (event as CustomEvent<{ newProviderIds?: string[]; initialTab?: "default" | "available" }>).detail;
      const ids = detail?.newProviderIds;
      if (ids && ids.length > 0) {
        setRecentProviderIds(new Set(ids));
      }
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
      if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
        setRecentProviderIds(new Set(ids));
      }
      setOpen(true);
    } catch {
      // Ignore malformed pending-picker state.
    }
  }, []);

  // Surface option-load failures when requested. The provider query remains
  // subscribed while the picker is open, so a startup cloud import updates an
  // already-open picker instead of leaving it on the pre-import snapshot.
  useEffect(() => {
    if (providerListQuery.error) {
      onLoadError?.(providerListQuery.error);
    }
  }, [onLoadError, providerListQuery.error]);

  const modelOptions = useMemo(() => {
    const data = providerListQuery.data;
    if (!data?.all) return [];

    // Flag models from recently-added providers so they appear in the
    // "Recently added" section at the top of the picker.
    // Two sources: (1) providers not yet in the localStorage seen-set,
    // (2) providers passed via the openModelPickerEvent from the toast.
    let seenIds: Set<string>;
    try {
      const raw = window.localStorage.getItem("openwork.seenProviderIds");
      seenIds = new Set(raw ? JSON.parse(raw) : []);
    } catch {
      seenIds = new Set();
    }

    const next: ModelOption[] = [];
    for (const provider of getConnectedProviderItems(data)) {
      const modelIds = Object.keys(provider.models);
      const isNew = !seenIds.has(provider.id) || recentProviderIds.has(provider.id);
      for (const id of modelIds) {
        const model = provider.models[id];
        const summary = getModelBehaviorSummary(provider.id, model, null, provider.name);
        next.push({
          providerID: provider.id,
          modelID: id,
          title: model.name || id,
          description: provider.name,
          behaviorTitle: summary.title,
          behaviorLabel: summary.label,
          behaviorDescription: summary.description,
          behaviorValue: summary.value,
          behaviorOptions: summary.options,
          isFree: false,
          isRecommended: isNew,
          source: isCloudManagedProviderKey(provider.id) ? "cloud" : undefined,
        });
      }
    }
    return filterCloudManagedModelOptions(
      mergeModelOptions(next, fallbackOptions),
      cloudProvidersEnabled,
    );
  }, [cloudProvidersEnabled, fallbackOptions, providerListQuery.data, recentProviderIds]);

  // Apply org-level restrictions (dev #1505) on top of the raw model list
  // so the picker never surfaces blocked options:
  //   - `allowZenModel` hides the built-in OpenCode provider entries when false
  //   - `allowCustomProviders` keeps org-managed providers, plus Zen when allowed.
  const options = useMemo(() => {
    const restrictToCloud = checkDesktopRestriction({
      restriction: "allowCustomProviders",
    });
    return filterEntitledModelOptions(modelOptions, {
      restrictToCloud,
      checkRestriction: checkDesktopRestriction,
    });
  }, [checkDesktopRestriction, modelOptions]);

  return {
    open,
    setOpen,
    compactOpen,
    setCompactOpen,
    query,
    setQuery,
    options,
    setRecentProviderIds,
  };
}
