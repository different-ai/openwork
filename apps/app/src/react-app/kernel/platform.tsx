/** @jsxImportSource react */
import { createContext, useContext, type ReactNode } from "react";

import { isTauriRuntime } from "../../app/utils";

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
  return (
    <PlatformContext.Provider value={value}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform(): Platform {
  const context = useContext(PlatformContext);
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
    platform: isTauriRuntime() ? "desktop" : "web",
    openLink(url: string) {
      if (isTauriRuntime()) {
        void import("@tauri-apps/plugin-opener")
          .then(({ openUrl }) => openUrl(url))
          .catch(() => undefined);
        return;
      }

      if (shouldOpenInCurrentTab(url)) {
        window.location.href = url;
        return;
      }

      window.open(url, "_blank");
    },
    restart: async () => {
      if (isTauriRuntime()) {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
        return;
      }

      window.location.reload();
    },
    notify: async (title, description, href) => {
      if (!("Notification" in window)) return;

      const permission =
        Notification.permission === "default"
          ? await Notification.requestPermission().catch(() => "denied")
          : Notification.permission;

      if (permission !== "granted") return;

      const inView = document.visibilityState === "visible" && document.hasFocus();
      if (inView) return;

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
