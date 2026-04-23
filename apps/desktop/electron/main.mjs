import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
// electron-updater is dynamically imported later because it pulls in a
// larger dep graph and we only want it loaded in packaged builds.
import { createRuntimeManager } from "./runtime.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_DEEP_LINK_EVENT = "openwork:deep-link-native";
const TAURI_APP_IDENTIFIER = "com.differentai.openwork";
const MIGRATION_SNAPSHOT_FILENAME = "migration-snapshot.v1.json";
const MIGRATION_SNAPSHOT_DONE_FILENAME = "migration-snapshot.v1.done.json";

// Share the same on-disk state folder as the Tauri shell so in-place
// migration is a no-op for almost every file. Done BEFORE whenReady so all
// app.getPath("userData") callers see the unified path.
//
// Override via OPENWORK_ELECTRON_USERDATA so dogfooders can isolate their
// Electron install from the real Tauri app.
app.setName("OpenWork");
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
    // Dev: repo-relative path to the existing Tauri icon set.
    path.resolve(__dirname, "../src-tauri/icons/icon.png"),
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

const EMPTY_WORKSPACE_LIST = Object.freeze({
  selectedId: "",
  watchedId: null,
  activeId: null,
  workspaces: [],
});

const IDLE_ENGINE_INFO = Object.freeze({
  running: false,
  runtime: "openwork-orchestrator",
  baseUrl: null,
  projectDir: null,
  hostname: null,
  port: null,
  opencodeUsername: null,
  opencodePassword: null,
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
  return path.join(app.getPath("userData"), "desktop-bootstrap.json");
}

function workspaceStatePath() {
  return path.join(app.getPath("userData"), "workspace-state.json");
}

// Tauri shell writes the same data to openwork-workspaces.json. Electron
// reads the legacy filename on first launch when the Electron-native file
// isn't present yet, then writes to the Electron filename going forward.
function legacyTauriWorkspaceStatePath() {
  return path.join(app.getPath("userData"), "openwork-workspaces.json");
}

async function migrateLegacyWorkspaceStateIfNeeded() {
  const current = workspaceStatePath();
  const legacy = legacyTauriWorkspaceStatePath();
  try {
    if (existsSync(current)) return false;
    if (!existsSync(legacy)) return false;
    await mkdir(path.dirname(current), { recursive: true });
    const raw = await readFile(legacy, "utf8");
    // Write to the Electron name without deleting the legacy file for a few
    // releases so a rollback to Tauri (same bundle id) still finds data.
    await writeFile(current, raw, "utf8");
    console.info(
      "[migration] copied openwork-workspaces.json → workspace-state.json",
    );
    return true;
  } catch (error) {
    console.warn("[migration] legacy workspace-state copy failed", error);
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

function defaultWorkspaceOpenworkConfig(workspacePath) {
  return {
    version: 1,
    workspace: null,
    authorizedRoots: workspacePath ? [workspacePath] : [],
    reload: null,
  };
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
    selectedId: typeof state?.selectedId === "string" ? state.selectedId : "",
    watchedId: typeof state?.watchedId === "string" ? state.watchedId : null,
    activeId: typeof state?.activeId === "string" ? state.activeId : null,
    workspaces: Array.isArray(state?.workspaces) ? state.workspaces : [],
  };
}

async function writeWorkspaceState(nextState) {
  const outputPath = workspaceStatePath();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
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

function makeWorkspaceId(kind, value) {
  return `${kind}_${createHash("sha1").update(String(value)).digest("hex").slice(0, 12)}`;
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

function resolveProgramInPath(name) {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = process.platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = path.join(entry, candidate);
      if (existsSync(fullPath)) return fullPath;
    }
  }
  return null;
}

function runProgram(program, args) {
  return spawnSync(program, args, { encoding: "utf8" });
}

function engineDoctor(options = {}) {
  const explicitPath = typeof options?.opencodeBinPath === "string" ? options.opencodeBinPath.trim() : "";
  const resolvedPath = explicitPath || resolveProgramInPath("opencode");
  const notes = [];

  if (!resolvedPath) {
    return {
      found: false,
      inPath: false,
      resolvedPath: null,
      version: null,
      supportsServe: false,
      notes: ["OpenCode binary not found on PATH."],
      serveHelpStatus: null,
      serveHelpStdout: null,
      serveHelpStderr: null,
    };
  }

  const versionResult = runProgram(resolvedPath, ["--version"]);
  const helpResult = runProgram(resolvedPath, ["serve", "--help"]);
  if (versionResult.status !== 0) {
    notes.push("OpenCode version probe failed.");
  }
  if (helpResult.status !== 0) {
    notes.push("OpenCode serve --help probe failed.");
  }

  return {
    found: true,
    inPath: !explicitPath,
    resolvedPath,
    version: versionResult.stdout?.trim() || versionResult.stderr?.trim() || null,
    supportsServe: helpResult.status === 0,
    notes,
    serveHelpStatus: typeof helpResult.status === "number" ? helpResult.status : null,
    serveHelpStdout: helpResult.stdout?.trim() || null,
    serveHelpStderr: helpResult.stderr?.trim() || null,
  };
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
      const folderPath = String(input.folderPath ?? "").trim();
      if (!folderPath) throw new Error("folderPath is required");
      const workspace = normalizeWorkspaceEntry({
        id: makeWorkspaceId("local", folderPath),
        name: String(input.name ?? (path.basename(folderPath) || "Workspace")),
        displayName: String(input.name ?? (path.basename(folderPath) || "Workspace")),
        path: folderPath,
        preset: String(input.preset ?? "starter"),
        workspaceType: "local",
      });
      await mkdir(path.join(folderPath, ".opencode"), { recursive: true });
      await writeWorkspaceOpenworkConfig(folderPath, defaultWorkspaceOpenworkConfig(folderPath));
      return mutateWorkspaceState((state) => {
        state.workspaces = state.workspaces.filter((entry) => entry.id !== workspace.id);
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
      const workspace = normalizeWorkspaceEntry({
        id: makeWorkspaceId("remote", `${baseUrl}:${input.directory ?? ""}`),
        name: String(input.displayName ?? input.openworkWorkspaceName ?? "Remote workspace"),
        displayName: input.displayName ?? null,
        path: String(input.directory ?? baseUrl),
        preset: "remote",
        workspaceType: "remote",
        remoteType: input.remoteType ?? "openwork",
        baseUrl,
        directory: input.directory ?? null,
        openworkHostUrl: input.openworkHostUrl ?? null,
        openworkToken: input.openworkToken ?? null,
        openworkClientToken: input.openworkClientToken ?? null,
        openworkHostToken: input.openworkHostToken ?? null,
        openworkWorkspaceId: input.openworkWorkspaceId ?? null,
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
      const authorizedRoot = String(input.authorizedRoot ?? "").trim();
      if (!workspacePath || !authorizedRoot) {
        throw new Error("workspacePath and authorizedRoot are required");
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
      const result = await dialog.showOpenDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        properties: ["openDirectory", ...(options.multiple ? ["multiSelections"] : [])],
      });
      if (result.canceled) return null;
      return options.multiple ? result.filePaths : (result.filePaths[0] ?? null);
    }
    case "pickFile": {
      const options = args[0] ?? {};
      const result = await dialog.showOpenDialog(activeWindowFromEvent(event), {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        properties: ["openFile", ...(options.multiple ? ["multiSelections"] : [])],
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
    case "schedulerListJobs":
      return [];
    case "schedulerDeleteJob":
      return {
        slug: String(args[0] ?? ""),
        name: String(args[0] ?? ""),
        schedule: "",
        createdAt: new Date().toISOString(),
      };
    case "getOpenCodeRouterStatus":
      return (async () => {
        const info = await runtimeManager.opencodeRouterInfo();
        if (!info.running) return null;
        return {
          running: info.running,
          config: "",
          healthPort: info.healthPort,
          telegram: { items: [] },
          slack: { items: [] },
          opencode: {
            url: info.opencodeUrl ?? "",
            directory: info.workspacePath ?? undefined,
          },
        };
      })();
    case "getOpenCodeRouterStatusDetailed":
      return (async () => {
        try {
          const status = await handleDesktopInvoke(event, "getOpenCodeRouterStatus");
          if (!status) {
            return { ok: false, error: "OpenCodeRouter is not running." };
          }
          return { ok: true, status };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })();
    case "opencodeRouterInfo":
      return runtimeManager.opencodeRouterInfo();
    case "getOpenCodeRouterGroupsEnabled":
      return (async () => {
        const info = await runtimeManager.opencodeRouterInfo();
        if (!info.healthPort) return null;
        try {
          const payload = await fetchJson(`http://127.0.0.1:${info.healthPort}/config/groups`, {}, 3000);
          return payload?.groupsEnabled ?? null;
        } catch {
          return null;
        }
      })();
    case "setOpenCodeRouterGroupsEnabled":
      return (async () => {
        const info = await runtimeManager.opencodeRouterInfo();
        if (!info.healthPort) {
          return execResult(false, "", "OpenCodeRouter is not running.");
        }
        try {
          const response = await fetch(`http://127.0.0.1:${info.healthPort}/config/groups`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: Boolean(args[0]) }),
          });
          if (!response.ok) {
            return execResult(false, "", (await response.text()) || `HTTP ${response.status}`);
          }
          return execResult(true, "", "");
        } catch (error) {
          return execResult(false, "", error instanceof Error ? error.message : String(error));
        }
      })();
    case "opencodeMcpAuth":
      return runtimeManager.opencodeMcpAuth(String(args[0] ?? "").trim(), String(args[1] ?? "").trim());
    case "opencodeRouterStop":
      return runtimeManager.opencodeRouterStop();
    case "opencodeRouterStart":
      return runtimeManager.opencodeRouterStart(args[0] ?? {});
    case "opencodeRouterRestart":
      return runtimeManager.opencodeRouterRestart(args[0] ?? {});
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

// Migration snapshot: one-way handoff from the last Tauri release into the
// first Electron launch. The Tauri shell writes migration-snapshot.v1.json
// into app_data_dir before it kicks off the Electron installer. Electron
// renders the workspace list / session-by-workspace preferences from it on
// first boot and then marks it .done so subsequent boots don't re-import.
function migrationSnapshotPath(done = false) {
  return path.join(
    app.getPath("userData"),
    done ? MIGRATION_SNAPSHOT_DONE_FILENAME : MIGRATION_SNAPSHOT_FILENAME,
  );
}

ipcMain.handle("openwork:migration:read", async () => {
  const snapshotPath = migrationSnapshotPath();
  if (!existsSync(snapshotPath)) return null;
  try {
    const raw = await readFile(snapshotPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.version === 1) {
      return parsed;
    }
    return null;
  } catch (error) {
    console.warn("[migration] failed to read snapshot", error);
    return null;
  }
});

ipcMain.handle("openwork:migration:ack", async () => {
  const snapshotPath = migrationSnapshotPath();
  const donePath = migrationSnapshotPath(true);
  if (!existsSync(snapshotPath)) return { ok: true, moved: false };
  try {
    await rename(snapshotPath, donePath);
    return { ok: true, moved: true };
  } catch (error) {
    console.warn("[migration] failed to rename snapshot", error);
    return { ok: false, moved: false };
  }
});

// electron-updater wiring. Packaged-only; dev builds skip this so the
// updater doesn't try to probe a non-existent release channel.
let autoUpdaterInstance = null;
let autoUpdaterLoaded = false;

async function ensureAutoUpdater() {
  if (!app.isPackaged) return null;
  if (autoUpdaterLoaded) return autoUpdaterInstance;
  autoUpdaterLoaded = true;
  try {
    const mod = await import("electron-updater");
    autoUpdaterInstance = mod.autoUpdater ?? mod.default?.autoUpdater ?? null;
    if (autoUpdaterInstance) {
      autoUpdaterInstance.autoDownload = false;
      autoUpdaterInstance.autoInstallOnAppQuit = true;
      autoUpdaterInstance.on("error", (err) => {
        console.warn("[updater] error", err);
      });
    }
  } catch (error) {
    console.warn("[updater] electron-updater not available", error);
    autoUpdaterInstance = null;
  }
  return autoUpdaterInstance;
}

ipcMain.handle("openwork:updater:check", async () => {
  const updater = await ensureAutoUpdater();
  if (!updater) return { available: false, reason: "unavailable" };
  try {
    const result = await updater.checkForUpdates();
    const info = result?.updateInfo ?? null;
    return {
      available: Boolean(info && info.version && info.version !== app.getVersion()),
      currentVersion: app.getVersion(),
      latestVersion: info?.version ?? null,
      releaseDate: info?.releaseDate ?? null,
      releaseNotes: info?.releaseNotes ?? null,
    };
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error) };
  }
});

ipcMain.handle("openwork:updater:download", async () => {
  const updater = await ensureAutoUpdater();
  if (!updater) return { ok: false, reason: "unavailable" };
  try {
    await updater.downloadUpdate();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
});

ipcMain.handle("openwork:updater:installAndRestart", async () => {
  const updater = await ensureAutoUpdater();
  if (!updater) return { ok: false, reason: "unavailable" };
  try {
    updater.quitAndInstall(false, true);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) };
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
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
    // Copy Tauri workspace state on first launch so the Electron sidebar
    // reflects the exact workspace list users see in the Tauri app today.
    await migrateLegacyWorkspaceStateIfNeeded();

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
