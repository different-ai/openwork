export const deepLinkBridgeEvent = "openwork:deep-link";
export const nativeDeepLinkEvent = "openwork:deep-link-native";

export type DeepLinkBridgeDetail = {
  urls: string[];
};

declare global {
  interface Window {
    __OPENWORK__?: {
      deepLinks?: string[];
    };
  }
}

function normalizeDeepLinks(urls: readonly string[]): string[] {
  return urls.map((url) => url.trim()).filter(Boolean);
}

export function pushPendingDeepLinks(target: Window, urls: readonly string[]): string[] {
  const normalized = normalizeDeepLinks(urls);
  if (normalized.length === 0) {
    return [];
  }

  target.__OPENWORK__ ??= {};
  const pending = target.__OPENWORK__.deepLinks ?? [];
  target.__OPENWORK__.deepLinks = [...pending, ...normalized];
  target.dispatchEvent(
    new CustomEvent<DeepLinkBridgeDetail>(deepLinkBridgeEvent, {
      detail: { urls: normalized },
    }),
  );
  return normalized;
}

export function drainPendingDeepLinks(target: Window): string[] {
  const pending = target.__OPENWORK__?.deepLinks ?? [];
  if (target.__OPENWORK__) {
    target.__OPENWORK__.deepLinks = [];
  }
  return [...pending];
}
