import { randomUUID, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import {
  desktopBootstrapPath,
  normalizeWorkspaceRootPath,
  openworkEnvStorePath,
  openworkServerConfigPath,
  resolveWorkspaceOpencodeConfigPath,
} from "@openwork/paths";
import {
  dedupeCertificates,
  resolveSystemCaBundle,
  summarizeSystemCaSources,
  systemPlatformCertificateLoader,
} from "./system-ca.mjs";

const __runtimeDir = path.dirname(fileURLToPath(import.meta.url));

const DIRECT_RUNTIME = "direct";
const OPENWORK_SERVER_PORT_RANGE_START = 48_000;
const OPENWORK_SERVER_PORT_RANGE_END = 51_000;
const MAX_BOOTSTRAP_BYTES = 256 * 1024;
const MAX_CHAIN_REPAIR_BODY_BYTES = 64 * 1024;
const MAX_CHAIN_REPAIR_ORIGINS = 3;
const CHAIN_REPAIR_TOTAL_TIMEOUT_MS = 20000;
const CHAIN_REPAIR_SOCKET_TIMEOUT_MS = 8000;
const CHAIN_REPAIR_FETCH_TIMEOUT_MS = 8000;
const CERTIFICATE_VERIFY_USE_CHROMIUM = -3;
const CERTIFICATE_VERIFY_OK = 0;
const ERR_CERT_AUTHORITY_INVALID = -202;
const MAX_CERTIFICATE_CHAIN_LENGTH = 10;
const PEM_CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
/** @type {Map<string, X509Certificate | null>} */
const chainRepairRootCache = new Map();

/** @param {unknown} value */
function parsePemCertificates(value) {
  return String(value ?? "").match(PEM_CERTIFICATE_PATTERN) ?? [];
}

/** @param {string} value */
function parseCertificate(value) {
  try {
    return new X509Certificate(value);
  } catch {
    return null;
  }
}

/** @param {X509Certificate} certificate */
function certificateIsCurrent(certificate, now = Date.now()) {
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  return Number.isFinite(validFrom) && Number.isFinite(validTo) && validFrom <= now && now <= validTo;
}

/** @param {X509Certificate} certificate @param {string | undefined} hostname */
function certificateMatchesHostname(certificate, hostname) {
  const value = String(hostname ?? "").trim();
  if (!value) return false;
  try {
    return net.isIP(value) ? certificate.checkIP(value) !== undefined : certificate.checkHost(value) !== undefined;
  } catch {
    return false;
  }
}

/** @param {X509Certificate} certificate */
function certificateAllowsTlsServerAuthentication(certificate) {
  return certificate.keyUsage?.some((usage) =>
    usage === "1.3.6.1.5.5.7.3.1" || /server ?auth/i.test(usage)
  ) === true;
}

/**
 * @typedef {Object} ElectronCertificate
 * @property {string} data
 * @property {ElectronCertificate} [issuerCert]
 */

/** @param {ElectronCertificate | undefined} certificate */
function presentedCertificateChain(certificate) {
  const chain = [];
  const seen = new Set();
  let current = certificate;
  while (current) {
    if (chain.length >= MAX_CERTIFICATE_CHAIN_LENGTH || typeof current.data !== "string") return null;
    const parsed = parseCertificate(current.data);
    if (!parsed) return null;
    const key = parsed.raw.toString("base64");
    if (seen.has(key)) return null;
    seen.add(key);
    chain.push(parsed);
    current = current.issuerCert;
  }
  return chain;
}

/** @param {ElectronCertificate | undefined} certificate @param {string | undefined} hostname @param {X509Certificate[]} trustedAnchors */
function chainEndsAtTrustedAnchor(certificate, hostname, trustedAnchors) {
  const chain = presentedCertificateChain(certificate);
  if (!chain || chain.length === 0 || chain.some((entry) => !certificateIsCurrent(entry))) return false;
  if (!certificateAllowsTlsServerAuthentication(chain[0])) return false;
  if (!certificateMatchesHostname(chain[0], hostname)) return false;
  for (let index = 0; index < chain.length - 1; index += 1) {
    if (chain[index + 1].ca !== true) return false;
    if (!chain[index].checkIssued(chain[index + 1]) || !chain[index].verify(chain[index + 1].publicKey)) return false;
  }
  const terminal = chain.at(-1);
  if (!terminal) return false;
  return trustedAnchors.some((anchor) =>
    anchor.ca === true && terminal.checkIssued(anchor) && terminal.verify(anchor.publicKey)
  );
}

/**
 * @param {string[]} trustedCertificates
 * @returns {(request: { verificationResult?: string, errorCode?: number, hostname?: string, certificate?: ElectronCertificate }, callback: (result: number) => void) => void}
 */
export function createSystemCaCertificateVerifyProc(trustedCertificates) {
  const trustedAnchors = trustedCertificates.map(parseCertificate).filter((certificate) => certificate !== null);
  return (request, callback) => {
    const authorityInvalid = request.verificationResult
      ? request.verificationResult === "net::ERR_CERT_AUTHORITY_INVALID"
        && (request.errorCode === undefined || request.errorCode === ERR_CERT_AUTHORITY_INVALID)
      : request.errorCode === ERR_CERT_AUTHORITY_INVALID;
    if (authorityInvalid && chainEndsAtTrustedAnchor(request.certificate, request.hostname, trustedAnchors)) {
      callback(CERTIFICATE_VERIFY_OK);
      return;
    }
    callback(CERTIFICATE_VERIFY_USE_CHROMIUM);
  };
}

function truncateOutput(value, limit = 8000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function appendOutput(state, key, chunk) {
  const next = `${state[key] ?? ""}${String(chunk ?? "")}`;
  state[key] = truncateOutput(next);
}

function normalizeWorkspaceKey(value, platform = process.platform) {
  try {
    const normalized = normalizeWorkspaceRootPath(value, { platform });
    if (!normalized) return "";
    const paths = platform === "win32" ? path.win32 : path;
    return paths.resolve(normalized).replace(/\\/g, "/").toLowerCase();
  } catch {
    return "";
  }
}

function normalizeServerCredentials(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const clientToken = typeof value.clientToken === "string" && value.clientToken.trim()
    ? value.clientToken
    : null;
  const hostToken = typeof value.hostToken === "string" && value.hostToken.trim()
    ? value.hostToken
    : null;
  if (!clientToken || !hostToken) return null;
  return {
    clientToken,
    hostToken,
    ownerToken: typeof value.ownerToken === "string" && value.ownerToken.trim()
      ? value.ownerToken
      : null,
    updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : 0,
  };
}

export function migrateOpenworkServerTokenStore(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sourceWorkspaces = source.workspaces && typeof source.workspaces === "object" && !Array.isArray(source.workspaces)
    ? source.workspaces
    : {};
  const workspaceEntries = Object.entries(sourceWorkspaces);
  const legacyCredentials = workspaceEntries
    .flatMap(([workspaceKey, entry]) => {
      const credentials = normalizeServerCredentials(entry);
      return credentials ? [{ workspaceKey, credentials }] : [];
    })
    .sort((left, right) => {
      const updatedAtDifference = right.credentials.updatedAt - left.credentials.updatedAt;
      if (updatedAtDifference !== 0) return updatedAtDifference;
      return left.workspaceKey < right.workspaceKey ? -1 : left.workspaceKey > right.workspaceKey ? 1 : 0;
    })[0]?.credentials;
  const credentials = normalizeServerCredentials(source.credentials) ?? legacyCredentials ?? {
    clientToken: randomUUID(),
    hostToken: randomUUID(),
    ownerToken: null,
    updatedAt: nowMs(),
  };
  return { version: 2, credentials };
}

export function prioritizeWorkspacePaths(preferredPath, workspacePaths = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const paths = [];
  const seen = new Set();
  const add = (value) => {
    let workspacePath;
    try {
      workspacePath = normalizeWorkspaceRootPath(value, { platform });
    } catch {
      return;
    }
    const key = normalizeWorkspaceKey(workspacePath, platform);
    if (!workspacePath || !key || seen.has(key)) return;
    paths.push(workspacePath);
    seen.add(key);
  };
  add(preferredPath);
  for (const workspacePath of workspacePaths) add(workspacePath);
  return paths;
}

function workspaceInaccessibleError(workspacePath, cause) {
  if (cause && typeof cause === "object" && cause.code === "workspace_inaccessible") return cause;
  const error = new Error(`Workspace path is not accessible: ${workspacePath}`, { cause });
  Object.defineProperties(error, {
    code: { value: "workspace_inaccessible", enumerable: true },
    workspacePath: { value: workspacePath, enumerable: true },
  });
  return error;
}

export async function prepareRuntimeWorkspaceRoot(projectDir, options = {}) {
  const rawProjectDir = String(projectDir ?? "").trim();
  try {
    const workspaceRoot = normalizeWorkspaceRootPath(rawProjectDir, {
      platform: options.platform ?? process.platform,
    });
    if (!workspaceRoot) throw new Error("projectDir is required");
    await (options.mkdirImpl ?? mkdir)(workspaceRoot, { recursive: true });
    if (typeof options.ensureConfig === "function") {
      await options.ensureConfig(workspaceRoot);
    }
    return workspaceRoot;
  } catch (error) {
    throw workspaceInaccessibleError(rawProjectDir, error);
  }
}

export function resolveOpenworkServerConfigPath(env = process.env) {
  return openworkServerConfigPath({ env });
}

export function seedWorkspacePathsForEmbeddedServer(workspacePaths, serverConfigExists) {
  return serverConfigExists ? [] : workspacePaths;
}

export function selectStickyOpenworkPortWorkspace(requestedWorkspacePaths = [], serverWorkspacePaths = []) {
  for (const value of [...requestedWorkspacePaths, ...serverWorkspacePaths]) {
    const workspacePath = String(value ?? "").trim();
    if (workspacePath) return workspacePath;
  }
  return "";
}

export function resolveEvalLocalServerDelayMs(env = process.env) {
  const delayMs = Number(env.OPENWORK_EVAL_LOCAL_SERVER_DELAY_MS);
  return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
}

export function reconcileInjectedUserEnv({
  processEnv,
  inheritedEnv,
  userEnv,
  previouslyInjectedKeys = new Set(),
}) {
  for (const key of previouslyInjectedKeys) {
    if (Object.prototype.hasOwnProperty.call(userEnv, key)) continue;
    if (Object.prototype.hasOwnProperty.call(inheritedEnv, key)) {
      processEnv[key] = inheritedEnv[key];
    } else {
      delete processEnv[key];
    }
  }

  for (const [key, value] of Object.entries(userEnv)) {
    if (Object.prototype.hasOwnProperty.call(inheritedEnv, key)) continue;
    processEnv[key] = value;
  }

  return new Set(
    Object.keys(userEnv).filter(
      (key) => !Object.prototype.hasOwnProperty.call(inheritedEnv, key),
    ),
  );
}

export function commandMatchesPackagedSidecar(command, sidecarDirs = []) {
  const value = String(command ?? "");
  if (!sidecarDirs.some((dir) => String(dir ?? "").trim() && value.includes(dir))) {
    return false;
  }
  return /(?:^|[/\\])opencode[^/\\\s]*\s+serve\b/.test(value);
}

export function embeddedServerImportUrl(embeddedPath) {
  const url = pathToFileURL(embeddedPath);
  try {
    const stats = statSync(embeddedPath);
    url.searchParams.set("mtimeMs", String(stats.mtimeMs));
    url.searchParams.set("size", String(stats.size));
  } catch {
    // Fall back to the deterministic file URL if stat fails; startup can continue.
  }
  return url.href;
}

function nowMs() {
  return Date.now();
}

function createEngineState() {
  return {
    child: null,
    childExited: true,
    runtime: DIRECT_RUNTIME,
    projectDir: null,
    hostname: null,
    port: null,
    baseUrl: null,
    opencodeUsername: null,
    opencodePassword: null,
    opencodeBinPath: null,
    opencodeBinSource: null,
    managedByServer: false,
    managedPid: null,
    managedIsAlive: null,
    lastStdout: null,
    lastStderr: null,
    execution: null,
  };
}

export function snapshotEngineState(state) {
  const child = state.childExited ? null : state.child;
  let managedRunning = false;
  if (state.managedByServer && typeof state.managedIsAlive === "function") {
    try {
      managedRunning = state.managedIsAlive() === true;
    } catch {
      managedRunning = false;
    }
  }
  const childRunning = Boolean(child && child.exitCode === null && !child.killed);
  return {
    running: managedRunning || childRunning,
    runtime: state.runtime,
    managedByServer: state.managedByServer === true,
    baseUrl: state.baseUrl,
    projectDir: state.projectDir,
    hostname: state.hostname,
    port: state.port,
    opencodeUsername: state.opencodeUsername,
    opencodePassword: state.opencodePassword,
    opencodeBinPath: state.opencodeBinPath,
    opencodeBinSource: state.opencodeBinSource,
    pid: state.managedByServer ? state.managedPid ?? null : child?.pid ?? null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
    execution: state.execution,
  };
}

function createOpenworkServerState() {
  return {
    child: null,
    childExited: true,
    inProcess: false,
    engineRollover: false,
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
    lastStdout: null,
    lastStderr: null,
    managedOpencodeExecution: null,
  };
}

export function snapshotOpenworkServerState(state) {
  const child = state.childExited ? null : state.child;
  const running = state.inProcess || Boolean(child && child.exitCode === null && !child.killed);
  return {
    running,
    engineRollover: state.engineRollover === true,
    remoteAccessEnabled: state.remoteAccessEnabled,
    host: state.host,
    port: state.port,
    baseUrl: state.baseUrl,
    connectUrl: state.connectUrl,
    mdnsUrl: state.mdnsUrl,
    lanUrl: state.lanUrl,
    clientToken: state.clientToken,
    ownerToken: state.ownerToken,
    hostToken: state.hostToken,
    managedOpencodeBinPath: state.managedOpencodeBinPath,
    managedOpencodeBinSource: state.managedOpencodeBinSource,
    pid: child?.pid ?? null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
    managedOpencodeExecution: state.managedOpencodeExecution,
  };
}

export function resolveEngineRolloverPreference(optionValue, persistedValue) {
  return typeof optionValue === "boolean" ? optionValue : persistedValue === true;
}

/**
 * A failed server start must not leave the state objects describing the
 * runtime it already stopped: snapshotOpenworkServerState would report
 * running:true with a dead baseUrl and assertOpenworkServerReady would pass
 * against it. Keeps accumulated output for diagnostics and the project dir so
 * a retry via engineRestart still knows its workspace. The engine state only
 * resets when this start owned the engine (manageOpencode) — an external
 * engine keeps running regardless of the server's fate.
 */
export function resetRuntimeStatesAfterFailedServerStart(openworkServerStateRef, engineStateRef, options = {}) {
  const serverStdout = openworkServerStateRef.lastStdout;
  const serverStderr = openworkServerStateRef.lastStderr;
  Object.assign(openworkServerStateRef, createOpenworkServerState());
  openworkServerStateRef.lastStdout = serverStdout;
  openworkServerStateRef.lastStderr = serverStderr;
  if (options.manageOpencode === true) {
    const engineStdout = engineStateRef.lastStdout;
    const engineStderr = engineStateRef.lastStderr;
    const projectDir = engineStateRef.projectDir;
    Object.assign(engineStateRef, createEngineState());
    engineStateRef.lastStdout = engineStdout;
    engineStateRef.lastStderr = engineStderr;
    engineStateRef.projectDir = projectDir;
  }
}

function assertOpenworkServerReady(snapshot) {
  if (!snapshot?.running) {
    throw new Error("OpenWork server did not stay running after startup.");
  }
  if (!snapshot.baseUrl) {
    throw new Error("OpenWork server did not report a base URL after startup.");
  }
  if (!snapshot.ownerToken && !snapshot.clientToken) {
    throw new Error("OpenWork server did not report an access token after startup.");
  }
  return snapshot;
}

async function fileExists(targetPath) {
  try {
    await readFile(targetPath);
    return true;
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

function selectLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry && entry.family === "IPv4" && entry.internal === false) {
        return entry.address;
      }
    }
  }
  return null;
}

