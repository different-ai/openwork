import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, Menu, WebContentsView, clipboard, dialog, ipcMain, nativeImage, nativeTheme, session, shell } from "electron";
import { registerMigrationIpc } from "./migration.mjs";
import { createRuntimeManager } from "./runtime.mjs";
import { registerUpdaterIpc } from "./updater.mjs";
import { exportWorkspaceConfig, importWorkspaceConfig } from "./workspace-archive.mjs";
import {
  openworkWorkspaceDisplayName,
  selectOpenworkWorkspaceForConnection,
} from "./remote-workspace.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_DEEP_LINK_EVENT = "openwork:deep-link-native";
const NATIVE_MENU_OPEN_SETTINGS_EVENT = "openwork:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "openwork:native-menu:toggle-sidebar";
const TAURI_APP_IDENTIFIER = "com.differentai.openwork";
const DEV_APP_IDENTIFIER = "com.differentai.openwork.dev";
const DESKTOP_PROTOCOL_SCHEME = "openwork";
const isDevMode = process.env.OPENWORK_DEV_MODE === "1";
const APP_NAME = isDevMode ? "OpenWork - Dev" : "OpenWork";
const APP_IDENTIFIER = isDevMode ? DEV_APP_IDENTIFIER : TAURI_APP_IDENTIFIER;
const RELEASE_DOWNLOAD_BASE_URL = "https://github.com/different-ai/openwork/releases/latest/download";
const RELEASE_PAGE_URL = "https://github.com/different-ai/openwork/releases/latest";
const DOCS_PAGE_URL = "https://openworklabs.com/docs";
const BROWSER_PLUGIN = "opencode-chrome-devtools";
const COMPUTER_USE_HELPER_APP_NAME = "OpenWork Computer Use.app";
const COMPUTER_USE_HELPER_EXECUTABLE = "ComputerUse";

function computerUseHelperExecutablePath() {
  const appPath = computerUseHelperAppPath();
  const explicitBinary = process.env.OPENWORK_COMPUTER_USE_BINARY?.trim();
  const candidates = [
    explicitBinary,
    appPath ? path.join(appPath, "Contents", "MacOS", COMPUTER_USE_HELPER_EXECUTABLE) : null,
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function computerUseHelperAppPath() {
  const explicitApp = process.env.OPENWORK_COMPUTER_USE_APP?.trim();
  const candidates = [
    explicitApp,
    process.resourcesPath ? path.join(process.resourcesPath, "helpers", COMPUTER_USE_HELPER_APP_NAME) : null,
    path.resolve(__dirname, "..", "resources", "helpers", COMPUTER_USE_HELPER_APP_NAME),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getComputerUseMcpCommand() {
  const helperExecutable = computerUseHelperExecutablePath();
  if (helperExecutable) return [helperExecutable, "mcp"];

  if (app.isPackaged) {
    throw new Error("OpenWork Computer Use is missing from this OpenWork build.");
  }

  if (process.env.OPENWORK_DEV_MODE === "1") {
    return ["node", path.resolve(__dirname, "../../..", "packages/handsfree/bin/openwork-handsfree-computer-use.mjs"), "mcp"];
  }
  return ["npx", "-y", "@openwork/handsfree", "mcp"];
}

// ---------------------------------------------------------------------------
// Permission checks — spawn the binary with --check, read stdout, done.
// Fresh process = fresh TCC read = always accurate. No HTTP server needed.
// ---------------------------------------------------------------------------

function resolveComputerUseExecutable() {
  // 1. Explicit env override.
  const explicit = process.env.OPENWORK_COMPUTER_USE_BINARY?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  // 2. .app bundle (packaged builds + pnpm dev).
  const appPath = computerUseHelperAppPath();
  if (appPath) {
    const bin = path.join(appPath, "Contents", "MacOS", COMPUTER_USE_HELPER_EXECUTABLE);
    if (existsSync(bin)) return bin;
  }

  // 3. Dev fallback — raw Swift build output.
  if (!app.isPackaged) {
    const swiftPkg = path.resolve(__dirname, "../../..", "packages/handsfree/native/HandsFree");
    const devCandidates = [
      path.join(swiftPkg, ".build", "release", "HandsFreeComputerUse"),
      path.join(swiftPkg, ".build", "arm64-apple-macosx", "release", "HandsFreeComputerUse"),
      path.join(swiftPkg, ".build", "debug", "HandsFreeComputerUse"),
      path.join(swiftPkg, ".build", "arm64-apple-macosx", "debug", "HandsFreeComputerUse"),
    ];
    for (const c of devCandidates) {
      if (existsSync(c)) return c;
    }
  }

  return null;
}

async function checkComputerUsePermissions() {
  // Spawn binary --check → read JSON from stdout → exit. Always fresh.
  const bin = resolveComputerUseExecutable();
  if (!bin) {
    return { ok: false, accessibility: false, screenRecording: false, error: "Helper binary not found. Run pnpm dev to build it." };
  }
  return spawnCheckPermissions(bin);
}

function spawnCheckPermissions(bin) {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(bin, ["--check"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve({ ok: false, accessibility: false, screenRecording: false, error: "Failed to run permission check." }));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({
          ok: parsed?.ok === true,
          accessibility: parsed?.accessibility === true,
          screenRecording: parsed?.screenRecording === true,
        });
      } catch {
        resolve({ ok: false, accessibility: false, screenRecording: false, error: "Permission check returned invalid output." });
      }
    });
  });
}

async function openComputerUseSetupApp() {
  // Open the GUI. Use the .app bundle if available so macOS shows it as
  // a real app with its own dock icon and permission identity.
  const appPath = computerUseHelperAppPath();
  if (appPath) {
    const result = await shell.openPath(appPath);
    if (result) console.error("[ComputerUse] shell.openPath error:", result);
    return;
  }

  // Fallback: spawn the raw binary (opens the same GUI).
  const bin = resolveComputerUseExecutable();
  if (!bin) throw new Error("Helper binary not found. Run pnpm dev to build it.");
  const child = spawn(bin, [], { detached: true, stdio: "ignore" });
  child.unref();
}

// Production Electron shares the same on-disk state folder as the Tauri shell
// so in-place migration is a no-op for almost every file. Dev mode uses the
// separate dev identifier so it can run beside the production app.
//
// Override via OPENWORK_ELECTRON_USERDATA so dogfooders can isolate their
// Electron install from the real Tauri app.
app.setName(APP_NAME);
app.setAppUserModelId(APP_IDENTIFIER);
if (app.isPackaged) {
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL_SCHEME);
}
const userDataOverride = process.env.OPENWORK_ELECTRON_USERDATA?.trim();
if (userDataOverride) {
  app.setPath("userData", userDataOverride);
} else {
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), APP_IDENTIFIER),
  );
}

