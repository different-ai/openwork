import { contextBridge, ipcRenderer } from "electron";

const NATIVE_DEEP_LINK_EVENT = "openwork:deep-link-native";
const NATIVE_MENU_OPEN_SETTINGS_EVENT = "openwork:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "openwork:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "openwork:native-menu:check-updates";
const NATIVE_MENU_ZOOM_EVENT = "openwork:native-menu:zoom";

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function applyShellDocumentMarkers() {
  try {
    const root = document?.documentElement;
    if (!root) return false;

    root.dataset.openworkShell = "electron";
    root.classList.add("openwork-electron");
    if (process.platform === "darwin") {
      root.classList.add("openwork-platform-mac");
    } else if (process.platform === "win32") {
      root.classList.add("openwork-platform-windows");
    } else if (process.platform === "linux") {
      root.classList.add("openwork-platform-linux");
    }
    return true;
  } catch {
    return false;
  }
}

function notifyMenuOverlayDismiss() {
  ipcRenderer.send("openwork:menu-overlay:dismiss");
}

function installMenuOverlayDismissListeners() {
  try {
    const target = window;
    target.addEventListener("pointerdown", notifyMenuOverlayDismiss, { capture: true });
    target.addEventListener("wheel", notifyMenuOverlayDismiss, { capture: true, passive: true });
    target.addEventListener("keydown", notifyMenuOverlayDismiss, { capture: true });
    return true;
  } catch {
    return false;
  }
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
  system: {
    getArchitectureInfo() {
      return ipcRenderer.invoke("openwork:system:architecture");
    },
    getMicrophoneStatus() {
      return ipcRenderer.invoke("openwork:system:microphoneStatus");
    },
    askMicrophoneAccess() {
      return ipcRenderer.invoke("openwork:system:askMicrophoneAccess");
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
    check(channel) {
      return ipcRenderer.invoke("openwork:updater:check", channel);
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
    openUrl(url, provider) { return ipcRenderer.invoke("openwork:browser:openUrl", url, provider); },
    navigate(url) { return ipcRenderer.invoke("openwork:browser:navigate", url); },
    back() { return ipcRenderer.invoke("openwork:browser:back"); },
    forward() { return ipcRenderer.invoke("openwork:browser:forward"); },
    reload() { return ipcRenderer.invoke("openwork:browser:reload"); },
    setBounds(bounds) { return ipcRenderer.invoke("openwork:browser:bounds", bounds); },
    getState() { return ipcRenderer.invoke("openwork:browser:state"); },
    createTab(url) { return ipcRenderer.invoke("openwork:browser:createTab", url); },
    closeTab(tabId) { return ipcRenderer.invoke("openwork:browser:closeTab", tabId); },
    closeAllTabs() { return ipcRenderer.invoke("openwork:browser:closeAllTabs"); },
    selectTab(tabId) { return ipcRenderer.invoke("openwork:browser:selectTab", tabId); },
    reorderTabs(tabIds) { return ipcRenderer.invoke("openwork:browser:reorderTabs", tabIds); },
    listTabs() { return ipcRenderer.invoke("openwork:browser:listTabs"); },
    setProxy(proxy) { return ipcRenderer.invoke("openwork:browser:setProxy", proxy); },
    getProxy() { return ipcRenderer.invoke("openwork:browser:getProxy"); },
    showTabContextMenu(tabId, point) { return ipcRenderer.invoke("openwork:browser:tabContextMenu", tabId, point); },
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
  terminal: {
    create(options) { return ipcRenderer.invoke("openwork:terminal:create", options); },
    write(terminalId, data) { return ipcRenderer.invoke("openwork:terminal:write", terminalId, data); },
    resize(terminalId, cols, rows) { return ipcRenderer.invoke("openwork:terminal:resize", terminalId, cols, rows); },
    kill(terminalId) { return ipcRenderer.invoke("openwork:terminal:kill", terminalId); },
    onData(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("openwork:terminal:data", handler);
      return () => ipcRenderer.removeListener("openwork:terminal:data", handler);
    },
    onExit(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("openwork:terminal:exit", handler);
      return () => ipcRenderer.removeListener("openwork:terminal:exit", handler);
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

ipcRenderer.on(NATIVE_MENU_OPEN_SETTINGS_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_OPEN_SETTINGS_EVENT));
});

ipcRenderer.on(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT));
});

ipcRenderer.on(NATIVE_MENU_CHECK_UPDATES_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_CHECK_UPDATES_EVENT));
});

ipcRenderer.on(NATIVE_MENU_ZOOM_EVENT, (_event, action) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_MENU_ZOOM_EVENT, { detail: action }));
});

if (!applyShellDocumentMarkers() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", applyShellDocumentMarkers, { once: true });
}

if (!installMenuOverlayDismissListeners() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", installMenuOverlayDismissListeners, { once: true });
}
