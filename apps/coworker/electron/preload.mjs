import { contextBridge, ipcRenderer } from "electron";

/**
 * The whole renderer bridge is one invoke channel. Every command is validated
 * and executed in the main process; results come back as
 * `{ ok: true, result } | { ok: false, error }`.
 */
contextBridge.exposeInMainWorld("__COWORKER__", {
  invoke: (command, payload) => ipcRenderer.invoke("coworker:invoke", { command, payload }),
});