// Resolve and cache the app icon (reused for BrowserWindow + mac dock).
// Packaged builds ship icons via electron-builder config, but for `dev:electron`
// the Electron default icon is shown without this.
function resolveAppIconPath() {
  const candidates = [
    // Dev: match Tauri's separate dev icon so the dev app is visibly distinct.
    ...(isDevMode
      ? [
          path.resolve(__dirname, "../resources/icons/dev/icon.png"),
          path.resolve(__dirname, "../resources/icons/dev/128x128@2x.png"),
          path.resolve(__dirname, "../resources/icons/dev/icon-dev.icns"),
        ]
      : []),
    // Repo-relative path to the Electron resource icon set.
    path.resolve(__dirname, "../resources/icons/icon.png"),
    // Packaged: electron-builder copies extraResources but we fall back to this
    // if custom packaging ever exposes the icon here.
    path.join(process.resourcesPath ?? "", "icons", "icon.png"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeRuntimeArch(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["arm64", "aarch64", "arm64e"].includes(normalized)) return "arm64";
  if (["x64", "x86_64", "amd64"].includes(normalized)) return "x64";
  return normalized || "unknown";
}

function isMacRunningUnderRosetta() {
  if (process.platform !== "darwin" || process.arch !== "x64") return false;
  try {
    return execFileSync("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() === "1";
  } catch {
    return false;
  }
}

function resolveSystemArch() {
  if (process.platform === "darwin" && isMacRunningUnderRosetta()) return "arm64";
  if (process.platform === "win32") {
    return normalizeRuntimeArch(
      process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || os.arch(),
    );
  }
  if (typeof os.machine === "function") return normalizeRuntimeArch(os.machine());
  return normalizeRuntimeArch(os.arch());
}

function platformDownloadSlug() {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

function downloadAssetArch(arch) {
  if (process.platform === "linux" && arch === "x64") return "x86_64";
  return arch;
}

function downloadAssetExtension() {
  if (process.platform === "darwin") return "dmg";
  if (process.platform === "win32") return "exe";
  return "AppImage";
}

function updaterManifestName(arch) {
  if (process.platform === "darwin") return "latest-mac.yml";
  if (process.platform === "win32") return "latest.yml";
  return arch === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml";
}

function archLabel(arch) {
  if (arch === "arm64") return "ARM";
  if (arch === "x64") return "Intel";
  return arch;
}

function parseUpdaterManifestFiles(raw) {
  const files = [];
  let current = null;
  for (const line of String(raw || "").split(/\r?\n/)) {
    const start = line.match(/^\s*-\s+url:\s*(.+?)\s*$/);
    if (start) {
      current = { url: start[1].trim().replace(/^['"]|['"]$/g, "") };
      files.push(current);
      continue;
    }
    const prop = line.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.+?)\s*$/);
    if (prop && current) {
      current[prop[1]] = prop[2].trim().replace(/^['"]|['"]$/g, "");
    }
  }
  return files.filter((file) => file.url);
}

function selectDownloadFile(files, arch) {
  const assetArch = downloadAssetArch(arch);
  const expected = `-${assetArch}-`;
  const extension = downloadAssetExtension();
  const matchingArch = files.filter((file) => file.url.includes(expected));
  return (
    matchingArch.find((file) => file.url.endsWith(`.${extension}`)) ||
    matchingArch.find((file) => file.url.endsWith(".zip")) ||
    matchingArch[0] ||
    null
  );
}

async function resolveCorrectArchitectureDownloadUrl(arch) {
  const manifestUrl = `${RELEASE_DOWNLOAD_BASE_URL}/${updaterManifestName(arch)}`;
  try {
    const response = await fetch(manifestUrl, {
      headers: { Accept: "text/yaml, text/plain, */*" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const selected = selectDownloadFile(parseUpdaterManifestFiles(await response.text()), arch);
    if (!selected?.url) return null;
    return /^https?:\/\//i.test(selected.url)
      ? selected.url
      : new URL(selected.url, `${RELEASE_DOWNLOAD_BASE_URL}/`).toString();
  } catch (error) {
    console.warn("[architecture] failed to resolve latest download URL", error);
    return null;
  }
}

async function resolveArchitectureInfo() {
  const appArch = normalizeRuntimeArch(process.arch);
  const systemArch = resolveSystemArch();
  const version = app.getVersion();
  const targetArch = systemArch === "arm64" || systemArch === "x64" ? systemArch : appArch;
  const assetName = `openwork-${platformDownloadSlug()}-${downloadAssetArch(targetArch)}-${version}.${downloadAssetExtension()}`;
  const latestDownloadUrl = await resolveCorrectArchitectureDownloadUrl(targetArch);
  const hasCorrectArchitectureDownload = Boolean(latestDownloadUrl);
  return {
    appArch,
    appArchLabel: archLabel(appArch),
    systemArch,
    systemArchLabel: archLabel(systemArch),
    mismatch: appArch !== systemArch && hasCorrectArchitectureDownload,
    platform: process.platform === "win32" ? "windows" : process.platform,
    version,
    downloadUrl: latestDownloadUrl || `${RELEASE_DOWNLOAD_BASE_URL}/${assetName}`,
    releaseUrl: RELEASE_PAGE_URL,
  };
}

const APP_ICON_PATH = resolveAppIconPath();
const APP_ICON_IMAGE = APP_ICON_PATH ? nativeImage.createFromPath(APP_ICON_PATH) : null;

if (process.platform === "darwin" && APP_ICON_IMAGE && !APP_ICON_IMAGE.isEmpty() && app.dock) {
  app.dock.setIcon(APP_ICON_IMAGE);
}

// Expose Chrome DevTools Protocol so the opencode-chrome-devtools plugin can
// drive the built-in browser panel.  Use OPENWORK_ELECTRON_REMOTE_DEBUG_PORT to
// pin a specific port; otherwise probe for a free one starting at 9223.
// Must resolve before app.commandLine.appendSwitch (before `ready`).
function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1" }, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function findFreeCdpPort(candidates) {
  for (const port of candidates) {
    if (await probePort(port)) return port;
  }
  return 0;
}

const explicitCdpPort = Number.parseInt(
  process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() ?? "",
  10,
);
const remoteDebugPort = Number.isFinite(explicitCdpPort) && explicitCdpPort > 0
  ? explicitCdpPort
  : await findFreeCdpPort([9223, 9224, 9225, 9226, 9227]);
if (remoteDebugPort > 0) {
  app.commandLine.appendSwitch("remote-debugging-port", String(remoteDebugPort));
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
// Make the resolved port available to the embedded server so it flows into
// agent instructions via ensureOpenworkAgent → resolveAgentTemplate.
process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT = String(remoteDebugPort);

// Apply extra Chromium flags from ELECTRON_EXTRA_LAUNCH_ARGS.
// Used in headless/Daytona environments to pass e.g. --disable-gpu.
const extraLaunchArgs = (process.env.ELECTRON_EXTRA_LAUNCH_ARGS ?? "").trim();
if (extraLaunchArgs) {
  for (const arg of extraLaunchArgs.split(/\s+/)) {
    const cleaned = arg.replace(/^--/, "");
    if (!cleaned) continue;
    const eqIdx = cleaned.indexOf("=");
    if (eqIdx > 0) {
      app.commandLine.appendSwitch(cleaned.slice(0, eqIdx), cleaned.slice(eqIdx + 1));
    } else {
      app.commandLine.appendSwitch(cleaned);
    }
  }
}
const DEFAULT_DEN_BASE_URL = "https://app.openworklabs.com";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:4096";
const FORCE_DESKTOP_REQUIRE_SIGNIN = envFlagEnabled("OPENWORK_FORCE_SIGNIN");
const DEFAULT_DESKTOP_REQUIRE_SIGNIN = FORCE_DESKTOP_REQUIRE_SIGNIN;
let applicationMenuVisible = process.platform === "darwin";

function envFlagEnabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const EMPTY_WORKSPACE_LIST = Object.freeze({
  selectedId: "",
  watchedId: null,
  activeId: null,
  workspaces: [],
});

const IDLE_ENGINE_INFO = Object.freeze({
  running: false,
  runtime: "direct",
  baseUrl: null,
  projectDir: null,
  hostname: null,
  port: null,
  opencodeUsername: null,
  opencodePassword: null,
  opencodeBinPath: null,
  opencodeBinSource: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

const IDLE_OPENWORK_SERVER_INFO = Object.freeze({
  running: false,
  remoteAccessEnabled: false,
  host: null,
  port: null,
  baseUrl: null,
  connectUrl: null,
  mdnsUrl: null,
  lanUrl: null,
  clientToken: null,
  ownerToken: null,
  hostToken: null,
  managedOpencodeBinPath: null,
  managedOpencodeBinSource: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

const IDLE_ROUTER_INFO = Object.freeze({
  running: false,
  version: null,
  workspacePath: null,
  opencodeUrl: null,
  healthPort: null,
  pid: null,
  lastStdout: null,
  lastStderr: null,
});

let mainWindow = null;
const pendingDeepLinks = [];
let uiControlServer = null;
let uiControlDiscoveryPath = null;
const uiControlToken = randomBytes(32).toString("hex");

function isLocalRendererOrigin(origin) {
  const value = String(origin ?? "").trim();
  if (!value || value === "file://") return true;
  try {
    const url = new URL(value);
    return url.protocol === "file:" || url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function isMainWindowWebContents(webContents) {
  return Boolean(mainWindow && webContents && webContents.id === mainWindow.webContents.id);
}

function shouldAllowMainWindowPermission(webContents, permission, origin, details = {}) {
  if (!isMainWindowWebContents(webContents)) return false;
  if (!isLocalRendererOrigin(origin)) return false;
  if (permission !== "media" && permission !== "audioCapture") return true;
  const mediaType = typeof details.mediaType === "string" ? details.mediaType : "";
  if (mediaType && mediaType !== "audio") return false;
  const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  return mediaTypes.length === 0 || (mediaTypes.includes("audio") && !mediaTypes.includes("video"));
}

function installMediaPermissionHandlers() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(shouldAllowMainWindowPermission(webContents, permission, details?.requestingUrl, details));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    shouldAllowMainWindowPermission(webContents, permission, requestingOrigin, details)
  ));
}

// ── Embedded browser panel ─────────────────────────────────────────────
const browserTabs = new Map();
let browserTabOrder = [];
let activeBrowserTabId = null;
let browserViewVisible = false;
let lastBrowserBounds = null;
let browserTabCounter = 0;
const BROWSER_DEFAULT_URL = "https://www.google.com";
const MENU_OVERLAY_HTML = "overlay.html";
const MENU_OVERLAY_WIDTH = 196;
const MENU_OVERLAY_HEIGHT = 176;
const MENU_OVERLAY_READY_TIMEOUT_MS = 2000;
let menuOverlayView = null;
let menuOverlayRequest = null;
let menuOverlayReady = false;
let menuOverlayReadyResolvers = [];
let menuOverlayShowSerial = 0;

function resetMenuOverlayReady({ resolvePending = false } = {}) {
  menuOverlayReady = false;
  if (resolvePending) {
    const resolvers = menuOverlayReadyResolvers.splice(0);
    for (const resolve of resolvers) resolve(false);
  }
}

function markMenuOverlayReady(view) {
  if (!view || view.webContents.isDestroyed()) return;
  menuOverlayReady = true;
  const resolvers = menuOverlayReadyResolvers.splice(0);
  for (const resolve of resolvers) resolve(true);
}

function waitForMenuOverlayReady(view) {
  if (menuOverlayReady) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer = null;
    const done = (ready) => {
      if (timer) clearTimeout(timer);
      menuOverlayReadyResolvers = menuOverlayReadyResolvers.filter((candidate) => candidate !== done);
      resolve(ready);
    };
    timer = setTimeout(() => done(false), MENU_OVERLAY_READY_TIMEOUT_MS);
    menuOverlayReadyResolvers.push(done);
    if (!view || view.webContents.isDestroyed()) done(false);
  });
}

/** Send an IPC message to the main renderer, guarding against disposed frames. */
function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try { mainWindow.webContents.send(channel, payload); } catch { /* window closing */ }
}

async function openSettingsFromNativeMenu() {
  const win = await createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send(NATIVE_MENU_OPEN_SETTINGS_EVENT);
}

async function toggleSidebarFromNativeMenu() {
  const win = await createMainWindow();
  win.webContents.send(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT);
}

function installApplicationMenu() {
  const isMac = process.platform === "darwin";
  const template = /** @type {import("electron").MenuItemConstructorOptions[]} */ ([
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: "about" },
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
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
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
        {
          label: "Docs",
          click: async () => {
            await shell.openExternal(DOCS_PAGE_URL);
          },
        },
      ],
    },
  ]);

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function applyApplicationMenuVisibility(window) {
  if (process.platform === "darwin") return;
  window.setAutoHideMenuBar(false);
  window.setMenuBarVisibility(applicationMenuVisible);
}

function setApplicationMenuVisible(visible) {
  applicationMenuVisible = visible === true;
  for (const window of BrowserWindow.getAllWindows()) {
    applyApplicationMenuVisibility(window);
  }
  return applicationMenuVisible;
}

function createBrowserTabId() {
  browserTabCounter += 1;
  return `tab_${Date.now().toString(36)}_${browserTabCounter.toString(36)}`;
}

function normalizeBrowserUrl(url, fallback = BROWSER_DEFAULT_URL) {
  const target = typeof url === "string" && url.trim() ? url.trim() : fallback;
  if (!target || target === "about:blank") return "about:blank";
  return /^https?:\/\//i.test(target) ? target : `https://${target}`;
}

function getBrowserTab(tabId = activeBrowserTabId) {
  return tabId ? browserTabs.get(tabId) ?? null : null;
}

function getActiveBrowserView() {
  return getBrowserTab()?.view ?? null;
}

function getActiveWebContents() {
  return getActiveBrowserView()?.webContents ?? null;
}

function listBrowserTabs() {
  return browserTabOrder
    .map((tabId) => {
      const tab = browserTabs.get(tabId);
      if (!tab || tab.view.webContents.isDestroyed()) return null;
      return {
        tabId,
        url: tab.view.webContents.getURL(),
        title: tab.view.webContents.getTitle(),
        favicon: tab.favicon,
        canGoBack: tab.view.webContents.canGoBack(),
        canGoForward: tab.view.webContents.canGoForward(),
        isLoading: tab.view.webContents.isLoading(),
        isActive: tabId === activeBrowserTabId,
      };
    })
    .filter(Boolean);
}

function browserStatePayload() {
  const activeTab = getBrowserTab();
  const activeWebContents = activeTab?.view.webContents;
  const activeState = activeWebContents && !activeWebContents.isDestroyed()
    ? {
        url: activeWebContents.getURL(),
        title: activeWebContents.getTitle(),
        canGoBack: activeWebContents.canGoBack(),
        canGoForward: activeWebContents.canGoForward(),
        isLoading: activeWebContents.isLoading(),
      }
    : {
        url: "",
        title: "",
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
      };
  return {
    ...activeState,
    activeTabId: activeBrowserTabId,
    tabs: listBrowserTabs(),
  };
}

function browserTabUrl(tab) {
  const url = tab?.view?.webContents?.getURL?.();
  return typeof url === "string" && url && url !== "about:blank" ? url : null;
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeMenuOverlayPoint(point) {
  if (!point || typeof point !== "object") {
    return { x: 0, y: 0 };
  }
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { x: 0, y: 0 };
  }
  return { x: Math.round(x), y: Math.round(y) };
}

function menuOverlayBounds(point) {
  const [contentWidth, contentHeight] = mainWindow?.getContentSize?.() ?? [MENU_OVERLAY_WIDTH, MENU_OVERLAY_HEIGHT];
  return {
    x: Math.min(Math.max(point.x, 0), Math.max(contentWidth - MENU_OVERLAY_WIDTH - 4, 0)),
    y: Math.min(Math.max(point.y, 0), Math.max(contentHeight - MENU_OVERLAY_HEIGHT - 4, 0)),
    width: MENU_OVERLAY_WIDTH,
    height: MENU_OVERLAY_HEIGHT,
  };
}

function menuOverlayUrl() {
  const currentUrl = mainWindow?.webContents?.getURL?.();
  if (currentUrl && /^https?:\/\//i.test(currentUrl)) {
    return new URL(MENU_OVERLAY_HTML, currentUrl).toString();
  }
  return null;
}

async function loadMenuOverlayRenderer(view) {
  const devUrl = menuOverlayUrl();
  if (devUrl) {
    await view.webContents.loadURL(devUrl);
    return;
  }

  const packagedOverlayPath = path.join(process.resourcesPath, "app-dist", MENU_OVERLAY_HTML);
  const devOverlayPath = path.resolve(__dirname, "../../app/dist", MENU_OVERLAY_HTML);
  await view.webContents.loadFile(app.isPackaged ? packagedOverlayPath : devOverlayPath);
}

async function ensureMenuOverlayView() {
  if (menuOverlayView && !menuOverlayView.webContents.isDestroyed()) {
    return menuOverlayView;
  }

  const view = new WebContentsView({
    webPreferences: {
      // Electron only runs ESM preload scripts reliably with sandbox disabled.
      // Keep the bridge isolated and node-free for the React overlay document.
      backgroundThrottling: false,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "menu-overlay-preload.mjs"),
    },
  });
  view.setBackgroundColor?.("#00000000");
  view.setVisible?.(false);
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) resetMenuOverlayReady();
  });
  view.webContents.once("destroyed", () => {
    if (menuOverlayView === view) {
      menuOverlayView = null;
      menuOverlayRequest = null;
      resetMenuOverlayReady({ resolvePending: true });
    }
  });

  menuOverlayView = view;
  resetMenuOverlayReady({ resolvePending: true });
  await loadMenuOverlayRenderer(view);
  return view;
}

function hideMenuOverlay() {
  const view = menuOverlayView;
  menuOverlayShowSerial += 1;
  menuOverlayRequest = null;
  if (!view || !mainWindow) return;
  view.setVisible?.(false);
  try {
    if (mainWindow.contentView.children.includes(view)) {
      mainWindow.contentView.removeChildView(view);
    }
  } catch {
    // already removed
  }
}

function bringMenuOverlayToTop(view) {
  if (!mainWindow) return;
  try {
    if (mainWindow.contentView.children.includes(view)) {
      mainWindow.contentView.removeChildView(view);
    }
  } catch {
    // already removed
  }
  mainWindow.contentView.addChildView(view);
}

function tabMenuRequest(tab, point) {
  const url = browserTabUrl(tab);
  return {
    id: `tab-menu:${tab.tabId}:${Date.now()}`,
    source: "tab",
    tabId: tab.tabId,
    url,
    bounds: menuOverlayBounds(normalizeMenuOverlayPoint(point)),
    items: [
      { id: "copy-url", label: "Copy URL", iconName: "copy", disabled: !url },
      { id: "open-external", label: "Open in Browser", iconName: "external", disabled: !(url && isHttpUrl(url)) },
      { id: "close-tab", label: "Close Tab", iconName: "close", separatorBefore: true },
      { id: "close-all-tabs", label: "Close All Tabs", iconName: "close" },
    ],
  };
}

async function showBrowserTabContextMenu(tabId, point) {
  const tab = getBrowserTab(String(tabId ?? ""));
  if (!mainWindow || !tab || tab.view.webContents.isDestroyed()) return;

  const showSerial = menuOverlayShowSerial + 1;
  menuOverlayShowSerial = showSerial;
  const request = tabMenuRequest(tab, point);
  const view = await ensureMenuOverlayView();
  if (showSerial !== menuOverlayShowSerial || menuOverlayView !== view) return;
  menuOverlayRequest = request;
  view.setBounds(request.bounds);
  view.setVisible?.(true);
  bringMenuOverlayToTop(view);
  const ready = await waitForMenuOverlayReady(view);
  if (showSerial !== menuOverlayShowSerial || menuOverlayRequest !== request || menuOverlayView !== view) return;
  if (!ready) {
    console.warn("[menu-overlay] renderer did not signal readiness before show");
  }
  view.webContents.send("openwork:menu-overlay:show", {
    id: request.id,
    source: request.source,
    items: request.items,
  });
  view.webContents.focus();
}

function handleMenuOverlayChoice(payload) {
  if (!payload || payload.requestId !== menuOverlayRequest?.id) return;
  const request = menuOverlayRequest;
  const tab = getBrowserTab(request.tabId);
  hideMenuOverlay();

  switch (payload.itemId) {
    case "copy-url":
      if (request.url) clipboard.writeText(request.url);
      break;
    case "open-external":
      if (request.url && isHttpUrl(request.url)) void shell.openExternal(request.url);
      break;
    case "close-tab":
      if (tab) closeBrowserTab(tab.tabId);
      break;
    case "close-all-tabs":
      closeAllBrowserTabs();
      break;
  }
}

function createBrowserTab(url = "about:blank", { select = true } = {}) {
  const tabId = createBrowserTabId();
  const view = new WebContentsView({
    webPreferences: {
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "browser-content-preload.cjs"),
      partition: "persist:openwork-browser",
    },
  });
  const tab = { tabId, view, favicon: null };
  browserTabs.set(tabId, tab);
  browserTabOrder.push(tabId);
  // Load about:blank immediately to preempt persistent-session restore.
  // Cookies live on the session object, not the document — they survive this.
  view.webContents.loadURL("about:blank");
  view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    void shell.openExternal(targetUrl);
    return { action: "deny" };
  });
  view.webContents.on("did-start-navigation", (_event, targetUrl, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace && targetUrl !== "about:blank") {
      sendToRenderer("openwork:browser:panel-opened");
    }
  });
  view.webContents.on("did-navigate", () => sendBrowserState());
  view.webContents.on("did-navigate-in-page", () => sendBrowserState());
  view.webContents.on("page-title-updated", () => sendBrowserState());
  view.webContents.on("page-favicon-updated", (_event, favicons) => {
    tab.favicon = Array.isArray(favicons) ? favicons[0] ?? null : null;
    sendBrowserState();
  });
  view.webContents.on("did-start-loading", () => sendBrowserState());
  view.webContents.on("did-stop-loading", () => sendBrowserState());
  view.webContents.once("destroyed", () => {
    browserTabs.delete(tabId);
    browserTabOrder = browserTabOrder.filter((id) => id !== tabId);
    if (activeBrowserTabId === tabId) activeBrowserTabId = browserTabOrder[0] ?? null;
    sendBrowserState();
  });
  if (select || !activeBrowserTabId) {
    selectBrowserTab(tabId);
  } else {
    sendBrowserState();
  }
  const finalUrl = normalizeBrowserUrl(url, "about:blank");
  if (finalUrl !== "about:blank") {
    view.webContents.loadURL(finalUrl);
  }
  return tab;
}

