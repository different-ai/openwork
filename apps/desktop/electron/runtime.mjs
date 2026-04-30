import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DIRECT_RUNTIME = "direct";
const ORCHESTRATOR_RUNTIME = "openwork-orchestrator";
const OPENWORK_SERVER_PORT_RANGE_START = 48_000;
const OPENWORK_SERVER_PORT_RANGE_END = 51_000;

function truncateOutput(value, limit = 8000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function appendOutput(state, key, chunk) {
  const next = `${state[key] ?? ""}${String(chunk ?? "")}`;
  state[key] = truncateOutput(next);
}

function normalizeWorkspaceKey(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return path.resolve(trimmed).replace(/\\/g, "/").toLowerCase();
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
    lastStdout: null,
    lastStderr: null,
  };
}

function snapshotEngineState(state) {
  const child = state.childExited ? null : state.child;
  return {
    running: Boolean(child && child.exitCode === null && !child.killed),
    runtime: state.runtime,
    baseUrl: state.baseUrl,
    projectDir: state.projectDir,
    hostname: state.hostname,
    port: state.port,
    opencodeUsername: state.opencodeUsername,
    opencodePassword: state.opencodePassword,
    pid: child?.pid ?? null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
  };
}

function createOpenworkServerState() {
  return {
    child: null,
    childExited: true,
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
    lastStdout: null,
    lastStderr: null,
  };
}

function snapshotOpenworkServerState(state) {
  const child = state.childExited ? null : state.child;
  return {
    running: Boolean(child && child.exitCode === null && !child.killed),
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
    pid: child?.pid ?? null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
  };
}

function createOrchestratorState() {
  return {
    child: null,
    childExited: true,
    dataDir: null,
    baseUrl: null,
    daemonPort: null,
    lastStdout: null,
    lastStderr: null,
  };
}

function createRouterState() {
  return {
    child: null,
    childExited: true,
    version: null,
    workspacePath: null,
    opencodeUrl: null,
    healthPort: null,
    lastStdout: null,
    lastStderr: null,
  };
}

function snapshotRouterState(state) {
  const child = state.childExited ? null : state.child;
  return {
    running: Boolean(child && child.exitCode === null && !child.killed),
    version: state.version,
    workspacePath: state.workspacePath,
    opencodeUrl: state.opencodeUrl,
    healthPort: state.healthPort,
    pid: child?.pid ?? null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
  };
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
    `${baseName}${ext}`,
    triple ? `${baseName}-${triple}${ext}` : null,
  ].filter(Boolean);
}

function prependedPath(sidecarDirs) {
  const filtered = sidecarDirs.filter((dir) => existsSync(dir));
  if (filtered.length === 0) return null;
  return `${filtered.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ""}`;
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

async function waitForHttpOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Request did not succeed.";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(lastError);
}

