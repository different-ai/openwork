import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { networkInterfaces } from "node:os";
import { hostname } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import type { EngineInfo, OpenworkServerInfo } from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

type OpenworkServerState = {
  child: ManagedChild | null;
  childExited: boolean;
  host: string | null;
  port: number | null;
  baseUrl: string | null;
  connectUrl: string | null;
  mdnsUrl: string | null;
  lanUrl: string | null;
  clientToken: string | null;
  hostToken: string | null;
  pid: number | null;
  lastStdout: string | null;
  lastStderr: string | null;
  runToken: number;
};

type OpenworkServerServiceOptions = {
  getEngineInfo: () => Promise<EngineInfo>;
  getRouterHealthPort?: () => number | null;
};

function defaultState(): OpenworkServerState {
  return {
    child: null,
    childExited: true,
    host: null,
    port: null,
    baseUrl: null,
    connectUrl: null,
    mdnsUrl: null,
    lanUrl: null,
    clientToken: null,
    hostToken: null,
    pid: null,
    lastStdout: null,
    lastStderr: null,
    runToken: 0,
  };
}

function truncateOutput(value: string, max = 8000) {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function appendOutput(current: string | null, chunk: string) {
  return truncateOutput(`${current ?? ""}${chunk}`);
}

function snapshot(state: OpenworkServerState): OpenworkServerInfo {
  const running = Boolean(state.child) && !state.childExited;
  return {
    running,
    host: state.host,
    port: state.port,
    baseUrl: state.baseUrl,
    connectUrl: state.connectUrl,
    mdnsUrl: state.mdnsUrl,
    lanUrl: state.lanUrl,
    clientToken: state.clientToken,
    hostToken: state.hostToken,
    pid: running ? state.pid : null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
  };
}

function resolveOpenworkServerCommand() {
  const fileName = process.platform === "win32" ? "openwork-server.exe" : "openwork-server";
  const candidates = [
    path.join(path.dirname(process.execPath), fileName),
    process.resourcesPath ? path.join(process.resourcesPath, "sidecars", fileName) : null,
    process.resourcesPath ? path.join(process.resourcesPath, fileName) : null,
  ].filter((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));

  return candidates[0] ?? fileName;
}

async function resolveOpenworkPort() {
  const tryPort = (port: number) =>
    new Promise<boolean>((resolve) => {
      const server = createNetServer();
      server.once("error", () => resolve(false));
      server.listen(port, "0.0.0.0", () => {
        server.close(() => resolve(true));
      });
    });

  if (await tryPort(8787)) {
    return 8787;
  }

  return new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to resolve OpenWork server port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

function buildUrls(port: number) {
  const hostName = hostname().trim();
  const mdnsUrl = hostName ? `http://${hostName.replace(/\.local$/, "")}.local:${port}` : null;

  const lanUrl = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && !entry.internal && entry.family === "IPv4")?.address;
  const lan = lanUrl ? `http://${lanUrl}:${port}` : null;
  return {
    mdnsUrl,
    lanUrl: lan,
    connectUrl: lan ?? mdnsUrl,
  };
}

function buildArgs(
  host: string,
  port: number,
  workspacePaths: string[],
  clientToken: string,
  hostToken: string,
  opencodeBaseUrl: string | null,
  opencodeDirectory: string | null,
) {
  const args = [
    "--host",
    host,
    "--port",
    String(port),
    "--token",
    clientToken,
    "--host-token",
    hostToken,
    "--cors",
    "*",
    "--approval",
    "auto",
  ];

  for (const workspacePath of workspacePaths) {
    if (workspacePath.trim()) {
      args.push("--workspace", workspacePath);
    }
  }

  if (opencodeBaseUrl?.trim()) {
    args.push("--opencode-base-url", opencodeBaseUrl);
  }
  if (opencodeDirectory?.trim()) {
    args.push("--opencode-directory", opencodeDirectory);
  }

  return args;
}

export function createOpenworkServerService(options: OpenworkServerServiceOptions) {
  const state = defaultState();

  const stop = () => {
    state.runToken += 1;
    if (state.child && !state.child.killed) {
      state.child.kill();
    }
    Object.assign(state, { ...defaultState(), runToken: state.runToken });
  };

  const attachChild = (child: ManagedChild) => {
    state.runToken += 1;
    const token = state.runToken;
    state.child = child;
    state.childExited = false;
    child.stdout.on("data", (chunk) => {
      if (state.runToken !== token) return;
      state.lastStdout = appendOutput(state.lastStdout, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      if (state.runToken !== token) return;
      state.lastStderr = appendOutput(state.lastStderr, chunk.toString());
    });
    child.on("exit", (code) => {
      if (state.runToken !== token) return;
      state.childExited = true;
      if (typeof code === "number") {
        state.lastStderr = appendOutput(state.lastStderr, `OpenWork server exited (code ${code}).`);
      }
    });
    child.on("error", (error) => {
      if (state.runToken !== token) return;
      state.childExited = true;
      state.lastStderr = appendOutput(state.lastStderr, error.message);
    });
  };

  return {
    async info() {
      return snapshot(state);
    },

    async restart() {
      const engine = await options.getEngineInfo();
      const workspacePath = engine.projectDir?.trim();
      if (!workspacePath) {
        throw new Error("No active local workspace available");
      }

      stop();

      const host = "0.0.0.0";
      const port = await resolveOpenworkPort();
      const clientToken = randomUUID();
      const hostToken = randomUUID();
      const command = resolveOpenworkServerCommand();
      const args = buildArgs(host, port, [workspacePath], clientToken, hostToken, engine.baseUrl, workspacePath);

      const child = spawn(command, args, {
        cwd: workspacePath,
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
          ...(options.getRouterHealthPort?.() ? { OPENCODE_ROUTER_HEALTH_PORT: String(options.getRouterHealthPort!()) } : {}),
          ...(engine.opencodeUsername?.trim() ? { OPENWORK_OPENCODE_USERNAME: engine.opencodeUsername.trim() } : {}),
          ...(engine.opencodePassword?.trim() ? { OPENWORK_OPENCODE_PASSWORD: engine.opencodePassword.trim() } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      attachChild(child);
      state.host = host;
      state.port = port;
      state.baseUrl = `http://127.0.0.1:${port}`;
      const urls = buildUrls(port);
      state.connectUrl = urls.connectUrl;
      state.mdnsUrl = urls.mdnsUrl;
      state.lanUrl = urls.lanUrl;
      state.clientToken = clientToken;
      state.hostToken = hostToken;
      state.pid = child.pid ?? null;

      return snapshot(state);
    },

    cleanupOnQuit() {
      stop();
    },
  };
}

export type OpenworkServerService = ReturnType<typeof createOpenworkServerService>;

export function registerOpenworkServerIpc(service: OpenworkServerService) {
  ipcMain.handle(IPC_CHANNELS.openworkServer("info"), () => service.info());
  ipcMain.handle(IPC_CHANNELS.openworkServer("restart"), () => service.restart());
}
