import { contextBridge, ipcRenderer } from "electron";

const NATIVE_DEEP_LINK_EVENT = "openwork:deep-link-native";

document.documentElement.dataset.openworkShell = "electron";
document.documentElement.classList.add("openwork-electron");

if (process.platform === "darwin") {
  document.documentElement.classList.add("openwork-platform-mac");
} else if (process.platform === "win32") {
  document.documentElement.classList.add("openwork-platform-windows");
} else if (process.platform === "linux") {
  document.documentElement.classList.add("openwork-platform-linux");
}

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
  browser: {
    show(bounds) { return ipcRenderer.invoke("openwork:browser:show", bounds); },
    hide() { return ipcRenderer.invoke("openwork:browser:hide"); },
    navigate(url) { return ipcRenderer.invoke("openwork:browser:navigate", url); },
    back() { return ipcRenderer.invoke("openwork:browser:back"); },
    forward() { return ipcRenderer.invoke("openwork:browser:forward"); },
    reload() { return ipcRenderer.invoke("openwork:browser:reload"); },
    setBounds(bounds) { return ipcRenderer.invoke("openwork:browser:bounds", bounds); },
    getState() { return ipcRenderer.invoke("openwork:browser:state"); },
    destroy() { return ipcRenderer.invoke("openwork:browser:destroy"); },
    onStateChange(callback) {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("openwork:browser:state", handler);
      return () => ipcRenderer.removeListener("openwork:browser:state", handler);
    },
    onPanelOpened(callback) {
      const handler = () => callback();
      ipcRenderer.on("openwork:browser:panel-opened", handler);
      return () => ipcRenderer.removeListener("openwork:browser:panel-opened", handler);
    },
    onPanelClosed(callback) {
      const handler = () => callback();
      ipcRenderer.on("openwork:browser:panel-closed", handler);
      return () => ipcRenderer.removeListener("openwork:browser:panel-closed", handler);
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
