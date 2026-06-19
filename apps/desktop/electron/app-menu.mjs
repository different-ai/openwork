// Native application menu: template installation, the macOS/system menu
// actions that forward into the renderer (settings, updates, sidebar, zoom),
// and Windows/Linux menu-bar visibility. Extracted from main.mjs as a
// factory (createRuntimeManager pattern); the NATIVE_MENU_* channels are
// consumed by the preload bridge.
import { BrowserWindow, Menu, shell } from "electron";

const NATIVE_MENU_OPEN_SETTINGS_EVENT = "openwork:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "openwork:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "openwork:native-menu:check-updates";
const NATIVE_MENU_ZOOM_EVENT = "openwork:native-menu:zoom";

export function createApplicationMenu({ appName, docsUrl, getWindow }) {
  let applicationMenuVisible = process.platform === "darwin";

  async function openSettingsFromNativeMenu() {
    const win = await getWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(NATIVE_MENU_OPEN_SETTINGS_EVENT);
  }

  async function checkForUpdatesFromNativeMenu() {
    const win = await getWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(NATIVE_MENU_CHECK_UPDATES_EVENT);
  }

  async function toggleSidebarFromNativeMenu() {
    const win = await getWindow();
    win.webContents.send(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT);
  }

  // Zoom must flow through the renderer's font-zoom pathway so the persisted
  // preference and the applied webContents zoom factor never drift apart. The
  // built-in resetZoom/zoomIn/zoomOut roles bypass that pathway (and zoom
  // whichever webContents is focused, including the embedded browser view).
  async function zoomFromNativeMenu(action) {
    const win = await getWindow();
    win.webContents.send(NATIVE_MENU_ZOOM_EVENT, action);
  }

  function install() {
    const isMac = process.platform === "darwin";
    const template = /** @type {import("electron").MenuItemConstructorOptions[]} */ ([
      ...(isMac
        ? [
            {
              label: appName,
              submenu: [
                { role: "about" },
                {
                  label: "Check for Updates...",
                  click: () => {
                    void checkForUpdatesFromNativeMenu();
                  },
                },
                { type: "separator" },
                {
                  label: "Settings...",
                  accelerator: "Command+,",
                  click: () => {
                    void openSettingsFromNativeMenu();
                  },
                },
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
              ],
            },
          ]
        : []),
      {
        label: "File",
        submenu: [
          ...(isMac
            ? []
            : [
                {
                  label: "Settings",
                  accelerator: "Control+,",
                  click: () => {
                    void openSettingsFromNativeMenu();
                  },
                },
                { type: "separator" },
              ]),
          { role: "close" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          ...(isMac
            ? [
                { role: "pasteAndMatchStyle" },
                { role: "delete" },
                { role: "selectAll" },
                { type: "separator" },
                {
                  label: "Speech",
                  submenu: [
                    { role: "startSpeaking" },
                    { role: "stopSpeaking" },
                  ],
                },
                { type: "separator" },
                {
                  label: "Settings...",
                  click: () => {
                    void openSettingsFromNativeMenu();
                  },
                },
              ]
            : [
                { role: "delete" },
                { type: "separator" },
                { role: "selectAll" },
              ]),
        ],
      },
      {
        label: "View",
        submenu: [
          {
            label: "Toggle Sidebar",
            accelerator: "CommandOrControl+B",
            click: () => {
              void toggleSidebarFromNativeMenu();
            },
          },
          { type: "separator" },
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          {
            label: "Actual Size",
            accelerator: "CommandOrControl+0",
            click: () => {
              void zoomFromNativeMenu("reset");
            },
          },
          {
            label: "Zoom In",
            accelerator: "CommandOrControl+Plus",
            click: () => {
              void zoomFromNativeMenu("in");
            },
          },
          {
            label: "Zoom Out",
            accelerator: "CommandOrControl+-",
            click: () => {
              void zoomFromNativeMenu("out");
            },
          },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          ...(isMac
            ? [
                { type: "separator" },
                { role: "front" },
                { type: "separator" },
                { role: "window" },
              ]
            : [
                { role: "close" },
              ]),
        ],
      },
      {
        role: "help",
        submenu: [
          ...(isMac
            ? []
            : [
                {
                  label: "Check for Updates...",
                  click: () => {
                    void checkForUpdatesFromNativeMenu();
                  },
                },
                { type: "separator" },
              ]),
          {
            label: "Docs",
            click: async () => {
              await shell.openExternal(docsUrl);
            },
          },
        ],
      },
    ]);

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

  return { install, applyVisibility, setVisible };
}
