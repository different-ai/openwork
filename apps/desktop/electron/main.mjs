import { processBlankSlateProfile, resolveBlankSlateLaunch } from "./blank-slate-profile.mjs";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { existsSync, readFileSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globalOpencodeConfigDir, workspaceOpencodeConfigCandidates } from "@openwork/paths";

import { configureFakeMediaForTests, installMediaPermissionHandlers } from "./media-permissions.mjs";
import { registerMigrationIpc } from "./migration.mjs";
import { createRuntimeManager, createSystemCaCertificateVerifyProc } from "./runtime.mjs";
import { registerUpdaterIpc } from "./updater.mjs";
import {
  checkComputerUsePermissions,
  getComputerUseMcpCommand,
  listRunningApps,
  openComputerUseSetupApp,
} from "./computer-use.mjs";
import { createUiControlServer } from "./ui-control-server.mjs";
import { createApplicationMenu } from "./app-menu.mjs";
import { applyBrandAppName } from "./brand-app-name.mjs";
import { createBrowserLoginSync } from "./browser-login-sync.mjs";
import { createBrowserPanel } from "./browser-panel.mjs";
import { createWorkspaceStore } from "./workspace-store.mjs";
import {
  buildNukeManifest,
  executeNukeFreshStart,
  runPendingNukeCleanup,
} from "./nuke.mjs";
import {
  createConnectLinkReplayGuard,
  extractConnectExchange,
  resolveConnectExchangeUrl,
  verifyConnectLinkUrl,
} from "./connect-link.mjs";
import {
  applyDesktopBootstrapBrandIcon,
  persistConnectLinkBranding,
} from "./connect-link-branding.mjs";
import { resolveConnectLinkPublicKeys } from "./connect-link-keys.mjs";
import { openExternalUrl } from "./open-external.mjs";
import { resolveAppIdentifier, resolveUserDataPath } from "./dev-profile.mjs";
import { fetchAgentContextDiagnosticsResponse } from "./agent-context-diagnostics-fetch.mjs";
import { downloadBinaryToPath, uploadMultipartFromBytes } from "./binary-transfer.mjs";
import {
  createLinuxDesktopIntegration,
} from "./linux-desktop-integration.mjs";
import { createDesktopAutomationRunner, normalizeRunnerBaseUrl } from "./automation-runner.mjs";
import {
  desktopActivationRequired,
  enterprisePreactivationCommandAllowed,
  resolveDesktopDistribution,
} from "./desktop-distribution.mjs";
import {
  applyWindowsTaskbarIcon,
  windowsBrandAppUserModelId,
  windowsBrandShortcutDetails,
  windowsBrandShortcutFileName,
  windowsInstalledShortcutFileName,
  windowsInstalledExecutablePath,
  writeWindowsBrandShortcut,
  windowsIconFromNativeImage,
} from "./brand-icon-windows.mjs";
import { resetMacDockIcon } from "./brand-icon-darwin.mjs";
import { createDesktopVaultKeyProvider } from "./secure-vault-key.mjs";
import {
  clearOpenworkSentrySession,
  initOpenworkSentry,
  setOpenworkSentrySession,
} from "./sentry.mjs";
import { installStdioErrorHandlers } from "./stdio-errors.mjs";
import {
  createRendererCrashRecovery,
  installSocketTypeOfServiceGuard,
  runDetachedTask,
} from "./process-resilience.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
const desktopPackageMetadata = require("../package.json");
// Electron 35 eagerly resolves every export in a named ESM import, including
// safeStorage. Loading through CommonJS keeps safeStorage lazy so isolated demo
// profiles do not show macOS's native keychain dialog before our switches run.
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net: electronNet,
  powerMonitor,
  Notification: ElectronNotification,
  session,
  shell,
  systemPreferences,
} = require("electron");
const pty = require(["node", "pty"].join("-"));
const NATIVE_DEEP_LINK_EVENT = "openwork:deep-link-native";
const AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT = "openwork:automation-runner:credential-rejected";
const isDevMode = process.env.OPENWORK_DEV_MODE === "1";
const DESKTOP_DISTRIBUTION = resolveDesktopDistribution({
  isPackaged: app.isPackaged,
  packageFlavor: Reflect.get(desktopPackageMetadata, "openworkDistribution"),
  environmentFlavor: process.env.OPENWORK_DESKTOP_DISTRIBUTION,
});
const TAURI_APP_IDENTIFIER = DESKTOP_DISTRIBUTION.appIdentifier;
const DEV_APP_IDENTIFIER = `${DESKTOP_DISTRIBUTION.appIdentifier}.dev`;
const DESKTOP_PROTOCOL_SCHEME = DESKTOP_DISTRIBUTION.protocolScheme;
const DEFAULT_APP_NAME =
  (!app.isPackaged ? process.env.OPENWORK_ELECTRON_APP_NAME?.trim() : "") ||
  (isDevMode ? `${DESKTOP_DISTRIBUTION.appName} - Dev` : DESKTOP_DISTRIBUTION.appName);
const BLANK_SLATE_LAUNCH = resolveBlankSlateLaunch({
  appName: DEFAULT_APP_NAME,
  profile: processBlankSlateProfile,
});
const APP_NAME = BLANK_SLATE_LAUNCH.appName;
let currentDisplayAppName = APP_NAME;
installStdioErrorHandlers();
installSocketTypeOfServiceGuard();
await initOpenworkSentry({
  app,
  distribution: DESKTOP_DISTRIBUTION,
  packageMetadata: desktopPackageMetadata,
});
const BASE_APP_IDENTIFIER = isDevMode ? DEV_APP_IDENTIFIER : TAURI_APP_IDENTIFIER;
const APP_IDENTIFIER = resolveAppIdentifier({
  appIdentifierOverride: process.env.OPENWORK_ELECTRON_APP_IDENTIFIER,
  appRootPath: APP_ROOT,
  baseAppIdentifier: BASE_APP_IDENTIFIER,
  devAppIdentifier: DEV_APP_IDENTIFIER,
  devProfile: process.env.OPENWORK_DEV_PROFILE,
  isDevMode,
  isPackaged: app.isPackaged,
});
if (BLANK_SLATE_LAUNCH.enabled || process.env.OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN === "1") {
  // Fresh, isolated development profiles otherwise trigger macOS's native
  // "Login" keychain prompt as soon as Chromium persists an authenticated
  // cookie. That modal blocks the entire Electron main loop and makes the demo
  // appear frozen. Production never sets this flag and continues to use the
  // system keychain normally.
  app.commandLine.appendSwitch("use-mock-keychain");
}
const RELEASE_DOWNLOAD_BASE_URL = "https://github.com/different-ai/openwork/releases/latest/download";
const RELEASE_PAGE_URL = "https://github.com/different-ai/openwork/releases/latest";
const DOCS_PAGE_URL = "https://openworklabs.com/docs";
const applicationMenu = createApplicationMenu({
  appName: APP_NAME,
  docsUrl: DOCS_PAGE_URL,
  getWindow: () => createMainWindow(),
});

const uiControlServer = createUiControlServer({
  app,
  appName: APP_NAME,
  appIdentifier: APP_IDENTIFIER,
  getWindow: () => createMainWindow(),
});

const terminalProcesses = new Map();
let nextTerminalId = 1;

function defaultTerminalShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

async function resolveTerminalCwd(cwd) {
  const fallback = os.homedir();
  if (typeof cwd !== "string" || !cwd.trim()) return fallback;
  const candidate = path.resolve(cwd);
  const info = await stat(candidate).catch(() => null);
  return info?.isDirectory() ? candidate : fallback;
}

function terminalForSender(event, terminalId) {
  const terminal = terminalProcesses.get(String(terminalId ?? ""));
  if (!terminal || terminal.webContentsId !== event.sender.id) return null;
  return terminal;
}

function killTerminal(terminalId) {
  const terminal = terminalProcesses.get(terminalId);
  if (!terminal) return;
  terminalProcesses.delete(terminalId);
  try { terminal.process.kill(); } catch { /* already gone */ }
}

function killTerminalsForWebContents(webContentsId) {
  for (const [terminalId, terminal] of terminalProcesses.entries()) {
    if (terminal.webContentsId === webContentsId) killTerminal(terminalId);
  }
}

