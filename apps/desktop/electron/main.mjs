import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { existsSync } from "node:fs";
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

import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, session, shell, systemPreferences } from "electron";
import { configureFakeMediaForTests, installMediaPermissionHandlers } from "./media-permissions.mjs";
import { registerMigrationIpc } from "./migration.mjs";
import { createRuntimeManager } from "./runtime.mjs";
import { registerUpdaterIpc } from "./updater.mjs";
import {
  checkComputerUsePermissions,
  getComputerUseMcpCommand,
  listRunningApps,
  openComputerUseSetupApp,
} from "./computer-use.mjs";
import { createUiControlServer } from "./ui-control-server.mjs";
import { createApplicationMenu } from "./app-menu.mjs";
import { createBrowserPanel } from "./browser-panel.mjs";
import { createWorkspaceStore } from "./workspace-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pty = require(["node", "pty"].join("-"));
const NATIVE_DEEP_LINK_EVENT = "openwork:deep-link-native";
const TAURI_APP_IDENTIFIER = "com.differentai.openwork";
const DEV_APP_IDENTIFIER = "com.differentai.openwork.dev";
const DESKTOP_PROTOCOL_SCHEME = "openwork";
const isDevMode = process.env.OPENWORK_DEV_MODE === "1";
const APP_NAME = isDevMode ? "OpenWork - Dev" : "OpenWork";
const APP_IDENTIFIER = isDevMode ? DEV_APP_IDENTIFIER : TAURI_APP_IDENTIFIER;
const RELEASE_DOWNLOAD_BASE_URL = "https://github.com/different-ai/openwork/releases/latest/download";
const RELEASE_PAGE_URL = "https://github.com/different-ai/openwork/releases/latest";
const DOCS_PAGE_URL = "https://openworklabs.com/docs";
const applicationMenu = createApplicationMenu({
  appName: APP_NAME,
  docsUrl: DOCS_PAGE_URL,
  getWindow: () => createMainWindow(),
});

const uiControlServer = createUiControlServer({
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
configureFakeMediaForTests(app, envFlagEnabled("OPENWORK_ELECTRON_FAKE_MEDIA"));
const DEFAULT_DEN_BASE_URL = "https://app.openworklabs.com";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:4096";
const FORCE_DESKTOP_REQUIRE_SIGNIN = envFlagEnabled("OPENWORK_FORCE_SIGNIN");
const DEFAULT_DESKTOP_REQUIRE_SIGNIN = FORCE_DESKTOP_REQUIRE_SIGNIN;

function envFlagEnabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

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

const browserPanel = createBrowserPanel({
  remoteDebugPort,
  getWindow: () => mainWindow,
});

const workspaceStore = createWorkspaceStore({
  app,
  defaultDenBaseUrl: DEFAULT_DEN_BASE_URL,
  defaultRequireSignin: DEFAULT_DESKTOP_REQUIRE_SIGNIN,
  forceRequireSignin: FORCE_DESKTOP_REQUIRE_SIGNIN,
});

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
});

let runtimeDisposedForQuit = false;
let runtimeDisposeInProgress = false;
let runtimeBootstrapPromise = null;

function showShutdownScreen() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    win.show();
    win.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
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
</html>`)}`);
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
  "orchestratorStatus": async (event, ...args) => {
      return runtimeManager.orchestratorStatus();
  },
  "orchestratorWorkspaceActivate": async (event, ...args) => {
      return runtimeManager.orchestratorWorkspaceActivate(args[0] ?? {});
  },
  "orchestratorInstanceDispose": async (event, ...args) => {
      return runtimeManager.orchestratorInstanceDispose(String(args[0] ?? "").trim());
  },
  "appBuildInfo": async (event, ...args) => {
      return {
        version: app.getVersion(),
        gitSha: process.env.OPENWORK_GIT_SHA ?? null,
        buildEpoch: process.env.OPENWORK_BUILD_EPOCH ?? null,
        openworkDevMode: process.env.OPENWORK_DEV_MODE === "1",
      };
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
      // Spawn --check → fresh TCC read → always accurate.
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
  "setDesktopBootstrapConfig": async (event, ...args) => {
      return workspaceStore.setDesktopBootstrapConfig(args[0] ?? {});
  },
  "nukeOpenworkAndOpencodeConfigAndExit": async (event, ...args) => {
      await rm(app.getPath("userData"), { recursive: true, force: true });
      app.exit(0);
      return undefined;
  },
  "orchestratorStartDetached": async (event, ...args) => {
      return runtimeManager.orchestratorStartDetached(args[0] ?? {});
  },
  "sandboxDoctor": async (event, ...args) => {
      return runtimeManager.sandboxDoctor();
  },
  "sandboxStop": async (event, ...args) => {
      return runtimeManager.sandboxStop(String(args[0] ?? "").trim());
  },
  "sandboxCleanupOpenworkContainers": async (event, ...args) => {
      return runtimeManager.sandboxCleanupOpenworkContainers();
  },
  "sandboxDebugProbe": async (event, ...args) => {
      return runtimeManager.sandboxDebugProbe();
  },
  "openworkServerInfo": async (event, ...args) => {
      return runtimeManager.openworkServerInfo();
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
      if (!target) return undefined;
      shell.showItemInFolder(target);
      return undefined;
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

async function handleDesktopInvoke(event, command, ...args) {
  const handler = desktopCommandHandlers[command];
  if (!handler) {
    throw new Error(`Electron desktop bridge method is not implemented yet: ${command}`);
  }
  return handler(event, ...args);
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
  applicationMenu.applyVisibility(mainWindow);

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
    browserPanel.destroy();
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("file://")) {
      try {
        void shell.openPath(fileURLToPath(url));
      } catch {
        void shell.openExternal(url);
      }

      return { action: "deny" };
    }

    const local =
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://localhost");
    if (!local) {
      void shell.openExternal(url);
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

registerMigrationIpc({ app, ipcMain });
const { ensureAutoUpdater } = registerUpdaterIpc({ app, ipcMain, getMainWindow: () => mainWindow });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("before-quit", (event) => {
    if (runtimeDisposedForQuit) return;
    event.preventDefault();
    if (runtimeDisposeInProgress) return;
    showShutdownScreen();
    void Promise.all([disposeRuntimeBeforeQuit(), uiControlServer.stop()]).finally(() => app.quit());
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
    installMediaPermissionHandlers(session, () => mainWindow);
    applicationMenu.install();
    await runtimeManager.prepareFreshRuntime().catch(() => undefined);

    // Use Tauri's existing workspace state file as canonical so rollback and
    // Electron see the same workspace list. Import the short-lived
    // Electron-only filename only when the shared file is missing.
    await workspaceStore.migrateLegacyElectronWorkspaceStateIfNeeded();
    await uiControlServer.start().catch((error) => {
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
