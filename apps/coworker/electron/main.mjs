import { readAllHands, updateAllHands, prepareAllHands, claimAllHands } from "./all-hands.mjs";
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
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createServer as createPortProbe } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, shell, systemPreferences } from "electron";
import { createVoice, installVoicePermissions } from "./voice.mjs";
import { bindWindowAppearance, windowMaterial } from "./window-appearance.mjs";
import { globalOpencodeConfigDir, openworkConfigDir } from "@openwork/paths";
import { createHeadlessThreadClientV2 as createHeadlessThreadClient, createNativeV2Client, createNativeV2Id, nativeCatalogProviders, toTranscript } from "@openwork/headless-threads/v2";
import { configureNativePluginBundles, verifyNativePluginBundles } from "./native-plugin.mjs";
import { nativeTurnAgent, coworkerAgent, NATIVE_COORDINATOR_AGENT } from "./native-turns.mjs";
import { assertTeamCompatibleHomes, teamWorkspaceDirectory, teamWorkspaceId, updateTeamWorkspaceConfig, writeTeamFeatures } from "./team-workspace.mjs";
import { createLinkPreviews } from "./link-preview.mjs";
import { DEFAULT_FEATURES } from "../src/lib/features.ts";
import { assertOwnedNativeTool, createTeamSessionRegistry, resolveNativeFilesystemScope } from "./team-sessions.mjs";
import { awaitNativePluginActivation, prepareNativeTurnRoles } from "./turn-roles-plugin.mjs";
import { dispatchNativeTurn, nativeTurnReceipt, waitForNativeTurn, verifyNativeTurnSkills } from "./native-recovery.mjs";
import { nativeV2SkillsSchema } from "@openwork/headless-threads/v2";
import { selectCatalogSkill, selectionFields, validateSkillSelections, sameSkillFields, selectedCloudSkillScope } from "../src/lib/skill-selection.ts";
import { createNativeProviders } from "./native-providers.mjs";
import { createCollaboration, collaborationId, withAbort, assertTeamConsultToolContext } from "./collaboration.mjs";
import { createActivityInbox } from "./activity-inbox.mjs";
import { createMessageReactionRuntime } from "./message-reactions-context.mjs";
import { readExecutionActivity } from "../src/lib/progress-activity.ts";
import { PROGRESS_LIMITS } from "../src/lib/progress-config.ts";
import { createGroupExecution, repairGroupSelection } from "./group-execution.mjs";
import { assertGroupActionToolContext, createGroupActions } from "./group-actions.mjs";
import { installCollaborationPlugin } from "./collaboration-plugin.mjs";
import { createAbilitiesRuntime, readAbilitiesCatalog } from "./abilities.mjs";
import { installAbilitiesPlugin } from "./abilities-plugin.mjs";
import { assertGroupDocumentToolContext, createGroupDocumentService, groupDocumentToolCatalog } from "./group-documents.mjs";
import { installGroupDocumentPlugin } from "./group-document-plugin.mjs";
import { createEvents, eventNativeSchemas, assertEventToolContext } from "./events.mjs";
import { coworkerIdentity, EVENT_SCHEDULE_DENY, EVENT_WRITE_DENY } from "./event-execution.mjs";
import { installEventPlugin } from "./event-plugin.mjs";
import { installComputerPlugin } from "./computer-plugin.mjs";
import { createComputerControl, assertPrivateComputerDiscussion, COMPUTER_TOOLS, COMPUTER_DENY, COMPUTER_STOP_GUIDANCE, trustedComputerSender } from "./computer-control.mjs";
import { createLocalComputerAdapter } from "./computer-local.mjs";
import { createBrowserPanel } from "@openwork/browser-tabs/electron";
import { createBrowserTools } from "@openwork/browser-tabs/tools";
import { assertBrowserToolContext, BROWSER_TOOLS, checkBrowserPolicy, createBrowserControl } from "./browser-control.mjs";
import { installBrowserPlugin } from "./browser-plugin.mjs";
import { DISCUSSION_REGISTRY_FILE, parseDiscussionRegistry } from "../src/lib/discussions.ts";
import { installProgressPlugin } from "./progress-plugin.mjs";
import { createProgressSummaries } from "./progress-summaries.mjs";
import { installMemoryPlugin } from "./memory-model.mjs";
import { createConversationMemory } from "./conversation-memory.mjs";
import { createCoworkerThreads, eligibleProgressModels } from "../src/lib/threads.ts";
import { configureCoworkerSessionAccess } from "../src/lib/session-routing.ts";
import { cloudModelOptions, resolveCloudModel } from "../src/lib/cloud-responsibilities.ts";
import { createDenAutomationsClient, listAssignedCoworkerTemplates } from "../src/lib/den.ts";
import { createTemplateInstaller, exportCoworkerTemplate, parseCoworkerTemplateFile, templateScope } from "./templates.mjs";
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
  readHomeContext,
  repairCoworkerContract,
  restoreCoworker,
  retireCoworker,
  updateCoworker,
  updateCoworkerAbilities,
  writeCoworkerFile,
} from "./coworkers.mjs";
import { TEAM_SCOPE, COWORKER_TOOLS_MCP_NAME, DEFAULT_INSTRUCTIONS, createCoworkerToolsServer, createToolHandlers, toolCatalog } from "./coworker-tools.mjs";
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
import { ensureCoordinatorHome, readCoordinator, updateCoordinator } from "./coordinator.mjs";
import { effortForTurn, effortStopOf, replyKindForLane, workerTurnsFor } from "../src/lib/effort.ts";
import { classifyRequest, resolveDiscussionModel } from "../src/lib/model-choice.ts";
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
import { detectLocalProviders, listOpenAiCompatibleModels } from "./local-providers.mjs";
import { resolveBundledOpencodeV2Binary, resolveUserDataDir } from "./runtime-paths.mjs";
import nativeRuntime from "../native-runtime.json" with { type: "json" };
import { assertMaintenanceSender, assertResetConfirmation, createMaintenance, createMaintenanceAdmission, createMaintenanceSteps, resolveMaintenanceHistoryDb, validateMaintenancePaths } from "./maintenance.mjs";
import { captureMaintenanceProcesses, maintenanceFailureDetail, maintenancePreparationFailure, prepareMaintenanceHandoff, readMaintenanceStartup, waitForMaintenanceExit } from "./maintenance-handoff.mjs";
import { noteProgress, readChanges, trackChange, undoChange, writeTrackedFile } from "./self-memory.mjs";
import { SETTINGS_FILE, normalizeSettings, readSettings, scheduleGuardrails, updateSettings } from "./settings.mjs";
import {
  RECOVERED_STATUS,
  THINKING_TURN_BUDGET,
  appendWorkerEvent,
  createWorker,
  createWorkerToolHandlers,
  getWorker,
  isWorkerFinished,
  lifespanSpent,
  lifespanFromToolArgs,
  listWorkers,
  nextWorkerState,
  prepareWorkerTurn,
  queueWorkerSteer,
  readWorkerEvents,
  readWorkerRegistry,
  registerWorkerThread,
  resolveWorkerModel,
  updateWorker,
  workerProgressNote,
  workerPurpose,
  workerThreadTitle,
  workerToolCatalog,
  workerTurnTools,
  workerTurnOutcome,
  withWorkerCancellation,
  abortWorkerThread,
} from "./workers.mjs";
import { assertControlOrigin, assertWorkerSupervisor, assertWorkerToolContext, createWorkerControls, WORKER_MANAGEMENT, workerControlRequest } from "./worker-controls.mjs";

import { verifyPackagedNativeRuntime } from "./packaged-native-runtime.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged || process.env.OPENWORK_DEV_MODE === "1";
const packagedNativeProfile = app.isPackaged ? verifyPackagedNativeRuntime(process.resourcesPath) : undefined;
if (packagedNativeProfile) nativeRuntime.sourceBuild = packagedNativeProfile.sourceBuild;
if (nativeRuntime.sourceBuild) nativeRuntime.apiContract = "native-2";
configureNativePluginBundles(app.isPackaged
  ? path.join(process.resourcesPath, "native-plugins")
  : path.resolve(process.env.OPENWORK_COWORKER_PLUGIN_BUNDLE_DIR?.trim() || path.join(__dirname, "..", "resources", "native-plugins")), { sourceBuild: nativeRuntime.sourceBuild });
let sourceRuntimeProfile;
let sourceRuntimePreparation;
async function prepareSourceRuntime() {
  const manifestPath = process.env.OPENWORK_COWORKER_NATIVE_SOURCE_MANIFEST;
  if (!manifestPath) return;
  if (app.isPackaged || !process.env.COWORKER_HOME_DIR || !process.env.COWORKER_SERVER_CONFIG
    || !(process.env.COWORKER_USER_DATA_DIR || process.env.OPENWORK_ELECTRON_USERDATA)) throw new Error("Source native development requires explicit isolated Coworker home, server config and Electron profile paths.");
  sourceRuntimePreparation ??= (async () => {
    const { readNativeSourceFixture, prepareNativeSourceBundles } = await import("./native-source-fixture.mjs");
    const manifest = await readNativeSourceFixture(path.resolve(manifestPath));
    const bundles = await prepareNativeSourceBundles(manifest, path.join(userDataDir, "source-native-plugins"));
    configureNativePluginBundles(bundles.directory, { sourceBuild: bundles.sourceBuild });
    sourceRuntimeProfile = { bin: manifest.executable.path, sourceBuild: bundles.sourceBuild };
    nativeRuntime.apiContract = "native-2";
  })();
  await sourceRuntimePreparation;
}

const APP_NAME = "Open Coworker";
const APP_IDENTIFIER = isDev ? "com.differentai.opencoworker.dev" : "com.differentai.opencoworker";
const userDataDir = resolveUserDataDir({ env: process.env, appDataDir: app.getPath("appData"), appIdentifier: APP_IDENTIFIER });
if (process.env.OPENWORK_COWORKER_NATIVE_SOURCE_MANIFEST && (app.isPackaged || ![process.env.COWORKER_HOME_DIR, process.env.COWORKER_SERVER_CONFIG,
  process.env.COWORKER_USER_DATA_DIR || process.env.OPENWORK_ELECTRON_USERDATA].every((value) => typeof value === "string" && path.isAbsolute(value)))) throw new Error("Source native development requires explicit absolute isolated profile paths.");
// This must precede the first await and app.setPath: a competing launch may
// not select the old profile while its post-exit helper is moving it.
const maintenanceNotice = readMaintenanceStartup(userDataDir, { consume: false });
if (maintenanceNotice?.blocked) {
  dialog.showErrorBox("Fresh start needs attention", maintenanceNotice.message);
  app.exit(0);
}
const DEFAULT_SERVER_PORT = 8790;
const DEFAULT_DEN_BASE_URL = "https://app.openworklabs.com";
const HOSTED_DEN_APEX_HOST = "openworklabs.com";
const APP_ICON_PATH = path.resolve(
  __dirname,
  "..",
  "resources",
  "icons",
  process.platform === "darwin" ? "icon-macos.png" : "icon.png",
);

const explicitCdpPort = Number.parseInt(
  process.env.OPENWORK_ELECTRON_REMOTE_DEBUG_PORT?.trim() ?? "",
  10,
);
const remoteDebugPort = Number.isSafeInteger(explicitCdpPort) && explicitCdpPort > 0 && explicitCdpPort <= 65535
  ? explicitCdpPort : await new Promise((resolve, reject) => {
    const probe = createPortProbe();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close((error) => error ? reject(error) : resolve(port)); });
  });
