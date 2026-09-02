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
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from "electron";
import { openworkConfigDir } from "@openwork/paths";
import { createHeadlessThreadClient } from "@openwork/headless-threads";
import {
  createCoworker,
  defaultCoworkersDir,
  deleteRetiredCoworker,
  getCoworker,
  listCoworkers,
  listMemoryFiles,
  listRetiredCoworkers,
  readCoworkerFile,
  restoreCoworker,
  retireCoworker,
  updateCoworker,
  writeCoworkerFile,
} from "./coworkers.mjs";
import {
  attachLocalResponsibilityThread,
  beginLocalResponsibilityRun,
  cancelQueuedLocalRun,
  createLocalResponsibility,
  deleteLocalResponsibility,
  finishLocalResponsibilityRun,
  listLocalResponsibilities,
  queueLocalResponsibilityRun,
  reconcileInterruptedLocalRuns,
  setLocalResponsibilityActive,
} from "./local-responsibilities.mjs";
import { resolveBundledOpencodeBinary, resolveUserDataDir } from "./runtime-paths.mjs";
import { SETTINGS_FILE, readSettings, updateSettings } from "./settings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged || process.env.OPENWORK_DEV_MODE === "1";

const APP_NAME = "Open Coworker";
const APP_IDENTIFIER = isDev ? "com.differentai.opencoworker.dev" : "com.differentai.opencoworker";
const DEFAULT_SERVER_PORT = 8790;
const DEFAULT_DEN_BASE_URL = "https://app.openworklabs.com";
const HOSTED_DEN_APEX_HOST = "openworklabs.com";
const APP_ICON_PATH = path.resolve(__dirname, "..", "resources", "icons", "icon.png");

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
  resolveUserDataDir({ env: process.env, appDataDir: app.getPath("appData"), appIdentifier: APP_IDENTIFIER }),
);

const coworkersDir = process.env.COWORKER_HOME_DIR?.trim() || defaultCoworkersDir();
const serverConfigPath = process.env.COWORKER_SERVER_CONFIG?.trim()
  || path.join(openworkConfigDir(), "coworker-server.json");
// The embedded server keeps its runtime configuration (synced providers,
// engine records) and its credential store next to its registry file. Open
// Coworker owns its own copies so signing an account in or out here never
// rewrites the OpenWork desktop app's engine state on the same machine.
process.env.OPENWORK_RUNTIME_DB ||= path.join(path.dirname(serverConfigPath), "coworker-runtime.sqlite");
process.env.OPENWORK_ENV_STORE ||= path.join(path.dirname(serverConfigPath), "coworker-env.json");
const settingsPath = path.join(path.dirname(serverConfigPath), SETTINGS_FILE);

/**
 * Deep links use the app's own scheme so a Den handoff never lands in the
 * OpenWork desktop app installed beside Open Coworker. Registration mirrors
 * the desktop shell: packaged builds only, and never inside isolated test
 * profiles.
 */
const DEEP_LINK_SCHEME = "opencoworker";
const DEEP_LINK_EVENT = "coworker:deep-link";
const protocolRegistered = app.isPackaged
  && process.env.OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION !== "1"
  && !(process.platform === "linux" && process.env.APPIMAGE);

/** @type {{ url: string, stop: () => Promise<void>, managedOpencode: { pid: number | null, isAlive: () => boolean } | null } | null} */
let serverHandle = null;
let ownerToken = "";
let engineError = "";
let startingServer = null;
let localResponsibilitiesTimer = null;
/** `slug:id` of every run executing in this process. */
const activeLocalRuns = new Set();
/** Runs waiting for a free slot, oldest first: `{ key, slug, id, runId }`. */
const queuedLocalRuns = [];
/** Admission decisions run one at a time so two requests can never both take the last slot. */
let localRunAdmission = Promise.resolve();
function admitLocalRun(decide) {
  const next = localRunAdmission.then(decide, decide);
  localRunAdmission = next.then(() => undefined, () => undefined);
  return next;
}
/** @type {BrowserWindow | null} */
let mainWindow = null;

function parseExternalUrl(value) {
  const parsed = new URL(String(value ?? ""));
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http(s) URLs can be opened");
  }
  return parsed;
}

