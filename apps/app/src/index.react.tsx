/** @jsxImportSource react */
import React from "react";
import ReactDOM from "react-dom/client";

import { bootstrapTheme } from "./app/theme";
import { initLocale } from "./i18n";
import {
  createDefaultPlatform,
  PlatformProvider,
} from "./react-app/kernel/platform";
import { AppRoot } from "./react-app/shell/app-root";
import "./app/index.css";

bootstrapTheme();
initLocale();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

const platform = createDefaultPlatform();

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <PlatformProvider value={platform}>
      <AppRoot />
    </PlatformProvider>
  </React.StrictMode>,
);
