/** @jsxImportSource react */
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter } from "react-router-dom";

import { getOpenWorkDeployment } from "./app/lib/openwork-deployment";
import { bootstrapTheme } from "./app/theme";
import { isDesktopRuntime } from "./app/utils";
import { initLocale } from "./i18n";
import { getReactQueryClient } from "./react-app/infra/query-client";
import {
  createDefaultPlatform,
  PlatformProvider,
} from "./react-app/kernel/platform";
import { AppProviders } from "./react-app/shell/providers";
import { AppRoot } from "./react-app/shell/app-root";
import { startDeepLinkBridge } from "./react-app/shell/startup-deep-links";
import "./app/index.css";

bootstrapTheme();
initLocale();
startDeepLinkBridge();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

root.dataset.openworkDeployment = getOpenWorkDeployment();

const platform = createDefaultPlatform();
const queryClient = getReactQueryClient();
const Router = isDesktopRuntime() ? HashRouter : BrowserRouter;

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <PlatformProvider value={platform}>
        <AppProviders>
          <Router>
            <AppRoot />
          </Router>
        </AppProviders>
      </PlatformProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