// Production Electron shares the same on-disk state folder as the Tauri shell
// so in-place migration is a no-op for almost every file. Dev mode uses the
// separate dev identifier so it can run beside the production app.
//
// Dev profile precedence: OPENWORK_ELECTRON_USERDATA (explicit profile path)
// wins over everything; then OPENWORK_ELECTRON_APP_IDENTIFIER; then
// OPENWORK_DEV_PROFILE in unpackaged dev; then the legacy identifier default.
app.setName(APP_NAME);
app.setAppUserModelId(APP_IDENTIFIER);
if (BLANK_SLATE_LAUNCH.homePath) app.setPath("home", BLANK_SLATE_LAUNCH.homePath);
if (
  app.isPackaged
  && !BLANK_SLATE_LAUNCH.enabled
  && process.env.OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION !== "1"
  && !(process.platform === "linux" && process.env.APPIMAGE)
) {
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL_SCHEME);
}
const userDataPath = BLANK_SLATE_LAUNCH.userDataPath ?? resolveUserDataPath({
  appDataPath: app.getPath("appData"),
  appIdentifier: APP_IDENTIFIER,
  userDataOverride: process.env.OPENWORK_ELECTRON_USERDATA,
});
app.setPath("userData", userDataPath);
const linuxDesktopIntegration = createLinuxDesktopIntegration({
  app,
  dialog,
  appName: APP_NAME,
  distribution: DESKTOP_DISTRIBUTION.flavor,
});

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
    // Packaged Windows and Linux builds ship runtime icons via extraResources.
    path.join(process.resourcesPath ?? "", "icons", "linux", "512x512.png"),
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await electronNet.fetch(manifestUrl, {
      signal: controller.signal,
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
  } finally {
    clearTimeout(timeout);
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
const BRAND_ICON_MAX_BYTES = 2 * 1024 * 1024;
const BRAND_ICON_FETCH_TIMEOUT_MS = 10_000;
// Keep in sync with ee/apps/den-api/src/brand-icon-validation.ts so logo CDNs
// that expect a browser request behave the same at save time and apply time.
const BRAND_ICON_FETCH_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function scheduleBlankSlateProfileCleanup() {
  if (!BLANK_SLATE_LAUNCH.rootPath) return;
  try {
    const child = spawn(process.execPath, [
      path.join(__dirname, "blank-slate-cleanup.mjs"),
      String(process.pid),
      BLANK_SLATE_LAUNCH.rootPath,
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.once("error", (error) => {
      console.warn("[blank-slate] failed to schedule temporary profile cleanup", error);
    });
    child.unref();
  } catch (error) {
    console.warn("[blank-slate] failed to schedule temporary profile cleanup", error);
  }
}
let brandIconApplySequence = 0;
let brandIconRuntimeState = { applied: false, sourceUrl: null, reason: null };

function brandIconCachePath() {
  return path.join(app.getPath("userData"), "brand-icon.png");
}

function brandIconSidecarPath() {
  return path.join(app.getPath("userData"), "brand-icon.json");
}

function brandIconWindowsPath() {
  return path.join(app.getPath("userData"), "brand-icon.ico");
}

function defaultAppWindowsIconPath() {
  return path.join(app.getPath("userData"), "openwork-stock.ico");
}

let cachedWindowsProgramsPath = null;
function windowsProgramsPath() {
  if (cachedWindowsProgramsPath) return cachedWindowsProgramsPath;
  const userProfile = app.getPath("userData").split(/[\\/]AppData[\\/]/i)[0];
  cachedWindowsProgramsPath = path.join(userProfile, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs");
  return cachedWindowsProgramsPath;
}

function windowsBrandShortcutPath() {
  return path.join(windowsProgramsPath(), windowsBrandShortcutFileName(currentDisplayAppName));
}

function windowsInstalledShortcutPath() {
  return path.join(windowsProgramsPath(), windowsInstalledShortcutFileName(APP_NAME));
}

function windowsBrandShortcutMarkerPath() {
  return path.join(app.getPath("userData"), "windows-brand-shortcut.txt");
}

function windowsExecutablePath() {
  return windowsInstalledExecutablePath({
    packaged: app.isPackaged,
    execPath: app.getPath("exe"),
    resourcesPath: process.resourcesPath,
    shortcutPath: windowsBrandShortcutPath(),
  });
}

async function readWindowsBrandShortcutMarker() {
  return (await readFile(windowsBrandShortcutMarkerPath(), "utf8").catch(() => "")).trim();
}

function repairWindowsShortcutTarget(shortcutPath, details) {
  const payload = Buffer.from(JSON.stringify({ shortcutPath, ...details }), "utf8").toString("base64");
  const script = [
    `$value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    "$shell = New-Object -ComObject WScript.Shell",
    "$link = $shell.CreateShortcut($value.shortcutPath)",
    "$link.TargetPath = $value.target",
    "$link.WorkingDirectory = $value.cwd",
    "$link.Description = $value.description",
    "$link.IconLocation = \"$($value.icon),$($value.iconIndex)\"",
    "$link.Save()",
  ].join("\n");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
  });
}

async function registerWindowsBrandShortcut(appId, appIconPath) {
  if (process.platform !== "win32") return null;
  const shortcutPath = windowsBrandShortcutPath();
  const shortcutTempPath = `${shortcutPath}.${process.pid}.tmp.lnk`;
  await mkdir(path.dirname(shortcutPath), { recursive: true });
  // Recreate instead of replacing in place. Explorer can retain the old
  // target and search metadata when a prior installer owned this path.
  await rm(shortcutPath, { force: true });
  await rm(shortcutTempPath, { force: true });
  const details = windowsBrandShortcutDetails({
    target: windowsExecutablePath(),
    appId,
    appIconPath,
    appName: currentDisplayAppName,
  });
  const written = writeWindowsBrandShortcut(shell, shortcutTempPath, details, false);
  if (!written) throw new Error(`Windows rejected the organization shortcut: ${shortcutPath}`);
  await rename(shortcutTempPath, shortcutPath);
  if (shell.readShortcutLink(shortcutPath).target !== details.target) {
    repairWindowsShortcutTarget(shortcutPath, details);
  }
  const previousShortcutPath = await readWindowsBrandShortcutMarker();
  if (previousShortcutPath && previousShortcutPath !== shortcutPath) {
    await rm(previousShortcutPath, { force: true });
  }
  if (windowsInstalledShortcutPath() !== shortcutPath) {
    await rm(windowsInstalledShortcutPath(), { force: true });
  }
  await writeFile(windowsBrandShortcutMarkerPath(), shortcutPath, "utf8");
  return shortcutPath;
}

async function removeWindowsBrandShortcut() {
  if (process.platform !== "win32") return;
  const shortcutPath = await readWindowsBrandShortcutMarker();
  if (shortcutPath) await rm(shortcutPath, { force: true });
  await rm(windowsBrandShortcutMarkerPath(), { force: true });
}

function resolveBrandIconImage() {
  try {
    const cachePath = brandIconCachePath();
    if (!existsSync(cachePath)) return null;
    const image = nativeImage.createFromPath(cachePath);
    return image && !image.isEmpty() ? image : null;
  } catch {
    return null;
  }
}

function brandIconFailure(reason, error) {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  console.warn(`[brand-icon] ${reason}${detail ? `: ${detail}` : ""}`);
  return { ok: false, reason };
}

function recordBrandIconResult(result, sourceUrl) {
  if (result.ok) {
    brandIconRuntimeState = {
      applied: typeof sourceUrl === "string",
      sourceUrl: typeof sourceUrl === "string" ? sourceUrl : null,
      reason: null,
    };
  } else {
    brandIconRuntimeState = { ...brandIconRuntimeState, reason: result.reason ?? "apply-failed" };
  }
  return result;
}

async function applyAppIconImage(image, { taskbarIconPath = null, taskbarAppId = APP_IDENTIFIER } = {}) {
  if (!image || image.isEmpty()) return brandIconFailure("invalid-image");
  try {
    if (process.platform === "darwin") {
      if (!app.dock) return brandIconFailure("dock-unavailable");
      app.dock.setIcon(image);
      return { ok: true };
    }

    if (process.platform === "win32") {
      if (!taskbarIconPath || !existsSync(taskbarIconPath)) {
        return brandIconFailure("taskbar-icon-missing");
      }
      if (!mainWindow) return { ok: true };
      await applyWindowsTaskbarIcon(mainWindow, {
        image,
        appId: taskbarAppId,
        appIconPath: taskbarIconPath,
        relaunchCommand: windowsExecutablePath(),
        relaunchDisplayName: currentDisplayAppName,
      });
    } else {
      if (!mainWindow) return brandIconFailure("window-unavailable");
      mainWindow.setIcon(image);
    }
    return { ok: true };
  } catch (error) {
    return brandIconFailure("os-apply-failed", error);
  }
}

async function applyDefaultAppIconImage(expectedSequence = null) {
  let image = APP_ICON_IMAGE;
  let taskbarIconPath = null;
  if (process.platform === "darwin") {
    // Packaged macOS builds have no loose default icon file (APP_ICON_IMAGE
    // is null), so reset the dock via dock.setIcon(null) to restore the
    // bundle icon instead of silently leaving the branded icon in place.
    if (expectedSequence !== null && expectedSequence !== brandIconApplySequence) {
      return { ok: false, reason: "stale" };
    }
    try {
      const result = resetMacDockIcon(app.dock, image);
      return result.ok ? result : brandIconFailure(result.reason);
    } catch (error) {
      return brandIconFailure("os-apply-failed", error);
    }
  }
  if (process.platform === "win32") {
    try {
      await removeWindowsBrandShortcut();
      app.setAppUserModelId(APP_IDENTIFIER);
    } catch (error) {
      return brandIconFailure("shortcut-remove-failed", error);
    }
    if (image && !image.isEmpty()) {
      try {
        taskbarIconPath = defaultAppWindowsIconPath();
        await writeWindowsIconFile(image, taskbarIconPath);
      } catch (error) {
        return brandIconFailure("stock-icon-unavailable", error);
      }
    } else {
      try {
        const executableIcon = await app.getFileIcon(process.execPath, { size: "large" });
        if (executableIcon && !executableIcon.isEmpty()) image = executableIcon;
        taskbarIconPath = process.execPath;
      } catch (error) {
        return brandIconFailure("stock-icon-unavailable", error);
      }
    }
  }
  if (!image || image.isEmpty()) {
    // Linux: the packaged window/launcher icon is managed by the desktop
    // integration, so a missing loose icon is a safe no-op.
    return process.platform === "win32" ? brandIconFailure("stock-icon-unavailable") : { ok: true };
  }
  if (process.platform === "win32" && taskbarIconPath) {
    try {
      await registerWindowsBrandShortcut(APP_IDENTIFIER, taskbarIconPath);
    } catch (error) {
      return brandIconFailure("shortcut-write-failed", error);
    }
  }
  if (expectedSequence !== null && expectedSequence !== brandIconApplySequence) {
    return { ok: false, reason: "stale" };
  }
  return applyAppIconImage(image, {
    taskbarIconPath,
    taskbarAppId: APP_IDENTIFIER,
  });
}

async function focusMainWindowFromNotification() {
  const win = await createMainWindow();
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * @param {unknown} input
 * @returns {import("@openwork/types/desktop-ipc").DesktopNotificationResult}
 */
function showDesktopNotification(input) {
  if (!ElectronNotification.isSupported()) {
    return { ok: false, reason: "notifications unsupported" };
  }

  const record = input && typeof input === "object" ? input : {};
  const title = String(Reflect.get(record, "title") ?? "").trim();
  if (!title) {
    return { ok: false, reason: "missing title" };
  }

  const body = String(Reflect.get(record, "body") ?? "").trim();
  const icon = resolveBrandIconImage() ?? APP_ICON_IMAGE;
  const options = {
    title,
    ...(body ? { body } : {}),
    ...(Reflect.get(record, "silent") === true ? { silent: true } : {}),
    ...(icon && !icon.isEmpty() ? { icon } : {}),
  };

  try {
    const notification = new ElectronNotification(options);
    notification.on("click", () => {
      runDetachedTask("focus window from notification", focusMainWindowFromNotification);
    });
    notification.show();
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "failed to show notification";
    return { ok: false, reason };
  }
}

async function readBrandIconSidecar() {
  try {
    const parsed = JSON.parse(await readFile(brandIconSidecarPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readBrandIconSidecarSourceUrlSync() {
  try {
    const parsed = JSON.parse(readFileSync(brandIconSidecarPath(), "utf8"));
    return parsed && typeof parsed === "object" && typeof parsed.sourceUrl === "string"
      ? parsed.sourceUrl
      : null;
  } catch {
    return null;
  }
}

async function clearBrandIconCache() {
  await Promise.all([
    rm(brandIconCachePath(), { force: true }),
    rm(brandIconSidecarPath(), { force: true }),
    rm(brandIconWindowsPath(), { force: true }),
  ]);
}

function normalizeBrandIconSourceUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

async function fetchBrandIconBuffer(sourceUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRAND_ICON_FETCH_TIMEOUT_MS);
  try {
    const response = await electronNet.fetch(sourceUrl, {
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      headers: {
        "user-agent": BRAND_ICON_FETCH_USER_AGENT,
        accept: "image/*,*/*",
      },
    });
    if (!response.ok) return { ok: false, reason: "http-status" };

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > BRAND_ICON_MAX_BYTES) {
      return { ok: false, reason: "too-large" };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > BRAND_ICON_MAX_BYTES) {
      return { ok: false, reason: "too-large" };
    }
    return { ok: true, buffer };
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "timeout" : "fetch-failed" };
  } finally {
    clearTimeout(timeout);
  }
}

function brandIconImageRejectionReason(image) {
  if (!image || image.isEmpty()) return "invalid-image";
  const size = image.getSize();
  if (size.width < 64 || size.height < 64) return "too-small";
  const aspectRatio = size.width / size.height;
  if (aspectRatio < 1 / 1.5 || aspectRatio > 1.5) return "invalid-aspect";
  return null;
}

async function writeBrandIconCache(image, sourceUrl) {
  const cachePath = brandIconCachePath();
  const sidecarPath = brandIconSidecarPath();
  const windowsPath = brandIconWindowsPath();
  const suffix = `${process.pid}-${Date.now()}`;
  const cacheTempPath = `${cachePath}.${suffix}.tmp`;
  const sidecarTempPath = `${sidecarPath}.${suffix}.tmp`;
  const windowsTempPath = `${windowsPath}.${suffix}.tmp`;
  const windowsIcon = process.platform === "win32" ? windowsIconFromNativeImage(image) : null;
  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cacheTempPath, image.toPNG());
    if (windowsIcon) await writeFile(windowsTempPath, windowsIcon);
    await writeFile(sidecarTempPath, JSON.stringify({
      sourceUrl,
      appliedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
    }, null, 2), "utf8");
    await rename(cacheTempPath, cachePath);
    if (windowsIcon) await rename(windowsTempPath, windowsPath);
    await rename(sidecarTempPath, sidecarPath);
  } catch (error) {
    await Promise.all([
      rm(cacheTempPath, { force: true }),
      rm(sidecarTempPath, { force: true }),
      rm(windowsTempPath, { force: true }),
    ]).catch(() => undefined);
    throw error;
  }
}

async function writeWindowsIconFile(image, destination) {
  const tempPath = `${destination}.${process.pid}-${Date.now()}.tmp`;
  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(tempPath, windowsIconFromNativeImage(image));
    await rename(tempPath, destination);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function ensureWindowsBrandIcon(image) {
  if (process.platform !== "win32") return null;
  const windowsPath = brandIconWindowsPath();
  if (!existsSync(windowsPath)) await writeWindowsIconFile(image, windowsPath);
  return windowsPath;
}

async function registerWindowsDisplayShortcut() {
  if (process.platform !== "win32") return;
  const sidecar = await readBrandIconSidecar();
  const sourceUrl = typeof sidecar?.sourceUrl === "string" ? sidecar.sourceUrl : null;
  const brandedImage = sourceUrl ? resolveBrandIconImage() : null;
  if (brandedImage && sourceUrl) {
    const iconPath = await ensureWindowsBrandIcon(brandedImage);
    await registerWindowsBrandShortcut(windowsBrandAppUserModelId(APP_IDENTIFIER, sourceUrl), iconPath);
    return;
  }
  const stockImage = APP_ICON_IMAGE ?? await app.getFileIcon(windowsExecutablePath(), { size: "large" });
  const iconPath = defaultAppWindowsIconPath();
  await writeWindowsIconFile(stockImage, iconPath);
  await registerWindowsBrandShortcut(APP_IDENTIFIER, iconPath);
}

async function applyCachedBrandIcon(image, sourceUrl, expectedSequence = null) {
  let taskbarIconPath = null;
  let taskbarAppId = APP_IDENTIFIER;
  try {
    taskbarIconPath = await ensureWindowsBrandIcon(image);
    if (process.platform === "win32") {
      taskbarAppId = windowsBrandAppUserModelId(APP_IDENTIFIER, sourceUrl);
      await registerWindowsBrandShortcut(taskbarAppId, taskbarIconPath);
      app.setAppUserModelId(taskbarAppId);
    }
  } catch (error) {
    if (expectedSequence !== null && expectedSequence !== brandIconApplySequence) {
      return { ok: false, reason: "stale" };
    }
    return recordBrandIconResult(brandIconFailure("write-failed", error), sourceUrl);
  }
  if (expectedSequence !== null && expectedSequence !== brandIconApplySequence) {
    return { ok: false, reason: "stale" };
  }
  return recordBrandIconResult(await applyAppIconImage(image, {
    taskbarIconPath,
    taskbarAppId,
  }), sourceUrl);
}

async function applyBrandIconUrl(value) {
  const sequence = ++brandIconApplySequence;
  if (value === null) {
    const result = await applyDefaultAppIconImage(sequence);
    if (result.reason === "stale") return result;
    const applied = recordBrandIconResult(result, null);
    if (!applied.ok) return applied;
    try {
      await clearBrandIconCache();
      return applied;
    } catch (error) {
      return recordBrandIconResult(brandIconFailure("clear-failed", error), null);
    }
  }

  const sourceUrl = normalizeBrandIconSourceUrl(value);
  if (!sourceUrl) return recordBrandIconResult(brandIconFailure("invalid-url"), null);

  const sidecar = await readBrandIconSidecar();
  const cachedImage = resolveBrandIconImage();
  if (sidecar?.sourceUrl === sourceUrl && cachedImage) {
    return applyCachedBrandIcon(cachedImage, sourceUrl, sequence);
  }

  const fetched = await fetchBrandIconBuffer(sourceUrl);
  if (sequence !== brandIconApplySequence) return { ok: false, reason: "stale" };
  if (!fetched.ok) return recordBrandIconResult(brandIconFailure(fetched.reason), sourceUrl);

  const image = nativeImage.createFromBuffer(fetched.buffer);
  const rejectionReason = brandIconImageRejectionReason(image);
  if (rejectionReason) return recordBrandIconResult(brandIconFailure(rejectionReason), sourceUrl);

  try {
    await writeBrandIconCache(image, sourceUrl);
  } catch (error) {
    if (sequence !== brandIconApplySequence) return { ok: false, reason: "stale" };
    return recordBrandIconResult(brandIconFailure("write-failed", error), sourceUrl);
  }
  if (sequence !== brandIconApplySequence) {
    const latestSidecar = await readBrandIconSidecar();
    if (latestSidecar?.sourceUrl === sourceUrl) {
      await clearBrandIconCache().catch(() => undefined);
    }
    return { ok: false, reason: "stale" };
  }
  return applyCachedBrandIcon(image, sourceUrl, sequence);
}

async function getBrandIconState() {
  return { ...brandIconRuntimeState };
}

const INITIAL_BRAND_ICON_IMAGE = resolveBrandIconImage();
const INITIAL_APP_ICON_IMAGE = INITIAL_BRAND_ICON_IMAGE ?? APP_ICON_IMAGE;
if (INITIAL_BRAND_ICON_IMAGE) {
  // The renderer's level-based reconcile compares getBrandIconState() with
  // the fresh org config. Record that a cached brand icon is restored at
  // boot so a clear whose edge the renderer missed still resets the icon.
  brandIconRuntimeState = {
    applied: true,
    sourceUrl: readBrandIconSidecarSourceUrlSync(),
    reason: null,
  };
}
if (process.platform === "darwin" && INITIAL_APP_ICON_IMAGE && !INITIAL_APP_ICON_IMAGE.isEmpty() && app.dock) {
  app.dock.setIcon(INITIAL_APP_ICON_IMAGE);
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
if (isDevMode && !app.isPackaged) {
  const cdpAddress = remoteDebugPort > 0 ? `http://127.0.0.1:${remoteDebugPort}` : "disabled";
  console.log(`[openwork] dev profile=${app.getPath("userData")} cdp=${cdpAddress}`);
}

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
configureFakeMediaForTests(app, envFlagEnabled("OPENWORK_ELECTRON_FAKE_MEDIA"));
const DEFAULT_DEN_BASE_URL = "https://app.openworklabs.com";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:4096";
const FORCE_DESKTOP_REQUIRE_SIGNIN =
  DESKTOP_DISTRIBUTION.requireSignin || envFlagEnabled("OPENWORK_FORCE_SIGNIN");
const DEFAULT_DESKTOP_REQUIRE_SIGNIN = FORCE_DESKTOP_REQUIRE_SIGNIN;

function envFlagEnabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

const IDLE_ENGINE_INFO = Object.freeze({
  running: false,
  runtime: "direct",
  managedByServer: false,
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
  logFilePath: null,
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

const browserPanel = createBrowserPanel({
  remoteDebugPort,
  getWindow: () => mainWindow,
  onDeepLink: (urls) => queueDeepLinks(urls),
  checkPolicy: async (input) => {
    const server = await runtimeManager.openworkServerInfo();
    if (!server.baseUrl || !(server.clientToken ?? server.ownerToken)) throw new Error("OpenWork policy service is unavailable.");
    // loopback-fetch: the policy service is the locally managed OpenWork server.
    const response = await fetch(`${server.baseUrl}/managed-policy/evaluate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.clientToken ?? server.ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: input.external ? "browser_external" : "browser", input }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Your organization's policy blocked this browser request.");
  },
});

const workspaceStore = createWorkspaceStore({
  app,
  defaultDenBaseUrl: DEFAULT_DEN_BASE_URL,
  defaultRequireSignin: DEFAULT_DESKTOP_REQUIRE_SIGNIN,
  forceRequireSignin: FORCE_DESKTOP_REQUIRE_SIGNIN,
});

const activeDesktopTransfers = new Map();

function desktopTransferKey(event, transferId) {
  const normalizedId = typeof transferId === "string" ? transferId.trim() : "";
  if (!normalizedId || normalizedId.length > 128 || !/^[a-zA-Z0-9._-]+$/.test(normalizedId)) {
    throw new Error("A valid transferId is required.");
  }
  return `${event.sender.id}:${normalizedId}`;
}

async function runDesktopTransfer(event, input, operation) {
  const key = desktopTransferKey(event, input?.transferId);
  if (activeDesktopTransfers.has(key)) throw new Error("transferId is already active.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  activeDesktopTransfers.set(key, controller);
  event.sender.once("destroyed", abort);
  try {
    // Both authorities come from app-owned state in userData; workspace-
    // writable configuration must never widen where a transfer may write.
    const [authorizedRoots, allowedUrlPrefixes] = await Promise.all([
      workspaceStore.listLocalWorkspacePaths(),
      workspaceStore.listRemoteWorkspaceUrlPrefixes(),
    ]);
    return await operation(input, {
      authorizedRoots,
      allowedUrlPrefixes,
      // App-owned staging keeps in-flight downloads outside every authorized
      // workspace root until they complete.
      stagingDir: path.join(app.getPath("userData"), "binary-transfers"),
      fetcher: electronNet.fetch,
      signal: controller.signal,
    });
  } finally {
    event.sender.removeListener("destroyed", abort);
    activeDesktopTransfers.delete(key);
  }
}

const connectLinkReplayGuard = createConnectLinkReplayGuard({
  filePath: path.join(app.getPath("userData"), "connect-link-seen.json"),
});

/**
 * @param {string} rawUrl
 * @returns {import("@openwork/types/connect-link").ConnectLinkVerifyResult}
 */
function verifyConnectLink(rawUrl) {
  return verifyConnectLinkUrl(String(rawUrl ?? ""), {
    publicKeys: resolveConnectLinkPublicKeys(),
    // http is refused everywhere except loopback targets in dev runs.
    allowInsecureLoopback: isDevMode,
  });
}

async function previewConnectLink(rawUrl) {
  if (extractConnectExchange(rawUrl)) {
    return resolveConnectExchangeUrl(rawUrl, {
      mode: "preview",
      fetcher: electronNet.fetch,
      allowInsecureLoopback: isDevMode,
    });
  }
  return verifyConnectLink(rawUrl);
}

async function acceptConnectLink(rawUrl) {
  if (extractConnectExchange(rawUrl)) {
    return resolveConnectExchangeUrl(rawUrl, {
      mode: "exchange",
      fetcher: electronNet.fetch,
      allowInsecureLoopback: isDevMode,
    });
  }
  return verifyConnectLink(rawUrl);
}

async function persistConnectLinkClaims(claims) {
  const previous = workspaceStore.readDesktopBootstrapConfigSync();
  const config = await persistConnectLinkBranding(claims, {
    persistBootstrap: (config) => workspaceStore.setDesktopBootstrapConfig(config),
    applyBrandIconUrl: (iconUrl) => applyBrandIconUrl(iconUrl).catch((error) =>
      brandIconFailure("connect-apply-failed", error)),
    enterpriseActivation: DESKTOP_DISTRIBUTION.flavor === "enterprise"
      ? {
          activatedAt: new Date().toISOString(),
          denBaseUrl: claims.den.baseUrl,
        }
      : null,
  });
  if (
    desktopActivationRequired(DESKTOP_DISTRIBUTION, previous)
    && !desktopActivationRequired(DESKTOP_DISTRIBUTION, config)
  ) {
    await uiControlServer.start().catch((error) => {
      console.warn("[ui-control] failed to start", error);
    });
    await runtimeManager.prepareFreshRuntime();
  }
  return config;
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
        entry.startsWith(`${DESKTOP_PROTOCOL_SCHEME}://`) ||
        (!app.isPackaged && entry.startsWith("openwork-dev://")) ||
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

function globalOpencodeRoot() {
  return globalOpencodeConfigDir();
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

const runtimeManager = createRuntimeManager({
  app,
  desktopRoot: path.resolve(__dirname, ".."),
  listLocalWorkspacePaths: () => workspaceStore.listLocalWorkspacePaths(),
  // When OPENWORK_ENCRYPTION_KEY is set, skip the safeStorage provider so it does not shadow the documented env override used by CI/headless/enterprise.
  localManagedMcpVaultKey: process.env.OPENWORK_ENCRYPTION_KEY?.trim()
    ? undefined
    : createDesktopVaultKeyProvider({
        filePath: path.join(app.getPath("userData"), "local-managed-mcp-vault-key.bin"),
        loadSafeStorage: () => require("electron").safeStorage,
      }),
});
const initialRunnerBootstrap = workspaceStore.readDesktopBootstrapConfigSync();
const legacyRunnerBaseUrls = [
  initialRunnerBootstrap.apiBaseUrl,
  initialRunnerBootstrap.baseUrl,
  initialRunnerBootstrap.baseUrl
    ? `${String(initialRunnerBootstrap.baseUrl).replace(/\/+$/, "")}/api/den`
    : null,
  `${DEFAULT_DEN_BASE_URL}/api/den`,
].map((value) => normalizeRunnerBaseUrl(value)).filter(Boolean);
const desktopAutomationRunner = createDesktopAutomationRunner({
  // v1 credentials predate token audiences. Keep them usable during the Den
  // rollout only for endpoints trusted before the renderer starts issuing IPC.
  legacyBaseUrls: legacyRunnerBaseUrls,
  getLocalRuntime: async () => {
    const server = await runtimeManager.openworkServerInfo();
    return { baseUrl: server.baseUrl, token: server.clientToken ?? server.ownerToken };
  },
  log: (state) => console.info(`[automation-runner] ${state}`),
  onCredentialRejected: () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(AUTOMATION_RUNNER_CREDENTIAL_REJECTED_EVENT);
  },
});

// Scheduled Automations are due at wall-clock times a laptop routinely sleeps
// through. Waking the machine has to poll for work now, not up to a full poll
// interval later, or a recovered occurrence sits queued while the desktop is
// already back.
const wakeAutomationRunner = (wakeEvent) => {
  if (desktopAutomationRunner.wake().polled) {
    console.info(`[automation-runner] polling for work after ${wakeEvent}`);
  }
};
powerMonitor.on("resume", () => wakeAutomationRunner("resume"));
powerMonitor.on("unlock-screen", () => wakeAutomationRunner("unlock-screen"));

let runtimeDisposedForQuit = false;
let runtimeDisposeInProgress = false;
let runtimeBootstrapPromise = null;

function showShutdownScreen() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    win.show();
    void win.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { height: 100%; margin: 0; background: #0b0b0f; color: #f4f4f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { display: grid; place-items: center; }
      main { display: grid; gap: 10px; justify-items: center; }
      .spinner { width: 22px; height: 22px; border: 2px solid rgba(244,244,245,.25); border-top-color: #f4f4f5; border-radius: 50%; animation: spin .9s linear infinite; }
      .title { font-size: 15px; font-weight: 600; }
      .body { font-size: 13px; color: #a1a1aa; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main>
      <div class="spinner" aria-hidden="true"></div>
      <div class="title">Stopping OpenWork services</div>
      <div class="body">Closing local workers and background services...</div>
    </main>
  </body>
</html>`)}`).catch(() => undefined);
  } catch {
    // Ignore renderer teardown races during quit.
  }
}

async function disposeRuntimeBeforeQuit() {
  if (runtimeDisposedForQuit || runtimeDisposeInProgress) return;
  runtimeDisposeInProgress = true;
  try {
    await runtimeManager.dispose().catch(() => undefined);
    runtimeDisposedForQuit = true;
  } finally {
    runtimeDisposeInProgress = false;
  }
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
  if (typeof process.env.OPENWORK_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE === "string") {
    throw new Error(process.env.OPENWORK_EVAL_FATAL_DESKTOP_BOOTSTRAP_FAILURE);
  }
  const list = await workspaceStore.readWorkspaceState();
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
    await workspaceStore.writeWorkspaceState({
      ...list,
      selectedId: String(fallback.id ?? ""),
      watchedId: String(fallback.id ?? ""),
    }).catch(() => undefined);
  }
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

function resolveOpencodeConfigPath(scope, projectDir) {
  if (scope === "project") {
    if (!String(projectDir ?? "").trim()) {
      throw new Error("projectDir is required");
    }
    return workspaceOpencodeConfigCandidates(projectDir);
  } else if (scope === "global") {
    const root = globalOpencodeRoot();
    return [path.join(root, "opencode.jsonc"), path.join(root, "opencode.json")];
  } else {
    throw new Error("scope must be 'project' or 'global'");
  }
}

async function selectOpencodeConfigPath(candidates) {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return candidates[0];
}

async function readOpencodeConfig(scope, projectDir) {
  const chosenPath = await selectOpencodeConfigPath(resolveOpencodeConfigPath(scope, projectDir));
  const exists = await pathExists(chosenPath);
  return {
    path: chosenPath,
    exists,
    content: exists ? await readFile(chosenPath, "utf8") : null,
  };
}

async function writeOpencodeConfig(scope, projectDir, content) {
  const targetPath = await selectOpencodeConfigPath(resolveOpencodeConfigPath(scope, projectDir));
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

// Desktop IPC command registry. Every command invokable from the renderer's
// desktopBridge Proxy (apps/app/src/app/lib/desktop.ts) has exactly one
// entry here; handlers receive the ipcMain event followed by the renderer
// arguments. The @type below asserts this registry against the shared
// DesktopCommandMap contract (packages/types/src/desktop-ipc.ts): a missing,
// extra, or renamed command fails `pnpm --filter @openwork/desktop
// typecheck:electron`.
/** @type {import("@openwork/types/desktop-ipc").DesktopCommandHandlers<import("electron").IpcMainInvokeEvent>} */
const desktopCommandHandlers = {
  "workspaceBootstrap": async (event, ...args) => {
      return workspaceStore.readWorkspaceState();
  },
  "workspaceSetSelected": async (event, ...args) => {
      return workspaceStore.setSelectedWorkspace(typeof args[0] === "string" ? args[0] : "");
  },
  "workspaceSetRuntimeActive": async (event, ...args) => {
      return workspaceStore.setRuntimeActiveWorkspace(typeof args[0] === "string" && args[0].trim() ? args[0] : null);
  },
  "workspaceCreate": async (event, ...args) => {
      return workspaceStore.createWorkspace(args[0] ?? {});
  },
  "workspaceCreateRemote": async (event, ...args) => {
      return workspaceStore.createRemoteWorkspace(args[0] ?? {});
  },
  "workspaceUpdateRemote": async (event, ...args) => {
      return workspaceStore.updateRemoteWorkspace(args[0] ?? {});
  },
  "workspaceUpdateDisplayName": async (event, ...args) => {
      return workspaceStore.updateWorkspaceDisplayName(args[0] ?? {});
  },
  "workspaceForget": async (event, ...args) => {
      return workspaceStore.forgetWorkspace(String(args[0] ?? "").trim());
  },
  "workspaceAddAuthorizedRoot": async (event, ...args) => {
      return workspaceStore.addAuthorizedRoot(args[0] ?? {});
  },
  "workspaceOpenworkRead": async (event, ...args) => {
      return workspaceStore.readWorkspaceOpenworkConfig(String(args[0]?.workspacePath ?? "").trim());
  },
  "workspaceOpenworkWrite": async (event, ...args) => {
      return workspaceStore.writeWorkspaceOpenworkConfig(
        String(args[0]?.workspacePath ?? "").trim(),
        args[0]?.config ?? workspaceStore.defaultWorkspaceOpenworkConfig(""),
      );
  },
  "workspaceExportConfig": async (event, ...args) => {
      return workspaceStore.exportConfig(args[0] ?? {});
  },
  "workspaceImportConfig": async (event, ...args) => {
      return workspaceStore.importConfig(args[0] ?? {});
  },
  "opencodeCommandList": async (event, ...args) => {
      return listCommandNames(String(args[0]?.scope ?? "").trim(), String(args[0]?.projectDir ?? "").trim());
  },
  "opencodeCommandWrite": async (event, ...args) => {
      return writeCommandFile(
        String(args[0]?.scope ?? "").trim(),
        String(args[0]?.projectDir ?? "").trim(),
        args[0]?.command ?? {},
      );
  },
  "opencodeCommandDelete": async (event, ...args) => {
      return deleteCommandFile(
        String(args[0]?.scope ?? "").trim(),
        String(args[0]?.projectDir ?? "").trim(),
        String(args[0]?.name ?? "").trim(),
      );
  },
  "engineStart": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const options = args[1] ?? {};
      return runtimeManager.engineStart(projectDir, options);
  },
  "prepareFreshRuntime": async (event, ...args) => {
      return runtimeManager.prepareFreshRuntime();
  },
  "runtimeBootstrap": async (event, ...args) => {
      return ensureRuntimeBootstrap();
  },
  "runtimeStatus": async (event, ...args) => {
      return runtimeManager.runtimeStatus();
  },
  "engineStop": async (event, ...args) => {
      return runtimeManager.engineStop();
  },
  "engineRestart": async (event, ...args) => {
      return runtimeManager.engineRestart(args[0] ?? {});
  },
  "engineInfo": async (event, ...args) => {
      return runtimeManager.engineInfo();
  },
  "engineDoctor": async (event, ...args) => {
      return engineDoctor(args[0]);
  },
  "engineInstall": async (event, ...args) => {
      return runtimeManager.engineInstall();
  },
  "appBuildInfo": async (event, ...args) => {
      return {
        version: app.getVersion(),
        gitSha: process.env.OPENWORK_GIT_SHA ?? null,
        buildEpoch: process.env.OPENWORK_BUILD_EPOCH ?? null,
        openworkDevMode: process.env.OPENWORK_DEV_MODE === "1",
      };
  },
  "desktopNotificationShow": async (event, ...args) => {
      return showDesktopNotification(args[0] ?? {});
  },
  "desktopSentrySetSession": async (event, ...args) => {
      const input = args[0] ?? {};
      return {
        enabled: setOpenworkSentrySession({
          userId: input.userId,
          orgId: input.orgId,
        }),
      };
  },
  "desktopSentryClearSession": async (event, ...args) => {
      return { enabled: clearOpenworkSentrySession() };
  },
  "desktopIntegrationStatus": async (event, ...args) => {
      return linuxDesktopIntegration.getStatus();
  },
  "desktopIntegrationInstall": async (event, ...args) => {
      if (BLANK_SLATE_LAUNCH.enabled) throw new Error("Desktop integration is disabled for test profiles.");
      return linuxDesktopIntegration.install(args[0] ?? {});
  },
  "desktopIntegrationRemove": async (event, ...args) => {
      if (BLANK_SLATE_LAUNCH.enabled) throw new Error("Desktop integration is disabled for test profiles.");
      return linuxDesktopIntegration.remove();
  },
  "getUiControlBridgeInfo": async (event, ...args) => {
      try {
        const raw = await readFile(path.join(app.getPath("userData"), "openwork-ui-control.json"), "utf8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
  },
  "getOpenworkUiMcpCommand": async (event, ...args) => {
      if (process.env.OPENWORK_DEV_MODE === "1") {
        return ["node", path.resolve(__dirname, "../../..", "packages/openwork-ui-mcp/index.mjs")];
      }
      return ["npx", "-y", "openwork-ui-mcp"];
  },
  "getComputerUseMcpCommand": async (event, ...args) => {
      return getComputerUseMcpCommand();
  },
  "checkComputerUsePermissions": async (event, ...args) => {
      // Read permissions in the same child-process context as setup.
      return checkComputerUsePermissions();
  },
  "listRunningApps": async (event, ...args) => {
      // Running regular macOS apps for composer @App mentions.
      return listRunningApps();
  },
  "openComputerUsePermissionSetup": async (event, ...args) => {
      // Open the GUI app. Returns immediately — React shows "verify" CTA.
      await openComputerUseSetupApp();
      // Return a fresh check so the UI shows the current state.
      return checkComputerUsePermissions();
  },
  "openComputerUsePermissionSettings": async (event, ...args) => {
      // Legacy: open the setup app (same as above).
      await openComputerUseSetupApp();
      return checkComputerUsePermissions();
  },
  "getOpenworkUiMcpEnvironment": async (event, ...args) => {
      return {
        OPENWORK_UI_CONTROL_DISCOVERY: path.join(app.getPath("userData"), "openwork-ui-control.json"),
      };
  },
  "getDesktopBootstrapConfig": async (event, ...args) => {
      return workspaceStore.getDesktopBootstrapConfig();
  },
  "debugDesktopBootstrapConfig": async (event, ...args) => {
      return workspaceStore.debugDesktopBootstrapConfig();
  },
  "clearDesktopBootstrapConfig": async (event, ...args) => {
      return workspaceStore.clearDesktopBootstrapConfig();
  },
  "setDesktopBootstrapConfig": async (event, ...args) => {
      const previous = workspaceStore.readDesktopBootstrapConfigSync();
      // A locked installation must never be able to unlock itself by writing
      // policy through the bridge. The activation requirement is cleared only
      // by an administrator editing desktop-bootstrap.json on disk (which this
      // process reads, never writes) or by a completed Den activation.
      const requested = args[0] ?? {};
      const guarded = desktopActivationRequired(DESKTOP_DISTRIBUTION, previous)
          && requested?.requireActivation === false
        ? { ...requested, requireActivation: true }
        : requested;
      const next = await workspaceStore.setDesktopBootstrapConfig(guarded);
      if (
        desktopActivationRequired(DESKTOP_DISTRIBUTION, previous)
        && !desktopActivationRequired(DESKTOP_DISTRIBUTION, next)
      ) {
        await uiControlServer.start().catch((error) => {
          console.warn("[ui-control] failed to start", error);
        });
        await runtimeManager.prepareFreshRuntime();
      }
      return next;
  },
  "connectLinkVerify": async (event, ...args) => {
      // Read-only check — parses + verifies the deep link, writes nothing.
      // Replay is surfaced here too so an already-used link gets its refusal
      // before the user is ever shown a confirmation.
      const verified = await previewConnectLink(String(args[0] ?? ""));
      if (verified.ok === false) return verified;
      if (verified.transport === "signed" && await connectLinkReplayGuard.has(verified.claims.jti)) {
        return { ok: false, code: "replayed", message: "This connect link was already used on this machine." };
      }
      return verified;
  },
  "connectLinkAccept": async (event, ...args) => {
      // The renderer passes the raw URL back after the user confirmed; claims
      // shaped in the renderer are never trusted (desktop-ipc trust boundary).
      const verified = await acceptConnectLink(String(args[0] ?? ""));
      if (verified.ok === false) return verified;
      if (verified.transport === "exchange") {
        const config = await persistConnectLinkClaims(verified.claims);
        return { ok: true, config };
      }
      if (await connectLinkReplayGuard.has(verified.claims.jti)) {
        return { ok: false, code: "replayed", message: "This connect link was already used on this machine." };
      }
      // Consume before mutation. If the replay ledger cannot be persisted,
      // fail closed and leave the existing bootstrap untouched.
      if (!(await connectLinkReplayGuard.remember(verified.claims.jti))) {
        return { ok: false, code: "replayed", message: "This connect link was already used on this machine." };
      }
      const config = await persistConnectLinkClaims(verified.claims);
      return { ok: true, config };
  },
  "nukeOpenworkAndOpencodeConfigPreview": async (event, ...args) => {
      return buildNukeManifest({
        env: process.env,
        homedir: os.homedir(),
        platform: process.platform,
        preserveBootstrap: args[0]?.preserveBootstrap !== false,
        userDataPath: app.getPath("userData"),
        workspacePaths: await workspaceStore.listLocalWorkspacePaths(),
      });
  },
  "nukeOpenworkAndOpencodeConfigAndExit": async (event, ...args) => {
      return executeNukeFreshStart({
        app,
        session,
        runtimeManager,
        uiControlServer,
        removeWindowsBrandShortcut,
      }, {
        preserveBootstrap: args[0]?.preserveBootstrap !== false,
        input: {
          env: process.env,
          homedir: os.homedir(),
          platform: process.platform,
          userDataPath: app.getPath("userData"),
          workspacePaths: await workspaceStore.listLocalWorkspacePaths(),
        },
      });
  },
  "sandboxCleanupOpenworkContainers": async (event, ...args) => {
      return runtimeManager.sandboxCleanupOpenworkContainers();
  },
  "openworkServerInfo": async (event, ...args) => {
      return runtimeManager.openworkServerInfo();
  },
  "automationRunnerConfigure": async (event, ...args) => {
      return desktopAutomationRunner.configure(args[0] ?? null);
  },
  "openworkServerRestart": async (event, ...args) => {
      return runtimeManager.openworkServerRestart(args[0] ?? {});
  },
  "pickDirectory": async (event, ...args) => {
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
  },
  "pickFile": async (event, ...args) => {
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
  },
  "saveFile": async (event, ...args) => {
      const options = args[0] ?? {};
      const result = await dialog.showSaveDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
      });
      return result.canceled ? null : (result.filePath ?? null);
  },
  "importSkill": async (event, ...args) => {
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
  },
  "installSkillTemplate": async (event, ...args) => {
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
  },
  "listLocalSkills": async (event, ...args) => {
      return listLocalSkills(String(args[0] ?? "").trim());
  },
  "readLocalSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        throw new Error("Skill not found");
      }
      return { path: skillPath, content: await readFile(skillPath, "utf8") };
  },
  "writeLocalSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        return execResult(false, "", "Skill not found");
      }
      const content = String(args[2] ?? "");
      const next = content.endsWith("\n") ? content : `${content}\n`;
      await writeFile(skillPath, next, "utf8");
      return execResult(true, `Saved skill ${path.basename(path.dirname(skillPath))}`);
  },
  "uninstallSkill": async (event, ...args) => {
      const projectDir = String(args[0] ?? "").trim();
      const skillPath = await findSkillFile(projectDir, args[1]);
      if (!skillPath) {
        return execResult(false, "", "Skill not found in .opencode/skills or .claude/skills");
      }
      await rm(path.dirname(skillPath), { recursive: true, force: true });
      return execResult(true, `Removed skill ${args[1]}`);
  },
  "updaterEnvironment": async (event, ...args) => {
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
  },
  "readOpencodeConfig": async (event, ...args) => {
      return readOpencodeConfig(String(args[0] ?? "").trim(), String(args[1] ?? "").trim());
  },
  "writeOpencodeConfig": async (event, ...args) => {
      return writeOpencodeConfig(
        String(args[0] ?? "").trim(),
        String(args[1] ?? "").trim(),
        String(args[2] ?? ""),
      );
  },
  "resetOpenworkState": async (event, ...args) => {
      return workspaceStore.resetOpenworkState();
  },
  "resetOpencodeCache": async (event, ...args) => {
      return { removed: [], missing: [], errors: [] };
  },
  "opencodeMcpAuth": async (event, ...args) => {
      return runtimeManager.opencodeMcpAuth(String(args[0] ?? "").trim(), String(args[1] ?? "").trim());
  },
  "setWindowDecorations": async (event, ...args) => {
      return undefined;
  },
  "__openPath": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      if (!target) return "Path is required.";
      return shell.openPath(target);
  },
  "__revealItemInDir": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      if (!target) return "Path is required.";
      if (existsSync(target)) {
        shell.showItemInFolder(target);
        return undefined;
      }
      // The exact file may not exist yet (or path is slightly off); fall back to
      // opening the containing directory so the user still lands in the right place.
      const parent = path.dirname(target);
      if (parent && parent !== target && existsSync(parent)) {
        const error = await shell.openPath(parent);
        return error && error.trim() ? error : undefined;
      }
      return `Could not find "${target}" on disk.`;
  },
  "__getFileIcon": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      if (!target) return null;
      const requestedSize = args[1];
      /** @type {"small" | "normal" | "large"} */
      let validSize = "normal";
      if (requestedSize === "small" || requestedSize === "normal" || requestedSize === "large") {
        validSize = requestedSize;
      }
      try {
        const image = await app.getFileIcon(target, { size: validSize });
        return image.isEmpty() ? null : image.toDataURL();
      } catch {
        return null;
      }
  },
  "__applyBrandAppName": async (event, ...args) => {
    currentDisplayAppName = applyBrandAppName(
      BLANK_SLATE_LAUNCH.enabled || DESKTOP_DISTRIBUTION.flavor === "enterprise" ? null : args[0],
      {
      fallbackName: APP_NAME,
      platform: process.platform,
      updateElectronAppName: process.platform === "darwin",
      runtimeProcess: process,
      app,
      applicationMenu,
      window: mainWindow,
      },
    );
    if (process.platform === "win32" && !BLANK_SLATE_LAUNCH.enabled) {
      await registerWindowsDisplayShortcut();
    }
    return { ok: true, appName: currentDisplayAppName };
  },
  "__applyBrandIcon": async (event, ...args) => {
      if (BLANK_SLATE_LAUNCH.enabled) return { ok: true };
      const value = args[0] === null ? null : String(args[0] ?? "");
      return applyBrandIconUrl(value);
  },
  "__getBrandIconState": async (event, ...args) => {
      return getBrandIconState();
  },
  "__getApplicationsForFile": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      if (!target) return [];
      const platform = process.platform;
      const results = [];

      try {
        if (platform === "darwin") {
          // Scan /Applications and /System/Applications for .app bundles
          const appDirs = ["/Applications", "/System/Applications", "/Applications/Utilities", `${os.homedir()}/Applications`];
          const seen = new Set();
          for (const dir of appDirs) {
            let entries;
            try { entries = await readdir(dir); } catch { continue; }
            for (const entry of entries) {
              if (!entry.endsWith(".app")) continue;
              const appPath = path.join(dir, entry);
              if (seen.has(appPath)) continue;
              seen.add(appPath);
              const name = entry.replace(/\.app$/i, "");
              let icon = null;
              try {
                const img = await app.getFileIcon(appPath, { size: "small" });
                icon = img.isEmpty() ? null : img.toDataURL();
              } catch {}
              results.push({ name, appPath, icon });
            }
          }
        } else if (platform === "linux") {
          // Parse .desktop files in standard directories
          const desktopDirs = ["/usr/share/applications", "/usr/local/share/applications", `${os.homedir()}/.local/share/applications`];
          const seen = new Set();
          for (const dir of desktopDirs) {
            let entries;
            try { entries = await readdir(dir); } catch { continue; }
            for (const entry of entries) {
              if (!entry.endsWith(".desktop")) continue;
              const filePath = path.join(dir, entry);
              if (seen.has(filePath)) continue;
              seen.add(filePath);
              try {
                const content = await readFile(filePath, "utf-8");
                const nameMatch = content.match(/^Name=(.+)$/m);
                const execMatch = content.match(/^Exec=(.+)$/m);
                if (!nameMatch || !execMatch) continue;
                const name = nameMatch[1].trim();
                const appPath = execMatch[1].trim().replace(/%[fFuU]/g, "").trim();
                if (!appPath) continue;
                let icon = null;
                try {
                  const img = await app.getFileIcon(filePath, { size: "small" });
                  icon = img.isEmpty() ? null : img.toDataURL();
                } catch {}
                results.push({ name, appPath, icon });
              } catch {}
            }
          }
        }
      } catch {}

      return results;
  },
  "__openWithApp": async (event, ...args) => {
      const target = String(args[0] ?? "").trim();
      const appPath = String(args[1] ?? "").trim();
      if (!target || !appPath) return "Target and app path are required.";
      const platform = process.platform;
      try {
        if (platform === "darwin") {
          execFileSync("open", ["-a", appPath, target]);
        } else if (platform === "linux") {
          const child = spawn(appPath, [target], { detached: true, stdio: "ignore" });
          child.unref();
        } else {
          return `Open with app is not supported on ${platform}`;
        }
      } catch (err) {
        return String(err?.message ?? err);
      }
  },
  "__fetch": async (event, ...args) => {
      const url = String(args[0] ?? "").trim();
      const init = args[1] ?? {};
      if (!url) throw new Error("URL is required.");
      /** @type {RequestInit} */
      const requestInit = {
        method: typeof init.method === "string" ? init.method : undefined,
        headers: init.headers && typeof init.headers === "object" ? init.headers : undefined,
        body: typeof init.body === "string" ? init.body : undefined,
        credentials: "omit",
        cache: "no-store",
      };
      if (init.agentContextDiagnostics && typeof init.agentContextDiagnostics === "object") {
        return fetchAgentContextDiagnosticsResponse(
          electronNet.fetch,
          url,
          requestInit,
          init.agentContextDiagnostics.deadlineAtMs,
        );
      }
      const timeoutMs = Number(init.timeoutMs);
      const response = await electronNet.fetch(url, {
        ...requestInit,
        signal: Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
        body: await response.text(),
      };
  },
  "__uploadMultipart": async (event, ...args) => {
      return runDesktopTransfer(event, args[0] ?? {}, uploadMultipartFromBytes);
  },
  "__downloadBinary": async (event, ...args) => {
      return runDesktopTransfer(event, args[0] ?? {}, downloadBinaryToPath);
  },
  "__cancelTransfer": async (event, ...args) => {
      const controller = activeDesktopTransfers.get(desktopTransferKey(event, args[0]));
      if (!controller) return false;
      controller.abort();
      return true;
  },
  "__homeDir": async (event, ...args) => {
      return os.homedir();
  },
  "__joinPath": async (event, ...args) => {
      return path.join(...args.map((value) => String(value ?? "")));
  },
  "__setZoomFactor": async (event, ...args) => {
      const factor = Number(args[0]);
      const window = activeWindowFromEvent(event);
      if (!window || !Number.isFinite(factor) || factor <= 0) {
        return false;
      }
      window.webContents.setZoomFactor(factor);
      return true;
  },
  "__setNativeTheme": async (event, ...args) => {
      return applyNativeTheme(String(args[0]));
  },
  "__setApplicationMenuVisible": async (event, ...args) => {
      return applicationMenu.setVisible(args[0]);
  },
};

if (isDevMode) {
  desktopCommandHandlers.__evalRelaunch = async () => {
    // Chromium persists localStorage/leveldb lazily; force a flush so the
    // relaunched instance sees the same renderer storage (otherwise the app
    // can come back signed out and eval flows misread that as a regression).
    try {
      mainWindow?.webContents.session.flushStorageData();
      session.defaultSession.flushStorageData();
    } catch {
      // Best effort — never block the relaunch on a flush failure.
    }
    setTimeout(() => {
      app.relaunch();
      // Graceful quit (not app.exit) so before-quit teardown runs and managed
      // sidecars are stopped — a hard exit orphans them and they can hold
      // ports (e.g. the CDP debug port) the relaunched instance needs.
      app.quit();
    }, 150);
    return { ok: true };
  };
}

function desktopErrorMessageSegment(error, includeName = false) {
  try {
    if (error && (typeof error === "object" || typeof error === "function")) {
      const message = typeof error.message === "string" ? error.message.trim() : "";
      if (message) {
        const name = typeof error.name === "string" ? error.name.trim() : "";
        return includeName && name && name !== "Error" && !message.startsWith(`${name}:`)
          ? `${name}: ${message}`
          : message;
      }
    }
    return String(error);
  } catch {
    return "Unknown error";
  }
}

function desktopErrorCause(error) {
  try {
    return error && (typeof error === "object" || typeof error === "function") ? error.cause : undefined;
  } catch {
    return undefined;
  }
}

function desktopErrorMessageWithCauses(error) {
  try {
    const messages = [];
    const seenMessages = new Set();
    const seenErrors = new Set();
    let current = error;
    for (let depth = 0; current != null && depth < 8; depth += 1) {
      if (typeof current === "object" || typeof current === "function") {
        if (seenErrors.has(current)) break;
        seenErrors.add(current);
      }
      const message = desktopErrorMessageSegment(current, depth === 0).trim();
      if (message && !seenMessages.has(message)) {
        seenMessages.add(message);
        messages.push(message);
      }
      current = desktopErrorCause(current);
    }
    const combined = messages.join(": ") || "Unknown desktop command error";
    return combined.length > 2000 ? `${combined.slice(0, 1997)}...` : combined;
  } catch {
    return "Unknown desktop command error";
  }
}

function assertDesktopActivation() {
  if (desktopActivationRequired(
    DESKTOP_DISTRIBUTION,
    workspaceStore.readDesktopBootstrapConfigSync(),
  )) {
    throw new Error("OpenWork must be activated from your Den portal before this command is available.");
  }
}

async function handleDesktopInvoke(event, command, ...args) {
  if (!enterprisePreactivationCommandAllowed(command)) {
    assertDesktopActivation();
  }
  const handler = desktopCommandHandlers[command];
  if (!handler) {
    throw new Error(`Electron desktop bridge method is not implemented yet: ${command}`);
  }
  try {
    return await handler(event, ...args);
  } catch (error) {
    throw new Error(desktopErrorMessageWithCauses(error), { cause: error });
  }
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

  const bootSidecar = await readBrandIconSidecar();
  const bootSourceUrl = typeof bootSidecar?.sourceUrl === "string" ? bootSidecar.sourceUrl : null;
  const cachedBrandImage = bootSourceUrl ? resolveBrandIconImage() : null;
  const windowIconImage = cachedBrandImage ?? APP_ICON_IMAGE;
  if (process.platform === "win32" && cachedBrandImage && bootSourceUrl) {
    try {
      const taskbarIconPath = await ensureWindowsBrandIcon(cachedBrandImage);
      const taskbarAppId = windowsBrandAppUserModelId(APP_IDENTIFIER, bootSourceUrl);
      await registerWindowsBrandShortcut(taskbarAppId, taskbarIconPath);
      app.setAppUserModelId(taskbarAppId);
    } catch (error) {
      console.warn("[brand-icon] failed to register cached Windows shortcut before window creation", error);
    }
  }
  if (process.platform === "darwin" && windowIconImage && !windowIconImage.isEmpty() && app.dock) {
    app.dock.setIcon(windowIconImage);
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    title: currentDisplayAppName,
    show: false,
    ...(process.platform === "win32" ? { skipTaskbar: true } : {}),
    ...windowAppearanceOptions,
    ...(windowIconImage && !windowIconImage.isEmpty() ? { icon: windowIconImage } : {}),
    webPreferences: {
      // The renderer owns session dispatch + event streams; keep it running
      // while hidden/minimized so background tasks are not interrupted.
      backgroundThrottling: false,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Enable Chromium's built-in PDF viewer so PDFs render inside the
      // artifact panel (<embed> pointed at a blob URL).
      plugins: true,
    },
  });
  if (cachedBrandImage && bootSourceUrl) {
    await applyCachedBrandIcon(cachedBrandImage, bootSourceUrl);
  }
  applicationMenu.applyVisibility(mainWindow);

  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow?.setTitle(currentDisplayAppName);
  });
  mainWindow.setTitle(currentDisplayAppName);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.setTitle(currentDisplayAppName);
    if (process.platform === "win32") mainWindow?.setSkipTaskbar(false);
    mainWindow?.show();
    flushPendingDeepLinks();
  });

  mainWindow.on("closed", () => {
    browserPanel.destroy();
    mainWindow = null;
  });

  const recoverRendererCrash = createRendererCrashRecovery({
    reload: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.reload();
    },
    onRepeatedCrash: (details) => {
      dialog.showErrorBox(
        `${APP_NAME} could not recover`,
        `The app renderer stopped repeatedly (${details.reason ?? "unknown reason"}). Quit and reopen OpenWork. Your workspace files were not deleted.`,
      );
    },
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    recoverRendererCrash(details);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("file://")) {
      try {
        runDetachedTask("open local file", () => shell.openPath(fileURLToPath(url)));
      } catch {
        runDetachedTask("open local file externally", () => openExternalUrl(url));
      }

      return { action: "deny" };
    }

    const local =
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://localhost");
    if (!local) {
      runDetachedTask("open external URL", () => openExternalUrl(url));
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (browserPanel.isMainWindowAllowedNavigation(url)) return;
    event.preventDefault();
    browserPanel.routeBlockedMainWindowNavigation(url);
  });

  // `will-navigate` does NOT fire for CDP `Page.navigate` (it behaves like
  // loadURL), so agent automation that picks the wrong CDP target — the app
  // window itself is the first page target when no browser tab exists — used
  // to replace the entire workspace UI with the website, with no way back
  // (#2000). Catch those at `did-start-navigation`, cancel the load, and
  // reroute the URL into a built-in browser tab instead.
  mainWindow.webContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    if (browserPanel.isMainWindowAllowedNavigation(url)) return;
    try {
      mainWindow?.webContents.stop();
    } catch {
      // best effort — routing below still gives the user a way back
    }
    browserPanel.routeBlockedMainWindowNavigation(url);
  });

  const startUrl = process.env.OPENWORK_ELECTRON_START_URL?.trim() || process.env.ELECTRON_START_URL?.trim();
  if (startUrl) {
    await mainWindow.loadURL(startUrl);
  } else {
    const packagedIndexPath = path.join(process.resourcesPath, "app-dist", "index.html");
    const devIndexPath = path.resolve(__dirname, "../../app/dist/index.html");
    await mainWindow.loadFile(app.isPackaged ? packagedIndexPath : devIndexPath);
  }

  return mainWindow;
}

