/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { Cloud, X } from "lucide-react";
import { resolveProviderDisplayName } from "../../app/utils";
import { ProviderIcon } from "../design-system/provider-icon";
import { writeStoredDefaultModel } from "../kernel/model-config";

type ImportedProvider = {
  id: string;
  name: string;
  providerId: string;
  firstModelId?: string;
  firstModelName?: string;
};

type ToastState = {
  show: boolean;
  providers: ImportedProvider[];
};

/**
 * Global toast that appears when new cloud providers are imported
 * (via the provider auth store's sync). Shows regardless of which
 * route is active (session, settings, etc.).
 *
 * Batches multiple providers into a single notification.
 * Offers "Set as default" for the first provider with a model.
 */
export function CloudProvidersToast() {
  const [state, setState] = useState<ToastState>({ show: false, providers: [] });

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ providers: ImportedProvider[]; reason: string }>).detail;
      // Don't show toast on sign_in — the onboarding page handles that.
      // Only show for interval/app_launch/settings_cloud_opened syncs
      // (i.e., admin added a new provider while user is already working).
      if (detail.reason === "sign_in") return;
      if (detail.providers.length === 0) return;
      setState({ show: true, providers: detail.providers });
    };
    window.addEventListener("openwork-cloud-providers-imported", handler);
    return () => window.removeEventListener("openwork-cloud-providers-imported", handler);
  }, []);

  const dismiss = useCallback(() => {
    setState({ show: false, providers: [] });
  }, []);

  const setAsDefault = useCallback((provider: ImportedProvider) => {
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
          <Cloud size={18} className="text-dls-text" />
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
