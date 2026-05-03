import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
  Menu,
} from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDevMode = !app.isPackaged;

// ── App identity ──
app.setName("Pilot");
app.setAppUserModelId("com.openwork.pilot");

// menubar-only: hide dock icon on macOS
if (process.platform === "darwin") {
  app.dock?.hide();
}

let tray = null;
let panelWindow = null;
let listening = false;

// ── Resolve UI assets ──
function getUIPath() {
  if (isDevMode) {
    // Dev: vite dev server or built files
    const devDist = path.resolve(__dirname, "../dist/index.html");
    if (existsSync(devDist)) return devDist;
    return path.resolve(__dirname, "../src/index.html");
  }
  // Packaged: electron-builder extraResources
  return path.join(process.resourcesPath, "ui", "index.html");
}

// ── Floating panel window ──
function createPanel() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.show();
    panelWindow.focus();
    return panelWindow;
  }

  const display = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = display.workAreaSize;
  const panelW = 340;
  const panelH = 480;

  panelWindow = new BrowserWindow({
    width: panelW,
    height: panelH,
    x: screenW - panelW - 16,
    y: 40,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    vibrancy: "under-window",
    visualEffectState: "active",
    roundedCorners: true,
    show: false,
    webPreferences: {
      preload: path.resolve(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  panelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const uiPath = getUIPath();
  if (uiPath.startsWith("http")) {
    panelWindow.loadURL(uiPath);
  } else {
    panelWindow.loadFile(uiPath);
  }

  panelWindow.once("ready-to-show", () => {
    panelWindow.show();
  });

  // Panel stays visible — user dismisses with hotkey or tray click
  // panelWindow.on("blur", () => { ... });

  panelWindow.on("closed", () => {
    panelWindow = null;
  });

  return panelWindow;
}

function togglePanel() {
  if (panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible()) {
    panelWindow.hide();
  } else {
    createPanel();
  }
}

// ── Tray ──
function createTrayIcon() {
  // Programmatic 22x22 template icon (mic silhouette) for macOS menubar
  const iconPath = path.resolve(__dirname, "../resources/icons/tray-icon.png");
  if (existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    img.setTemplateImage(true);
    return img;
  }
  // Fallback: draw a simple circle using a data URL
  const size = 22;
  const buf = Buffer.alloc(size * size * 4, 0);
  const cx = size / 2;
  const cy = size / 2;
  const r = 5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= r) {
        const offset = (y * size + x) * 4;
        buf[offset] = 0;     // R
        buf[offset + 1] = 0; // G
        buf[offset + 2] = 0; // B
        buf[offset + 3] = 255; // A
      }
    }
  }
  const img = nativeImage.createFromBuffer(buf, { width: size, height: size });
  img.setTemplateImage(true);
  return img;
}

function createTray() {
  const image = createTrayIcon();

  tray = new Tray(image);
  tray.setToolTip("Pilot — Voice control for macOS");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: listening ? "⏹ Stop listening" : "🎙 Start listening",
      click: () => {
        toggleListening();
      },
    },
    { type: "separator" },
    {
      label: "Show panel",
      accelerator: "CmdOrCtrl+Shift+;",
      click: () => togglePanel(),
    },
    { type: "separator" },
    {
      label: "Quit Pilot",
      accelerator: "CmdOrCtrl+Q",
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on("click", () => togglePanel());
}

function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: listening ? "⏹ Stop listening" : "🎙 Start listening",
      click: () => toggleListening(),
    },
    { type: "separator" },
    {
      label: "Show panel",
      accelerator: "CmdOrCtrl+Shift+;",
      click: () => togglePanel(),
    },
    { type: "separator" },
    {
      label: "Quit Pilot",
      accelerator: "CmdOrCtrl+Q",
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(contextMenu);
}

function toggleListening() {
  listening = !listening;
  updateTrayMenu();
  // Notify the renderer
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send("pilot:listening-changed", listening);
  }
  // If starting to listen, show the panel
  if (listening) {
    createPanel();
  }
}

// ── AppleScript execution ──
function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message));
      } else {
        resolve(stdout?.trim() ?? "");
      }
    });
  });
}

