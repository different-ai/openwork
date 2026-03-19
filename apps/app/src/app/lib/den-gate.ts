import {
  ENV_DEN_BASE_URL,
  normalizeDenBaseUrl,
  readStoredDenBaseUrls,
  resolveDenBaseUrls,
} from "./den";

export const DEN_CONFIG_UPDATED_EVENT = "openwork-den-config-updated";

export type DenFeatureConfigSource = "env" | "override" | "none";

export type DenFeatureGate = {
  enabled: boolean;
  source: DenFeatureConfigSource;
  baseUrl: string | null;
  apiBaseUrl: string | null;
  envBaseUrl: string | null;
  overrideBaseUrl: string | null;
  canConfigureInDeveloperMode: boolean;
};

export function canConfigureDenBaseUrlOverride(developerMode: boolean): boolean {
  return developerMode && !ENV_DEN_BASE_URL;
}

export function readDenFeatureGate(developerMode: boolean): DenFeatureGate {
  if (ENV_DEN_BASE_URL) {
    const resolved = resolveDenBaseUrls(ENV_DEN_BASE_URL);
    return {
      enabled: true,
      source: "env",
      baseUrl: resolved.baseUrl,
      apiBaseUrl: resolved.apiBaseUrl,
      envBaseUrl: resolved.baseUrl,
      overrideBaseUrl: readStoredDenBaseUrlOverride(),
      canConfigureInDeveloperMode: false,
    };
  }

  const stored = readStoredDenBaseUrls();
  const overrideBaseUrl = stored.baseUrl ?? normalizeDenBaseUrl(stored.apiBaseUrl);
  if (overrideBaseUrl) {
    const resolved = resolveDenBaseUrls({
      baseUrl: overrideBaseUrl,
      apiBaseUrl: stored.apiBaseUrl,
    });
    return {
      enabled: true,
      source: "override",
      baseUrl: resolved.baseUrl,
      apiBaseUrl: resolved.apiBaseUrl,
      envBaseUrl: null,
      overrideBaseUrl: resolved.baseUrl,
      canConfigureInDeveloperMode: canConfigureDenBaseUrlOverride(developerMode),
    };
  }

  return {
    enabled: false,
    source: "none",
    baseUrl: null,
    apiBaseUrl: null,
    envBaseUrl: null,
    overrideBaseUrl: null,
    canConfigureInDeveloperMode: canConfigureDenBaseUrlOverride(developerMode),
  };
}

export function readStoredDenBaseUrlOverride(): string | null {
  const stored = readStoredDenBaseUrls();
  return stored.baseUrl ?? normalizeDenBaseUrl(stored.apiBaseUrl);
}

export function dispatchDenConfigUpdated(detail?: {
  source?: DenFeatureConfigSource;
  baseUrl?: string | null;
  enabled?: boolean;
}) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(DEN_CONFIG_UPDATED_EVENT, {
      detail,
    }),
  );
}
