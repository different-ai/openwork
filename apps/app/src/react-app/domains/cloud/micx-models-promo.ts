import { INFERENCE_MODEL_ALIASES } from "@micx/types/den/inference";

import {
  buildDenAuthUrl,
  getDenInferenceUrl,
  isSelfHostedControlPlane,
  HOSTED_DEFAULT_DEN_BASE_URL,
  readDenBootstrapConfig,
  readDenSettings,
} from "../../../app/lib/den";
import { isDefaultControlPlaneUrl } from "../settings/cloud/control-plane-url";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import { useSyncExternalStore } from "react";

export const MICX_MODELS_PROVIDER_ID = "micx";
export const MICX_MODELS_PROVIDER_NAME = "Micx Models";
export const MICX_MODELS_PROMO_HIDDEN_KEY = "micx.micxModelsPromo.hidden";
export const MICX_MODELS_PROMO_LAST_SHOWN_KEY = "micx.micxModelsPromo.lastShownAt";
export const MICX_MODELS_STARTUP_PROMO_SHOWN_KEY = "micx.micxModelsPromo.startupShown";
export const micxWorkModelsPromoChangedEvent = "micx-micx-models-promo-changed";
export const MICX_MODELS_PROMO_SHOW_DELAY_MS = 4_000;
export const MICX_MODELS_PROMO_VISIBLE_MS = 14_000;
export const MICX_MODELS_PROMO_REPEAT_MS = 6 * 60 * 60 * 1000;

export function areMicxModelsPromosDisabled() {
  if (/^(1|true|yes|on)$/i.test(String(import.meta.env.VITE_DISABLE_MICX_MODELS ?? "").trim())) {
    return true;
  }
  // Micx Models are a hosted Micx Cloud offering; self-hosted
  // deployments should never see the upsell surfaces.
  return isSelfHostedControlPlane();
}

export function isMicxModelsPromoEligibleForDenBaseUrl(baseUrl: string) {
  return !areMicxModelsPromosDisabled() && isDefaultControlPlaneUrl(baseUrl, HOSTED_DEFAULT_DEN_BASE_URL);
}

export function isMicxModelsPromoEligible() {
  return isMicxModelsPromoEligibleForDenBaseUrl(readDenSettings().baseUrl);
}

export function useMicxModelsPromoEligibility() {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined") return () => undefined;
      window.addEventListener(denSettingsChangedEvent, notify);
      return () => window.removeEventListener(denSettingsChangedEvent, notify);
    },
    isMicxModelsPromoEligible,
    isMicxModelsPromoEligible,
  );
}

export type MicxModelPreview = {
  id: string;
  title: string;
  subtitle: string;
};

export const MICX_MODEL_PREVIEWS: MicxModelPreview[] = Object.entries(
  INFERENCE_MODEL_ALIASES,
)
  .filter(([, model]) => model.enabled)
  .map(([id, model]) => ({
    id,
    title: model.displayName.replace(/^Micx:\s*/, ""),
    subtitle: "Micx hosted",
  }));

export function hasMicxModelsProvider(providerIds: readonly string[]) {
  return providerIds.some((id) => id.trim().toLowerCase() === MICX_MODELS_PROVIDER_ID);
}

/** Local engine has Micx Models connected with at least one selectable model. */
export function hasMicxModelsAvailable(input: {
  providerConnectedIds: readonly string[];
  providers: ReadonlyArray<{ id: string; models?: Record<string, unknown> | null }>;
}) {
  if (!hasMicxModelsProvider(input.providerConnectedIds)) return false;
  const micx = input.providers.find(
    (provider) => provider.id.trim().toLowerCase() === MICX_MODELS_PROVIDER_ID,
  );
  return Object.keys(micx?.models ?? {}).length > 0;
}

export function getMicxModelsActionUrl(
  isSignedIn: boolean,
  authMode: "sign-in" | "sign-up" = "sign-in",
) {
  const settings = readDenSettings();
  const baseUrl = settings.baseUrl || readDenBootstrapConfig().baseUrl;
  // Signed-in users go straight to the Micx Models page — the value-prop
  // + subscribe surface — never to a bare auth or billing page.
  return isSignedIn ? getDenInferenceUrl(baseUrl) : buildDenAuthUrl(baseUrl, authMode);
}

export function isMicxModelsPromoHidden() {
  if (areMicxModelsPromosDisabled()) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MICX_MODELS_PROMO_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function hideMicxModelsPromo() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MICX_MODELS_PROMO_HIDDEN_KEY, "1");
    window.dispatchEvent(new Event(micxWorkModelsPromoChangedEvent));
  } catch {}
}

export function wasMicxModelsStartupPromoShown() {
  if (!isMicxModelsPromoEligible()) return true;
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(MICX_MODELS_STARTUP_PROMO_SHOWN_KEY) === "1";
  } catch {
    return true;
  }
}

export function markMicxModelsStartupPromoShown() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MICX_MODELS_STARTUP_PROMO_SHOWN_KEY, "1");
  } catch {}
}

export function shouldShowMicxModelsPromo(now = Date.now()) {
  if (!isMicxModelsPromoEligible() || typeof window === "undefined" || isMicxModelsPromoHidden()) return false;
  try {
    const lastShown = Number(window.localStorage.getItem(MICX_MODELS_PROMO_LAST_SHOWN_KEY) ?? "0");
    return !Number.isFinite(lastShown) || now - lastShown >= MICX_MODELS_PROMO_REPEAT_MS;
  } catch {
    return true;
  }
}

export function markMicxModelsPromoShown(now = Date.now()) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MICX_MODELS_PROMO_LAST_SHOWN_KEY, String(now));
  } catch {}
}
