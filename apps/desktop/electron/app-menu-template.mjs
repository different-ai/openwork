// Pure builder for the native application menu template. Kept free of
// Electron imports so the menu structure can be tested with `node --test`.
//
// Rules the template follows:
// - Every item appears once per platform (Settings lives in the app menu on
//   macOS and in File elsewhere; Close lives in File only).
// - Shortcuts the renderer already owns (New session, Search sessions,
//   Command palette) are shown in the menu for discovery but not registered
//   (`registerAccelerator: false`), so a key press never fires twice.
// - Reload, Force Reload and Developer Tools are development aids. Packaged
//   builds keep Developer Tools on its usual shortcut but hide it, and drop
//   Reload so Cmd/Ctrl+R cannot wipe an open conversation.

/**
 * @typedef {{
 *   openSettings: (tab?: string) => void,
 *   checkForUpdates: () => void,
 *   newSession: () => void,
 *   searchSessions: () => void,
 *   commandPalette: () => void,
 *   toggleSidebar: () => void,
 *   zoom: (action: "in" | "out" | "reset") => void,
 *   close: (item: unknown, focusedWindow: unknown) => void,
 *   openDocs: () => void,
 * }} AppMenuActions
 */

/**
 * @param {{ isMac: boolean, isPackaged: boolean, appName: string, actions: AppMenuActions }} input
 * @returns {import("electron").MenuItemConstructorOptions[]}
 */
export function buildApplicationMenuTemplate({ isMac, isPackaged, appName, actions }) {
  /** @type {import("electron").MenuItemConstructorOptions} */
  const separator = { type: "separator" };

  /** @type {import("electron").MenuItemConstructorOptions} */
  const closeItem = {
    label: "Close",
    accelerator: "CommandOrControl+W",
    click: (item, focusedWindow) => actions.close(item, focusedWindow),
  };

  /** @type {import("electron").MenuItemConstructorOptions[]} */
  const developerItems = isPackaged
    ? [{ role: "toggleDevTools", visible: false }]
    : [separator, { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }];

  /** @type {import("electron").MenuItemConstructorOptions[]} */
  const editPlatformItems = isMac
    ? [
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        separator,
        { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] },
      ]
    : [{ role: "delete" }, separator, { role: "selectAll" }];

  /** @type {import("electron").MenuItemConstructorOptions[]} */
  const windowPlatformItems = isMac ? [separator, { role: "front" }, separator, { role: "window" }] : [];

  /** @type {import("electron").MenuItemConstructorOptions[]} */
  const template = [];

  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about", label: `About ${appName}` },
        { label: "Check for Updates…", click: () => actions.checkForUpdates() },
        separator,
        { label: "Settings…", accelerator: "Command+,", click: () => actions.openSettings() },
        separator,
        { role: "services" },
        separator,
        { role: "hide", label: `Hide ${appName}` },
        { role: "hideOthers" },
        { role: "unhide" },
        separator,
        { role: "quit", label: `Quit ${appName}` },
      ],
    });
  }

  template.push({
    label: "File",
    submenu: [
      {
        label: "New Session",
        accelerator: "CommandOrControl+N",
        registerAccelerator: false,
        click: () => actions.newSession(),
      },
      {
        label: "Search Sessions…",
        accelerator: "CommandOrControl+Shift+F",
        registerAccelerator: false,
        click: () => actions.searchSessions(),
      },
      separator,
      ...(isMac
        ? []
        : [
            { label: "Settings", accelerator: "Control+,", click: () => actions.openSettings() },
            separator,
          ]),
      closeItem,
    ],
  });

  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      separator,
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...editPlatformItems,
    ],
  });

  template.push({
    label: "View",
    submenu: [
      {
        label: "Command Palette…",
        accelerator: "CommandOrControl+K",
        registerAccelerator: false,
        click: () => actions.commandPalette(),
      },
      { label: "Toggle Sidebar", accelerator: "CommandOrControl+B", click: () => actions.toggleSidebar() },
      separator,
      // Zoom goes through the renderer so the saved preference and the
      // applied zoom factor never drift apart (see font-zoom.ts).
      { label: "Actual Size", accelerator: "CommandOrControl+0", click: () => actions.zoom("reset") },
      // Cmd/Ctrl+= is the key people press; the renderer also accepts the
      // shifted "+" and the numpad keys.
      { label: "Zoom In", accelerator: "CommandOrControl+=", click: () => actions.zoom("in") },
      { label: "Zoom Out", accelerator: "CommandOrControl+-", click: () => actions.zoom("out") },
      separator,
      { role: "togglefullscreen" },
      ...developerItems,
    ],
  });

  template.push({
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      ...windowPlatformItems,
    ],
  });

  template.push({
    role: "help",
    submenu: [
      ...(isMac ? [] : [{ label: "Check for Updates…", click: () => actions.checkForUpdates() }, separator]),
      { label: "Keyboard Shortcuts", click: () => actions.openSettings("shortcuts") },
      { label: `${appName} Documentation`, click: () => actions.openDocs() },
    ],
  });

  return template;
}
