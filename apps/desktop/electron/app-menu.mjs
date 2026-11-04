// Native application menu: template installation, the macOS/system menu
// actions that forward into the renderer (settings, updates, sessions,
// sidebar, zoom), and Windows/Linux menu-bar visibility. The template itself
// is built by app-menu-template.mjs; the NATIVE_MENU_* channels are consumed
// by the preload bridge.
import { app, BrowserWindow, Menu, shell } from "electron";
import { buildApplicationMenuTemplate } from "./app-menu-template.mjs";
import { runDetachedTask } from "./process-resilience.mjs";

const NATIVE_MENU_OPEN_SETTINGS_EVENT = "openwork:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "openwork:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "openwork:native-menu:check-updates";
const NATIVE_MENU_ZOOM_EVENT = "openwork:native-menu:zoom";
const NATIVE_MENU_NEW_SESSION_EVENT = "openwork:native-menu:new-session";
const NATIVE_MENU_SEARCH_SESSIONS_EVENT = "openwork:native-menu:search-sessions";
const NATIVE_MENU_COMMAND_PALETTE_EVENT = "openwork:native-menu:command-palette";

export function createApplicationMenu({ appName, docsUrl, getWindow, closeBrowserTab }) {
  let applicationMenuVisible = process.platform === "darwin";
  let currentAppName = appName;

  // Bring the main window forward, then hand the action to the renderer.
  async function sendToWindow(channel, payload, { reveal = true } = {}) {
    const win = await getWindow();
    if (reveal) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    if (payload === undefined) win.webContents.send(channel);
    else win.webContents.send(channel, payload);
  }

  function forward(label, channel, payload, options) {
    runDetachedTask(label, () => sendToWindow(channel, payload, options));
  }

  /** @type {import("./app-menu-template.mjs").AppMenuActions} */
  const actions = {
    openSettings: (tab) => forward("open settings from menu", NATIVE_MENU_OPEN_SETTINGS_EVENT, tab),
    checkForUpdates: () => forward("check for updates from menu", NATIVE_MENU_CHECK_UPDATES_EVENT),
    newSession: () => forward("new session from menu", NATIVE_MENU_NEW_SESSION_EVENT),
    searchSessions: () => forward("search sessions from menu", NATIVE_MENU_SEARCH_SESSIONS_EVENT),
    commandPalette: () => forward("command palette from menu", NATIVE_MENU_COMMAND_PALETTE_EVENT),
    toggleSidebar: () =>
      forward("toggle sidebar from menu", NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, undefined, { reveal: false }),
    // Zoom must flow through the renderer's font-zoom pathway so the persisted
    // preference and the applied webContents zoom factor never drift apart. The
    // built-in resetZoom/zoomIn/zoomOut roles bypass that pathway (and zoom
    // whichever webContents is focused, including the embedded browser view).
    zoom: (action) => forward(`zoom ${action} from menu`, NATIVE_MENU_ZOOM_EVENT, action, { reveal: false }),
    close: (_item, focusedWindow) => {
      const host = focusedWindow instanceof BrowserWindow ? focusedWindow : BrowserWindow.getFocusedWindow();
      if (host && !closeBrowserTab?.(host)) host.close();
    },
    openDocs: () => runDetachedTask("open documentation from menu", () => shell.openExternal(docsUrl)),
  };

  function install() {
    const template = buildApplicationMenuTemplate({
      isMac: process.platform === "darwin",
      isPackaged: app.isPackaged,
      appName: currentAppName,
      actions,
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  function applyVisibility(window) {
    if (process.platform === "darwin") return;
    window.setAutoHideMenuBar(false);
    window.setMenuBarVisibility(applicationMenuVisible);
  }

  function setVisible(visible) {
    applicationMenuVisible = visible === true;
    for (const window of BrowserWindow.getAllWindows()) {
      applyVisibility(window);
    }
    return applicationMenuVisible;
  }

  function setAppName(nextAppName) {
    currentAppName = typeof nextAppName === "string" && nextAppName.trim() ? nextAppName.trim() : appName;
    install();
    return currentAppName;
  }

  return { install, applyVisibility, setVisible, setAppName };
}
