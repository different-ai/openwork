/** @jsxImportSource react */
import React from "react";
import ReactDOM from "react-dom/client";

import { bootstrapTheme } from "./app/theme";
import { initLocale } from "./i18n";
import { AppRoot } from "./react-app/shell/app-root";
import "./app/index.css";

bootstrapTheme();
initLocale();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
);
