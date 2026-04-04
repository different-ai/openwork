import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import "streamdown/styles.css";

import { AppRoot } from "./react-app/app";
import { nativeDeepLinkEvent, pushPendingDeepLinks } from "./app/lib/deep-link-bridge";
import { getOpenWorkDeployment } from "./app/lib/openwork-deployment";
import { isTauriRuntime } from "./app/utils";
import "./react-app/styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

root.dataset.openworkDeployment = getOpenWorkDeployment();

let deepLinkBridgeStarted = false;

function startDeepLinkBridge() {
  if (typeof window === "undefined" || deepLinkBridgeStarted) {
    return;
  }

  deepLinkBridgeStarted = true;

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

      const startUrls = await getCurrent().catch(() => null);
      if (Array.isArray(startUrls)) {
        pushPendingDeepLinks(window, startUrls);
      }

      await onOpenUrl((urls) => {
        pushPendingDeepLinks(window, urls);
      }).catch(() => undefined);

      await listen<string[]>(nativeDeepLinkEvent, (event) => {
        if (Array.isArray(event.payload)) {
          pushPendingDeepLinks(window, event.payload);
        }
      }).catch(() => undefined);
    } catch {
      // ignore
    }
  })();
}

startDeepLinkBridge();

const Router = isTauriRuntime() ? HashRouter : BrowserRouter;

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Router>
      <AppRoot />
    </Router>
  </React.StrictMode>,
);