// ── IPC handlers ──
function registerIPC() {
  // System: run AppleScript
  ipcMain.handle("pilot:applescript", async (_event, script) => {
    if (typeof script !== "string" || !script.trim()) {
      return { ok: false, error: "Empty script" };
    }
    try {
      const result = await runAppleScript(script);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // System: list running apps
  ipcMain.handle("pilot:list-apps", async () => {
    try {
      const result = await runAppleScript(
        'tell application "System Events" to get name of every application process whose background only is false'
      );
      const apps = result.split(", ").map((name) => name.trim()).filter(Boolean);
      return { ok: true, apps };
    } catch (err) {
      return { ok: false, error: err.message, apps: [] };
    }
  });

  // System: activate (bring to front) an app
  ipcMain.handle("pilot:activate-app", async (_event, appName) => {
    try {
      await runAppleScript(`tell application "${appName}" to activate`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // System: launch an app
  ipcMain.handle("pilot:launch-app", async (_event, appName) => {
    try {
      await runAppleScript(`tell application "${appName}" to launch`);
      // Give it a moment then activate
      await new Promise((r) => setTimeout(r, 500));
      await runAppleScript(`tell application "${appName}" to activate`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // System: type text (keystroke into frontmost app)
  ipcMain.handle("pilot:type-text", async (_event, text) => {
    try {
      // Escape for AppleScript
      const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      await runAppleScript(
        `tell application "System Events" to keystroke "${escaped}"`
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // System: press a key combo (e.g., "command+c", "command+shift+v")
  ipcMain.handle("pilot:press-key", async (_event, combo) => {
    try {
      const parts = combo.toLowerCase().split("+").map((s) => s.trim());
      const key = parts.pop();
      const modifiers = parts.map((mod) => {
        if (mod === "command" || mod === "cmd") return "command down";
        if (mod === "shift") return "shift down";
        if (mod === "option" || mod === "alt") return "option down";
        if (mod === "control" || mod === "ctrl") return "control down";
        return `${mod} down`;
      });
      const using = modifiers.length ? ` using {${modifiers.join(", ")}}` : "";
      // Handle special keys
      const special = {
        return: "return", enter: "return", tab: "tab", escape: "escape",
        space: "space", delete: "delete", backspace: "delete",
        up: "up arrow", down: "down arrow", left: "left arrow", right: "right arrow",
      };
      const keyCode = special[key];
      const script = keyCode
        ? `tell application "System Events" to key code (key code of "${keyCode}")${using}`
        : `tell application "System Events" to keystroke "${key}"${using}`;
      await runAppleScript(script);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // System: read clipboard
  ipcMain.handle("pilot:clipboard-read", async () => {
    try {
      const result = await runAppleScript("the clipboard");
      return { ok: true, text: result };
    } catch (err) {
      return { ok: false, error: err.message, text: "" };
    }
  });

  // System: write clipboard
  ipcMain.handle("pilot:clipboard-write", async (_event, text) => {
    try {
      const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      await runAppleScript(`set the clipboard to "${escaped}"`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // System: open URL
  ipcMain.handle("pilot:open-url", async (_event, url) => {
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // System: get frontmost app
  ipcMain.handle("pilot:frontmost-app", async () => {
    try {
      const result = await runAppleScript(
        'tell application "System Events" to get name of first application process whose frontmost is true'
      );
      return { ok: true, app: result.trim() };
    } catch (err) {
      return { ok: false, error: err.message, app: "" };
    }
  });

  // Microphone permission
  ipcMain.handle("pilot:request-microphone", async () => {
    if (process.platform !== "darwin") return { granted: true, status: "granted" };
    try {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      if (status === "granted") return { granted: true, status };
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return { granted, status: granted ? "granted" : systemPreferences.getMediaAccessStatus("microphone") };
    } catch (err) {
      return { granted: false, status: err.message };
    }
  });

  // Listening state
  ipcMain.handle("pilot:get-listening", () => listening);
  ipcMain.on("pilot:set-listening", (_event, value) => {
    listening = Boolean(value);
    updateTrayMenu();
  });

  // Media permission handler
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === "media") {
      callback(true);
      return;
    }
    callback(false);
  });
}

// ── App lifecycle ──
app.whenReady().then(() => {
  registerIPC();
  createTray();

  // Global hotkey: Cmd+Shift+; to toggle panel
  globalShortcut.register("CommandOrControl+Shift+;", () => {
    togglePanel();
  });

  // Global hotkey: Cmd+Shift+L to toggle listening
  globalShortcut.register("CommandOrControl+Shift+L", () => {
    toggleListening();
  });

  // Auto-show panel on first launch
  createPanel();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// Keep running when all windows closed (menubar app)
app.on("window-all-closed", (event) => {
  // Do nothing — stay in tray
});

app.on("activate", () => {
  togglePanel();
});
