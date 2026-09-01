/**
 * Open Coworker desktop shell.
 *
 * A second product client on the OpenWork platform, not a second platform:
 * it embeds the same `openwork-server` bundle the OpenWork desktop embeds
 * (managed OpenCode engine, native sessions, MCP layering, workspace
 * registry) and adds only the Open Coworker layer — filesystem coworkers and
 * a coworker-centric renderer. It never talks to, or requires, the OpenWork
 * desktop app process.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, Menu, app, ipcMain, shell } from "electron";
import { openworkConfigDir } from "@openwork/paths";
import { createHeadlessThreadClient } from "@openwork/headless-threads";
import {
  createCoworker,
  defaultCoworkersDir,
  deleteCoworker,
  getCoworker,
  listCoworkers,
  listMemoryFiles,
  readCoworkerFile,
  updateCoworker,
  writeCoworkerFile,
} from "./coworkers.mjs";
import {
  attachLocalResponsibilityThread,
  beginLocalResponsibilityRun,
  createLocalResponsibility,
  deleteLocalResponsibility,
  finishLocalResponsibilityRun,
  listLocalResponsibilities,
  setLocalResponsibilityActive,
} from "./local-responsibilities.mjs";
import { resolveBundledOpencodeBinary } from "./runtime-paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged || process.env.OPENWORK_DEV_MODE === "1";

const APP_NAME = "Open Coworker";
const APP_IDENTIFIER = isDev ? "com.differentai.opencoworker.dev" : "com.differentai.opencoworker";
const DEFAULT_SERVER_PORT = 8790;
const DEFAULT_DEN_BASE_URL = "https://app.openworklabs.com";

const explicitCdpPort = Number.parseInt(
  process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() ?? "",
  10,
);
if (Number.isFinite(explicitCdpPort) && explicitCdpPort > 0) {
  app.commandLine.appendSwitch("remote-debugging-port", String(explicitCdpPort));
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  if (isDev) console.log(`[open-coworker] Electron CDP exposed at http://127.0.0.1:${explicitCdpPort}`);
}
const extraLaunchArgs = (process.env.ELECTRON_EXTRA_LAUNCH_ARGS ?? "").trim();
for (const argument of extraLaunchArgs.split(/\s+/).filter(Boolean)) {
  const cleaned = argument.replace(/^--/, "");
  const separator = cleaned.indexOf("=");
  if (separator > 0) {
    app.commandLine.appendSwitch(cleaned.slice(0, separator), cleaned.slice(separator + 1));
  } else if (cleaned) {
    app.commandLine.appendSwitch(cleaned);
  }
}

app.setName(APP_NAME);
if (process.platform === "win32") {
  app.setAppUserModelId(APP_IDENTIFIER);
}
app.setPath(
  "userData",
  process.env.COWORKER_USER_DATA_DIR?.trim() || path.join(app.getPath("appData"), APP_IDENTIFIER),
);

const coworkersDir = process.env.COWORKER_HOME_DIR?.trim() || defaultCoworkersDir();
const serverConfigPath = process.env.COWORKER_SERVER_CONFIG?.trim()
  || path.join(openworkConfigDir(), "coworker-server.json");

/** @type {{ url: string, stop: () => Promise<void>, managedOpencode: { pid: number | null, isAlive: () => boolean } | null } | null} */
let serverHandle = null;
let ownerToken = "";
let engineError = "";
let startingServer = null;
let localResponsibilitiesTimer = null;
const activeLocalRuns = new Set();

function tokenFilePath() {
  return path.join(app.getPath("userData"), "coworker-server-tokens.json");
}

