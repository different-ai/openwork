// Model picker modal state: lazy option loading (with "Recently added"
// provider flagging), open-event/localStorage triggers from the new-providers
// toast, and org-restriction filtering. Extracted verbatim from
// session-route.tsx; settings-route carries a sibling copy that should adopt
// this hook next.
import { useEffect, useMemo, useState } from "react";

import { isDesktopProviderBlocked } from "@/app/cloud/desktop-app-restrictions";
import type { Client, ModelOption } from "@/app/types";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import {
  ensureProviderListQuery,
  getConnectedProviderItems,
} from "@/react-app/infra/provider-list-query";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import {
  openModelPickerEvent,
  pendingModelPickerProviderIdsKey,
} from "@/react-app/shell/new-providers-listener";

export type UseModelPickerInput = {
  client: Client | null;
  baseUrl: string;
  workspaceRoot: string;
  /** Optional: surface option-load failures (settings shows a toast; the session route stays silent). */
  onLoadError?: (error: unknown) => void;
};

export function useModelPicker(input: UseModelPickerInput) {
  const { client, baseUrl, workspaceRoot, onLoadError } = input;
  const checkDesktopRestriction = useCheckDesktopRestriction();

  const [open, setOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  // Provider IDs that were just added — used to highlight them as
  // "Recently added" in the model picker even after they've been
  // marked as seen in localStorage.
  const [recentProviderIds, setRecentProviderIds] = useState<Set<string>>(new Set());

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

  // Load the picker list lazily the first time the modal opens. Uses the
  // cached catalog when available, otherwise re-fetches.
  useEffect(() => {
    if (!open || !client) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await ensureProviderListQuery(getReactQueryClient(), {
          client,
          baseUrl,
          directory: workspaceRoot || undefined,
        });
        if (cancelled || !data?.all) return;
        // Flag models from recently-added providers so they appear in
        // the "Recently added" section at the top of the picker.
        // Two sources: (1) providers not yet in the localStorage seen-set,
        // (2) providers passed via the openModelPickerEvent from the toast.
        let seenIds: Set<string>;
        try {
          const raw = window.localStorage.getItem("openwork.seenProviderIds");
          seenIds = new Set(raw ? JSON.parse(raw) : []);
        } catch {
          seenIds = new Set();
        }
        const options: ModelOption[] = [];
        for (const provider of getConnectedProviderItems(data)) {
          const modelIds = Object.keys(provider.models);
          const isNew = !seenIds.has(provider.id) || recentProviderIds.has(provider.id);
          for (const id of modelIds) {
            const model = provider.models[id];
            options.push({
              providerID: provider.id,
              modelID: id,
              title: model.name || id,
              description: provider.name,
              behaviorTitle: "Reasoning",
              behaviorLabel: "Default",
              behaviorDescription: "",
              behaviorValue: null,
              isFree: false,
              isConnected: true,
              isRecommended: isNew,
              source: /^lpr_/i.test(provider.id) ? "cloud" as const : undefined,
            });
          }
        }
        setModelOptions(options);
      } catch (error) {
        // Default: silent — the picker surfaces an empty list rather than
        // blocking the UI. Callers can opt into surfacing the failure.
        onLoadError?.(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, baseUrl, client, recentProviderIds, workspaceRoot]);

  // Apply org-level restrictions (dev #1505) on top of the raw model list
  // so the picker never surfaces blocked options:
  //   - `allowZenModel` hides the built-in OpenCode provider entries when false
  //   - `allowCustomProviders` hides providers that OpenCode does not report
  //     as connected through the provider list endpoint.
  const options = useMemo(() => {
    const restrictToCloud = checkDesktopRestriction({
      restriction: "allowCustomProviders",
    });
    return modelOptions.filter((option) => {
      if (
        isDesktopProviderBlocked({
          providerId: option.providerID,
          checkRestriction: checkDesktopRestriction,
        })
      ) {
        return false;
      }
      if (restrictToCloud && !option.isConnected) {
        return false;
      }
      return true;
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
