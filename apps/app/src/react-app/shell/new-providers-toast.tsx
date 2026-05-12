/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { Zap, X } from "lucide-react";
import { resolveModelDisplayName, resolveProviderDisplayName } from "../../app/utils";
import {
  newProvidersEvent,
  type NewProviderInfo,
  type NewProvidersEventDetail,
} from "../../app/lib/provider-events";
import { ProviderIcon } from "../design-system/provider-icon";
import { writeStoredDefaultModel } from "../kernel/model-config";

const SEEN_KEY = "openwork.seenProviderIds";

/** Read provider IDs the user has already been notified about. */
function readSeenProviderIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

/** Mark provider IDs as seen so the toast won't fire for them again. */
function markProvidersSeen(ids: string[]): void {
  try {
    const existing = readSeenProviderIds();
    for (const id of ids) existing.add(id);
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...existing]));
  } catch {}
}

type ToastState = {
  show: boolean;
  providers: NewProviderInfo[];
};

/**
 * Global toast shown when genuinely NEW providers become available.
 * Uses a localStorage set of "seen" provider IDs to avoid re-firing
 * for providers the user was already notified about (e.g. on every
 * periodic sync or app launch).
 *
 * Each provider row has its own "Use as default" button so the user
 * can pick which one.
 */
export function NewProvidersToast() {
  const [state, setState] = useState<ToastState>({ show: false, providers: [] });

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<NewProvidersEventDetail>).detail;
      // Don't show on sign_in — the onboarding page handles that.
      if (detail.source === "sign_in") return;
      if (detail.providers.length === 0) return;

      // Filter out providers the user has already been notified about.
      const seen = readSeenProviderIds();
      const genuinelyNew = detail.providers.filter((p) => !seen.has(p.id));
      if (genuinelyNew.length === 0) return;

      setState((prev) => ({
        show: true,
        providers: prev.show
          ? [...prev.providers, ...genuinelyNew.filter((p) => !prev.providers.some((e) => e.id === p.id))]
          : genuinelyNew,
      }));
    };
    window.addEventListener(newProvidersEvent, handler);
    return () => window.removeEventListener(newProvidersEvent, handler);
  }, []);

  const dismiss = useCallback(() => {
    markProvidersSeen(state.providers.map((p) => p.id));
    setState({ show: false, providers: [] });
  }, [state.providers]);

  const setAsDefault = useCallback((provider: NewProviderInfo) => {
    if (provider.firstModelId) {
      writeStoredDefaultModel({
        providerID: provider.id.trim(),
        modelID: provider.firstModelId,
      });
    }
    markProvidersSeen(state.providers.map((p) => p.id));
    setState({ show: false, providers: [] });
  }, [state.providers]);

  if (!state.show || state.providers.length === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 z-[9999] -translate-x-1/2 animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="flex max-w-md flex-col gap-3 rounded-2xl border border-dls-border bg-dls-surface px-5 py-4 shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-dls-text" />
            <span className="text-[13px] font-medium text-dls-text">
              {state.providers.length === 1
                ? "New provider available"
                : `${state.providers.length} new providers available`}
            </span>
          </div>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            onClick={dismiss}
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>

        {/* Provider rows with per-provider "Use as default" */}
        <div className="space-y-1.5">
          {state.providers.map((p) => (
            <div key={p.id} className="flex items-center gap-2">
              <ProviderIcon providerId={p.providerId} providerName={p.name} size={14} className="shrink-0 text-dls-secondary" />
              <span className="min-w-0 flex-1 truncate text-xs text-dls-text">
                {resolveProviderDisplayName(p.name || p.providerId)}
                {p.firstModelName ? (
                  <span className="ml-1.5 font-mono text-[10px] text-dls-secondary">{p.firstModelName}</span>
                ) : null}
              </span>
              {p.firstModelId ? (
                <button
                  type="button"
                  className="shrink-0 rounded-full border border-dls-border px-2.5 py-0.5 text-[10px] font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                  onClick={() => setAsDefault(p)}
                >
                  Use as default
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
