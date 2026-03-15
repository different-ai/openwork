import { app, ipcMain } from "electron";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { EngineDoctorResult, EngineInfo, ExecResult } from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";

type EngineRuntimeMode = EngineInfo["runtime"];
type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

type EngineStartInput = {
  projectDir: string;
  preferSidecar?: boolean;
  runtime?: EngineRuntimeMode;
  workspacePaths?: string[];
  opencodeBinPath?: string | null;
};

type EngineState = {
  runtime: EngineRuntimeMode;
  child: ManagedChild | null;
  childExited: boolean;
  projectDir: string | null;
  hostname: string | null;
  port: number | null;
  baseUrl: string | null;
  opencodeUsername: string | null;
  opencodePassword: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
  startInput: EngineStartInput | null;
  orchestratorDataDir: string | null;
  runToken: number;
};

type OrchestratorHealth = {
  ok: boolean;
  opencode?: {
    pid: number;
    port: number;
    baseUrl: string;
    startedAt: number;
  } | null;
};

type OrchestratorStateFile = {
  daemon?: {
    baseUrl: string;
  } | null;
};

type SpawnedChild = {
  child: ManagedChild;
  token: number;
};

function defaultEngineState(): EngineState {
  return {
    runtime: "direct",
    child: null,
    childExited: true,
    projectDir: null,
    hostname: null,
    port: null,
    baseUrl: null,
    opencodeUsername: null,
    opencodePassword: null,
    pid: null,
    lastStdout: null,
    lastStderr: null,
    startInput: null,
    orchestratorDataDir: null,
    runToken: 0,
  };
}

