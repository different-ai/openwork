/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveModelDisplayName, resolveProviderDisplayName } from "../../app/utils";

const STORAGE_KEY = "openwork.acknowledgedProviders";

function readAcknowledged(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeAcknowledged(ids: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {}
}

export type ProviderOnboardingState = {
  show: boolean;
  providers: Array<{
    id: string;
    name: string;
    recommended?: boolean;
    recommendedModel?: string;
  }>;
};

export type ProviderToastState = {
  show: boolean;
  providerName: string;
  providerId: string;
  modelName?: string;
};

type ProviderInfo = {
  id: string;
  name?: string;
  models?: Record<string, { name?: string }>;
};

/**
 * Detects new providers by comparing the current connected list against
 * a localStorage "acknowledged" set. Returns notification state for
 * the onboarding modal and new-provider toast.
 */
export function useProviderChangeDetection(
  connectedProviderIds: string[],
  providers: ProviderInfo[],
) {
  const [onboarding, setOnboarding] = useState<ProviderOnboardingState>({ show: false, providers: [] });
  const [toast, setToast] = useState<ProviderToastState>({ show: false, providerName: "", providerId: "" });
  const shownRef = useRef(false);

  useEffect(() => {
    if (connectedProviderIds.length === 0) return;
    // Once we've shown a notification this session, don't show again
    // (user can dismiss and it won't re-appear until next new provider)
    if (shownRef.current) return;

    const acknowledged = readAcknowledged();
    const newIds = connectedProviderIds.filter((id) => !acknowledged.includes(id));

    if (newIds.length === 0) return;

    if (acknowledged.length === 0) {
      // First time seeing any providers -- show onboarding modal
      const onboardingProviders = newIds.map((id) => {
        const provider = providers.find((p) => p.id === id);
        const firstModelId = provider?.models ? Object.keys(provider.models)[0] : undefined;
        const firstModelName = firstModelId
          ? provider?.models?.[firstModelId]?.name ?? resolveModelDisplayName(firstModelId)
          : undefined;
        return {
          id,
          name: provider?.name ?? resolveProviderDisplayName(id),
          recommendedModel: firstModelName,
        };
      });
      // Mark the first one as recommended
      if (onboardingProviders.length > 0) {
        onboardingProviders[0].recommended = true;
      }
      shownRef.current = true;
      setOnboarding({ show: true, providers: onboardingProviders });
    } else {
      // Already had providers, show toast for the first new one
      const newId = newIds[0];
      const provider = providers.find((p) => p.id === newId);
      const firstModelId = provider?.models ? Object.keys(provider.models)[0] : undefined;
      const modelName = firstModelId
        ? provider?.models?.[firstModelId]?.name ?? resolveModelDisplayName(firstModelId)
        : undefined;
      shownRef.current = true;
      setToast({
        show: true,
        providerName: provider?.name ?? resolveProviderDisplayName(newId),
        providerId: newId,
        modelName,
      });
    }
  }, [connectedProviderIds, providers]);

  const acknowledgeAll = useCallback(() => {
    writeAcknowledged(connectedProviderIds);
    setOnboarding({ show: false, providers: [] });
    setToast({ show: false, providerName: "", providerId: "" });
  }, [connectedProviderIds]);

  const dismissOnboarding = useCallback(() => {
    writeAcknowledged(connectedProviderIds);
    setOnboarding({ show: false, providers: [] });
  }, [connectedProviderIds]);

  const dismissToast = useCallback(() => {
    writeAcknowledged(connectedProviderIds);
    setToast({ show: false, providerName: "", providerId: "" });
  }, [connectedProviderIds]);

  return {
    onboarding,
    toast,
    acknowledgeAll,
    dismissOnboarding,
    dismissToast,
  };
}