function detachBrowserView(view) {
  if (!mainWindow || !view) return;
  try {
    if (mainWindow.contentView.children.includes(view)) {
      mainWindow.contentView.removeChildView(view);
    }
  } catch {
    // already removed
  }
}

function attachActiveBrowserView() {
  if (!mainWindow || !browserViewVisible) return;
  const view = getActiveBrowserView();
  if (!view) return;
  for (const tab of browserTabs.values()) {
    if (tab.view !== view) detachBrowserView(tab.view);
  }
  if (!mainWindow.contentView.children.includes(view)) {
    mainWindow.contentView.addChildView(view);
  }
  if (lastBrowserBounds && lastBrowserBounds.width > 0 && lastBrowserBounds.height > 0) {
    view.setBounds(lastBrowserBounds);
  }
}

function selectBrowserTab(tabId) {
  if (!browserTabs.has(tabId)) throw new Error(`Unknown browser tab: ${tabId}`);
  hideMenuOverlay();
  const previousView = getActiveBrowserView();
  activeBrowserTabId = tabId;
  if (previousView && previousView !== getActiveBrowserView()) {
    detachBrowserView(previousView);
  }
    attachActiveBrowserView();
  sendBrowserState();
  return getBrowserTab(tabId);
}

function closeBrowserTab(tabId = activeBrowserTabId) {
  const tab = getBrowserTab(tabId);
  if (!tab) return null;
  if (menuOverlayRequest?.tabId === tabId) hideMenuOverlay();
  const closingIndex = browserTabOrder.indexOf(tabId);
  const wasActive = activeBrowserTabId === tabId;
  detachBrowserView(tab.view);
  browserTabs.delete(tabId);
  browserTabOrder = browserTabOrder.filter((id) => id !== tabId);
  if (wasActive) {
    const nextTabId =
      browserTabOrder[Math.min(closingIndex, browserTabOrder.length - 1)] ??
      browserTabOrder[closingIndex - 1] ??
      null;
    activeBrowserTabId = nextTabId;
    if (nextTabId) {
      attachActiveBrowserView();
    } else {
      hideBrowserView();
      sendToRenderer("openwork:browser:panel-closed");
    }
  }
  try { tab.view.webContents.close(); } catch { /* already destroyed */ }
  sendBrowserState();
  return tabId;
}

function closeAllBrowserTabs() {
  const closedTabIds = [...browserTabOrder];
  if (closedTabIds.length === 0) return [];
  hideMenuOverlay();
  const tabsToClose = closedTabIds
    .map((tabId) => browserTabs.get(tabId))
    .filter(Boolean);
  hideBrowserView();
  browserTabs.clear();
  browserTabOrder = [];
  activeBrowserTabId = null;
  for (const tab of tabsToClose) {
    try { tab.view.webContents.close(); } catch { /* already destroyed */ }
  }
  sendToRenderer("openwork:browser:panel-closed");
  sendBrowserState();
  return closedTabIds;
}

function reorderBrowserTabs(tabIds) {
  const nextOrder = Array.isArray(tabIds) ? tabIds.map(String) : [];
  if (nextOrder.length !== browserTabOrder.length) {
    throw new Error("Tab order must include every open tab.");
  }
  if (new Set(nextOrder).size !== nextOrder.length) {
    throw new Error("Tab order must not contain duplicate tabs.");
  }
  const current = new Set(browserTabOrder);
  if (nextOrder.some((tabId) => !current.has(tabId))) {
    throw new Error("Tab order contains an unknown tab.");
  }
  browserTabOrder = nextOrder;
  sendBrowserState();
  return listBrowserTabs();
}

function sendBrowserState() {
  sendToRenderer("openwork:browser:state", browserStatePayload());
}

/**
 * Attach the browser view to the main window.
 * @param {object} bounds — { x, y, width, height }
 * @param {object} [opts]
 * @param {boolean} [opts.preloadDefault=true] - load default URL if the view has no URL
 * @param {boolean} [opts.ensureTab=true] - create a blank tab if needed
 */
function attachBrowserView(bounds, { preloadDefault = true, ensureTab = true } = {}) {
  if (!mainWindow) return;
  lastBrowserBounds = bounds;
  browserViewVisible = true;
  if (ensureTab && !activeBrowserTabId) createBrowserTab("about:blank");
  const view = getActiveBrowserView();
  attachActiveBrowserView();
  if (bounds.width > 0 && bounds.height > 0) {
    view?.setBounds(bounds);
  }
  const url = view?.webContents.getURL();
  if (preloadDefault && (!url || url === "about:blank")) {
    view?.webContents.loadURL(BROWSER_DEFAULT_URL);
  }
  sendBrowserState();
}

function hideBrowserView() {
  hideMenuOverlay();
  browserViewVisible = false;
  if (!mainWindow) return;
  for (const tab of browserTabs.values()) {
    detachBrowserView(tab.view);
  }
}

function destroyBrowserView() {
  hideBrowserView();
  const overlayView = menuOverlayView;
  menuOverlayView = null;
  menuOverlayRequest = null;
  try { overlayView?.webContents.close(); } catch { /* already destroyed */ }
  for (const tab of browserTabs.values()) {
    try { tab.view.webContents.close(); } catch { /* already destroyed */ }
  }
  browserTabs.clear();
  browserTabOrder = [];
  activeBrowserTabId = null;
  lastBrowserBounds = null;
  sendBrowserState();
}

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function forwardedDeepLinks(argv) {
  return argv
    .slice(1)
    .map((entry) => entry.trim())
    .filter(
      (entry) =>
        entry.startsWith("openwork://") ||
        entry.startsWith("openwork-dev://") ||
        entry.startsWith("https://") ||
        entry.startsWith("http://"),
    );
}

function queueDeepLinks(urls) {
  const nextUrls = urls.filter(Boolean);
  if (nextUrls.length === 0) return;
  pendingDeepLinks.push(...nextUrls);
  if (mainWindow?.webContents) {
    mainWindow.webContents.send(NATIVE_DEEP_LINK_EVENT, nextUrls);
  }
}

function flushPendingDeepLinks() {
  if (!mainWindow?.webContents || pendingDeepLinks.length === 0) return;
  const urls = pendingDeepLinks.splice(0, pendingDeepLinks.length);
  mainWindow.webContents.send(NATIVE_DEEP_LINK_EVENT, urls);
}

function desktopBootstrapPath() {
  if (process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH?.trim()) {
    return process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH.trim();
  }
  return path.join(os.homedir(), ".config", "openwork", "desktop-bootstrap.json");
}

function workspaceStatePath() {
  return path.join(app.getPath("userData"), "openwork-workspaces.json");
}

// Earlier Electron alpha builds copied Tauri's openwork-workspaces.json into an
// Electron-only workspace-state.json. Keep importing that file when the shared
// canonical file is missing, but write openwork-workspaces.json going forward so
// Tauri rollback and Electron both read the same desktop workspace state.
function legacyElectronWorkspaceStatePath() {
  return path.join(app.getPath("userData"), "workspace-state.json");
}