async function confirmAndOpenExternal(value) {
  const parsed = parseExternalUrl(value);
  const options = {
    type: "question",
    title: "Open link in browser?",
    message: "An App wants to open this link in your browser.",
    detail: parsed.toString(),
    buttons: ["Cancel", "Open link"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  if (result.response !== 1) return { ok: false, cancelled: true };
  await shell.openExternal(parsed.toString());
  return { ok: true };
}
/** @type {string[]} */
const pendingDeepLinks = [];
let deepLinkListenerReady = false;
/**
 * The signed-in OpenWork account the renderer handed to this process, in the
 * shape the embedded server's cloud provider sync expects. Held here so a
 * platform restart (first coworker, workspace repair) re-applies it without
 * asking the user to sign in again.
 * @type {{ baseUrl: string, token: string, orgId: string } | null}
 */
let denSession = null;

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
  if (denSession) {
    // A fresh server starts with no account context; hand the session back so
    // the signed-in user's providers keep flowing into this engine.
    await applyDenSession(serverHandle, tokens.hostToken, denSession).catch((error) => {
      console.warn("[open-coworker] could not re-apply the OpenWork session after restart", error);
    });
  }
  return serverHandle;
}

/**
 * Give the embedded server the signed-in account so it can materialize the
 * member's authorized providers into the engine — the same `PUT /den-session`
 * then `POST /cloud-provider-sync/run` sequence the OpenWork desktop performs.
 */
async function applyDenSession(handle, hostToken, session) {
  const headers = { "Content-Type": "application/json", "X-OpenWork-Host-Token": hostToken };
  const response = await fetch(`${handle.url}/den-session`, {
    method: "PUT",
    headers,
    body: JSON.stringify(session),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Storing the OpenWork session failed (${response.status})`);
  return runCloudProviderSync(handle, hostToken, "den_session_updated");
}

async function runCloudProviderSync(handle, hostToken, reason) {
  const payload = await fetchJson(`${handle.url}/cloud-provider-sync/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenWork-Host-Token": hostToken },
    body: JSON.stringify({ reason }),
  }, 90_000);
  return {
    status: typeof payload?.status === "string" ? payload.status : "failed",
    message: typeof payload?.message === "string" ? payload.message : "",
  };
}

async function clearDenSession(handle, hostToken) {
  const response = await fetch(`${handle.url}/den-session`, {
    method: "DELETE",
    headers: { "X-OpenWork-Host-Token": hostToken },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Clearing the OpenWork session failed (${response.status})`);
}

function parseDenSessionPayload(payload) {
  const baseUrl = String(payload?.baseUrl ?? "").trim().replace(/\/+$/, "");
  const token = String(payload?.token ?? "").trim();
  const orgId = String(payload?.orgId ?? "").trim();
  if (!baseUrl || !token || !orgId) {
    throw new Error("An OpenWork session needs its API base URL, token, and organization.");
  }
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The OpenWork API base URL must use http(s).");
  }
  const configured = configuredDenApiBase();
  if (parsed.toString().replace(/\/+$/, "") !== configured) {
    throw new Error("The OpenWork session origin does not match this app's configured Den.");
  }
  return { baseUrl, token, orgId };
}

function configuredDenApiBase() {
  const configured = (process.env.COWORKER_DEN_BASE_URL?.trim() || DEFAULT_DEN_BASE_URL).replace(/\/+$/, "");
  const url = new URL(configured);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "api" || hostname.startsWith("api.")) return url.origin;
  if (hostname === HOSTED_DEN_APEX_HOST || hostname.endsWith(`.${HOSTED_DEN_APEX_HOST}`)) {
    url.hostname = `api.${hostname}`;
    return url.origin;
  }
  return `${configured}/api/den`;
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
    deepLinkScheme: DEEP_LINK_SCHEME,
    deepLinksRegistered: protocolRegistered,
    engineManaged: Boolean(serverHandle?.managedOpencode),
    engineError,
  };
}

function forwardedDeepLinks(argv) {
  return argv
    .slice(1)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${DEEP_LINK_SCHEME}://`));
}

function queueDeepLinks(urls) {
  const next = urls.filter(Boolean);
  if (next.length === 0) return;
  pendingDeepLinks.push(...next);
  flushPendingDeepLinks();
}

function flushPendingDeepLinks() {
  const contents = mainWindow?.webContents;
  if (!contents || !deepLinkListenerReady || pendingDeepLinks.length === 0) return;
  contents.send(DEEP_LINK_EVENT, pendingDeepLinks.splice(0, pendingDeepLinks.length));
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

/** The coworker's own last words for a finished run, bounded for the history list. */
async function readRunSummary(client, threadId) {
  try {
    const transcript = await client.exportTranscript(threadId);
    const reply = [...transcript.messages].reverse().find((message) => message.role === "assistant" && message.text.trim());
    return reply?.text.trim() ?? "";
  } catch {
    return "";
  }
}

const RESUME_PROMPT = (name, reason) =>
  [
    `Continue the previous run of the responsibility "${name}". It stopped before finishing${reason ? ` (${reason})` : ""}.`,
    "Pick up where you left off, finish the work described in your instructions, and report the outcome.",
  ].join(" ");

/**
 * Execute one run to completion. `runId` promotes an already-queued run;
 * `resumeThreadId` continues an earlier run's native thread instead of
 * opening a new one.
 */
async function executeLocalResponsibility(slug, id, { trigger = "manual", runId = "", resumeThreadId = "", resumeReason = "" } = {}) {
  const key = `${slug}:${id}`;
  try {
    // The coworker or responsibility can disappear between the due check and
    // this point (retire, delete). That is not a run failure to record, only a
    // run that never started; log it instead of rejecting a detached promise.
    let coworker;
    let started;
    try {
      coworker = await getCoworker(coworkersDir, slug);
      if (!coworker.workspaceId) throw new Error("Coworker workspace is not ready");
      started = await beginLocalResponsibilityRun(coworkersDir, slug, id, { trigger, runId, threadId: resumeThreadId });
    } catch (error) {
      console.warn(`[open-coworker] local responsibility ${key} did not start`, error);
      return;
    }
    const activeRunId = started.latestRun.id;
    try {
      const handle = await ensurePlatformServer();
      if (!handle.managedOpencode) throw new Error(engineError || "AI is unavailable on this Mac");
      const client = createHeadlessThreadClient({
        baseUrl: handle.url,
        workspaceId: coworker.workspaceId,
        token: ownerToken,
        defaultModel: localRunModel(coworker),
      });
      let threadId = resumeThreadId;
      let acceptance;
      if (threadId) {
        acceptance = await client.sendTurn(threadId, { prompt: RESUME_PROMPT(started.name, resumeReason) });
      } else {
        const thread = await client.createThread({ title: started.name, prompt: started.instructions });
        threadId = thread.id;
        await attachLocalResponsibilityThread(coworkersDir, slug, id, activeRunId, threadId);
      }
      const result = await client.waitForThread(threadId, {
        timeoutMs: 60 * 60_000,
        pollIntervalMs: 1_000,
        ...(acceptance ? { since: acceptance } : {}),
      });
      const succeeded = result.outcome === "settled" && !result.terminalError;
      await finishLocalResponsibilityRun(coworkersDir, slug, id, activeRunId, {
        status: succeeded ? "succeeded" : "failed",
        error: succeeded
          ? ""
          : result.terminalError?.message || (result.outcome === "timeout" ? "Run timed out after one hour" : `Run ${result.outcome}`),
        summary: await readRunSummary(client, threadId),
      });
    } catch (error) {
      await finishLocalResponsibilityRun(coworkersDir, slug, id, activeRunId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
  } finally {
    activeLocalRuns.delete(key);
    void drainLocalRunQueue();
  }
}

async function parallelRunLimit() {
  return (await readSettings(settingsPath)).maxParallelLocalRuns;
}

function isQueued(key) {
  return queuedLocalRuns.some((entry) => entry.key === key);
}

/**
 * Start a run now if a slot is free on this Mac, otherwise record it as queued
 * so it starts by itself when one frees up. Returns what happened.
 */
function startLocalResponsibilityRun(slug, id, trigger) {
  return admitLocalRun(async () => {
    const key = `${slug}:${id}`;
    if (activeLocalRuns.has(key)) return { accepted: false, queued: false, reason: "running" };
    if (isQueued(key)) return { accepted: false, queued: true, reason: "queued" };
    const limit = await parallelRunLimit();
    if (activeLocalRuns.size >= limit) {
      const queued = await queueLocalResponsibilityRun(coworkersDir, slug, id, { trigger });
      queuedLocalRuns.push({ key, slug, id, runId: queued.latestRun.id });
      return { accepted: true, queued: true, reason: "" };
    }
    activeLocalRuns.add(key);
    void executeLocalResponsibility(slug, id, { trigger });
    return { accepted: true, queued: false, reason: "" };
  });
}

/** Continue a failed or interrupted run inside its own native thread. */
function resumeLocalResponsibilityRun(slug, id) {
  return admitLocalRun(async () => {
    const key = `${slug}:${id}`;
    if (activeLocalRuns.has(key) || isQueued(key)) return { accepted: false, reason: "busy" };
    const items = await listLocalResponsibilities(coworkersDir, slug);
    const record = items.find((item) => item.id === id);
    const last = record?.latestRun;
    if (!last || last.status !== "failed" || !last.threadId) return { accepted: false, reason: "nothing to resume" };
    const limit = await parallelRunLimit();
    if (activeLocalRuns.size >= limit) return { accepted: false, reason: "at limit" };
    activeLocalRuns.add(key);
    void executeLocalResponsibility(slug, id, { trigger: "resume", resumeThreadId: last.threadId, resumeReason: last.error });
    return { accepted: true, reason: "" };
  });
}

async function cancelQueuedLocalResponsibilityRun(slug, id) {
  const key = `${slug}:${id}`;
  const index = queuedLocalRuns.findIndex((entry) => entry.key === key);
  const entry = index === -1 ? null : queuedLocalRuns.splice(index, 1)[0];
  const items = await listLocalResponsibilities(coworkersDir, slug);
  const record = items.find((item) => item.id === id);
  const queuedRun = entry?.runId ?? record?.runs.find((run) => run.status === "queued")?.id ?? "";
  if (queuedRun) await cancelQueuedLocalRun(coworkersDir, slug, id, queuedRun);
  return { ok: true };
}

/** Start queued runs, oldest first, while slots are free. */
function drainLocalRunQueue() {
  return admitLocalRun(async () => {
    const limit = await parallelRunLimit();
    while (queuedLocalRuns.length > 0 && activeLocalRuns.size < limit) {
      const next = queuedLocalRuns.shift();
      if (activeLocalRuns.has(next.key)) continue;
      activeLocalRuns.add(next.key);
      void executeLocalResponsibility(next.slug, next.id, { runId: next.runId });
    }
  });
}

function activeLocalRunIds(slug) {
  const prefix = `${slug}:`;
  return new Set([...activeLocalRuns].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)));
}

function localRunStatus(limit) {
  return { limit, active: activeLocalRuns.size, queued: queuedLocalRuns.length };
}

async function runDueLocalResponsibilities() {
  const now = Date.now();
  const coworkers = await listCoworkers(coworkersDir);
  for (const coworker of coworkers) {
    const responsibilities = await reconcileInterruptedLocalRuns(coworkersDir, coworker.slug, {
      activeRunIds: activeLocalRunIds(coworker.slug),
      now,
    }).catch(() => []);
    for (const responsibility of responsibilities) {
      const key = `${coworker.slug}:${responsibility.id}`;
      // A run queued in an earlier process (quit before its turn) waits in line again.
      const persistedQueue = responsibility.runs.find((run) => run.status === "queued");
      if (persistedQueue && !activeLocalRuns.has(key) && !isQueued(key)) {
        queuedLocalRuns.push({ key, slug: coworker.slug, id: responsibility.id, runId: persistedQueue.id });
      }
      if (responsibility.state !== "active" || !responsibility.nextDueAt || responsibility.nextDueAt > now) continue;
      const trigger = now - responsibility.nextDueAt > 30_000 ? "recovery" : "scheduled";
      await startLocalResponsibilityRun(coworker.slug, responsibility.id, trigger);
    }
  }
  await drainLocalRunQueue();
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
  "runtime.restart": async () => {
    await restartPlatformServer();
    return runtimeInfo();
  },
  "coworkers.list": async () => listPreparedCoworkers(),
  "coworkers.get": async ({ slug }) => getCoworker(coworkersDir, slug),
  "coworkers.create": async ({ name, role, mission, avatarColor, avatarGlasses, personality }) => {
    await ensurePlatformServer();
    const hadEngine = Boolean(serverHandle?.managedOpencode);
    const coworker = await createCoworker(coworkersDir, { name, role, mission, avatarColor, avatarGlasses, personality });
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
    const running = activeLocalRunIds(String(slug ?? "")).size;
    for (let index = queuedLocalRuns.length - 1; index >= 0; index -= 1) {
      if (queuedLocalRuns[index].slug === String(slug ?? "")) queuedLocalRuns.splice(index, 1);
    }
    if (running > 0) {
      throw new Error(
        `${running === 1 ? "A local responsibility is" : `${running} local responsibilities are`} still running for this coworker. Wait for it to finish or stop it before retiring.`,
      );
    }
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
    const retired = await retireCoworker(coworkersDir, slug);
    return { ok: true, archiveId: retired.archiveId };
  },
  "coworkers.retired.list": async () => listRetiredCoworkers(coworkersDir),
  "coworkers.restore": async ({ archiveId }) => {
    // Restoring puts the home back at its original path; the server derives the
    // same workspace id from that path, so registration is idempotent.
    const restored = await restoreCoworker(coworkersDir, archiveId);
    await ensurePlatformServer();
    const hadEngine = Boolean(serverHandle?.managedOpencode);
    const workspaceId = await registerCoworkerWorkspace(restored);
    const updated = await updateCoworker(coworkersDir, restored.slug, { workspaceId });
    if (!hadEngine) await restartPlatformServer();
    return updated;
  },
  "coworkers.retired.delete": async ({ archiveId }) => {
    await deleteRetiredCoworker(coworkersDir, archiveId);
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
  "localResponsibilities.runNow": async ({ slug, id }) => startLocalResponsibilityRun(slug, id, "manual"),
  "localResponsibilities.resume": async ({ slug, id }) => resumeLocalResponsibilityRun(slug, id),
  "localResponsibilities.cancelQueued": async ({ slug, id }) => cancelQueuedLocalResponsibilityRun(slug, id),
  /** How busy this Mac is with responsibilities right now, and the limit that applies. */
  "localResponsibilities.status": async () => localRunStatus(await parallelRunLimit()),
  "settings.get": async () => readSettings(settingsPath),
  "settings.update": async (patch) => {
    const next = await updateSettings(settingsPath, patch);
    void drainLocalRunQueue();
    return next;
  },
  "shell.openExternal": async ({ url }) => {
    const parsed = parseExternalUrl(url);
    await shell.openExternal(parsed.toString());
    return { ok: true };
  },
  // Links supplied by an MCP App are untrusted. The native confirmation keeps
  // the destination visible and requires a fresh user gesture before leaving.
  "shell.openUntrustedExternal": async ({ url }) => confirmAndOpenExternal(url),
  /** Signed-in account → embedded server → engine providers. Returns the sync outcome. */
  "den.session.set": async (payload) => {
    const session = parseDenSessionPayload(payload);
    denSession = session;
    const handle = await ensurePlatformServer();
    const tokens = await loadOrCreateTokens();
    return applyDenSession(handle, tokens.hostToken, session);
  },
  "den.session.clear": async () => {
    denSession = null;
    const handle = await ensurePlatformServer();
    const tokens = await loadOrCreateTokens();
    await clearDenSession(handle, tokens.hostToken);
    return { ok: true };
  },
  /** Re-read the account's providers now (after org changes, new keys, or a failed pass). */
  "den.providers.sync": async () => {
    if (!denSession) return { status: "no_session", message: "" };
    const handle = await ensurePlatformServer();
    const tokens = await loadOrCreateTokens();
    return runCloudProviderSync(handle, tokens.hostToken, "manual_refresh");
  },
  /**
   * The renderer announces its deep-link listener and drains anything queued
   * while it was loading; later links are pushed over the same channel.
   */
  "deepLinks.subscribe": async () => {
    deepLinkListenerReady = true;
    return { urls: pendingDeepLinks.splice(0, pendingDeepLinks.length) };
  },
};

function registerIpc() {
  ipcMain.handle("coworker:invoke", async (event, request) => {
    if (event.senderFrame !== event.sender.mainFrame) {
      return { ok: false, error: "Open Coworker commands are only available to the main app frame." };
    }
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
    : { backgroundColor: "#090c12" };
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    icon: APP_ICON_PATH,
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
    if (/^https?:\/\//i.test(url)) void confirmAndOpenExternal(url);
    return { action: "deny" };
  });
  // A reload replaces the renderer; its deep-link listener must re-announce.
  window.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) deepLinkListenerReady = false;
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    deepLinkListenerReady = false;
  });
  mainWindow = window;
  await window.loadURL(rendererUrl());
  return window;
}

async function focusMainWindow() {
  const window = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? await createMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  if (protocolRegistered) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

  app.on("second-instance", (_event, argv) => {
    void focusMainWindow().then(() => queueDeepLinks(forwardedDeepLinks(argv)));
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    void app.whenReady()
      .then(() => focusMainWindow())
      .then(() => queueDeepLinks([url]));
  });

  app.whenReady().then(async () => {
    if (process.platform === "darwin" && existsSync(APP_ICON_PATH)) app.dock.setIcon(APP_ICON_PATH);
    installApplicationMenu();
    registerIpc();
    // Start the platform in the background; the renderer gates on runtime.info.
    void ensurePlatformServer().catch((error) => {
      engineError = error instanceof Error ? error.message : String(error);
    });
    startLocalResponsibilitiesScheduler();
    await createMainWindow();
    queueDeepLinks(forwardedDeepLinks(process.argv));
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
