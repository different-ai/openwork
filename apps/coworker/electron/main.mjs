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
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from "electron";
import { openworkConfigDir } from "@openwork/paths";
import { createHeadlessThreadClient, toTranscript } from "@openwork/headless-threads";
import { cloudModelOptions, resolveCloudModel } from "../src/lib/cloud-responsibilities.ts";
import { createDenAutomationsClient } from "../src/lib/den.ts";
import { assignmentToolCatalog, createAssignmentToolHandlers, createSelfToolHandlers, selfToolCatalog } from "./assignment-tools.mjs";
import {
  createCoworker,
  createLongTermMemory,
  defaultCoworkersDir,
  deleteLongTermMemory,
  deleteRetiredCoworker,
  getCoworker,
  indexLongTermMemory,
  listCoworkers,
  listLongTermMemories,
  listMemoryFiles,
  listRetiredCoworkers,
  readCoworkerFile,
  repairCoworkerContract,
  restoreCoworker,
  retireCoworker,
  updateCoworker,
  writeCoworkerFile,
} from "./coworkers.mjs";
import { COWORKER_TOOLS_MCP_NAME, DEFAULT_INSTRUCTIONS, createCoworkerToolsServer, createToolHandlers, toolCatalog } from "./coworker-tools.mjs";
import { readSuggestions, recommendTeam, refreshTeamRosters, setReferralState, setSuggestionState, teamCatalog, teamStates } from "./team.mjs";
import { createTeamToolHandlers, teamToolCatalog } from "./team-tools.mjs";
import {
  archiveDocument,
  listDocuments,
  listRevisions,
  readDocument,
  recordStyleEvent,
  restoreRevision,
  setDocumentStatus,
  updateDocument,
} from "./documents.mjs";
import { ensureCoordinatorHome, updateCoordinator } from "./coordinator.mjs";
import { effortForTurn, effortStopOf, workerTurnsFor } from "../src/lib/effort.ts";
import {
  appendGroupEvent,
  archiveGroup,
  beginGroupTurn,
  createGroup,
  getGroup,
  listGroups,
  readGroupTimeline,
  reconcileInterruptedGroupTurns,
  updateGroup,
  updateGroupTurn,
} from "./groups.mjs";
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
  updateLocalResponsibility,
} from "./local-responsibilities.mjs";
import { prepareEngineSdk, readSidecarVersion } from "./engine-sdk.mjs";
import {
  SignInImportError,
  codexAuthFromFile,
  codexAuthPath,
  copilotAuthFromFile,
  copilotConfigDir,
  copilotSignedIn,
  customProviderId,
  detectLocalProviders,
  listOpenAiCompatibleModels,
  localServerProviderPatch,
  openAiCompatibleProviderConfig,
} from "./local-providers.mjs";
import { resolveBundledOpencodeBinary, resolveUserDataDir } from "./runtime-paths.mjs";
import { noteProgress, readChanges, trackChange, undoChange, writeTrackedFile } from "./self-memory.mjs";
import { SETTINGS_FILE, readSettings, scheduleGuardrails, updateSettings } from "./settings.mjs";
import {
  BEGIN_BODY,
  CONTINUE_BODY,
  RECOVERED_STATUS,
  appendWorkerEvent,
  createReviewScheduler,
  createWorker,
  createWorkerToolHandlers,
  getWorker,
  isWorkerFinished,
  lifespanSpent,
  listWorkers,
  nextWorkerState,
  parseWorkerReport,
  readWorkerEvents,
  registerWorkerThread,
  reviewPrompt,
  steerBody,
  updateWorker,
  workerProgressNote,
  workerThreadTitle,
  workerToolCatalog,
  workerTurnPrompt,
} from "./workers.mjs";

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
/** `slug:id` of every run executing in this process — responsibility runs and Worker turns alike. */
const activeLocalRuns = new Set();
/** Runs waiting for a free slot, oldest first: `{ key, slug, id, runId, launch }`; `launch` starts it once admitted. */
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

/** The engine's exact version: the sidecar's record beside the binary, else what the binary says. */
async function resolveOpencodeVersion(binary) {
  const recorded = await readSidecarVersion(path.join(path.dirname(binary), "versions.json"));
  if (recorded) return recorded;
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 8_000, windowsHide: true }, (error, stdout) => {
      const match = /(\d+\.\d+\.\d+)/.exec(String(stdout ?? ""));
      resolve(!error && match ? match[1] : "");
    });
  });
}

/**
 * Seed the engine's SDK directories before it starts, once per launch. In a
 * fresh profile the engine's own first install leaves its first read stalled
 * until a restart (see `engine-sdk.mjs`); a seeded directory makes that install
 * a no-op. Bounded and best effort: without an installer or a network the
 * engine's own path still applies.
 */