app.commandLine.appendSwitch("remote-debugging-port", String(remoteDebugPort));
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
const extraLaunchArgs = (process.env.ELECTRON_EXTRA_LAUNCH_ARGS ?? "").trim();
for (const argument of extraLaunchArgs.split(/\s+/).filter(Boolean)) {
  const cleaned = argument.replace(/^--/, "");
  if (/^remote-debugging-(port|address)(=|$)/.test(cleaned)) continue;
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
  userDataDir,
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
// A profile-owned sibling survives Fresh start's profile/home moves. Never use
// the shared OpenCode history or derive the native database from its env flags.
const opencodeV2RootDir = `${path.resolve(userDataDir)}-opencode2`;
const maintenanceAdmission = createMaintenanceAdmission();
const responsibilityAbort = new AbortController();
let responsibilityCleanupError;
let resetExitReady = false;
let resetInProgress = false;
let resetRetryReady = false;
let resetBlockedReason = "";
let quitting = false;
let quitReady = false;

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

/** @type {{ url: string, policyToken: string, stop: () => Promise<void>, managedOpencodeV2: { pid: number | null, isAlive: () => boolean } | null } | null} */
let serverHandle = null;
let ownerToken = "";
let engineError = "";
let startingServer = null;
let engineHistoryDb = null;
let engineHistoryError = "The AI service has not resolved its history database yet. Wait for startup and retry.";
let localResponsibilitiesTimer = null;
/** `slug:id` of every run executing in this process — responsibility runs and Worker turns alike. */
const activeLocalRuns = new Set();
/** Runs waiting for a free slot, oldest first: `{ key, slug, id, runId, launch }`; `launch` starts it once admitted. */
const queuedLocalRuns = [];
/** Admission decisions run one at a time so two requests can never both take the last slot. */
let localRunAdmission = Promise.resolve();
function admitLocalRun(decide) {
  if (maintenanceAdmission.closed) return Promise.resolve();
  const admitted = () => maintenanceAdmission.closed ? undefined : decide();
  const next = localRunAdmission.then(admitted, admitted);
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
// In-memory receipts only: a renderer account is not proof the embedded server applied it.
let denSessionHandoff = Promise.resolve();
let denAccountHandoff = Promise.resolve();
let denAccountGeneration = 0;
let denAccountReady = false;
let storedSkillSession = null;
let appliedSkillSession = null;
const voice = createVoice({ getSession: () => denSession, getBaseUrl: configuredDenApiBase, systemPreferences });

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
    path.resolve(__dirname, "..", "..", "server", "dist", "embedded-native.js"),
    path.resolve(__dirname, "..", "server", "dist", "embedded-native.js"),
    ...(process.resourcesPath
      ? [path.resolve(process.resourcesPath, "server", "dist", "embedded-native.js")]
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

function describeNativeStartupFailure(error) {
  if (error instanceof AggregateError) return "The native AI service failed to start and cleanup is unconfirmed. Quit and reopen Open Coworker before continuing.";
  const line = (error instanceof Error ? error.message : "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  const detail = line.slice(0, 400);
  if (!detail || detail === "The native AI service is not running.") return "The native AI service could not start. Check the v2 binary and native plugin bundles, then restart.";
  return detail;
}

async function startPlatformServer() {
  maintenanceAdmission.assertOpen();
  engineError = "";
  try {
    await prepareSourceRuntime();
    await verifyNativePluginBundles();
    const opencodeV2Bin = sourceRuntimeProfile?.bin ?? resolveBundledOpencodeV2Binary({ appRoot: path.resolve(__dirname, ".."), resourcesPath: process.resourcesPath, isPackaged: app.isPackaged }) ?? undefined;
    const { startEmbeddedServer } = await import(pathToFileURL(embeddedServerPath()).href);
    const tokens = await loadOrCreateTokens();
    const movedPaths = [userDataDir, coworkersDir, serverConfigPath, settingsPath, process.env.OPENWORK_RUNTIME_DB, process.env.OPENWORK_ENV_STORE, `${path.resolve(userDataDir)}-recovery`];
    const pathKey = (value) => process.platform === "linux" ? path.resolve(value) : path.resolve(value).toLowerCase();
    if (movedPaths.some((value) => {
      const moved = pathKey(value), root = pathKey(opencodeV2RootDir);
      return moved === root || root.startsWith(`${moved}${path.sep}`) || moved.startsWith(`${root}${path.sep}`);
    })) throw new Error("Native history must remain outside the reset storage paths.");
    engineHistoryDb = resolveMaintenanceHistoryDb({ rootDir: opencodeV2RootDir });
    engineHistoryError = "";
    await mkdir(coworkersDir, { recursive: true });
    nativeTeamDirectory = await realpath(coworkersDir);
    const contextServer = await ensureToolsServer();
    await installNativeCoworkerPlugins(teamWorkspace(), contextServer);
    const seedWorkspaces = existsSync(serverConfigPath) ? [] : [teamWorkspace().path];

    serverHandle = await startEmbeddedServer({
      engine: "v2",
      opencodeV2Bin,
      opencodeV2: { ...(sourceRuntimeProfile?.sourceBuild || nativeRuntime.sourceBuild
        ? { sourceBuild: sourceRuntimeProfile?.sourceBuild ?? nativeRuntime.sourceBuild, apiContract: "native-2" }
        : { version: nativeRuntime.opencodeV2Version, apiContract: nativeRuntime.apiContract }), rootDir: opencodeV2RootDir, workspaceDirectory: teamWorkspace().path },
      host: "127.0.0.1",
      port: DEFAULT_SERVER_PORT,
      corsOrigins: ["*"],
      approvalMode: "auto",
      configPath: serverConfigPath,
      workspaces: seedWorkspaces,
      token: tokens.clientToken,
      hostToken: tokens.hostToken,
    });
    if (!serverHandle.managedOpencodeV2?.isAlive()) throw new Error("The native AI service is not running.");
    ownerToken = await resolveOwnerToken(serverHandle.url, tokens);
    // OpenWork is running once the native process is alive. Workspace
    // registration is later work and must not stop or fail this start.
    await registerCoworkerWorkspace(teamWorkspace(), serverHandle).catch((error) => {
      console.warn("[open-coworker] OpenWork is running; workspace registration can finish later", error);
    });
    if (denSession) {
      // A fresh server starts with no account context; hand the session back so
      // the signed-in user's providers keep flowing into this engine.
      await applyDenSession(serverHandle, tokens.hostToken, denSession).catch(() => {
        console.warn("[open-coworker] could not re-apply the OpenWork session after restart");
      });
    }
    return serverHandle;
  } catch (error) {
    engineError = describeNativeStartupFailure(error);
    if (serverHandle) {
      try {
        await serverHandle.stop();
        if (serverHandle.managedOpencodeV2?.isAlive()) throw new Error("The native AI service is still running.");
      }
      catch { engineError = "The native AI service failed to start and its shutdown is unconfirmed. Quit and reopen Open Coworker before continuing."; throw new Error(engineError); }
      serverHandle = null;
    }
    throw new Error(engineError);
  }
}

/**
 * Give the embedded server the signed-in account so it can materialize the
 * member's authorized providers into the engine — the same `PUT /den-session`
 * then `POST /cloud-provider-sync/run` sequence the OpenWork desktop performs.
 */
function queueDenSessionHandoff(work) {
  appliedSkillSession = null;
  const result = denSessionHandoff.then(() => { appliedSkillSession = null; return work(); });
  denSessionHandoff = result.catch(() => undefined);
  return result;
}

// Account mutations and Connect registration share one admission queue. Fence
// immediately, before awaiting server startup, so late renderer work cannot
// restore a departing account. Keep failed teardown retryable.
function queueDenAccountHandoff(work) {
  const result = denAccountHandoff.then(work);
  denAccountHandoff = result.catch(() => undefined);
  return result;
}

function invalidateDenAccount() {
  denAccountReady = false;
  // Revoke account/skill admission immediately; renderer persistence is only
  // cleared after the server confirms teardown, so failure remains retryable.
  denSession = null;
  appliedSkillSession = null;
  storedSkillSession = null;
  return ++denAccountGeneration;
}

function confirmSkillSession(handle, session, result) {
  if (session && denSession === session && serverHandle === handle && storedSkillSession?.session === session && storedSkillSession.handle === handle && ["applied", "noop"].includes(result.status)) appliedSkillSession = { handle, session };
}

async function applyDenSession(handle, hostToken, session) {
  return queueDenSessionHandoff(async () => {
    storedSkillSession = null;
    const headers = { "Content-Type": "application/json", "X-OpenWork-Host-Token": hostToken };
    const response = await fetch(`${handle.url}/den-session`, {
      method: "PUT", headers, body: JSON.stringify(session), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Storing the OpenWork session failed (${response.status})`);
    storedSkillSession = { handle, session };
    const result = await requestCloudProviderSync(handle, hostToken, "den_session_updated");
    confirmSkillSession(handle, session, result);
    return result;
  });
}

async function runCloudProviderSync(handle, hostToken, reason) {
  const session = denSession;
  return queueDenSessionHandoff(async () => {
    const result = await requestCloudProviderSync(handle, hostToken, reason);
    confirmSkillSession(handle, session, result);
    return result;
  });
}

async function requestCloudProviderSync(handle, hostToken, reason) {
  const payload = await fetchJson(`${handle.url}/cloud-provider-sync/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenWork-Host-Token": hostToken },
    body: JSON.stringify({ reason }),
  }, 90_000);
  const detail = payload?.detail;
  const nativeUnchanged = payload?.status === "noop" && detail?.nativeReloadAttempted === false
    && ["fingerprintChanged", "providerStateChanged", "cleanupChanged", "cleanupRuntimeChanged", "fileChanged", "reloadDeferred", "nativeReloadPending"].every((field) => detail[field] === false)
    && detail.envUpserts === 0 && detail.envDeletes === 0;
  return {
    status: typeof payload?.status === "string" ? payload.status : "failed",
    message: typeof payload?.message === "string" ? payload.message : "",
    ...(nativeUnchanged ? { readinessUnchanged: true } : {}),
  };
}

async function clearDenSession(handle, hostToken) {
  return queueDenSessionHandoff(async () => {
    storedSkillSession = null;
    const response = await fetch(`${handle.url}/den-session`, {
      method: "DELETE", headers: { "X-OpenWork-Host-Token": hostToken }, signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Clearing the OpenWork session failed (${response.status})`);
  });
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
  maintenanceAdmission.assertOpen();
  if (engineError) throw new Error(engineError);
  if (startingServer) return startingServer;
  if (serverHandle) {
    if (!serverHandle.managedOpencodeV2?.isAlive()) throw new Error("The native AI service stopped. Restart it before continuing.");
    return serverHandle;
  }
  startingServer ??= startPlatformServer().finally(() => {
    startingServer = null;
  });
  return startingServer;
}

async function restartPlatformServer() {
  maintenanceAdmission.assertOpen();
  if (!await workerControls.reset()) throw new Error("Worker control cleanup could not be confirmed. Revoke it before restarting.");
  const reset = await computerControl.reset(false, async () => {
    // Keep computer admission closed for the entire stop-and-start, including
    // UI requests arriving while the replacement engine is booting.
    if (startingServer) await startingServer.catch(() => undefined);
    if (serverHandle) {
      const previous = serverHandle;
      try {
        await previous.stop();
        if (previous.managedOpencodeV2?.isAlive()) throw new Error("Native process is still alive.");
      } catch {
        engineError = "The native AI service could not confirm shutdown. Quit and reopen Open Coworker before continuing.";
        throw new Error(engineError);
      }
      serverHandle = null;
    }
    engineError = "";
    nativeProviderGeneration = null;
    signInAttempts.clear();
    warmedCoworkerWorkspaces.clear();
    warmedCoworkerScopes.clear();
    coworkerWarmups.clear();
    coworkerWarmupTail = Promise.resolve();
    toolsRegistered.clear();
    variantsByModel.clear();
    progressCoordinator = null;
    return ensurePlatformServer();
  });
  if (!reset.confirmed) throw new Error(COMPUTER_STOP_GUIDANCE);
  return reset.value;
}

function runtimeInfo() {
  return {
    appName: APP_NAME,
    version: app.getVersion(),
    serverUrl: serverHandle?.url ?? "",
    ownerToken,
    coworkersDir,
    teamWorkspaceId: teamWorkspace().workspaceId,
    apiContract: nativeRuntime.apiContract ?? "beta19271",
    denBaseUrl: process.env.COWORKER_DEN_BASE_URL?.trim() || DEFAULT_DEN_BASE_URL,
    deepLinkScheme: DEEP_LINK_SCHEME,
    deepLinksRegistered: protocolRegistered,
    engineManaged: Boolean(serverHandle?.managedOpencodeV2?.isAlive()),
    engineError,
    readinessKey: readinessKey(),
    workspaceReadinessRevisions: Object.fromEntries(workspaceReadinessRevisions),
  };
}

function forwardedDeepLinks(argv) {
  return argv
    .slice(1)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${DEEP_LINK_SCHEME}://`));
}

function queueDeepLinks(urls) {
  if (maintenanceAdmission.closed) return;
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

async function readModelCatalog(workspaceId, { handle, signal } = {}) {
  handle ??= await ensurePlatformServer();
  const catalog = createCoworkerThreads({ serverUrl: handle.url, workspaceId: teamWorkspace().workspaceId, token: ownerToken }).listModelCatalog();
  const result = signal ? await withAbort(catalog, signal) : await catalog;
  if (handle !== serverHandle) throw new Error("The native AI service changed while reading models. Try again.");
  return result;
}

async function modelVariantsFor(coworker) {
  const preference = String(coworker?.model ?? "").trim();
  if (!preference || !coworker?.workspaceId) return null;
  if (variantsByModel.has(preference)) return variantsByModel.get(preference);
  try {
    const catalog = await readModelCatalog(coworker.workspaceId);
    const variants = catalog.models.find((model) => model.id === preference)?.variants ?? [];
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
async function localRunModel(coworker, kind = "assignment-run", requestText) {
  const preference = String(coworker?.model ?? "").trim();
  const separator = preference.indexOf("/");
  if ((kind === "reply" || kind === "review") && typeof requestText === "string") {
    const catalog = await readModelCatalog(coworker.workspaceId);
    const { modelDefaults } = await readSettings(settingsPath);
    const decision = resolveDiscussionModel(catalog, coworker, requestText, modelDefaults);
    if (!decision.model) throw new Error(decision.reason);
    return { providerId: decision.model.providerId, modelId: decision.model.modelId, ...(decision.variant ? { variant: decision.variant } : {}) };
  }
  if (separator <= 0 || separator === preference.length - 1) {
    const handle = await ensurePlatformServer();
    const model = await createNativeV2Client({ baseUrl: handle.url, workspaceId: teamWorkspace().workspaceId, token: ownerToken }).defaultModel();
    if (!model) throw new Error("No native model is available. Choose a connected model.");
    return { providerId: model.providerID, modelId: model.id, ...(model.variant ? { variant: model.variant } : {}) };
  }
  const fixedVariant = String(coworker?.modelVariant ?? "").trim();
  const variants = await modelVariantsFor(coworker);
  const variant = variants === null
    ? fixedVariant
    : effortForTurn({ kind: typeof requestText === "string" ? replyKindForLane(classifyRequest(requestText)) : kind, stop: effortStopOf(coworker?.effortPreference), fixedVariant, variants });
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
  const signal = responsibilityAbort.signal;
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
      started = await beginLocalResponsibilityRun(coworkersDir, slug, id, { trigger, runId, threadId: resumeThreadId || createNativeV2Id("ses") });
    } catch (error) {
      console.warn(`[open-coworker] local responsibility ${key} did not start`, error);
      onStarted();
      return;
    }
    // The run record is on disk: admission can answer, and the UI can read a consistent state.
    onStarted();
    const activeRunId = started.latestRun.id;
    let client;
    const threadId = started.latestRun.threadId;
    try {
      const handle = await ensurePlatformServer();
      const binding = resumeThreadId ? await sessionBinding(coworker, resumeThreadId) : null;
      const shared = !binding || binding.nativeWorkspaceId === teamWorkspace().workspaceId;
      if (shared) await warmCoworkerWorkspace(coworker);
      else await prepareLegacySession(coworker, binding);
      const model = await localRunModel(coworker, "assignment-run");
      const agent = nativeTurnAgent({ tools: COMPUTER_DENY, ...(shared ? { slug } : {}) });
      client = ownedSessionClient(coworker, {
        baseUrl: handle.url,
        workspaceId: coworker.workspaceId,
        token: ownerToken,
        defaultModel: model,
        nativeWorkspaceId: binding?.nativeWorkspaceId ?? teamWorkspace().workspaceId,
        defaultAgent: agent,
      }, "assignment");
      let acceptance;
      signal.throwIfAborted();
      const messageId = `msg_${activeRunId.replaceAll("-", "")}`;
      const execution = { id: activeRunId, owner: { slug, threadId, kind: "assignment" }, coworkerCreatedAt: coworker.createdAt,
        messageId, workspaceId: coworker.workspaceId, model, agent, tools: COMPUTER_DENY, state: "running", sentAt: Date.now() };
      standaloneExecutions.set(threadId, execution);
      if (resumeThreadId) {
        acceptance = await client.sendTurn(threadId, { prompt: RESUME_PROMPT(started.name, resumeReason), messageId, agent, model, signal });
      } else {
        await client.createThread({ threadId, title: started.name, agent, model, signal });
        signal.throwIfAborted();
        acceptance = await client.sendTurn(threadId, { prompt: started.instructions, messageId, agent, model, signal });
      }
      const result = await client.waitForThread(threadId, {
        signal,
        timeoutMs: 60 * 60_000,
        pollIntervalMs: 1_000,
        ...(acceptance ? { since: acceptance } : {}),
      });
      if (result.outcome === "timeout" || signal.aborted) await client.abortThread(threadId);
      const reply = toTranscript(result.snapshot).messages.filter((message) => message.role === "assistant").at(-1);
      const succeeded = result.outcome === "settled" && !result.terminalError && typeof reply?.completedAt === "number";
      await finishLocalResponsibilityRun(coworkersDir, slug, id, activeRunId, {
        status: succeeded ? "succeeded" : "failed",
        error: succeeded
          ? ""
          : result.terminalError?.message || (result.outcome === "timeout" ? "Run timed out after one hour" : "The run stopped before its reply finished. Review its work before resuming."),
        summary: await readRunSummary(client, threadId),
      });
    } catch (error) {
      if (client && threadId) await client.abortThread(threadId).catch((cleanupError) => { responsibilityCleanupError = cleanupError; });
      await finishLocalResponsibilityRun(coworkersDir, slug, id, activeRunId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    } finally {
      if (standaloneExecutions.get(threadId)?.id === activeRunId) standaloneExecutions.delete(threadId);
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
    void maintenanceAdmission.run(() => executeLocalResponsibility(slug, id, { ...options, onStarted: resolve })).catch(resolve);
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
    if (trigger === "scheduled" || trigger === "recovery") {
      const current = (await listLocalResponsibilities(coworkersDir, slug)).find((item) => item.id === id);
      if (!current || current.state !== "active" || !current.nextDueAt || current.nextDueAt > Date.now()) {
        return { accepted: false, queued: false, reason: "not due" };
      }
    }
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

function cancelQueuedLocalResponsibilityRun(slug, id) {
  return admitLocalRun(async () => {
    const entry = removeQueuedRun(`${slug}:${id}`);
    const items = await listLocalResponsibilities(coworkersDir, slug);
    const record = items.find((item) => item.id === id);
    const queuedRun = entry?.runId ?? record?.runs.find((run) => run.status === "queued")?.id ?? "";
    if (queuedRun) await cancelQueuedLocalRun(coworkersDir, slug, id, queuedRun);
    return { ok: true };
  });
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

/** Worker turns in flight, including the native cleanup barrier used by Stop. */
const liveWorkerTurns = new Map();
let workersRecovered = false;
let workersRecovering = false;
const WORKER_TURN_TIMEOUT_MS = 60 * 60_000;

async function resolveSessionOwner(owner) {
  const stored = owner.slug === ".coordinator" ? await readCoordinator(coworkersDir) : await getCoworker(coworkersDir, owner.slug);
  const coworker = owner.slug === ".coordinator" && stored ? { ...stored, slug: owner.slug, createdAt: "coordinator" } : stored;
  const createdAt = owner.coworkerCreatedAt ?? owner.coworkerIdentity?.createdAt;
  if (!coworker?.path || !coworker.workspaceId || (createdAt && createdAt !== coworker.createdAt)) throw new Error("The original session owner changed.");
  const binding = await sessionBinding(coworker, owner.threadId);
  if ((createdAt && createdAt !== binding.createdAt) || binding.workspaceId !== coworker.workspaceId
    || (owner.workspaceId && owner.workspaceId !== binding.workspaceId)) throw new Error("The original session owner changed.");
  if (binding.kind !== "legacy" && binding.kind !== owner.kind) throw new Error("This native session belongs to another work surface.");
  return { ...owner, coworkerCreatedAt: binding.createdAt, ...(binding.nativeWorkspaceId === teamWorkspace().workspaceId ? { agent: owner.slug === ".coordinator" ? NATIVE_COORDINATOR_AGENT : coworkerAgent(owner.slug) } : {}) };
}

const collaboration = createCollaboration({
  resolveOwner: (owner) => owner.kind === "group" && owner.coworkerCreatedAt === undefined ? owner : resolveSessionOwner(owner),
  acceptanceTimeoutMs: 120_000,
  setupTimeoutMs: 120_000,
  validateAdmission: (entry) => assertExpectedReadiness(entry.expectedReadiness, { slug: entry.owner.slug, workspaceId: entry.workspaceId, coworkerCreatedAt: entry.coworkerCreatedAt }),
  directory: coworkersDir,
  clientFor: (slug, options) => maintenanceAdmission.run(() => collaborationClient(slug, options)),
  cleanupClientFor: collaborationCleanupClient,
  validateOwner: async (owner) => { await resolveSessionOwner(owner); await events.validateOwner(owner); },
  consult: (task) => maintenanceAdmission.run(() => groupExecution.consultation(task)),
  spawn: (slug, input) => maintenanceAdmission.run(() => spawnWorker(slug, input, "coworker")),
  selectWorkerSkills: (slug, input) => resolveWorkerSkills(slug, input),
  cancelWorker: async (slug, id) => {
    // A requested child may never have spawned. Late spawn acknowledgements
    // re-enter this callback after the record exists and repair cleanup then.
    const worker = await getWorker(coworkersDir, slug, id).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (worker || liveWorkerTurns.has(workerKey(slug, id))) return cancelWorker(slug, id, "The originating task stopped.", "person");
  },
  invalidateWorker: (slug, id) => { void workerControls.revokeId(slug, id); },
  memoryContext: (owner) => conversationMemory.context(owner),
  executionContext: (owner) => events.context(owner),
  reactionContext: (entry, snapshot) => messageReactions.prepare(entry, snapshot),
  onSuccess: (entry) => entry.owner.kind === "private" && !entry.reactionOnly ? captureConversationMemory(entry) : Promise.resolve(),
  onExecutionEnd: async (entry, snapshot) => {
    await computerControl.endTurn(entry);
    await events.captureExecution(entry, snapshot);
  },
  publish: (task) => maintenanceAdmission.run(async () => {
    if (!task.groupId) return;
    const event = await appendGroupEvent(coworkersDir, task.groupId, { id: `evt_${collaborationId(task.id, "answer").slice(5)}`, executionId: task.executionId, kind: task.state === "succeeded" ? "coworker" : "status", slug: task.to, threadId: task.owner.threadId, status: task.state, text: task.state === "succeeded" ? task.result : `${task.label}: ${task.error || "The request stopped."}` });
    if (task.state === "succeeded") {
      const entry = await collaboration.read((state) => state.executions[task.executionId]);
      if (entry) await captureConversationMemory(entry).catch(() => {});
    }
    return { eventId: event.id, event };
  }),
  publishExecution: (entry) => maintenanceAdmission.run(async () => {
    const task = await collaboration.read((state) => state.tasks[entry.taskId]);
    let event;
    if (entry.owner.groupId && task.kind !== "consultation") event = await appendGroupEvent(coworkersDir, entry.owner.groupId, { id: `evt_${collaborationId(entry.id, "follow-up").slice(5)}`, executionId: entry.id, kind: entry.state === "succeeded" ? "coworker" : "status", slug: entry.owner.slug, threadId: entry.owner.threadId, turnId: entry.owner.turnId, status: entry.state, text: entry.state === "succeeded" ? entry.result : `The follow-up could not finish: ${entry.error}` });
    if (entry.owner.groupId && task.kind !== "consultation" && entry.state === "succeeded") await captureConversationMemory(entry).catch(() => {});
    const children = await collaboration.read((state) => state.tasks[entry.taskId].dependencies.map((id) => state.tasks[id]));
    for (const child of children.filter((task) => task.kind === "worker")) await appendWorkerEvent(coworkersDir, child.origin.slug, child.workerId, { id: `evt_${collaborationId(entry.id, child.id, "review").slice(5)}`, kind: "review", reviewThreadId: entry.owner.threadId, text: entry.state === "succeeded" ? "The coworker reviewed this in the original conversation." : "The follow-up did not finish. Its receipt is in the original conversation.", ...(entry.state === "succeeded" ? {} : { error: entry.error }) });
    return event ? { eventId: event.id, event } : undefined;
  }),
});
const activityInbox = createActivityInbox({ collaboration, coworkers: () => listCoworkers(coworkersDir), groups: () => listGroups(coworkersDir) });
const linkPreviews = createLinkPreviews();
const messageReactions = createMessageReactionRuntime({
  directory: coworkersDir, collaboration,
  coworkerFor: (slug) => getCoworker(coworkersDir, slug),
  assertPrivate: (slug, threadId) => savedPrivateDiscussion(slug, threadId),
  onChange: (scope, revision) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("coworker:reactions-changed", { scope, revision });
  },
});
const computerControl = createComputerControl({
  adapters: [createLocalComputerAdapter({
    // "Back to Coworker" in the native permission coach: the coach is an accessory
    // process, so the person is usually still in System Settings when they click it.
    onSetupReturn: () => {
      void app.whenReady().then(() => focusMainWindow()).then((window) => {
        if (window) app.focus({ steal: true });
      });
    },
  })],
  discussionFor: computerDiscussion,
  resolveContext: (slug, context, expected) => resolveControlContext(slug, context, expected, "computer"),
  onRevoke: (scope) => { void workerControls.revokeOrigin(scope); },
});
let browserTools;
const browserControl = createBrowserControl({
  createPanel: createBrowserPanel,
  panelOptions: {
    getWindow: () => mainWindow,
    remoteDebugPort,
    partition: "persist:coworker-browser",
    // The packaged asset is always next to this bundle; only source dev resolves the package.
    preloadPath: app.isPackaged ? fileURLToPath(new URL("./browser-content-preload.cjs", import.meta.url))
      : existsSync(fileURLToPath(new URL("./browser-content-preload.cjs", import.meta.url)))
        ? fileURLToPath(new URL("./browser-content-preload.cjs", import.meta.url))
        : fileURLToPath(import.meta.resolve("@openwork/browser-tabs/preload")),
    openExternal: async () => { throw new Error("Browser requests stay in the embedded Coworker browser."); },
    runDetachedTask: (_label, task) => { void maintenanceAdmission.run(task).catch(() => console.warn("[open-coworker] Browser navigation could not finish.")); },
  },
  discussionFor: computerDiscussion,
  resolveContext: (slug, context, expected) => resolveControlContext(slug, context, expected, "browser"),
  checkPolicy: (input) => checkBrowserPolicy(serverHandle, input),
  runTool: async (name, args, context) => {
    if (!context?.sessionID || !context.messageID || !context.callID || !context.directory || !(context.abort instanceof AbortSignal)) throw new Error("Browser tools require the validated native origin and cancellation signal.");
    context.abort.throwIfAborted();
    browserTools ??= createBrowserTools();
    const tools = await browserTools;
    context.abort.throwIfAborted();
    return tools.tool[name].execute(args, context);
  },
});
const workerControls = createWorkerControls({
  discussionFor: computerDiscussion,
  taskFor: (worker) => collaboration.workerControlTask(worker),
  readWorker: (slug, id) => getWorker(coworkersDir, slug, id),
  updateWorker: (slug, id, patch) => updateWorker(coworkersDir, slug, id, patch),
  liveRuns: liveWorkerTurns, browser: browserControl, computer: computerControl,
  stopNative: abortWorkerThread,
});

async function resolveControlContext(slug, context, expected, surface) {
  const delegated = await workerControls.resolve(slug, context, expected, surface);
  if (delegated) return delegated;
  const trusted = await collaboration.context(slug, context, expected, surface === "browser" ? assertBrowserToolContext : undefined);
  const assertActive = () => { trusted.assertActive(); workerControls.assertAvailable(slug, context.sessionID, surface); };
  assertActive();
  return { ...trusted, assertActive };
}
const groupExecution = createGroupExecution({
  directory: coworkersDir,
  collaboration,
  settings: () => readSettings(settingsPath),
  eventContext: (request, slug) => events.requestContext(request, slug),
  conversationContext: (groupId, expected) => events.conversationContext(groupId, expected),
  coworkerFor: (slug) => getCoworker(coworkersDir, slug),
  coordinator: () => maintenanceAdmission.run(ensureCoordinatorWorkspace),
  catalogFor: async (workspace, signal) => {
    return readModelCatalog(workspace.workspaceId, { signal });
  },
  clientFor: (slug, options) => maintenanceAdmission.run(() => collaborationClient(slug, options)),
  onPublished: (entry) => captureConversationMemory(entry),
});

const groupDocumentTools = new Set(groupDocumentToolCatalog().map((tool) => tool.name));
const groupDocuments = createGroupDocumentService({
  coworkersDir,
  coworkerFor: (slug) => getCoworker(coworkersDir, slug),
  sessionBindingFor: (coworker, sessionId) => teamSessions.resolve(sessionId, coworker),
  resolveContext: (slug, context, expected) => collaboration.context(slug, context, expected, assertGroupDocumentToolContext),
  captureArtifact: async (...args) => {
    try { await events.captureArtifact(...args); }
    catch (error) { await events.recordArtifactError(args[0], error); throw error; }
  },
});

const events = createEvents({
  directory: coworkersDir, collaboration, groups: groupExecution,
  coworkerFor: (slug) => getCoworker(coworkersDir, slug),
  coworkers: () => listCoworkers(coworkersDir),
  readExecution: async (entry) => (await (maintenanceAdmission.closed
    ? collaborationCleanupClient(entry.owner.slug, { owner: entry.owner, workspaceId: entry.workspaceId, coworkerCreatedAt: entry.coworkerCreatedAt, signal: AbortSignal.timeout(10_000) })
    : collaborationClient(entry.owner.slug, { model: entry.model, observationOnly: true }))).getThreadSnapshot(entry.owner.threadId, { signal: AbortSignal.timeout(10_000) }),
  resolveContext: (slug, context, expected) => collaboration.context(slug, context, expected, assertEventToolContext),
  readArtifact: async (artifact) => {
    const owner = artifact.owner;
    const current = owner.kind === "group" ? await groupDocuments.read(owner.groupId, artifact.documentId) : await readDocument(coworkersDir, owner.slug, artifact.documentId);
    if (current.revision === artifact.revision) return current;
    const history = owner.kind === "group" ? await groupDocuments.revisions(owner.groupId, artifact.documentId) : await listRevisions(coworkersDir, owner.slug, artifact.documentId);
    const exact = history.find((entry) => entry.revision === artifact.revision);
    if (!exact) throw new Error("This exact document revision is no longer retained. The current version was not substituted.");
    return exact;
  },
  assignments: async () => (await Promise.all((await listCoworkers(coworkersDir)).map(async (coworker) =>
    (await listLocalResponsibilities(coworkersDir, coworker.slug)).map((item) => ({ id: item.id, slug: coworker.slug, title: item.name, state: item.state, schedule: item.schedule, nextDueAt: item.nextDueAt }))))).flat().slice(0, 200),
});
const groupActions = createGroupActions({
  coworkersDir,
  coworkers: () => listCoworkers(coworkersDir),
  resolveContext: (slug, context, expected) => collaboration.context(slug, context, expected, assertGroupActionToolContext),
});

async function ordinaryGroup(id) {
  if ((await getGroup(coworkersDir, id)).eventId) throw new Error("This group is managed through Events.");
}

async function collaborationClient(slug, { threadId, kind = "reply", sessionKind = "private", requestText, model, agent, observationOnly = false, prepareOnly = false, signal } = {}) {
  maintenanceAdmission.assertOpen();
  const stored = slug === ".coordinator" ? observationOnly ? await readCoordinator(coworkersDir) : await ensureCoordinatorWorkspace() : await getCoworker(coworkersDir, slug);
  let coworker = slug === ".coordinator" && stored ? { ...stored, slug, createdAt: "coordinator" } : stored;
  const handle = await ensurePlatformServer();
  if (!coworker?.workspaceId && !observationOnly && slug !== ".coordinator") {
    signal?.throwIfAborted();
    const legacy = handle.config.workspaces.find((workspace) => workspace.workspaceType === "local" && path.resolve(workspace.path) === path.resolve(coworker.path));
    const workspaceId = legacy?.id ?? await registerCoworkerWorkspace(coworker, handle);
    signal?.throwIfAborted();
    const current = await getCoworker(coworkersDir, slug);
    if (current.createdAt !== coworker.createdAt || current.path !== coworker.path) throw new Error("The coworker changed while its AI workspace was starting.");
    coworker = current.workspaceId ? current : await updateCoworker(coworkersDir, slug, { workspaceId });
  }
  if (!coworker?.workspaceId) throw new Error("The AI service is not ready. Your work has been kept.");
  const binding = threadId ? await sessionBinding(coworker, threadId) : null;
  if ((!observationOnly || prepareOnly) && binding && binding.nativeWorkspaceId !== teamWorkspace().workspaceId) await prepareLegacySession(coworker, binding);
  else if ((!observationOnly || prepareOnly) && slug !== ".coordinator") {
    // Warm-up already installs the current plug-ins and registers the shared
    // tools endpoint. Doing both here repeated that work before every turn.
    await warmCoworkerWorkspace(coworker);
  }
  signal?.throwIfAborted();
  // Legacy admissions have no model pin. Observe their native work without
  // consulting today's catalog or turning a missing selection into a failure.
  const resolvedModel = model ?? (observationOnly || prepareOnly ? undefined : await localRunModel(coworker, kind, requestText));
  const options = { baseUrl: handle.url, workspaceId: coworker.workspaceId, nativeWorkspaceId: binding?.nativeWorkspaceId ?? teamWorkspace().workspaceId, token: ownerToken, defaultModel: resolvedModel, defaultAgent: agent ?? (slug === ".coordinator" ? NATIVE_COORDINATOR_AGENT : binding && binding.nativeWorkspaceId !== teamWorkspace().workspaceId ? "build" : coworkerAgent(slug)), captureSkillOrigin: slug !== ".coordinator" };
  const client = ownedSessionClient(coworker, options, slug === ".coordinator" ? "coordinator" : sessionKind);
  client.resolvedModel = resolvedModel;
  if (slug !== ".coordinator") client.coworkerIdentity = coworkerIdentity(coworker);
  const interactions = createCoworkerThreads({ serverUrl: handle.url, workspaceId: coworker.workspaceId, token: ownerToken,
    ...(slug === ".coordinator" ? {} : { owner: { slug, createdAt: coworker.createdAt } }) });
  client.workspaceId = coworker.workspaceId;
  client.coworkerCreatedAt = coworker.createdAt ?? null;
  client.pendingInteractions = interactions.listThreadInteractions;
  client.replyPermission = interactions.replyPermission;
  client.replyQuestion = interactions.replyQuestion;
  client.rejectQuestion = interactions.rejectQuestion;
  return client;
}

async function collaborationCleanupClient(slug, { owner, workspaceId, coworkerCreatedAt, signal } = {}) {
  const handle = serverHandle;
  const generation = handle?.managedOpencodeV2;
  const pid = generation?.pid;
  const request = handle?.nativeCleanupRequest;
  const createdAt = coworkerCreatedAt ?? owner?.coworkerCreatedAt ?? owner?.coworkerIdentity?.createdAt;
  if (!owner || owner.slug !== slug || !owner.threadId || !workspaceId
    || (slug !== ".coordinator" && (typeof createdAt !== "string" || !createdAt))) throw new Error("The original cleanup identity is unavailable. No unrelated work was stopped.");
  if (typeof request !== "function") throw new Error("Cleanup-only access to the owned AI service is unavailable. Update Open Coworker before retrying Fresh start.");
  const homeDirectory = path.join(path.resolve(coworkersDir), slug);
  const binding = (await teamSessions.list({ slug, createdAt: slug === ".coordinator" ? "coordinator" : createdAt })).find((entry) => entry.sessionId === owner.threadId);
  const directory = binding?.directory ?? homeDirectory;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (serverHandle !== handle || handle.managedOpencodeV2 !== generation || generation?.pid !== pid
      || !Number.isSafeInteger(pid) || pid < 2 || !generation.isAlive() || handle.nativeCleanupRequest !== request
      || (maintenanceAdmission.closed && maintenanceServer && (maintenanceServer.handle !== handle || maintenanceServer.native !== generation || maintenanceServer.pid !== pid))) throw new Error("The owned AI service changed or stopped. Cleanup was not confirmed.");
  };
  const checkOwner = async () => {
    assertCurrent();
    const current = await withAbort(slug === ".coordinator" ? readCoordinator(coworkersDir) : getCoworker(coworkersDir, slug),
      AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]));
    assertCurrent();
    const expected = owner.coworkerIdentity;
    if (!current?.path || current.workspaceId !== workspaceId || path.resolve(current.path) !== homeDirectory
      || (owner.workspaceId && owner.workspaceId !== workspaceId)
      || (slug !== ".coordinator" && (current.slug !== slug || current.createdAt !== createdAt))
      || (expected && (expected.slug !== slug || expected.path !== homeDirectory || expected.createdAt !== createdAt
        || (expected.workspaceId && expected.workspaceId !== workspaceId)))) throw new Error("The original coworker or workspace changed. No unrelated work was stopped.");
    return current;
  };
  const coworker = await checkOwner();
  const baseUrl = handle.url.replace(/\/+$/, "");
  const mount = new URL(`${baseUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode2`);
  const session = `/api/session/${encodeURIComponent(owner.threadId)}`;
  const wait = nativeRuntime.apiContract === "native-2" ? `/api/experimental/session/${encodeURIComponent(owner.threadId)}/wait` : `${session}/wait`;
  const transport = async (url, init = {}) => {
    const target = new URL(url);
    const route = target.pathname.slice(mount.pathname.length);
    const method = init.method ?? "GET";
    const read = method === "GET" && ([session, `${session}/inbox`, "/api/session/active"].includes(route) ? !target.search
      : route === `${session}/message` && [...target.searchParams.keys()].every((key) => ["limit", "cursor", "order"].includes(key)));
    const stop = method === "POST" && (route === `${session}/interrupt` && target.search === "?continue=false" || route === wait && !target.search);
    const cancel = method === "DELETE" && route.startsWith(`${session}/inbox/`) && /^msg_[A-Za-z0-9_]+$/.test(route.slice(`${session}/inbox/`.length)) && !target.search;
    if (target.origin !== mount.origin || !target.pathname.startsWith(`${mount.pathname}/`) || target.username || target.password || target.hash
      || init.body != null || !(read || stop || cancel)) throw new Error("Only the original native session's cleanup operations are allowed.");
    await checkOwner();
    const requestSignal = AbortSignal.any([AbortSignal.timeout(8000), ...[signal, init.signal].filter(Boolean)]);
    requestSignal.throwIfAborted();
    const response = await withAbort(request.call(handle, { workspaceId: binding?.nativeWorkspaceId ?? workspaceId, directory, method, path: `${route}${target.search}`, signal: requestSignal }), requestSignal);
    assertCurrent();
    return response;
  };
  const options = { baseUrl, workspaceId, apiContract: nativeRuntime.apiContract, token: ownerToken, requestTimeoutMs: 8000, signal, fetch: transport };
  const client = createHeadlessThreadClient(options);
  const native = createNativeV2Client(options);
  const checked = (work, scoped = true) => async (...args) => {
    if (scoped && args[0] !== owner.threadId) throw new Error("Only the original native session's cleanup operations are allowed.");
    await checkOwner();
    const value = await work(...args);
    await checkOwner();
    return value;
  };
  return Object.freeze({
    workspaceId, coworkerCreatedAt: coworker.createdAt ?? null,
    ...(slug !== ".coordinator" ? { coworkerIdentity: coworkerIdentity(coworker) } : {}),
    getThreadSnapshot: checked(async (threadId, input) => {
      const snapshot = await client.getThreadSnapshot(threadId, input);
      if (threadId !== owner.threadId || snapshot.threadId !== threadId || !snapshot.directory || path.resolve(snapshot.directory) !== directory) throw new Error("The native cleanup snapshot belongs to another workspace or session.");
      return snapshot;
    }),
    abortThread: checked(client.abortThread),
    nativeSkills: Object.freeze(Object.fromEntries(["getSession", "readHistory", "readInbox", "readActive", "reconcileInput", "cancelInput"].map((name) => [name, checked(native[name], name !== "readActive")]))),
  });
}

configureCoworkerSessionAccess({
  apiContract: () => nativeRuntime.apiContract ?? "beta19271",
  workspace: () => teamWorkspace().workspaceId,
  active: async (owner) => ownedNativeActive(await checkedSessionCoworker(owner)),
  binding: async (owner, id) => sessionBinding(await checkedSessionCoworker(owner), id),
  list: async (owner, includeLegacy) => ownedNativeSessions(await checkedSessionCoworker(owner), includeLegacy),
  create: async (owner, input) => commands["sessions.create"]({ ...owner, input }),
});

const privateTurnIntents = new Map();
const standaloneExecutions = new Map();
let nativeTeamDirectory;
const teamWorkspace = () => ({ path: teamWorkspaceDirectory(nativeTeamDirectory ?? coworkersDir), name: "Coworker team", workspaceId: teamWorkspaceId(nativeTeamDirectory ?? coworkersDir) });
const teamSessions = createTeamSessionRegistry({
  file: path.join(userDataDir, "native-session-owners.json"),
  coworkerFor: async (slug) => slug === ".coordinator" ? { ...await readCoordinator(coworkersDir), slug, createdAt: "coordinator" } : getCoworker(coworkersDir, slug),
  executionFor: async (binding) => {
    const entries = await collaboration.read((state) => Object.values(state.executions).filter((entry) => entry.owner.slug === binding.slug && entry.owner.threadId === binding.sessionId && entry.state === "running"));
    for (const run of liveWorkerTurns.values()) if (run.entry?.owner.slug === binding.slug && run.entry.owner.threadId === binding.sessionId && run.active && !run.controller.signal.aborted) entries.push(run.entry);
    const standalone = standaloneExecutions.get(binding.sessionId);
    if (standalone?.state === "running") entries.push(standalone);
    return entries.length === 1 ? entries[0] : null;
  },
});

async function sessionKind(coworker, sessionId) {
  const groups = await listGroups(coworkersDir);
  if (groups.some((group) => group.participantThreadIds[coworker.slug] === sessionId)) return "group";
  if ((await listWorkers(coworkersDir, coworker.slug)).some((worker) => worker.threadId === sessionId)) return "worker";
  const saved = parseDiscussionRegistry(await readCoworkerFile(coworkersDir, coworker.slug, DISCUSSION_REGISTRY_FILE).catch((error) => { if (error.code !== "ENOENT") throw error; return ""; }));
  if (saved.includes(sessionId) || coworker.conversationThreadId === sessionId) return "private";
  const registered = await collaboration.owner(coworker.slug, sessionId);
  return registered?.kind ?? "legacy";
}

async function sessionBinding(coworker, sessionId) {
  const known = (await teamSessions.list(coworker)).find((binding) => binding.sessionId === sessionId);
  if (known) return known;
  const handle = await ensurePlatformServer();
  const workspace = handle.config.workspaces.find((workspace) => workspace.id === coworker.workspaceId && workspace.workspaceType === "local" && path.resolve(workspace.path) === path.resolve(coworker.path));
  if (!workspace || workspace.id === teamWorkspace().workspaceId) throw new Error("This native session has no host owner.");
  const native = createNativeV2Client({ baseUrl: handle.url, workspaceId: workspace.id, token: ownerToken });
  const session = await native.getSession(sessionId);
  if (coworker.slug === ".coordinator") {
    if (!(await listGroups(coworkersDir)).some((group) => group.facilitatorThreadId === sessionId) || path.resolve(session.location.directory) !== path.resolve(coworker.path)) throw new Error("Unknown legacy coordinator history.");
    return teamSessions.bind({ slug: coworker.slug, createdAt: coworker.createdAt, sessionId, workspaceId: coworker.workspaceId, directory: coworker.path, kind: "coordinator" });
  }
  const kind = await sessionKind(coworker, sessionId);
  await teamSessions.importLegacy({ owner: coworker, workspace, sessions: [session], classify: () => kind });
  return teamSessions.resolve(sessionId, coworker);
}

async function ownedNativeSessions(coworker, includeLegacy = false) {
  const handle = await ensurePlatformServer();
  const legacy = handle.config.workspaces.find((workspace) => workspace.id === coworker.workspaceId && workspace.workspaceType === "local" && path.resolve(workspace.path) === path.resolve(coworker.path));
  if (includeLegacy && legacy && legacy.id !== teamWorkspace().workspaceId) {
    const sessions = await createNativeV2Client({ baseUrl: handle.url, workspaceId: legacy.id, token: ownerToken }).listSessions();
    const classifications = new Map(await Promise.all(sessions.map(async (session) => [session.id, await sessionKind(coworker, session.id)])));
    await teamSessions.importLegacy({ owner: coworker, workspace: legacy, sessions, classify: (id) => classifications.get(id) });
  }
  const activeLegacy = includeLegacy ? [] : await collaboration.read((state) => Object.values(state.executions).filter((entry) => entry.owner.slug === coworker.slug && ["running", "waiting-person"].includes(entry.state)).map((entry) => entry.owner.threadId));
  const records = await Promise.all((await teamSessions.list(coworker)).filter((binding) => includeLegacy || binding.nativeWorkspaceId === teamWorkspace().workspaceId || activeLegacy.includes(binding.sessionId)).map((binding) => teamSessions.route(binding.sessionId, coworker,
    async (record) => createNativeV2Client({ baseUrl: handle.url, workspaceId: record.nativeWorkspaceId, token: ownerToken }), { allowUnavailable: true })));
  return records.flatMap(({ session }) => session ? [session] : []);
}

async function ownedNativeActive(coworker) {
  const handle = await ensurePlatformServer();
  const bindings = await teamSessions.list(coworker);
  const activeIds = await collaboration.read((state) => Object.values(state.executions).filter((entry) => entry.owner.slug === coworker.slug && ["running", "waiting-person"].includes(entry.state)).map((entry) => entry.owner.threadId));
  for (const run of liveWorkerTurns.values()) if (run.entry?.owner.slug === coworker.slug && run.active) activeIds.push(run.entry.owner.threadId);
  const workspaces = new Set([teamWorkspace().workspaceId, ...bindings.filter((binding) => activeIds.includes(binding.sessionId)).map((binding) => binding.nativeWorkspaceId)]);
  const results = await Promise.all([...workspaces].map((workspaceId) => createNativeV2Client({ baseUrl: handle.url, workspaceId, token: ownerToken }).readActive()));
  const owned = new Set(bindings.map((binding) => binding.sessionId));
  return Object.fromEntries(results.flatMap((result) => Object.entries(result).filter(([id]) => owned.has(id))));
}

const legacyPreparations = new Map();
async function prepareLegacySession(coworker, binding) {
  const handle = await ensurePlatformServer();
  const key = JSON.stringify([readinessKey(), binding.workspaceId, binding.directory, binding.createdAt]);
  if (legacyPreparations.has(key)) return legacyPreparations.get(key);
  const pending = (async () => {
    const legacy = { ...coworker, path: binding.directory, workspaceId: binding.nativeWorkspaceId };
    if (coworker.slug !== ".coordinator") {
      const server = await ensureToolsServer();
      await installCollaborationPlugin(legacy, { url: server.url.replace(/\/mcp$/, "/context"), token: coworkerToolToken(coworker.slug) });
      for (const install of [installComputerPlugin, installBrowserPlugin, installGroupDocumentPlugin, installEventPlugin]) await install(legacy);
      await installAbilitiesPlugin(legacy, { url: server.url.replace(/\/mcp$/, "/context"), token: coworkerToolToken(coworker.slug) });
      await fetchJson(`${handle.url}/workspace/${encodeURIComponent(binding.nativeWorkspaceId)}/mcp`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ name: COWORKER_TOOLS_MCP_NAME, config: server.mcpConfig(coworkerToolToken(coworker.slug)) }),
      }, 120_000);
    }
    await awaitNativePluginActivation((method, route) => nativeWorkspaceRequest(handle, binding.nativeWorkspaceId, method, route), { apiContract: nativeRuntime.apiContract });
    if (coworker.slug !== ".coordinator") await prepareNativeTurnRoles((method, route, body) => nativeWorkspaceRequest(handle, binding.nativeWorkspaceId, method, route, body));
  })();
  legacyPreparations.set(key, pending);
  try { await pending; } catch (error) { legacyPreparations.delete(key); throw error; }
}

function ownedSessionClient(coworker, options, kind = "private") {
  const send = options.fetch ?? fetch;
  const client = skillAwareClient({ apiContract: nativeRuntime.apiContract, ...options, nativeWorkspaceId: options.nativeWorkspaceId ?? teamWorkspace().workspaceId, defaultAgent: options.defaultAgent ?? coworkerAgent(coworker.slug),
    onIntent: async (intent) => {
      const { threadId, messageId } = intent;
      if (messageId === undefined) {
        const team = teamWorkspace();
        await teamSessions.bind({ slug: coworker.slug, createdAt: coworker.createdAt, sessionId: threadId, workspaceId: coworker.workspaceId, nativeWorkspaceId: team.workspaceId, directory: team.path, kind });
      } else await teamSessions.resolve(threadId, coworker);
      await options.onIntent?.(intent);
    },
    fetch: async (url, init) => {
      const target = new URL(url);
      const prefix = `/workspace/${encodeURIComponent(options.workspaceId)}/opencode2`;
      if (target.origin !== new URL(options.baseUrl).origin || !target.pathname.startsWith(`${prefix}/api/`)) throw new Error("Unexpected native session host.");
      const route = target.pathname.slice(prefix.length);
      const sessionId = /^\/api\/(?:experimental\/)?session\/(ses_[A-Za-z0-9_]+)(?:\/|$)/.exec(route)?.[1];
      const binding = sessionId ? await sessionBinding(coworker, sessionId) : null;
      if (binding && binding.nativeWorkspaceId !== teamWorkspace().workspaceId && init?.method === "POST" && /\/(permission|prompt|synthetic)$/.test(route)) await prepareLegacySession(coworker, binding);
      target.pathname = `/workspace/${encodeURIComponent(binding?.nativeWorkspaceId ?? options.nativeWorkspaceId ?? teamWorkspace().workspaceId)}/opencode2${route}`;
      return send(target.href, init);
    },
  });
  client.workspaceId = coworker.workspaceId;
  client.coworkerCreatedAt = coworker.createdAt;
  return client;
}

async function privateOwner(slug, threadId, kind = "private") {
  const coworker = await getCoworker(coworkersDir, slug);
  const group = (await listGroups(coworkersDir)).find((group) => group.participantThreadIds[slug] === threadId);
  const worker = (await listWorkers(coworkersDir, slug)).find((worker) => worker.threadId === threadId);
  if (group || worker) throw new Error("This thread belongs to group or Worker work, not a private discussion.");
  let binding = await sessionBinding(coworker, threadId);
  if (binding.kind === "unassigned") binding = await teamSessions.classify(threadId, coworker, kind);
  if (![kind, "legacy"].includes(binding.kind)) throw new Error("This native session belongs to another work surface.");
  return collaboration.registerOwner({ slug, threadId, conversationId: threadId, kind, workspaceId: coworker.workspaceId, coworkerCreatedAt: coworker.createdAt,
    ...(binding.nativeWorkspaceId === teamWorkspace().workspaceId ? { agent: coworkerAgent(slug) } : {}) });
}

async function savedPrivateDiscussion(slug, threadId) {
  if (typeof threadId !== "string" || !threadId || slug === ".coordinator") throw new Error("Choose a saved private discussion.");
  const coworker = await getCoworker(coworkersDir, slug);
  if (!coworker.workspaceId) throw new Error("This coworker's workspace is not ready.");
  const [saved, workers, workerIds, groups, assignments, owners] = await Promise.all([
    readCoworkerFile(coworkersDir, slug, DISCUSSION_REGISTRY_FILE).catch((error) => { if (error.code === "ENOENT") return ""; throw error; }),
    listWorkers(coworkersDir, slug), readWorkerRegistry(coworkersDir, slug), listGroups(coworkersDir),
    listLocalResponsibilities(coworkersDir, slug),
    collaboration.read((state) => [state.owners[`${slug}:${threadId}`], ...Object.values(state.executions).filter((entry) => entry.owner.slug === slug && entry.owner.threadId === threadId).map((entry) => entry.owner)].filter(Boolean)),
  ]);
  assertPrivateComputerDiscussion({ slug, threadId, savedIds: parseDiscussionRegistry(saved), workerIds, workers, groups, assignments, owners });
  return coworker;
}

async function computerDiscussion(slug, threadId) {
  const coworker = await savedPrivateDiscussion(slug, threadId);
  const client = await collaborationClient(slug, { observationOnly: true });
  const snapshot = await client.getThreadSnapshot(threadId, { signal: AbortSignal.timeout(8000) });
  const binding = await sessionBinding(coworker, threadId);
  if (snapshot.threadId !== threadId || !snapshot.directory || path.resolve(snapshot.directory) !== binding.directory || client.workspaceId !== binding.workspaceId) throw new Error("This native discussion does not belong to its original host binding.");
  return { workspaceId: binding.workspaceId, directory: binding.directory };
}

// Short-lived metadata only. Refresh and account/workspace changes invalidate it;
// saved selections are read separately on every call and are never cached here.
const abilitiesCatalogReads = new Map();
const abilitiesRuntime = createAbilitiesRuntime({
  coworkerFor: (slug) => getCoworker(coworkersDir, slug),
  readCatalog: async (coworker, nativeSkills) => {
    const handle = await ensurePlatformServer();
    const request = (route) => fetchJson(`${handle.url}${route}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }, 5_000);
    // Native admission already owns the skill catalog. Re-entering its proxy
    // here would wait on the same preparation barrier from inside the plugin.
    if (nativeSkills !== undefined) return readAbilitiesCatalog({ ...coworker, workspaceId: teamWorkspace().workspaceId }, request, nativeSkills);
    const identity = JSON.stringify([coworker.createdAt, coworker.workspaceId, handle.url, denSession?.baseUrl, denSession?.orgId, denSession?.userEmail]);
    const cached = abilitiesCatalogReads.get(coworker.path);
    if (cached?.identity === identity && cached.expiresAt > Date.now()) return cached.result;
    const result = readAbilitiesCatalog({ ...coworker, workspaceId: teamWorkspace().workspaceId }, request);
    abilitiesCatalogReads.set(coworker.path, { identity, expiresAt: Date.now() + 10_000, result });
    return result;
  },
});

const nativePluginInstalls = new Map();
let installedTeamRevision = "";
async function installNativeCoworkerPlugins(coworker, server) {
  const team = teamWorkspace();
  const key = team.path;
  const pending = (nativePluginInstalls.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const coworkers = await listCoworkers(coworkersDir);
    if (coworker.slug && !coworkers.some((current) => current.slug === coworker.slug && current.createdAt === coworker.createdAt)) throw new Error("This coworker was replaced before its tools were prepared.");
    const context = { mode: "team", url: server.url.replace(/\/mcp$/, "/context"), token: coworkerToolToken(".team") };
    const configured = await assertTeamCompatibleHomes(coworkers);
    // The optional features shape every coworker's contract and which tools are off.
    const { features } = await readSettings(settingsPath);
    const revision = JSON.stringify([configured.map(({ slug, createdAt, name, nativePermissions }) => ({ slug, createdAt, name, nativePermissions })), context, features]);
    if (installedTeamRevision === revision) return;
    await updateTeamWorkspaceConfig(coworkersDir, coworkers, features);
    await writeTeamFeatures(coworkersDir, features);
    await installCollaborationPlugin(team, context);
    await installComputerPlugin(team);
    await installBrowserPlugin(team);
    await installGroupDocumentPlugin(team);
    await installEventPlugin(team);
    await installAbilitiesPlugin(team, { ...context, coworkers });
    await installProgressPlugin(team);
    await installMemoryPlugin(team);
    installedTeamRevision = revision;
    warmedCoworkerWorkspaces.delete(team.workspaceId);
  });
  nativePluginInstalls.set(key, pending);
  try { await pending; } finally { if (nativePluginInstalls.get(key) === pending) nativePluginInstalls.delete(key); }
}

let progressCoordinator = null;
/** Only an already-warmed coordinator is usable. No setup or engine repair on this path. */
async function readyProgressTransport() {
  const handle = serverHandle;
  const workspaceId = progressCoordinator?.workspaceId;
  if (!handle?.managedOpencodeV2?.isAlive() || !workspaceId || !warmedCoworkerWorkspaces.has(workspaceId)) return null;
  const catalog = await readModelCatalog(workspaceId, { handle, signal: AbortSignal.timeout(PROGRESS_LIMITS.activityReadTimeoutMs) });
  return {
    key: `${handle.url}/${workspaceId}`,
    models: eligibleProgressModels(catalog),
    client: createHeadlessThreadClient({ baseUrl: handle.url, workspaceId, apiContract: nativeRuntime.apiContract, token: ownerToken, defaultAgent: NATIVE_COORDINATOR_AGENT, requestTimeoutMs: PROGRESS_LIMITS.timeoutMs }),
  };
}

const progressSummaries = createProgressSummaries({
  settings: () => readSettings(settingsPath),
  ready: readyProgressTransport,
  listExecutions: () => collaboration.read((state) => Object.values(state.executions).filter((entry) => {
    const task = state.tasks[entry.taskId];
    if (entry.state !== "running" || entry.owner.kind === "coordinator" || task?.executionId !== entry.id || ["succeeded", "failed", "cancelled"].includes(task.state)) return false;
    for (let parent = task, depth = 0; parent && depth < 8; parent = state.tasks[parent.parentId], depth++) if (parent.cancelRequested || parent.state === "cancelled") return false;
    return !state.groups[entry.owner.groupId]?.cancelledRequestIds?.includes(entry.groupRequestId);
  }).map((entry) => ({ executionId: entry.id, budgetId: entry.taskId, createdAt: Math.min(entry.createdAt, state.tasks[entry.taskId].createdAt), slug: entry.owner.slug, threadId: entry.owner.threadId, groupId: entry.owner.groupId }))),
  readActivity: async (entry) => (await readCollaborationActivity({ ...(entry.groupId ? { groupId: entry.groupId } : { slug: entry.slug, threadId: entry.threadId }), executionId: entry.executionId }))[0],
});

const conversationMemory = createConversationMemory({
  directory: coworkersDir,
  settings: () => readSettings(settingsPath),
  ready: readyProgressTransport,
  groupsFor: async (slug) => (await listGroups(coworkersDir)).filter((group) => group.archivedAt === null && group.participantSlugs.includes(slug)).map((group) => group.id),
});

async function captureConversationMemory(entry) {
  const coworker = await getCoworker(coworkersDir, entry.owner.slug);
  // A retired coworker's late completion must not populate a same-name replacement.
  if (!entry.workspaceId || entry.workspaceId !== coworker.workspaceId) return false;
  return conversationMemory.capture(entry);
}

/** Activity observation never starts a server, installs tools, or cancels parent work. */
async function readCollaborationActivity(scope) {
  const handle = serverHandle;
  const entries = await collaboration.activityEntries(scope, PROGRESS_LIMITS.maxActivityExecutions);
  const observed = await Promise.all(entries.filter((entry) => !scope.executionId || entry.executionId === scope.executionId).map(async (entry) => {
    const empty = { replies: [], tools: [], completedSteps: 0, failedSteps: 0, available: false, nativeStatus: "unknown" };
    if (handle !== serverHandle || !handle?.managedOpencodeV2?.isAlive()) return { ...entry, ...empty };
    try {
      const coworker = await getCoworker(coworkersDir, entry.slug);
      if (!coworker.workspaceId || entry.workspaceId !== coworker.workspaceId || entry.coworkerCreatedAt !== coworker.createdAt) return { ...entry, ...empty };
      if (entry.admission?.inFlight && !entry.admission.confirmed) return { ...entry, ...empty, available: true };
      const binding = await sessionBinding(coworker, entry.threadId);
      const snapshot = await readExecutionActivity({ serverUrl: handle.url, workspaceId: binding.nativeWorkspaceId, apiContract: nativeRuntime.apiContract, token: ownerToken, threadId: entry.threadId, messageId: entry.messageId, signal: AbortSignal.timeout(PROGRESS_LIMITS.activityReadTimeoutMs) });
      return { ...entry, ...snapshot, available: handle === serverHandle && handle.managedOpencodeV2.isAlive() };
    } catch { return { ...entry, ...empty }; }
  }));
  const current = await collaboration.activityEntries(scope, PROGRESS_LIMITS.maxActivityExecutions);
  return observed.flatMap((entry) => {
    const latest = current.find((item) => item.executionId === entry.executionId && item.messageId === entry.messageId && item.threadId === entry.threadId && item.slug === entry.slug && item.workspaceId === entry.workspaceId && item.coworkerCreatedAt === entry.coworkerCreatedAt);
    if (!latest) return [];
    const activity = { ...entry, ...latest, available: entry.available && handle === serverHandle && Boolean(handle?.managedOpencodeV2?.isAlive()) && (!entry.admission?.inFlight || Boolean(latest.admission?.inFlight)) };
    return [{ ...activity, progressNote: progressSummaries.noteFor(activity) }];
  });
}

function workerKey(slug, id) {
  return `${slug}:${id}`;
}

/** Read identity from the authenticated main-process account, never from draft metadata. */
function assertSkillSession(session) {
  if (!session || denSession !== session || appliedSkillSession?.session !== session || appliedSkillSession.handle !== serverHandle) throw new Error("The OpenWork connection is changing or has not finished syncing. Finish connecting, then select the skill again; your words are kept.");
}

async function currentSkillAccount(session, signal) {
  if (!session) throw new Error("The selected skill's OpenWork account is signed out. Your words are kept.");
  assertSkillSession(session);
  const response = await fetch(`${session.baseUrl}/v1/me`, { headers: { Authorization: `Bearer ${session.token}`, "x-openwork-org-id": session.orgId }, redirect: "error", signal: signal ?? AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("The selected skill's OpenWork account could not be verified. Your words are kept.");
  const payload = await response.json();
  assertSkillSession(session);
  if (denSession !== session || typeof payload.user?.id !== "string" || !payload.user.id) throw new Error("The OpenWork account changed while checking selected skills. Your words are kept.");
  return { scope: { baseUrl: session.baseUrl, orgId: session.orgId, accountId: payload.user.id }, email: payload.user.email };
}

function skillAccountKey(session) {
  return session ? createHash("sha256").update(JSON.stringify([session.baseUrl, session.orgId, session.token])).digest("hex") : null;
}

function skillAwareClient({ captureSkillOrigin = false, nativeWorkspaceId, ...options }) {
  const preparationWorkspaceId = nativeWorkspaceId ?? options.workspaceId;
  let pinnedSession;
  let pinnedScope;
  let validated = false;
  const send = options.fetch ?? fetch;
  const transport = (url, init) => {
    const headers = new Headers(init?.headers);
    // Neither callers nor an old client configuration may override the selected receipt.
    headers.delete("x-openwork-native-skills-scope");
    // Recheck at actual input admission after native preflight. Stop/cleanup must remain usable after sign-out.
    if (init?.method === "POST" && /\/(prompt|synthetic)$/.test(new URL(url).pathname) && pinnedSession !== undefined) {
      assertSkillSession(pinnedSession);
      headers.set("x-openwork-native-skills-scope", pinnedScope);
    }
    return send(url, { ...init, headers });
  };
  const client = createHeadlessThreadClient({ admissionTimeoutMs: 60_000, ...options, fetch: transport });
  client.nativeSkills = createNativeV2Client({ ...options, fetch: transport });
  client.validateSkills = async (fields, signal) => {
    const expectedScope = selectedCloudSkillScope(fields);
    if (validated && expectedScope !== pinnedScope) throw new Error("The selected Cloud skill scope changed. Select it again in a new turn; your words are kept.");
    const session = denSession;
    const account = fields.skillSelections?.some((skill) => skill.source) ? (await currentSkillAccount(session, signal)).scope : null;
    const catalog = await client.nativeSkills.listSkills(signal);
    if (account) assertSkillSession(session);
    validateSkillSelections(fields, catalog, options.workspaceId, account);
    if (account) {
      if (pinnedSession !== undefined && pinnedSession !== session) throw new Error("The selected skill's account revision changed. Your words are kept.");
      pinnedSession = session;
    }
    pinnedScope = expectedScope;
    validated = true;
  };
  if (captureSkillOrigin) client.prepareSkillOrigin = async (turn, signal) => {
    const session = denSession;
    const accountKey = skillAccountKey(session);
    const preparationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const assertCurrent = () => {
      if (preparationSignal.aborted && preparationSignal.reason?.name === "TimeoutError") {
        throw new Error("Checking skills took too long before OpenCode received your message. Your message is kept; nothing was sent.");
      }
      preparationSignal.throwIfAborted();
      if (denSession !== session || skillAccountKey(denSession) !== accountKey) throw new Error("The OpenWork account changed while checking selected skills. Your words are kept.");
    };
    let binding = null;
    let emptyNativeSkillOrigin = false;
    if (session) {
      try {
        const handle = !validated && !turn.skills?.length && !turn.skillSelections?.length && typeof serverHandle?.nativeSkillOriginSnapshot === "function" ? serverHandle : null;
        const registered = handle?.config?.workspaces?.filter((workspace) => workspace.id === preparationWorkspaceId) ?? [];
        const workspace = registered.length === 1 && registered[0].workspaceType === "local" ? registered[0] : null;
        const directory = workspace?.path;
        const hintCurrent = () => workspace && typeof directory === "string" && path.isAbsolute(directory)
          && handle === serverHandle && handle.url === options.baseUrl && options.token === ownerToken
          && handle.managedOpencodeV2?.isAlive() && handle.config.workspaces.includes(workspace)
          && workspace.workspaceType === "local" && workspace.id === preparationWorkspaceId && workspace.path === directory;
        const readHint = async () => {
          assertCurrent();
          if (!hintCurrent()) return null;
          const hint = await handle.nativeSkillOriginSnapshot({ workspaceId: preparationWorkspaceId, directory, signal: preparationSignal });
          assertCurrent();
          return hintCurrent() && Array.isArray(hint?.scopes) && Object.isFrozen(hint) && Object.isFrozen(hint.scopes)
            && (hint.scopes.length === 0 || hint.scopes.length === 1 && typeof hint.scopes[0] === "string" && /^[0-9a-f]{64}$/.test(hint.scopes[0])) ? hint : null;
        };
        try {
          const hint = await readHint();
          if (hint) {
            if (hint.scopes.length === 0) {
              emptyNativeSkillOrigin = await readHint() === hint;
            } else {
              const account = (await currentSkillAccount(session, preparationSignal)).scope;
              assertCurrent();
              if (await readHint() === hint) {
                assertSkillSession(session);
                binding = { account, scope: hint.scopes[0] };
              }
            }
          }
        } catch (error) {
          assertCurrent();
          if (error?.name === "AbortError") throw error;
        }
        // Only an explicit, stable empty native snapshot can skip discovery.
        // A missing hint can mean that Cloud skills are present but stale.
        if (!binding && !emptyNativeSkillOrigin) {
          const catalog = await client.nativeSkills.listSkills(preparationSignal);
          assertCurrent();
          const scopes = [...new Set(catalog.flatMap((skill) => skill.source ? [skill.source.scope] : []))];
          if (scopes.length > 1 || scopes.some((scope) => !/^[0-9a-f]{64}$/.test(scope))) throw new Error("The selected skill's OpenWork account could not be verified. Your words are kept.");
          if (scopes.length) {
            const account = (await currentSkillAccount(session, preparationSignal)).scope;
            assertCurrent();
            assertSkillSession(session);
            binding = { account, scope: scopes[0] };
          }
        }
      } catch (error) {
        assertCurrent();
        if (error?.name === "AbortError" || pinnedSession !== undefined) throw error;
      }
    }
    if (binding?.scope) {
      if ((pinnedSession !== undefined && pinnedSession !== session) || (pinnedScope !== undefined && pinnedScope !== binding.scope)) throw new Error("The OpenWork account changed while checking selected skills. Your words are kept.");
      pinnedSession = session;
      pinnedScope = binding.scope;
    }
    const receipt = { version: 1, workspaceId: options.workspaceId, messageId: turn.messageId, accountKey, account: binding?.account ?? null, scope: binding?.scope ?? null };
    await collaboration.change((state) => {
      assertCurrent();
      const current = state.executions[turn.id];
      if (!current || current.messageId !== turn.messageId || current.workspaceId !== options.workspaceId
        || current.owner.slug !== turn.owner?.slug || current.owner.threadId !== turn.owner?.threadId
        || current.nativeAdmission !== "prepared" || current.state !== "running") throw new Error("This execution stopped or changed before native admission.");
      current.cloudSkillOrigin = receipt;
    });
    assertCurrent();
    return receipt;
  };
  return client;
}

async function resolveWorkerSkills(slug, input, origin) {
  const session = denSession;
  const accountKey = skillAccountKey(session);
  const ids = nativeV2SkillsSchema.parse(input.skills ?? []);
  const inherited = origin ? selectionFields(origin.skillSelections ?? []) : input.skillSelections === undefined ? null : selectionFields(input.skillSelections);
  if (inherited && !sameSkillFields(origin ?? input, inherited)) throw new Error("The originating turn's skill selections do not match its admitted input.");
  const recorded = origin?.cloudSkillOrigin;
  const receipt = recorded?.version === 1 && recorded.workspaceId === origin.workspaceId && recorded.messageId === origin.messageId
    && typeof recorded.accountKey === "string" && /^[0-9a-f]{64}$/.test(recorded.accountKey)
    && typeof recorded.scope === "string" && /^[0-9a-f]{64}$/.test(recorded.scope) ? structuredClone(recorded) : null;
  let scope = selectedCloudSkillScope(inherited ?? {}) ?? receipt?.scope;
  let account = inherited?.skillSelections.find((skill) => skill.source)?.account ?? receipt?.account;
  const fresh = !origin && !inherited;
  let cloudSelected = ids.some(({ id }) => id.startsWith("openwork-cloud-") || inherited?.skillSelections.some((skill) => skill.id === id && skill.source));
  const assertSession = () => {
    if (denSession !== session || skillAccountKey(denSession) !== accountKey || (receipt && receipt.accountKey !== accountKey)) throw new Error("The OpenWork account changed while checking selected skills. Your words are kept.");
    assertSkillSession(session);
  };
  const assertCurrent = () => {
    assertSession();
    if (!scope || !account?.baseUrl || !account.orgId || !account.accountId) throw new Error("The selected skill's OpenWork account could not be verified. Your words are kept.");
  };
  if (cloudSelected) { if (fresh) assertSession(); else assertCurrent(); }
  if (!ids.length) return selectionFields([]);
  const signal = AbortSignal.timeout(30_000);
  const coworker = await getCoworker(coworkersDir, slug);
  if (origin && (origin.owner.slug !== slug || origin.workspaceId !== coworker.workspaceId)) throw new Error("The originating skill selection belongs to another coworker workspace.");
  if (cloudSelected) assertSession();
  const handle = await ensurePlatformServer();
  if (cloudSelected) assertSession();
  const client = ownedSessionClient(coworker, { baseUrl: handle.url, workspaceId: coworker.workspaceId, token: ownerToken });
  const catalog = await client.nativeSkills.listSkills(signal);
  const selectedCloud = catalog.filter((skill) => skill.source && ids.some(({ id }) => id === skill.id));
  cloudSelected ||= selectedCloud.length > 0;
  if (cloudSelected) {
    assertSession();
    if (fresh) {
      const scopes = [...new Set(selectedCloud.map((skill) => skill.source.scope))];
      if (scopes.length !== 1 || !/^[0-9a-f]{64}$/.test(scopes[0])) throw new Error("The selected skill's OpenWork account could not be verified. Your words are kept.");
      scope = scopes[0];
    } else assertCurrent();
    if (selectedCloud.some((skill) => skill.source.scope !== scope)) throw new Error("The OpenWork account changed while checking selected skills. Your words are kept.");
    const currentAccount = (await currentSkillAccount(session, signal)).scope;
    if (fresh) account = currentAccount;
    assertCurrent();
    if (currentAccount.baseUrl !== account.baseUrl || currentAccount.orgId !== account.orgId || currentAccount.accountId !== account.accountId) throw new Error("The OpenWork account changed while checking selected skills. Your words are kept.");
  }
  const fields = selectionFields(ids.map(({ id }) => inherited?.skillSelections.find((skill) => skill.id === id)
    ?? selectCatalogSkill(catalog, { id }, coworker.workspaceId, cloudSelected ? account : null)));
  await client.validateSkills(fields, signal);
  if (cloudSelected) assertCurrent();
  return fields;
}

/** Saved Worker choices never inherit a later edit to the coworker's model. */
async function readyWorkerClient(coworker, worker = null) {
  const handle = await ensurePlatformServer();
  if (!coworker.workspaceId) throw new Error("This coworker's workspace is not ready yet.");
  const binding = worker?.threadId ? await sessionBinding(coworker, worker.threadId) : null;
  if (worker?.pendingTurn && worker.pendingTurn.nativeAdmission !== "prepared") {
    if (!binding) throw new Error("The original Worker session binding is unavailable.");
  } else if (binding && binding.nativeWorkspaceId !== teamWorkspace().workspaceId) await prepareLegacySession(coworker, binding);
  else await warmCoworkerWorkspace(coworker);
  return ownedSessionClient(coworker, {
    baseUrl: handle.url,
    workspaceId: coworker.workspaceId,
    nativeWorkspaceId: binding?.nativeWorkspaceId ?? teamWorkspace().workspaceId,
    token: ownerToken,
    // Missing legacy pins are observation-only; recovery must not select a
    // replacement model just to read an already-accepted input.
    defaultModel: worker ? worker.pendingTurn?.model ?? worker.modelSnapshot ?? undefined : await localRunModel(coworker, "worker-turn"),
  }, "worker");
}

async function workerModelProviders(coworker, readDefault = false) {
  const handle = await ensurePlatformServer();
  const native = createNativeV2Client({ baseUrl: handle.url, workspaceId: teamWorkspace().workspaceId, token: ownerToken });
  const [catalog, preferred] = await Promise.all([native.readCatalog(), readDefault ? native.defaultModel() : undefined]);
  const providers = nativeCatalogProviders(catalog);
  return { providers, default: preferred ? { [preferred.providerID]: preferred.id } : {}, model: preferred ? `${preferred.providerID}/${preferred.id}` : undefined };
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
  if (input.control !== undefined) {
    workerControlRequest(input.control);
    if (input.control === "computer" && !(await readSettings(settingsPath)).features.computerUse) {
      throw new Error("Computer use is off in this app. The person can turn it on in Settings, Features.");
    }
    await computerDiscussion(slug, input.spawnedFromThreadId);
    if (input.purpose === "thinking" || input.lifespan?.kind === "open") throw new Error("Control needs a bounded delivery Worker.");
  }
  if (input.id) {
    const existing = await getWorker(coworkersDir, slug, input.id).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
    if (existing) {
      if (!sameSkillFields(existing, input)) throw new Error("This Worker already records different skill selections.");
      if (isWorkerFinished(existing)) await collaboration.completeWorker(existing, existing.pendingSettlement?.events ?? await readWorkerEvents(coworkersDir, slug, existing.id));
      else void admitWorkerTurn(slug, existing.id);
      return workerControls.summary(existing);
    }
  }
  const coworker = await getCoworker(coworkersDir, slug);
  if (!coworker.workspaceId) throw new Error("This coworker's workspace is not ready yet.");
  const purpose = workerPurpose(input.purpose);
  const lifespan = input.lifespan === undefined || input.lifespan === null
    ? { kind: "turns", max: purpose === "thinking" ? THINKING_TURN_BUDGET : workerTurnsFor(effortStopOf(coworker.effortPreference)), used: 0 }
    : input.lifespan;
  const configured = purpose === "thinking" ? coworker.thinkingModel : coworker.deliveryModel;
  const { modelDefaults } = await readSettings(settingsPath);
  const catalog = await workerModelProviders(coworker, !configured && !modelDefaults[purpose].model && !coworker.model);
  const modelSnapshot = resolveWorkerModel(coworker, purpose, catalog.providers, null, catalog, modelDefaults);
  const skills = await resolveWorkerSkills(slug, input);
  const worker = await createWorker(coworkersDir, slug, { ...input, ...skills, purpose, modelSnapshot, lifespan, spawnedBy });
  if (spawnedBy === "person" && worker.spawnedFromThreadId) await collaboration.attachWorker(worker, await privateOwner(slug, worker.spawnedFromThreadId), { activityEligible: true });
  await appendWorkerEvent(coworkersDir, slug, worker.id, {
    kind: "status",
    text: spawnedBy === "coworker" ? `Started by ${coworker.name}` : "Started by you",
    by: spawnedBy,
  });
  if (!worker.spawnedFromThreadId) await appendWorkerEvent(coworkersDir, slug, worker.id, { id: `evt_${collaborationId(worker.id, "origin-missing").slice(5)}`, kind: "status", text: "No originating conversation was recorded. Findings remain here; no private conversation will receive an automatic follow-up." });
  await syncWorkerNote(slug, worker);
  if (!isWorkerFinished(worker)) void admitWorkerTurn(slug, worker.id);
  return workerControls.summary(worker);
}

/** Take a slot for the Worker's next turn now, or wait in line with the other runs on this Mac. */
function admitWorkerTurn(slug, id) {
  return admitLocalRun(async () => {
    const key = workerKey(slug, id);
    if (activeLocalRuns.has(key) || isQueued(key) || liveWorkerTurns.has(key)) return;
    const worker = await getWorker(coworkersDir, slug, id).catch(() => null);
    if (!worker || isWorkerFinished(worker) || worker.status === "paused" || !workerControls.allowed(worker) || (worker.waitingFor === "decision" && worker.pendingSteers.length === 0)) return;
    const limit = await parallelRunLimit();
    if (activeLocalRuns.size >= limit) {
      queuedLocalRuns.push({ key, slug, id, runId: "", launch: () => launchWorkerTurn(slug, id) });
      const queued = await updateWorker(coworkersDir, slug, id, (current) => isWorkerFinished(current) || current.status === "paused" ? null : { status: "waiting", waitingFor: "turn" });
      if (isWorkerFinished(queued) || queued.status === "paused") removeQueuedRun(key);
      return;
    }
    activeLocalRuns.add(key);
    await launchWorkerTurn(slug, id);
  });
}

/** Resolve once the turn is recorded as running (or could not start); the turn itself continues detached. */
function launchWorkerTurn(slug, id) {
  return new Promise((resolve) => {
    void maintenanceAdmission.run(() => executeWorkerTurn(slug, id, { onStarted: resolve })).catch(resolve);
  });
}

async function executeWorkerTurn(slug, id, { onStarted }) {
  const key = workerKey(slug, id);
  if (liveWorkerTurns.has(key)) { activeLocalRuns.delete(key); onStarted(); return; }
  const controller = new AbortController();
  let release;
  const run = { controller, active: false, entry: null, client: null, threadId: "", done: new Promise((resolve) => { release = resolve; }), cleanupError: null };
  liveWorkerTurns.set(key, run);
  let continueAfter = false;
  let eventDeadlineTimer;
  try {
    let worker;
    let coworker;
    try {
      worker = await getWorker(coworkersDir, slug, id);
      run.threadId = worker.threadId;
      coworker = await getCoworker(coworkersDir, slug);
      if (isWorkerFinished(worker) || worker.status === "paused" || !workerControls.allowed(worker)) {
        onStarted();
        return;
      }
      if (lifespanSpent(worker.lifespan) && !worker.pendingTurn) {
        await settleWorkerTurn(slug, id, { kind: "settled", report: { kind: "none", text: "" } });
        onStarted();
        return;
      }
      worker = await prepareWorkerTurn(coworkersDir, slug, id, coworker.name);
      if (worker.status !== "running") {
        onStarted();
        return;
      }
    } catch (error) {
      console.warn(`[open-coworker] Worker ${key} did not start a turn`, error);
      onStarted();
      return;
    }
    onStarted();
    run.entry = { id: `worker:${id}:${worker.pendingTurn.messageId}`, owner: { kind: "worker", slug, threadId: worker.threadId, conversationId: worker.threadId }, messageId: worker.pendingTurn.messageId, workspaceId: coworker.workspaceId, state: "running", sentAt: Date.now() };
    let client;
    let threadId = worker.threadId;
    const drainNative = () => {
      if (!threadId) return Promise.resolve();
      return run.stopping ??= (async () => {
        const signal = AbortSignal.timeout(30_000);
        try {
          if (!client) throw new Error("Native cleanup could not be confirmed. Try Stop again before continuing.");
          await withAbort(abortWorkerThread(client, threadId, signal), signal);
        } catch (error) { run.cleanupError = error; throw error; }
      })();
    };
    const settle = async (outcome) => {
      run.entry.state = outcome.kind === "failed" ? "failed" : "succeeded";
      if (outcome.kind === "failed") {
        try { await drainNative(); }
        catch {
          await updateWorker(coworkersDir, slug, id, (current) => isWorkerFinished(current) ? null : { error: `${outcome.error} Native cleanup could not be confirmed. Try Stop again before continuing.` });
          return false;
        }
      }
      if (run.eventOwner && run.client && threadId) {
        const snapshot = await run.client.getThreadSnapshot(threadId, { signal: AbortSignal.timeout(10_000) });
        await events.captureExecution({ ...run.entry, owner: { ...run.eventOwner, kind: "worker", threadId } }, snapshot);
      }
      if (!await workerControls.endRun(run)) {
        run.cleanupError = new Error("Worker control cleanup could not be confirmed. Try Stop again before continuing.");
        return false;
      }
      return settleWorkerTurn(slug, id, outcome);
    };
    try {
      const eventBudget = await collaboration.admitEventWorker(worker);
      run.eventOwner = eventBudget?.owner;
      run.eventPromptPrefix = eventBudget?.promptPrefix;
      if (eventBudget) eventDeadlineTimer = setTimeout(() => controller.abort(new Error("The event reached its duration limit.")), Math.max(1, eventBudget.deadlineAt - Date.now()));
      client = await readyWorkerClient(coworker, worker);
      run.client = client;
      controller.signal.throwIfAborted();
      // Accepted recovery only observes the old turn, even if access was since
      // revoked. Every new send validates the pinned choice before any inference.
      const snapshot = threadId ? await client.getThreadSnapshot(threadId, { signal: controller.signal }) : null;
      const present = snapshot && nativeTurnReceipt(snapshot, worker.pendingTurn.messageId).present;
      if (present) await verifyNativeTurnSkills(client, snapshot, worker.pendingTurn, controller.signal);
      if (!present && worker.pendingTurn.nativeAdmission !== "prepared") throw new Error("The Worker's native admission could not be confirmed. Its earlier work will not be resent; review it before starting again.");
      if (!present && lifespanSpent(worker.lifespan)) {
        await settle({ kind: "settled", report: { kind: "none", text: "" } });
        return;
      }
      if (worker.modelSnapshot && !present) resolveWorkerModel(coworker, worker.purpose, (await workerModelProviders(coworker)).providers, worker.modelSnapshot);
      controller.signal.throwIfAborted();
      const eventTools = run.eventOwner?.eventRunId ? EVENT_SCHEDULE_DENY : EVENT_WRITE_DENY;
      const binding = threadId ? await sessionBinding(coworker, threadId) : null;
      const shared = !binding || binding.nativeWorkspaceId === teamWorkspace().workspaceId;
      const agent = present ? worker.pendingTurn.agent : nativeTurnAgent({ ...(shared ? { slug } : {}), tools: { ...workerTurnTools(worker.control?.surface), ...eventTools } });
      if (!present) {
        if (worker.pendingTurn.agent !== undefined && worker.pendingTurn.agent !== agent) throw new Error("The Worker's native agent does not match its owner and approved tool role.");
        const intentThreadId = threadId || createNativeV2Id("ses");
        worker = await updateWorker(coworkersDir, slug, id, (current) => {
          if (current.status !== "running" || current.pendingTurn?.messageId !== worker.pendingTurn.messageId || current.pendingTurn.nativeAdmission !== "prepared") throw new Error("The Worker stopped or changed before native admission.");
          if (current.pendingTurn.agent !== undefined && current.pendingTurn.agent !== agent) throw new Error("The Worker's native agent changed before native admission.");
          const model = current.pendingTurn.model ?? current.modelSnapshot;
          if (!model) throw new Error("The Worker's model was not recorded. Choose a model for a new Worker; this Worker will not switch models.");
          const pendingTurn = { ...current.pendingTurn, agent, model };
          if (pendingTurn.eventPromptPrefix === undefined) {
            pendingTurn.eventPromptPrefix = run.eventPromptPrefix || "";
            if (pendingTurn.eventPromptPrefix) pendingTurn.prompt = `${pendingTurn.eventPromptPrefix}\n\n${pendingTurn.prompt}`;
          }
          return { threadId: intentThreadId, pendingTurn };
        });
      }
      if (!threadId) {
        // The durable intent and exclusion registry precede the native write.
        // A lost creation response retains exactly one recoverable identity.
        threadId = worker.threadId;
        run.threadId = threadId;
        await registerWorkerThread(coworkersDir, slug, threadId);
        await client.createThread({ threadId, title: workerThreadTitle(worker.name), agent, model: worker.pendingTurn.model, signal: controller.signal });
      }
      if (isWorkerFinished(await getWorker(coworkersDir, slug, id)) || !workerControls.allowed(worker) || controller.signal.aborted) {
        controller.abort();
        return;
      }
      if (!present && lifespanSpent(worker.lifespan)) {
        await settle({ kind: "settled", report: { kind: "none", text: "" } });
        return;
      }
      run.entry.owner.threadId = threadId; run.entry.owner.conversationId = threadId;
      await workerControls.admit(worker, run);
      controller.signal.throwIfAborted();
      if (!present && agent !== nativeTurnAgent({ ...(shared ? { slug } : {}), tools: { ...workerTurnTools(run.control?.surface), ...eventTools } })) throw new Error("The Worker's approved control surface changed before native admission.");
      Object.assign(run.entry, { agent, model: worker.pendingTurn.model ?? worker.modelSnapshot, coworkerCreatedAt: coworker.createdAt, tools: { ...workerTurnTools(run.control?.surface), ...eventTools } });
      run.active = true;
      await collaboration.admitEventWorker(worker);
      const acceptance = await dispatchNativeTurn({ client, threadId, turn: worker.pendingTurn, signal: controller.signal, markAttempted: async () => {
        worker = await updateWorker(coworkersDir, slug, id, (current) => {
          if (current.status !== "running" || current.pendingTurn?.messageId !== worker.pendingTurn.messageId || (!present && current.pendingTurn.nativeAdmission !== "prepared")) throw new Error("The Worker stopped or changed before native admission.");
          if (!present && current.pendingTurn.agent !== agent) throw new Error("The Worker's native agent changed before native admission.");
          return { pendingTurn: { ...current.pendingTurn, nativeAdmission: "attempted" } };
        });
      } });
      for (const [index, steer] of (worker.pendingTurn.steers ?? []).entries()) {
        await appendWorkerEvent(coworkersDir, slug, id, { id: `evt_${collaborationId(id, worker.pendingTurn.messageId, "steer-applied", steer.id ?? index).slice(5)}`, kind: "status", by: steer.by, turnId: worker.pendingTurn.messageId, text: `Applied to admitted step: ${steer.text}` });
      }
      const result = await waitForNativeTurn(client, threadId, {
        ...worker.pendingTurn,
        timeoutMs: worker.lifespan.kind === "until" ? Math.max(1, Math.min(WORKER_TURN_TIMEOUT_MS, worker.lifespan.at - Date.now())) : WORKER_TURN_TIMEOUT_MS,
        pollIntervalMs: 1_000,
        signal: controller.signal,
        since: acceptance,
      });
      // Stopped while it ran: the stop already recorded itself.
      if (controller.signal.aborted) return;
      if (result.outcome === "timeout") await drainNative();
      const outcome = result.outcome === "timeout" && lifespanSpent(worker.lifespan)
          ? { kind: "settled", report: { kind: "none", text: "" } }
          : workerTurnOutcome(result, toTranscript(result.snapshot), worker.pendingTurn.messageId);
      continueAfter = await settle(outcome);
    } catch (error) {
      if (!controller.signal.aborted) {
        const failure = error instanceof Error ? error.message : String(error);
        continueAfter = await settle({ kind: "failed", error: failure });
      }
    } finally {
      run.active = false;
      if (run.control) {
        const cleaned = controller.signal.aborted ? await workerControls.revokeId(slug, id) : await workerControls.endRun(run);
        if (!cleaned) run.cleanupError = new Error("Worker control cleanup could not be confirmed.");
      }
      // Cancelling the HTTP wait alone does not stop native execution. This
      // also covers Stop arriving while the first thread was being created.
      if (controller.signal.aborted && client && threadId) {
        try { await drainNative(); }
        catch (error) { run.cleanupError = error; console.warn("[open-coworker] Worker native cleanup is unconfirmed; use Stop to retry."); }
      }
    }
  } finally {
    clearTimeout(eventDeadlineTimer);
    release();
    if (!run.cleanupError && liveWorkerTurns.get(key) === run) liveWorkerTurns.delete(key);
    workerControls.releaseRun(run);
    activeLocalRuns.delete(key);
    // Runs already in line go first; this Worker's next turn asks for a slot after them.
    void drainLocalRunQueue();
    if (continueAfter && !run.cleanupError) void admitWorkerTurn(slug, id);
  }
}

/** Record what a settled turn meant and wake the coworker for anything it reported; returns whether to take another turn. */
async function settleWorkerTurn(slug, id, outcome) {
  const now = Date.now();
  let step;
  let updated;
  try {
    updated = await updateWorker(coworkersDir, slug, id, (current) => {
      step = current.pendingSettlement ?? { ...nextWorkerState(current, outcome, { now, hasPendingSteer: current.pendingSteers.length > 0 }), messageId: current.pendingTurn?.messageId ?? collaborationId(id, now) };
      return current.pendingSettlement ? null : { ...step.patch, pendingSettlement: step };
    }, { now });
  } catch {
    return false;
  }
  // The durable settlement is replayable until both the continuation obligation
  // and legacy finding projections are recorded. Only then clear the admitted turn.
  if (isWorkerFinished(updated) && !await workerControls.revoke(updated)) throw new Error("Worker control cleanup could not be confirmed before completion.");
  await collaboration.completeWorker(updated, step.events);
  if (updated.status === "cancelled") {
    await updateWorker(coworkersDir, slug, id, { pendingTurn: null, pendingSettlement: null });
    return false;
  }
  let latestFinding = null;
  for (const [index, event] of step.events.entries()) {
    const recorded = await appendWorkerEvent(coworkersDir, slug, id, { ...event, id: `evt_${collaborationId(id, step.messageId, index).slice(5)}` }, { now });
    if (event.kind === "finding") {
      latestFinding = recorded;
    }
  }
  await updateWorker(coworkersDir, slug, id, { pendingTurn: null, pendingSettlement: null });
  // A turn that reported nothing leaves the line as it was; a finding or an ending rewrites it.
  if (latestFinding || isWorkerFinished(updated)) await syncWorkerNote(slug, updated, latestFinding);
  return step.schedule === "continue";
}

async function steerWorker(slug, id, text, by) {
  const updated = await queueWorkerSteer(coworkersDir, slug, id, text, by);
  // A waiting Worker takes the steer as its next turn now; a running one when its turn settles; a paused one when resumed.
  if (updated.status === "waiting" || updated.status === "starting") void admitWorkerTurn(slug, id);
  return updated;
}

async function cancelWorker(slug, id, reason, by) {
  const key = workerKey(slug, id);
  workerControls.startStop(slug, id);
  const stoppingControl = workerControls.revokeId(slug, id);
  removeQueuedRun(key);
  const run = liveWorkerTurns.get(key);
  run?.controller.abort(new Error("Worker stopped."));
  const updated = await withWorkerCancellation(async () => {
    const updated = await updateWorker(coworkersDir, slug, id, (current) => isWorkerFinished(current) ? null : { status: "cancelled", pendingSteers: [], pendingTurn: null });
    await collaboration.completeWorker(updated, []);
    const why = String(reason ?? "").trim();
    await appendWorkerEvent(coworkersDir, slug, id, { id: `evt_${collaborationId(id, "stop").slice(5)}`, kind: "status", text: why ? `Stopped: ${why}` : "Stopped", by });
    await syncWorkerNote(slug, updated);
    return updated;
  }, async () => {
    await stoppingControl;
    const signal = AbortSignal.timeout(30_000);
    // Wait for any first-thread creation to finish linking before confirming Stop.
    // The producer also attempts abort in its finally block, independently of writes.
    if (run) await withAbort(run.done, signal);
    const worker = run?.threadId && run.client ? null : await withAbort(getWorker(coworkersDir, slug, id), signal);
    const threadId = run?.threadId || worker?.threadId;
    if (threadId) {
      const client = run?.client ?? await withAbort(readyWorkerClient(await withAbort(getCoworker(coworkersDir, slug), signal), worker), signal);
      await withAbort(abortWorkerThread(client, threadId, signal), signal);
    }
    if (!await workerControls.revokeId(slug, id)) throw new Error("Worker control cleanup is still unconfirmed.");
    if (liveWorkerTurns.get(key) === run) liveWorkerTurns.delete(key);
    if (run) { run.cleanupError = null; workerControls.releaseRun(run); }
  });
  workerControls.finishStop(slug, id);
  return workerControls.summary(updated);
}

async function pauseWorker(slug, id, by = "person") {
  const stopping = workerControls.revokeId(slug, id);
  const worker = await getWorker(coworkersDir, slug, id);
  if (worker.control) {
    await stopping;
    if (!await workerControls.revoke(worker)) throw new Error("Worker control cleanup could not be confirmed. Try Stop again before continuing.");
    const updated = await getWorker(coworkersDir, slug, id);
    await appendWorkerEvent(coworkersDir, slug, id, { kind: "status", text: "Control revoked and Worker paused. A new approval is required.", by });
    return workerControls.summary(updated);
  }
  if (isWorkerFinished(worker)) throw new Error("This Worker has already stopped.");
  if (worker.status === "paused") return worker;
  removeQueuedRun(workerKey(slug, id));
  const updated = await updateWorker(coworkersDir, slug, id, { status: "paused", waitingFor: "" });
  await appendWorkerEvent(coworkersDir, slug, id, {
    kind: "status",
    text: worker.status === "running" ? "Paused; it finishes its current step first." : "Paused",
    by,
  });
  await syncWorkerNote(slug, updated);
  return updated;
}

async function resumeWorker(slug, id, by = "person") {
  const worker = await getWorker(coworkersDir, slug, id);
  if (worker.control) throw new Error("Review this Worker and choose Approve control in its original discussion. Resume cannot grant control.");
  if (worker.status !== "paused") return worker;
  const updated = await updateWorker(coworkersDir, slug, id, { status: "waiting", waitingFor: "turn" });
  await appendWorkerEvent(coworkersDir, slug, id, { kind: "status", text: "Resumed", by });
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
  if (workersRecovered || workersRecovering || !serverHandle?.managedOpencodeV2?.isAlive()) return;
  workersRecovering = true;
  try {
  for (const coworker of await listCoworkers(coworkersDir)) {
    for (const worker of await listWorkers(coworkersDir, coworker.slug).catch(() => [])) {
      const key = workerKey(coworker.slug, worker.id);
      const linked = await collaboration.read((state) => Object.values(state.tasks).some((task) => task.workerId === worker.id && task.origin.slug === coworker.slug));
      if (!linked && worker.spawnedFromThreadId) {
        const owner = await collaboration.owner(coworker.slug, worker.spawnedFromThreadId) ?? await privateOwner(coworker.slug, worker.spawnedFromThreadId);
        await collaboration.attachWorker(worker, owner);
      } else if (!linked) {
        await appendWorkerEvent(coworkersDir, coworker.slug, worker.id, { id: `evt_${collaborationId(worker.id, "origin-missing").slice(5)}`, kind: "status", text: "No originating conversation was recorded. Findings remain here; no private conversation will receive an automatic follow-up." });
      }
      if (worker.pendingSettlement) await settleWorkerTurn(coworker.slug, worker.id, { kind: "failed", error: "Interrupted settlement" });
      else if (isWorkerFinished(worker)) await collaboration.completeWorker(worker, await readWorkerEvents(coworkersDir, coworker.slug, worker.id));
      if (worker.control && !isWorkerFinished(worker)) {
        await updateWorker(coworkersDir, coworker.slug, worker.id, { status: "paused", waitingFor: "" });
        continue;
      }
      if (isWorkerFinished(worker) || worker.status === "paused" || activeLocalRuns.has(key) || isQueued(key)) continue;
      if (worker.status === "waiting" && worker.waitingFor === "decision") continue;
      if (worker.status === "running" || worker.status === "starting") {
        await updateWorker(coworkersDir, coworker.slug, worker.id, { status: "waiting", waitingFor: "turn" }).catch(() => undefined);
        await appendWorkerEvent(coworkersDir, coworker.slug, worker.id, { kind: "status", text: RECOVERED_STATUS }).catch(() => undefined);
      }
      void admitWorkerTurn(coworker.slug, worker.id);
    }
  }
  workersRecovered = true;
  } finally { workersRecovering = false; }
}

async function runDueLocalResponsibilities() {
  // Calendar drives every automation: while it is off, Events and scheduled assignments do not run.
  const { features } = await readSettings(settingsPath).catch(() => ({ features: DEFAULT_FEATURES }));
  if (features.calendar) await events.tick().catch((error) => console.warn("[open-coworker] Event scheduling could not advance:", error.message));
  const now = Date.now();
  await recoverInterruptedWorkers().catch((error) => {
    console.warn("[open-coworker] Worker recovery failed", error);
  });
  const coworkers = await listCoworkers(coworkersDir);
  for (const coworker of coworkers) {
    const responsibilities = await admitLocalRun(async () => {
      const items = await reconcileInterruptedLocalRuns(coworkersDir, coworker.slug, {
        activeRunIds: activeLocalRunIds(coworker.slug),
        now,
      });
      for (const item of items) {
        const key = `${coworker.slug}:${item.id}`;
        const persistedQueue = item.runs.find((run) => run.status === "queued");
        if (features.calendar && persistedQueue && !activeLocalRuns.has(key) && !isQueued(key)) {
          queuedLocalRuns.push(queuedResponsibilityRun(coworker.slug, item.id, persistedQueue.id));
        }
      }
      return items;
    }).catch(() => []);
    for (const responsibility of responsibilities) {
      if (!features.calendar || responsibility.state !== "active" || !responsibility.nextDueAt || responsibility.nextDueAt > now) continue;
      const trigger = now - responsibility.nextDueAt > 30_000 ? "recovery" : "scheduled";
      await startLocalResponsibilityRun(coworker.slug, responsibility.id, trigger);
    }
  }
  await drainLocalRunQueue();
}

function startLocalResponsibilitiesScheduler() {
  if (localResponsibilitiesTimer) return;
  const check = () => {
    if (maintenanceAdmission.closed) return;
    void maintenanceAdmission.run(runDueLocalResponsibilities).catch((error) => {
      console.warn("[open-coworker] local responsibilities check failed", error);
    });
  };
  check();
  localResponsibilitiesTimer = setInterval(check, 15_000);
}

/** Register the coworker directory as a native OpenWork workspace. */
async function registerCoworkerWorkspace(coworker, readyHandle) {
  const handle = readyHandle ?? await ensurePlatformServer();
  const team = teamWorkspace();
  const matches = handle.config.workspaces.filter((workspace) => workspace.id === team.workspaceId
    || (typeof workspace.path === "string" && path.resolve(workspace.path) === path.resolve(team.path)));
  const exact = matches.length === 1 && matches[0].id === team.workspaceId && matches[0].workspaceType === "local"
    && typeof matches[0].path === "string" && path.resolve(matches[0].path) === path.resolve(team.path);
  if (matches.length && !exact) throw new Error("The shared coworker workspace conflicts with its saved registration.");
  if (exact && handle.config.authorizedRoots.some((root) => path.resolve(root) === path.resolve(team.path))) return team.workspaceId;
  const tokens = await loadOrCreateTokens();
  const payload = await fetchJson(`${handle.url}/workspaces/local`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-OpenWork-Host-Token": tokens.hostToken,
    },
    body: JSON.stringify({ folderPath: team.path, name: team.name, preset: "minimal" }),
  });
  const workspaceId = typeof payload?.activeId === "string" ? payload.activeId : "";
  if (workspaceId !== team.workspaceId) throw new Error("Workspace registration did not return the shared team id");
  return workspaceId;
}

async function restoreLegacyCoworkerWorkspace(coworker, handle) {
  if (!coworker.workspaceId || coworker.workspaceId === teamWorkspace().workspaceId) return;
  const directory = path.resolve(coworker.path);
  const checkIdentity = async () => {
    const current = await getCoworker(coworkersDir, coworker.slug);
    if (!Number.isFinite(Date.parse(coworker.createdAt)) || directory !== path.join(path.resolve(coworkersDir), coworker.slug)
      || current.slug !== coworker.slug || current.createdAt !== coworker.createdAt || current.workspaceId !== coworker.workspaceId
      || path.resolve(current.path) !== directory) throw new Error("The original coworker changed before its legacy workspace could be restored.");
  };
  const descriptor = () => {
    const matches = handle.config.workspaces.filter((workspace) => workspace.id === coworker.workspaceId || (typeof workspace.path === "string" && path.resolve(workspace.path) === directory));
    if (!matches.length) return null;
    const workspace = matches[0];
    if (matches.length !== 1 || workspace.id !== coworker.workspaceId || workspace.workspaceType !== "local"
      || typeof workspace.path !== "string" || path.resolve(workspace.path) !== directory) throw new Error("The original legacy workspace conflicts with an existing descriptor. Existing bindings were kept.");
    return workspace;
  };
  await checkIdentity();
  if (!descriptor()) {
    const workspaceId = `ws_${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`;
    if (workspaceId !== coworker.workspaceId) throw new Error("The original legacy workspace id cannot be restored from its recorded path. Existing bindings were kept.");
    const tokens = await loadOrCreateTokens();
    await checkIdentity();
    if (!descriptor()) {
      const payload = await fetchJson(`${handle.url}/workspaces/local`, {
        method: "POST", headers: { "Content-Type": "application/json", "X-OpenWork-Host-Token": tokens.hostToken },
        body: JSON.stringify({ folderPath: directory, name: coworker.name, preset: "minimal" }),
      });
      if (payload?.activeId !== coworker.workspaceId) throw new Error("The original legacy workspace restoration could not be confirmed. Existing bindings were kept.");
    }
  }
  await checkIdentity();
  if (!descriptor()) throw new Error("The original legacy workspace descriptor is still unavailable. Existing bindings were kept.");
}

// OpenCode initializes plug-ins per workspace directory. A team landing in the
// main screen can otherwise ask it to initialize every new coworker at once,
// which is both slower and vulnerable to shared first-boot work colliding.
// Keep that cold path one-at-a-time and remember completed work for this engine
// process; normal reads remain fully concurrent after the warm-up.
const warmedCoworkerWorkspaces = new Set();
const warmedCoworkerScopes = new Map();
const coworkerWarmups = new Map();
let coworkerWarmupTail = Promise.resolve();
let workspaceReadinessRevision = 0;
const workspaceReadinessRevisions = new Map();
const workspaceReadinessChanges = new Map();
const readinessKey = () => `${serverHandle?.managedOpencodeV2?.pid ?? "stopped"}:${workspaceReadinessRevision}`;
const workspaceRevision = (workspaceId, slug) => workspaceReadinessRevisions.get(slug ? `coworker:${slug}` : workspaceId) ?? workspaceReadinessRevisions.get(workspaceId) ?? 0;
const workspaceReadinessScope = () => JSON.stringify([teamWorkspace().workspaceId, readinessKey(), installedTeamRevision]);
const pendingWorkspaceReadinessChanges = (owner) => [...workspaceReadinessChanges]
  .filter(([, scope]) => !scope || (scope.slug ? scope.slug === owner.slug : scope.workspaceId && scope.workspaceId === owner.workspaceId))
  .map(([promise]) => promise);

function assertExpectedReadiness(expected, owner) {
  if (expected && (expected.readinessKey !== readinessKey() || (expected.workspaceRevision ?? 0) !== workspaceRevision(owner.workspaceId, owner.slug)
    || pendingWorkspaceReadinessChanges(owner).length > 0 || !serverHandle?.managedOpencodeV2?.isAlive()
    || expected.workspaceId !== owner.workspaceId || expected.createdAt !== owner.coworkerCreatedAt)) {
    throw Object.assign(new Error("The AI configuration changed before submission. Your draft is kept; wait for preparation and try again."), { code: "readiness_changed" });
  }
}

function invalidateWorkspaceReadiness(owner) {
  if (owner) {
    if (!owner.workspaceId) return;
    workspaceReadinessRevisions.set(owner.slug ? `coworker:${owner.slug}` : owner.workspaceId, workspaceRevision(owner.workspaceId, owner.slug) + 1);
  } else {
    workspaceReadinessRevision += 1;
    workspaceReadinessRevisions.clear();
    warmedCoworkerWorkspaces.clear();
    warmedCoworkerScopes.clear();
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("coworker:runtime-changed", runtimeInfo());
}

async function runCoworkerWorkspaceWarmup(coworker, signal = AbortSignal.timeout(120_000), scope = workspaceReadinessScope(coworker)) {
  coworker = teamWorkspace();
  signal.throwIfAborted();
  if (scope !== workspaceReadinessScope(coworker) || pendingWorkspaceReadinessChanges(coworker).length) throw new Error("The native AI service changed during workspace preparation.");
  const handle = await ensurePlatformServer();
  if (!coworker?.workspaceId) throw new Error("The native workspace is not registered yet.");
  if (!toolsRegistered.has(coworker.workspaceId)) await registerCoworkerTools(coworker, 120_000);
  signal.throwIfAborted();
  const plugins = await awaitNativePluginActivation((method, route) => nativeWorkspaceRequest(handle, coworker.workspaceId, method, route, undefined, { timeoutMs: 120_000, signal }), { apiContract: nativeRuntime.apiContract, signal });
  const required = ["collaboration", "computer", "browser", "group-documents", "events", "abilities", "turn-roles", "progress-summary", "auto-memory"];
  if (!Array.isArray(plugins?.data)
    || plugins.data.some((plugin) => plugin.state?.status !== "active")
    || required.some((id) => !plugins.data.some((plugin) => plugin.id === `coworker.${id}` && plugin.state?.status === "active"))) {
    throw new Error(`The native plugins for ${coworker.name} are not ready. Check the plugin bundles before continuing.`);
  }
  await prepareNativeTurnRoles((method, route, body) => nativeWorkspaceRequest(handle, coworker.workspaceId, method, route, body, { timeoutMs: 120_000, signal }), { requireFilesystemScope: true });
  const current = coworker.slug ? await getCoworker(coworkersDir, coworker.slug) : coworker;
  signal.throwIfAborted();
  if (handle !== serverHandle || !handle.managedOpencodeV2?.isAlive() || scope !== workspaceReadinessScope(current) || pendingWorkspaceReadinessChanges(current).length) throw new Error("The native AI service changed during workspace preparation.");
  warmedCoworkerWorkspaces.add(coworker.workspaceId);
  warmedCoworkerScopes.delete(coworker.workspaceId);
  warmedCoworkerScopes.set(coworker.workspaceId, scope);
  while (warmedCoworkerScopes.size > 64) {
    const oldest = warmedCoworkerScopes.keys().next().value;
    warmedCoworkerScopes.delete(oldest);
    warmedCoworkerWorkspaces.delete(oldest);
  }
}

async function warmCoworkerWorkspace(coworker) {
  if (!coworker?.workspaceId) throw new Error("The native workspace is not registered yet.");
  // Every coworker's owner agent lives in the one team config. Bring it up to
  // date first (a no-op when the team is unchanged), so a coworker added after
  // startup changes the readiness scope instead of reusing an older warmup
  // that never defined its agent.
  await installNativeCoworkerPlugins(teamWorkspace(), await ensureToolsServer());
  coworker = teamWorkspace();
  const scope = workspaceReadinessScope(coworker);
  if (warmedCoworkerWorkspaces.has(coworker.workspaceId) && warmedCoworkerScopes.get(coworker.workspaceId) === scope) return Promise.resolve();
  const current = coworkerWarmups.get(scope);
  if (current) return current;
  const signal = AbortSignal.timeout(120_000);
  const warmup = withAbort(coworkerWarmupTail.catch(() => undefined).then(() => runCoworkerWorkspaceWarmup(coworker, signal, scope)), signal)
    .finally(() => { if (coworkerWarmups.get(scope) === warmup) coworkerWarmups.delete(scope); });
  coworkerWarmups.set(scope, warmup);
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
    toolTokenSlugs.set(token, slug === ".team" ? TEAM_SCOPE : slug);
  }
  return token;
}

async function ensureToolsServer() {
  maintenanceAdmission.assertOpen();
  if (toolsServer) return toolsServer;
  const workerHandlers = createWorkerToolHandlers({
    coworkersDir,
    spawn: () => { throw new Error("Starting a Worker requires its conversation-aware tool."); },
    steer: (slug, id, text) => steerWorker(slug, id, text, "coworker"),
    cancel: (slug, id, reason) => cancelWorker(slug, id, reason, "coworker"),
    pause: (slug, id) => pauseWorker(slug, id, "coworker"),
    resume: (slug, id) => resumeWorker(slug, id, "coworker"),
  });
  const managementCalls = new Map();
  const ordinaryHandlers = {
    ...createToolHandlers({ coworkersDir }), ...workerHandlers,
    ...createAssignmentToolHandlers({ coworkersDir, settings: () => readSettings(settingsPath), timezone: coworkerTimezone,
      runNow: (slug, id) => startLocalResponsibilityRun(slug, id, "manual"), cloud: () => cloudAssignments() }),
    ...createSelfToolHandlers({ coworkersDir }), ...createTeamToolHandlers({ coworkersDir }),
  };
  // Documents and Workers share one server: starting, steering, and stopping a Worker go
  // through the same functions the Workers view uses, so the run limit and records agree.
  // Documents, Workers, assignments, and memory share one server: each goes through the same
  // functions the panel views use, so the run limit, the guardrails, and the records agree.
  startingToolsServer ??= createCoworkerToolsServer({
    resolveSlug: (token) => maintenanceAdmission.closed ? null : toolTokenSlugs.get(token) ?? null,
    onContextTool: (slug, input, transportSignal) => maintenanceAdmission.run(async () => {
      const { name, args, context, cancel } = input;
      let admitted;
      if (slug === TEAM_SCOPE) {
        if (cancel === true && (Object.hasOwn(COMPUTER_TOOLS, name) || Object.hasOwn(BROWSER_TOOLS, name))) {
          const binding = await teamSessions.cleanupBinding(context?.sessionID);
          if (typeof context?.directory !== "string" || path.resolve(context.directory) !== binding.directory) throw new Error("Cleanup does not match the original native location.");
          return Object.hasOwn(COMPUTER_TOOLS, name)
            ? computerControl.execute(binding.slug, { name, args, context, cancel })
            : browserControl.execute(binding.slug, { name, args, context, cancel });
        }
        admitted = await teamSessions.context(context);
        slug = admitted.binding.slug;
        if (name === "filesystem_scope") {
          if (context.filesystemScopeVersion !== 1 || context.filesystemScopeProjectResolution !== 1 || typeof context.callID !== "string" || !context.callID) throw new Error("The native invocation scope capability was not observed.");
          const handle = await ensurePlatformServer();
          const client = ownedSessionClient(admitted.coworker, { baseUrl: handle.url, workspaceId: admitted.binding.workspaceId, token: ownerToken, defaultModel: admitted.entry.model });
          const snapshot = await client.getThreadSnapshot(context.sessionID, { signal: AbortSignal.timeout(8000) });
          const message = snapshot.messages.find((item) => item.id === context.messageID && item.role === "assistant");
          if (snapshot.threadId !== admitted.binding.sessionId || message?.parentId !== admitted.entry.messageId || message.completedAt != null || message.error) throw new Error("The scope request has no current admitted assistant message.");
          const current = await teamSessions.context(context);
          if (current.entry.id !== admitted.entry.id) throw new Error("The admitted execution changed during scope resolution.");
          return { filesystemScope: await resolveNativeFilesystemScope(current.coworker, context) };
        }
        if (name === "session_context") return { slug, createdAt: admitted.binding.createdAt, abilities: admitted.coworker.abilities, homeDirectory: admitted.coworker.path,
          homeContext: await readHomeContext(coworkersDir, slug) };
      }
      const abilityContext = admitted ? { ...context, createdAt: admitted.binding.createdAt, workspaceId: admitted.binding.workspaceId, directory: admitted.coworker.path } : context;
      if (name === "react") return messageReactions.execute(slug, args, context, transportSignal);
      if (name === "abilities_check") return abilitiesRuntime.check(slug, { ...args, ...abilityContext });
      if (name === "abilities_transform") return abilitiesRuntime.transform(slug, { ...args, ...abilityContext });
      if (Object.hasOwn(COMPUTER_TOOLS, name)) return computerControl.execute(slug, { name, args, context, cancel });
      if (Object.hasOwn(BROWSER_TOOLS, name)) return browserControl.execute(slug, { name, args, context, cancel });
      if (groupDocumentTools.has(name)) return groupDocuments.executeNative(slug, { name, args, context });
      if (name === "group_manage") return groupActions.executeNative(slug, { args, context }, transportSignal);
      if (Object.hasOwn(eventNativeSchemas, name)) return events.executeNative(slug, { name, args, context }, transportSignal);
      if (admitted && Object.hasOwn(ordinaryHandlers, name) && name !== "worker_spawn" && !WORKER_MANAGEMENT.includes(name)) {
        const handle = await ensurePlatformServer();
        const client = ownedSessionClient(admitted.coworker, { baseUrl: handle.url, workspaceId: admitted.binding.workspaceId, token: ownerToken, defaultModel: admitted.entry.model });
        const snapshot = await client.getThreadSnapshot(context.sessionID, { signal: AbortSignal.timeout(8000) });
        const current = await teamSessions.context(context);
        if (current.entry.id !== admitted.entry.id) throw new Error("The admitted execution changed before the tool call.");
        assertOwnedNativeTool({ slug, context, name: `coworker_${name}`, args, entry: current.entry, snapshot, workspaceId: current.binding.workspaceId, active: true });
        const key = JSON.stringify([admitted.entry.id, context.messageID, context.callID]);
        if (managementCalls.has(key)) return managementCalls.get(key);
        if (managementCalls.size >= 4096) throw new Error("This app launch reached its native action receipt limit.");
        const result = ordinaryHandlers[name](slug, args);
        managementCalls.set(key, result);
        return result;
      }
      const workerTool = name === "worker_spawn" || WORKER_MANAGEMENT.includes(name);
      const trusted = workerTool
        ? await collaboration.context(slug, context, { name: `coworker_${name}`, args }, assertWorkerToolContext)
        : await collaboration.context(slug, context, { name: `coworker_${name}`, args }, assertTeamConsultToolContext);
      if (name === "team_consult") {
        if (!["private", "group", "consultation", "assignment"].includes(trusted.entry.owner.kind)) throw new Error("Workers cannot manage collaboration.");
        const target = (await listCoworkers(coworkersDir)).find((coworker) => coworker.slug === args.to || coworker.name.toLowerCase() === String(args.to).toLowerCase());
        if (!target) throw new Error("Choose a teammate from the team roster.");
        transportSignal?.throwIfAborted();
        trusted.assertActive();
        const current = await collaboration.context(slug, context, { name: "coworker_team_consult", args }, assertTeamConsultToolContext);
        if (current.entry.id !== trusted.entry.id) throw new Error("This consultation belongs to an earlier admission.");
        transportSignal?.throwIfAborted();
        current.assertActive();
        return collaboration.request(current, "consultation", { ...args, to: target.slug }, { workspaceId: target.workspaceId, coworkerCreatedAt: target.createdAt });
      }
      if (name === "worker_spawn") {
        if (args.control !== undefined) { assertControlOrigin(trusted.entry); await computerDiscussion(slug, trusted.entry.owner.threadId); trusted.assertActive(); }
        const skills = await resolveWorkerSkills(slug, args, trusted.entry);
        trusted.assertActive();
        return collaboration.request(trusted, "worker", { ...args, ...skills, lifespan: args.lifespan ? lifespanFromToolArgs(args.lifespan, { purpose: args.purpose }) : undefined });
      }
      if (WORKER_MANAGEMENT.includes(name)) {
        const worker = await getWorker(coworkersDir, slug, args.id);
        if (worker.control) {
          assertWorkerSupervisor(trusted.entry, worker);
          await computerDiscussion(slug, worker.spawnedFromThreadId);
        }
        trusted.assertActive();
        const key = JSON.stringify([slug, context.sessionID, context.messageID, context.callID]);
        if (managementCalls.has(key)) return managementCalls.get(key);
        if (managementCalls.size >= 4096) throw new Error("This app launch reached its Worker management receipt limit.");
        const result = workerHandlers[name](slug, args, trusted);
        managementCalls.set(key, result);
        return result;
      }
      throw new Error("Unknown collaboration tool.");
    }),
    handlers: Object.fromEntries(Object.entries({
      ...createToolHandlers({ coworkersDir }),
      ...workerHandlers,
      ...createAssignmentToolHandlers({
        coworkersDir,
        settings: () => readSettings(settingsPath),
        timezone: coworkerTimezone,
        runNow: (slug, id) => startLocalResponsibilityRun(slug, id, "manual"),
        cloud: () => cloudAssignments(),
      }),
      ...createSelfToolHandlers({ coworkersDir }),
      ...createTeamToolHandlers({ coworkersDir }),
    }).map(([name, handler]) => [name, (...args) => maintenanceAdmission.run(() => handler(...args))])),
    tools: [...toolCatalog(), ...workerToolCatalog().filter((tool) => tool.name !== "worker_spawn" && !WORKER_MANAGEMENT.includes(tool.name)), ...assignmentToolCatalog(), ...selfToolCatalog(), ...teamToolCatalog()],
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
let teamToolsRegistration;
function registerCoworkerTools(coworker, timeoutMs = 30_000) {
  return teamToolsRegistration ??= runTeamToolsRegistration(coworker, timeoutMs).finally(() => { teamToolsRegistration = null; });
}

async function runTeamToolsRegistration(coworker, timeoutMs = 30_000) {
  coworker = teamWorkspace();
  if (toolsRegistered.has(coworker.workspaceId)) return true;
  const [handle, server] = await Promise.all([ensurePlatformServer(), ensureToolsServer()]);
  const scope = workspaceReadinessScope(coworker);
  await fetchJson(`${handle.url}/workspace/${encodeURIComponent(coworker.workspaceId)}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: COWORKER_TOOLS_MCP_NAME, config: server.mcpConfig(coworkerToolToken(".team")) }),
  }, timeoutMs);
  if (handle !== serverHandle || !handle.managedOpencodeV2?.isAlive() || scope !== workspaceReadinessScope()) throw new Error("The coworker or AI service changed during tool preparation.");
  toolsRegistered.add(coworker.workspaceId);
  return true;
}

/** Bring one coworker up to the current contract and give it its tools; never blocks the list. */
function prepareCoworker(coworker, includeTools = true) {
  if (!contractsRepaired.has(coworker.slug)) {
    contractsRepaired.add(coworker.slug);
    void maintenanceAdmission.run(() => repairCoworkerContract(coworkersDir, coworker.slug)).catch((error) => {
      console.warn(`[open-coworker] could not repair the contract for ${coworker.slug}`, error);
    });
  }
  if (includeTools && coworker.workspaceId && !toolsRegistered.has(coworker.slug) && !toolsRegistering.has(coworker.slug)) {
    const registration = maintenanceAdmission.run(() => registerCoworkerTools(coworker))
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
  const stored = await listCoworkers(coworkersDir);
  const groups = await listGroups(coworkersDir);
  const coworkers = await Promise.all(stored.map((coworker) => repairGroupSelection(coworker, groups, (slug, patch) => updateCoworker(coworkersDir, slug, patch))));
  if (!coworkers.some((coworker) => !coworker.workspaceId)) {
    for (const coworker of coworkers) {
      prepareCoworker(coworker, false);
    }
    return coworkers;
  }

  await ensurePlatformServer();
  const prepared = [];
  for (const coworker of coworkers) {
    if (coworker.workspaceId) {
      prepared.push(coworker);
      continue;
    }
    try {
      const legacy = serverHandle.config.workspaces.find((workspace) => workspace.workspaceType === "local" && path.resolve(workspace.path) === path.resolve(coworker.path));
      const workspaceId = legacy?.id ?? await registerCoworkerWorkspace(coworker);
      prepared.push(await updateCoworker(coworkersDir, coworker.slug, { workspaceId }));
    } catch {
      // Keep the coworker visible. Its explicit repair action remains the
      // fallback when automatic registration is genuinely unavailable.
      prepared.push(coworker);
    }
  }

  for (const coworker of prepared) {
    prepareCoworker(coworker, false);
  }
  return prepared;
}

/** The silent facilitator's hidden workspace, registered on first use; never listed as a coworker. */
let coordinatorPreparation = null;
function ensureCoordinatorWorkspace() {
  // Startup, provider discovery and group routing can arrive together. They
  // must share initialization rather than race on config writes/registration.
  if (!coordinatorPreparation) {
    coordinatorPreparation = prepareCoordinatorWorkspace().finally(() => { coordinatorPreparation = null; });
  }
  return coordinatorPreparation;
}

async function prepareCoordinatorWorkspace() {
  await ensurePlatformServer();
  const coordinator = await ensureCoordinatorHome(coworkersDir);
  await installNativeCoworkerPlugins(teamWorkspace(), await ensureToolsServer());
  if (coordinator.workspaceId) {
    await warmCoworkerWorkspace(coordinator);
    progressCoordinator = teamWorkspace();
    return coordinator;
  }
  const workspaceId = await registerCoworkerWorkspace(coordinator);
  const updated = await updateCoordinator(coworkersDir, { workspaceId });
  await warmCoworkerWorkspace(updated);
  progressCoordinator = teamWorkspace();
  return updated;
}

// ---------------------------------------------------------------------------
// Native provider attempts and presentation indexes belong to one engine and
// workspace generation. No credential-file imports or raw provider errors reach IPC.
async function nativeWorkspaceRequest(handle, workspaceId, method, enginePath, body, { timeoutMs = 20_000, signal } = {}) {
  if (handle !== serverHandle || !handle.managedOpencodeV2?.isAlive()) throw new Error("The native AI service changed or stopped. Refresh before continuing.");
  if (!enginePath.startsWith("/api/")) throw new Error("Expected a native API route.");
  const response = await fetch(`${handle.url}/workspace/${encodeURIComponent(workspaceId)}/opencode2${enginePath}`, {
    method,
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    ...(method === "GET" ? {} : { keepalive: false }),
  }).catch(() => { throw new Error("The native AI service request could not be confirmed. Refresh before trying again."); });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The native AI service answered with HTTP ${response.status}.`);
  }
  if (handle !== serverHandle) { await response.body?.cancel(); throw new Error("The native AI service changed. Refresh before continuing."); }
  if (response.status === 204) return null;
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; }
  catch { throw new Error("The native AI service returned an unreadable response."); }
}

async function patchRuntimeProviders(patch, handle) {
  handle ??= await ensurePlatformServer();
  const tokens = await loadOrCreateTokens();
  if (serverHandle !== handle) throw new Error("The native AI service changed. Refresh before continuing.");
  return fetchJson(`${handle.url}/runtime-config/providers`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-OpenWork-Host-Token": tokens.hostToken },
    body: JSON.stringify({ provider: patch }),
  }, 90_000);
}

async function readRuntimeProviderIds(handle) {
  handle ??= await ensurePlatformServer();
  const tokens = await loadOrCreateTokens();
  if (serverHandle !== handle) throw new Error("The native AI service changed. Refresh before continuing.");
  const payload = await fetchJson(`${handle.url}/runtime-config/providers`, { headers: { "X-OpenWork-Host-Token": tokens.hostToken } });
  return Object.keys(payload?.provider && typeof payload.provider === "object" ? payload.provider : {});
}

function connectedResult(providerId, label, modelCount) {
  return { status: "connected", providerId, label, modelCount };
}

let nativeProviderGeneration = null;
const signInAttempts = new Set();

async function nativeProviderContext() {
  const handle = await ensurePlatformServer();
  if (nativeProviderGeneration?.handle !== handle) {
    const generation = { handle, pending: null };
    nativeProviderGeneration = generation;
    generation.pending = (async () => {
      const workspaceId = teamWorkspace().workspaceId;
      const tokens = await loadOrCreateTokens();
      const assertCurrent = () => {
        if (serverHandle !== handle || nativeProviderGeneration !== generation || !handle.managedOpencodeV2?.isAlive()) throw new Error("The native AI service changed. Refresh before continuing.");
      };
      const native = createNativeV2Client({ baseUrl: handle.url, workspaceId, token: ownerToken });
      const envRequest = async (method, route, body) => {
        assertCurrent();
        await fetchJson(`${handle.url}${route}`, {
          method, headers: { "Content-Type": "application/json", "X-OpenWork-Host-Token": tokens.hostToken },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        assertCurrent();
      };
      assertCurrent();
      const providers = createNativeProviders({
        engineRequest: (method, route, body, options) => { assertCurrent(); return nativeWorkspaceRequest(handle, workspaceId, method, route, body, options); },
        readCatalog: async () => { assertCurrent(); const catalog = await native.readCatalog(); assertCurrent(); return catalog; },
        patchRuntimeProviders: async (patch) => { assertCurrent(); const result = await patchRuntimeProviders(patch, handle); assertCurrent(); return result; },
        readRuntimeProviderIds: async () => { assertCurrent(); const result = await readRuntimeProviderIds(handle); assertCurrent(); return result; },
        storeCustomKey: (name, key) => envRequest("PUT", "/env", { entries: [{ key: name, value: key }] }),
        removeCustomKey: (name) => envRequest("DELETE", `/env/${encodeURIComponent(name)}`),
      });
      return { workspaceId, providers };
    })().catch((error) => {
      if (nativeProviderGeneration === generation) nativeProviderGeneration = null;
      throw error;
    });
  }
  return nativeProviderGeneration.pending;
}

const nativeProviders = async () => (await nativeProviderContext()).providers;
const readEngineProviders = async () => (await nativeProviders()).readEngineProviders();
const readConnectedProviders = async () => (await nativeProviders()).readConnectedProviders();
const readEngineSignIns = async () => (await nativeProviders()).readEngineSignIns();
const connectLocalProvider = async (id) => (await nativeProviders()).connectLocalProvider(id);
const addCustomProvider = async (input) => (await nativeProviders()).addCustomProvider(input);
const disconnectProvider = async (providerId, confirmed) => (await nativeProviders()).disconnect(providerId, confirmed);

/** A key the person typed goes straight to the engine's store; nothing here keeps it. */
async function saveProviderKey(providerId, key) {
  const trimmedId = String(providerId ?? "").trim();
  const trimmedKey = String(key ?? "").trim();
  if (!trimmedId) throw new Error("Choose a provider first.");
  if (!trimmedKey) throw new Error("Paste the key first.");
  const provider = (await readEngineProviders()).find((entry) => entry.id === trimmedId);
  if (!provider) throw new Error("That provider is not offered here.");
  const modelCount = await (await nativeProviders()).storeCredential(trimmedId, trimmedKey);
  return connectedResult(trimmedId, provider.name, modelCount);
}

/** The native engine owns the OAuth attempt; status and cancellation are awaited. */
async function startProviderSignIn(providerId, methodIndex) {
  const attempt = await (await nativeProviders()).startSignIn(String(providerId ?? "").trim(), methodIndex);
  signInAttempts.add(attempt.attemptId);
  return attempt;
}

async function signInStatus(attemptId) {
  const id = String(attemptId ?? "");
  const result = await (await nativeProviders()).status(id);
  if (result.state !== "waiting" && signInAttempts.delete(id)) invalidateWorkspaceReadiness();
  return result;
}

async function cancelSignIn(attemptId) {
  const id = String(attemptId ?? "");
  const result = await (await nativeProviders()).cancel(id);
  signInAttempts.delete(id);
  return result;
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
  const coworker = await createCoworker(coworkersDir, input);
  // The mandatory native engine already runs, including for an empty team.
  const workspaceId = await registerCoworkerWorkspace(coworker);
  const updated = await updateCoworker(coworkersDir, coworker.slug, {
    workspaceId,
    ...(input.model ? { model: input.model, modelVariant: input.modelVariant ?? "", modelChosenBy: input.modelChosenBy ?? "person" } : {}),
  });
  await warmCoworkerWorkspace(updated);
  prepareCoworker(updated);
  return updated;
}

function shortDate(at) {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const installTemplates = createTemplateInstaller(coworkersDir, addCoworker);

async function checkedSessionCoworker(input) {
  const coworker = await getCoworker(coworkersDir, input.slug);
  if (coworker.createdAt !== input.createdAt) throw new Error("The original coworker is no longer available.");
  return coworker;
}

const commands = {
  "sessions.active": async (input) => ownedNativeActive(await checkedSessionCoworker(input)),
  "sessions.binding": async (input) => sessionBinding(await checkedSessionCoworker(input), input.sessionId),
  "sessions.list": async (input) => ownedNativeSessions(await checkedSessionCoworker(input), input.includeLegacy === true),
  "sessions.create": async (input) => {
    const coworker = await checkedSessionCoworker(input);
    await warmCoworkerWorkspace(coworker);
    const handle = await ensurePlatformServer();
    const model = input.input?.model ?? await localRunModel(coworker, "reply", "");
    const client = ownedSessionClient(coworker, { baseUrl: handle.url, workspaceId: coworker.workspaceId, token: ownerToken, defaultModel: model }, "unassigned");
    return client.createThread({ threadId: input.input?.threadId, title: input.input?.title, model });
  },
  "reactions:read": (scope) => messageReactions.read(scope),
  "activity.list": () => activityInbox.list(),
  "activity.markRead": ({ ids, read = true }) => activityInbox.markRead(ids, read),
  "browser.bind": (input) => browserControl.bind(input),
  "browser.detach": (input) => browserControl.detach(input),
  "browser.read": (input) => browserControl.read(input),
  "browser.thumbnail": (input) => browserControl.thumbnail(input),
  "browser.command": (input) => browserControl.command(input),
  "computer.snapshot": (input) => computerControl.snapshot(input),
  "computer.presentation": (input) => computerControl.presentation(input),
  "computer.interact": (input) => computerControl.interact(input),
  "computer.configure": (input) => computerControl.configure(input),
  "computer.stop": (input) => computerControl.stop(input),
  "computer.setup": (input) => computerControl.setup(input),
  "collaboration.receipts": async (scope) => collaboration.receipts(scope),
  "collaboration.cancel": async ({ id }) => { await collaboration.cancel(id); return { ok: true }; },
  "collaboration.retry": async ({ id }) => { await collaboration.retry(id); return { ok: true }; },
  "collaboration.excludedThreads": async ({ slug }) => {
    const groupThreads = (await listGroups(coworkersDir)).map((group) => group.participantThreadIds[slug]).filter(Boolean);
    return [...new Set([...groupThreads, ...await collaboration.excludedThreads(slug)])];
  },
  "turns.state": async ({ slug, threadId }) => { await getCoworker(coworkersDir, slug); return collaboration.threadState(slug, threadId); },
  "turns.activity": async ({ slug, threadId }) => readCollaborationActivity({ slug, threadId }),
  "turns.update": async ({ slug, threadId, previous, next }) => { const coworker = await getCoworker(coworkersDir, slug); return collaboration.updateThread(slug, threadId, previous, next, { coworkerCreatedAt: coworker.createdAt }); },
  "turns.selectSkill": async ({ slug, uri, label, account }) => {
    if (typeof uri !== "string" || !uri.startsWith("skill://")) throw new Error("Select a skill from Apps & tools.");
    const session = denSession;
    const identity = await currentSkillAccount(session);
    if (account?.baseUrl?.replace(/\/+$/, "") !== identity.scope.baseUrl || account?.orgId !== identity.scope.orgId || typeof account?.email !== "string" || account.email.trim().toLowerCase() !== identity.email?.trim().toLowerCase()) throw new Error("The OpenWork account changed. Refresh Apps & tools and select the skill again.");
    const coworker = await getCoworker(coworkersDir, slug);
    const handle = await ensurePlatformServer();
    const catalog = await createCoworkerThreads({ serverUrl: handle.url, workspaceId: coworker.workspaceId, token: ownerToken, owner: { slug: coworker.slug, createdAt: coworker.createdAt } }).listSkills(AbortSignal.timeout(30_000));
    assertSkillSession(session);
    return selectCatalogSkill(catalog, { uri, label }, coworker.workspaceId, identity.scope);
  },
  "turns.validateSkills": async ({ slug, ...fields }) => {
    if (!fields.skills?.length && !fields.skillSelections?.length) { nativeV2SkillsSchema.parse(fields.skills ?? []); return; }
    const coworker = await getCoworker(coworkersDir, slug);
    const handle = await ensurePlatformServer();
    await ownedSessionClient(coworker, { baseUrl: handle.url, workspaceId: coworker.workspaceId, token: ownerToken }).validateSkills(fields, AbortSignal.timeout(30_000));
  },
  "turns.send": async ({ slug, threadId, prompt, messageId, skills, skillSelections, model, expectedReadiness, retry, retryByPerson, retryLabel, kind }) => {
    if ([slug, threadId, messageId].some((value) => typeof value !== "string" || !value.trim() || value.length > 256)) throw new Error("A send requires its exact coworker, thread and message IDs.");
    const key = JSON.stringify([slug, threadId, messageId]);
    if (privateTurnIntents.has(key) || privateTurnIntents.size >= 64) throw new Error("A message submission is already pending. Its recorded work is kept; do not resend it.");
    const intent = { cancelled: false, kind: kind === "assignment" ? "assignment" : "private" };
    privateTurnIntents.set(key, intent);
    let admissionRequested = false;
    try {
      const owner = await privateOwner(slug, threadId, intent.kind);
      try { if (!retry) assertExpectedReadiness(expectedReadiness, owner); }
      catch (error) { return { rejected: true, messageId, notSubmitted: true, code: "readiness_changed", error: error.message }; }
      admissionRequested = true;
      const entry = await collaboration.submit({ owner, prompt, messageId, skills, skillSelections, model, expectedReadiness, retry, retryByPerson: retryByPerson === true, retryLabel, track: true }, () => intent.cancelled);
      try { return { ...await collaboration.acceptance(entry.id), prompt: entry.prompt }; }
      catch (error) {
        const recorded = await collaboration.read((state) => state.executions[entry.id]);
        if (recorded?.acceptance) return { ...recorded.acceptance, prompt: recorded.prompt };
        if (recorded && ["failed", "cancelled"].includes(recorded.state) && (recorded.nativeAdmission === "prepared" || recorded.admissionFailure)) {
          return { rejected: true, messageId: entry.messageId, notSubmitted: recorded.nativeAdmission === "prepared" || recorded.admissionFailure?.notSubmitted === true, code: recorded.admissionFailure?.code ?? "not_submitted", status: recorded.admissionFailure?.status,
            error: recorded.error || "This message was not submitted. Your draft is kept." };
        }
        throw error;
      }
    } catch (error) {
      if (!admissionRequested) return { rejected: true, messageId, notSubmitted: true, code: "preparation_failed", error: error instanceof Error ? error.message : "Preparation failed. Your draft is kept." };
      throw error;
    } finally { if (privateTurnIntents.get(key) === intent) privateTurnIntents.delete(key); }
  },
  "turns.cancel": async ({ slug, threadId, messageId }) => {
    if (typeof messageId !== "string" || !messageId.trim()) throw new Error("Stopping a turn requires its exact message ID. Use Computer Stop to revoke the whole discussion.");
    const intent = privateTurnIntents.get(JSON.stringify([slug, threadId, messageId]));
    if (intent) intent.cancelled = true;
    const kind = intent?.kind ?? await collaboration.read((state) => state.owners[`${slug}:${threadId}`]?.kind ?? "private");
    if (!["private", "assignment"].includes(kind)) throw new Error("This turn belongs to another execution surface.");
    await privateOwner(slug, threadId, kind);
    const matched = await collaboration.cancelThread(slug, threadId, messageId);
    if (!matched && !intent) throw new Error("No matching message is on record. Stop is not confirmed; refresh and try again.");
    return { ok: true };
  },
  "templates.sync": async ({ userEmail, automatic = false, installIds = [] }) => {
    const session = denSession;
    if (!session) throw new Error("Sign in to OpenWork to get your team's coworkers.");
    const catalog = await listAssignedCoworkerTemplates(session);
    if (!catalog.enabled) return { enabled: false, items: [], created: [] };
    return { enabled: true, ...await installTemplates({ scope: templateScope(session, userEmail), items: catalog.items, automatic, installIds, isCurrent: () => denSession === session }) };
  },
  "templates.import": async () => {
    const selection = await dialog.showOpenDialog({ title: "Import a coworker template", properties: ["openFile"], filters: [{ name: "Coworker template", extensions: ["json"] }] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    if ((await stat(selection.filePaths[0])).size > 131072) throw new Error("A coworker template must be 128 KB or smaller.");
    const template = parseCoworkerTemplateFile(await readFile(selection.filePaths[0], "utf8"));
    const id = createHash("sha256").update(JSON.stringify(template)).digest("hex");
    return installTemplates({ scope: "imported-file", items: [{ id, versionId: id, template, assigned: false }], installIds: [id] });
  },
  "templates.export": async ({ slug }) => {
    const template = await exportCoworkerTemplate(coworkersDir, slug);
    const selection = await dialog.showSaveDialog({ title: "Export a coworker template", defaultPath: `${slug}.coworker.json`, filters: [{ name: "Coworker template", extensions: ["json"] }] });
    if (selection.canceled || !selection.filePath) return { saved: false };
    await writeFile(selection.filePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
    return { saved: true };
  },
  "runtime.info": async () => {
    try { await ensurePlatformServer(); }
    catch (error) { engineError = error instanceof Error ? error.message : "The native AI service is unavailable."; }
    return runtimeInfo();
  },
  "runtime.restart": async () => {
    await restartPlatformServer();
    return runtimeInfo();
  },
  "coworkers.list": async () => listPreparedCoworkers(),
  "coworkers.get": async ({ slug }) => repairGroupSelection(await getCoworker(coworkersDir, slug), await listGroups(coworkersDir), (owner, patch) => updateCoworker(coworkersDir, owner, patch)),
  "coworkers.openFolder": async ({ slug }) => {
    if (slug !== undefined && typeof slug !== "string") throw new Error("Coworker slug must be a string.");
    const directory = slug === undefined ? coworkersDir : (await getCoworker(coworkersDir, slug)).path;
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  },
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
  "team.referralResolved": (() => {
    const pending = new Map();
    return async ({ slug, referralId, outcome, expectedAt }) => {
      if (typeof slug !== "string" || !slug || typeof referralId !== "string" || !referralId) throw new Error("Choose the coworker and referral to resolve.");
      if (!["asked", "continued", "offered"].includes(outcome)) throw new Error("Unknown referral outcome.");
      if (outcome === "offered" ? !Number.isSafeInteger(expectedAt) || expectedAt < 0 : expectedAt !== undefined) throw new Error("Restoring an offer requires its exact asked receipt.");
      const key = JSON.stringify([slug, referralId]);
      const operation = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        const current = (await teamStates(coworkersDir, slug)).referrals.find((entry) => entry.id === referralId);
        if (!current) throw new Error("That hand-over is not on record.");
        if (outcome === "offered" && (current.state !== "asked" || current.at !== expectedAt)) throw new Error("REFERRAL_CONFLICT: This referral has a newer answer. Its current state was kept.");
        if (!Number.isSafeInteger(current.at) || current.at < 0 || current.at === Number.MAX_SAFE_INTEGER) throw new Error("This referral's state receipt is unreadable. Its current state was kept.");
        const now = Math.max(Date.now(), current.at + 1);
        const resolved = await setReferralState(coworkersDir, slug, referralId, outcome, { now });
        return { id: resolved.id, state: resolved.state, at: resolved.stateAt };
      });
      pending.set(key, operation);
      try { return await operation; }
      finally { if (pending.get(key) === operation) pending.delete(key); }
    };
  })(),
  "coworkers.ensureWorkspace": async ({ slug, expected }) => {
    const signal = AbortSignal.timeout(120_000);
    return withAbort((async () => {
      await withAbort(Promise.all(pendingWorkspaceReadinessChanges(await getCoworker(coworkersDir, slug))), signal);
      const handle = await ensurePlatformServer();
      let coworker = await getCoworker(coworkersDir, slug);
      const generation = readinessKey();
      const revision = workspaceRevision(coworker.workspaceId, coworker.slug);
      const hadWorkspace = Boolean(coworker.workspaceId);
      const assertCurrent = (current) => {
        signal.throwIfAborted();
        if (handle !== serverHandle || !handle.managedOpencodeV2?.isAlive() || generation !== readinessKey() || revision !== workspaceRevision(current.workspaceId, current.slug)
          || current.createdAt !== coworker.createdAt || current.path !== coworker.path || current.workspaceId !== coworker.workspaceId
          || current.model !== coworker.model || current.modelVariant !== coworker.modelVariant || pendingWorkspaceReadinessChanges(current).length > 0
          || (expected && (expected.createdAt !== current.createdAt || (hadWorkspace && expected.workspaceId !== current.workspaceId) || expected.readinessKey !== generation || (expected.workspaceRevision ?? 0) !== revision))) {
          throw new Error("The coworker or AI configuration changed. Refresh before sending; your draft is kept.");
        }
      };
      assertCurrent(coworker);
      if (!coworker.workspaceId) {
        const legacy = handle.config.workspaces.find((workspace) => workspace.workspaceType === "local" && path.resolve(workspace.path) === path.resolve(coworker.path));
        const workspaceId = legacy?.id ?? await registerCoworkerWorkspace(coworker);
        signal.throwIfAborted();
        coworker = await updateCoworker(coworkersDir, slug, { workspaceId });
      }
      await withAbort(warmCoworkerWorkspace(coworker), signal);
      assertCurrent(await getCoworker(coworkersDir, slug));
      prepareCoworker(coworker);
      return { ...coworker, readinessKey: generation, workspaceRevision: revision };
    })(), signal).catch((error) => {
      if (signal.aborted) throw new Error("Starting AI took longer than two minutes. Retry preparation or restart AI in Settings. Your draft is kept.");
      throw error;
    });
  },
  "coworkers.update": async ({ slug, patch }) => {
    if (patch?.conversationThreadId) await privateOwner(slug, patch.conversationThreadId);
    return updateCoworker(coworkersDir, slug, patch ?? {});
  },
  "abilities.catalog": async ({ slug, createdAt }) => {
    const coworker = await getCoworker(coworkersDir, slug);
    abilitiesCatalogReads.delete(coworker.path);
    return abilitiesRuntime.catalog({ slug, createdAt });
  },
  "abilities.update": async ({ slug, createdAt, expectedRevision, abilities }) => {
    const updated = await updateCoworkerAbilities(coworkersDir, slug, { createdAt, expectedRevision, abilities });
    // Update the live plugin's small config, not engine permissions or account-wide
    // MCP settings. Already-dispatched calls are not cancelled or replayed.
    const server = await ensureToolsServer();
    await installNativeCoworkerPlugins(updated, server);
    return getCoworker(coworkersDir, slug);
  },
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
    if (!await computerControl.revoke({ slug })) throw new Error(COMPUTER_STOP_GUIDANCE);
    const coworker = await getCoworker(coworkersDir, slug).catch(() => null);

    const retired = await retireCoworker(coworkersDir, slug);
    await installNativeCoworkerPlugins(teamWorkspace(), await ensureToolsServer());
    toolTokenSlugs.delete(coworkerToolTokens.get(slug));
    coworkerToolTokens.delete(slug);
    return { ok: true, archiveId: retired.archiveId };
  },
  "coworkers.retired.list": async () => listRetiredCoworkers(coworkersDir),
  "coworkers.restore": async ({ archiveId }) => {
    const restored = await restoreCoworker(coworkersDir, archiveId);
    const handle = await ensurePlatformServer();
    await restoreLegacyCoworkerWorkspace(restored, handle);
    const workspaceId = await registerCoworkerWorkspace(restored, handle);
    const updated = restored.workspaceId ? restored : await updateCoworker(coworkersDir, restored.slug, { workspaceId });
    await warmCoworkerWorkspace(updated);
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
  "groups.documents.list": ({ id }) => groupDocuments.list(id),
  "groups.documents.read": ({ id, documentId }) => groupDocuments.read(id, documentId),
  "groups.documents.save": ({ id, input }) => groupDocuments.save(id, input),
  "groups.documents.revisions": ({ id, documentId }) => groupDocuments.revisions(id, documentId),
  "groups.documents.restore": ({ id, documentId, revision, expectedRevision }) => groupDocuments.restore(id, documentId, revision, expectedRevision),
  "groups.submit": async ({ id, ...input }) => groupExecution.submit(id, input),
  "groups.status": async ({ id }) => groupExecution.status(id),
  "groups.interactions.reply": async (input) => { await groupExecution.replyInteraction(input); return { ok: true }; },
  "groups.activity": async ({ id }) => groupExecution.activity(id, readCollaborationActivity),
  "groups.cancel": async ({ id }) => { if ((await getGroup(coworkersDir, id)).eventId) await events.cancelGroup(id); else await groupExecution.cancel(id); return { ok: true }; },
  "groups.removeQueued": async ({ id, clientMessageId }) => { await groupExecution.remove(id, clientMessageId); return { ok: true }; },
  "groups.get": async ({ id }) => getGroup(coworkersDir, id),
  "groups.create": async ({ name, participantSlugs }) => createGroup(coworkersDir, { name, participantSlugs }),
  "groups.update": async ({ id, patch }) => updateGroup(coworkersDir, id, patch ?? {}),
  "groups.archive": async ({ id }) => { await ordinaryGroup(id); await groupExecution.cancel(id); return archiveGroup(coworkersDir, id); },
  "groups.readTimeline": async ({ id, limit }) => readGroupTimeline(coworkersDir, id, Number.isFinite(limit) ? { limit } : {}),
  "groups.appendEvent": async ({ id, event }) => { await ordinaryGroup(id); return appendGroupEvent(coworkersDir, id, event); },
  // One turn per message from the person: the record is the source of truth the
  // view and recovery read, so a double Send or a quit mid-turn loses nothing.
  "groups.beginTurn": async ({ id, clientMessageId, prompt }) => { await ordinaryGroup(id); return beginGroupTurn(coworkersDir, id, { clientMessageId, prompt }); },
  "groups.updateTurn": async ({ id, turnId, patch }) => { await ordinaryGroup(id); return updateGroupTurn(coworkersDir, id, turnId, patch ?? {}); },
  // Reloads do not stop native work. Check queue ownership at the recovery mutation.
  "groups.recoverInterrupted": async () => {
    const coworkers = await listCoworkers(coworkersDir).catch(() => []);
    const names = new Map(coworkers.map((coworker) => [coworker.slug, coworker.name]));
    return reconcileInterruptedGroupTurns(coworkersDir, { isActive: (turn, group) => collaboration.read((state) => state.groups[group.id]?.queue.some((entry) => entry.turnId === turn.id || entry.id === turn.clientMessageId) ?? false), nameFor: (slug) => names.get(slug) ?? slug });
  },
  // The silent facilitator's own workspace: hidden, tool-less, registered like a
  // coworker's but never listed as one.
  "coordinator.ensure": async () => ensureCoordinatorWorkspace(),
  // AI providers on this Mac: what is already here, one-step connect, the
  // engine's own sign-ins, keys, custom servers, and disconnect. Secrets go
  // from their source to the engine over loopback and are never returned.
  "localProviders.prepare": async () => {
    const { workspaceId } = await nativeProviderContext();
    const handle = await ensurePlatformServer();
    const engineManaged = Boolean(handle.managedOpencodeV2?.isAlive());
    const base = { workspaceId, engineManaged, serverUrl: handle.url, ownerToken };
    if (!engineManaged) return { ...base, providers: [], signIns: {} };
    // The first read is also the hidden workspace's cold start. Finish it
    // before the second read so OpenCode never initializes the same directory
    // twice at once on a new install.
    const providers = await readEngineProviders();
    const signIns = await readEngineSignIns();
    return { ...base, providers, signIns };
  },
  "localProviders.detect": async () => detectLocalProviders({ providers: await readConnectedProviders() }),
  "localProviders.connect": async ({ id }) => connectLocalProvider(String(id ?? "")),
  "localProviders.saveKey": async ({ providerId, key }) => saveProviderKey(providerId, key),
  "localProviders.disconnect": async ({ providerId, confirmed }) => disconnectProvider(providerId, confirmed === true),
  "localProviders.signIn.start": async ({ providerId, method }) => startProviderSignIn(providerId, Number.isInteger(method) ? method : undefined),
  "localProviders.signIn.status": async ({ attemptId }) => await signInStatus(attemptId),
  "localProviders.signIn.cancel": async ({ attemptId }) => await cancelSignIn(attemptId),
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
  "coworkers.memory.automatic": async ({ slug, groupId }) => {
    await getCoworker(coworkersDir, slug);
    return conversationMemory.read({ slug, kind: groupId ? "group" : "private", groupId });
  },
  "coworkers.memory.clearAutomatic": async ({ slug, groupId }) => {
    await getCoworker(coworkersDir, slug);
    return conversationMemory.clear({ slug, kind: groupId ? "group" : "private", groupId });
  },
  "coworkers.memory.automaticGroups": async ({ slug }) => {
    await getCoworker(coworkersDir, slug);
    return (await listGroups(coworkersDir)).filter((group) => group.archivedAt === null && group.participantSlugs.includes(slug)).map(({ id, name }) => ({ id, name }));
  },
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
  "workers.list": async ({ slug }) => (await listWorkers(coworkersDir, slug)).map((worker) => workerControls.summary(worker)),
  "workers.get": async ({ slug, id }) => workerControls.summary(await getWorker(coworkersDir, slug, id)),
  "workers.spawn": async ({ slug, name, goal, purpose, lifespan, spawnedFromThreadId, control, skills, skillSelections }) =>
    spawnWorker(slug, { name, goal, purpose, lifespan, spawnedFromThreadId, control, skills, skillSelections }, "person"),
  "workers.approveControl": async ({ slug, id, expectedRevision }) => {
    const updated = await workerControls.approve(await getWorker(coworkersDir, slug, id), expectedRevision);
    void admitWorkerTurn(slug, id);
    return updated;
  },
  "workers.revokeControl": async ({ slug, id, expectedRevision }) => {
    const stopping = workerControls.revokeKnown(slug, id, expectedRevision);
    if (stopping) await stopping;
    const worker = await getWorker(coworkersDir, slug, id);
    if (!stopping) await workerControls.revoke(worker, expectedRevision);
    return workerControls.summary(await getWorker(coworkersDir, slug, id));
  },
  "workers.steer": async ({ slug, id, text }) => steerWorker(slug, id, text, "person"),
  "workers.cancel": async ({ slug, id, reason }) => cancelWorker(slug, id, reason, "person"),
  "workers.pause": async ({ slug, id }) => pauseWorker(slug, id),
  "workers.resume": async ({ slug, id }) => resumeWorker(slug, id),
  "workers.findings": async ({ slug, id, limit }) => readWorkerEvents(coworkersDir, slug, id, Number.isFinite(limit) ? { limit } : {}),
  "allHands.get": async () => readAllHands(coworkersDir),
  "allHands.update": async (patch) => { if (await events.migrated()) throw new Error("All Hands schedules are now managed in Events."); return updateAllHands(coworkersDir, patch); },
  "allHands.prepare": async () => prepareAllHands(coworkersDir, await listCoworkers(coworkersDir)),
  "allHands.claim": async () => await events.migrated() ? null : claimAllHands(coworkersDir),
  "events.list": () => events.list(),
  "events.get": ({ id }) => events.get(id),
  "events.create": ({ input }) => events.create(input),
  "events.update": ({ id, input, expectedRevision }) => events.update(id, input, expectedRevision),
  "events.runNow": ({ id, requestId }) => events.runNow(id, requestId),
  "events.cancel": ({ id, runId }) => events.cancel(id, runId),
  "events.document.read": ({ id, runId, artifact }) => events.documentRead(id, runId, artifact),
  "settings.get": async () => readSettings(settingsPath),
  "settings.progressModels": async () => {
    const transport = await readyProgressTransport().catch(() => null);
    return (transport?.models ?? []).map(({ id, label, cost }) => ({ id, label, cost }));
  },
  "settings.update": async (patch) => {
    const previous = await readSettings(settingsPath);
    const next = await updateSettings(settingsPath, patch);
    progressSummaries.configure(next);
    conversationMemory.configure(next);
    if (JSON.stringify(previous.features) !== JSON.stringify(next.features)) {
      // Rewrite every coworker's contract and denied tools now; the next turn prepares against them.
      await installNativeCoworkerPlugins(teamWorkspace(), await ensureToolsServer());
      invalidateWorkspaceReadiness();
    }
    if (patch?.maxParallelLocalRuns !== undefined) void drainLocalRunQueue();
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
  // Metadata for a link shared in a conversation; public hosts only, fetched here, never by the renderer.
  "links.preview": async ({ url }) => linkPreviews.read(url),
  /** Signed-in account → embedded server → engine providers. Returns the sync outcome. */
  "den.session.set": async (payload) => {
    const session = parseDenSessionPayload(payload);
    const generation = invalidateDenAccount();
    voice.reset();
    return queueDenAccountHandoff(async () => {
      if (generation !== denAccountGeneration) throw new Error("The OpenWork account changed. Try again.");
      const handle = await ensurePlatformServer();
      const tokens = await loadOrCreateTokens();
      await clearDenSession(handle, tokens.hostToken);
      if (generation !== denAccountGeneration) throw new Error("The OpenWork account changed. Try again.");
      denSession = session;
      const result = await applyDenSession(handle, tokens.hostToken, session);
      if (generation !== denAccountGeneration) {
        appliedSkillSession = null;
        throw new Error("The OpenWork account changed. Try again.");
      }
      denAccountReady = true;
      return { ...result, accountGeneration: generation };
    });
  },
  "den.session.clear": async () => {
    invalidateDenAccount();
    voice.reset();
    return queueDenAccountHandoff(async () => {
      const handle = await ensurePlatformServer();
      const tokens = await loadOrCreateTokens();
      await clearDenSession(handle, tokens.hostToken);
      denSession = null;
      return { ok: true };
    });
  },
  "den.connect.reconcile": async ({ accountGeneration, workspaceId, config }) => {
    const current = () => denAccountReady && denSession && accountGeneration === denAccountGeneration;
    if (!current()) throw new Error("The OpenWork account changed. Connect again after signing in.");
    return queueDenAccountHandoff(async () => {
      if (!current()) throw new Error("The OpenWork account changed. Connect again after signing in.");
      const handle = await ensurePlatformServer();
      if (!current()) throw new Error("The OpenWork account changed. Connect again after signing in.");
      const result = await fetchJson(`${handle.url}/workspace/${encodeURIComponent(workspaceId)}/mcp/openwork-cloud/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify(config),
      }, 90_000);
      if (!current()) throw new Error("The OpenWork account changed. Connect again after signing in.");
      return result;
    });
  },
  /** Re-read the account's providers now (after org changes, new keys, or a failed pass). */
  "den.providers.sync": async () => {
    const generation = denAccountGeneration;
    return queueDenAccountHandoff(async () => {
      if (!denAccountReady || !denSession || generation !== denAccountGeneration) return { status: "no_session", message: "" };
      const handle = await ensurePlatformServer();
      const tokens = await loadOrCreateTokens();
      return runCloudProviderSync(handle, tokens.hostToken, "manual_refresh");
    });
  },
  "voice.status": () => voice.status(),
  "voice.transcribe": (input) => voice.transcribe(input),
  "voice.speech": (input) => voice.speech(input),
  "voice.cancel": ({ requestId }) => voice.cancel(requestId),
  "voice.microphone": () => voice.microphone(),
  /** The renderer drains deep links queued while it was loading. */
  "deepLinks.subscribe": async () => {
    deepLinkListenerReady = true;
    return { urls: pendingDeepLinks.splice(0, pendingDeepLinks.length) };
  },
};

function maintenanceScope() {
  if (!engineHistoryDb) throw new Error(engineHistoryError);
  const home = homedir();
  const data = process.env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  return {
    userData: app.getPath("userData"), coworkers: coworkersDir, serverConfig: serverConfigPath,
    runtimeDb: process.env.OPENWORK_RUNTIME_DB, envStore: process.env.OPENWORK_ENV_STORE, settings: settingsPath,
    historyDb: engineHistoryDb, isDev,
    defaults: {
      userData: path.join(app.getPath("appData"), "com.differentai.opencoworker"),
      devUserData: path.join(app.getPath("appData"), "com.differentai.opencoworker.dev"),
      coworkers: defaultCoworkersDir(), serverConfig: path.join(openworkConfigDir(), "coworker-server.json"),
    },
    // Legacy paths are reset exclusions only, never native engine launch inputs.
    protectedPaths: [home, app.getPath("appData"), openworkConfigDir(), app.getAppPath(), process.execPath,
      path.join(app.getPath("appData"), "com.differentai.opencoworker.dev"),
      path.join(app.getPath("appData"), "com.differentai.openwork"),
      path.join(app.getPath("appData"), "com.differentai.openwork.dev"),
      path.join(data, "opencode"), path.join(home, ".config", "opencode"), globalOpencodeConfigDir(),
      path.join(home, ".local", "share", "opencode"),
      ...(process.env.OPENCODE_DB && process.env.OPENCODE_DB !== ":memory:" ? [path.resolve(process.env.OPENCODE_DB)] : []),
      ...(process.env.OPENCODE_CONFIG_DIR ? [path.resolve(process.env.OPENCODE_CONFIG_DIR)] : [])],
    allowedParents: [home, app.getPath("appData"), openworkConfigDir()],
  };
}

const maintenance = createMaintenance({
  admission: maintenanceAdmission,
  paths: () => validateMaintenancePaths(maintenanceScope()),
  coworkerCount: async () => (await listCoworkers(coworkersDir)).length + (await listRetiredCoworkers(coworkersDir)).length,
  restoreDefaults: async () => {
    const next = await updateSettings(settingsPath, normalizeSettings({}));
    progressSummaries.configure(next);
    conversationMemory.configure(next);
    return next;
  },
});

const maintenanceSteps = createMaintenanceSteps();
let maintenanceServer;
let maintenanceServerStopped = false;

async function stopForMaintenance() {
  if (!maintenanceAdmission.closed) throw new Error("Fresh start must close ordinary work before cleanup.");
  maintenanceServer ??= { handle: serverHandle, native: serverHandle?.managedOpencodeV2, pid: serverHandle?.managedOpencodeV2?.pid };
  if (localResponsibilitiesTimer) clearInterval(localResponsibilitiesTimer);
  localResponsibilitiesTimer = null;
  responsibilityAbort.abort(new Error("Fresh start is stopping local work."));
  queuedLocalRuns.length = 0;
  for (const run of liveWorkerTurns.values()) run.controller.abort(new Error("Fresh start is stopping Workers."));
  const controls = async () => {
    const failures = [];
    for (const [label, work] of [
      ["Worker controls", async () => { if (await workerControls.reset(true) !== true) throw new Error("Worker cleanup is unconfirmed."); }],
      ["Computer control", async () => { if ((await computerControl.reset(true)).confirmed !== true) throw new Error("Computer cleanup is unconfirmed."); }],
      ["Browser control", () => browserControl.shutdown()],
    ]) {
      try { await maintenanceSteps.run(label, work, { timeoutMs: 10_000 }); }
      catch (error) { failures.push(error.message); }
    }
    if (failures.length) throw Object.assign(new Error(failures.join(" ")), { maintenanceRetryable: true });
  };
  const results = await Promise.allSettled([
    maintenanceSteps.run("Scheduled Events", () => events.stop()),
    maintenanceSteps.run("Progress notes", () => progressSummaries.stop()),
    maintenanceSteps.run("Conversation memory", () => conversationMemory.stop()),
    maintenanceSteps.run("Voice", () => voice.reset()),
    maintenanceSteps.run("Provider sign-ins", async () => {
      if (!nativeProviderGeneration || !signInAttempts.size) return;
      const { providers } = await nativeProviderGeneration.pending;
      for (const id of signInAttempts) { await providers.cancel(id); signInAttempts.delete(id); }
    }),
    maintenanceSteps.run("Group work", () => groupExecution.stop()),
    maintenanceSteps.run("Collaboration", () => collaboration.stop({ requireConfirmed: true })),
    maintenanceSteps.run("Local admission", () => localRunAdmission),
    controls(),
  ]);
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length) throw Object.assign(new Error(failures.map((error) => error.message).join(" ")), {
    maintenanceRetryable: failures.every((error) => error.maintenanceRetryable !== false)
      && serverHandle === maintenanceServer.handle && serverHandle?.managedOpencodeV2 === maintenanceServer.native
      && maintenanceServer.native?.pid === maintenanceServer.pid && maintenanceServer.native?.isAlive() === true,
  });
  await maintenanceSteps.run("Admitted work", () => maintenanceAdmission.drain());
  const unresolvedStop = responsibilityCleanupError || [...liveWorkerTurns.values()].some((run) => run.cleanupError);
  if (startingServer || startingToolsServer || activeLocalRuns.size || unresolvedStop) throw Object.assign(new Error("Local execution cleanup is unconfirmed. No reset was performed."), { maintenanceRetryable: !unresolvedStop });
  const previous = maintenanceServer;
  const original = () => serverHandle === previous.handle && previous.handle?.managedOpencodeV2 === previous.native;
  const exited = () => {
    const pid = previous.native?.pid;
    return (pid === null || pid === previous.pid) && previous.native?.isAlive() === false;
  };
  if (!previous.handle || !previous.native || !Number.isSafeInteger(previous.pid) || previous.pid < 2
    || previous.handle.managedOpencodeV2 !== previous.native
    || (previous.native.pid !== previous.pid && !(previous.stopStarted && exited()))
    || (serverHandle !== previous.handle && !(maintenanceServerStopped && serverHandle === null))) throw Object.assign(new Error("The original AI service's ownership could not be confirmed. No reset was performed."), { maintenanceRetryable: false });
  await maintenanceSteps.run("Workspace tools", async () => {
    if (toolsServer) await toolsServer.stop();
    toolsServer = null;
  }, { timeoutMs: 10_000, retry: false });
  await maintenanceSteps.run("The native AI service", async () => {
    if (!original() || previous.native.pid !== previous.pid) throw new Error("The original native process changed before shutdown.");
    previous.stopStarted = true;
    await previous.handle.stop();
    if (!original() || !exited()) throw new Error("The original native process's shutdown is unconfirmed.");
    maintenanceServerStopped = true;
    serverHandle = null;
    ownerToken = "";
    denSession = null;
  }, { retry: false });
  if (!maintenanceServerStopped || serverHandle !== null || previous.handle.managedOpencodeV2 !== previous.native || !exited()) throw Object.assign(new Error("The AI service's exit is unconfirmed. No reset was performed."), { maintenanceRetryable: false });
}

let resetHandoff;
let resetReceiptTimer;

async function cancelResetAttempt(attempt, error) {
  if (attempt.cancelling) return attempt.cancelling;
  attempt.consumed = true;
  clearTimeout(resetReceiptTimer);
  if (attempt.preparing && !maintenanceAdmission.closed) maintenanceAdmission.close();
  const preparation = maintenancePreparationFailure(error);
  resetBlockedReason = "Fresh start cancellation is unconfirmed. Keep this app open; retry and quit are blocked. Have the recovery status checked before continuing.";
  attempt.cancelling = (async () => {
    try {
      if (attempt.preparing && !attempt.handoff && !["not-spawned", "cancelled"].includes(preparation)) throw new Error("Helper preparation is unconfirmed.");
      if (attempt.handoff) {
        await withAbort(attempt.handoff.cancel(), AbortSignal.timeout(10_000));
        if (attempt.helperProcesses?.length !== 1) throw new Error("The original helper identity is unconfirmed.");
        await withAbort(waitForMaintenanceExit(attempt.helperProcesses, 10_000), AbortSignal.timeout(12_000));
        if (readMaintenanceStartup(userDataDir, { consume: false }) !== null) throw new Error("The helper's recovery status is unconfirmed.");
      }
    } catch {
      return Object.assign(new Error(resetBlockedReason), { maintenanceRetryable: false });
    }
    if (attempt.commitAttempted) {
      resetBlockedReason = "The native helper's commitment is unconfirmed. Keep this app open; retry and quit are blocked. Have the recovery status checked before continuing.";
      return Object.assign(new Error(resetBlockedReason), { maintenanceRetryable: false });
    }
    resetHandoff = null;
    resetInProgress = false;
    resetRetryReady = error?.maintenanceRetryable !== false;
    const detail = typeof error?.maintenanceRetryable === "boolean" ? error.message : "The native Fresh start handoff did not finish.";
    resetBlockedReason = resetRetryReady ? "" : `${detail} This shutdown cannot be retried in this app session. Quit and reopen Open Coworker before another Fresh start.`;
    return Object.assign(new Error(resetRetryReady
      ? `${detail} Nothing was erased. ${attempt.handoff || preparation === "cancelled" ? "The helper was safely cancelled. " : preparation === "not-spawned" ? "No helper was started. " : ""}You can retry erase & restart here; ordinary work stays closed after shutdown begins.`
      : resetBlockedReason), { maintenanceRetryable: resetRetryReady });
  })();
  return attempt.cancelling;
}

commands["maintenance.preview"] = () => maintenance.preview();
commands["maintenance.restoreDefaults"] = () => maintenance.restoreDefaults();
commands["maintenance.factoryReset"] = async (input) => {
  assertResetConfirmation(input);
  if (quitting || quitReady || resetExitReady) throw new Error("Open Coworker is already closing. Fresh start was not started.");
  if (resetInProgress) throw new Error(resetBlockedReason || "Fresh start is already in progress.");
  if (!resetRetryReady) {
    if (maintenanceAdmission.closed && resetBlockedReason) throw new Error(resetBlockedReason);
    maintenanceAdmission.assertOpen();
  }
  resetInProgress = true;
  resetRetryReady = false;
  resetBlockedReason = "";
  const attempt = { handoff: null, ready: false, consumed: false, preparing: false, commitAttempted: false };
  resetHandoff = attempt;
  try {
    // Background startup may still be assigning serverHandle. Join it before
    // closing admission or retaining the process identity for shutdown. A retry
    // behind closed admission must keep its original owner and stop receipt.
    if (!maintenanceAdmission.closed) {
      try {
        const handle = await withAbort(ensurePlatformServer(), AbortSignal.timeout(60_000));
        const native = handle?.managedOpencodeV2;
        if (serverHandle !== handle || !Number.isSafeInteger(native?.pid) || native.pid < 2 || !native.isAlive()) {
          throw new Error("Native ownership is not ready.");
        }
      } catch {
        throw Object.assign(new Error("The AI service is not ready for Fresh start. Wait for startup or restart the AI service, then try again. No reset was performed."), { maintenanceRetryable: true });
      }
    }
    attempt.previousProcesses = captureMaintenanceProcesses(app.getAppMetrics().map((metric) => metric.pid));
    const scope = maintenanceScope();
    attempt.preparing = true;
    attempt.handoff = await prepareMaintenanceHandoff({ input, scope,
      helperPath: fileURLToPath(new URL("./maintenance-helper.mjs", import.meta.url)),
      args: process.argv.slice(1),
    });
    attempt.helperProcesses = captureMaintenanceProcesses([attempt.handoff.pid]);
    if (attempt.helperProcesses.length !== 1) throw new Error("The original native helper could not be identified.");
    if (!maintenanceAdmission.closed) maintenanceAdmission.close();
    await stopForMaintenance();
    attempt.ready = true;
    resetReceiptTimer = setTimeout(() => {
      if (resetHandoff !== attempt || attempt.consumed) return;
      void cancelResetAttempt(attempt, new Error("The handoff could not be acknowledged.")).then((failure) => {
        dialog.showErrorBox(resetInProgress ? "Fresh start cancellation needs attention" : "Fresh start was not started", failure.message);
      });
    }, 30_000);
    return { phase: "handoff", backupDirectory: attempt.handoff.backupDirectory, handoffId: attempt.handoff.ticket };
  } catch (error) {
    throw await cancelResetAttempt(attempt, error);
  }
};
commands["maintenance.handoffReceived"] = async ({ handoffId }) => {
  const pending = resetHandoff;
  if (!pending?.ready || !pending.handoff || pending.consumed || pending.handoff.ticket !== handoffId) throw new Error("This Fresh start handoff is not current.");
  pending.consumed = true;
  clearTimeout(resetReceiptTimer);
  try {
    await withAbort(pending.handoff.arm([...pending.previousProcesses, ...captureMaintenanceProcesses(app.getAppMetrics().map((metric) => metric.pid).filter((pid) => pid !== pending.handoff.pid))]), AbortSignal.timeout(25_000));
    pending.commitAttempted = true;
    await withAbort(pending.handoff.commit(), AbortSignal.timeout(25_000));
    console.info("[fresh-start] Native handoff committed; closing previous app.");
    resetExitReady = true;
    setImmediate(() => app.exit(0));
    return { acknowledged: true };
  } catch (error) {
    const failure = await cancelResetAttempt(pending, error);
    dialog.showErrorBox("Fresh start was not started", failure.message);
    throw failure;
  }
};

function registerIpc() {
  ipcMain.handle("coworker:invoke", async (event, request) => {
    if (event.senderFrame !== event.sender.mainFrame) {
      return { ok: false, error: "Open Coworker commands are only available to the main app frame." };
    }
    const command = typeof request?.command === "string" ? request.command : "";
    if ((command === "coworkers.openFolder" || command.startsWith("events.") || command.startsWith("voice.") || command.startsWith("computer.") || command.startsWith("browser.") || command.startsWith("workers.") || command.startsWith("groups.documents.")) && !trustedComputerSender(event, mainWindow?.webContents, rendererUrl())) {
      return { ok: false, error: "Native controls require the trusted Open Coworker window and renderer URL." };
    }
    if (command === "voice.microphone" && request?.userGesture !== true) {
      return { ok: false, error: "Click the microphone control to allow audio input." };
    }
    const handler = commands[command];
    if (!handler) {
      return { ok: false, error: `Unknown Open Coworker command: ${command}` };
    }
    const changesReadiness = ["runtime.restart", "den.session.set", "den.session.clear", "den.providers.sync", "localProviders.connect", "localProviders.saveKey", "localProviders.disconnect", "localProviders.custom.add", "localProviders.signIn.start"].includes(command)
      || (command === "coworkers.update" && ["model", "modelVariant", "modelMode", "modelChosenBy", "useAppModelDefaults", "modelSelectionPreferences", "effortPreference", "thinkingModel", "thinkingModelVariant", "deliveryModel", "deliveryModelVariant"].some((field) => Object.hasOwn(request?.payload?.patch ?? {}, field)))
      || (command === "settings.update" && request?.payload?.modelDefaults !== undefined);
    const compareSavedReadiness = changesReadiness && (command === "settings.update" || command === "coworkers.update");
    const readinessOwner = changesReadiness && command === "coworkers.update" ? { slug: request?.payload?.slug, workspaceId: null } : null;
    const readinessChange = changesReadiness ? Promise.withResolvers() : null;
    let readinessUnchanged = false;
    if (readinessChange) {
      workspaceReadinessChanges.set(readinessChange.promise, readinessOwner);
      if (!compareSavedReadiness && command !== "den.providers.sync") invalidateWorkspaceReadiness();
    }
    try {
      if (command.startsWith("maintenance.")) assertMaintenanceSender(event, mainWindow?.webContents, rendererUrl());
      const result = ["maintenance.factoryReset", "maintenance.handoffReceived"].includes(command)
        ? await handler(request?.payload ?? {})
        : await maintenanceAdmission.run(async () => {
          const previous = compareSavedReadiness
            ? command === "coworkers.update" ? await getCoworker(coworkersDir, request?.payload?.slug) : await readSettings(settingsPath)
            : null;
          if (readinessOwner) readinessOwner.workspaceId = previous?.workspaceId ?? null;
          const noSession = command === "den.providers.sync" && !denSession;
          const result = await handler(request?.payload ?? {});
          readinessUnchanged = (noSession && result?.status === "no_session")
            || (command === "den.providers.sync" && result?.readinessUnchanged === true)
            || (previous !== null && JSON.stringify(previous) === JSON.stringify(result));
          return result;
        });
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: resetInProgress && resetBlockedReason ? resetBlockedReason : error instanceof Error ? error.message : String(error),
        ...(["maintenance.factoryReset", "maintenance.handoffReceived"].includes(command)
          ? { maintenanceRetryable: !resetInProgress && !quitting && !quitReady && !resetExitReady && (!maintenanceAdmission.closed || resetRetryReady) } : {}) };
    } finally {
      if (readinessChange) { workspaceReadinessChanges.delete(readinessChange.promise); readinessChange.resolve(); }
      if (changesReadiness && !readinessUnchanged && command !== "runtime.restart") invalidateWorkspaceReadiness(readinessOwner);
      else if (command === "runtime.restart" && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("coworker:runtime-changed", runtimeInfo());
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
  maintenanceAdmission.assertOpen();
  const initialMaterial = windowMaterial(nativeTheme);
  const macWindowChrome = process.platform === "darwin"
    ? {
        // Match the appearance binding before Chromium creates its layers,
        // rather than switching an initially opaque backing to vibrancy later.
        backgroundColor: initialMaterial === "vibrancy" ? "#00000000" : "#090c12",
        vibrancy: initialMaterial === "vibrancy" ? "under-window" : undefined,
        hasShadow: true,
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 18, y: 18 },
        visualEffectState: "followWindow",
      }
    : { backgroundColor: "#090c12" };
  const window = new BrowserWindow({
    show: false,
    backgroundColor: "#090c12",
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
  bindWindowAppearance(window, nativeTheme);
  installVoicePermissions(window.webContents.session, () => mainWindow, rendererUrl, voice);
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void confirmAndOpenExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("context-menu", (_event, params) => {
    const { editFlags, isEditable, selectionText } = params;
    const template = [];
    if (isEditable) {
      template.push(
        { role: "undo", enabled: editFlags.canUndo },
        { role: "redo", enabled: editFlags.canRedo },
        { type: "separator" },
        { role: "cut", enabled: editFlags.canCut },
        { role: "copy", enabled: editFlags.canCopy },
        { role: "paste", enabled: editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll", enabled: editFlags.canSelectAll },
      );
    } else if (selectionText) {
      template.push({ role: "copy", enabled: editFlags.canCopy });
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window });
  });
  // A reload replaces the renderer; its deep-link listener must re-announce.
  window.webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) { voice.reset(); deepLinkListenerReady = false; browserControl.hideWindow(); }
  });
  window.on("close", () => { voice.reset(); browserControl.hideWindow(); });
  window.webContents.on("render-process-gone", () => { voice.reset(); deepLinkListenerReady = false; browserControl.hideWindow(); });
  window.webContents.on("destroyed", () => { voice.reset(); browserControl.hideWindow(); });
  window.on("unresponsive", () => browserControl.hideWindow());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    deepLinkListenerReady = false;
    if (process.platform !== "darwin") app.quit();
  });
  mainWindow = window;
  await window.loadURL(rendererUrl());
  return window;
}

async function focusMainWindow() {
  // A failed reset seals native work until quit. Its existing window must still
  // be reachable, so the person can read the failure and quit normally.
  if (!mainWindow && maintenanceAdmission.closed) {
    dialog.showErrorBox("Fresh start needs attention", resetBlockedReason || (resetInProgress
      ? "Fresh start is still stopping the app. It will reopen after the reset finishes."
      : "Fresh start did not finish. Quit and reopen Open Coworker to review the saved result."));
    return null;
  }
  const window = mainWindow ?? await createMainWindow();
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
    void app.whenReady().then(() => focusMainWindow()).then(() => {
      if (!maintenanceAdmission.closed) queueDeepLinks(forwardedDeepLinks(argv));
    });
  });

  // Register before startup awaits: Dock activation must also restore a hidden
  // or minimized window, including while startup is reporting a reset failure.
  app.on("activate", () => {
    void app.whenReady().then(() => focusMainWindow());
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (maintenanceAdmission.closed) return;
    void app.whenReady()
      .then(() => focusMainWindow())
      .then(() => queueDeepLinks([url]));
  });

  app.whenReady().then(async () => {
    // Coworker's dark palette also applies to OS-drawn menus and window materials.
    nativeTheme.themeSource = "dark";
    if (process.platform === "darwin" && existsSync(APP_ICON_PATH)) app.dock.setIcon(APP_ICON_PATH);
    installApplicationMenu();
    registerIpc();
    if (maintenanceNotice && (maintenanceNotice.phase !== "completed" || maintenanceNotice.relaunchFailed)) {
      await dialog.showMessageBox({ type: maintenanceNotice.phase === "completed" ? "info" : "warning",
        title: maintenanceNotice.phase === "completed" ? "Fresh start complete" : "Fresh start did not finish",
        message: maintenanceNotice.phase === "completed" ? "Your previous local setup was saved in recovery. Open Coworker is ready for a fresh start."
          : "Fresh start stopped safely. Your previous local setup was kept or restored. No cloud records or provider credentials were reset.",
        detail: [maintenanceNotice.relaunchFailed ? "Automatic reopening failed. This launch is reading the saved result." : "",
          maintenanceFailureDetail(maintenanceNotice.diagnostics),
          maintenanceNotice.backupPath ? `Recovery directory: ${maintenanceNotice.backupPath}` : "No completed recovery copy was recorded."].filter(Boolean).join("\n"), buttons: ["Continue"],
      });
      readMaintenanceStartup(userDataDir);
    }
    // Start the platform in the background; the renderer gates on runtime.info.
    void maintenanceAdmission.run(async () => {
      await ensurePlatformServer();
      maintenanceAdmission.assertOpen();
      await events.start();
      await groupExecution.start();
      await collaboration.start();
      progressSummaries.start();
      conversationMemory.start();
      // Ordinary initialization, never triggered by a progress note or activity read.
      void maintenanceAdmission.run(ensureCoordinatorWorkspace).catch(() => {
        console.warn("[open-coworker] native coordinator plugins are not ready; background inference is unavailable");
      });
    }).catch((error) => {
      engineError ||= "The native AI service could not finish preparing local work. Restart it before continuing.";
    });
    startLocalResponsibilitiesScheduler();
    await focusMainWindow();
    // A verified reset returns directly to onboarding. Acknowledge only after
    // its replacement window exists; failures still require the native notice.
    if (maintenanceNotice?.phase === "completed" && !maintenanceNotice.relaunchFailed) readMaintenanceStartup(userDataDir);
    queueDeepLinks(forwardedDeepLinks(process.argv));
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    voice.reset();
    if (resetExitReady) return;
    if (resetInProgress) {
      event.preventDefault();
      return;
    }
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (async () => {
      await workerControls.reset(true);
      const stopped = await computerControl.reset(true);
      if (!stopped.confirmed) {
        const options = { type: "warning", title: "Computer control may still be active", message: COMPUTER_STOP_GUIDANCE,
          detail: "Quitting cannot confirm that the selected computer released this session.", buttons: ["Keep Open", "Quit Anyway"], defaultId: 0, cancelId: 0 };
        const choice = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
        if (choice.response !== 1) return;
      }
      progressSummaries.stop();
      await conversationMemory.stop();
      await events.stop();
      browserControl.destroy();
      await groupExecution.stop();
      if (localResponsibilitiesTimer) {
        clearInterval(localResponsibilitiesTimer);
        localResponsibilitiesTimer = null;
      }
      await collaboration.stop();
      if (toolsServer) await toolsServer.stop().catch(() => undefined);
      toolsServer = null;
      if (serverHandle) {
        try {
          await serverHandle.stop();
          if (serverHandle.managedOpencodeV2?.isAlive()) throw new Error("The native AI service is still running.");
        } catch { throw new Error("The native AI service could not confirm shutdown. Keep Open Coworker open and try quitting again."); }
      }
      serverHandle = null;
      quitReady = true;
      app.quit();
    })().catch(async () => {
      await dialog.showMessageBox({ type: "error", title: "Shutdown needs attention", message: "Open Coworker could not finish stopping.", detail: COMPUTER_STOP_GUIDANCE, buttons: ["Keep Open"] })
        .catch(() => console.warn(COMPUTER_STOP_GUIDANCE));
    }).finally(() => { quitting = false; });
  });
}
