import { app, ipcMain } from "electron";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type {
  ExecResult,
  OpenCodeRouterInfo,
  OpenCodeRouterStatus,
} from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

type RouterStartInput = {
  workspacePath: string;
  opencodeUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  healthPort?: number;
};

type RouterState = {
  child: ManagedChild | null;
  childExited: boolean;
  version: string | null;
  workspacePath: string | null;
  opencodeUrl: string | null;
  healthPort: number | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
  startInput: RouterStartInput | null;
  runToken: number;
};

const DEFAULT_OPENCODE_ROUTER_HEALTH_PORT = 3005;
const OPENCODE_ROUTER_STARTUP_WAIT_MS = 5_000;
const OPENCODE_ROUTER_MAX_START_ATTEMPTS = 5;

function defaultState(): RouterState {
  return {
    child: null,
    childExited: true,
    version: null,
    workspacePath: null,
    opencodeUrl: null,
    healthPort: null,
    pid: null,
    lastStdout: null,
    lastStderr: null,
    startInput: null,
    runToken: 0,
  };
}

function truncateOutput(value: string, max = 8_000) {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function appendOutput(current: string | null, chunk: string) {
  return truncateOutput(`${current ?? ""}${chunk}`);
}

function snapshot(state: RouterState): OpenCodeRouterInfo {
  const running = Boolean(state.child) && !state.childExited;
  return {
    running,
    version: state.version,
    workspacePath: state.workspacePath,
    opencodeUrl: state.opencodeUrl,
    healthPort: state.healthPort,
    pid: running ? state.pid : null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
  };
}

function resetState(state: RouterState) {
  const runToken = state.runToken;
  Object.assign(state, { ...defaultState(), runToken });
}

function stopChild(state: RouterState) {
  state.runToken += 1;
  if (state.child && !state.child.killed) {
    state.child.kill();
  }
  state.child = null;
  state.childExited = true;
}

function resolveRouterCommand() {
  const fileName = process.platform === "win32" ? "opencode-router.exe" : "opencode-router";
  const currentFile = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const appPath = app.getAppPath();
  const sourceSidecarDirs = [
    path.resolve(appPath, "resources/sidecars"),
    path.resolve(appPath, "../resources/sidecars"),
    path.resolve(currentDir, "../../../resources/sidecars"),
    path.resolve(currentDir, "../../../../../resources/sidecars"),
  ];
  const candidates = [
    path.join(path.dirname(process.execPath), fileName),
    process.resourcesPath ? path.join(process.resourcesPath, "sidecars", fileName) : null,
    process.resourcesPath ? path.join(process.resourcesPath, fileName) : null,
    ...sourceSidecarDirs.map((dir) => path.join(dir, fileName)),
  ].filter((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));

  return candidates[0] ?? fileName;
}

function buildRouterArgs(workspacePath: string, opencodeUrl?: string) {
  const args = ["serve", workspacePath];
  if (opencodeUrl?.trim()) {
    args.push("--opencode-url", opencodeUrl.trim());
  }
  return args;
}

async function resolveHealthPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate router health port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

async function checkHealthEndpoint(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function isPortInUseError(message: string) {
  const lower = message.toLowerCase();
  return lower.includes("port is in use") || lower.includes("eaddrinuse") || lower.includes("address already in use");
}

function formatStartupFailure(code: number | null | undefined, startupStdout: string | null, startupStderr: string | null) {
  const parts: string[] = [];
  if (startupStdout?.trim()) {
    parts.push(`stdout:\n${startupStdout.trim()}`);
  }
  if (startupStderr?.trim()) {
    parts.push(`stderr:\n${startupStderr.trim()}`);
  }
  const suffix = parts.length ? `\n\n${parts.join("\n\n")}` : "";
  return `OpenCodeRouter exited during startup (code ${code ?? -1}).${suffix}`;
}

async function awaitRouterStartup(
  child: ManagedChild,
  state: RouterState,
  token: number,
  healthPort: number,
  startupOutput: { stdout: string | null; stderr: string | null },
) {
  if (await checkHealthEndpoint(healthPort)) {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < OPENCODE_ROUTER_STARTUP_WAIT_MS) {
    if (state.runToken !== token) {
      return;
    }

    if (await checkHealthEndpoint(healthPort)) {
      return;
    }

    if (state.childExited) {
      throw new Error(formatStartupFailure(child.exitCode, startupOutput.stdout, startupOutput.stderr));
    }

    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

function execRouterFile(command: string, args: string[]) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          reject(new Error(`Failed to ${args.join(" ")}: ${error.message}`));
          return;
        }

        resolve({
          ok: !error,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

async function routerJson(command: string, args: string[], context: string) {
  const result = await execRouterFile(command, args);
  if (!result.ok) {
    throw new Error(`Failed to ${context}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function routerVersion(command: string) {
  try {
    const result = await execRouterFile(command, ["--version"]);
    const trimmed = result.stdout.trim();
    return result.ok && trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

async function resolveRouterGroupsHealthPort(state: RouterState) {
  if (state.healthPort) {
    return state.healthPort;
  }

  const command = resolveRouterCommand();
  try {
    const status = await routerJson(command, ["status", "--json"], "get status");
    if (typeof status.healthPort === "number") {
      return status.healthPort;
    }
  } catch {
    // ignore and fall back
  }

  return DEFAULT_OPENCODE_ROUTER_HEALTH_PORT;
}

export function createRouterService() {
  const state = defaultState();

  const service = {
    async info(): Promise<OpenCodeRouterInfo> {
      const info = snapshot(state);
      const healthPort = state.healthPort ?? DEFAULT_OPENCODE_ROUTER_HEALTH_PORT;
      if (!info.running && (await checkHealthEndpoint(healthPort))) {
        info.running = true;
      }

      const command = resolveRouterCommand();
      if (!info.version) {
        state.version = await routerVersion(command);
        info.version = state.version;
      }

      if (!info.opencodeUrl || !info.workspacePath) {
        try {
          const status = await routerJson(command, ["status", "--json"], "get status");
          const opencode = status.opencode as { url?: unknown; directory?: unknown } | undefined;
          if (!info.opencodeUrl && typeof opencode?.url === "string" && opencode.url.trim()) {
            info.opencodeUrl = opencode.url.trim();
            state.opencodeUrl = info.opencodeUrl;
          }
          if (!info.workspacePath && typeof opencode?.directory === "string" && opencode.directory.trim()) {
            info.workspacePath = opencode.directory.trim();
            state.workspacePath = info.workspacePath;
          }
        } catch {
          // ignore fallback failures
        }
      }

      return info;
    },

    async start(input: RouterStartInput): Promise<OpenCodeRouterInfo> {
      const workspacePath = input.workspacePath.trim();
      if (!workspacePath) {
        throw new Error("workspacePath is required");
      }

      stopChild(state);
      resetState(state);

      const command = resolveRouterCommand();
      const maxAttempts = input.healthPort ? 1 : OPENCODE_ROUTER_MAX_START_ATTEMPTS;
      let lastError: string | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const healthPort =
          attempt === 0
            ? (input.healthPort ?? (await resolveHealthPort()))
            : await resolveHealthPort();
        const child = spawn(command, buildRouterArgs(workspacePath, input.opencodeUrl), {
          cwd: workspacePath,
          env: {
            ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
            OPENCODE_ROUTER_HEALTH_PORT: String(healthPort),
            ...(input.opencodeUsername?.trim() ? { OPENCODE_SERVER_USERNAME: input.opencodeUsername.trim() } : {}),
            ...(input.opencodePassword?.trim() ? { OPENCODE_SERVER_PASSWORD: input.opencodePassword.trim() } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });

        state.runToken += 1;
        const token = state.runToken;
        state.child = child;
        state.childExited = false;
        const startupOutput = { stdout: null as string | null, stderr: null as string | null };
        child.stdout.on("data", (chunk) => {
          if (state.runToken !== token) return;
          const line = chunk.toString();
          startupOutput.stdout = appendOutput(startupOutput.stdout, line);
          state.lastStdout = appendOutput(state.lastStdout, line);
        });
        child.stderr.on("data", (chunk) => {
          if (state.runToken !== token) return;
          const line = chunk.toString();
          startupOutput.stderr = appendOutput(startupOutput.stderr, line);
          state.lastStderr = appendOutput(state.lastStderr, line);
        });
        child.on("exit", (code) => {
          if (state.runToken !== token) return;
          state.childExited = true;
          if (typeof code === "number") {
            state.lastStderr = appendOutput(state.lastStderr, `OpenCodeRouter exited (code ${code}).`);
          }
        });
        child.on("error", (error) => {
          if (state.runToken !== token) return;
          state.childExited = true;
          state.lastStderr = appendOutput(state.lastStderr, error.message);
        });

        try {
          await awaitRouterStartup(child, state, token, healthPort, startupOutput);
          state.workspacePath = workspacePath;
          state.opencodeUrl = input.opencodeUrl?.trim() || null;
          state.healthPort = healthPort;
          state.pid = child.pid ?? null;
          state.startInput = { ...input, healthPort };
          state.version = await routerVersion(command);
          return snapshot(state);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastError = message;
          child.kill();
          if (!(input.healthPort == null && isPortInUseError(message))) {
            break;
          }
        }
      }

      throw new Error(
        lastError && maxAttempts > 1
          ? `Failed to start OpenCodeRouter after ${maxAttempts} attempts: ${lastError}`
          : (lastError ?? "Failed to start OpenCodeRouter"),
      );
    },

    async stop(): Promise<OpenCodeRouterInfo> {
      stopChild(state);
      resetState(state);
      return snapshot(state);
    },

    async restart(input: RouterStartInput): Promise<OpenCodeRouterInfo> {
      await this.stop();
      return this.start(input);
    },

    async status(): Promise<OpenCodeRouterStatus> {
      const command = resolveRouterCommand();
      const status = await routerJson(command, ["status", "--json"], "get status");
      let running = snapshot(state).running;
      if (!running) {
        const checkPort = state.healthPort ?? DEFAULT_OPENCODE_ROUTER_HEALTH_PORT;
        if (await checkHealthEndpoint(checkPort)) {
          running = true;
        }
      }

      const config = typeof status.config === "string" ? status.config : "";
      const cliHealthPort = typeof status.healthPort === "number" ? status.healthPort : null;
      const healthPort = state.healthPort ?? cliHealthPort;
      const telegramItems = Array.isArray(status.telegram) ? status.telegram : [];
      const slackItems = Array.isArray(status.slack) ? status.slack : [];
      const opencode = typeof status.opencode === "object" && status.opencode ? (status.opencode as { url?: unknown; directory?: unknown }) : {};
      const result: OpenCodeRouterStatus = {
        running,
        config,
        healthPort,
        telegram: {
          items: telegramItems as OpenCodeRouterStatus["telegram"]["items"],
        },
        slack: {
          items: slackItems as OpenCodeRouterStatus["slack"]["items"],
        },
        opencode: {
          url: typeof opencode.url === "string" ? opencode.url : "",
          ...(typeof opencode.directory === "string" && opencode.directory.trim()
            ? { directory: opencode.directory.trim() }
            : {}),
        },
      };
      return result;
    },

    cleanupOnQuit() {
      stopChild(state);
      resetState(state);
    },

    async getGroupsEnabled(): Promise<boolean | null> {
      // Intentionally narrow bridge: this only talks to the router's localhost health/config port
      // and does not expose a generic HTTP proxy to the renderer.
      const healthPort = await resolveRouterGroupsHealthPort(state);
      try {
        const response = await fetch(`http://127.0.0.1:${healthPort}/config/groups`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });
        if (!response.ok) {
          return null;
        }
        const data = (await response.json()) as { groupsEnabled?: unknown };
        return typeof data.groupsEnabled === "boolean" ? data.groupsEnabled : null;
      } catch {
        return null;
      }
    },

    async setGroupsEnabled(input: { enabled: boolean }): Promise<ExecResult> {
      const healthPort = await resolveRouterGroupsHealthPort(state);
      try {
        const response = await fetch(`http://127.0.0.1:${healthPort}/config/groups`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: input.enabled }),
        });
        if (!response.ok) {
          const message = await response.text();
          return { ok: false, status: response.status, stdout: "", stderr: message };
        }
        return { ok: true, status: 0, stdout: "", stderr: "" };
      } catch (error) {
        return { ok: false, status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  return service;
}

export type RouterService = ReturnType<typeof createRouterService>;

export function registerRouterIpc(service: RouterService) {
  ipcMain.handle(IPC_CHANNELS.router("info"), () => service.info());
  ipcMain.handle(IPC_CHANNELS.router("status"), () => service.status());
  ipcMain.handle(IPC_CHANNELS.router("start"), (_event, input: RouterStartInput) => service.start(input));
  ipcMain.handle(IPC_CHANNELS.router("stop"), () => service.stop());
  ipcMain.handle(IPC_CHANNELS.router("restart"), (_event, input: RouterStartInput) => service.restart(input));
  ipcMain.handle(IPC_CHANNELS.router("getGroupsEnabled"), () => service.getGroupsEnabled());
  ipcMain.handle(IPC_CHANNELS.router("setGroupsEnabled"), (_event, input: { enabled: boolean }) => service.setGroupsEnabled(input));
}