function buildConnectUrls(port) {
  const hostname = os.hostname().trim();
  const mdnsUrl = hostname ? `http://${hostname.replace(/\.local$/i, "")}.local:${port}` : null;
  const lan = selectLanAddress();
  const lanUrl = lan ? `http://${lan}:${port}` : null;
  return {
    connectUrl: lanUrl ?? mdnsUrl,
    mdnsUrl,
    lanUrl,
  };
}

function targetTriple() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return null;
}

function binaryFileNames(baseName) {
  const ext = process.platform === "win32" ? ".exe" : "";
  const triple = targetTriple();
  return [
    triple ? `${baseName}-${triple}${ext}` : null,
    `${baseName}${ext}`,
  ].filter(Boolean);
}

function isDirectory(targetPath) {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function nvmVersionBinPaths(home) {
  const base = path.join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name, "bin"))
      .filter(isDirectory)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function pathHelperEntries() {
  if (process.platform !== "darwin") return [];
  const result = spawnSync("/usr/libexec/path_helper", ["-s"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return [];
  const stdout = String(result.stdout ?? "");
  const match = stdout.match(/PATH="([^"]+)"/) ?? stdout.match(/PATH=([^;\n]+)/);
  return match?.[1]?.split(path.delimiter).filter(Boolean) ?? [];
}

function extraPathEntries() {
  const home = os.homedir();
  const candidates = [];

  if (process.platform === "darwin") {
    candidates.push(
      ...pathHelperEntries(),
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      path.join(home, ".nvm", "current", "bin"),
      ...nvmVersionBinPaths(home),
      path.join(home, ".fnm", "current", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, "Library", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".pyenv", "shims"),
      path.join(home, ".local", "bin"),
    );
  }

  if (process.platform === "linux") {
    candidates.push(
      "/usr/local/bin",
      "/usr/local/sbin",
      path.join(home, ".nvm", "current", "bin"),
      ...nvmVersionBinPaths(home),
      path.join(home, ".fnm", "current", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".local", "share", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".pyenv", "shims"),
      path.join(home, ".local", "bin"),
    );
  }

  if (process.platform === "win32") {
    candidates.push(
      path.join(home, ".volta", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "pnpm") : null,
    );
  }

  return candidates.filter((entry) => entry && isDirectory(entry));
}

function enrichedPath(sidecarDirs, currentPath) {
  const entries = [
    ...sidecarDirs.filter(isDirectory),
    ...extraPathEntries(),
    ...String(currentPath ?? "").split(path.delimiter).filter(Boolean),
  ];
  const deduped = entries.filter((entry, index) => entries.indexOf(entry) === index);
  return deduped.length > 0 ? deduped.join(path.delimiter) : null;
}

async function portAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a free port.")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function fetchJson(url, options = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // loopback-fetch: fetchJson callers pass runtime-managed 127.0.0.1 server URLs.
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function resolveUserEnvFilePath(env = process.env) {
  return openworkEnvStorePath({ env });
}

const USER_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USER_ENV_RESERVED_PREFIXES = ["OPENWORK_", "OPENCODE_"];

// Synchronous, best-effort; absent or malformed returns {}. Reserved prefixes
// are stripped so a tampered file can never shadow OPENWORK_* / OPENCODE_*.
function loadUserEnvFile(env = process.env) {
  try {
    const raw = readFileSync(resolveUserEnvFilePath(env), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.variables)) return {};
    const out = {};
    for (const entry of parsed.variables) {
      if (!entry || typeof entry !== "object") continue;
      const { key, value } = entry;
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (!USER_ENV_KEY_PATTERN.test(key)) continue;
      if (USER_ENV_RESERVED_PREFIXES.some((p) => key.startsWith(p))) continue;
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reduces an administrator-provisioned Den control-plane URL to its exact
 * origin. Keep this in sync with apps/server/src/enterprise-den-origin.ts.
 *
 * @param {unknown} rawValue
 * @returns {string | null}
 */
function exactEnterpriseOrigin(rawValue) {
  if (typeof rawValue !== "string") return null;
  const raw = rawValue.trim();
  if (!raw || raw.length > 2 * 1024) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function readActivatedEnterpriseOrigin(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size > MAX_BOOTSTRAP_BYTES) return null;
    const raw = await readFile(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_BOOTSTRAP_BYTES) return null;
    const data = JSON.parse(raw);
    if (!isPlainObject(data)) return null;
    const activation = isPlainObject(data.enterpriseActivation) ? data.enterpriseActivation : null;
    if (!activation) return null;
    if (typeof activation.activatedAt !== "string" || !activation.activatedAt.trim()) return null;
    return exactEnterpriseOrigin(activation.denBaseUrl);
  } catch {
    return null;
  }
}

/**
 * @param {Iterable<string>} values
 * @returns {string[]}
 */
function normalizeRepairOrigins(values) {
  const seen = new Set();
  const origins = [];
  for (const value of values) {
    const origin = exactEnterpriseOrigin(value);
    if (!origin || seen.has(origin)) continue;
    origins.push(origin);
    seen.add(origin);
    if (origins.length >= MAX_CHAIN_REPAIR_ORIGINS) break;
  }
  return origins;
}

/**
 * @param {string} origin
 * @returns {{ host: string, port: number }}
 */
function tlsTargetFromOrigin(origin) {
  const url = new URL(origin);
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port ? Number(url.port) : 443,
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorCode(error) {
  return isPlainObject(error) && typeof error.code === "string" ? error.code : "unknown";
}

/**
 * @param {RuntimeChainRepairSocket} socket
 * @returns {void}
 */
function destroySocket(socket) {
  try {
    socket.destroy();
  } catch {
    // Best effort.
  }
}

/**
 * @typedef {Object} RuntimeSystemCaTlsModule
 * @property {(type?: string) => string[]} [getCACertificates]
 * @property {(certificates: string[]) => void} [setDefaultCACertificates]
 */

/**
 * @typedef {Object} RuntimeChainRepairFetchResponse
 * @property {boolean} [ok]
 * @property {number} [status]
 * @property {() => Promise<ArrayBuffer>} arrayBuffer
 */

/**
 * @typedef {Object} RuntimeChainRepairFetchOptions
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {(input: string, init?: RuntimeChainRepairFetchOptions) => Promise<RuntimeChainRepairFetchResponse>} RuntimeChainRepairFetch
 */

/**
 * @typedef {Object} RuntimeChainRepairTlsConnectOptions
 * @property {string} host
 * @property {number} port
 * @property {string} servername
 * @property {boolean} rejectUnauthorized
 * @property {number} timeout
 */

/**
 * @typedef {Object} RuntimeChainRepairPeerCertificate
 * @property {Buffer} [raw]
 * @property {RuntimeChainRepairPeerCertificate} [issuerCertificate]
 */

/**
 * @typedef {Object} RuntimeChainRepairSocket
 * @property {boolean} [authorized]
 * @property {unknown} [authorizationError]
 * @property {(eventName: string, listener: (...args: unknown[]) => void) => RuntimeChainRepairSocket} once
 * @property {(eventName: string, listener: (...args: unknown[]) => void) => RuntimeChainRepairSocket} off
 * @property {(timeout: number) => RuntimeChainRepairSocket} setTimeout
 * @property {() => void} destroy
 * @property {() => X509Certificate | undefined} [getPeerX509Certificate]
 * @property {(detailed?: boolean) => RuntimeChainRepairPeerCertificate | null} [getPeerCertificate]
 */

/**
 * @typedef {(options: RuntimeChainRepairTlsConnectOptions) => RuntimeChainRepairSocket} RuntimeChainRepairTlsConnect
 */

/**
 * @typedef {Object} RuntimeChainRepairOptions
 * @property {string[]} [origins]
 * @property {RuntimeChainRepairFetch} [fetchImpl]
 * @property {() => string[]} [rootsProvider]
 * @property {RuntimeChainRepairTlsConnect} [tlsConnectImpl]
 * @property {string} [bootstrapPath]
 * @property {boolean} [disabled]
 */

/**
 * @typedef {Object} ResolveSystemCaEnvOptions
 * @property {RuntimeSystemCaTlsModule} [tlsModule]
 * @property {string} userDataDir
 * @property {NodeJS.ProcessEnv} [parentEnv]
 * @property {(...args: unknown[]) => void} [logInfo]
 * @property {() => Promise<string[]>} [loadPlatformCertificates]
 * @property {string} [platformSourceName]
 * @property {NodeJS.Platform} [platform]
 * @property {RuntimeChainRepairOptions} [chainRepair]
 */

/**
 * @param {string} origin
 * @param {RuntimeChainRepairTlsConnect} tlsConnectImpl
 * @param {boolean} rejectUnauthorized
 * @returns {Promise<RuntimeChainRepairSocket>}
 */
function connectForChainRepair(origin, tlsConnectImpl, rejectUnauthorized) {
  const target = tlsTargetFromOrigin(origin);
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const finish = (value, isError) => {
      if (settled) return;
      settled = true;
      if (socket) {
        socket.off("secureConnect", onSecureConnect);
        socket.off("error", onError);
        socket.off("timeout", onTimeout);
      }
      if (isError) reject(value);
      else resolve(value);
    };
    const onSecureConnect = () => finish(socket, false);
    const onError = (error) => {
      if (socket) destroySocket(socket);
      finish(error, true);
    };
    const onTimeout = () => {
      const error = new Error("TLS connection timed out");
      Object.defineProperty(error, "code", { value: "ETIMEDOUT" });
      if (socket) destroySocket(socket);
      finish(error, true);
    };

    try {
      socket = tlsConnectImpl({
        host: target.host,
        port: target.port,
        servername: target.host,
        rejectUnauthorized,
        timeout: CHAIN_REPAIR_SOCKET_TIMEOUT_MS,
      });
      socket.once("secureConnect", onSecureConnect);
      socket.once("error", onError);
      socket.once("timeout", onTimeout);
      socket.setTimeout(CHAIN_REPAIR_SOCKET_TIMEOUT_MS);
    } catch (error) {
      finish(error, true);
    }
  });
}

/**
 * @param {string} origin
 * @param {RuntimeChainRepairTlsConnect} tlsConnectImpl
 * @returns {Promise<string | null>}
 */
async function strictProbeChainRepair(origin, tlsConnectImpl) {
  let socket;
  try {
    socket = await connectForChainRepair(origin, tlsConnectImpl, true);
    return socket.authorized === true ? null : String(socket.authorizationError || "UNAUTHORIZED");
  } catch (error) {
    return errorCode(error);
  } finally {
    if (socket) destroySocket(socket);
  }
}

/**
 * @param {RuntimeChainRepairPeerCertificate | null} peer
 * @returns {boolean}
 */
function peerChainIsLeafOnly(peer) {
  if (!peer || typeof peer !== "object") return true;
  const issuer = peer.issuerCertificate;
  if (!issuer || issuer === peer) return true;
  if (peer.raw && issuer.raw && Buffer.compare(Buffer.from(peer.raw), Buffer.from(issuer.raw)) === 0) return true;
  return false;
}

/**
 * @param {string} origin
 * @param {RuntimeChainRepairTlsConnect} tlsConnectImpl
 * @returns {Promise<{ leaf: X509Certificate, leafOnly: boolean } | null>}
 */
async function introspectLeafCertificate(origin, tlsConnectImpl) {
  let socket;
  try {
    socket = await connectForChainRepair(origin, tlsConnectImpl, false);
    if (typeof socket.getPeerX509Certificate !== "function") return null;
    const leaf = socket.getPeerX509Certificate();
    if (!leaf) return null;
    const peer = typeof socket.getPeerCertificate === "function" ? socket.getPeerCertificate(true) : null;
    return { leaf, leafOnly: peerChainIsLeafOnly(peer) };
  } catch {
    return null;
  } finally {
    if (socket) destroySocket(socket);
  }
}

/**
 * @param {X509Certificate} certificate
 * @returns {string[]}
 */
function caIssuerUrls(certificate) {
  const urls = [];
  const infoAccess = typeof certificate.infoAccess === "string" ? certificate.infoAccess : "";
  for (const line of infoAccess.split(/\r?\n/)) {
    const match = /^\s*CA Issuers\s*-\s*URI:(.+?)\s*$/i.exec(line);
    if (!match) continue;
    try {
      const url = new URL(match[1].trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      urls.push(url.href);
      if (urls.length >= 2) break;
    } catch {
      // Ignore malformed AIA entries.
    }
  }
  return urls;
}

/**
 * @param {ArrayBuffer} bytes
 * @returns {X509Certificate}
 */
function certificateFromBody(bytes) {
  const buffer = Buffer.from(bytes);
  try {
    return new X509Certificate(buffer);
  } catch (bufferError) {
    const text = buffer.toString("utf8");
    if (/-----BEGIN CERTIFICATE-----/.test(text)) return new X509Certificate(text);
    throw bufferError;
  }
}

/**
 * @param {X509Certificate} certificate
 * @returns {string}
 */
function certificateCommonName(certificate) {
  for (const line of certificate.subject.split(/\r?\n/)) {
    const match = /^CN\s*=\s*(.+)$/.exec(line.trim());
    if (match) return match[1].trim();
  }
  return certificate.subject || "unknown subject";
}

/**
 * @param {string} pem
 * @returns {X509Certificate | null}
 */
function cachedRootCertificate(pem) {
  const key = String(pem ?? "").trim();
  if (!key) return null;
  if (chainRepairRootCache.has(key)) return chainRepairRootCache.get(key) ?? null;
  try {
    const certificate = new X509Certificate(key);
    chainRepairRootCache.set(key, certificate);
    return certificate;
  } catch {
    chainRepairRootCache.set(key, null);
    return null;
  }
}

/**
 * @param {X509Certificate} intermediate
 * @param {() => string[]} rootsProvider
 * @returns {boolean}
 */
function intermediateChainsToTrustedRoot(intermediate, rootsProvider) {
  let roots = [];
  try {
    roots = rootsProvider();
  } catch {
    roots = [];
  }
  for (const pem of roots) {
    const root = cachedRootCertificate(pem);
    if (root && intermediate.checkIssued(root) && intermediate.verify(root.publicKey)) return true;
  }
  return false;
}

/**
 * @param {X509Certificate} leaf
 * @param {X509Certificate} intermediate
 * @param {() => string[]} rootsProvider
 * @returns {string | null}
 */
function refusalReason(leaf, intermediate, rootsProvider) {
  if (intermediate.ca !== true) return "fetched certificate is not a CA";
  if (leaf.checkIssued(intermediate) !== true) return "fetched certificate did not issue leaf";
  if (leaf.verify(intermediate.publicKey) !== true) return "leaf signature verification failed";
  if (!intermediateChainsToTrustedRoot(intermediate, rootsProvider)) return "fetched certificate does not chain to a trusted public root";
  return null;
}

/**
 * @param {string} url
 * @param {RuntimeChainRepairFetch} fetchImpl
 * @returns {Promise<X509Certificate | null>}
 */
async function fetchIntermediateCertificate(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(CHAIN_REPAIR_FETCH_TIMEOUT_MS) });
  if (!response || typeof response.arrayBuffer !== "function") return null;
  if (response.ok === false) return null;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_CHAIN_REPAIR_BODY_BYTES) return null;
  return certificateFromBody(bytes);
}

