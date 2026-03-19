/* @refresh reload */
import { render } from "solid-js/web";
import { HashRouter, Route, Router } from "@solidjs/router";

import { bootstrapTheme } from "./app/theme";
import "./app/index.css";
import AppEntry from "./app/entry";
import { PlatformProvider, type Platform } from "./app/context/platform";
import { forwardedDeepLinkEvent, pushPendingDeepLinks } from "./app/lib/deep-link-bridge";
import { getOpenWorkDeployment } from "./app/lib/openwork-deployment";
import { isTauriRuntime } from "./app/utils";
import { initLocale } from "./i18n";

bootstrapTheme();
initLocale();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

root.dataset.openworkDeployment = getOpenWorkDeployment();

function startDeepLinkBridge() {
  if (typeof window === "undefined") {
    return;
  }

  if (!isTauriRuntime()) {
    pushPendingDeepLinks(window, [window.location.href]);
    return;
  }

  void (async () => {
    try {
      const [{ getCurrent, onOpenUrl }, { listen }] = await Promise.all([
        import("@tauri-apps/plugin-deep-link"),
        import("@tauri-apps/api/event"),
      ]);

      const syncCurrentDeepLinks = async () => {
        const urls = await getCurrent().catch(() => null);
        if (Array.isArray(urls)) {
          pushPendingDeepLinks(window, urls);
        }
      };

      await syncCurrentDeepLinks();
      const unlistenOpenUrl = await onOpenUrl((urls) => {
        console.log("[issue-1022][bridge] received plugin onOpenUrl", urls);
        pushPendingDeepLinks(window, urls);
      }).catch(() => undefined);
      const unlistenForwarded = await listen<string[]>(
        forwardedDeepLinkEvent,
        (event) => {
          if (Array.isArray(event.payload)) {
            console.log("[issue-1022][bridge] received forwarded native deeplinks", event.payload);
            pushPendingDeepLinks(window, event.payload);
          }
        },
      ).catch(() => undefined);
      const handleWindowFocus = () => {
        void syncCurrentDeepLinks().catch(() => undefined);
      };
      const handleVisibilityChange = () => {
        if (document.visibilityState !== "visible") {
          return;
        }
        void syncCurrentDeepLinks().catch(() => undefined);
      };
      const cleanup = () => {
        if (typeof unlistenOpenUrl === "function") {
          unlistenOpenUrl();
        }
        if (typeof unlistenForwarded === "function") {
          unlistenForwarded();
        }
        window.removeEventListener("focus", handleWindowFocus);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        window.removeEventListener("pagehide", cleanup);
      };

      window.addEventListener("focus", handleWindowFocus);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      window.addEventListener("pagehide", cleanup, { once: true });
    } catch {
      // ignore
    }
  })();
}

startDeepLinkBridge();

const RouterComponent = isTauriRuntime() ? HashRouter : Router;

function shouldOpenInCurrentTab(url: string) {
  return /^(mailto|tel):/i.test(url.trim());
}

const platform: Platform = {
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

render(
  () => (
    <PlatformProvider value={platform}>
      <RouterComponent root={AppEntry}>
        <Route path="*all" component={() => null} />
      </RouterComponent>
    </PlatformProvider>
  ),
  root,
);
