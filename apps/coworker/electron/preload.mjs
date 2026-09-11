import { contextBridge, ipcRenderer, webFrame } from "electron";

/**
 * The whole renderer bridge is one invoke channel. Every command is validated
 * and executed in the main process; results come back as
 * `{ ok: true, result } | { ok: false, error }`.
 *
 * Deep links reach the renderer through its subscription. Window appearance is
 * applied here from the OS, without exposing native window controls to the page.
 */
if (process.isMainFrame) {
  window.addEventListener("DOMContentLoaded", () => {
    document.documentElement.dataset.windowPlatform = process.platform;
  }, { once: true });
  ipcRenderer.on("coworker:appearance", (_event, appearance) => {
    if (!appearance || !["none", "vibrancy", "mica"].includes(appearance.material)) return;
    document.documentElement.dataset.windowMaterial = appearance.material;
    document.documentElement.dataset.windowFocused = String(appearance.focused === true);
  });
  contextBridge.exposeInMainWorld("__COWORKER__", {
    invoke: (command, payload) => ipcRenderer.invoke("coworker:invoke", {
      command,
      // Stamp CSS geometry before IPC; a later main-process zoom cannot safely
      // reinterpret the rectangle measured by this renderer turn.
      payload: command === "browser.command" && payload?.action === "bounds" && payload.bounds
        ? { ...payload, bounds: { ...payload.bounds, zoomFactor: webFrame.getZoomFactor() } }
        : payload,
      userGesture: command === "voice.microphone" && navigator.userActivation.isActive,
    }),
    onDeepLink: (listener) => {
      const handler = (_event, urls) => {
        if (Array.isArray(urls)) listener(urls.filter((url) => typeof url === "string"));
      };
      ipcRenderer.on("coworker:deep-link", handler);
      return () => ipcRenderer.removeListener("coworker:deep-link", handler);
    },
  });
}
