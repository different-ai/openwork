import { contextBridge, ipcRenderer } from "electron";

const NATIVE_DEEP_LINK_EVENT = "micx:deep-link-native";
const NATIVE_MENU_OPEN_SETTINGS_EVENT = "micx:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "micx:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "micx:native-menu:check-updates";
const NATIVE_MENU_ZOOM_EVENT = "micx:native-menu:zoom";

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function applyShellDocumentMarkers() {
  try {
    const root = document?.documentElement;
    if (!root) return false;

    root.dataset.micxShell = "electron";
    root.classList.add("micx-electron");
    if (process.platform === "darwin") {
      root.classList.add("micx-platform-mac");
    } else if (process.platform === "win32") {
      root.classList.add("micx-platform-windows");
    } else if (process.platform === "linux") {
      root.classList.add("micx-platform-linux");
    }
    return true;
  } catch {
    return false;
  }
}

function notifyMenuOverlayDismiss() {
  ipcRenderer.send("micx:menu-overlay:dismiss");
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

let desktopBootstrap = null;
let desktopDistribution = null;
try {
  desktopBootstrap = ipcRenderer.sendSync("micx:desktop-bootstrap-sync");
  desktopDistribution = ipcRenderer.sendSync("micx:desktop-distribution-sync");
} catch {
  desktopBootstrap = null;
  desktopDistribution = null;
}

contextBridge.exposeInMainWorld("__MICX_ELECTRON__", {
  invokeDesktop(command, ...args) {
    return ipcRenderer.invoke("micx:desktop", command, ...args);
  },
  shell: {
    openExternal(url) {
      return ipcRenderer.invoke("micx:shell:openExternal", url);
    },
    relaunch() {
      return ipcRenderer.invoke("micx:shell:relaunch");
    },
  },
  system: {
    getArchitectureInfo() {
      return ipcRenderer.invoke("micx:system:architecture");
    },
    getMicrophoneStatus() {
      return ipcRenderer.invoke("micx:system:microphoneStatus");
    },
    askMicrophoneAccess() {
      return ipcRenderer.invoke("micx:system:askMicrophoneAccess");
    },
  },
  migration: {
    readSnapshot() {
      return ipcRenderer.invoke("micx:migration:read");
    },
    ackSnapshot() {
      return ipcRenderer.invoke("micx:migration:ack");
    },
  },
  brandIcon: {
    apply(url) {
      return ipcRenderer.invoke("micx:desktop", "__applyBrandIcon", url ?? null);
    },
    getState() {
      return ipcRenderer.invoke("micx:desktop", "__getBrandIconState");
    },
  },
  dev: {
    evalRelaunch() {
      return ipcRenderer.invoke("micx:desktop", "__evalRelaunch");
    },
  },
  nuke: {
    preview(options) {
      return ipcRenderer.invoke("micx:desktop", "nukeMicxAndOpencodeConfigPreview", options);
    },
    execute(options) {
      return ipcRenderer.invoke("micx:desktop", "nukeMicxAndOpencodeConfigAndExit", options);
    },
  },
  updater: {
    getChannel() {
      return ipcRenderer.invoke("micx:updater:getChannel");
    },
    setChannel(channel) {
      return ipcRenderer.invoke("micx:updater:setChannel", channel);
    },
    check(channel, targetVersion) {
      return ipcRenderer.invoke("micx:updater:check", channel, targetVersion);
    },
    download() {
      return ipcRenderer.invoke("micx:updater:download");
    },
    installAndRestart() {
      return ipcRenderer.invoke("micx:updater:installAndRestart");
    },
    /** Subscribe to incremental download progress from electron-updater. */
    onDownloadProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("micx:updater:download-progress", handler);
      return () => {
        ipcRenderer.removeListener("micx:updater:download-progress", handler);
      };
    },
  },
  browser: {
    show(bounds) { return ipcRenderer.invoke("micx:browser:show", bounds); },
    hide() { return ipcRenderer.invoke("micx:browser:hide"); },
    openUrl(url, provider) { return ipcRenderer.invoke("micx:browser:openUrl", url, provider); },
    navigate(url) { return ipcRenderer.invoke("micx:browser:navigate", url); },
    back() { return ipcRenderer.invoke("micx:browser:back"); },
    forward() { return ipcRenderer.invoke("micx:browser:forward"); },
    reload() { return ipcRenderer.invoke("micx:browser:reload"); },
    setBounds(bounds) { return ipcRenderer.invoke("micx:browser:bounds", bounds); },
    getState() { return ipcRenderer.invoke("micx:browser:state"); },
    createTab(url) { return ipcRenderer.invoke("micx:browser:createTab", url); },
    closeTab(tabId) { return ipcRenderer.invoke("micx:browser:closeTab", tabId); },
    closeAllTabs() { return ipcRenderer.invoke("micx:browser:closeAllTabs"); },
    selectTab(tabId) { return ipcRenderer.invoke("micx:browser:selectTab", tabId); },
    reorderTabs(tabIds) { return ipcRenderer.invoke("micx:browser:reorderTabs", tabIds); },
    listTabs() { return ipcRenderer.invoke("micx:browser:listTabs"); },
    setProxy(proxy) { return ipcRenderer.invoke("micx:browser:setProxy", proxy); },
    getProxy() { return ipcRenderer.invoke("micx:browser:getProxy"); },
    showTabContextMenu(tabId, point) { return ipcRenderer.invoke("micx:browser:tabContextMenu", tabId, point); },
    destroy() { return ipcRenderer.invoke("micx:browser:destroy"); },
    onStateChange(callback) {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("micx:browser:state", handler);
      return () => ipcRenderer.removeListener("micx:browser:state", handler);
    },
    onPanelOpened(callback) {
      const handler = () => callback();
      ipcRenderer.on("micx:browser:panel-opened", handler);
      return () => ipcRenderer.removeListener("micx:browser:panel-opened", handler);
    },
    onPanelClosed(callback) {
      const handler = () => callback();
      ipcRenderer.on("micx:browser:panel-closed", handler);
      return () => ipcRenderer.removeListener("micx:browser:panel-closed", handler);
    },
  },
  terminal: {
    create(options) { return ipcRenderer.invoke("micx:terminal:create", options); },
    write(terminalId, data) { return ipcRenderer.invoke("micx:terminal:write", terminalId, data); },
    resize(terminalId, cols, rows) { return ipcRenderer.invoke("micx:terminal:resize", terminalId, cols, rows); },
    kill(terminalId) { return ipcRenderer.invoke("micx:terminal:kill", terminalId); },
    onData(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("micx:terminal:data", handler);
      return () => ipcRenderer.removeListener("micx:terminal:data", handler);
    },
    onExit(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("micx:terminal:exit", handler);
      return () => ipcRenderer.removeListener("micx:terminal:exit", handler);
    },
  },
  meta: {
    desktopBootstrap,
    distribution: desktopDistribution,
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