function envTruthy(key: string) {
  const value = process.env[key]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function opencodeExecutableName() {
  return process.platform === "win32" ? "opencode.exe" : "opencode";
}

function opencodeCmdName() {
  return process.platform === "win32" ? "opencode.cmd" : "opencode";
}

function orchestratorSidecarName() {
  return process.platform === "win32" ? "openwork-orchestrator.exe" : "openwork-orchestrator";
}

function orchestratorCliName() {
  return process.platform === "win32" ? "openwork.exe" : "openwork";
}

function truncateOutput(value: string, max = 8000) {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max)}...`;
}

function appendOutput(current: string | null, chunk: string) {
  return truncateOutput(`${current ?? ""}${chunk}`);
}

function bunEnvOverrides() {
  const overrides: Record<string, string> = {
    BUN_CONFIG_DNS_RESULT_ORDER: "verbatim",
  };

  const sanitize = (raw: string) => {
    const tokens = raw.split(/\s+/).filter(Boolean);
    const kept: string[] = [];
    let changed = false;

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token) continue;

      const inline = token.startsWith("--dns-result-order=")
        ? token.slice("--dns-result-order=".length)
        : null;
      if (inline !== null) {
        if (inline === "ipv4first" || inline === "verbatim") {
          kept.push(token);
        } else {
          changed = true;
        }
        continue;
      }

      if (token === "--dns-result-order") {
        const next = tokens[index + 1];
        if (next === "ipv4first" || next === "verbatim") {
          kept.push(token, next);
        } else {
          changed = true;
        }
        index += 1;
        continue;
      }

      kept.push(token);
    }

    return changed ? kept.join(" ") : null;
  };

  for (const key of ["BUN_OPTIONS", "NODE_OPTIONS"] as const) {
    const value = process.env[key];
    if (!value) {
      continue;
    }

    const sanitized = sanitize(value);
    if (sanitized) {
      overrides[key] = sanitized;
    }
  }

  return overrides;
}

function commonToolPaths() {
  const home = os.homedir();
  const paths: string[] = [];

  if (process.platform === "darwin") {
    paths.push("/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin");
    paths.push(
      path.join(home, ".nvm", "current", "bin"),
      path.join(home, ".fnm", "current", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, "Library", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".pyenv", "shims"),
      path.join(home, ".local", "bin"),
    );
  } else if (process.platform === "linux") {
    paths.push("/usr/local/bin", "/usr/local/sbin");
    paths.push(
      path.join(home, ".nvm", "current", "bin"),
      path.join(home, ".fnm", "current", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".local", "share", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".pyenv", "shims"),
      path.join(home, ".local", "bin"),
    );
  } else {
    paths.push(path.join(home, ".volta", "bin"), path.join(home, ".bun", "bin"), path.join(home, ".cargo", "bin"));
    if (process.env.LOCALAPPDATA) {
      paths.push(path.join(process.env.LOCALAPPDATA, "pnpm"));
    }
    if (process.env.APPDATA) {
      paths.push(path.join(process.env.APPDATA, "npm"));
    }
  }

  return paths.filter((entry) => existsSync(entry));
}

function sourceSidecarDir() {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "../../src-tauri/sidecars");
}

function sidecarDirectoryCandidates() {
  return [
    path.dirname(process.execPath),
    process.resourcesPath ? path.join(process.resourcesPath, "sidecars") : null,
    process.resourcesPath || null,
    sourceSidecarDir(),
  ].filter((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));
}

function pathEnvWithPrefixes(prefixes: string[] = []) {
  const entries = [...prefixes, ...commonToolPaths(), ...(process.env.PATH?.split(path.delimiter) ?? [])];
  return Array.from(new Set(entries.filter(Boolean))).join(path.delimiter);
}

function execCapture(command: string, args: string[]) {
  return new Promise<{ ok: boolean; status: number | null; stdout: string | null; stderr: string | null }>((resolve) => {
    execFile(
      command,
      args,
      {
        env: {
          ...process.env,
          ...bunEnvOverrides(),
          PATH: pathEnvWithPrefixes(sidecarDirectoryCandidates()),
        },
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          status:
            typeof (error as { code?: unknown } | null)?.code === "number"
              ? Number((error as { code: number }).code)
              : 0,
          stdout: stdout?.trim() ? truncateOutput(stdout.trim(), 4000) : null,
          stderr: stderr?.trim() ? truncateOutput(stderr.trim(), 4000) : null,
        });
      },
    );
  });
}

function resolveInPath(name: string) {
  const pathEntries = pathEnvWithPrefixes(sidecarDirectoryCandidates()).split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function candidateOpencodePaths() {
  const home = os.homedir();
  const candidates = [path.join(home, ".opencode", "bin", opencodeExecutableName())];
  if (process.platform === "win32") {
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, "npm", opencodeExecutableName()));
      candidates.push(path.join(process.env.APPDATA, "npm", opencodeCmdName()));
    }
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, "npm", opencodeExecutableName()));
      candidates.push(path.join(process.env.LOCALAPPDATA, "npm", opencodeCmdName()));
      candidates.push(path.join(process.env.LOCALAPPDATA, "OpenCode", opencodeExecutableName()));
    }
    candidates.push(path.join(home, "scoop", "shims", opencodeExecutableName()));
    candidates.push(path.join(home, "scoop", "shims", opencodeCmdName()));
    candidates.push(path.join("C:\\ProgramData\\chocolatey\\bin", opencodeExecutableName()));
    candidates.push(path.join("C:\\ProgramData\\chocolatey\\bin", opencodeCmdName()));
  } else {
    candidates.push(path.join("/opt/homebrew/bin", opencodeExecutableName()));
    candidates.push(path.join("/usr/local/bin", opencodeExecutableName()));
    candidates.push(path.join("/usr/bin", opencodeExecutableName()));
  }
  return candidates;
}

function resolveSidecarCandidate(preferSidecar: boolean) {
  if (!preferSidecar) {
    return { resolved: null as string | null, notes: [] as string[] };
  }

  const candidates = sidecarDirectoryCandidates().map((directory) => path.join(directory, opencodeExecutableName()));
  const notes: string[] = [];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      notes.push(`Using bundled sidecar: ${candidate}`);
      return { resolved: candidate, notes };
    }
    notes.push(`Sidecar missing: ${candidate}`);
  }

  return { resolved: null, notes };
}

function resolveEnginePath(preferSidecar: boolean, opencodeBinPath?: string | null) {
  const notes: string[] = [];
  const customPath = opencodeBinPath?.trim() || process.env.OPENCODE_BIN_PATH?.trim();
  if (customPath) {
    if (existsSync(customPath)) {
      notes.push(`Using OPENCODE_BIN_PATH: ${customPath}`);
      return { resolved: customPath, inPath: false, notes };
    }
    notes.push(`OPENCODE_BIN_PATH set but missing: ${customPath}`);
  }

  const sidecar = resolveSidecarCandidate(preferSidecar);
  notes.push(...sidecar.notes);
  if (sidecar.resolved) {
    return { resolved: sidecar.resolved, inPath: false, notes };
  }

  const inPath =
    resolveInPath(opencodeExecutableName()) ||
    (process.platform === "win32" ? resolveInPath(opencodeCmdName()) : null);
  if (inPath) {
    notes.push(`Found in PATH: ${inPath}`);
    return { resolved: inPath, inPath: true, notes };
  }
  notes.push("Not found on PATH");

  for (const candidate of candidateOpencodePaths()) {
    if (existsSync(candidate)) {
      notes.push(`Found at ${candidate}`);
      return { resolved: candidate, inPath: false, notes };
    }
    notes.push(`Missing: ${candidate}`);
  }

  return { resolved: null, inPath: false, notes };
}

function resolveOrchestratorBinary() {
  const sidecarCandidates = sidecarDirectoryCandidates().map((directory) => path.join(directory, orchestratorSidecarName()));
  for (const candidate of sidecarCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return resolveInPath(orchestratorCliName()) || resolveInPath(orchestratorSidecarName()) || orchestratorCliName();
}

function buildEngineArgs(bindHost: string, port: number) {
  return ["serve", "--hostname", bindHost, "--port", String(port), "--cors", "*"];
}

async function findFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to determine free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function stableWorkspaceSlug(projectDir: string) {
  return `ws-${createHash("sha1").update(projectDir).digest("hex").slice(0, 16)}`;
}

function resolveDevModePaths(projectDir: string) {
  const rootDir = path.join(app.getPath("userData"), "opencode-dev", stableWorkspaceSlug(projectDir));
  return {
    homeDir: path.join(rootDir, "home"),
    xdgConfigHome: path.join(rootDir, "xdg", "config"),
    xdgDataHome: path.join(rootDir, "xdg", "data"),
    xdgCacheHome: path.join(rootDir, "xdg", "cache"),
    xdgStateHome: path.join(rootDir, "xdg", "state"),
    opencodeConfigDir: path.join(rootDir, "config", "opencode"),
  };
}

async function ensureDevModePaths(projectDir: string) {
  const paths = resolveDevModePaths(projectDir);
  for (const dir of [
    paths.homeDir,
    paths.xdgConfigHome,
    paths.xdgDataHome,
    paths.xdgCacheHome,
    paths.xdgStateHome,
    paths.opencodeConfigDir,
    path.join(paths.xdgDataHome, "opencode"),
  ]) {
    await mkdir(dir, { recursive: true });
  }
  return paths;
}

function resolveProjectConfigPath(projectDir: string) {
  const jsoncPath = path.join(projectDir, "opencode.jsonc");
  const jsonPath = path.join(projectDir, "opencode.json");
  if (existsSync(jsoncPath)) {
    return jsoncPath;
  }
  if (existsSync(jsonPath)) {
    return jsonPath;
  }
  return jsoncPath;
}

async function ensureProjectConfig(projectDir: string) {
  const resolvedPath = resolveProjectConfigPath(projectDir);
  if (existsSync(resolvedPath)) {
    return;
  }

  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(
    resolvedPath,
    `${JSON.stringify({ "$schema": "https://opencode.ai/config.json" }, null, 2)}\n`,
    "utf8",
  );
}

function resolveOrchestratorDataDir() {
  const configured = process.env.OPENWORK_DATA_DIR?.trim();
  if (configured) {
    return configured;
  }

  return path.join(os.homedir(), ".openwork", "openwork-orchestrator");
}

function orchestratorStatePath(dataDir: string) {
  return path.join(dataDir, "openwork-orchestrator-state.json");
}

function orchestratorAuthPath(dataDir: string) {
  return path.join(dataDir, "openwork-orchestrator-auth.json");
}

function writeOrchestratorAuth(dataDir: string, username: string | null, password: string | null, projectDir: string | null) {
  const target = orchestratorAuthPath(dataDir);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify(
      {
        opencodeUsername: username,
        opencodePassword: password,
        projectDir,
        updatedAt: Date.now(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function clearOrchestratorAuth(dataDir: string | null) {
  if (!dataDir) {
    return;
  }

  rmSync(orchestratorAuthPath(dataDir), { force: true });
}

function readOrchestratorState(dataDir: string) {
  try {
    return JSON.parse(readFileSync(orchestratorStatePath(dataDir), "utf8")) as OrchestratorStateFile;
  } catch {
    return null;
  }
}

async function requestOrchestratorShutdown(dataDir: string) {
  const state = readOrchestratorState(dataDir);
  const baseUrl = state?.daemon?.baseUrl?.trim();
  if (!baseUrl) {
    return false;
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/shutdown`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: "",
  });
  if (!response.ok) {
    throw new Error(`Failed to request orchestrator shutdown at ${baseUrl}: ${response.status}`);
  }
  return true;
}