/**
 * @param {ResolveSystemCaEnvOptions} options
 * @returns {Promise<string[]>}
 */
async function resolveChainRepairOrigins(options) {
  const env = options.parentEnv ?? {};
  const chainRepair = options.chainRepair ?? {};
  if (chainRepair.origins) return normalizeRepairOrigins(chainRepair.origins);
  const envOrigins = typeof env.OPENWORK_CHAIN_REPAIR_ORIGINS === "string" ? env.OPENWORK_CHAIN_REPAIR_ORIGINS : "";
  if (envOrigins.trim()) return normalizeRepairOrigins(envOrigins.split(","));
  const bootstrapPath = chainRepair.bootstrapPath ?? desktopBootstrapPath({ env });
  const origin = await readActivatedEnterpriseOrigin(bootstrapPath);
  return origin ? [origin] : [];
}

/**
 * @param {ResolveSystemCaEnvOptions} options
 * @returns {Promise<{ pems: string[], timedOut: boolean }>}
 */
async function repairIncompleteChains(options) {
  const env = options.parentEnv ?? {};
  const chainRepair = options.chainRepair ?? {};
  const logInfo = options.logInfo;
  if (chainRepair.disabled === true || String(env.OPENWORK_DISABLE_CHAIN_REPAIR ?? "").trim() === "1") {
    if (typeof logInfo === "function") logInfo("OpenWork runtime: chain repair disabled by OPENWORK_DISABLE_CHAIN_REPAIR.");
    return { pems: [], timedOut: false };
  }

  const origins = await resolveChainRepairOrigins(options);
  if (origins.length === 0) {
    if (!chainRepair.origins && !String(env.OPENWORK_CHAIN_REPAIR_ORIGINS ?? "").trim() && typeof logInfo === "function") {
      logInfo("OpenWork runtime: chain repair skipped: no activation record.");
    }
    return { pems: [], timedOut: false };
  }

  const fetchImpl = chainRepair.fetchImpl ?? globalThis.fetch;
  const tlsModule = options.tlsModule ?? tls;
  const tlsConnectImpl = chainRepair.tlsConnectImpl ?? tls.connect;
  const totalTimeoutValue = Number(env.OPENWORK_CHAIN_REPAIR_TIMEOUT_MS);
  const totalTimeoutMs =
    Number.isFinite(totalTimeoutValue) && totalTimeoutValue >= 1000 && totalTimeoutValue <= 120000
      ? totalTimeoutValue
      : CHAIN_REPAIR_TOTAL_TIMEOUT_MS;
  const rootsProvider = chainRepair.rootsProvider ?? (() => {
    if (typeof tlsModule?.getCACertificates !== "function") return [];
    const roots = tlsModule.getCACertificates("default");
    return Array.isArray(roots) ? roots : [];
  });

  if (typeof fetchImpl !== "function") {
    if (typeof logInfo === "function") {
      for (const origin of origins) logInfo(`OpenWork runtime: chain repair skipped for ${origin}: fetch unavailable`);
    }
    return { pems: [], timedOut: false };
  }

  const run = async () => {
    const pems = [];
    for (const origin of origins) {
      const strictError = await strictProbeChainRepair(origin, tlsConnectImpl);
      if (strictError === null) {
        if (typeof logInfo === "function") logInfo(`OpenWork runtime: chain ok for ${origin}`);
        continue;
      }
      if (strictError !== "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
        if (typeof logInfo === "function") logInfo(`OpenWork runtime: chain repair skipped for ${origin}: ${strictError}`);
        continue;
      }

      const leafState = await introspectLeafCertificate(origin, tlsConnectImpl);
      if (!leafState) {
        if (typeof logInfo === "function") logInfo(`OpenWork runtime: chain repair skipped for ${origin}: certificate introspection failed`);
        continue;
      }
      if (!leafState.leafOnly) {
        if (typeof logInfo === "function") logInfo(`OpenWork runtime: chain repair skipped for ${origin}: served chain includes an intermediate`);
        continue;
      }

      const issuerUrls = caIssuerUrls(leafState.leaf);
      if (issuerUrls.length === 0) {
        if (typeof logInfo === "function") logInfo(`OpenWork runtime: chain repair skipped for ${origin}: no CA Issuers AIA URL`);
        continue;
      }

      let repaired = false;
      for (const url of issuerUrls) {
        let intermediate;
        try {
          intermediate = await fetchIntermediateCertificate(url, fetchImpl);
        } catch {
          intermediate = null;
        }
        if (!intermediate) continue;
        const reason = refusalReason(leafState.leaf, intermediate, rootsProvider);
        if (reason) {
          if (typeof logInfo === "function") logInfo(`OpenWork runtime: chain repair refused for ${origin}: ${reason}`);
          continue;
        }
        pems.push(intermediate.toString());
        repaired = true;
        if (typeof logInfo === "function") {
          logInfo(`OpenWork runtime: chain repaired for ${origin}: added "${certificateCommonName(intermediate)}"`);
        }
        break;
      }
      if (!repaired && typeof logInfo === "function") {
        logInfo(`OpenWork runtime: chain repair skipped for ${origin}: no usable AIA issuer certificate`);
      }
    }
    return { pems, timedOut: false };
  };

  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ pems: [], timedOut: true }), totalTimeoutMs);
    timeoutId.unref?.();
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * @param {ResolveSystemCaEnvOptions} options
 * @returns {Promise<{ childEnv: NodeJS.ProcessEnv, trustedCertificates: string[] }>}
 */
