export const STATION_SHORTCUT = "CommandOrControl+Shift+Space";

export const STATION_COLLAPSED_BOUNDS = Object.freeze({ width: 70, height: 560 });
export const STATION_EXPANDED_BOUNDS = Object.freeze({ width: 400, height: 560 });

const ALLOWED_COMMANDS = new Set([
  "activate",
  "dismiss",
  "hide",
  "select",
  "seed-demo",
  "start",
  "stop",
  "toggle-listening",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCommand(value) {
  if (!isRecord(value) || !ALLOWED_COMMANDS.has(value.type)) return null;
  const command = { type: value.type };
  if (typeof value.id === "string" && value.id.trim()) command.id = value.id.trim().slice(0, 200);
  return command;
}

export function stationWindowBounds(display, expanded) {
  const workArea = display?.workArea ?? { x: 0, y: 0, width: 1440, height: 900 };
  const desired = expanded ? STATION_EXPANDED_BOUNDS : STATION_COLLAPSED_BOUNDS;
  const width = Math.min(desired.width, Math.max(STATION_COLLAPSED_BOUNDS.width, workArea.width - 24));
  const height = Math.min(desired.height, Math.max(280, workArea.height - 48));
  return {
    x: Math.round(workArea.x + workArea.width - width - 12),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

export function createStationWindowManager(options) {
  const {
    BrowserWindow,
    globalShortcut,
    ipcMain,
    loadContent,
    platform,
    screen,
    getMainWindow,
  } = options;
  let stationWindow = null;
  let expanded = false;
  let anchorDisplay = null;
  let latestState = {
    status: "idle",
    statusText: "Ready when you are.",
    listening: false,
    visible: false,
    transcript: "",
    partialTranscript: "",
    suggestions: [],
    selectedId: null,
    source: null,
    error: null,
  };
  const pendingCommands = [];

  function activeDisplay() {
    if (anchorDisplay) return anchorDisplay;
    try {
      anchorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch {
      anchorDisplay = screen.getPrimaryDisplay();
    }
    return anchorDisplay;
  }

  function applyBounds() {
    if (!stationWindow || stationWindow.isDestroyed()) return;
    const bounds = stationWindowBounds(activeDisplay(), expanded);
    // Keep the OS-level frame change instantaneous. The visible rail and card
    // own the animation, so the pointer anchor never drifts during a resize.
    stationWindow.setBounds(bounds, false);
  }

  function show() {
    const win = ensureWindow();
    applyBounds();
    win.showInactive();
    return { ok: true };
  }

  function hide() {
    if (stationWindow && !stationWindow.isDestroyed()) stationWindow.hide();
    return { ok: true };
  }

  function forwardCommand(value) {
    const command = normalizeCommand(value);
    if (!command) return { ok: false, error: "invalid Station command" };
    if (command.type === "hide") {
      hide();
      return { ok: true };
    }
    show();
    const main = getMainWindow();
    if (!main || main.isDestroyed() || main.webContents.isDestroyed()) {
      pendingCommands.push(command);
      return { ok: true, queued: true };
    }
    if (command.type === "activate") {
      if (main.isMinimized?.()) main.restore?.();
      main.show?.();
      main.focus?.();
    }
    main.webContents.send("openwork:station:command", command);
    return { ok: true };
  }

  function flushPendingCommands() {
    const main = getMainWindow();
    if (!main || main.isDestroyed() || main.webContents.isDestroyed()) return;
    while (pendingCommands.length) {
      main.webContents.send("openwork:station:command", pendingCommands.shift());
    }
  }

  function publishState(state) {
    if (!isRecord(state)) return { ok: false, error: "invalid Station state" };
    latestState = {
      ...latestState,
      ...state,
      suggestions: Array.isArray(state.suggestions) ? state.suggestions.slice(0, 12) : latestState.suggestions,
    };
    const win = ensureWindow();
    if (!win.webContents.isDestroyed()) {
      win.webContents.send("openwork:station:state", latestState);
    }
    if (latestState.visible) show();
    return { ok: true };
  }

  function ensureWindow() {
    if (stationWindow && !stationWindow.isDestroyed()) return stationWindow;
    stationWindow = new BrowserWindow({
      ...stationWindowBounds(activeDisplay(), false),
      title: "OpenWork Station",
      show: false,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: {
        backgroundThrottling: false,
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    stationWindow.setAlwaysOnTop(true, platform === "darwin" ? "floating" : "normal");
    if (platform === "darwin") {
      stationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    stationWindow.setMenuBarVisibility(false);
    stationWindow.webContents.on("did-finish-load", () => {
      stationWindow?.webContents.send("openwork:station:state", latestState);
    });
    stationWindow.on("closed", () => {
      stationWindow = null;
    });
    void loadContent(stationWindow);
    return stationWindow;
  }

  function setExpanded(value) {
    expanded = value === true;
    applyBounds();
    return { ok: true, expanded };
  }

  function registerIpc() {
    ipcMain.on("openwork:station:publish-state", (_event, state) => {
      publishState(state);
    });
    ipcMain.on("openwork:station:ui-command", (_event, command) => {
      forwardCommand(command);
    });
    ipcMain.handle("openwork:station:get-state", () => latestState);
    ipcMain.handle("openwork:station:set-expanded", (_event, value) => setExpanded(value));
    ipcMain.handle("openwork:station:show", () => show());
    ipcMain.handle("openwork:station:hide", () => hide());
  }

  function initialize() {
    ensureWindow();
    const registered = globalShortcut.register(STATION_SHORTCUT, () => {
      forwardCommand({ type: "toggle-listening" });
    });
    return { registered, shortcut: STATION_SHORTCUT };
  }

  function dispose() {
    try {
      globalShortcut.unregister(STATION_SHORTCUT);
    } catch {
      // best effort during app shutdown
    }
    if (stationWindow && !stationWindow.isDestroyed()) stationWindow.destroy();
    stationWindow = null;
    anchorDisplay = null;
  }

  registerIpc();

  return {
    dispose,
    flushPendingCommands,
    forwardCommand,
    getState: () => latestState,
    initialize,
    publishState,
    setExpanded,
    show,
    hide,
  };
}