async function migrateLegacyElectronWorkspaceStateIfNeeded() {
  const current = workspaceStatePath();
  const legacy = legacyElectronWorkspaceStatePath();
  try {
    if (existsSync(current)) return false;
    if (!existsSync(legacy)) return false;
    await mkdir(path.dirname(current), { recursive: true });
    const raw = await readFile(legacy, "utf8");
    await writeFile(current, raw, "utf8");
    console.info(
      "[migration] copied workspace-state.json → openwork-workspaces.json",
    );
    return true;
  } catch (error) {
    console.warn("[migration] legacy Electron workspace-state copy failed", error);
    return false;
  }
}

function configHomePath() {
  if (process.env.XDG_CONFIG_HOME?.trim()) {
    return process.env.XDG_CONFIG_HOME.trim();
  }
  if (process.platform === "win32" && process.env.APPDATA?.trim()) {
    return process.env.APPDATA.trim();
  }
  return path.join(os.homedir(), ".config");
}

function globalOpencodeRoot() {
  return path.join(configHomePath(), "opencode");
}

function execResult(ok, stdout = "", stderr = "", status = ok ? 0 : 1) {
  return { ok, status, stdout, stderr };
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(targetPath) {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function readJsonFile(targetPath, fallback) {
  try {
    const raw = await readFile(targetPath, "utf8");
    try {
      return JSON.parse(raw);
    } catch (error) {
      const recovered = parseFirstJsonObject(raw);
      if (recovered.ok) {
        console.warn(`[json] recovered ${targetPath} from trailing invalid data`, error);
        await writeJsonFileAtomic(targetPath, recovered.value);
        return recovered.value;
      }
      throw error;
    }
  } catch {
    return fallback;
  }
}

function parseFirstJsonObject(raw) {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          return { ok: true, value: JSON.parse(raw.slice(start, index + 1)) };
        } catch {
          return { ok: false, value: null };
        }
      }
    }
  }

  return { ok: false, value: null };
}

async function writeJsonFileAtomic(outputPath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(content);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, outputPath);
}

function normalizeDesktopBootstrapConfig(input) {
  const baseUrl = typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!baseUrl) {
    throw new Error("baseUrl is required");
  }

  const apiBaseUrl =
    typeof input?.apiBaseUrl === "string" && input.apiBaseUrl.trim().length > 0
      ? input.apiBaseUrl.trim()
      : null;

  return {
    baseUrl,
    apiBaseUrl,
    requireSignin: FORCE_DESKTOP_REQUIRE_SIGNIN || input?.requireSignin === true,
  };
}