let engineSdkPrepared = null;
function prepareEngineSdkOnce(binary) {
  engineSdkPrepared ??= (async () => {
    const version = await resolveOpencodeVersion(binary);
    return prepareEngineSdk({ version, log: debugLog });
  })().catch((error) => {
    console.warn("[open-coworker] could not prepare the AI service's SDK directory", error);
    return { version: "", results: [], installer: "" };
  });
  return engineSdkPrepared;
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
    await prepareEngineSdkOnce(resolveOpencodeBin());
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
  warmedCoworkerWorkspaces.clear();
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

/** The efforts each model offers, read from the engine once per model per launch; "" when it could not be read. */
const variantsByModel = new Map();

async function modelVariantsFor(coworker) {
  const preference = String(coworker?.model ?? "").trim();
  if (!preference || !coworker?.workspaceId) return null;
  if (variantsByModel.has(preference)) return variantsByModel.get(preference);
  try {
    const handle = await ensurePlatformServer();
    const payload = await fetchJson(`${handle.url}/workspace/${encodeURIComponent(coworker.workspaceId)}/opencode/config/providers`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const separator = preference.indexOf("/");
    const provider = (payload?.providers ?? []).find((entry) => entry.id === preference.slice(0, separator));
    const variants = Object.keys(provider?.models?.[preference.slice(separator + 1)]?.variants ?? {});
    variantsByModel.set(preference, variants);
    return variants;
  } catch {
    return null;
  }
}

/**
 * The model a background turn runs on, with the effort the dial decides for
 * that kind of turn (an assignment run, a Worker turn, a review) — an exact
 * effort the person fixed wins. When the model's efforts cannot be read, the
 * fixed effort is passed as it is and the dial stays out of it.
 */
async function localRunModel(coworker, kind = "assignment-run") {
  const preference = String(coworker?.model ?? "").trim();
  const separator = preference.indexOf("/");
  if (separator <= 0 || separator === preference.length - 1) return undefined;
  const fixedVariant = String(coworker?.modelVariant ?? "").trim();
  const variants = await modelVariantsFor(coworker);
  const variant = variants === null
    ? fixedVariant
    : effortForTurn({ kind, stop: effortStopOf(coworker?.effortPreference), fixedVariant, variants });
  return {
    providerId: preference.slice(0, separator),
    modelId: preference.slice(separator + 1),
    variant: variant || undefined,
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
async function executeLocalResponsibility(
  slug,
  id,
  { trigger = "manual", runId = "", resumeThreadId = "", resumeReason = "", onStarted = () => undefined } = {},
) {
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
      onStarted();
      return;
    }
    // The run record is on disk: admission can answer, and the UI can read a consistent state.
    onStarted();
    const activeRunId = started.latestRun.id;
    try {
      const handle = await ensurePlatformServer();
      if (!handle.managedOpencode) throw new Error(engineError || "AI is unavailable on this Mac");
      const client = createHeadlessThreadClient({
        baseUrl: handle.url,
        workspaceId: coworker.workspaceId,
        token: ownerToken,
        defaultModel: await localRunModel(coworker, "assignment-run"),
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

/** Launch a run and resolve once its record exists (or it could not start); the run itself continues detached. */
function launchLocalRun(slug, id, options) {
  return new Promise((resolve) => {
    void executeLocalResponsibility(slug, id, { ...options, onStarted: resolve });
  });
}

function isQueued(key) {
  return queuedLocalRuns.some((entry) => entry.key === key);
}

function removeQueuedRun(key) {
  const index = queuedLocalRuns.findIndex((entry) => entry.key === key);
  return index === -1 ? null : queuedLocalRuns.splice(index, 1)[0];
}

function queuedResponsibilityRun(slug, id, runId) {
  return { key: `${slug}:${id}`, slug, id, runId, launch: () => launchLocalRun(slug, id, { runId }) };
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
      queuedLocalRuns.push(queuedResponsibilityRun(slug, id, queued.latestRun.id));
      return { accepted: true, queued: true, reason: "" };
    }
    activeLocalRuns.add(key);
    await launchLocalRun(slug, id, { trigger });
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
    await launchLocalRun(slug, id, { trigger: "resume", resumeThreadId: last.threadId, resumeReason: last.error });
    return { accepted: true, reason: "" };
  });
}

async function cancelQueuedLocalResponsibilityRun(slug, id) {
  const entry = removeQueuedRun(`${slug}:${id}`);
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
      await next.launch();
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

// ---------------------------------------------------------------------------
// Workers: long-lived sub-agents in a coworker's own workspace. Each Worker
// turn is one bounded native turn that takes a slot on this Mac like a
// responsibility run and releases it when it settles; every finding wakes the
// coworker in its open discussion. Records live in `electron/workers.mjs`.

/** Worker turns in flight in this process: `slug:wrk_…` → controller that cancels the wait. */
const liveWorkerTurns = new Map();
/** Steering that arrived while a turn ran or the Worker waited; delivered as its next turn. */
const pendingWorkerSteers = new Map();
let workersRecovered = false;
const REVIEW_IDLE_WAIT_MS = 5 * 60_000;
const REVIEW_TURN_TIMEOUT_MS = 15 * 60_000;
const WORKER_TURN_TIMEOUT_MS = 60 * 60_000;

const workerReviews = createReviewScheduler({
  review: (slug, findings) => reviewWorkerFindings(slug, findings),
  onDropped: (slug, findings) => {
    void recordDroppedReview(slug, findings);
  },
});

function workerKey(slug, id) {
  return `${slug}:${id}`;
}

/** A thread client in the coworker's workspace, on its own model at the effort the dial gives this kind of turn; throws when AI is unavailable here. */
async function readyWorkerClient(coworker, kind = "worker-turn") {
  const handle = await ensurePlatformServer();
  if (!handle.managedOpencode) throw new Error(engineError || "AI is unavailable on this Mac");
  if (!coworker.workspaceId) throw new Error("This coworker's workspace is not ready yet.");
  return createHeadlessThreadClient({
    baseUrl: handle.url,
    workspaceId: coworker.workspaceId,
    token: ownerToken,
    defaultModel: await localRunModel(coworker, kind),
  });
}

/**
 * Keep the one working-memory line Open Coworker writes for a Worker on the
 * coworker's behalf (started, latest finding, waiting for a decision, cleared
 * once it ends). Best effort: a full working memory or a refused text is
 * logged and never touches the Worker itself.
 */
async function syncWorkerNote(slug, worker, finding = null) {
  if (!worker) return;
  await noteProgress(coworkersDir, slug, workerProgressNote(worker, finding)).catch((error) => {
    console.warn(`[open-coworker] could not keep the working-memory line for Worker ${worker.id}`, error instanceof Error ? error.message : error);
  });
}

async function spawnWorker(slug, input, spawnedBy) {
  const coworker = await getCoworker(coworkersDir, slug);
  if (!coworker.workspaceId) throw new Error("This coworker's workspace is not ready yet.");
  // Nobody chose a lifespan: the effort dial says how much work is welcome (6 … 20 turns; 10 at Balanced).
  const lifespan = input.lifespan === undefined || input.lifespan === null
    ? { kind: "turns", max: workerTurnsFor(effortStopOf(coworker.effortPreference)), used: 0 }
    : input.lifespan;
  const worker = await createWorker(coworkersDir, slug, { ...input, lifespan, spawnedBy });
  await appendWorkerEvent(coworkersDir, slug, worker.id, {
    kind: "status",
    text: spawnedBy === "coworker" ? `Started by ${coworker.name}` : "Started by you",
    by: spawnedBy,
  });
  await syncWorkerNote(slug, worker);
  void admitWorkerTurn(slug, worker.id);
  return worker;
}

/** Take a slot for the Worker's next turn now, or wait in line with the other runs on this Mac. */
function admitWorkerTurn(slug, id) {
  return admitLocalRun(async () => {
    const key = workerKey(slug, id);
    if (activeLocalRuns.has(key) || isQueued(key)) return;
    const worker = await getWorker(coworkersDir, slug, id).catch(() => null);
    if (!worker || isWorkerFinished(worker) || worker.status === "paused") return;
    const limit = await parallelRunLimit();
    if (activeLocalRuns.size >= limit) {
      queuedLocalRuns.push({ key, slug, id, runId: "", launch: () => launchWorkerTurn(slug, id) });
      await updateWorker(coworkersDir, slug, id, { status: "waiting", waitingFor: "turn" }).catch(() => undefined);
      return;
    }
    activeLocalRuns.add(key);
    await launchWorkerTurn(slug, id);
  });
}

/** Resolve once the turn is recorded as running (or could not start); the turn itself continues detached. */
function launchWorkerTurn(slug, id) {
  return new Promise((resolve) => {
    void executeWorkerTurn(slug, id, { onStarted: resolve });
  });
}

async function executeWorkerTurn(slug, id, { onStarted }) {
  const key = workerKey(slug, id);
  let continueAfter = false;
  try {
    let worker;
    let coworker;
    try {
      worker = await getWorker(coworkersDir, slug, id);
      coworker = await getCoworker(coworkersDir, slug);
      if (isWorkerFinished(worker) || worker.status === "paused") {
        onStarted();
        return;
      }
      if (lifespanSpent(worker.lifespan)) {
        const finished = await updateWorker(coworkersDir, slug, id, { status: "finished" });
        await appendWorkerEvent(coworkersDir, slug, id, { kind: "status", text: "Finished: reached the end of its lifespan." });
        await syncWorkerNote(slug, finished);
        onStarted();
        return;
      }
      worker = await updateWorker(coworkersDir, slug, id, { status: "running", waitingFor: "" });
    } catch (error) {
      console.warn(`[open-coworker] Worker ${key} did not start a turn`, error);
      onStarted();
      return;
    }
    onStarted();
    const controller = new AbortController();
    liveWorkerTurns.set(key, controller);
    try {
      const client = await readyWorkerClient(coworker);
      const steers = pendingWorkerSteers.get(key) ?? [];
      pendingWorkerSteers.delete(key);
      const body = steers.length > 0 ? steerBody(steers, coworker.name) : worker.threadId ? CONTINUE_BODY : BEGIN_BODY;
      const prompt = workerTurnPrompt({ worker, coworkerName: coworker.name, body });
      let threadId = worker.threadId;
      let acceptance;
      if (threadId) {
        acceptance = await client.sendTurn(threadId, { prompt, signal: controller.signal });
      } else {
        const thread = await client.createThread({ title: workerThreadTitle(worker.name), prompt, signal: controller.signal });
        threadId = thread.id;
        await registerWorkerThread(coworkersDir, slug, threadId);
        await updateWorker(coworkersDir, slug, id, { threadId });
      }
      const result = await client.waitForThread(threadId, {
        timeoutMs: WORKER_TURN_TIMEOUT_MS,
        pollIntervalMs: 1_000,
        signal: controller.signal,
        ...(acceptance ? { since: acceptance } : {}),
      });
      // Stopped while it ran: the stop already recorded itself.
      if (controller.signal.aborted) return;
      const settled = result.outcome === "settled" && !result.terminalError;
      const outcome = settled
        ? { kind: "settled", report: parseWorkerReport(toTranscript(result.snapshot).finalAssistantText) }
        : {
            kind: "failed",
            error: result.terminalError?.message
              || (result.outcome === "timeout" ? "The turn timed out after one hour" : `The turn ${result.outcome}`),
          };
      continueAfter = await settleWorkerTurn(slug, id, outcome);
    } catch (error) {
      if (!controller.signal.aborted) {
        continueAfter = await settleWorkerTurn(slug, id, { kind: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      liveWorkerTurns.delete(key);
    }
  } finally {
    activeLocalRuns.delete(key);
    // Runs already in line go first; this Worker's next turn asks for a slot after them.
    void drainLocalRunQueue();
    if (continueAfter) void admitWorkerTurn(slug, id);
  }
}

/** Record what a settled turn meant and wake the coworker for anything it reported; returns whether to take another turn. */
async function settleWorkerTurn(slug, id, outcome) {
  const key = workerKey(slug, id);
  const now = Date.now();
  let current;
  try {
    current = await getWorker(coworkersDir, slug, id);
  } catch {
    return false;
  }
  const step = nextWorkerState(current, outcome, { now, hasPendingSteer: (pendingWorkerSteers.get(key) ?? []).length > 0 });
  const updated = Object.keys(step.patch).length > 0
    ? await updateWorker(coworkersDir, slug, id, step.patch, { now }).catch(() => current)
    : current;
  let latestFinding = null;
  for (const event of step.events) {
    const recorded = await appendWorkerEvent(coworkersDir, slug, id, event, { now }).catch(() => null);
    if (!recorded) continue;
    if (event.kind === "finding") {
      latestFinding = recorded;
      workerReviews.add(slug, { id: recorded.id, workerId: id, workerName: updated.name, report: recorded.report, text: recorded.text });
    } else if (updated.status === "failed") {
      workerReviews.add(slug, { id: recorded.id, workerId: id, workerName: updated.name, report: "failed", text: updated.error || recorded.text });
    }
  }
  // A turn that reported nothing leaves the line as it was; a finding or an ending rewrites it.
  if (latestFinding || isWorkerFinished(updated)) await syncWorkerNote(slug, updated, latestFinding);
  return step.schedule === "continue";
}

async function steerWorker(slug, id, text, by) {
  const message = String(text ?? "").trim();
  if (!message) throw new Error("Say what the Worker should do differently.");
  const key = workerKey(slug, id);
  const worker = await getWorker(coworkersDir, slug, id);
  if (isWorkerFinished(worker)) throw new Error("This Worker has already stopped.");
  await appendWorkerEvent(coworkersDir, slug, id, { kind: "steer", text: message, by });
  const steers = pendingWorkerSteers.get(key) ?? [];
  steers.push({ by, text: message });
  pendingWorkerSteers.set(key, steers);
  const updated = await updateWorker(coworkersDir, slug, id, {
    steerCount: worker.steerCount + 1,
    ...(worker.status === "waiting" ? { waitingFor: "turn" } : {}),
  });
  // A waiting Worker takes the steer as its next turn now; a running one when its turn settles; a paused one when resumed.
  if (worker.status === "waiting" || worker.status === "starting") void admitWorkerTurn(slug, id);
  return updated;
}

async function cancelWorker(slug, id, reason, by) {
  const key = workerKey(slug, id);
  const worker = await getWorker(coworkersDir, slug, id);
  if (isWorkerFinished(worker)) return worker;
  removeQueuedRun(key);
  pendingWorkerSteers.delete(key);
  const updated = await updateWorker(coworkersDir, slug, id, { status: "cancelled" });
  const why = String(reason ?? "").trim();
  await appendWorkerEvent(coworkersDir, slug, id, { kind: "status", text: why ? `Stopped: ${why}` : "Stopped", by });
  await syncWorkerNote(slug, updated);
  const controller = liveWorkerTurns.get(key);
  if (controller) {
    controller.abort();
    if (worker.threadId) {
      const coworker = await getCoworker(coworkersDir, slug).catch(() => null);
      if (coworker) await readyWorkerClient(coworker).then((client) => client.abortThread(worker.threadId)).catch(() => undefined);
    }
  }
  return updated;
}

async function pauseWorker(slug, id) {
  const worker = await getWorker(coworkersDir, slug, id);
  if (isWorkerFinished(worker)) throw new Error("This Worker has already stopped.");
  if (worker.status === "paused") return worker;
  removeQueuedRun(workerKey(slug, id));
  const updated = await updateWorker(coworkersDir, slug, id, { status: "paused", waitingFor: "" });
  await appendWorkerEvent(coworkersDir, slug, id, {
    kind: "status",
    text: worker.status === "running" ? "Paused; it finishes its current step first." : "Paused",
  });
  await syncWorkerNote(slug, updated);
  return updated;
}

async function resumeWorker(slug, id) {
  const worker = await getWorker(coworkersDir, slug, id);
  if (worker.status !== "paused") return worker;
  const updated = await updateWorker(coworkersDir, slug, id, { status: "waiting", waitingFor: "turn" });
  await appendWorkerEvent(coworkersDir, slug, id, { kind: "status", text: "Resumed" });
  await syncWorkerNote(slug, updated);
  void admitWorkerTurn(slug, id);
  return updated;
}

/**
 * Workers left mid-turn by a quit or crash pick up again once the engine is
 * ready, waiting their turn like any run. A Worker waiting for a decision
 * keeps waiting; a paused one stays paused.
 */
async function recoverInterruptedWorkers() {
  if (workersRecovered || !serverHandle?.managedOpencode) return;
  workersRecovered = true;
  for (const coworker of await listCoworkers(coworkersDir)) {
    for (const worker of await listWorkers(coworkersDir, coworker.slug).catch(() => [])) {
      const key = workerKey(coworker.slug, worker.id);
      if (isWorkerFinished(worker) || worker.status === "paused" || activeLocalRuns.has(key) || isQueued(key)) continue;
      if (worker.status === "waiting" && worker.waitingFor === "decision") continue;
      if (worker.status === "running" || worker.status === "starting") {
        await updateWorker(coworkersDir, coworker.slug, worker.id, { status: "waiting", waitingFor: "turn" }).catch(() => undefined);
        await appendWorkerEvent(coworkersDir, coworker.slug, worker.id, { kind: "status", text: RECOVERED_STATUS }).catch(() => undefined);
      }
      void admitWorkerTurn(coworker.slug, worker.id);
    }
  }
}

/**
 * Wake the coworker: one normal turn in its open discussion carrying the new
 * findings. It never interleaves with a reply in progress or a turn waiting
 * on the person; without an open discussion the findings are held.
 */
async function reviewWorkerFindings(slug, findings) {
  const coworker = await getCoworker(coworkersDir, slug);
  if (!coworker.workspaceId || !coworker.conversationThreadId || !serverHandle?.managedOpencode) return "hold";
  const client = await readyWorkerClient(coworker, "review");
  const threadId = coworker.conversationThreadId;
  const idle = await client.waitUntilIdle(threadId, { timeoutMs: REVIEW_IDLE_WAIT_MS, pollIntervalMs: 1_000 });
  if (idle.outcome !== "settled") return "hold";
  const workers = await listWorkers(coworkersDir, slug);
  const mentioned = new Set(findings.map((finding) => finding.workerId));
  const prompt = reviewPrompt({
    coworkerName: coworker.name,
    workers: workers.filter((worker) => !isWorkerFinished(worker) || mentioned.has(worker.id)),
    findings,
    toolsAvailable: toolsRegistered.has(slug),
  });
  const acceptance = await client.sendTurn(threadId, { prompt });
  const result = await client.waitForThread(threadId, { timeoutMs: REVIEW_TURN_TIMEOUT_MS, pollIntervalMs: 1_000, since: acceptance });
  const failure = result.outcome !== "settled" || result.terminalError
    ? result.terminalError?.message || `The review ${result.outcome}`
    : "";
  const now = Date.now();
  for (const workerId of mentioned) {
    await appendWorkerEvent(coworkersDir, slug, workerId, {
      kind: "review",
      text: failure ? `${coworker.name} could not review this yet.` : `${coworker.name} reviewed this.`,
      reviewThreadId: threadId,
      findingIds: findings.filter((finding) => finding.workerId === workerId).map((finding) => finding.id),
      ...(failure ? { error: failure } : {}),
    }, { now }).catch(() => undefined);
  }
  if (failure) throw new Error(failure);
  return "reviewed";
}

async function recordDroppedReview(slug, findings) {
  for (const workerId of new Set(findings.map((finding) => finding.workerId))) {
    await appendWorkerEvent(coworkersDir, slug, workerId, {
      kind: "review",
      text: "Not reviewed: the coworker's reply failed twice. The findings stay here.",
      findingIds: findings.filter((finding) => finding.workerId === workerId).map((finding) => finding.id),
      error: "Review failed twice",
    }).catch(() => undefined);
  }
}

async function runDueLocalResponsibilities() {
  const now = Date.now();
  await recoverInterruptedWorkers().catch((error) => {
    console.warn("[open-coworker] Worker recovery failed", error);
  });
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
        queuedLocalRuns.push(queuedResponsibilityRun(coworker.slug, responsibility.id, persistedQueue.id));
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

// OpenCode initializes plug-ins per workspace directory. A team landing in the
// main screen can otherwise ask it to initialize every new coworker at once,
// which is both slower and vulnerable to shared first-boot work colliding.
// Keep that cold path one-at-a-time and remember completed work for this engine
// process; normal reads remain fully concurrent after the warm-up.
const warmedCoworkerWorkspaces = new Set();
const coworkerWarmups = new Map();
let coworkerWarmupTail = Promise.resolve();

async function runCoworkerWorkspaceWarmup(coworker) {
  let handle = await ensurePlatformServer();
  if (!handle.managedOpencode || !coworker?.workspaceId) return;
  let lastError = null;
  // OpenCode's very first project request also prepares its SDK directory.
  // In a blank profile that request can stay attached to the installer even
  // after the files are ready. Bound it once, restart the still-idle engine,
  // then make the real readiness read against the prepared directory.
  for (const [attempt, timeoutMs] of [20_000, 60_000].entries()) {
    try {
      const response = await fetch(
        // The connected-providers read: a few kilobytes, and it is the same bootstrap the full list would wait on.
        `${handle.url}/workspace/${encodeURIComponent(coworker.workspaceId)}/opencode/config/providers`,
        {
          headers: { Authorization: `Bearer ${ownerToken}` },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (response.ok) {
        await response.arrayBuffer();
        warmedCoworkerWorkspaces.add(coworker.workspaceId);
        return;
      }
      lastError = new Error(`AI service answered with HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt === 0) {
      handle = await restartPlatformServer();
      if (!handle.managedOpencode) break;
    }
  }
  throw new Error(
    `The AI service did not finish preparing ${coworker.name}. ${lastError instanceof Error ? lastError.message : "Try again."}`,
  );
}

function warmCoworkerWorkspace(coworker) {
  if (!coworker?.workspaceId || warmedCoworkerWorkspaces.has(coworker.workspaceId)) return Promise.resolve();
  const current = coworkerWarmups.get(coworker.workspaceId);
  if (current) return current;
  const warmup = coworkerWarmupTail
    .catch(() => undefined)
    .then(() => runCoworkerWorkspaceWarmup(coworker))
    .finally(() => coworkerWarmups.delete(coworker.workspaceId));
  coworkerWarmups.set(coworker.workspaceId, warmup);
  coworkerWarmupTail = warmup;
  return warmup;
}

// ---------------------------------------------------------------------------
// Coworker tools: the app's own MCP server on loopback (documents and the
// active context around them). One bearer token per coworker names the
// coworker; the endpoint is registered in each workspace like any remote MCP.

/** @type {Awaited<ReturnType<typeof createCoworkerToolsServer>> | null} */
let toolsServer = null;
let startingToolsServer = null;
/** slug → bearer token minted for this launch; the reverse map answers the server. */
const coworkerToolTokens = new Map();
const toolTokenSlugs = new Map();
/** Coworkers whose workspace carries this launch's tools registration. */
const toolsRegistered = new Set();
/** Registrations in flight, so the coworker lists the renderer asks for while booting share one request each. */
const toolsRegistering = new Map();
/** Contracts already brought up to date this launch, so the repair runs once per coworker. */
const contractsRepaired = new Set();

function coworkerToolToken(slug) {
  let token = coworkerToolTokens.get(slug);
  if (!token) {
    token = randomBytes(24).toString("hex");
    coworkerToolTokens.set(slug, token);
    toolTokenSlugs.set(token, slug);
  }
  return token;
}

async function ensureToolsServer() {
  if (toolsServer) return toolsServer;
  // Documents and Workers share one server: starting, steering, and stopping a Worker go
  // through the same functions the Workers view uses, so the run limit and records agree.
  // Documents, Workers, assignments, and memory share one server: each goes through the same
  // functions the panel views use, so the run limit, the guardrails, and the records agree.
  startingToolsServer ??= createCoworkerToolsServer({
    resolveSlug: (token) => toolTokenSlugs.get(token) ?? null,
    handlers: {
      ...createToolHandlers({ coworkersDir }),
      ...createWorkerToolHandlers({
        coworkersDir,
        spawn: (slug, input) => spawnWorker(slug, input, "coworker"),
        steer: (slug, id, text) => steerWorker(slug, id, text, "coworker"),
        cancel: (slug, id, reason) => cancelWorker(slug, id, reason, "coworker"),
      }),
      ...createAssignmentToolHandlers({
        coworkersDir,
        settings: () => readSettings(settingsPath),
        timezone: coworkerTimezone,
        runNow: (slug, id) => startLocalResponsibilityRun(slug, id, "manual"),
        cloud: () => cloudAssignments(),
      }),
      ...createSelfToolHandlers({ coworkersDir }),
      ...createTeamToolHandlers({ coworkersDir }),
    },
    tools: [...toolCatalog(), ...workerToolCatalog(), ...assignmentToolCatalog(), ...selfToolCatalog(), ...teamToolCatalog()],
    // One line naming the server; the rules for each tool family are in the coworker's contract, said once.
    instructions: DEFAULT_INSTRUCTIONS,
    version: app.getVersion(),
  }).then((server) => {
    toolsServer = server;
    return server;
  }).finally(() => {
    startingToolsServer = null;
  });
  return startingToolsServer;
}

/**
 * Register (or refresh) this launch's tools endpoint in one coworker workspace
 * through the embedded server, which hot-adds it to the running engine and
 * re-adds it after an engine restart. Best effort: a coworker without the
 * tools still talks; it just cannot write documents until the next attempt.
 */
async function registerCoworkerTools(coworker) {
  if (!coworker?.workspaceId) return false;
  const [handle, server] = await Promise.all([ensurePlatformServer(), ensureToolsServer()]);
  await fetchJson(`${handle.url}/workspace/${encodeURIComponent(coworker.workspaceId)}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: COWORKER_TOOLS_MCP_NAME, config: server.mcpConfig(coworkerToolToken(coworker.slug)) }),
  }, 30_000);
  toolsRegistered.add(coworker.slug);
  return true;
}

/** Bring one coworker up to the current contract and give it its tools; never blocks the list. */
function prepareCoworker(coworker) {
  if (!contractsRepaired.has(coworker.slug)) {
    contractsRepaired.add(coworker.slug);
    void repairCoworkerContract(coworkersDir, coworker.slug).catch((error) => {
      console.warn(`[open-coworker] could not repair the contract for ${coworker.slug}`, error);
    });
  }
  if (coworker.workspaceId && !toolsRegistered.has(coworker.slug) && !toolsRegistering.has(coworker.slug)) {
    const registration = registerCoworkerTools(coworker)
      .catch((error) => {
        console.warn(`[open-coworker] could not register the document tools for ${coworker.slug}`, error);
      })
      .finally(() => {
        toolsRegistering.delete(coworker.slug);
      });
    toolsRegistering.set(coworker.slug, registration);
  }
}

/**
 * Repair imported or pre-registration coworker records during normal startup.
 * The filesystem home already exists; this completes its native OpenWork
 * workspace registration and persists the platform id before the UI lists it.
 */
async function listPreparedCoworkers() {
  const coworkers = await listCoworkers(coworkersDir);
  if (!coworkers.some((coworker) => !coworker.workspaceId)) {
    for (const coworker of coworkers) {
      await warmCoworkerWorkspace(coworker).catch((error) => {
        console.warn(`[open-coworker] could not warm ${coworker.slug}`, error);
      });
      prepareCoworker(coworker);
    }
    return coworkers;
  }

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
  for (const coworker of prepared) {
    await warmCoworkerWorkspace(coworker).catch((error) => {
      console.warn(`[open-coworker] could not warm ${coworker.slug}`, error);
    });
    prepareCoworker(coworker);
  }
  return prepared;
}

/** The silent facilitator's hidden workspace, registered on first use; never listed as a coworker. */
async function ensureCoordinatorWorkspace() {
  await ensurePlatformServer();
  const coordinator = await ensureCoordinatorHome(coworkersDir);
  if (coordinator.workspaceId) {
    await warmCoworkerWorkspace(coordinator);
    return coordinator;
  }
  const workspaceId = await registerCoworkerWorkspace(coordinator);
  const updated = await updateCoordinator(coworkersDir, { workspaceId });
  if (!serverHandle?.managedOpencode) await restartPlatformServer();
  await warmCoworkerWorkspace(updated);
  return updated;
}

// ---------------------------------------------------------------------------
// AI providers on this Mac. Detection is `electron/local-providers.mjs`; the
// connect steps below only ever use the engine's own credential store
// (`PUT`/`DELETE /auth/{provider}`), its own sign-in flows, and the embedded
// server's runtime provider config — the same paths OpenWork Desktop uses. A
// secret travels from a sign-in file or the person's own typing straight to
// the engine over loopback; this process keeps none of it and logs none of it.

class EngineRequestError extends Error {
  constructor(status, body) {
    super(engineErrorMessage(status, body));
    this.name = "EngineRequestError";
    this.status = status;
    this.body = body;
  }
}

function engineErrorMessage(status, body) {
  const data = body && typeof body === "object" ? body : {};
  const nested = data.data && typeof data.data === "object" ? data.data : {};
  const message = [nested.message, data.message].find((value) => typeof value === "string" && value.trim());
  return message ? message.trim() : `The AI service answered with HTTP ${status}.`;
}

/** A workspace to reach the engine through: the first coworker's, else the hidden coordinator's. */
async function providerWorkspaceId() {
  const coworkers = await listCoworkers(coworkersDir).catch(() => []);
  const ready = coworkers.find((coworker) => coworker.workspaceId);
  if (ready) return ready.workspaceId;
  return (await ensureCoordinatorWorkspace()).workspaceId;
}

async function engineRequest(method, enginePath, body, { timeoutMs = 20_000, signal } = {}) {
  const workspaceId = await providerWorkspaceId();
  const handle = await ensurePlatformServer();
  if (!handle.managedOpencode) throw new Error(engineError || "AI is unavailable on this Mac");
  const response = await fetch(`${handle.url}/workspace/${encodeURIComponent(workspaceId)}/opencode${enginePath}`, {
    method,
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) throw new EngineRequestError(response.status, json);
  return json;
}

/**
 * Bring a credential change into effect everywhere. The engine keeps one
 * instance per workspace directory and reads its credential store when an
 * instance is built, so every registered workspace is reloaded through the
 * embedded server (which also re-attaches each workspace's tools); `force`
 * because a store change is invisible to the server's config fingerprint.
 */
async function reloadEngine() {
  await providerWorkspaceId();
  const handle = await ensurePlatformServer();
  const headers = { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" };
  const listed = await fetchJson(`${handle.url}/workspaces`, { headers });
  const ids = (Array.isArray(listed?.items) ? listed.items : [])
    .map((workspace) => (typeof workspace?.id === "string" ? workspace.id : ""))
    .filter(Boolean);
  for (const id of ids) {
    await fetchJson(`${handle.url}/workspace/${encodeURIComponent(id)}/engine/reload`, {
      method: "POST",
      headers,
      body: JSON.stringify({ force: true }),
    }, 60_000).catch((error) => {
      console.warn(`[open-coworker] could not reload the AI service for workspace ${id}`, error);
    });
  }
}

/** Poll the provider list until it agrees with `expectConnected`, since a busy engine rolls over in the background. */
async function waitForProvider(providerId, expectConnected, { timeoutMs = 30_000, pollMs = 750 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await readConnectedProviders().catch(() => [])).find((entry) => entry.id === providerId) ?? null;
    if ((last !== null) === expectConnected) return last ? last.modelCount : 0;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return last ? last.modelCount : 0;
}

function summarizeProvider(provider, connected) {
  return {
    id: String(provider.id ?? ""),
    name: typeof provider.name === "string" && provider.name.trim() ? provider.name.trim() : String(provider.id ?? ""),
    env: Array.isArray(provider.env) ? provider.env.filter((name) => typeof name === "string") : [],
    source: typeof provider.source === "string" ? provider.source : "",
    connected,
    modelCount: provider.models && typeof provider.models === "object" ? Object.keys(provider.models).length : 0,
  };
}

/** Every provider the engine knows, connected or not: megabytes, read only when a screen needs the whole list. */
async function readEngineProviders() {
  const payload = await engineRequest("GET", "/provider");
  const connected = new Set(Array.isArray(payload?.connected) ? payload.connected : []);
  return (Array.isArray(payload?.all) ? payload.all : []).map((provider) => summarizeProvider(provider, connected.has(provider.id)));
}

/** Only the connected providers: kilobytes, so it can be polled while a change takes effect. */
async function readConnectedProviders() {
  const payload = await engineRequest("GET", "/config/providers");
  return (Array.isArray(payload?.providers) ? payload.providers : []).map((provider) => summarizeProvider(provider, true));
}

/** The engine's own sign-in methods: provider id → labels of its browser/device flows. */
async function readEngineSignIns() {
  const methods = await engineRequest("GET", "/provider/auth").catch(() => ({}));
  return Object.fromEntries(
    Object.entries(methods && typeof methods === "object" ? methods : {}).map(([providerId, list]) => [
      providerId,
      (Array.isArray(list) ? list : []).flatMap((method, index) => (method?.type === "oauth" ? [{ index, label: String(method.label ?? "") }] : [])),
    ]).filter(([, list]) => list.length > 0),
  );
}

async function connectedModelCount(providerId) {
  const provider = (await readConnectedProviders()).find((entry) => entry.id === providerId);
  return provider ? provider.modelCount : 0;
}

/** Store a credential in the engine's own store and bring it into effect. */
async function storeCredential(providerId, auth) {
  await engineRequest("PUT", `/auth/${encodeURIComponent(providerId)}`, auth);
  await reloadEngine();
  return waitForProvider(providerId, true);
}

async function patchRuntimeProviders(patch) {
  const handle = await ensurePlatformServer();
  const tokens = await loadOrCreateTokens();
  return fetchJson(`${handle.url}/runtime-config/providers`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-OpenWork-Host-Token": tokens.hostToken },
    body: JSON.stringify({ provider: patch }),
  }, 90_000);
}

async function readRuntimeProviderIds() {
  const handle = await ensurePlatformServer();
  const tokens = await loadOrCreateTokens();
  const payload = await fetchJson(`${handle.url}/runtime-config/providers`, { headers: { "X-OpenWork-Host-Token": tokens.hostToken } });
  return Object.keys(payload?.provider && typeof payload.provider === "object" ? payload.provider : {});
}

function connectedResult(providerId, label, modelCount) {
  return { status: "connected", providerId, label, modelCount };
}

function plainConnectError(error) {
  if (error instanceof SignInImportError) return error.message;
  if (error instanceof EngineRequestError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Connect one detected finding in one step: a Codex or Copilot sign-in goes to
 * the engine as the credential its own sign-in would have stored; a local
 * server becomes an engine provider pointed at its address.
 */
async function connectLocalProvider(id) {
  const { found } = await detectLocalProviders({ log: debugLog });
  const finding = found.find((entry) => entry.id === id);
  if (!finding) throw new Error("That is no longer on this Mac. Refresh and try again.");
  if (finding.how === "in-use") return connectedResult(finding.providerId, finding.label, await connectedModelCount(finding.providerId));
  if (finding.how === "unavailable") throw new Error(finding.reason);
  try {
    if (finding.kind === "codex") {
      const parsed = JSON.parse(await readFile(codexAuthPath(process.env, homedir()), "utf8"));
      const modelCount = await storeCredential("openai", codexAuthFromFile(parsed));
      return connectedResult("openai", finding.label, modelCount);
    }
    if (finding.kind === "copilot") {
      const directory = copilotConfigDir(process.env, homedir());
      const files = await Promise.all(["apps.json", "hosts.json"].map((file) => readFile(path.join(directory, file), "utf8").then(JSON.parse).catch(() => null)));
      const parsed = files.find((file) => file && copilotSignedIn(file));
      const modelCount = await storeCredential("github-copilot", copilotAuthFromFile(parsed));
      return connectedResult("github-copilot", finding.label, modelCount);
    }
    if (finding.kind === "server") {
      await patchRuntimeProviders(localServerProviderPatch(finding));
      return connectedResult(finding.providerId, finding.label, await waitForProvider(finding.providerId, true));
    }
  } catch (error) {
    if (error instanceof SignInImportError) {
      return { status: "failed", providerId: finding.providerId, label: finding.label, error: expiredSignInMessage(finding), fallback: "sign-in" };
    }
    throw new Error(plainConnectError(error));
  }
  throw new Error("This cannot be connected here.");
}

function expiredSignInMessage(finding) {
  if (finding.kind === "codex") return "Codex's sign-in has expired — sign in again in Codex, then Connect.";
  if (finding.kind === "copilot") return "Copilot's sign-in has expired — sign in again in your editor, then Connect.";
  return "This sign-in has expired.";
}

/** A key the person typed goes straight to the engine's store; nothing here keeps it. */
async function saveProviderKey(providerId, key) {
  const trimmedId = String(providerId ?? "").trim();
  const trimmedKey = String(key ?? "").trim();
  if (!trimmedId) throw new Error("Choose a provider first.");
  if (!trimmedKey) throw new Error("Paste the key first.");
  const provider = (await readEngineProviders()).find((entry) => entry.id === trimmedId);
  if (!provider) throw new Error("That provider is not offered here.");
  const modelCount = await storeCredential(trimmedId, { type: "api", key: trimmedKey });
  return connectedResult(trimmedId, provider.name, modelCount);
}

/** Sign-in attempts in flight: the engine waits on the browser or device flow while the renderer polls here. */
const signInAttempts = new Map();
const SIGN_IN_WAIT_MS = 15 * 60_000;

function codeFromInstructions(instructions) {
  const match = /code:?\s*([A-Z0-9][A-Z0-9-]{3,})/i.exec(String(instructions ?? ""));
  return match ? match[1] : "";
}

function plainSignInError(error) {
  const message = plainConnectError(error);
  if (/ProviderAuthOauthCallbackFailed|callback failed/i.test(message)) return "The sign-in did not finish. Try again.";
  if (/timed out|TimeoutError|aborted/i.test(message)) return "The sign-in took too long. Try again.";
  return message;
}

/** Start the engine's own sign-in for a provider and wait for it in the background. */
async function startProviderSignIn(providerId, methodIndex) {
  const trimmedId = String(providerId ?? "").trim();
  const signIns = await readEngineSignIns();
  const methods = signIns[trimmedId] ?? [];
  const chosen = methods.find((method) => method.index === methodIndex) ?? methods[0];
  if (!chosen) throw new Error("This provider has no sign-in here. Add a key instead.");
  const inputs = trimmedId === "github-copilot" ? { deploymentType: "github.com" } : {};
  const authorization = await engineRequest("POST", `/provider/${encodeURIComponent(trimmedId)}/oauth/authorize`, { method: chosen.index, inputs });
  const attemptId = `sia_${randomBytes(6).toString("hex")}`;
  const controller = new AbortController();
  const attempt = { id: attemptId, providerId: trimmedId, state: "waiting", error: "", modelCount: 0, controller };
  signInAttempts.set(attemptId, attempt);
  void engineRequest("POST", `/provider/${encodeURIComponent(trimmedId)}/oauth/callback`, { method: chosen.index }, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(SIGN_IN_WAIT_MS)]),
  })
    .then(async () => {
      await reloadEngine();
      attempt.modelCount = await waitForProvider(trimmedId, true);
      attempt.state = attempt.modelCount > 0 ? "connected" : "failed";
      attempt.error = attempt.modelCount > 0 ? "" : "The sign-in finished, but no models became available.";
    })
    .catch((error) => {
      if (controller.signal.aborted) return;
      attempt.state = "failed";
      attempt.error = plainSignInError(error);
    });
  return {
    attemptId,
    providerId: trimmedId,
    url: typeof authorization?.url === "string" ? authorization.url : "",
    code: codeFromInstructions(authorization?.instructions),
    instructions: typeof authorization?.instructions === "string" ? authorization.instructions : "",
    label: chosen.label,
  };
}

function signInStatus(attemptId) {
  const attempt = signInAttempts.get(String(attemptId ?? ""));
  if (!attempt) return { state: "failed", error: "This sign-in is no longer running.", modelCount: 0 };
  return { state: attempt.state, error: attempt.error, modelCount: attempt.modelCount };
}

function cancelSignIn(attemptId) {
  const attempt = signInAttempts.get(String(attemptId ?? ""));
  if (!attempt) return { ok: true };
  attempt.controller.abort();
  attempt.state = "failed";
  attempt.error = "Cancelled.";
  signInAttempts.delete(attempt.id);
  return { ok: true };
}

/** Add a server the person typed in: validated by listing its models first, then saved as an engine provider. */
async function addCustomProvider({ name, address, key, models }) {
  const label = String(name ?? "").trim();
  if (!label) throw new Error("Give the server a name.");
  const listed = await listOpenAiCompatibleModels(address, key);
  const wanted = Array.isArray(models) ? models.filter((model) => listed.models.includes(model)) : [];
  const chosen = wanted.length > 0 ? wanted : listed.models;
  const providerId = customProviderId(label);
  const trimmedKey = String(key ?? "").trim();
  if (trimmedKey) await engineRequest("PUT", `/auth/${encodeURIComponent(providerId)}`, { type: "api", key: trimmedKey });
  await patchRuntimeProviders({ [providerId]: openAiCompatibleProviderConfig({ name: label, address: listed.address, models: chosen }) });
  return connectedResult(providerId, label, await waitForProvider(providerId, true));
}

/**
 * Remove what connects a provider on this Mac. A credential in the engine's
 * store is shared with OpenWork Desktop and OpenCode, so the first call only
 * says so; the renderer asks and calls again with `confirmed`.
 */
async function disconnectProvider(providerId, confirmed) {
  const trimmedId = String(providerId ?? "").trim();
  const provider = (await readConnectedProviders()).find((entry) => entry.id === trimmedId);
  if (!provider) throw new Error("That provider is not connected here.");
  const runtimeIds = await readRuntimeProviderIds().catch(() => []);
  const addedHere = runtimeIds.includes(trimmedId);
  if (provider.source === "env" && !addedHere) {
    const envName = provider.env[0] ?? "an environment variable";
    return { removed: false, needsConfirmation: false, note: `This comes from ${envName} in your environment. Remove it there, then restart Open Coworker.` };
  }
  // A well-known provider's credential (a key reads as `api`, a sign-in as `custom`) lives in the
  // store every OpenCode-based app on this Mac reads.
  const sharedCredential = !addedHere && provider.source !== "env" && provider.source !== "config";
  if (sharedCredential && !confirmed) {
    return {
      removed: false,
      needsConfirmation: true,
      note: `This also signs OpenWork Desktop and OpenCode out of ${provider.name} on this Mac.`,
    };
  }
  await engineRequest("DELETE", `/auth/${encodeURIComponent(trimmedId)}`).catch((error) => {
    if (!(error instanceof EngineRequestError && error.status === 404)) throw error;
  });
  if (addedHere) {
    await patchRuntimeProviders({ [trimmedId]: null });
  } else {
    await reloadEngine();
  }
  await waitForProvider(trimmedId, false);
  return { removed: true, needsConfirmation: false, note: "" };
}

function debugLog(line) {
  if (isDev) console.debug(`[open-coworker] ${line}`);
}

// ---------------------------------------------------------------------------
// Assignments a coworker sets up itself, and the memory and soul it keeps: the
// schedule guardrails every local schedule is checked with, OpenWork Cloud
// placement while an account is signed in, and the memory files whose edits
// the Memory view records and undoes (see `electron/assignment-tools.mjs` and
// `electron/self-memory.mjs`).

const coworkerTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The store options every schedule on this Mac is checked with: the app's guardrails and the coworker's zone. */
async function localScheduleOptions() {
  return { guardrails: scheduleGuardrails(await readSettings(settingsPath)), defaultTimezone: coworkerTimezone() };
}

/** OpenWork Cloud placement for the assignment tools: present only while an account is signed in. */
function cloudAssignments() {
  if (!denSession) return null;
  const session = {
    baseUrl: process.env.COWORKER_DEN_BASE_URL?.trim() || DEFAULT_DEN_BASE_URL,
    token: denSession.token,
    orgId: denSession.orgId,
    userName: "",
    userEmail: "",
    orgName: "",
  };
  const den = createDenAutomationsClient(session);
  return {
    async list(slug) {
      const coworker = await getCoworker(coworkersDir, slug);
      const list = await den.list();
      return list.items
        .filter((entry) => coworker.automations.includes(entry.automation.id) || (coworker.workspaceId && entry.revision.workspaceId === coworker.workspaceId))
        .map((entry) => ({
          id: entry.automation.id,
          name: entry.automation.name,
          schedule: entry.revision.schedule,
          nextDueAt: entry.automation.nextDueAt,
          state: entry.automation.state,
        }));
    },
    async create(slug, draft) {
      const coworker = await getCoworker(coworkersDir, slug);
      const providers = await den.listCloudProviders();
      const options = cloudModelOptions(providers);
      const preferred = resolveCloudModel({ model: coworker.model, modelVariant: coworker.modelVariant }, providers, options);
      const detail = await den.create({
        name: draft.name,
        instructions: draft.instructions,
        schedule: draft.schedule,
        model: { providerId: preferred.model.providerId, modelId: preferred.model.modelId, variant: preferred.model.variant ?? null },
      });
      await updateCoworker(coworkersDir, slug, { automations: [...coworker.automations, detail.automation.id] });
      const chosen = options.find((option) => option.providerId === preferred.model.providerId && option.modelId === preferred.model.modelId);
      return { id: detail.automation.id, name: detail.automation.name, schedule: detail.revision.schedule, modelName: chosen ? `${chosen.providerName} · ${chosen.modelName}` : "" };
    },
  };
}

const TRACKED_MEMORY_FILES = /^(soul\.md|memory\/(working|index)\.md|memory\/long-term\/[^/]+\.md)$/;

/**
 * Add a coworker the one way there is: the home on disk, its native workspace,
 * the engine when it was not running yet, then the contract repair and tools.
 * The Add screen, onboarding, and a suggestion the person accepts all land here.
 */
async function addCoworker(input) {
  await ensurePlatformServer();
  const hadEngine = Boolean(serverHandle?.managedOpencode);
  const coworker = await createCoworker(coworkersDir, input);
  // Registration is registry-level and works without an engine. Do it
  // first, then restart when no engine was managed yet: the engine only
  // spawns when the registry holds at least one workspace, so the restart
  // must happen after this workspace is persisted.
  const workspaceId = await registerCoworkerWorkspace(coworker);
  const updated = await updateCoworker(coworkersDir, coworker.slug, {
    workspaceId,
    ...(input.model ? { model: input.model, modelVariant: input.modelVariant ?? "", modelChosenBy: input.modelChosenBy ?? "person" } : {}),
  });
  if (!hadEngine) {
    await restartPlatformServer();
  }
  await warmCoworkerWorkspace(updated);
  prepareCoworker(updated);
  return updated;
}

function shortDate(at) {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
  "coworkers.create": async ({ name, role, mission, avatarColor, avatarGlasses, personality, roleId, firstNote }) =>
    addCoworker({ name, role, mission, avatarColor, avatarGlasses, personality, roleId, firstNote }),
  // The team: the catalog onboarding proposes from, the person's answers to a
  // coworker's offers, and the states the conversation restores after a reload.
  "team.catalog": async () => teamCatalog(),
  "team.recommend": async ({ intents }) => recommendTeam(intents),
  "team.states": async ({ slug }) => teamStates(coworkersDir, slug),
  // Only this tap creates a coworker from a suggestion. It inherits the proposer's
  // model, remembers who proposed it and why, and every team description refreshes.
  "team.accept": async ({ slug, suggestionId, name }) => {
    const suggestion = (await readSuggestions(coworkersDir, slug)).find((entry) => entry.id === suggestionId);
    if (!suggestion) throw new Error("That suggestion is not on record.");
    if (suggestion.state !== "offered") throw new Error("That suggestion was already answered.");
    const proposer = await getCoworker(coworkersDir, slug);
    const chosenName = typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : suggestion.name;
    const created = await addCoworker({
      name: chosenName,
      role: suggestion.role,
      mission: suggestion.mission,
      avatarColor: suggestion.avatarColor,
      avatarGlasses: suggestion.avatarGlasses,
      personality: suggestion.personality,
      roleId: suggestion.roleId,
      suggestedBy: { slug, why: suggestion.why },
      firstNote: `Joined the team on ${shortDate(Date.now())}; ${proposer.name} suggested me because ${suggestion.why.replace(/\.$/, "")}.`,
      model: proposer.model,
      modelVariant: proposer.modelVariant,
      modelChosenBy: proposer.modelChosenBy,
    });
    await setSuggestionState(coworkersDir, slug, suggestionId, "accepted", { createdSlug: created.slug });
    return created;
  },
  "team.decline": async ({ slug, suggestionId }) => {
    const declined = await setSuggestionState(coworkersDir, slug, suggestionId, "declined");
    // The decline reaches the coworker through its team description.
    await refreshTeamRosters(coworkersDir, await listCoworkers(coworkersDir));
    return { id: declined.id, state: declined.state, at: declined.stateAt };
  },
  "team.referralResolved": async ({ slug, referralId, outcome }) => {
    const resolved = await setReferralState(coworkersDir, slug, referralId, outcome);
    return { id: resolved.id, state: resolved.state, at: resolved.stateAt };
  },
  "coworkers.ensureWorkspace": async ({ slug }) => {
    await ensurePlatformServer();
    const coworker = await getCoworker(coworkersDir, slug);
    if (coworker.workspaceId) {
      if (!serverHandle?.managedOpencode) await restartPlatformServer();
      prepareCoworker(coworker);
      return coworker;
    }
    const workspaceId = await registerCoworkerWorkspace(coworker);
    const updated = await updateCoworker(coworkersDir, slug, { workspaceId });
    if (!serverHandle?.managedOpencode) {
      await restartPlatformServer();
    }
    prepareCoworker(updated);
    return updated;
  },
  "coworkers.update": async ({ slug, patch }) => updateCoworker(coworkersDir, slug, patch ?? {}),
  "coworkers.delete": async ({ slug }) => {
    const activeIds = [...activeLocalRunIds(String(slug ?? ""))];
    const workersRunning = activeIds.filter((id) => id.startsWith("wrk_")).length;
    const running = activeIds.length - workersRunning;
    for (let index = queuedLocalRuns.length - 1; index >= 0; index -= 1) {
      if (queuedLocalRuns[index].slug === String(slug ?? "")) queuedLocalRuns.splice(index, 1);
    }
    if (workersRunning > 0) {
      throw new Error(
        `${workersRunning === 1 ? "A Worker is" : `${workersRunning} Workers are`} still running for this coworker. Stop them before retiring.`,
      );
    }
    if (running > 0) {
      throw new Error(
        `${running === 1 ? "A scheduled assignment is" : `${running} scheduled assignments are`} still running for this coworker. Wait for it to finish or stop it before retiring.`,
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
    coworkerToolServer.forget(String(slug ?? ""));
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
    prepareCoworker(updated);
    return updated;
  },
  "coworkers.retired.delete": async ({ archiveId }) => {
    await deleteRetiredCoworker(coworkersDir, archiveId);
    return { ok: true };
  },
  // Group chats: several coworkers in one conversation. Metadata and the timeline
  // live under the coworkers home beside the coworker folders.
  "groups.list": async () => listGroups(coworkersDir),
  "groups.get": async ({ id }) => getGroup(coworkersDir, id),
  "groups.create": async ({ name, participantSlugs }) => createGroup(coworkersDir, { name, participantSlugs }),
  "groups.update": async ({ id, patch }) => updateGroup(coworkersDir, id, patch ?? {}),
  "groups.archive": async ({ id }) => archiveGroup(coworkersDir, id),
  "groups.readTimeline": async ({ id, limit }) => readGroupTimeline(coworkersDir, id, Number.isFinite(limit) ? { limit } : {}),
  "groups.appendEvent": async ({ id, event }) => appendGroupEvent(coworkersDir, id, event),
  // One turn per message from the person: the record is the source of truth the
  // view and recovery read, so a double Send or a quit mid-turn loses nothing.
  "groups.beginTurn": async ({ id, clientMessageId, prompt }) => beginGroupTurn(coworkersDir, id, { clientMessageId, prompt }),
  "groups.updateTurn": async ({ id, turnId, patch }) => updateGroupTurn(coworkersDir, id, turnId, patch ?? {}),
  // The window drives group turns, so a fresh window means none is live: every
  // turn still recorded as running was cut off and is settled as partial here.
  "groups.recoverInterrupted": async () => {
    const coworkers = await listCoworkers(coworkersDir).catch(() => []);
    const names = new Map(coworkers.map((coworker) => [coworker.slug, coworker.name]));
    return reconcileInterruptedGroupTurns(coworkersDir, { nameFor: (slug) => names.get(slug) ?? slug });
  },
  // The silent facilitator's own workspace: hidden, tool-less, registered like a
  // coworker's but never listed as one.
  "coordinator.ensure": async () => ensureCoordinatorWorkspace(),
  // AI providers on this Mac: what is already here, one-step connect, the
  // engine's own sign-ins, keys, custom servers, and disconnect. Secrets go
  // from their source to the engine over loopback and are never returned.
  "localProviders.prepare": async () => {
    const workspaceId = await providerWorkspaceId();
    const handle = await ensurePlatformServer();
    const engineManaged = Boolean(handle.managedOpencode);
    // Registering the first workspace restarts the platform, which may move it to another port:
    // the renderer reads the live address from here rather than from an earlier runtime.info.
    const base = { workspaceId, engineManaged, serverUrl: handle.url, ownerToken };
    if (!engineManaged) return { ...base, providers: [], signIns: {} };
    // The first read is also the hidden workspace's cold start. Finish it
    // before the second read so OpenCode never initializes the same directory
    // twice at once on a new install.
    const providers = await readEngineProviders();
    const signIns = await readEngineSignIns();
    return { ...base, providers, signIns };
  },
  "localProviders.detect": async () => detectLocalProviders({ log: debugLog }),
  "localProviders.connect": async ({ id }) => connectLocalProvider(String(id ?? "")),
  "localProviders.saveKey": async ({ providerId, key }) => saveProviderKey(providerId, key),
  "localProviders.disconnect": async ({ providerId, confirmed }) => disconnectProvider(providerId, confirmed === true),
  "localProviders.signIn.start": async ({ providerId, method }) => startProviderSignIn(providerId, Number.isInteger(method) ? method : undefined),
  "localProviders.signIn.status": async ({ attemptId }) => signInStatus(attemptId),
  "localProviders.signIn.cancel": async ({ attemptId }) => cancelSignIn(attemptId),
  "localProviders.custom.probe": async ({ address, key }) => listOpenAiCompatibleModels(address, key),
  "localProviders.custom.add": async ({ name, address, key, models }) => addCustomProvider({ name, address, key, models }),
  "coworkers.files.list": async ({ slug }) => listMemoryFiles(coworkersDir, slug),
  "coworkers.files.read": async ({ slug, path: relativePath }) => ({
    content: await readCoworkerFile(coworkersDir, slug, relativePath),
  }),
  // A person's edit to the soul or a memory file takes the same tracked, atomic
  // path as the coworker's own tools, so the Memory view can show and undo it.
  "coworkers.files.write": async ({ slug, path: relativePath, content }) => {
    const relative = String(relativePath ?? "").replace(/\\/g, "/");
    if (TRACKED_MEMORY_FILES.test(relative)) await writeTrackedFile(coworkersDir, slug, relative, content);
    else await writeCoworkerFile(coworkersDir, slug, relativePath, content);
    return { ok: true };
  },
  "coworkers.memory.list": async ({ slug }) => listLongTermMemories(coworkersDir, slug),
  "coworkers.memory.create": async ({ slug, title, summary }) => {
    const { result } = await trackChange(coworkersDir, slug, ["memory/index.md"], { actor: "person", tool: "memory_create", input: { title, summary } }, async () => {
      const created = await createLongTermMemory(coworkersDir, slug, { title, summary });
      return created;
    });
    return result;
  },
  "coworkers.memory.index": async ({ slug, file, summary }) => {
    await trackChange(coworkersDir, slug, ["memory/index.md"], { actor: "person", tool: "memory_index", input: { file } }, () => indexLongTermMemory(coworkersDir, slug, file, summary));
    return { ok: true };
  },
  "coworkers.memory.delete": async ({ slug, file }) => {
    const relative = `memory/long-term/${String(file ?? "")}`;
    await trackChange(coworkersDir, slug, ["memory/index.md", relative], { actor: "person", tool: "memory_delete", input: { file } }, () => deleteLongTermMemory(coworkersDir, slug, file));
    return { ok: true };
  },
  // Documents: the coworker writes them through its tools; the person reads,
  // edits, organizes, exports, and restores them here. Every write is a new
  // revision by the person, which the coworker sees in its index next turn.
  "documents.list": async ({ slug }) => listDocuments(coworkersDir, slug),
  "documents.read": async ({ slug, id }) => readDocument(coworkersDir, slug, id),
  "documents.save": async ({ slug, id, title, summary, highlights, body }) =>
    updateDocument(coworkersDir, slug, id, {
      ...(typeof title === "string" ? { title } : {}),
      ...(typeof summary === "string" ? { summary } : {}),
      ...(Array.isArray(highlights) ? { highlights } : {}),
      ...(typeof body === "string" ? { body } : {}),
    }, { by: "person" }),
  /** active | aside | archived — archiving is the person's call, so it lives here and not in a tool the coworker uses on its own. */
  "documents.setStatus": async ({ slug, id, status }) =>
    status === "archived" ? archiveDocument(coworkersDir, slug, id) : setDocumentStatus(coworkersDir, slug, id, status),
  "documents.revisions": async ({ slug, id }) => listRevisions(coworkersDir, slug, id),
  "documents.restore": async ({ slug, id, revision }) => restoreRevision(coworkersDir, slug, id, revision),
  /** Save a copy as Markdown wherever the person chooses; nothing else moves. */
  "documents.export": async ({ slug, id }) => {
    const document = await readDocument(coworkersDir, slug, id);
    const options = {
      title: "Export document",
      defaultPath: `${document.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || document.id}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    };
    const chosen = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true, path: "" };
    const highlights = document.highlights.map((line) => `- ${line}`).join("\n");
    await writeFile(chosen.filePath, `# ${document.title}\n\n${document.summary ? `${document.summary}\n\n` : ""}${highlights ? `${highlights}\n\n` : ""}${document.body}`, "utf8");
    return { ok: true, cancelled: false, path: chosen.filePath };
  },
  /** A reply ran long with no document behind it: remember it so the coworker's next turn carries a one-line reminder. */
  "documents.recordLongReply": async ({ slug, messageId, chars }) =>
    recordStyleEvent(coworkersDir, slug, { kind: "long-reply", messageId, chars: Number(chars) }),
  /** Recent changes to memory and soul, newest first, by the coworker or the person. */
  "coworkers.memory.changes": async ({ slug, limit }) => readChanges(coworkersDir, slug, Number.isFinite(limit) ? { limit } : {}),
  "coworkers.memory.undo": async ({ slug, changeId }) => undoChange(coworkersDir, slug, String(changeId ?? "")),
  "localResponsibilities.list": async ({ slug }) => listLocalResponsibilities(coworkersDir, slug),
  "localResponsibilities.create": async ({ slug, name, instructions, schedule }) =>
    createLocalResponsibility(coworkersDir, slug, { name, instructions, schedule }, Date.now(), await localScheduleOptions()),
  "localResponsibilities.update": async ({ slug, id, patch }) =>
    updateLocalResponsibility(coworkersDir, slug, id, patch ?? {}, Date.now(), await localScheduleOptions()),
  "localResponsibilities.setActive": async ({ slug, id, active }) =>
    setLocalResponsibilityActive(coworkersDir, slug, id, Boolean(active)),
  "localResponsibilities.delete": async ({ slug, id }) => {
    await deleteLocalResponsibility(coworkersDir, slug, id);
    return { ok: true };
  },
  "localResponsibilities.runNow": async ({ slug, id }) => startLocalResponsibilityRun(slug, id, "manual"),
  "localResponsibilities.resume": async ({ slug, id }) => resumeLocalResponsibilityRun(slug, id),
  "localResponsibilities.cancelQueued": async ({ slug, id }) => cancelQueuedLocalResponsibilityRun(slug, id),
  /** How busy this Mac is with responsibilities and Worker turns right now, and the limit that applies. */
  "localResponsibilities.status": async () => localRunStatus(await parallelRunLimit()),
  // Workers: long-lived sub-agents in the coworker's workspace. The person starts,
  // steers, pauses, and stops them here; the coworker does the same through its tools.
  "workers.list": async ({ slug }) => listWorkers(coworkersDir, slug),
  "workers.get": async ({ slug, id }) => getWorker(coworkersDir, slug, id),
  "workers.spawn": async ({ slug, name, goal, lifespan, spawnedFromThreadId }) =>
    spawnWorker(slug, { name, goal, lifespan, spawnedFromThreadId }, "person"),
  "workers.steer": async ({ slug, id, text }) => steerWorker(slug, id, text, "person"),
  "workers.cancel": async ({ slug, id, reason }) => cancelWorker(slug, id, reason, "person"),
  "workers.pause": async ({ slug, id }) => pauseWorker(slug, id),
  "workers.resume": async ({ slug, id }) => resumeWorker(slug, id),
  "workers.findings": async ({ slug, id, limit }) => readWorkerEvents(coworkersDir, slug, id, Number.isFinite(limit) ? { limit } : {}),
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
    if (toolsServer) {
      const tools = toolsServer;
      toolsServer = null;
      void tools.stop().catch(() => undefined);
    }
    if (!serverHandle) return;
    event.preventDefault();
    const handle = serverHandle;
    serverHandle = null;
    void handle.stop().catch(() => undefined).finally(() => app.quit());
  });
}
