/** @jsxImportSource react */
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";

import { bootstrapTheme } from "./app/theme";
import { initLocale } from "./i18n";
import { getReactQueryClient } from "./react-app/infra/query-client";
import {
  createDefaultPlatform,
  PlatformProvider,
} from "./react-app/kernel/platform";
import { AppProviders } from "./react-app/shell/providers";
import { AppRoot } from "./react-app/shell/app-root";
import "./app/index.css";

bootstrapTheme();
initLocale();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

const platform = createDefaultPlatform();
const queryClient = getReactQueryClient();

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <PlatformProvider value={platform}>
        <AppProviders>
          <AppRoot />
        </AppProviders>
      </PlatformProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