async function getDesktopBootstrapConfig() {
  const configPath = desktopBootstrapPath();
  try {
    const raw = await readFile(configPath, "utf8");
    return normalizeDesktopBootstrapConfig(JSON.parse(raw));
  } catch (error) {
    console.warn("[desktop-bootstrap] falling back to defaults", {
      path: configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      baseUrl: DEFAULT_DEN_BASE_URL,
      apiBaseUrl: null,
      requireSignin: DEFAULT_DESKTOP_REQUIRE_SIGNIN,
    };
  }
}

async function debugDesktopBootstrapConfig() {
  const configPath = desktopBootstrapPath();
  const result = {
    path: configPath,
    home: os.homedir(),
    envHome: process.env.HOME ?? null,
    envOverride: process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH ?? null,
    exists: existsSync(configPath),
    raw: null,
    parsed: null,
    normalized: null,
    error: null,
  };

  try {
    result.raw = await readFile(configPath, "utf8");
    result.parsed = JSON.parse(result.raw);
    result.normalized = normalizeDesktopBootstrapConfig(result.parsed);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

async function setDesktopBootstrapConfig(config) {
  const normalized = normalizeDesktopBootstrapConfig(config);
  const outputPath = desktopBootstrapPath();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

function sanitizeCommandName(raw) {
  const trimmed = String(raw ?? "").trim().replace(/^\/+/, "");
  if (!trimmed) return null;
  const safe = Array.from(trimmed)
    .filter((char) => /[A-Za-z0-9_-]/.test(char))
    .join("");
  return safe || null;
}

function escapeYamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function serializeCommandFrontmatter(command) {
  const template = String(command?.template ?? "").trim();
  if (!template) {
    throw new Error("command.template is required");
  }

  let output = "---\n";
  if (typeof command?.description === "string" && command.description.trim()) {
    output += `description: ${escapeYamlScalar(command.description.trim())}\n`;
  }
  if (typeof command?.agent === "string" && command.agent.trim()) {
    output += `agent: ${escapeYamlScalar(command.agent.trim())}\n`;
  }
  if (typeof command?.model === "string" && command.model.trim()) {
    output += `model: ${escapeYamlScalar(command.model.trim())}\n`;
  }
  if (command?.subtask === true) {
    output += "subtask: true\n";
  }
  output += `---\n\n${template}\n`;
  return output;
}

function validateSkillName(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    throw new Error("skill name must be kebab-case");
  }
  return trimmed;
}

function defaultWorkspaceOpenworkConfig(workspacePath, preset = null) {
  return {
    version: 1,
    workspace: workspacePath
      ? {
          name: path.basename(workspacePath) || "Workspace",
          createdAt: Date.now(),
          preset: preset || null,
        }
      : null,
    authorizedRoots: workspacePath ? [workspacePath] : [],
    reload: null,
  };
}

async function workspaceOpencodeConfigPath(workspacePath) {
  const candidates = [
    path.join(workspacePath, "opencode.jsonc"),
    path.join(workspacePath, "opencode.json"),
    path.join(workspacePath, ".opencode", "opencode.jsonc"),
    path.join(workspacePath, ".opencode", "opencode.json"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return candidates[0];
}

async function ensureDefaultWorkspaceOpencodeConfig(workspacePath) {
  const configPath = await workspaceOpencodeConfigPath(workspacePath);
  if (await pathExists(configPath)) return false;
  await writeJsonFileAtomic(configPath, {
    $schema: "https://opencode.ai/config.json",
    default_agent: "openwork",
    plugin: [BROWSER_PLUGIN],
  });
  return true;
}

async function normalizeLocalWorkspacePath(rawPath) {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) return "";
  const expanded = trimmed === "~"
    ? os.homedir()
    : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed;
  const resolved = path.resolve(expanded);
  return realpath(resolved).catch(() => resolved);
}

function normalizeWorkspacePathKey(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? path.resolve(trimmed).replace(/\\/g, "/").toLowerCase() : "";
}

function stableWorkspaceId(value) {
  return `ws_${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
}

function localWorkspaceId(workspacePath) {
  return stableWorkspaceId(workspacePath);
}

function remoteWorkspaceId(baseUrl, directory) {
  const key = String(directory ?? "").trim()
    ? `remote::${baseUrl}::${String(directory).trim()}`
    : `remote::${baseUrl}`;
  return stableWorkspaceId(key);
}

function parseOpenworkWorkspaceIdFromUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    const workspaceIndex = segments.indexOf("workspace");
    const legacyIndex = segments.indexOf("w");
    const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
    return mountIndex >= 0 && segments[mountIndex + 1]
      ? decodeURIComponent(segments[mountIndex + 1])
      : null;
  } catch {
    const match = raw.match(/\/(?:workspace|w)\/([^/?#]+)/);
    if (!match?.[1]) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
}

function stripOpenworkWorkspaceMount(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    const workspaceIndex = segments.indexOf("workspace");
    const legacyIndex = segments.indexOf("w");
    const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
    if (mountIndex >= 0 && segments[mountIndex + 1]) {
      const prefix = segments.slice(0, mountIndex).join("/");
      url.pathname = prefix ? `/${prefix}` : "/";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/(?:workspace|w)\/[^/?#]+.*$/, "").replace(/\/+$/, "") || raw;
  }
}

function openworkRemoteWorkspaceId(hostUrl, workspaceId) {
  const remoteWorkspaceId = String(workspaceId ?? "").trim() || parseOpenworkWorkspaceIdFromUrl(hostUrl);
  if (remoteWorkspaceId) return `rem_${remoteWorkspaceId}`;
  return `rem_${createHash("sha256").update(`openwork::${hostUrl}`).digest("hex").slice(0, 12)}`;
}

async function fetchOpenworkWorkspaceList(hostUrl, token, hostToken) {
  const url = `${String(hostUrl ?? "").replace(/\/+$/, "")}/workspaces`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  const headers = new Headers();
  const bearerToken = String(token ?? "").trim();
  const hostAuthToken = String(hostToken ?? "").trim();
  if (bearerToken) headers.set("Authorization", `Bearer ${bearerToken}`);
  if (hostAuthToken) headers.set("X-OpenWork-Host-Token", hostAuthToken);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`OpenWork workspace discovery failed (${response.status} ${response.statusText || "HTTP error"})`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverOpenworkWorkspace({ hostUrl, token, hostToken, directory }) {
  const list = await fetchOpenworkWorkspaceList(hostUrl, token, hostToken);
  return selectOpenworkWorkspaceForConnection(list, directory);
}

async function readWorkspaceOpenworkConfig(workspacePath) {
  const openworkPath = path.join(workspacePath, ".opencode", "openwork.json");
  if (!(await pathExists(openworkPath))) {
    return defaultWorkspaceOpenworkConfig(workspacePath);
  }
  const raw = await readFile(openworkPath, "utf8");
  return JSON.parse(raw);
}

async function writeWorkspaceOpenworkConfig(workspacePath, config) {
  const openworkPath = path.join(workspacePath, ".opencode", "openwork.json");
  await mkdir(path.dirname(openworkPath), { recursive: true });
  await writeFile(openworkPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return execResult(true, `Wrote ${openworkPath}`);
}

async function readWorkspaceState() {
  const state = await readJsonFile(workspaceStatePath(), EMPTY_WORKSPACE_LIST);
  const selectedId =
    typeof state?.selectedId === "string"
      ? state.selectedId
      : typeof state?.selectedWorkspaceId === "string"
        ? state.selectedWorkspaceId
        : typeof state?.activeId === "string"
          ? state.activeId
          : "";
  const watchedId =
    typeof state?.watchedId === "string"
      ? state.watchedId
      : typeof state?.watchedWorkspaceId === "string"
        ? state.watchedWorkspaceId
        : null;
  const activeId = typeof state?.activeId === "string" ? state.activeId : null;
  const workspaces = Array.isArray(state?.workspaces) ? state.workspaces : [];
  let changed = false;
  const idMap = new Map();
  const migratedWorkspaces = workspaces.map((entry) => {
    const workspace = entry && typeof entry === "object" ? entry : normalizeWorkspaceEntry(entry ?? {});
    if (workspace.workspaceType !== "remote" || workspace.remoteType !== "openwork") return workspace;

    const remoteWorkspaceId = String(workspace.openworkWorkspaceId ?? "").trim()
      || parseOpenworkWorkspaceIdFromUrl(workspace.openworkHostUrl)
      || parseOpenworkWorkspaceIdFromUrl(workspace.baseUrl);
    if (!remoteWorkspaceId) return workspace;

    const hostUrl = stripOpenworkWorkspaceMount(workspace.openworkHostUrl) || stripOpenworkWorkspaceMount(workspace.baseUrl);
    const nextId = openworkRemoteWorkspaceId(hostUrl ?? workspace.baseUrl, remoteWorkspaceId);
    idMap.set(workspace.id, nextId);
    const nextWorkspace = {
      ...workspace,
      id: nextId,
      baseUrl: hostUrl,
      openworkWorkspaceId: remoteWorkspaceId,
      openworkHostUrl: hostUrl,
    };
    if (workspace.id !== nextWorkspace.id || workspace.baseUrl !== nextWorkspace.baseUrl || workspace.openworkWorkspaceId !== nextWorkspace.openworkWorkspaceId || workspace.openworkHostUrl !== nextWorkspace.openworkHostUrl) {
      changed = true;
    }
    return nextWorkspace;
  });
  // Older desktop state can contain multiple OpenWork remote entries that
  // normalize to the same `rem_<workspaceId>` after stripping worker mounts.
  // Collapse them here so React never receives duplicate workspace keys.
  const workspaceIndexById = new Map();
  const dedupedWorkspaces = [];
  for (const workspace of migratedWorkspaces) {
    const workspaceId = String(workspace?.id ?? "").trim();
    if (!workspaceId) {
      dedupedWorkspaces.push(workspace);
      continue;
    }
    const existingIndex = workspaceIndexById.get(workspaceId);
    if (existingIndex === undefined) {
      workspaceIndexById.set(workspaceId, dedupedWorkspaces.length);
      dedupedWorkspaces.push(workspace);
      continue;
    }
    // Keep the later entry: normal mutations replace-then-push refreshed
    // remote workspaces, and there is no persisted updatedAt to compare.
    dedupedWorkspaces[existingIndex] = workspace;
    changed = true;
  }

  const migratedSelectedId = idMap.get(selectedId) ?? selectedId;
  const migratedWatchedId = watchedId ? idMap.get(watchedId) ?? watchedId : null;
  const migratedActiveId = activeId ? idMap.get(activeId) ?? activeId : null;
  if (migratedSelectedId !== selectedId || migratedWatchedId !== watchedId || migratedActiveId !== activeId) changed = true;

  const nextState = {
    selectedId:
      migratedSelectedId,
    watchedId: migratedWatchedId,
    activeId: migratedActiveId,
    workspaces: dedupedWorkspaces,
  };

  if (changed) {
    return writeWorkspaceState(nextState);
  }
  return nextState;
}

async function writeWorkspaceState(nextState) {
  const outputPath = workspaceStatePath();
  const selectedId = String(nextState?.selectedId ?? nextState?.activeId ?? "");
  const watchedId = typeof nextState?.watchedId === "string" ? nextState.watchedId : "";
  const output = {
    ...nextState,
    // Tauri's Rust state uses selectedWorkspaceId/watchedWorkspaceId on disk
    // (with activeId as a legacy alias). Keep Electron's selectedId/watchedId
    // too so older Electron builds can still read the same file.
    selectedId,
    selectedWorkspaceId: selectedId,
    watchedId: watchedId || null,
    watchedWorkspaceId: watchedId,
    activeId: selectedId || null,
  };
  await writeJsonFileAtomic(outputPath, output);
  return output;
}

const runtimeManager = createRuntimeManager({
  app,
  desktopRoot: path.resolve(__dirname, ".."),
  listLocalWorkspacePaths: async () =>
    (await readWorkspaceState())
      .workspaces
      .filter((entry) => entry?.workspaceType !== "remote")
      .map((entry) => String(entry?.path ?? "").trim())
      .filter(Boolean),
});

let runtimeDisposedForQuit = false;
let runtimeBootstrapPromise = null;

async function disposeRuntimeBeforeQuit() {
  if (runtimeDisposedForQuit) return;
  runtimeDisposedForQuit = true;
  await runtimeManager.dispose().catch(() => undefined);
}

function assertOpenworkServerReady(info) {
  if (!info?.running) {
    throw new Error("OpenWork server did not stay running after startup.");
  }
  if (!info.baseUrl) {
    throw new Error("OpenWork server did not report a base URL after startup.");
  }
  if (!info.ownerToken && !info.clientToken) {
    throw new Error("OpenWork server did not report an access token after startup.");
  }
  return info;
}

async function bootRuntimeForSelectedWorkspace() {
  const list = await readWorkspaceState();
  const selectedId = list.selectedId || list.activeId || list.workspaces[0]?.id || "";
  const workspace = selectedId
    ? list.workspaces.find((entry) => entry?.id === selectedId)
    : list.workspaces[0];
  const workspaceRoot = String(workspace?.path ?? "").trim();
  if (!workspaceRoot || workspace?.workspaceType === "remote") {
    return { ok: true, skipped: true, reason: "no-local-workspace" };
  }

  const workspacePaths = [];
  for (const entry of list.workspaces) {
    if (entry?.workspaceType === "remote") continue;
    const workspacePath = String(entry?.path ?? "").trim();
    if (workspacePath && !workspacePaths.includes(workspacePath)) workspacePaths.push(workspacePath);
  }
  if (!workspacePaths.includes(workspaceRoot)) workspacePaths.unshift(workspaceRoot);

  let bootWorkspace = workspace;
  let bootWorkspaceRoot = workspaceRoot;
  let engine;
  try {
    engine = await runtimeManager.engineStart(workspaceRoot, {
      runtime: "direct",
      workspacePaths,
    });
  } catch (error) {
    const fallback = list.workspaces.find((entry) => {
      const candidatePath = String(entry?.path ?? "").trim();
      return entry?.workspaceType !== "remote" && candidatePath && candidatePath !== workspaceRoot;
    });
    const fallbackRoot = String(fallback?.path ?? "").trim();
    if (!fallback || !fallbackRoot) throw error;
    console.warn("[runtime] selected workspace failed during boot; trying fallback workspace", {
      selectedWorkspaceId: workspace?.id ?? null,
      fallbackWorkspaceId: fallback.id ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    const fallbackWorkspacePaths = [
      fallbackRoot,
      ...workspacePaths.filter((entry) => entry !== fallbackRoot && entry !== workspaceRoot),
    ];
    engine = await runtimeManager.engineStart(fallbackRoot, {
      runtime: "direct",
      workspacePaths: fallbackWorkspacePaths,
    });
    bootWorkspace = fallback;
    bootWorkspaceRoot = fallbackRoot;
    await writeWorkspaceState({
      ...list,
      selectedId: String(fallback.id ?? ""),
      watchedId: String(fallback.id ?? ""),
    }).catch(() => undefined);
  }
  await runtimeManager.orchestratorWorkspaceActivate({
    workspacePath: bootWorkspaceRoot,
    name: bootWorkspace.name ?? bootWorkspace.displayName ?? null,
  }).catch(() => undefined);
  const openworkServer = assertOpenworkServerReady(await runtimeManager.openworkServerInfo());
  return { ok: true, skipped: false, engine, openworkServer, workspaceId: bootWorkspace.id ?? null };
}

function ensureRuntimeBootstrap() {
  if (!runtimeBootstrapPromise) {
    runtimeBootstrapPromise = bootRuntimeForSelectedWorkspace().catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return runtimeBootstrapPromise;
}

function normalizeWorkspaceEntry(input) {
  return {
    id: String(input.id),
    name: String(input.name ?? "Workspace"),
    path: String(input.path ?? ""),
    preset: String(input.preset ?? "starter"),
    workspaceType: input.workspaceType === "remote" ? "remote" : "local",
    remoteType: input.remoteType ?? null,
    baseUrl: input.baseUrl ?? null,
    directory: input.directory ?? null,
    displayName: input.displayName ?? null,
    openworkHostUrl: input.openworkHostUrl ?? null,
    openworkToken: input.openworkToken ?? null,
    openworkClientToken: input.openworkClientToken ?? null,
    openworkHostToken: input.openworkHostToken ?? null,
    openworkWorkspaceId: input.openworkWorkspaceId ?? null,
    openworkWorkspaceName: input.openworkWorkspaceName ?? null,
    sandboxBackend: input.sandboxBackend ?? null,
    sandboxRunId: input.sandboxRunId ?? null,
    sandboxContainerName: input.sandboxContainerName ?? null,
  };
}

async function mutateWorkspaceState(mutator) {
  const current = await readWorkspaceState();
  const next = await mutator({ ...current, workspaces: [...current.workspaces] });
  return writeWorkspaceState(next);
}

function resolveOpencodeConfigPath(scope, projectDir) {
  let root;
  if (scope === "project") {
    if (!String(projectDir ?? "").trim()) {
      throw new Error("projectDir is required");
    }
    root = projectDir;
  } else if (scope === "global") {
    root = globalOpencodeRoot();
  } else {
    throw new Error("scope must be 'project' or 'global'");
  }

  const jsoncPath = path.join(root, "opencode.jsonc");
  const jsonPath = path.join(root, "opencode.json");
  return { jsoncPath, jsonPath };
}

async function readOpencodeConfig(scope, projectDir) {
  const { jsoncPath, jsonPath } = resolveOpencodeConfigPath(scope, projectDir);
  const chosenPath = (await pathExists(jsoncPath)) ? jsoncPath : (await pathExists(jsonPath)) ? jsonPath : jsoncPath;
  const exists = await pathExists(chosenPath);
  return {
    path: chosenPath,
    exists,
    content: exists ? await readFile(chosenPath, "utf8") : null,
  };
}

async function writeOpencodeConfig(scope, projectDir, content) {
  const { jsoncPath, jsonPath } = resolveOpencodeConfigPath(scope, projectDir);
  const targetPath = (await pathExists(jsoncPath)) ? jsoncPath : (await pathExists(jsonPath)) ? jsonPath : jsoncPath;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  return execResult(true, `Wrote ${targetPath}`);
}

function resolveCommandsDir(scope, projectDir) {
  if (scope === "workspace") {
    if (!String(projectDir ?? "").trim()) {
      throw new Error("projectDir is required");
    }
    return path.join(projectDir, ".opencode", "commands");
  }
  if (scope === "global") {
    return path.join(globalOpencodeRoot(), "commands");
  }
  throw new Error("scope must be 'workspace' or 'global'");
}

async function listCommandNames(scope, projectDir) {
  const commandsDir = resolveCommandsDir(scope, projectDir);
  if (!(await isDirectory(commandsDir))) {
    return [];
  }
  const entries = await readdir(commandsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.replace(/\.md$/, ""))
    .sort();
}

async function writeCommandFile(scope, projectDir, command) {
  const safeName = sanitizeCommandName(command?.name);
  if (!safeName) {
    throw new Error("command.name is required");
  }
  const commandsDir = resolveCommandsDir(scope, projectDir);
  await mkdir(commandsDir, { recursive: true });
  const filePath = path.join(commandsDir, `${safeName}.md`);
  await writeFile(filePath, serializeCommandFrontmatter({ ...command, name: safeName }), "utf8");
  return execResult(true, `Wrote ${filePath}`);
}

async function deleteCommandFile(scope, projectDir, name) {
  const safeName = sanitizeCommandName(name);
  if (!safeName) {
    throw new Error("name is required");
  }
  const commandsDir = resolveCommandsDir(scope, projectDir);
  const filePath = path.join(commandsDir, `${safeName}.md`);
  if (await pathExists(filePath)) {
    await rm(filePath, { force: true });
  }
  return execResult(true, `Deleted ${filePath}`);
}

async function collectProjectSkillRoots(projectDir) {
  const roots = [];
  let current = path.resolve(projectDir);

  while (true) {
    const opencodeSkills = path.join(current, ".opencode", "skills");
    const legacySkills = path.join(current, ".opencode", "skill");
    const claudeSkills = path.join(current, ".claude", "skills");

    if (await isDirectory(opencodeSkills)) roots.push(opencodeSkills);
    if (await isDirectory(legacySkills)) roots.push(legacySkills);
    if (await isDirectory(claudeSkills)) roots.push(claudeSkills);

    if (await pathExists(path.join(current, ".git"))) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots;
}

async function collectGlobalSkillRoots() {
  const roots = [];
  const candidates = [
    path.join(globalOpencodeRoot(), "skills"),
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".agent", "skills"),
  ];

  for (const candidate of candidates) {
    if (await isDirectory(candidate)) {
      roots.push(candidate);
    }
  }

  return roots;
}

async function collectSkillRoots(projectDir) {
  const roots = [...(await collectProjectSkillRoots(projectDir)), ...(await collectGlobalSkillRoots())];
  return roots.filter((value, index) => roots.indexOf(value) === index);
}

async function findSkillDirsInRoot(root) {
  const found = [];
  if (!(await isDirectory(root))) return found;

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const direct = path.join(root, entry.name);
    if (await pathExists(path.join(direct, "SKILL.md"))) {
      found.push(direct);
      continue;
    }

    const nestedEntries = await readdir(direct, { withFileTypes: true }).catch(() => []);
    for (const nested of nestedEntries) {
      if (!nested.isDirectory()) continue;
      const nestedDir = path.join(direct, nested.name);
      if (await pathExists(path.join(nestedDir, "SKILL.md"))) {
        found.push(nestedDir);
      }
    }
  }

  return found;
}

function extractFrontmatterValue(raw, keys) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (!keys.includes(key)) continue;
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (value) return value;
  }
  return null;
}

function extractTrigger(raw) {
  return extractFrontmatterValue(raw, ["trigger", "when"]);
}

function extractDescription(raw) {
  let inFrontmatter = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter || trimmed.startsWith("#")) continue;
    const cleaned = trimmed.replace(/`/g, "");
    return cleaned.length > 180 ? `${cleaned.slice(0, 180)}...` : cleaned;
  }
  return null;
}

async function listLocalSkills(projectDir) {
  if (!String(projectDir ?? "").trim()) {
    throw new Error("projectDir is required");
  }

  const seen = new Set();
  const out = [];
  for (const root of await collectSkillRoots(projectDir)) {
    for (const skillDir of await findSkillDirsInRoot(root)) {
      const name = path.basename(skillDir);
      if (seen.has(name)) continue;
      seen.add(name);
      let raw = "";
      try {
        raw = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
      } catch {
        raw = "";
      }
      out.push({
        name,
        path: skillDir,
        description: extractDescription(raw) ?? undefined,
        trigger: extractTrigger(raw) ?? undefined,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function findSkillFile(projectDir, name) {
  const safeName = validateSkillName(name);
  for (const root of await collectSkillRoots(projectDir)) {
    const direct = path.join(root, safeName, "SKILL.md");
    if (await pathExists(direct)) return direct;

    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(root, entry.name, safeName, "SKILL.md");
      if (await pathExists(nested)) return nested;
    }
  }
  return null;
}

async function ensureProjectSkillRoot(projectDir) {
  if (!String(projectDir ?? "").trim()) {
    throw new Error("projectDir is required");
  }
  const opencodeRoot = path.join(projectDir, ".opencode");
  const legacy = path.join(opencodeRoot, "skill");
  const modern = path.join(opencodeRoot, "skills");
  if ((await isDirectory(legacy)) && !(await pathExists(modern))) {
    await rename(legacy, modern);
  }
  await mkdir(modern, { recursive: true });
  return modern;
}

function engineDoctor(options = {}) {
  return runtimeManager.engineDoctor(options);
}

function activeWindowFromEvent(event) {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
}

function macosVibrancyForCurrentTheme() {
  return nativeTheme.shouldUseDarkColors ? "under-window" : "sidebar";
}

function applyNativeTheme(mode) {
  nativeTheme.themeSource = mode;

  if (process.platform !== "darwin") {
    return true;
  }

  mainWindow?.setVibrancy(macosVibrancyForCurrentTheme());
  mainWindow?.setBackgroundColor("#00000001");

  return true;
}

async function handleDesktopInvoke(event, command, ...args) {
  switch (command) {
    case "workspaceBootstrap":
      return readWorkspaceState();
    case "workspaceSetSelected":
      return mutateWorkspaceState((state) => {
        const workspaceId = typeof args[0] === "string" ? args[0] : "";
        state.selectedId = workspaceId;
        state.activeId = workspaceId || null;
        return state;
      });
    case "workspaceSetRuntimeActive":
      return mutateWorkspaceState((state) => {
        state.watchedId = typeof args[0] === "string" && args[0].trim() ? args[0] : null;
        return state;
      });
    case "workspaceCreate": {
      const input = args[0] ?? {};
      const rawFolderPath = String(input.folderPath ?? "").trim();
      if (!rawFolderPath) throw new Error("folderPath is required");
      const folderPath = await normalizeLocalWorkspacePath(rawFolderPath);
      await mkdir(folderPath, { recursive: true });
      const preset = String(input.preset ?? "starter");
      const workspace = normalizeWorkspaceEntry({
        id: localWorkspaceId(folderPath),
        name: String(input.name ?? (path.basename(folderPath) || "Workspace")),
        displayName: String(input.name ?? (path.basename(folderPath) || "Workspace")),
        path: folderPath,
        preset,
        workspaceType: "local",
      });
      await mkdir(path.join(folderPath, ".opencode"), { recursive: true });
      await ensureDefaultWorkspaceOpencodeConfig(folderPath);
      await writeWorkspaceOpenworkConfig(folderPath, defaultWorkspaceOpenworkConfig(folderPath, preset));

      return mutateWorkspaceState((state) => {
        const workspacePathKey = normalizeWorkspacePathKey(workspace.path);
        state.workspaces = state.workspaces.filter(
          (entry) => entry.id !== workspace.id && normalizeWorkspacePathKey(entry.path) !== workspacePathKey,
        );
        state.workspaces.push(workspace);
        state.selectedId = workspace.id;
        state.activeId = workspace.id;
        state.watchedId = workspace.id;
        return state;
      });
    }
    case "workspaceCreateRemote": {
      const input = args[0] ?? {};
      const baseUrl = String(input.baseUrl ?? "").trim();
      if (!baseUrl) throw new Error("baseUrl is required");
      if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
        throw new Error("baseUrl must start with http:// or https://");
      }
      const remoteType = input.remoteType === "opencode" ? "opencode" : "openwork";
      const directory = typeof input.directory === "string" && input.directory.trim() ? input.directory.trim() : null;
      const rawOpenworkHostUrl = typeof input.openworkHostUrl === "string" && input.openworkHostUrl.trim()
        ? input.openworkHostUrl.trim()
        : null;
      const openworkHostUrl = remoteType === "openwork"
        ? stripOpenworkWorkspaceMount(rawOpenworkHostUrl ?? baseUrl)
        : rawOpenworkHostUrl;
      const openworkWorkspaceId = typeof input.openworkWorkspaceId === "string" && input.openworkWorkspaceId.trim()
        ? input.openworkWorkspaceId.trim()
        : remoteType === "openwork"
          ? parseOpenworkWorkspaceIdFromUrl(rawOpenworkHostUrl) || parseOpenworkWorkspaceIdFromUrl(baseUrl)
          : null;
      let resolvedOpenworkWorkspaceId = openworkWorkspaceId;
      let resolvedOpenworkWorkspaceName = input.openworkWorkspaceName ?? null;
      if (remoteType === "openwork" && !resolvedOpenworkWorkspaceId) {
        const discovered = await discoverOpenworkWorkspace({
          hostUrl: openworkHostUrl ?? baseUrl,
          token: input.openworkToken,
          hostToken: input.openworkHostToken,
          directory,
        });
        if (!discovered?.id) {
          throw new Error(
            directory
              ? `OpenWork server has no workspace matching ${directory}.`
              : "OpenWork server returned no workspaces.",
          );
        }
        resolvedOpenworkWorkspaceId = String(discovered.id).trim();
        resolvedOpenworkWorkspaceName = openworkWorkspaceDisplayName(discovered);
      }
      const id = remoteType === "openwork"
        ? openworkRemoteWorkspaceId(openworkHostUrl ?? baseUrl, resolvedOpenworkWorkspaceId)
        : remoteWorkspaceId(baseUrl, directory);
      const workspace = normalizeWorkspaceEntry({
        id,
        name: String(input.displayName ?? resolvedOpenworkWorkspaceName ?? "Remote workspace"),
        displayName: input.displayName ?? null,
        path: directory ?? "",
        preset: "remote",
        workspaceType: "remote",
        remoteType,
        baseUrl: remoteType === "openwork" ? (openworkHostUrl ?? baseUrl) : baseUrl,
        directory,
        openworkHostUrl,
        openworkToken: input.openworkToken ?? null,
        openworkClientToken: input.openworkClientToken ?? null,
        openworkHostToken: input.openworkHostToken ?? null,
        openworkWorkspaceId: resolvedOpenworkWorkspaceId,
        openworkWorkspaceName: resolvedOpenworkWorkspaceName,
        sandboxBackend: input.sandboxBackend ?? null,
        sandboxRunId: input.sandboxRunId ?? null,
        sandboxContainerName: input.sandboxContainerName ?? null,
      });
      return mutateWorkspaceState((state) => {
        state.workspaces = state.workspaces.filter((entry) => entry.id !== workspace.id);
        state.workspaces.push(workspace);
        state.selectedId = workspace.id;
        state.activeId = workspace.id;
        return state;
      });
    }
    case "workspaceUpdateRemote": {
      const input = args[0] ?? {};
      const workspaceId = String(input.workspaceId ?? "").trim();
      if (!workspaceId) throw new Error("workspaceId is required");
      const { workspaceId: _workspaceId, ...patch } = input;
      return mutateWorkspaceState(async (state) => {
        const existing = state.workspaces.find((entry) => entry.id === workspaceId);
        if (!existing) return state;

        let nextWorkspace = { ...existing, ...patch };
        const nextRemoteType = nextWorkspace.remoteType === "opencode" ? "opencode" : "openwork";
        if (nextRemoteType === "openwork") {
          const rawHostUrl = typeof nextWorkspace.openworkHostUrl === "string" && nextWorkspace.openworkHostUrl.trim()
            ? nextWorkspace.openworkHostUrl.trim()
            : null;
          const nextBaseUrl = String(nextWorkspace.baseUrl ?? "").trim();
          const hostUrl = stripOpenworkWorkspaceMount(rawHostUrl ?? nextBaseUrl);
          const directory = typeof nextWorkspace.directory === "string" && nextWorkspace.directory.trim()
            ? nextWorkspace.directory.trim()
            : null;
          const parsedWorkspaceId = parseOpenworkWorkspaceIdFromUrl(rawHostUrl) || parseOpenworkWorkspaceIdFromUrl(nextBaseUrl);
          let remoteWorkspaceId = parsedWorkspaceId || (
            typeof nextWorkspace.openworkWorkspaceId === "string" && nextWorkspace.openworkWorkspaceId.trim()
              ? nextWorkspace.openworkWorkspaceId.trim()
              : null
          );
          let remoteWorkspaceName = nextWorkspace.openworkWorkspaceName ?? null;
          if (!remoteWorkspaceId) {
            const discovered = await discoverOpenworkWorkspace({
              hostUrl: hostUrl ?? nextBaseUrl,
              token: nextWorkspace.openworkToken,
              hostToken: nextWorkspace.openworkHostToken,
              directory,
            });
            if (!discovered?.id) {
              throw new Error(
                directory
                  ? `OpenWork server has no workspace matching ${directory}.`
                  : "OpenWork server returned no workspaces.",
              );
            }
            remoteWorkspaceId = String(discovered.id).trim();
            remoteWorkspaceName = openworkWorkspaceDisplayName(discovered);
          }
          const nextId = openworkRemoteWorkspaceId(hostUrl ?? nextBaseUrl, remoteWorkspaceId);
          nextWorkspace = normalizeWorkspaceEntry({
            ...nextWorkspace,
            id: nextId,
            baseUrl: hostUrl ?? nextBaseUrl,
            openworkHostUrl: hostUrl,
            directory,
            remoteType: "openwork",
            openworkWorkspaceId: remoteWorkspaceId,
            openworkWorkspaceName: remoteWorkspaceName,
          });
          if (nextId !== workspaceId) {
            if (state.selectedId === workspaceId) state.selectedId = nextId;
            if (state.activeId === workspaceId) state.activeId = nextId;
            if (state.watchedId === workspaceId) state.watchedId = nextId;
          }
        }

        state.workspaces = state.workspaces.map((entry) =>
          entry.id === workspaceId ? nextWorkspace : entry,
        );
        return state;
      });
    }
    case "workspaceUpdateDisplayName": {
      const input = args[0] ?? {};
      const workspaceId = String(input.workspaceId ?? "").trim();
      if (!workspaceId) throw new Error("workspaceId is required");
      return mutateWorkspaceState((state) => {
        state.workspaces = state.workspaces.map((entry) =>
          entry.id === workspaceId ? { ...entry, displayName: input.displayName ?? null } : entry,
        );
        return state;
      });
    }
    case "workspaceForget": {
      const workspaceId = String(args[0] ?? "").trim();
      if (!workspaceId) throw new Error("workspaceId is required");
      return mutateWorkspaceState((state) => {
        state.workspaces = state.workspaces.filter((entry) => entry.id !== workspaceId);
        if (state.selectedId === workspaceId) state.selectedId = "";
        if (state.activeId === workspaceId) state.activeId = null;
        if (state.watchedId === workspaceId) state.watchedId = null;
        return state;
      });
    }
    case "workspaceAddAuthorizedRoot": {
      const input = args[0] ?? {};
      const workspacePath = String(input.workspacePath ?? "").trim();
      const authorizedRoot = String(input.folderPath ?? input.authorizedRoot ?? "").trim();
      if (!workspacePath || !authorizedRoot) {
        throw new Error("workspacePath and folderPath are required");
      }
      const config = await readWorkspaceOpenworkConfig(workspacePath);
      if (!Array.isArray(config.authorizedRoots)) {
        config.authorizedRoots = [];
      }
      if (!config.authorizedRoots.includes(authorizedRoot)) {
        config.authorizedRoots.push(authorizedRoot);
      }
      return writeWorkspaceOpenworkConfig(workspacePath, config);
    }
    case "workspaceOpenworkRead":
      return readWorkspaceOpenworkConfig(String(args[0]?.workspacePath ?? "").trim());
    case "workspaceOpenworkWrite":
      return writeWorkspaceOpenworkConfig(
        String(args[0]?.workspacePath ?? "").trim(),
        args[0]?.config ?? defaultWorkspaceOpenworkConfig(""),
      );
    case "workspaceExportConfig": {
      const input = args[0] ?? {};
      const workspaceId = String(input.workspaceId ?? "").trim();
      const outputPath = String(input.outputPath ?? "").trim();
      if (!workspaceId) throw new Error("workspaceId is required");
      if (!outputPath) throw new Error("outputPath is required");
      const state = await readWorkspaceState();
      const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
      if (!workspace) throw new Error("Unknown workspaceId");
      return exportWorkspaceConfig({ workspace, outputPath });
    }
    case "workspaceImportConfig": {
      const input = args[0] ?? {};
      const archivePath = String(input.archivePath ?? "").trim();
      const targetDirRaw = String(input.targetDir ?? "").trim();
      if (!archivePath) throw new Error("archivePath is required");
      if (!targetDirRaw) throw new Error("targetDir is required");
      const targetDir = await normalizeLocalWorkspacePath(targetDirRaw);
      const imported = await importWorkspaceConfig({
        archivePath,
        targetDir,
        name: input.name ?? null,
      });
      const workspace = normalizeWorkspaceEntry({
        id: localWorkspaceId(targetDir),
        name: imported.workspaceName,
        displayName: null,
        path: targetDir,
        preset: imported.preset,
        workspaceType: "local",
      });
      return mutateWorkspaceState((state) => {
        const workspacePathKey = normalizeWorkspacePathKey(workspace.path);
        state.workspaces = state.workspaces.filter(
          (entry) => entry.id !== workspace.id && normalizeWorkspacePathKey(entry.path) !== workspacePathKey,
        );
        state.workspaces.push(workspace);
        state.selectedId = workspace.id;
        state.activeId = workspace.id;
        state.watchedId = workspace.id;
        return state;
      });
    }
    case "opencodeCommandList":
      return listCommandNames(String(args[0]?.scope ?? "").trim(), String(args[0]?.projectDir ?? "").trim());
    case "opencodeCommandWrite":
      return writeCommandFile(
        String(args[0]?.scope ?? "").trim(),
        String(args[0]?.projectDir ?? "").trim(),
        args[0]?.command ?? {},
      );
    case "opencodeCommandDelete":
      return deleteCommandFile(
        String(args[0]?.scope ?? "").trim(),
        String(args[0]?.projectDir ?? "").trim(),
        String(args[0]?.name ?? "").trim(),
      );
    case "engineStart": {
      const projectDir = String(args[0] ?? "").trim();
      const options = args[1] ?? {};
      return runtimeManager.engineStart(projectDir, options);
    }
    case "prepareFreshRuntime":
      return runtimeManager.prepareFreshRuntime();
    case "runtimeBootstrap":
      return ensureRuntimeBootstrap();
    case "runtimeStatus":
      return runtimeManager.runtimeStatus();
    case "engineStop":
      return runtimeManager.engineStop();
    case "engineRestart":
      return runtimeManager.engineRestart(args[0] ?? {});
    case "engineInfo":
      return runtimeManager.engineInfo();
    case "engineDoctor":
      return engineDoctor(args[0]);
    case "engineInstall":
      return runtimeManager.engineInstall();
    case "orchestratorStatus": {
      return runtimeManager.orchestratorStatus();
    }
    case "orchestratorWorkspaceActivate": {
      return runtimeManager.orchestratorWorkspaceActivate(args[0] ?? {});
    }
    case "orchestratorInstanceDispose":
      return runtimeManager.orchestratorInstanceDispose(String(args[0] ?? "").trim());
    case "appBuildInfo":
      return {
        version: app.getVersion(),
        gitSha: process.env.OPENWORK_GIT_SHA ?? null,
        buildEpoch: process.env.OPENWORK_BUILD_EPOCH ?? null,
        openworkDevMode: process.env.OPENWORK_DEV_MODE === "1",
      };
    case "getUiControlBridgeInfo":
      try {
        const raw = await readFile(path.join(app.getPath("userData"), "openwork-ui-control.json"), "utf8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
    case "getOpenworkUiMcpCommand": {
      if (process.env.OPENWORK_DEV_MODE === "1") {
        return ["node", path.resolve(__dirname, "../../..", "packages/openwork-ui-mcp/index.mjs")];
      }
      return ["npx", "-y", "openwork-ui-mcp"];
    }
    case "getComputerUseMcpCommand": {
      return getComputerUseMcpCommand();
    }
    case "checkComputerUsePermissions": {
      // Spawn --check → fresh TCC read → always accurate.
      return checkComputerUsePermissions();
    }
    case "openComputerUsePermissionSetup": {
      // Open the GUI app. Returns immediately — React shows "verify" CTA.
      await openComputerUseSetupApp();
      // Return a fresh check so the UI shows the current state.
      return checkComputerUsePermissions();
    }
    case "openComputerUsePermissionSettings": {
      // Legacy: open the setup app (same as above).
      await openComputerUseSetupApp();
      return checkComputerUsePermissions();
    }
    case "getOpenworkUiMcpEnvironment": {
      return {
        OPENWORK_UI_CONTROL_DISCOVERY: path.join(app.getPath("userData"), "openwork-ui-control.json"),
      };
    }
    case "getDesktopBootstrapConfig":
      return getDesktopBootstrapConfig();
    case "debugDesktopBootstrapConfig":
      return debugDesktopBootstrapConfig();
    case "setDesktopBootstrapConfig":
      return setDesktopBootstrapConfig(args[0] ?? {});
    case "nukeOpenworkAndOpencodeConfigAndExit": {
      await rm(app.getPath("userData"), { recursive: true, force: true });
      app.exit(0);
      return undefined;
    }
    case "orchestratorStartDetached": {
      return runtimeManager.orchestratorStartDetached(args[0] ?? {});
    }
    case "sandboxDoctor":
      return runtimeManager.sandboxDoctor();
    case "sandboxStop":
      return runtimeManager.sandboxStop(String(args[0] ?? "").trim());
    case "sandboxCleanupOpenworkContainers":
      return runtimeManager.sandboxCleanupOpenworkContainers();
    case "sandboxDebugProbe":
      return runtimeManager.sandboxDebugProbe();
    case "openworkServerInfo":
      return runtimeManager.openworkServerInfo();
    case "openworkServerRestart":
      return runtimeManager.openworkServerRestart(args[0] ?? {});
    case "pickDirectory": {
      const options = args[0] ?? {};
      /** @type {import("electron").OpenDialogOptions["properties"]} */
      const properties = options.multiple
        ? ["openDirectory", "createDirectory", "multiSelections"]
        : ["openDirectory", "createDirectory"];
      const result = await dialog.showOpenDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        properties,
      });
      if (result.canceled) return null;
      return options.multiple ? result.filePaths : (result.filePaths[0] ?? null);
    }
    case "pickFile": {
      const options = args[0] ?? {};
      /** @type {import("electron").OpenDialogOptions["properties"]} */
      const properties = options.multiple ? ["openFile", "multiSelections"] : ["openFile"];
      const result = await dialog.showOpenDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        properties,
      });
      if (result.canceled) return null;
      return options.multiple ? result.filePaths : (result.filePaths[0] ?? null);
    }
    case "saveFile": {
      const options = args[0] ?? {};
      const result = await dialog.showSaveDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
      });
      return result.canceled ? null : (result.filePath ?? null);
    }
    case "importSkill": {
      const projectDir = String(args[0] ?? "").trim();
      const sourceDir = String(args[1] ?? "").trim();
      const overwrite = args[2]?.overwrite === true;
      if (!projectDir || !sourceDir) {
        throw new Error("projectDir and sourceDir are required");
      }
      const skillRoot = await ensureProjectSkillRoot(projectDir);
      const name = validateSkillName(path.basename(sourceDir));
      const destination = path.join(skillRoot, name);
      if (await pathExists(destination)) {
        if (!overwrite) {
          return execResult(false, "", `Skill already exists at ${destination}`);
        }
        await rm(destination, { recursive: true, force: true });
      }
      await cp(sourceDir, destination, { recursive: true });
      return execResult(true, `Imported skill to ${destination}`);
    }
    case "installSkillTemplate": {
      const projectDir = String(args[0] ?? "").trim();
      const name = validateSkillName(args[1]);
      const content = String(args[2] ?? "");
      const overwrite = args[3]?.overwrite === true;
      const skillRoot = await ensureProjectSkillRoot(projectDir);
      const destination = path.join(skillRoot, name);
      if (await pathExists(destination)) {
        if (!overwrite) {
          return execResult(false, "", `Skill already exists at ${destination}`);
        }
        await rm(destination, { recursive: true, force: true });
      }
      await mkdir(destination, { recursive: true });
      await writeFile(path.join(destination, "SKILL.md"), content, "utf8");
      return execResult(true, `Installed skill to ${destination}`);
    }
    case "listLocalSkills":
      return listLocalSkills(String(args[0] ?? "").trim());
    case "readLocalSkill": {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        throw new Error("Skill not found");
      }
      return { path: skillPath, content: await readFile(skillPath, "utf8") };
    }
    case "writeLocalSkill": {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        return execResult(false, "", "Skill not found");
      }
      const content = String(args[2] ?? "");
      const next = content.endsWith("\n") ? content : `${content}\n`;
      await writeFile(skillPath, next, "utf8");
      return execResult(true, `Saved skill ${path.basename(path.dirname(skillPath))}`);
    }
    case "uninstallSkill": {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        return execResult(false, "", "Skill not found in .opencode/skills or .claude/skills");
      }
      await rm(path.dirname(skillPath), { recursive: true, force: true });
      return execResult(true, `Removed skill ${args[1]}`);
    }
    case "updaterEnvironment": {
      const executablePath = app.isPackaged ? app.getPath("exe") : process.execPath;
      return {
        supported: true,
        reason: null,
        executablePath,
        appBundlePath:
          process.platform === "darwin"
            ? path.resolve(executablePath, "../../..")
            : path.dirname(executablePath),
      };
    }
    case "readOpencodeConfig":
      return readOpencodeConfig(String(args[0] ?? "").trim(), String(args[1] ?? "").trim());
    case "writeOpencodeConfig":
      return writeOpencodeConfig(
        String(args[0] ?? "").trim(),
        String(args[1] ?? "").trim(),
        String(args[2] ?? ""),
      );
    case "resetOpenworkState": {
      await rm(workspaceStatePath(), { force: true });
      await rm(desktopBootstrapPath(), { force: true });
      return undefined;
    }
    case "resetOpencodeCache":
      return { removed: [], missing: [], errors: [] };
    case "opencodeMcpAuth":
      return runtimeManager.opencodeMcpAuth(String(args[0] ?? "").trim(), String(args[1] ?? "").trim());
    case "setWindowDecorations":
      return undefined;
    case "__openPath": {
      const target = String(args[0] ?? "").trim();
      if (!target) return "Path is required.";
      return shell.openPath(target);
    }
    case "__revealItemInDir": {
      const target = String(args[0] ?? "").trim();
      if (!target) return undefined;
      shell.showItemInFolder(target);
      return undefined;
    }
    case "__fetch": {
      const url = String(args[0] ?? "").trim();
      const init = args[1] ?? {};
      if (!url) throw new Error("URL is required.");
      const timeoutMs = Number(init.timeoutMs);
      const response = await fetch(url, {
        method: typeof init.method === "string" ? init.method : undefined,
        headers: init.headers && typeof init.headers === "object" ? init.headers : undefined,
        body: typeof init.body === "string" ? init.body : undefined,
        signal: Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
        body: await response.text(),
      };
    }
    case "__homeDir":
      return os.homedir();
    case "__joinPath":
      return path.join(...args.map((value) => String(value ?? "")));
    case "__setZoomFactor": {
      const factor = Number(args[0]);
      const window = activeWindowFromEvent(event);
      if (!window || !Number.isFinite(factor) || factor <= 0) {
        return false;
      }
      window.webContents.setZoomFactor(factor);
      return true;
    }
    case "__setNativeTheme":
      return applyNativeTheme(String(args[0]));
    case "__setApplicationMenuVisible":
      return setApplicationMenuVisible(args[0]);
    default:
      throw new Error(`Electron desktop bridge method is not implemented yet: ${command}`);
  }
}

function sendJsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readJsonRequestBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 128_000) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Request body must be JSON"));
      }
    });
    request.on("error", reject);
  });
}

function authorizedUiControlRequest(request) {
  const auth = request.headers.authorization ?? "";
  return auth === `Bearer ${uiControlToken}`;
}

function jsonForJavaScript(value) {
  return JSON.stringify(JSON.stringify(value ?? {}));
}

async function evaluateOpenworkControl(expression, options = {}) {
  const win = await createMainWindow();
  if (options.focus === true) {
    win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  return win.webContents.executeJavaScript(expression, true);
}

async function runOpenworkControlCommand(command, args = {}) {
  const argsJsonLiteral = jsonForJavaScript(args);
  if (command === "snapshot") {
    return evaluateOpenworkControl(`(async () => {
      const control = window.__openworkControl;
      if (!control) return { ok: false, error: "OpenWork control surface is not available yet." };
      control.setEnabled?.(true);
      return { ok: true, ...control.snapshot() };
    })()`);
  }
  if (command === "actions") {
    return evaluateOpenworkControl(`(async () => {
      const control = window.__openworkControl;
      if (!control) return { ok: false, error: "OpenWork control surface is not available yet." };
      control.setEnabled?.(true);
      return { ok: true, actions: control.listActions() };
    })()`);
  }
  if (command === "execute") {
    return evaluateOpenworkControl(`(async () => {
      const control = window.__openworkControl;
      const input = JSON.parse(${argsJsonLiteral});
      if (!control) return { ok: false, error: "OpenWork control surface is not available yet." };
      if (!input || typeof input.actionId !== "string" || !input.actionId.trim()) {
        return { ok: false, error: "Missing OpenWork actionId." };
      }
      control.setEnabled?.(true);
      return control.execute(input.actionId, input.args ?? {});
    })()`, { focus: true });
  }
  return { ok: false, error: `Unknown OpenWork control command: ${command}` };
}

async function startUiControlServer() {
  if (uiControlServer) return;
  uiControlServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJsonResponse(response, 200, { ok: true, app: APP_NAME, version: 1 });
        return;
      }
      if (!authorizedUiControlRequest(request)) {
        sendJsonResponse(response, 401, { ok: false, error: "Unauthorized" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/snapshot") {
        sendJsonResponse(response, 200, await runOpenworkControlCommand("snapshot"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/actions") {
        sendJsonResponse(response, 200, await runOpenworkControlCommand("actions"));
        return;
      }
      if (request.method === "POST" && url.pathname === "/execute") {
        sendJsonResponse(response, 200, await runOpenworkControlCommand("execute", await readJsonRequestBody(request)));
        return;
      }
      sendJsonResponse(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      sendJsonResponse(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolve, reject) => {
    uiControlServer.once("error", reject);
    uiControlServer.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = uiControlServer.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port) throw new Error("Could not start OpenWork UI control bridge.");
  uiControlDiscoveryPath = path.join(app.getPath("userData"), "openwork-ui-control.json");
  await writeFile(
    uiControlDiscoveryPath,
    `${JSON.stringify({ version: 1, app: APP_NAME, identifier: APP_IDENTIFIER, platform: process.platform, baseUrl: `http://127.0.0.1:${port}`, token: uiControlToken }, null, 2)}\n`,
    "utf8",
  );
}

async function stopUiControlServer() {
  if (uiControlDiscoveryPath) {
    await rm(uiControlDiscoveryPath, { force: true }).catch(() => undefined);
    uiControlDiscoveryPath = null;
  }
  if (!uiControlServer) return;
  await new Promise((resolve) => uiControlServer.close(() => resolve(undefined)));
  uiControlServer = null;
}

async function createMainWindow() {
  if (mainWindow) return mainWindow;

  const preloadPath = path.join(__dirname, "preload.mjs");
  const windowAppearanceOptions = {};
  if (process.platform === "darwin") {
    Object.assign(windowAppearanceOptions, {
      backgroundColor: "#00000001",
      titleBarStyle: "hiddenInset",
      vibrancy: macosVibrancyForCurrentTheme(),
      visualEffectState: "active",
    });
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    title: APP_NAME,
    show: false,
    ...windowAppearanceOptions,
    ...(APP_ICON_IMAGE && !APP_ICON_IMAGE.isEmpty() ? { icon: APP_ICON_IMAGE } : {}),
    webPreferences: {
      // The renderer owns session dispatch + event streams; keep it running
      // while hidden/minimized so background tasks are not interrupted.
      backgroundThrottling: false,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  applyApplicationMenuVisibility(mainWindow);

  if (isDevMode) {
    mainWindow.on("page-title-updated", (event) => {
      event.preventDefault();
      mainWindow?.setTitle(APP_NAME);
    });
    mainWindow.setTitle(APP_NAME);
  }

  mainWindow.once("ready-to-show", () => {
    if (isDevMode) {
      mainWindow?.setTitle(APP_NAME);
    }
    mainWindow?.show();
    flushPendingDeepLinks();
  });

  mainWindow.on("closed", () => {
    destroyBrowserView();
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const local =
      url.startsWith("file://") ||
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://localhost");
    if (!local) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  const startUrl = process.env.OPENWORK_ELECTRON_START_URL?.trim() || process.env.ELECTRON_START_URL?.trim();
  if (startUrl) {
    await mainWindow.loadURL(startUrl);
  } else {
    const packagedIndexPath = path.join(process.resourcesPath, "app-dist", "index.html");
    const devIndexPath = path.resolve(__dirname, "../../app/dist/index.html");
    await mainWindow.loadFile(app.isPackaged ? packagedIndexPath : devIndexPath);
  }

  if (!activeBrowserTabId) {
    createBrowserTab("about:blank", { select: true });
  }

  return mainWindow;
}

ipcMain.handle("openwork:desktop", handleDesktopInvoke);
ipcMain.handle("openwork:shell:openExternal", async (_event, url) => {
  if (typeof url === "string" && url.trim().length > 0) {
    await shell.openExternal(url);
  }
});
ipcMain.handle("openwork:shell:relaunch", async () => {
  app.relaunch();
  app.exit(0);
});
ipcMain.handle("openwork:system:architecture", async () => resolveArchitectureInfo());

// ── Embedded browser IPC ────────────────────────────────────────────────
ipcMain.handle("openwork:browser:show", (_event, bounds) => attachBrowserView(bounds));
ipcMain.handle("openwork:browser:hide", () => hideBrowserView());
ipcMain.handle("openwork:browser:navigate", (_event, url) => {
  const view = getActiveBrowserView() ?? createBrowserTab("about:blank", { select: true }).view;
  view.webContents.loadURL(normalizeBrowserUrl(url));
});
ipcMain.handle("openwork:browser:back", () => {
  const webContents = getActiveWebContents();
  if (webContents?.canGoBack()) webContents.goBack();
});
ipcMain.handle("openwork:browser:forward", () => {
  const webContents = getActiveWebContents();
  if (webContents?.canGoForward()) webContents.goForward();
});
ipcMain.handle("openwork:browser:reload", () => getActiveWebContents()?.reload());
ipcMain.handle("openwork:browser:bounds", (_event, bounds) => {
  lastBrowserBounds = bounds;
  const view = getActiveBrowserView();
  if (view && browserViewVisible && bounds.width > 0 && bounds.height > 0) {
    view.setBounds(bounds);
  }
});
ipcMain.handle("openwork:browser:state", () => browserStatePayload());
ipcMain.handle("openwork:browser:createTab", (_event, url) => {
  const tab = createBrowserTab(url ?? "about:blank", { select: true });
  return { tabId: tab.tabId };
});
ipcMain.handle("openwork:browser:closeTab", (_event, tabId) => closeBrowserTab(tabId == null ? undefined : String(tabId)));
ipcMain.handle("openwork:browser:closeAllTabs", () => closeAllBrowserTabs());
ipcMain.handle("openwork:browser:selectTab", (_event, tabId) => selectBrowserTab(String(tabId ?? "")).tabId);
ipcMain.handle("openwork:browser:reorderTabs", (_event, tabIds) => reorderBrowserTabs(tabIds));
ipcMain.handle("openwork:browser:listTabs", () => listBrowserTabs());
ipcMain.handle("openwork:browser:tabContextMenu", (_event, tabId, point) => showBrowserTabContextMenu(tabId, point));
ipcMain.handle("openwork:browser:destroy", () => destroyBrowserView());
ipcMain.on("openwork:menu-overlay:ready", (event) => {
  if (event.sender !== menuOverlayView?.webContents) return;
  markMenuOverlayReady(menuOverlayView);
});
ipcMain.on("openwork:menu-overlay:choose", (event, payload) => {
  if (event.sender !== menuOverlayView?.webContents) return;
  handleMenuOverlayChoice(payload);
});
ipcMain.on("openwork:menu-overlay:close", (event, payload) => {
  if (event.sender !== menuOverlayView?.webContents) return;
  if (payload?.requestId && payload.requestId !== menuOverlayRequest?.id) return;
  hideMenuOverlay();
});
ipcMain.on("openwork:menu-overlay:dismiss", (event) => {
  if (event.sender === menuOverlayView?.webContents) return;
  hideMenuOverlay();
});

registerMigrationIpc({ app, ipcMain });
const { ensureAutoUpdater } = registerUpdaterIpc({ app, ipcMain, getMainWindow: () => mainWindow });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("before-quit", (event) => {
    if (runtimeDisposedForQuit) return;
    event.preventDefault();
    void Promise.all([disposeRuntimeBeforeQuit(), stopUiControlServer()]).finally(() => app.quit());
  });

  app.on("second-instance", async (_event, argv) => {
    const win = await createMainWindow();
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
    queueDeepLinks(forwardedDeepLinks(argv));
  });

  app.on("open-url", async (event, url) => {
    event.preventDefault();
    await createMainWindow();
    queueDeepLinks([url]);
  });

  app.whenReady().then(async () => {
    installMediaPermissionHandlers();
    installApplicationMenu();
    await runtimeManager.prepareFreshRuntime().catch(() => undefined);

    // Use Tauri's existing workspace state file as canonical so rollback and
    // Electron see the same workspace list. Import the short-lived
    // Electron-only filename only when the shared file is missing.
    await migrateLegacyElectronWorkspaceStateIfNeeded();
    await startUiControlServer().catch((error) => {
      console.warn("[ui-control] failed to start", error);
    });
    runtimeBootstrapPromise = bootRuntimeForSelectedWorkspace().catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));

    queueDeepLinks(forwardedDeepLinks(process.argv));
    const win = await createMainWindow();
    win.webContents.on("did-finish-load", () => {
      flushPendingDeepLinks();
    });

    // Initialize the packaged updater after the window is up so the user sees
    // a working app first. Renderer-owned checks pass the selected release
    // channel explicitly, avoiding stale stable-feed results for alpha users.
    void ensureAutoUpdater();
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
      return;
    }
    const win = await createMainWindow();
    win.show();
    win.focus();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
