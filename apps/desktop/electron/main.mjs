import { createHash } from "node:crypto";
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import { registerMigrationIpc } from "./migration.mjs";
import { createRuntimeManager } from "./runtime.mjs";
import { registerUpdaterIpc } from "./updater.mjs";
import { exportWorkspaceConfig, importWorkspaceConfig } from "./workspace-archive.mjs";
import * as openshellClient from "./openshell/client.mjs";
import * as openshellCli from "./openshell/cli.mjs";
import * as openeral from "./openshell/openeral.mjs";
import * as openeralCredentials from "./openshell/openeral-credentials.mjs";
import * as openeralPty from "./openshell/openeral-pty.mjs";
import {
  deriveOpenEralSandboxName,
  launchExternalTerminalToSandbox,
} from "./openshell/openeral-terminal.mjs";
import { openshellDoctor } from "./openshell/doctor.mjs";
import {
  installOpenShellStack,
  loadInstallerState as loadOpenShellInstallerState,
} from "./openshell/installer.mjs";
import { DISTRO_NAME as OPENSHELL_DISTRO_NAME, distroExists, wslRun } from "./openshell/wsl.mjs";

// Preflight gate for every OpenEral entry point. If the WSL distro
// isn't registered, the very first `wsl -d openwork-openshell -- docker
// pull ...` call fails with a raw WSL_E_DISTRO_NOT_FOUND error. We
// surface a phrase the renderer's BootstrapErrorCard recognises so the
// user sees the "Open Settings → Sandbox" CTA instead of a stack trace.
async function assertOpenShellReady() {
  let exists;
  try {
    exists = await distroExists();
  } catch (err) {
    // wsl.exe missing entirely (non-Windows host or WSL not installed)
    // surfaces here. Treat as not-ready.
    throw new Error(
      `OpenShell is not ready: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!exists) {
    throw new Error(
      `OpenShell is not ready: WSL distro "${OPENSHELL_DISTRO_NAME}" is not registered. ` +
        "Open Settings → Sandbox and run the installer.",
    );
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_DEEP_LINK_EVENT = "openwork:deep-link-native";
const TAURI_APP_IDENTIFIER = "com.differentai.openwork";
const DESKTOP_PROTOCOL_SCHEME = "openwork";

// Share the same on-disk state folder as the Tauri shell so in-place
// migration is a no-op for almost every file. Done BEFORE whenReady so all
// app.getPath("userData") callers see the unified path.
//
// Override via OPENWORK_ELECTRON_USERDATA so dogfooders can isolate their
// Electron install from the real Tauri app.
app.setName("OpenWork");
if (app.isPackaged) {
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL_SCHEME);
}
const userDataOverride = process.env.OPENWORK_ELECTRON_USERDATA?.trim();
if (userDataOverride) {
  app.setPath("userData", userDataOverride);
} else {
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), TAURI_APP_IDENTIFIER),
  );
}

// Resolve and cache the app icon (reused for BrowserWindow + mac dock).
// Packaged builds ship icons via electron-builder config, but for `dev:electron`
// the Electron default icon is shown without this.
function resolveAppIconPath() {
  const candidates = [
    // Dev: repo-relative path to the Electron resource icon set.
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

const APP_ICON_PATH = resolveAppIconPath();
const APP_ICON_IMAGE = APP_ICON_PATH ? nativeImage.createFromPath(APP_ICON_PATH) : null;

if (process.platform === "darwin" && APP_ICON_IMAGE && !APP_ICON_IMAGE.isEmpty() && app.dock) {
  app.dock.setIcon(APP_ICON_IMAGE);
}

// Optional: expose Chrome DevTools Protocol so external tools (chrome-devtools
// MCP, raw CDP clients, etc.) can attach to this Electron instance.
// Enable by setting OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=<port> before launch.
const remoteDebugPort = Number.parseInt(
  process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() ?? "",
  10,
);
if (Number.isFinite(remoteDebugPort) && remoteDebugPort > 0) {
  app.commandLine.appendSwitch("remote-debugging-port", String(remoteDebugPort));
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}
const DEFAULT_DEN_BASE_URL = "https://app.openworklabs.com";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:4096";

function envFlagDisabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off";
}

async function installReactDevToolsForDev() {
  if (app.isPackaged || envFlagDisabled("OPENWORK_REACT_DEVTOOLS")) return;
  try {
    const mod = await import("electron-devtools-installer");
    const installExtension =
      typeof mod.installExtension === "function"
        ? mod.installExtension
        : typeof mod.default === "function"
          ? mod.default
          : typeof mod.default?.installExtension === "function"
            ? mod.default.installExtension
            : null;
    const reactDevtools = mod.REACT_DEVELOPER_TOOLS ?? mod.default?.REACT_DEVELOPER_TOOLS;
    if (typeof installExtension !== "function" || !reactDevtools) {
      throw new Error("electron-devtools-installer did not expose React DevTools");
    }
    const name = await installExtension(reactDevtools);
    console.info(`[devtools] installed ${name}`);
  } catch (error) {
    console.warn("[devtools] failed to install React Developer Tools", error);
  }
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

// OpenShell installer singleton. Only one install can run at a time; the
// renderer drives it via openshellInstallStart / openshellInstallStatus /
// openshellInstallCancel.
const openshellInstaller = {
  /** @type {Promise<unknown> | null} */ promise: null,
  /** @type {AbortController | null} */ abortController: null,
  /** @type {{ status: string, phase?: string, message?: string, error?: string } | null} */
  lastEvent: null,
  /** Most recent terminal status: "idle" | "running" | "ready" | "reboot_required" | "cancelled" | "failed". */
  status: "idle",
};

function resolveOpenShellRootfsPath() {
  // Bundled by electron-builder as an extraResource (Phase 9 wires this
  // into electron-builder.yml). Allow env override for dev workflows.
  const override = process.env.OPENWORK_OPENSHELL_ROOTFS;
  if (override) return override;
  const base = process.resourcesPath || path.join(__dirname, "..", "resources");
  return path.join(base, "openshell", "ubuntu-24.04-openshell.tar.gz");
}

function resolveOpenShellPoliciesDir() {
  // In production the policies are mapped to process.resourcesPath/openshell-policies
  // by electron-builder.yml (Phase 9). In dev we fall back to the
  // source directory so devs see the policies they're editing.
  const override = process.env.OPENWORK_OPENSHELL_POLICIES_DIR;
  if (override) return override;
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, "openshell-policies");
    if (existsSync(packaged)) return packaged;
  }
  return path.join(__dirname, "..", "..", "orchestrator", "policies");
}

function emitOpenShellInstallProgress(payload) {
  openshellInstaller.lastEvent = payload;
  try {
    mainWindow?.webContents.send("openshell:install-progress", payload);
  } catch {
    // Window may have closed mid-install; the next status query still works.
  }
}

function emitOpenEralSessionProgress(payload) {
  try {
    mainWindow?.webContents.send("openeral:session-progress", payload);
  } catch {
    // Window may have closed; renderer's next status query still works.
  }
}

function emitOpenEralPtyData(sessionId, data) {
  try {
    mainWindow?.webContents.send("openeral:pty-data", { sessionId, data });
  } catch {
    // Window may have closed mid-stream. The renderer's next PTY open
    // reattaches handlers (attachHandlers) so a brief disconnect is fine.
  }
}

function emitOpenEralPtyExit(sessionId, exitCode, signal) {
  try {
    mainWindow?.webContents.send("openeral:pty-exit", { sessionId, exitCode, signal });
  } catch {
    // ignore
  }
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
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
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
    requireSignin: input?.requireSignin === true,
  };
}

async function getDesktopBootstrapConfig() {
  try {
    const raw = await readFile(desktopBootstrapPath(), "utf8");
    return normalizeDesktopBootstrapConfig(JSON.parse(raw));
  } catch {
    return {
      baseUrl: DEFAULT_DEN_BASE_URL,
      apiBaseUrl: null,
      requireSignin: false,
    };
  }
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

function openworkRemoteWorkspaceId(hostUrl, workspaceId) {
  const key = String(workspaceId ?? "").trim()
    ? `openwork::${hostUrl}::${String(workspaceId).trim()}`
    : `openwork::${hostUrl}`;
  return stableWorkspaceId(key);
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
  return {
    selectedId:
      typeof state?.selectedId === "string"
        ? state.selectedId
        : typeof state?.selectedWorkspaceId === "string"
          ? state.selectedWorkspaceId
          : typeof state?.activeId === "string"
            ? state.activeId
            : "",
    watchedId:
      typeof state?.watchedId === "string"
        ? state.watchedId
        : typeof state?.watchedWorkspaceId === "string"
          ? state.watchedWorkspaceId
          : null,
    activeId: typeof state?.activeId === "string" ? state.activeId : null,
    workspaces: Array.isArray(state?.workspaces) ? state.workspaces : [],
  };
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
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
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
      const openworkHostUrl = typeof input.openworkHostUrl === "string" && input.openworkHostUrl.trim()
        ? input.openworkHostUrl.trim()
        : null;
      const openworkWorkspaceId = typeof input.openworkWorkspaceId === "string" && input.openworkWorkspaceId.trim()
        ? input.openworkWorkspaceId.trim()
        : null;
      const id = remoteType === "openwork"
        ? openworkRemoteWorkspaceId(openworkHostUrl ?? baseUrl, openworkWorkspaceId)
        : remoteWorkspaceId(baseUrl, directory);
      const workspace = normalizeWorkspaceEntry({
        id,
        name: String(input.displayName ?? input.openworkWorkspaceName ?? "Remote workspace"),
        displayName: input.displayName ?? null,
        path: directory ?? "",
        preset: "remote",
        workspaceType: "remote",
        remoteType,
        baseUrl,
        directory,
        openworkHostUrl,
        openworkToken: input.openworkToken ?? null,
        openworkClientToken: input.openworkClientToken ?? null,
        openworkHostToken: input.openworkHostToken ?? null,
        openworkWorkspaceId,
        openworkWorkspaceName: input.openworkWorkspaceName ?? null,
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
      return mutateWorkspaceState((state) => {
        state.workspaces = state.workspaces.map((entry) =>
          entry.id === workspaceId ? { ...entry, ...input } : entry,
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
    case "getDesktopBootstrapConfig":
      return getDesktopBootstrapConfig();
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
      const response = await fetch(url, {
        method: typeof init.method === "string" ? init.method : undefined,
        headers: init.headers && typeof init.headers === "object" ? init.headers : undefined,
        body: typeof init.body === "string" ? init.body : undefined,
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
    case "openshellDoctor":
      return openshellDoctor();
    case "openshellListSandboxes":
      return openshellClient.listSandboxes();
    case "openshellGatewayStatus":
      return openshellClient.getGatewayStatus();
    case "openshellGatewayRestart": {
      // The gateway lifecycle has rotated across releases — see
      // installer.mjs:bringUpGateway for the full story. Order of attempts:
      //   1. Legacy `openshell gateway start [--recreate|--detach]`.
      //   2. systemd user service restart (0.0.37+, the current shape).
      //   3. Direct `docker restart` of an openshell-cluster* container
      //      (recovery path for hand-rolled deployments).
      // Each attempt is logged with its exit code so the final error
      // message tells the user exactly what was tried and what each
      // path reported.
      const cliInfo = await openshellCli.getCliInfo();
      const attempts = [];
      const tryWsl = async (label, args, opts = {}) => {
        const r = await wslRun(
          ["-d", OPENSHELL_DISTRO_NAME, ...(opts.user ? ["--user", opts.user] : []), "--", ...args],
          { timeout: opts.timeout ?? 60_000 },
        );
        attempts.push({ label, r });
        return r.exitCode === 0;
      };

      // Path 1 — legacy gateway start verb (will silently no-op on 0.0.37+).
      if (await openshellCli.hasSubcommand("gateway", "start")) {
        if (await tryWsl("openshell gateway start --recreate", ["openshell", "gateway", "start", "--recreate"])) return { ok: true, recoveredVia: "gateway start --recreate" };
        if (await tryWsl("openshell gateway start --detach", ["openshell", "gateway", "start", "--detach"])) return { ok: true, recoveredVia: "gateway start --detach" };
        if (await tryWsl("openshell gateway start", ["openshell", "gateway", "start"])) return { ok: true, recoveredVia: "gateway start" };
      }

      // Path 2 — systemd user service (the current shape per install.sh).
      if (await tryWsl(
        "systemctl --user restart openshell-gateway",
        ["systemctl", "--user", "restart", "openshell-gateway"],
        { user: "banker", timeout: 60_000 },
      )) {
        return { ok: true, recoveredVia: "systemctl --user restart openshell-gateway" };
      }

      // Path 3 — docker fallback for hand-rolled cluster containers.
      const list = await wslRun(
        [
          "-d",
          OPENSHELL_DISTRO_NAME,
          "--",
          "bash",
          "-c",
          "docker ps -a --filter 'name=openshell' --format '{{.Names}}'",
        ],
        { timeout: 15_000 },
      ).catch((err) => ({ exitCode: -1, stdout: "", stderr: err?.message ?? String(err) }));

      const names = list.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length === 1) {
        if (await tryWsl(`docker restart ${names[0]}`, ["docker", "restart", names[0]])) {
          return { ok: true, recoveredVia: `docker restart ${names[0]}` };
        }
      }

      const detail = attempts
        .map(({ label, r }) => `${label} → exit ${r.exitCode}: ${(r.stderr || r.stdout || "").trim().slice(0, 200) || "(no output)"}`)
        .join(" | ");
      throw new Error(
        `Could not restart the OpenShell gateway. CLI ${cliInfo.version ?? "(unknown)"}. ` +
          `Tried: ${detail || "(no attempts)"}. ` +
          `If this persists, open Settings → Sandbox → Reset distro.`,
      );
    }
    case "openshellListPolicies": {
      // Lists the bundled policy YAML files. Returns just filenames for
      // now; the UI doesn't need richer metadata yet, and the YAML
      // schema validation happens inside the openshell binary at
      // sandbox-create time.
      const dir = resolveOpenShellPoliciesDir();
      try {
        const entries = await readdir(dir);
        return entries
          .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
          .sort();
      } catch {
        return [];
      }
    }
    case "openshellOpenPoliciesFolder": {
      const dir = resolveOpenShellPoliciesDir();
      try {
        const err = await shell.openPath(dir);
        if (err) throw new Error(err);
        return { ok: true, path: dir };
      } catch (err) {
        throw new Error(
          `Could not open policy folder at ${dir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    case "openshellInstallStart": {
      if (openshellInstaller.promise) {
        return { status: "running", lastEvent: openshellInstaller.lastEvent };
      }
      // UAC heads-up: only meaningful on Windows and only when WSL is not
      // already installed (= first run). Phase 6's installer detects that
      // case itself and elevates inline; this dialog gives the banker a
      // clear "you'll see a UAC prompt" warning before it fires.
      if (process.platform === "win32") {
        await dialog.showMessageBox(activeWindowFromEvent(event), {
          type: "info",
          title: "OpenShell setup",
          message: "OpenShell installs WSL2, Ubuntu, Docker, and the OpenShell CLI.",
          detail:
            "Windows will ask for admin permission once. Your laptop may also ask for a " +
            "BitLocker recovery key after the first reboot — get this from IT before " +
            "continuing if you do not have it.",
          buttons: ["Continue", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });
      }
      const ac = new AbortController();
      openshellInstaller.abortController = ac;
      openshellInstaller.status = "running";
      openshellInstaller.lastEvent = { phase: "preflight", status: "starting" };
      openshellInstaller.promise = installOpenShellStack({
        rootfsPath: resolveOpenShellRootfsPath(),
        signal: ac.signal,
        onPhase: (phase, status, err) =>
          emitOpenShellInstallProgress({
            phase,
            status,
            message: err?.message ?? null,
          }),
        onProgress: (evt) => emitOpenShellInstallProgress(evt),
      })
        .then((result) => {
          openshellInstaller.status = result.status;
          emitOpenShellInstallProgress({
            phase: "done",
            status: result.status,
          });
          return result;
        })
        .catch((err) => {
          openshellInstaller.status = "failed";
          emitOpenShellInstallProgress({
            phase: "error",
            status: "failed",
            error: err?.message ?? String(err),
          });
        })
        .finally(() => {
          openshellInstaller.promise = null;
          openshellInstaller.abortController = null;
        });
      return { status: "running" };
    }
    case "openshellInstallStatus": {
      const persisted = await loadOpenShellInstallerState();
      return {
        status: openshellInstaller.status,
        lastEvent: openshellInstaller.lastEvent,
        state: persisted,
      };
    }
    case "openshellInstallCancel": {
      if (!openshellInstaller.promise) {
        return { status: openshellInstaller.status };
      }
      openshellInstaller.abortController?.abort();
      return { status: "cancelling" };
    }
    case "openeralCredentialStatus":
      return openeralCredentials.getCredentialStatus();
    case "openeralSetCredential": {
      const input = args[0] ?? {};
      const key = String(input.key ?? "").trim();
      const value = String(input.value ?? "");
      await openeralCredentials.setCredential(key, value);
      return openeralCredentials.getCredentialStatus();
    }
    case "openeralClearCredential": {
      const key = String(args[0] ?? "").trim();
      await openeralCredentials.clearCredential(key);
      return openeralCredentials.getCredentialStatus();
    }
    case "openeralTestDatabase": {
      // Runs psql via a transient postgres:16-alpine container inside
      // the openwork-openshell distro. Lazy-pulls the image on first
      // run (~6 MB). Returns reachable=true on a successful SELECT 1,
      // throws with the stderr otherwise so the UI can surface why.
      await assertOpenShellReady();
      return openeral.probeDatabaseUrl();
    }
    case "openeralStartSession": {
      // Per spec O3+O4 contract:
      //   1. Derive sandbox name from workspaceId (stable across machines).
      //   2. createOpenEralSandbox: create or short-circuit if it exists,
      //      streams pull + create progress via openeral:session-progress.
      //   3. Launch the OS terminal pointed at `openshell sandbox connect <name>`.
      //   4. Return {sandboxName, profile, existed, terminal} to the renderer.
      const input = args[0] ?? {};
      const workspaceId = String(input.workspaceId ?? "").trim();
      const profile = String(input.profile ?? "").trim();
      if (!workspaceId) throw new Error("workspaceId is required");
      if (profile !== "openeral-claude" && profile !== "openeral-openclaw") {
        throw new Error(`Unsupported OpenEral profile: ${profile}`);
      }
      await assertOpenShellReady();
      const sandboxName = deriveOpenEralSandboxName(workspaceId);
      emitOpenEralSessionProgress({
        sandboxName,
        phase: "starting",
        message: "Preparing OpenEral sandbox...",
      });
      const result = await openeral.createOpenEralSandbox({
        name: sandboxName,
        profile,
        onProgress: (evt) =>
          emitOpenEralSessionProgress({
            sandboxName,
            phase: evt.phase,
            message: evt.message,
          }),
      });
      emitOpenEralSessionProgress({
        sandboxName,
        phase: "launching-terminal",
        message: "Opening session in external terminal...",
      });
      let terminal;
      try {
        terminal = await launchExternalTerminalToSandbox(sandboxName);
      } catch (err) {
        // Sandbox is up but we couldn't open a terminal. Don't fail the
        // whole session — surface the issue so the user can launch
        // their own terminal with the documented command.
        emitOpenEralSessionProgress({
          sandboxName,
          phase: "terminal-error",
          message: err instanceof Error ? err.message : String(err),
        });
        return {
          ...result,
          sandboxName,
          terminal: null,
          terminalError: err instanceof Error ? err.message : String(err),
        };
      }
      emitOpenEralSessionProgress({
        sandboxName,
        phase: "ready",
        message: `Session running in ${terminal.launched}.`,
      });
      return { ...result, sandboxName, terminal };
    }
    case "openeralListSessions": {
      // Returns the subset of `openshell sandbox list` whose names start
      // with the openeral- prefix — sandboxes OpenWork has created.
      const list = await openshellClient.listSandboxes().catch(() => []);
      const filtered = Array.isArray(list)
        ? list.filter((s) => {
            const name = typeof s === "string" ? s : s?.name;
            return typeof name === "string" && name.startsWith("openeral-");
          })
        : [];
      return filtered;
    }
    case "openeralEndSession": {
      // Per spec: OpenEral sandboxes persist across sessions for the
      // Postgres-backed restore story. "End session" is a no-op marker;
      // closing the external terminal is what ends user interaction.
      // We still emit a status event so the UI can update.
      const name = String(args[0] ?? "").trim();
      emitOpenEralSessionProgress({ sandboxName: name, phase: "closed", message: "Session closed." });
      return { status: "closed", sandboxName: name };
    }
    case "openeralDeleteSandbox": {
      // Explicit destructive teardown. Gated by a renderer-side
      // confirmation in Phase O8 docs; here we just execute.
      const name = String(args[0] ?? "").trim();
      if (!name) throw new Error("sandboxName is required");
      const r = await openeral.deleteOpenEralSandbox(name);
      if (r.exitCode !== 0) {
        throw new Error(
          `openshell sandbox delete failed: ${(r.stderr || r.stdout).trim()}`,
        );
      }
      emitOpenEralSessionProgress({ sandboxName: name, phase: "deleted", message: "Sandbox deleted." });
      return { status: "deleted", sandboxName: name };
    }
    case "openeralDeriveSandboxName": {
      const workspaceId = String(args[0] ?? "").trim();
      return deriveOpenEralSandboxName(workspaceId);
    }
    case "openeralPtyOpen": {
      // Renderer xterm.js requests a PTY to an existing sandbox. We
      // spawn `wsl -d openwork-openshell -- openshell sandbox connect <name>`
      // inside a real PTY (node-pty) and forward stdout bytes via the
      // openeral:pty-data event channel.
      const input = args[0] ?? {};
      const sandboxName = String(input.sandboxName ?? "").trim();
      if (!sandboxName) throw new Error("sandboxName is required");
      const cols = Number.isFinite(input.cols) ? input.cols : undefined;
      const rows = Number.isFinite(input.rows) ? input.rows : undefined;
      const result = await openeralPty.openSession({
        sandboxName,
        cols,
        rows,
        onData: (data) => emitOpenEralPtyData(result.id, data),
        onExit: (exitCode, signal) => emitOpenEralPtyExit(result.id, exitCode, signal),
      });
      return result;
    }
    case "openeralPtyWrite": {
      const input = args[0] ?? {};
      const id = String(input.sessionId ?? "").trim();
      const data = String(input.data ?? "");
      if (!id) throw new Error("sessionId is required");
      return openeralPty.writeSession(id, data);
    }
    case "openeralPtyResize": {
      const input = args[0] ?? {};
      const id = String(input.sessionId ?? "").trim();
      if (!id) throw new Error("sessionId is required");
      return openeralPty.resizeSession(id, Number(input.cols), Number(input.rows));
    }
    case "openeralPtyClose": {
      const id = String(args[0] ?? "").trim();
      if (!id) throw new Error("sessionId is required");
      return openeralPty.closeSession(id);
    }
    case "openeralPtyList":
      return openeralPty.listSessions();
    case "openeralEnsureSandbox": {
      // Same as openeralStartSession but WITHOUT launching an external
      // terminal — the renderer's xterm.js component connects via the
      // PTY IPC handlers instead. Returns {sandboxName, existed, profile}.
      const input = args[0] ?? {};
      const workspaceId = String(input.workspaceId ?? "").trim();
      const profile = String(input.profile ?? "").trim();
      if (!workspaceId) throw new Error("workspaceId is required");
      if (profile !== "openeral-claude" && profile !== "openeral-openclaw") {
        throw new Error(`Unsupported OpenEral profile: ${profile}`);
      }
      await assertOpenShellReady();
      const sandboxName = deriveOpenEralSandboxName(workspaceId);
      emitOpenEralSessionProgress({
        sandboxName,
        phase: "ensuring",
        message: "Ensuring OpenEral sandbox is up...",
      });
      const result = await openeral.createOpenEralSandbox({
        name: sandboxName,
        profile,
        onProgress: (evt) =>
          emitOpenEralSessionProgress({
            sandboxName,
            phase: evt.phase,
            message: evt.message,
          }),
      });
      emitOpenEralSessionProgress({
        sandboxName,
        phase: "ready",
        message: result.existed
          ? `Reconnecting to ${sandboxName}.`
          : `Sandbox ${sandboxName} ready.`,
      });
      return { ...result, sandboxName };
    }
    case "openeralPopOutTerminal": {
      // Renderer's "Pop out to external terminal" button. Opens a
      // second connection to the same sandbox in a new OS terminal
      // window — additive to the in-app xterm.js, not a replacement.
      const sandboxName = String(args[0] ?? "").trim();
      if (!sandboxName) throw new Error("sandboxName is required");
      try {
        const terminal = await launchExternalTerminalToSandbox(sandboxName);
        return terminal;
      } catch (err) {
        throw new Error(
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    case "openshellResetDistro": {
      // Per spec §5 row "Distro corrupts (rare but happens)". Tear the
      // distro down completely so the installer can re-import from the
      // bundled rootfs on next launch. Destructive — gate behind an
      // explicit confirmation dialog.
      const choice = await dialog.showMessageBox(activeWindowFromEvent(event), {
        type: "warning",
        title: "Reset OpenShell distro?",
        message: "This wipes the openwork-openshell WSL distro and clears installer state.",
        detail:
          "Any data inside the distro (Docker images, OpenShell sandboxes, downloaded packages) " +
          "is lost. Your OpenWork workspaces on the Windows side are untouched. " +
          "The next launch will re-run the setup wizard from scratch.",
        buttons: ["Reset distro", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (choice.response !== 0) {
        return { status: "cancelled" };
      }
      // Terminate then unregister. --terminate is required first because
      // --unregister refuses to act on a running distro.
      try {
        await wslRun(["-t", OPENSHELL_DISTRO_NAME], { timeout: 15_000 });
      } catch {
        // Distro may already be stopped.
      }
      try {
        await wslRun(["--unregister", OPENSHELL_DISTRO_NAME], { timeout: 30_000 });
      } catch (err) {
        throw new Error(
          `Could not unregister distro: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Wipe installer state so the next run re-executes every phase.
      const stateFile = path.join(os.homedir(), ".openwork", "openshell-install.json");
      try {
        await rm(stateFile, { force: true });
      } catch {
        // Best-effort.
      }
      return { status: "reset", path: stateFile };
    }
    default:
      throw new Error(`Electron desktop bridge method is not implemented yet: ${command}`);
  }
}

async function createMainWindow() {
  if (mainWindow) return mainWindow;

  const preloadPath = path.join(__dirname, "preload.mjs");
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    title: "OpenWork",
    show: false,
    ...(APP_ICON_IMAGE && !APP_ICON_IMAGE.isEmpty() ? { icon: APP_ICON_IMAGE } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    flushPendingDeepLinks();
  });

  mainWindow.on("closed", () => {
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

registerMigrationIpc({ app, ipcMain });
const { ensureAutoUpdater } = registerUpdaterIpc({ app, ipcMain, getMainWindow: () => mainWindow });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("before-quit", (event) => {
    if (runtimeDisposedForQuit) return;
    event.preventDefault();
    void disposeRuntimeBeforeQuit().finally(() => app.quit());
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
    await installReactDevToolsForDev();
    await runtimeManager.prepareFreshRuntime().catch(() => undefined);

    // Use Tauri's existing workspace state file as canonical so rollback and
    // Electron see the same workspace list. Import the short-lived
    // Electron-only filename only when the shared file is missing.
    await migrateLegacyElectronWorkspaceStateIfNeeded();
    runtimeBootstrapPromise = bootRuntimeForSelectedWorkspace().catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));

    queueDeepLinks(forwardedDeepLinks(process.argv));
    const win = await createMainWindow();
    win.webContents.on("did-finish-load", () => {
      flushPendingDeepLinks();
    });

    // Kick the packaged-only updater after the window is up so the user
    // sees a working app first. This is a no-op in dev.
    void ensureAutoUpdater().then((updater) => {
      if (!updater) return;
      void updater.checkForUpdates().catch(() => undefined);
    });
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
