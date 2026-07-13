/** @jsxImportSource react */
import * as React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter } from "react-router-dom";

import { TooltipProvider } from "@/components/ui/tooltip";
import { initializeDenBootstrapConfig } from "./app/lib/den";
import { getOpenWorkDeployment } from "./app/lib/openwork-deployment";
import { bootstrapTheme } from "./app/theme";
import { isDesktopRuntime, isDesktopWorkspaceRecoveryDisabled } from "./app/utils";
import { resetFirstRunClientState } from "./react-app/shell/session-memory";
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

// OPENWORK_DESKTOP_DISABLE_WORKSPACE_RECOVERY resets backend workspace state
// but not the renderer's localStorage; wipe the renderer's first-run memory
// here (before any provider/component reads it) so the flag actually produces a
// fresh first run — loader, auto session, provider step — on every launch.
if (isDesktopWorkspaceRecoveryDisabled()) {
  resetFirstRunClientState();
}

bootstrapTheme();
initLocale();
startDeepLinkBridge();
await initializeDenBootstrapConfig();

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
      <TooltipProvider>
        <PlatformProvider value={platform}>
          <AppProviders>
            <Router>
              <AppRoot />
            </Router>
          </AppProviders>
        </PlatformProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