async function resolveSystemCa({
  tlsModule = tls,
  userDataDir,
  parentEnv = process.env,
  logInfo = console.info,
  loadPlatformCertificates,
  platformSourceName,
  platform = process.platform,
  chainRepair,
}) {
  const env = parentEnv ?? {};
  if (Object.prototype.hasOwnProperty.call(env, "NODE_EXTRA_CA_CERTS")) {
    if (typeof logInfo === "function") {
      logInfo("OpenWork runtime: NODE_EXTRA_CA_CERTS is already set; skipping system CA bundle export.");
    }
    try {
      const configuredPem = await readFile(String(env.NODE_EXTRA_CA_CERTS), "utf8");
      return { childEnv: {}, trustedCertificates: parsePemCertificates(configuredPem) };
    } catch {
      return { childEnv: {}, trustedCertificates: [] };
    }
  }

  try {
    const platformLoader = loadPlatformCertificates
      ? { name: platformSourceName || "platform-stores", load: loadPlatformCertificates }
      : systemPlatformCertificateLoader(platform);
    const bundle = await resolveSystemCaBundle({
      runtime: () => {
        if (typeof tlsModule?.getCACertificates !== "function") return [];
        const certs = tlsModule.getCACertificates("system");
        return Array.isArray(certs) ? certs : [];
      },
      platform: platformLoader,
    });
    if (typeof logInfo === "function") {
      logInfo(`OpenWork runtime: system CA bundle sources ${summarizeSystemCaSources(bundle.sources)}`);
    }
    let repairedPems = [];
    try {
      const repaired = await repairIncompleteChains({
        tlsModule,
        userDataDir,
        parentEnv: env,
        logInfo,
        loadPlatformCertificates,
        platformSourceName,
        platform,
        chainRepair,
      });
      repairedPems = repaired.pems;
      if (repaired.timedOut && typeof logInfo === "function") {
        logInfo("OpenWork runtime: chain repair skipped: timed out");
      }
    } catch {
      repairedPems = [];
    }
    const certificates = dedupeCertificates([...bundle.certificates, ...repairedPems]);
    if (certificates.length === 0) return { childEnv: {}, trustedCertificates: bundle.certificates };
    if (typeof tlsModule?.getCACertificates === "function" && typeof tlsModule?.setDefaultCACertificates === "function") {
      try {
        const defaultCerts = tlsModule.getCACertificates("default");
        tlsModule.setDefaultCACertificates(dedupeCertificates([...(Array.isArray(defaultCerts) ? defaultCerts : []), ...certificates]));
      } catch {
        // Best-effort only; child processes still receive NODE_EXTRA_CA_CERTS.
      }
    }
    const pem = certificates.join("\n");
    if (!pem) return { childEnv: {}, trustedCertificates: bundle.certificates };
    const bundlePath = path.join(userDataDir, "system-ca-bundle.pem");
    await mkdir(path.dirname(bundlePath), { recursive: true });
    await writeFile(bundlePath, `${pem}\n`, "utf8");
    return {
      childEnv: { NODE_EXTRA_CA_CERTS: bundlePath },
      trustedCertificates: bundle.certificates,
    };
  } catch {
    return { childEnv: {}, trustedCertificates: [] };
  }
}