async function waitForOrchestrator(baseUrl: string, timeoutMs: number) {
  const startedAt = Date.now();
  let lastError = "Timed out waiting for orchestrator";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
        headers: { Accept: "application/json" },
      });
      if (response.ok) {
        const payload = (await response.json()) as OrchestratorHealth;
        if (payload.ok) {
          return payload;
        }
        lastError = "Orchestrator reported unhealthy";
      } else {
        lastError = `Health check failed with status ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(lastError);
}

function buildSpawnEnv(projectDir: string, devMode: boolean, extraEnv: Record<string, string> = {}) {
  const sidecarDirs = sidecarDirectoryCandidates();
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    ...bunEnvOverrides(),
    PATH: pathEnvWithPrefixes(sidecarDirs),
    OPENCODE_CLIENT: "openwork",
    OPENWORK: "1",
    ...extraEnv,
  };

  if (devMode) {
    const paths = resolveDevModePaths(projectDir);
    env.OPENWORK_DEV_MODE = "1";
    env.HOME = paths.homeDir;
    env.XDG_CONFIG_HOME = paths.xdgConfigHome;
    env.XDG_DATA_HOME = paths.xdgDataHome;
    env.XDG_CACHE_HOME = paths.xdgCacheHome;
    env.XDG_STATE_HOME = paths.xdgStateHome;
    env.OPENCODE_CONFIG_DIR = paths.opencodeConfigDir;
  }

  return env;
}

function snapshotState(state: EngineState): EngineInfo {
  const running = Boolean(state.child) && !state.childExited;
  return {
    running,
    runtime: state.runtime,
    baseUrl: state.baseUrl,
    projectDir: state.projectDir,
    hostname: state.hostname,
    port: state.port,
    opencodeUsername: state.opencodeUsername,
    opencodePassword: state.opencodePassword,
    pid: running ? state.pid : null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
  };
}

function resetState(state: EngineState) {
  const runToken = state.runToken;
  Object.assign(state, { ...defaultEngineState(), runToken });
}

function attachChild(state: EngineState, child: ManagedChild) {
  state.runToken += 1;
  const token = state.runToken;
  state.child = child;
  state.childExited = false;

  child.stdout.on("data", (chunk: Buffer | string) => {
    if (state.runToken !== token) {
      return;
    }
    state.lastStdout = appendOutput(state.lastStdout, chunk.toString());
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    if (state.runToken !== token) {
      return;
    }
    state.lastStderr = appendOutput(state.lastStderr, chunk.toString());
  });

  const markExited = () => {
    if (state.runToken !== token) {
      return;
    }
    state.childExited = true;
  };

  child.on("exit", markExited);
  child.on("error", (error) => {
    if (state.runToken !== token) {
      return;
    }
    state.lastStderr = appendOutput(state.lastStderr, error.message);
    state.childExited = true;
  });

  return { child, token } satisfies SpawnedChild;
}

async function waitForWarmup(state: EngineState, spawned: SpawnedChild) {
  const buildImmediateExitError = (exitCode?: number | null) => {
    const parts: string[] = [];
    if (state.lastStdout?.trim()) {
      parts.push(`stdout:\n${state.lastStdout.trim()}`);
    }
    if (state.lastStderr?.trim()) {
      parts.push(`stderr:\n${state.lastStderr.trim()}`);
    }
    const suffix = parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
    return new Error(`OpenCode exited immediately with status ${exitCode ?? -1}.${suffix}`);
  };

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, 2000);

    const cleanup = () => {
      clearTimeout(timeout);
      spawned.child.removeListener("exit", onExit);
      spawned.child.removeListener("error", onError);
    };

    const onExit = (code: number | null) => {
      if (state.runToken !== spawned.token) {
        cleanup();
        resolve();
        return;
      }

      cleanup();
      reject(buildImmediateExitError(code));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    spawned.child.once("exit", onExit);
    spawned.child.once("error", onError);
  });
}

export function createEngineService() {
  const state = defaultEngineState();

  const stopCurrentProcess = async (graceful: boolean) => {
    const currentChild = state.child;
    const runtime = state.runtime;
    const dataDir = state.orchestratorDataDir;

    state.runToken += 1;
    state.child = null;
    state.childExited = true;

    if (runtime === "openwork-orchestrator" && dataDir) {
      try {
        if (graceful) {
          await requestOrchestratorShutdown(dataDir);
        }
      } catch (error) {
        state.lastStderr = appendOutput(state.lastStderr, error instanceof Error ? error.message : String(error));
      }
      clearOrchestratorAuth(dataDir);
    }

    if (currentChild && !currentChild.killed) {
      currentChild.kill();
    }
  };

  const ensureDirectProcess = async (input: EngineStartInput) => {
    const preferSidecar = input.preferSidecar ?? false;
    const resolution = resolveEnginePath(preferSidecar, input.opencodeBinPath ?? null);
    const program = resolution.resolved;
    if (!program) {
      throw new Error(
        `OpenCode CLI not found.\n\nInstall with:\n- brew install anomalyco/tap/opencode\n- curl -fsSL https://opencode.ai/install | bash\n\nNotes:\n${resolution.notes.join("\n")}`,
      );
    }

    const bindHost = process.env.OPENWORK_OPENCODE_BIND_HOST?.trim() || "0.0.0.0";
    const clientHost = "127.0.0.1";
    const port = await findFreePort();
    const devMode = envTruthy("OPENWORK_DEV_MODE") || !app.isPackaged;
    const enableAuth = process.env.OPENWORK_OPENCODE_AUTH
      ? envTruthy("OPENWORK_OPENCODE_AUTH")
      : true;
    const opencodeUsername = enableAuth ? "opencode" : null;
    const opencodePassword = enableAuth ? randomUUID() : null;

    if (devMode) {
      await ensureDevModePaths(input.projectDir);
    }

    const child = spawn(program, buildEngineArgs(bindHost, port), {
      cwd: input.projectDir,
      env: buildSpawnEnv(input.projectDir, devMode, {
        ...(opencodeUsername ? { OPENCODE_SERVER_USERNAME: opencodeUsername } : {}),
        ...(opencodePassword ? { OPENCODE_SERVER_PASSWORD: opencodePassword } : {}),
      }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const spawned = attachChild(state, child);
    state.runtime = "direct";
    state.projectDir = input.projectDir;
    state.hostname = clientHost;
    state.port = port;
    state.baseUrl = `http://${clientHost}:${port}`;
    state.opencodeUsername = opencodeUsername;
    state.opencodePassword = opencodePassword;
    state.pid = child.pid ?? null;
    state.startInput = {
      ...input,
      runtime: "direct",
      preferSidecar,
      opencodeBinPath: input.opencodeBinPath ?? null,
      workspacePaths: input.workspacePaths ?? [input.projectDir],
    };
    state.orchestratorDataDir = null;

    await waitForWarmup(state, spawned);
    return snapshotState(state);
  };

  const ensureOrchestratorProcess = async (input: EngineStartInput) => {
    const preferSidecar = input.preferSidecar ?? false;
    const resolution = resolveEnginePath(preferSidecar, input.opencodeBinPath ?? null);
    const opencodeBin = resolution.resolved;
    if (!opencodeBin) {
      throw new Error(
        `OpenCode CLI not found.\n\nInstall with:\n- brew install anomalyco/tap/opencode\n- curl -fsSL https://opencode.ai/install | bash\n\nNotes:\n${resolution.notes.join("\n")}`,
      );
    }

    const daemonHost = "127.0.0.1";
    const daemonPort = await findFreePort();
    const opencodePort = await findFreePort();
    const bindHost = process.env.OPENWORK_OPENCODE_BIND_HOST?.trim() || "0.0.0.0";
    const opencodeUsername = "opencode";
    const opencodePassword = randomUUID();
    const dataDir = resolveOrchestratorDataDir();
    const command = resolveOrchestratorBinary();
    const args = [
      "daemon",
      "run",
      "--data-dir",
      dataDir,
      "--daemon-host",
      daemonHost,
      "--daemon-port",
      String(daemonPort),
      "--opencode-bin",
      opencodeBin,
      "--opencode-host",
      bindHost,
      "--opencode-workdir",
      input.projectDir,
      "--allow-external",
      "--opencode-port",
      String(opencodePort),
      "--opencode-username",
      opencodeUsername,
      "--opencode-password",
      opencodePassword,
      "--cors",
      "*",
    ];

    const child = spawn(command, args, {
      env: buildSpawnEnv(input.projectDir, envTruthy("OPENWORK_DEV_MODE"), {}),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    attachChild(state, child);
    writeOrchestratorAuth(dataDir, opencodeUsername, opencodePassword, input.projectDir);

    const daemonBaseUrl = `http://${daemonHost}:${daemonPort}`;
    const timeoutMs = Number(process.env.OPENWORK_ORCHESTRATOR_START_TIMEOUT_MS || 180000);
    const health = await waitForOrchestrator(daemonBaseUrl, Number.isFinite(timeoutMs) ? timeoutMs : 180000);
    const opencode = health.opencode;
    if (!opencode) {
      throw new Error("Orchestrator did not report OpenCode status");
    }

    state.runtime = "openwork-orchestrator";
    state.projectDir = input.projectDir;
    state.hostname = "127.0.0.1";
    state.port = opencode.port;
    state.baseUrl = `http://127.0.0.1:${opencode.port}`;
    state.opencodeUsername = opencodeUsername;
    state.opencodePassword = opencodePassword;
    state.pid = opencode.pid;
    state.startInput = {
      ...input,
      runtime: "openwork-orchestrator",
      preferSidecar,
      opencodeBinPath: input.opencodeBinPath ?? null,
      workspacePaths: input.workspacePaths ?? [input.projectDir],
    };
    state.orchestratorDataDir = dataDir;
    state.child = child;
    state.childExited = false;

    return snapshotState(state);
  };

  return {
    async info(): Promise<EngineInfo> {
      return snapshotState(state);
    },

    async doctor(input?: { preferSidecar?: boolean; opencodeBinPath?: string | null }): Promise<EngineDoctorResult> {
      const resolved = resolveEnginePath(input?.preferSidecar ?? false, input?.opencodeBinPath ?? null);
      if (!resolved.resolved) {
        return {
          found: false,
          inPath: resolved.inPath,
          resolvedPath: null,
          version: null,
          supportsServe: false,
          notes: resolved.notes,
          serveHelpStatus: null,
          serveHelpStdout: null,
          serveHelpStderr: null,
        };
      }

      const versionResult = await execCapture(resolved.resolved, ["--version"]);
      const serveHelp = await execCapture(resolved.resolved, ["serve", "--help"]);
      return {
        found: true,
        inPath: resolved.inPath,
        resolvedPath: resolved.resolved,
        version: versionResult.stdout || versionResult.stderr,
        supportsServe: serveHelp.ok,
        notes: resolved.notes,
        serveHelpStatus: serveHelp.status,
        serveHelpStdout: serveHelp.stdout,
        serveHelpStderr: serveHelp.stderr,
      };
    },

    async start(input: EngineStartInput): Promise<EngineInfo> {
      const projectDir = input.projectDir.trim();
      if (!projectDir) {
        throw new Error("projectDir is required");
      }

      await mkdir(projectDir, { recursive: true });
      await ensureProjectConfig(projectDir);
      await stopCurrentProcess(true);
      resetState(state);

      const runtime = input.runtime ?? "openwork-orchestrator";
      if (runtime === "openwork-orchestrator") {
        return ensureOrchestratorProcess({ ...input, projectDir, runtime });
      }

      return ensureDirectProcess({ ...input, projectDir, runtime });
    },

    async stop(): Promise<EngineInfo> {
      await stopCurrentProcess(true);
      resetState(state);
      return snapshotState(state);
    },

    async restart(): Promise<EngineInfo> {
      if (!state.startInput?.projectDir) {
        throw new Error("OpenCode is not configured for a local workspace");
      }

      const nextInput = { ...state.startInput };
      await stopCurrentProcess(true);
      resetState(state);
      return this.start(nextInput);
    },

    async install(): Promise<ExecResult> {
      if (process.platform === "win32") {
        return {
          ok: false,
          status: -1,
          stdout: "",
          stderr:
            "Guided install is not supported on Windows yet. Install OpenCode via Scoop/Chocolatey or https://opencode.ai/install, then restart OpenWork.",
        };
      }

      const installDir = path.join(os.homedir(), ".opencode", "bin");
      return new Promise<ExecResult>((resolve, reject) => {
        execFile(
          "bash",
          ["-lc", "curl -fsSL https://opencode.ai/install | bash"],
          {
            env: {
              ...process.env,
              OPENCODE_INSTALL_DIR: installDir,
            },
            windowsHide: true,
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (error && typeof (error as { code?: unknown }).code !== "number") {
              reject(new Error(`Failed to run installer: ${error.message}`));
              return;
            }

            resolve({
              ok: !error,
              status:
                typeof (error as { code?: unknown } | null)?.code === "number"
                  ? Number((error as { code: number }).code)
                  : 0,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
            });
          },
        );
      });
    },

    cleanupOnQuit() {
      state.runToken += 1;
      if (state.child && !state.child.killed) {
        state.child.kill();
      }
      clearOrchestratorAuth(state.orchestratorDataDir);
      resetState(state);
    },
  };
}

export type EngineService = ReturnType<typeof createEngineService>;

export function registerEngineIpc(service: EngineService) {
  ipcMain.handle(IPC_CHANNELS.engine("info"), () => service.info());
  ipcMain.handle(
    IPC_CHANNELS.engine("start"),
    (_event, input: EngineStartInput) => service.start(input),
  );
  ipcMain.handle(IPC_CHANNELS.engine("stop"), () => service.stop());
  ipcMain.handle(IPC_CHANNELS.engine("restart"), () => service.restart());
  ipcMain.handle(
    IPC_CHANNELS.engine("doctor"),
    (_event, input?: { preferSidecar?: boolean; opencodeBinPath?: string | null }) => service.doctor(input),
  );
  ipcMain.handle(IPC_CHANNELS.engine("install"), () => service.install());
}
