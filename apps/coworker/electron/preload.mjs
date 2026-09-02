import { contextBridge, ipcRenderer } from "electron";

/**
 * The whole renderer bridge is one invoke channel. Every command is validated
 * and executed in the main process; results come back as
 * `{ ok: true, result } | { ok: false, error }`.
 *
 * Deep links are the one push channel: `opencoworker://` handoffs arrive from
 * the OS after the renderer announced its listener through `deepLinks.subscribe`.
 */
contextBridge.exposeInMainWorld("__COWORKER__", {
  invoke: (command, payload) => ipcRenderer.invoke("coworker:invoke", { command, payload }),
  onDeepLink: (listener) => {
    const handler = (_event, urls) => {
      if (Array.isArray(urls)) listener(urls.filter((url) => typeof url === "string"));
    };
    ipcRenderer.on("coworker:deep-link", handler);
    return () => ipcRenderer.removeListener("coworker:deep-link", handler);
  },
});
