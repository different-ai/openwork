import { contextBridge, ipcRenderer } from "electron";

/**
 * The whole renderer bridge is one invoke channel. Every command is validated
 * and executed in the main process; results come back as
 * `{ ok: true, result } | { ok: false, error }`.
 */
contextBridge.exposeInMainWorld("__WORKBOT__", {
  invoke: (command, payload) => ipcRenderer.invoke("workbot:invoke", { command, payload }),
});