ipcMain.on("openwork:desktop-bootstrap-sync", (event) => {
  event.returnValue = workspaceStore.readDesktopBootstrapConfigSync();
});
ipcMain.on("openwork:desktop-distribution-sync", (event) => {
  event.returnValue = DESKTOP_DISTRIBUTION;
});
ipcMain.handle("openwork:desktop", handleDesktopInvoke);
ipcMain.handle("openwork:shell:openExternal", async (_event, url) => {
  if (typeof url !== "string" || url.trim().length === 0) {
    return { ok: false, error: "empty url" };
  }
  return openExternalUrl(url.trim());
});
ipcMain.handle("openwork:shell:relaunch", async () => {
  app.relaunch();
  app.quit();
});
ipcMain.handle("openwork:system:architecture", async () => resolveArchitectureInfo());
ipcMain.handle("openwork:system:microphoneStatus", async () => {
  if (process.platform !== "darwin") return { platform: process.platform, status: "not-mac" };
  return { platform: process.platform, status: systemPreferences.getMediaAccessStatus("microphone") };
});
ipcMain.handle("openwork:system:askMicrophoneAccess", async () => {
  if (process.platform !== "darwin") return { platform: process.platform, granted: true, status: "not-mac" };
  const before = systemPreferences.getMediaAccessStatus("microphone");
  const granted = await systemPreferences.askForMediaAccess("microphone");
  const after = systemPreferences.getMediaAccessStatus("microphone");
  return { platform: process.platform, before, after, granted };
});

