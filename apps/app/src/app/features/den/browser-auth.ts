import { normalizeDenBaseUrl, resolveDenBaseUrls } from "../../lib/den";

type DenAuthMode = "sign-in" | "sign-up";

function appHostedCloudBaseUrl(): URL | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const current = new URL(window.location.href);
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      return null;
    }
    return new URL("/cloud", current.origin);
  } catch {
    return null;
  }
}

export function buildDenBrowserAuthUrl(input: {
  baseUrl: string;
  mode: DenAuthMode;
  desktopAuth?: boolean;
  desktopScheme?: string | null;
}): string {
  const hosted = appHostedCloudBaseUrl();
  const normalizedBaseUrl = normalizeDenBaseUrl(input.baseUrl);

  if (hosted) {
    hosted.searchParams.set("mode", input.mode);
    if (input.desktopAuth) {
      hosted.searchParams.set("desktopAuth", "1");
      hosted.searchParams.set("desktopScheme", input.desktopScheme?.trim() || "openwork");
    }
    if (normalizedBaseUrl) {
      hosted.searchParams.set("denBaseUrl", normalizedBaseUrl);
    }
    return hosted.toString();
  }

  const fallback = new URL(resolveDenBaseUrls(input.baseUrl).baseUrl);
  fallback.searchParams.set("mode", input.mode);
  if (input.desktopAuth) {
    fallback.searchParams.set("desktopAuth", "1");
    fallback.searchParams.set("desktopScheme", input.desktopScheme?.trim() || "openwork");
  }
  return fallback.toString();
}

export function buildDenSocialCallbackUrl(mode: DenAuthMode): string | null {
  const hosted = appHostedCloudBaseUrl();
  if (!hosted) {
    return null;
  }
  hosted.searchParams.set("mode", mode);
  return hosted.toString();
}
