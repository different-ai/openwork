/* @refresh reload */
import { render } from "solid-js/web";
import { HashRouter, Route, Router } from "@solidjs/router";

import { bootstrapTheme } from "./app/theme";
import "./app/index.css";
import AppEntry from "./app/entry";
import { PlatformProvider, type Platform } from "./app/context/platform";
import { logDeepLinkBoundary, nativeDeepLinkEvent, pushPendingDeepLinks } from "./app/lib/deep-link-bridge";
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

let deepLinkBridgeStarted = false;

function startDeepLinkBridge() {
  if (typeof window === "undefined") {
    return;
  }

  if (deepLinkBridgeStarted) {
    logDeepLinkBoundary("skipping duplicate bridge startup");
    return;
  }

  deepLinkBridgeStarted = true;

  if (!isTauriRuntime()) {
    logDeepLinkBoundary("queueing browser location for web runtime", {
      href: window.location.href,
    });
    pushPendingDeepLinks(window, [window.location.href]);
    return;
  }

  void (async () => {
    try {
      logDeepLinkBoundary("starting tauri deep-link bridge");
      const [{ getCurrent, onOpenUrl }, { listen }] = await Promise.all([
        import("@tauri-apps/plugin-deep-link"),
        import("@tauri-apps/api/event"),
      ]);

      const startUrls = await getCurrent().catch((error) => {
        logDeepLinkBoundary("getCurrent failed", error instanceof Error ? error.message : String(error));
        return null;
      });
      logDeepLinkBoundary("getCurrent result", startUrls ?? null);
      if (Array.isArray(startUrls)) {
        pushPendingDeepLinks(window, startUrls);
      }

      await listen<string[]>("deep-link://new-url", (event) => {
        logDeepLinkBoundary("observed raw plugin deep-link event", event.payload);
      }).catch((error) => {
        logDeepLinkBoundary(
          "failed to listen for raw plugin deeplink event",
          error instanceof Error ? error.message : String(error),
        );
        return undefined;
      });

      await onOpenUrl((urls) => {
        logDeepLinkBoundary("received plugin onOpenUrl", urls);
        pushPendingDeepLinks(window, urls);
      }).catch((error) => {
        logDeepLinkBoundary(
          "failed to register plugin onOpenUrl listener",
          error instanceof Error ? error.message : String(error),
        );
        return undefined;
      });

      await listen<string[]>(
        nativeDeepLinkEvent,
        (event) => {
          if (Array.isArray(event.payload)) {
            logDeepLinkBoundary("received native deep-link event", event.payload);
            pushPendingDeepLinks(window, event.payload);
          }
        },
      ).catch((error) => {
        logDeepLinkBoundary(
          "failed to register native deep-link listener",
          error instanceof Error ? error.message : String(error),
        );
        return undefined;
      });
    } catch (error) {
      logDeepLinkBoundary(
        "failed to start tauri deep-link bridge",
        error instanceof Error ? error.message : String(error),
      );
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
