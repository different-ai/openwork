import {
  DEFAULT_DEN_BASE_URL,
  normalizeDenBaseUrl,
  readDenBootstrapConfig,
  resolveDenBaseUrls,
  setDenBootstrapConfig,
  writeDenSettings,
} from "@/app/lib/den";

export function isValidControlPlaneUrl(value: string) {
  return normalizeDenBaseUrl(value) !== null;
}

export function isDefaultControlPlaneUrl(value: string, defaultBaseUrl = DEFAULT_DEN_BASE_URL) {
  const normalized = normalizeDenBaseUrl(value);
  if (!normalized) return value.trim().length === 0;
  return resolveDenBaseUrls(normalized).baseUrl === resolveDenBaseUrls(defaultBaseUrl).baseUrl;
}

export function displayCustomControlPlaneUrl(value: string) {
  const normalized = normalizeDenBaseUrl(value);
  if (!normalized) return value;
  return isDefaultControlPlaneUrl(normalized) ? "" : resolveDenBaseUrls(normalized).baseUrl;
}

export function formatControlPlaneHost(value: string) {
  const baseUrl = resolveDenBaseUrls(value).baseUrl;
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export async function saveControlPlaneUrl(value: string) {
  const normalized = normalizeDenBaseUrl(value);
  if (!normalized) return null;

  const resolved = resolveDenBaseUrls(normalized);
  const bootstrap = readDenBootstrapConfig();
  const persisted = await setDenBootstrapConfig({
    baseUrl: resolved.baseUrl,
    requireSignin: bootstrap.requireSignin,
  });

  writeDenSettings(
    {
      baseUrl: persisted.baseUrl,
      authToken: null,
      activeOrgId: null,
      activeOrgSlug: null,
      activeOrgName: null,
    },
    { persistBootstrap: false },
  );

  return persisted;
}

export function defaultControlPlaneUrl() {
  return resolveDenBaseUrls(DEFAULT_DEN_BASE_URL).baseUrl;
}