export async function resolveSystemCaEnv(options) {
  return (await resolveSystemCa(options)).childEnv;
}

/**
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {NodeJS.ProcessEnv} [caEnv]
 * @param {NodeJS.ProcessEnv} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function mergeSystemCaChildEnv(baseEnv = {}, caEnv = {}, extra = {}) {
  return {
    ...baseEnv,
    ...(Object.prototype.hasOwnProperty.call(baseEnv, "NODE_EXTRA_CA_CERTS") ? {} : caEnv),
    ...extra,
  };
}

export function createRuntimeManager({
  app,
  desktopRoot,
  listLocalWorkspacePaths,
  localManagedMcpVaultKey,
  workspaceMkdir = mkdir,
  workspacePlatform = process.platform,
}) {
  const inheritedProcessEnv = { ...process.env };
  let injectedUserEnvKeys = new Set();
  const engineState = createEngineState();
  const openworkServerState = createOpenworkServerState();

  // Serialize engine lifecycle operations. Without this, concurrent renderer
  // invocations of engineStart/engineStop/engineRestart race: each call's
  // stopAllRuntimeChildren kills the previous call's freshly-started server,
  // and the prior call then times out its /health probe.
  /** @type {Promise<unknown>} */
  let runtimeLifecycleQueue = Promise.resolve();
  let lifecycleState = "idle";
  /**
   * Serialize engine lifecycle operations; preserves the wrapped function's
   * return type (untyped, this collapsed runtime-manager inference to
   * Promise<void> and blocked tightening the DesktopCommandMap results).
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withRuntimeLifecycle(fn) {
    const next = runtimeLifecycleQueue.then(fn, fn);
    runtimeLifecycleQueue = next.catch(() => {});
    return next;
  }

  const userDataDir = app.getPath("userData");
  const sidecarDirs = [
    path.join(desktopRoot, "resources", "sidecars"),
    process.resourcesPath ? path.join(process.resourcesPath, "sidecars") : null,
    path.join(path.dirname(app.getPath("exe")), "sidecars"),
  ].filter(Boolean);
  let systemCaPromise = null;

  function systemCa() {
    systemCaPromise ??= resolveSystemCa({
      tlsModule: tls,
      userDataDir,
      parentEnv: { ...loadUserEnvFile(process.env), ...process.env },
    });
    return systemCaPromise;
  }

  function openworkServerTokenStorePath() {
    return path.join(userDataDir, "openwork-server-tokens.json");
  }

  function openworkServerStatePath() {
    return path.join(userDataDir, "openwork-server-state.json");
  }

  function managedOpencodeWorkdir() {
    return path.join(userDataDir, "managed-opencode-workdir");
  }

  async function loadTokenStore() {
    const stored = await readJsonFile(openworkServerTokenStorePath(), { version: 1, workspaces: {} });
    const migrated = migrateOpenworkServerTokenStore(stored);
    if (JSON.stringify(stored) !== JSON.stringify(migrated)) {
      await saveTokenStore(migrated);
    }
    return migrated;
  }

  async function saveTokenStore(store) {
    const filePath = openworkServerTokenStorePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  async function loadPortState() {
    return readJsonFile(openworkServerStatePath(), {
      version: 4,
      workspacePorts: {},
      preferredPort: null,
      engineRollover: false,
    });
  }

  async function savePortState(state) {
    const filePath = openworkServerStatePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async function loadServerCredentials() {
    const store = await loadTokenStore();
    return store.credentials;
  }

  async function persistServerOwnerToken(ownerToken) {
    const store = await loadTokenStore();
    store.credentials.ownerToken = ownerToken;
    store.credentials.updatedAt = nowMs();
    await saveTokenStore(store);
  }

  async function readPreferredOpenworkPort(workspaceKey) {
    const state = await loadPortState();
    const normalized = normalizeWorkspaceKey(workspaceKey, workspacePlatform);
    if (normalized && state.workspacePorts?.[normalized]) {
      return state.workspacePorts[normalized];
    }
    return state.preferredPort ?? null;
  }

  async function persistPreferredOpenworkPort(workspaceKey, port) {
    const state = await loadPortState();
    const normalized = normalizeWorkspaceKey(workspaceKey, workspacePlatform);
    state.version = 4;
    state.workspacePorts ??= {};
    if (normalized) {
      state.workspacePorts[normalized] = port;
      state.preferredPort = null;
    } else {
      state.preferredPort = port;
    }
    await savePortState(state);
  }

  async function readEngineRolloverPreference() {
    const state = await loadPortState();
    return state.engineRollover === true;
  }

  async function persistEngineRolloverPreference(enabled) {
    const state = await loadPortState();
    state.version = 4;
    state.engineRollover = enabled === true;
    await savePortState(state);
  }

  async function waitForPortAvailable(host, port, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await portAvailable(host, port)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return portAvailable(host, port);
  }

  async function resolveOpenworkPort(host, workspaceKey, currentPort = null) {
    const preferredPort = await readPreferredOpenworkPort(workspaceKey);
    if (currentPort && (await waitForPortAvailable(host, currentPort))) {
      return { port: currentPort, preferredPort };
    }
    if (preferredPort && (await waitForPortAvailable(host, preferredPort))) {
      return { port: preferredPort, preferredPort };
    }
    return { port: await findFreePort(host), preferredPort };
  }

  async function ensureDevModePaths() {
    const root = path.join(userDataDir, "openwork-dev-data");
    const paths = {
      homeDir: path.join(root, "home"),
      xdgConfigHome: path.join(root, "xdg", "config"),
      xdgDataHome: path.join(root, "xdg", "data"),
      xdgCacheHome: path.join(root, "xdg", "cache"),
      xdgStateHome: path.join(root, "xdg", "state"),
      opencodeConfigDir: path.join(root, "config", "opencode"),
    };

    for (const dir of Object.values(paths)) {
      await mkdir(dir, { recursive: true });
    }
    await mkdir(path.join(paths.xdgDataHome, "opencode"), { recursive: true });
    return paths;
  }

  async function buildChildEnv(extra = {}) {
    /** @type {NodeJS.ProcessEnv} */
    // User env is layered first so process.env + any caller overrides always
    // win. See apps/server/src/env-file.ts — all loaders must agree on path +
    // reserved-keys policy.
    const devPaths = process.env.OPENWORK_DEV_MODE === "1"
      ? await ensureDevModePaths()
      : null;
    const userEnvPathEnv = devPaths
      ? {
          ...process.env,
          HOME: devPaths.homeDir,
          USERPROFILE: devPaths.homeDir,
          XDG_CONFIG_HOME: devPaths.xdgConfigHome,
        }
      : process.env;
    const userEnv = loadUserEnvFile(userEnvPathEnv);
    injectedUserEnvKeys = reconcileInjectedUserEnv({
      processEnv: process.env,
      inheritedEnv: inheritedProcessEnv,
      userEnv,
      previouslyInjectedKeys: injectedUserEnvKeys,
    });
    const baseEnv = {
      ...userEnv,
      ...process.env,
      BUN_CONFIG_DNS_RESULT_ORDER: "verbatim",
    };
    const caEnv = Object.prototype.hasOwnProperty.call(baseEnv, "NODE_EXTRA_CA_CERTS") ? {} : (await systemCa()).childEnv;
    // Bun honors Node's NODE_EXTRA_CA_CERTS, so bundled Bun sidecars inherit
    // the exported OS trust store through the same child env variable.
    const env = mergeSystemCaChildEnv(baseEnv, caEnv, extra);
    const pathKey =
      Object.prototype.hasOwnProperty.call(env, "PATH") ||
      !Object.prototype.hasOwnProperty.call(env, "Path")
        ? "PATH"
        : "Path";
    const pathEnv = enrichedPath(sidecarDirs, env[pathKey]);
    if (pathEnv) {
      env[pathKey] = pathEnv;
    }
    if (devPaths) {
      env.OPENWORK_DEV_MODE = "1";
      env.HOME = devPaths.homeDir;
      env.USERPROFILE = devPaths.homeDir;
      env.XDG_CONFIG_HOME = devPaths.xdgConfigHome;
      env.XDG_DATA_HOME = devPaths.xdgDataHome;
      env.XDG_CACHE_HOME = devPaths.xdgCacheHome;
      env.XDG_STATE_HOME = devPaths.xdgStateHome;
      env.OPENCODE_CONFIG_DIR = devPaths.opencodeConfigDir;
      env.OPENCODE_TEST_HOME = devPaths.homeDir;
    }
    return env;
  }

  function resolveBinaryInfo(baseName, extraPaths = []) {
    for (const directory of [...sidecarDirs, ...extraPaths]) {
      for (const fileName of binaryFileNames(baseName)) {
        const candidate = path.join(directory, fileName);
        if (existsSync(candidate)) {
          return { path: candidate, source: "bundled" };
        }
      }
    }

    const pathEntries = (enrichedPath([], process.env.PATH) ?? "")
      .split(path.delimiter)
      .filter(Boolean);
    for (const entry of pathEntries) {
      for (const fileName of binaryFileNames(baseName)) {
        const candidate = path.join(entry, fileName);
        if (existsSync(candidate)) {
          return { path: candidate, source: "path" };
        }
      }
    }

    if (baseName === "opencode") {
      for (const candidate of [
        path.join(app.getPath("home"), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
        path.join("/opt/homebrew/bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
        path.join("/usr/local/bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
        path.join("/usr/bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
      ]) {
        if (existsSync(candidate)) {
          return { path: candidate, source: "known-location" };
        }
      }
    }

    return null;
  }

  function resolveBinary(baseName, extraPaths = []) {
    return resolveBinaryInfo(baseName, extraPaths)?.path ?? null;
  }

  function resolveOpencodeBinary(opencodeBinPath) {
    const explicitPath = typeof opencodeBinPath === "string" ? opencodeBinPath.trim() : "";
    return explicitPath ? { path: explicitPath, source: "custom" } : resolveBinaryInfo("opencode");
  }

  function resolveDockerCandidates() {
    const candidates = [];
    const seen = new Set();

    for (const key of ["OPENWORK_DOCKER_BIN", "OPENWRK_DOCKER_BIN", "DOCKER_BIN"]) {
      const value = process.env[key]?.trim();
      if (value && !seen.has(value)) {
        seen.add(value);
        candidates.push(value);
      }
    }

    for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(entry, process.platform === "win32" ? "docker.exe" : "docker");
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }

    for (const candidate of [
      "/opt/homebrew/bin/docker",
      "/usr/local/bin/docker",
      "/Applications/Docker.app/Contents/Resources/bin/docker",
    ]) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }

    return candidates.filter((candidate) => existsSync(candidate));
  }

  function runDockerCommandDetailed(args, timeoutMs = 8000) {
    const tried = [...resolveDockerCandidates(), process.platform === "win32" ? "docker.exe" : "docker"];
    const errors = [];

    for (const program of tried) {
      try {
        const result = spawnSync(program, args, {
          encoding: "utf8",
          timeout: timeoutMs,
          windowsHide: true,
        });
        return {
          program,
          status: typeof result.status === "number" ? result.status : -1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(
      `Failed to run docker: ${errors.join("; ")} (Set OPENWORK_DOCKER_BIN to your docker binary if needed)`,
    );
  }

  const legacyOpenworkContainerPrefix = `${["openwork", "orchestrator"].join("-")}-`;

  async function listOpenworkManagedContainers() {
    const result = runDockerCommandDetailed(["ps", "-a", "--format", "{{.Names}}"], 8000);
    if (result.status !== 0) {
      const combined = `${result.stdout.trim()}\n${result.stderr.trim()}`.trim();
      throw new Error(combined || `docker ps -a failed (status ${result.status})`);
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((name) => name && (name.startsWith(legacyOpenworkContainerPrefix) || name.startsWith("openwork-dev-") || name.startsWith("openwrk-")))
      .sort();
  }

  async function runShellCommand(program, args, options = {}) {
    const result = spawnSync(program, args, {
      encoding: "utf8",
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs,
    });
    return {
      status: typeof result.status === "number" ? result.status : -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  function engineDoctor(options = {}) {
    const resolved = resolveOpencodeBinary(options?.opencodeBinPath);
    if (!resolved?.path) {
      return {
        found: false,
        inPath: false,
        resolvedPath: null,
        resolvedSource: null,
        version: null,
        supportsServe: false,
        notes: ["OpenCode binary not found in bundled sidecars or PATH."],
        serveHelpStatus: null,
        serveHelpStdout: null,
        serveHelpStderr: null,
      };
    }

    const versionResult = spawnSync(resolved.path, ["--version"], { encoding: "utf8" });
    const helpResult = spawnSync(resolved.path, ["serve", "--help"], { encoding: "utf8" });
    const notes = [`Using ${resolved.source}: ${resolved.path}`];
    if (versionResult.status !== 0) {
      notes.push("OpenCode version probe failed.");
    }
    if (helpResult.status !== 0) {
      notes.push("OpenCode serve --help probe failed.");
    }

    return {
      found: true,
      inPath: resolved.source === "path",
      resolvedPath: resolved.path,
      resolvedSource: resolved.source,
      version: versionResult.stdout?.trim() || versionResult.stderr?.trim() || null,
      supportsServe: helpResult.status === 0,
      notes,
      serveHelpStatus: typeof helpResult.status === "number" ? helpResult.status : null,
      serveHelpStdout: helpResult.stdout?.trim() || null,
      serveHelpStderr: helpResult.stderr?.trim() || null,
    };
  }

  async function pinnedOpencodeInstallCommand() {
    const constantsPath = path.resolve(desktopRoot, "../../constants.json");
    const payload = JSON.parse(await readFile(constantsPath, "utf8"));
    const version = String(payload?.opencodeVersion ?? "").trim().replace(/^v/, "");
    if (!version) {
      throw new Error("constants.json is missing opencodeVersion");
    }
    return `curl -fsSL https://opencode.ai/install | bash -s -- --version ${version} --no-modify-path`;
  }

  function processMatchesSidecar(command) {
    return commandMatchesPackagedSidecar(command, sidecarDirs);
  }

  function killProcessId(pid, signal = "SIGTERM") {
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return;
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited or is not ours.
    }
  }

  async function cleanupPackagedSidecars() {
    if (!app.isPackaged) return;

    // Safety net: an unclean Electron quit can orphan sidecars. Packaged builds
    // should always own a fresh runtime per app launch, so remove any leftover
    // sidecars from this app bundle before choosing ports for the new runtime.
    const result = spawnSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
    const rows = String(result.stdout ?? "").split(/\r?\n/);
    const pids = [];
    for (const row of rows) {
      const match = row.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2] ?? "";
      if (processMatchesSidecar(command)) pids.push(pid);
    }
    for (const pid of pids) killProcessId(pid, "SIGTERM");
    if (pids.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const pid of pids) killProcessId(pid, "SIGKILL");
    }
  }

  async function stopChild(state, options = {}) {
    const child = state.child;
    state.child = null;
    state.childExited = true;
    if (!child || child.exitCode != null || child.killed) return;

    if (options.requestShutdown) {
      try {
        const shutdownRequested = await options.requestShutdown();
        if (shutdownRequested) {
          await new Promise((resolve) => setTimeout(resolve, 750));
        }
      } catch {
        // ignore
      }
    }

    if (child.exitCode == null && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (child.exitCode == null && !child.killed) {
        child.kill("SIGKILL");
      }
    }
  }

  async function ensureOpencodeConfig(projectDir) {
    const configPath = resolveWorkspaceOpencodeConfigPath(projectDir);
    if (await fileExists(configPath)) return;
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`,
      "utf8",
    );
  }

  async function issueOwnerToken(baseUrl, hostToken) {
    const payload = await fetchJson(
      `${baseUrl.replace(/\/+$/, "")}/tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenWork-Host-Token": hostToken,
        },
        body: JSON.stringify({ scope: "owner", label: "OpenWork desktop owner token" }),
      },
      5000,
    );
    const token = typeof payload?.token === "string" ? payload.token.trim() : "";
    return token || null;
  }

  // In-process server handle. Kept alive across restarts so we can stop it.
  let inProcessServer = null;

  async function startOpenworkServer(options) {
    // The inner start stops any previous runtime before mutating state, so a
    // throw below always happens with nothing left running.
    try {
      const engineRollover = resolveEngineRolloverPreference(
        options.engineRollover,
        await readEngineRolloverPreference(),
      );
      if (typeof options.engineRollover === "boolean") {
        await persistEngineRolloverPreference(engineRollover);
      }
      return await startOpenworkServerInner({ ...options, engineRollover });
    } catch (error) {
      resetRuntimeStatesAfterFailedServerStart(openworkServerState, engineState, options);
      throw error;
    }
  }

  async function startOpenworkServerInner(options) {
    const evalDelayMs = resolveEvalLocalServerDelayMs();
    if (evalDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, evalDelayMs));
    }
    const currentPort = openworkServerState.port;
    // Stop any previously running in-process server
    if (inProcessServer) {
      try { await inProcessServer.stop(); } catch { /* ignore */ }
      inProcessServer = null;
    }
    await stopChild(openworkServerState);

    const host = options.remoteAccessEnabled ? "0.0.0.0" : "127.0.0.1";

    const managedOpencode = options.manageOpencode ? resolveOpencodeBinary(options.opencodeBinPath) : null;
    openworkServerState.managedOpencodeBinPath = managedOpencode?.path ?? null;
    openworkServerState.managedOpencodeBinSource = managedOpencode?.source ?? null;
    if (options.manageOpencode) {
      engineState.opencodeBinPath = managedOpencode?.path ?? null;
      engineState.opencodeBinSource = managedOpencode?.source ?? null;
    }

    // Inject user env vars so the server and managed OpenCode inherit them.
    const serverEnv = await buildChildEnv({});
    Object.assign(process.env, serverEnv);

    // Once the embedded server has a persisted registry, it is the source of
    // truth. Do not pass Electron's legacy workspace list as CLI workspaces or
    // the server config loader will ignore server.json and lose server-created
    // workspaces after restart.
    const serverConfigPath = resolveOpenworkServerConfigPath(process.env);
    const requestedWorkspacePaths = prioritizeWorkspacePaths("", options.workspacePaths, {
      platform: workspacePlatform,
    });
    const workspacePaths = seedWorkspacePathsForEmbeddedServer(
      requestedWorkspacePaths,
      existsSync(serverConfigPath),
    );
    const activeWorkspace = selectStickyOpenworkPortWorkspace(requestedWorkspacePaths, workspacePaths);
    const portSelection = await resolveOpenworkPort(host, activeWorkspace, currentPort);
    const tokens = await loadServerCredentials();

    // One call: resolve config, spawn managed OpenCode, start HTTP server.
    // Dev must prefer apps/server/dist; build output also stages a packaged
    // copy under apps/desktop/server for electron-builder.
    const devPath = path.resolve(__runtimeDir, "..", "..", "server", "dist", "embedded.js");
    const packagedPaths = [
      path.resolve(__runtimeDir, "..", "server", "dist", "embedded.js"),
      ...(process.resourcesPath ? [path.resolve(process.resourcesPath, "server", "dist", "embedded.js")] : []),
    ];
    const candidates = process.env.OPENWORK_DEV_MODE === "1"
      ? [devPath, ...packagedPaths]
      : [...packagedPaths, devPath];
    const embeddedPath = candidates.find((candidate) => existsSync(candidate));
    if (!embeddedPath) {
      throw new Error(`Cannot find OpenWork embedded server bundle. Checked: ${candidates.join(", ")}`);
    }
    const { startEmbeddedServer } = await import(embeddedServerImportUrl(embeddedPath));
    // startEmbeddedServer falls back to an OS-assigned port if `port` races
    // into EADDRINUSE (see apps/server/src/serve-node.ts), so the bound port
    // below is authoritative.
    const handle = await startEmbeddedServer({
      host,
      port: portSelection.port,
      corsOrigins: ["*"],
      approvalMode: "auto",
      configPath: serverConfigPath,
      workspaces: workspacePaths,
      token: tokens.clientToken,
      hostToken: tokens.hostToken,
      opencodeBaseUrl: options.opencodeBaseUrl ?? undefined,
      opencodeDirectory: activeWorkspace || undefined,
      manageOpencode: options.manageOpencode === true,
      opencodeBin: managedOpencode?.path ?? undefined,
      opencodeCwd: managedOpencodeWorkdir(),
      localManagedMcpVaultKey,
      engineRollover: options.engineRollover === true,
    });
    inProcessServer = handle;
    openworkServerState.managedOpencodeExecution = handle.managedOpencodeExecution ?? null;
    engineState.managedByServer = Boolean(handle.managedOpencode);
    engineState.managedPid = handle.managedOpencode?.pid ?? null;
    engineState.managedIsAlive = handle.managedOpencode?.isAlive ?? null;

    const boundPort = handle.port;
    const baseUrl = handle.url;

    openworkServerState.inProcess = true;
    openworkServerState.engineRollover = options.engineRollover === true;
    openworkServerState.remoteAccessEnabled = options.remoteAccessEnabled;
    openworkServerState.host = host;
    openworkServerState.port = boundPort;
    openworkServerState.baseUrl = baseUrl;
    openworkServerState.clientToken = tokens.clientToken;
    openworkServerState.hostToken = tokens.hostToken;

    const connectUrls = options.remoteAccessEnabled ? buildConnectUrls(boundPort) : { connectUrl: null, mdnsUrl: null, lanUrl: null };
    openworkServerState.connectUrl = connectUrls.connectUrl;
    openworkServerState.mdnsUrl = connectUrls.mdnsUrl;
    openworkServerState.lanUrl = connectUrls.lanUrl;

    // No health check needed -- startServer() resolves only after the listener is bound.
    let workspaceList = null;
    let ownerToken = tokens.ownerToken?.trim() || null;
    if (ownerToken) {
      try {
        workspaceList = await fetchJson(`${baseUrl}/workspaces`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        }, 5000);
      } catch {
        ownerToken = null;
      }
    }
    ownerToken ||= await issueOwnerToken(baseUrl, tokens.hostToken);
    openworkServerState.ownerToken = ownerToken;
    if (ownerToken) {
      await persistServerOwnerToken(ownerToken);
    }
    if (ownerToken) {
      try {
        const list = workspaceList ?? await fetchJson(`${baseUrl}/workspaces`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        }, 5000);
        const first = Array.isArray(list?.items) ? list.items[0] : undefined;
        const opencode = first?.opencode;
        if (opencode?.baseUrl) {
          engineState.runtime = DIRECT_RUNTIME;
          engineState.projectDir = opencode.directory ?? activeWorkspace ?? null;
          engineState.hostname = new URL(opencode.baseUrl).hostname;
          engineState.port = Number(new URL(opencode.baseUrl).port) || null;
          engineState.baseUrl = opencode.baseUrl;
          engineState.opencodeUsername = opencode.username ?? null;
          engineState.opencodePassword = opencode.password ?? null;
          engineState.execution = handle.managedOpencodeExecution ?? null;
          engineState.child = null;
          engineState.childExited = false;
        }
      } catch (error) {
        appendOutput(openworkServerState, "lastStderr", `OpenWork server workspace probe: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (!portSelection.preferredPort || boundPort === portSelection.preferredPort) {
      await persistPreferredOpenworkPort(activeWorkspace, boundPort);
    }
    return snapshotOpenworkServerState(openworkServerState);
  }

  async function stopAllRuntimeChildren() {
    // Stop the in-process server (and its managed OpenCode child) if running.
    if (inProcessServer) {
      try { await inProcessServer.stop(); } catch { /* ignore */ }
      inProcessServer = null;
    }
    await stopChild(openworkServerState);
    await stopChild(engineState);

    Object.assign(engineState, createEngineState());
    Object.assign(openworkServerState, createOpenworkServerState());
  }

  async function prepareFreshRuntime() {
    lifecycleState = "cleaning";
    await stopAllRuntimeChildren();
    await cleanupPackagedSidecars();
    lifecycleState = "idle";
  }

  function settleAfterWorkspacePreparationFailure() {
    if (snapshotOpenworkServerState(openworkServerState).running) {
      lifecycleState = "healthy";
      return;
    }
    Object.assign(engineState, createEngineState());
    Object.assign(openworkServerState, createOpenworkServerState());
    lifecycleState = "idle";
  }

  async function ensureOpenwork(options) {
    let openworkServer;
    try {
      openworkServer = await startOpenworkServer({
        workspacePaths: options.workspacePaths,
        opencodeBaseUrl: engineState.baseUrl,
        opencodeUsername: engineState.opencodeUsername,
        opencodePassword: engineState.opencodePassword,
        remoteAccessEnabled: options.remoteAccessEnabled,
        manageOpencode: options.manageOpencode === true,
        opencodeBinPath: options.opencodeBinPath,
        engineRollover: options.engineRollover,
      });
    } catch (error) {
      appendOutput(engineState, "lastStderr", `OpenWork server: ${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
    }

    assertOpenworkServerReady(openworkServer);
  }

  async function engineStart(projectDir, options = {}) {
    const rawProjectDir = String(projectDir ?? "").trim();
    if (!rawProjectDir) {
      throw new Error("projectDir is required");
    }
    let safeProjectDir;
    try {
      safeProjectDir = normalizeWorkspaceRootPath(rawProjectDir, { platform: workspacePlatform });
    } catch (error) {
      settleAfterWorkspacePreparationFailure();
      throw workspaceInaccessibleError(rawProjectDir, error);
    }

    // Reuse a healthy server instead of tearing it down. During boot the
    // main process kicks off bootRuntimeForSelectedWorkspace while renderer
    // routes independently call ensureDesktopLocalOpenworkConnection. Both go
    // through this serialized path; without this guard the second call runs
    // prepareFreshRuntime (killing the freshly bound server) and then rebinds
    // the sticky preferred port, racing the not-yet-released socket into
    // EADDRINUSE and leaving the runtime in error -> boot screen.
    const requestedRemoteAccess = options.openworkRemoteAccess === true;
    const requestedEngineRollover = resolveEngineRolloverPreference(
      options.engineRollover,
      await readEngineRolloverPreference(),
    );
    if (
      options.forceRestart !== true &&
      openworkServerState.inProcess &&
      lifecycleState === "healthy" &&
      normalizeWorkspaceKey(engineState.projectDir, workspacePlatform) === normalizeWorkspaceKey(safeProjectDir, workspacePlatform) &&
      openworkServerState.remoteAccessEnabled === requestedRemoteAccess &&
      openworkServerState.engineRollover === requestedEngineRollover
    ) {
      const existing = snapshotOpenworkServerState(openworkServerState);
      if (existing.running && existing.baseUrl && (existing.ownerToken || existing.clientToken)) {
        return snapshotEngineState(engineState);
      }
    }

    lifecycleState = "starting";
    try {
      safeProjectDir = await prepareRuntimeWorkspaceRoot(safeProjectDir, {
        platform: workspacePlatform,
        mkdirImpl: workspaceMkdir,
        ensureConfig: ensureOpencodeConfig,
      });
    } catch (error) {
      settleAfterWorkspacePreparationFailure();
      throw error;
    }
    await prepareFreshRuntime();

    const workspacePaths = prioritizeWorkspacePaths(safeProjectDir, options.workspacePaths, {
      platform: workspacePlatform,
    });
    const runtime = DIRECT_RUNTIME;

    try {
      lifecycleState = "starting";
      engineState.runtime = runtime;
      engineState.projectDir = safeProjectDir;
      engineState.child = null;
      engineState.childExited = true;

      await ensureOpenwork({
        projectDir: safeProjectDir,
        workspacePaths,
        remoteAccessEnabled: options.openworkRemoteAccess === true,
        manageOpencode: true,
        opencodeBinPath: options.opencodeBinPath,
        engineRollover: requestedEngineRollover,
      });

      lifecycleState = "healthy";
      return snapshotEngineState(engineState);
    } catch (error) {
      lifecycleState = "error";
      throw error;
    }
  }

  async function engineStop() {
    lifecycleState = "stopping";
    await stopAllRuntimeChildren();
    lifecycleState = "idle";
    return snapshotEngineState(engineState);
  }

  async function engineRestart(options = {}) {
    const projectDir = engineState.projectDir;
    if (!projectDir) {
      throw new Error("OpenCode is not configured for a local workspace");
    }
    const openworkRemoteAccess = typeof options.openworkRemoteAccess === "boolean"
      ? options.openworkRemoteAccess
      : openworkServerState.remoteAccessEnabled;
    return engineStart(projectDir, {
      runtime: engineState.runtime,
      workspacePaths: [projectDir],
      opencodeEnableExa: options.opencodeEnableExa,
      openworkRemoteAccess,
      ...(typeof options.engineRollover === "boolean"
        ? { engineRollover: options.engineRollover }
        : {}),
      forceRestart: true,
    });
  }

  async function engineInfo() {
    if (inProcessServer?.managedOpencode) {
      engineState.managedPid = inProcessServer.managedOpencode.pid ?? null;
    }
    return { ...snapshotEngineState(engineState), lifecycleState };
  }

  async function runtimeStatus() {
    return {
      lifecycleState,
      engine: await engineInfo(),
      enginePool: inProcessServer?.managedOpencodePool?.() ?? null,
      openworkServer: snapshotOpenworkServerState(openworkServerState),
    };
  }

  async function openworkServerInfo() {
    return snapshotOpenworkServerState(openworkServerState);
  }

  async function openworkServerRestart(options = {}) {
    const workspacePaths = prioritizeWorkspacePaths(engineState.projectDir, await listLocalWorkspacePaths(), {
      platform: workspacePlatform,
    });
    const shouldManageOpencode = Boolean(
      openworkServerState.managedOpencodeBinPath || engineState.opencodeBinPath || !engineState.baseUrl,
    );
    return startOpenworkServer({
      workspacePaths,
      opencodeBaseUrl: shouldManageOpencode ? null : engineState.baseUrl,
      opencodeUsername: shouldManageOpencode ? null : engineState.opencodeUsername,
      opencodePassword: shouldManageOpencode ? null : engineState.opencodePassword,
      remoteAccessEnabled: options.remoteAccessEnabled === true,
      manageOpencode: shouldManageOpencode,
      opencodeBinPath: engineState.opencodeBinPath ?? openworkServerState.managedOpencodeBinPath,
    });
  }

  async function engineInstall() {
    if (process.platform === "win32") {
      return {
        ok: false,
        status: -1,
        stdout: "",
        stderr:
          "Guided install is not supported on Windows yet. Install the OpenWork-pinned OpenCode version manually, then restart OpenWork.",
      };
    }

    const installDir = path.join(app.getPath("home"), ".opencode", "bin");
    const command = await pinnedOpencodeInstallCommand();
    const result = await runShellCommand("bash", ["-lc", command], {
      env: { ...(await buildChildEnv()), OPENCODE_INSTALL_DIR: installDir },
      timeoutMs: 180_000,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async function opencodeMcpAuth(projectDir, serverName) {
    const safeProjectDir = String(projectDir ?? "").trim();
    const safeServerName = String(serverName ?? "").trim();
    if (!safeProjectDir) {
      throw new Error("project_dir is required");
    }
    if (!safeServerName) {
      throw new Error("server_name is required");
    }

    const program = resolveBinary("opencode");
    if (!program) {
      throw new Error("Failed to locate opencode.");
    }

    const result = await runShellCommand(program, ["mcp", "auth", safeServerName], {
      cwd: safeProjectDir,
      env: await buildChildEnv(),
      timeoutMs: 120_000,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async function sandboxCleanupOpenworkContainers() {
    const candidates = await listOpenworkManagedContainers().catch((error) => {
      throw error;
    });
    const removed = [];
    const errors = [];

    for (const name of candidates) {
      try {
        const result = runDockerCommandDetailed(["rm", "-f", name], 20_000);
        if (result.status === 0) {
          removed.push(name);
        } else {
          errors.push(`${name}: exit ${result.status}: ${(result.stdout + "\n" + result.stderr).trim()}`);
        }
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { candidates, removed, errors };
  }

  return {
    systemCaCertificates: async () => (await systemCa()).trustedCertificates,
    engineStart: (projectDir, options) => withRuntimeLifecycle(() => engineStart(projectDir, options)),
    engineStop: () => withRuntimeLifecycle(() => engineStop()),
    engineRestart: (options) => withRuntimeLifecycle(() => engineRestart(options)),
    prepareFreshRuntime: () => withRuntimeLifecycle(() => prepareFreshRuntime()),
    dispose: () => withRuntimeLifecycle(() => stopAllRuntimeChildren()),
    runtimeStatus,
    engineInfo,
    engineDoctor,
    engineInstall,
    openworkServerInfo,
    openworkServerRestart: (options) => withRuntimeLifecycle(() => openworkServerRestart(options)),
    opencodeMcpAuth,
    sandboxCleanupOpenworkContainers,
  };
}