async function loadOrCreateTokens() {
  const file = tokenFilePath();
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed?.clientToken === "string" && typeof parsed?.hostToken === "string") {
      return parsed;
    }
  } catch {
    // First launch or unreadable file: mint fresh credentials below.
  }
  const tokens = {
    clientToken: randomBytes(24).toString("hex"),
    hostToken: randomBytes(24).toString("hex"),
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(tokens, null, 2)}\n`, "utf8");
  return tokens;
}

async function persistOwnerToken(token) {
  const file = tokenFilePath();
  const tokens = await loadOrCreateTokens();
  await writeFile(file, `${JSON.stringify({ ...tokens, ownerToken: token }, null, 2)}\n`, "utf8");
}

/** Reuse the persisted owner token across restarts; mint only when invalid. */
async function resolveOwnerToken(baseUrl, tokens) {
  const persisted = typeof tokens.ownerToken === "string" ? tokens.ownerToken.trim() : "";
  if (persisted) {
    try {
      const probe = await fetch(`${baseUrl}/workspaces`, {
        headers: { Authorization: `Bearer ${persisted}` },
        signal: AbortSignal.timeout(5000),
      });
      if (probe.ok) return persisted;
    } catch {
      // Unreachable or rejected: mint a fresh token below.
    }
  }
  const minted = await issueOwnerToken(baseUrl, tokens.hostToken);
  await persistOwnerToken(minted).catch(() => undefined);
  return minted;
}

function embeddedServerPath() {
  const candidates = [
    path.resolve(__dirname, "..", "..", "server", "dist", "embedded.js"),
    path.resolve(__dirname, "..", "server", "dist", "embedded.js"),
    ...(process.resourcesPath
      ? [path.resolve(process.resourcesPath, "server", "dist", "embedded.js")]
      : []),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Cannot find the OpenWork embedded server bundle. Build it with \`pnpm --filter openwork-server build\`. Checked: ${candidates.join(", ")}`,
    );
  }
  return found;
}

function resolveOpencodeBin() {
  return process.env.OPENWORK_OPENCODE_BIN?.trim()
    || resolveBundledOpencodeBinary({
      appRoot: path.resolve(__dirname, ".."),
      resourcesPath: process.resourcesPath,
    })
    || "opencode";
}

async function fetchJson(url, init, timeoutMs = 8000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = json && typeof json.message === "string" ? json.message : `HTTP ${response.status}`;
    throw new Error(`${url} failed: ${message}`);
  }
  return json;
}

