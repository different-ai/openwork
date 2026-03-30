import { DEFAULT_OPENWORK_PUBLISHER_BASE_URL } from "../lib/publisher";

export type BundleUrlTrust = {
  trusted: boolean;
  bundleId: string | null;
  actualOrigin: string | null;
  configuredOrigin: string | null;
};

export function extractBundleId(url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "b" && segments[1] && (segments.length === 2 || (segments.length === 3 && segments[2] === "data"))) {
    return segments[1];
  }
  return null;
}

export function resolveConfiguredBundlePublisherOrigin(baseUrl = DEFAULT_OPENWORK_PUBLISHER_BASE_URL): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

export function describeBundleUrlTrust(bundleUrl: string, baseUrl = DEFAULT_OPENWORK_PUBLISHER_BASE_URL): BundleUrlTrust {
  const configuredOrigin = resolveConfiguredBundlePublisherOrigin(baseUrl);
  try {
    const url = new URL(bundleUrl);
    const bundleId = extractBundleId(url);
    return {
      trusted: Boolean(configuredOrigin && url.origin === configuredOrigin && bundleId),
      bundleId,
      actualOrigin: url.origin,
      configuredOrigin,
    };
  } catch {
    return {
      trusted: false,
      bundleId: null,
      actualOrigin: null,
      configuredOrigin,
    };
  }
}

export function isConfiguredBundlePublisherUrl(bundleUrl: string, baseUrl = DEFAULT_OPENWORK_PUBLISHER_BASE_URL): boolean {
  return describeBundleUrlTrust(bundleUrl, baseUrl).trusted;
}
