export const deepLinkBridgeEvent = "openwork:deep-link";
export const nativeDeepLinkEvent = "openwork:deep-link-native";
export const deepLinkDebugEvent = "openwork:deep-link-debug";

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

let eventModulePromise: Promise<typeof import("@tauri-apps/api/event") | null> | null = null;

export function logDeepLinkBoundary(message: string, details?: unknown) {
  const prefix = `[issue-1022][bridge] ${message}`;
  if (details === undefined) {
    console.log(prefix);
  } else {
    console.log(prefix, details);
  }

  if (typeof window === "undefined") {
    return;
  }

  eventModulePromise ??= import("@tauri-apps/api/event").catch(() => null);
  void eventModulePromise.then((eventModule) => {
    if (!eventModule) {
      return;
    }

    void eventModule
      .emit(deepLinkDebugEvent, {
        message,
        details: details ?? null,
      })
      .catch(() => undefined);
  });
}
