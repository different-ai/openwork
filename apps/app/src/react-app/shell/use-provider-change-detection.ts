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
    recommendedModelId?: string;
    recommendedModel?: string;
  }>;
};

export type ProviderToastState = {
  show: boolean;
  providerName: string;
  providerId: string;
  modelId?: string;
  modelName?: string;
};

type ProviderInfo = {
  id: string;
  name?: string;
  models?: Record<string, { name?: string }>;
};

/**
 * Pick a model to surface for a provider in the onboarding/toast UI.
 *
 * NOTE: This is positional, not a recommendation. We pick the FIRST model
 * in `provider.models` (insertion order from the provider's declaration).
 * There is no Den API for "team recommended model" — if we ever want one,
 * it has to come from the cloud org config, not the local OpenCode SDK
 * (which only exposes the workspace's runtime default, a different concept).
 */
function pickFirstModel(
  provider: ProviderInfo | undefined,
): { id: string | undefined; name: string | undefined } {
  if (!provider?.models) return { id: undefined, name: undefined };
  const id = Object.keys(provider.models)[0];
  if (!id) return { id: undefined, name: undefined };
  const name = provider.models[id]?.name ?? resolveModelDisplayName(id);
  return { id, name };
}

/**
 * Detects new providers by comparing the current connected list against
 * a localStorage "acknowledged" set. Returns notification state for
 * the onboarding modal and new-provider toast.
 *
 * - `enabled=false` (e.g. signed out) disables all notifications. This
 *   prevents the onboarding modal from triggering after sign-out when
 *   `acknowledgedProviders` was cleared but local providers (openai,
 *   opencode) remain.
 */
export function useProviderChangeDetection(
  connectedProviderIds: string[],
  providers: ProviderInfo[],
  enabled: boolean = true,
) {
  const [onboarding, setOnboarding] = useState<ProviderOnboardingState>({ show: false, providers: [] });
  const [toast, setToast] = useState<ProviderToastState>({ show: false, providerName: "", providerId: "", modelId: undefined });
  const shownRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
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
        const picked = pickFirstModel(provider);
        return {
          id,
          name: provider?.name ?? resolveProviderDisplayName(id),
          recommended: false as boolean,
          recommendedModelId: picked.id,
          recommendedModel: picked.name,
        };
      });
      // Mark the first one as the default-action target (used by the
      // "Use {model}" button). Positional only, not a quality signal.
      if (onboardingProviders.length > 0) {
        onboardingProviders[0].recommended = true;
      }
      shownRef.current = true;
      setOnboarding({ show: true, providers: onboardingProviders });
    } else {
      // Already had providers, show toast for the first new one
      const newId = newIds[0];
      const provider = providers.find((p) => p.id === newId);
      const picked = pickFirstModel(provider);
      shownRef.current = true;
      setToast({
        show: true,
        providerName: provider?.name ?? resolveProviderDisplayName(newId),
        providerId: newId,
        modelId: picked.id,
        modelName: picked.name,
      });
    }
  }, [connectedProviderIds, providers, enabled]);

  // Reset the "shown this session" gate when sign-out clears the
  // acknowledged list, so the next sign-in can show notifications again.
  useEffect(() => {
    if (!enabled) {
      shownRef.current = false;
      setOnboarding({ show: false, providers: [] });
      setToast({ show: false, providerName: "", providerId: "", modelId: undefined });
    }
  }, [enabled]);

  const acknowledgeAll = useCallback(() => {
    writeAcknowledged(connectedProviderIds);
    setOnboarding({ show: false, providers: [] });
    setToast({ show: false, providerName: "", providerId: "", modelId: undefined });
  }, [connectedProviderIds]);

  const dismissOnboarding = useCallback(() => {
    writeAcknowledged(connectedProviderIds);
    setOnboarding({ show: false, providers: [] });
  }, [connectedProviderIds]);

  const dismissToast = useCallback(() => {
    writeAcknowledged(connectedProviderIds);
    setToast({ show: false, providerName: "", providerId: "", modelId: undefined });
  }, [connectedProviderIds]);

  return {
    onboarding,
    toast,
    acknowledgeAll,
    dismissOnboarding,
    dismissToast,
  };
}