async function fetchJson(url, options = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
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

export function createRuntimeManager({ app, desktopRoot, listLocalWorkspacePaths }) {
  const engineState = createEngineState();
  const openworkServerState = createOpenworkServerState();
  const orchestratorState = createOrchestratorState();
  const routerState = createRouterState();

  // Serialize engine lifecycle operations. Without this, concurrent renderer
  // invocations of engineStart/engineStop/engineRestart race: each call's
  // stopAllRuntimeChildren kills the previous call's freshly-spawned
  // orchestrator daemon, and the prior call then times out its /health probe.
  let runtimeLifecycleQueue = Promise.resolve();
  let lifecycleState = "idle";
  function withRuntimeLifecycle(fn) {
    const next = runtimeLifecycleQueue.then(fn, fn);
    runtimeLifecycleQueue = next.catch(() => {});
    return next;
  }

  const userDataDir = app.getPath("userData");
  const sidecarDirs = [
    path.join(desktopRoot, "src-tauri", "sidecars"),
    process.resourcesPath ? path.join(process.resourcesPath, "sidecars") : null,
    path.join(path.dirname(app.getPath("exe")), "sidecars"),
  ].filter(Boolean);

  function openworkServerTokenStorePath() {
    return path.join(userDataDir, "openwork-server-tokens.json");
  }

  function openworkServerStatePath() {
    return path.join(userDataDir, "openwork-server-state.json");
  }

  function orchestratorDataDir() {
    const envDir = process.env.OPENWORK_DATA_DIR?.trim();
    if (envDir) return envDir;
    return path.join(app.getPath("home"), ".openwork", "openwork-orchestrator");
  }

  function orchestratorStatePath(dataDir) {
    return path.join(dataDir, "openwork-orchestrator-state.json");
  }

  function orchestratorAuthPath(dataDir) {
    return path.join(dataDir, "openwork-orchestrator-auth.json");
  }

  async function readOrchestratorStateFile(dataDir) {
    return readJsonFile(orchestratorStatePath(dataDir), null);
  }

  async function readOrchestratorAuthFile(dataDir) {
    return readJsonFile(orchestratorAuthPath(dataDir), null);
  }

  async function writeOrchestratorAuthFile(dataDir, auth) {
    const filePath = orchestratorAuthPath(dataDir);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify({ ...auth, updatedAt: nowMs() }, null, 2)}\n`, "utf8");
  }

  async function clearOrchestratorAuthFile(dataDir) {
    await rm(orchestratorAuthPath(dataDir), { force: true });
  }

  async function requestOrchestratorShutdown(dataDir) {
    const state = await readOrchestratorStateFile(dataDir);
    const baseUrl = state?.daemon?.baseUrl?.trim();
    if (!baseUrl) return false;
    try {
      await fetch(`${baseUrl.replace(/\/+$/, "")}/shutdown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      return true;
    } catch {
      return false;
    }
  }

  async function loadTokenStore() {
    return readJsonFile(openworkServerTokenStorePath(), { version: 1, workspaces: {} });
  }

  async function saveTokenStore(store) {
    const filePath = openworkServerTokenStorePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  async function loadPortState() {
    return readJsonFile(openworkServerStatePath(), {
      version: 3,
      workspacePorts: {},
      preferredPort: null,
    });
  }

  async function savePortState(state) {
    const filePath = openworkServerStatePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async function loadOrCreateWorkspaceTokens(workspaceKey) {
    const store = await loadTokenStore();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    if (store.workspaces?.[normalized]) {
      return store.workspaces[normalized];
    }
    const next = {
      clientToken: randomUUID(),
      hostToken: randomUUID(),
      ownerToken: null,
      updatedAt: nowMs(),
    };
    store.workspaces ??= {};
    store.workspaces[normalized] = next;
    await saveTokenStore(store);
    return next;
  }

  async function persistWorkspaceOwnerToken(workspaceKey, ownerToken) {
    const store = await loadTokenStore();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    if (!store.workspaces?.[normalized]) return;
    store.workspaces[normalized].ownerToken = ownerToken;
    store.workspaces[normalized].updatedAt = nowMs();
    await saveTokenStore(store);
  }

  async function readPreferredOpenworkPort(workspaceKey) {
    const state = await loadPortState();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    if (normalized && state.workspacePorts?.[normalized]) {
      return state.workspacePorts[normalized];
    }
    return state.preferredPort ?? null;
  }

  async function persistPreferredOpenworkPort(workspaceKey, port) {
    const state = await loadPortState();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    state.version = 3;
    state.workspacePorts ??= {};
    if (normalized) {
      state.workspacePorts[normalized] = port;
      state.preferredPort = null;
    } else {
      state.preferredPort = port;
    }
    await savePortState(state);
  }

  async function resolveOpenworkPort(host, workspaceKey) {
    // Use a fresh port every boot. Persisted preferred ports made prod starts
    // fragile when an old sidecar held the previous port or shutdown was
    // unclean; Electron publishes the chosen URL to React after boot.
    return findFreePort(host);
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
    const env = { ...process.env, BUN_CONFIG_DNS_RESULT_ORDER: "verbatim", ...extra };
    const pathEnv = prependedPath(sidecarDirs);
    if (pathEnv) {
      env.PATH = pathEnv;
    }
    if (process.env.OPENWORK_DEV_MODE === "1") {
      const devPaths = await ensureDevModePaths();
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

  function resolveBinary(baseName, extraPaths = []) {
    for (const directory of [...sidecarDirs, ...extraPaths]) {
      for (const fileName of binaryFileNames(baseName)) {
        const candidate = path.join(directory, fileName);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }

    const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const entry of pathEntries) {
      for (const fileName of binaryFileNames(baseName)) {
        const candidate = path.join(entry, fileName);
        if (existsSync(candidate)) {
          return candidate;
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
          return candidate;
        }
      }
    }

    return null;
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

  function parseDockerClientVersion(stdout) {
    const line = String(stdout ?? "").split(/\r?\n/)[0]?.trim() ?? "";
    return line.toLowerCase().startsWith("docker version") ? line : null;
  }

  function parseDockerServerVersion(stdout) {
    for (const line of String(stdout ?? "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("Server Version:")) {
        return trimmed.slice("Server Version:".length).trim() || null;
      }
    }
    return null;
  }

  function deriveOrchestratorContainerName(runId) {
    const sanitized = String(runId ?? "")
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .slice(0, 24);
    return `openwork-orchestrator-${sanitized}`;
  }

  async function listOpenworkManagedContainers() {
    const result = runDockerCommandDetailed(["ps", "-a", "--format", "{{.Names}}"], 8000);
    if (result.status !== 0) {
      const combined = `${result.stdout.trim()}\n${result.stderr.trim()}`.trim();
      throw new Error(combined || `docker ps -a failed (status ${result.status})`);
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((name) => name && (name.startsWith("openwork-orchestrator-") || name.startsWith("openwork-dev-") || name.startsWith("openwrk-")))
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

  async function pinnedOpencodeInstallCommand() {
    const constantsPath = path.resolve(desktopRoot, "../../constants.json");
    const payload = JSON.parse(await readFile(constantsPath, "utf8"));
    const version = String(payload?.opencodeVersion ?? "").trim().replace(/^v/, "");
    if (!version) {
      throw new Error("constants.json is missing opencodeVersion");
    }
    return `curl -fsSL https://opencode.ai/install | bash -s -- --version ${version} --no-modify-path`;
  }

  function spawnManagedChild(state, program, args, options = {}) {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    state.child = child;
    state.childExited = false;
    state.lastStdout = null;
    state.lastStderr = null;

    child.stdout?.on("data", (chunk) => appendOutput(state, "lastStdout", chunk.toString()));
    child.stderr?.on("data", (chunk) => appendOutput(state, "lastStderr", chunk.toString()));
    child.on("exit", (code) => {
      state.childExited = true;
      if (code != null && code !== 0) {
        appendOutput(state, "lastStderr", `Process exited with code ${code}.\n`);
      }
      options.onExit?.(code);
    });
    child.on("error", (error) => {
      state.childExited = true;
      appendOutput(state, "lastStderr", `${error instanceof Error ? error.message : String(error)}\n`);
    });

    return child;
  }

  function processMatchesSidecar(command) {
    const value = String(command ?? "");
    return sidecarDirs.some((dir) => value.includes(dir)) &&
      (
        value.includes("openwork-orchestrator") ||
        value.includes("openwork-server") ||
        value.includes("opencode serve") ||
        value.includes("opencode-router")
      );
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

    // First ask the previously recorded orchestrator daemon to shut itself and
    // its OpenCode child down. This handles the happy path without relying on
    // process-list parsing.
    await requestOrchestratorShutdown(orchestratorState.dataDir || orchestratorDataDir()).catch(() => false);
    await new Promise((resolve) => setTimeout(resolve, 300));

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
    const configPath = path.join(projectDir, "opencode.json");
    if (await fileExists(configPath)) return;
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`,
      "utf8",
    );
  }

  function generateManagedCredentials() {
    return [randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")];
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

  async function startOpenworkServer(options) {
    await stopChild(openworkServerState);

    const workspacePaths = options.workspacePaths.filter((value) => value.trim().length > 0);
    const activeWorkspace = workspacePaths[0] ?? "";
    const host = options.remoteAccessEnabled ? "0.0.0.0" : "127.0.0.1";
    const port = await resolveOpenworkPort(host, activeWorkspace);
    const baseUrl = `http://127.0.0.1:${port}`;
    const tokens = await loadOrCreateWorkspaceTokens(activeWorkspace);
    const program = resolveBinary("openwork-server");
    if (!program) {
      throw new Error("Failed to locate openwork-server.");
    }

    const args = [
      "--host",
      host,
      "--port",
      String(port),
      "--cors",
      "*",
      "--approval",
      "auto",
      ...workspacePaths.flatMap((workspacePath) => ["--workspace", workspacePath]),
      ...(options.opencodeBaseUrl ? ["--opencode-base-url", options.opencodeBaseUrl] : []),
      ...(activeWorkspace ? ["--opencode-directory", activeWorkspace] : []),
    ];

    const env = await buildChildEnv({
      OPENWORK_TOKEN: tokens.clientToken,
      OPENWORK_HOST_TOKEN: tokens.hostToken,
      ...(options.manageOpencode ? { OPENWORK_MANAGE_OPENCODE: "1" } : {}),
      ...(options.manageOpencode ? { OPENWORK_OPENCODE_BIN: options.opencodeBinPath || resolveBinary("opencode") || "" } : {}),
      ...(options.routerHealthPort ? { OPENCODE_ROUTER_HEALTH_PORT: String(options.routerHealthPort) } : {}),
      ...(options.opencodeUsername ? { OPENWORK_OPENCODE_USERNAME: options.opencodeUsername } : {}),
      ...(options.opencodePassword ? { OPENWORK_OPENCODE_PASSWORD: options.opencodePassword } : {}),
    });

    spawnManagedChild(openworkServerState, program, args, {
      cwd: activeWorkspace || desktopRoot,
      env,
    });

    openworkServerState.remoteAccessEnabled = options.remoteAccessEnabled;
    openworkServerState.host = host;
    openworkServerState.port = port;
    openworkServerState.baseUrl = baseUrl;
    openworkServerState.clientToken = tokens.clientToken;
    openworkServerState.hostToken = tokens.hostToken;

    const connectUrls = options.remoteAccessEnabled ? buildConnectUrls(port) : { connectUrl: null, mdnsUrl: null, lanUrl: null };
    openworkServerState.connectUrl = connectUrls.connectUrl;
    openworkServerState.mdnsUrl = connectUrls.mdnsUrl;
    openworkServerState.lanUrl = connectUrls.lanUrl;

    await waitForHttpOk(`${baseUrl}/health`, 10_000);
    // Owner tokens live in the OpenWork server token store, which can be reset
    // independently from the desktop runtime token cache. Always mint a fresh
    // owner token for the newly-started server instead of trusting the cached
    // value; otherwise the renderer can receive a stale bearer token and all
    // workspace calls fail with 401.
    const ownerToken = await issueOwnerToken(baseUrl, tokens.hostToken);
    openworkServerState.ownerToken = ownerToken;
    if (ownerToken) {
      await persistWorkspaceOwnerToken(activeWorkspace, ownerToken);
    }
    if (ownerToken) {
      try {
        const list = await fetchJson(`${baseUrl}/workspaces`, {
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
          engineState.child = null;
          engineState.childExited = false;
        }
      } catch (error) {
        appendOutput(openworkServerState, "lastStderr", `OpenWork server workspace probe: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    await persistPreferredOpenworkPort(activeWorkspace, port);
    return snapshotOpenworkServerState(openworkServerState);
  }

  async function resolveRouterHealthPort() {
    return findFreePort("127.0.0.1");
  }

  async function startRouter(options) {
    await stopChild(routerState);
    const healthPort = options.healthPort ?? (await resolveRouterHealthPort());
    const program = resolveBinary("opencode-router");
    if (!program) {
      throw new Error("Failed to locate opencode-router.");
    }

    const env = await buildChildEnv({
      OPENCODE_ROUTER_HEALTH_PORT: String(healthPort),
      ...(options.opencodeUsername ? { OPENCODE_SERVER_USERNAME: options.opencodeUsername } : {}),
      ...(options.opencodePassword ? { OPENCODE_SERVER_PASSWORD: options.opencodePassword } : {}),
    });

    const args = [
      "serve",
      options.workspacePath,
      ...(options.opencodeUrl ? ["--opencode-url", options.opencodeUrl] : []),
    ];

    spawnManagedChild(routerState, program, args, {
      cwd: options.workspacePath,
      env,
    });

    routerState.workspacePath = options.workspacePath;
    routerState.opencodeUrl = options.opencodeUrl ?? null;
    routerState.healthPort = healthPort;

    try {
      const version = runProgram(program, ["--version"]);
      routerState.version = version.stdout?.trim() || version.stderr?.trim() || null;
    } catch {
      routerState.version = null;
    }

    await waitForHttpOk(`http://127.0.0.1:${healthPort}/health`, 5000).catch(() => undefined);
    return snapshotRouterState(routerState);
  }

  async function resolveOrchestratorBaseUrl() {
    if (orchestratorState.baseUrl) {
      return orchestratorState.baseUrl;
    }
    const stateFile = await readOrchestratorStateFile(orchestratorState.dataDir || orchestratorDataDir());
    const baseUrl = stateFile?.daemon?.baseUrl?.trim();
    if (!baseUrl) {
      throw new Error("orchestrator daemon is not running");
    }
    return baseUrl;
  }

  async function startOrchestratorRuntime(projectDir, options = {}) {
    const dataDir = orchestratorDataDir();
    await mkdir(dataDir, { recursive: true });
    const daemonPort = await findFreePort("127.0.0.1");
    const opencodePort = await findFreePort("127.0.0.1");
    const [username, password] = generateManagedCredentials();

    const orchestratorProgram = resolveBinary("openwork-orchestrator") ?? resolveBinary("openwork");
    if (!orchestratorProgram) {
      throw new Error("Failed to locate openwork-orchestrator.");
    }

    const opencodeProgram = (typeof options.opencodeBinPath === "string" && options.opencodeBinPath.trim())
      ? options.opencodeBinPath.trim()
      : resolveBinary("opencode");
    if (!opencodeProgram) {
      throw new Error("Failed to locate opencode.");
    }

    const env = await buildChildEnv({
      OPENWORK_INTERNAL_ALLOW_OPENCODE_CREDENTIALS: "1",
      OPENWORK_OPENCODE_USERNAME: username,
      OPENWORK_OPENCODE_PASSWORD: password,
      ...(options.opencodeEnableExa === true ? { OPENCODE_ENABLE_EXA: "1" } : {}),
    });

    const args = [
      "daemon",
      "run",
      "--data-dir",
      dataDir,
      "--daemon-host",
      "127.0.0.1",
      "--daemon-port",
      String(daemonPort),
      "--opencode-bin",
      opencodeProgram,
      "--opencode-host",
      "127.0.0.1",
      "--opencode-workdir",
      projectDir,
      "--opencode-port",
      String(opencodePort),
      "--allow-external",
      "--cors",
      "*",
    ];

    spawnManagedChild(orchestratorState, orchestratorProgram, args, { env });
    orchestratorState.dataDir = dataDir;
    orchestratorState.daemonPort = daemonPort;
    orchestratorState.baseUrl = `http://127.0.0.1:${daemonPort}`;

    await writeOrchestratorAuthFile(dataDir, {
      opencodeUsername: username,
      opencodePassword: password,
      projectDir,
    });

    const health = await waitForHttpOk(`${orchestratorState.baseUrl}/health`, 180_000).then((response) => response.json());
    const opencode = health?.opencode;
    if (!opencode?.port) {
      throw new Error("Orchestrator did not report OpenCode status.");
    }

    engineState.runtime = ORCHESTRATOR_RUNTIME;
    engineState.projectDir = projectDir;
    engineState.hostname = "127.0.0.1";
    engineState.port = opencode.port;
    engineState.baseUrl = `http://127.0.0.1:${opencode.port}`;
    engineState.opencodeUsername = username;
    engineState.opencodePassword = password;

    return snapshotEngineState(engineState);
  }

  async function startDirectRuntime(projectDir, options = {}) {
    const opencodeProgram = (typeof options.opencodeBinPath === "string" && options.opencodeBinPath.trim())
      ? options.opencodeBinPath.trim()
      : resolveBinary("opencode");
    if (!opencodeProgram) {
      throw new Error("Failed to locate opencode.");
    }

    const port = await findFreePort("127.0.0.1");
    const [username, password] = generateManagedCredentials();
    const env = await buildChildEnv({
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    });

    spawnManagedChild(
      engineState,
      opencodeProgram,
      ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--cors", "*"],
      {
        cwd: projectDir,
        env,
      },
    );

    engineState.runtime = DIRECT_RUNTIME;
    engineState.projectDir = projectDir;
    engineState.hostname = "127.0.0.1";
    engineState.port = port;
    engineState.baseUrl = `http://127.0.0.1:${port}`;
    engineState.opencodeUsername = username;
    engineState.opencodePassword = password;

    await waitForHttpOk(`${engineState.baseUrl}/health`, 10_000).catch(() => undefined);
    return snapshotEngineState(engineState);
  }

  async function stopAllRuntimeChildren() {
    await stopChild(routerState);
    await stopChild(openworkServerState);
    await stopChild(orchestratorState, {
      requestShutdown: () => requestOrchestratorShutdown(orchestratorState.dataDir || orchestratorDataDir()),
    });
    await clearOrchestratorAuthFile(orchestratorState.dataDir || orchestratorDataDir()).catch(() => undefined);
    await stopChild(engineState);

    Object.assign(engineState, createEngineState());
    Object.assign(openworkServerState, createOpenworkServerState());
    Object.assign(orchestratorState, createOrchestratorState());
    Object.assign(routerState, createRouterState());
  }

  async function prepareFreshRuntime() {
    lifecycleState = "cleaning";
    await stopAllRuntimeChildren();
    await cleanupPackagedSidecars();
    lifecycleState = "idle";
  }

  async function ensureRouterAndOpenwork(options) {
    const routerHealthPort = await resolveRouterHealthPort().catch(() => null);
    try {
      await startOpenworkServer({
        workspacePaths: options.workspacePaths,
        opencodeBaseUrl: engineState.baseUrl,
        opencodeUsername: engineState.opencodeUsername,
        opencodePassword: engineState.opencodePassword,
        routerHealthPort,
        remoteAccessEnabled: options.remoteAccessEnabled,
        manageOpencode: options.manageOpencode === true,
        opencodeBinPath: options.opencodeBinPath,
      });
    } catch (error) {
      appendOutput(engineState, "lastStderr", `OpenWork server: ${error instanceof Error ? error.message : String(error)}\n`);
    }

    if (options.projectDir && engineState.baseUrl) {
      try {
        await startRouter({
          workspacePath: options.projectDir,
          opencodeUrl: engineState.baseUrl,
          opencodeUsername: engineState.opencodeUsername,
          opencodePassword: engineState.opencodePassword,
          healthPort: routerHealthPort,
        });
      } catch (error) {
        appendOutput(engineState, "lastStderr", `OpenCodeRouter: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  async function engineStart(projectDir, options = {}) {
    const safeProjectDir = String(projectDir ?? "").trim();
    if (!safeProjectDir) {
      throw new Error("projectDir is required");
    }
    await mkdir(safeProjectDir, { recursive: true });
    await ensureOpencodeConfig(safeProjectDir);
    await prepareFreshRuntime();

    const workspacePaths = [safeProjectDir, ...((options.workspacePaths ?? []).filter(Boolean))].filter(
      (value, index, list) => list.indexOf(value) === index,
    );
    const runtime = DIRECT_RUNTIME;

    try {
      lifecycleState = "starting";
      engineState.runtime = runtime;
      engineState.projectDir = safeProjectDir;
      engineState.child = null;
      engineState.childExited = true;

      await ensureRouterAndOpenwork({
        projectDir: safeProjectDir,
        workspacePaths,
        remoteAccessEnabled: options.openworkRemoteAccess === true,
        manageOpencode: true,
        opencodeBinPath: options.opencodeBinPath,
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
    return engineStart(projectDir, {
      runtime: engineState.runtime,
      workspacePaths: [projectDir],
      opencodeEnableExa: options.opencodeEnableExa,
      openworkRemoteAccess: options.openworkRemoteAccess,
    });
  }

  async function engineInfo() {
    return { ...snapshotEngineState(engineState), lifecycleState };
  }

  async function runtimeStatus() {
    return {
      lifecycleState,
      engine: await engineInfo(),
      openworkServer: snapshotOpenworkServerState(openworkServerState),
      router: snapshotRouterState(routerState),
    };
  }

  async function openworkServerInfo() {
    return snapshotOpenworkServerState(openworkServerState);
  }

  async function openworkServerRestart(options = {}) {
    const workspacePaths = (await listLocalWorkspacePaths()).filter(Boolean);
    return startOpenworkServer({
      workspacePaths,
      opencodeBaseUrl: engineState.baseUrl,
      opencodeUsername: engineState.opencodeUsername,
      opencodePassword: engineState.opencodePassword,
      routerHealthPort: routerState.healthPort,
      remoteAccessEnabled: options.remoteAccessEnabled === true,
    });
  }

  async function orchestratorStatus() {
    const engine = snapshotEngineState(engineState);
    const openworkServer = snapshotOpenworkServerState(openworkServerState);
    const workspaces = engine.projectDir
      ? [{ id: normalizeWorkspaceKey(engine.projectDir), path: engine.projectDir, name: path.basename(engine.projectDir) || "Workspace" }]
      : [];
    return {
      running: engine.running,
      dataDir: null,
      daemon: openworkServer.running
        ? { baseUrl: openworkServer.baseUrl, port: openworkServer.port, pid: openworkServer.pid, runtime: "direct" }
        : null,
      opencode: engine.running
        ? { baseUrl: engine.baseUrl, port: engine.port, pid: engine.pid, projectDir: engine.projectDir, runtime: "direct" }
        : null,
      cliVersion: null,
      sidecar: null,
      binaries: null,
      activeId: workspaces[0]?.id ?? null,
      workspaceCount: workspaces.length,
      workspaces,
      lastError: engine.lastStderr,
    };
  }

  async function orchestratorWorkspaceActivate(input) {
    const workspacePath = String(input?.workspacePath ?? "").trim();
    if (!workspacePath) {
      throw new Error("workspacePath is required");
    }
    const resolved = path.resolve(workspacePath);
    if (normalizeWorkspaceKey(engineState.projectDir) !== normalizeWorkspaceKey(resolved)) {
      await engineStart(resolved, {
        runtime: DIRECT_RUNTIME,
        workspacePaths: [resolved],
      });
    }
    return {
      id: normalizeWorkspaceKey(resolved),
      path: resolved,
      name: input?.name ?? (path.basename(resolved) || "Workspace"),
    };
  }

  async function orchestratorInstanceDispose(workspacePath) {
    if (normalizeWorkspaceKey(engineState.projectDir) === normalizeWorkspaceKey(workspacePath)) {
      return true;
    }
    return true;
  }

  async function opencodeRouterInfo() {
    return snapshotRouterState(routerState);
  }

  async function opencodeRouterStart(options) {
    return startRouter(options);
  }

  async function opencodeRouterStop() {
    await stopChild(routerState);
    Object.assign(routerState, createRouterState());
    return snapshotRouterState(routerState);
  }

  async function opencodeRouterRestart(options) {
    return opencodeRouterStart(options);
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

  async function sandboxDoctor() {
    const candidates = resolveDockerCandidates();
    const debug = {
      candidates,
      selectedBin: null,
      versionCommand: null,
      infoCommand: null,
    };

    let version;
    try {
      version = runDockerCommandDetailed(["--version"], 2000);
    } catch (error) {
      return {
        installed: false,
        daemonRunning: false,
        permissionOk: false,
        ready: false,
        clientVersion: null,
        serverVersion: null,
        error: error instanceof Error ? error.message : String(error),
        debug,
      };
    }

    debug.selectedBin = version.program;
    debug.versionCommand = {
      status: version.status,
      stdout: truncateOutput(version.stdout, 1200),
      stderr: truncateOutput(version.stderr, 1200),
    };

    const clientVersion = parseDockerClientVersion(version.stdout);
    if (version.status !== 0) {
      return {
        installed: false,
        daemonRunning: false,
        permissionOk: false,
        ready: false,
        clientVersion: null,
        serverVersion: null,
        error: `docker --version failed (status ${version.status}): ${version.stderr.trim()}`,
        debug,
      };
    }

    let info;
    try {
      info = runDockerCommandDetailed(["info"], 8000);
    } catch (error) {
      return {
        installed: true,
        daemonRunning: false,
        permissionOk: false,
        ready: false,
        clientVersion,
        serverVersion: null,
        error: error instanceof Error ? error.message : String(error),
        debug,
      };
    }

    debug.infoCommand = {
      status: info.status,
      stdout: truncateOutput(info.stdout, 1200),
      stderr: truncateOutput(info.stderr, 1200),
    };

    if (info.status === 0) {
      return {
        installed: true,
        daemonRunning: true,
        permissionOk: true,
        ready: true,
        clientVersion,
        serverVersion: parseDockerServerVersion(info.stdout),
        error: null,
        debug,
      };
    }

    const combined = `${info.stdout.trim()}\n${info.stderr.trim()}`.trim().toLowerCase();
    const permissionOk = !combined.includes("permission denied") && !combined.includes("access is denied");
    const daemonRunning = !combined.includes("cannot connect to the docker daemon") && !combined.includes("is the docker daemon running") && !combined.includes("connection refused") && !combined.includes("no such file or directory");

    return {
      installed: true,
      daemonRunning,
      permissionOk,
      ready: false,
      clientVersion,
      serverVersion: null,
      error: `${info.stdout.trim()}\n${info.stderr.trim()}`.trim() || `docker info failed (status ${info.status})`,
      debug,
    };
  }

  async function sandboxStop(containerName) {
    const name = String(containerName ?? "").trim();
    if (!name) {
      throw new Error("containerName is required");
    }
    if (!name.startsWith("openwork-orchestrator-")) {
      throw new Error("Refusing to stop container: expected name starting with 'openwork-orchestrator-'");
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error("containerName contains invalid characters");
    }
    const result = runDockerCommandDetailed(["stop", name], 15_000);
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

  async function orchestratorStartDetached(options = {}) {
    const workspacePath = String(options.workspacePath ?? "").trim();
    if (!workspacePath) {
      throw new Error("workspacePath is required");
    }

    const sandboxBackend = String(options.sandboxBackend ?? "none").trim().toLowerCase();
    if (!["none", "docker", "microsandbox"].includes(sandboxBackend)) {
      throw new Error("sandboxBackend must be one of: none, docker, microsandbox");
    }

    const wantsDockerSandbox = sandboxBackend === "docker" || sandboxBackend === "microsandbox";
    const runId = String(options.runId ?? randomUUID()).trim();
    const containerName = wantsDockerSandbox ? deriveOrchestratorContainerName(runId) : null;
    const port = await findFreePort("127.0.0.1");
    const token = String(options.openworkToken ?? randomUUID()).trim();
    const hostToken = String(options.openworkHostToken ?? randomUUID()).trim();
    const openworkUrl = `http://127.0.0.1:${port}`;
    const program = resolveBinary("openwork-orchestrator") ?? resolveBinary("openwork");
    if (!program) {
      throw new Error("Failed to locate openwork orchestrator.");
    }

    const args = [
      "start",
      "--workspace",
      workspacePath,
      "--approval",
      "auto",
      "--opencode-router",
      "true",
      "--detach",
      "--openwork-port",
      String(port),
      "--run-id",
      runId,
      ...(wantsDockerSandbox ? ["--sandbox", "docker"] : []),
      ...(options.sandboxImageRef ? ["--sandbox-image", String(options.sandboxImageRef)] : []),
    ];

    const child = spawn(program, args, {
      env: { ...(await buildChildEnv()), OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    await waitForHttpOk(`${openworkUrl}/health`, wantsDockerSandbox ? 90_000 : 12_000);
    const ownerToken = await issueOwnerToken(openworkUrl, hostToken).catch(() => null);

    return {
      openworkUrl,
      token,
      ownerToken,
      hostToken,
      port,
      sandboxBackend: wantsDockerSandbox ? sandboxBackend : null,
      sandboxRunId: wantsDockerSandbox ? runId : null,
      sandboxContainerName: containerName,
    };
  }

  async function sandboxDebugProbe() {
    const startedAt = nowMs();
    const runId = `probe-${randomUUID()}`;
    const workspacePath = path.join(os.tmpdir(), `openwork-sandbox-probe-${randomUUID()}`);
    await mkdir(workspacePath, { recursive: true });

    const doctor = await sandboxDoctor();
    let detachedHost = null;
    let dockerInspect = null;
    let dockerLogs = null;
    let error = null;
    const cleanupErrors = [];
    let containerRemoved = false;
    let workspaceRemoved = false;
    let removeResult = null;

    if (doctor.ready) {
      try {
        detachedHost = await orchestratorStartDetached({
          workspacePath,
          sandboxBackend: "docker",
          runId,
        });
        const containerName = detachedHost.sandboxContainerName ?? deriveOrchestratorContainerName(runId);
        try {
          const inspectResult = runDockerCommandDetailed(["inspect", containerName], 6000);
          dockerInspect = {
            status: inspectResult.status,
            stdout: truncateOutput(inspectResult.stdout, 48000),
            stderr: truncateOutput(inspectResult.stderr, 48000),
          };
        } catch (inspectError) {
          cleanupErrors.push(`docker inspect failed: ${inspectError instanceof Error ? inspectError.message : String(inspectError)}`);
        }
        try {
          const logsResult = runDockerCommandDetailed(["logs", "--timestamps", "--tail", "400", containerName], 8000);
          dockerLogs = {
            status: logsResult.status,
            stdout: truncateOutput(logsResult.stdout, 48000),
            stderr: truncateOutput(logsResult.stderr, 48000),
          };
        } catch (logsError) {
          cleanupErrors.push(`docker logs failed: ${logsError instanceof Error ? logsError.message : String(logsError)}`);
        }

        try {
          const rmResult = runDockerCommandDetailed(["rm", "-f", containerName], 20_000);
          containerRemoved = rmResult.status === 0;
          removeResult = {
            status: rmResult.status,
            stdout: truncateOutput(rmResult.stdout, 48000),
            stderr: truncateOutput(rmResult.stderr, 48000),
          };
        } catch (removeError) {
          cleanupErrors.push(`docker rm -f ${containerName} failed: ${removeError instanceof Error ? removeError.message : String(removeError)}`);
        }
      } catch (probeError) {
        error = `Sandbox probe failed to start: ${probeError instanceof Error ? probeError.message : String(probeError)}`;
      }
    } else {
      error = doctor.error ?? "Docker is not ready for sandbox creation";
    }

    try {
      await rm(workspacePath, { recursive: true, force: true });
      workspaceRemoved = true;
    } catch (workspaceError) {
      cleanupErrors.push(`Failed to remove probe workspace: ${workspaceError instanceof Error ? workspaceError.message : String(workspaceError)}`);
    }

    return {
      startedAt,
      finishedAt: nowMs(),
      runId,
      workspacePath,
      ready: doctor.ready && !error,
      doctor,
      detachedHost,
      dockerInspect,
      dockerLogs,
      cleanup: {
        containerName: detachedHost?.sandboxContainerName ?? null,
        containerRemoved,
        removeResult,
        workspaceRemoved,
        errors: cleanupErrors,
      },
      error,
    };
  }

  return {
    engineStart: (projectDir, options) => withRuntimeLifecycle(() => engineStart(projectDir, options)),
    engineStop: () => withRuntimeLifecycle(() => engineStop()),
    engineRestart: (options) => withRuntimeLifecycle(() => engineRestart(options)),
    prepareFreshRuntime: () => withRuntimeLifecycle(() => prepareFreshRuntime()),
    dispose: () => withRuntimeLifecycle(() => stopAllRuntimeChildren()),
    runtimeStatus,
    engineInfo,
    engineInstall,
    openworkServerInfo,
    openworkServerRestart,
    orchestratorStatus,
    orchestratorWorkspaceActivate,
    orchestratorInstanceDispose,
    orchestratorStartDetached,
    opencodeRouterInfo,
    opencodeRouterStart,
    opencodeRouterStop,
    opencodeRouterRestart,
    opencodeMcpAuth,
    sandboxDoctor,
    sandboxStop,
    sandboxCleanupOpenworkContainers,
    sandboxDebugProbe,
  };
}
