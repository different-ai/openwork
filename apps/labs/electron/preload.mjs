import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openworkLabsDesktop", {
  isDesktop: true,
  platform: process.platform,
  ensureLocalServer: () => ipcRenderer.invoke("labs:ensure-local-server"),
});
