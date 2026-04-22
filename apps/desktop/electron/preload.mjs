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
    check() {
      return ipcRenderer.invoke("openwork:updater:check");
    },
    download() {
      return ipcRenderer.invoke("openwork:updater:download");
    },
    installAndRestart() {
      return ipcRenderer.invoke("openwork:updater:installAndRestart");
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
