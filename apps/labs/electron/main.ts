import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain } from "electron";

type Role = "user" | "assistant" | "error";

type Message = {
  id: string;
  role: Role;
  text: string;
  createdAt: string;
};

type SessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
};

type ConnectionState =
  | { kind: "none" }
  | { kind: "local"; workspacePath: string; url: string }
  | { kind: "remote"; url: string; token: string };

type Snapshot = {
  connection: ConnectionState;
  sessions: SessionSummary[];
  currentSessionID: string | null;
  messages: Message[];
};

type LogEntry = {
  id: string;
  scope: "renderer" | "main" | "host";
  level: "info" | "error";
  message: string;
  at: string;
};

type HostEvent =
  | { type: "ready" }
  | { type: "sessions.changed"; sessionID?: string }
  | { type: "messages.changed"; sessionID: string }
  | { type: "run.failed"; sessionID?: string; error: string };

type SyncRequest = {
  sessions?: boolean;
  messages?: boolean;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const hostPackageRoot = path.resolve(repoRoot, "apps", "openwork-host");
const hostEntry = path.resolve(hostPackageRoot, "dist", "index.js");
const rendererUrl = process.env.OPENWORK_LABS_RENDERER_URL ?? "http://127.0.0.1:4174";
const smokeWorkspaceDir = process.env.OPENWORK_LABS_SMOKE_WORKSPACE_DIR ?? "";
const smokePrompt = process.env.OPENWORK_LABS_SMOKE_PROMPT ?? "";
const configDir = path.join(app.getPath("userData"), "labs");
const configFile = path.join(configDir, "workspace.json");
const logFile = path.join(configDir, "runtime.log");

let mainWindow: BrowserWindow | null = null;
let localHost: ReturnType<typeof spawn> | null = null;
let eventAbort: AbortController | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let connection: ConnectionState = { kind: "none" };
let sessions: SessionSummary[] = [];
let currentSessionID: string | null = null;
let messages: Message[] = [];
const logs: LogEntry[] = [];
const pendingSync: Required<SyncRequest> = { sessions: false, messages: false };

type PersistedConnection = Extract<ConnectionState, { kind: "local" | "remote" }>;

function snapshot(): Snapshot {
  return { connection, sessions, currentSessionID, messages };
}

function emitState(): void {
  mainWindow?.webContents.send("ow:state", snapshot());
}

function pushLog(scope: LogEntry["scope"], level: LogEntry["level"], message: string): void {
  const entry: LogEntry = { id: randomUUID(), scope, level, message, at: new Date().toISOString() };
  logs.push(entry);
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  mainWindow?.webContents.send("ow:log", entry);
  void appendFile(logFile, `[${entry.at}] [${scope}] [${level}] ${message}\n`).catch(() => undefined);
}

async function ensureHostBuilt(): Promise<void> {
  try {
    await access(hostEntry);
    return;
  } catch {
    pushLog("main", "info", "Building openwork-host before launch");
    const child = spawn("pnpm", ["--filter", "openwork-host", "build"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => pushLog("main", "info", String(chunk).trim()));
    child.stderr.on("data", (chunk) => pushLog("main", "error", String(chunk).trim()));
    const [code] = (await once(child, "exit")) as [number | null];
    if (code !== 0) {
      throw new Error(`openwork-host build failed with code ${code}`);
    }
  }
}

async function saveConnection(): Promise<void> {
  await mkdir(configDir, { recursive: true });
  if (connection.kind === "none") {
    await writeFile(configFile, "null", "utf8");
    return;
  }
  await writeFile(configFile, JSON.stringify(connection), "utf8");
}

async function loadConnection(): Promise<PersistedConnection | null> {
  try {
    const raw = await readFile(configFile, "utf8");
    if (!raw.trim() || raw.trim() === "null") return null;
    const parsed = JSON.parse(raw) as PersistedConnection;
    if (parsed.kind === "local" || parsed.kind === "remote") return parsed;
    return null;
  } catch {
    return null;
  }
}

async function getPort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (!address || typeof address === "string") throw new Error("Unable to allocate port");
  return address.port;
}

function baseUrl(): string {
  if (connection.kind === "local" || connection.kind === "remote") return connection.url;
  throw new Error("No active connection");
}

function authHeaders(): Record<string, string> {
  if (connection.kind === "remote" && connection.token) {
    return { Authorization: `Bearer ${connection.token}` };
  }
  return {};
}

async function api(pathname: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${baseUrl()}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

function formatHostError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function refreshSessions(): Promise<void> {
  const data = (await api("/session", { method: "GET" })) as { sessions: SessionSummary[] };
  sessions = data.sessions;
  if (!currentSessionID && sessions[0]) currentSessionID = sessions[0].id;
  if (currentSessionID && !sessions.some((session) => session.id === currentSessionID)) {
    currentSessionID = sessions[0]?.id ?? null;
  }
}

async function refreshMessages(): Promise<void> {
  if (!currentSessionID) {
    messages = [];
    return;
  }
  const data = (await api(`/session/${currentSessionID}/message`, { method: "GET" })) as { messages: Message[] };
  messages = data.messages;
}

function queueSync(request: SyncRequest): void {
  pendingSync.sessions ||= request.sessions === true;
  pendingSync.messages ||= request.messages === true;
  if (syncTimer) return;

  syncTimer = setTimeout(() => {
    syncTimer = null;
    const next = { ...pendingSync };
    pendingSync.sessions = false;
    pendingSync.messages = false;

    void (async () => {
      if (next.sessions) await refreshSessions();
      if (next.messages) await refreshMessages();
      emitState();
    })().catch((error: unknown) => {
      pushLog("main", "error", formatHostError(error));
    });
  }, 75);
}

function applyHostEvent(event: HostEvent): void {
  if (event.type === "ready") {
    return;
  }

  if (event.type === "sessions.changed") {
    queueSync({ sessions: true, messages: event.sessionID === currentSessionID });
    return;
  }

  if (event.type === "messages.changed") {
    queueSync({ sessions: true, messages: event.sessionID === currentSessionID });
    return;
  }

  if (event.type === "run.failed") {
    pushLog("host", "error", event.error);
    queueSync({ sessions: true, messages: event.sessionID === currentSessionID });
    return;
  }
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${url}/global/health`);
      if (response.ok) return;
    } catch {
      // Retry until the child is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("openwork-host did not become healthy in time");
}

async function openEventStream(): Promise<void> {
  eventAbort?.abort();
  const controller = new AbortController();
  eventAbort = controller;
  const response = await fetch(`${baseUrl()}/event`, {
    method: "GET",
    headers: { Accept: "text/event-stream", ...authHeaders() },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) throw new Error(`SSE failed: ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const read = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLine = frame
          .split("\n")
          .find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload) continue;
        applyHostEvent(JSON.parse(payload) as HostEvent);
      }
    }
  };

  void read().catch((error: unknown) => {
    if (!controller.signal.aborted) pushLog("main", "error", String(error));
  });
}

