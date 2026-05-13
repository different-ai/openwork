import { contextBridge, ipcRenderer } from "electron";

const NATIVE_DEEP_LINK_EVENT = "openwork:deep-link-native";

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

contextBridge.exposeInMainWorld("__OPENWORK_ELECTRON__", {
  invokeDesktop(command, ...args) {
    return ipcRenderer.invoke("openwork:desktop", command, ...args);
  },
  shell: {
    openExternal(url) {
      return ipcRenderer.invoke("openwork:shell:openExternal", url);
    },
    relaunch() {
      return ipcRenderer.invoke("openwork:shell:relaunch");
    },
  },
  migration: {
    readSnapshot() {
      return ipcRenderer.invoke("openwork:migration:read");
    },
    ackSnapshot() {
      return ipcRenderer.invoke("openwork:migration:ack");
    },
  },
  updater: {
    getChannel() {
      return ipcRenderer.invoke("openwork:updater:getChannel");
    },
    setChannel(channel) {
      return ipcRenderer.invoke("openwork:updater:setChannel", channel);
    },
    check() {
      return ipcRenderer.invoke("openwork:updater:check");
    },
    download() {
      return ipcRenderer.invoke("openwork:updater:download");
    },
    installAndRestart() {
      return ipcRenderer.invoke("openwork:updater:installAndRestart");
    },
    /** Subscribe to incremental download progress from electron-updater. */
    onDownloadProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("openwork:updater:download-progress", handler);
      return () => {
        ipcRenderer.removeListener("openwork:updater:download-progress", handler);
      };
    },
  },
  openshell: {
    /** Subscribe to installer progress events emitted by installer.mjs (Phase 6). */
    onInstallProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("openshell:install-progress", handler);
      return () => {
        ipcRenderer.removeListener("openshell:install-progress", handler);
      };
    },
  },
  openeral: {
    /** Subscribe to OpenEral session progress (pull, create, terminal launch). */
    onSessionProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("openeral:session-progress", handler);
      return () => {
        ipcRenderer.removeListener("openeral:session-progress", handler);
      };
    },
  },
  meta: {
    initialDeepLinks: [],
    platform: normalizePlatform(process.platform),
    version: process.versions.electron,
  },
});

ipcRenderer.on(NATIVE_DEEP_LINK_EVENT, (_event, urls) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_DEEP_LINK_EVENT, { detail: urls }));
});
