/** @jsxImportSource react */
import { createContext, use, useEffect, useState, type ReactNode } from "react";

import {
  browserHandoffRequiredEvent,
  openBrowserUrlWithGlobalFallback,
  type BrowserHandoffRequiredDetail,
} from "../../app/lib/browser-handoff";
import { desktopNotificationShow, relaunchDesktopApp } from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";
import { BrowserHandoffFallback } from "../../components/browser-handoff-fallback";

export type SyncStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type AsyncStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type Platform = {
  platform: "web" | "desktop";
  os?: "macos" | "windows" | "linux";
  version?: string;
  openLink(url: string): void;
  restart(): Promise<void>;
  notify(title: string, description?: string, href?: string): Promise<void>;
  storage?: (name?: string) => SyncStorage | AsyncStorage;
  checkUpdate?: () => Promise<{ updateAvailable: boolean; version?: string }>;
  update?: () => Promise<void>;
  fetch?: typeof fetch;
  getDefaultServerUrl?: () => Promise<string | null>;
  setDefaultServerUrl?: (url: string | null) => Promise<void>;
};

const PlatformContext = createContext<Platform | undefined>(undefined);

type PlatformProviderProps = {
  value: Platform;
  children: ReactNode;
};

export function PlatformProvider({ value, children }: PlatformProviderProps) {
  const [browserHandoff, setBrowserHandoff] = useState<BrowserHandoffRequiredDetail | null>(null);

  useEffect(() => {
    const handleBrowserHandoff = (event: Event) => {
      setBrowserHandoff((event as CustomEvent<BrowserHandoffRequiredDetail>).detail);
    };
    window.addEventListener(browserHandoffRequiredEvent, handleBrowserHandoff);
    return () => window.removeEventListener(browserHandoffRequiredEvent, handleBrowserHandoff);
  }, []);

  return (
    <PlatformContext.Provider value={value}>
      {children}
      {browserHandoff ? (
        <div className="fixed inset-x-4 bottom-4 z-[250] ml-auto max-w-2xl">
          <button
            type="button"
            aria-label="Dismiss browser link"
            className="absolute right-2 top-2 z-10 rounded-md px-2 py-1 text-xs text-amber-11 hover:bg-amber-3"
            onClick={() => setBrowserHandoff(null)}
          >
            Dismiss
          </button>
          <BrowserHandoffFallback
            url={browserHandoff.url}
            title="Open this link manually"
            description={`${browserHandoff.error} The complete link remains available here to copy or select.`}
            className="pr-20 shadow-2xl"
          />
        </div>
      ) : null}
    </PlatformContext.Provider>
  );
}

export function usePlatform(): Platform {
  const context = use(PlatformContext);
  if (!context) {
    throw new Error("Platform context is missing");
  }
  return context;
}

function shouldOpenInCurrentTab(url: string) {
  return /^(mailto|tel):/i.test(url.trim());
}

export function createDefaultPlatform(): Platform {
  return {
    platform: isDesktopRuntime() ? "desktop" : "web",
    openLink(url: string) {
      if (shouldOpenInCurrentTab(url)) {
        window.location.href = url;
        return;
      }

      void openBrowserUrlWithGlobalFallback(url);
    },
    restart: async () => {
      if (isDesktopRuntime()) {
        await relaunchDesktopApp();
        return;
      }

      window.location.reload();
    },
    notify: async (title, description, href) => {
      const inView = document.visibilityState === "visible" && document.hasFocus();
      if (inView) return;

      if (isDesktopRuntime()) {
        await desktopNotificationShow({ title, body: description });
        return;
      }

      if (!("Notification" in window)) return;

      const permission =
        Notification.permission === "default"
          ? await Notification.requestPermission().catch(() => "denied")
          : Notification.permission;

      if (permission !== "granted") return;

      await Promise.resolve()
        .then(() => {
          const notification = new Notification(title, {
            body: description ?? "",
          });
          notification.onclick = () => {
            window.focus();
            if (href) {
              window.history.pushState(null, "", href);
              window.dispatchEvent(new PopStateEvent("popstate"));
            }
            notification.close();
          };
        })
        .catch(() => undefined);
    },
    storage: (name) => {
      const prefix = name ? `${name}:` : "";
      return {
        getItem: (key) => window.localStorage.getItem(prefix + key),
        setItem: (key, value) => window.localStorage.setItem(prefix + key, value),
        removeItem: (key) => window.localStorage.removeItem(prefix + key),
      };
    },
    fetch,
  };
}