async function stopLocalHost(): Promise<void> {
  eventAbort?.abort();
  eventAbort = null;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  pendingSync.sessions = false;
  pendingSync.messages = false;
  if (!localHost) return;
  localHost.kill();
  await once(localHost, "exit").catch(() => undefined);
  localHost = null;
}

async function connectLocal(workspacePath: string): Promise<Snapshot> {
  await stopLocalHost();
  await ensureHostBuilt();
  const port = await getPort();
  const child = spawn(process.execPath, [hostEntry], {
    cwd: hostPackageRoot,
    env: {
      ...process.env,
      PORT: String(port),
      OPENWORK_HOST_WORKSPACE_DIR: workspacePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => pushLog("host", "info", String(chunk).trim()));
  child.stderr.on("data", (chunk) => pushLog("host", "error", String(chunk).trim()));
  child.on("exit", (code, signal) => pushLog("host", code === 0 ? "info" : "error", `host exited code=${code} signal=${signal}`));
  localHost = child;

  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url);
  connection = { kind: "local", workspacePath, url };
  sessions = [];
  currentSessionID = null;
  messages = [];
  await refreshSessions();
  await refreshMessages();
  await openEventStream();
  emitState();
  pushLog("main", "info", `Connected local workspace ${workspacePath}`);
  await saveConnection();
  return snapshot();
}

async function connectRemote(urlInput: string, token: string): Promise<Snapshot> {
  await stopLocalHost();
  connection = { kind: "remote", url: urlInput.replace(/\/$/, ""), token };
  sessions = [];
  currentSessionID = null;
  messages = [];
  await refreshSessions();
  await refreshMessages();
  await openEventStream();
  emitState();
  pushLog("main", "info", `Connected remote ${connection.url}`);
  await saveConnection();
  return snapshot();
}

async function runMainSmokeFlow(promptValue: string): Promise<void> {
  const data = (await api("/session", { method: "POST", body: JSON.stringify({ title: "Smoke chat" }) })) as {
    session: SessionSummary;
  };
  currentSessionID = data.session.id;
  await refreshMessages();
  await refreshSessions();
  pushLog("main", "info", `Smoke created session ${data.session.id}`);
  await api(`/session/${data.session.id}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({ prompt: promptValue }),
  });
  pushLog("main", "info", `Smoke prompt submitted for ${data.session.id}`);
  await waitForAssistantReply(data.session.id);
  emitState();
}

async function waitForAssistantReply(sessionID: string, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    currentSessionID = sessionID;
    await refreshMessages();
    await refreshSessions();
    const done = messages.some((message) => message.role === "assistant" && message.text.trim().length > 0);
    if (done) {
      pushLog("main", "info", `Assistant reply observed for ${sessionID}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  pushLog("main", "error", `Assistant reply timeout for ${sessionID}; last messages=${JSON.stringify(messages)}`);
  throw new Error(`Timed out waiting for assistant reply for session ${sessionID}`);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    webPreferences: {
      contextIsolation: true,
      preload: path.resolve(__dirname, "preload.cjs"),
    },
  });

  if (process.env.OPENWORK_LABS_DEV === "1") {
    await mainWindow.loadURL(rendererUrl);
  } else {
    await mainWindow.loadFile(path.resolve(packageRoot, "dist", "index.html"));
  }
}