// ── Terminal IPC ────────────────────────────────────────────────────────
ipcMain.handle("openwork:terminal:create", async (event, options = {}) => {
  assertDesktopActivation();
  const cwd = await resolveTerminalCwd(options?.cwd);
  const cols = Number.isFinite(options?.cols) ? Math.max(20, Math.floor(options.cols)) : 80;
  const rows = Number.isFinite(options?.rows) ? Math.max(5, Math.floor(options.rows)) : 24;
  const terminalId = `term_${nextTerminalId++}`;
  const shellPath = defaultTerminalShell();
  const child = pty.spawn(shellPath, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      OPENWORK_TERMINAL: "1",
    },
  });

  terminalProcesses.set(terminalId, { process: child, webContentsId: event.sender.id });
  event.sender.once("destroyed", () => killTerminalsForWebContents(event.sender.id));
  child.onData((data) => {
    if (event.sender.isDestroyed()) return;
    event.sender.send("openwork:terminal:data", { terminalId, data });
  });
  child.onExit(({ exitCode, signal }) => {
    terminalProcesses.delete(terminalId);
    if (event.sender.isDestroyed()) return;
    event.sender.send("openwork:terminal:exit", { terminalId, exitCode, signal });
  });

  return { terminalId };
});
ipcMain.handle("openwork:terminal:write", (event, terminalId, data) => {
  const terminal = terminalForSender(event, terminalId);
  if (!terminal || typeof data !== "string") return;
  terminal.process.write(data);
});
ipcMain.handle("openwork:terminal:resize", (event, terminalId, cols, rows) => {
  const terminal = terminalForSender(event, terminalId);
  if (!terminal || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
  terminal.process.resize(Math.max(20, Math.floor(cols)), Math.max(5, Math.floor(rows)));
});
ipcMain.handle("openwork:terminal:kill", (event, terminalId) => {
  const terminal = terminalForSender(event, terminalId);
  if (!terminal) return;
  killTerminal(String(terminalId));
});

browserPanel.registerIpc(ipcMain);
const browserLoginEvalSeam = !app.isPackaged && process.env.OPENWORK_EVAL_BROWSER_LOGIN_SYNC === "1";
const browserLoginSync = createBrowserLoginSync({
  statePath: path.join(app.getPath("userData"), "browser-login-sync.json"),
  initialPolicyAllowed:
    DESKTOP_DISTRIBUTION.flavor === "public"
    && initialRunnerBootstrap.requireSignin !== true,
  confirmUserAction: browserLoginEvalSeam
    ? async () => true
    : async ({ action, source, sites = [] }) => {
      const sourceLabel = source ? `${source.label} · ${source.profile}` : "Supported browser profiles on this computer";
      /** @type {import("electron").MessageBoxOptions} */
      const options = {
        type: "warning",
        buttons: [action === "resume" ? "Resume sync" : action === "configure" ? "Enable sync" : action === "discover" ? "Look for browsers" : "Read sites", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        title: action === "resume" ? "Resume browser login sync?" : action === "configure" ? "Enable browser login sync?" : action === "discover" ? "Look for browser profiles?" : "Read logins from this browser?",
        message: sourceLabel,
        detail: action === "resume"
          ? "OpenWork will resume reading the sites you selected from this profile. It never changes the source browser."
          : action === "configure"
            ? `OpenWork will keep reading login cookies for these sites until you pause or disconnect: ${sites.join(", ")}. It never changes the source browser.`
            : action === "discover"
              ? "OpenWork will look only for supported browser profile locations. It will not read cookie databases until you choose a profile and confirm again."
              : "OpenWork will read login metadata from this profile so you can choose sites. Nothing syncs until you confirm those sites, and the source browser is never changed.",
        noLink: true,
      };
      const result = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      return result.response === 0;
    },
});
browserLoginSync.registerIpc(ipcMain, { evalSeam: browserLoginEvalSeam });

registerMigrationIpc({ app, ipcMain });
const { ensureAutoUpdater } = registerUpdaterIpc({
  app,
  ipcMain,
  getMainWindow: () => mainWindow,
  // All distributions intentionally share one application identifier, so they also
  // share Squirrel's ShipIt domain. Keep the shared default rather than
  // implying an isolation the bundle identifier cannot provide.
  manifestChannel: DESKTOP_DISTRIBUTION.flavor === "public"
    ? "latest"
    : DESKTOP_DISTRIBUTION.flavor,
  electronNet,
  shell,
  distribution: DESKTOP_DISTRIBUTION.flavor,
  platform: process.platform,
  arch: process.arch,
});

if (!app.requestSingleInstanceLock()) {
  if (isDevMode && !app.isPackaged) {
    console.error(`[openwork] Another OpenWork dev instance already holds this profile directory:
  ${app.getPath("userData")}
The second process is exiting so its CDP port is released.
Run this worktree with an isolated profile: OPENWORK_DEV_PROFILE=auto pnpm dev
or use: pnpm dev:worktree`);
    app.exit(1);
    setImmediate(() => process.exit(1));
  } else {
    app.quit();
  }
} else {
  app.on("before-quit", (event) => {
    if (runtimeDisposedForQuit) return;
    event.preventDefault();
    if (runtimeDisposeInProgress) return;
    showShutdownScreen();
    desktopAutomationRunner.stop();
    browserLoginSync.shutdown();
    runDetachedTask("stop services before quit", async () => {
      try {
        await Promise.all([
          disposeRuntimeBeforeQuit(),
          uiControlServer.stop(),
        ]);
      } finally {
        scheduleBlankSlateProfileCleanup();
        app.quit();
      }
    });
  });

  app.on("second-instance", (_event, argv) => {
    runDetachedTask("focus second instance", async () => {
      const win = await createMainWindow();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      queueDeepLinks(forwardedDeepLinks(argv));
    });
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    runDetachedTask("open deep link", async () => {
      const win = await createMainWindow();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      queueDeepLinks([url]);
    });
  });

  app.whenReady().then(async () => {
    const systemCaCertificates = await runtimeManager.systemCaCertificates();
    session.defaultSession.setCertificateVerifyProc(createSystemCaCertificateVerifyProc(systemCaCertificates));
    installMediaPermissionHandlers(session, () => mainWindow);
    await runPendingNukeCleanup({
      env: process.env,
      homedir: os.homedir(),
      platform: process.platform,
      userDataPath: app.getPath("userData"),
    }).catch((error) => {
      console.warn("[nuke] pending cleanup failed", error);
    });
    const bootstrapConfig = await workspaceStore.getDesktopBootstrapConfig();
    currentDisplayAppName = applyBrandAppName(
      BLANK_SLATE_LAUNCH.enabled || DESKTOP_DISTRIBUTION.flavor === "enterprise"
        ? null
        : bootstrapConfig.brandAppName,
      {
      fallbackName: APP_NAME,
      platform: process.platform,
      updateElectronAppName: true,
      runtimeProcess: process,
      app,
      applicationMenu,
      },
    );
    if (process.platform === "win32" && !BLANK_SLATE_LAUNCH.enabled) {
      await registerWindowsDisplayShortcut();
    }
    if (process.platform !== "linux" && !BLANK_SLATE_LAUNCH.enabled) {
      await applyDesktopBootstrapBrandIcon(bootstrapConfig, applyBrandIconUrl);
    }
    applicationMenu.install();
    if (!desktopActivationRequired(DESKTOP_DISTRIBUTION, bootstrapConfig)) {
      await runtimeManager.prepareFreshRuntime().catch(() => undefined);
    }

    // Use Tauri's existing workspace state file as canonical so rollback and
    // Electron see the same workspace list. Import the short-lived
    // Electron-only filename only when the shared file is missing.
    await workspaceStore.migrateLegacyElectronWorkspaceStateIfNeeded();
    // The UI-control bridge evaluates arbitrary JavaScript in the renderer, so
    // it stays down until the installation is activated. Otherwise it is a
    // local bypass of the pre-activation restriction.
    if (!desktopActivationRequired(DESKTOP_DISTRIBUTION, bootstrapConfig)) {
      await uiControlServer.start().catch((error) => {
        console.warn("[ui-control] failed to start", error);
      });
    }
    if (!desktopActivationRequired(DESKTOP_DISTRIBUTION, bootstrapConfig)) {
      runtimeBootstrapPromise = bootRuntimeForSelectedWorkspace().catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }

    queueDeepLinks(forwardedDeepLinks(process.argv));
    const win = await createMainWindow();
    if (process.platform === "linux" && !BLANK_SLATE_LAUNCH.enabled) {
      await applyDesktopBootstrapBrandIcon(bootstrapConfig, applyBrandIconUrl);
    }
    win.webContents.on("did-finish-load", () => {
      flushPendingDeepLinks();
    });
    if (!BLANK_SLATE_LAUNCH.enabled) {
      setTimeout(() => {
        void linuxDesktopIntegration.maybePrompt(win).catch((error) => {
          console.warn("[desktop-integration] prompt failed", error);
        });
      }, 500);
    }

    // Initialize the packaged updater after the window is up so the user sees
    // a working app first. Renderer-owned checks pass the selected release
    // channel explicitly, avoiding stale stable-feed results for alpha users.
    runDetachedTask("initialize updater", ensureAutoUpdater);
  }).catch((error) => {
    console.error("[desktop] startup failed", error);
    dialog.showErrorBox(
      `${APP_NAME} could not start`,
      "OpenWork hit an unexpected startup error. Quit and reopen the app. If it continues, switch to a Stable build and share the diagnostics with support.",
    );
    app.quit();
  });

  app.on("activate", () => {
    runDetachedTask("activate window", async () => {
      const win = await createMainWindow();
      win.show();
      win.focus();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
