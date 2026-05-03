import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

const PILOT_DEFAULT_MODEL = "gpt-realtime-1.5";
const PILOT_SETTINGS_FILE = "settings.json";
const PILOT_REALTIME_INSTRUCTIONS = [
  "You are Pilot, a macOS computer-control assistant running as a standalone menubar app.",
  "You control the user's Mac through safe, explicit tools: listing apps, bringing apps forward, typing text, pressing key combos, reading/writing clipboard, and opening URLs.",
  "Use snapshot or frontmost_app before acting unless the user named an obvious app/action.",
  "Prefer app-specific activation before typing: activate_app or launch_app first, then type_text or press_key.",
  "Keep spoken responses brief. Narrate what you are doing, then act.",
  "Do not use destructive key combos like command+q, command+w, delete, or return-to-send unless the user explicitly asks or confirms.",
  "When dictating into the frontmost app, type exactly what the user intends, not your own commentary.",
].join(" ");

function getSettingsPath() {
  return path.join(app.getPath("userData"), PILOT_SETTINGS_FILE);
}

async function readPilotSettings() {
  try {
    const raw = await readFile(getSettingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      openAIKey: typeof parsed.openAIKey === "string" ? parsed.openAIKey : "",
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model : PILOT_DEFAULT_MODEL,
    };
  } catch {
    return { openAIKey: "", model: PILOT_DEFAULT_MODEL };
  }
}

async function writePilotSettings(settings) {
  await mkdir(path.dirname(getSettingsPath()), { recursive: true });
  const current = await readPilotSettings();
  const next = {
    ...current,
    ...(typeof settings.openAIKey === "string" ? { openAIKey: settings.openAIKey } : {}),
    ...(typeof settings.model === "string" ? { model: settings.model } : {}),
    model: settings.model?.trim() || current.model || PILOT_DEFAULT_MODEL,
  };
  await writeFile(getSettingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function openAIRealtimeTools() {
  return [
    {
      type: "function",
      name: "snapshot",
      description: "Read Pilot state: frontmost app, running apps, and listening state.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "function",
      name: "list_apps",
      description: "List currently running visible macOS apps.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "function",
      name: "frontmost_app",
      description: "Read the current frontmost macOS app.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "function",
      name: "activate_app",
      description: "Bring a running macOS app to the foreground by name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "App name, e.g. Safari, Notes, OpenWork." } },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "launch_app",
      description: "Launch and activate a macOS app by name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "App name, e.g. Safari, Notes, OpenWork." } },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "type_text",
      description: "Type text into the frontmost app using macOS keystrokes. Does not press return.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Text to type exactly." } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "press_key",
      description: "Press a key or key combo in the frontmost app, e.g. command+c, command+v, tab, escape.",
      parameters: {
        type: "object",
        properties: { combo: { type: "string", description: "Key combo, e.g. command+c, command+shift+v, tab." } },
        required: ["combo"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "clipboard_read",
      description: "Read the macOS clipboard as text.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "function",
      name: "clipboard_write",
      description: "Write text to the macOS clipboard.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "Text to copy to clipboard." } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "open_url",
      description: "Open a URL in the default browser.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute URL to open." } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  ];
}

async function createRealtimeSession() {
  const settings = await readPilotSettings();
  const apiKey = process.env.OPENAI_API_KEY?.trim() || settings.openAIKey?.trim();
  if (!apiKey) {
    throw new Error("Add an OpenAI API key in Pilot before starting realtime control.");
  }

  const model = settings.model || PILOT_DEFAULT_MODEL;
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        output_modalities: ["text"],
        audio: {
          input: {
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              silence_duration_ms: 250,
              prefix_padding_ms: 300,
              create_response: true,
              interrupt_response: false,
            },
          },
        },
        instructions: PILOT_REALTIME_INSTRUCTIONS,
        tool_choice: "auto",
        tools: openAIRealtimeTools(),
      },
    }),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const message = typeof json?.error?.message === "string" ? json.error.message : response.statusText;
    throw new Error(message || "Failed to create OpenAI realtime session");
  }
  const clientSecret =
    typeof json?.client_secret?.value === "string"
      ? json.client_secret.value
      : typeof json?.value === "string"
        ? json.value
        : typeof json?.client_secret === "string"
          ? json.client_secret
          : "";
  if (!clientSecret) throw new Error("OpenAI did not return a usable realtime client secret");
  return {
    clientSecret,
    expiresAt: typeof json?.client_secret?.expires_at === "number" ? json.client_secret.expires_at : null,
    model,
    tools: openAIRealtimeTools().map((tool) => tool.name),
  };
}

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
  // Settings: OpenAI API key and model. Stored locally in app userData.
  ipcMain.handle("pilot:get-settings", async () => {
    const settings = await readPilotSettings();
    return {
      ok: true,
      settings: {
        model: settings.model,
        hasOpenAIKey: Boolean(settings.openAIKey?.trim() || process.env.OPENAI_API_KEY?.trim()),
        openAIKeyPreview: settings.openAIKey
          ? `${settings.openAIKey.slice(0, 7)}••••${settings.openAIKey.slice(-4)}`
          : process.env.OPENAI_API_KEY?.trim()
            ? "OPENAI_API_KEY env"
            : "",
      },
    };
  });

  ipcMain.handle("pilot:save-settings", async (_event, input) => {
    try {
      const settings = await writePilotSettings({
        openAIKey: typeof input?.openAIKey === "string" ? input.openAIKey.trim() : undefined,
        model: typeof input?.model === "string" ? input.model.trim() : undefined,
      });
      return {
        ok: true,
        settings: {
          model: settings.model,
          hasOpenAIKey: Boolean(settings.openAIKey?.trim()),
          openAIKeyPreview: settings.openAIKey ? `${settings.openAIKey.slice(0, 7)}••••${settings.openAIKey.slice(-4)}` : "",
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Realtime: create ephemeral OpenAI client secret. Long-lived API key stays in main process.
  ipcMain.handle("pilot:create-realtime-session", async () => {
    try {
      return { ok: true, session: await createRealtimeSession() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

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
        return: 36, enter: 36, tab: 48, escape: 53,
        space: 49, delete: 51, backspace: 51,
        up: 126, down: 125, left: 123, right: 124,
      };
      const keyCode = special[key];
      const script = keyCode
        ? `tell application "System Events" to key code ${keyCode}${using}`
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
