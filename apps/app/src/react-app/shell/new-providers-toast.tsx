/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { Zap, X } from "lucide-react";
import { resolveProviderDisplayName } from "../../app/utils";
import {
  newProvidersEvent,
  type NewProviderInfo,
  type NewProvidersEventDetail,
} from "../../app/lib/provider-events";
import { ProviderIcon } from "../design-system/provider-icon";
import { writeStoredDefaultModel } from "../kernel/model-config";

type ToastState = {
  show: boolean;
  providers: NewProviderInfo[];
};

/**
 * Global toast shown when new providers become available — whether from
 * cloud sync, local config, or any other source. Renders at app-root
 * level so it appears regardless of which route is active.
 *
 * Batches multiple providers into a single notification.
 * Offers "Set as default" for the first provider with a model.
 */
export function NewProvidersToast() {
  const [state, setState] = useState<ToastState>({ show: false, providers: [] });

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<NewProvidersEventDetail>).detail;
      // Don't show on sign_in — the onboarding page handles that.
      if (detail.source === "sign_in") return;
      if (detail.providers.length === 0) return;
      setState((prev) => ({
        show: true,
        // Append to existing batch if toast is already visible
        providers: prev.show
          ? [...prev.providers, ...detail.providers.filter((p) => !prev.providers.some((e) => e.id === p.id))]
          : detail.providers,
      }));
    };
    window.addEventListener(newProvidersEvent, handler);
    return () => window.removeEventListener(newProvidersEvent, handler);
  }, []);

  const dismiss = useCallback(() => {
    setState({ show: false, providers: [] });
  }, []);

  const setAsDefault = useCallback((provider: NewProviderInfo) => {
    if (provider.firstModelId) {
      writeStoredDefaultModel({
        providerID: provider.id.trim(),
        modelID: provider.firstModelId,
      });
    }
    setState({ show: false, providers: [] });
  }, []);

  if (!state.show || state.providers.length === 0) return null;

  const defaultCandidate = state.providers.find((p) => p.firstModelId);

  return (
    <div className="fixed bottom-6 left-1/2 z-[9999] -translate-x-1/2 animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="flex items-start gap-3 rounded-2xl border border-dls-border bg-dls-surface px-5 py-4 shadow-lg">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-dls-hover">
          <Zap size={18} className="text-dls-text" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-dls-text">
            {state.providers.length === 1
              ? "New provider available"
              : `${state.providers.length} new providers available`}
          </div>
          <div className="mt-1 space-y-1">
            {state.providers.map((p) => (
              <div key={p.id} className="flex items-center gap-2 text-xs text-dls-secondary">
                <ProviderIcon providerId={p.providerId} providerName={p.name} size={14} className="text-dls-secondary" />
                <span>{resolveProviderDisplayName(p.name || p.providerId)}</span>
                {p.firstModelName ? (
                  <span className="font-mono text-[10px] text-dls-secondary/70">{p.firstModelName}</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {defaultCandidate ? (
            <button
              type="button"
              className="rounded-full bg-dls-accent px-3 py-1.5 text-[11px] font-semibold text-[var(--dls-accent-fg)] transition-colors hover:bg-[var(--dls-accent-hover)]"
              onClick={() => setAsDefault(defaultCandidate)}
            >
              Set as default
            </button>
          ) : null}
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            onClick={dismiss}
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
