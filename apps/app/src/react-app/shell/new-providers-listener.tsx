/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { resolveProviderDisplayName } from "@/app/utils";
import {
  newProvidersEvent,
  type NewProviderInfo,
  type NewProvidersEventDetail,
} from "@/app/lib/provider-events";
import { t } from "@/i18n";
import { useNotificationStore } from "@/react-app/kernel/notification-store";
import { notifyEvent } from "./notifications";
import { orgOnboardingVisibilityEvent } from "./reload-coordinator";

const SEEN_KEY = "openwork.seenProviderIds";
const PENDING_MODEL_PICKER_KEY = "openwork.pendingModelPickerProviderIds";
const NEW_PROVIDERS_DEDUPE_KEY = "new-providers";

/** Custom event to request the model picker to open. */
export const openModelPickerEvent = "openwork-open-model-picker";
export const pendingModelPickerProviderIdsKey = PENDING_MODEL_PICKER_KEY;

function readSeenProviderIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function markProvidersSeen(ids: string[]): void {
  try {
    const existing = readSeenProviderIds();
    for (const id of ids) existing.add(id);
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...existing]));
  } catch {}
}

/**
 * Open the model picker focused on the given new providers. If no session
 * surface picks the event up, fall back to navigating to preferences.
 */
export function requestOpenModelPicker(providerIds: string[]): void {
  try {
    window.localStorage.setItem(
      PENDING_MODEL_PICKER_KEY,
      JSON.stringify({ newProviderIds: providerIds, initialTab: "available" }),
    );
  } catch {}
  window.dispatchEvent(
    new CustomEvent(openModelPickerEvent, {
      detail: { newProviderIds: providerIds, initialTab: "available" },
    }),
  );
  window.setTimeout(() => {
    try {
      if (window.localStorage.getItem(PENDING_MODEL_PICKER_KEY)) {
        const path = window.location.hash.replace(/^#/, "") || "/settings/preferences";
        const match = path.match(/^\/workspace\/([^/]+)/);
        window.location.hash = match?.[1]
          ? `/workspace/${match[1]}/settings/preferences`
          : "/settings/preferences";
      }
    } catch {}
  }, 0);
}

type ListenerState = {
  active: boolean;
  providers: NewProviderInfo[];
  newProviderCount: number;
  newModelCount: number;
};

const EMPTY_STATE: ListenerState = {
  active: false,
  providers: [],
  newProviderCount: 0,
  newModelCount: 0,
};

/**
 * Headless listener: converts "new providers available" events (cloud sync,
 * sign-in, local config changes) into a single coalesced notification center
 * entry instead of a popup. Accumulates until the entry is read, so repeated
 * syncs update one entry with the full summary.
 */
export function NewProvidersListener() {
  const [state, setState] = useState<ListenerState>(EMPTY_STATE);
  const [orgOnboardingVisible, setOrgOnboardingVisible] = useState(false);
  const [pendingProviders, setPendingProviders] = useState<NewProviderInfo[]>([]);

  const showProviders = useCallback((detail: NewProvidersEventDetail) => {
    const seen = readSeenProviderIds();
    const genuinelyNew = detail.providers.filter((p) => !seen.has(p.id));
    const newProviderCount = detail.newProviderCount ?? genuinelyNew.length;
    const newModelCount = detail.newModelCount ?? 0;
    if (genuinelyNew.length === 0 && newModelCount === 0) return;

    setState((prev) => ({
      active: true,
      providers: prev.active
        ? [...prev.providers, ...detail.providers.filter((p) => !prev.providers.some((e) => e.id === p.id))]
        : detail.providers,
      newProviderCount: prev.active
        ? prev.newProviderCount + newProviderCount
        : newProviderCount,
      newModelCount: prev.active
        ? prev.newModelCount + newModelCount
        : newModelCount,
    }));
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<NewProvidersEventDetail>).detail;
      if (detail.providers.length === 0 && !detail.newModelCount) return;
      if (orgOnboardingVisible) {
        setPendingProviders((current) => [
          ...current,
          ...detail.providers.filter((p) => !current.some((existing) => existing.id === p.id)),
        ]);
        return;
      }
      showProviders(detail);
    };
    window.addEventListener(newProvidersEvent, handler);
    return () => window.removeEventListener(newProvidersEvent, handler);
  }, [orgOnboardingVisible, showProviders]);

  useEffect(() => {
    const handler = (event: Event) => {
      setOrgOnboardingVisible(Boolean((event as CustomEvent<{ visible?: boolean }>).detail?.visible));
    };
    window.addEventListener(orgOnboardingVisibilityEvent, handler);
    return () => window.removeEventListener(orgOnboardingVisibilityEvent, handler);
  }, []);

  useEffect(() => {
    if (orgOnboardingVisible || pendingProviders.length === 0) return;
    showProviders({ providers: pendingProviders, source: "cloud_sync" });
    setPendingProviders([]);
  }, [orgOnboardingVisible, pendingProviders, showProviders]);

  // Write the accumulated summary into the notification center. The dedupe
  // key keeps one unread entry that absorbs repeated provider syncs.
  useEffect(() => {
    if (!state.active || (state.providers.length === 0 && state.newModelCount === 0)) {
      return;
    }

    markProvidersSeen(state.providers.map((p) => p.id));

    const parts: string[] = [];
    if (state.newProviderCount > 0) {
      parts.push(`${state.newProviderCount} new ${state.newProviderCount === 1 ? "provider" : "providers"}`);
    }
    if (state.newModelCount > 0) {
      parts.push(`${state.newModelCount} new ${state.newModelCount === 1 ? "model" : "models"}`);
    }
    const summary =
      parts.join(" & ") ||
      resolveProviderDisplayName(
        state.providers[0]?.name || state.providers[0]?.providerId || "Models",
      );

    notifyEvent({
      kind: "providers",
      severity: "info",
      dedupeKey: NEW_PROVIDERS_DEDUPE_KEY,
      title: `${summary} available`,
      action: {
        type: "open-model-picker",
        providerIds: state.providers.map((p) => p.id),
      },
      actionLabel: t("notifications.select_model"),
    });
  }, [state]);

  // Once the entry is read (or cleared), restart accumulation so the next
  // sync produces a fresh unread entry.
  useEffect(
    () =>
      useNotificationStore.subscribe((store) => {
        const unread = store.notifications.some(
          (notification) =>
            notification.dedupeKey === NEW_PROVIDERS_DEDUPE_KEY && notification.readAt === null,
        );
        if (!unread) {
          setState((prev) => (prev.active ? EMPTY_STATE : prev));
        }
      }),
    [],
  );

  return null;
}
