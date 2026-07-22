import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BROWSER_SESSION_PARTITION = "persist:openwork-browser";
const NUKE_PARTITIONS = ["default", BROWSER_SESSION_PARTITION];
const PENDING_NUKE_FILENAME = ".nuke-pending.json";
const WINDOWS_RETRY_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const OPENWORK_CONFIG_FILENAMES = [
  "server.json",
  "runtime.sqlite",
  "runtime.sqlite-wal",
  "runtime.sqlite-shm",
  "runtime-opencode-config.json",
  "tokens.json",
  "env.json",
];
const SHIP_IT_CACHE_DOMAIN = "com.differentai.openwork.ShipIt";
const NUKE_WORKER_FILENAME = "nuke-worker.mjs";
const NUKE_WORKER_DEADLINE_MS = 60_000;
const NUKE_WORKER_PARENT_WAIT_MS = 30_000;
const NUKE_WORKER_ENV_KEYS = [
  "APPDATA",
  "LOCALAPPDATA",
  "OPENWORK_DATA_DIR",
  "OPENWORK_DESKTOP_BOOTSTRAP_PATH",
  "OPENWORK_DEV_MODE",
  "OPENWORK_ELECTRON_USERDATA",
  "OPENWORK_ENV_STORE",
  "OPENWORK_RUNTIME_DB",
  "OPENWORK_SERVER_CONFIG",
  "OPENWORK_TOKEN_STORE",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function envValue(env, key) {
  return String(env?.[key] ?? "").trim();
}

function isTruthyDevMode(env) {
  return envValue(env, "OPENWORK_DEV_MODE") === "1";
}

function normalizePlatform(value) {
  return value === "win32" || value === "darwin" || value === "linux" ? value : "linux";
}

function resolveNukeEnvironment({ env = {}, homedir, platform, userDataPath }) {
  const normalizedPlatform = normalizePlatform(platform);
  const paths = pathApi(normalizedPlatform);
  /** @type {Record<string, string | undefined>} */
  const resolvedEnv = { ...env };
  let resolvedHome = homedir;
  const userDataOverride = envValue(env, "OPENWORK_ELECTRON_USERDATA");
  const resolvedUserDataPath = userDataOverride || userDataPath;

  if (isTruthyDevMode(env)) {
    const root = paths.join(resolvedUserDataPath, "openwork-dev-data");
    resolvedHome = paths.join(root, "home");
    resolvedEnv.HOME = resolvedHome;
    resolvedEnv.USERPROFILE = resolvedHome;
    resolvedEnv.XDG_CONFIG_HOME = paths.join(root, "xdg", "config");
    resolvedEnv.XDG_DATA_HOME = paths.join(root, "xdg", "data");
    resolvedEnv.XDG_CACHE_HOME = paths.join(root, "xdg", "cache");
    resolvedEnv.XDG_STATE_HOME = paths.join(root, "xdg", "state");
    resolvedEnv.OPENCODE_CONFIG_DIR = paths.join(root, "config", "opencode");
    resolvedEnv.OPENCODE_TEST_HOME = resolvedHome;
  }

  return {
    env: resolvedEnv,
    homedir: resolvedHome,
    platform: normalizedPlatform,
    paths,
    userDataPath: resolvedUserDataPath,
  };
}

function desktopConfigHome(env, homedir, platform, paths) {
  const xdgConfigHome = envValue(env, "XDG_CONFIG_HOME");
  if (xdgConfigHome) return xdgConfigHome;
  if (platform === "win32") {
    const localAppData = envValue(env, "LOCALAPPDATA");
    if (localAppData) return localAppData;
    return paths.join(homedir, "AppData", "Local");
  }
  return paths.join(homedir, ".config");
}

function appDataHome(env, homedir, platform, paths) {
  const appData = envValue(env, "APPDATA");
  return appData || paths.join(homedir, "AppData", "Roaming");
}

function openworkServerConfigPath(env, homedir, platform, paths) {
  const override = envValue(env, "OPENWORK_SERVER_CONFIG");
  if (override) return paths.resolve(override);
  if (platform === "win32") return paths.join(appDataHome(env, homedir, platform, paths), "openwork", "server.json");
  const xdgConfigHome = envValue(env, "XDG_CONFIG_HOME");
  const root = xdgConfigHome || paths.join(homedir, ".config");
  return paths.join(root, "openwork", "server.json");
}

function envStorePath(env, homedir, platform, paths) {
  const override = envValue(env, "OPENWORK_ENV_STORE");
  if (override) return paths.resolve(override);
  if (platform === "win32") return paths.join(appDataHome(env, homedir, platform, paths), "openwork", "env.json");
  return paths.join(homedir, ".config", "openwork", "env.json");
}

function tokenStorePath(env, serverConfigPath, homedir, paths) {
  const override = envValue(env, "OPENWORK_TOKEN_STORE");
  if (override) return paths.resolve(override);
  const configDir = serverConfigPath ? paths.dirname(serverConfigPath) : paths.join(homedir, ".config", "openwork");
  return paths.join(configDir, "tokens.json");
}

function runtimeDbPath(env, serverConfigPath, homedir, paths) {
  const override = envValue(env, "OPENWORK_RUNTIME_DB");
  if (override) return paths.resolve(override);
  const configDir = serverConfigPath ? paths.dirname(serverConfigPath) : paths.join(homedir, ".config", "openwork");
  return paths.join(configDir, "runtime.sqlite");
}

function desktopBootstrapPath(env, homedir, platform, paths, userDataPath) {
  const override = envValue(env, "OPENWORK_DESKTOP_BOOTSTRAP_PATH");
  if (override) return override;
  if (isTruthyDevMode(env)) {
    return paths.join(userDataPath, "openwork-dev-data", "home", ".config", "openwork", "desktop-bootstrap.json");
  }
  return paths.join(desktopConfigHome(env, homedir, platform, paths), "openwork", "desktop-bootstrap.json");
}

function legacyDesktopBootstrapPath(homedir, paths) {
  return paths.join(homedir, ".config", "openwork", "desktop-bootstrap.json");
}

function globalOpencodeConfigHome(env, homedir, platform, paths) {
  const xdgConfigHome = envValue(env, "XDG_CONFIG_HOME");
  if (xdgConfigHome) return xdgConfigHome;
  if (platform === "win32") return appDataHome(env, homedir, platform, paths);
  return paths.join(homedir, ".config");
}

function opencodeDataDirs(env, homedir, platform, paths) {
  const dirs = [];
  const xdgDataHome = envValue(env, "XDG_DATA_HOME");
  if (xdgDataHome) dirs.push(paths.join(xdgDataHome, "opencode"));
  dirs.push(paths.join(homedir, ".local", "share", "opencode"));
  if (platform === "darwin") dirs.push(paths.join(homedir, "Library", "Application Support", "opencode"));
  if (platform === "win32") dirs.push(paths.join(appDataHome(env, homedir, platform, paths), "opencode"));
  return dirs;
}

function opencodeConfigDirs(env, homedir, platform, paths) {
  const dirs = [paths.join(globalOpencodeConfigHome(env, homedir, platform, paths), "opencode")];
  const opencodeConfigDir = envValue(env, "OPENCODE_CONFIG_DIR");
  if (opencodeConfigDir) dirs.push(opencodeConfigDir);
  return dirs;
}

function opencodeCacheDirs(env, homedir, paths) {
  const dirs = [];
  const xdgCacheHome = envValue(env, "XDG_CACHE_HOME");
  if (xdgCacheHome) dirs.push(paths.join(xdgCacheHome, "opencode"));
  dirs.push(paths.join(homedir, ".cache", "opencode"));
  return dirs;
}

function orchestratorDataDir(env, homedir, paths) {
  const override = envValue(env, "OPENWORK_DATA_DIR");
  if (override) return override;
  return paths.join(homedir, ".openwork", "openwork-orchestrator");
}

function opencodeDbOverridePaths(env, dataDirs, paths) {
  const override = envValue(env, "OPENCODE_DB");
  if (!override) return [];
  if (paths.isAbsolute(override)) return [override];
  return dataDirs.map((dir) => paths.join(dir, override));
}

function sameOrInside(candidate, parent, paths, platform) {
  if (!candidate || !parent) return false;
  const candidateResolved = paths.resolve(candidate);
  const parentResolved = paths.resolve(parent);
  const keyCandidate = platform === "win32" ? candidateResolved.toLowerCase() : candidateResolved;
  const keyParent = platform === "win32" ? parentResolved.toLowerCase() : parentResolved;
  const relative = paths.relative(keyParent, keyCandidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !paths.isAbsolute(relative));
}

function shouldSkipDeletePath(targetPath, preserveBootstrapPath, homedir, paths, platform) {
  if (!targetPath) return true;
  if (preserveBootstrapPath && paths.resolve(targetPath) === paths.resolve(preserveBootstrapPath)) return true;
  const opencodeBin = paths.join(homedir, ".opencode", "bin");
  return sameOrInside(targetPath, opencodeBin, paths, platform) || paths.resolve(targetPath) === paths.dirname(paths.resolve(opencodeBin));
}

function uniquePaths(rawPaths, paths, platform) {
  const seen = new Set();
  const output = [];
  for (const rawPath of rawPaths) {
    const value = String(rawPath ?? "").trim();
    if (!value) continue;
    const normalized = paths.normalize(value);
    const key = platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function addOpenworkConfigFiles(deletePaths, roots, paths) {
  for (const root of roots) {
    if (!root) continue;
    for (const filename of OPENWORK_CONFIG_FILENAMES) {
      deletePaths.push(paths.join(root, filename));
    }
  }
}

function resolveNukePlan(input) {
  const resolved = resolveNukeEnvironment(input);
  const { env, homedir, platform, paths, userDataPath } = resolved;
  const bootstrapPath = desktopBootstrapPath(env, homedir, platform, paths, userDataPath);
  const preserveBootstrapPath = input.preserveBootstrap === false ? null : bootstrapPath;
  const legacyBootstrapPath = legacyDesktopBootstrapPath(homedir, paths);
  const serverConfig = openworkServerConfigPath(env, homedir, platform, paths);
  const runtimeDb = runtimeDbPath(env, serverConfig, homedir, paths);
  const envStore = envStorePath(env, homedir, platform, paths);
  const tokens = tokenStorePath(env, serverConfig, homedir, paths);
  const runtimeConfig = paths.join(paths.dirname(runtimeDb), "runtime-opencode-config.json");
  const dataDirs = opencodeDataDirs(env, homedir, platform, paths);
  const deletePaths = [
    userDataPath,
    serverConfig,
    runtimeDb,
    `${runtimeDb}-wal`,
    `${runtimeDb}-shm`,
    runtimeConfig,
    tokens,
    envStore,
    bootstrapPath,
    legacyBootstrapPath,
    ...dataDirs,
    ...opencodeDbOverridePaths(env, dataDirs, paths),
    ...opencodeConfigDirs(env, homedir, platform, paths),
    ...opencodeCacheDirs(env, homedir, paths),
    orchestratorDataDir(env, homedir, paths),
  ];

  const openworkConfigRoots = [
    paths.join(desktopConfigHome(env, homedir, platform, paths), "openwork"),
    paths.dirname(serverConfig),
    paths.dirname(runtimeDb),
    paths.dirname(tokens),
    paths.dirname(envStore),
  ];
  deletePaths.push(...openworkConfigRoots);
  addOpenworkConfigFiles(deletePaths, openworkConfigRoots, paths);

  if (platform === "darwin") {
    deletePaths.push(paths.join(homedir, "Library", "Caches", SHIP_IT_CACHE_DOMAIN));
  }

  const filteredDeletePaths = deletePaths.filter(
    (targetPath) => !shouldSkipDeletePath(targetPath, preserveBootstrapPath, homedir, paths, platform),
  );
  const manifest = {
    deletePaths: uniquePaths(filteredDeletePaths, paths, platform),
    bootstrapPath,
    preserveBootstrapPath: preserveBootstrapPath || null,
    partitions: [...NUKE_PARTITIONS],
  };
  const pendingPath = paths.join(desktopConfigHome(env, homedir, platform, paths), "openwork", PENDING_NUKE_FILENAME);

  return {
    manifest,
    pendingPath,
    preservePaths: uniquePaths([preserveBootstrapPath, paths.join(homedir, ".opencode", "bin")], paths, platform),
    legacyBootstrapPath: paths.resolve(legacyBootstrapPath) === paths.resolve(bootstrapPath) ? null : legacyBootstrapPath,
    platform,
  };
}

export function buildNukeManifest(input) {
  return resolveNukePlan(input).manifest;
}

export function buildNukeWorkerNukeInput(input) {
  const env = {};
  for (const key of NUKE_WORKER_ENV_KEYS) {
    const value = envValue(input.env, key);
    if (value) env[key] = value;
  }
  return {
    env,
    homedir: String(input.homedir ?? ""),
    platform: normalizePlatform(input.platform),
    preserveBootstrap: input.preserveBootstrap !== false,
    userDataPath: String(input.userDataPath ?? ""),
  };
}

function safeNukeWorkerAppArgv(argv) {
  const input = Array.isArray(argv) ? argv : [];
  const entrypoint = typeof input[0] === "string" ? input[0].trim() : "";
  return entrypoint.endsWith("main.mjs") ? [entrypoint] : [];
}

export function buildNukeWorkerPayload({ parentPid, nukeInput, appExecutablePath, appArgv, pendingPath, nowMs = Date.now() }) {
  return {
    version: 1,
    parentPid: Number(parentPid) || 0,
    nukeInput: buildNukeWorkerNukeInput(nukeInput),
    appExecutablePath: String(appExecutablePath ?? ""),
    appArgv: safeNukeWorkerAppArgv(appArgv),
    pendingPath: String(pendingPath ?? ""),
    parentWaitDeadlineAt: nowMs + NUKE_WORKER_PARENT_WAIT_MS,
    deadlineAt: nowMs + NUKE_WORKER_DEADLINE_MS,
  };
}

function nukeWorkerScriptPath() {
  return path.join(__dirname, NUKE_WORKER_FILENAME);
}

function nukeWorkerPayloadPath() {
  return path.join(os.tmpdir(), `openwork-nuke-worker-${Date.now()}-${randomBytes(6).toString("hex")}.json`);
}

async function writeNukeWorkerPayload(payloadPath, payload) {
  await writeFile(payloadPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function nukeWorkerSpawnEnv(env = process.env) {
  const workerEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  delete workerEnv["OPENWORK_ELECTRON_REMOTE_DEBUG_PORT"];
  return workerEnv;
}

function nukeRelaunchArgv(app, argv) {
  const input = Array.isArray(argv) ? argv.slice(1) : [];
  const output = [];
  if (app?.isPackaged !== true && input[0]?.endsWith("main.mjs")) output.push(input.shift());
  output.push(...safeNukeWorkerAppArgv(input));
  return output;
}

export async function scheduleNukeCleanupWorker({ app, input, plan, spawnFn, execPath = process.execPath, argv = process.argv, env = process.env }) {
  const payloadPath = nukeWorkerPayloadPath();
  const payload = buildNukeWorkerPayload({
    parentPid: process.pid,
    nukeInput: input,
    appExecutablePath: execPath,
    appArgv: nukeRelaunchArgv(app, argv),
    pendingPath: plan.pendingPath,
  });
  await writeNukeWorkerPayload(payloadPath, payload);
  try {
    const launchWorker = typeof spawnFn === "function" ? spawnFn : spawn;
    const child = launchWorker(execPath, [nukeWorkerScriptPath(), payloadPath], {
      detached: true,
      env: nukeWorkerSpawnEnv(env),
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { pid: child.pid ?? null, payloadPath };
  } catch (error) {
    await rm(payloadPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function sanitizeDesktopBootstrapConfig(input, writtenAt = new Date().toISOString()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!baseUrl) return null;
  const apiBaseUrl = typeof input.apiBaseUrl === "string" ? input.apiBaseUrl.trim() : "";
  const brandAppName = typeof input.brandAppName === "string" ? input.brandAppName.trim().slice(0, 64) : "";
  const brandLogoUrl = typeof input.brandLogoUrl === "string" ? input.brandLogoUrl.trim() : "";
  const brandIconUrl = typeof input.brandIconUrl === "string" ? input.brandIconUrl.trim() : "";
  return {
    baseUrl,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    requireSignin: input.requireSignin === true,
    ...(brandAppName ? { brandAppName } : {}),
    ...(brandLogoUrl ? { brandLogoUrl } : {}),
    ...(brandIconUrl ? { brandIconUrl } : {}),
    writtenAt,
  };
}

async function readJsonIfPresent(targetPath) {
  try {
    const raw = await readFile(targetPath, "utf8");
    const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return { exists: true, ok: true, value: JSON.parse(content) };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { exists: false, ok: false, value: null };
    return { exists: true, ok: false, value: null };
  }
}

async function writeJsonFile(targetPath, value) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function sanitizeDesktopBootstrapFiles({ canonicalPath, legacyPath }) {
  const canonical = await readJsonIfPresent(canonicalPath);
  const legacy = legacyPath ? await readJsonIfPresent(legacyPath) : { exists: false, ok: false, value: null };
  const canonicalSanitized = canonical.ok ? sanitizeDesktopBootstrapConfig(canonical.value) : null;
  const legacySanitized = legacy.ok ? sanitizeDesktopBootstrapConfig(legacy.value) : null;
  const sanitized = canonicalSanitized ?? legacySanitized;

  if (sanitized) {
    await writeJsonFile(canonicalPath, sanitized);
    if (legacyPath) await rm(legacyPath, { force: true });
    return true;
  }

  if (canonical.exists) await rm(canonicalPath, { force: true });
  if (legacyPath && legacy.exists) await rm(legacyPath, { force: true });
  return false;
}

async function sanitizeDesktopBootstrapOnDisk(plan) {
  const preservePath = plan.manifest.preserveBootstrapPath;
  if (!preservePath) return false;
  return sanitizeDesktopBootstrapFiles({
    canonicalPath: preservePath,
    legacyPath: plan.legacyBootstrapPath,
  });
}

function errorCode(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return "";
  return typeof error.code === "string" ? error.code : "";
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function receiptError(targetPath, error) {
  const code = errorCode(error);
  return {
    path: targetPath,
    message: errorMessage(error),
    ...(code ? { code } : {}),
  };
}

function isWindowsRetryable(error, platform) {
  return platform === "win32" && WINDOWS_RETRY_CODES.has(errorCode(error));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nativeSameOrInside(candidate, parent) {
  const candidateResolved = path.resolve(candidate);
  const parentResolved = path.resolve(parent);
  const relative = path.relative(parentResolved, candidateResolved);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function containedPreservePaths(targetPath, preservePaths) {
  return preservePaths.filter((preservePath) => nativeSameOrInside(preservePath, targetPath));
}

async function removeDirectoryContentsExcept(targetPath, preservePaths) {
  const entries = await readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.join(targetPath, entry.name);
    const childPreservePaths = containedPreservePaths(childPath, preservePaths);
    if (childPreservePaths.length > 0) {
      if (entry.isDirectory()) await removeDirectoryContentsExcept(childPath, childPreservePaths);
      continue;
    }
    await rm(childPath, { recursive: true, force: true });
  }
}

async function removePathPreservingPaths(targetPath, preservePaths) {
  if (preservePaths.some((preservePath) => nativeSameOrInside(targetPath, preservePath))) return;
  const contained = containedPreservePaths(targetPath, preservePaths);
  if (contained.length === 0) {
    await rm(targetPath, { recursive: true, force: true });
    return;
  }
  if (!existsSync(targetPath)) return;
  const info = await stat(targetPath);
  if (!info.isDirectory()) return;
  await removeDirectoryContentsExcept(targetPath, contained);
}

async function removePathWithRetry(targetPath, preservePaths, platform) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await removePathPreservingPaths(targetPath, preservePaths);
      return null;
    } catch (error) {
      lastError = error;
      if (!isWindowsRetryable(error, platform) || attempt === 3) break;
      await sleep(250);
    }
  }
  return lastError;
}

async function onlyPreserveBranchesRemain(targetPath, preservePaths) {
  const contained = containedPreservePaths(targetPath, preservePaths);
  if (contained.length === 0) return false;
  if (!existsSync(targetPath)) return true;
  const entries = await readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.join(targetPath, entry.name);
    const childPreservePaths = containedPreservePaths(childPath, contained);
    if (childPreservePaths.length === 0) return false;
    if (entry.isDirectory() && !(await onlyPreserveBranchesRemain(childPath, childPreservePaths))) return false;
  }
  return true;
}

async function pathDeletedOrPreservedOnly(targetPath, preservePaths) {
  try {
    await stat(targetPath);
  } catch {
    return true;
  }
  return onlyPreserveBranchesRemain(targetPath, preservePaths);
}

async function deleteManifestPaths(manifest, platform, preservePaths, options = {}) {
  const errors = [];
  const removePath = typeof options.removePathWithRetry === "function" ? options.removePathWithRetry : removePathWithRetry;
  for (const targetPath of manifest.deletePaths) {
    const error = await removePath(targetPath, preservePaths, platform);
    if (error) errors.push(receiptError(targetPath, error));
  }
  return errors;
}

async function verifyManifestDeletion(manifest, deletionErrors, preservePaths) {
  const deleted = [];
  const pendingRetry = [];
  const errors = [...deletionErrors];
  const erroredPaths = new Set(deletionErrors.map((error) => error.path));
  for (const targetPath of manifest.deletePaths) {
    if (await pathDeletedOrPreservedOnly(targetPath, preservePaths)) {
      deleted.push(targetPath);
      continue;
    }
    pendingRetry.push(targetPath);
    if (!erroredPaths.has(targetPath)) {
      errors.push({ path: targetPath, message: "Path still exists after deletion" });
    }
  }
  return { deleted, pendingRetry, errors };
}

function nukeNowIso(options = {}) {
  return typeof options.nowIso === "string" && options.nowIso.trim()
    ? options.nowIso.trim()
    : new Date().toISOString();
}

function pendingCreatedAt(pending, fallback) {
  const createdAt = typeof pending?.createdAt === "string" ? pending.createdAt.trim() : "";
  return createdAt && Number.isFinite(Date.parse(createdAt)) ? createdAt : fallback;
}

function pendingCleanupResult({ ran, invalid = false, deleted = [], pendingRetry = [], errors = [] }) {
  return { ran, invalid, deleted, pendingRetry, errors };
}

async function writePendingNukeFile(pendingPath, paths, pending = null, options = {}) {
  if (paths.length === 0) return;
  const attemptedAt = nukeNowIso(options);
  await writeJsonFile(pendingPath, {
    paths,
    preserveBootstrap: typeof pending?.preserveBootstrap === "boolean"
      ? pending.preserveBootstrap
      : options.preserveBootstrap !== false,
    createdAt: pendingCreatedAt(pending, attemptedAt),
    attemptedAt,
  });
}

async function writeReceipt(receipt) {
  const receiptPath = path.join(os.tmpdir(), `openwork-nuke-receipt-${Date.now()}.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

async function clearSessionStorage(targetSession) {
  await targetSession.clearStorageData();
  try {
    targetSession.flushStorageData();
  } catch {
    // Best effort only; clearStorageData is the authoritative operation.
  }
}

async function clearChromiumStorage(sessionModule) {
  const browserSession = sessionModule.fromPartition(BROWSER_SESSION_PARTITION);
  await clearSessionStorage(sessionModule.defaultSession);
  await clearSessionStorage(browserSession);
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function bestEffort(errors, label, task, timeoutMs) {
  try {
    await withTimeout(Promise.resolve().then(task), timeoutMs, label);
  } catch (error) {
    errors.push(receiptError(label, error));
  }
}

async function quiesceForNuke({ runtimeManager, uiControlServer, removeWindowsBrandShortcut }, errors) {
  await bestEffort(errors, "ui-control-server", () => uiControlServer.stop(), 3000);
  await bestEffort(errors, "runtime-dispose", () => runtimeManager.dispose(), 12_000);
  await bestEffort(errors, "packaged-sidecar-reaper", () => runtimeManager.prepareFreshRuntime(), 16_000);
  await bestEffort(errors, "sandbox-docker-cleanup", () => runtimeManager.sandboxCleanupOpenworkContainers(), 24_000);
  await bestEffort(errors, "windows-brand-shortcut", removeWindowsBrandShortcut, 5000);
}

/** @returns {"cleanup_worker" | "direct"} */
function nukeReceiptRelaunchMode(workerScheduled) {
  return workerScheduled ? "cleanup_worker" : "direct";
}

function preservePathsWithoutBootstrap(plan) {
  const bootstrapPath = plan.manifest.preserveBootstrapPath;
  if (!bootstrapPath) return plan.preservePaths;
  const resolvedBootstrapPath = path.resolve(bootstrapPath);
  return plan.preservePaths.filter((preservePath) => path.resolve(preservePath) !== resolvedBootstrapPath);
}

export async function runPendingNukeCleanup(input, options = {}) {
  const initialPlan = resolveNukePlan(input);
  const pendingFile = await readJsonIfPresent(initialPlan.pendingPath);
  if (!pendingFile.exists) return pendingCleanupResult({ ran: false });
  if (!pendingFile.ok) {
    await rm(initialPlan.pendingPath, { force: true });
    return pendingCleanupResult({ ran: false, invalid: true });
  }
  const pending = pendingFile.ok ? pendingFile.value : null;
  const plan = resolveNukePlan({ ...input, preserveBootstrap: pending?.preserveBootstrap !== false });
  const paths = Array.isArray(pending?.paths)
    ? pending.paths.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : [];
  if (paths.length === 0) {
    await rm(plan.pendingPath, { force: true });
    return pendingCleanupResult({ ran: false });
  }

  const manifest = { ...plan.manifest, deletePaths: paths };
  const deletionErrors = await deleteManifestPaths(manifest, plan.platform, plan.preservePaths, options);
  const verified = await verifyManifestDeletion(manifest, deletionErrors, [...plan.preservePaths, plan.pendingPath]);
  if (verified.pendingRetry.length > 0) {
    await writePendingNukeFile(plan.pendingPath, verified.pendingRetry, pending, options);
    return pendingCleanupResult({ ran: true, ...verified });
  }

  await rm(plan.pendingPath, { force: true });
  return pendingCleanupResult({ ran: true, ...verified });
}

/** @returns {Promise<import("@openwork/types/desktop-ipc").NukeReceipt>} */
export async function executeNukeFreshStart({ app, session, runtimeManager, uiControlServer, removeWindowsBrandShortcut }, options = {}) {
  const input = {
    ...(options.input ?? {
      env: process.env,
      homedir: os.homedir(),
      platform: process.platform,
      userDataPath: app.getPath("userData"),
    }),
    preserveBootstrap: options.preserveBootstrap ?? options.input?.preserveBootstrap ?? true,
  };
  const plan = resolveNukePlan(input);
  const phaseErrors = [];

  await quiesceForNuke({ runtimeManager, uiControlServer, removeWindowsBrandShortcut }, phaseErrors);
  await bestEffort(phaseErrors, "chromium-storage", () => clearChromiumStorage(session), 8000);
  const preservedBootstrap = await sanitizeDesktopBootstrapOnDisk(plan).catch((error) => {
    phaseErrors.push(receiptError(plan.manifest.preserveBootstrapPath ?? "desktop-bootstrap", error));
    return false;
  });
  const preservePaths = preservedBootstrap
    ? plan.preservePaths
    : preservePathsWithoutBootstrap(plan);
  const deletionErrors = await deleteManifestPaths(plan.manifest, plan.platform, preservePaths, options);
  const verified = await verifyManifestDeletion(plan.manifest, [...phaseErrors, ...deletionErrors], preservePaths);
  if (verified.pendingRetry.length > 0) {
    await writePendingNukeFile(plan.pendingPath, verified.pendingRetry, null, {
      preserveBootstrap: input.preserveBootstrap,
    }).catch((error) => {
      verified.errors.push(receiptError(plan.pendingPath, error));
    });
  }
  const scheduleCleanupWorker = typeof options.scheduleCleanupWorker === "function"
    ? options.scheduleCleanupWorker
    : scheduleNukeCleanupWorker;
  let workerScheduled = false;
  if (verified.pendingRetry.length > 0) {
    try {
      await scheduleCleanupWorker({ app, input, plan });
      workerScheduled = true;
    } catch (error) {
      verified.errors.push(receiptError("nuke-cleanup-worker", error));
    }
  }
  const receipt = {
    deleted: verified.deleted,
    pendingRetry: verified.pendingRetry,
    errors: verified.errors,
    preservedBootstrap,
    relaunchMode: nukeReceiptRelaunchMode(workerScheduled),
    workerScheduled,
  };
  await writeReceipt(receipt).catch((error) => {
    receipt.errors.push(receiptError("nuke-receipt", error));
  });

  setTimeout(() => {
    if (!workerScheduled) app.relaunch();
    app.quit();
  }, 100);

  return receipt;
}
