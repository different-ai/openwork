export const STATION_MODE_SHORTCUT = "CommandOrControl+Shift+Space";
export const STATION_ACTIVE_SHORTCUTS = Object.freeze({
  previous: "Left",
  next: "Right",
  handoff: "Enter",
  dismiss: "Esc",
});

export const STATION_COLLAPSED_BOUNDS = Object.freeze({ width: 66, height: 420 });
export const STATION_EXPANDED_BOUNDS = Object.freeze({ width: 440, height: 420 });

const ALLOWED_COMMANDS = new Set([
  "activate",
  "approve-goal",
  "clear-transcript",
  "dismiss",
  "dismiss-goal",
  "handoff",
  "hide",
  "next",
  "previous",
  "select",
  "seed-demo",
  "set-mode",
  "set-transcript-record",
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
  if (value.type === "set-mode") command.active = value.active === true;
  if (value.type === "set-transcript-record") command.enabled = value.enabled === true;
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
  let enabled = false;
  let expanded = false;
  let rendererExpanded = false;
  let activeMode = false;
  let modeShortcutRegistered = false;
  let collapseTimer = null;
  let anchorDisplay = null;
  let latestState = {
    status: "idle",
    statusText: "Ready when you are.",
    interactionMode: "passive",
    runtime: {
      phase: "idle",
      presentation: "ready",
      runId: 0,
      updatedAt: 0,
    },
    provenance: {
      inputSource: null,
      inferenceMode: null,
      model: null,
    },
    listening: false,
    visible: false,
    transcript: "",
    partialTranscript: "",
    suggestions: [],
    selectedId: null,
    goal: null,
    transcriptRecordEnabled: true,
    source: null,
    error: null,
  };
  const pendingCommands = [];
  const activeShortcutCommands = new Map([
    [STATION_ACTIVE_SHORTCUTS.previous, { type: "previous" }],
    [STATION_ACTIVE_SHORTCUTS.next, { type: "next" }],
    [STATION_ACTIVE_SHORTCUTS.handoff, { type: "handoff" }],
    [STATION_ACTIVE_SHORTCUTS.dismiss, { type: "dismiss" }],
  ]);
  const registeredActiveShortcuts = new Set();

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
    let display = activeDisplay();
    let bounds = stationWindowBounds(display, expanded);
    try {
      const matchedDisplay = screen.getDisplayMatching?.(bounds);
      if (
        matchedDisplay
        && matchedDisplay.id !== undefined
        && display.id !== undefined
        && matchedDisplay.id !== display.id
      ) {
        // Display metrics can change while Station remains enabled (dock/scale
        // changes, disconnects, or mirrored displays). Re-anchor before the
        // right-side pill can end up outside the current live work area.
        anchorDisplay = matchedDisplay;
        display = matchedDisplay;
        bounds = stationWindowBounds(display, expanded);
      }
    } catch {
      // Keep the last stable anchor if display discovery is unavailable.
    }
    // Keep the OS-level frame change instantaneous. The visible rail and card
    // own the animation, so the pointer anchor never drifts during a resize.
    stationWindow.setBounds(bounds, false);
  }

  function setSurfaceExpanded(value) {
    if (!value && (!expanded || collapseTimer)) return;
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
    if (value) {
      expanded = true;
      applyBounds();
      return;
    }
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      expanded = false;
      applyBounds();
    }, 170);
  }

  function syncSurfaceExpanded() {
    setSurfaceExpanded(
      rendererExpanded || (activeMode && latestState.suggestions.length > 0),
    );
  }

  function show() {
    if (!enabled) return { ok: false, reason: "Station is disabled." };
    const win = ensureWindow();
    applyBounds();
    win.showInactive();
    return { ok: true };
  }

  function hide() {
    if (stationWindow && !stationWindow.isDestroyed()) stationWindow.hide();
    return { ok: true };
  }

  function unregisterActiveShortcuts() {
    for (const shortcut of registeredActiveShortcuts) {
      try {
        globalShortcut.unregister(shortcut);
      } catch {
        // best effort while leaving the temporary modal state
      }
    }
    registeredActiveShortcuts.clear();
  }

  function registerActiveShortcuts() {
    for (const [shortcut, command] of activeShortcutCommands) {
      if (registeredActiveShortcuts.has(shortcut)) continue;
      if (globalShortcut.register(shortcut, () => forwardCommand(command))) {
        registeredActiveShortcuts.add(shortcut);
      }
    }
  }

  function syncModeSurface() {
    if (!enabled) return;
    if (activeMode) registerActiveShortcuts();
    else unregisterActiveShortcuts();
    syncSurfaceExpanded();
    show();
  }

  function setActiveMode(value, { forward = true } = {}) {
    if (!enabled) return { ok: false, reason: "Station is disabled.", active: false };
    const next = value === true;
    if (activeMode !== next) {
      activeMode = next;
      syncModeSurface();
    } else {
      syncSurfaceExpanded();
      show();
    }
    if (forward) return forwardCommand({ type: "set-mode", active: activeMode });
    return { ok: true, active: activeMode };
  }

  function forwardCommand(value) {
    const command = normalizeCommand(value);
    if (!command) return { ok: false, error: "invalid Station command" };
    if (!enabled) return { ok: false, reason: "Station is disabled." };
    if (command.type === "hide") {
      hide();
      return { ok: true };
    }
    if (command.type === "set-mode" && command.active !== activeMode) {
      setActiveMode(command.active, { forward: false });
    }
    show();
    const main = getMainWindow();
    if (!main || main.isDestroyed() || main.webContents.isDestroyed()) {
      pendingCommands.push(command);
      return { ok: true, queued: true };
    }
    if (command.type === "activate" || command.type === "handoff") {
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
    if (!enabled) return { ok: true, dormant: true };
    if (state.interactionMode === "active" || state.interactionMode === "passive") {
      const nextActiveMode = state.interactionMode === "active";
      if (activeMode !== nextActiveMode) {
        activeMode = nextActiveMode;
        if (activeMode) registerActiveShortcuts();
        else unregisterActiveShortcuts();
      } else if (activeMode) {
        registerActiveShortcuts();
      }
      syncSurfaceExpanded();
    }
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
    rendererExpanded = value === true;
    syncSurfaceExpanded();
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
    ipcMain.handle("openwork:station:get-enabled", () => ({
      enabled,
      registered: modeShortcutRegistered,
      shortcut: STATION_MODE_SHORTCUT,
    }));
    ipcMain.handle("openwork:station:set-enabled", (_event, value) => setEnabled(value));
    ipcMain.handle("openwork:station:set-expanded", (_event, value) => setExpanded(value));
    ipcMain.handle("openwork:station:show", () => show());
    ipcMain.handle("openwork:station:hide", () => hide());
  }

  function registerModeShortcut() {
    if (!modeShortcutRegistered) {
      modeShortcutRegistered = globalShortcut.register(STATION_MODE_SHORTCUT, () => {
        setActiveMode(!activeMode);
      });
    }
  }

  function unregisterModeShortcut() {
    if (!modeShortcutRegistered) return;
    try {
      globalShortcut.unregister(STATION_MODE_SHORTCUT);
    } catch {
      // best effort while disabling the capability
    }
    modeShortcutRegistered = false;
  }

  function setEnabled(value) {
    const next = value === true;
    if (next) {
      enabled = true;
      registerModeShortcut();
      latestState = { ...latestState, visible: true };
      show();
      return {
        ok: true,
        enabled,
        registered: modeShortcutRegistered,
        shortcut: STATION_MODE_SHORTCUT,
      };
    }

    const main = getMainWindow();
    if (enabled && main && !main.isDestroyed() && !main.webContents.isDestroyed()) {
      main.webContents.send("openwork:station:command", { type: "stop" });
    }
    enabled = false;
    activeMode = false;
    expanded = false;
    rendererExpanded = false;
    pendingCommands.length = 0;
    unregisterActiveShortcuts();
    unregisterModeShortcut();
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = null;
    latestState = {
      ...latestState,
      interactionMode: "passive",
      listening: false,
      visible: false,
      partialTranscript: "",
    };
    if (stationWindow && !stationWindow.isDestroyed()) stationWindow.destroy();
    stationWindow = null;
    anchorDisplay = null;
    return {
      ok: true,
      enabled,
      registered: false,
      shortcut: STATION_MODE_SHORTCUT,
    };
  }

  function initialize() {
    return {
      enabled,
      registered: modeShortcutRegistered,
      shortcut: STATION_MODE_SHORTCUT,
    };
  }

  function dispose() {
    enabled = false;
    unregisterModeShortcut();
    unregisterActiveShortcuts();
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = null;
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
    getEnabled: () => enabled,
    initialize,
    publishState,
    setEnabled,
    setActiveMode,
    setExpanded,
    show,
    hide,
  };
}