async function issueOwnerToken(baseUrl, hostToken) {
  const payload = await fetchJson(`${baseUrl}/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-OpenWork-Host-Token": hostToken,
    },
    body: JSON.stringify({ scope: "owner", label: "Open Coworker owner token" }),
  });
  const token = typeof payload?.token === "string" ? payload.token.trim() : "";
  if (!token) throw new Error("OpenWork server did not return an owner token");
  return token;
}

async function startPlatformServer() {
  const { startEmbeddedServer } = await import(pathToFileURL(embeddedServerPath()).href);
  const tokens = await loadOrCreateTokens();
  await mkdir(coworkersDir, { recursive: true });
  const coworkers = await listCoworkers(coworkersDir);
  // The registry file is the source of truth once it exists; seeds only shape
  // the very first boot (mirrors the OpenWork desktop's embedded-server use).
  const seedWorkspaces = existsSync(serverConfigPath) ? [] : coworkers.map((coworker) => coworker.path);

  const startOnce = async (manageOpencode) =>
    startEmbeddedServer({
      host: "127.0.0.1",
      port: DEFAULT_SERVER_PORT,
      corsOrigins: ["*"],
      approvalMode: "auto",
      configPath: serverConfigPath,
      workspaces: seedWorkspaces,
      token: tokens.clientToken,
      hostToken: tokens.hostToken,
      manageOpencode,
      opencodeBin: manageOpencode ? resolveOpencodeBin() : undefined,
    });

  engineError = "";
  try {
    serverHandle = await startOnce(true);
  } catch (error) {
    // Missing/broken engine binary must not take the whole product down:
    // fall back to a server without a managed engine and surface the reason.
    engineError = error instanceof Error ? error.message : String(error);
    serverHandle = await startOnce(false);
  }
  ownerToken = await resolveOwnerToken(serverHandle.url, tokens);
  return serverHandle;
}

async function ensurePlatformServer() {
  if (serverHandle) return serverHandle;
  startingServer ??= startPlatformServer().finally(() => {
    startingServer = null;
  });
  return startingServer;
}

async function restartPlatformServer() {
  // Settle an in-flight boot first so a restart is a real stop-then-start
  // rather than a second subscriber to the old start.
  if (startingServer) await startingServer.catch(() => undefined);
  if (serverHandle) {
    const previous = serverHandle;
    serverHandle = null;
    await previous.stop().catch(() => undefined);
  }
  return ensurePlatformServer();
}

function runtimeInfo() {
  return {
    appName: APP_NAME,
    version: app.getVersion(),
    serverUrl: serverHandle?.url ?? "",
    ownerToken,
    coworkersDir,
    denBaseUrl: process.env.COWORKER_DEN_BASE_URL?.trim() || DEFAULT_DEN_BASE_URL,
    engineManaged: Boolean(serverHandle?.managedOpencode),
    engineError,
  };
}

function localRunModel(coworker) {
  const preference = String(coworker?.model ?? "").trim();
  const separator = preference.indexOf("/");
  if (separator <= 0 || separator === preference.length - 1) return undefined;
  return {
    providerId: preference.slice(0, separator),
    modelId: preference.slice(separator + 1),
    variant: String(coworker?.modelVariant ?? "").trim() || undefined,
  };
}

async function executeLocalResponsibility(slug, id, trigger) {
  const key = `${slug}:${id}`;
  try {
    const coworker = await getCoworker(coworkersDir, slug);
    if (!coworker.workspaceId) throw new Error("Coworker workspace is not ready");
    const started = await beginLocalResponsibilityRun(coworkersDir, slug, id, { trigger });
    const runId = started.latestRun.id;
    try {
      const handle = await ensurePlatformServer();
      if (!handle.managedOpencode) throw new Error(engineError || "The local agent engine is unavailable");
      const client = createHeadlessThreadClient({
        baseUrl: handle.url,
        workspaceId: coworker.workspaceId,
        token: ownerToken,
        defaultModel: localRunModel(coworker),
      });
      const thread = await client.createThread({
        title: started.name,
        prompt: started.instructions,
      });
      await attachLocalResponsibilityThread(coworkersDir, slug, id, runId, thread.id);
      const result = await client.waitForThread(thread.id, {
        timeoutMs: 60 * 60_000,
        pollIntervalMs: 1_000,
      });
      const succeeded = result.outcome === "settled" && !result.terminalError;
      await finishLocalResponsibilityRun(coworkersDir, slug, id, runId, {
        status: succeeded ? "succeeded" : "failed",
        error: succeeded
          ? ""
          : result.terminalError?.message || (result.outcome === "timeout" ? "Run timed out after one hour" : `Run ${result.outcome}`),
      });
    } catch (error) {
      await finishLocalResponsibilityRun(coworkersDir, slug, id, runId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
  } finally {
    activeLocalRuns.delete(key);
  }
}

function startLocalResponsibilityRun(slug, id, trigger) {
  const key = `${slug}:${id}`;
  if (activeLocalRuns.has(key)) return false;
  activeLocalRuns.add(key);
  void executeLocalResponsibility(slug, id, trigger);
  return true;
}

async function runDueLocalResponsibilities() {
  const now = Date.now();
  const coworkers = await listCoworkers(coworkersDir);
  for (const coworker of coworkers) {
    const responsibilities = await listLocalResponsibilities(coworkersDir, coworker.slug).catch(() => []);
    for (const responsibility of responsibilities) {
      const key = `${coworker.slug}:${responsibility.id}`;
      if (responsibility.latestRun?.status === "running" && !activeLocalRuns.has(key)) {
        await finishLocalResponsibilityRun(
          coworkersDir,
          coworker.slug,
          responsibility.id,
          responsibility.latestRun.id,
          { status: "failed", error: "Open Coworker closed before this local run finished.", now },
        ).catch(() => undefined);
      }
      if (responsibility.state !== "active" || !responsibility.nextDueAt || responsibility.nextDueAt > now) continue;
      const trigger = now - responsibility.nextDueAt > 30_000 ? "recovery" : "scheduled";
      startLocalResponsibilityRun(coworker.slug, responsibility.id, trigger);
    }
  }
}

function startLocalResponsibilitiesScheduler() {
  if (localResponsibilitiesTimer) return;
  const check = () => {
    void runDueLocalResponsibilities().catch((error) => {
      console.warn("[open-coworker] local responsibilities check failed", error);
    });
  };
  check();
  localResponsibilitiesTimer = setInterval(check, 15_000);
}

/** Register the coworker directory as a native OpenWork workspace. */
async function registerCoworkerWorkspace(coworker) {
  const handle = await ensurePlatformServer();
  const tokens = await loadOrCreateTokens();
  const payload = await fetchJson(`${handle.url}/workspaces/local`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-OpenWork-Host-Token": tokens.hostToken,
    },
    body: JSON.stringify({ folderPath: coworker.path, name: coworker.name, preset: "minimal" }),
  });
  const workspaceId = typeof payload?.activeId === "string" ? payload.activeId : "";
  if (!workspaceId) throw new Error("Workspace registration did not return an id");
  return workspaceId;
}

/**
 * Repair imported or pre-registration coworker records during normal startup.
 * The filesystem home already exists; this completes its native OpenWork
 * workspace registration and persists the platform id before the UI lists it.
 */
async function listPreparedCoworkers() {
  const coworkers = await listCoworkers(coworkersDir);
  if (!coworkers.some((coworker) => !coworker.workspaceId)) return coworkers;

  await ensurePlatformServer();
  let registeredWorkspace = false;
  const prepared = [];
  for (const coworker of coworkers) {
    if (coworker.workspaceId) {
      prepared.push(coworker);
      continue;
    }
    try {
      const workspaceId = await registerCoworkerWorkspace(coworker);
      prepared.push(await updateCoworker(coworkersDir, coworker.slug, { workspaceId }));
      registeredWorkspace = true;
    } catch {
      // Keep the coworker visible. Its explicit repair action remains the
      // fallback when automatic registration is genuinely unavailable.
      prepared.push(coworker);
    }
  }

  if (registeredWorkspace && !serverHandle?.managedOpencode) {
    await restartPlatformServer();
  }
  return prepared;
}

const commands = {
  "runtime.info": async () => {
    await ensurePlatformServer();
    return runtimeInfo();
  },
  "coworkers.list": async () => listPreparedCoworkers(),
  "coworkers.get": async ({ slug }) => getCoworker(coworkersDir, slug),
  "coworkers.create": async ({ name, role, mission, avatarColor, avatarGlasses }) => {
    await ensurePlatformServer();
    const hadEngine = Boolean(serverHandle?.managedOpencode);
    const coworker = await createCoworker(coworkersDir, { name, role, mission, avatarColor, avatarGlasses });
    // Registration is registry-level and works without an engine. Do it
    // first, then restart when no engine was managed yet: the engine only
    // spawns when the registry holds at least one workspace, so the restart
    // must happen after this workspace is persisted.
    const workspaceId = await registerCoworkerWorkspace(coworker);
    const updated = await updateCoworker(coworkersDir, coworker.slug, { workspaceId });
    if (!hadEngine) {
      await restartPlatformServer();
    }
    return updated;
  },
  "coworkers.ensureWorkspace": async ({ slug }) => {
    await ensurePlatformServer();
    const coworker = await getCoworker(coworkersDir, slug);
    if (coworker.workspaceId) {
      if (!serverHandle?.managedOpencode) await restartPlatformServer();
      return coworker;
    }
    const workspaceId = await registerCoworkerWorkspace(coworker);
    const updated = await updateCoworker(coworkersDir, slug, { workspaceId });
    if (!serverHandle?.managedOpencode) {
      await restartPlatformServer();
    }
    return updated;
  },
  "coworkers.update": async ({ slug, patch }) => updateCoworker(coworkersDir, slug, patch ?? {}),
  "coworkers.delete": async ({ slug }) => {
    // Deregister the workspace first so the registry never points at a
    // directory that is about to disappear. Best effort: a failed
    // deregistration must not leave the coworker half-retired in the UI.
    const coworker = await getCoworker(coworkersDir, slug).catch(() => null);
    if (coworker?.workspaceId) {
      const handle = await ensurePlatformServer();
      const tokens = await loadOrCreateTokens();
      await fetch(`${handle.url}/workspaces/${encodeURIComponent(coworker.workspaceId)}`, {
        method: "DELETE",
        headers: { "X-OpenWork-Host-Token": tokens.hostToken },
        signal: AbortSignal.timeout(8000),
      }).catch(() => undefined);
    }
    await deleteCoworker(coworkersDir, slug);
    return { ok: true };
  },
  "coworkers.files.list": async ({ slug }) => listMemoryFiles(coworkersDir, slug),
  "coworkers.files.read": async ({ slug, path: relativePath }) => ({
    content: await readCoworkerFile(coworkersDir, slug, relativePath),
  }),
  "coworkers.files.write": async ({ slug, path: relativePath, content }) => {
    await writeCoworkerFile(coworkersDir, slug, relativePath, content);
    return { ok: true };
  },
  "localResponsibilities.list": async ({ slug }) => listLocalResponsibilities(coworkersDir, slug),
  "localResponsibilities.create": async ({ slug, name, instructions, schedule }) =>
    createLocalResponsibility(coworkersDir, slug, { name, instructions, schedule }),
  "localResponsibilities.setActive": async ({ slug, id, active }) =>
    setLocalResponsibilityActive(coworkersDir, slug, id, Boolean(active)),
  "localResponsibilities.delete": async ({ slug, id }) => {
    await deleteLocalResponsibility(coworkersDir, slug, id);
    return { ok: true };
  },
  "localResponsibilities.runNow": async ({ slug, id }) => ({
    accepted: startLocalResponsibilityRun(slug, id, "manual"),
  }),
  "shell.openExternal": async ({ url }) => {
    const parsed = new URL(String(url ?? ""));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Only http(s) URLs can be opened");
    }
    await shell.openExternal(parsed.toString());
    return { ok: true };
  },
};

function registerIpc() {
  ipcMain.handle("coworker:invoke", async (_event, request) => {
    const command = typeof request?.command === "string" ? request.command : "";
    const handler = commands[command];
    if (!handler) {
      return { ok: false, error: `Unknown Open Coworker command: ${command}` };
    }
    try {
      const result = await handler(request?.payload ?? {});
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function installApplicationMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function rendererUrl() {
  const explicit = process.env.COWORKER_START_URL?.trim();
  if (explicit) return explicit;
  return pathToFileURL(path.resolve(__dirname, "..", "dist", "index.html")).href;
}

async function createMainWindow() {
  const macWindowChrome = process.platform === "darwin"
    ? {
        backgroundColor: "#00000000",
        hasShadow: true,
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 18, y: 18 },
        transparent: true,
        vibrancy: "under-window",
        visualEffectState: "active",
      }
    : { backgroundColor: "#fbfaf7" };
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    ...macWindowChrome,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  await window.loadURL(rendererUrl());
  return window;
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    installApplicationMenu();
    registerIpc();
    // Start the platform in the background; the renderer gates on runtime.info.
    void ensurePlatformServer().catch((error) => {
      engineError = error instanceof Error ? error.message : String(error);
    });
    startLocalResponsibilitiesScheduler();
    await createMainWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (localResponsibilitiesTimer) {
      clearInterval(localResponsibilitiesTimer);
      localResponsibilitiesTimer = null;
    }
    if (!serverHandle) return;
    event.preventDefault();
    const handle = serverHandle;
    serverHandle = null;
    void handle.stop().catch(() => undefined).finally(() => app.quit());
  });
}
