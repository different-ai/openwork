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

const SEEN_KEY = "openwork.seenProviderIds";

/** Custom event to request the model picker to open. */
export const openModelPickerEvent = "openwork-open-model-picker";

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

type ToastState = {
  show: boolean;
  providers: NewProviderInfo[];
};

/**
 * Minimal global toast: lists new providers, offers to open the model
 * picker so the user can change their default if they want.
 */
export function NewProvidersToast() {
  const [state, setState] = useState<ToastState>({ show: false, providers: [] });

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<NewProvidersEventDetail>).detail;
      if (detail.source === "sign_in") return;
      if (detail.providers.length === 0) return;

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

  const pickDefault = useCallback(() => {
    const ids = state.providers.map((p) => p.id);
    markProvidersSeen(ids);
    setState({ show: false, providers: [] });
    // Pass the new provider IDs so the picker can highlight them as
    // "Recently added" even though they were just marked as seen.
    window.dispatchEvent(new CustomEvent(openModelPickerEvent, { detail: { newProviderIds: ids } }));
  }, [state.providers]);

  if (!state.show || state.providers.length === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 z-[9999] -translate-x-1/2 animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="flex items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface px-5 py-3.5 shadow-lg">
        <div className="flex items-center gap-2">
          {state.providers.map((p) => (
            <ProviderIcon key={p.id} providerId={p.providerId} providerName={p.name} size={16} className="text-dls-text" />
          ))}
        </div>

        <div className="min-w-0 text-[13px] text-dls-text">
          <span className="font-medium">
            {state.providers.length === 1
              ? resolveProviderDisplayName(state.providers[0].name || state.providers[0].providerId)
              : `${state.providers.length} new providers`}
          </span>
          {" "}added.{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2 transition-colors hover:text-dls-text/80"
            onClick={pickDefault}
          >
            Pick a new default?
          </button>
        </div>

        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
          onClick={dismiss}
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
