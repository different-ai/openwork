/* @refresh reload */
import { ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import { HashRouter, Route, Router } from "@solidjs/router";

import { bootstrapTheme } from "./app/theme";
import "./app/index.css";
import AppEntry from "./app/entry";
import { PlatformProvider, type Platform } from "./app/context/platform";
import { isTauriRuntime } from "./app/utils";

bootstrapTheme();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

const RouterComponent = isTauriRuntime() ? HashRouter : Router;

const isSafeExternalUrl = (value: string) => {
  const url = value.trim();
  if (!url) return false;
  try {
    const parsed = new URL(url, window.location.href);
    const protocol = parsed.protocol.toLowerCase();
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
};

const platform: Platform = {
  platform: isTauriRuntime() ? "desktop" : "web",
  openLink(url: string) {
    if (!isSafeExternalUrl(url)) return;
    if (isTauriRuntime()) {
      void import("@tauri-apps/plugin-opener")
        .then(({ openUrl }) => openUrl(url))
        .catch(() => undefined);
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
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
            const nextHref = href.trim();
            if (nextHref.startsWith("/") || nextHref.startsWith("#")) {
              window.history.pushState(null, "", nextHref);
              window.dispatchEvent(new PopStateEvent("popstate"));
            }
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

render(
  () => (
    <ErrorBoundary
      fallback={(error, reset) => {
        const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
        return (
          <div class="h-screen w-full flex items-center justify-center bg-dls-surface text-dls-text p-6">
            <div class="max-w-xl w-full rounded-2xl border border-dls-border bg-dls-surface-elevated p-5 shadow-lg space-y-3">
              <div class="text-lg font-semibold">Something went wrong</div>
              <div class="text-sm text-dls-secondary break-words">{message}</div>
              <div class="flex gap-2 pt-1">
                <button
                  class="px-3 py-2 rounded-lg border border-dls-border bg-dls-surface-hover text-sm"
                  onClick={() => reset()}
                >
                  Retry
                </button>
                <button
                  class="px-3 py-2 rounded-lg border border-dls-border bg-dls-surface-hover text-sm"
                  onClick={() => window.location.reload()}
                >
                  Reload
                </button>
              </div>
            </div>
          </div>
        );
      }}
    >
      <PlatformProvider value={platform}>
        <RouterComponent root={AppEntry}>
          <Route path="*all" component={() => null} />
        </RouterComponent>
      </PlatformProvider>
    </ErrorBoundary>
  ),
  root,
);
