import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app";
import "./styles.css";

const originalConsole = { ...console };

for (const level of ["log", "info", "warn", "error"] as const) {
  console[level] = (...args: unknown[]) => {
    originalConsole[level](...args);
    const message = args
      .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ");
    window.openwork.sendRendererLog(level === "error" ? "error" : "info", message);
  };
}

window.addEventListener("error", (event) => {
  window.openwork.sendRendererLog("error", event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  window.openwork.sendRendererLog("error", String(event.reason));
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