ipcMain.handle("ow:getSnapshot", () => snapshot());
ipcMain.handle("ow:getLogs", () => logs);
ipcMain.handle("ow:createWorkspace", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return snapshot();
  return connectLocal(result.filePaths[0]);
});
ipcMain.handle("ow:connectRemote", async (_event, payload: { url: string; token: string }) => {
  return connectRemote(payload.url, payload.token);
});
ipcMain.handle("ow:createSession", async () => {
  const data = (await api("/session", { method: "POST", body: JSON.stringify({}) })) as { session: SessionSummary };
  currentSessionID = data.session.id;
  messages = [];
  await refreshSessions();
  emitState();
  return snapshot();
});
ipcMain.handle("ow:selectSession", async (_event, sessionID: string) => {
  currentSessionID = sessionID;
  await refreshMessages();
  emitState();
  return snapshot();
});
ipcMain.handle("ow:sendPrompt", async (_event, payload: { sessionID: string; prompt: string }) => {
  pushLog("main", "info", `Sending prompt for ${payload.sessionID}`);
  await api(`/session/${payload.sessionID}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({ prompt: payload.prompt }),
  });
  return snapshot();
});
ipcMain.handle("ow:abortSession", async (_event, sessionID: string) => {
  await api(`/session/${sessionID}/abort`, { method: "POST", body: JSON.stringify({}) });
  return snapshot();
});
ipcMain.on("ow:rendererLog", (_event, payload: { level: string; message: string }) => {
  pushLog("renderer", payload.level === "error" ? "error" : "info", payload.message);
});

app.on("before-quit", () => {
  void stopLocalHost();
});

app.whenReady().then(async () => {
  await mkdir(configDir, { recursive: true });
  pushLog("main", "info", "Labs shell ready");
  await createWindow();
  const persisted = await loadConnection();
  if (persisted?.kind === "local") {
    try {
      await connectLocal(persisted.workspacePath);
    } catch (error) {
      pushLog("main", "error", `Failed to restore local workspace: ${String(error)}`);
      connection = { kind: "none" };
      await saveConnection();
    }
  }
  if (persisted?.kind === "remote") {
    try {
      await connectRemote(persisted.url, persisted.token);
    } catch (error) {
      pushLog("main", "error", `Failed to restore remote workspace: ${String(error)}`);
      connection = { kind: "none" };
      await saveConnection();
    }
  }

  if (smokeWorkspaceDir) {
    try {
      await connectLocal(smokeWorkspaceDir);
      pushLog("main", "info", `Smoke connected local workspace ${smokeWorkspaceDir}`);
      if (smokePrompt.trim()) {
        await runMainSmokeFlow(smokePrompt);
        pushLog("main", "info", `Smoke prompt completed`);
      }
      emitState();
    } catch (error) {
      pushLog("main", "error", `Smoke flow failed: ${String(error)}`);
    }
  }

  emitState();
});
