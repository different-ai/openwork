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
import { orgOnboardingVisibilityEvent } from "./reload-coordinator";

const SEEN_KEY = "openwork.seenProviderIds";
const PENDING_MODEL_PICKER_KEY = "openwork.pendingModelPickerProviderIds";

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

type ToastState = {
  show: boolean;
  providers: NewProviderInfo[];
  newProviderCount: number;
  newModelCount: number;
};

/**
 * Minimal global toast: lists new providers, offers to open the model
 * picker so the user can change their default if they want.
 */
export function NewProvidersToast() {
  const [state, setState] = useState<ToastState>({
    show: false,
    providers: [],
    newProviderCount: 0,
    newModelCount: 0,
  });
  const [orgOnboardingVisible, setOrgOnboardingVisible] = useState(false);
  const [pendingProviders, setPendingProviders] = useState<NewProviderInfo[]>([]);

  const showProviders = useCallback((detail: NewProvidersEventDetail) => {
    const seen = readSeenProviderIds();
    const genuinelyNew = detail.providers.filter((p) => !seen.has(p.id));
    const newProviderCount = detail.newProviderCount ?? genuinelyNew.length;
    const newModelCount = detail.newModelCount ?? 0;
    if (genuinelyNew.length === 0 && newModelCount === 0) return;

    setState((prev) => ({
      show: true,
      providers: prev.show
        ? [...prev.providers, ...detail.providers.filter((p) => !prev.providers.some((e) => e.id === p.id))]
        : detail.providers,
      newProviderCount: prev.show
        ? prev.newProviderCount + newProviderCount
        : newProviderCount,
      newModelCount: prev.show
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

  const dismiss = useCallback(() => {
    markProvidersSeen(state.providers.map((p) => p.id));
    setState({ show: false, providers: [], newProviderCount: 0, newModelCount: 0 });
  }, [state.providers]);

  const pickDefault = useCallback(() => {
    const ids = state.providers.map((p) => p.id);
    markProvidersSeen(ids);
    setState({ show: false, providers: [], newProviderCount: 0, newModelCount: 0 });
    try {
      window.localStorage.setItem(
        PENDING_MODEL_PICKER_KEY,
        JSON.stringify({ newProviderIds: ids, initialTab: "available" }),
      );
    } catch {}
    window.dispatchEvent(new CustomEvent(openModelPickerEvent, { detail: { newProviderIds: ids, initialTab: "available" } }));
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
  }, [state.providers]);

  if (!state.show || (state.providers.length === 0 && state.newModelCount === 0)) return null;

  const message = (() => {
    const parts: string[] = [];
    if (state.newProviderCount > 0) {
      parts.push(`${state.newProviderCount} new ${state.newProviderCount === 1 ? "provider" : "providers"}`);
    }
    if (state.newModelCount > 0) {
      parts.push(`${state.newModelCount} new ${state.newModelCount === 1 ? "model" : "models"}`);
    }
    return parts.join(" & ");
  })();

  return (
    <div className="fixed bottom-6 left-1/2 z-[9999] -translate-x-1/2 animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="flex items-center gap-4 rounded-2xl border border-dls-border bg-dls-surface px-5 py-3.5 shadow-lg">
        <div className="flex items-center gap-2">
          {state.providers.slice(0, 6).map((p) => (
            <ProviderIcon key={p.id} providerId={p.providerId} providerName={p.name} size={16} className="text-dls-text" />
          ))}
        </div>

        <div className="min-w-0 text-[13px] text-dls-text">
          <span className="font-medium">{message || resolveProviderDisplayName(state.providers[0]?.name || state.providers[0]?.providerId || "Models")}</span>
          {" "}available.{" "}
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
